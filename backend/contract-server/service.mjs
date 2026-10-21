// The service layer of the contract server: authenticate -> authorize -> stamp -> persist -> audit, all on the server.
//
// It runs the SAME module the screens use (src/lib/storage/secureStorage.js, with src/lib/security/authz.js behind it), so the rule the
// screen hides a button for is the rule the server refuses. Each request gets its own context (AsyncLocalStorage): who is calling,
// which community, and ONE database transaction for everything the request writes - the record, the audit line, the ledger entry,
// the notification. If any step fails, none of it is saved. (Denied attempts are the one exception: they are recorded after the rollback.)
import { AsyncLocalStorage } from 'node:async_hooks';
import { createFieldCrypto } from './fieldcrypto.mjs';
import { redactChanges } from './guards.mjs';
import { createRepository } from './store/repository.mjs';

const als = new AsyncLocalStorage();
export const ctxNow = () => als.getStore();

export async function createService({ pool, tenantOf, UPSERT, stamp, ID_RE, HttpError, srcDir }) {
  const here = (p) => new URL(p, srcDir).href;
  const { setServerAdapter, serverReads, COLLECTIONS: C } = await import(here('lib/storage/index.js'));
  if (process.env.DB_SCOPE === 'off') serverReads.disable();   // test switch: row scope / filters / paging in memory instead of SQL
  const { setContextResolver, getPrincipal } = await import(here('lib/security/principal.js'));
  const { storage } = await import(here('lib/storage/index.js'));
  const { setCommunityResolver } = await import(here('lib/community.js'));
  const { setLockResolver } = await import(here('lib/finance/lock.js'));
  const { setAuditNumbering } = await import(here('lib/audit/auditLog.js'));
  const { secureStorage, setVersionCheck, setShortIdAllocator, ConflictError } = await import(here('lib/storage/secureStorage.js'));
  const { logChange } = await import(here('lib/audit/auditLog.js'));
  const { AuthzError, canReadCollection, canWriteCollection } = await import(here('lib/security/authz.js'));
  const { runQuery } = await import(here('lib/storage/queryEngine.js'));
  const { DEFAULT_SCHEMAS } = await import(here('lib/schema/registry.js'));
  const { refreshUtilityNames } = await import(here('lib/utilityTypes.js'));

  const fc = createFieldCrypto();   // personal numbers are encrypted in the database when DATA_ENCRYPTION_KEY is set
  const plain = (row) => (fc.enabled && row ? fc.decryptRecord(row) : row);

  // ---- the storage adapter every module on the server talks to: this request's transaction ----------------------------
  const adapter = () => {
    const x = als.getStore();
    if (!x) throw new Error('No request context.');
    const T = (c) => tenantOf(x.tenant, c);
    const R = (x.repo ||= createRepository({ q: x.q, HttpError }));   // this request's transaction; knows which collection lives in which table
    return {
      async list(c) { return (await R.list(T(c), c)).map(plain); },
      async get(c, id) { return plain(await R.get(T(c), c, id)) ?? null; },
      async put(c, record) {
        if (!record || typeof record.id !== 'string' || !ID_RE.test(record.id)) throw new HttpError(400, 'Every record needs a string "id".');
        let rec = record;
        if (c === C.AUDIT) rec = { ...record, ...(x.ip ? { ip: x.ip } : {}), ...(x.requestId ? { requestId: x.requestId } : {}), changes: redactChanges(record.changes, fc.fields) };   // who, from where, and never a secret
        const row = plain(await R.put(T(c), c, stamp(fc.enabled && c !== C.AUDIT ? fc.encryptRecord(rec) : rec, new Date().toISOString())));
        if (c === C.AUDIT) x.audit.push(row);
        if (x.meta.collections.has(c)) x.dirty.add(c);
        return row;
      },
      async putMany(c, list) { const out = []; for (const r of list) out.push(await this.put(c, r)); return out; },
      async remove(c, id) { await R.remove(T(c), c, id); if (x.meta.collections.has(c)) x.dirty.add(c); },
      async replaceAll(c, list) { await R.removeAll(T(c), c); for (const r of list) await this.put(c, r); },
      async query(c, params) { return runQuery(await this.list(c), params); },
      // the database does the row scoping, filtering, sorting and paging (see secureStorage.fastQuery); rows come back already limited
      async queryScoped(c, params, scope) { const r = await R.page(T(c), c, params, scope); return { ...r, rows: r.rows.map(plain) }; },
      async selectScoped(c, scope) { return (await R.select(T(c), c, scope)).map(plain); },
      async getScoped(c, id, scope) { return plain(await R.getWhere(T(c), c, id, scope)) ?? null; },
      async forCommunity() { throw new Error('Not available on the server.'); },
      async clearCommunity() { throw new Error('Not available on the server.'); },
    };
  };
  setServerAdapter(adapter);
  setContextResolver(() => als.getStore());
  setCommunityResolver(() => als.getStore()?.tenant || '');
  setLockResolver(() => als.getStore()?.lockedUntil || '');
  setVersionCheck(() => !!als.getStore()?.checkVersion);
  // short ids (TKT-1058): one counter row per community and collection, seeded from the rows already there the first time
  setShortIdAllocator(async (collection, base) => {
    const x = als.getStore(); const t = tenantOf(x.tenant, collection); const R = (x.repo ||= createRepository({ q: x.q, HttpError }));
    let r = await x.q('UPDATE short_id_counters SET last = last + 1 WHERE tenant=$1 AND collection=$2 RETURNING last', [t, collection]);
    if (!r.rowCount) {
      const rows = await R.list(t, collection);
      const seed = rows.reduce((m, row) => { const n = Number(String(row.shortId || row.ticketNumber || '').replace(/^[A-Z]+-/, '')); return Number.isFinite(n) && n > m ? n : m; }, base);
      r = await x.q('INSERT INTO short_id_counters (tenant, collection, last) VALUES ($1,$2,$3) ON CONFLICT (tenant, collection) DO UPDATE SET last = short_id_counters.last + 1 RETURNING last', [t, collection, seed + 1]);
    }
    return Number(r.rows[0].last);
  });
  setAuditNumbering(async () => Number((await als.getStore().q("SELECT nextval('audit_short_seq') AS n")).rows[0].n));

  // ---- who may do what: roles and field definitions of the community, read fresh for every request (META_CACHE_MS=0, the default since round 76;
  // a value above 0 keeps them that many milliseconds, which a very busy server may want) ------
  const META_TTL = Number(process.env.META_CACHE_MS || 0);
  const metaCache = new Map();
  async function metaFor(tenant) {
    const hit = metaCache.get(tenant);
    if (hit && Date.now() - hit.at < META_TTL) return hit;
    const rd = async (c) => (await pool.query('SELECT data FROM documents WHERE tenant=$1 AND collection=$2 ORDER BY seq', [tenant, c])).rows.map((r) => r.data);
    const [roles, stored, fin] = await Promise.all([rd(C.ROLES), rd(C.SCHEMA), rd(C.FINANCE_SETTINGS)]);
    const schemas = [...stored, ...DEFAULT_SCHEMAS.filter((d) => !stored.some((s) => s.id === d.id))];
    const meta = { at: Date.now(), roles, schemas, lockedUntil: String(fin[0]?.lockedUntil || '').slice(0, 10), collections: new Set([C.ROLES, C.SCHEMA, C.FINANCE_SETTINGS, C.ROLE_GROUPS, C.USERS]) };
    metaCache.set(tenant, meta);
    return meta;
  }

  const principalFor = (tenant, who, meta) => {
    const base = meta.roles.find((r) => r.id === who.roleId);
    if (!base) return null;   // an unknown role can do nothing
    const role = who.system ? { ...base, name: who.name } : base;   // system jobs show up in the audit trail under their own name
    return { roleId: who.roleId, role, name: who.name, unit: who.unit || '', blocks: who.blocks || [], community: tenant, userId: who.userId, phone: who.phone || '', email: who.email || '' };
  };

  /** Runs fn as `who` in `tenant`. write=true wraps everything fn does in one transaction. */
  // isolation: 'REPEATABLE READ' | 'SERIALIZABLE' for money. PostgreSQL then aborts one of two conflicting transactions (SQLSTATE 40001, or 40P01 on
  // a deadlock); that is not an error for the caller: the whole transaction is simply run again (up to 4 times), now seeing the other one's result.
  async function run(tenant, who, opts = {}, fn) {
    if (!opts.isolation || !opts.write) return runOnce(tenant, who, opts, fn);
    for (let attempt = 1; ; attempt++) {
      try { return await runOnce(tenant, who, opts, fn); }
      catch (e) { if (!['40001', '40P01'].includes(e?.code) || attempt >= 4) throw e; await new Promise((r) => setTimeout(r, 15 * attempt + Math.random() * 25)); }
    }
  }
  async function runOnce(tenant, who, { write = false, checkVersion = false, isolation = '' } = {}, fn) {
    const meta = await metaFor(tenant);
    const client = write ? await pool.connect() : pool;
    const x = { tenant, client, q: null, tail: Promise.resolve(), ip: who.ip || '', requestId: who.requestId || '', principal: principalFor(tenant, who, meta), schemas: meta.schemas, lockedUntil: meta.lockedUntil, audit: [], dirty: new Set(), meta, checkVersion };
    // modules run queries in parallel (Promise.all); one connection does one thing at a time, so they queue here in order
    x.q = (sql, args) => { const go = x.tail.then(() => client.query(sql, args)); x.tail = go.catch(() => {}); return go; };
    return als.run(x, async () => {
      try {
        if (write) await client.query(isolation ? `BEGIN ISOLATION LEVEL ${isolation === 'SERIALIZABLE' ? 'SERIALIZABLE' : 'REPEATABLE READ'}` : 'BEGIN');
        await refreshUtilityNames().catch(() => {});
        const out = await fn(x);
        if (write) { const done = await client.query('COMMIT'); if (done.command === 'ROLLBACK') throw new Error('The transaction was rolled back (an earlier step failed).'); }
        for (const c of x.dirty) metaCache.delete(tenant);
        return out;
      } catch (e) {
        if (write) {
          await client.query('ROLLBACK').catch(() => {});
          // a refused attempt is evidence: keep it even though the rest of the request was rolled back
          for (const a of x.audit.filter((r) => r.action === 'Denied')) await createRepository({ q: (sql, args) => pool.query(sql, args), HttpError }).put(tenant, C.AUDIT, a).catch(() => {});
        }
        throw e;
      } finally { if (write) client.release(); }
    });
  }

  // Writers of the same record queue up here (SELECT ... FOR UPDATE), so the version check that follows sees the latest saved version.
  const lockRows = async (collection, ids) => { const x = als.getStore(); await (x.repo ||= createRepository({ q: x.q, HttpError })).lock(tenantOf(x.tenant, collection), collection, ids); };
  // What the screens may ask for but the server settles itself. Everyone, even the Super Admin, goes through the endpoints that do the checking.
  const RESIDENT_NO_DIRECT = new Set([C.DUES, C.LEDGER, C.UNIT_CREDITS]);
  const clientGuard = async (collection, x, op, record) => {
    if (x.principal?.role?.category === 'Resident' && RESIDENT_NO_DIRECT.has(collection)) {
      const reason = 'Payments are confirmed by the payment service, not by the app. Use Pay on the bill.';
      const p = x.principal;
      await logChange({ who: `${p.name} (${p.role?.name})`, whoName: p.name, what: collection, collection, recordId: record?.id ?? '', recordShortId: record?.shortId ?? '', unit: record?.unit || '', action: 'Denied', summary: `${op} blocked: ${reason}`, changes: [] });
      throw new AuthzError(reason);
    }
  };

  const asHttp = (e) => {
    if (e instanceof ConflictError) { const h = new HttpError(409, e.message); h.code = 'conflict'; h.current = e.current; return h; }
    if (e instanceof AuthzError || e?.name === 'AuthzError') { const h = new HttpError(403, e.message); h.code = 'denied'; return h; }
    return e;
  };
  const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { throw asHttp(e); } };

  /** A server job (webhook, reconcile, scheduler): acts as the system, in one transaction. */
  const runSystem = (tenant, name, opts, fn) => run(tenant, { system: true, roleId: 'super_admin', name, userId: `system:${name}` }, opts, fn);
  const tenants = async () => (await pool.query("SELECT DISTINCT tenant FROM users WHERE tenant <> 'platform'")).rows.map((r) => r.tenant);

  return {
    run, runSystem, tenants, metaFor, asHttp,
    // The second factor of e-voting: the code is asked for and checked HERE, so the proof that the voter-roll write demands lives where the write is checked.
    evotingOtp: guard((t, who, action, body) => run(t, who, {}, async () => {
      const ev = await import(here('lib/evoting.js'));
      const ballot = await storage.get(C.BALLOTS, String(body?.ballotId ?? ''));
      if (!ballot) throw new HttpError(400, 'No such ballot');
      try {
        if (action === 'request') return await ev.requestOtp(ballot, getPrincipal());
        if (action === 'verify') return { proof: await ev.verifyOtp(ballot, getPrincipal(), body?.code) };
      } catch (e) { throw Object.assign(new HttpError(400, e.message), { code: 'evoting' }); }
      throw new HttpError(404, 'Not found.');
    })),
    list: guard((t, who, c) => run(t, who, {}, () => secureStorage.list(c))),
    query: guard((t, who, c, params) => run(t, who, {}, () => secureStorage.query(c, params))),
    get: guard((t, who, c, id) => run(t, who, {}, () => secureStorage.get(c, id))),
    put: guard((t, who, c, record, opts) => run(t, who, { write: true, checkVersion: true }, async (x) => { await clientGuard(c, x, 'Update', record); await lockRows(c, [record?.id]); return secureStorage.put(c, record, opts || {}); })),
    remove: guard((t, who, c, id, opts) => run(t, who, { write: true }, async (x) => { await clientGuard(c, x, 'Delete', { id }); await lockRows(c, [id]); return secureStorage.remove(c, id, opts || {}); })),
    createMany: guard((t, who, c, rows, opts) => run(t, who, { write: true }, async (x) => { await clientGuard(c, x, 'Create', rows[0]); return secureStorage.createMany(c, rows, opts || {}); })),
    updateMany: guard((t, who, c, rows, opts) => run(t, who, { write: true }, async (x) => { await clientGuard(c, x, 'Update', rows[0]); await lockRows(c, rows.map((r) => r.id)); return secureStorage.updateMany(c, rows, opts || {}); })),
    importMany: guard((t, who, c, rows, opts) => run(t, who, { write: true }, async (x) => { await clientGuard(c, x, 'Import', rows[0]); return secureStorage.importMany(c, rows, opts || {}); })),
    canWrite: (t, who, c) => run(t, who, {}, (x) => !!x.principal && canWriteCollection(c, x.principal)),
    /** May replace the bytes of a saved file: the Super Admin and document managers (the same rule as editing a file record). */
    mayManageFiles: (t, who) => run(t, who, {}, (x) => !!x.principal && (x.principal.roleId === 'super_admin' || !!x.principal.role?.permissions?.includes('MANAGE_DOCUMENTS'))),
    canRead: (t, who, c) => run(t, who, {}, (x) => !!x.principal && canReadCollection(c, x.principal)),
  };
}
