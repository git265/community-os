import React, { useMemo, useState } from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import Modal from '../../components/Modal.jsx';
import Combobox from '../../components/Combobox.jsx';
import PlanPanel from './PlanPanel.jsx';
import { buildPlan } from '../../lib/approval/engine.js';
import { parseJson } from '../../lib/approval/kit.js';
import { releaseSummary, releaseProblem } from '../../lib/approval/releases.js';
import { money } from '../../lib/locale.js';

const inr = (n) => money(n, { round: false });
const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * Releases & advances for ONE task: money that goes out before (or without) the invoice.
 *   - an advance before any invoice is possible only when the EC has pre-approved it for this task (ceiling + reason)
 *   - a stage payment needs the quotation approved
 *   - every release has its own approval steps ('Maintenance release' rules) and the total can never pass the approved amount
 * Paid releases are credited against the invoices that arrive later; the task does not close itself while they are not covered.
 */
export default function ReleasesPanel({ ticket, kit, open, canEC, canAsk, onSaveTicket, defaultVendor, vendors = [], users = [] }) {
  const { records: releases, save, remove } = useCollection(COLLECTIONS.RELEASES, 'Fund releases');
  const { records: docs } = useCollection(COLLECTIONS.QUOTATIONS, 'Quotations');
  const { records: ledger } = useCollection(COLLECTIONS.LEDGER, 'Payments Cross-check');
  const [dlg, setDlg] = useState(null); // 'release'
  const [f, setF] = useState({});
  const [err, setErr] = useState('');
  const sum = useMemo(() => releaseSummary(ticket, releases, docs, kit.settings.tolerancePct, ledger), [ticket, releases, docs, kit.settings.tolerancePct, ledger]);
  const mine = releases.filter((r) => r.ticketId === ticket.id).sort((a, b) => String(a.recordCreatedAt || '').localeCompare(String(b.recordCreatedAt || '')));
  if (!canAsk && !mine.length) return null;
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const payeeOptions = useMemo(() => {
    const seen = new Set(); const out = [];
    vendors.forEach((v) => { if (v.name && !seen.has(v.name)) { seen.add(v.name); out.push({ value: v.name, label: v.name, hint: v.service || 'Vendor' }); } });
    users.forEach((u) => { if (u.name && !seen.has(u.name)) { seen.add(u.name); out.push({ value: u.name, label: u.name, hint: u.unit ? `Villa ${u.unit}` : 'User' }); } });
    return out;
  }, [vendors, users]);

  async function ask() {
    const kind = sum.basis === 'Invoice' ? 'Against invoice' : sum.basis === 'Quotation' ? 'Against quotation' : 'Release';
    const msg = sum.askBlock || releaseProblem(f.amount, sum);
    if (msg) return setErr(msg);
    if (!String(f.vendor || '').trim()) return setErr('Who is the money for?');
    const plan = buildPlan(kit.policies, { subject: 'Maintenance release', amount: Number(f.amount), category: ticket.category, taskType: ticket.taskType, flags: [] });
    const out = await save({ ticketId: ticket.id, ticketShortId: ticket.ticketNumber, kind, amount: Number(f.amount), vendor: f.vendor.trim(), note: f.note || '', status: 'Waiting approval', requestedBy: kit.me.name, settled: false, plan: JSON.stringify(plan) });
    if (out) { setDlg(null); setF({}); }
  }
  /** Correction: an approved release that is wrong (or no longer needed) is cancelled with a reason - it frees the amount again. */
  async function cancelRelease(r) {
    const why = window.prompt(`Cancel the ${inr(r.amount)} release to ${r.vendor}? Say why (kept on the record):`, '');
    if (!why || !why.trim()) return;
    const out = await save({ ...r, status: 'Cancelled', cancelReason: why.trim(), cancelledBy: `${kit.me.name} · ${todayIso()}` });
    if (!out) return;
  }
  async function planSaved(rel, plan) {
    const ps = plan.steps.some((s) => (s.decisions || []).some((d) => d.value === 'Rejected')) ? 'Rejected' : plan.steps.every((s) => s.skipped || ((s.decisions || []).filter((d) => d.value === 'Approved').length >= (Number(s.needed) || 1))) ? 'Approved' : 'Waiting approval';
    await save({ ...rel, plan: JSON.stringify(plan), status: ps });
  }
  async function settle() {
    const note = window.prompt('Settle the advance without a matching invoice — why? (kept on the task)', '');
    if (note && note.trim()) await onSaveTicket({ advanceSettled: `${note.trim()} — ${kit.me.name}, ${todayIso()}` });
  }

  return (
    <div className="quotes" data-testid="releases-panel">
      <div className="quotes-head">
        <b>Fund releases <small className="muted">(money released at any stage — before or after the quotation or invoice)</small></b>
        {sum.paid > 0 && <span className="tag blue">Paid {inr(sum.paid)}</span>}
      </div>
      {sum.cap > 0 && (
        <div className="money-bar" role="img" aria-label={`Paid ${sum.paid}, approved for release ${sum.released - sum.paid}, of ${sum.cap}`}>
          <span className="mb-paid" style={{ width: `${Math.min(100, (sum.paid / sum.cap) * 100)}%` }} />
          <span className="mb-wait" style={{ width: `${Math.min(100 - Math.min(100, (sum.paid / sum.cap) * 100), ((sum.released - sum.paid) / sum.cap) * 100)}%` }} />
        </div>
      )}
      <div className="muted" data-testid="release-summary">
        {sum.cap > 0 ? <>{sum.basis} approved {inr(sum.cap)} · </> : 'No quotation or invoice approved yet · '}Paid {inr(sum.paid)} · Waiting {inr(sum.released - sum.paid)}{sum.cap > 0 ? <> · Left {inr(sum.capLeft)}</> : ''}
      </div>
      {sum.paid > 0 && !sum.settled && <div className="notice" data-testid="advance-open">Released money paid {inr(sum.paid)}; approved invoices cover {inr(sum.invApproved)}. The task will not close itself until the invoices cover it{canEC && open ? <> — or <button type="button" className="link-btn" data-testid="advance-settle" onClick={settle}>settle it with a note</button></> : ''}.</div>}
      {ticket.advanceSettled && <small className="muted">Settled: {ticket.advanceSettled}</small>}
      {mine.map((r) => {
        const plan = parseJson(r.plan, null);
        return (
          <div key={r.id} className="quote-row" data-testid="release-row">
            <div className="quote-main">
              <div className="q-head"><b>Release{r.kind && r.kind !== 'Release' ? <small className="muted"> · {r.kind.toLowerCase()}</small> : ''}</b> <span className="quote-amt">{inr(r.amount)}</span> <span className={`tag ${r.status === 'Paid' ? 'blue' : r.status === 'Approved' ? 'green' : r.status === 'Rejected' ? 'red' : 'orange'}`}>{r.status}</span></div>
              <div className="muted">{r.shortId} · to {r.vendor}{r.note ? ` · ${r.note}` : ''} · asked by {r.requestedBy}</div>
              {plan && r.status !== 'Paid' && <PlanPanel title="Release approval" plan={plan} kit={kit} rec={r} open={open && r.status !== 'Approved' ? true : false} onSave={(pl) => planSaved(r, pl)} entry={r.status === 'Approved' ? null : undefined} />}
              {r.status === 'Cancelled' && <small className="muted" data-testid="release-cancelled">Cancelled{r.cancelReason ? `: ${r.cancelReason}` : ''}{r.cancelledBy ? ` — ${r.cancelledBy}` : ''}</small>}
              {r.status === 'Approved' && open && (canEC || canAsk) && <button type="button" className="link-btn" data-testid="release-cancel" onClick={() => cancelRelease(r)}>Cancel this release</button>}
              {r.status === 'Waiting approval' && open && canAsk && <button type="button" className="link-btn" onClick={() => window.confirm('Withdraw this release request?') && remove(r.id)}>Withdraw request</button>}
            </div>
          </div>
        );
      })}
      {open && canAsk && sum.askBlock && <div className="notice" data-testid="release-blocked" style={{ marginTop: 8 }}>{sum.askBlock}</div>}
      {open && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          {canAsk && <button type="button" className="btn secondary" data-testid="release-ask" disabled={!!sum.askBlock} title={sum.askBlock || ''} onClick={() => { setErr(''); setF({ vendor: defaultVendor || '', amount: sum.suggest || '' }); setDlg('release'); }}>+ Ask for a release</button>}
        </div>
      )}
      {dlg === 'release' && (
        <Modal title="Ask for a release" subtitle={sum.cap > 0 ? `Filled in from the approved ${sum.basis.toLowerCase()} (${inr(sum.cap)}); ${inr(sum.capLeft)} is left. It goes through the release approval steps, then to Payments.` : 'No quotation or invoice is approved yet, so the approvers decide the amount. It goes through the release approval steps, then to Payments.'} onClose={() => setDlg(null)}>
          {err && <div className="notice error" data-testid="release-error">{err}</div>}
          <div className="form-grid">
            <div className="field"><label>Amount (₹) *</label><input type="number" min="0" data-testid="rel-amount" value={f.amount} onChange={(e) => set('amount', e.target.value)} /></div>
            <div className="field" data-testid="rel-vendor"><label>Pay to *</label><Combobox value={f.vendor || ''} onChange={(v) => set('vendor', v)} options={payeeOptions} allowCustom placeholder="Search vendors or people…" /></div>
            <div className="field" style={{ gridColumn: '1 / -1' }}><label>Note</label><textarea rows={2} data-testid="rel-note" value={f.note || ''} onChange={(e) => set('note', e.target.value)} placeholder="e.g. advance for materials, first stage" /></div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}><button type="button" className="btn" data-testid="rel-save" onClick={ask}>Send for approval</button><button type="button" className="btn secondary" onClick={() => setDlg(null)}>Cancel</button></div>
        </Modal>
      )}
    </div>
  );
}
