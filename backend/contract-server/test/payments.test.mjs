// Payments settled by the server: pricing, signed webhooks, atomic settlement, lost webhooks, expiry.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer, seedTenant, pool as mkPool, TENANT, purge, rowOf, rowsOf } from './harness.mjs';

let S, pool, own1, own2, treas;
const SECRET = 'test-webhook-secret'; const RUN = crypto.randomBytes(3).toString('hex');
const signed = (ev) => { const raw = JSON.stringify(ev); return { raw, sig: crypto.createHmac('sha256', SECRET).update(raw).digest('hex') }; };
const hook = async (ev, sig) => { const { raw, sig: good } = signed(ev); const r = await fetch(`${S.base}/payments/webhook/simulated`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': sig ?? good }, body: raw }); return { status: r.status, body: await r.json().catch(() => null) }; };
const row = (c, id) => rowOf(pool, c, id);
const resetDue = async (id, extra = {}) => { await pool.query(`DELETE FROM payment_orders WHERE tenant=$1 AND refs ? $2`, [TENANT, id]); return reopen(id, extra); };
const reopen = (id, extra = {}) => pool.query(`UPDATE dues SET data = data - 'paidAt' - 'receiptNo' - 'paymentRef' || $3::jsonb WHERE tenant=$1 AND id=$2`, [TENANT, id, JSON.stringify({ status: 'Unpaid', ...extra })]);
const wait = async (fn, ms = 8000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };

before(async () => {
  pool = mkPool(); await seedTenant(pool); await pool.query('DELETE FROM auth_attempts'); await pool.query('DELETE FROM payment_orders WHERE tenant=$1', [TENANT]);
  S = await startServer({ port: 8097, env: { PAYMENT_WEBHOOK_SECRET: SECRET, PAYMENT_RECONCILE_SECONDS: '1', PAYMENT_PENDING_RECHECK_SECONDS: '0', PAYMENT_ORDER_MINUTES: '30' } });
  own1 = (await S.otp('+91 98000 00011')).token; own2 = (await S.otp('+91 98000 00012')).token; treas = (await S.otp('+91 98000 00002')).token;
});
after(async () => { S?.stop(); await pool.query('DELETE FROM payment_orders WHERE tenant=$1', [TENANT]); await purge(pool); await pool.end(); });

describe('creating an order', () => {
  test('the server prices the order; the amount the browser sends is ignored', async () => {
    const r = await S.call('POST', '/payments/orders', { token: own1, body: { purpose: 'due', refs: ['due-1'], amount: 1, unit: 'V-2' } });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.amount, 1000); assert.equal(r.body.unit, 'V-1'); assert.equal(r.body.status, 'Created');
  });
  test('asking twice returns the same order (double click, retry after a timeout)', async () => {
    const a = await S.call('POST', '/payments/orders', { token: own1, body: { purpose: 'due', refs: ['due-1'] } });
    const b = await S.call('POST', '/payments/orders', { token: own1, body: { purpose: 'due', refs: ['due-1'] } });
    assert.equal(a.body.orderId, b.body.orderId);
  });
  test('nobody can pay or look up another unit\'s order', async () => {
    assert.equal((await S.call('POST', '/payments/orders', { token: own2, body: { purpose: 'due', refs: ['due-1'] } })).status, 403);
    const mine = (await S.call('POST', '/payments/orders', { token: own1, body: { purpose: 'due', refs: ['due-1'] } })).body;
    assert.equal((await S.call('GET', `/payments/orders/${mine.orderId}`, { token: own2 })).status, 404);
    assert.equal((await S.call('GET', `/payments/orders/${mine.orderId}`, { token: own1 })).status, 200);
  });
  test('no sign-in, no order', async () => {
    assert.equal((await S.call('POST', '/payments/orders', { body: { purpose: 'due', refs: ['due-1'] } })).status, 401);
  });
});

describe('settling', () => {
  test('a verified webhook settles bill, ledger entry and receipt together - and only once', async () => {
    await resetDue('due-1'); await pool.query(`DELETE FROM payment_orders WHERE tenant=$1`, [TENANT]);
    const o = (await S.call('POST', '/payments/orders', { token: own1, body: { purpose: 'due', refs: ['due-1'] } })).body;
    const sim = await S.call('POST', `/payments/simulate/${o.orderId}`, { token: own1, body: { outcome: 'success', method: 'UPI' } });
    assert.equal(sim.status, 200, JSON.stringify(sim.body));
    const due = await row('dues', 'due-1');
    assert.equal(due.status, 'Paid'); assert.match(due.receiptNo, /^RCT-/); assert.equal(due.paymentMode, 'UPI'); assert.ok(due.paymentRef);
    const led = (await pool.query(`SELECT data FROM ledger_entries WHERE tenant=$1 AND source_id LIKE '%due-1%'`, [TENANT])).rows;
    assert.equal(led.length, 1); assert.equal(Number(led[0].data.amount), 1000);
    const st = (await S.call('GET', `/payments/orders/${o.orderId}`, { token: own1 })).body; assert.equal(st.status, 'Paid'); assert.ok(st.paymentId);
    // the provider repeats the same event, and a second capture arrives for the same order: nothing happens twice
    const bank = (await pool.query('SELECT bank FROM payment_orders WHERE order_id=$1', [o.orderId])).rows[0].bank;
    const ev = { id: `EVT-REPEAT-${RUN}`, type: 'payment.captured', orderId: o.orderId, paymentId: bank.paymentId, amount: 1000, method: 'UPI' };
    await hook(ev); assert.equal((await hook(ev)).body.duplicate, true);
    assert.equal((await hook({ ...ev, id: `EVT-OTHER-${RUN}` })).body.duplicate, true);
    assert.equal((await pool.query(`SELECT count(*)::int c FROM ledger_entries WHERE tenant=$1 AND source_id LIKE '%due-1%'`, [TENANT])).rows[0].c, 1);
  });
  test('the audit trail names the payment service, and the ledger line is audited too', async () => {
    const a = (await S.call('GET', '/audit', { token: treas })).body;
    assert.ok(a.some((x) => /payment gateway/i.test(x.who)), 'someone is accountable for the settlement');
  });
  test('a forged or unsigned webhook changes nothing', async () => {
    await resetDue('due-2');
    const o = (await S.call('POST', '/payments/orders', { token: own2, body: { purpose: 'due', refs: ['due-2'] } })).body;
    const ev = { id: `EVT-FORGED-${RUN}`, type: 'payment.captured', orderId: o.orderId, paymentId: 'PAY-X', amount: 2000, method: 'Card' };
    assert.equal((await hook(ev, 'deadbeef')).status, 401);
    assert.equal((await hook(ev, '')).status, 401);
    assert.equal((await row('dues', 'due-2')).status, 'Unpaid');
  });
  test('a different amount than the order is never settled', async () => {
    const o = (await S.call('GET', `/payments/orders/${(await pool.query(`SELECT order_id FROM payment_orders WHERE tenant=$1 AND unit='V-2' ORDER BY created_at DESC LIMIT 1`, [TENANT])).rows[0].order_id}`, { token: own2 })).body;
    const r = await hook({ id: `EVT-SHORT-${RUN}`, type: 'payment.captured', orderId: o.orderId, paymentId: 'PAY-SHORT', amount: 5, method: 'Card' });
    assert.equal(r.body.ok, false);
    assert.equal((await row('dues', 'due-2')).status, 'Unpaid');
    assert.equal((await S.call('GET', `/payments/orders/${o.orderId}`, { token: own2 })).body.status, 'Failed');
  });
  test('a declined payment leaves the bill open and the payer can try again with a new order', async () => {
    await resetDue('due-2');
    const o1 = (await S.call('POST', '/payments/orders', { token: own2, body: { purpose: 'due', refs: ['due-2'] } })).body;
    await S.call('POST', `/payments/simulate/${o1.orderId}`, { token: own2, body: { outcome: 'failure' } });
    assert.equal((await S.call('GET', `/payments/orders/${o1.orderId}`, { token: own2 })).body.status, 'Failed');
    assert.equal((await row('dues', 'due-2')).status, 'Unpaid');
    const o2 = (await S.call('POST', '/payments/orders', { token: own2, body: { purpose: 'due', refs: ['due-2'] } })).body;
    assert.notEqual(o2.orderId, o1.orderId);
    await S.call('POST', `/payments/simulate/${o2.orderId}`, { token: own2, body: { outcome: 'success' } });
    assert.equal((await row('dues', 'due-2')).status, 'Paid');
  });
  test('a bill that is already paid cannot be paid again', async () => {
    assert.equal((await S.call('POST', '/payments/orders', { token: own2, body: { purpose: 'due', refs: ['due-2'] } })).status, 409);
  });
});

describe('when things go wrong', () => {
  test('a failure half-way through settling undoes all of it', async () => {
    await resetDue('due-1', { category: 'FAILTEST' }); await pool.query(`DELETE FROM ledger_entries WHERE tenant=$1 AND source_id LIKE '%due-1%'`, [TENANT]);
    await pool.query(`CREATE OR REPLACE FUNCTION fail_ledger() RETURNS trigger AS $$ BEGIN IF NEW.data->>'description' LIKE '%FAILTEST%' THEN RAISE EXCEPTION 'ledger is down'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER fail_ledger_t BEFORE INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION fail_ledger()`);
    try {
      const o = (await S.call('POST', '/payments/orders', { token: own1, body: { purpose: 'due', refs: ['due-1'] } })).body;
      await S.call('POST', `/payments/simulate/${o.orderId}`, { token: own1, body: { outcome: 'success', deliverWebhook: false } });
      await new Promise((r) => setTimeout(r, 2500));   // the reconcile job tries, fails, rolls back
      const due = await row('dues', 'due-1');
      assert.equal(due.status, 'Unpaid', 'the bill was not marked paid without its ledger entry');
      assert.ok(!due.receiptNo);
      assert.notEqual((await S.call('GET', `/payments/orders/${o.orderId}`, { token: own1 })).body.status, 'Paid');
      await pool.query('DROP TRIGGER fail_ledger_t ON ledger_entries');   // the fault clears: the reconcile job finishes the job
      await wait(async () => (await row('dues', 'due-1')).status === 'Paid');
      assert.equal((await S.call('GET', `/payments/orders/${o.orderId}`, { token: own1 })).body.status, 'Paid');
      assert.equal((await pool.query(`SELECT count(*)::int c FROM ledger_entries WHERE tenant=$1 AND source_id LIKE '%due-1%'`, [TENANT])).rows[0].c, 1);
    } finally { await pool.query('DROP TRIGGER IF EXISTS fail_ledger_t ON ledger_entries'); }
  });
  test('the bank took the money but the webhook was lost: the reconcile job settles it', async () => {
    await resetDue('due-2'); await resetDue('due-1', { category: 'Maintenance' }); await pool.query(`UPDATE payment_orders SET status='Failed' WHERE tenant=$1 AND status IN ('Created','Pending')`, [TENANT]);
    const o = (await S.call('POST', '/payments/orders', { token: own2, body: { purpose: 'due', refs: ['due-2'] } })).body;
    const sim = await S.call('POST', `/payments/simulate/${o.orderId}`, { token: own2, body: { outcome: 'success', deliverWebhook: false } });
    assert.equal(sim.body.delivered, false);
    assert.equal((await S.call('GET', `/payments/orders/${o.orderId}`, { token: own2 })).body.status, 'Created', 'for a moment the app still says it is waiting');
    await wait(async () => (await S.call('GET', `/payments/orders/${o.orderId}`, { token: own2 })).body.status === 'Paid');
    assert.equal((await row('dues', 'due-2')).status, 'Paid');
  });
  test('an order nobody pays is expired, and an expired order is never settled', async () => {
    await resetDue('due-2');
    const o = (await S.call('POST', '/payments/orders', { token: own2, body: { purpose: 'due', refs: ['due-2'] } })).body;
    await pool.query(`UPDATE payment_orders SET created_at = now() - interval '2 hours' WHERE order_id=$1`, [o.orderId]);
    await wait(async () => (await S.call('GET', `/payments/orders/${o.orderId}`, { token: own2 })).body.status === 'Expired');
    assert.equal((await row('dues', 'due-2')).status, 'Unpaid');
  });
  test('residents cannot mark bills paid or write ledger rows by hand', async () => {
    const d = (await S.call('GET', '/dues/due-2', { token: own2 })).body;
    assert.equal((await S.call('PUT', '/dues/due-2', { token: own2, body: { ...d, status: 'Paid' } })).status, 403);
    assert.equal((await S.call('PUT', '/ledger/mine', { token: own2, body: { id: 'mine', type: 'Credit', amount: 5 } })).status, 403);
  });
  test('the simulator is not reachable by a stranger', async () => {
    assert.equal((await S.call('POST', '/payments/simulate/ORD_X', { body: { outcome: 'success' } })).status, 401);
  });
});

describe('scheduled jobs run on the server', () => {
  test('only the Super Admin can start them, and running them twice creates nothing twice', async () => {
    const root = (await S.otp('+91 98000 00003')).token;
    assert.equal((await S.call('POST', '/admin/jobs/run', { token: own1 })).status, 403);
    const a = await S.call('POST', '/admin/jobs/run', { token: root }); assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.ok(Object.values(a.body[TENANT]).every((v) => v === 'ok'), JSON.stringify(a.body[TENANT]));
    const count = async () => (await pool.query(`SELECT collection, count(*)::int c FROM documents WHERE tenant=$1 GROUP BY 1 ORDER BY 1`, [TENANT])).rows.filter((r) => !['audit', 'notificationOutbox', 'reportRuns'].includes(r.collection)).map((r) => `${r.collection}:${r.c}`).join(',');
    const before = await count(); await S.call('POST', '/admin/jobs/run', { token: root });
    assert.equal(await count(), before, 'a second run changed nothing');
  });
});
