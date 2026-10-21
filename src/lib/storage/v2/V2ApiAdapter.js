// StorageAdapter over the TYPED v2 API (backend/api, /api/v1). The app keeps calling storage.list / get / put; this adapter turns those calls
// into the resource endpoints and maps the records (v2map.js). The server decides every read and write (row scope, permissions, versions,
// audit); nothing here is trusted by it.
//
//   properties  GET /v1/units (paged), GET /v1/units/{id}, PATCH /v1/units/{id} with If-Match
//   users       GET /v1/members, GET /v1/members/{id}, POST /v1/members (new), PUT /v1/members/{id}/roles, POST /v1/members/{id}/deactivate
//   dues        GET /v1/dues, GET /v1/dues/{id}, POST /v1/dues (new), POST /v1/dues/{id}/cancel | /waive (status change) - a bill is never edited
//   roles       GET /v1/roles (read-only here)
//   tickets     GET /v1/tickets, POST /v1/tickets (new), then the commands a change needs: PATCH (fields), /assign, /status, /rating, /me-too
//   ticketComments  GET /v1/ticket-comments (the latest on tickets I may see), POST /v1/tickets/{id}/comments (comments are never edited)
//   quotations  GET /v1/quotations, POST /v1/tickets/{id}/quotations (new), then the command a change means: /select, /decision, /send-back; DELETE
//   handymen  GET /v1/field-staff, clock in / out, add a member as field staff
//   registers (RESOURCES in v2map.js: task types, categories, phrases, wishes, approval rules, finance settings ...)  the resource kit:
//               GET /v1/{module}/{resource}, POST (new), PUT with If-Match (change), DELETE with If-Match - the server's rules decide each one
//   app configuration (schema, communityConfig, financeSettings, roleGroups): kept in this browser until the v2 API has endpoints for them
//   everything else: not on the v2 API yet - reads answer empty, writes are refused with a clear message (nothing is silently dropped)
import { apiFetch } from '../../net/request.js';
import { AuthzError, ConflictError } from '../../security/errors.js';
import { SessionStorageAdapter } from '../SessionStorageAdapter.js';
import { propertyOf, unitPatch, userOf, dueOf, raiseBody, roleOf, ticketOf, ticketPatch, raiseTicketBody, commentOf, fieldStaffOf, quotationOf, addDocumentBody,
  quotationCommands, RESOURCES, resourceOf, resourceBody, isUuid } from './v2map.js';
import { getAuthUser } from '../../auth/session.js';

export const V2_COLLECTIONS = ['properties', 'users', 'dues', 'roles', 'tickets', 'ticketComments', 'handymen', 'quotations', ...Object.keys(RESOURCES)];
export const LOCAL_COLLECTIONS = ['schema', 'communityConfig', 'roleGroups'];

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
  tickets: {
    list: async () => { const { noById } = await unitIndex(); return (await all('/tickets')).map((t) => ticketOf(t, noById)); },
    get: async (id) => { const t = await call(`/tickets/${encodeURIComponent(id)}`); if (!t) return null; const { noById } = await unitIndex(); return ticketOf(t, noById); },
  },
  ticketComments: { list: async () => (await call('/ticket-comments?limit=1000')).map(commentOf), get: async (id) => (await readers.ticketComments.list()).find((c) => c.id === id) || null },
  handymen: { list: async () => (await call('/field-staff')).map(fieldStaffOf), get: async (id) => (await readers.handymen.list()).find((h) => h.id === id) || null },
  quotations: { list: async () => (await call('/quotations')).map(quotationOf), get: async (id) => { if (!isUuid(id)) return null; const q = await call(`/quotations/${id}`); return q && quotationOf(q); } },
};
// every register of the resource kit reads the same way
for (const [c, spec] of Object.entries(RESOURCES)) {
  readers[c] = {
    list: async () => (await call(`/${spec.path}`)).map((r) => resourceOf(r, spec)),
    get: async (id) => { if (!isUuid(id)) return null; const r = await call(`/${spec.path}/${id}`); return r && resourceOf(r, spec); },
  };
}
// task types also say which ones this person may raise (the ticket form offers only those)
const taskTypeList = readers.taskTypes.list;
readers.taskTypes.list = async () => {
  const [all, mine] = await Promise.all([taskTypeList(), call('/task-types')]);
  const can = Object.fromEntries((mine || []).map((t) => [t.id, t.canRaise !== false]));
  return all.map((t) => ({ ...t, canRaise: !!can[t.id] }));
};

let metaCache = null;
/** collection -> the fields its request type carries (from the server, once per session). */
async function resourceFields(c) {
  if (!metaCache) metaCache = Object.fromEntries((await call('/meta/resources')).map((m) => [m.collection, m]));
  const m = metaCache[c];
  if (!m) throw new NotOnV2Error(c);
  return m.fields;
}

const sameList = (a = [], b = []) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

async function assigneeId(ticketId, name) {
  if (!name) return null;
  const options = await call(`/tickets/${encodeURIComponent(ticketId)}/assignees`);
  const hit = options.find((o) => o.name === name || o.membershipId === name);
  if (!hit) throw new Error(`${name} cannot take this ticket.`);
  return hit.membershipId;
}

async function putTicket(rec) {
  const before = rec.id ? await readers.tickets.get(rec.id) : null;
  if ((rec.attachments || []).length) throw new NotOnV2Error('photos and files on tickets');
  const { idByNo, noById } = await unitIndex();
  const map = (t) => ticketOf(t, noById);
  if (!before) {
    const types = await call('/task-types');
    const resident = getAuthUser()?.category === 'Resident';
    let t = await call('/tickets', json('POST', raiseTicketBody(rec, { taskTypeIdByName: Object.fromEntries(types.map((x) => [x.name, x.id])), unitIdByNo: idByNo, resident })));
    if (rec.assignedTo && rec.assignedTo !== t.assigneeName) {
      t = await call(`/tickets/${t.id}/assign`, json('POST', { assigneeId: await assigneeId(t.id, rec.assignedTo) }, ifMatch(t.version)));
    }
    return map(t);
  }
  // the money side (quotation / invoice status, approvals, approved amount) follows the quotations - it is never written on the ticket
  let version = rec.version ?? before.version; let out = null;
  const step = async (path, body) => { out = await call(`/tickets/${encodeURIComponent(rec.id)}${path}`, json(path ? 'POST' : 'PATCH', body, ifMatch(version))); version = out.version; };
  const patch = ticketPatch(before, rec);
  if (patch) await step('', patch);
  if ((rec.assignedTo || '') !== (before.assignedTo || '')) await step('/assign', { assigneeId: await assigneeId(rec.id, rec.assignedTo) });
  const to = rec.status === 'Reopened' ? 'Open' : rec.status;
  if (to && to !== before.status && !(to === 'Assigned' && rec.assignedTo) && !(to === 'Open' && !rec.assignedTo && before.status === 'Assigned')) {
    await step('/status', { status: to, reason: rec.cancelReason || rec.reason || null });
  }
  if (Number(rec.residentRating || 0) > 0 && Number(rec.residentRating) !== Number(before.residentRating || 0)) {
    out = await call(`/tickets/${encodeURIComponent(rec.id)}/rating`, json('POST', { rating: Number(rec.residentRating) }));
  }
  if (!sameList(rec.affectedUnits, before.affectedUnits)) {
    const added = (rec.affectedUnits || []).filter((u) => !(before.affectedUnits || []).includes(u));
    const removed = (before.affectedUnits || []).filter((u) => !(rec.affectedUnits || []).includes(u));
    for (const u of added) out = await call(`/tickets/${encodeURIComponent(rec.id)}/me-too`, json('POST', { unitId: idByNo[u] || null }));
    for (const u of removed) out = await call(`/tickets/${encodeURIComponent(rec.id)}/me-too${idByNo[u] ? `?unit=${idByNo[u]}` : ''}`, { method: 'DELETE' });
  }
  return out ? map(out) : before;
}

async function putComment(rec) {
  if (rec.id && (await readers.ticketComments.get(rec.id))) throw new Error('Comments cannot be edited.');
  if ((rec.attachments || []).length) throw new NotOnV2Error('files on comments');
  return commentOf(await call(`/tickets/${encodeURIComponent(rec.ticketId)}/comments`, json('POST', { body: rec.body, visibility: rec.visibility || 'Public' })));
}

async function putFieldStaff(rec) {
  const before = rec.id ? await readers.handymen.get(rec.id) : null;
  if (!before) {
    const members = await all('/members');
    const m = members.find((x) => x.id === rec.membershipId || x.displayName === rec.name);
    if (!m) throw new Error(`Add ${rec.name || 'the person'} as a member first, then make them field staff.`);
    return fieldStaffOf(await call('/field-staff', json('POST', { membershipId: m.id, trade: rec.trade, shift: rec.shift || null, phone: rec.phone || null })));
  }
  if (!!rec.clockedIn === before.clockedIn) return before;
  return fieldStaffOf(await call(`/field-staff/${encodeURIComponent(rec.id)}`, json('PATCH', { clockedIn: !!rec.clockedIn }, ifMatch(rec.version ?? before.version))));
}

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

async function putQuotation(rec) {
  const before = isUuid(rec.id) ? await readers.quotations.get(rec.id) : null;
  if ((rec.attachments || []).length) throw new NotOnV2Error('files on quotations and invoices');
  if (!before) {
    if (!rec.ticketId) throw new Error('A quotation belongs to a task.');
    let q = await call(`/tickets/${encodeURIComponent(rec.ticketId)}/quotations`, json('POST', addDocumentBody(rec)));
    if (rec.selected && q.kind === 'Quotation') q = await call(`/quotations/${q.id}/select`, json('POST', {}, ifMatch(q.version)));
    return quotationOf(q);
  }
  let version = before.version; let out = null;
  for (const cmd of quotationCommands(before, rec)) {
    out = await call(`/quotations/${encodeURIComponent(rec.id)}/${cmd.path}`, json('POST', cmd.body || {}, ifMatch(version)));
    version = out.version;
  }
  return out ? quotationOf(out) : before;
}

async function putResource(c, rec) {
  const spec = RESOURCES[c];
  const fields = await resourceFields(c);
  let before = isUuid(rec.id) ? await call(`/${spec.path}/${rec.id}`) : null;
  if (!before && spec.singleton) before = (await call(`/${spec.path}`))[0] || null;
  const { idByNo } = spec.unit ? await unitIndex() : { idByNo: {} };
  const merged = before ? { ...resourceOf(before, spec), ...rec } : rec;          // a write is the whole record: keep what the app did not send
  const body = resourceBody(merged, spec, fields, idByNo);
  const out = before
    ? await call(`/${spec.path}/${before.id}`, json('PUT', body, ifMatch(rec.version && rec.id === before.id ? rec.version : before.version)))
    : await call(`/${spec.path}`, json('POST', body));
  return resourceOf(out, spec);
}
async function removeResource(c, id) {
  const spec = RESOURCES[c];
  const before = isUuid(id) ? await call(`/${spec.path}/${id}`) : null;
  if (!before) return;
  await call(`/${spec.path}/${id}`, { method: 'DELETE', headers: ifMatch(before.version) });
}

const WRITERS = { properties: putProperty, users: putUser, dues: putDue, tickets: putTicket, ticketComments: putComment, handymen: putFieldStaff, quotations: putQuotation };
for (const c of Object.keys(RESOURCES)) WRITERS[c] = (rec) => putResource(c, rec);
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
    if (RESOURCES[c]) return removeResource(c, id);
    if (c === 'quotations') { const q = isUuid(id) ? await call(`/quotations/${id}`) : null; if (q) await call(`/quotations/${id}`, { method: 'DELETE', headers: ifMatch(q.version) }); return; }
    throw new Error(c === 'dues' ? 'A bill is not deleted: cancel it with a reason.' : c === 'users' ? 'Deactivate the member instead.' : c === 'tickets' ? 'Tickets cannot be deleted - cancel or close them instead.' : `"${c}" cannot be removed on the v2 back end.`);
  },
  async replaceAll(c, records) { if (LOCAL_COLLECTIONS.includes(c)) return SessionStorageAdapter.replaceAll(c, records); throw new NotOnV2Error(c); },
  forCommunity() { return V2ApiAdapter; },          // the community comes from the access token, not from the client
  async clearCommunity() { throw new Error('Not available on the v2 back end.'); },
};
