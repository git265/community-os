// Central notification dispatcher.
//
//  - The APP (in-app bell, push banner, notification centre) is always on - it is the default and cannot be switched off.
//  - WhatsApp, SMS and E-mail are extra channels. A person opts in under Notifications -> My channels; the community decides
//    per kind of notification which extra channels are offered (Notifications -> Channel settings, management only).
//  - Extra channels are queued in the Notification Outbox ("Queued - demo, not delivered") until a real gateway is connected.
//  - Transactional messages (portal invitation, OTP) are sent regardless of preferences by their own code, not through here.
import { logEvent, getPrincipalLabel } from './audit/auditLog.js';
import { storage, COLLECTIONS } from './storage/index.js';
import { pushNotifications } from './notifications.js';
import { uuid } from './uuid.js';
import { sameName, key as nameKey } from './unitNaming.js';

export const CHANNELS = ['WhatsApp', 'SMS', 'Email'];
export const chKey = (c) => c.toLowerCase();
export const EVENTS = [
  { id: 'ticket_assigned', label: 'Task assigned to me', group: 'Maintenance' },
  { id: 'ticket_status', label: 'Task status changed', group: 'Maintenance' },
  { id: 'ticket_decision', label: 'Quotation / invoice approved or rejected', group: 'Maintenance' },
  { id: 'approval', label: 'Approval needed from me (quotation, invoice, event expense)', group: 'Maintenance' },
  { id: 'bill', label: 'Bill published (utilities, dues)', group: 'Billing' },
  { id: 'payment_reminder', label: 'Payment reminder for an unpaid bill', group: 'Billing' },
  { id: 'announcement', label: 'Notices & announcements', group: 'Communications' },
  { id: 'ticket_new', label: 'New request raised by a resident', group: 'Maintenance' },
  { id: 'ticket_chat', label: 'New message in a task chat', group: 'Maintenance' },
  { id: 'ticket_overdue', label: 'Task past its SLA date (assignee, Facility Manager, Helpdesk)', group: 'Maintenance' },
  { id: 'ticket_nudge', label: 'Ticket not started in time, or taking long (technician, then the Facility Manager)', group: 'Maintenance' },
  { id: 'planned_work', label: 'Planned works due today, or not done by their day (the team or person, Facility Manager)', group: 'Maintenance' },
  { id: 'payment_made', label: 'Release approved, ready to pay, or paid', group: 'Billing' },
  { id: 'ballot', label: 'E-voting opened / closing soon', group: 'Communications' },
  { id: 'ballot_result', label: 'E-voting closed: result ready', group: 'Communications' },
  { id: 'poll', label: 'New poll', group: 'Communications', mutable: true },
  { id: 'forum_topic', label: 'New forum topic', group: 'Communications', mutable: true },
  { id: 'forum_reply', label: 'Reply to my forum post or topic', group: 'Communications', mutable: true },
  { id: 'calendar', label: 'Community calendar (trash pickup, workers allowed, holidays)', group: 'Community', mutable: true },
  { id: 'cultural', label: 'Cultural events, donation receipts & volunteer calls', group: 'Cultural', mutable: true },
  { id: 'brochure', label: 'Event brochure published or updated', group: 'Cultural', mutable: true },
  { id: 'service_notice', label: 'Service notice from the office (power cut, water supply, lift …)', group: 'Community' },
  { id: 'meeting', label: 'Meetings (new, changed, cancelled, minutes)', group: 'Governance' },
  { id: 'shift', label: 'My shift planned / changed', group: 'Staff' },
  { id: 'event_work', label: 'Event work given to me or changed (Facility Manager / MEP)', group: 'Cultural' },
  { id: 'report', label: 'Scheduled reports', group: 'Reports' },
  { id: 'gate_approval', label: 'Gate: visitor needs my approval', group: 'Security' },
  { id: 'gate_guest_arrived', label: 'Gate: guest or pass holder arrived', group: 'Security' },
  { id: 'gate_guest_exit', label: 'Gate: guest exited', group: 'Security' },
  { id: 'gate_delivery', label: 'Gate: delivery arrived or left', group: 'Security' },
  { id: 'gate_staff_inout', label: 'Gate: maid, cook or driver in or out', group: 'Security' },
  { id: 'gate_crew_inout', label: 'Gate: crew member in or out', group: 'Security' },
  { id: 'gate_overstay', label: 'Gate: overstay or no exit', group: 'Security' },
  { id: 'gate_ghost', label: 'Gate: ghost entry, headcount, missed patrol, guard silence', group: 'Security' },
  { id: 'gate_override', label: 'Gate: guard override or manual open', group: 'Security' },
  { id: 'gate_blocked', label: 'Gate: blocked person attempt', group: 'Security' },
  { id: 'gate_vetting', label: 'Gate: vetting expiring or rejected', group: 'Security' },
  { id: 'stock_low', label: 'Stock running low (supplies at or below their minimum)', group: 'Assets' },
  { id: 'money_check', label: 'Money check: payments, bills or the books disagree (reconciliation)', group: 'Billing' },
];
export const eventLabel = (id) => EVENTS.find((e) => e.id === id)?.label || id;
/** The kinds a person may mute (news, not work): tickets, bills, payments, approvals, the gate and notices always reach them. */
export const MUTABLE = EVENTS.filter((e) => e.mutable).map((e) => e.id);

const SYSTEM = 'System';
const changed = (c) => window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: c } }));

/** Roles the Super Admin added to an event's audience (Notifications -> Channel settings -> "Also tell"). */
export async function alsoRolesOf(event) {
  const row = (await storage.list(COLLECTIONS.NOTIFICATION_SETTINGS)).find((r) => r.id === 'default');
  const a = row?.events?.[event]?.alsoRoles;
  return Array.isArray(a) ? a : [];
}

/** Channels the community offers for an event (default: all three). */
export async function offeredChannels(event) {
  const row = (await storage.list(COLLECTIONS.NOTIFICATION_SETTINGS)).find((r) => r.id === 'default');
  const e = row?.events?.[event];
  return CHANNELS.filter((c) => (e ? e[chKey(c)] !== false : true));
}
export async function getSettings() {
  const row = (await storage.list(COLLECTIONS.NOTIFICATION_SETTINGS)).find((r) => r.id === 'default');
  return row?.events || {};
}
export async function saveSettings(events) {
  const now = new Date().toISOString();
  await storage.put(COLLECTIONS.NOTIFICATION_SETTINGS, { id: 'default', events, lastUpdatedAt: now });
  logEvent({ what: 'Notification Settings', action: 'Update', summary: 'Notification channels per event changed', who: getPrincipalLabel() });
  changed(COLLECTIONS.NOTIFICATION_SETTINGS);
}
export async function getMyPrefs(name) {
  const row = (await storage.list(COLLECTIONS.NOTIFICATION_PREFS)).find((r) => sameName(r.userName, name));
  return { whatsapp: !!row?.whatsapp, sms: !!row?.sms, email: !!row?.email, muted: (Array.isArray(row?.muted) ? row.muted : []).filter((e) => MUTABLE.includes(e)) };
}
export async function saveMyPrefs(name, prefs) {
  const rows = await storage.list(COLLECTIONS.NOTIFICATION_PREFS);
  const old = rows.find((r) => sameName(r.userName, name));
  const now = new Date().toISOString();
  const muted = (prefs.muted || []).filter((e) => MUTABLE.includes(e));
  await storage.put(COLLECTIONS.NOTIFICATION_PREFS, { ...(old || { id: uuid(), recordCreatedAt: now }), userName: name, whatsapp: !!prefs.whatsapp, sms: !!prefs.sms, email: !!prefs.email, muted, lastUpdatedAt: now });
  logEvent({ what: 'Notification Settings', action: 'Update', summary: `${name}: notification preferences changed (WhatsApp ${prefs.whatsapp ? 'on' : 'off'}, SMS ${prefs.sms ? 'on' : 'off'}, email ${prefs.email ? 'on' : 'off'}${muted.length ? `; muted: ${muted.map(eventLabel).join(', ')}` : ''})`, who: name });
  changed(COLLECTIONS.NOTIFICATION_PREFS);
}

function unitsOfUser(u) { return Array.isArray(u.units) ? u.units : String(u.units || '').split(',').map((x) => x.trim()); }
/** Look-ups built ONCE per batch, so addressing 2,000 notifications is not 2,000 scans of every user. */
function indexUsers(users) {
  const act = users.filter((u) => u.status !== 'Inactive');
  const byName = new Map(); const byUnit = new Map();
  act.forEach((u) => {
    if (!byName.has(u.name)) byName.set(u.name, []);
    byName.get(u.name).push(u);
    unitsOfUser(u).forEach((x) => { if (!byUnit.has(x)) byUnit.set(x, []); byUnit.get(x).push(u); });
  });
  return { act, byName, byUnit };
}
function recipientsOf(to, ix) {
  const set = new Map();
  if (to.toName) (ix.byName.get(to.toName) || []).forEach((u) => set.set(u.id, u));
  if (to.toUnit) (ix.byUnit.get(to.toUnit) || []).forEach((u) => set.set(u.id, u));
  if (Array.isArray(to.toRoleIds) && to.toRoleIds.length) {
    ix.act.filter((u) => to.toRoleIds.includes(u.roleId) || (Array.isArray(u.extraRoleIds) && u.extraRoleIds.some((r) => to.toRoleIds.includes(r)))).forEach((u) => set.set(u.id, u));
  }
  return [...set.values()];
}

/**
 * Who a bill's notice goes to (built once for a batch): the person it is billed to - the owner and co-owners, or the tenants - by name when
 * they have a sign-in on the unit, otherwise everyone on the unit. alsoOwner: a demand or final notice on a tenant's bill reaches the
 * owners too (the owner answers for the unit's dues).
 *   const to = await billAudience(); to('Villa 135', 'Tenant', { alsoOwner: true }) -> [{ toName: 'Kavita Rao' }, { toName: 'Vikram Shah' }]
 */
export async function billAudience() {
  const [users, props] = await Promise.all([storage.list(COLLECTIONS.USERS), storage.list(COLLECTIONS.PROPERTIES)]);
  const active = users.filter((u) => u.status !== 'Inactive');
  const byUnit = new Map(props.map((p) => [p.unit, p]));
  return (unit, billTo, { alsoOwner = false } = {}) => {
    const p = byUnit.get(unit);
    if (!p) return [{ toUnit: unit }];
    const to = billTo || p.billTo || 'Owner';
    const owners = [p.owner, ...(p.people || []).filter((x) => x.relation === 'Additional owner').map((x) => x.name)];
    const tenants = [p.tenant, ...(p.people || []).filter((x) => x.relation === 'Additional tenant').map((x) => x.name)];
    const tenantBill = to === 'Tenant' && !!p.tenant;
    const names = [...(tenantBill ? tenants : owners), ...(alsoOwner && tenantBill ? owners : [])].filter(Boolean);
    const hits = [];
    for (const nm of names) {
      const u = active.find((x) => nameKey(x.name) === nameKey(nm) && unitsOfUser(x).includes(unit));
      if (u && !hits.includes(u.name)) hits.push(u.name);
    }
    return hits.length ? hits.map((n) => ({ toName: n })) : [{ toUnit: unit }];
  };
}

function outboxRow(seq, channel, event, user, title, body, now) {
  const to = channel === 'Email' ? user.email : user.phone;
  return {
    id: uuid(), shortId: `OUT-${String(seq).padStart(4, '0')}`, recVersion: 1, event, channel, to: to || '', toName: user.name, subject: title, body: `Hello ${user.name}, ${body}`,
    status: to ? 'Queued — demo, not delivered' : `Skipped — no ${channel === 'Email' ? 'e-mail address' : 'phone number'}`, createdAt: now, recordCreatedAt: now, recordCreatedBy: SYSTEM, lastUpdatedAt: now, lastUpdatedBy: SYSTEM,
  };
}

/**
 * Tell people about something. Always writes the in-app notification (addressed by name / villa / roles) and then queues an
 * outbox message on each extra channel the recipient chose AND the community offers for this event.
 * Returns the number of outbox messages queued.
 */
export async function notify(args) { return notifyMany([args]); }

/** The same for a whole batch (one write for the notifications, one for the outbox). Returns the number of outbox messages queued. */
export async function notifyMany(items) {
  if (!items.length) return 0;
  try {
    const cfg = (await storage.list(COLLECTIONS.NOTIFICATION_SETTINGS)).find((r) => r.id === 'default')?.events || {};
    items = items.map((it) => { const a = cfg[it.event]?.alsoRoles; return Array.isArray(a) && a.length ? { ...it, toRoleIds: [...new Set([...(it.toRoleIds || []), ...a])] } : it; });
  } catch { /* settings unreadable: keep the original audience */ }
  const rows = items.map(({ event, title, body, link = '', kind = event, by = '', toName, toUnit, toRoleIds, extra = {} }) => ({ id: uuid(), kind, event, title, body, link, read: false, createdAt: new Date().toISOString(), by, ...(toName ? { toName } : {}), ...(toUnit ? { toUnit } : {}), ...(toRoleIds ? { toRoleIds } : {}), ...extra }));
  await pushNotifications(rows);
  return queueExtraChannels(items, rows);
}

/** Queue WhatsApp / SMS / e-mail messages for notifications already written in-app. rows[i] is the in-app row of items[i]. */
export async function queueExtraChannels(items, rows) {
  let queued = 0;
  try {
    const settings = (await storage.list(COLLECTIONS.NOTIFICATION_SETTINGS)).find((r) => r.id === 'default')?.events || {};
    const offeredFor = (event) => CHANNELS.filter((c) => (settings[event] ? settings[event][chKey(c)] !== false : true));
    const [users, prefs, outbox] = await Promise.all([storage.list(COLLECTIONS.USERS), storage.list(COLLECTIONS.NOTIFICATION_PREFS), storage.list(COLLECTIONS.NOTIFICATION_OUTBOX)]);
    const prefBy = new Map(prefs.map((x) => [nameKey(x.userName), x]));
    const ix = indexUsers(users);
    let seq = outbox.reduce((m, r) => Math.max(m, Number(String(r.shortId || '').replace('OUT-', '')) || 0), 0);
    const now = new Date().toISOString(); const out = [];
    items.forEach((it, i) => {
      const offered = offeredFor(it.event);
      if (!offered.length) return;
      for (const u of recipientsOf(it, ix)) {
        if (it.by && u.name === it.by) continue;
        const pr = prefBy.get(nameKey(u.name));
        if (!pr || (Array.isArray(pr.muted) && pr.muted.includes(it.event))) continue;   // no extra channels, or this kind is muted by them
        for (const c of offered) if (pr[chKey(c)]) { out.push(outboxRow(++seq, c, it.event, u, rows[i].title, rows[i].body, now)); queued += 1; }
      }
    });
    if (out.length) await storage.putMany(COLLECTIONS.NOTIFICATION_OUTBOX, out);
  } catch (e) { console.warn('extra channels failed', e); }
  if (queued) changed(COLLECTIONS.NOTIFICATION_OUTBOX);
  return queued;
}

/**
 * Deliver a message on exactly the channels given (a scheduled report states its own channels, so personal opt-in is not consulted).
 * items: [{ title, body, link?, by?, toName?, toUnit?, toRoleIds?, extraTo?: [{ channel: 'Email'|'SMS'|'WhatsApp', to }] }]
 * channels: any of 'In-app' | 'Email' | 'SMS' | 'WhatsApp'. Returns { inApp, queued, skipped }.
 */
export async function deliverDirect(items, channels, event = 'report') {
  const res = { inApp: 0, queued: 0, skipped: 0 };
  if (!items.length) return res;
  if (channels.includes('In-app')) {
    const rows = items.filter((it) => it.toName || it.toUnit || (it.toRoleIds && it.toRoleIds.length)).map(({ title, body, link = '', by = '', toName, toUnit, toRoleIds }) => ({ id: uuid(), kind: event, event, title, body, link, read: false, createdAt: new Date().toISOString(), by, ...(toName ? { toName } : {}), ...(toUnit ? { toUnit } : {}), ...(toRoleIds?.length ? { toRoleIds } : {}) }));
    if (rows.length) { await pushNotifications(rows); res.inApp = rows.length; }
  }
  const extra = channels.filter((c) => CHANNELS.includes(c));
  if (extra.length) {
    const [users, outbox] = await Promise.all([storage.list(COLLECTIONS.USERS), storage.list(COLLECTIONS.NOTIFICATION_OUTBOX)]);
    const ix = indexUsers(users);
    let seq = outbox.reduce((m, r) => Math.max(m, Number(String(r.shortId || '').replace('OUT-', '')) || 0), 0);
    const now = new Date().toISOString(); const out = [];
    for (const it of items) {
      const people = recipientsOf(it, ix);
      for (const u of people) for (const c of extra) { const r = outboxRow(++seq, c, event, u, it.title, it.body, now); out.push(r); r.status.startsWith('Queued') ? (res.queued += 1) : (res.skipped += 1); }
      for (const x of it.extraTo || []) if (extra.includes(x.channel)) { const r = outboxRow(++seq, x.channel, event, { name: x.to, email: x.to, phone: x.to }, it.title, it.body, now); out.push(r); res.queued += 1; }
    }
    if (out.length) { await storage.putMany(COLLECTIONS.NOTIFICATION_OUTBOX, out); changed(COLLECTIONS.NOTIFICATION_OUTBOX); }
  }
  return res;
}

/** Every unit that has at least one active login (the villas a "to all villas" report can reach). */
export async function unitsWithPeople() {
  const ix = indexUsers(await storage.list(COLLECTIONS.USERS));
  return [...ix.byUnit.keys()].filter(Boolean).sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
}
