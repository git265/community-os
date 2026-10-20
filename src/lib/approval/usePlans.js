import { useMemo } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../storage/index.js';
import { getPrincipal } from '../security/principal.js';
import { finalApproverRoleIds } from '../../modules/tickets/ticketEngine.js';
import { normPolicies, hydrate, planFields, canDecideNow, planState } from './kit.js';
import { stepEligible, overBudget } from './engine.js';

/** Everything a screen needs to show / decide a rules-driven approval. */
export function useApprovalKit() {
  const { roleId, role, currentUser, roles } = useApp();
  const { records: rawPolicies, save: savePolicy, remove: removePolicy, refresh: refreshPolicies } = useCollection(COLLECTIONS.APPROVAL_POLICIES, 'Approval rules');
  const { records: settingsRows } = useCollection(COLLECTIONS.FINANCE_SETTINGS, 'Finance settings');
  const { records: approverRows } = useCollection(COLLECTIONS.APPROVER_SETTINGS, 'Final Approvers');
  const policies = useMemo(() => normPolicies(rawPolicies), [rawPolicies]);
  const s = settingsRows[0] || {};
  const settings = { skipWithinQuote: !!s.invoiceSkipWithinQuote, separate: !!s.approvalSeparate, allowOverride: s.allowOverride !== false, finalCanDecideEC: s.finalCanDecideEC !== false, tolerancePct: s.invoiceTolerancePct === undefined || s.invoiceTolerancePct === '' ? 5 : Number(s.invoiceTolerancePct) || 0 };
  const finalRoleIds = finalApproverRoleIds(approverRows);
  const me = useMemo(() => ({ ...(getPrincipal() || {}), name: currentUser?.name, roleId, role }), [currentUser, roleId, role]);
  const h = useMemo(() => ({ isEC: () => role?.category === 'EC' && (settings.finalCanDecideEC || roleId === 'super_admin' || !finalRoleIds.includes(roleId)), isFinal: () => roleId === 'super_admin' || finalRoleIds.includes(roleId), isAdmin: () => roleId === 'super_admin' }), [role, roleId, finalRoleIds.join(','), settings.finalCanDecideEC]); // eslint-disable-line react-hooks/exhaustive-deps
  const roleName = (id) => roles.find((r) => r.id === id)?.name || id;
  return {
    me, h, policies, settings, roleName, savePolicy, removePolicy, refreshPolicies, finalRoleIds,
    canOverride: settings.allowOverride && roleId === 'super_admin', // only a Super Admin may change the steps of one task
    planOf: (rec, ctx, shape) => hydrate(rec, policies, ctx, shape),
    mayDecide: (plan, rec) => canDecideNow(plan, me, h, { separate: settings.separate, requester: rec?.recordCreatedBy || rec?.createdBy }),
    eligibleFor: (plan) => { const st = planState(plan); return st.key === 'pending' && stepEligible(st.step, me, h) && !(plan.steps.flatMap((x) => x.decisions || []).some((d) => d.by === me.name && st.step.decisions?.some((y) => y === d))); },
    planFields,
    overBudget: (total, approved) => overBudget(total, approved, settings.tolerancePct),
  };
}
