import React, { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import { useGatewayPay, PaymentResult } from './GatewayCheckout.jsx';
import { upiLink, qrDataUrl, gatewayOf, GATEWAY_DEMO, payOnline } from '../lib/payments.js';
import { money } from '../lib/locale.js';

const inr = (n) => money(n, { round: false });

/** Reusable "pay now" panel: UPI QR (scan with any UPI app), open-in-app link for phones, copy UPI id,
 *  UTR reference + "I've paid", and an optional online gateway. Works for any event that has a UPI id.
 *  Props: ev (upiId, upiPayee, gateway, name), donation (optional pledge row), amount, onClaim(reference), onPaid(). */
import { upiQrEnabled } from '../lib/region/paymentModes.js';
export default function PayPanel({ ev, donation, amount, note, onClaim, onPaid, onPledge, onClose, title }) {
  const upiOn = upiQrEnabled(); // UPI QR is an India-only rail
  const [typed, setTyped] = useState('');
  const amt = Number(amount ?? donation?.amount) || Number(typed) || 0;
  const link = !upiOn ? '' : upiLink({ upiId: ev?.upiId, payee: ev?.upiPayee || ev?.name, amount: amt, note: note || donation?.note || ev?.name, ref: donation?.shortId || donation?.id });
  const [qr, setQr] = useState('');
  const [utr, setUtr] = useState(donation?.reference || '');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const claimed = !!donation?.paymentClaimedAt && donation?.status !== 'Received';
  const received = donation?.status === 'Received';
  useEffect(() => { let on = true; if (link) qrDataUrl(link).then((u) => on && setQr(u)).catch(() => {}); return () => { on = false; }; }, [link]);

  async function copy() { try { await navigator.clipboard.writeText(ev.upiId); setMsg('UPI id copied'); } catch { setMsg(ev.upiId); } }
  async function claim() {
    if (!utr.trim()) { setMsg('Enter the UPI reference / transaction id shown in your UPI app after paying'); return; }
    setBusy(true); try { await onClaim?.(utr.trim()); setMsg('Thank you! The committee will verify the payment and send your receipt.'); } finally { setBusy(false); }
  }
  const gw = useGatewayPay();
  const pledged = React.useRef(null);
  const [attempt, setAttempt] = useState(null);
  async function online() {
    setBusy(true); setAttempt(null);
    try {
      let don = donation;
      if (!don) { // a contribution with no pledge yet: record the pledge first, so the gateway settles a real record
        if (!(amt > 0)) { setMsg('Enter the amount you wish to contribute'); return; }
        don = await onPledge?.(amt); if (!don) return;
        pledged.current = don;
      }
      const res = await gw.start({ purpose: 'donation', refs: [don.id], amount: Number(don.amount) || amt, unit: don.unit || '', payer: don.donor || '', description: `${ev?.name || 'Event'} contribution` });
      if (res.status !== 'Paid') { setAttempt(res); return; }
      await payOnline(don.id, ev, { gatewayRef: res.paymentId }); setMsg('Payment successful. Your receipt is ready.'); onPaid?.();
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }

  const body = (
    <div data-testid="pay-panel" style={{ textAlign: 'center' }}>
      {received ? <div className="notice" data-testid="pay-received">✅ Payment received · receipt {donation.receiptNo}</div> : upiOn && !ev?.upiId ? (
        <div className="notice">The committee has not set a UPI id for this event yet. Please pay at the office or ask the committee.</div>
      ) : (
        <>
          {!donation && !amount && onPledge ? <label className="field" style={{ textAlign: 'left' }}><span>Amount you wish to contribute (₹)</span><input type="number" min="1" aria-label="Contribution amount" data-testid="pay-typed-amount" value={typed} onChange={(e) => setTyped(e.target.value)} /></label> : <div style={{ fontSize: 28, fontWeight: 700 }} data-testid="pay-amount">{amt > 0 ? inr(amt) : 'Any amount'}</div>}
          {upiOn && ev?.upiId ? <div className="muted">to {ev.upiPayee || ev.name} · <b>{ev.upiId}</b></div> : <div className="muted" data-testid="pay-nonupi">to {ev?.name}. Pay online, by bank transfer or at the office, then enter the reference below.</div>}
          {upiOn && ev?.upiId && (qr ? <img data-testid="upi-qr" alt="UPI QR code" src={qr} width={220} height={220} style={{ margin: '10px auto', display: 'block', background: '#fff', padding: 6, borderRadius: 8 }} /> : <div style={{ height: 232 }} />)}
          {upiOn && ev?.upiId && <div className="muted" style={{ fontSize: 12 }}>Scan with any UPI app (GPay, PhonePe, Paytm, BHIM) — or on this phone:</div>}
          {upiOn && ev?.upiId && <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap', margin: '8px 0' }}>
            <a className="btn" style={{ textDecoration: "none" }} data-testid="upi-open" href={link}>📱 Open UPI app</a>
            <button type="button" className="btn secondary" data-testid="upi-copy" onClick={copy}>Copy UPI id</button>
          </div>}
          <input type="text" hidden readOnly data-testid="upi-link" value={link} />
          {donation && !received && (
            <div style={{ textAlign: 'left', marginTop: 10 }}>
              <label style={{ fontWeight: 600 }}>After paying, enter the {upiOn ? 'UPI reference (UTR)' : 'payment reference'}</label>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <input aria-label="UPI reference" data-testid="pay-utr" style={{ flex: 1 }} placeholder="12-digit UPI ref e.g. 4098…" value={utr} onChange={(e) => setUtr(e.target.value)} />
                <button type="button" className="btn good" data-testid="pay-claim" disabled={busy} onClick={claim}>I’ve paid</button>
              </div>
              {claimed && <div className="muted" style={{ marginTop: 4 }} data-testid="pay-claimed">Payment reported — waiting for the committee to verify it.</div>}
            </div>
          )}
          {!received && (donation || onPledge) && (
            <div style={{ marginTop: 12, borderTop: '1px dashed #ccc', paddingTop: 10 }}>
              <button type="button" className="btn" data-testid="pay-online" disabled={busy} onClick={online}>💳 Pay online{amt > 0 ? ` (${inr(amt)})` : ''}</button>
              <div className="muted" style={{ fontSize: 12 }}>Paid through the community's payment gateway (a simulated one in this demo, so no real money moves).</div>
            </div>
          )}
        </>
      )}
      {attempt && <PaymentResult result={attempt} onRetry={online} onDone={async (paid) => {
        setAttempt(null);
        // a slow bank confirmed it: record the donation against that payment (once - payOnline does nothing for a pledge already received)
        const don = donation || pledged.current;
        if (paid?.status === 'Paid' && don) { try { await payOnline(don.id, ev, { gatewayRef: paid.paymentId || '' }); setMsg('Payment successful. Your receipt is ready.'); } catch (e) { setMsg(e.message); } }
        onPaid?.();
      }} />}
      {gw.node}
      {msg && <div className="notice" style={{ marginTop: 8 }} data-testid="pay-msg">{msg}</div>}
    </div>
  );
  if (!onClose) return body;
  return <Modal title={title || 'Pay now'} subtitle={ev?.name} onClose={onClose}>{body}<div className="form-actions"><button type="button" className="btn secondary" onClick={onClose}>Close</button></div></Modal>;
}
