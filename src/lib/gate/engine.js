// GateGuard rules engine. Everything the gate DECIDES lives here, not in the screens: who may enter, when a resident must be asked,
// what a delivery rider is allowed, when a record becomes a ghost entry flag. The screens and the gate-device simulator only call
// these functions, so when the Spring Boot backend takes over, this file is the specification of its gate service.
import { secureStorage } from '../storage/secureStorage.js';
import { storage, COLLECTIONS } from '../storage/index.js';
import { getPrincipal } from '../security/principal.js';
import { pushNotifications } from '../notifications.js';
import { alsoRolesOf, queueExtraChannels } from '../notify.js';
import { uuid } from '../uuid.js';
import { avatar } from './photo.js';
import { DAYS, DEFAULT_SETTINGS, GATE_EVENTS, VILLA_CLASSES, CREW_CLASSES } from './constants.js';
import * as v2 from './v2gate.js';   // on the v2 back end the server's gate desk decides: these functions hand over to it

const C = COLLECTIONS;
export const iso = (d = new Date()) => d.toISOString();
// While a sweep runs, each collection is read ONCE and shared by its steps (approvals, flags, patrols, silence, digest all look at the same lists).
// The memo lives only for that run and a write through put() drops that collection from it.
let memo = null;
const memoRead = (key, read) => { if (!memo) return read(); if (!memo.has(key)) memo.set(key, read()); return memo.get(key).then((r) => (Array.isArray(r) ? [...r] : r)); };
const list = (c) => memoRead(`s:${c}`, () => secureStorage.list(c));
const rawList = (c) => memoRead(`r:${c}`, () => storage.list(c));
const put = (c, r) => { memo?.delete(`s:${c}`); memo?.delete(`r:${c}`); return secureStorage.put(c, r, { label: 'Gate' }).finally(() => { memo?.delete(`s:${c}`); memo?.delete(`r:${c}`); }); };
const me = () => getPrincipal()?.name || 'Gate';
const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
export const dayOf = (d = new Date()) => DAYS[(d.getDay() + 6) % 7];
const todayStr = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addMin = (d, m) => new Date(d.getTime() + m * 60000);
const minutes = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const atTime = (d, t) => { const m = minutes(t); if (m == null) return null; const x = new Date(d); x.setHours(Math.floor(m / 60), m % 60, 0, 0); return x; };
export const ago = (isoStr) => { const m = Math.max(0, Math.round((Date.now() - new Date(isoStr).getTime()) / 60000)); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min ago` : new Date(isoStr).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }); };

/** Is this person's entry window open right now? `days` empty = every day; blank times = any time. */
export function windowOpen({ days, fromTime, toTime }, d = new Date(), slackMin = 0) {
  if (Array.isArray(days) && days.length && !days.includes(dayOf(d))) return false;
  const now = d.getHours() * 60 + d.getMinutes(); const a = minutes(fromTime); const b = minutes(toTime);
  if (a != null && now < a - slackMin) return false;
  if (b != null && now > b + slackMin) return false;
  return true;
}

// ---- settings ---------------------------------------------------------------------------------------------------------------
export async function getSettings() {
  let row = null;
  try { const rows = await rawList(C.GATE_SETTINGS); row = rows.find((r) => r.id === 'default') || rows[0]; } catch { /* none yet */ }
  const parse = (v, d) => { try { return typeof v === 'string' ? { ...d, ...JSON.parse(v) } : { ...d, ...(v || {}) }; } catch { return d; } };
  return { ...DEFAULT_SETTINGS, ...(row || {}), durations: parse(row?.durations, DEFAULT_SETTINGS.durations), events: parse(row?.events, DEFAULT_SETTINGS.events), approvedCompanies: Array.isArray(row?.approvedCompanies) && row.approvedCompanies.length ? row.approvedCompanies : DEFAULT_SETTINGS.approvedCompanies };
}
export async function saveSettings(next) {
  const rows = await rawList(C.GATE_SETTINGS); const row = rows.find((r) => r.id === 'default') || rows[0] || {};
  return put(C.GATE_SETTINGS, { ...row, ...next, id: row.id || 'default', durations: next.durations ?? row.durations, events: next.events ?? row.events });
}
export const isQuiet = (s, d = new Date()) => { const a = minutes(s.quietFrom); const b = minutes(s.quietTo); const n = d.getHours() * 60 + d.getMinutes(); if (a == null || b == null) return false; return a <= b ? n >= a && n < b : n >= a || n < b; };
export async function villaRule(unit) {
  const row = (await list(C.GATE_VILLA_RULES)).find((r) => r.unit === unit);
  return row || { unit, deliveryMode: 'Allow listed', companies: [], awayMode: false, fallback: 'Community default', tellGuestExit: false, tellStaff: false, tellDelivery: true };
}

// ---- notifications (with the picture) --------------------------------------------------------------------------------------
const ROLE_GROUPS = { security: ['committee_security', 'handyman_security'], manager: ['committee_security', 'president', 'general_secretary'], fm: ['facility_manager'] };
/** Tell the right people about a gate event. Photo is attached when the community's matrix says so (approvals always carry one). */
export async function notifyGate(event, { unit, title, body, image, approvalId, flagId, visitId }) {
  const s = await getSettings();
  const def = GATE_EVENTS.find((e) => e.id === event); if (!def) return;
  const cfg = s.events?.[event] || { on: true, photo: def.photo };
  if (!def.locked && cfg.on === false) return;
  const rule = unit && unit !== 'Common area' ? await villaRule(unit) : null;
  if (rule) { if (event === 'guest_exit' && !rule.tellGuestExit) return; if (event === 'staff_inout' && !rule.tellStaff) return; if (event === 'delivery' && rule.tellDelivery === false) return; }
  const withPhoto = def.locked && event === 'approval' ? true : cfg.photo !== false;
  const base = { kind: event === 'approval' ? 'gate_approval' : 'gate', event: `gate_${event}`, title, body, image: withPhoto ? image || '' : '', approvalId, flagId, visitId, read: false, createdAt: iso(), by: me(), link: unit && unit !== 'Common area' && event !== 'ghost' ? '#/mygate' : '#/security' };
  const rows = [];
  const parts = String(def.to).split('+');
  for (const part of parts) {
    if (part === 'villa' && unit && unit !== 'Common area') rows.push({ ...base, id: uuid(), toUnit: unit, link: '#/mygate' });
    else if (part === 'villa' && event === 'approval') rows.push({ ...base, id: uuid(), toRoleIds: ROLE_GROUPS.fm, link: '#/security' }); // an unlisted worker waits for the Facility Manager
    else if (ROLE_GROUPS[part]) rows.push({ ...base, id: uuid(), toRoleIds: ROLE_GROUPS[part], link: '#/security' });
  }
  const have = new Set(rows.flatMap((r) => r.toRoleIds || []));
  const also = (await alsoRolesOf(`gate_${event}`)).filter((r) => !have.has(r));
  if (also.length) rows.push({ ...base, id: uuid(), toRoleIds: also, link: '#/security' });
  if (rows.length) { await pushNotifications(rows); await queueExtraChannels(rows, rows); }
}

// ---- visits ---------------------------------------------------------------------------------------------------------------
export const openVisits = (visits) => visits.filter((v) => v.state === 'Inside');
const expectedFor = (kind, s, now, link, wo) => {
  if (kind === 'Resident vehicle') return '';
  if (link?.toTime) { const e = atTime(now, link.toTime); if (e) return iso(e); }
  if (wo?.toTime) { const e = atTime(now, wo.toTime); if (e) return iso(addMin(e, 30)); }
  return iso(addMin(now, Number(s.durations?.[kind] ?? 120)));
};

async function newVisit(fields, state = 'Inside') {
  const now = new Date(); const s = await getSettings();
  return put(C.GATE_VISITS, { kind: 'Guest', gate: 'Main gate', purpose: '', method: 'Guard manual', ...fields, state, inAt: iso(now), outAt: state === 'Inside' ? '' : iso(now), expectedUntil: state === 'Inside' ? (fields.expectedUntil ?? expectedFor(fields.kind || 'Guest', s, now)) : '', verifiedBy: me() });
}

export async function closeVisit(...args) {
  if (v2.onV2()) return v2.closeVisit(...args);
  return closeVisitLocal(...args);
}
async function closeVisitLocal(v, method = 'Guard') {
  const saved = await put(C.GATE_VISITS, { ...v, state: method === 'Auto' ? 'Auto-closed' : 'Exited', outAt: iso(), outMethod: method });
  if (v.kind === 'Guest') notifyGate('guest_exit', { unit: v.unit, title: `${v.name} has left`, body: `Exited ${v.gate || 'the gate'}.`, image: v.photo });
  if (v.kind === 'Maid / cook' || v.kind === 'Driver') notifyGate('staff_inout', { unit: v.unit, title: `${v.name} left`, body: `${v.kind} signed out at ${hm(new Date())}.`, image: v.photo });
  return saved;
}

// ---- approvals ------------------------------------------------------------------------------------------------------------
/** Ask a villa (or, for an unlisted worker, the Facility Manager) to let someone in. The visit waits in "Awaiting approval". */
export async function requestApproval(...args) {
  if (v2.onV2()) return v2.requestApproval(...args);
  return requestApprovalLocal(...args);
}
async function requestApprovalLocal(f) {
  const s = await getSettings(); const now = new Date();
  const unit = f.unit || 'Common area';
  const rule = unit === 'Common area' ? null : await villaRule(unit);
  const fallback = isQuiet(s, now) ? s.quietFallback : rule && rule.fallback && rule.fallback !== 'Community default' ? rule.fallback : s.fallback;
  const photo = f.photo || avatar(f.name || 'Visitor');
  const visit = await newVisit({ kind: f.kind || 'Guest', name: f.name, phone: f.phone || '', company: f.company || '', vehicle: f.vehicle || '', purpose: f.purpose || '', unit, gate: f.gate || 'Main gate', photo, ...(f.headcountIn ? { headcountIn: f.headcountIn, headcountExpected: f.headcountIn, material: f.material || '' } : {}), personId: f.personId || '', workOrderId: f.workOrderId || '', method: 'Guard approval' }, 'Awaiting approval');
  const approval = await put(C.GATE_APPROVALS, { visitId: visit.id, kind: visit.kind, name: f.name, unit, company: f.company || '', purpose: f.purpose || '', vehicle: f.vehicle || '', gate: visit.gate, photo, status: 'Pending', requestedAt: iso(now), expiresAt: iso(new Date(now.getTime() + Number(s.waitSeconds || 60) * 1000)), fallback });
  await put(C.GATE_VISITS, { ...visit, approvalId: approval.id });
  await notifyGate('approval', { unit, approvalId: approval.id, visitId: visit.id, image: photo, title: `${f.name} is at ${visit.gate}`, body: `${[f.purpose || visit.kind, f.company, f.vehicle].filter(Boolean).join(' · ')}. Approve or deny.` });
  return { visit: { ...visit, approvalId: approval.id }, approval };
}
export async function retryApproval(...args) {
  if (v2.onV2()) return v2.retryApproval(...args);
  return retryApprovalLocal(...args);
}
async function retryApprovalLocal(visit) {
  const old = (await list(C.GATE_APPROVALS)).find((a) => a.id === visit.approvalId);
  const s = await getSettings(); const now = new Date();
  const approval = await put(C.GATE_APPROVALS, { ...(old || {}), id: undefined, shortId: undefined, status: 'Pending', requestedAt: iso(now), expiresAt: iso(new Date(now.getTime() + Number(s.waitSeconds || 60) * 1000)), answeredAt: '', answeredBy: '', visitId: visit.id, name: visit.name, unit: visit.unit, photo: visit.photo, gate: visit.gate, kind: visit.kind });
  await put(C.GATE_VISITS, { ...visit, state: 'Awaiting approval', approvalId: approval.id });
  await notifyGate('approval', { unit: visit.unit, approvalId: approval.id, visitId: visit.id, image: visit.photo, title: `${visit.name} is still at ${visit.gate}`, body: 'Please approve or deny.' });
  return approval;
}
/** A resident (or the Facility Manager) answers. "Always allow" leaves a standing permission so the next visit needs no question. */
export async function answerApproval(...args) {
  if (v2.onV2()) return v2.answerApproval(...args);
  return answerApprovalLocal(...args);
}
async function answerApprovalLocal(id, decision, { always = false } = {}) {
  const ap = (await list(C.GATE_APPROVALS)).find((a) => a.id === id);
  if (!ap) return null;
  if (!['Pending', 'No answer'].includes(ap.status)) return ap; // first answer wins
  const who = getPrincipal();
  const saved = await put(C.GATE_APPROVALS, { ...ap, status: decision, answeredAt: iso(), answeredBy: who?.name || '', alwaysAllow: !!always && decision === 'Approved' });
  if (always && decision === 'Approved' && ap.unit && ap.unit !== 'Common area') {
    try {
      if (ap.kind === 'Delivery' && ap.company) {
        const r = await villaRule(ap.unit); const companies = [...new Set([...(r.companies || []), ap.company])];
        await put(C.GATE_VILLA_RULES, { ...r, companies, deliveryMode: r.deliveryMode === 'Ask me each time' ? 'Allow listed' : r.deliveryMode });
      } else {
        const t = todayStr(); const y = new Date(); y.setFullYear(y.getFullYear() + 1);
        await put(C.GATE_PASSES, { visitorName: ap.name, phone: '', unit: ap.unit, type: 'Recurring', validFrom: t, validTo: todayStr(y), fromTime: '', toTime: '', days: [], vehicle: ap.vehicle || '', usedCount: 0, code: makeCode(), photo: ap.photo, hostName: who?.name || '', status: 'Active' });
      }
    } catch { /* the answer is recorded even if the standing permission cannot be saved */ }
  }
  return saved;
}
export const makeCode = () => String(Math.floor(100000 + Math.random() * 900000));

/** Move overdue approvals to "No answer" (applying the villa's fallback) and let the visits follow what the villa answered. */
export async function sweepApprovals() {
  const aps = await list(C.GATE_APPROVALS); const visits = await list(C.GATE_VISITS); let n = 0;
  for (const a of aps) {
    if (a.status === 'Pending' && a.expiresAt && new Date(a.expiresAt) < new Date()) {
      await put(C.GATE_APPROVALS, { ...a, status: a.fallback === 'Deny' ? 'Denied' : 'No answer', answeredBy: a.fallback === 'Deny' ? 'Automatic (no answer)' : '', answeredAt: a.fallback === 'Deny' ? iso() : '' }); n++;
    }
  }
  const fresh = n ? await list(C.GATE_APPROVALS) : aps;
  for (const v of visits) {
    if (!['Awaiting approval', 'No answer'].includes(v.state)) continue;
    const a = fresh.find((x) => x.id === v.approvalId); if (!a) continue;
    const next = a.status === 'Approved' ? 'Approved' : a.status === 'Denied' ? 'Denied' : a.status === 'No answer' ? 'No answer' : null;
    if (next && next !== v.state) { await put(C.GATE_VISITS, { ...v, state: next, ...(next === 'Denied' ? { outAt: iso() } : {}) }); n++; }
  }
  return n;
}
/** Open the gate for a visitor the villa approved. With a kiosk in use the kiosk does this by face (see kioskOpen); the guard opening it by hand needs a reason and is flagged. */
export async function admitApproved(...args) {
  if (v2.onV2()) return v2.admitApproved(...args);
  return admitApprovedLocal(...args);
}
async function admitApprovedLocal(v, { manualReason = '' } = {}) {
  const s = await getSettings();
  const out = await put(C.GATE_VISITS, { ...v, state: 'Inside', inAt: iso(), expectedUntil: expectedFor(v.kind, s, new Date()), method: manualReason ? 'Manual open' : 'Guard approval', openReason: manualReason, verifiedBy: me() });
  if (manualReason) await flagManual(out, manualReason);
  return out;
}
/** The guard opened the gate by hand for someone who already had a record. Never silent: a flag says who, why and where. */
export async function flagManual(visit, reason) {
  return raiseFlag({ type: 'Manual open', visitId: visit.id, personName: visit.name, unit: visit.unit || '', gate: visit.gate || 'Main gate', photo: visit.photo, detail: `Opened by hand by ${me()}. Reason: ${reason}.` });
}
/** The face kiosk's answer for a visitor the villa approved: matched = the gate opens; not matched = the guard decides. */
export async function kioskOpen(v, { matched }) {
  if (v.state !== 'Approved') return { ok: false, reason: 'This visitor is not approved yet' };
  if (!matched) return { ok: false, outcome: 'no-match', reason: 'The kiosk did not recognise this face. The guard can open by hand with a reason.' };
  const s = await getSettings();
  const out = await put(C.GATE_VISITS, { ...v, state: 'Inside', inAt: iso(), expectedUntil: expectedFor(v.kind, s, new Date()), method: 'Kiosk face', verifiedBy: 'Kiosk' });
  return { ok: true, visit: out };
}
export const refuseVisit = (v, note = '') => (v2.onV2() ? v2.refuseVisit(v, note) : put(C.GATE_VISITS, { ...v, state: 'Refused', outAt: iso(), note: note || v.note || '' }));

// ---- passes ---------------------------------------------------------------------------------------------------------------
export function passProblem(p, d = new Date()) {
  if (p.status === 'Cancelled') return 'This pass was cancelled';
  if (p.status === 'Used') return 'This one-time pass has already been used';
  if (p.status === 'Expired') return 'This pass has expired';
  const t = todayStr(d);
  if (p.validFrom && t < p.validFrom) return `Not valid before ${p.validFrom}`;
  if (p.validTo && t > p.validTo) return `Expired on ${p.validTo}`;
  if (p.type === 'Event' && Number(p.guestCap) > 0 && Number(p.usedCount || 0) >= Number(p.guestCap)) return `Guest limit of ${p.guestCap} reached`;
  if (p.type === 'Recurring' && !windowOpen({ days: p.days, fromTime: p.fromTime, toTime: p.toTime }, d)) return 'Outside the days or hours of this pass';
  if (p.type !== 'Recurring' && (p.fromTime || p.toTime) && !windowOpen({ fromTime: p.fromTime, toTime: p.toTime }, d)) return 'Outside the hours of this pass';
  return '';
}
export async function findPasses(...args) {
  if (v2.onV2()) return v2.findPasses(...args);
  return findPassesLocal(...args);
}
async function findPassesLocal(q) {
  let t = String(q || '').trim().toLowerCase(); if (!t) return [];
  if (t.startsWith('ggp|')) t = t.split('|')[1] || '';
  return (await list(C.GATE_PASSES)).filter((p) => p.status !== 'Cancelled' && (String(p.code) === t || `${p.visitorName} ${p.phone || ''}`.toLowerCase().includes(t)));
}
export async function admitPass(...args) {
  if (v2.onV2()) return v2.admitPass(...args);
  return admitPassLocal(...args);
}
async function admitPassLocal(p, { gate = 'Main gate', photo = '', vehicle = '' } = {}) {
  const bad = passProblem(p); if (bad) return { ok: false, reason: bad };
  const s = await getSettings();
  const visit = await newVisit({ kind: 'Guest', name: p.visitorName, phone: p.phone || '', unit: p.unit, gate, vehicle: vehicle || p.vehicle || '', photo: photo || p.photo || avatar(p.visitorName), passId: p.id, method: 'QR / OTP', purpose: `${p.type} pass`, expectedUntil: iso(addMin(new Date(), Number(s.durations?.Guest ?? 240))) });
  const used = Number(p.usedCount || 0) + 1;
  await put(C.GATE_PASSES, { ...p, usedCount: used, status: p.type === 'One-time' ? 'Used' : p.status });
  notifyGate('guest_arrived', { unit: p.unit, visitId: visit.id, image: visit.photo, title: `${p.visitorName} has arrived`, body: `Came in at ${gate} with your ${p.type.toLowerCase()} pass.` });
  return { ok: true, visit };
}

// ---- flags (ghost entry) --------------------------------------------------------------------------------------------------
export async function raiseFlag(f, { watch = false } = {}) {
  const s = await getSettings(); const now = new Date();
  const flag = await put(C.GATE_FLAGS, { gate: 'Main gate', ...f, state: watch ? 'Watching' : 'Open', raisedAt: iso(now), graceUntil: watch ? iso(new Date(now.getTime() + Number(s.graceSeconds || 30) * 1000)) : '' });
  if (!watch) await notifyFlag(flag);
  return flag;
}
async function notifyFlag(flag) {
  const ev = ['Guard silence', 'Headcount mismatch', 'Missed patrol'].includes(flag.type) ? 'ghost' : ['Override entry', 'Manual open'].includes(flag.type) ? 'override' : flag.type === 'Blocked person attempt' ? 'blocked' : flag.type === 'Overstay' ? 'overstay' : 'ghost';
  await notifyGate(ev, { unit: flag.type === 'Overstay' ? flag.unit : '', flagId: flag.id, image: flag.photo, title: `${flag.type}${flag.gate ? ` · ${flag.gate}` : ''}`, body: `${flag.personName ? `${flag.personName}. ` : ''}${flag.detail || ''}` });
}
export async function resolveFlag(...args) {
  if (v2.onV2()) return v2.resolveFlag(...args);
  return resolveFlagLocal(...args);
}
async function resolveFlagLocal(flag, resolution, note = '') {
  return put(C.GATE_FLAGS, { ...flag, state: 'Closed', resolution, resolutionNote: note, resolvedBy: me(), resolvedAt: iso() });
}

/** Heartbeat from a guard console: any tap on it (or the "I'm here" button) counts as activity. Throttled so it does not write on every click. */
let lastBeat = 0;
export async function guardBeat(...args) {
  if (v2.onV2()) return v2.guardBeat(...args);
  return guardBeatLocal(...args);
}
async function guardBeatLocal(kind = 'activity', force = false) {
  const p = getPrincipal(); if (!p?.name) return;
  if (!force && Date.now() - lastBeat < 20000) return;
  lastBeat = Date.now();
  try { await storage.put(C.GATE_PULSE, { id: `pulse-${p.id || p.name}`, guard: p.name, lastAt: iso(), kind }); } catch { /* best effort */ }
}
const isGuardRole = (r) => /guard|security/i.test(r || '');
/** Guards clocked in whose console has been quiet for longer than the community's limit get a 'Guard silence' flag (once per quiet spell). */
async function sweepGuardSilence(s, now, flags) {
  const limit = Number(s.guardSilenceMinutes) || 0; if (!limit) return 0;
  let n = 0;
  const [att, pulses] = await Promise.all([rawList(C.ATTENDANCE).catch(() => []), rawList(C.GATE_PULSE).catch(() => [])]);
  for (const a of att) {
    if (a.clockOut || !isGuardRole(a.roleName)) continue;
    const beat = pulses.find((x) => x.guard === a.staffName);
    const last = Math.max(new Date(a.clockIn).getTime() || 0, beat ? new Date(beat.lastAt).getTime() : 0);
    if (now - last <= limit * 60000) continue;
    if (flags.some((f) => f.type === 'Guard silence' && f.personName === a.staffName && f.state !== 'Closed' && new Date(f.raisedAt) >= new Date(a.clockIn))) continue;
    await raiseFlag({ type: 'Guard silence', personName: a.staffName, gate: '', detail: `No activity on the gate console for ${Math.round((now - last) / 60000)} min (limit ${limit}). Clocked in ${new Date(a.clockIn).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` });
    n++;
  }
  return n;
}

/** A community-wide, name-free summary residents may see (no visitor names, photos or villas). Rebuilt by the guard console's sweep; a real backend serves it from an endpoint. */
export async function publishDigest() {
  const now = new Date(); const day = todayStr(now);
  const [visits, flags, people, att, incs, pulses] = await Promise.all([rawList(C.GATE_VISITS), rawList(C.GATE_FLAGS), rawList(C.GATE_PEOPLE), rawList(C.ATTENDANCE).catch(() => []), rawList(C.INCIDENTS).catch(() => []), rawList(C.GATE_PULSE).catch(() => [])]);
  const today = visits.filter((v) => String(v.inAt || '').slice(0, 10) === day || todayStr(new Date(v.inAt || 0)) === day);
  const guards = att.filter((a) => !a.clockOut && isGuardRole(a.roleName)).map((a) => ({ name: a.staffName, since: a.clockIn, lastSeen: pulses.find((x) => x.guard === a.staffName)?.lastAt || a.clockIn }));
  const staff = people.filter((x) => ['Maid / cook', 'Nanny / caretaker', 'Driver', 'Daily worker', 'Landscaper', 'Vendor staff', 'Contractor'].includes(x.personClass));
  const d = {
    id: 'digest', day, at: iso(now),
    entriesToday: today.filter((v) => !['Denied', 'Refused', 'Awaiting approval', 'No answer'].includes(v.state)).length,
    deliveriesToday: today.filter((v) => v.kind === 'Delivery').length,
    refusedToday: today.filter((v) => ['Denied', 'Refused'].includes(v.state)).length,
    insideNow: visits.filter((v) => v.state === 'Inside').length,
    openAlerts: flags.filter((f) => f.state === 'Open').length,
    flagsThisWeek: flags.filter((f) => now - new Date(f.raisedAt || 0) < 7 * 864e5).length,
    guardsOnDuty: guards,
    staffVetted: staff.filter((x) => x.status === 'Active').length, staffTotal: staff.length,
    incidents: incs.slice(-5).reverse().map((i) => ({ title: i.title, gate: i.gate, when: i.reportedAt, status: i.status })),
  };
  const prev = pulses.find((x) => x.id === 'digest');
  const sig = JSON.stringify({ ...d, at: '' }); if (prev && prev.sig === sig) return;
  try { await storage.put(C.GATE_PULSE, { ...d, sig }); } catch { /* best effort */ }
}
export async function readDigest() { try { return (await rawList(C.GATE_PULSE)).find((x) => x.id === 'digest') || null; } catch { return null; } }

/** The ghost detector: runs on a timer on the guard's screen. Watching flags raise after their grace window unless a record appeared; open visits past their time become overstay flags; old pass visits close themselves. */
let sweeping = null;
/** One sweep at a time: the timer, the screen opening and a second tab's timer must not all run it at once (they would raise the same flag twice and hammer the server). */
export function sweep() {
  if (v2.onV2()) return v2.sweep();
  if (!sweeping) { memo = new Map(); sweeping = sweepOnce().finally(() => { sweeping = null; memo = null; }); }
  return sweeping;
}
async function sweepOnce() {
  let changed = await sweepApprovals();
  const s = await getSettings(); const now = new Date();
  const flags = await list(C.GATE_FLAGS); const visits = await list(C.GATE_VISITS);
  for (const f of flags) {
    if (f.state !== 'Watching' || new Date(f.graceUntil) > now) continue;
    const registered = f.personId && visits.some((v) => v.personId === f.personId && new Date(v.inAt) >= new Date(f.raisedAt) - 60000);
    if (registered) await resolveFlag(f, 'Registered late', 'A gate record appeared inside the grace window');
    else { const open = await put(C.GATE_FLAGS, { ...f, state: 'Open', raisedAt: iso(now) }); await notifyFlag(open); }
    changed++;
  }
  const grace = Number(s.overstayGraceMinutes || 10) * 60000; const autoClose = Number(s.autoCloseHours || 2) * 3600000;
  for (const v of visits) {
    if (v.state !== 'Inside' || !v.expectedUntil) continue;
    const late = now - new Date(v.expectedUntil);
    if (late > grace && !flags.some((f) => f.type === 'Overstay' && f.visitId === v.id)) {
      await raiseFlag({ type: 'Overstay', visitId: v.id, personId: v.personId || '', personName: v.name, unit: v.unit, gate: v.gate, photo: v.photo, detail: `Expected out by ${new Date(v.expectedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}; still inside.` });
      changed++;
    }
    if (v.method === 'QR / OTP' && late > autoClose) { await closeVisit(v, 'Auto'); changed++; }
  }
  await publishDigest().catch(() => {});
  changed += await sweepPatrols(now);
  changed += await sweepGuardSilence(s, now.getTime(), await list(C.GATE_FLAGS));
  if (changed) window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: C.GATE_VISITS } }));
  return changed;
}

/** Guard opens the gate with no token: allowed, but never silent. */
export async function overrideEntry(...args) {
  if (v2.onV2()) return v2.overrideEntry(...args);
  return overrideEntryLocal(...args);
}
async function overrideEntryLocal({ name, reason, photo, unit = '', gate = 'Main gate', vehicle = '' }) {
  const visit = await newVisit({ kind: 'Other', name: name || 'Unidentified person', unit, gate, vehicle, photo: photo || avatar(name || 'Override'), method: 'Override', purpose: 'Guard override', note: reason });
  await raiseFlag({ type: 'Override entry', visitId: visit.id, personName: visit.name, unit, gate, photo: visit.photo, detail: `Reason given: ${reason}` });
  return visit;
}

// ---- registered people (face terminal or guard picks from the registry) ----------------------------------------------------
const expired = (d) => !!d && todayStr() > d;
export async function admitPerson(...args) {
  if (v2.onV2()) return v2.admitPerson(...args);
  return admitPersonLocal(...args);
}
async function admitPersonLocal(person, { gate = 'Main gate', method = 'Face', unit: wanted = '' } = {}) {
  const [visits, links, orders] = await Promise.all([list(C.GATE_VISITS), list(C.GATE_LINKS), list(C.GATE_WORKORDERS)]);
  const now = new Date();
  if (visits.some((v) => v.personId === person.id && v.state === 'Inside')) return { ok: false, outcome: 'already-inside', reason: `${person.name} is already inside` };
  if (person.status === 'Blocked') {
    await raiseFlag({ type: 'Blocked person attempt', personId: person.id, personName: person.name, gate, photo: person.photo, detail: `${person.statusReason || 'Blocked person'} tried to enter by ${method.toLowerCase()}.` });
    await newVisit({ kind: 'Other', name: person.name, gate, photo: person.photo, personId: person.id, method, note: 'Blocked' }, 'Refused');
    return { ok: false, outcome: 'blocked', reason: 'This person is blocked' };
  }
  if (person.status !== 'Active') return { ok: false, outcome: 'not-active', reason: `Not cleared for entry (${person.status})` };
  if (expired(person.policeExpiry) || (person.personClass === 'Driver' && expired(person.licenceExpiry))) return { ok: false, outcome: 'expired', reason: 'A document has expired; the person must be re-validated' };
  const s = await getSettings();
  if (VILLA_CLASSES.includes(person.personClass)) {
    const mine = links.filter((l) => l.personId === person.id && l.status !== 'Ended');
    const ok = mine.filter((l) => windowOpen(l, now, 15));
    if (!ok.length) {
      await raiseFlag({ type: 'Wrong destination', personId: person.id, personName: person.name, unit: mine[0]?.unit || '', gate, photo: person.photo, detail: mine.length ? `${person.name} arrived outside the allowed days or hours.` : `${person.name} is not linked to any villa.` });
      await newVisit({ kind: person.personClass === 'Driver' ? 'Driver' : 'Maid / cook', name: person.name, gate, photo: person.photo, personId: person.id, method, note: 'Outside allowed window' }, 'Refused');
      return { ok: false, outcome: 'window', reason: mine.length ? 'Outside the allowed days or hours' : 'Not linked to any villa' };
    }
    const kind = person.personClass === 'Driver' ? 'Driver' : 'Maid / cook';
    const first = ok.find((l) => l.unit === wanted) || ok[0];
    const visit = await newVisit({ kind, name: person.name, phone: person.phone, unit: first.unit, gate, photo: person.photo, personId: person.id, method, purpose: person.personClass, vehicle: person.vehicleNo || '', expectedUntil: expectedFor(kind, s, now, first), note: ok.length > 1 ? `Also works at ${ok.filter((l) => l !== first).map((l) => l.unit).join(', ')}` : '' });
    for (const l of ok) notifyGate('staff_inout', { unit: l.unit, visitId: visit.id, image: person.photo, title: `${person.name} arrived`, body: `${person.personClass} signed in at ${hm(now)}.` });
    return { ok: true, outcome: 'admitted', visit };
  }
  if (CREW_CLASSES.includes(person.personClass)) {
    const order = orders.find((o) => o.status === 'Active' && (o.rosterIds || []).includes(person.id) && windowOpen(o, now, 30));
    if (!order) {
      const r = await requestApproval({ kind: 'Crew', name: person.name, photo: person.photo, unit: 'Common area', purpose: `Not on today's roster${person.vendor ? ` · ${person.vendor}` : ''}`, company: person.vendor, gate, personId: person.id });
      return { ok: false, outcome: 'needs-approval', reason: "Not on today's roster: sent to the Facility Manager", visit: r.visit };
    }
    const visit = await newVisit({ kind: 'Crew', name: person.name, phone: person.phone, unit: 'Common area', company: person.vendor || order.vendor, gate, photo: person.photo, personId: person.id, workOrderId: order.id, method, purpose: order.title, expectedUntil: expectedFor('Crew', s, now, null, order) });
    notifyGate('crew_inout', { unit: 'Common area', visitId: visit.id, image: person.photo, title: `${person.name} in · ${order.title}`, body: `${order.vendor || 'Crew'} · ${hm(now)}` });
    return { ok: true, outcome: 'admitted', visit };
  }
  if (person.personClass === 'Delivery rider') {
    if (!wanted) return { ok: false, outcome: 'need-villa', reason: 'Which villa is the delivery for?' };
    return deliveryDecision({ person, unit: wanted, company: person.deliveryCompany || 'Other', gate, method });
  }
  const visit = await newVisit({ kind: 'Other', name: person.name, phone: person.phone, unit: wanted, gate, photo: person.photo, personId: person.id, method });
  return { ok: true, outcome: 'admitted', visit };
}
export async function exitPerson(...args) {
  if (v2.onV2()) return v2.exitPerson(...args);
  return exitPersonLocal(...args);
}
async function exitPersonLocal(person, method = 'Face') {
  const v = (await list(C.GATE_VISITS)).find((x) => x.personId === person.id && x.state === 'Inside');
  if (!v) return { ok: false, reason: `No open visit for ${person.name}` };
  await closeVisit(v, method);
  return { ok: true, visit: v };
}

// ---- deliveries -----------------------------------------------------------------------------------------------------------
export async function deliveryDecision(...args) {
  if (v2.onV2()) return v2.deliveryDecision(...args);
  return deliveryDecisionLocal(...args);
}
async function deliveryDecisionLocal({ person = null, name = '', phone = '', photo = '', company = 'Other', unit, gate = 'Main gate', vehicle = '', method = 'Guard manual' }) {
  const s = await getSettings(); const rule = await villaRule(unit); const now = new Date();
  const who = person?.name || name || 'Delivery rider'; const pic = person?.photo || photo || avatar(who);
  const base = { kind: 'Delivery', name: who, phone: person?.phone || phone, company, unit, gate, photo: pic, personId: person?.id || '', vehicle: vehicle || person?.vehicleNo || '', purpose: `${company} delivery`, method };
  const approved = s.approvedCompanies.includes(company);
  const expecting = rule.expectingUntil && new Date(rule.expectingUntil) > now;
  let mode = rule.deliveryMode || 'Allow listed';
  if (rule.awayMode) mode = 'Leave at gate';
  else if (expecting && mode !== 'Leave at gate') mode = 'Allow all';
  if (mode === 'Leave at gate') {
    const v = await newVisit({ ...base, note: 'Left at gate' }, 'Left at gate');
    notifyGate('delivery', { unit, visitId: v.id, image: pic, title: `${company} delivery left at the gate`, body: `${who} was asked to leave it with the guard.` });
    return { ok: true, outcome: 'left', visit: v };
  }
  const listed = (rule.companies || []).length ? rule.companies.includes(company) : approved;
  const free = approved && (mode === 'Allow all' || (mode === 'Allow listed' && listed));
  if (!free) return { ...(await requestApproval({ ...base, purpose: `${company} delivery` })), ok: false, outcome: 'ask', reason: approved ? 'The villa asked to be asked' : `${company} is not an approved delivery company` };
  const v = await newVisit({ ...base, method: method === 'Face' ? 'Face' : 'Pre-approved' });
  notifyGate('delivery', { unit, visitId: v.id, image: pic, title: `${company} delivery arrived`, body: `${who} is on the way to your door.` });
  return { ok: true, outcome: 'admitted', visit: v };
}

// ---- vehicles and the ghost detector's sensors ------------------------------------------------------------------------------
export async function plateEvent({ plate, gate = 'Main gate', direction = 'In', people }) {
  const norm = (x) => String(x || '').replace(/\s+/g, '').toUpperCase();
  const veh = (await list(C.GATE_VEHICLES)).find((v) => norm(v.plate) === norm(plate));
  if (!veh) return { ok: false, outcome: 'unknown', reason: 'Plate not registered: guard handles it' };
  if (veh.status === 'Blocked') {
    await raiseFlag({ type: 'Blocked person attempt', personName: veh.owner, unit: veh.unit, gate, detail: `Blocked vehicle ${veh.plate} was read at ${gate}.` });
    return { ok: false, outcome: 'blocked', reason: 'Vehicle is blocked' };
  }
  const visits = await list(C.GATE_VISITS);
  if (veh.recurringGoods) return recurringGoods(veh, { gate, direction, people, visits });
  const open = visits.find((v) => v.vehicle && norm(v.vehicle) === norm(veh.plate) && v.state === 'Inside' && v.kind === 'Resident vehicle');
  if (direction === 'Out') { if (!open) return { ok: false, outcome: 'no-entry', reason: 'No entry on record' }; await closeVisit(open, 'FASTag'); return { ok: true, outcome: 'exited' }; }
  if (open) return { ok: false, outcome: 'already-inside', reason: 'Already inside' };
  const v = await newVisit({ kind: 'Resident vehicle', name: veh.owner || veh.plate, unit: veh.unit, gate, vehicle: veh.plate, method: 'FASTag', purpose: `${veh.vehicleClass} vehicle`, photo: avatar(veh.owner || veh.plate, 3), expectedUntil: '' });
  return { ok: true, outcome: 'admitted', visit: v };
}
/** The barrier's sensor counts what crossed. More crossed than the register shows: somebody followed somebody. */
export async function barrierCycle({ gate = 'Main gate', vehicles = 1 }) {
  const visits = await list(C.GATE_VISITS); const cutoff = Date.now() - 120000;
  const recorded = visits.filter((v) => v.gate === gate && v.vehicle && new Date(v.inAt).getTime() >= cutoff && ['Inside', 'Exited'].includes(v.state)).length;
  if (vehicles <= recorded) return { ok: true, recorded, counted: vehicles };
  const flag = await raiseFlag({ type: 'Tailgate', gate, personName: 'Unrecorded vehicle', photo: avatar('Vehicle', 5), detail: `The barrier sensor counted ${vehicles} vehicle${vehicles > 1 ? 's' : ''} in this cycle; the register has ${recorded}.` });
  return { ok: false, recorded, counted: vehicles, flag };
}
/** A camera inside the community sees a person with no open visit. Waits the grace window before it becomes a flag. */
export async function cameraSees({ gate = 'Main gate', person = null, photo = '' }) {
  if (person) {
    const open = (await list(C.GATE_VISITS)).some((v) => v.personId === person.id && v.state === 'Inside');
    if (open) return { ok: true, outcome: 'has-record' };
  }
  const flag = await raiseFlag({ type: 'Unrecorded entry', gate, personId: person?.id || '', personName: person?.name || 'Unknown person', photo: person?.photo || photo || avatar('Unknown', 6), detail: `A camera saw ${person?.name || 'a person'} inside with no open entry record.` }, { watch: true });
  return { ok: false, outcome: 'watching', flag };
}


// ======================================================================================================================
// Goods vehicles: one pass per vehicle, people counted in and counted out
// ======================================================================================================================
const normPlate = (x) => String(x || '').replace(/\s+/g, '').toUpperCase();
const goodsExpiry = (p, s, now) => { const e = p.toTime ? atTime(now, p.toTime) : null; return e ? iso(addMin(e, 30)) : iso(addMin(now, Number(s.durations?.['Goods vehicle'] ?? 240))); };

/** The guard counted `people` in the vehicle. Fewer or equal to the pass: in. More: held until the guard confirms with a reason (or let in and flagged, by the community's rule). A different plate always needs a reason. */
export async function admitGoods(...args) {
  if (v2.onV2()) return v2.admitGoods(...args);
  return admitGoodsLocal(...args);
}
async function admitGoodsLocal(p, { gate = 'Main gate', people, vehicle = '', photo = '', force = '' } = {}) {
  const bad = passProblem(p); if (bad) return { ok: false, outcome: 'pass', reason: bad };
  const n = Number(people); if (!(n >= 1)) return { ok: false, outcome: 'count', reason: 'Count the people in the vehicle, driver included' };
  const visits = await list(C.GATE_VISITS);
  if (visits.some((v) => v.passId === p.id && v.state === 'Inside')) return { ok: false, outcome: 'inside', reason: 'This vehicle is already inside' };
  const s = await getSettings(); const plate = vehicle || p.vehicle || '';
  const wrongPlate = !!p.vehicle && !!vehicle && normPlate(p.vehicle) !== normPlate(vehicle);
  const expected = Number(p.peopleCount) || 0; const extra = expected > 0 && n > expected;
  if (wrongPlate && !force) return { ok: false, outcome: 'plate', reason: `The plate is ${vehicle} but the pass is for ${p.vehicle}` };
  if (extra && !force && s.goodsExtraPeople !== 'Let in and flag') return { ok: false, outcome: 'headcount', expected, counted: n, reason: `${n} people counted but the pass allows ${expected}` };
  const now = new Date();
  const visit = await newVisit({ kind: 'Goods vehicle', name: p.visitorName || 'Goods vehicle', phone: p.phone || '', unit: p.unit || 'Common area', gate, vehicle: plate, photo: photo || p.photo || avatar(p.visitorName || 'Goods', 4), passId: p.id, method: force ? 'Manual open' : 'Goods pass', purpose: [p.goodsKind, p.material].filter(Boolean).join(' · ') || 'Goods vehicle', headcountExpected: expected, headcountIn: n, material: p.material || '', carryingOut: !!p.carryingOut, outItems: p.outItems || '', openReason: force || '', expectedUntil: goodsExpiry(p, s, now) });
  await put(C.GATE_PASSES, { ...p, usedCount: Number(p.usedCount || 0) + 1 });
  if (wrongPlate) await raiseFlag({ type: 'Manual open', visitId: visit.id, personName: visit.name, unit: visit.unit, gate, photo: visit.photo, detail: `Plate ${vehicle} let in on a pass for ${p.vehicle}. Reason: ${force}.` });
  if (extra) await raiseFlag({ type: 'Headcount mismatch', visitId: visit.id, personName: visit.name, unit: visit.unit, gate, photo: visit.photo, detail: `${n} people counted in, the pass allows ${expected}.${force ? ` Guard confirmed: ${force}.` : ''}` });
  if (p.unit) notifyGate('guest_arrived', { unit: p.unit, visitId: visit.id, image: visit.photo, title: `${p.visitorName || 'Goods vehicle'} has arrived`, body: `${plate || 'Vehicle'} came in at ${gate} with ${n} ${n === 1 ? 'person' : 'people'}${p.material ? ` carrying ${p.material}` : ''}.` });
  return { ok: true, visit };
}
/** Leaving: count the people again. A different number from the one who came in is a flag; a vehicle taking items out needs the out-pass items checked. */
export async function exitGoods(...args) {
  if (v2.onV2()) return v2.exitGoods(...args);
  return exitGoodsLocal(...args);
}
async function exitGoodsLocal(v, { people, itemsChecked = false } = {}) {
  const n = Number(people); if (!(n >= 0) || people === '' || people == null) return { ok: false, reason: 'Count the people leaving, driver included' };
  if (v.carryingOut && !itemsChecked) return { ok: false, outcome: 'items', reason: `Check the items against the out-pass${v.outItems ? `: ${v.outItems}` : ''}` };
  const saved = await put(C.GATE_VISITS, { ...v, state: 'Exited', outAt: iso(), outMethod: 'Guard', headcountOut: n });
  if (Number(v.headcountIn) !== n) await raiseFlag({ type: 'Headcount mismatch', visitId: v.id, personName: v.name, unit: v.unit, gate: v.gate, photo: v.photo, detail: `${v.headcountIn} people came in and ${n} left${n < Number(v.headcountIn) ? `. ${Number(v.headcountIn) - n} may still be inside.` : '.'}` });
  if (v.unit && v.unit !== 'Common area') notifyGate('guest_exit', { unit: v.unit, title: `${v.name} has left`, body: `${v.vehicle || 'The vehicle'} left with ${n} ${n === 1 ? 'person' : 'people'}${v.carryingOut && v.outItems ? `, carrying: ${v.outItems}` : ''}.`, image: v.photo });
  return { ok: true, visit: saved };
}
/** A regular goods vehicle (water tanker, milk van): the plate opens the gate. If the camera counted people, extra ones stop it. */
async function recurringGoods(veh, { gate, direction, people, visits }) {
  const open = visits.find((v) => v.kind === 'Goods vehicle' && v.state === 'Inside' && normPlate(v.vehicle) === normPlate(veh.plate));
  const s = await getSettings(); const usual = Number(veh.usualPeople) || 0; const counted = people == null || people === '' ? null : Number(people);
  if (direction === 'Out') {
    if (!open) return { ok: false, outcome: 'no-entry', reason: 'No entry on record' };
    const r = await exitGoods({ ...open, carryingOut: false }, { people: counted ?? open.headcountIn });
    return { ...r, outcome: 'exited' };
  }
  if (open) return { ok: false, outcome: 'already-inside', reason: 'Already inside' };
  if (counted != null && usual && counted > usual && s.goodsExtraPeople !== 'Let in and flag') return { ok: false, outcome: 'headcount', reason: `${counted} people counted, ${usual} usual. The guard decides.` };
  const v = await newVisit({ kind: 'Goods vehicle', name: veh.owner || veh.plate, unit: veh.unit || 'Common area', gate, vehicle: veh.plate, method: 'FASTag', purpose: veh.material || 'Regular goods vehicle', photo: avatar(veh.owner || veh.plate, 4), headcountExpected: usual, headcountIn: counted ?? usual, material: veh.material || '', note: counted == null ? 'People not counted: usual number assumed' : '' });
  if (counted != null && usual && counted > usual) await raiseFlag({ type: 'Headcount mismatch', visitId: v.id, personName: v.name, unit: v.unit, gate, photo: v.photo, detail: `${counted} people counted in a regular vehicle that usually carries ${usual}.` });
  return { ok: true, outcome: 'admitted', visit: v };
}

// ======================================================================================================================
// Passes: QR text and the message a resident shares
// ======================================================================================================================
export const passQrText = (p) => `GGP|${p.code}`;
/**
 * A link that opens the pass's QR and code for the guest, without signing in (the pass page, PublicPass.jsx). Everything it shows is in the
 * link's # part, which browsers never send to a server - it carries only what the message itself already says.
 */
export function passLink(p, { community = '', host = '', base } = {}) {
  const here = base || (typeof window !== 'undefined' ? `${window.location.origin}${window.location.pathname}` : '');
  const q = new URLSearchParams();
  const put = (k, v) => { if (v) q.set(k, String(v)); };
  put('c', p.code); put('g', p.visitorName); put('h', host || p.hostName); put('u', p.unit); put('s', community);
  put('f', p.validFrom); put('t', p.validTo && p.validTo !== p.validFrom ? p.validTo : ''); put('ft', p.fromTime); put('tt', p.toTime); put('v', p.vehicle); put('k', p.type);
  return `${here}#/pass?${q.toString()}`;
}
/** What a pass link says (for the pass page): null when it is not a pass link. */
export function readPassLink(hash) {
  const m = /^#\/pass\?(.*)$/.exec(hash || '');
  if (!m) return null;
  const q = new URLSearchParams(m[1]);
  const code = (q.get('c') || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
  if (!code) return null;
  const g = (k) => (q.get(k) || '').slice(0, 120);
  return { code, visitorName: g('g'), hostName: g('h'), unit: g('u'), community: g('s'), validFrom: g('f'), validTo: g('t') || g('f'), fromTime: g('ft'), toTime: g('tt'), vehicle: g('v'), type: g('k') };
}
export function passMessage(template, p, { community = 'the community', host = '', link = '' } = {}) {
  const base = template || DEFAULT_SETTINGS.passMessage;
  // the QR travels as a link (WhatsApp and SMS carry text only): where the template does not place it, it goes at the end
  const t = link && !base.includes('{qr}') ? `${base}\nQR: {qr}` : base;
  const time = p.fromTime ? ` ${p.fromTime}${p.toTime ? `-${p.toTime}` : ''}` : '';
  const date = p.validTo && p.validTo !== p.validFrom ? `${p.validFrom} to ${p.validTo}` : p.validFrom || '';
  const veh = p.vehicle ? `Vehicle: ${p.vehicle}\n` : '';
  return t.replace(/\{guest\}/g, p.visitorName || 'there').replace(/\{host\}/g, host || p.hostName || '').replace(/\{unit\}/g, p.unit || '').replace(/\{community\}/g, community).replace(/\{pin\}/g, p.code || '').replace(/\{date\}/g, date).replace(/\{time\}/g, time).replace(/\{vehicle\}/g, veh).replace(/\{gate\}/g, 'the main gate').replace(/\{qr\}/g, link);
}
export const shareLinks = (phone, text) => {
  const d = String(phone || '').replace(/\D/g, ''); const num = d.length === 10 ? `91${d}` : d;
  return { whatsapp: `https://wa.me/${num}?text=${encodeURIComponent(text)}`, sms: `sms:${d}?&body=${encodeURIComponent(text)}` };
};

// ======================================================================================================================
// Patrol: checkpoints on posts, rounds on a schedule, a flag when a round is missed
// ======================================================================================================================
export const checkpointQr = (cp) => `GGCP|${cp.id}|${cp.code}`;
const atDay = (d, t) => atTime(d, t);
/** The rounds that apply on a day with their time windows. */
export function roundsFor(rounds, d = new Date()) {
  return rounds.filter((r) => r.active !== false && (!(r.days || []).length || r.days.includes(dayOf(d)))).map((r) => { const start = atDay(d, r.time); return { ...r, start, end: start ? addMin(start, Number(r.windowMin) || 60) : null }; }).filter((r) => r.start);
}
/** Which checkpoints of a round were scanned inside its window. */
export function roundProgress(round, scans) {
  const ids = round.checkpointIds || []; const done = new Set();
  scans.forEach((s) => { const t = new Date(s.at); if (ids.includes(s.checkpointId) && t >= round.start && t <= new Date(round.end.getTime() + 60000)) done.add(s.checkpointId); });
  return { done: [...done], total: ids.length, complete: ids.length > 0 && done.size >= ids.length };
}
export async function scanCheckpoint(...args) {
  if (v2.onV2()) return v2.scanCheckpoint(...args);
  return scanCheckpointLocal(...args);
}
async function scanCheckpointLocal(text, { note = '' } = {}) {
  const m = /^GGCP\|([^|]+)\|(.+)$/.exec(String(text || '').trim());
  if (!m) return { ok: false, reason: 'This is not a checkpoint code' };
  const [cps, scans, rounds, s] = await Promise.all([list(C.GATE_CHECKPOINTS), list(C.GATE_SCANS), list(C.GATE_ROUNDS), getSettings()]);
  const cp = cps.find((c) => c.id === m[1]);
  if (!cp || cp.code !== m[2]) return { ok: false, reason: 'Unknown or out-of-date checkpoint code' };
  if (cp.active === false) return { ok: false, reason: `${cp.name} is not in use` };
  const guard = me(); const now = new Date();
  const mine = scans.filter((x) => x.guard === guard).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
  const gap = Number(s.patrolMinSeconds ?? 20);
  if (mine && gap > 0 && (now - new Date(mine.at)) / 1000 < gap) return { ok: false, reason: `Too soon after the last scan (${mine.checkpointName}). Walk to the next post first.` };
  const live = roundsFor(rounds, now).find((r) => now >= r.start && now <= r.end && (r.checkpointIds || []).includes(cp.id));
  const row = await put(C.GATE_SCANS, { checkpointId: cp.id, checkpointName: cp.name, guard, at: iso(now), roundId: live?.id || '', roundName: live?.name || '', day: todayStr(now), note });
  guardBeat('patrol', true);
  let progress = null;
  if (live) progress = roundProgress(live, [...scans, row]);
  return { ok: true, checkpoint: cp, round: live || null, progress };
}
/** A round whose window is over without every checkpoint scanned, while a guard was clocked in, becomes a flag (once). */
async function sweepPatrols(now) {
  const [rounds, scans, flags, att] = await Promise.all([list(C.GATE_ROUNDS), list(C.GATE_SCANS), list(C.GATE_FLAGS), rawList(C.ATTENDANCE).catch(() => [])]);
  let n = 0; const day = todayStr(now);
  for (const r of roundsFor(rounds, now)) {
    if (now <= r.end || now - r.end > 6 * 3600000) continue;
    if (flags.some((f) => f.type === 'Missed patrol' && f.roundId === r.id && f.day === day)) continue;
    const onDuty = att.some((a) => isGuardRole(a.roleName) && new Date(a.clockIn) <= r.end && (!a.clockOut || new Date(a.clockOut) >= r.start));
    if (!onDuty) continue;
    const pr = roundProgress(r, scans.filter((x) => x.day === day || new Date(x.at) >= r.start));
    if (pr.complete) continue;
    const cps = await list(C.GATE_CHECKPOINTS);
    const missing = (r.checkpointIds || []).filter((id) => !pr.done.includes(id)).map((id) => cps.find((c) => c.id === id)?.name || id);
    await raiseFlag({ type: 'Missed patrol', gate: '', personName: r.name, roundId: r.id, day, detail: `${r.name} (${r.time}) was ${pr.done.length === 0 ? 'not walked' : `only partly walked (${pr.done.length} of ${pr.total})`}. Not scanned: ${missing.join(', ')}.` });
    n++;
  }
  return n;
}

// ======================================================================================================================
// Staff badge: a QR on the person's own phone that changes every 30 seconds, so a screenshot is useless
// ======================================================================================================================
const BADGE_STEP = 30000;
async function badgeKey(userId) {
  const s = await getSettings(); const secret = `${s.badgeSalt || 'communityos-demo-secret'}|${userId}`;
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
async function badgeMac(userId, win) {
  const sig = await crypto.subtle.sign('HMAC', await badgeKey(userId), new TextEncoder().encode(String(win)));
  return [...new Uint8Array(sig)].slice(0, 5).map((b) => b.toString(16).padStart(2, '0')).join('');
}
export async function badgeText(userId, at = Date.now()) {
  if (v2.onV2()) return v2.badgeText(userId, at);
  const win = Math.floor(at / BADGE_STEP); return `GGB|${userId}|${win}|${await badgeMac(userId, win)}`; }
/** Check a scanned badge: right person, current code (this 30 s or the one before), and still an active user. */
export async function verifyBadge(text, at = Date.now()) {
  if (v2.onV2()) return v2.verifyBadge(text);
  const m = /^GGB\|([^|]+)\|(\d+)\|([0-9a-f]+)$/.exec(String(text || '').trim());
  if (!m) return { ok: false, reason: 'This is not a staff badge' };
  const win = Number(m[2]); const now = Math.floor(at / BADGE_STEP);
  if (win > now + 1 || win < now - 1) return { ok: false, reason: 'This badge code is old. Ask the person to open their badge again; screenshots do not work.' };
  if ((await badgeMac(m[1], win)) !== m[3]) return { ok: false, reason: 'The badge code is not valid' };
  const u = (await rawList(C.USERS)).find((x) => x.id === m[1]);
  if (!u) return { ok: false, reason: 'No such staff member' };
  if (u.status === 'Inactive') return { ok: false, reason: `${u.name} is no longer active` };
  return { ok: true, user: u };
}
/** Badge scanned at the gate: opens a Crew visit, or closes the open one. */
export async function badgeEntry(user, { gate = 'Main gate' } = {}) {
  if (v2.onV2()) return v2.badgeEntry(user, { gate });
  const visits = await list(C.GATE_VISITS);
  const open = visits.find((v) => v.memberId === user.id && v.state === 'Inside');
  if (open) { await closeVisit(open, 'Staff badge'); return { ok: true, direction: 'Out', visit: open }; }
  const v = await newVisit({ kind: 'Staff', name: user.name, unit: 'Common area', gate, memberId: user.id, photo: avatar(user.name), method: 'Staff badge', purpose: 'Staff', expectedUntil: '' });
  return { ok: true, direction: 'In', visit: v };
}
