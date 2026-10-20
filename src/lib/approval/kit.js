// Glue between the pure engine and the app: policies from storage, the person's powers, plan hydration from old-style records.
import { buildPlan, stepState, planState, canDecideNow, decide as engineDecide, legacy, overrideSteps, DEFAULT_STEPS } from './engine.js';

export const parseJson = (s, fallback) => { try { if (s === undefined || s === null || s === '') return fallback; return typeof s === 'string' ? JSON.parse(s) : s; } catch { return fallback; } };
export const normPolicies = (rows) => (rows || []).map((p) => ({ ...p, steps: parseJson(p.steps, []) }));

/** The plan for a record: the stored one, or (for records approved before rules existed) a plan built now with the old decisions laid over it. */
export function hydrate(rec, policies, ctx, shape = 'doc') {
  const stored = parseJson(rec?.plan, null);
  if (stored?.steps?.length) return stored;
  const plan = buildPlan(policies, ctx);
  const ecV = rec?.ecApproval;
  if (ecV === 'Approved' && rec.finalRequired === true && plan.steps.length < 2) plan.steps.push({ id: 's2', name: 'Final approval', approvers: [{ kind: 'group', value: 'Final approvers' }], needed: 1, canFinish: false, deadlineDays: 0, decisions: [] });
  const [first, ...rest] = plan.steps;
  if (ecV === 'Approved' || ecV === 'Rejected') first.decisions.push({ by: rec.ecApprovedBy || '—', at: rec.ecApprovedAt || '', value: ecV, comment: '' });
  if (ecV === 'Approved') {
    if (rec.finalRequired === false) rest.forEach((s) => { s.skipped = true; });
    else {
      const fv = shape === 'ticket' ? rec.treasurerApproval : shape === 'expense' ? (rec.status === 'Approved' || rec.status === 'Paid' ? 'Approved' : rec.status === 'Rejected' ? 'Rejected' : 'Pending') : rec.finalApproval;
      const by = shape === 'ticket' ? rec.treasurerApprovedBy : shape === 'expense' ? rec.approvedBy : rec.finalApprovedBy;
      const at = shape === 'ticket' ? rec.treasurerApprovedAt : shape === 'expense' ? rec.approvedAt : rec.finalApprovedAt;
      if (fv === 'Approved') rest.forEach((s) => { for (let i = 0; i < Math.max(1, s.needed); i += 1) s.decisions.push({ by: i ? `${by} (${i + 1})` : by || '—', at: at || '', value: 'Approved', comment: '' }); });
      else if (fv === 'Rejected' && rest[0]) rest[0].decisions.push({ by: by || '—', at: at || '', value: 'Rejected', comment: '' });
    }
  }
  return plan;
}

/** Fields to store with a plan: the plan itself + the old two-slot mirror every other screen reads. */
export const planFields = (plan, shape) => ({ plan: JSON.stringify(plan), ...legacy(plan, shape) });

export { stepState, planState, canDecideNow, engineDecide, overrideSteps, DEFAULT_STEPS };
