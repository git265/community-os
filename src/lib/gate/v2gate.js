// The gate desk on the v2 back end: every decision the engine (engine.js) makes in the browser is made by the server instead (GateService);
// these functions turn the engine's calls into the desk commands and give back the shapes the screens expect ({ ok, outcome, reason, visit }).
import { apiFetch } from '../net/request.js';
import { getDataSource } from '../storage/dataSource.js';
import { gatePassOf, gateVisitOf, gateApprovalOf, gateFlagOf } from '../storage/v2/v2map.js';

export const onV2 = () => getDataSource().mode === 'v2';

async function call(path, body, headers = {}) {
  const res = await apiFetch(`/v1${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body), headers });
  let out = null; try { out = res.status === 204 ? null : await res.json(); } catch { /* no body */ }
  if (!res.ok) { const e = new Error(out?.detail || `Gate: ${res.status}`); e.status = res.status; e.code = out?.code; throw e; }
  if (body !== undefined) (await import('../storage/index.js')).forgetKept();   // a desk command can change the people and vehicle lists
  return out;
}
const ifMatch = (v) => ({ 'If-Match': `"${v}"` });
const unitId = async (no) => { if (!no || no === 'Common area') return null; const { unitIdByNo } = await import('../storage/v2/V2ApiAdapter.js'); return unitIdByNo(no); };
/** A server outcome as the engine's { ok, outcome, reason, visit, approval }. */
const outcome = (o) => ({ ok: o.ok, outcome: o.outcome, reason: o.reason || '', visit: o.visit ? gateVisitOf(o.visit) : null, approval: o.approval ? gateApprovalOf(o.approval) : null });
/** A refusal the guard should see (a rule), not an exception. */
const soft = async (work) => { try { return await work(); } catch (e) { if (e.status === 422 || e.status === 409 || e.status === 403) return { ok: false, outcome: e.code || 'refused', reason: e.message }; throw e; } };

export const findPasses = async (q) => (await call(`/gate/passes/search?q=${encodeURIComponent(q || '')}`)).map((x) => ({ ...gatePassOf(x.pass), problem: x.problem }));
export const admitPass = (p, { gate = 'Main gate', photo = '', vehicle = '' } = {}) => soft(async () => outcome(await call(`/gate/passes/${p.id}/admit`, { gate, vehicle: vehicle || null, photo: photo || null })));
export async function requestApproval(f) {
  const o = await call('/gate/visits/ask', { kind: f.kind || 'Guest', name: f.name, phone: f.phone || null, company: f.company || null, vehicle: f.vehicle || null, purpose: f.purpose || null,
    unitId: await unitId(f.unit), gate: f.gate || 'Main gate', photo: f.photo || null, personId: f.personId || null, workOrderId: f.workOrderId || null, headcount: f.headcountIn || null, material: f.material || null });
  return { visit: gateVisitOf(o.visit), approval: gateApprovalOf(o.approval) };
}
export async function retryApproval(visit) { return outcome(await call(`/gate/visits/${visit.id}/ask-again`, {}, ifMatch(visit.version))).approval; }
export async function answerApproval(id, decision, { always = false } = {}) { return gateApprovalOf(await call(`/gate/approvals/${id}/answer`, { decision, always })); }
export async function admitApproved(v, { manualReason = '' } = {}) { return gateVisitOf(await call(`/gate/visits/${v.id}/admit`, { manualReason: manualReason || null }, ifMatch(v.version))); }
export async function refuseVisit(v, note = '') { return gateVisitOf(await call(`/gate/visits/${v.id}/refuse`, { note: note || null }, ifMatch(v.version))); }
export async function closeVisit(v, method = 'Guard') { return gateVisitOf(await call(`/gate/visits/${v.id}/exit`, { method }, ifMatch(v.version))); }
export async function overrideEntry({ name, reason, photo, unit = '', gate = 'Main gate', vehicle = '' }) {
  return gateVisitOf(await call('/gate/visits/override', { name: name || null, reason, photo: photo || null, unitId: await unitId(unit), gate, vehicle: vehicle || null }));
}
export const admitPerson = (person, { gate = 'Main gate', method = 'Face', unit = '' } = {}) => soft(async () => outcome(await call(`/gate/people/${person.id}/admit`, { gate, method, unitId: await unitId(unit) })));
export const exitPerson = (person, method = 'Face') => soft(async () => ({ ok: true, visit: gateVisitOf(await call(`/gate/people/${person.id}/exit`, { method })) }));
export const deliveryDecision = ({ person = null, name = '', phone = '', photo = '', company = 'Other', unit, gate = 'Main gate', vehicle = '' }) => soft(async () => (person
  ? outcome(await call(`/gate/people/${person.id}/admit`, { gate, method: 'Guard manual', unitId: await unitId(unit) }))
  : outcome(await call('/gate/visits/delivery', { name: name || null, phone: phone || null, photo: photo || null, company, unitId: await unitId(unit), gate, vehicle: vehicle || null }))));
export const admitGoods = (p, { gate = 'Main gate', people, vehicle = '', photo = '', force = '' } = {}) => soft(async () => outcome(await call(`/gate/passes/${p.id}/admit-goods`,
  { gate, people: Number(people), vehicle: vehicle || null, photo: photo || null, force: force || null })));
export const exitGoods = (v, { people, itemsChecked = false } = {}) => soft(async () => ({ ok: true, visit: gateVisitOf(await call(`/gate/visits/${v.id}/exit-goods`, { people: Number(people), itemsChecked }, ifMatch(v.version))) }));
export async function resolveFlag(flag, resolution, note = '') { return gateFlagOf(await call(`/gate/flags/${flag.id}/resolve`, { resolution, note: note || null }, ifMatch(flag.version))); }
export const scanCheckpoint = (text, { note = '' } = {}) => soft(async () => {
  const r = await call('/gate/scans', { text, note: note || null });
  return { ok: true, checkpoint: { name: r.checkpoint }, round: r.round ? { name: r.round } : null, progress: r.round ? { done: Array(r.done).fill(0), total: r.total, complete: r.complete } : null };
});
// staff badges: signed by the server with the community's key; the code is fetched once per 30-second window
let badgeCache = { window: -1, text: '' };
export async function badgeText(_userId, at = Date.now()) {
  const w = Math.floor(at / 30000);
  if (badgeCache.window !== w) { const b = await call('/gate/badge/mine'); badgeCache = { window: w, text: b.text }; }
  return badgeCache.text;
}
export async function verifyBadge(text) {
  try { const h = await call('/gate/badge/check', { code: String(text || '').trim() }); return { ok: true, direction: h.direction, user: { id: h.memberId, name: h.name, roleId: h.roleName || 'Staff', code: String(text).trim() } }; }
  catch (e) { if (e.status === 422 || e.status === 403) return { ok: false, reason: e.message }; throw e; }
}
export const badgeEntry = (user, { gate = 'Main gate' } = {}) => soft(async () => {
  const o = outcome(await call('/gate/badge', { code: user.code, gate }));
  return o.ok ? { ok: true, direction: o.outcome === 'out' ? 'Out' : 'In', visit: o.visit } : o;
});
export async function guardBeat() { try { await call('/gate/beat', {}); } catch { /* best effort */ } }
/** The server sweeps every half minute; the console only re-reads. */
export async function sweep() { return 0; }
