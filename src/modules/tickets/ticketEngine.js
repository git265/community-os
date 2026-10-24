// Pure helpers for the generic Task/Ticket engine. Kept out of
// TicketsModule.jsx so the workflow rules (who can create what, which
// statuses follow which, who's eligible to Accept, who's allowed to see a
// given ticket) are testable and readable in one place.

export const CORE_STATUSES = ['Open', 'Assigned', 'In Progress', 'On Hold', 'Completed', 'Closed'];

/** "Handyman · Plumbing" -> "Plumbing". Returns null for non-handyman roles. */
export function tradeFromRoleName(name) {
  const parts = (name || '').split('·');
  return parts.length > 1 ? parts[1].trim() : null;
}

// Ticket numbers (TKT-1058) are issued by secureStorage on create - see nextShortId there.

// Who a new maintenance ticket goes to (the next free technician of its category, or the queue): src/lib/ticketQueue.js and the server.

/** Staff allocated to a category (the team that shares its queue). */
export const teamFor = (handymen, category) => handymen.filter((h) => h.trade === category);

/** A ticket can be taken over by another member of the same category while it is still Open or only Assigned (work not started). */
export const canTakeOver = (ticket, me) => !!ticket && !!me && (ticket.status === 'Open' || ticket.status === 'Assigned') && ticket.assignedTo !== me.name;

/** Which TaskTypes a role is allowed to raise, per its `creatorScope`. */
// Within Facility Staff only the Facility Manager and MEP can create tasks;
// the other handyman trades just work the tickets assigned to them.
const STAFF_CREATORS = ['facility_manager', 'handyman_mep'];

export function creatableTaskTypes(taskTypes, role) {
  if (!role) return [];
  if (role.category === 'Staff' && !STAFF_CREATORS.includes(role.id)) return [];
  return taskTypes.filter((tt) => {
    if (tt.creatorScope === 'Anyone') return true;
    if (tt.creatorScope === 'Resident') return role.category === 'Resident';
    if (tt.creatorScope === 'EC / Staff') return role.category === 'EC' || role.category === 'Staff';
    return false;
  });
}

/** A financial stage is shown whenever its TaskType config isn't 'No'. */
export function stageApplies(stageValue) {
  return stageValue === 'Yes' || stageValue === 'Optional';
}

/**
 * Approval chain for one task: EC first, then Treasurer. A step is *required*
 * when the task type says "Yes" or the task is flagged financial; it is merely
 * *available* when the type says "Optional". Flagging a task financial therefore
 * always brings the approval chain in, whatever the task type.
 */
/** One invoice's approval: EC first, then a final approver. waitingOn: 'ec' | 'final' | null. */
export function invoiceApproval(doc) {
  if (!doc) return { key: 'none', label: '', tone: '', waitingOn: null };
  if (doc.selected === false) return { key: 'unselected', label: 'Not selected', tone: '', waitingOn: null };
  if (doc.approvalWaived) return { key: 'approved', label: 'Pre-approved (within quotation)', tone: 'green', waitingOn: null };
  if (doc.ecApproval === 'Rejected') return { key: 'rejected', label: 'Rejected by EC', tone: 'red', waitingOn: null };
  if (doc.finalApproval === 'Rejected') return { key: 'rejected', label: 'Rejected at final approval', tone: 'red', waitingOn: null };
  if (doc.ecApproval !== 'Approved') return { key: 'pending-ec', label: 'Awaiting EC', tone: 'orange', waitingOn: 'ec' };
  // the EC may make its own approval the last step (finalRequired === false): nothing goes to the Treasurer
  if (doc.finalRequired === false) return { key: 'approved', label: 'Approved by EC (last step)', tone: 'green', waitingOn: null };
  if (doc.finalApproval !== 'Approved') return { key: 'pending-final', label: 'Awaiting final approval', tone: 'orange', waitingOn: 'final' };
  return { key: 'approved', label: 'Approved', tone: 'green', waitingOn: null };
}

/** The ticket may close itself when it has invoices and every one is fully approved (and any selected quotation is approved). */
export function readyToClose(ticket, invoices, advance) {
  if (advance && advance.settled === false) return false; // advances paid but the invoices do not cover them yet
  const active = invoices.filter((d) => d.selected !== false);
  if (!active.length || !active.every((d) => invoiceApproval(d).key === 'approved')) return false;
  const q = approvalState(ticket, null);
  return q.key === 'none' || q.key === 'approved';
}

/** Roles set as final approvers (falls back to Treasurer + President until the setting loads). */
export const finalApproverRoleIds = (records) => {
  const r = records?.[0]?.roles;
  return Array.isArray(r) && r.length ? r : ['treasurer', 'president'];
};

export function approvalSteps(ticket, type) {
  const fin = !!ticket?.financial;
  const ecReq = type?.ecApprovalStage === 'Yes' || fin;
  const trReq = type?.treasurerStage === 'Yes' || fin;
  // Every task can be put through the EC -> Treasurer chain; "required" decides whether it blocks / is chased.
  return { ec: true, treasurer: true, ecRequired: ecReq, treasurerRequired: trReq };
}

/** Where the task is in its approval chain: { key, label, tone, waitingOn: 'ec' | 'treasurer' | null }. */
export function approvalState(ticket, type) {
  // the task-level chain approves the selected QUOTATION; every invoice carries its own approval (see invoiceApproval)
  if (!ticket || !ticket.selectedQuotationId) return { key: 'none', label: '', tone: '', waitingOn: null };
  const st = approvalSteps(ticket, type);
  if (ticket.ecApproval === 'Rejected') return { key: 'rejected', label: 'Rejected by EC', tone: 'red', waitingOn: null };
  if (ticket.treasurerApproval === 'Rejected') return { key: 'rejected', label: 'Rejected at final approval', tone: 'red', waitingOn: null };
  const live = ticket.status !== 'Closed' && ticket.status !== 'Cancelled';
  const ecOk = ticket.ecApproval === 'Approved';
  const trOk = ticket.treasurerApproval === 'Approved';
  if (st.ecRequired && !ecOk) return { key: 'pending-ec', label: 'Awaiting EC', tone: 'orange', waitingOn: live ? 'ec' : null };
  if (ecOk && ticket.finalRequired === false) return { key: 'approved', label: 'Approved by EC (last step)', tone: 'green', waitingOn: null };
  if (st.treasurerRequired && !trOk) return { key: 'pending-treasurer', label: 'Awaiting final approval', tone: 'orange', waitingOn: live ? 'treasurer' : null };
  if (ecOk || trOk) return { key: 'approved', label: 'Approved', tone: 'green', waitingOn: null };
  return { key: 'none', label: '', tone: '', waitingOn: null };
}

/**
 * Tickets a given session is allowed to see. Residents/owners are scoped to
 * their own villa and only to task types marked `residentVisible` - the
 * internal EC/FM workflow (quotations, invoices, Treasurer approvals, other
 * villas' tickets) never reaches them. Everyone else (EC/Staff/handymen)
 * sees everything; handyman-specific trade filtering happens separately in
 * TicketsModule since it also drives the "accept" queue, not just read access.
 */
export function visibleTicketsFor(tickets, taskTypes, { role, currentUser }) {
  if (role?.category !== 'Resident') return tickets;
  const myUnit = currentUser?.unit;
  return tickets.filter((t) => {
    if (myUnit && t.unit !== myUnit && t.scope !== 'Community') return false;
    const tt = taskTypes.find((x) => x.name === t.taskType);
    return tt ? tt.residentVisible : true;
  });
}

/** Comments a given session is allowed to see: Internal is EC/Staff/field-staff only. */
export function visibleCommentsFor(comments, ticketId, { isFieldStaff }) {
  return comments
    .filter((c) => c.ticketId === ticketId)
    .filter((c) => c.visibility !== 'Internal' || isFieldStaff)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

/** Owner may edit their own ticket's description for 30 minutes after raising it. */
export const EDIT_WINDOW_MS = 30 * 60 * 1000;
export function withinEditWindow(ticket, now = Date.now()) {
  const created = ticket?.recordCreatedAt || ticket?.createdAtIso;
  if (!created) return false;
  return now - new Date(created).getTime() < EDIT_WINDOW_MS;
}

/** Internal tasks = types created by EC / Facility Manager / MEP (creatorScope 'EC / Staff'). */
export const isInternalType = (taskType) => taskType?.creatorScope === 'EC / Staff';

/**
 * Who an internal task may be assigned to: EC members and vendors only - never
 * owners/residents or facility staff (handymen). Enforced again in
 * secureStorage.put so it can't be bypassed from the UI.
 */
export function internalAssigneePool({ ecRoles = [] }) {
  return ecRoles
    .map((r) => ({ value: r.personName || r.roleTitle, label: r.personName ? `${r.personName} · ${r.roleTitle}` : `${r.roleTitle} (vacant)`, kind: 'EC' }))
    .filter((o) => o.value);
}

/** Role ids a Category-coverage row says coordinate it (older rows stored a text label instead of a list). */
export const coordinatorRoleIds = (row) => (Array.isArray(row?.coordinator) ? row.coordinator : []);

/** Active users holding any of the roles that coordinate this category, as { value, label } options. */
export function coordinatorUsers({ row, users = [], roles = [] }) {
  const ids = new Set(coordinatorRoleIds(row));
  if (!ids.size) return [];
  const ecGroup = ids.has('group:EC');
  const inGroup = (r) => ecGroup && roles.find((x) => x.id === r)?.category === 'EC';
  return users
    .filter((u) => u.status !== 'Inactive')
    .map((u) => ({ u, rid: [u.roleId, ...(Array.isArray(u.extraRoleIds) ? u.extraRoleIds : [])].find((r) => ids.has(r) || inGroup(r)) }))
    .filter((x) => x.rid)
    .map(({ u, rid }) => ({ value: u.name, label: `${u.name} · ${roles.find((r) => r.id === rid)?.name || rid}` }));
}

/**
 * "Assign to" list for a category, from the Category Coverage table: the people in the roles that coordinate that category (e.g. the Facility Manager / MEP users).
 * Resident tickets also list the clocked-in field staff of the matching trade.
 * Returns { options:[{value,label}], row, fallback }.
 */
export function assigneesForCategory({ category, internal, coverage = [], vendors = [], ecRoles = [], handymen = [], users = [], roles = [] }) {
  const row = coverage.find((c) => c.category === category) || null;
  if (!category) return { options: [], row: null, fallback: false };
  const people = coordinatorUsers({ row, users, roles });
  const uniq = (list) => list.filter((o, i) => list.findIndex((x) => x.value === o.value) === i);
  if (internal) {
    const options = [];
    options.push(...people);
    if (options.length) return { options: uniq(options), row, fallback: false };
    return { options: internalAssigneePool({ ecRoles }).map((o) => ({ value: o.value, label: o.label })), row, fallback: true };
  }
  let names = handymen.filter((h) => h.trade === category).map((h) => h.name);
  const fallback = names.length === 0 && people.length === 0;
  if (names.length === 0 && people.length === 0) names = handymen.map((h) => h.name);
  return { options: uniq([...names.map((n) => ({ value: n, label: n })), ...people]), row, fallback };
}

export const GST_RATES = [5, 12, 18, 28];
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Split an invoice amount into taxable value, GST and total.
 *  - 'None'     : no GST (amount is the total).
 *  - 'Included' : the amount already contains GST at `rate`%.
 *  - 'Extra'    : the amount is before GST; GST is added on top.
 */
export function gstSplit(amount, mode, rate) {
  const a = Number(amount) || 0;
  const r = (Number(rate) || 0) / 100;
  if (mode === 'Included' && r > 0) { const base = r2(a / (1 + r)); return { base, gst: r2(a - base), total: r2(a) }; }
  if (mode === 'Extra' && r > 0) { const gst = r2(a * r); return { base: r2(a), gst, total: r2(a + gst) }; }
  return { base: r2(a), gst: 0, total: r2(a) };
}

/** Format an ISO SLA date for display; legacy free-text values pass through. */
export function slaLabel(v) {
  if (!v) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  return v;
}

/**
 * A ledger (Payments Cross-check) entry pre-filled from a financial task, for the treasurer to review.
 * With an invoice under approval the entry carries its number, taxable value and the GST input credit.
 */
export function ledgerEntryForTask(ticket, vendorName, invoice) {
  const entry = {
    date: new Date().toISOString().slice(0, 10),
    account: '',
    description: `${ticket.ticketNumber} · ${ticket.title}`,
    type: 'Debit',
    amount: Number(invoice?.amount) || Number(ticket.approvedAmount) || Number(ticket.materialsCost) || 0,
    vendor: vendorName || invoice?.vendor || ticket.assignedTo || '',
    category: ticket.category || '',
    taskRef: ticket.ticketNumber,
    module: 'Maintenance', sourceType: invoice ? 'invoice' : 'task', sourceLabel: `${ticket.ticketNumber} · ${ticket.title}`, mode: 'Bank transfer', reconStatus: 'Unreconciled',
    attachments: [],
  };
  if (invoice) Object.assign(entry, { baseAmount: Number(invoice.baseAmount) || entry.amount, gstRate: Number(invoice.gstRate) || 0, gstAmount: Number(invoice.gstAmount) || 0 });
  return entry;
}

export const todayIso = () => new Date().toISOString().slice(0, 10);

/** SLA chip for lists and the ticket header: { tone: 'late' | 'soon' | 'ok' | 'none', text }. Finished tickets never show as late. */
export function slaInfo(v, status) {
  if (!v) return { tone: 'none', text: 'No SLA' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return { tone: 'none', text: v };
  const days = Math.round((new Date(`${v}T00:00:00`) - new Date(`${todayIso()}T00:00:00`)) / 86400000);
  const date = new Date(`${v}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  if (['Closed', 'Cancelled', 'Completed'].includes(status)) return { tone: 'none', text: date };
  if (days < 0) return { tone: 'late', text: `${date} · ${-days}d overdue` };
  if (days === 0) return { tone: 'soon', text: `${date} · due today` };
  if (days <= 2) return { tone: 'soon', text: `${date} · in ${days}d` };
  return { tone: 'ok', text: `${date} · in ${days}d` };
}
