import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { needsRef } from '../../lib/region/paymentModes.js';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { getDataSource } from '../../lib/storage/dataSource.js';
import { SegTabs, MoneyTiles } from '../../components/ui.jsx';
import Modal from '../../components/Modal.jsx';
import Combobox from '../../components/Combobox.jsx';
import { AREAS, MODES, areaOf, routingMap, recordPayment, suggestMatches, applyMatch, undoMatch, gstCheck, GST_NOW } from '../../lib/paymentEngine.js';
import { PayeeView } from '../approval/Payee.jsx';
import PaymentRequest from '../approval/PaymentRequest.jsx';
import { invoiceApproval } from '../tickets/ticketEngine.js';
import { liveDebits, taskMoney, grossOf } from '../../lib/approval/moneyGuard.js';
import SectionPage from '../../components/SectionPage.jsx';
import FinancialTasks, { useFinancialQueue } from './FinancialTasks.jsx';
import CulturalPayments from './CulturalPayments.jsx';
import Collections from './Collections.jsx';
import UtilityPayments from './UtilityPayments.jsx';
import { recomputeEventTotals } from '../../lib/culturalServer.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import { tell } from '../../lib/net/activity.js';
import { AttachmentPicker } from '../../components/Attachments.jsx';
import { persistPending } from '../../lib/files/attachments.js';
import { TDS_SECTIONS, submitPayRequest, markReleasePaid, r2 } from '../../lib/finance/rules.js';
import Reconciliation from './Reconciliation.jsx';
import PayoutDialog from './PayoutDialog.jsx';
import { payoutsOnServer } from '../../lib/payouts.js';
import { IncomeDialog, RecurringDialog, RequestsPanel } from './MoreMoney.jsx';
import { fmtDate, money, todayLocal } from '../../lib/locale.js';

const inr = (n) => money(n);
const dmy = (s) => fmtDate(s, { empty: '—' });
const today = () => todayLocal();

/** The record a payment can be linked to, per area. */
function useLinkables() {
  const { records: tickets } = useCollection(C.TICKETS, 'Tasks');
  const { records: expenses } = useCollection(C.CULTURAL_EXPENSES, 'Event Expenses');
  const { records: events } = useCollection(C.CULTURAL_EVENTS, 'Cultural Events');
  const { records: fuel } = useCollection(C.DG_FUEL_LOGS, 'DG Fuel Log');
  const { records: elec } = useCollection(C.ELECTRICITY_BILLS, 'Electricity Bills');
  const { records: assocBills } = useCollection(C.ASSOC_BILLS, 'Association Utility Bills');
  const { records: bookings } = useCollection(C.AMENITIES, 'Bookings');
  const { records: docs } = useCollection(C.QUOTATIONS, 'Quotations');
  const { records: ledger } = useCollection(C.LEDGER, 'Payments Cross-check');
  const { records: rels } = useCollection(C.RELEASES, 'Fund releases');
  return useMemo(() => {
    const paid = new Set(liveDebits(ledger).map((l) => l.sourceId).filter(Boolean));
    const tk = new Map(tickets.map((t) => [t.id, t]));
    const ev = new Map(events.map((e) => [e.id, e]));
    const xp = new Map(expenses.map((e) => [e.id, e]));
    return {
      Maintenance: [
        ...rels.filter((r) => r.status === 'Approved' && r.ticketId).map((r) => { const t = tk.get(r.ticketId); return { value: r.id, label: `${t?.ticketNumber || 'Task'} · ${r.kind} release · ${r.vendor}`, hint: inr(r.amount), amount: r.amount, type: 'release', vendor: r.vendor, taskRef: t?.ticketNumber, text: t?.title, release: r }; }),
        ...docs.filter((d) => d.kind === 'Invoice' && invoiceApproval(d).key === 'approved' && !paid.has(d.id)).map((d) => { const t = tk.get(d.ticketId); return { value: d.id, label: `${t?.ticketNumber || 'Task'} · invoice · ${d.vendor}`, hint: `${inr(d.amount)}${Number(d.gstAmount) ? ` incl. GST ${inr(d.gstAmount)}` : ''}`, amount: d.amount, type: 'invoice', vendor: d.vendor, taskRef: t?.ticketNumber, gst: { mode: Number(d.gstRate) > 0 ? 'Included' : 'None', rate: Number(d.gstRate) || 18, billed: Number(d.gstAmount) || 0 }, text: t?.title || '' }; }),
        ...tickets.filter((t) => t.financial).map((t) => ({ value: t.ticketNumber, label: `${t.ticketNumber} · ${t.title}`, hint: t.approvedAmount ? inr(t.approvedAmount) : '', amount: t.approvedAmount || 0, type: 'task', vendor: t.assignedTo || '', taskRef: t.ticketNumber, text: t.title })),
      ],
      Cultural: [...rels.filter((r) => r.status === 'Approved' && r.expenseId).map((r) => { const x = xp.get(r.expenseId); return { value: `culrel:${r.id}`, label: `${x?.item || 'Expense'} · release ${r.shortId || ''} · ${r.vendor}`, hint: inr(r.amount), amount: r.amount, type: 'culturalRelease', vendor: r.vendor, fund: x?.fund || ev.get(x?.eventId)?.fund || '', release: { ...r, id: r.id }, expense: x }; }), ...expenses.filter((x) => x.status === 'Approved').map((x) => ({ value: `cultural:${x.id}`, label: `${x.item} · ${ev.get(x.eventId)?.name || ''}`, hint: `${inr(x.amount)} · ${x.status}`, amount: x.amount, type: 'culturalExpense', vendor: x.vendor || '', fund: x.fund || ev.get(x.eventId)?.fund || '', expense: x }))],
      Utilities: [
        ...fuel.map((f) => ({ value: `dgfuel:${f.id}`, label: `DG diesel ${f.date} · ${f.litres} L`, hint: inr(f.amount || f.litres * f.rate), amount: f.amount || Math.round(f.litres * f.rate), type: 'dgFuel', vendor: f.supplier || '' })),
        ...elec.map((b) => ({ value: `elec:${b.id}`, label: `${b.shortId || ''} Electricity · ${b.service || 'Supply'} · ${b.period || b.billDate || ''}`, hint: inr(b.amount || b.totalAmount), amount: b.amount || b.totalAmount || 0, type: 'electricityBill', vendor: 'Electricity board' })),
        ...assocBills.map((b) => ({ value: `assoc:${b.id}`, label: `${b.shortId || ''} ${b.utility} · ${b.provider || ''} · ${b.period || ''}`, hint: `${inr(b.amount)} · ${b.location}`, amount: b.amount || 0, type: 'assocBill', vendor: b.provider || '' })),
      ],
      Amenities: bookings.filter((b) => b.refundStatus === 'Refund due' || b.depositRefundStatus === 'Due').map((b) => ({ value: `amenity:${b.id}:payout`, label: `${b.shortId} · ${b.amenity} refund`, hint: inr(b.refundStatus === 'Refund due' ? b.refundAmount : b.depositReturned), amount: b.refundStatus === 'Refund due' ? b.refundAmount : b.depositReturned, type: 'amenityRefund', vendor: '', unit: b.unit })),
    };
  }, [tickets, expenses, events, fuel, elec, bookings, docs, ledger, rels]);
}

export function PayDialog({ initial = {}, accounts, routing, onClose, onDone }) {
  const links = useLinkables();
  const { records: vendorRows } = useCollection(C.VENDORS, 'Vendors');
  const [f, setF] = useState(() => ({ area: initial.area || 'Maintenance', link: initial.link || '', amount: initial.amount ?? '', account: initial.account || '', mode: initial.mode || 'Bank transfer', ref: initial.ref || '', date: initial.date || today(), vendor: initial.vendor || '', description: initial.description || '', type: initial.type || 'Debit', gstMode: initial.gstMode || 'None', gstRate: initial.gstRate ?? 18 }));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState(false);
  const [files, setFiles] = useState([]);
  const [sent, setSent] = useState(false);
  const [tds, setTds] = useState({ on: false, section: TDS_SECTIONS[0].code, rate: TDS_SECTIONS[0].rate });
  const { records: fundRows } = useCollection(C.FUNDS, 'Fund Position');
  const { records: finSet } = useCollection(C.FINANCE_SETTINGS, 'Finance Estimates');
  const { records: catRows } = useCollection(C.CATEGORY_MAP, 'Category Coverage');
  const { records: allLedger } = useCollection(C.LEDGER, 'Payments Cross-check');
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const options = links[f.area] || [];
  const picked = options.find((o) => o.value === f.link);
  // payments already recorded against the record being paid (same record, or the same task for another invoice)
  const { records: allTickets } = useCollection(C.TICKETS, 'Tasks');
  const { records: allDocs } = useCollection(C.QUOTATIONS, 'Quotations');
  const { records: allRels } = useCollection(C.RELEASES, 'Fund releases');
  const liveIds = new Set(liveDebits(allLedger).map((l) => l.id));
  const taskObj = picked?.taskRef ? allTickets.find((t) => t.ticketNumber === picked.taskRef) : null;
  const tm = taskObj ? taskMoney(taskObj, allDocs, allRels, allLedger) : null;
  // what may still be paid: a release is capped by itself, anything else by what is approved minus what is already released or paid
  const maxPay = picked?.type === 'release' ? Number(picked.amount) : tm && tm.cap > 0 ? tm.remaining : null;
  const sameRec = picked ? allLedger.filter((l) => liveIds.has(l.id) && picked.value && l.sourceId === picked.value) : [];
  const sameTask = picked?.taskRef ? allLedger.filter((l) => liveIds.has(l.id) && l.taskRef === picked.taskRef && !sameRec.includes(l)) : [];
  const priorSum = [...sameRec, ...sameTask].reduce((n, l) => n + (Number(l.amount) || 0), 0);
  const willExceed = picked && Number(picked.amount) > 0 && (sameRec.length > 0 || sameTask.length > 0) && picked.type === 'task' && priorSum + Number(f.amount || 0) > Number(picked.amount) + 0.5;
  const needAck = sameRec.length > 0 || sameTask.length > 0 || willExceed;
  const account = f.account || (picked?.fund && accounts.some((a) => a.name === picked.fund) ? picked.fund : routing[f.area]) || '';
  // what is still payable on the task an option belongs to (null when nothing is approved yet)
  const tm0 = (o) => { const t = allTickets.find((x) => x.ticketNumber === o.taskRef); if (!t) return null; const m = taskMoney(t, allDocs, allRels, allLedger); return m.cap > 0 ? m.remaining : null; };
  function pickLink(v) {
    setAck(false);
    const o = options.find((x) => x.value === v);
    const payBy = o?.release?.payMode && MODES.includes(o.release.payMode) ? { mode: o.release.payMode } : {};   // how the asker said the payee is paid
    setF((x) => ({ ...x, link: v, ...payBy, ...(o ? { amount: (o.taskRef && o.type !== 'release' && tm0(o) != null ? Math.min(Number(o.amount) || tm0(o), tm0(o)) : o.amount) || x.amount, vendor: o.vendor || x.vendor, description: x.description || o.label, ...(o.gst ? { gstMode: o.gst.mode, gstRate: o.gst.rate } : {}) } : {}) }));
  }
  const vendorRec = vendorRows.find((v) => v.name === f.vendor);
  const gst = gstCheck({ amount: f.amount, mode: f.gstMode, rate: f.gstRate, date: f.date, area: f.area, text: `${f.description} ${picked?.label || ''} ${picked?.text || ''} ${f.vendor}`, gstin: vendorRec?.gstin, vendor: f.vendor ? vendorRec?.name || f.vendor : undefined, billedGst: picked?.gst?.billed || undefined });
  const tdsAmount = f.type === 'Debit' && tds.on ? r2((gst.base * (Number(tds.rate) || 0)) / 100) : 0;
  const netPaid = r2(gst.total - tdsAmount);
  const limit = Number(finSet[0]?.approvalLimit) || 0;
  async function pay() {
    setErr('');
    if (maxPay != null && f.type !== 'Credit' && gst.total > maxPay + 0.5) return setErr(maxPay <= 0.5 ? 'Nothing is left to pay on this task - the approved amount is already released or paid. To fix a wrong payment, reverse it first.' : `Only ${inr(maxPay)} can still be paid here (${picked?.type === 'release' ? 'the release amount' : `${tm.basis.toLowerCase()} ${inr(tm.cap)} less ${inr(tm.committed)} already released or paid`}).`);
    if (needAck && !ack) return setErr('Other payments exist. Tick the box above the buttons to confirm you have checked them.');
    if (gst.msgs.some((m) => m.tone === 'bad') && !window.confirm('The GST on this payment looks wrong (see the red note). Record it anyway?')) return;
    if (!account) return setErr('Choose the bank account');
    if (!(Number(f.amount) > 0)) return setErr('Enter the amount');
    if (f.gstMode !== 'None' && !(Number(f.gstRate) >= 0)) return setErr('Choose the GST rate');
    if (!f.description.trim() && !picked) return setErr('Say what this payment is for');
    if (needsRef(f.mode) && !f.ref.trim()) return setErr(`Enter the ${f.mode === 'Cheque' ? 'cheque number' : 'UTR / reference'} - it is how the bank statement line is matched`);
    const extraRow = { ...(gst.hasGst ? { baseAmount: gst.base, gstRate: Number(f.gstRate), gstAmount: gst.gst } : {}), ...(f.subCategory ? { subCategory: f.subCategory } : {}), ...(f.fund ? { fund: f.fund } : {}), ...(tdsAmount > 0 ? { tdsSection: tds.section, tdsRate: Number(tds.rate), tdsAmount } : {}) };
    try {
      if (limit > 0 && f.type === 'Debit' && gst.total > limit) {
        setBusy(true);
        await submitPayRequest({ area: f.area, type: f.type, amount: netPaid, account, date: f.date, mode: f.mode, ref: f.ref.trim(), vendor: f.vendor, description: f.description.trim() || picked.label, sourceType: picked?.type || 'manual', sourceId: picked?.value || '', sourceLabel: picked?.label || '', taskRef: picked?.taskRef, unit: picked?.unit, allowDuplicate: sameRec.length > 0 && ack, extra: extraRow }, getPrincipal().name);
        setBusy(false); setSent(true); return;
      }
      setBusy(true);
      const res = await recordPayment({
        area: f.area, type: f.type, amount: netPaid, account, date: f.date, mode: f.mode, ref: f.ref.trim(), vendor: f.vendor, description: f.description.trim() || picked.label,
        sourceType: picked?.type || 'manual', sourceId: picked?.value || '', sourceLabel: picked?.label || '', taskRef: picked?.taskRef, unit: picked?.unit, allowDuplicate: sameRec.length > 0 && ack,
        extra: extraRow,
      });
      if (res.error) { setErr(res.error); setBusy(false); return; }
      // The payment is booked: anything below that fails is said out loud (the release would otherwise stay Approved and could be paid twice).
      const after = [];
      const step = async (what, work) => { try { await work(); } catch (e) { after.push(`${what} (${e?.message || 'failed'})`); } };
      const { secureStorage } = await import('../../lib/storage/secureStorage.js');
      const how = `${f.mode} · ${account}${f.ref ? ` · ${f.ref}` : ''}`;
      if (files.length && res.row && !res.existing) {
        const metas = await persistPending(files, { ownerType: 'ledger', ownerId: res.row.id });
        if (metas) await step('the attached file could not be linked to the payment', async () => { const cur = (await secureStorage.get(C.LEDGER, res.row.id)) || res.row; await secureStorage.put(C.LEDGER, { ...cur, attachments: [...(cur.attachments || []), ...metas] }); });
        else setErr('The payment was recorded but a file could not be stored. Open the payment and add it again.');
      }
      if (picked?.type === 'release' && !res.existing) {
        await step('the release could not be marked Paid', async () => {
          const cur = await secureStorage.get(C.RELEASES, picked.release.id); // fresh: the copy picked in the list may be out of date
          if (!cur) throw new Error('release not found');
          if (cur.status !== 'Paid') await secureStorage.put(C.RELEASES, { ...cur, status: 'Paid' });
        });
      }
      if (picked?.type === 'culturalRelease' && !res.existing) await step('the cultural release could not be marked Paid', () => markReleasePaid(picked.release.id, how));
      // the expense's Paid follows this payment: on the server it is set there; the browser demo sets it here
      if (picked?.type === 'culturalExpense' && !res.existing && picked.expense.status !== 'Paid' && getDataSource().mode !== 'v2') {
        await step('the cultural expense could not be marked Paid', async () => {
          const cur = await secureStorage.get(C.CULTURAL_EXPENSES, picked.expense.id);
          if (!cur) throw new Error('expense not found');
          if (cur.status !== 'Paid') await secureStorage.put(C.CULTURAL_EXPENSES, { ...cur, status: 'Paid', paidBy: how });
        });
        await step('the event totals could not be updated', () => recomputeEventTotals(picked.expense.eventId));
      }
      if (after.length) tell(`The payment was recorded, but ${after.join('; ')}. Do not pay it again - open it and mark it Paid by hand.`);
      setBusy(false); onDone(res.row);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  if (sent) {
    return (
      <Modal title="Sent for approval" subtitle="This payment is above the approval limit." onClose={() => { onClose(); onDone(null); }}>
        <p data-testid="pay-sent">{inr(gst.total)} to {f.vendor || 'the vendor'} needs a second person to approve it before it is paid. It is listed at the top of Payments. (Attach the bill again when it is paid, if you have one.)</p>
        <div className="form-actions"><button className="btn" onClick={() => { onClose(); onDone(null); }}>OK</button></div>
      </Modal>
    );
  }
  return (
    <Modal title={initial.title || 'Make a payment'} subtitle="One place for every payment: pick what it is for, the bank account and how it was paid. It is recorded in the ledger and can be matched to the bank statement." onClose={onClose}>
      {err && <div className="notice error" data-testid="pay-error">{err}</div>}
      <div className="form-grid" data-testid="pay-dialog">
        <div className="field"><label>Paid for *</label><select aria-label="Paid for" value={f.area} onChange={(e) => { set('area', e.target.value); set('link', ''); set('account', ''); }}>{AREAS.map((a) => <option key={a}>{a}</option>)}</select></div>
        <div className="field"><label>Sub-category (optional)</label>
          <select aria-label="Sub-category" data-testid="pay-subcat" value={f.subCategory || ''} onChange={(e) => set('subCategory', e.target.value)}><option value="">None</option>
            {catRows.filter((c) => (c.subCategories || []).length).map((c) => <optgroup key={c.id} label={c.category}>{c.subCategories.map((sc) => <option key={sc} value={`${c.category} › ${sc}`}>{sc}</option>)}</optgroup>)}</select></div>
        <div className="field"><label>{f.area === 'Cultural' ? 'Linked cultural expense' : f.area === 'Maintenance' ? 'Linked maintenance task' : f.area === 'Utilities' ? 'Linked association bill' : 'Linked record'} {options.length ? '' : '(none to link in this area)'}</label>
          <Combobox value={f.link} onChange={pickLink} options={options} placeholder={f.area === 'Cultural' ? 'Search expense, event, vendor…' : f.area === 'Maintenance' ? 'Search task number, title, vendor…' : 'Search task, expense, bill…'} disabled={!options.length} /></div>
        {picked && (
          <div className="notice" data-testid="linked-summary" style={{ gridColumn: '1 / -1', background: '#f0f9ff', borderColor: '#bae6fd' }}>
            <b>{picked.type === 'culturalExpense' ? '🎭 Linked cultural expense' : picked.taskRef ? '🔧 Linked maintenance task' : picked.type === 'assocBill' ? '🏢 Linked association bill' : '🔗 Linked record'}</b>
            <div style={{ display: 'flex', gap: '2px 14px', flexWrap: 'wrap', marginTop: 4, fontSize: 13 }}>
              <span>{picked.label}</span>
              {picked.taskRef && <span className="mono">{picked.taskRef}</span>}
              {picked.expense?.shortId && <span className="mono">{picked.expense.shortId}</span>}
              {picked.vendor && <span>Vendor: {picked.vendor}</span>}
              {picked.unit && <span>Unit: {picked.unit}</span>}
              {Number(picked.amount) > 0 && <span>Approved: <b>{inr(picked.amount)}</b></span>}
              {picked.expense?.status && <span>Status: {picked.expense.status}</span>}
              {tm && tm.cap > 0 && picked.type !== 'release' && <span data-testid="pay-limit">Still payable: <b>{inr(Math.max(0, tm.remaining))}</b> of {inr(tm.cap)} ({tm.basis.toLowerCase()} · {inr(tm.committed)} already released or paid)</span>}
            </div>
            <PayeeView release={picked.release} />
          </div>
        )}
        <div className="field"><label>Amount (₹) *</label><input type="number" aria-label="Amount" min="0" value={f.amount} onChange={(e) => set('amount', e.target.value)} /></div>
        <div className="field"><label>Bank account *</label>
          <select aria-label="Bank account" value={account} onChange={(e) => set('account', e.target.value)}><option value="">Choose…</option>{accounts.map((a) => <option key={a.id} value={a.name}>{a.name}{a.name === routing[f.area] ? ' (default for ' + f.area + ')' : ''}</option>)}</select></div>
        <div className="field"><label>Mode</label><select aria-label="Mode" value={f.mode} onChange={(e) => set('mode', e.target.value)}>{MODES.map((m) => <option key={m}>{m}</option>)}</select></div>
        <div className="field"><label>{f.mode === 'Cheque' ? 'Cheque number *' : 'UTR / reference' + (f.mode === 'Cash' ? '' : ' *')}</label><input aria-label="Reference" maxLength={100} value={f.ref} onChange={(e) => set('ref', e.target.value)} /></div>
        <div className="field"><label>Date</label><input type="date" aria-label="Payment date" value={f.date} max={today()} onChange={(e) => set('date', e.target.value)} /></div>
        <div className="field"><label>Paid to</label><input aria-label="Paid to" maxLength={200} value={f.vendor} onChange={(e) => set('vendor', e.target.value)} /></div>
        <div className="field"><label>Fund (optional)</label><select aria-label="Fund" data-testid="pay-fund" value={f.fund || ''} onChange={(e) => set('fund', e.target.value)}><option value="">None</option>{fundRows.map((x) => <option key={x.id} value={x.name}>{x.name}{x.kind ? ` (${x.kind})` : ''}</option>)}</select></div>
        {f.type === 'Debit' && (
          <div className="field" style={{ gridColumn: '1 / -1' }} data-testid="tds-box">
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" data-testid="tds-on" checked={tds.on} onChange={(e) => setTds((x) => ({ ...x, on: e.target.checked }))} /> Deduct TDS from this payment</label>
            {tds.on && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}>
                <select aria-label="TDS section" data-testid="tds-section" value={tds.section} onChange={(e) => { const sct = TDS_SECTIONS.find((x) => x.code === e.target.value); setTds({ on: true, section: sct.code, rate: sct.rate }); }} style={{ width: 'auto' }}>{TDS_SECTIONS.map((x) => <option key={x.code} value={x.code}>{x.label}</option>)}</select>
                <input type="number" aria-label="TDS rate" data-testid="tds-rate" min="0" step="0.1" value={tds.rate} onChange={(e) => setTds((x) => ({ ...x, rate: e.target.value }))} style={{ width: 80 }} /> %
                <span className="muted" data-testid="tds-split">TDS <b>{inr(tdsAmount)}</b> held back on {inr(gst.base)} · vendor receives <b>{inr(netPaid)}</b></span>
              </div>
            )}
          </div>
        )}
        {limit > 0 && f.type === 'Debit' && gst.total > limit && <div className="notice" data-testid="limit-note" style={{ gridColumn: '1 / -1', background: '#fffbeb', borderColor: '#f59e0b' }}>This is above the {inr(limit)} approval limit - it will wait for a second person to approve before it is paid.</div>}
        <div className="field" style={{ gridColumn: '1 / -1' }} data-testid="gst-box">
          <label>GST on this bill</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select aria-label="GST" value={f.gstMode} onChange={(e) => set('gstMode', e.target.value)} style={{ width: 'auto' }}>
              <option value="None">No GST on the bill</option><option value="Included">GST is included in the amount</option><option value="Extra">GST is added on top of the amount</option></select>
            {f.gstMode !== 'None' && <select aria-label="GST rate" value={f.gstRate} onChange={(e) => set('gstRate', Number(e.target.value))} style={{ width: 'auto' }}>{[...new Set([...GST_NOW.filter((x) => x), 12, 28])].map((r) => <option key={r} value={r}>{r}%</option>)}</select>}
          </div>
          {gst.hasGst && <div data-testid="gst-split" className="muted" style={{ marginTop: 4 }}>Taxable value <b>{inr(gst.base)}</b> + GST <b>{inr(gst.gst)}</b> = <b>{inr(gst.total)}</b> paid</div>}
          {gst.msgs.map((m, i) => <div key={i} data-testid="gst-note" className={m.tone === 'bad' ? 'field-error' : 'muted'} style={{ marginTop: 3, color: m.tone === 'warn' ? '#b45309' : m.tone === 'ok' ? '#15803d' : undefined }}>{m.tone === 'ok' ? '✓ ' : m.tone === 'bad' ? '✕ ' : m.tone === 'warn' ? '⚠ ' : 'ℹ '}{m.text}</div>)}
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }} data-testid="pay-files"><label>Attachments (bill, receipt, payment proof)</label><AttachmentPicker pending={files} onChange={setFiles} label="Add files" compact /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Note</label><input aria-label="Note" maxLength={500} value={f.description} onChange={(e) => set('description', e.target.value)} placeholder={picked ? picked.label : 'What is this for?'} /></div>
        {(sameRec.length > 0 || sameTask.length > 0) && (
          <div className="notice" data-testid="prior-payments" style={{ gridColumn: '1 / -1', borderColor: '#f59e0b', background: '#fffbeb' }}>
            <b>⚠ {sameRec.length ? 'This record already has a payment' : 'Other payments exist for this task'}</b>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {[...sameRec, ...sameTask].map((l) => <li key={l.id} data-testid="prior-row">{l.shortId} · {dmy(l.date)} · <b>{inr(l.amount)}</b> · {l.account}{l.mode ? ` · ${l.mode}` : ''}{l.ref ? ` · ${l.ref}` : ''}{l.sourceId !== picked?.value ? ' · other invoice / record of the same task' : ''}</li>)}
            </ul>
            <div className="muted" style={{ marginTop: 3 }}>Paid so far: <b>{inr(priorSum)}</b>{picked && Number(picked.amount) > 0 ? ` of ${inr(picked.amount)}` : ''}{willExceed ? ` — paying ${inr(f.amount)} more would go over the approved amount.` : ''}</div>
            {needAck && <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}><input type="checkbox" data-testid="prior-ack" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I have checked these earlier payments and still want to record this one</label>}
          </div>
        )}
      </div>
      <div className="form-actions"><button className="btn good" disabled={busy || (needAck && !ack)} data-testid="pay-confirm" onClick={pay}>{busy ? 'Recording…' : limit > 0 && f.type === 'Debit' && gst.total > limit ? 'Send for approval' : 'Record payment'}</button><button className="btn secondary" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

/** What a ledger entry actually paid for: the task / invoice, cultural expense, bill or booking behind it, plus a GST read-out. */
function LedgerDetail({ row, onOpenTask, onNavigate }) { // eslint-disable-line no-unused-vars
  const { records: tickets } = useCollection(C.TICKETS, 'Tasks');
  const { records: docs } = useCollection(C.QUOTATIONS, 'Quotations');
  const { records: expenses } = useCollection(C.CULTURAL_EXPENSES, 'Event Expenses');
  const { records: events } = useCollection(C.CULTURAL_EVENTS, 'Cultural Events');
  const { records: fuel } = useCollection(C.DG_FUEL_LOGS, 'DG Fuel Log');
  const { records: bookings } = useCollection(C.AMENITIES, 'Bookings');
  const { records: vendors } = useCollection(C.VENDORS, 'Vendors');
  if (!row) return null;
  const sid = String(row.sourceId || '');
  const ticket = tickets.find((t) => t.ticketNumber === row.taskRef);
  const invoice = docs.find((d) => d.id === sid);
  const exp = sid.startsWith('cultural:') ? expenses.find((x) => x.id === sid.slice(9)) : null;
  const ev = exp ? events.find((e) => e.id === exp.eventId) : null;
  const dg = sid.startsWith('dgfuel:') ? fuel.find((x) => x.id === sid.slice(7)) : null;
  const bk = sid.startsWith('amenity:') ? bookings.find((b) => b.id === sid.split(':')[1]) : null;
  const vendor = vendors.find((v) => v.name === row.vendor);
  const area = areaOf(row);
  const rows = [];
  if (ticket) rows.push(['Task', `${ticket.ticketNumber} · ${ticket.title}`], ['Task status', `${ticket.status}${ticket.category ? ` · ${ticket.category}` : ''}${ticket.unit ? ` · ${ticket.unit}` : ''}`], ['Assigned to', ticket.assignedTo || '—'], ['Approved amount', Number(ticket.approvedAmount) ? inr(ticket.approvedAmount) : '—']);
  if (invoice) rows.push(['Invoice', `${invoice.vendor} · ${inr(invoice.amount)}${Number(invoice.gstAmount) ? ` (GST ${inr(invoice.gstAmount)} @ ${invoice.gstRate}%)` : ''}`], ['Invoice approval', invoiceApproval(invoice).label || '—']);
  if (exp) rows.push(['Expense', `${exp.item} · ${exp.category || ''}`], ['Event', ev ? `${ev.name}${ev.fund ? ` · fund ${ev.fund}` : ''}` : '—'], ['Expense status', exp.status], ['Approved by', exp.approvedBy || '—']);
  if (dg) rows.push(['DG diesel refill', `${dg.date} · ${dg.litres} L @ ${inr(dg.rate)} · ${dg.generator || ''}`]);
  if (bk) rows.push(['Booking', `${bk.shortId || ''} · ${bk.amenity} · ${bk.unit}`], ['Booking status', bk.status || '—']);
  const eb = sid.startsWith('elec:'); // electricity bill
  if (sid.startsWith('dues:')) rows.push(['Utility bills', `${sid.split(':')[1]} · billed ${sid.split(':')[2]} — one line for the month; every villa's bill (with its own bill number) is under Payments → Utilities → Collections`]);
  if (eb) rows.push(['Electricity bill', row.sourceLabel || sid]);
  if (sid.startsWith('culturalCredit:')) rows.push(['Budget credit', `Unused budget of ${row.sourceLabel || 'the event'} credited back to the fund — internal record, no bank movement`]);
  if (!rows.length && row.sourceLabel) rows.push(['Linked to', row.sourceLabel]);
  const g = gstCheck({ amount: row.amount, mode: Number(row.gstRate) > 0 ? 'Included' : 'None', rate: row.gstRate, date: row.date, area, text: `${row.description} ${ticket?.title || ''} ${row.category || ''}`, gstin: vendor?.gstin, vendor: vendor ? vendor.name : undefined, billedGst: Number(row.gstAmount) || undefined });
  return (
    <div className="card" style={{ background: 'var(--surface-2, #f8fafc)', margin: '12px 0' }} data-testid="ledger-detail">
      <b>What this payment is for</b>
      <div style={{ margin: '4px 0 8px' }}><span className="tag">{area}</span> <span className="tag">{row.account}</span> {row.mode && <span className="tag">{row.mode}{row.ref ? ` · ${row.ref}` : ''}</span>} {row.internal ? <span className="tag">Internal record · no bank movement</span> : <span className={`tag ${row.reconStatus === 'Matched' ? 'green' : 'orange'}`}>{row.reconStatus === 'Matched' ? 'On the bank statement' : 'Not on the statement yet'}</span>}</div>
      {rows.length ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px 12px' }} data-testid="linked-record">{rows.map(([k, v]) => <React.Fragment key={k}><span className="muted">{k}</span><span>{v}</span></React.Fragment>)}</div>
      ) : <div className="notice" data-testid="unlinked">Not linked to any task, expense or bill. Link it (Linked task above) so it shows up in the right analysis.</div>}
      {bk && onNavigate && <button type="button" className="btn secondary sm" data-testid="open-booking" style={{ marginTop: 8 }} onClick={() => { try { sessionStorage.setItem('communityos:openBooking', bk.shortId); } catch { /* ignore */ } onNavigate('amenities'); }}>Open booking {bk.shortId} →</button>}
      {row.taskRef && onOpenTask && <button type="button" className="btn secondary sm" style={{ marginTop: 8 }} onClick={() => onOpenTask(row.taskRef)}>Open task {row.taskRef} →</button>}
      <div style={{ marginTop: 10 }} data-testid="ledger-gst">
        <b>GST</b>
        {g.hasGst ? <div>Taxable value <b>{inr(Number(row.baseAmount) || g.base)}</b> + GST <b>{inr(Number(row.gstAmount) || g.gst)}</b> @ {row.gstRate}% = <b>{inr(row.amount)}</b></div> : <div className="muted">No GST recorded on this payment.</div>}
        {g.msgs.map((m, i) => <div key={i} className="muted" style={{ color: m.tone === 'warn' ? '#b45309' : m.tone === 'bad' ? '#c7364a' : m.tone === 'ok' ? '#15803d' : undefined }}>{m.tone === 'ok' ? '✓ ' : m.tone === 'bad' ? '✕ ' : m.tone === 'warn' ? '⚠ ' : 'ℹ '}{m.text}</div>)}
      </div>
    </div>
  );
}

function Pay({ accounts, routing, ledger, onPaid, onOpenTask, onNavigate }) {
  const { records: expenses } = useCollection(C.CULTURAL_EXPENSES, 'Event Expenses');
  const [dlg, setDlg] = useState(null);
  const [aux, setAux] = useState('');
  const [pick, setPick] = useState(() => { try { const t = sessionStorage.getItem('communityos:paySection'); if (t) { setTimeout(() => { try { sessionStorage.removeItem('communityos:paySection'); } catch { /* ignore */ } }, 400); return t; } } catch { /* ignore */ } return ''; });
  const canPay = canWriteCollection(C.LEDGER, getPrincipal());
  const fin = useFinancialQueue();
  const paidIds = new Set(ledger.map((l) => l.sourceId));
  const { records: skips } = useCollection(C.LEDGER_SKIPS, 'Not Recorded Payments');
  const { records: relAll } = useCollection(C.RELEASES, 'Fund releases');
  const takenOf = (x) => relAll.filter((r) => r.expenseId === x.id && r.status !== 'Rejected').reduce((n, r) => n + (Number(r.amount) || 0), 0);
  const culturalN = expenses.filter((x) => x.status === 'Approved' && !paidIds.has(`cultural:${x.id}`) && !skips.some((s) => s.sourceId === `cultural:${x.id}`) && (Number(x.amount) || 0) - takenOf(x) > 0.5).length
    + relAll.filter((r) => r.expenseId && r.status === 'Approved' && expenses.some((x) => x.id === r.expenseId)).length;
  const maintN = fin.filter((r) => r.bucket === 'todo').length;
  const { records: ecs } = useCollection(C.ELECTRICITY_BILLS, 'Electricity Bills');
  const { records: abs } = useCollection(C.ASSOC_BILLS, 'Association Utility Bills');
  const { records: dgf } = useCollection(C.DG_FUEL_LOGS, 'DG Fuel Log');
  const assocN = [...ecs.filter((b) => b.status !== 'Paid').map((b) => `elec:${b.id}`), ...abs.map((b) => `assoc:${b.id}`), ...dgf.map((b) => `dgfuel:${b.id}`)].filter((k) => !paidIds.has(k) && !skips.some((s) => s.sourceId === k)).length;
  const { tabAllowed, role } = useApp();
  const okSec = (k) => tabAllowed(`pay.s.${k}`);
  const firstSec = (culturalN && okSec('cultural') ? 'cultural' : maintN && okSec('maintenance') ? 'maintenance' : ['cultural', 'maintenance', 'assoc', 'collections', 'all'].find(okSec)) || 'all';
  const sec = pick && okSec(pick) ? pick : firstSec;
  return (
    <div>
      <div className="card" style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0, flex: 1 }}>Payments</h3>
          {canPay && <button className="btn secondary" data-testid="recurring-open" onClick={() => setAux('recurring')}>🔁 Recurring bills</button>}
          {canPay && <button className="btn secondary" data-testid="income-open" onClick={() => setAux('income')}>＋ Other income</button>}
          {role?.category === 'EC' && <button className="btn secondary" data-testid="payreq-open" onClick={() => setAux('request')}>＋ Payment request</button>}
          <button className="btn" data-testid="new-payment" onClick={() => setDlg({})}>+ New payment</button>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>Approved items wait below, by area, for you to pay. Each payment stays linked to its record and GST.</p>
      </div>
      <RequestsPanel onChanged={onPaid} />
      <SegTabs label="Payment sections" value={sec} onChange={setPick} tabs={[{ key: 'cultural', label: 'Cultural', count: culturalN }, { key: 'maintenance', label: 'Maintenance', count: maintN }, { key: 'assoc', label: 'Utilities (Association)', count: assocN }, { key: 'collections', label: 'Collections' }, { key: 'all', label: 'All payments' }].filter((t) => okSec(t.key))} />
      <div style={{ marginTop: 12 }}>
        {sec === 'cultural' && <CulturalPayments canPay={canPay} onPay={setDlg} />}
        {sec === 'maintenance' && <FinancialTasks onOpenTask={onOpenTask} onPay={setDlg} />}
        {sec === 'assoc' && <UtilityPayments canPay={canPay} onPay={setDlg} onNavigate={onNavigate} />}
        {sec === 'collections' && <Collections onNavigate={onNavigate} />}
        {sec === 'all' && (
          <SectionPage
            sectionId={C.LEDGER}
            title="All payments"
            description="Every payment and receipt. Open one to see the task, expense or bill it paid, its GST and whether it is on the bank statement."
            recordName="payment entry"
            statCards={(rows) => {
              const sum = (f) => rows.reduce((t, r) => t + (Number(f(r)) || 0), 0);
              return [
                { label: 'Entries', value: rows.length },
                { label: 'Paid out', value: inr(sum((r) => (r.type === 'Debit' ? r.amount : 0))) },
                { label: 'GST paid', value: inr(sum((r) => (r.type === 'Debit' ? r.gstAmount : 0))), sub: 'On bills that carry GST' },
                { label: 'Not on statement', value: rows.filter((r) => r.reconStatus === 'Unreconciled' && !r.internal).length, sub: 'match them under Bank matching' },
              ];
            }}
            formHelp="Record money in or out of a fund. Pick the vendor and the linked task so the books can be tallied against the work."
            formExtra={(l) => (l ? <LedgerDetail top row={l} onOpenTask={onOpenTask} onNavigate={onNavigate} /> : null)}
            search
            filters={[{ key: 'module', label: 'All areas' }, { key: 'account', label: 'All accounts' }, { key: 'type', label: 'All types' }, { key: 'reconStatus', label: 'Any statement status' }, { key: 'vendor', label: 'All vendors' }]}
            dateFields={[{ key: 'date', label: 'Entry date' }]}
            baseSort={{ key: 'date', dir: 'desc' }}
          />
        )}
      </div>
      {aux === 'recurring' && <RecurringDialog onClose={() => setAux('')} />}
      {aux === 'income' && <IncomeDialog accounts={accounts} onClose={() => setAux('')} onDone={() => { setAux(''); onPaid(); }} />}
      {aux === 'request' && <PaymentRequest onClose={() => setAux('')} onDone={() => { setAux(''); setPick('maintenance'); onPaid(); }} />}
      {dlg && <PayDialog initial={dlg} accounts={accounts} routing={routing} onClose={() => setDlg(null)} onDone={() => { setDlg(null); onPaid(); }} />}
    </div>
  );
}

function Reconcile({ accounts, ledger, txns, onChanged }) {
  const [account, setAccount] = useState('');
  const [month, setMonth] = useState('');
  const [sugg, setSugg] = useState(null);
  const [dlg, setDlg] = useState(null);
  const [msg, setMsg] = useState('');
  const canWrite = canWriteCollection(C.LEDGER, getPrincipal());
  const acc = account || accounts[0]?.name || '';
  const inMonth = (d) => !month || String(d).startsWith(month);
  const L = useMemo(() => ledger.filter((l) => !l.internal && l.account === acc && inMonth(l.date)), [ledger, acc, month]); // eslint-disable-line react-hooks/exhaustive-deps
  const X = useMemo(() => txns.filter((t) => t.account === acc && inMonth(t.date)), [txns, acc, month]); // eslint-disable-line react-hooks/exhaustive-deps
  const lOpen = L.filter((l) => l.reconStatus !== 'Matched'); const xOpen = X.filter((t) => !t.matchedLedgerId);
  const sumL = (t) => L.filter((l) => l.type === t).reduce((n, l) => n + Number(l.amount || 0), 0);
  const sumX = (k) => X.reduce((n, t) => n + (Number(t[k]) || 0), 0);
  const gapOut = sumX('debit') - sumL('Debit'); const gapIn = sumX('credit') - sumL('Credit');
  const months = [...new Set([...ledger.map((l) => String(l.date).slice(0, 7)), ...txns.map((t) => String(t.date).slice(0, 7))])].sort().reverse();
  const run = () => { const m = suggestMatches(lOpen, xOpen); setSugg(m); setMsg(m.length ? '' : 'No new matches found - same account, direction and amount within 5 days are needed.'); };
  async function confirm(list) { let n = 0; for (const m of list) if (await applyMatch(m.ledger, m.txn)) n += 1; setSugg(null); setMsg(`${n} matched.`); onChanged(); }
  async function unmatch(l) { await undoMatch(l, txns.find((t) => t.id === l.bankTxnId)); onChanged(); }
  const matched = L.filter((l) => l.reconStatus === 'Matched');
  const [payout, setPayout] = useState(null);   // a money-in line being matched to the provider's payout (back end)
  return (
    <div data-testid="reconcile">
      <div className="card" style={{ marginTop: 12 }}>
        <div className="stmt-bar" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select aria-label="Bank account" data-testid="recon-account" value={acc} onChange={(e) => { setAccount(e.target.value); setSugg(null); }}>{accounts.map((a) => <option key={a.id}>{a.name}</option>)}</select>
          <select aria-label="Month" value={month} onChange={(e) => setMonth(e.target.value)}><option value="">All months</option>{months.map((m) => <option key={m}>{m}</option>)}</select>
          <span style={{ flex: 1 }} />
          {canWrite && <button className="btn" data-testid="auto-match" onClick={run}>Auto-match</button>}
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>Import the bank statement under Accounts &amp; budget → Bank statements, then match it against what was recorded here.</p>
      </div>
      <MoneyTiles items={[
        { label: 'Paid out · app vs bank', value: `${inr(sumL('Debit'))} / ${inr(sumX('debit'))}`, sub: Math.abs(gapOut) < 1 ? 'Tallies' : `Difference ${inr(Math.abs(gapOut))}`, tone: Math.abs(gapOut) < 1 ? 'green' : 'orange' },
        { label: 'Received · app vs bank', value: `${inr(sumL('Credit'))} / ${inr(sumX('credit'))}`, sub: Math.abs(gapIn) < 1 ? 'Tallies' : `Difference ${inr(Math.abs(gapIn))}`, tone: Math.abs(gapIn) < 1 ? 'green' : 'orange' },
        { label: 'In the app only', value: lOpen.length, sub: 'not yet on the statement', tone: lOpen.length ? 'orange' : '' },
        { label: 'On the statement only', value: xOpen.length, sub: 'not recorded in the app', tone: xOpen.length ? 'orange' : '' },
      ]} />
      {msg && <div className="notice" data-testid="recon-msg">{msg}</div>}
      {sugg && sugg.length > 0 && (
        <div className="card" style={{ marginTop: 12 }} data-testid="suggestions">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><h3 style={{ margin: 0, flex: 1 }}>Suggested matches <span className="tag">{sugg.length}</span></h3><button className="btn good" data-testid="confirm-all" onClick={() => confirm(sugg)}>Confirm all</button></div>
          <ul className="list bk-list">{sugg.map((m) => (
            <li key={m.ledger.id}><span><b>{m.ledger.description}</b> <small className="muted">· {dmy(m.ledger.date)}{m.ledger.ref ? ` · ${m.ledger.ref}` : ''}</small><br /><small className="muted">↔ {dmy(m.txn.date)} · {m.txn.narration}</small><br /><small className="tag purple">{m.how}</small></span>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><b>{inr(m.ledger.amount)}</b><button className="btn sm" onClick={() => confirm([m])}>Match</button></span></li>
          ))}</ul>
        </div>
      )}
      <div className="card" style={{ marginTop: 12 }}>
        <h3 style={{ marginTop: 0 }}>In the app, not on the statement <span className="tag">{lOpen.length}</span></h3>
        {lOpen.length === 0 ? <div className="empty">Everything recorded here appears on the statement.</div> : (
          <ul className="list bk-list">{lOpen.map((l) => <li key={l.id} data-testid="open-ledger"><span><b>{l.description}</b><br /><small className="muted">{dmy(l.date)} · {areaOf(l)} · {l.mode || ''} {l.ref || ''}</small></span><b>{l.type === 'Debit' ? '−' : '+'}{inr(l.amount)}</b></li>)}</ul>
        )}
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <h3 style={{ marginTop: 0 }}>On the statement, not recorded in the app <span className="tag">{xOpen.length}</span></h3>
        {xOpen.length === 0 ? <div className="empty">Every statement line has an entry here.</div> : (
          <ul className="list bk-list">{[...xOpen].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 60).map((t) => (
            <li key={t.id} data-testid="open-txn"><span><b>{t.narration}</b><br /><small className="muted">{dmy(t.date)}{t.head ? ` · ${t.head}` : ''}</small></span>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><b>{Number(t.debit) > 0 ? '−' + inr(t.debit) : '+' + inr(t.credit)}</b>
                {canWrite && Number(t.debit) > 0 && <button className="btn sm secondary" onClick={() => setDlg({ title: 'Record this bank payment', amount: t.debit, account: t.account, date: t.date, description: t.narration, vendor: t.party || '' })}>Record</button>}
                {canWrite && Number(t.credit) > 0 && payoutsOnServer() && <button className="btn sm secondary" data-testid="payout-open" onClick={() => setPayout(t)}>Payout…</button>}</span></li>
          ))}</ul>
        )}
      </div>
      {payout && <PayoutDialog line={payout} onClose={() => setPayout(null)} onDone={onChanged} />}
      <div className="card" style={{ marginTop: 12 }}>
        <h3 style={{ marginTop: 0 }}>Matched <span className="tag green">{matched.length}</span></h3>
        {matched.length === 0 ? <div className="empty">Nothing matched yet.</div> : (
          <ul className="list bk-list">{matched.map((l) => <li key={l.id}><span><b>{l.description}</b><br /><small className="muted">{dmy(l.date)} ↔ {dmy(txns.find((t) => t.id === l.bankTxnId)?.date)} · {l.ref || ''}</small></span><span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><b>{inr(l.amount)}</b>{canWrite && <button className="btn sm secondary" onClick={() => unmatch(l)}>Unmatch</button>}</span></li>)}</ul>
        )}
      </div>
      {dlg && <PayDialog initial={dlg} accounts={accounts} routing={{}} onClose={() => setDlg(null)} onDone={() => { setDlg(null); onChanged(); }} />}
    </div>
  );
}

function Analysis({ ledger, accounts }) {
  const [month, setMonth] = useState('');
  const rows = ledger.filter((l) => !l.internal && (!month || String(l.date).startsWith(month)));
  const months = [...new Set(ledger.map((l) => String(l.date).slice(0, 7)))].sort().reverse();
  const by = {}; rows.forEach((l) => { const a = areaOf(l); const k = by[a] || (by[a] = { area: a, out: 0, in: 0, n: 0, accounts: {} }); k.n += 1; if (l.type === 'Debit') { k.out += Number(l.amount) || 0; k.accounts[l.account] = (k.accounts[l.account] || 0) + (Number(l.amount) || 0); } else k.in += Number(l.amount) || 0; });
  const list = Object.values(by).sort((a, b) => b.out - a.out); const max = Math.max(1, ...list.map((x) => x.out));
  const unlinked = rows.filter((l) => l.type === 'Debit' && !l.sourceId && !l.taskRef).length;
  return (
    <div data-testid="pay-analysis">
      <div className="card" style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><h3 style={{ margin: 0, flex: 1 }}>Spending by area</h3>
          <select aria-label="Month" value={month} onChange={(e) => setMonth(e.target.value)}><option value="">All months</option>{months.map((m) => <option key={m}>{m}</option>)}</select></div>
        {list.length === 0 ? <div className="empty">No payments yet.</div> : (
          <table className="resp-table" style={{ marginTop: 8 }}><thead><tr><th>Area</th><th>Paid out</th><th>Received</th><th>Entries</th><th>Through accounts</th></tr></thead>
            <tbody>{list.map((x) => (
              <tr key={x.area} data-testid={`area-${x.area}`}><td data-label="Area"><b>{x.area}</b></td>
                <td data-label="Paid out"><div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><b>{inr(x.out)}</b><span style={{ display: 'inline-block', height: 8, width: `${Math.max(4, (x.out / max) * 90)}px`, background: 'var(--blue, #2563eb)', borderRadius: 4 }} /></div></td>
                <td data-label="Received">{inr(x.in)}</td><td data-label="Entries">{x.n}</td>
                <td data-label="Accounts"><small className="muted">{Object.entries(x.accounts).map(([a, v]) => `${a} ${inr(v)}`).join(' · ') || '—'}</small></td></tr>
            ))}</tbody></table>
        )}
        <p className="muted" style={{ marginBottom: 0 }}>{unlinked ? `${unlinked} payment(s) are not linked to a task, expense or bill - link them for better analysis.` : 'Every payment is linked to the record it pays.'}</p>
      </div>
    </div>
  );
}

function Routing({ accounts, routing, rows, onChanged }) {
  const { save } = useCollection(C.PAYMENT_ROUTING, 'Payment Routing');
  const canWrite = canWriteCollection(C.PAYMENT_ROUTING, getPrincipal());
  return (
    <div className="card" style={{ marginTop: 12 }} data-testid="routing">
      <h3 style={{ marginTop: 0 }}>Which bank account does each kind of payment use?</h3>
      <p className="muted" style={{ marginTop: -6 }}>Used as the default whenever a payment is recorded. A cultural event whose fund has an account of the same name (for example Ganesh) uses that one instead.</p>
      <table className="resp-table"><thead><tr><th>Payments for</th><th>Bank account</th></tr></thead><tbody>
        {AREAS.filter((a) => a !== 'Other').map((a) => (
          <tr key={a}><td data-label="Payments for"><b>{a}</b></td><td data-label="Bank account">
            <select aria-label={`Account for ${a}`} disabled={!canWrite} value={routing[a] || ''} onChange={async (e) => { const row = rows.find((r) => r.module === a); await save({ ...(row || {}), module: a, account: e.target.value }); onChanged(); }}>
              <option value="">Not set</option>{accounts.map((x) => <option key={x.id}>{x.name}</option>)}</select></td></tr>
        ))}</tbody></table>
    </div>
  );
}

export default function PaymentsHub({ onOpenTask, onNavigate }) {
  const { records: accounts } = useCollection(C.BANK_ACCOUNTS, 'Bank Accounts');
  const { records: ledger, refresh: refL } = useCollection(C.LEDGER, 'Payments Cross-check');
  const { records: txns, refresh: refT } = useCollection(C.BANK_TXNS, 'Bank Statement');
  const { records: rows, refresh: refR } = useCollection(C.PAYMENT_ROUTING, 'Payment Routing');
  const { tabAllowed } = useApp();
  const PTABS = [{ key: 'pay', label: 'Payments' }, { key: 'recon', label: 'Reconciliation' }, { key: 'reconcile', label: 'Bank matching' }, { key: 'analysis', label: 'Analysis' }, { key: 'routing', label: 'Account routing' }].filter((t) => tabAllowed(`pay.${t.key}`));
  const [tabRaw, setTab] = useState('pay');
  const tab = PTABS.some((t) => t.key === tabRaw) ? tabRaw : PTABS[0]?.key;
  const [routing, setRouting] = useState({});
  const load = useCallback(() => routingMap().then(setRouting), []);
  useEffect(() => { load(); }, [load, rows]);
  const refreshAll = () => { refL?.(); refT?.(); refR?.(); load(); };
  return (
    <div data-testid="payments-hub">
      <SegTabs label="Payments" variant="pill" value={tab} onChange={setTab} tabs={PTABS} />
      {tab === 'pay' && <Pay accounts={accounts} routing={routing} ledger={ledger} onPaid={refreshAll} onOpenTask={onOpenTask} onNavigate={onNavigate} />}
      {tab === 'recon' && <Reconciliation ledger={ledger} onOpenTask={onOpenTask} />}
      {tab === 'reconcile' && <Reconcile accounts={accounts} ledger={ledger} txns={txns} onChanged={refreshAll} />}
      {tab === 'analysis' && <Analysis ledger={ledger} accounts={accounts} />}
      {tab === 'routing' && <Routing accounts={accounts} routing={routing} rows={rows} onChanged={refreshAll} />}
    </div>
  );
}
