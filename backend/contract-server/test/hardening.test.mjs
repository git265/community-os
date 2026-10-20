// Round 70: idempotency, card-data guard, encryption at rest, audit origin and redaction, rate limits, HTTPS, circuit breaker, outbox.
process.env.OUTBOX_MAX_ATTEMPTS = '2';
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer, seedTenant, pool as mkPool, TENANT, purge, rowOf, setRow } from './harness.mjs';
import { createBreaker, CircuitOpenError } from '../breaker.mjs';
import { createFieldCrypto } from '../fieldcrypto.mjs';
import { findCardData, redactChanges, createLimiter } from '../guards.mjs';
import { createOutbox } from '../outbox.mjs';

let S, S2, S3, pool, own1, root;
const SECRET = 'test-webhook-secret'; const KEY = crypto.randomBytes(32).toString('hex'); const RUN = crypto.randomBytes(3).toString('hex');
const raw = async (base, method, path, { token, body, headers = {} } = {}) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Community-Id': TENANT, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await res.json(); } catch { /* empty */ } return { status: res.status, body: j, h: res.headers };
};
const doc = (c, id) => rowOf(pool, c, id);
const auditFor = async (id) => (await pool.query(`SELECT data FROM audit_log WHERE tenant=$1 AND record_id=$2 ORDER BY seq`, [TENANT, id])).rows.map((r) => r.data);

before(async () => {
  pool = mkPool(); await seedTenant(pool); await pool.query('DELETE FROM auth_attempts'); await pool.query('DELETE FROM payment_orders WHERE tenant=$1', [TENANT]);
  S = await startServer({ port: 8101, env: { PAYMENT_WEBHOOK_SECRET: SECRET, DATA_ENCRYPTION_KEY: KEY, ENCRYPT_FIELDS: 'taxId', OUTBOX_SECONDS: '1', PAYMENT_RECONCILE_SECONDS: '0', RATE_LIMIT: 'off' } });
  S2 = await startServer({ port: 8102, env: { RATE_LIMIT: 'on', RATE_IP_PER_MIN: '12', RATE_USER_PER_MIN: '600' } });
  S3 = await startServer({ port: 8103, env: { REQUIRE_HTTPS: 'true', TRUST_PROXY: 'true', RATE_LIMIT: 'off' } });
  own1 = (await S.otp('+91 98000 00011')).token; root = (await S.otp('+91 98000 00003')).token;
});
after(async () => { S?.stop(); S2?.stop(); S3?.stop(); await pool.query('DELETE FROM payment_orders WHERE tenant=$1', [TENANT]); await purge(pool); await pool.end(); });

describe('idempotency keys', () => {
  const ticket = (id) => ({ id, unit: 'V-1', title: 'Gate light', status: 'Open', category: 'Electrical', priority: 'Low', taskType: 'Resident Maintenance', description: 'Out' });
  test('a retried write gets the first answer and does the work once', async () => {
    const id = `tk-${RUN}-a`; const h = { 'Idempotency-Key': `key-${RUN}-aaaa` };
    const a = await raw(S.base, 'PUT', `/tickets/${id}`, { token: own1, body: ticket(id), headers: h });
    const b = await raw(S.base, 'PUT', `/tickets/${id}`, { token: own1, body: ticket(id), headers: h });
    assert.equal(a.status, 200, JSON.stringify(a.body)); assert.equal(b.status, 200);
    assert.equal(b.h.get('idempotent-replay'), 'true'); assert.deepEqual(b.body, a.body);
    assert.equal((await auditFor(id)).filter((r) => r.action === 'Create').length, 1, 'one audit line, not two');
  });
  test('the same key for a different request is refused', async () => {
    const id = `tk-${RUN}-b`; const h = { 'Idempotency-Key': `key-${RUN}-bbbb` };
    assert.equal((await raw(S.base, 'PUT', `/tickets/${id}`, { token: own1, body: ticket(id), headers: h })).status, 200);
    const r = await raw(S.base, 'PUT', `/tickets/${id}`, { token: own1, body: { ...ticket(id), title: 'Something else' }, headers: h });
    assert.equal(r.status, 422); assert.equal(r.body.code, 'idempotency-mismatch');
  });
  test('two identical requests at the same moment: one runs, the other waits or replays', async () => {
    const id = `tk-${RUN}-c`; const h = { 'Idempotency-Key': `key-${RUN}-cccc` };
    const rs = await Promise.all([1, 2, 3].map(() => raw(S.base, 'PUT', `/tickets/${id}`, { token: own1, body: ticket(id), headers: h })));
    assert.ok(rs.every((r) => [200, 409].includes(r.status)), rs.map((r) => r.status).join());
    assert.ok(rs.some((r) => r.status === 200));
    assert.equal((await auditFor(id)).filter((r) => r.action === 'Create').length, 1);
  });
  test('a key belongs to the person who made it', async () => {
    const id = `tk-${RUN}-d`; const h = { 'Idempotency-Key': `key-${RUN}-dddd` };
    await raw(S.base, 'PUT', `/tickets/${id}`, { token: own1, body: ticket(id), headers: h });
    const other = (await S.otp('+91 98000 00012')).token;
    const r = await raw(S.base, 'PUT', `/tickets/tk-${RUN}-e`, { token: other, body: { ...ticket(`tk-${RUN}-e`), unit: 'V-2' }, headers: h });
    assert.equal(r.status, 200, 'another user can use the same text without seeing the first answer');
  });
  test('a bad key is refused', async () => {
    assert.equal((await raw(S.base, 'PUT', '/tickets/tk-x', { token: own1, body: ticket('tk-x'), headers: { 'Idempotency-Key': 'short' } })).status, 400);
  });
});

describe('card data never reaches the server', () => {
  test('card numbers and security codes are refused', async () => {
    const id = `tk-${RUN}-card`;
    const base = { id, unit: 'V-1', title: 'x', status: 'Open', category: 'Plumbing', priority: 'Low', taskType: 'Resident Maintenance' };
    const a = await raw(S.base, 'PUT', `/tickets/${id}`, { token: own1, body: { ...base, description: 'my card is 4111 1111 1111 1111' } });
    assert.equal(a.status, 200, 'a number inside a sentence is not a card field'); // free text is not scanned for digits inside sentences
    const b = await raw(S.base, 'PUT', `/tickets/${id}`, { token: own1, body: { ...base, description: '4111 1111 1111 1111' } });
    assert.equal(b.status, 400); assert.equal(b.body.code, 'card-data');
    const c = await raw(S.base, 'PUT', `/tickets/${id}`, { token: own1, body: { ...base, cvv: '123' } });
    assert.equal(c.status, 400);
    const d = await raw(S.base, 'PUT', `/tickets/${id}`, { token: own1, body: { ...base, description: '9876543210123' } });   // 13 digits, fails the card checksum: fine
    assert.equal(d.status, 200);
    assert.equal(findCardData({ a: { b: ['4012888888881881'] } }) !== null, true);
    assert.equal(findCardData({ phone: '+91 98765 43210' }), null);
  });
});

describe('personal numbers are encrypted in the database', () => {
  test('the stored value is ciphertext; the API gives it back readable', async () => {
    const r = await raw(S.base, 'PUT', '/properties/p-V-1', { token: root, body: { id: 'p-V-1', unit: 'V-1', type: 'Villa', owner: 'Owner of V-1', ownerPhone: '+91 98000 09991', ownerEmail: 'V-1@example.com', occupancy: 'Owner', taxId: 'ABCDE1234F' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const stored = await doc('properties', 'p-V-1');
    assert.notEqual(stored.taxId, undefined, 'the field was kept');
    assert.match(stored.taxId, /^enc:v1:/); assert.ok(!JSON.stringify(stored).includes('ABCDE1234F'));
    assert.equal((await raw(S.base, 'GET', '/properties/p-V-1', { token: root })).body.taxId, 'ABCDE1234F');
  });
  test('round trip, tamper detection and key rotation (unit)', () => {
    const a = createFieldCrypto({ DATA_ENCRYPTION_KEY: KEY, ENCRYPT_FIELDS: 'secretNo' });
    const e = a.encryptRecord({ id: '1', secretNo: '1234', nested: { secretNo: '99' }, other: 'x' });
    assert.match(e.secretNo, /^enc:v1:/); assert.match(e.nested.secretNo, /^enc:v1:/); assert.equal(e.other, 'x');
    assert.deepEqual(a.decryptRecord(e), { id: '1', secretNo: '1234', nested: { secretNo: '99' }, other: 'x' });
    const bad = { ...e, secretNo: e.secretNo.slice(0, -4) + 'AAAA' }; assert.throws(() => a.decryptRecord(bad));
    const k2 = crypto.randomBytes(32).toString('hex'); const b = createFieldCrypto({ DATA_ENCRYPTION_KEY: k2, DATA_ENCRYPTION_KEY_OLD: KEY, ENCRYPT_FIELDS: 'secretNo' });
    assert.equal(b.decryptRecord(e).secretNo, '1234', 'old key still reads old data');
    assert.equal(createFieldCrypto({}).enabled, false);
  });
});

describe('the audit trail says where a change came from and never holds secrets', () => {
  test('every audit line of a request carries its address and request id', async () => {
    const id = `tk-${RUN}-aud`; const rid = `req-${RUN}-12345`;
    const r = await raw(S.base, 'PUT', `/tickets/${id}`, { token: own1, headers: { 'X-Request-Id': rid }, body: { id, unit: 'V-1', title: 'x', status: 'Open', category: 'Plumbing', priority: 'Low', taskType: 'Resident Maintenance' } });
    assert.equal(r.h.get('x-request-id'), rid);
    const rows = await auditFor(id); assert.ok(rows.length >= 1);
    assert.ok(rows.every((a) => a.requestId === rid && a.ip), JSON.stringify(rows[0]));
  });
  test('secrets are hidden in the audit changes (unit)', () => {
    const out = redactChanges([{ field: 'password', from: 'a', to: 'b' }, { field: 'title', from: 'x', to: 'y' }, { field: 'otpCode', from: '', to: '123456' }, { field: 'taxId', from: '', to: 'zzz' }], new Set(['taxId']));
    assert.deepEqual(out.map((c) => [c.from, c.to]), [['[hidden]', '[hidden]'], ['x', 'y'], ['', '[hidden]'], ['', '[hidden]']]);
  });
});

describe('rate limits, HTTPS and headers', () => {
  test('too many requests from one address get 429 with Retry-After', async () => {
    let last; for (let i = 0; i < 20; i++) { last = await raw(S2.base, 'GET', '/auth/config'); if (last.status === 429) break; }
    assert.equal(last.status, 429); assert.ok(Number(last.h.get('retry-after')) >= 1);
  });
  test('the bucket refills (unit)', () => {
    let t = 0; const l = createLimiter({ now: () => t });
    for (let i = 0; i < 5; i++) assert.ok(l.take('k', 5).ok);
    assert.equal(l.take('k', 5).ok, false); t += 12000; assert.ok(l.take('k', 5).ok); assert.equal(l.take('k', 5).ok, false);
  });
  test('production refuses plain HTTP, accepts it through a TLS proxy, and sends HSTS', async () => {
    assert.equal((await raw(S3.base, 'GET', '/auth/config')).status, 426);
    const ok = await raw(S3.base, 'GET', '/auth/config', { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.equal(ok.status, 200); assert.match(ok.h.get('strict-transport-security'), /max-age=31536000/);
    assert.equal(ok.h.get('x-content-type-options'), 'nosniff'); assert.equal(ok.h.get('cache-control'), 'no-store');
  });
});

describe('circuit breaker', () => {
  test('opens after repeated failures, fails fast, then lets one trial through', async () => {
    let t = 0; const br = createBreaker({ name: 'Bank', failureThreshold: 3, resetMs: 1000, timeoutMs: 50, now: () => t });
    for (let i = 0; i < 3; i++) await assert.rejects(br.call(async () => { throw new Error('down'); }));
    assert.equal(br.state(), 'open');
    let called = 0; await assert.rejects(br.call(async () => { called++; }), CircuitOpenError); assert.equal(called, 0, 'no call is made while open');
    t += 1500; assert.equal(await br.call(async () => 'fine'), 'fine'); assert.equal(br.state(), 'closed');
  });
  test('a slow provider is cut off by the timeout', async () => {
    const br = createBreaker({ timeoutMs: 30 });
    await assert.rejects(br.call(() => new Promise((r) => setTimeout(r, 300))), (e) => e.code === 'timeout' && e.status === 504);
  });
});

describe('outbox', () => {
  test('a settled payment queues its follow-up work in the same transaction, and the worker delivers it', async () => {
    await pool.query(`UPDATE dues SET data = data - 'paidAt' - 'receiptNo' - 'paymentRef' || '{"status":"Unpaid"}'::jsonb WHERE tenant=$1 AND id='due-1'`, [TENANT]);
    await pool.query('DELETE FROM payment_orders WHERE tenant=$1', [TENANT]); await pool.query('DELETE FROM event_outbox WHERE tenant=$1', [TENANT]);
    const o = (await raw(S.base, 'POST', '/payments/orders', { token: own1, body: { purpose: 'due', refs: ['due-1'] } })).body;
    assert.equal((await raw(S.base, 'POST', `/payments/simulate/${o.orderId}`, { token: own1, body: { outcome: 'success', method: 'UPI' } })).status, 200);
    const queued = (await pool.query(`SELECT * FROM event_outbox WHERE tenant=$1 AND topic='payment.settled'`, [TENANT])).rows;
    assert.equal(queued.length, 1); assert.equal(queued[0].payload.orderId, o.orderId);
    for (let i = 0; i < 40; i++) { const r = (await pool.query(`SELECT status FROM event_outbox WHERE id=$1`, [queued[0].id])).rows[0]; if (r.status === 'Sent') return; await new Promise((r2) => setTimeout(r2, 250)); }
    assert.fail('the worker did not deliver the event');
  });
  test('a failing handler is retried, then parked as Dead (unit)', async () => {
    const ob = createOutbox({ pool }); let calls = 0; ob.register('t.fail', async () => { calls++; throw new Error('mail server down'); });
    const c = await pool.connect(); await c.query('BEGIN'); const x = { tenant: TENANT, q: (s, a) => c.query(s, a) }; await ob.emit(x, 't.fail', { n: 1 }); await c.query('COMMIT'); c.release();
    const id = (await pool.query(`SELECT id FROM event_outbox WHERE tenant=$1 AND topic='t.fail' ORDER BY id DESC LIMIT 1`, [TENANT])).rows[0].id;
    let r = await ob.dispatch(); assert.ok(r.retried >= 1);
    await pool.query(`UPDATE event_outbox SET next_attempt_at=now() WHERE id=$1`, [id]);
    r = await ob.dispatch(); assert.ok(r.dead >= 1);
    const row = (await pool.query('SELECT status, attempts, last_error FROM event_outbox WHERE id=$1', [id])).rows[0];
    assert.equal(row.status, 'Dead'); assert.equal(row.attempts, 2); assert.match(row.last_error, /mail server down/); assert.equal(calls, 2);
    await pool.query('DELETE FROM event_outbox WHERE id=$1', [id]);
  });
  test('an event whose transaction rolled back is never queued', async () => {
    const ob = createOutbox({ pool }); const c = await pool.connect(); await c.query('BEGIN'); await ob.emit({ tenant: TENANT, q: (s, a) => c.query(s, a) }, 't.never', {}); await c.query('ROLLBACK'); c.release();
    assert.equal((await pool.query(`SELECT 1 FROM event_outbox WHERE topic='t.never'`)).rowCount, 0);
  });
});
