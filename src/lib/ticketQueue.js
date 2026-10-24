// Dispatch of maintenance tickets (role-queue task types): a ticket goes to the next free technician of its category; with nobody free it waits
// in the category's queue, in the order received, and the next technician to become free takes the oldest one. The server's rules
// (backend/api maintenance/domain/Dispatch.java); in the browser demo this file also does the work (secureStorage calls dispatchCategory).
//   free     on shift (clocked in) and not holding a ticket that is Assigned or In Progress (On Hold, waiting for parts, does not count)
//   next     of the free ones, the one whose last job was given longest ago (never given one first), then by name
//   nudges   not started within the category's start time: the technician, then (twice that) the technician and the facility manager;
//            in progress for longer than the category's fix time: the same two steps
import { COLLECTIONS as C } from './storage/StorageAdapter.js';
import { storage } from './storage/index.js';
import { getDataSource } from './storage/dataSource.js';
import { notify } from './notify.js';

export const START_WITHIN_MIN = 30;
export const FIX_WITHIN_HOURS = 4;
const BUSY = ['Assigned', 'In Progress'];
const LIVE = ['Open', 'Assigned', 'In Progress', 'On Hold'];
const lc = (x) => String(x || '').trim().toLowerCase();
export const isQueueType = (tt) => String(tt?.assignmentMode || '').startsWith('Role queue');

/** When a ticket was last given out and when work started (the demo keeps them in the status trail; the server sends them). */
export function timesOf(t) {
  const trail = Array.isArray(t?.statusHistory) ? t.statusHistory : [];
  const last = (st) => [...trail].reverse().find((x) => x.status === st)?.at || '';
  const assignedAt = t?.assignedAt || (t?.assignedTo ? last('Assigned') || (t.status === 'In Progress' ? '' : t.recordCreatedAt || '') : '');
  const startedAt = t?.startedAt || (t?.status === 'In Progress' || t?.status === 'On Hold' || t?.status === 'Completed' ? last('In Progress') : '');
  const completedAt = t?.completedAt || last('Completed');
  return { assignedAt, startedAt, completedAt };
}

/** A category's technicians with their load: [{ name, onShift, busy, lastAssigned, working }]. */
export function techsOf(handymen, tickets, category) {
  return handymen.filter((h) => lc(h.trade) === lc(category) && h.status !== 'Inactive').map((h) => {
    const mine = tickets.filter((t) => t.assignedTo === h.name);
    const holding = mine.filter((t) => BUSY.includes(t.status)).sort((a, b) => (a.status === 'In Progress' ? -1 : 0) - (b.status === 'In Progress' ? -1 : 0));
    const lastAssigned = mine.map((t) => timesOf(t).assignedAt).filter(Boolean).sort().pop() || '';
    return { name: h.name, onShift: !!h.clockedIn, busy: holding.length, lastAssigned, working: holding[0]?.ticketNumber || '' };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
/** The free technician a ticket goes to, if any. */
export function nextFree(techs) {
  return techs.filter((x) => x.onShift && !x.busy).sort((a, b) => String(a.lastAssigned || '').localeCompare(String(b.lastAssigned || '')) || a.name.localeCompare(b.name))[0] || null;
}

/** Which reminder a ticket is due now: { kind: 'start'|'fix', stage: 1|2, since, minutes } or null. */
export function nudgeDue(t, limits = {}, now = new Date()) {
  const { assignedAt, startedAt } = timesOf(t);
  const start = (Number(limits.startWithinMin) || START_WITHIN_MIN) * 60e3; const fix = (Number(limits.fixWithinHours) || FIX_WITHIN_HOURS) * 3600e3;
  const at = t.status === 'Assigned' ? assignedAt : t.status === 'In Progress' ? startedAt : '';
  if (!at) return null;
  const took = now.getTime() - new Date(at).getTime(); const limit = t.status === 'Assigned' ? start : fix;
  if (!(took >= limit)) return null;
  return { kind: t.status === 'Assigned' ? 'start' : 'fix', stage: took >= limit * 2 ? 2 : 1, since: at, minutes: Math.round(took / 60e3) };
}
/** "45 minutes", "5 hours". */
export const tookText = (m) => (m >= 120 ? `${Math.floor(m / 60)} hours` : `${m} minutes`);

// ---- the browser demo's dispatch (on the server, TicketService does this) -----------------------------------------------------------------
async function queueTypes() { return new Set((await storage.list(C.TASK_TYPES)).filter(isQueueType).map((t) => t.name)); }

/**
 * Give a category's queued tickets, oldest first, to its free technicians. Written as the system (not as the person whose action freed
 * the technician): the ticket gets the assignment, its status trail and the usual "assigned to you" notification. Returns the tickets given.
 */
export async function dispatchCategory(category, { by = 'Auto-assign' } = {}) {
  if (!category) return [];
  const [tickets, handymen, types] = await Promise.all([storage.list(C.TICKETS), storage.list(C.HANDYMEN), queueTypes()]);
  const techs = techsOf(handymen, tickets, category);
  const queue = tickets.filter((t) => t.status === 'Open' && !t.assignedTo && lc(t.category) === lc(category) && types.has(t.taskType))
    .sort((a, b) => String(a.recordCreatedAt || '').localeCompare(String(b.recordCreatedAt || '')));
  const given = [];
  for (const t of queue) {
    const x = nextFree(techs);
    if (!x) break;
    const now = new Date().toISOString();
    const next = { ...t, assignedTo: x.name, status: 'Assigned', recVersion: (t.recVersion || 0) + 1, lastUpdatedAt: now, lastUpdatedBy: `System (${by})`,
      statusHistory: [...(Array.isArray(t.statusHistory) ? t.statusHistory : []), { status: 'Assigned', at: now, by: `${by} → ${x.name}` }] };
    await storage.put(C.TICKETS, next);
    x.busy += 1; x.lastAssigned = now; x.working = t.ticketNumber;
    given.push(next);
    try {
      const { notifyTicketChange } = await import('./notifications.js');
      const [users, roles] = await Promise.all([storage.list(C.USERS), storage.list(C.ROLES)]);
      await notifyTicketChange({ old: t, next, actor: { name: by }, users, roles });
    } catch (e) { console.warn('auto-assign notification failed', e); }
  }
  if (given.length && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: C.TICKETS } }));
  return given;
}

/** The demo's job (on the server, Jobs.dispatchTickets): every queue to its free technicians, then the reminders, once each. */
export async function runTicketDispatch(now = new Date()) {
  const tickets = await storage.list(C.TICKETS);
  const live = tickets.filter((t) => LIVE.includes(t.status));
  if (!live.length) return 0;
  const types = await queueTypes();
  let n = 0;
  for (const cat of [...new Set(live.filter((t) => t.status === 'Open' && !t.assignedTo && types.has(t.taskType)).map((t) => t.category))]) n += (await dispatchCategory(cat)).length;
  const [coverage, sentRows, fresh] = await Promise.all([storage.list(C.CATEGORY_MAP), storage.list('notifications'), storage.list(C.TICKETS)]);
  const sent = new Set(sentRows.filter((x) => x.kind === 'ticket_nudge').map((x) => `${x.nudgeTicket}|${x.nudgeKind}|${x.nudgeStage}|${x.nudgeSince}`));
  for (const t of fresh) {
    if (!BUSY.includes(t.status) || !t.assignedTo || !types.has(t.taskType)) continue;
    const d = nudgeDue(t, coverage.find((c) => lc(c.category) === lc(t.category)) || {}, now);
    if (!d || sent.has(`${t.id}|${d.kind}|${d.stage}|${d.since}`)) continue;
    const took = tookText(d.minutes);
    const title = d.kind === 'start' ? `${d.stage === 1 ? 'Not started yet' : 'Still not started'} · ${t.ticketNumber}` : `${d.stage === 1 ? 'Taking long' : 'Still in progress'} · ${t.ticketNumber}`;
    const body = d.kind === 'start'
      ? (d.stage === 1 ? `${t.title} was given to you ${took} ago. Start it, or hand it back to the queue.` : `${t.title} (${t.category}) was given to ${t.assignedTo} ${took} ago and is not started.`)
      : (d.stage === 1 ? `${t.title} has been in progress for ${took}. Mark it done, or put it on hold and say why.` : `${t.title} (${t.category}) has been in progress with ${t.assignedTo} for ${took}.`);
    await notify({ event: 'ticket_nudge', kind: 'ticket_nudge', title, body, link: `#/ticket/${t.ticketNumber}`, by: 'System', toName: t.assignedTo,
      ...(d.stage === 2 ? { toRoleIds: ['facility_manager'] } : {}), extra: { nudgeTicket: t.id, nudgeKind: d.kind, nudgeStage: d.stage, nudgeSince: d.since } });
    n += 1;
  }
  return n;
}

// ---- the queue view --------------------------------------------------------------------------------------------------------------------------
/**
 * A category's queue as the signed-in person may see it: { category, technicians: [{ name, onShift, busy, working }], tickets: [{ ticketNumber,
 * title, unitNo, priority, status, technician, receivedAt, assignedAt, startedAt, completedAt, mine, place, id }], waiting }. Other homes'
 * tickets are anonymised for residents (no title, no unit). On the server: GET /tickets/queue.
 */
export async function ticketQueue(category, { days = 3, principal = null } = {}) {
  if (getDataSource().mode === 'v2') {
    const { ticketQueueV2 } = await import('./storage/v2/V2ApiAdapter.js');
    return ticketQueueV2(category, days);
  }
  const [tickets, handymen, types] = await Promise.all([storage.list(C.TICKETS), storage.list(C.HANDYMEN), queueTypes()]);
  const staff = principal && principal.role?.category !== 'Resident';
  const since = Date.now() - Math.max(1, Math.min(14, days)) * 86400e3;
  const rows = tickets.filter((t) => lc(t.category) === lc(category) && types.has(t.taskType) && (LIVE.includes(t.status) || new Date(t.recordCreatedAt || 0).getTime() >= since))
    .sort((a, b) => String(a.recordCreatedAt || '').localeCompare(String(b.recordCreatedAt || '')));
  let place = 0;
  const out = rows.map((t) => {
    const mine = !!principal && (t.createdBy === principal.name || (!!principal.unit && (t.unit === principal.unit || (t.affectedUnits || []).includes(principal.unit))));
    const waiting = t.status === 'Open' && !t.assignedTo;
    if (waiting) place += 1;
    const tm = timesOf(t);
    return { ticketNumber: t.ticketNumber, title: staff || mine ? t.title : null, unitNo: staff || mine ? t.unit || null : null, priority: t.priority, status: t.status,
      technician: t.assignedTo || null, receivedAt: t.recordCreatedAt || null, assignedAt: tm.assignedAt || null, startedAt: tm.startedAt || null, completedAt: tm.completedAt || null,
      mine, place: waiting ? place : null, id: staff || mine ? t.id : null };
  });
  return { category, technicians: techsOf(handymen, tickets, category).map(({ name, onShift, busy, working }) => ({ name, onShift, busy: busy > 0, working: working || null })), tickets: out, waiting: place };
}

/** What a new request in a category will meet, in words: the free technician, or the queue. */
export function availabilityText(q, category) {
  if (!q) return null;
  const on = q.technicians.filter((x) => x.onShift); const free = on.filter((x) => !x.busy);
  if (free.length) return { tone: 'ok', text: `${free.map((x) => x.name).slice(0, 2).join(' or ')} ${free.length === 1 ? 'is' : 'are'} free — your request goes straight to ${free.length === 1 ? 'them' : 'one of them'}${q.waiting ? ` after the ${q.waiting} waiting` : ''}.` };
  if (on.length) return { tone: 'wait', text: `${on.length === 1 ? `The ${category} technician on shift is` : `All ${on.length} ${category} technicians on shift are`} on other jobs — your request will be number ${q.waiting + 1} in the queue.` };
  return { tone: 'wait', text: `No ${category} technician is on shift now — your request waits in the queue${q.waiting ? ` (${q.waiting} ahead of it)` : ''} for the next one.` };
}
