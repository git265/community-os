// Reference implementation of the CommunityOS REST contract (docs/BACKEND.md) on the SAME PostgreSQL schema the Spring Boot
// service uses. It exists so you can flip the UI to "Back end" and develop screens WITHOUT building the Java service, and so
// the contract can be tested. The production service is backend/spring. Keep the two in step: both follow docs/BACKEND.md.
//
//   DATABASE_URL=postgres://user:pass@localhost:5432/communityos  PORT=8080  node server.mjs
import './register-hooks.mjs';   // must come first: lets the server import the UI's policy modules (see shared-hooks.mjs)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import pg from 'pg';
import { createAuth, CFG as AUTH, AuthError } from './auth.mjs';
import { createService } from './service.mjs';
import { createPayments, PAY } from './payments.mjs';
import { createJobs } from './jobs.mjs';
import { findCardData, createLimiter, clientIp, securityHeaders, checkFileBytes, fileResponseHeaders } from './guards.mjs';
import { createIdempotency } from './idempotency.mjs';
import { createOutbox } from './outbox.mjs';
import { createBreaker } from './breaker.mjs';
import { createRepository } from './store/repository.mjs';
import { createPlatform } from './platform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const FILES_DIR = process.env.FILES_DIR || path.join(here, 'data', 'files');
const API_KEY = process.env.API_KEY || '';          // optional: require "Authorization: Bearer <key>"
const ALLOW_RESET = process.env.ALLOW_TENANT_RESET !== 'false';
const PLATFORM_COLLECTIONS = new Set((process.env.PLATFORM_COLLECTIONS || 'communities').split(','));
// Connection pool: size it to what PostgreSQL can serve (all server instances together must stay under max_connections). Too many connections
// swamp the database, too few make requests queue; a request that waits more than 10 s for a connection fails instead of piling up.
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres@localhost:5432/communityos',
  max: Number(process.env.PG_POOL_MAX || 20), idleTimeoutMillis: Number(process.env.PG_IDLE_MS || 30000), connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 10000),
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 30000),                       // one runaway query cannot hold a connection forever
  idle_in_transaction_session_timeout: Number(process.env.PG_IDLE_TX_MS || 60000),               // a crashed request cannot keep row locks
});
pool.on('error', (e) => console.error('[pg] idle client error', e.message));
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const REQUIRE_HTTPS = process.env.REQUIRE_HTTPS ? process.env.REQUIRE_HTTPS === 'true' : process.env.NODE_ENV === 'production';
const RATE = { on: process.env.RATE_LIMIT ? process.env.RATE_LIMIT !== 'off' : AUTH.mode === 'enforce', ip: Number(process.env.RATE_IP_PER_MIN || 1200), user: Number(process.env.RATE_USER_PER_MIN || 600), auth: Number(process.env.RATE_AUTH_PER_MIN || 30) };
const limiter = createLimiter();

const TENANT_RE = /^(platform|[a-z0-9][a-z0-9-]{1,30}[a-z0-9])$/;
const COLLECTION_RE = /^[A-Za-z][A-Za-z0-9_:-]{0,63}$/;
const KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
// ids are chosen by the app ("pulse-Handyman · Security", "FST-0001"): anything except a slash, backslash, ?, % or control characters, so a path stays one segment
const ID_RE = /^[^/\\?%\u0000-\u001f\u007f]{1,128}$/u;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

// ---- migrations (the same file Flyway runs) --------------------------------------------------------
async function migrate() {
  const dir = path.join(here, '..', 'db');
  for (const f of fs.readdirSync(dir).filter((x) => /^V\d+__.*\.sql$/.test(x)).sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)))) await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
}

// ---- the document repository (see store/: collections live in typed tables or in the generic documents table) ----------------------
const tenantOf = (tenant, collection) => (PLATFORM_COLLECTIONS.has(collection) ? 'platform' : tenant);
const stamp = (r, now) => ({ ...r, updatedAt: now });
const repoOn = (client = pool) => createRepository({ q: (sql, args) => client.query(sql, args), HttpError });
const repo = repoOn(pool);
const list = (t, c) => repo.list(t, c);
const get = (t, c, id) => repo.get(t, c, id);
const put = (t, c, record, client = pool) => {
  if (!record || typeof record.id !== 'string' || !ID_RE.test(record.id)) throw new HttpError(400, 'Every record needs a string "id".');
  return repoOn(client).put(t, c, stamp(record, new Date().toISOString()));
};
async function inTx(fn) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const out = await fn(client); await client.query('COMMIT'); return out; }
  catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
const putMany = (t, c, list) => inTx(async (cl) => { const out = []; for (const r of list) out.push(await put(t, c, r, cl)); return out; });
const replaceAll = (t, c, list) => inTx(async (cl) => {
  await repoOn(cl).removeAll(t, c);
  for (const r of list) await put(t, c, r, cl);
});

// ---- server-written audit trail: nothing the client sends ever becomes an audit row (see /api/audit below) ---------------------
async function writeAudit(t, e, client = pool) {
  const n = (await client.query("SELECT nextval('audit_short_seq') AS n")).rows[0].n;
  const row = { id: crypto.randomUUID(), shortId: `AUD-${String(n).padStart(5, '0')}`, when: new Date().toISOString(), changes: [], unit: '', recordId: '', recordShortId: '', collection: e.what, whoName: e.who, ...e };
  await put(t, 'audit', row, client);
  return row;
}
const auth = createAuth({
  pool, audit: (t, e) => writeAudit(t, e).catch(() => null),
  getUsers: (t) => list(t, 'users'), getUser: (t, id) => get(t, 'users', id), list, get: (t, c, id) => get(t, c, id),
});

// ---- the service layer (authorization, stamping, audit in one transaction) - used when AUTH_MODE=enforce -------------------------
const svc = AUTH.mode === 'enforce'
  ? await createService({ pool, tenantOf, stamp, ID_RE, HttpError, srcDir: pathToFileURL(path.join(here, '..', '..', 'src') + path.sep) })
  : null;

const srcDirUrl = pathToFileURL(path.join(here, '..', '..', 'src') + path.sep);
const { ALLOWED_TYPES, MAX_BYTES } = await import(new URL('lib/files/fileValidation.js', srcDirUrl).href);
const outbox = createOutbox({ pool });
outbox.register('payment.settled', async (ev) => { console.log(`[outbox] payment.settled ${ev.payload.orderId} ${ev.payload.unit} ${ev.payload.amount}`); });   // plug mail / invoice / accounting export handlers in here
const idem = createIdempotency({ pool, HttpError });
const providerBreaker = createBreaker({ name: 'The payment provider', timeoutMs: Number(process.env.PAYMENT_PROVIDER_TIMEOUT_MS || 8000), failureThreshold: Number(process.env.PAYMENT_BREAKER_FAILURES || 5), resetMs: Number(process.env.PAYMENT_BREAKER_RESET_MS || 30000) });
const payments = svc ? await createPayments({ pool, svc, HttpError, srcDir: srcDirUrl, outbox, breaker: providerBreaker }) : null;
if (svc) { outbox.start(); const t = setInterval(() => idem.cleanup().catch(() => {}), 3600e3); t.unref?.(); }
if (payments) {
  const { setPaymentVerifier } = await import(new URL('lib/amenityServer.js', srcDirUrl).href);
  const { ctxNow } = await import('./service.mjs');
  setPaymentVerifier((a) => payments.claimForBooking(ctxNow().tenant, a));
  payments.start();
}
const jobs = svc ? await createJobs({ pool, svc, srcDir: srcDirUrl }) : null;
const platform = svc ? await createPlatform({ pool, svc, srcDir: srcDirUrl, HttpError }) : null;   // the platform console: create / list / suspend communities
jobs?.start();

// ---- query: same meaning as src/lib/storage/queryEngine.js (the SQL is built in store/sqlquery.mjs) ------------------------------
const query = (t, c, p) => repo.page(t, c, p, null);
function parseQuery(sp) {
  const filters = {};
  for (const [k, v] of sp.entries()) if (k.startsWith('f.')) (filters[k.slice(2)] ||= []).push(v);
  const [sortKey, sortDir] = (sp.get('sort') || '').split(':');
  return {   // the same shape src/lib/storage/queryEngine.js takes
    page: Number(sp.get('page') || 1), pageSize: Number(sp.get('pageSize') || 50), sort: sortKey ? { key: sortKey, dir: sortDir || 'asc' } : undefined,
    search: sp.get('search') || '', searchKeys: sp.getAll('searchKey'),
    dateRange: sp.get('dateKey') ? { key: sp.get('dateKey'), from: sp.get('from') || '', to: sp.get('to') || '' } : undefined,
    period: sp.get('periodKey') ? { key: sp.get('periodKey'), year: sp.get('year') || '', month: sp.get('month') || '' } : undefined, filters,
  };
}

// ---- file bytes (the FileStorage port: local disk here; S3 / Azure in the Spring service) --------------
const filePath = (t, id) => path.join(FILES_DIR, t, id.replace(/[^A-Za-z0-9_.-]/g, '_'));
const readBody = (req) => req._raw ? Promise.resolve(req._raw) : new Promise((ok, no) => { const b = []; req.on('data', (d) => b.push(d)); req.on('end', () => ok(Buffer.concat(b))); req.on('error', no); });

// ---- HTTP -------------------------------------------------------------------------------------------
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };

async function authRoute(req, res, parts, url) {
  const a = auth.handlers; const op = parts[1];
  const body = req.method === 'POST' ? JSON.parse((await readBody(req)).toString() || '{}') : {};
  const tenant = String(req.headers['x-community-id'] || '');
  const needTenant = () => { if (!TENANT_RE.test(tenant) || tenant === 'platform') throw new HttpError(400, 'Send a valid X-Community-Id header.'); return tenant; };
  if (op === 'config' && req.method === 'GET') return json(res, 200, await a.config());
  if (op === 'me' && req.method === 'GET') return json(res, 200, await a.me(await auth.principalFrom(req, needTenant())));
  if (op === 'community' && req.method === 'GET') return json(res, 200, await a.community(needTenant()));
  if (op === 'roster' && req.method === 'GET') return json(res, 200, await a.roster(needTenant()));
  if (op === 'invite' && req.method === 'GET') return json(res, 200, await a.invite(needTenant(), parts[2] || ''));
  if (req.method !== 'POST') throw new HttpError(405, 'Not supported.');
  if (op === 'request-code') return json(res, 200, await a.requestCode(req, needTenant(), body));
  if (op === 'verify') return json(res, 200, await a.verify(req, res, needTenant(), body));
  if (op === 'demo') return json(res, 200, await a.demo(req, res, needTenant(), body));
  if (op === 'refresh') return json(res, 200, await a.refresh(req, res, TENANT_RE.test(tenant) ? tenant : ''));
  if (op === 'logout') { await a.logout(req, res); return json(res, 204); }
  if (op === 'switch-role') { const t = needTenant(); const claims = await auth.claimsFrom(req); await auth.principalFrom(req, t); return json(res, 200, await a.switchRole(req, res, claims, t, body)); }
  throw new HttpError(404, 'Not found.');
}

// Card numbers and security codes never belong in this server (PCI-DSS): the provider's own page takes them. A request carrying one is refused and NOT stored.
const noCardData = (v) => { const f = findCardData(v); if (f) throw Object.assign(new HttpError(400, `Card details must never be sent to this app (found ${f}). Pay on the payment provider's own page.`), { code: 'card-data' }); return v; };

// AUTH_MODE=enforce: every call is authenticated, authorized and audited by the service layer. The client never writes audit rows,
// never stamps metadata and never reaches the raw tables.
async function paymentsRoute(req, res, parts, tenant, who) {
  const M = req.method; const b = async () => noCardData(JSON.parse((await readBody(req)).toString() || '{}'));
  if (parts[1] === 'orders' && M === 'POST' && !parts[2]) return json(res, 200, await payments.createOrder(tenant, who, await b()));
  if (parts[1] === 'orders' && M === 'GET' && parts[2]) return json(res, 200, await payments.getOrder(tenant, who, parts[2]));
  if (parts[1] === 'simulate' && M === 'POST' && parts[2]) return json(res, 200, await payments.simulate(tenant, who, parts[2], await b()));
  throw new HttpError(404, 'Not found.');
}

async function enforcedRoute(req, res, url, tenant, who, collection, id, sub) {
  const M = req.method; const body = async () => noCardData(JSON.parse((await readBody(req)).toString() || 'null'));
  if (collection === 'audit' && M !== 'GET') throw new HttpError(403, 'The audit trail is written by the server only.');
  if (collection === 'files' && sub === 'content') {
    if (!ID_RE.test(id || '')) throw new HttpError(400, 'Bad id.');
    const row = await svc.get(tenant, who, 'files', id);
    if (M === 'GET') {
      if (!row) throw new HttpError(404, 'No such file.');
      const f = filePath(tenant, id); if (!fs.existsSync(f)) throw new HttpError(404, 'No such file.');
      res.writeHead(200, fileResponseHeaders(fs.existsSync(`${f}.mime`) ? fs.readFileSync(`${f}.mime`, 'utf8') : '', ALLOWED_TYPES));
      return res.end(fs.readFileSync(f));
    }
    if (M === 'PUT') {
      // new bytes go to a new file id only; the bytes of a saved file are replaced only by someone who manages documents
      const f = filePath(tenant, id);
      const manager = await svc.mayManageFiles(tenant, who);
      if (row && !manager) throw Object.assign(new HttpError(403, 'Uploaded files cannot be replaced.'), { code: 'denied' });
      if (!row && fs.existsSync(f) && !manager) throw Object.assign(new HttpError(403, 'Uploaded files cannot be replaced.'), { code: 'denied' });
      if (!row && !(await svc.canWrite(tenant, who, 'files'))) throw new HttpError(403, 'You cannot add files here.');
      const bytes = await readBody(req);
      const chk = checkFileBytes(bytes, req.headers['content-type'], ALLOWED_TYPES, MAX_BYTES);
      if (chk.error) throw Object.assign(new HttpError(400, chk.error), { code: 'bad-file' });
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, bytes); fs.writeFileSync(`${f}.mime`, chk.type); return json(res, 204);
    }
    if (M === 'DELETE') { if (!row) throw new HttpError(404, 'No such file.'); await svc.remove(tenant, who, 'files', id); const f = filePath(tenant, id); fs.rmSync(f, { force: true }); fs.rmSync(`${f}.mime`, { force: true }); return json(res, 204); }
  }
  if (!id) {
    if (M === 'GET') return json(res, 200, await svc.list(tenant, who, collection));
    throw new HttpError(403, 'Replacing a whole collection is not available to clients.');
  }
  if (id === 'query' && M === 'GET') return json(res, 200, await svc.query(tenant, who, collection, parseQuery(url.searchParams)));
  const bulkOpts = (o) => ({ ...(o?.label ? { label: o.label } : {}), ...(o?.summary ? { summary: o.summary } : {}) });
  if (id === '_create-many' && M === 'POST') { const b = await body(); return json(res, 200, await svc.createMany(tenant, who, collection, b.rows || [], bulkOpts(b.opts))); }
  if (id === '_update-many' && M === 'POST') { const b = await body(); return json(res, 200, await svc.updateMany(tenant, who, collection, b.rows || [], bulkOpts(b.opts))); }
  if (id === '_import-many' && M === 'POST') { const b = await body(); return json(res, 200, { count: await svc.importMany(tenant, who, collection, b.rows || [], bulkOpts(b.opts)) }); }
  if (!ID_RE.test(id)) throw new HttpError(400, 'Bad id.');
  if (M === 'GET') { const r = await svc.get(tenant, who, collection, id); if (!r) throw new HttpError(404, 'Not found.'); return json(res, 200, r); }
  if (M === 'PUT') {
    const { __opts, ...b } = (await body()) || {};
    if (b.id !== id) throw new HttpError(400, 'The id in the body must match the address.');
    const summary = typeof __opts?.summary === 'string' && __opts.summary ? __opts.summary : undefined;
    return json(res, 200, await svc.put(tenant, who, collection, b, { label: __opts?.label || undefined, ...(summary ? { summaryOf: () => summary } : {}) }));
  }
  if (M === 'DELETE') { await svc.remove(tenant, who, collection, id); return json(res, 204); }
  throw new HttpError(405, 'Not supported.');
}

async function route(req, res, url) {
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'health') {
    let db = 'down'; try { await pool.query('SELECT 1'); db = 'PostgreSQL'; } catch { /* reported below */ }
    return json(res, db === 'down' ? 503 : 200, { status: db === 'down' ? 'DOWN' : 'UP', database: db, version: 'contract-server 1.1', auth: { mode: AUTH.mode, provider: AUTH.provider }, providers: { storage: 'postgres', files: 'local-disk', mail: 'none', sms: 'none', payments: 'none', gst: 'none' } });
  }
  if (parts[0] === 'auth') return authRoute(req, res, parts, url);
  if (payments && parts[0] === 'payments' && parts[1] === 'webhook' && req.method === 'POST') {   // the provider calls this: no sign-in, no community header; the signature is the credential
    const out = await payments.webhook((await readBody(req)).toString(), String(req.headers['x-webhook-signature'] || ''));
    return json(res, 200, out);
  }
  if (API_KEY && req.headers.authorization !== `Bearer ${API_KEY}`) throw new HttpError(401, 'Missing or wrong access key.');
  if (parts[0] === 'platform') {
    if (!platform) throw Object.assign(new HttpError(404, 'Without AUTH_MODE=enforce the platform console writes the registry directly.'), { code: 'platform-direct' });
    return json(res, 200, await platform.route(req, parts, async () => JSON.parse((await readBody(req)).toString() || '{}')));
  }
  const tenant = String(req.headers['x-community-id'] || '');
  if (!TENANT_RE.test(tenant)) throw new HttpError(400, 'Send a valid X-Community-Id header.');

  if (parts[0] === 'admin' && parts[1] === 'jobs' && parts[2] === 'run' && req.method === 'POST') {
    if (!jobs || (await auth.principalFrom(req, tenant)).roleId !== 'super_admin') throw new HttpError(403, 'Only the Super Admin can run the scheduled jobs.');
    return json(res, 200, await jobs.run());
  }
  if (parts[0] === 'admin' && parts[1] === 'tenants' && req.method === 'DELETE') {
    if (!ALLOW_RESET) throw new HttpError(403, 'Tenant reset is switched off on this server.');
    if (AUTH.mode === 'enforce' && (await auth.principalFrom(req, tenant)).roleId !== 'super_admin') throw new HttpError(403, 'Only the Super Admin can reset a community.');
    if (parts[2] !== tenant || tenant === 'platform') throw new HttpError(400, 'Reset your own community only.');
    await inTx((cl) => repoOn(cl).purgeTenant(tenant));
    fs.rmSync(path.join(FILES_DIR, tenant), { recursive: true, force: true });
    return json(res, 204);
  }
  const who = AUTH.mode === 'enforce' ? await auth.principalFrom(req, tenant) : null;
  if (who) {
    who.ip = req._ip; who.requestId = req._rid;      // written into every audit line this request makes
    if (RATE.on) { const r = limiter.take(`u:${tenant}:${who.userId}`, RATE.user); if (!r.ok) throw Object.assign(new HttpError(429, 'Too many requests. Slow down a little.'), { retryAfter: r.retryAfter, code: 'rate-limited' }); }
  }
  const idemRun = async (h) => {   // Idempotency-Key: a retried write returns the first answer instead of running twice
    if (!who || !req.headers['idempotency-key'] || !['POST', 'PUT', 'DELETE'].includes(req.method) || (parts[2] === 'content') || (parts[1] === 'content')) return h();
    req._raw = await readBody(req);
    return idem.wrap(req, res, { tenant, scope: who.userId || 'anon', rawBody: req._raw }, h);
  };
  if (who && parts[0] === 'evoting' && parts[1] === 'otp' && req.method === 'POST' && ['request', 'verify'].includes(parts[2])) {
    const b = JSON.parse((await readBody(req)).toString() || '{}');
    const r = await svc.evotingOtp(tenant, who, parts[2], b);
    if (parts[2] === 'verify') return json(res, 200, r);
    if (AUTH.otpDelivery === 'log') console.log(`[e-voting code] ${tenant} ${who.name}: ${r.code}`);   // production: replace with the SMS / WhatsApp provider
    return json(res, 200, { sent: true, phoneLast4: r.phoneLast4, expiresIn: 300, ...(AUTH.otpDelivery === 'echo' ? { code: r.code } : {}) });
  }
  if (who && parts[0] === 'payments') return idemRun(() => paymentsRoute(req, res, parts, tenant, who));
  const [collection, id, sub] = parts;
  if (!collection || !COLLECTION_RE.test(collection)) throw new HttpError(400, 'Bad collection name.');
  if (who) return idemRun(() => enforcedRoute(req, res, url, tenant, who, collection, id, sub));
  const t = tenantOf(tenant, collection);

  if (collection === 'files' && sub === 'content') {
    const f = filePath(tenant, id);
    if (req.method === 'PUT') { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, await readBody(req)); fs.writeFileSync(`${f}.mime`, req.headers['content-type'] || 'application/octet-stream'); return json(res, 204); }
    if (req.method === 'GET') {
      if (!fs.existsSync(f)) throw new HttpError(404, 'No such file.');
      res.writeHead(200, { 'Content-Type': fs.existsSync(`${f}.mime`) ? fs.readFileSync(`${f}.mime`, 'utf8') : 'application/octet-stream' });
      return res.end(fs.readFileSync(f));
    }
    if (req.method === 'DELETE') { fs.rmSync(f, { force: true }); fs.rmSync(`${f}.mime`, { force: true }); return json(res, 204); }
  }
  if (!id) {
    if (req.method === 'GET') return json(res, 200, await list(t, collection));
    if (req.method === 'PUT') { await replaceAll(t, collection, JSON.parse(await readBody(req) || '[]')); return json(res, 204); }
  } else if (id === 'query' && req.method === 'GET') {
    return json(res, 200, await query(t, collection, parseQuery(url.searchParams)));
  } else if (id === 'bulk' && req.method === 'POST') {
    return json(res, 200, await putMany(t, collection, JSON.parse(await readBody(req) || '[]')));
  } else {
    if (!ID_RE.test(id)) throw new HttpError(400, 'Bad id.');
    if (req.method === 'GET') { const r = await get(t, collection, id); if (!r) throw new HttpError(404, 'Not found.'); return json(res, 200, r); }
    if (req.method === 'PUT') { const body = JSON.parse(await readBody(req) || '{}'); if (body.id !== id) throw new HttpError(400, 'The id in the body must match the address.'); return json(res, 200, await put(t, collection, body)); }
    if (req.method === 'DELETE') { await repo.remove(t, collection, id); return json(res, 204); }
  }
  throw new HttpError(405, 'Not supported.');
}

const server = http.createServer(async (req, res) => {
  // cookies (the refresh token) need a named origin, never "*": in development "*" echoes the caller's origin; in production CORS_ORIGIN must be set
  const allowed = (process.env.CORS_ORIGIN || '*').split(',').map((x) => x.trim()); const origin = req.headers.origin || '';
  const allow = allowed.includes('*') ? (origin || '*') : (allowed.includes(origin) ? origin : allowed[0]);
  const cors = { 'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Community-Id, X-Platform-Key, If-Match, Idempotency-Key, X-Request-Id', 'Access-Control-Expose-Headers': 'Retry-After, Idempotent-Replay, X-Request-Id', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' };
  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
  req._ip = clientIp(req, TRUST_PROXY); req._rid = String(req.headers['x-request-id'] || '').match(/^[A-Za-z0-9._-]{8,64}$/)?.[0] || crypto.randomUUID();
  res.setHeader('X-Request-Id', req._rid);
  const viaTls = req.socket.encrypted || (TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
  securityHeaders(res, { https: viaTls });
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    if (REQUIRE_HTTPS && !viaTls && !/^\/api\/health/.test(req.url)) throw new HttpError(426, 'HTTPS is required.');
    if (RATE.on) {   // per address, before anything else is done for the caller; sign-in endpoints get a much smaller allowance
      const r = limiter.take(`ip:${req._ip}`, RATE.ip); const a = /^\/api\/auth\/(request-code|verify|refresh|demo)/.test(req.url) ? limiter.take(`auth:${req._ip}`, RATE.auth) : r;
      if (!r.ok || !a.ok) throw Object.assign(new HttpError(429, 'Too many requests. Please wait a moment.'), { retryAfter: (r.ok ? a : r).retryAfter, code: 'rate-limited' });
    }
    await route(req, res, new URL(req.url, 'http://x'));
  }
  catch (e) {
    const status = e.status || (e instanceof SyntaxError ? 400 : 500);
    if (status === 500) console.error(e);
    if (e.retryAfter && !res.headersSent) res.setHeader('Retry-After', String(e.retryAfter));
    if (!res.headersSent) json(res, status, { message: status === 500 ? 'Server error.' : e.message, ...(e.code ? { code: e.code } : {}), ...(e.current ? { current: e.current } : {}), ...(e.errors ? { errors: e.errors } : {}) });
  }
});

await migrate();
// the audit trail is partitioned by month: make sure this month and the next two exist, now and every day
const ensurePartitions = () => pool.query(`SELECT cos_audit_partitions(current_date, (current_date + interval '62 days')::date)`).catch((e) => console.error('[audit] partitions', e.message));
await ensurePartitions(); setInterval(ensurePartitions, 24 * 3600e3).unref();
server.listen(PORT, () => console.log(`CommunityOS contract server on :${PORT} (database ${(process.env.DATABASE_URL || 'default').replace(/:[^:@/]*@/, ':***@')})`));
