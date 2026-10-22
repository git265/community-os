import BillTerms from '../../components/BillTerms.jsx';
import { communityTaxId } from '../../lib/locale.js';
import RecordMeta from '../../components/RecordMeta.jsx';
import { DocButton } from '../../components/DocumentPreview.jsx';
import { bookingReceipt } from '../../lib/documents/builders.js';
import { dateTime } from '../../lib/documents/templates.js';
import React, { useState } from 'react';
import Modal from '../../components/Modal.jsx';
import EventWorkPanel from '../eventwork/EventWorkPanel.jsx';
import RichTextEditor from '../../components/RichTextEditor.jsx';
import RichText from '../../components/RichText.jsx';
import { AttachmentPicker, AttachmentList } from '../../components/Attachments.jsx';
import { persistPending } from '../../lib/files/attachments.js';
import { tell } from '../../lib/net/activity.js';
import { cancellationQuote, inr, tiersOf, startAtOf, PAYMENT_MODES, ONLINE_MODES, parseExtras } from '../../lib/amenityEngine.js';

import { PAYOUT_MODES, needsRef } from '../../lib/region/paymentModes.js';
const plain = (h) => String(h || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/** A small step tracker: done steps are ticked, the current one is highlighted. */
function Steps({ steps, testid }) {
  return (
    <ol className="refund-steps" data-testid={testid} style={{ listStyle: 'none', padding: 0, margin: '8px 0' }}>
      {steps.map((st, i) => (
        <li key={i} data-state={st.done ? 'done' : st.current ? 'current' : 'todo'} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '4px 0', opacity: st.done || st.current ? 1 : 0.55 }}>
          <span className={`tag ${st.done ? 'green' : st.current ? 'orange' : ''}`} style={{ minWidth: 22, textAlign: 'center' }}>{st.done ? '✓' : i + 1}</span>
          <span><b>{st.title}</b>{st.sub ? <><br /><small className="muted">{st.sub}</small></> : null}</span>
        </li>
      ))}
    </ol>
  );
}

const TONE = { Paid: 'green', 'Not required': '', Pending: 'orange', 'Refund due': 'orange', Refunded: 'blue', 'Partially refunded': 'blue', Cancelled: 'red' };
const fmtWhen = (d) => new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Price lines of one booking (also used for the preview before booking, see PriceBreakdown). */
export function PriceLines({ q, gstin, extras = [] }) {
  if (!q) return null;
  return (
    <div className="price-box" data-testid="price-box">
      <div className="pr-row"><span>{q.free ? 'Fee' : `Rate (${q.rateUnit.toLowerCase()})${q.weekend ? ' · weekend rate' : ''}`}</span><b>{q.free ? 'Free' : (q.rate - (q.addOn || 0)) > 0 ? inr(q.rate - (q.addOn || 0)) : 'Free'}</b></div>
      {extras.map((x) => <div key={x.itemId} className="pr-row sub" data-testid="price-extra"><span>{x.qty} × {x.name} <small>@ {inr(x.price)}</small></span><span>{inr(x.amount ?? x.qty * x.price)}</span></div>)}
      {q.gstRate > 0 && q.gstMode === 'Inclusive' && <div className="pr-row sub"><span>Taxable value</span><span>{inr(q.base)}</span></div>}
      {q.gstRate > 0 && (
        <div className="pr-row sub"><span>GST {q.gstRate}% <small>(CGST {q.gstRate / 2}% {inr(q.halves)} + SGST {q.gstRate / 2}% {inr(q.halves)}){q.gstMode === 'Inclusive' ? ' · included in rate' : ''}</small></span><span>{inr(q.gst)}</span></div>
      )}
      {q.gstRate > 0 && <div className="pr-row"><span>Fee incl. GST</span><b>{inr(q.fee)}</b></div>}
      {q.deposit > 0 && <div className="pr-row"><span>Refundable security deposit <small>(no GST, returned after the event)</small></span><b>{inr(q.deposit)}</b></div>}
      <div className="pr-row total"><span>Total payable</span><b>{inr(q.total)}</b></div>
      {gstin && q.gstRate > 0 && <div className="pr-gstin muted">GSTIN {gstin}</div>}
    </div>
  );
}

/** The cancellation tiers as dated cut-offs ("Until 05 Oct 17:00: 100% refund"). */
export function PolicyList({ amenity, date, slot, snapshot }) {
  const tiers = snapshot?.length ? snapshot : tiersOf(amenity);
  const startAt = startAtOf(date, slot, amenity);
  return (
    <ul className="policy-list" data-testid="policy-list">
      {tiers.map((t, i) => {
        const cutoff = new Date(new Date(startAt).getTime() - t.hoursBefore * 3600000);
        const prev = tiers[i - 1];
        const label = t.hoursBefore === 0
          ? `${prev ? `After ${fmtWhen(new Date(new Date(startAt).getTime() - prev.hoursBefore * 3600000))}` : 'Any time'}`
          : `Until ${fmtWhen(cutoff)}`;
        return <li key={i}><span>{label} <small className="muted">({t.hoursBefore === 0 ? 'less than ' + (prev?.hoursBefore ?? 0) + ' h before' : t.hoursBefore + ' h or more before'})</small></span><b className={t.refundPct >= 100 ? 'ok' : t.refundPct === 0 ? 'bad' : ''}>{t.refundPct}% refund</b></li>;
      })}
      <li className="muted"><span>Security deposit</span><span>always returned in full on cancellation</span></li>
    </ul>
  );
}

export default function BookingDetail({ booking: b, amenity, settings, isStaff, onClose, onAction, today }) {
  const awaiting = /awaiting|pending/i.test(`${b.paymentStatus || ''} ${b.status || ''}`) && b.status !== 'Cancelled';
  const hrs = Number(settings?.paymentDueHours) || 0;
  const payBy = awaiting && hrs && b.recordCreatedAt ? new Date(new Date(b.recordCreatedAt).getTime() + hrs * 3600000).toISOString().slice(0, 10) : '';
  const [mode, setMode] = useState(null); // 'cancel' | 'receive' | 'refund' | 'settle' | 'depositPaid'
  const [reason, setReason] = useState('');
  const [newFee, setNewFee] = useState('');
  const [waive, setWaive] = useState(false);
  const [override, setOverride] = useState('');
  const [ref, setRef] = useState('');
  const [payMode, setPayMode] = useState(b.paymentMode === 'Cheque' ? 'Cheque' : 'Cash');
  const [deduct, setDeduct] = useState('');
  const [deductWhy, setDeductWhy] = useState('');
  const [photos, setPhotos] = useState([]);
  const [refundTo, setRefundTo] = useState(settings?.refundMode === 'Original payment mode (manual)' ? 'original' : 'credit');
  const [outMode, setOutMode] = useState(PAYOUT_MODES.includes(b.depositRefundMode) ? b.depositRefundMode : (PAYOUT_MODES.includes(b.paymentMode) ? b.paymentMode : 'Cash'));
  const [busy, setBusy] = useState(false);

  const live = !['Cancelled', 'Completed'].includes(b.status);
  const started = new Date(b.startAt || startAtOf(b.date, b.slot, amenity)) < new Date();
  const canCancel = live && (isStaff || !started);
  const cq = cancellationQuote(b, amenity, new Date(), { waive: isStaff && waive });
  const overrideNum = override === '' ? null : Math.min(cq.feePaid, Math.max(0, Number(override) || 0));
  const feeRefund = overrideNum ?? cq.refundFee;
  const total = Math.round((feeRefund + cq.refundDeposit) * 100) / 100;
  const viaCredit = b.paymentMode === 'Unit credit' || Number(b.creditApplied) > 0;
  const toCredit = refundTo === 'credit' || viaCredit;
  const depDefault = viaCredit || settings?.refundMode !== 'Original payment mode (manual)' ? 'Unit credit' : (b.paymentMode && PAYOUT_MODES.includes(b.paymentMode) ? b.paymentMode : 'Cash');
  const [depMode, setDepMode] = useState(depDefault);
  const depChoices = [
    { key: 'credit', value: 'Unit credit', label: '💳 Unit credit' },
    ...(!viaCredit && b.paymentMode && b.paymentMode !== 'Unit credit' ? [{ key: 'original', value: b.paymentMode, label: `↩ Original mode (${b.paymentMode})` }] : []),
    ...['Cash', 'Cheque', 'Bank transfer'].filter((m) => m !== b.paymentMode || viaCredit).map((m) => ({ key: m.toLowerCase().replace(' ', '-'), value: m, label: `${m === 'Cash' ? '💵' : m === 'Cheque' ? '🧾' : '🏦'} ${m}` })),
  ];
  const depBack = Math.max(0, b.depositAmount - Math.min(b.depositAmount, Number(deduct) || 0));
  const settleOk = !(Number(deduct) > 0) || (plain(deductWhy) && photos.length > 0);

  async function run(patch) {
    setBusy(true);
    let ok = false;
    try { ok = await onAction({ ...b, ...patch }); } catch (e) { tell(e?.message || String(e), e?.name === 'NetworkError' || e?.name === 'TimeoutError' ? 'network' : 'error'); } finally { setBusy(false); }
    if (ok) onClose();
  }

  return (
    <Modal title={`${b.amenity} · ${b.date}`} subtitle="" onClose={onClose}>
      <div className="bk-head">
        <span className="mono">{b.shortId}</span>
        <span className={`tag ${b.status === 'Cancelled' ? 'red' : b.status === 'Confirmed' || b.status === 'Completed' ? 'green' : 'orange'}`}>{b.status}</span>
        <span className={`tag ${TONE[b.paymentStatus] || ''}`}>{b.paymentStatus}</span>
      </div>
      <div className="form-grid" style={{ marginTop: 10 }}>
        <div className="field"><label>When</label><div className="ro-value">{b.slot}</div></div>
        <div className="field"><label>{b.bookedFor === 'Association' ? 'Association' : 'Unit'}</label><div className="ro-value" data-testid="bk-unit">{b.bookedFor === 'Association' ? b.association : b.unit}</div></div>
        <div className="field"><label>Paid by</label><div className="ro-value">{b.paymentMode || '—'}{b.paymentRef ? ` · ${b.paymentRef}` : ''}</div></div>
        <div className="field"><label>Paid on</label><div className="ro-value">{b.dateStamps?.paidAt ? dateTime(b.dateStamps.paidAt) : (b.paidAt || '—')}</div></div>
        <div className="field"><label>Booked on</label><div className="ro-value" data-testid="bk-created">{b.recordCreatedAt ? dateTime(b.recordCreatedAt) : '—'}{b.recordCreatedBy ? <small className="muted"> · {b.recordCreatedBy}</small> : null}</div></div>
        <div className="field"><label>Last updated</label><div className="ro-value">{b.lastUpdatedAt ? dateTime(b.lastUpdatedAt) : '—'}{b.lastUpdatedBy ? <small className="muted"> · {b.lastUpdatedBy}</small> : null}</div></div>
      </div>

      <div style={{ margin: '8px 0' }}><DocButton testid="booking-receipt" label={b.paymentStatus === 'Paid' ? '🧾 Receipt (print / PDF)' : '🖨 Print booking invoice'} build={() => bookingReceipt(b)} title={`${b.shortId} · ${b.amenity}`} fileName={b.shortId} /></div>
      <RecordMeta record={b} />

      <h3 className="bk-h">Charges</h3>
      <div className="price-box">
        {b.chargeWaived && <div className="pr-row" data-testid="bk-waived"><span>Charges waived <small>({b.waiveReason})</small></span><b>{inr(b.waivedAmount)}</b></div>}
        <div className="pr-row"><span>Rate</span><b>{Number(b.rate) > 0 ? inr(b.rate) : 'Free'}</b></div>
        {parseExtras(b.extras).map((x) => <div key={x.itemId} className="pr-row sub" data-testid="booking-extra"><span>{x.qty} × {x.name}</span><span>{inr(x.amount)}</span></div>)}
        <div className="pr-row"><span>Fee</span><b>{inr(b.feeTotal)}</b></div>
        {Number(b.depositAmount) > 0 && <div className="pr-row"><span>Security deposit <small>({b.depositStatus})</small></span><b>{inr(b.depositAmount)}</b></div>}
        <div className="pr-row total"><span>Total</span><b>{inr(b.totalPayable)}</b></div>
      </div>
      <BillTerms showPenalty={false} amount={b.gstMode === 'Inclusive' ? b.feeTotal : b.baseAmount} rate={b.gstRate} mode={b.gstMode} taxId={communityTaxId()} dueDate={payBy} status={awaiting ? 'Unpaid' : 'Paid'} />

      {b.status === 'Cancelled' && (
        <>
          <h3 className="bk-h">Cancellation</h3>
          <div className="price-box">
            <div className="pr-row sub"><span>Cancelled {b.cancelledAt ? fmtWhen(b.cancelledAt) : ''}{b.cancelledBy ? ` by ${b.cancelledBy}` : ''}</span><span>{b.cancelReason || ''}</span></div>
            {b.paymentStatus !== 'Cancelled' && <div className="pr-row sub"><span>Fee refund ({b.refundPct ?? 0}%)</span><span>{inr(b.refundFeeAmount)}</span></div>}
            {b.paymentStatus !== 'Cancelled' && <div className="pr-row sub"><span>Retained as cancellation charge</span><span>{inr(b.retainedAmount)}</span></div>}
            {b.paymentStatus !== 'Cancelled' && Number(b.depositReturned) > 0 && <div className="pr-row sub"><span>Deposit returned</span><span>{inr(b.depositReturned)}</span></div>}
            <div className="pr-row total"><span>Refund</span><b>{inr(b.refundAmount)}</b></div>
            <div className="pr-row sub"><span>Status</span><span>{b.refundStatus === 'None' ? 'Nothing to refund' : b.refundStatus}</span></div>
          </div>
          {Number(b.refundAmount) > 0 && (
            <>
              <h4 className="bk-h">Refund process</h4>
              <Steps testid="refund-tracker" steps={[
                { title: 'Booking cancelled', sub: `${b.cancelledAt ? fmtWhen(b.cancelledAt) : ''}${b.cancelledBy ? ` · ${b.cancelledBy}` : ''}`, done: true },
                { title: `Refund approved · ${inr(b.refundAmount)}`, sub: `${b.refundPct ?? 0}% of the fee${Number(b.depositReturned) > 0 ? ' + security deposit' : ''} → ${b.refundTo || (b.refundStatus === 'Credited to unit account' ? 'Unit account' : 'Original payment mode')}`, done: true },
                b.refundStatus === 'Refund due'
                  ? { title: 'Waiting for the office to pay it out', sub: `${b.refundTo || 'Original payment mode'} — you will be notified when it is paid`, current: true }
                  : { title: b.refundStatus === 'Credited to unit account' ? 'Credited to the unit account' : 'Refund paid', sub: `${b.refundPaidAt || (b.cancelledAt ? String(b.cancelledAt).slice(0, 10) : '')}${b.refundPayoutMode ? ` · ${b.refundPayoutMode}` : ''}${b.refundRef ? ` · ref ${b.refundRef}` : ''}${b.refundStatus === 'Credited to unit account' ? ' · available on the next booking' : ''}`, done: true },
              ]} />
            </>
          )}
        </>
      )}

      {Number(b.depositAmount) > 0 && b.depositSettledAt && (
        <div data-testid="deposit-summary">
          <h3 className="bk-h">Security deposit</h3>
          <div className="price-box">
            <div className="pr-row sub"><span>Deposit held</span><span>{inr(b.depositAmount)}</span></div>
            {Number(b.depositDeduction) > 0 && <div className="pr-row sub"><span>Deducted</span><span>{inr(b.depositDeduction)}</span></div>}
            <div className="pr-row total"><span>Returned</span><b>{inr(b.depositReturned)}</b></div>
          </div>
          {Number(b.depositDeduction) > 0 && b.depositDeductionReason && <div style={{ marginTop: 6 }}><b>Reason</b><RichText html={b.depositDeductionReason} /></div>}
          {(b.depositPhotos || []).length > 0 && <div style={{ marginTop: 6 }} data-testid="deposit-photos"><b>Inspection photos</b><AttachmentList items={b.depositPhotos} /></div>}
          {Number(b.depositReturned) > 0 && (
            <Steps testid="deposit-tracker" steps={[
              { title: 'Deposit inspected and settled', sub: `${b.depositSettledAt}${b.depositSettledBy ? ` · ${b.depositSettledBy}` : ''}`, done: true },
              b.depositRefundStatus === 'Due'
                ? { title: `Waiting to pay out ${inr(b.depositReturned)}`, sub: `${b.depositRefundMode || 'Cash'} — the office records it once paid`, current: true }
                : { title: b.depositRefundStatus === 'Credited to unit account' ? `${inr(b.depositReturned)} credited to the unit account` : `${inr(b.depositReturned)} paid out`, sub: `${b.depositRefundPaidAt || b.depositSettledAt}${b.depositRefundMode ? ` · ${b.depositRefundMode}` : ''}${b.depositRefundRef ? ` · ref ${b.depositRefundRef}` : ''}`, done: true },
            ]} />
          )}
        </div>
      )}

      {live && (
        <>
          <h3 className="bk-h">Cancellation policy</h3>
          <PolicyList amenity={amenity} date={b.date} slot={b.slot} snapshot={b.policySnapshot} />
        </>
      )}

      {isStaff && live && mode === null && (
        <details style={{ marginTop: 10 }} data-testid="booking-work"><summary><b>Work for this booking</b></summary>
          <div style={{ marginTop: 8 }}><EventWorkPanel kind="Booking" eventId={b.id} eventName={`${b.amenity} · ${b.unit || b.association || ''}`} eventDate={b.date} /></div></details>
      )}

      {mode === null && (
        <div className="bk-actions">
          {isStaff && b.paymentStatus === 'Pending' && live && <button className="btn good" onClick={() => setMode('receive')}>Record payment received</button>}
          {isStaff && b.refundStatus === 'Refund due' && ONLINE_MODES.includes(b.paymentMode) && <button className="btn good" disabled={busy} data-testid="initiate-refund" onClick={() => run({ _action: 'mark_refund_paid', initiate: true })}>↩ Initiate refund to {b.paymentMode}</button>}
          {isStaff && b.refundStatus === 'Refund due' && <button className="btn secondary" onClick={() => setMode('refund')}>Mark refund paid (manual)</button>}
          {isStaff && b.depositRefundStatus === 'Due' && ONLINE_MODES.includes(b.paymentMode) && <button className="btn good" disabled={busy} data-testid="initiate-deposit-refund" onClick={() => run({ _action: 'mark_deposit_paid', initiate: true })}>↩ Initiate deposit refund to {b.paymentMode}</button>}
          {isStaff && b.depositRefundStatus === 'Due' && <button className="btn secondary" onClick={() => setMode('depositPaid')}>Mark deposit refund paid (manual)</button>}
          {isStaff && b.depositStatus === 'Held' && b.status !== 'Cancelled' && b.date <= today && <button className="btn" onClick={() => setMode('settle')}>Settle security deposit</button>}
          {isStaff && b.status === 'Confirmed' && b.date <= today && <button className="btn secondary" disabled={busy} onClick={() => run({ _action: 'complete' })}>Mark completed</button>}
          {isStaff && live && b.paymentStatus !== 'Paid' && !(Number(b.creditApplied) > 0) && <button className="btn secondary" data-testid="adjust-fee" onClick={() => { setNewFee(String(b.feeTotal ?? '')); setMode('adjust'); }}>Correct the fee</button>}
          {canCancel && <button className="btn secondary danger" onClick={() => setMode('cancel')}>Cancel booking</button>}
        </div>
      )}

      {mode === 'adjust' && (
        <div className="assign" data-testid="adjust-panel">
          <b>Correct the fee</b>
          <p className="muted" style={{ margin: '6px 0' }}>For a booking nobody has paid for yet. The fee below includes GST. The deposit is unchanged. For a paid booking, cancel it with the right refund and book it again.</p>
          <div className="form-grid">
            <div className="field"><label>Correct fee incl. GST (₹) *</label><input type="number" min="0" data-testid="adjust-fee-input" value={newFee} onChange={(e) => setNewFee(e.target.value)} /></div>
            <div className="field"><label>Reason *</label><input data-testid="adjust-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Wrong rate applied" /></div>
          </div>
          <div className="bk-actions">
            <button className="btn" disabled={busy || !reason.trim() || newFee === ''} data-testid="adjust-confirm" onClick={() => run({ _action: 'adjust_fee', newFee, adjustReason: reason.trim() })}>Save corrected fee</button>
            <button className="btn secondary" onClick={() => setMode(null)}>Keep as is</button>
          </div>
        </div>
      )}

      {mode === 'cancel' && (
        <div className="assign" data-testid="cancel-panel">
          <b>Cancel this booking?</b>
          {!cq.paid ? (
            <p className="muted" style={{ margin: '6px 0' }}>Nothing has been paid, so nothing is charged. The reservation is simply released.</p>
          ) : (
            <div className="price-box" style={{ marginTop: 8 }}>
              <div className="pr-row sub"><span>{cq.waived ? 'Cancelled by the community: full refund' : `Cancelling ${cq.hoursLeft} h before the start`}</span><b>{cq.pct}% of fee</b></div>
              <div className="pr-row sub"><span>Fee paid</span><span>{inr(cq.feePaid)}</span></div>
              <div className="pr-row sub"><span>Fee refunded</span><span>{inr(feeRefund)}</span></div>
              <div className="pr-row sub"><span>Retained</span><span>{inr(cq.feePaid - feeRefund)}</span></div>
              {cq.refundDeposit > 0 && <div className="pr-row sub"><span>Security deposit returned</span><span>{inr(cq.refundDeposit)}</span></div>}
              <div className="pr-row total"><span>You get back</span><b data-testid="refund-total">{inr(total)}</b></div>
            </div>
          )}
          {cq.paid && total > 0 && (
            <div className="field" style={{ marginTop: 8 }} data-testid="refund-choice">
              <label>Where should the refund go?</label>
              <div className="chips" role="group" aria-label="Refund destination">
                <button type="button" className={`chip${toCredit ? ' on' : ''}`} aria-pressed={toCredit} data-testid="refund-credit" onClick={() => setRefundTo('credit')}>💳 Unit account credit</button>
                <button type="button" className={`chip${!toCredit ? ' on' : ''}`} aria-pressed={!toCredit} disabled={viaCredit} data-testid="refund-original" onClick={() => setRefundTo('original')}>↩ Original payment mode{b.paymentMode ? ` (${b.paymentMode})` : ''}</button>
              </div>
              <small className="muted">{viaCredit ? 'This booking was paid (at least partly) from unit credit, so the refund goes back to the unit account.' : toCredit ? 'Credited at once. Use it on your next booking — it can cover all of it or part of it.' : 'The office pays it back to the way you paid, and you get a notification when it is done.'}</small>
              <Steps testid="refund-preview" steps={[
                { title: 'You cancel', sub: 'The reservation is released for others', current: true },
                { title: `Refund approved · ${inr(total)}`, sub: `${cq.pct}% of the fee${cq.refundDeposit > 0 ? ' + full security deposit' : ''}` },
                { title: toCredit ? 'Credited to the unit account straight away' : 'Office pays it out', sub: toCredit ? 'Shown as unit credit when you book next' : `${b.paymentMode || 'Original mode'} — you are notified once paid` },
              ]} />
            </div>
          )}
          <div className="field" style={{ marginTop: 8 }}><label>Reason {isStaff ? '*' : '(optional)'}</label><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Plans changed" /></div>
          {isStaff && cq.paid && (
            <div className="form-grid">
              <label className="check"><input type="checkbox" checked={waive} onChange={(e) => setWaive(e.target.checked)} /> Waive charges (community cancelled)</label>
              <div className="field"><label>Override fee refund (₹, optional)</label><input type="number" min="0" max={cq.feePaid} value={override} onChange={(e) => setOverride(e.target.value)} /></div>
            </div>
          )}
          <div className="bk-actions">
            <button className="btn danger" disabled={busy || (isStaff && !reason.trim())} data-testid="confirm-cancel" onClick={() => run({ _action: 'cancel', cancelReason: reason.trim(), refundTo: toCredit ? 'credit' : 'original', ...(isStaff ? { waive, refundOverride: overrideNum ?? undefined } : {}) })}>Confirm cancellation</button>
            <button className="btn secondary" onClick={() => setMode(null)}>Keep booking</button>
          </div>
        </div>
      )}

      {mode === 'receive' && (
        <div className="assign">
          <b>Record payment of {inr(b.totalPayable)}</b>
          <div className="form-grid">
            <div className="field"><label>Received by</label><select value={payMode} onChange={(e) => setPayMode(e.target.value)}>{PAYMENT_MODES.map((m) => <option key={m}>{m}</option>)}</select></div>
            <div className="field"><label>Receipt / cheque no.</label><input value={ref} onChange={(e) => setRef(e.target.value)} /></div>
          </div>
          <div className="bk-actions"><button className="btn good" disabled={busy} data-testid="confirm-receive" onClick={() => run({ _action: 'receive_payment', paymentMode: payMode, paymentRef: ref })}>Record in Payments Cross-check</button><button className="btn secondary" onClick={() => setMode(null)}>Back</button></div>
        </div>
      )}

      {(mode === 'refund' || mode === 'depositPaid') && (
        <div className="assign" data-testid="payout-panel">
          <b>Pay out {inr(mode === 'refund' ? b.refundAmount : b.depositReturned)} to {b.bookedFor === 'Association' ? b.association : b.unit}</b>
          <div className="form-grid">
            <div className="field"><label>Paid by *</label><select aria-label="Paid by" value={outMode} onChange={(e) => setOutMode(e.target.value)}>{PAYOUT_MODES.map((m) => <option key={m}>{m}</option>)}</select></div>
            <div className="field"><label>{outMode === 'Cheque' ? 'Cheque number *' : outMode === 'Cash' ? 'Receipt / voucher no. (optional)' : 'Transaction / UTR reference *'}</label><input aria-label="Payout reference" value={ref} onChange={(e) => setRef(e.target.value)} /></div>
          </div>
          <small className="muted">Recorded in Payments Cross-check as a debit and the villa is notified.</small>
          <div className="bk-actions">
            <button className="btn good" disabled={busy || (needsRef(outMode) && !ref.trim())} data-testid="confirm-payout" onClick={() => run({ _action: mode === 'refund' ? 'mark_refund_paid' : 'mark_deposit_paid', payoutMode: outMode, paymentRef: ref })}>Confirm payment</button>
            {ONLINE_MODES.includes(b.paymentMode) && <button className="btn" disabled={busy} data-testid="initiate-refund-panel" onClick={() => run({ _action: mode === 'refund' ? 'mark_refund_paid' : 'mark_deposit_paid', initiate: true })}>↩ Initiate to {b.paymentMode}</button>}
            {mode === 'refund' && <button className="btn secondary" disabled={busy} data-testid="refund-to-credit" onClick={() => run({ _action: 'refund_to_credit' })}>Credit to unit account instead</button>}
            <button className="btn secondary" onClick={() => setMode(null)}>Back</button>
          </div>
        </div>
      )}

      {mode === 'settle' && (
        <div className="assign" data-testid="settle-panel">
          <b>Settle the {inr(b.depositAmount)} security deposit</b>
          <p className="muted" style={{ margin: '4px 0' }}>Inspect the amenity, add photos of its condition, then decide what is returned and how it is paid.</p>
          <div className="form-grid">
            <div className="field"><label>Deduct for damage / cleaning (₹)</label><input aria-label="Deduction" type="number" min="0" max={b.depositAmount} value={deduct} onChange={(e) => setDeduct(e.target.value)} placeholder="0" /></div>
            <div className="field" data-testid="deposit-method-box"><label>Return the balance by</label>
              <div className="chips" role="group" aria-label="Deposit refund method">
                {depChoices.map((c) => <button key={c.value} type="button" disabled={depBack <= 0} className={`chip${depMode === c.value ? ' on' : ''}`} aria-pressed={depMode === c.value} data-testid={`dep-${c.key}`} onClick={() => setDepMode(c.value)}>{c.label}</button>)}
              </div></div>
          </div>
          <div className="field" style={{ marginTop: 8 }} data-testid="deduction-reason"><label>Reason {Number(deduct) > 0 ? '*' : '(optional)'}</label>
            <RichTextEditor value={deductWhy} onChange={setDeductWhy} placeholder="What was damaged or left dirty? Use bold, lists, links…" minHeight={90} /></div>
          <div className="field" style={{ marginTop: 8 }} data-testid="deposit-photo-picker"><label>Inspection photos {Number(deduct) > 0 ? '* (evidence for the deduction)' : '(recommended)'}</label>
            <AttachmentPicker pending={photos} onChange={setPhotos} label="Add photos" compact /></div>
          {depBack > 0 && (
            <Steps testid="deposit-preview" steps={[
              { title: 'Inspect and settle', sub: Number(deduct) > 0 ? `${inr(Number(deduct))} deducted, photos and reason kept on record` : 'No deduction', current: true },
              { title: `Return ${inr(depBack)}`, sub: depMode === 'Unit credit' ? 'Credited to the unit account straight away' : ONLINE_MODES.includes(depMode) ? `Back to the original ${depMode} payment - tap “Initiate refund” next` : `Paid by ${depMode} - you record the reference next` },
              { title: depMode === 'Unit credit' ? 'Resident sees it as credit on the next booking' : 'Resident is notified once it is paid' },
            ]} />
          )}
          <p style={{ margin: '8px 0' }}>Returned: <b data-testid="deposit-back">{inr(depBack)}</b> · {depBack <= 0 ? 'nothing to pay out' : depMode === 'Unit credit' ? 'credited to the unit account at once' : `to be paid by ${depMode} — you will record the payment next`}</p>
          <div className="bk-actions"><button className="btn good" disabled={busy || !settleOk} data-testid="confirm-settle" onClick={async () => {
            setBusy(true);
            let metas;
            try { metas = photos.length ? await persistPending(photos, { ownerType: 'amenityDeposit', ownerId: b.id }) : []; } catch (e) { tell(e?.message || String(e), e?.name === 'NetworkError' || e?.name === 'TimeoutError' ? 'network' : 'error'); return; } finally { setBusy(false); }
            if (!metas) return;
            run({ _action: 'settle_deposit', depositDeduction: Number(deduct) || 0, deductionReason: deductWhy, depositPhotos: metas, payoutMode: depBack > 0 ? depMode : '' });
          }}>Settle deposit</button><button className="btn secondary" onClick={() => setMode(null)}>Back</button></div>
        </div>
      )}
    </Modal>
  );
}
