import React, { useEffect, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import { money } from '../lib/locale.js';
import { OUTCOME } from '../lib/payments/PaymentGateway.js';
import { pay as payService, confirmPending, checkOrder } from '../lib/payments/index.js';
import { serverDecides } from '../lib/auth/session.js';
import { upiLink, qrDataUrl } from '../lib/payments.js';

/**
 * useGatewayPay() -> { start(req), node }
 *   start(req) opens the provider checkout, runs the payment through PaymentService and resolves
 *   { status: 'Paid'|'Failed'|'Pending'|'Cancelled', message, paymentId, order }. Render {node} once in the screen.
 * The checkout page below is the SIMULATOR'S hosted page. A real provider shows its own; this component is then not used.
 */
export function useGatewayPay() {
  const [open, setOpen] = useState(null); // { order, resolve }
  const ref = useRef(null);
  // what the payment is waiting on (see pay() in lib/payments): shown over the screen so a slow bank never looks like nothing is happening
  const [stage, setStage] = useState(null);
  const ui = (order, gw) => new Promise((resolve) => { ref.current = { order, gw, resolve }; setOpen({ order, gw }); });
  const close = (v) => { const r = ref.current; ref.current = null; setOpen(null); if (v?.outcome) setStage({ step: 'confirm', since: Date.now() }); r?.resolve(v); };
  // one payment at a time: a second tap (or a second screen) while one is in flight gets the same answer instead of starting another order
  const flight = useRef(null);
  const [paying, setPaying] = useState(false);
  const onStage = (step) => setStage((s) => (step ? (s?.step === step ? s : { step, since: s?.since || Date.now() }) : null));
  const start = (req) => {
    if (!flight.current) { setPaying(true); flight.current = payService(req, ui, onStage).finally(() => { flight.current = null; setPaying(false); setStage(null); }); }
    return flight.current;
  };
  const node = open ? <CheckoutPage order={open.order} gw={open.gw} onDone={close} /> : stage ? <PaymentProgress step={stage.step} since={stage.since} /> : null;
  return { start, node, paying };
}

const STEPS = {
  order: ['Preparing your payment…', 'Getting the exact amount from the server.'],
  confirm: ['Confirming with the bank…', 'Your bank has answered the checkout; the payment is being confirmed.'],
  bank: ['Waiting for the bank…', 'The bank is confirming the payment. This usually takes a few seconds.'],
};
/** A payment in progress: what it is waiting on, for how long, and - once it is slow - that it is still going and must not be repeated. */
export function PaymentProgress({ step, since }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const secs = Math.max(0, Math.round((now - (since || now)) / 1000));
  const slow = secs >= 8;
  const [title, text] = STEPS[step] || STEPS.bank;
  return (
    <div className="pay-progress" role="status" aria-live="polite" data-testid="pay-progress" data-step={step}>
      <div className="pay-progress-card">
        <span className="pay-spinner" aria-hidden="true" />
        <b>{slow && step !== 'order' ? 'The bank is slow to answer…' : title}</b>
        <p>{slow ? 'Still working on it in the background. Please keep this page open and do not pay again - you will not be charged twice.' : text}</p>
        <small className="muted" data-testid="pay-progress-time">{secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`}</small>
      </div>
    </div>
  );
}

function CheckoutPage({ order, gw, onDone }) {
  const [method, setMethod] = useState(gw.methods[0]);
  const [busy, setBusy] = useState(false);
  const go = (outcome, extra = {}) => { setBusy(true); setTimeout(() => onDone({ outcome, method, ...extra }), 450); };
  return (
    <Modal title={gw.name} subtitle="Simulated checkout page - no real money moves." onClose={() => onDone({ outcome: null })}>
      <div className="ro-block" data-testid="gw-checkout">
        <div className="kv"><span>Paying</span><b>{order.description || order.unit || 'Community payment'}</b><span>Order</span><b>{order.orderId}</b><span><b>Amount</b></span><b data-testid="gw-amount">{money(order.amount)}</b></div>
      </div>
      <div className="field"><label>Pay using</label>
        <select value={method} onChange={(e) => setMethod(e.target.value)} data-testid="gw-method">{gw.methods.map((m) => <option key={m}>{m}</option>)}</select></div>
      {method === 'UPI' && <UpiCheckout order={order} busy={busy} onPaid={(outcome, upi) => go(outcome, { upi })} />}
      <p className="muted" style={{ fontSize: 12 }}>{method === 'UPI' ? 'Or skip the UPI app and choose what the bank does:' : 'Choose what the bank should do, to test every path:'}</p>
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

// ---- UPI, as it works in India today (simulated) ------------------------------------------------------------------------------------------
// The website never sees the payer's bank accounts. On a phone it opens a UPI app (UPI Intent: the phone lists the UPI apps installed); on a
// computer it shows a QR code for this order and amount, scanned with any UPI app. The UPI app shows the accounts linked in it, the payer picks
// one and enters that bank's UPI PIN. The bank tells the provider, the provider tells the server (webhook); the page only waits for the answer.
// "Enter your UPI ID" (a collect request) is being retired by NPCI for merchant payments, so it is not offered.
const UPI_APPS = [['gpay', 'Google Pay', 'okhdfcbank'], ['phonepe', 'PhonePe', 'ybl'], ['paytm', 'Paytm', 'ptyes'], ['bhim', 'BHIM', 'upi'], ['bank', 'My bank\'s app', 'oksbi']];
const LITE_LIMIT = 1000;   // UPI Lite pays small amounts without a PIN, up to this much a payment
const isPhone = () => { try { return window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 720; } catch { return false; } };
const handleOf = (name) => String(name || 'resident').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 24) || 'resident';
/** The accounts a payer has linked in their UPI app (made up for the demo, named after the payer). */
const linkedAccounts = (payer, app) => {
  const h = handleOf(payer);
  return [
    { id: 'hdfc', label: 'HDFC Bank · savings ••4821', vpa: `${h}@${app[2] === 'ybl' ? 'ybl' : 'okhdfcbank'}`, pin: 6 },
    { id: 'sbi', label: 'State Bank of India · savings ••0937', vpa: `${h}.m@oksbi`, pin: 4 },
    { id: 'lite', label: 'UPI Lite · balance ₹1,240 (no PIN)', vpa: `${h}@${app[2]}`, pin: 0, lite: true },
    { id: 'card', label: 'RuPay credit card ••7712', vpa: `${h}@okicici`, pin: 6 },
  ];
};
const PAYEE = { vpa: 'lapaloma.society@okaxis', name: 'La Paloma Owners Association' };

function UpiCheckout({ order, busy, onPaid }) {
  const [view, setView] = useState(isPhone() ? 'intent' : 'qr');
  const [app, setApp] = useState(null);        // the UPI app open on the "phone"
  const [qr, setQr] = useState('');
  const [left, setLeft] = useState(300);       // a QR is valid for 5 minutes
  const link = upiLink({ upiId: PAYEE.vpa, payee: PAYEE.name, amount: order.amount, note: order.description || 'Community payment', ref: order.orderId });
  useEffect(() => { let on = true; qrDataUrl(link).then((u) => on && setQr(u)).catch(() => {}); return () => { on = false; }; }, [link]);
  useEffect(() => { if (view !== 'qr' || app) return undefined; const t = setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000); return () => clearInterval(t); }, [view, app]);
  if (app) return <UpiApp app={app} order={order} busy={busy} onBack={() => setApp(null)} onPaid={onPaid} />;
  return (
    <div className="upi-box" data-testid="upi-checkout">
      <div className="upi-tabs" role="tablist" aria-label="How to pay by UPI">
        <button type="button" role="tab" aria-selected={view === 'intent'} className={view === 'intent' ? 'on' : ''} data-testid="upi-intent-tab" onClick={() => setView('intent')}>📱 On this phone</button>
        <button type="button" role="tab" aria-selected={view === 'qr'} className={view === 'qr' ? 'on' : ''} data-testid="upi-qr-tab" onClick={() => setView('qr')}>🖥 Scan a QR</button>
      </div>
      {view === 'intent' ? (
        <>
          <p className="muted" style={{ margin: '8px 0' }}>Pick your UPI app. It opens with the amount filled in; you choose which of your accounts pays and enter its UPI PIN there.</p>
          <div className="upi-apps">{UPI_APPS.map((a) => <button key={a[0]} type="button" className="upi-app" data-testid={`upi-app-${a[0]}`} disabled={busy} onClick={() => setApp(a)}>{a[1]}</button>)}</div>
        </>
      ) : (
        <div className="upi-qr">
          {left > 0 ? (qr ? <img src={qr} alt={`UPI QR code for ${money(order.amount)}`} width="180" height="180" data-testid="upi-qr" /> : <div className="muted">Making the QR code…</div>)
            : <div className="notice warn" data-testid="upi-qr-expired">This QR code has expired. Nothing was charged. <button type="button" className="link-btn" onClick={() => setLeft(300)}>Show a new one</button></div>}
          <div>
            <p style={{ margin: '0 0 6px' }}>Scan with any UPI app (Google Pay, PhonePe, Paytm, BHIM or your bank's app), check the amount, choose the account and enter your UPI PIN.</p>
            <small className="muted">Valid for {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} · Pays {PAYEE.name} ({PAYEE.vpa}) · Order {order.orderId}</small>
            <div style={{ marginTop: 8 }}><button type="button" className="btn secondary sm" data-testid="upi-scan" disabled={busy || left <= 0} onClick={() => setApp(UPI_APPS[1])}>Simulate: scan it with my phone</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

/** The payer's UPI app (simulated): the linked accounts, the default one chosen; a PIN for that bank (UPI Lite needs none). */
function UpiApp({ app, order, busy, onBack, onPaid }) {
  const accounts = linkedAccounts(order.payer, app);
  const [acct, setAcct] = useState(accounts[0].id);
  const [pin, setPin] = useState(''); const [err, setErr] = useState('');
  const a = accounts.find((x) => x.id === acct);
  const liteTooBig = a.lite && Number(order.amount) > LITE_LIMIT;
  const pay = (outcome) => {
    if (outcome !== 'failure' && liteTooBig) return setErr(`UPI Lite pays up to ₹${LITE_LIMIT.toLocaleString('en-IN')} at a time. Choose a bank account.`);
    if (outcome !== 'failure' && a.pin && pin.length !== a.pin) return setErr(`Enter your ${a.pin}-digit UPI PIN for ${a.label.split(' ·')[0]}.`);
    setErr(''); onPaid(outcome, { app: app[1], payerVpa: a.vpa, account: a.label });
  };
  return (
    <div className="upi-phone" data-testid="upi-app">
      <div className="upi-phone-head"><button type="button" className="link-btn" onClick={onBack} aria-label="Back to the checkout">←</button> <b>{app[1]}</b> <small className="muted">(simulated)</small></div>
      <div className="upi-pay-to">Paying <b>{PAYEE.name}</b><br /><small className="muted">{PAYEE.vpa}</small><div className="upi-amt" data-testid="upi-amount">{money(order.amount)}</div><small className="muted">{order.description || ''}</small></div>
      <div className="field"><label>Pay from</label>
        <div className="upi-accts" role="radiogroup" aria-label="Pay from">
          {accounts.map((x) => (
            <label key={x.id} className={`upi-acct${acct === x.id ? ' on' : ''}`}>
              <input type="radio" name="upi-acct" value={x.id} checked={acct === x.id} data-testid={`upi-acct-${x.id}`} onChange={() => { setAcct(x.id); setPin(''); setErr(''); }} />
              <span>{x.label}<br /><small className="muted">{x.vpa}</small></span>
            </label>
          ))}
        </div>
      </div>
      {a.pin > 0 && <div className="field"><label>UPI PIN ({a.pin} digits, any digits in the demo)</label>
        <input type="password" inputMode="numeric" autoComplete="off" maxLength={a.pin} data-testid="upi-pin" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, a.pin))} /></div>}
      {err && <div className="field-error" data-testid="upi-error">{err}</div>}
      <div className="form-actions">
        <button type="button" className="btn" data-testid="upi-pay" disabled={busy} onClick={() => pay('success')}>{busy ? 'Processing…' : `Pay ${money(order.amount)}`}</button>
        <button type="button" className="btn secondary" data-testid="upi-slow" disabled={busy} onClick={() => pay('pending')}>Bank is slow</button>
        <button type="button" className="btn secondary" data-testid="upi-decline" disabled={busy} onClick={() => pay('failure')}>Bank declines</button>
      </div>
    </div>
  );
}

/**
 * Shows the result of a payment attempt, with a retry for failures.
 * While the bank has not confirmed (status Pending), this is the "we're checking your payment" screen: it asks the server again, gently,
 * for up to 10 minutes, tells the payer NOT to pay twice, and finishes by itself when the server settles the payment.
 */
export function PaymentResult({ result, onRetry, onDone }) {
  // Done hands back the payment as it ended (a slow bank's payment has its id only once it is confirmed): never start it again from Done
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

  async function confirm() { const r = await confirmPending(result.order.orderId); if (r.ok) { const o = await checkOrder(result.order.orderId).catch(() => null); if (o?.order) setOrder(o.order); setStatus('Paid'); setMsg('Payment received.'); } }
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!watching) return undefined; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [watching]);
  const waited = Math.round((now - since) / 1000);
  const final = () => ({ status, order, message: msg, paymentId: order?.paymentId || result.paymentId || null, utr: order?.utr || result.utr || '', payerVpa: order?.payerVpa || result.payerVpa || '' });
  const title = status === 'Paid' ? '✅ Payment received' : status === 'Failed' ? '⚠ Payment failed' : status === 'Expired' ? '⌛ Payment not completed' : status === 'Pending' ? (watching ? "⏳ We're checking your payment" : '⏳ Waiting for the bank') : 'Cancelled';
  return (
    <div className={`notice ${status === 'Paid' ? '' : 'warn'}`} data-testid="pay-result" style={{ marginTop: 8 }}>
      <b data-testid="pay-result-title">{title}</b>
      <div>{watching ? 'This usually takes under a minute. Please do not pay again - if the money has left your account, it is confirmed here automatically.' : msg}</div>
      {watching && <div className="pay-watch" data-testid="pay-watching"><span className="pay-spinner sm" aria-hidden="true" /><span>Checking with the bank in the background · {waited < 60 ? `${waited}s` : `${Math.floor(waited / 60)}m ${waited % 60}s`}</span></div>}
      {watching && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Order {order.orderId}{checkedAt ? ` · last checked ${checkedAt.toLocaleTimeString()}` : ''}</div>}
      {status === 'Expired' && order?.orderId && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Order {order.orderId}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
        {(status === 'Failed' || status === 'Cancelled' || status === 'Expired') && <button type="button" className="btn" data-testid="pay-retry" onClick={onRetry}>Try again</button>}
        {watching && <button type="button" className="btn secondary" data-testid="pay-check-now" onClick={checkNow}>Check now</button>}
        {status === 'Pending' && !serverDecides() && <button type="button" className="btn secondary" data-testid="pay-confirm-pending" onClick={confirm}>Simulate: bank confirmed</button>}
        {status === 'Paid' && <button type="button" className="btn" data-testid="pay-done" onClick={() => onDone?.(final())}>Done</button>}
      </div>
    </div>
  );
}
