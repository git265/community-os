// Payments extras: other income (rent, interest…), recurring bills, and payments waiting for a second approver.
import React, { useState } from 'react';
import { needsRef } from '../../lib/region/paymentModes.js';
import Modal from '../../components/Modal.jsx';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { getPrincipal } from '../../lib/security/principal.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { recordPayment, MODES } from '../../lib/paymentEngine.js';
import { INCOME_HEADS, decidePayRequest, runRecurringBills, inr, dmy, todayIso } from '../../lib/finance/rules.js';

export function IncomeDialog({ accounts, onClose, onDone }) {
  const { records: funds } = useCollection(C.FUNDS, 'Fund Position');
  const [f, setF] = useState({ head: INCOME_HEADS[0], from: '', amount: '', account: '', fund: '', mode: 'Bank transfer', ref: '', date: todayIso(), note: '' });
  const [err, setErr] = useState('');
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  async function go() {
    setErr('');
    if (needsRef(f.mode) && !f.ref.trim()) return setErr('Enter the UTR / cheque number so the bank statement can be matched');
    const r = await recordPayment({ area: 'Other', type: 'Credit', category: f.head, amount: f.amount, account: f.account, date: f.date, mode: f.mode, ref: f.ref.trim(), vendor: f.from, description: `${f.head}${f.from ? ` · ${f.from}` : ''}${f.note ? ` · ${f.note}` : ''}`, sourceType: 'income', sourceId: '', extra: f.fund ? { fund: f.fund } : {} });
    if (r.error) return setErr(r.error);
    onDone();
  }
  return (
    <Modal title="Record other income" subtitle="Money the association earns apart from dues: parking or hall rent, a mobile tower, hoarding, interest, scrap…" onClose={onClose}>
      {err && <div className="notice error" data-testid="inc-error">{err}</div>}
      <div className="form-grid" data-testid="income-dialog">
        <div className="field"><label>Income from *</label><input list="inc-heads" data-testid="inc-head" value={f.head} onChange={(e) => set('head', e.target.value)} /><datalist id="inc-heads">{INCOME_HEADS.map((h) => <option key={h} value={h} />)}</datalist></div>
        <div className="field"><label>Received from</label><input data-testid="inc-from" value={f.from} onChange={(e) => set('from', e.target.value)} placeholder="Name of the payer" /></div>
        <div className="field"><label>Amount (₹) *</label><input type="number" min="0" data-testid="inc-amount" value={f.amount} onChange={(e) => set('amount', e.target.value)} /></div>
        <div className="field"><label>{f.mode === 'Cash' ? 'Bank account it is paid into *' : 'Bank account *'}</label><select data-testid="inc-account" value={f.account} onChange={(e) => set('account', e.target.value)}><option value="">Choose…</option>{accounts.map((a) => <option key={a.id}>{a.name}</option>)}</select></div>
        <div className="field"><label>Fund</label><select data-testid="inc-fund" value={f.fund} onChange={(e) => set('fund', e.target.value)}><option value="">None</option>{funds.map((x) => <option key={x.id} value={x.name}>{x.name}</option>)}</select></div>
        <div className="field"><label>Mode</label><select value={f.mode} onChange={(e) => set('mode', e.target.value)}>{MODES.map((m) => <option key={m}>{m}</option>)}</select></div>
        <div className="field"><label>UTR / cheque no.{f.mode === 'Cash' ? '' : ' *'}</label><input data-testid="inc-ref" value={f.ref} onChange={(e) => set('ref', e.target.value)} /></div>
        <div className="field"><label>Date</label><input type="date" value={f.date} max={todayIso()} onChange={(e) => set('date', e.target.value)} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Note</label><input value={f.note} onChange={(e) => set('note', e.target.value)} placeholder="e.g. Airtel tower rent, October" /></div>
      </div>
      <div className="form-actions"><button className="btn good" data-testid="inc-save" disabled={!f.head.trim() || !(Number(f.amount) > 0) || !f.account} onClick={go}>Record income</button><button className="btn secondary" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

export function RecurringDialog({ onClose }) {
  const { records, save, remove } = useCollection(C.RECURRING_BILLS, 'Recurring bills');
  const [f, setF] = useState({ description: '', utility: 'Other', provider: '', amount: '', dayOfMonth: 10, location: 'Common area' });
  const [msg, setMsg] = useState('');
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const canEdit = canWriteCollection(C.RECURRING_BILLS, getPrincipal());
  async function add() {
    const ok = await save({ ...f, amount: Number(f.amount), dayOfMonth: Number(f.dayOfMonth) || 10, active: true });
    if (ok) { setF({ description: '', utility: 'Other', provider: '', amount: '', dayOfMonth: 10, location: 'Common area' }); setMsg('Added. Its bill appears under Utilities (Association) every month.'); }
  }
  return (
    <Modal title="Recurring bills" subtitle="Expenses that repeat every month (security agency, internet, lift AMC, rent…). Each month a bill is raised under Payments → Utilities (Association), ready to pay." onClose={onClose} wide>
      <div data-testid="recurring-dialog">
        {records.length > 0 && (
          <table className="table resp-table" data-testid="rec-table">
            <thead><tr><th>What</th><th>Supplier</th><th style={{ textAlign: 'right' }}>Amount</th><th>Due day</th><th>Last raised</th><th /></tr></thead>
            <tbody>{records.map((r) => (
              <tr key={r.id} data-testid="rec-row"><td data-label="What">{r.description}{r.active === false ? ' (paused)' : ''}</td><td data-label="Supplier">{r.provider}</td><td data-label="Amount" style={{ textAlign: 'right' }}>{inr(r.amount)}</td><td data-label="Due day">{r.dayOfMonth}</td><td data-label="Last raised">{r.lastMonth || '—'}</td>
                <td>{canEdit && <><button className="btn secondary sm" onClick={() => save({ ...r, active: r.active === false })}>{r.active === false ? 'Resume' : 'Pause'}</button> <button className="btn secondary sm" onClick={() => remove(r.id)}>Remove</button></>}</td></tr>))}</tbody>
          </table>
        )}
        {canEdit && (
          <>
            <h4 style={{ margin: '10px 0 4px' }}>Add a recurring bill</h4>
            <div className="form-grid">
              <div className="field"><label>What it is *</label><input data-testid="rec-desc" value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="Security agency" /></div>
              <div className="field"><label>Supplier *</label><input data-testid="rec-provider" value={f.provider} onChange={(e) => set('provider', e.target.value)} /></div>
              <div className="field"><label>Amount each month (₹) *</label><input type="number" min="0" data-testid="rec-amount" value={f.amount} onChange={(e) => set('amount', e.target.value)} /></div>
              <div className="field"><label>Due on day</label><input type="number" min="1" max="28" data-testid="rec-day" value={f.dayOfMonth} onChange={(e) => set('dayOfMonth', e.target.value)} /></div>
              <div className="field"><label>Kind</label><select value={f.utility} onChange={(e) => set('utility', e.target.value)}>{['Water', 'Gas', 'Internet / telecom', 'Waste / sanitation', 'Other'].map((u) => <option key={u}>{u}</option>)}</select></div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn" data-testid="rec-add" disabled={!f.description.trim() || !f.provider.trim() || !(Number(f.amount) > 0)} onClick={add}>Add</button>
              <button className="btn secondary" data-testid="rec-run" onClick={async () => { const n = await runRecurringBills(); setMsg(n ? `${n} bill(s) raised for this month.` : 'Every recurring bill already has this month’s bill.'); }}>Raise this month’s bills now</button>
            </div>
          </>
        )}
        {msg && <p className="muted" data-testid="rec-msg">{msg}</p>}
        <div className="form-actions"><button className="btn secondary" onClick={onClose}>Close</button></div>
      </div>
    </Modal>
  );
}

/** Payments above the approval limit, waiting for someone other than the requester. */
export function RequestsPanel({ onChanged }) {
  const { records } = useCollection(C.PAY_REQUESTS, 'Payments waiting for approval');
  const [msg, setMsg] = useState('');
  const me = getPrincipal().name;
  const canDecide = canWriteCollection(C.PAY_REQUESTS, getPrincipal());
  const waiting = records.filter((r) => r.status === 'Waiting');
  if (!waiting.length) return null;
  async function decide(r, ok) { const res = await decidePayRequest(r, ok, me); setMsg(res.error || (ok ? `Approved and paid ${inr(r.amount)}.` : 'Rejected.')); onChanged?.(); }
  return (
    <div className="notice" data-testid="requests-panel" style={{ marginTop: 12, borderColor: '#f59e0b', background: '#fffbeb' }}>
      <b>⏳ {waiting.length} payment{waiting.length === 1 ? '' : 's'} waiting for a second approver</b>
      {waiting.map((r) => (
        <div key={r.id} data-testid="request-row" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
          <span style={{ flex: 1 }}>{r.shortId} · <b>{inr(r.amount)}</b> to {r.vendor || '—'} · {r.description} · requested by {r.requestedBy} on {dmy(String(r.recordCreatedAt).slice(0, 10))}</span>
          {canDecide && (r.requestedBy === me ? <span className="muted">Needs someone else to approve</span> : <><button className="btn good sm" data-testid="request-approve" onClick={() => decide(r, true)}>Approve & pay</button><button className="btn secondary sm" data-testid="request-reject" onClick={() => decide(r, false)}>Reject</button></>)}
        </div>
      ))}
      {msg && <div className="muted" data-testid="request-msg" style={{ marginTop: 4 }}>{msg}</div>}
    </div>
  );
}
