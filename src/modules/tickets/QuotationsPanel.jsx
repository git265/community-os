import React, { useEffect, useMemo, useState } from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import Combobox from '../../components/Combobox.jsx';
import { AttachmentList, AttachmentPicker } from '../../components/Attachments.jsx';
import { persistPending } from '../../lib/files/attachments.js';
import { tell } from '../../lib/net/activity.js';
import { gstCheck } from '../../lib/paymentEngine.js';
import { todayIso, gstSplit, GST_RATES, invoiceApproval, approvalState } from './ticketEngine.js';
import Modal from '../../components/Modal.jsx';
import AdminDelete from '../../components/AdminDelete.jsx';
import ActionMenu from '../../components/ActionMenu.jsx';
import { uuid } from '../../lib/uuid.js';
import PlanPanel from '../approval/PlanPanel.jsx';
import { parseJson } from '../../lib/approval/kit.js';
import { money } from '../../lib/locale.js';

const inr = (n) => money(n, { round: false });

/**
 * EC + Final approval block, shared by quotations and invoices (same look and actions).
 * The EC decides with one multi-action button: approve and send to the final approver, approve as the last step, or reject.
 * `finalRequired === false` means the EC made its own approval the last step.
 */
function ApprovalBlock({ title, st, open, ec, fin, hint, canEC, canFinal, finalRequired, onDecide, entry, note }) {
  const lastStep = ec.value === 'Approved' && finalRequired === false;
  const tag = (d) => (d.value === 'Approved' ? <span className="tag green"><span className="tick">✓</span> Approved</span> : <span className={`tag ${d.value === 'Rejected' ? 'red' : 'orange'}`}>{d.value}</span>);
  const ecActions = [
    { key: 'send', label: 'Approve & send to final approver', hint: hint ? `Goes to ${hint} to approve` : 'Goes to the Treasurer / President', onClick: () => onDecide('ec', 'Approved', { send: true }) },
    { key: 'final', label: 'Approve — this is the last step', hint: 'No Treasurer approval needed; it goes straight to Payments', onClick: () => onDecide('ec', 'Approved', { send: false }) },
    { key: 'reject', label: 'Reject', tone: 'bad', onClick: () => onDecide('ec', 'Rejected') },
  ];
  return (
    <div className={`approval-panel compact inv ${st.key}`}>
      <div className="ap-head"><b>{title}</b>{st.label && <span className={`tag ${st.tone}`}>{st.label}</span>}</div>
      <div className={`ap-step ${ec.value === 'Approved' ? 'ok' : ec.value === 'Rejected' ? 'no' : ''}`}>
        <span className="ap-title">EC</span>
        {tag(ec)}
        {ec.value !== 'Pending' && <small className="muted">{ec.by || '—'}{ec.at ? ` · ${ec.at}` : ''}</small>}
        {open && canEC && (
          <span className="ap-actions">
            {ec.value === 'Pending' && <ActionMenu label="EC decision" actions={ecActions} testid="ec-decide" />}
            {ec.value !== 'Pending' && fin.value === 'Pending' && <button type="button" className="link-btn" data-testid="ec-undo" onClick={() => onDecide('ec', 'Pending')}>Undo</button>}
          </span>
        )}
      </div>
      <div className={`ap-step ${fin.value === 'Approved' || lastStep ? 'ok' : fin.value === 'Rejected' ? 'no' : ''}`}>
        <span className="ap-title">Final{hint && <small className="muted ap-hint"> {hint}</small>}</span>
        {lastStep ? <span className="tag green">Not needed</span> : tag(fin)}
        {lastStep && <small className="muted">EC made its approval the last step</small>}
        {!lastStep && fin.value !== 'Pending' && <small className="muted">{fin.by || '—'}{fin.at ? ` · ${fin.at}` : ''}</small>}
        {!lastStep && open && canFinal && ec.value === 'Approved' && (
          <span className="ap-actions">
            {fin.value !== 'Approved' && <button type="button" className="btn good sm" data-testid="final-approve" onClick={() => onDecide('final', 'Approved')}>Approve</button>}
            {fin.value !== 'Rejected' && <button type="button" className="btn secondary sm" data-testid="final-reject" onClick={() => onDecide('final', 'Rejected')}>Reject</button>}
            {fin.value !== 'Pending' && <button type="button" className="link-btn" onClick={() => onDecide('final', 'Pending')}>Undo</button>}
          </span>
        )}
        {!lastStep && open && canFinal && ec.value !== 'Approved' && fin.value === 'Pending' && <small className="muted">after EC</small>}
      </div>
      {note && <small className="muted">{note}</small>}
      {st.key === 'approved' && (
        <div className={`ap-step${entry ? ' ok' : ''}`}>
          <span className="ap-title">Payments</span>
          {entry ? <span className="tag blue">Paid · {entry.shortId}</span> : <small className="muted">Approved — now in Payments for the Treasurer to review and pay.</small>}
        </div>
      )}
    </div>
  );
}

/**
 * Quotations and invoices for one task (both live in the Quotations collection, told apart by `kind`).
 *
 *  - Quotation: competing quotes; one is chosen (`selectedId` / `onSelect`) and goes to the EC, then the Treasurer.
 *  - Invoice: uploaded directly (no quotation needed). The amount and GST are captured so the Payments Cross-check can
 *    show the GST input credit. Adding one restarts the approval chain via `onAdded`.
 */
export default function QuotationsPanel({ kind = 'Quotation', ticket, selectedIds = [], onSelect, onAdded, canEdit, vendors, defaultVendor, invoiceTools, quoteTools, invoicesExist, quotesExist }) {
  const isInvoice = kind === 'Invoice';
  const { records, save } = useCollection(COLLECTIONS.QUOTATIONS, isInvoice ? 'Invoices' : 'Quotations');
  const docs = useMemo(
    () => records.filter((q) => q.ticketId === ticket.id && (q.kind || 'Quotation') === kind).sort((a, b) => (isInvoice ? String(b.quoteDate).localeCompare(String(a.quoteDate)) : Number(a.amount) - Number(b.amount))),
    [records, ticket.id, kind, isInvoice],
  );
  const blank = () => ({ vendor: defaultVendor || '', amount: '', quoteDate: todayIso(), note: '', gstMode: 'None', gstRate: 18 });
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(blank());
  const [pending, setPending] = useState([]);
  const [fe, setFe] = useState({});
  const [busy, setBusy] = useState(false);
  const [fixing, setFixing] = useState(null); // { doc, amount, reason, err }
  useEffect(() => { setAdding(false); }, [ticket.id]);

  const isChosen = (id) => selectedIds.includes(id);
  const primaryId = selectedIds[0];
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const vendorOptions = vendors.map((v) => ({ value: v.name, label: v.name, hint: v.service }));
  const lowest = !isInvoice && docs.length ? Number(docs[0].amount) : null;
  const split = gstSplit(form.amount, form.gstMode, form.gstRate);

  /** EC / final decision on ONE invoice. Stamps who and when; afterwards the parent may close the task. */
  async function decide(doc, step, value, opts = {}) {
    const t = invoiceTools;
    const who = value === 'Pending' ? '' : t.actor;
    const at = value === 'Pending' ? '' : todayIso();
    const patch = step === 'ec' ? { ecApproval: value, ecApprovedBy: who, ecApprovedAt: at, finalRequired: value === 'Approved' ? opts.send !== false : null } : { finalApproval: value, finalApprovedBy: who, finalApprovedAt: at };
    const saved = await save({ ...doc, ...patch });
    if (saved && t.onDecided) await t.onDecided(docs.map((d) => (d.id === doc.id ? saved : d)));
  }

  /** Invoice vs what was approved: beyond the tolerance it needs the extra "above the approved amount" step. */
  const invoiceCtx = (doc) => {
    const approved = Number(ticket.approvedAmount) || 0;
    const over = approved > 0 && invoiceTools?.kit?.overBudget(doc.amount, approved);
    return { subject: 'Maintenance invoice', amount: Number(doc.amount) || 0, category: ticket.category, taskType: ticket.taskType, flags: over ? ['overBudget'] : [] };
  };
  async function savePlan(doc, plan) {
    const t = invoiceTools;
    const saved = await save({ ...doc, ...t.kit.planFields(plan, 'doc'), overBudget: invoiceCtx(doc).flags.includes('overBudget') });
    if (saved && t.onDecided) await t.onDecided(docs.map((d) => (d.id === doc.id ? saved : d)));
  }

  const invoiceBlock = (doc) => {
    const t = invoiceTools;
    const st = invoiceApproval(doc);
    if (t.kit && !doc.approvalWaived) {
      const ctx = invoiceCtx(doc);
      const plan = t.kit.planOf(doc, ctx, 'doc');
      return (
        <PlanPanel title="Invoice approval" plan={plan} kit={t.kit} rec={doc} open={t.open} tagLabel={st.label} tagTone={st.tone}
          note={ctx.flags.includes('overBudget') ? `Above the approved ${inr(ticket.approvedAmount)} by more than ${t.kit.settings.tolerancePct}% — extra approval applies.` : undefined}
          onSave={(pl) => savePlan(doc, pl)} entry={t.ledgerFor(doc) || null} />
      );
    }
    return (
      <ApprovalBlock
        title="Invoice approval" st={st} open={t.open}
        ec={doc.approvalWaived ? { value: 'Approved', by: 'Within approved quotation', at: '' } : { value: doc.ecApproval || 'Pending', by: doc.ecApprovedBy, at: doc.ecApprovedAt }}
        fin={doc.approvalWaived ? { value: 'Approved', by: 'Not needed', at: '' } : { value: doc.finalApproval || 'Pending', by: doc.finalApprovedBy, at: doc.finalApprovedAt }}
        note={doc.approvalWaived ? 'This invoice is within the approved quotation, so it needs no further approval (Maintenance → Final approvers → Approval rules).' : undefined}
        canEC={t.canDecideEC} canFinal={t.canDecideFinal} finalRequired={doc.approvalWaived ? undefined : doc.finalRequired}
        onDecide={(step, v, o) => decide(doc, step, v, o)}
        entry={t.ledgerFor(doc)}
      />
    );
  };

  /** Correction: an approved invoice that turns out to be wrong goes back to Pending with a reason (and optionally a new amount). Not possible once a payment is recorded against it. */
  async function sendBack() {
    const { doc, amount, reason } = fixing;
    if (!String(reason || '').trim()) return setFixing({ ...fixing, err: 'Say what is being corrected' });
    const total = Number(amount) || Number(doc.amount);
    if (!(total > 0)) return setFixing({ ...fixing, err: 'Enter the corrected invoice amount' });
    const sp = Number(doc.gstRate) > 0 ? gstSplit(total, 'Included', doc.gstRate) : { base: total, gst: 0, total };
    const out = await save({ ...doc, amount: total, ...(Number(doc.gstRate) > 0 ? { baseAmount: sp.base, gstAmount: sp.gst } : { baseAmount: total, gstAmount: 0 }),
      ecApproval: 'Pending', ecApprovedBy: '', ecApprovedAt: '', finalRequired: null, finalApproval: 'Pending', finalApprovedBy: '', finalApprovedAt: '', plan: '',
      correctionNote: `${String(reason).trim()}${total !== Number(doc.amount) ? ` (amount ${inr(doc.amount)} → ${inr(total)})` : ''} — ${invoiceTools?.actor || ''} ${todayIso()}` });
    if (out) { setFixing(null); if (invoiceTools?.onDecided) await invoiceTools.onDecided(docs.map((d) => (d.id === doc.id ? out : d))); }
  }

  /** With quotations on the task, an invoice must be selected before it goes for approval. */
  async function toggleInvoice(doc) {
    const off = doc.selected !== false; // unselecting restarts this invoice's approval
    await save({ ...doc, selected: !off, ...(off ? { ecApproval: 'Pending', ecApprovedBy: '', ecApprovedAt: '', finalRequired: null, finalApproval: 'Pending', finalApprovedBy: '', finalApprovedAt: '' } : {}) });
  }

  async function add(e) {
    e.preventDefault();
    const er = {};
    if (!form.vendor.trim()) er.vendor = 'Vendor is required';
    if (!(Number(form.amount) > 0)) er.amount = isInvoice ? 'Enter the invoice amount' : 'Enter the quoted amount';
    if (isInvoice && pending.length === 0) er.file = 'Attach the invoice (PDF or photo)';
    setFe(er);
    if (Object.keys(er).length) return;
    setBusy(true);
    try {
      const id = uuid();
      const metas = pending.length ? await persistPending(pending, { ownerType: 'quotation', ownerId: id }) : [];
      if (metas) {
        const rec = { id, kind, ticketId: ticket.id, vendor: form.vendor.trim(), amount: isInvoice ? split.total : Number(form.amount), quoteDate: form.quoteDate, note: form.note, attachments: metas };
        const quoteOk = approvalState(ticket, null).key === 'approved';
        const waived = isInvoice && (ticket.invoiceApprovalMode === 'Waived' || !!invoiceTools?.kit?.settings.skipWithinQuote) && quoteOk && Number(ticket.approvedAmount) > 0 && split.total <= Number(ticket.approvedAmount) * (1 + (Number(invoiceTools?.kit?.settings.tolerancePct) || 0) / 100) + 0.5;
        if (isInvoice) Object.assign(rec, { approvalWaived: waived, selected: waived || !quotesExist, ecApproval: 'Pending', finalApproval: 'Pending', gstMode: form.gstMode, gstRate: form.gstMode === 'None' ? 0 : Number(form.gstRate), baseAmount: split.base, gstAmount: split.gst });
        const saved = await save(rec);
        if (saved) {
          setAdding(false); setPending([]); setForm(blank());
          if (onAdded) await onAdded(saved);
        }
      }
    } catch (e) { tell(e?.message || String(e), e?.name === 'NetworkError' || e?.name === 'TimeoutError' ? 'network' : 'error'); } finally { setBusy(false); }
  }

  return (
    <div className="quotes">
      {fixing && (
        <Modal title="Send invoice back for correction" subtitle="Its approvals return to Pending and it goes through EC and final approval again. Not possible once a payment is recorded against it." onClose={() => setFixing(null)}>
          {fixing.err && <div className="notice error" data-testid="fix-error">{fixing.err}</div>}
          <div className="form-grid">
            <div className="field"><label>Corrected invoice total (₹)</label><input type="number" min="0" aria-label="Corrected amount" data-testid="fix-amount" value={fixing.amount} onChange={(e) => setFixing({ ...fixing, amount: e.target.value })} /></div>
            <div className="field" style={{ gridColumn: '1 / -1' }}><label>What is wrong? *</label><textarea rows={2} aria-label="Correction reason" data-testid="fix-reason" value={fixing.reason} onChange={(e) => setFixing({ ...fixing, reason: e.target.value })} placeholder="e.g. vendor typed 85,000 instead of 58,000" /></div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}><button type="button" className="btn" data-testid="fix-go" onClick={sendBack}>Send back</button><button type="button" className="btn secondary" onClick={() => setFixing(null)}>Cancel</button></div>
        </Modal>
      )}
      <div className="quotes-head">
        <b>{isInvoice ? 'Invoices' : 'Quotations'} <small className="muted">{isInvoice ? (quotesExist ? '(select the invoice(s) to send for EC and final approval)' : '(upload directly — each invoice goes to the EC, then final approval)') : '(optional — select one or several; the selected ones are approved together)'}</small></b>
        <span className="tag">{docs.length} {isInvoice ? 'uploaded' : 'collected'}</span>
      </div>
      {docs.length === 0 && (
        <div className="muted">
          {isInvoice ? 'No invoice yet. Upload each vendor invoice with its amount and GST; every invoice needs EC and final approval.' : 'No quotations. Upload each quotation you collect; the selected one(s) need EC and final approval.'}
        </div>
      )}
      {docs.map((q) => (
        <div key={q.id} className={`quote-row${isChosen(q.id) ? ' chosen' : ''}`}>
          <div className="quote-main">
            <div className="q-head"><b>{q.vendor}</b> <span className="quote-amt">{inr(q.amount)}</span></div>
            <div className="q-tags">
            {Number(q.amount) === lowest && docs.length > 1 && <span className="tag green">Lowest</span>}
            {isChosen(q.id) && !isInvoice && <span className="sel-tick" title="Selected"><i>✓</i> Selected</span>}
            {isInvoice && (quotesExist || docs.length > 1) && q.selected !== false && <span className="sel-tick" title="Selected"><i>✓</i> Selected</span>}
            {isInvoice && Number(q.gstAmount) > 0 && <span className="tag purple">GST {inr(q.gstAmount)} @ {q.gstRate}%</span>}
            {isInvoice && !(Number(q.gstAmount) > 0) && <span className="tag">No GST</span>}
            </div>
            <div className="muted">{q.shortId} · {q.quoteDate || '—'}{isInvoice && Number(q.gstAmount) > 0 ? ` · taxable ${inr(q.baseAmount)}` : ''}{q.note ? ` · ${q.note}` : ''}</div>
            {q.attachments?.length > 0 && <AttachmentList items={q.attachments} />}
            <div style={{ marginTop: 4 }}><AdminDelete collection={COLLECTIONS.QUOTATIONS} id={q.id} label={isInvoice ? 'invoice' : 'quotation'} /></div>
            {isInvoice && invoiceTools && (q.selected === false
              ? <small className="muted" style={{ display: 'block', marginTop: 6 }}>Select this invoice to send it for EC and final approval.</small>
              : invoiceBlock(q))}
            {isInvoice && q.correctionNote && <small className="muted" data-testid="invoice-correction-note" style={{ display: 'block', marginTop: 4 }}>Corrected: {q.correctionNote}</small>}
            {isInvoice && invoiceTools && q.selected !== false && !q.approvalWaived && invoiceApproval(q).key === 'approved' && invoiceTools.canDecideEC && invoiceTools.open && (
              invoiceTools.ledgerFor(q)
                ? <small className="muted" style={{ display: 'block', marginTop: 4 }}>Paid — to correct this invoice, reverse the payment first (Billing → Payments).</small>
                : <button type="button" className="link-btn" data-testid="invoice-sendback" onClick={() => setFixing({ doc: q, amount: q.amount, reason: '' })}>Send back for correction</button>
            )}
            {!isInvoice && quoteTools && q.id === primaryId && quoteTools.kit && (
              <PlanPanel
                title={selectedIds.length > 1 ? `Quotation approval · ${selectedIds.length} quotations, ${inr(selectedIds.reduce((n, id) => n + (Number(docs.find((d) => d.id === id)?.amount) || 0), 0))} in total` : 'Quotation approval'}
                plan={quoteTools.kit.planOf(ticket, quoteTools.planCtx, 'ticket')} kit={quoteTools.kit} rec={ticket} open={quoteTools.open}
                tagLabel={quoteTools.state.label} tagTone={quoteTools.state.tone} note={quoteTools.note} onSave={quoteTools.savePlan}
                entry={quoteTools.ledgerFor(q) || null} />
            )}
            {!isInvoice && quoteTools && q.id === primaryId && !quoteTools.kit && (
              <ApprovalBlock
                title={selectedIds.length > 1 ? `Quotation approval · ${selectedIds.length} quotations, ${inr(selectedIds.reduce((n, id) => n + (Number(docs.find((d) => d.id === id)?.amount) || 0), 0))} in total` : 'Quotation approval'} st={quoteTools.state} open={quoteTools.open}
                ec={{ value: ticket.ecApproval || 'Pending', by: ticket.ecApprovedBy, at: ticket.ecApprovedAt }}
                fin={{ value: ticket.treasurerApproval || 'Pending', by: ticket.treasurerApprovedBy, at: ticket.treasurerApprovedAt }}
                hint={quoteTools.finalRoleNames} canEC={quoteTools.canDecideEC} canFinal={quoteTools.canDecideFinal} finalRequired={ticket.finalRequired}
                onDecide={quoteTools.decide} note={quoteTools.note}
                entry={quoteTools.ledgerFor(q)}
              />
            )}
            {!isInvoice && quoteTools && isChosen(q.id) && q.id !== primaryId && quoteTools.state.key === 'approved' && (
              <div className="approval-panel compact inv approved">
                <div className="ap-step ok"><span className="ap-title">Payments · {q.vendor}</span>
                  {quoteTools.ledgerFor(q) ? <span className="tag blue">Paid · {quoteTools.ledgerFor(q).shortId}</span>
                    : <small className="muted">Approved with the other quotation(s) above — now in Payments.</small>}
                </div>
              </div>
            )}
          </div>
          {canEdit && onSelect && !isInvoice && (
            <button type="button" className={`btn sm ${isChosen(q.id) ? '' : 'secondary'}`} data-testid={`quote-toggle-${q.id}`}
              title="You can select more than one quotation (for example materials from one vendor, labour from another)"
              onClick={() => onSelect(q)}>
              {isChosen(q.id) ? 'Unselect' : 'Select'}
            </button>
          )}
          {canEdit && isInvoice && invoiceTools && (quotesExist || docs.length > 1) && (
            <button type="button" className={`btn sm ${q.selected === false ? 'secondary' : ''}`} data-testid={`invoice-toggle-${q.id}`}
              disabled={q.selected !== false && !!invoiceTools.ledgerFor(q)}
              title={q.selected !== false ? (invoiceTools.ledgerFor(q) ? 'Already paid' : 'Unselecting restarts this invoice\'s approval') : 'Send this invoice for approval'}
              onClick={() => toggleInvoice(q)}>
              {q.selected === false ? 'Select' : 'Unselect'}
            </button>
          )}
        </div>
      ))}
      {canEdit && !adding && <button type="button" className="btn secondary" onClick={() => { setForm((f) => ({ ...f, vendor: f.vendor || defaultVendor || '' })); setAdding(true); }}>{isInvoice ? '+ Upload invoice' : '+ Add quotation'}</button>}
      {canEdit && adding && (
        <div className="quote-add">
          <div className="form-grid">
            <div className={`field${fe.vendor ? ' invalid' : ''}`}><label>Vendor *</label><Combobox value={form.vendor} onChange={(v) => set('vendor', v)} options={vendorOptions} allowCustom placeholder="Search or type a vendor…" invalid={!!fe.vendor} />{fe.vendor && <div className="field-error">{fe.vendor}</div>}</div>
            <div className={`field${fe.amount ? ' invalid' : ''}`}><label>{isInvoice ? (form.gstMode === 'Extra' ? 'Amount before GST (₹) *' : 'Invoice amount (₹) *') : 'Amount (₹) *'}</label><input type="number" min="0" value={form.amount} onChange={(e) => set('amount', e.target.value)} />{fe.amount && <div className="field-error">{fe.amount}</div>}</div>
            <div className="field"><label>{isInvoice ? 'Invoice date' : 'Quotation date'}</label><input type="date" value={form.quoteDate} max={isInvoice ? todayIso() : undefined} onChange={(e) => set('quoteDate', e.target.value)} /></div>
            {isInvoice && (
              <>
                <div className="field"><label>GST</label>
                  <select value={form.gstMode} onChange={(e) => set('gstMode', e.target.value)}>
                    <option value="None">No GST / not applicable</option>
                    <option value="Included">GST included in the amount</option>
                    <option value="Extra">GST extra, on top of the amount</option>
                  </select>
                </div>
                {form.gstMode !== 'None' && (
                  <div className="field"><label>GST rate</label>
                    <select value={form.gstRate} onChange={(e) => set('gstRate', Number(e.target.value))}>
                      {GST_RATES.map((r) => <option key={r} value={r}>{r}%</option>)}
                    </select>
                  </div>
                )}
              </>
            )}
            <div className="field"><label>Scope / note</label><input value={form.note} onChange={(e) => set('note', e.target.value)} /></div>
            <div className={`field${fe.file && pending.length === 0 ? ' invalid' : ''}`} style={{ gridColumn: '1 / -1' }}><label>{isInvoice ? 'Invoice file *' : 'Quotation files'}</label><AttachmentPicker pending={pending} onChange={setPending} />{fe.file && pending.length === 0 && <div className="field-error">{fe.file}</div>}</div>
          </div>
          {isInvoice && Number(form.amount) > 0 && (
            <div className="gst-sum">
              <span>Taxable value <b>{inr(split.base)}</b></span>
              <span>GST input credit <b>{inr(split.gst)}</b></span>
              <span>Total payable <b>{inr(split.total)}</b></span>
            </div>
          )}
          {isInvoice && Number(form.amount) > 0 && (() => {
            const vr = (vendors || []).find((v) => v.name === form.vendor);
            const c = gstCheck({ amount: form.amount, mode: form.gstMode, rate: form.gstRate, date: form.quoteDate, area: 'Maintenance', text: `${ticket?.title || ''} ${ticket?.category || ''} ${form.note}`, gstin: vr?.gstin, vendor: form.vendor ? form.vendor : undefined });
            return c.msgs.length ? <div data-testid="inv-gst-notes" style={{ marginTop: 6 }}>{c.msgs.map((m, i) => <div key={i} className="muted" style={{ color: m.tone === 'warn' ? '#b45309' : m.tone === 'bad' ? '#c7364a' : m.tone === 'ok' ? '#15803d' : undefined }}>{m.tone === 'ok' ? '✓ ' : m.tone === 'bad' ? '✕ ' : m.tone === 'warn' ? '⚠ ' : 'ℹ '}{m.text}</div>)}</div> : null;
          })()}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="button" className="btn" disabled={busy} onClick={add}>{busy ? 'Saving…' : isInvoice ? 'Save invoice & send for approval' : 'Save quotation'}</button>
            <button type="button" className="btn secondary" onClick={() => { setAdding(false); setPending([]); setFe({}); }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
