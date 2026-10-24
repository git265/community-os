import { todayLocal } from '../locale.js';
// The approval engine: rules decide WHO must approve a thing, in what order; the thing keeps a frozen copy ("plan") of those steps.
//
//   policy  = a community-written rule: when [subject, amount range, category, task type, flag] -> steps
//   plan    = the steps for ONE record (invoice, quotation, release, expense), built from every matching policy; decisions are recorded on it
//   every matching policy applies: their steps are joined in rule-priority order, and identical approver sets are merged into one step
//
// Pure functions only (no storage, no React) so authz.js can use them to check a decision server-side, and a Spring Boot service can port them 1:1.
// The old two-slot fields (ecApproval / finalApproval ...) are kept in step by legacy() so Payments, closing rules and reports keep working.

export const SUBJECTS = ['Maintenance quotation', 'Maintenance invoice', 'Maintenance release', 'Cultural expense', 'Cultural release'];
export const GROUPS = ['EC members', 'Final approvers'];
export const FLAGS = [
  { value: '', label: 'Always' },
  { value: 'overBudget', label: 'Only when the invoice is above the approved amount (beyond tolerance)' },
  { value: 'eventFinal', label: 'Only when the event’s “final approval over” limit is crossed' },
];
export const DEFAULT_STEPS = () => [
  { id: 's1', name: 'EC', approvers: [{ kind: 'group', value: 'EC members' }], needed: 1, canFinish: true, deadlineDays: 0 },
  { id: 's2', name: 'Final approval', approvers: [{ kind: 'group', value: 'Final approvers' }], needed: 1, canFinish: false, deadlineDays: 0 },
];
const todayIso = () => todayLocal();
const keyOf = (s) => JSON.stringify([...s.approvers].map((a) => `${a.kind}:${a.value}`).sort());

/* ------------------------------------------------------------------ matching -- */
export function matches(policy, ctx) {
  if (!policy || policy.active === false) return false;
  const subjects = policy.subjects || [];
  if (subjects.length && !subjects.includes(ctx.subject)) return false;
  const a = Number(ctx.amount) || 0;
  if (Number(policy.minAmount) > 0 && a < Number(policy.minAmount)) return false;
  if (Number(policy.maxAmount) > 0 && a > Number(policy.maxAmount)) return false;
  const cats = policy.categories || [];
  if (cats.length && !cats.includes(ctx.category)) return false;
  const tts = policy.taskTypes || [];
  if (tts.length && !tts.includes(ctx.taskType)) return false;
  if (policy.requireFlag && !(ctx.flags || []).includes(policy.requireFlag)) return false;
  return true;
}
export const matching = (policies, ctx) => (policies || []).filter((p) => matches(p, ctx)).sort((x, y) => (Number(x.priority) || 100) - (Number(y.priority) || 100) || String(x.name).localeCompare(String(y.name)));

/** Build the plan for one record from every matching policy (steps joined, identical approver sets merged). No match -> EC then final approvers. */
export function buildPlan(policies, ctx) {
  const used = matching(policies, ctx);
  const steps = [];
  const seen = new Map();
  for (const p of used) {
    for (const st of p.steps || []) {
      if (!st.approvers?.length) continue;
      const k = keyOf(st);
      if (seen.has(k)) { const ex = seen.get(k); ex.needed = Math.max(ex.needed, Number(st.needed) || 1); continue; }
      const s = { id: `s${steps.length + 1}`, name: st.name || 'Approval', approvers: st.approvers.map((a) => ({ ...a })), needed: Math.max(1, Number(st.needed) || 1), canFinish: !!st.canFinish, deadlineDays: Number(st.deadlineDays) || 0, decisions: [] };
      seen.set(k, s); steps.push(s);
    }
  }
  const final = steps.length ? steps : DEFAULT_STEPS().map((s) => ({ ...s, decisions: [] }));
  return { version: 1, built: todayIso(), rules: used.map((p) => p.name), amount: Number(ctx.amount) || 0, steps: final, overrides: [] };
}

/* --------------------------------------------------------------------- state -- */
export function stepState(step) {
  if (step.skipped) return 'skipped';
  const ds = step.decisions || [];
  if (ds.some((d) => d.value === 'Rejected')) return 'rejected';
  const ok = new Set(ds.filter((d) => d.value === 'Approved').map((d) => d.by));
  return ok.size >= (Number(step.needed) || 1) ? 'approved' : 'pending';
}
/** { key: 'approved'|'rejected'|'pending', index, step } - the step now waiting (or the one that rejected). */
export function planState(plan) {
  if (!plan?.steps?.length) return { key: 'none', index: -1, step: null };
  for (let i = 0; i < plan.steps.length; i += 1) {
    const s = stepState(plan.steps[i]);
    if (s === 'rejected') return { key: 'rejected', index: i, step: plan.steps[i] };
    if (s === 'pending') return { key: 'pending', index: i, step: plan.steps[i] };
  }
  return { key: 'approved', index: plan.steps.length, step: null };
}
export const decidedBy = (step) => [...new Set((step.decisions || []).filter((d) => d.value === 'Approved').map((d) => d.by))];

/* ------------------------------------------------------------------ who may act -- */
/** h = { isEC(p), isFinal(p), isAdmin(p) } supplied by the caller (UI and authz each know their principal). */
export function approverMatches(a, p, h) {
  if (!p) return false;
  if (a.kind === 'group') return a.value === 'EC members' ? !!h.isEC(p) : a.value === 'Final approvers' ? !!h.isFinal(p) : false;
  if (a.kind === 'role') return p.roleId === a.value || (Array.isArray(p.extraRoleIds) && p.extraRoleIds.includes(a.value));
  if (a.kind === 'user') return p.name === a.value;
  return false;
}
export const stepEligible = (step, p, h) => !!step && (!!h.isAdmin(p) || step.approvers.some((a) => approverMatches(a, p, h)));

/** Can this person decide the plan's current step right now? (own-request and repeat-approver rules are the caller's choice via opts) */
export function canDecideNow(plan, p, h, opts = {}) {
  const st = planState(plan);
  if (st.key !== 'pending') return false;
  if (!stepEligible(st.step, p, h)) return false;
  if (decidedBy(st.step).includes(p.name)) return false; // one approval per person per step
  if (opts.separate && !h.isAdmin(p)) {
    if (plan.steps.some((s) => s !== st.step && (s.decisions || []).some((d) => d.by === p.name && d.value === 'Approved'))) return false;
    if (opts.requester && opts.requester === p.name) return false;
  }
  return true;
}

/* --------------------------------------------------------------------- decide -- */
export function decide(plan, actor, value, { comment = '', finish = false, at = todayIso() } = {}) {
  const st = planState(plan);
  const next = JSON.parse(JSON.stringify(plan));
  if (value === 'Pending') { // undo the latest decision, only while nothing after it has been decided
    for (let i = next.steps.length - 1; i >= 0; i -= 1) {
      const s = next.steps[i]; const ds = s.decisions || [];
      if (ds.length) { const idx = ds.map((d) => d.by).lastIndexOf(actor); if (idx < 0) return { error: 'Only the person who decided can undo it' }; ds.splice(idx, 1); for (let j = i + 1; j < next.steps.length; j += 1) delete next.steps[j].skipped; delete s.skipped; return { plan: next }; }
    }
    return { error: 'Nothing to undo' };
  }
  if (st.key !== 'pending') return { error: st.key === 'approved' ? 'Already approved' : 'Already rejected' };
  const s = next.steps[st.index];
  s.decisions = [...(s.decisions || []), { by: actor, at, value, comment }];
  if (value === 'Approved' && finish && s.canFinish && stepState(s) === 'approved') for (let j = st.index + 1; j < next.steps.length; j += 1) next.steps[j].skipped = true;
  return { plan: next };
}

/** Replace the not-yet-decided steps (a one-time change for this record), with a reason. Decided steps stay exactly as they are. */
export function overrideSteps(plan, newSteps, reason, actor, at = todayIso()) {
  if (!String(reason || '').trim()) return { error: 'Give a reason for changing the approvals' };
  const keep = plan.steps.filter((s) => (s.decisions || []).length);
  if (keep.some((s, i) => plan.steps[i] !== s)) return { error: 'Only steps that have not been decided yet can be changed' };
  const fresh = newSteps.filter((s) => s.approvers?.length).map((s, i) => ({ id: `s${keep.length + i + 1}`, name: s.name || 'Approval', approvers: s.approvers, needed: Math.max(1, Number(s.needed) || 1), canFinish: !!s.canFinish, deadlineDays: Number(s.deadlineDays) || 0, decisions: [] }));
  if (!fresh.length && !keep.length) return { error: 'Keep at least one approval step' };
  const next = { ...plan, steps: [...keep.map((s) => ({ ...s })), ...fresh], overrides: [...(plan.overrides || []), { by: actor, at, reason: String(reason).trim(), before: plan.steps.slice(keep.length).map((s) => ({ name: s.name, approvers: s.approvers })) }] };
  return { plan: next };
}

/* --------------------------------------------------------------- legacy mirror -- */
const lastOf = (steps) => { const ds = steps.flatMap((s) => (s.decisions || []).filter((d) => d.value !== 'Pending')); return ds.length ? ds[ds.length - 1] : null; };
/**
 * The two-slot fields the rest of the app reads: step 1 = "EC" slot, every later step together = "final" slot.
 * shape: 'doc' (quotations/invoices: finalApproval*), 'ticket' (treasurerApproval*), 'expense' (cultural: status + approvedBy).
 */
export function legacy(plan, shape = 'doc') {
  const [first, ...rest] = plan.steps;
  const f = stepState(first);
  const live = rest.filter((s) => !s.skipped);
  const ecL = lastOf([first]);
  const ec = f === 'approved' ? 'Approved' : f === 'rejected' ? 'Rejected' : 'Pending';
  const restStates = live.map(stepState);
  const fin = !live.length ? 'Pending' : restStates.some((s) => s === 'rejected') ? 'Rejected' : restStates.every((s) => s === 'approved') ? 'Approved' : 'Pending';
  const finL = lastOf(live);
  const finalRequired = ec !== 'Approved' ? null : live.length > 0;
  const base = { ecApproval: ec, ecApprovedBy: ec === 'Pending' ? '' : ecL?.by || '', ecApprovedAt: ec === 'Pending' ? '' : ecL?.at || '', finalRequired };
  if (shape === 'ticket') return { ...base, treasurerApproval: fin, treasurerApprovedBy: fin === 'Pending' ? '' : finL?.by || '', treasurerApprovedAt: fin === 'Pending' ? '' : finL?.at || '' };
  if (shape === 'expense') return base;
  return { ...base, finalApproval: fin, finalApprovedBy: fin === 'Pending' ? '' : finL?.by || '', finalApprovedAt: fin === 'Pending' ? '' : finL?.at || '' };
}

/* --------------------------------------------------------------------- display -- */
export const approverLabel = (a, roleName = (x) => x) => (a.kind === 'group' ? a.value : a.kind === 'role' ? roleName(a.value) : a.value);
export const stepWho = (step, roleName) => step.approvers.map((a) => approverLabel(a, roleName)).join(' or ') + ((Number(step.needed) || 1) > 1 ? ` (any ${step.needed})` : '');
export function describePolicy(p, roleName) {
  const bits = [];
  bits.push((p.subjects || []).length ? p.subjects.join(' / ') : 'Anything');
  if (Number(p.minAmount) > 0 || Number(p.maxAmount) > 0) bits.push(`₹${Number(p.minAmount) || 0} – ${Number(p.maxAmount) > 0 ? `₹${Number(p.maxAmount)}` : 'no limit'}`);
  if ((p.categories || []).length) bits.push(`category ${p.categories.join(', ')}`);
  if ((p.taskTypes || []).length) bits.push(`task type ${p.taskTypes.join(', ')}`);
  if (p.requireFlag) bits.push(FLAGS.find((f) => f.value === p.requireFlag)?.label?.toLowerCase() || p.requireFlag);
  return `${bits.join(' · ')} → ${(p.steps || []).map((s, i) => `${i + 1}. ${stepWho(s, roleName)}`).join('  ')}`;
}

/** Invoice vs approved amount: is it over, beyond a percentage tolerance? */
export const overBudget = (invoiceTotal, approved, tolerancePct = 0) => Number(approved) > 0 && Number(invoiceTotal) > Number(approved) * (1 + (Number(tolerancePct) || 0) / 100) + 0.5;
