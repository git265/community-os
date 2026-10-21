// StorageAdapter over the TYPED v2 API (backend/api, /api/v1). The app keeps calling storage.list / get / put; this adapter turns those calls
// into the resource endpoints and maps the records (v2map.js). The server decides every read and write (row scope, permissions, versions,
// audit); nothing here is trusted by it.
//
//   properties  GET /v1/units (paged), GET /v1/units/{id}, PATCH /v1/units/{id} with If-Match
//   users       GET /v1/members, GET /v1/members/{id}, POST /v1/members (new), PUT /v1/members/{id}/roles, POST /v1/members/{id}/deactivate
//   dues        GET /v1/dues, GET /v1/dues/{id}, POST /v1/dues (new), POST /v1/dues/{id}/cancel | /waive (status change) - a bill is never edited
//   roles       GET /v1/roles (read-only here)
//   app configuration (schema, communityConfig, financeSettings, roleGroups): kept in this browser until the v2 API has endpoints for them
//   everything else: not on the v2 API yet - reads answer empty, writes are refused with a clear message (nothing is silently dropped)
import { apiFetch } from '../../net/request.js';
import { AuthzError, ConflictError } from '../../security/errors.js';
import { SessionStorageAdapter } from '../SessionStorageAdapter.js';
import { propertyOf, unitPatch, userOf, dueOf, raiseBody, roleOf } from './v2map.js';

export const V2_COLLECTIONS = ['properties', 'users', 'dues', 'roles'];
export const LOCAL_COLLECTIONS = ['schema', 'communityConfig', 'financeSettings', 'roleGroups'];

export class NotOnV2Error extends Error { constructor(collection) { super(`"${collection}" is not on the v2 back end yet - this screen works with the Browser session or the v1 back end.`); this.name = 'NotOnV2Error'; } }

async function call(path, init = {}) {
  const res = await apiFetch(`/v1${path}`, init);
  if (res.status === 404 && (init.method || 'GET') === 'GET') return null;
  if (!res.ok) {
    let body = null; try { body = await res.json(); } catch { /* not JSON */ }
    const msg = body?.detail || `Back end error ${res.status}`;
    if (res.status === 403) throw new AuthzError(msg);
    if (res.status === 409 || res.status === 412) throw new ConflictError(null, msg);
    const e = new Error(msg); e.status = res.status; e.code = body?.code; e.fields = body?.fields; throw e;
  }
  return res.status === 204 ? null : res.json();
}
const json = (method, body, headers = {}) => ({ method, body: JSON.stringify(body), headers });
const ifMatch = (v) => ({ 'If-Match': `"${v}"` });

/** Every page of a list (the server caps a page at 200). */
async function all(path) {
  const out = []; const sep = path.includes('?') ? '&' : '?';
  for (let offset = 0; ; offset += 200) {
    const p = await call(`${path}${sep}limit=200&offset=${offset}`);
    out.push(...p.items);
    if (out.length >= p.total || !p.items.length) return out;
  }
}
async function unitIndex() {
  const units = await all('/units');
  return { noById: Object.fromEntries(units.map((u) => [u.id, u.unitNo])), idByNo: Object.fromEntries(units.map((u) => [u.unitNo, u.id])) };
}

const readers = {
  properties: { list: async () => (await all('/units')).map(propertyOf), get: async (id) => { const u = await call(`/units/${encodeURIComponent(id)}`); return u && propertyOf(u); } },
  users: {
    list: async () => { const { noById } = await unitIndex(); return (await all('/members')).map((m) => userOf(m, noById)); },
    get: async (id) => { const m = await call(`/members/${encodeURIComponent(id)}`); if (!m) return null; const { noById } = await unitIndex(); return userOf(m, noById); },
  },
  dues: { list: async () => (await all('/dues')).map((d) => dueOf(d)), get: async (id) => { const d = await call(`/dues/${encodeURIComponent(id)}`); return d && dueOf(d); } },
  roles: { list: async () => (await call('/roles')).map(roleOf), get: async (id) => (await readers.roles.list()).find((r) => r.id === id) || null },
};

async function putProperty(rec) {
  const before = await readers.properties.get(rec.id);
  if (!before) throw new NotOnV2Error('new units');   // units are created when the community is set up
  const body = unitPatch(before, rec);
  if (!body) return before;
  return propertyOf(await call(`/units/${encodeURIComponent(rec.id)}`, json('PATCH', body, ifMatch(rec.version ?? before.version))));
}

async function putUser(rec) {
  const before = rec.id ? await readers.users.get(rec.id) : null;
  if (!before) {
    const { idByNo, noById } = await unitIndex();
    const unitId = rec.units?.[0] ? idByNo[rec.units[0]] || null : null;
    const m = await call('/members', json('POST', { phone: rec.phone, fullName: rec.name, displayName: rec.name, roleCode: rec.roleId, unitId, relation: unitId ? (rec.relation || 'Owner') : null }));
    return userOf(m, noById);
  }
  let out = before;
  const roles = [rec.roleId, ...(rec.extraRoleIds || [])].filter(Boolean);
  const had = [before.roleId, ...before.extraRoleIds];
  if (JSON.stringify(roles) !== JSON.stringify(had)) {
    const { noById } = await unitIndex();
    out = userOf(await call(`/members/${encodeURIComponent(rec.id)}/roles`, json('PUT', { roleCodes: roles, primaryRoleCode: rec.roleId }, ifMatch(rec.version ?? before.version))), noById);
  }
  if (rec.status === 'Inactive' && before.status !== 'Inactive') {
    const { noById } = await unitIndex();
    out = userOf(await call(`/members/${encodeURIComponent(rec.id)}/deactivate`, { method: 'POST', headers: ifMatch(out.version) }), noById);
  }
  return out;
}

async function putDue(rec) {
  const before = rec.id ? await readers.dues.get(rec.id) : null;
  if (!before) {
    const { idByNo } = await unitIndex();
    return dueOf(await call('/dues', json('POST', raiseBody(rec, idByNo))));
  }
  const to = rec.status;
  if ((to === 'Cancelled' || to === 'Waived') && before.serverStatus !== to) {
    const verb = to === 'Cancelled' ? 'cancel' : 'waive';
    return dueOf(await call(`/dues/${encodeURIComponent(rec.id)}/${verb}`, json('POST', { reason: rec.cancelReason || rec.reason || '' }, ifMatch(rec.version ?? before.version))));
  }
  if (to === 'Paid' && before.serverStatus !== 'Paid') throw new Error('A bill is marked paid by recording the payment (Payments), not by editing the bill.');
  return before;   // a bill's amounts are never edited: a correction is a new bill
}

const WRITERS = { properties: putProperty, users: putUser, dues: putDue };
const warned = new Set();
const notYet = (c) => { if (!warned.has(c)) { warned.add(c); console.info(`[v2] "${c}" is not on the v2 back end yet; showing it empty.`); } };

/** @type {import('../StorageAdapter').StorageAdapter} */
export const V2ApiAdapter = {
  async list(c) {
    if (readers[c]) return readers[c].list();
    if (LOCAL_COLLECTIONS.includes(c)) return SessionStorageAdapter.list(c);
    notYet(c); return [];
  },
  async query(c, params = {}) {
    const rows = await this.list(c);
    const { runQuery } = await import('../queryEngine.js');   // same paging / sort / search as the session store
    return runQuery(rows, params);
  },
  async get(c, id) {
    if (readers[c]) return readers[c].get(id);
    if (LOCAL_COLLECTIONS.includes(c)) return SessionStorageAdapter.get(c, id);
    notYet(c); return null;
  },
  async put(c, rec) {
    if (WRITERS[c]) return WRITERS[c](rec);
    if (LOCAL_COLLECTIONS.includes(c)) return SessionStorageAdapter.put(c, rec);
    throw new NotOnV2Error(c);
  },
  async putMany(c, list) { const out = []; for (const r of list) out.push(await this.put(c, r)); return out; },
  async remove(c, id) {
    if (LOCAL_COLLECTIONS.includes(c)) return SessionStorageAdapter.remove(c, id);
    throw new Error(c === 'dues' ? 'A bill is not deleted: cancel it with a reason.' : c === 'users' ? 'Deactivate the member instead.' : `"${c}" cannot be removed on the v2 back end.`);
  },
  async replaceAll(c, records) { if (LOCAL_COLLECTIONS.includes(c)) return SessionStorageAdapter.replaceAll(c, records); throw new NotOnV2Error(c); },
  forCommunity() { return V2ApiAdapter; },          // the community comes from the access token, not from the client
  async clearCommunity() { throw new Error('Not available on the v2 back end.'); },
};
