import React, { useEffect, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import { money } from '../lib/locale.js';
import { OUTCOME } from '../lib/payments/PaymentGateway.js';
import { pay as payService, confirmPending, checkOrder } from '../lib/payments/index.js';
import { serverDecides } from '../lib/auth/session.js';

/**
 * useGatewayPay() -> { start(req), node }
 *   start(req) opens the provider checkout, runs the payment through PaymentService and resolves
 *   { status: 'Paid'|'Failed'|'Pending'|'Cancelled', message, paymentId, order }. Render {node} once in the screen.
 * The checkout page below is the SIMULATOR'S hosted page. A real provider shows its own; this component is then not used.
 */
export function useGatewayPay() {
  const [open, setOpen] = useState(null); // { order, resolve }
  const ref = useRef(null);
  const ui = (order, gw) => new Promise((resolve) => { ref.current = { order, gw, resolve }; setOpen({ order, gw }); });
  const close = (v) => { const r = ref.current; ref.current = null; setOpen(null); r?.resolve(v); };
  // one payment at a time: a second tap (or a second screen) while one is in flight gets the same answer instead of starting another order
  const flight = useRef(null);
  const [paying, setPaying] = useState(false);
  const start = (req) => {
    if (!flight.current) { setPaying(true); flight.current = payService(req, ui).finally(() => { flight.current = null; setPaying(false); }); }
    return flight.current;
  };
  const node = open ? <CheckoutPage order={open.order} gw={open.gw} onDone={close} /> : null;
  return { start, node, paying };
}

function CheckoutPage({ order, gw, onDone }) {
  const [method, setMethod] = useState(gw.methods[0]);
  const [busy, setBusy] = useState(false);
  const go = (outcome) => { setBusy(true); setTimeout(() => onDone({ outcome, method }), 450); };
  return (
    <Modal title={gw.name} subtitle="Simulated checkout page - no real money moves." onClose={() => onDone({ outcome: null })}>
      <div className="ro-block" data-testid="gw-checkout">
        <div className="kv"><span>Paying</span><b>{order.description || order.unit || 'Community payment'}</b><span>Order</span><b>{order.orderId}</b><span><b>Amount</b></span><b data-testid="gw-amount">{money(order.amount)}</b></div>
      </div>
      <div className="field"><label>Pay using</label>
        <select value={method} onChange={(e) => setMethod(e.target.value)} data-testid="gw-method">{gw.methods.map((m) => <option key={m}>{m}</option>)}</select></div>
      <p className="muted" style={{ fontSize: 12 }}>Choose what the bank should do, to test every path:</p>
      <div className="form-actions">
        <button className="btn" disabled={busy} data-testid="gw-success" onClick={() => go(OUTCOME.SUCCESS)}>{busy ? 'Processing…' : `Pay ${money(order.amount)}`}</button>
        <button className="btn secondary" disabled={busy} data-testid="gw-fail" onClick={() => go(OUTCOME.FAILURE)}>Bank declines</button>
        <button className="btn secondary" disabled={busy} data-testid="gw-pending" onClick={() => go(OUTCOME.PENDING)}>Bank is slow (pending)</button>
        {serverDecides() && <button className="btn secondary" disabled={busy} data-testid="gw-lost" onClick={() => { setBusy(true); setTimeout(() => onDone({ outcome: OUTCOME.SUCCESS, method, lostWebhook: true }), 450); }}>Bank charged, confirmation lost</button>}
        <button className="btn secondary" disabled={busy} data-testid="gw-cancel" onClick={() => onDone({ outcome: null })}>Cancel</button>
      </div>
    </Modal>
  );
}

/**
 * Shows the result of a payment attempt, with a retry for failures.
 * While the bank has not confirmed (status Pending), this is the "we're checking your payment" screen: it asks the server again, gently,
 * for up to 10 minutes, tells the payer NOT to pay twice, and finishes by itself when the server settles the payment.
 */
export function PaymentResult({ result, onRetry, onDone }) {
  const [msg, setMsg] = useState(result.message);
  const [status, setStatus] = useState(result.status);
  const [order, setOrder] = useState(result.order);
  const [since] = useState(() => Date.now());
  const [checkedAt, setCheckedAt] = useState(null);
  const watching = serverDecides() && status === 'Pending' && !!order?.orderId;

  async function checkNow() {
    try { const r = await checkOrder(order.orderId); setOrder(r.order); setCheckedAt(new Date()); if (r.status !== 'Pending') { setStatus(r.status); setMsg(r.message); } }
    catch { setCheckedAt(new Date()); }
  }
  useEffect(() => {
    if (!watching) return undefined;
    let stop = false; let wait = 2500; let timer;
    const tick = async () => {
      if (stop || Date.now() - since > 10 * 60e3) return;
      await checkNow();
      wait = Math.min(wait * 1.4, 15000); timer = setTimeout(tick, wait);
    };
    timer = setTimeout(tick, wait);
    return () => { stop = true; clearTimeout(timer); };
  }, [watching, order?.orderId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function confirm() { const r = await confirmPending(result.order.orderId); if (r.ok) { setStatus('Paid'); setMsg('Payment received.'); } }
  const title = status === 'Paid' ? '✅ Payment received' : status === 'Failed' ? '⚠ Payment failed' : status === 'Expired' ? '⌛ Payment not completed' : status === 'Pending' ? (watching ? "⏳ We're checking your payment" : '⏳ Waiting for the bank') : 'Cancelled';
  return (
    <div className={`notice ${status === 'Paid' ? '' : 'warn'}`} data-testid="pay-result" style={{ marginTop: 8 }}>
      <b data-testid="pay-result-title">{title}</b>
      <div>{watching ? 'This usually takes under a minute. Please do not pay again - if the money has left your account, it is confirmed here automatically.' : msg}</div>
      {watching && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Order {order.orderId}{checkedAt ? ` · last checked ${checkedAt.toLocaleTimeString()}` : ''}</div>}
      {status === 'Expired' && order?.orderId && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Order {order.orderId}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
        {(status === 'Failed' || status === 'Cancelled' || status === 'Expired') && <button type="button" className="btn" data-testid="pay-retry" onClick={onRetry}>Try again</button>}
        {watching && <button type="button" className="btn secondary" data-testid="pay-check-now" onClick={checkNow}>Check now</button>}
        {status === 'Pending' && !serverDecides() && <button type="button" className="btn secondary" data-testid="pay-confirm-pending" onClick={confirm}>Simulate: bank confirmed</button>}
        {status === 'Paid' && <button type="button" className="btn" data-testid="pay-done" onClick={onDone}>Done</button>}
      </div>
    </div>
  );
}
