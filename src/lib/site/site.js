// The site's devices (face / QR terminals, their bridges, the punch log, face consent) for the On site page.
// On the v2 back end every call goes to the server's device layer (/v1/site); in the browser demo the same calls work on a small
// local store with one demo terminal, and a "punch" is tried through the gate's own rules (lib/gate/engine.js).
import { apiFetch } from '../net/request.js';
import { getDataSource } from '../storage/dataSource.js';
import { SessionStorageAdapter } from '../storage/SessionStorageAdapter.js';
import { secureStorage } from '../storage/secureStorage.js';
import { COLLECTIONS as C } from '../storage/StorageAdapter.js';
import { announceChange } from '../storage/changes.js';
import { uuid } from '../uuid.js';
import { getCommunity } from '../community.js';

/** The change every site screen listens for (devices, bridges, the punch log, consent). */
export const SITE_CHANGED = 'siteDevices';
export const onV2 = () => getDataSource().mode === 'v2';
export const KINDS = ['Face terminal', 'QR reader', 'ANPR camera', 'FASTag reader', 'Barrier', 'Phone kiosk'];
export const DRIVERS = [['hikvision-isapi', 'Hikvision (ISAPI, through a bridge)'], ['app-kiosk', 'CommunityOS phone kiosk']];
export const DIRECTIONS = ['In', 'Out', 'Both'];
export const CAPABILITIES = ['Face', 'Card', 'QR', 'PIN', 'Fingerprint', 'Plate', 'Tag', 'Relay'];
export const CONSENT_TEXT = 'I agree that my face photo is used only to let me in and out of the community and to record my attendance. '
  + 'It is kept safely, never shared, and deleted when I stop working here.';
const VILLA = ['Maid / cook', 'Nanny / caretaker', 'Driver'], CREW = ['Daily worker', 'Landscaper', 'Vendor staff', 'Contractor'];

/** The On site groups a gate visit falls in. */
export const GROUPS = ['Staff', 'Household', 'Contractors', 'Visitors', 'Vehicles'];
export function groupOf(kind) {
  if (kind === 'Staff') return 'Staff';
  if (kind === 'Maid / cook' || kind === 'Driver') return 'Household';
  if (kind === 'Crew') return 'Contractors';
  if (kind === 'Resident vehicle' || kind === 'Goods vehicle') return 'Vehicles';
  return 'Visitors';
}
/** A device is online if its bridge heard from it in the last three minutes. */
export const isOnline = (d) => !!d?.online && !!d.lastSeenAt && Date.now() - new Date(d.lastSeenAt).getTime() < 180000;

/** What this person may do here (the server checks the same). */
export function siteRights({ roleId, role, hasPermission = () => false }) {
  const admin = roleId === 'super_admin', committee = admin || role?.category === 'EC', fm = roleId === 'facility_manager';
  const gateStaff = admin || hasPermission('MANAGE_SECURITY') || ['committee_security', 'handyman_security'].includes(roleId);
  const guardOnly = roleId === 'handyman_security';
  return { views: gateStaff || fm || committee, manages: (gateStaff || fm || committee) && !guardOnly, door: gateStaff, records: gateStaff || fm || committee };
}

// ---- the server ----------------------------------------------------------------------------------------------------------------------
async function call(method, path, body) {
  const res = await apiFetch(`/v1/site${path}`, method === 'GET' ? {} : { method, body: JSON.stringify(body ?? {}) });
  let out = null; try { out = res.status === 204 || res.status === 202 ? null : await res.json(); } catch { /* no body */ }
  if (!res.ok) { const e = new Error(out?.detail || `Devices: ${res.status}`); e.status = res.status; throw e; }
  if (method !== 'GET') announceChange(SITE_CHANGED, C.GATE_FLAGS);
  return out;
}

// ---- the browser demo ------------------------------------------------------------------------------------------------------------------
const L = { devices: 'siteDevices', bridges: 'siteBridges', events: 'siteEvents', faces: 'siteFaces' };
const local = SessionStorageAdapter;
const now = () => new Date().toISOString();
const done = (...extra) => announceChange(SITE_CHANGED, ...extra);
const seeding = new Map();   // community -> the one seeding in flight (the screen asks for devices and bridges at the same moment)
function demoSeed() {
  const slug = getCommunity();
  if (!seeding.has(slug)) seeding.set(slug, seedOnce().finally(() => seeding.delete(slug)));
  return seeding.get(slug);
}
async function seedOnce() {
  let devices = await local.list(L.devices);
  if (devices.length) return devices;
  const bridge = { id: uuid(), shortId: 'GBR-0001', name: 'Gate PC (demo)', status: 'Active', tokenHint: 'demo', lastSeenAt: now(), agentVersion: 'cos-bridge/0.1.0', createdAt: now() };
  await local.put(L.bridges, bridge);
  await local.put(L.devices, { id: uuid(), shortId: 'GDV-0001', name: 'Main gate face', gate: 'Main gate', kind: 'Face terminal', make: 'Hikvision', model: 'DS-K1T344MBWX-QRE1',
    driver: 'hikvision-isapi', direction: 'Both', capabilities: ['Face', 'Card', 'QR', 'Relay'], bridgeId: bridge.id, host: '192.168.1.64', port: 80, useTls: false, username: 'admin',
    hasPassword: true, doorNo: 1, capacity: 3000, status: 'Active', serial: 'DEMO-0001', firmware: 'V3.11.0', online: true, lastSeenAt: now(), clockDriftS: 2, enrolledCount: 0, lastError: null, lastEventNo: 0, version: 1 });
  devices = await local.list(L.devices);
  return devices;
}
const keyOf = (kind, id) => `${kind}:${id}`;
async function demoWanted() {
  const [faces, people, links, orders, users] = await Promise.all([local.list(L.faces), secureStorage.list(C.GATE_PEOPLE).catch(() => []), secureStorage.list(C.GATE_LINKS).catch(() => []),
    secureStorage.list(C.GATE_WORKORDERS).catch(() => []), secureStorage.list(C.USERS).catch(() => [])]);
  const ok = (f) => f && f.consentAt && !f.withdrawnAt;
  const byKey = new Map(faces.map((f) => [keyOf(f.subjectKind, f.subjectId), f]));
  const out = [];
  for (const p of people) {
    const f = byKey.get(keyOf('person', p.id));
    const works = links.some((l) => l.personId === p.id && l.status !== 'Ended') || orders.some((o) => o.status === 'Active' && (o.rosterIds || []).includes(p.id));
    if (ok(f) && p.status === 'Active' && p.photo && works) out.push({ subjectKind: 'person', subjectId: p.id, name: p.name, cardNo: f.cardNo || null });
  }
  for (const u of users) { const f = byKey.get(keyOf('member', u.id)); if (ok(f) && f.photo && u.status !== 'Inactive') out.push({ subjectKind: 'member', subjectId: u.id, name: u.name, cardNo: f.cardNo || null }); }
  return out;
}

// ---- reads ---------------------------------------------------------------------------------------------------------------------------------
export async function listDevices() {
  if (onV2()) return call('GET', '/devices');
  const [devices, wanted] = await Promise.all([demoSeed(), demoWanted()]);
  return devices.map((d) => (d.status === 'Active' ? { ...d, online: true, lastSeenAt: now(), enrolledCount: d.capabilities.some((c) => c === 'Face' || c === 'Card') ? wanted.length : 0 } : d));
}
export async function listBridges() { if (onV2()) return call('GET', '/bridges'); await demoSeed(); return (await local.list(L.bridges)).map((b) => (b.status === 'Active' ? { ...b, lastSeenAt: now() } : b)); }
export async function listEvents({ since = null, limit = 200 } = {}) {
  if (onV2()) return call('GET', `/events?limit=${limit}${since ? `&since=${encodeURIComponent(since)}` : ''}`);
  const from = since ? new Date(since).getTime() : Date.now() - 86400000;
  return (await local.list(L.events)).filter((e) => new Date(e.at).getTime() >= from).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
}
export async function eventPhoto(id) {
  if (onV2()) { const r = await call('GET', `/events/${id}/photo`); return r?.photo || ''; }
  return (await local.list(L.events)).find((e) => e.id === id)?.photo || '';
}
export async function enrolments(deviceId) {
  if (onV2()) return call('GET', `/devices/${deviceId}/enrolments`);
  const d = (await local.list(L.devices)).find((x) => x.id === deviceId);
  if (!d || d.status !== 'Active') return [];
  return (await demoWanted()).map((w) => ({ deviceId, employeeNo: w.subjectId.replace(/-/g, '').slice(0, 32), ...w, state: 'Enrolled', lastError: null, syncedAt: now() }));
}
export async function listFaces() {
  if (onV2()) return call('GET', '/faces');
  const [faces, people, users, wanted] = await Promise.all([local.list(L.faces), secureStorage.list(C.GATE_PEOPLE).catch(() => []), secureStorage.list(C.USERS).catch(() => []), demoWanted()]);
  const on = new Set(wanted.map((w) => keyOf(w.subjectKind, w.subjectId)));
  const devices = (await local.list(L.devices)).filter((d) => d.status === 'Active').length;
  return faces.map((f) => {
    const p = f.subjectKind === 'person' ? people.find((x) => x.id === f.subjectId) : users.find((x) => x.id === f.subjectId);
    return { subjectKind: f.subjectKind, subjectId: f.subjectId, name: p?.name || '—', hasPhoto: f.subjectKind === 'person' ? !!p?.photo : !!f.photo, cardNo: f.cardNo || null,
      consentAt: f.consentAt || null, consentText: f.consentText || null, withdrawnAt: f.withdrawnAt || null, onDevices: `${on.has(keyOf(f.subjectKind, f.subjectId)) ? devices : 0} of ${devices}` };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
/** One person's consent (null when none is recorded). */
export async function getFace(kind, id) {
  if (onV2()) return call('GET', `/faces/${kind}/${id}`);
  return (await listFaces()).find((f) => f.subjectKind === kind && f.subjectId === id) || null;
}

// ---- changes -------------------------------------------------------------------------------------------------------------------------------
/** Add (no id) or change a device. A blank password keeps the stored one. */
export async function saveDevice(id, fields) {
  if (onV2()) return id ? call('PUT', `/devices/${id}`, fields) : call('POST', '/devices', fields);
  if (!String(fields.name || '').trim()) throw new Error('Name the device');
  if (fields.driver === 'hikvision-isapi' && (!fields.bridgeId || !String(fields.host || '').trim())) throw new Error('Choose the site bridge and enter the device\'s address');
  const was = id ? (await local.list(L.devices)).find((d) => d.id === id) : null;
  if (!was && fields.driver === 'hikvision-isapi' && !fields.password) throw new Error("Enter the device's admin password");
  const caps = fields.capabilities?.length ? fields.capabilities : fields.kind === 'Face terminal' ? ['Face', 'Card', 'QR', 'Relay'] : [];
  const { password, ...rest } = fields;
  const d = { ...(was || { id: uuid(), shortId: `GDV-${String((await local.list(L.devices)).length + 1).padStart(4, '0')}`, online: true, lastSeenAt: now(), clockDriftS: 0, enrolledCount: 0, lastError: null, lastEventNo: 0, version: 0 }),
    ...rest, capabilities: caps, hasPassword: !!(password || was?.hasPassword), gate: fields.gate || 'Main gate', direction: fields.direction || 'In', status: fields.status || 'Active', version: (was?.version || 0) + 1 };
  await local.put(L.devices, d); done();
  return d;
}
/** A new bridge and its token, shown this once. */
export async function addBridge(name) {
  if (onV2()) return call('POST', '/bridges', { name });
  const token = `cosb_demo${uuid().replace(/-/g, '')}`;
  const b = { id: uuid(), shortId: `GBR-${String((await local.list(L.bridges)).length + 1).padStart(4, '0')}`, name, status: 'Active', tokenHint: token.slice(-4), lastSeenAt: null, agentVersion: null, createdAt: now() };
  await local.put(L.bridges, b); done();
  return { bridge: b, token };
}
export async function revokeBridge(id) {
  if (onV2()) return call('POST', `/bridges/${id}/revoke`);
  const b = (await local.list(L.bridges)).find((x) => x.id === id);
  if (b) { await local.put(L.bridges, { ...b, status: 'Revoked' }); done(); }
  return null;
}
/** Record or withdraw consent; for staff, their own face photo; a card number for the QR / M1 card. */
export async function saveFace(kind, id, { consent, photo = null, cardNo = null, text = null }) {
  if (onV2()) return call('PUT', `/faces/${kind}/${id}`, { consent: !!consent, photo: photo || null, cardNo: cardNo || null, text: text || null });
  if (cardNo && !/^\d{4,20}$/.test(cardNo)) throw new Error('A card number is 4 to 20 digits');
  if (photo && kind !== 'member') throw new Error("A registry person's face is their registry photo: change it there");
  const all = await local.list(L.faces);
  if (cardNo && all.some((f) => f.cardNo === cardNo && !(f.subjectKind === kind && f.subjectId === id))) throw new Error(`Card ${cardNo} is given to someone else already`);
  const was = all.find((f) => f.subjectKind === kind && f.subjectId === id);
  const had = was?.consentAt && !was.withdrawnAt;
  const rec = consent
    ? { ...(was || {}), id: keyOf(kind, id), subjectKind: kind, subjectId: id, consentAt: had ? was.consentAt : now(), consentText: text || CONSENT_TEXT, withdrawnAt: null, cardNo: cardNo || null, photo: photo || was?.photo || null }
    : { ...(was || {}), id: keyOf(kind, id), subjectKind: kind, subjectId: id, withdrawnAt: had ? now() : was?.withdrawnAt || null, photo: null, cardNo: cardNo || null };
  await local.put(L.faces, rec); done();
  return getFace(kind, id);
}
/** Open the device's door from the screen (always flagged). */
export async function openDoor(device, reason) {
  if (onV2()) return call('POST', `/devices/${device.id}/open`, { reason });
  const { raiseFlag } = await import('../gate/engine.js');
  await raiseFlag({ type: 'Manual open', personName: '', gate: device.gate, detail: `The door of ${device.name} was opened from the screen: ${reason}` });
  done(C.GATE_FLAGS);
  return null;
}
export async function resync(deviceId) { if (onV2()) return call('POST', `/devices/${deviceId}/resync`); return { enrol: (await demoWanted()).length, remove: 0, unchanged: 0 }; }
export async function syncNow() { if (onV2()) return call('POST', '/sync'); return { enrol: 0, remove: 0, unchanged: (await demoWanted()).length }; }

/**
 * The browser demo only: someone presents a face (or card) at a demo terminal. Registry people go through the gate's own rules,
 * staff open or close their gate visit and their attendance, and someone unknown is flagged.
 */
export async function demoPunch(device, who, { credential = 'Face' } = {}) {
  if (onV2()) throw new Error('On the server, punches come from the devices themselves');
  const engine = await import('../gate/engine.js');
  const how = `${credential} · ${device.name}`;
  const events = await local.list(L.events);
  const no = events.filter((e) => e.deviceId === device.id).reduce((m, e) => Math.max(m, e.eventNo), 0) + 1;
  const ev = { id: uuid(), deviceId: device.id, deviceName: device.name, gate: device.gate, eventNo: no, at: now(), receivedAt: now(), credential, subjectKind: who?.kind || null,
    subjectId: who?.id || null, name: who?.name || null, direction: null, result: 'Allowed', reason: null, outcome: '', counted: false, visitId: null, sessionId: null, hasPhoto: false };
  const visits = await secureStorage.list(C.GATE_VISITS).catch(() => []);
  if (!who) {
    await engine.raiseFlag({ type: 'Device entry', personName: 'Unknown person', gate: device.gate, detail: `${device.name} let in someone CommunityOS does not know (${credential.toLowerCase()}).` });
    Object.assign(ev, { outcome: 'Unknown person: flagged' });
  } else if (who.kind === 'person') {
    const inside = visits.some((v) => v.personId === who.id && v.state === 'Inside');
    const goIn = device.direction === 'In' || (device.direction === 'Both' && !inside);
    const r = goIn ? await engine.admitPerson(who.record, { gate: device.gate, method: how }) : await engine.exitPerson(who.record, how);
    Object.assign(ev, { direction: goIn ? 'In' : 'Out', counted: !!r.ok, visitId: r.visit?.id || null, result: r.ok || !goIn ? 'Allowed' : 'Refused',
      outcome: r.ok ? (goIn ? 'In' : 'Out') + (r.reason ? ` · ${r.reason}` : '') : `Not let in: ${r.reason}` });
  } else {
    const r = await engine.badgeEntry({ id: who.id, name: who.name }, { gate: device.gate });
    const goIn = r.direction === 'In';
    const att = await secureStorage.list(C.ATTENDANCE).catch(() => []);
    const open = att.filter((a) => a.staffName === who.name && !a.clockOut).sort((a, b) => String(b.clockIn).localeCompare(String(a.clockIn)))[0];
    let outcome;
    try {
    if (goIn && !open) { await secureStorage.put(C.ATTENDANCE, { staffName: who.name, roleName: who.roleName || '', date: now().slice(0, 10), clockIn: now(), clockOut: '', source: 'Device', inSite: 'Inside site', note: `In at ${device.name}` }); outcome = 'In · On duty'; }
    else if (!goIn && open) { const hours = Math.max(0, Math.round(((Date.now() - new Date(open.clockIn)) / 3600000) * 100) / 100); await secureStorage.put(C.ATTENDANCE, { ...open, clockOut: now(), hours, outSite: 'Inside site' }); outcome = `Out · Off duty after ${hours} h`; }
    else outcome = goIn ? 'In · Already on duty' : 'Out · Was not on duty';
    } catch (e) { outcome = `${r.direction} · attendance not recorded (${e.message})`; }
    Object.assign(ev, { direction: r.direction, counted: true, visitId: r.visit?.id || null, outcome });
    announceChange(C.ATTENDANCE);
  }
  await local.put(L.events, ev);
  const d = (await local.list(L.devices)).find((x) => x.id === device.id);
  if (d) await local.put(L.devices, { ...d, lastEventNo: no });
  done(C.GATE_VISITS, C.GATE_FLAGS);
  return ev;
}
