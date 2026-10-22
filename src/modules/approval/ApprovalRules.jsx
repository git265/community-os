import React, { useState } from 'react';
import Modal from '../../components/Modal.jsx';
import { SUBJECTS, FLAGS, buildPlan, matching, stepWho } from '../../lib/approval/engine.js';
import { useApprovalKit } from '../../lib/approval/usePlans.js';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import { approverOptions } from './PlanPanel.jsx';
import { money } from '../../lib/locale.js';

const inr = (n) => money(n, { round: false });
const conditionChips = (p) => {
  const c = [];
  c.push((p.subjects || []).length ? p.subjects.join(' · ') : 'Anything');
  if (Number(p.minAmount) > 0 || Number(p.maxAmount) > 0) c.push(`₹${Number(p.minAmount) || 0} – ${Number(p.maxAmount) > 0 ? `₹${Number(p.maxAmount)}` : 'no limit'}`);
  if ((p.categories || []).length) c.push(`Category: ${p.categories.join(', ')}`);
  if ((p.taskTypes || []).length) c.push(`Type: ${p.taskTypes.join(', ')}`);
  if (p.requireFlag === 'overBudget') c.push('Invoice above approved amount');
  if (p.requireFlag === 'eventFinal') c.push('Over the event’s final-approval limit');
  return c;
};
const csv = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const blank = () => ({ name: '', active: true, priority: 50, subjects: ['Maintenance invoice'], minAmount: '', maxAmount: '', categories: [], taskTypes: [], requireFlag: '', steps: [{ name: 'EC', approvers: [{ kind: 'group', value: 'EC members' }], needed: 1, canFinish: true }] });
const TEMPLATES = [
  { label: 'Over ₹50,000 also needs the President', make: () => ({ ...blank(), name: 'Large spend: President too', priority: 40, subjects: ['Maintenance quotation', 'Maintenance invoice', 'Maintenance release', 'Cultural expense'], minAmount: 50000, steps: [{ name: 'President', approvers: [{ kind: 'role', value: 'president' }], needed: 1, canFinish: false }] }) },
  { label: 'Over ₹2,00,000 needs two final approvers', make: () => ({ ...blank(), name: 'Very large spend: two final approvers', priority: 50, subjects: ['Maintenance quotation', 'Maintenance invoice'], minAmount: 200000, steps: [{ name: 'Two final approvers', approvers: [{ kind: 'group', value: 'Final approvers' }], needed: 2, canFinish: false }] }) },
];

function RuleDialog({ rule, kit, onClose, onSave }) {
  const [r, setR] = useState(rule);
  const [err, setErr] = useState('');
  const opts = approverOptions(kit);
  const set = (k, v) => setR((x) => ({ ...x, [k]: v }));
  const upd = (i, k, v) => set('steps', r.steps.map((s, j) => (j === i ? { ...s, [k]: v } : s)));
  const toggleSubj = (s) => set('subjects', r.subjects.includes(s) ? r.subjects.filter((x) => x !== s) : [...r.subjects, s]);
  const go = () => {
    if (!r.name.trim()) { setErr('Give the rule a name'); return; }
    if (!r.steps.length) { setErr('Add at least one approval step'); return; }
    onSave({ ...r, minAmount: Number(r.minAmount) || 0, maxAmount: Number(r.maxAmount) || 0 });
  };
  return (
    <Modal title={rule.id ? 'Edit approval rule' : 'New approval rule'} subtitle="When a thing matches, these steps are added to its approval. Every matching rule applies." onClose={onClose} wide>
      <div className={`field${err && !r.name.trim() ? ' invalid' : ''}`}><label>Rule name *</label><input data-testid="rule-name" value={r.name} onChange={(e) => set('name', e.target.value)} /></div>
      <div className="field"><label>Applies to</label>
        <div className="approver-grid">{SUBJECTS.map((s) => <label key={s} className={`approver-opt${r.subjects.includes(s) ? ' on' : ''}`}><input type="checkbox" checked={r.subjects.includes(s)} onChange={() => toggleSubj(s)} /><span>{s}</span></label>)}</div>
        <small className="muted">Nothing ticked = every kind of approval.</small></div>
      <div className="form-grid">
        <div className="field"><label>Amount from (₹)</label><input type="number" min="0" data-testid="rule-min" value={r.minAmount} onChange={(e) => set('minAmount', e.target.value)} /></div>
        <div className="field"><label>Up to (₹) — blank = no limit</label><input type="number" min="0" data-testid="rule-max" value={r.maxAmount} onChange={(e) => set('maxAmount', e.target.value)} /></div>
        <div className="field"><label>Only these categories (comma separated)</label><input value={(r.categories || []).join(', ')} onChange={(e) => set('categories', csv(e.target.value))} placeholder="e.g. MEP, Civil" /></div>
        <div className="field"><label>Only these task types</label><input value={(r.taskTypes || []).join(', ')} onChange={(e) => set('taskTypes', csv(e.target.value))} placeholder="e.g. Purchase" /></div>
        <div className="field"><label>Only when</label><select value={r.requireFlag || ''} onChange={(e) => set('requireFlag', e.target.value)}>{FLAGS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</select></div>
      </div>
      <b>Approval steps, in order</b>
      {r.steps.map((s, i) => (
        <div key={i} className="form-grid" style={{ alignItems: 'end', marginTop: 6 }}>
          <div className="field"><label>Step {i + 1} name</label><input value={s.name} onChange={(e) => upd(i, 'name', e.target.value)} /></div>
          <div className="field"><label>Who approves</label><select data-testid={`rule-who-${i}`} value={`${s.approvers[0].kind}:${s.approvers[0].value}`} onChange={(e) => { const [k, ...v] = e.target.value.split(':'); upd(i, 'approvers', [{ kind: k, value: v.join(':') }]); }}>{opts.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select></div>
          <div className="field"><label>How many must approve</label><input type="number" min="1" value={s.needed} onChange={(e) => upd(i, 'needed', e.target.value)} /></div>
          <label className="approver-opt" style={{ alignSelf: 'center' }}><input type="checkbox" checked={!!s.canFinish} onChange={(e) => upd(i, 'canFinish', e.target.checked)} /><span>Can be the last step<small className="muted">approver may skip the later steps</small></span></label>
          {r.steps.length > 1 && <button type="button" className="link-btn" onClick={() => set('steps', r.steps.filter((_, j) => j !== i))}>Remove</button>}
        </div>
      ))}
      <button type="button" className="btn secondary sm" style={{ marginTop: 8 }} onClick={() => set('steps', [...r.steps, { name: 'Final approval', approvers: [{ kind: 'group', value: 'Final approvers' }], needed: 1, canFinish: false }])}>+ Add a step</button>
      {err && <div className="field invalid"><div className="field-error">{err}</div></div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}><button type="button" className="btn" data-testid="rule-save" onClick={go}>Save rule</button><button type="button" className="btn secondary" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

/** Maintenance → Final approvers: the community's approval rules + the "test it" box + the few settings behind them. */
export default function ApprovalRules() {
  const kit = useApprovalKit();
  const { records: srows, save: saveSettings } = useCollection(COLLECTIONS.FINANCE_SETTINGS, 'Finance settings');
  const [edit, setEdit] = useState(null);
  const [test, setTest] = useState({ subject: 'Maintenance invoice', amount: 75000, flag: '' });
  const canEdit = canWriteCollection(COLLECTIONS.APPROVAL_POLICIES, getPrincipal());
  const sorted = [...kit.policies].sort((a, b) => (Number(a.priority) || 100) - (Number(b.priority) || 100));
  const row = srows[0];
  const setSetting = (k, v) => row && saveSettings({ ...row, [k]: v });
  const saveRule = async (r) => { const out = await kit.savePolicy({ ...r, steps: JSON.stringify(r.steps) }); if (out) setEdit(null); };
  const ctx = { subject: test.subject, amount: Number(test.amount) || 0, flags: test.flag ? [test.flag] : [] };
  const plan = buildPlan(kit.policies, ctx);
  const rulesOn = matching(kit.policies, ctx);
  const move = async (p, dir) => {
    const i = sorted.findIndex((x) => x.id === p.id); const o = sorted[i + dir]; if (!o) return;
    await kit.savePolicy({ ...p, steps: JSON.stringify(p.steps), priority: Number(o.priority) || 100 });
    await kit.savePolicy({ ...o, steps: JSON.stringify(o.steps), priority: Number(p.priority) || 100 });
    kit.refreshPolicies();
  };
  return (
    <div className="card" data-testid="approval-rules" style={{ marginTop: 16 }}>
      <h2 style={{ marginTop: 0 }}>Approval rules</h2>
      <p className="muted" style={{ marginTop: -6 }}>Say who must approve what — by amount, kind of work or category. <b>Every rule that matches applies</b>: their steps are joined in this order, and a step with the same approvers is shown once. If nothing matches it is EC, then the final approvers.</p>
      {sorted.length === 0 && <div className="muted">No rules yet — everything goes EC, then final approvers.</div>}
      <ol className="rule-list">
        {sorted.map((p, i) => (
          <li key={p.id} className={`rule-item${p.active === false ? ' off' : ''}`} data-testid="rule-row">
            <span className="rule-num">{i + 1}</span>
            <div className="rule-body">
              <div className="rule-title"><b>{p.name}</b>{p.active === false && <span className="tag">Off</span>}</div>
              <div className="rule-when">{conditionChips(p).map((c) => <span key={c} className="chip-soft">{c}</span>)}</div>
              <div className="rule-chain" aria-label="Approval steps">{(p.steps || []).map((s, k) => <React.Fragment key={k}>{k > 0 && <span className="chain-arrow" aria-hidden="true">→</span>}<span className="chain-step">{stepWho(s, kit.roleName)}{s.canFinish ? <i title="This approver can make it the last step"> · can end here</i> : null}</span></React.Fragment>)}</div>
            </div>
            {canEdit && <span className="rule-actions">
              <button type="button" className="icon-btn" aria-label="Move up" title="Move up" disabled={i === 0} onClick={() => move(p, -1)}>↑</button>
              <button type="button" className="icon-btn" aria-label="Move down" title="Move down" disabled={i === sorted.length - 1} onClick={() => move(p, 1)}>↓</button>
              <button type="button" className="btn secondary sm" data-testid="rule-edit" onClick={() => setEdit({ ...p })}>Edit</button>
              <button type="button" className="btn secondary sm" onClick={() => kit.savePolicy({ ...p, steps: JSON.stringify(p.steps), active: p.active === false })}>{p.active === false ? 'Turn on' : 'Turn off'}</button>
              <button type="button" className="link-btn danger-link" onClick={async () => { if (window.confirm(`Delete the rule “${p.name}”?`)) { await kit.removePolicy(p.id); } }}>Delete</button>
            </span>}
          </li>
        ))}
      </ol>
      {canEdit && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        <button type="button" className="btn" data-testid="rule-add" onClick={() => setEdit(blank())}>+ Add a rule</button>
        {TEMPLATES.map((t) => <button key={t.label} type="button" className="btn secondary sm" onClick={() => setEdit(t.make())}>{t.label}</button>)}
      </div>}

      <div className="sect-head"><h3>Try it</h3><small className="muted">Pick an amount to see exactly who would have to approve.</small></div>
      <div className="form-grid">
        <div className="field"><label>What is being approved</label><select data-testid="test-subject" value={test.subject} onChange={(e) => setTest({ ...test, subject: e.target.value })}>{SUBJECTS.map((s) => <option key={s}>{s}</option>)}</select></div>
        <div className="field"><label>Amount (₹)</label><input type="number" data-testid="test-amount" value={test.amount} onChange={(e) => setTest({ ...test, amount: e.target.value })} /></div>
        <div className="field"><label>Situation</label><select value={test.flag} onChange={(e) => setTest({ ...test, flag: e.target.value })}>{FLAGS.map((f) => <option key={f.value} value={f.value}>{f.value ? f.label.replace(/^Only when /, '') : 'Normal'}</option>)}</select></div>
      </div>
      <div className="approval-panel compact" data-testid="test-result">
        <div className="muted">{inr(ctx.amount)} · {test.subject}: {rulesOn.length ? `${rulesOn.length} rule${rulesOn.length === 1 ? '' : 's'} apply (${rulesOn.map((r) => r.name).join(' · ')})` : 'no rule matches — default chain'}</div>
        {plan.steps.map((s, i) => <div key={i} className="ap-step"><span className="ap-title">{i + 1}. {s.name}</span><small className="muted">{stepWho(s, kit.roleName)}{s.canFinish ? ' · can be the last step' : ''}</small></div>)}
      </div>

      <div className="sect-head"><h3>Settings</h3></div>
      <div className="form-grid">
        <label className="approver-opt"><input type="checkbox" disabled={!canEdit || !row} checked={!!row?.approvalSeparate} onChange={(e) => setSetting('approvalSeparate', e.target.checked)} data-testid="set-separate" /><span>Approvers must be different people<small className="muted">One person cannot approve two steps, nor their own request</small></span></label>
        <label className="approver-opt"><input type="checkbox" data-testid="set-skip" disabled={!canEdit || !row} checked={!!row?.invoiceSkipWithinQuote} onChange={(e) => setSetting('invoiceSkipWithinQuote', e.target.checked)} /><span>Invoices within the approved quotation need no approval<small className="muted">Up to the approved amount plus the tolerance below; anything above goes through the rules</small></span></label>
        <label className="approver-opt"><input type="checkbox" disabled={!canEdit || !row} checked={row?.allowOverride !== false} onChange={(e) => setSetting('allowOverride', e.target.checked)} /><span>Super Admin may change the approvals of one task<small className="muted">Only a Super Admin sees the button; needs a reason, kept in the history</small></span></label>
        <label className="approver-opt"><input type="checkbox" disabled={!canEdit || !row} checked={row?.finalCanDecideEC !== false} onChange={(e) => setSetting('finalCanDecideEC', e.target.checked)} data-testid="set-final-ec" /><span>Treasurer / final approvers who are also EC members may give the EC decision<small className="muted">Turn off and they approve only at the final step</small></span></label>
        <div className="field"><label>Invoice may exceed the approved amount by (%)</label><input type="number" min="0" data-testid="set-tolerance" disabled={!canEdit || !row} defaultValue={row?.invoiceTolerancePct ?? 5} key={row?.recVersion} onBlur={(e) => Number(e.target.value) !== Number(row?.invoiceTolerancePct) && setSetting('invoiceTolerancePct', Number(e.target.value) || 0)} /><small className="muted">Beyond this, the “above the approved amount” rules apply</small></div>
      </div>
      {edit && <RuleDialog rule={edit} kit={kit} onClose={() => setEdit(null)} onSave={saveRule} />}
    </div>
  );
}
