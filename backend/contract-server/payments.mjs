// Server-side payments: price the order, take the provider's signed webhook, settle bill + ledger + receipt atomically, and keep a
// reconcile job that finishes (or expires) anything a lost webhook left hanging.
//
//   PAYMENT_PROVIDER=simulated   a pretend bank for development: POST /api/payments/simulate/{order} decides what the bank did
//   PAYMENT_WEBHOOK_SECRET       shared secret the provider signs events with (HMAC-SHA256 of the raw body, header X-Webhook-Signature)
//   PAYMENT_ORDER_MINUTES=30     an order nobody paid is expired after this long
//   PAYMENT_RECONCILE_SECONDS=30 how often the reconcile job looks (0 = off)
import crypto from 'node:crypto';

export const PAY = {
  provider: process.env.PAYMENT_PROVIDER || 'simulated',
  secret: process.env.PAYMENT_WEBHOOK_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'dev-webhook-secret'),
  orderMinutes: Number(process.env.PAYMENT_ORDER_MINUTES || 30),
  reconcileSeconds: Number(process.env.PAYMENT_RECONCILE_SECONDS || 30),
  lookup: null,   // set by the provider adapter: async (order) => ({ outcome: 'success'|'failure', method, paymentId }) | null
  pendingRecheckSeconds: Number(process.env.PAYMENT_PENDING_RECHECK_SECONDS || 20),
};
if (process.env.NODE_ENV === 'production' && !PAY.secret) throw new Error('Set PAYMENT_WEBHOOK_SECRET.');
if (process.env.NODE_ENV === 'production' && PAY.provider === 'simulated') throw new Error('PAYMENT_PROVIDER=simulated is not allowed when NODE_ENV=production.');

export const sign = (raw) => crypto.createHmac('sha256', PAY.secret).update(raw).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const rid = (p) => `${p}_${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

class QuoteDone extends Error { constructor(v) { super('quote'); this.v = v; } }

export async function createPayments({ pool, svc, HttpError, srcDir, outbox, breaker }) {
  const here = (p) => new URL(p, srcDir).href;
  const { COLLECTIONS: C } = await import(here('lib/storage/index.js'));
  const { settleDues } = await import(here('lib/finance/settle.js'));
  const { creditBalance, applyLateFees } = await import(here('lib/finance/rules.js'));
  const { syncDuePayment } = await import(here('lib/utilityLedger.js'));
  const { nextShortId } = await import(here('lib/storage/secureStorage.js'));
  const { payOnline } = await import(here('lib/payments.js'));
  const { notify } = await import(here('lib/notify.js'));
  const { logChange } = await import(here('lib/audit/auditLog.js'));
  const { storage } = await import(here('lib/storage/index.js'));
  const SYSTEM = 'System · payment gateway';

  const view = (o) => ({ orderId: o.order_id, status: o.status, amount: Number(o.amount), currency: o.currency, purpose: o.purpose, refs: o.refs, unit: o.unit, payer: o.payer, method: o.method || '', paymentId: o.payment_id || '', description: o.meta?.description || '', createdAt: o.created_at, paidAt: o.paid_at, note: o.note || '', provider: o.provider });
  const unitsOf = (who) => [...new Set([who.unit, ...(who.units || [])].filter(Boolean))];
  const isFinance = (who, x) => !!x.principal && (x.principal.role?.category === 'EC' || (x.principal.role?.permissions || []).some((p) => ['MANAGE_DUES', 'MANAGE_LEDGER'].includes(p)));

  // ---- 1. create (and price) an order ---------------------------------------------------------------------------------
  async function createOrder(tenant, who, req) {
    try { return await createOrderTx(tenant, who, req); } catch (e) { if (e instanceof QuoteDone) return e.v; throw e; }
  }
  async function createOrderTx(tenant, who, req) {
    const purpose = String(req.purpose || '');
    if (!['due', 'donation', 'booking'].includes(purpose)) throw new HttpError(400, 'Unknown payment purpose.');
    let refs = [...new Set((req.refs || []).map(String))];
    return svc.run(tenant, who, { write: true }, async (x) => {
      if (!x.principal) throw new HttpError(403, 'Not allowed.');
      let amount = 0; let unit = ''; let meta = { description: String(req.description || '').slice(0, 200) };
      if (purpose === 'due') {
        if (!refs.length) throw new HttpError(400, 'Choose the bills to pay.');
        const asked = (await storage.list(C.DUES)).filter((d) => refs.includes(d.id));
        if (req.includeLateFees && asked.length && (unitsOf(who).includes(asked[0].unit) || isFinance(who, x))) {   // a late fee that has built up is added now, by the server, then paid with the bill
          for (const d of asked.filter((d) => !d.lateFeeFor)) await applyLateFees({ only: d.id, actor: SYSTEM });
          const fees = (await storage.list(C.DUES)).filter((d) => refs.includes(d.lateFeeFor) && !refs.includes(d.id) && !['Paid', 'Cancelled'].includes(d.status));
          refs = [...refs, ...fees.map((f) => f.id)];
        }
        const dues = (await storage.list(C.DUES)).filter((d) => refs.includes(d.id));
        if (dues.length !== refs.length) throw new HttpError(404, 'One of these bills does not exist.');
        unit = dues[0].unit;
        if (dues.some((d) => d.unit !== unit)) throw new HttpError(400, 'Pay one unit\'s bills at a time.');
        if (!unitsOf(who).includes(unit) && !isFinance(who, x)) throw new HttpError(403, 'You can only pay your own unit\'s bills.');
        const open = dues.filter((d) => !['Paid', 'Cancelled'].includes(d.status));
        if (!open.length) throw new HttpError(409, 'These bills are already paid.');
        const total = r2(open.reduce((n, d) => n + (Number(d.amount) || 0), 0));
        const credit = req.meta?.useCredit ? Math.min(total, Math.max(0, creditBalance(await storage.list(C.UNIT_CREDITS), unit))) : 0;
        amount = r2(total - credit); meta = { ...meta, useCredit: credit > 0, credit, gross: total };
        if (amount <= 0) throw new HttpError(400, 'Your unit credit covers these bills; use the credit instead of paying online.');
      } else if (purpose === 'donation') {
        const don = refs[0] ? await storage.get(C.CULTURAL_DONATIONS, refs[0]) : null;
        if (!don) throw new HttpError(404, 'Pledge not found.');
        if (don.status === 'Received') throw new HttpError(409, 'This pledge is already received.');
        amount = r2(don.amount); unit = don.unit || '';
        if (don.unit && !unitsOf(who).includes(don.unit) && !isFinance(who, x)) throw new HttpError(403, 'This pledge belongs to another unit.');
      } else {
        amount = r2(req.amount); unit = String(req.unit || '');
        if (!(amount > 0)) throw new HttpError(400, 'Nothing to pay.');
        if (!unitsOf(who).includes(unit) && !isFinance(who, x)) throw new HttpError(403, 'You can only pay for your own unit.');
        // money already taken for this booking but never used (the payer closed the page, the booking was refused): hand it back instead of charging twice
        const prior = (await x.q(`SELECT * FROM payment_orders WHERE tenant=$1 AND purpose='booking' AND status='Paid' AND consumed_by IS NULL AND unit=$2 AND amount=$3 AND payer_id=$4 ORDER BY paid_at DESC LIMIT 1`, [tenant, unit, amount, who.userId || ''])).rows[0];
        if (prior) return view(prior);
      }
      if (req.quote) throw new QuoteDone({ quote: true, amount, currency: 'INR', refs, gross: meta.gross ?? amount, credit: meta.credit ?? 0, extra: r2(amount - (meta.gross ?? amount) + (meta.credit ?? 0)) });   // a price check: everything above is rolled back
      const key = `${purpose}:${refs.slice().sort().join(',')}:${amount}:${who.userId}`;
      const found = (await x.q(`SELECT * FROM payment_orders WHERE tenant=$1 AND idempotency_key=$2 AND status IN ('Created','Pending') FOR UPDATE`, [tenant, key])).rows[0];
      if (found) return view(found);                       // asked twice (double click, retry after a timeout): the same order comes back
      const paid = (await x.q(`SELECT 1 FROM payment_orders WHERE tenant=$1 AND idempotency_key=$2 AND status='Paid'`, [tenant, key])).rowCount;
      if (paid && purpose !== 'booking') throw new HttpError(409, 'This payment has already been made.');
      const id = rid('ORD');
      const row = (await x.q(`INSERT INTO payment_orders (order_id, tenant, purpose, refs, unit, payer, payer_id, amount, currency, idempotency_key, meta, provider) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [id, tenant, purpose, JSON.stringify(refs), unit, x.principal.name, who.userId || '', amount, String(req.currency || 'INR').slice(0, 3), paid ? null : key, JSON.stringify(meta), PAY.provider])).rows[0];
      return view(row);
    });
  }

  async function getOrder(tenant, who, orderId) {
    return svc.run(tenant, who, {}, async (x) => {
      const o = (await pool.query('SELECT * FROM payment_orders WHERE order_id=$1 AND tenant=$2', [orderId, tenant])).rows[0];
      if (!o || !x.principal) throw new HttpError(404, 'No such payment.');
      if (o.payer_id !== who.userId && !unitsOf(who).includes(o.unit) && !isFinance(who, x)) throw new HttpError(404, 'No such payment.');
      return view(o);
    });
  }

  // ---- 2. settle: bill + ledger + receipt, all or nothing ---------------------------------------------------------------
  async function settle(tenant, orderId, ev) {
    let outcome;
    await svc.runSystem(tenant, SYSTEM, { write: true, isolation: 'REPEATABLE READ' }, async (x) => {   // money: REPEATABLE READ + a row lock + automatic retry on a serialization conflict
      const o = (await x.q('SELECT * FROM payment_orders WHERE order_id=$1 AND tenant=$2 FOR UPDATE', [orderId, tenant])).rows[0];
      if (!o) { outcome = { ok: false, reason: 'Unknown order' }; return; }
      if (o.status === 'Paid') { outcome = { ok: true, duplicate: true, order: view(o) }; return; }
      if (Math.abs(Number(ev.amount) - Number(o.amount)) > 0.009) {   // the bank took a different amount than we asked for: do not settle, a person must look
        await x.q(`UPDATE payment_orders SET status='Failed', note=$2, updated_at=now() WHERE order_id=$1`, [orderId, `Amount mismatch: asked ${o.amount}, provider reports ${ev.amount}. Not settled - check with the provider.`]);
        await logChange({ who: SYSTEM, whoName: SYSTEM, what: 'Online payments', collection: 'payments', recordId: orderId, action: 'Update', summary: `Order ${orderId}: provider reported ${ev.amount}, expected ${o.amount} - not settled`, changes: [] });
        outcome = { ok: false, reason: 'Amount mismatch' }; return;
      }
      const order = { ...view(o), refs: o.refs, meta: o.meta };
      if (o.purpose === 'due') {
        const paid = await settleDues({ dueIds: o.refs, unit: o.unit, useCredit: !!o.meta?.useCredit, mode: ev.method || 'Online', reference: ev.paymentId, paidBy: o.payer, actor: SYSTEM });
        for (const d of paid) await syncDuePayment(d, { nextShortId, actor: SYSTEM });   // the ledger entry is part of the same transaction
        order.settled = paid.length;
      } else if (o.purpose === 'donation') {
        const d = await storage.get(C.CULTURAL_DONATIONS, o.refs[0]);
        const evt = d && await storage.get(C.CULTURAL_EVENTS, d.eventId);
        if (d && evt) await payOnline(d.id, { ...evt }, { by: o.payer, gatewayRef: ev.paymentId });
      }
      await x.q(`UPDATE payment_orders SET status='Paid', payment_id=$2, method=$3, paid_at=now(), updated_at=now() WHERE order_id=$1`, [orderId, ev.paymentId, ev.method || '']);
      if (outbox) await outbox.emit(x, 'payment.settled', { orderId, paymentId: ev.paymentId, purpose: o.purpose, unit: o.unit, amount: Number(o.amount), payer: o.payer });   // same transaction: saved together or not at all
      outcome = { ok: true, order, settled: true };
    });
    if (outcome?.settled && outcome.order.purpose === 'due') {   // the receipt message is best effort: a failed SMS must never undo a settled payment
      svc.runSystem(tenant, SYSTEM, { write: true }, () => notify({ event: 'payment_made', title: `Payment received · ${outcome.order.unit}`, body: `${outcome.order.settled} bill(s) paid online. Reference ${ev.paymentId}.`, link: '#/billing', toUnit: outcome.order.unit, by: SYSTEM })).catch(() => {});
    }
    return outcome;
  }

  // ---- 3. the provider's webhook (no sign-in: the signature is the credential) ----------------------------------------------
  async function webhook(raw, signature) {
    if (!PAY.secret || !signature || !safeEq(sign(raw), signature)) throw new HttpError(401, 'Bad signature - event ignored.');
    let ev; try { ev = JSON.parse(raw); } catch { throw new HttpError(400, 'Bad event.'); }
    if (!ev?.id || !ev.orderId || !ev.type) throw new HttpError(400, 'Bad event.');
    const o = (await pool.query('SELECT tenant FROM payment_orders WHERE order_id=$1', [ev.orderId])).rows[0];
    if (!o) return { ok: false, reason: 'Unknown order' };
    const first = (await pool.query('INSERT INTO payment_events (event_id, order_id, type) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [ev.id, ev.orderId, ev.type])).rowCount;
    if (!first) return { ok: true, duplicate: true };
    if (ev.type === 'payment.captured') return settle(o.tenant, ev.orderId, ev);
    const status = ev.type === 'payment.failed' ? 'Failed' : 'Pending';
    await pool.query(`UPDATE payment_orders SET status=$2, method=COALESCE($3, method), updated_at=now() WHERE order_id=$1 AND status IN ('Created','Pending')`, [ev.orderId, status, ev.method || null]);
    return { ok: true };
  }

  // ---- 4. the pretend bank (development) ------------------------------------------------------------------------------
  async function simulate(tenant, who, orderId, { outcome, method = 'Card', deliverWebhook = true }) {
    if (PAY.provider !== 'simulated' || process.env.NODE_ENV === 'production') throw new HttpError(404, 'Not found.');
    const o = await getOrder(tenant, who, orderId);
    if (!['success', 'failure', 'pending'].includes(outcome)) throw new HttpError(400, 'Choose success, failure or pending.');
    const paymentId = rid('PAY');
    await pool.query(`UPDATE payment_orders SET bank=$2, attempts=attempts+1, updated_at=now() WHERE order_id=$1`, [orderId, JSON.stringify({ outcome, method, paymentId, at: new Date().toISOString() })]);
    if (!deliverWebhook) return { delivered: false, order: o };      // "the webhook got lost": only the reconcile job can finish this one
    const type = outcome === 'success' ? 'payment.captured' : outcome === 'failure' ? 'payment.failed' : 'payment.pending';
    const raw = JSON.stringify({ id: rid('EVT'), type, orderId, paymentId, amount: o.amount, currency: o.currency, method, at: new Date().toISOString() });
    return { delivered: true, result: await webhook(raw, sign(raw)) };
  }

  // ---- 5. reconcile: finish what the webhook did not -------------------------------------------------------------------------
  let warned = false;
  async function providerStatus(o) {   // what the provider says about this order right now
    if (o.provider === 'simulated') return o.bank ? { outcome: o.bank.outcome, method: o.bank.method, paymentId: o.bank.paymentId } : null;
    if (PAY.lookup) return breaker ? breaker.call(() => PAY.lookup(o)) : PAY.lookup(o);   // a real provider's status call: bounded by a timeout, and cut off quickly when the provider is down
    if (!warned) { warned = true; console.warn(`[payments] provider "${o.provider}" has no status lookup configured; orders stay pending until its webhook arrives.`); }
    return null;
  }
  async function reconcile() {
    const open = (await pool.query(`SELECT * FROM payment_orders WHERE status IN ('Created','Pending') AND updated_at < now() - ($1 || ' seconds')::interval ORDER BY created_at LIMIT 200`, [String(PAY.pendingRecheckSeconds)])).rows;
    const done = { settled: 0, failed: 0, expired: 0 };
    for (const o of open) {
      try {
        const s = await providerStatus(o);
        if (s?.outcome === 'success') { const r = await settle(o.tenant, o.order_id, { amount: Number(o.amount), paymentId: s.paymentId, method: s.method }); if (r?.ok && !r.duplicate) done.settled++; }
        else if (s?.outcome === 'failure') { await pool.query(`UPDATE payment_orders SET status='Failed', method=$2, updated_at=now() WHERE order_id=$1 AND status IN ('Created','Pending')`, [o.order_id, s.method || null]); done.failed++; }
        else if (Date.now() - new Date(o.created_at).getTime() > PAY.orderMinutes * 60e3) {
          await pool.query(`UPDATE payment_orders SET status='Expired', note='No payment was received in time.', updated_at=now() WHERE order_id=$1 AND status IN ('Created','Pending')`, [o.order_id]); done.expired++;
        } else await pool.query('UPDATE payment_orders SET updated_at=now() WHERE order_id=$1', [o.order_id]);
      } catch (e) { console.error('[payments] reconcile failed for', o.order_id, e.message); }
    }
    return { checked: open.length, ...done };
  }
  let timer = null;
  const start = () => { if (PAY.reconcileSeconds > 0 && !timer) { timer = setInterval(() => reconcile().catch((e) => console.error('[payments] reconcile', e.message)), PAY.reconcileSeconds * 1000); timer.unref?.(); } };

  // ---- 6. a booking paid online must point at a real, unused, big-enough payment ---------------------------------------------------
  async function claimForBooking(tenant, { ref, unit, amount, bookingId }) {
    const o = (await pool.query(`SELECT * FROM payment_orders WHERE tenant=$1 AND payment_id=$2 AND purpose='booking' AND status='Paid'`, [tenant, ref])).rows[0];
    if (!o) return 'That payment was not found. Pay online first, then book.';
    if (o.unit !== unit) return 'That payment was made for another unit.';
    if (Number(o.amount) + 0.009 < amount) return 'The payment is less than the booking total.';
    if (o.consumed_by && o.consumed_by !== bookingId) return 'That payment has already been used for another booking.';
    // one atomic statement: of two bookings racing for the same payment, exactly one gets the row
    const got = await pool.query('UPDATE payment_orders SET consumed_by=$2 WHERE order_id=$1 AND (consumed_by IS NULL OR consumed_by=$2)', [o.order_id, bookingId]);
    return got.rowCount ? '' : 'That payment has already been used for another booking.';
  }

  return { createOrder, getOrder, webhook, simulate, reconcile, start, claimForBooking, settle };
}
