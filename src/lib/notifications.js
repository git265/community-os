// Ticket notifications (simulated push).
//
// Server side (secureStorage.put on tickets) calls `notifyTicketChange`, which stores one row per recipient in the
// `notifications` collection: when a ticket is ASSIGNED the assignee is told, when its STATUS changes the owner is told.
// The client shows them in the bell, as a phone-style push banner, and (if the browser allows) as a real OS notification.
// Every notification carries a DEEP LINK (`#/ticket/TKT-1055`) - tapping it opens that exact ticket, which is exactly what a
// native push payload would carry (`data: { url }`) once the Spring Boot + FCM/APNs backend replaces this simulation.
import { storage } from './storage/index.js';
import { getPrincipal } from './security/principal.js';
import { notificationForMe } from './security/authz.js';
import { uuid } from './uuid.js';
import { notify, getMyPrefs } from './notify.js';
import { approvalState, invoiceApproval, finalApproverRoleIds } from '../modules/tickets/ticketEngine.js';

export const NOTIFICATIONS = 'notifications';
export const ticketLink = (ticketNumber) => `#/ticket/${ticketNumber}`;

/** Is this row addressed to the signed-in person? (by name, by role for staff, by villa for residents) */
export function isForMe(n, p = getPrincipal()) {
  return notificationForMe(n, p); // the same rule scopes the server's reads (lib/security/authz.js)
}

export async function listMine() {
  const p = getPrincipal();
  const [rows, prefs] = await Promise.all([storage.list(NOTIFICATIONS), p?.name ? getMyPrefs(p.name).catch(() => null) : null]);
  const muted = new Set(prefs?.muted || []);   // the kinds this person muted (news only: forum, polls, cultural, brochure, calendar)
  return rows.filter((n) => isForMe(n, p) && !muted.has(n.event)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function pushNotification(row) { return save(row); }

/** Many notifications in one write (a reminder run or an announcement to 2,000 units). Only the first few raise a push banner. */
export async function pushNotifications(rows) {
  if (!rows.length) return [];
  const saved = await storage.putMany(NOTIFICATIONS, rows);
  rows.slice(0, 5).forEach((row) => window.dispatchEvent(new CustomEvent('communityos:notify', { detail: { notification: row } })));
  window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: NOTIFICATIONS } }));
  return saved;
}

async function save(row) {
  const saved = await storage.put(NOTIFICATIONS, row);
  window.dispatchEvent(new CustomEvent('communityos:notify', { detail: { notification: row } }));
  return saved;
}

export async function markRead(id) {
  const row = (await storage.list(NOTIFICATIONS)).find((n) => n.id === id);
  if (row && !row.read) await storage.put(NOTIFICATIONS, { ...row, read: true });
  window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: NOTIFICATIONS } }));
}

export async function markAllRead() {
  const mine = (await storage.list(NOTIFICATIONS)).filter((n) => isForMe(n) && !n.read);
  for (const n of mine) await storage.put(NOTIFICATIONS, { ...n, read: true });
  window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: NOTIFICATIONS } }));
}

/** The team that hands out work: told about new requests and about a finished request that came back. */
const DISPATCH = ['facility_manager', 'helpdesk'];
const DONE = ['Completed', 'Closed', 'Cancelled'];

/**
 * Called after a ticket is saved. `old` is the previous row (null on create), `next` the saved one, `actor` the principal.
 * Only the people concerned with the ticket hear about it, each by name:
 *  - assignment                 -> the new assignee; the one it was taken from
 *  - status change              -> the person who raised it and the assignee; on a community request that is done, the villas that said
 *                                  "me too"; on a reopen, the dispatch team (it needs someone again)
 *  - priority / SLA date change -> the assignee (the SLA date also the person who raised it)
 * The person who made the change is never notified about it.
 */
export async function notifyTicketChange({ old, next, actor, users = [], roles = [] }) {
  const out = [];
  const base = { ticketId: next.id, ticketNumber: next.ticketNumber, ticketTitle: next.title, link: ticketLink(next.ticketNumber), read: false, createdAt: new Date().toISOString(), by: actor?.name || '' };
  const mine = (row) => (row.toName ? row.toName === actor?.name : (row.toRoleIds || []).includes(actor?.roleId) || (!!row.toUnit && row.toUnit === actor?.unit));
  const by = actor?.name ? ` (${actor.name})` : '';

  if (!old && next.scope === 'Community') {
    const ids = roles.filter((r) => ['facility_manager', 'handyman_mep', 'helpdesk'].includes(r.id)).map((r) => r.id);
    out.push({
      ...base, kind: 'community', event: 'ticket_assigned', toRoleIds: ids,
      title: `Community request · ${next.ticketNumber}`, body: `${next.title} — ${next.location || 'common area'}, raised by ${next.createdBy || 'a resident'} (${next.unit}).`,
    });
  }
  if (old && next.scope === 'Community' && (next.affectedUnits || []).length > (old.affectedUnits || []).length) {
    const ids = roles.filter((r) => ['facility_manager', 'handyman_mep', 'helpdesk'].includes(r.id)).map((r) => r.id);
    out.push({
      ...base, kind: 'community', event: 'ticket_assigned', toRoleIds: ids,
      title: `${next.ticketNumber}: ${(next.affectedUnits || []).length} villas affected`, body: `${next.title} — ${next.location || 'common area'}: another resident said “me too”.`,
    });
  }
  // the assignee by name only (not everyone in their trade), and told even when the person assigning has the same role
  if (next.assignedTo && next.assignedTo !== old?.assignedTo) {
    out.push({
      ...base, kind: 'assigned', event: 'ticket_assigned', toName: next.assignedTo,
      title: `New task assigned · ${next.ticketNumber}`, body: `${next.title} was assigned to you${actor?.name ? ` by ${actor.name}` : ''}.`,
    });
  }
  if (old?.assignedTo && old.assignedTo !== next.assignedTo) {
    out.push({
      ...base, kind: 'assigned', event: 'ticket_assigned', toName: old.assignedTo,
      title: `${next.ticketNumber} is no longer yours`, body: `${next.title} was ${next.assignedTo ? `given to ${next.assignedTo}` : 'taken off you'}${by}.`,
    });
  }
  if (old && next.status !== old.status) {
    const msg = { ...base, kind: 'status', event: 'ticket_status', title: `${next.ticketNumber} is now ${next.status}`, body: `${next.title}: ${old.status} → ${next.status}${by}.` };
    // the assignee, unless this same save gave them the ticket (they were just told of the assignment)
    const people = [...new Set([next.createdBy, next.assignedTo === old.assignedTo ? next.assignedTo : ''].filter(Boolean))];
    people.forEach((nm) => out.push({ ...msg, toName: nm }));
    if (next.scope === 'Community' && DONE.includes(next.status)) {
      const raiserUnit = next.unit;
      [...new Set(next.affectedUnits || [])].filter((u) => u && u !== raiserUnit).forEach((u) => out.push({ ...msg, toUnit: u, body: `${next.title} — the request your villa joined is now ${next.status}.` }));
    }
    if (DONE.includes(old.status) && !DONE.includes(next.status)) {
      const ids = roles.filter((r) => DISPATCH.includes(r.id)).map((r) => r.id);
      if (ids.length) out.push({ ...msg, kind: 'community', event: 'ticket_new', toRoleIds: ids, title: `${next.ticketNumber} reopened`, body: `${next.title} was ${old.status.toLowerCase()} and is ${next.status} again${by}.` });
    }
  }
  if (old && next.assignedTo && next.assignedTo === old.assignedTo && !DONE.includes(next.status)) {
    if ((next.priority || '') !== (old.priority || '')) out.push({ ...base, kind: 'status', event: 'ticket_status', toName: next.assignedTo, title: `${next.ticketNumber}: priority ${next.priority || 'cleared'}`, body: `${next.title}: priority ${old.priority || '—'} → ${next.priority || '—'}${by}.` });
  }
  if (old && (next.slaDueAt || '') !== (old.slaDueAt || '') && !DONE.includes(next.status)) {
    const when = next.slaDueAt ? new Date(`${next.slaDueAt}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : 'no date';
    [...new Set([next.assignedTo, next.createdBy].filter(Boolean))].forEach((nm) => out.push({ ...base, kind: 'status', event: 'ticket_status', toName: nm, title: `${next.ticketNumber}: due ${when}`, body: `${next.title}: the SLA date is now ${when}${by}.` }));
  }
  // quotation / invoice decisions: the person who raised or is doing the task hears about them
  for (const [field, who] of [['ecApproval', 'EC'], ['treasurerApproval', 'Final']]) {
    if (old && next[field] !== old[field] && ['Approved', 'Rejected'].includes(next[field])) {
      const names = [...new Set([next.assignedTo, next.createdBy].filter(Boolean))];
      for (const nm of names) out.push({ ...base, kind: 'decision', event: 'ticket_decision', toName: nm, title: `${next.ticketNumber}: ${who} approval ${next[field].toLowerCase()}`, body: `${who} approval on ${next.title} was ${next[field].toLowerCase()}${actor?.name ? ` by ${actor.name}` : ''}.` });
    }
  }
  for (const row of out) {
    if (mine(row)) continue; // don't notify yourself
    const { id: _i, read: _r, createdAt: _c, ...rest } = row;
    await notify({ ...rest, by: actor?.name || '', extra: { ticketId: row.ticketId, ticketNumber: row.ticketNumber, ticketTitle: row.ticketTitle } });
  }
}

/** Who has to act next on a task's quotation approval, or on an invoice? Tell exactly those roles, and tell the people doing the work when it is decided. */
async function approvers(waiting, roles) {
  if (waiting === 'ec') return roles.filter((r) => r.category === 'EC').map((r) => r.id);
  const rows = await storage.list('approverSettings');
  return finalApproverRoleIds(rows);
}
export async function notifyApprovalNeeded({ old, next, actor, roles = [] }) {
  const types = await storage.list('taskTypes');
  const type = types.find((x) => x.name === next.taskType);
  const before = approvalState(old, type).waitingOn;
  const after = approvalState(next, type).waitingOn;
  if (!after || after === before) return;
  const toRoleIds = await approvers(after === 'ec' ? 'ec' : 'final', roles);
  const step = after === 'ec' ? 'EC approval' : 'final approval (Treasurer / President)';
  await notify({ event: 'approval', title: `${step} needed · ${next.ticketNumber}`, body: `${next.title}: the selected quotation waits for your ${step}. Open the task → Money.`, link: ticketLink(next.ticketNumber), toRoleIds, by: actor?.name || '', extra: { ticketId: next.id, ticketNumber: next.ticketNumber, ticketTitle: next.title } });
}
export async function notifyInvoiceChange({ old, next, actor, roles = [] }) {
  if (next.kind !== 'Invoice') return;
  const tickets = await storage.list('tickets');
  const t = tickets.find((x) => x.id === next.ticketId);
  if (!t) return;
  const before = old ? invoiceApproval(old) : { waitingOn: null };
  const st = invoiceApproval(next);
  const link = ticketLink(t.ticketNumber);
  const extra = { ticketId: t.id, ticketNumber: t.ticketNumber, ticketTitle: t.title };
  const what = `${next.vendor || 'Invoice'} invoice of ₹${Number(next.amount || 0).toLocaleString('en-IN')} on ${t.title}`;
  if (st.waitingOn && st.waitingOn !== before.waitingOn) {
    const toRoleIds = await approvers(st.waitingOn, roles);
    await notify({ event: 'approval', title: `${st.waitingOn === 'ec' ? 'EC' : 'Final'} approval needed · ${t.ticketNumber}`, body: `${what} waits for your ${st.waitingOn === 'ec' ? 'EC' : 'final'} approval. Open the task → Money.`, link, toRoleIds, by: actor?.name || '', extra });
  } else if (['rejected', 'approved'].includes(st.key) && st.key !== before.key) {
    const names = [...new Set([t.assignedTo, t.createdBy].filter(Boolean))].filter((n) => n !== actor?.name);
    for (const nm of names) await notify({ event: 'ticket_decision', title: `${t.ticketNumber}: invoice ${st.key === 'approved' ? 'fully approved' : st.label.toLowerCase()}`, body: `${what} is ${st.key === 'approved' ? 'fully approved' : st.label.toLowerCase()}${actor?.name ? ` (${actor.name})` : ''}.`, link, toName: nm, by: actor?.name || '', extra });
  }
}
