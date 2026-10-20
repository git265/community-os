// One approval process for money decisions. Task quotations, vendor invoices and cultural-event expenses all wait on the same people:
//   EC members (first step, where a task needs it)  ->  the final approvers set under Maintenance -> Final approvers (default Treasurer + President).
// This builds the single list of "what is waiting for whom"; the decision itself is made where the record lives (the task for quotations and
// invoices, the Approvals page for cultural expenses) so each keeps its own side effects (ledger entry, closing the task, totals, notices).
import { approvalState, invoiceApproval, finalApproverRoleIds } from '../modules/tickets/ticketEngine.js';

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

export function approvalItems({ tickets = [], quotations = [], expenses = [], events = [], taskTypes = [], approverRows = [], releases = [], roleId, isEC, planInfo }) {
  // planInfo(rec) -> { mine, stage } when the record carries rules-driven approval steps (a custom approver can be 'mine' too)
  const pi = (rec, d) => { const x = planInfo && rec?.plan ? planInfo(rec) : null; return x ? { ...d, ...x } : d; };
  const finals = finalApproverRoleIds(approverRows);
  const isFinal = roleId === 'super_admin' || finals.includes(roleId);
  const ec = roleId === 'super_admin' || !!isEC;
  const out = [];
  const live = (t) => t && t.status !== 'Closed' && t.status !== 'Cancelled';
  for (const t of tickets) {
    if (!live(t)) continue;
    const type = taskTypes.find((x) => x.name === t.taskType);
    const st = approvalState(t, type);
    if (st.waitingOn) {
      const stage = st.waitingOn === 'ec' ? 'EC approval' : 'Final approval';
      out.push(pi(t, { id: `t-${t.id}`, kind: 'Task quotation', stage, title: t.title, ref: t.ticketNumber, amount: Number(t.approvedAmount || t.materialsCost) || 0, mine: st.waitingOn === 'ec' ? ec : isFinal, link: `#/ticket/${t.ticketNumber}`, since: t.lastUpdatedAt }));
    }
  }
  for (const d of quotations) {
    if (d.kind !== 'Invoice') continue;
    const t = tickets.find((x) => x.id === d.ticketId);
    if (!live(t)) continue;
    const st = invoiceApproval(d);
    if (st.waitingOn) out.push(pi(d, { id: `i-${d.id}`, kind: 'Vendor invoice', stage: st.waitingOn === 'ec' ? 'EC approval' : 'Final approval', title: `${d.vendor || 'Invoice'} · ${t.title}`, ref: d.shortId || t.ticketNumber, amount: Number(d.amount) || 0, mine: st.waitingOn === 'ec' ? ec : isFinal, link: `#/ticket/${t.ticketNumber}`, since: d.lastUpdatedAt }));
  }
  for (const x of expenses) {
    if (x.status !== 'Pending approval') continue;
    const ev = events.find((e) => e.id === x.eventId);
    out.push(pi(x, { id: `x-${x.id}`, kind: 'Cultural expense', stage: 'Final approval', title: `${x.item}${ev ? ` · ${ev.name}` : ''}`, ref: x.shortId, amount: Number(x.amount) || 0, fund: x.fund, mine: isFinal, link: '#/cultural', expense: x, since: x.lastUpdatedAt }));
  }
  for (const r of releases) {
    if (r.status !== 'Waiting approval') continue;
    if (r.expenseId) {
      const x = expenses.find((e) => e.id === r.expenseId); const ev = events.find((e) => e.id === x?.eventId);
      if (!x || ['Rejected', 'Paid'].includes(x.status)) continue;
      out.push(pi(r, { id: `r-${r.id}`, kind: 'Fund release', stage: 'Approval', title: `Release · ${r.vendor} · ${x.item}${ev ? ` · ${ev.name}` : ''}`, ref: r.shortId || x.shortId, amount: Number(r.amount) || 0, mine: false, link: '#/cultural', since: r.lastUpdatedAt }));
      continue;
    }
    const t = tickets.find((x) => x.id === r.ticketId);
    if (!live(t)) continue;
    out.push(pi(r, { id: `r-${r.id}`, kind: 'Fund release', stage: 'Approval', title: `${r.kind} · ${r.vendor} · ${t.title}`, ref: r.shortId || t.ticketNumber, amount: Number(r.amount) || 0, mine: false, link: `#/ticket/${t.ticketNumber}`, since: r.lastUpdatedAt }));
  }
  return out.sort((a, b) => Number(b.mine) - Number(a.mine) || String(a.since).localeCompare(String(b.since)));
}
export { inr };
