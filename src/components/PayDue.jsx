import CorrectBill from './CorrectBill.jsx';
import React, { useEffect, useState } from 'react';
import { StatusTag } from './StatusTag.jsx';
import Modal from './Modal.jsx';
import DynamicForm from './DynamicForm.jsx';
import { AttachmentList } from './Attachments.jsx';
import { useApp, useCollection } from '../context/AppContext.jsx';
import { COLLECTIONS } from '../lib/storage/index.js';
import { todayIso } from '../lib/notice.js';
import { getPrincipal } from '../lib/security/principal.js';
import { PlanDialog } from '../modules/billing/FinanceTools.jsx';
import BillTerms from './BillTerms.jsx';
import { DocButton } from './DocumentPreview.jsx';
import { billReceipt } from '../lib/documents/builders.js';
import { useGatewayPay, PaymentResult } from './GatewayCheckout.jsx';
import { storage } from '../lib/storage/index.js';
import { lateFeeSettings, finalDue, applyLateFees } from '../lib/finance/rules.js';
import { quoteBills } from '../lib/payments/index.js';
import { serverDecides } from '../lib/auth/session.js';
import { tell } from '../lib/net/activity.js';
import { money } from '../lib/locale.js';

const inr = (n) => money(n, { round: false });
import { ONLINE_MODES as ONLINE, ALL_MODES } from '../lib/region/paymentModes.js';

/** Who may settle a bill from the UI: the owner of that unit, or finance roles (recording a payment that arrived offline). */
export function usePayRights(due) {
  const { role, roleId, currentUser, hasPermission } = useApp();
  const resident = role?.category === 'Resident';
  const finance = roleId === 'super_admin' || hasPermission('MANAGE_DUES') || hasPermission('MANAGE_UTILITY_BILLING');
  const unpaid = due && !['Paid', 'Cancelled'].includes(due.status);
  // their own unit's bill: any owner pays it online, a committee or staff member who owns the unit too
  const own = !!due && !!currentUser?.unit && due.unit === currentUser.unit;
  return {
    resident,
    own,
    finance,
    canPay: !!unpaid && (own || (!resident && finance)),
  };
}

/**
 * One payment flow for every place a bill can be opened from (Billing → Dues, My home → Dues, a unit's page).
 * Owners pay online (simulated here - a payment gateway plugs in at `confirm`); finance roles record a payment that
 * arrived by cheque / cash / transfer, with its reference and date. Either way the bill is marked Paid and a receipt shown.
 */
export function PayDueModal({ due, onClose }) {
  const { currentUser } = useApp();
  const { save } = useCollection(COLLECTIONS.DUES, 'Billing & Finance');
  const { resident: isResident, own, finance } = usePayRights(due);
  const [asOwner, setAsOwner] = useState(true);
  // paying as the owner (online through the provider): a resident always; an owner on the committee for their own unit, unless they
  // switch to recording a payment that arrived another way (finance roles only)
  const resident = isResident || (own && (asOwner || !finance));
  const modes = resident ? ONLINE : ALL_MODES;
  const [mode, setMode] = useState(modes[0]);
  const [ref, setRef] = useState('');
  const [paidOn, setPaidOn] = useState(todayIso());
  const [busy, setBusy] = useState(false);
  const [fe, setFe] = useState({});
  const [receipt, setReceipt] = useState(null);
  const gw = useGatewayPay();
  const [attempt, setAttempt] = useState(null);
  const [feesPaid, setFeesPaid] = useState(0);
  const [fd, setFd] = useState(null); // final due: the bill + late fee (added or accruing)
  useEffect(() => {
    let on = true;
    // with a back end that enforces sign-in the SERVER prices the bill (late fees included); show exactly that amount
    if (serverDecides()) { quoteBills([due.id], { includeLateFees: true }).then((q) => { if (on && q) setFd({ total: q.amount, charged: Math.max(0, q.amount - Number(due.amount)), pending: 0, fromServer: true }); }); return () => { on = false; }; }
    Promise.all([lateFeeSettings(), storage.list(COLLECTIONS.DUES)]).then(([s, all]) => { if (on) setFd(finalDue(due, all, s)); }).catch(() => {}); return () => { on = false; };
  }, [due.id]);
  const payable = fd ? fd.total : Number(due.amount);
  /** Late fees that have accrued are added to the dues first so the one payment clears the bill and its fees together. */
  async function feeDues() {
    if (serverDecides()) return [];   // the server adds any accrued late fee to the order itself
    if (!fd || (fd.charged + fd.pending) <= 0) return [];
    if (fd.pending > 0) await applyLateFees({ only: due.id, actor: currentUser?.name || 'Billing' });
    return (await storage.list(COLLECTIONS.DUES)).filter((x) => x.lateFeeFor === due.id && !['Paid', 'Cancelled'].includes(x.status));
  }

  async function payOnlineNow() {
    setBusy(true); setAttempt(null);
    let res;
    try {
      const fees = await feeDues(); setFeesPaid(fees.reduce((n, f) => n + Number(f.amount), 0));
      res = await gw.start({ purpose: 'due', includeLateFees: true, refs: [due.id, ...fees.map((f) => f.id)], amount: Math.round((Number(due.amount) + fees.reduce((n, f) => n + Number(f.amount), 0)) * 100) / 100, unit: due.unit, payer: currentUser?.name || '', description: `${due.category}${due.billedMonth ? ` · ${due.billedMonth}` : ''} · ${due.unit}` });
    } catch (e) {
      tell(e?.message || String(e), e?.name === 'NetworkError' || e?.name === 'TimeoutError' ? 'network' : 'error');
      return;
    } finally {
      setBusy(false);
    }
    if (res.status === 'Paid') { const fresh = await storage.get(COLLECTIONS.DUES, due.id); setReceipt(fresh || { ...due, status: 'Paid' }); } else setAttempt(res);
  }

  async function confirm() {
    if (resident) return payOnlineNow();
    const reference = resident ? `TXN-${Date.now().toString(36).toUpperCase()}` : ref.trim();
    const er = {};
    if (!resident && mode !== 'Cash' && !reference) er.ref = `Enter the ${mode === 'Cheque' ? 'cheque number' : 'transaction reference'}`;
    if (!resident && !paidOn) er.paidOn = 'Received-on date is required';
    else if (!resident && paidOn > todayIso()) er.paidOn = 'The payment date cannot be in the future';
    setFe(er);
    if (Object.keys(er).length) return;
    setBusy(true);
    const receiptNo = `RCT-${String(due.shortId || '').replace(/^DUE-/, '') || Date.now()}`;
    let saved;
    try {
      const fees = await feeDues(); setFeesPaid(fees.reduce((n, f) => n + Number(f.amount), 0));
      for (const f of fees) await save({ ...f, status: 'Paid', paymentMode: mode, paymentRef: reference || '—', paidAt: resident ? todayIso() : paidOn, paidBy: currentUser?.name || '', receiptNo: `RCT-${String(f.shortId || '').replace(/^DUE-/, '')}` });
      saved = await save({ ...due, status: 'Paid', paymentMode: mode, paymentRef: reference || '—', paidAt: resident ? todayIso() : paidOn, paidBy: currentUser?.name || '', receiptNo });
    } catch (e) {
      tell(e?.message || String(e), e?.name === 'NetworkError' || e?.name === 'TimeoutError' ? 'network' : 'error');
      return;
    } finally {
      setBusy(false);
    }
    if (saved) setReceipt(saved);
  }

  if (receipt) {
    return (
      <Modal title="Payment received" subtitle={`Receipt ${receipt.receiptNo} — keep it for your records.`} onClose={onClose}>
        <div className="ro-block">
          <h3>✅ {inr(Number(receipt.amount) + feesPaid)} paid</h3>{feesPaid > 0 && <p className="muted" data-testid="paid-late">Includes {inr(feesPaid)} late fee.</p>}
          <div className="kv">
            <span>Unit</span><b>{receipt.unit}</b>
            <span>For</span><b>{receipt.category}{receipt.billedMonth ? ` · ${receipt.billedMonth}` : ''}</b>
            <span>Mode</span><b>{receipt.paymentMode}</b>
            <span>Reference</span><b>{receipt.paymentRef}</b>
            <span>Paid on</span><b>{receipt.paidAt}</b>
            <span>Receipt no.</span><b>{receipt.receiptNo}</b>
          </div>
        </div>
        <div className="form-actions"><DocButton className="btn secondary" testid="receipt-open" label="🧾 Receipt (print / PDF)" build={() => billReceipt(receipt)} title={`Receipt ${receipt.receiptNo}`} fileName={receipt.receiptNo} /><button className="btn" onClick={onClose}>Done</button></div>
      </Modal>
    );
  }

  return (
    <Modal
      title={resident ? `Pay ${inr(payable)}` : `Record payment · ${due.unit}`}
      subtitle={resident ? `${due.category}${due.billedMonth ? ` bill for ${due.billedMonth}` : ''}. Choose how you want to pay.` : 'Record money received for this bill (cheque, cash or transfer). The bill is marked Paid and a receipt number is issued.'}
      onClose={onClose}>
      <div className="ro-block" style={{ marginBottom: 12 }}>
        <div className="kv">
          <span>Unit</span><b>{due.unit}</b>
          <span>Bill</span><b>{due.category}{due.billedMonth ? ` · ${due.billedMonth}` : ''}</b>
          <span>Payable by</span><b>{due.dueDate || '—'}</b>
          <span><b>Amount</b></span><b>{inr(due.amount)}</b>
          {fd && fd.total !== fd.base && <><span>Late fee</span><b className="due-over" data-testid="pay-late">{inr(fd.charged + fd.pending)}</b><span><b>Final amount due</b></span><b data-testid="pay-final">{inr(fd.total)}</b></>}
        </div>
      </div>
      <BillTerms compact due={due} amount={due.amount} flatTax={due.tax} dueDate={due.dueDate} status={due.status} />
      {own && !isResident && finance && (
        <div className="chips" role="group" aria-label="How" style={{ margin: '8px 0' }} data-testid="pay-as">
          <button type="button" className={`chip${asOwner ? ' on' : ''}`} aria-pressed={asOwner} onClick={() => setAsOwner(true)}>Pay online (my unit)</button>
          <button type="button" className={`chip${!asOwner ? ' on' : ''}`} aria-pressed={!asOwner} onClick={() => setAsOwner(false)}>Record a payment received</button>
        </div>
      )}
      <div className="form-grid">
        {!resident && <div className="field"><label>Payment mode *</label>
          <select value={mode} onChange={(e) => setMode(e.target.value)}>{modes.map((m) => <option key={m}>{m}</option>)}</select>
        </div>}
        {!resident && (
          <>
            <div className={`field${fe.ref ? ' invalid' : ''}`}><label>{mode === 'Cheque' ? 'Cheque number' : 'Reference / transaction id'}{mode !== 'Cash' ? ' *' : ''}</label>
              <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder={mode === 'Cash' ? 'Optional' : ''} />
              {fe.ref && <div className="field-error">{fe.ref}</div>}
            </div>
            <div className={`field${fe.paidOn ? ' invalid' : ''}`}><label>Received on *</label><input type="date" value={paidOn} max={todayIso()} onChange={(e) => setPaidOn(e.target.value)} />{fe.paidOn && <div className="field-error">{fe.paidOn}</div>}</div>
          </>
        )}
      </div>
      {resident && <p className="muted" style={{ fontSize: 12 }}>You will be taken to the payment page. This demo uses a simulated provider - no real money moves.</p>}
      {attempt && <PaymentResult result={attempt} onRetry={payOnlineNow} onDone={() => { setAttempt(null); storage.get(COLLECTIONS.DUES, due.id).then((f) => f && setReceipt(f)); }} />}
      {gw.node}
      <div className="form-actions">
        <button className="btn" disabled={busy} onClick={confirm}>{busy ? 'Processing…' : resident ? `Pay ${inr(payable)}` : `Record payment${fd && fd.total !== fd.base ? ` · ${inr(payable)}` : ''}`}</button>
        <button className="btn secondary" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

/** Meter readings (Water / DG bills), payment details and the Pay button - shown inside any bill's detail view. */
export function DueExtras({ due }) {
  const { records } = useCollection(COLLECTIONS.DUES, 'Billing & Finance');
  const live = records.find((r) => r.id === due?.id) || due;
  const { canPay, resident } = usePayRights(live);
  const [paying, setPaying] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const { roleId, hasPermission } = useApp();
  if (!live?.id) return null;
  const canSplit = live.category === 'Maintenance' && !['Paid', 'Cancelled'].includes(live.status) && live.plan === 'Yearly' && (roleId === 'super_admin' || hasPermission('MANAGE_DUES') || hasPermission('MANAGE_LEDGER'));
  const canPlan = !resident && !['Paid', 'Cancelled'].includes(live.status) && live.plan !== 'Instalments' && live.category !== 'Late fee' && Number(live.amount) > 0 && (roleId === 'super_admin' || hasPermission('MANAGE_DUES') || hasPermission('MANAGE_LEDGER'));
  const split = async () => { const { splitIntoInstalments } = await import('../lib/maintenanceFee.js'); await splitIntoInstalments(live, { actor: getPrincipal().name }); };
  const canCorrect = !resident && live.category !== 'Late fee' && live.status !== 'Cancelled' && (roleId === 'super_admin' || hasPermission('MANAGE_DUES') || hasPermission('MANAGE_UTILITY_BILLING'));
  const usage = (Number(live.unitsConsumed) || 0) * (Number(live.ratePerUnit) || 0);

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {live.status === 'Cancelled' && (
        <div className="ro-block" data-testid="bill-cancelled">
          <h3>🚫 Cancelled</h3>
          <div className="kv"><span>Was</span><b>{inr(live.originalAmount)}</b><span>Because</span><b>{live.cancelReason || '—'}</b><span>By</span><b>{live.cancelledBy || '—'} · {String(live.cancelledAt || '').slice(0, 10)}</b>{live.replacedBy && <><span>Replaced by</span><b>{live.replacedBy}</b></>}</div>
        </div>
      )}
      {live.correctionOf && <div className="notice" data-testid="bill-correction-of">This bill replaces {live.correctionOf}.</div>}
      {live.status === 'Paid' ? (
        <div className="ro-block">
          <h3>✅ <StatusTag v="Paid" /></h3>
          <div className="kv">
            <span>Paid on</span><b>{live.paidAt || '—'}</b>
            <span>Mode</span><b>{live.paymentMode || '—'}</b>
            <span>Reference</span><b>{live.paymentRef || '—'}</b>
            <span>Receipt no.</span><b>{live.receiptNo || '—'}</b>
            {live.paidBy && <><span>Recorded by</span><b>{live.paidBy}</b></>}
          </div>
          <div style={{ marginTop: 8 }}><DocButton testid="receipt-open" label="🧾 Receipt (print / PDF)" build={() => billReceipt(live)} title={`Receipt ${live.receiptNo}`} fileName={live.receiptNo} /></div>
        </div>
      ) : canPay ? (
        <div className="ro-block" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span><b>{inr(live.amount)}</b> <StatusTag v={live.status === 'Overdue' ? 'Overdue' : 'Unpaid'} />{live.dueDate ? ` · payable by ${live.dueDate}` : ''}</span>
          <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><DocButton testid="bill-print" label="🖨 Print bill" build={() => billReceipt(live)} title={`Bill ${live.shortId}`} fileName={live.shortId} /><button type="button" className="btn" onClick={() => setPaying(true)}>{resident ? 'Pay now' : 'Record payment'}</button></span>
        </div>
      ) : null}

      {canCorrect && <div><button type="button" className="btn secondary sm" data-testid="correct-bill-open" onClick={() => setCorrecting(true)}>Something wrong with this bill?</button></div>}
      {live.correctionNote && <details data-testid="bill-history"><summary>Correction history</summary><pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{live.correctionNote}</pre></details>}
      {correcting && <CorrectBill due={live} onClose={() => setCorrecting(false)} />}

      <BillTerms due={live} amount={live.amount} flatTax={live.tax} dueDate={live.dueDate} status={live.status} />

      {live.readingId ? (
        <>
          <div className="ro-block">
            <h3>{live.category === 'DG' ? '⚡ DG' : '💧 Water'} meter readings · {live.billedMonth}</h3>
            <div className="kv">
              <span>Previous reading</span><b>{live.previousReading}</b>
              <span>Current reading</span><b>{live.currentReading}</b>
              <span>Units consumed</span><b>{live.unitsConsumed}</b>
              <span>{live.unitsConsumed} units × ₹{live.ratePerUnit}</span><b>{inr(usage)}</b>
              <span>Fixed charge</span><b>{inr(live.fixedCharge)}</b>
              <span>Tax</span><b>{inr(live.tax)}</b>
              <span><b>Total</b></span><b>{inr(live.amount)}</b>
            </div>
          </div>
          <div className="ro-block"><h3>📷 Meter photos</h3><AttachmentList items={Array.isArray(live.photos) ? live.photos : []} /></div>
          {live.notice && <div className="ro-block"><h3>✉ Notice sent to the owner</h3><div className="notice-text">{live.notice}</div></div>}
        </>
      ) : (
        <>
          <div className="ro-block" data-testid="bill-breakdown">
            <h3>{live.category === 'Maintenance' ? '🏠 Maintenance fee' : `${live.category} charge`} · {live.billedMonth || '—'}</h3>
            <div className="kv">
              <span>Unit</span><b>{live.unit}</b>
              {live.plan && <><span>Paid</span><b>{live.plan}{live.instalment && live.plan === 'Quarterly' ? ` · instalment ${live.instalment}` : ''}</b></>}
              {live.annualFee ? <><span>Yearly fee</span><b>{inr(live.annualFee)}</b></> : null}
              <span>Payable by</span><b>{live.dueDate || '—'}</b>
              <span><b>Total this bill</b></span><b>{inr(live.amount)}</b>
            </div>
            {canSplit && <button type="button" className="btn secondary sm" data-testid="split-quarterly" style={{ marginTop: 8 }} onClick={split}>Pay quarterly instead (4 instalments)</button>}
          </div>
          {live.notice && <div className="ro-block"><h3>✉ Notice sent to the owner</h3><div className="notice-text">{live.notice}</div></div>}
        </>
      )}

      {canPlan && <div><button type="button" className="btn secondary sm" data-testid="plan-open" onClick={() => setPlanning(true)}>Pay in instalments…</button></div>}
      {paying && <PayDueModal due={live} onClose={() => setPaying(false)} />}
      {planning && <PlanDialog due={live} onClose={() => setPlanning(false)} />}
    </div>
  );
}

/** A bill opened on its own (from My home / a unit page): the same detail the Billing screen shows. */
export function DueDetailModal({ due, onClose }) {
  const { roleId, schemaFor } = useApp();
  const schema = schemaFor(COLLECTIONS.DUES);
  return (
    <Modal title={`${due.category} bill · ${due.billedMonth || due.dueDate || ''}`} subtitle="Bill details, meter readings and payment." onClose={onClose}>
      {schema && <DynamicForm schema={schema} roleId={roleId} record={due} readOnly extra={<DueExtras due={due} />} onSave={() => {}} onCancel={onClose} />}
    </Modal>
  );
}
