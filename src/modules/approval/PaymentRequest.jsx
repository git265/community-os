// Payments → Payment request: an EC member asks the Treasurer to pay for something that has no task yet. It is filed the usual way, so the
// books and the reports see it like any other spend: a financial task (assigned to the EC member, the bill attached) and a release on it
// with how the payee is to be paid (UPI id / QR, account details). The EC member's request is the EC's approval; the final approvers decide,
// then the Treasurer pays it from Payments → Maintenance.
import React, { useMemo, useState } from 'react';
import Modal from '../../components/Modal.jsx';
import Combobox from '../../components/Combobox.jsx';
import { AttachmentPicker } from '../../components/Attachments.jsx';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { persistPending, isImageMeta } from '../../lib/files/attachments.js';
import { useApprovalKit } from '../../lib/approval/usePlans.js';
import { buildPlan } from '../../lib/approval/engine.js';
import { parseJson } from '../../lib/approval/kit.js';
import { TICKET_CATEGORIES } from '../../lib/schema/registry.js';
import { uuid } from '../../lib/uuid.js';
import { tell } from '../../lib/net/activity.js';
import { PayeeFields, ecAskPlan } from './Payee.jsx';

const todayPlus = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

/** The task type a payment request is filed under: the EC's own maintenance type, else the first one the EC raises that can carry money. */
export function requestTaskType(types) {
  const ec = types.filter((t) => t.active !== false && (t.creatorScope === 'EC / Staff' || t.creatorScope === 'Anyone') && t.quotationStage !== 'No');
  return ec.find((t) => /^EC Maintenance$/i.test(t.name)) || ec.find((t) => t.assignmentMode === 'Direct assign') || ec[0] || null;
}

export default function PaymentRequest({ onClose, onDone }) {
  const { currentUser } = useApp();
  const kit = useApprovalKit();
  const { records: taskTypes } = useCollection(C.TASK_TYPES, 'Task Types');
  const { records: coverage } = useCollection(C.CATEGORY_MAP, 'Category Coverage');
  const { records: vendors } = useCollection(C.VENDORS, 'Vendors');
  const { save: saveTicket } = useCollection(C.TICKETS, 'Maintenance', { enabled: false });
  const { save: saveRelease } = useCollection(C.RELEASES, 'Fund releases', { enabled: false });
  const categories = useMemo(() => [...new Set([...TICKET_CATEGORIES, ...coverage.map((c) => c.category).filter(Boolean)])], [coverage]);
  const [f, setF] = useState({ title: '', category: 'General', amount: '', vendor: '', note: '', payMode: 'UPI', payTo: '' });
  const [qr, setQr] = useState([]);
  const [bill, setBill] = useState([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const payees = useMemo(() => vendors.filter((v) => v.name).map((v) => ({ value: v.name, label: v.name, hint: v.service || 'Vendor' })), [vendors]);
  const tt = requestTaskType(taskTypes);

  async function send() {
    setErr('');
    const title = String(f.title || '').trim(); const amount = Number(f.amount) || 0; const vendor = String(f.vendor || '').trim();
    if (title.length < 3) return setErr('Say what the money is for (at least 3 characters)');
    if (!(amount > 0)) return setErr('Enter the amount');
    if (!vendor) return setErr('Who is the money for?');
    if ((f.payMode === 'UPI' || f.payMode === 'Bank transfer') && !String(f.payTo || '').trim() && !qr.length) return setErr(f.payMode === 'UPI' ? 'Give the UPI id, or attach the QR code' : 'Give the account details');
    if (!tt) return setErr('No task type can carry a payment request - add one under Maintenance → Task Types (raised by EC / Staff, with money).');
    setBusy(true);
    try {
      const tid = uuid();
      const billMetas = bill.length ? await persistPending(bill, { ownerType: 'ticket', ownerId: tid }) : [];
      if (!billMetas) return;
      const task = await saveTicket({
        id: tid, taskType: tt.name, title, description: f.note ? `<p>${String(f.note).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p>` : '', category: f.category, subCategory: '',
        priority: 'Medium', status: 'Assigned', assignedTo: currentUser?.name || kit.me.name, scope: 'Community', unit: '', location: 'Payment request', slaDueAt: todayPlus(7),
        financial: true, attachments: billMetas, hasPhotos: billMetas.some(isImageMeta), paymentStatus: 'Not Paid', awaitingParts: false, materialsCost: 0, residentRating: 0,
        createdBy: currentUser?.name || kit.me.name, createdByRole: kit.me.roleId, createdAt: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
      });
      if (!task) return;
      // a new task is raised first and marked as involving money after (the server takes the flag as an edit)
      const fin = task.financial ? task : (await saveTicket({ ...task, financial: true })) || task;
      const rid = uuid();
      const payQr = qr.length ? await persistPending(qr, { ownerType: 'release', ownerId: rid }) : [];
      if (!payQr) return;
      const plan = buildPlan(kit.policies, { subject: 'Maintenance release', amount, category: f.category, taskType: tt.name, flags: [] });
      const rel = await saveRelease({ id: rid, ticketId: fin.id, ticketShortId: fin.ticketNumber, kind: 'Release', amount, vendor, note: f.note || '', status: 'Waiting approval', requestedBy: kit.me.name,
        settled: false, plan: JSON.stringify(plan), payMode: f.payMode || '', payTo: String(f.payTo || '').trim(), payQr });
      if (!rel) { tell(`The task ${task.ticketNumber} is filed, but the release could not be asked for - open the task and ask again.`, 'error'); return; }
      const ec = ecAskPlan(parseJson(rel.plan, null) || plan, kit.me);
      let status = rel.status;
      if (ec) {
        status = ec.steps.every((s) => s.skipped || (s.decisions || []).filter((d) => d.value === 'Approved').length >= (Number(s.needed) || 1)) ? 'Approved' : 'Waiting approval';
        await saveRelease({ ...rel, plan: JSON.stringify(ec), status });
      }
      tell(`${task.ticketNumber}: ${amount.toLocaleString('en-IN')} to ${vendor} ${status === 'Approved' ? 'is approved - the Treasurer pays it from Payments' : 'waits for the final approval, then the Treasurer pays it'}.`, 'success');
      onDone?.(fin);
    } catch (e) { setErr(e?.message || String(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title="Payment request" subtitle="Ask the Treasurer to pay for something. It is filed as a task with its release, so it shows in the books and reports like any other spend. Your request counts as the EC's approval." onClose={onClose} wide>
      {err && <div className="notice error" data-testid="payreq-error">{err}</div>}
      <div className="form-grid" data-testid="payreq-form">
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>What is it for? *</label><input aria-label="What is it for" data-testid="payreq-title" maxLength={200} value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Diwali lights for the main gate" /></div>
        <div className="field"><label>Category</label><select aria-label="Category" value={f.category} onChange={(e) => set('category', e.target.value)}>{categories.map((c) => <option key={c}>{c}</option>)}</select></div>
        <div className="field"><label>Amount (₹) *</label><input aria-label="Amount" data-testid="payreq-amount" type="number" min="0" value={f.amount} onChange={(e) => set('amount', e.target.value)} /></div>
        <div className="field" data-testid="payreq-vendor"><label>Pay to *</label><Combobox value={f.vendor} onChange={(v) => set('vendor', v)} options={payees} allowCustom placeholder="A vendor, or type a name…" /></div>
        <PayeeFields value={f} onChange={setF} pending={qr} onPending={setQr} />
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Note</label><textarea aria-label="Note" rows={2} value={f.note} onChange={(e) => set('note', e.target.value)} placeholder="Anything the Treasurer should know" /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Bill or quote (optional)</label><AttachmentPicker pending={bill} onChange={setBill} label="Attach the bill" /></div>
      </div>
      <div className="form-actions"><button type="button" className="btn" data-testid="payreq-send" disabled={busy} onClick={send}>{busy ? 'Sending…' : 'Send to the Treasurer'}</button><button type="button" className="btn secondary" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}
