import { todayLocal } from '../../lib/locale.js';
import React, { useEffect, useMemo } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { setSecondStepRoles } from '../../lib/security/authz.js';
import { approvalItems, inr } from '../../lib/approvals.js';
import { recomputeEventTotals } from '../../lib/culturalServer.js';
import { notify } from '../../lib/notify.js';
import { useApprovalKit } from '../../lib/approval/usePlans.js';
import { parseJson } from '../../lib/approval/kit.js';
import { planState, decide as planDecide, stepWho } from '../../lib/approval/engine.js';

/** Everything waiting for approval in one list: task quotations, vendor invoices and cultural expenses. */
export function useApprovals() {
  const { roleId, role } = useApp();
  const { records: tickets } = useCollection(C.TICKETS, 'Maintenance');
  const { records: quotations } = useCollection(C.QUOTATIONS, 'Quotations');
  const { records: expenses } = useCollection(C.CULTURAL_EXPENSES, 'Event Expenses');
  const { records: events } = useCollection(C.CULTURAL_EVENTS, 'Cultural Events');
  const { records: taskTypes } = useCollection(C.TASK_TYPES, 'Task Types');
  const { records: approverRows } = useCollection(C.APPROVER_SETTINGS, 'Approvers');
  const { records: releases } = useCollection(C.RELEASES, 'Fund releases');
  const kit = useApprovalKit();
  useEffect(() => { setSecondStepRoles(approverRows[0]?.roles); }, [approverRows]);
  const planInfo = (rec) => {
    const plan = parseJson(rec.plan, null); if (!plan?.steps?.length) return null;
    const st = planState(plan); if (st.key !== 'pending') return null;
    return { mine: kit.mayDecide(plan, rec), stage: `${st.step.name} · ${stepWho(st.step, kit.roleName)}` };
  };
  return useMemo(() => approvalItems({ tickets, quotations, expenses, events, taskTypes, approverRows, releases, roleId, isEC: role?.category === 'EC', planInfo }), [tickets, quotations, expenses, events, taskTypes, approverRows, releases, roleId, role, kit.me, kit.policies]); // eslint-disable-line react-hooks/exhaustive-deps
}

export default function ApprovalsPanel({ onNavigate, limit, compact }) {
  const { currentUser } = useApp();
  const items = useApprovals();
  const kit = useApprovalKit();
  const { records: allEvents } = useCollection(C.CULTURAL_EVENTS, 'Cultural Events');
  const { save: saveExpense } = useCollection(C.CULTURAL_EXPENSES, 'Event Expenses');
  const mine = items.filter((i) => i.mine);
  const rows = (limit ? items.slice(0, limit) : items);

  async function decide(it, status) {
    const x = it.expense;
    let note = '';
    if (status === 'Rejected') note = window.prompt('Reason for rejecting (shown to the committee):', '') || '';
    const ev = allEvents.find((e) => e.id === x.eventId);
    const needs = !(Number(ev?.finalOver) > 0) || Number(x.amount) > Number(ev.finalOver);
    const res = planDecide(kit.planOf(x, { subject: 'Cultural expense', amount: Number(x.amount) || 0, category: x.category, taskType: '', flags: needs ? ['eventFinal'] : [] }, 'expense'), currentUser?.name || '', status, { comment: note });
    if (res.error) return;
    const ps = planState(res.plan).key;
    const out = await saveExpense({ ...x, ...kit.planFields(res.plan, 'expense'), status: ps === 'pending' ? 'Pending approval' : status, ...(ps === 'pending' ? {} : { approvedBy: currentUser?.name || '', approvedAt: todayLocal(), approvalNote: note }) });
    if (!out) return;
    await recomputeEventTotals(x.eventId);
    notify({ event: 'cultural', title: `Expense ${status.toLowerCase()} · ${x.item}`, body: `${currentUser?.name || 'The approver'} ${status.toLowerCase()} ${inr(x.amount)} for “${x.item}”${note ? ` — ${note}` : ''}.`, link: `#/cultural/expense/${x.id}`, toRoleIds: ['committee_cultural', 'president', 'general_secretary'], by: currentUser?.name || '' }).catch(() => {});
  }
  function open(it) {
    window.dispatchEvent(new CustomEvent('communityos:openlink', { detail: { link: it.link } }));
  }

  return (
    <div data-testid="approvals">
      {!compact && <div className="grid metrics" style={{ marginBottom: 12 }}>
        <div className="card metric"><div className="label">Waiting for you</div><div className="value" data-testid="ap-mine">{mine.length}</div></div>
        <div className="card metric"><div className="label">Waiting on others</div><div className="value">{items.length - mine.length}</div></div>
        <div className="card metric"><div className="label">Total value</div><div className="value">{inr(items.reduce((s, i) => s + i.amount, 0))}</div></div>
      </div>}
      {rows.length === 0 ? <div className="empty" data-testid="ap-empty">Nothing is waiting for approval.</div> : (
        <ul className="list">
          {rows.map((it) => (
            <li key={it.id} data-testid="ap-row" style={{ alignItems: 'flex-start' }}>
              <span style={{ flex: 1 }}>
                <span className={`tag ${it.kind === 'Cultural expense' ? 'purple' : it.kind === 'Vendor invoice' ? 'blue' : 'orange'}`}>{it.kind}</span> <b>{it.title}</b>
                <br /><small className="muted">{it.ref ? `${it.ref} · ` : ''}{inr(it.amount)}{it.fund ? ` · ${it.fund} fund` : ''} · </small><span className={`tag ${it.mine ? 'orange' : ''}`}>{it.stage}{it.mine ? ' — you' : ''}</span>
              </span>
              <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {it.expense && it.mine && <><button type="button" className="btn good sm" data-testid="ap-approve" onClick={() => decide(it, 'Approved')}>Approve</button><button type="button" className="btn danger sm" data-testid="ap-reject" onClick={() => decide(it, 'Rejected')}>Reject</button></>}
                <button type="button" className="btn secondary sm" data-testid="ap-open" onClick={() => open(it)}>{it.expense ? 'Open' : 'Review'}</button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {limit && items.length > limit && onNavigate && <button type="button" className="link-btn" onClick={() => onNavigate('approvals')}>View all {items.length} ›</button>}
    </div>
  );
}
