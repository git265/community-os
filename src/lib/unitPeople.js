// Who lives in or owns a unit over time: a tenant moving out, a change of owner, and the unit's history of both.
// On the v2 back end every step is the server's (/v1/units/{id}/people, /move-out, /change-owner, /changes); in the browser demo the same
// steps run here: the property record is saved through the secure store (its rules, and portal access added or closed afterwards), the
// household's gate access is ended, and the change is written to the unit's history. Nothing is deleted: who left stays in the history,
// their bills, requests and bookings stay as they were, and unpaid bills stay with the unit (reported, not settled).
import { apiFetch } from './net/request.js';
import { getDataSource } from './storage/dataSource.js';
import { storage, COLLECTIONS as C } from './storage/index.js';
import { secureStorage } from './storage/secureStorage.js';
import { announceChange } from './storage/changes.js';
import { getPrincipal } from './security/principal.js';
import { peopleOf } from './people.js';
import { phoneKey } from './phone.js';
import { uuid } from './uuid.js';

export const onV2 = () => getDataSource().mode === 'v2';
export const OCCUPANCIES = ['Owner occupied', 'Tenant occupied', 'Vacant'];
const today = () => new Date().toISOString().slice(0, 10);
const DONE_TICKET = ['Completed', 'Closed', 'Cancelled'];

async function call(method, path, body) {
  const res = await apiFetch(`/v1${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let out = null; try { out = res.status === 204 ? null : await res.json(); } catch { /* no body */ }
  if (!res.ok) { const e = new Error(out?.detail || `Units: ${res.status}`); e.status = res.status; e.code = out?.code; throw e; }
  return out;
}
const changed = () => announceChange(C.PROPERTIES, C.USERS, C.GATE_LINKS, C.GATE_PASSES, C.GATE_VEHICLES, C.GATE_VILLA_RULES, C.UNIT_CHANGES);

const SHOWN = { Owner: 'Primary owner', 'Co-owner': 'Additional owner', Tenant: 'Tenant', Family: 'Family / other contact', Caretaker: 'Family / other contact' };

/**
 * The people on the unit now, as the move-out and change-of-owner screens list them:
 * { key, name, relation (as shown), phone, email, isOwner, isTenant, primary }. key = the server's row id, or the demo record's slot.
 */
export async function currentPeople(prop) {
  if (onV2()) {
    const rows = await call('GET', `/units/${encodeURIComponent(prop.id)}/people`);
    return rows.filter((p) => !p.to).map((p) => ({ key: p.occupantId, name: p.name, relation: p.relation === 'Tenant' && !p.primary ? 'Tenant' : SHOWN[p.relation] || p.relation, phone: p.phone || '', email: p.email || '',
      isOwner: p.relation === 'Owner' || p.relation === 'Co-owner', isTenant: p.relation === 'Tenant', primary: p.relation === 'Owner' && p.primary }));
  }
  return peopleOf(prop).map((p) => ({ key: p.slot, name: p.name, relation: p.relation, phone: p.phone, email: p.email, isOwner: p.isOwner, isTenant: p.slot === 'tenant' || p.relation === 'Additional tenant',
    primary: p.slot === 'primary' }));
}

/** What stays open if these people leave: the unit's unpaid bills (they stay with the unit), their future bookings, the requests they raised. */
export async function leftovers(prop, keys) {
  if (onV2()) {
    const q = keys.map((k) => `leaving=${encodeURIComponent(k)}`).join('&');
    return call('GET', `/units/${encodeURIComponent(prop.id)}/leftovers${q ? `?${q}` : ''}`);
  }
  const names = new Set(peopleOf(prop).filter((p) => keys.includes(p.slot)).map((p) => String(p.name).trim().toLowerCase()));
  const mineByName = (n) => names.has(String(n || '').trim().toLowerCase());
  const [dues, bookings, tickets] = await Promise.all([storage.list(C.DUES), storage.list(C.AMENITIES), storage.list(C.TICKETS)]);
  const unpaid = dues.filter((d) => d.unit === prop.unit && !['Paid', 'Cancelled', 'Waived'].includes(d.status));
  return {
    duesOutstanding: unpaid.reduce((n, d) => n + Math.max(0, (Number(d.amount) || 0) - (Number(d.paidAmount) || 0)), 0),
    unpaidBills: unpaid.length,
    futureBookings: bookings.filter((b) => b.unit === prop.unit && ['Confirmed', 'Pending payment'].includes(b.status) && String(b.date || '') >= today() && (!b.bookedBy || mineByName(b.bookedBy))).length,
    openTickets: tickets.filter((t) => !DONE_TICKET.includes(t.status) && mineByName(t.createdBy)).length,
  };
}

function checkDay(on) {
  const d = on || today();
  if (d > today()) throw new Error('Record it on the day it happens (not a future date)');
  const two = new Date(); two.setFullYear(two.getFullYear() - 2);
  if (d < two.toISOString().slice(0, 10)) throw new Error('That date is more than two years ago');
  return d;
}
const consistent = (occ, tenant) => {
  if (!OCCUPANCIES.includes(occ)) throw new Error('Say who occupies the unit afterwards');
  if (occ === 'Tenant occupied' && !tenant) throw new Error('A tenant-occupied unit needs its tenant');
  if (occ !== 'Tenant occupied' && tenant) throw new Error(`The unit is ${occ.toLowerCase()} but a tenant stays on it`);
};

/** The demo's gate: the household's staff links end, its passes are cancelled, its cars are no longer known, its gate rule is reset. */
async function endGateLocal(unit) {
  const now = new Date().toISOString(); const by = getPrincipal()?.name || 'System';
  const upd = (r, patch) => ({ ...r, ...patch, recVersion: (r.recVersion || 1) + 1, lastUpdatedAt: now, lastUpdatedBy: by });
  const [links, passes, cars, rules] = await Promise.all([C.GATE_LINKS, C.GATE_PASSES, C.GATE_VEHICLES, C.GATE_VILLA_RULES].map((c) => storage.list(c)));
  const l = links.filter((x) => x.unit === unit && x.status !== 'Ended').map((x) => upd(x, { status: 'Ended' }));
  const p = passes.filter((x) => x.unit === unit && x.status === 'Active').map((x) => upd(x, { status: 'Cancelled' }));
  const v = cars.filter((x) => x.unit === unit && x.status === 'Active').map((x) => upd(x, { status: 'Ended' }));
  const r = rules.filter((x) => x.unit === unit).map((x) => upd(x, { deliveryMode: 'Allow listed', companies: [], awayMode: false, expectingUntil: '', fallback: 'Community default', tellGuestExit: false, tellStaff: false, tellDelivery: true }));
  if (l.length) await storage.putMany(C.GATE_LINKS, l);
  if (p.length) await storage.putMany(C.GATE_PASSES, p);
  if (v.length) await storage.putMany(C.GATE_VEHICLES, v);
  if (r.length) await storage.putMany(C.GATE_VILLA_RULES, r);
  return { links: l.length, passes: p.length, vehicles: v.length, ruleReset: r.length > 0 };
}
async function recordLocal(row) {
  const rows = await storage.list(C.UNIT_CHANGES);
  const n = rows.reduce((m, x) => Math.max(m, Number(String(x.shortId || '').replace('UCH-', '')) || 0), 0) + 1;
  const now = new Date().toISOString(); const by = getPrincipal()?.name || 'System';
  const full = { id: uuid(), shortId: `UCH-${String(n).padStart(4, '0')}`, recVersion: 1, ...row, by, at: now, recordCreatedAt: now, recordCreatedBy: by, lastUpdatedAt: now, lastUpdatedBy: by };
  await storage.put(C.UNIT_CHANGES, full);
  return full;
}
/** How many of these phones had a sign-in that is now closed. */
async function closedCount(phones, before) {
  const after = await storage.list(C.USERS);
  const keys = new Set(phones.filter(Boolean).map(phoneKey));
  return after.filter((u) => u.phone && keys.has(phoneKey(u.phone)) && u.status === 'Inactive' && before.find((b) => b.id === u.id)?.status !== 'Inactive').length;
}
const outOf = (ps) => ps.map((p) => ({ name: p.name, relation: p.relation, phone: p.phone || '' }));

/**
 * A tenant (and their family) moves out. leaving: keys from currentPeople. Returns { leftovers, gate, accountsClosed }.
 * An owner never moves out this way (that is a change of owner).
 */
export async function moveOut(prop, { on, leaving = [], occupancyAfter, endGate = true, note = '' }) {
  const day = checkDay(on);
  if (!leaving.length) throw new Error('Choose who is moving out');
  if (onV2()) {
    const r = await call('POST', `/units/${encodeURIComponent(prop.id)}/move-out`, { on: day, occupantIds: leaving, occupancyAfter, endGate, note: note || null });
    changed(); return r;
  }
  const all = peopleOf(prop); const out = all.filter((p) => leaving.includes(p.slot));
  if (out.some((p) => p.isOwner)) throw new Error('An owner leaves by a change of owner, not a move-out');
  const next = { ...prop, people: (prop.people || []).filter((x) => !leaving.includes(x.id || `p:${x.name}`)) };
  if (leaving.includes('tenant')) { next.tenant = ''; next.tenantPhone = ''; next.tenantEmail = ''; }
  if (!next.tenant) {   // the main tenant left but another tenant stays: they become the tenant
    const t = next.people.find((x) => x.relation === 'Additional tenant');
    if (t) { next.tenant = t.name; next.tenantPhone = t.phone || ''; next.tenantEmail = t.email || ''; next.people = next.people.filter((x) => x !== t); }
  }
  consistent(occupancyAfter, !!next.tenant);
  next.occupancy = occupancyAfter; if (!next.tenant) next.billTo = 'Owner';
  const left = await leftovers(prop, leaving);
  const users = await storage.list(C.USERS);
  await secureStorage.put(C.PROPERTIES, next, { summaryOf: () => `${out.map((p) => p.name).join(', ')} moved out of ${prop.unit} on ${day}` });
  const gate = endGate && !next.tenant ? await endGateLocal(prop.unit) : { links: 0, passes: 0, vehicles: 0, ruleReset: false };
  const accountsClosed = await closedCount(out.map((p) => p.phone), users);
  await recordLocal({ unit: prop.unit, kind: 'Moved out', on: day, out: outOf(out), in: [], occupancyBefore: prop.occupancy || '', occupancyAfter, duesOutstanding: left.duesOutstanding,
    summary: { accountsClosed, ...left, gateLinksEnded: gate.links, passesCancelled: gate.passes, vehiclesEnded: gate.vehicles }, note: note || '' });
  changed();
  return { leftovers: left, gate, accountsClosed };
}

/**
 * The unit is sold or transferred. newOwner { name, phone, email }; coOwners [...]; leaving: keys of those who go (the current primary owner
 * at least). Returns { leftovers, gate, accountsClosed }.
 */
export async function changeOwner(prop, { on, newOwner, coOwners = [], leaving = [], occupancyAfter, endGate = true, note = '' }) {
  const day = checkDay(on);
  if (!newOwner?.name?.trim() || !newOwner?.phone?.trim()) throw new Error('Give the new owner’s name and mobile number');
  const extra = coOwners.filter((x) => x.name?.trim());
  if (onV2()) {
    const r = await call('POST', `/units/${encodeURIComponent(prop.id)}/change-owner`, { on: day, newOwner: { ...newOwner, relation: 'Owner', primary: true },
      coOwners: extra.map((x) => ({ ...x, relation: 'Co-owner' })), leavingIds: leaving, occupancyAfter, endGate, note: note || null });
    changed(); return r;
  }
  const all = peopleOf(prop); const out = all.filter((p) => leaving.includes(p.slot));
  if (prop.owner && !leaving.includes('primary')) throw new Error(`${prop.owner} is the owner now - choose them among those leaving`);
  const stays = (prop.people || []).filter((x) => !leaving.includes(x.id || `p:${x.name}`));
  const next = { ...prop, owner: newOwner.name.trim(), ownerPhone: newOwner.phone.trim(), ownerEmail: (newOwner.email || '').trim(),
    people: [...stays, ...extra.map((x) => ({ id: uuid(), relation: 'Additional owner', name: x.name.trim(), phone: x.phone || '', email: x.email || '' }))] };
  if (leaving.includes('tenant')) { next.tenant = ''; next.tenantPhone = ''; next.tenantEmail = ''; }
  consistent(occupancyAfter, !!next.tenant);
  next.occupancy = occupancyAfter; if (!next.tenant) next.billTo = 'Owner';
  const left = await leftovers(prop, leaving);
  const users = await storage.list(C.USERS);
  await secureStorage.put(C.PROPERTIES, next, { summaryOf: () => `Owner of ${prop.unit} changed on ${day}: ${prop.owner || '—'} → ${next.owner}` });
  const gate = endGate ? await endGateLocal(prop.unit) : { links: 0, passes: 0, vehicles: 0, ruleReset: false };
  const accountsClosed = await closedCount(out.map((p) => p.phone), users);
  await recordLocal({ unit: prop.unit, kind: 'Owner changed', on: day, out: outOf(out), in: [{ name: next.owner, relation: 'Primary owner', phone: next.ownerPhone }, ...extra.map((x) => ({ name: x.name, relation: 'Additional owner', phone: x.phone || '' }))],
    occupancyBefore: prop.occupancy || '', occupancyAfter, duesOutstanding: left.duesOutstanding,
    summary: { accountsClosed, ...left, gateLinksEnded: gate.links, passesCancelled: gate.passes, vehiclesEnded: gate.vehicles }, note: note || '' });
  changed();
  return { leftovers: left, gate, accountsClosed };
}

/**
 * The unit's history: [{ id, shortId, kind, on, out: [{name, relation}], in: [...], occupancyBefore, occupancyAfter, duesOutstanding, summary, note, by, at }],
 * latest first. For the unit's managers and the committee.
 */
export async function unitHistory(prop) {
  if (onV2()) {
    return (await call('GET', `/units/${encodeURIComponent(prop.id)}/changes`)).map((c) => ({ ...c, out: (c.out || []).map((x) => ({ ...x, relation: SHOWN[x.relation] || x.relation })),
      in: (c.in || []).map((x) => ({ ...x, relation: SHOWN[x.relation] || x.relation })) }));
  }
  return (await secureStorage.list(C.UNIT_CHANGES)).filter((r) => r.unit === prop.unit).sort((a, b) => `${b.on}${b.at}`.localeCompare(`${a.on}${a.at}`));
}
