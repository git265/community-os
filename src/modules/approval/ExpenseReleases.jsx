import React, { useMemo, useState } from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import Modal from '../../components/Modal.jsx';
import Combobox from '../../components/Combobox.jsx';
import PlanPanel from './PlanPanel.jsx';
import { buildPlan } from '../../lib/approval/engine.js';
import { parseJson } from '../../lib/approval/kit.js';
import { money } from '../../lib/locale.js';

const inr = (n) => money(n, { round: false });

/**
 * Pay one cultural expense in parts. Same single action as maintenance: "Ask for a release".
 * Amount is prefilled with what is left of the expense; the total can never pass the expense amount.
 * Each release goes through the 'Cultural release' rules, then waits in Payments → Cultural.
 */
export default function ExpenseReleases({ expense, event, kit, canAsk, vendors = [], users = [], onClose }) {
  const { records: all, save, remove } = useCollection(COLLECTIONS.RELEASES, 'Fund releases');
  const mine = all.filter((r) => r.expenseId === expense.id).sort((a, b) => String(a.recordCreatedAt || '').localeCompare(String(b.recordCreatedAt || '')));
  const live = mine.filter((r) => r.status !== 'Rejected');
  const released = live.reduce((n, r) => n + (Number(r.amount) || 0), 0);
  const paid = live.filter((r) => r.status === 'Paid').reduce((n, r) => n + (Number(r.amount) || 0), 0);
  const total = Number(expense.amount) || 0;
  const left = Math.max(0, Math.round((total - released) * 100) / 100);
  const [dlg, setDlg] = useState(false);
  const [f, setF] = useState({});
  const [err, setErr] = useState('');
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const options = useMemo(() => {
    const seen = new Set(); const out = [];
    vendors.forEach((v) => { if (v.name && !seen.has(v.name)) { seen.add(v.name); out.push({ value: v.name, label: v.name, hint: v.service || 'Vendor' }); } });
    users.forEach((u) => { if (u.name && !seen.has(u.name)) { seen.add(u.name); out.push({ value: u.name, label: u.name, hint: u.unit ? `Villa ${u.unit}` : 'User' }); } });
    return out;
  }, [vendors, users]);
  const live1 = !['Rejected', 'Paid'].includes(expense.status);

  async function ask() {
    const a = Number(f.amount) || 0;
    if (!(a > 0)) return setErr('Enter the amount to release');
    if (a > left + 0.5) return setErr(`Only ${inr(left)} of ${inr(total)} is left to release`);
    if (!String(f.vendor || '').trim()) return setErr('Who is the money for?');
    const plan = buildPlan(kit.policies, { subject: 'Cultural release', amount: a, category: expense.category, taskType: '', flags: [] });
    const out = await save({ expenseId: expense.id, ticketShortId: expense.shortId, kind: 'Release', amount: a, vendor: f.vendor.trim(), note: f.note || '', status: 'Waiting approval', requestedBy: kit.me.name, settled: false, plan: JSON.stringify(plan) });
    if (out) { setDlg(false); setF({}); }
  }
  async function planSaved(rel, plan) {
    const ps = plan.steps.some((s) => (s.decisions || []).some((d) => d.value === 'Rejected')) ? 'Rejected' : plan.steps.every((s) => s.skipped || ((s.decisions || []).filter((d) => d.value === 'Approved').length >= (Number(s.needed) || 1))) ? 'Approved' : 'Waiting approval';
    await save({ ...rel, plan: JSON.stringify(plan), status: ps });
  }

  return (
    <Modal title={`Releases · ${expense.item}`} subtitle={`${event?.name || 'Cultural event'} · expense ${inr(total)}`} onClose={onClose}>
      <div className="muted" data-testid="exp-release-summary">Expense {inr(total)} · Released {inr(released)} · Paid {inr(paid)} · Left {inr(left)}</div>
      {mine.length === 0 && <div className="empty">No release yet. The whole expense can still be paid in one go from Payments.</div>}
      {mine.map((r) => {
        const plan = parseJson(r.plan, null);
        return (
          <div key={r.id} className="quote-row" data-testid="exp-release-row">
            <div className="quote-main">
              <div className="q-head"><b>Release</b> <span className="quote-amt">{inr(r.amount)}</span> <span className={`tag ${r.status === 'Paid' ? 'blue' : r.status === 'Approved' ? 'green' : r.status === 'Rejected' ? 'red' : 'orange'}`}>{r.status}</span></div>
              <div className="muted">{r.shortId} · to {r.vendor}{r.note ? ` · ${r.note}` : ''} · asked by {r.requestedBy}</div>
              {plan && r.status !== 'Paid' && <PlanPanel title="Release approval" plan={plan} kit={kit} rec={r} open={r.status !== 'Approved'} onSave={(pl) => planSaved(r, pl)} entry={r.status === 'Approved' ? null : undefined} />}
              {r.status === 'Waiting approval' && canAsk && <button type="button" className="link-btn" onClick={() => window.confirm('Withdraw this release request?') && remove(r.id)}>Withdraw request</button>}
            </div>
          </div>
        );
      })}
      {live1 && canAsk && left > 0.5 && <div style={{ marginTop: 10 }}><button type="button" className="btn secondary" data-testid="exp-release-ask" onClick={() => { setErr(''); setF({ vendor: expense.vendor || '', amount: left }); setDlg(true); }}>+ Ask for a release</button></div>}
      {dlg && (
        <Modal title="Ask for a release" subtitle={`Filled in with what is left of the expense (${inr(left)}). It goes through the cultural release approval, then to Payments.`} onClose={() => setDlg(false)}>
          {err && <div className="notice error" data-testid="exp-release-error">{err}</div>}
          <div className="form-grid">
            <div className="field"><label>Amount (₹) *</label><input type="number" min="0" data-testid="exp-rel-amount" value={f.amount} onChange={(e) => set('amount', e.target.value)} /></div>
            <div className="field" data-testid="exp-rel-vendor"><label>Pay to *</label><Combobox value={f.vendor || ''} onChange={(v) => set('vendor', v)} options={options} allowCustom placeholder="Search vendors or people…" /></div>
            <div className="field" style={{ gridColumn: '1 / -1' }}><label>Note</label><textarea rows={2} maxLength={2000} value={f.note || ''} onChange={(e) => set('note', e.target.value)} placeholder="e.g. advance to the caterer, balance after the event" /></div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}><button type="button" className="btn" data-testid="exp-rel-save" onClick={ask}>Send for approval</button><button type="button" className="btn secondary" onClick={() => setDlg(false)}>Cancel</button></div>
        </Modal>
      )}
    </Modal>
  );
}
