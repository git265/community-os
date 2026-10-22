import React, { useState } from 'react';
import ActionMenu from '../../components/ActionMenu.jsx';
import Modal from '../../components/Modal.jsx';
import { planState, stepState, decidedBy, stepWho, decide as engineDecide, overrideSteps } from '../../lib/approval/engine.js';

const todayIso = () => new Date().toISOString().slice(0, 10);
const tag = (v) => (v === 'approved' ? <span className="tag green"><span className="tick">✓</span> Approved</span> : v === 'rejected' ? <span className="tag red">Rejected</span> : v === 'skipped' ? <span className="tag">Not needed</span> : <span className="tag orange">Pending</span>);

/** Approver choices offered when one task's approvals are changed. */
export function approverOptions(kit) {
  const roles = [...new Set(['president', 'treasurer', 'secretary', 'vice_president', ...kit.finalRoleIds])].filter((id) => kit.roleName(id) !== id || ['president', 'treasurer', 'secretary'].includes(id));
  return [{ v: 'group:EC members', l: 'Any EC member' }, { v: 'group:Final approvers', l: 'Final approvers' }, ...roles.map((id) => ({ v: `role:${id}`, l: kit.roleName(id) }))];
}

function OverrideDialog({ plan, kit, onClose, onSave }) {
  const startAt = plan.steps.filter((s) => (s.decisions || []).length).length;
  const [rows, setRows] = useState(() => plan.steps.slice(startAt).map((s) => ({ name: s.name, who: `${s.approvers[0].kind}:${s.approvers[0].value}`, needed: s.needed, canFinish: !!s.canFinish })));
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const opts = approverOptions(kit);
  const upd = (i, k, v) => setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const go = () => {
    const steps = rows.map((r) => { const [kind, ...v] = r.who.split(':'); return { name: r.name || 'Approval', approvers: [{ kind, value: v.join(':') }], needed: Number(r.needed) || 1, canFinish: r.canFinish }; });
    const out = overrideSteps(plan, steps, reason, kit.me.name);
    if (out.error) { setErr(out.error); return; }
    onSave(out.plan);
  };
  return (
    <Modal title="Change the approvals for this one task" subtitle="Only the steps still waiting can be changed. Your reason is saved and shown in the history." onClose={onClose}>
      {rows.map((r, i) => (
        <div key={i} className="form-grid" style={{ alignItems: 'end', marginBottom: 8 }}>
          <div className="field"><label>Step {startAt + i + 1}</label><input value={r.name} onChange={(e) => upd(i, 'name', e.target.value)} /></div>
          <div className="field"><label>Who approves</label><select value={r.who} onChange={(e) => upd(i, 'who', e.target.value)}>{opts.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select></div>
          <div className="field"><label>Approvals needed</label><input type="number" min="1" value={r.needed} onChange={(e) => upd(i, 'needed', e.target.value)} /></div>
          <button type="button" className="link-btn" onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>Remove step</button>
        </div>
      ))}
      <button type="button" className="btn secondary sm" onClick={() => setRows((r) => [...r, { name: 'Approval', who: 'group:Final approvers', needed: 1, canFinish: false }])}>+ Add a step</button>
      <div className={`field${err ? ' invalid' : ''}`} style={{ marginTop: 12 }}><label>Why is this task different? *</label><textarea data-testid="override-reason" rows={2} value={reason} onChange={(e) => { setReason(e.target.value); setErr(''); }} />{err && <div className="field-error">{err}</div>}</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}><button type="button" className="btn" data-testid="override-save" onClick={go}>Save for this task</button><button type="button" className="btn secondary" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

/**
 * The approval steps of one record (quotation, invoice, release, expense), drawn from its plan.
 *   plan     the hydrated plan; onSave(nextPlan) persists it (plan + old-style fields)
 *   open     whether decisions are allowed at all right now
 * Test ids kept from the old two-step block: ec-decide (first step), final-approve / final-reject (later steps), ec-undo.
 */
/** A decision's time as a date ("22 Oct 2026"); a plain date stays as it is. */
const when = (at) => { const t = String(at || ''); if (!/^\d{4}-\d{2}-\d{2}/.test(t)) return at; const d = new Date(/T\d/.test(t) ? t : `${t.slice(0, 10)}T00:00:00`); return Number.isNaN(d.getTime()) ? at : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); };

export default function PlanPanel({ title, plan, kit, rec, open = true, onSave, entry, note, tagLabel, tagTone, waitingText, footer }) {
  const [override, setOverride] = useState(false);
  const st = planState(plan);
  const may = open && kit.mayDecide(plan, rec);
  const by = kit.me.name;
  const act = async (value, opts = {}) => {
    const out = engineDecide(plan, by, value, { finish: opts.finish, comment: opts.comment || '', at: todayIso() });
    if (out.error) return;
    await onSave(out.plan);
  };
  const lastDecided = (() => { for (let i = plan.steps.length - 1; i >= 0; i -= 1) if ((plan.steps[i].decisions || []).some((d) => d.by === by)) return i; return -1; })();
  const nextSteps = (i) => plan.steps.slice(i + 1).filter((s) => !s.skipped);
  return (
    <div className={`approval-panel compact inv ${st.key}`} data-testid="plan-panel">
      <div className="ap-head"><b>{title}</b>{tagLabel && <span className={`tag ${tagTone || ''}`}>{tagLabel}</span>}</div>
      {plan.steps.map((s, i) => {
        const ss = stepState(s); const here = st.key === 'pending' && st.index === i;
        const last = (s.decisions || []).filter((d) => d.value !== 'Pending').slice(-1)[0];
        const first = i === 0;
        return (
          <div key={s.id + i} className={`ap-step ${ss === 'approved' ? 'ok' : ss === 'rejected' ? 'no' : ss === 'skipped' ? 'ok' : ''}`}>
            <span className="ap-title">{s.name}<small className="muted ap-hint"> {stepWho(s, kit.roleName)}</small></span>
            {tag(ss)}
            {ss !== 'pending' && ss !== 'skipped' && last && <small className="muted">{(s.decisions || []).filter((d) => d.value === 'Approved').map((d) => d.by).join(', ') || last.by}{last.at ? ` · ${when(last.at)}` : ''}{last.comment ? ` · “${last.comment}”` : ''}</small>}
            {ss === 'pending' && (s.decisions || []).length > 0 && <small className="muted">{decidedBy(s).length} of {s.needed} so far</small>}
            {ss === 'skipped' && <small className="muted">The earlier step was the last one</small>}
            {here && may && (
              <span className="ap-actions">
                {first && s.canFinish && nextSteps(i).length > 0 ? (
                  <ActionMenu label="EC decision" testid="ec-decide" actions={[
                    { key: 'send', label: `Approve & send to ${nextSteps(i)[0].name}`, hint: `Goes to ${stepWho(nextSteps(i)[0], kit.roleName)}`, onClick: () => act('Approved', { finish: false }) },
                    { key: 'final', label: 'Approve — this is the last step', hint: 'No further approval needed; it goes straight to Payments', onClick: () => act('Approved', { finish: true }) },
                    { key: 'reject', label: 'Reject', tone: 'bad', onClick: () => act('Rejected') },
                  ]} />
                ) : first ? (
                  <ActionMenu label="EC decision" testid="ec-decide" actions={[
                    { key: 'send', label: 'Approve', onClick: () => act('Approved') },
                    { key: 'final', label: 'Approve', onClick: () => act('Approved') },
                    { key: 'reject', label: 'Reject', tone: 'bad', onClick: () => act('Rejected') },
                  ].filter((a) => a.key !== 'final')} />
                ) : (
                  <>
                    <button type="button" className="btn good sm" data-testid="final-approve" onClick={() => act('Approved')}>Approve</button>
                    <button type="button" className="btn secondary sm" data-testid="final-reject" onClick={() => act('Rejected')}>Reject</button>
                  </>
                )}
              </span>
            )}
            {here && !may && open && <small className="muted">{waitingText || `Waiting for ${stepWho(s, kit.roleName)}`}</small>}
            {open && lastDecided === i && (ss !== 'pending' || (s.decisions || []).length > 0) && !(plan.steps.slice(i + 1).some((x) => (x.decisions || []).length)) && (
              <button type="button" className="link-btn" data-testid={first ? 'ec-undo' : 'plan-undo'} onClick={() => act('Pending')}>Undo</button>
            )}
          </div>
        );
      })}
      {(plan.rules || []).length > 0 && <small className="muted">Rules applied: {plan.rules.join(' · ')}</small>}
      {(plan.overrides || []).map((o, i) => <small key={i} className="muted" data-testid="plan-override-note">Changed for this task by {o.by} on {o.at}: “{o.reason}”</small>)}
      {note && <small className="muted">{note}</small>}
      {open && st.key === 'pending' && kit.canOverride && <button type="button" className="link-btn" data-testid="override-open" onClick={() => setOverride(true)}>Change the approvals for this task</button>}
      {st.key === 'approved' && entry !== undefined && (
        <div className={`ap-step${entry ? ' ok' : ''}`}>
          <span className="ap-title">Payments</span>
          {entry ? <span className="tag blue">Paid · {entry.shortId}</span> : <small className="muted">Approved — now in Payments for the Treasurer to review and pay.</small>}
        </div>
      )}
      {footer}
      {override && <OverrideDialog plan={plan} kit={kit} onClose={() => setOverride(false)} onSave={async (p) => { setOverride(false); await onSave(p); }} />}
    </div>
  );
}
