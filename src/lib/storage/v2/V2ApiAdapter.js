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
//   notifications  GET /v1/notifications (the reader's own inbox), POST /{id}/read - the server writes them from what happened, so a new row here is a no-op
//   broadcasts  GET /v1/comms/broadcasts, POST (new: draft or send), then the command a change means: /sign, /reschedule, PUT (draft), /send
//   pollVotes   per poll: GET /results (a reader) or /voters (the committee), POST /vote
//   forum, forumPosts  GET /v1/comms/forum/topics (+ /results for polls), /topics/{id}/posts; POST, PATCH, /vote, /react, /hide, DELETE
//   meetings    GET /v1/governance/meetings (residents: published ones), POST, PUT with If-Match, DELETE; agenda / minutes papers are attached files
//   ballots, voteRoll, ballotBox  GET /v1/governance/ballots (+ /roll per ballot, /box once closed); a draft is POST / PUT, Open = /open, Closed = /close;
//               a vote = /code, /code/verify, then /votes (the roll mark and the box row are written together by the server)
//   serviceContacts, contactReviews  GET /v1/vendors/directory (+ /{id}/reviews), POST / PUT / DELETE; my review = PUT /{id}/review, DELETE /vendors/reviews/{id}
//   attendance  GET /v1/workforce/attendance (staff: their own); new = clock-in, a clock-out = clock-out (the times are the server's); other changes = a supervisor's correction
//   workforce   GET /v1/workforce/teams (field staff on duty by trade)
//   app configuration (schema, communityConfig, roleGroups): kept in this browser until the v2 API has endpoints for them
//   everything else: not on the v2 API yet - reads answer empty, writes are refused with a clear message (nothing is silently dropped)
import { apiFetch } from '../../net/request.js';
import { AuthzError, ConflictError } from '../../security/errors.js';
import { SessionStorageAdapter } from '../SessionStorageAdapter.js';
import { propertyOf, unitPatch, userOf, dueOf, raiseBody, roleOf, ticketOf, ticketPatch, raiseTicketBody, commentOf, fieldStaffOf, quotationOf, addDocumentBody,
  quotationCommands, RESOURCES, resourceOf, resourceBody, isUuid, bookingOf, busyOf, bookBody, bookingCommand, gatePassOf, gateVisitOf, gateApprovalOf, gateFlagOf, gateScanOf,
  passBody, ledgerOf, ledgerBody, bookedByServer, releaseOf, releaseCommands, payRequestOf, bankTxnOf, donationOf, donationBody, expenseOf, expenseBody, expenseCommands, fileMeta, fileRowOf, dataUrlBytes, bytesDataUrl, documentOf, documentBody, notificationOf, broadcastOf, broadcastDraft, broadcastCommands, pollVoteRows, topicOf, postOf, meetingOf, meetingBody, ballotOf, ballotBody, voteMarksOf, boxRowOf, voteUnit, contactOf, contactBody, reviewOf, attendanceOf, teamOf, auditOf, auditFilterOf } from './v2map.js';
import { getAuthUser } from '../../auth/session.js';
import { getPrincipal } from '../../security/principal.js';

const GATE_DESK = ['gatePasses', 'gateVisits', 'gateApprovals', 'gateFlags', 'gateScans', 'gatePulse'];
const DOCS = ['files', 'documents', 'culturalDonations', 'culturalExpenses', 'ledger', 'releases', 'payRequests', 'bankTxns'];
const COMMS = ['notifications', 'broadcasts', 'pollVotes', 'forum', 'forumPosts'];
const GOVERNANCE = ['meetings', 'ballots', 'voteRoll', 'ballotBox', 'serviceContacts', 'contactReviews', 'attendance', 'workforce'];
export const V2_COLLECTIONS = ['properties', 'users', 'audit', 'dues', 'roles', 'tickets', 'ticketComments', 'handymen', 'quotations', 'amenities', ...GATE_DESK, ...COMMS, ...DOCS, ...GOVERNANCE, ...Object.keys(RESOURCES)];
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
  const cap = res.headers?.get?.('X-List-Truncated');
  if (cap && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('communityos:truncated', { detail: { path, cap: Number(cap) } }));   // more rows than were sent
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
/** The counts above a page (GET /summary/{kind}): worked out by the server from the rows this person may see. */
export async function v2Summary(kind) { return call(`/summary/${kind}`); }
/** The tasks I raised that are still open (the "Needs attention" card): one filtered page, not every ticket. */
export async function myOpenTickets() {
  const { noById } = await unitIndex();
  const p = await call('/tickets?mine=true&active=true&limit=200');
  return (p?.items || []).map((t) => rev(ticketOf(t, noById)));
}
/** unit number -> unit id (for the payment gateway, which knows units by number). */
export async function unitIdByNo(no) { return (await unitIndex()).idByNo[no] || null; }
// The units (number <-> id, blocks) are the community's set-up: they change only when the platform adds units or a unit manager edits one.
// Every task, member, notice and gate read needs them, so they are read once and shared for UNIT_TTL (and dropped at once after a unit write).
const UNIT_TTL = 60e3;
let unitsAt = 0; let unitsP = null;
function allUnits() {
  if (unitsP && Date.now() - unitsAt < UNIT_TTL) return unitsP;
  unitsAt = Date.now();
  unitsP = all('/units').catch((e) => { unitsP = null; throw e; });
  return unitsP;
}
function dropUnits() { unitsP = null; }
if (typeof window !== 'undefined') window.addEventListener?.('communityos:changed', (e) => { if (e?.detail?.collection === 'properties') dropUnits(); });
async function unitIndex() {
  const units = await allUnits();
  return { noById: Object.fromEntries(units.map((u) => [u.id, u.unitNo])), idByNo: Object.fromEntries(units.map((u) => [u.unitNo, u.id])) };
}

const readers = {
  properties: { list: async () => { dropUnits(); return (await allUnits()).map(propertyOf); }, get: async (id) => { const u = await call(`/units/${encodeURIComponent(id)}`); return u && propertyOf(u); } },
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
// bookings: a resident gets their own, plus the other bookings as "taken" only (so the calendar can show what is full)
readers.amenities = {
  list: async () => {
    const own = (await call('/amenities/bookings')).map(bookingOf);
    if (getAuthUser()?.category !== 'Resident') return own;
    const from = new Date(Date.now() - 86400e3).toISOString().slice(0, 10); const to = new Date(Date.now() + 120 * 86400e3).toISOString().slice(0, 10);
    const [taken, types] = await Promise.all([call(`/amenities/availability?from=${from}&to=${to}`), call('/amenities/types')]);
    const name = Object.fromEntries(types.map((t) => [t.id, t.name]));
    const mine = new Map();
    for (const b of own) if (b.status !== 'Cancelled') { const k = `${b.amenityTypeId}|${b.date}|${b.slot}`; mine.set(k, (mine.get(k) || 0) + 1); }
    const busy = [];
    for (const t of taken) { const others = t.bookings - (mine.get(`${t.amenityTypeId}|${t.date}|${t.slot}`) || 0); for (let i = 0; i < others; i += 1) busy.push(busyOf(t, name[t.amenityTypeId], i)); }
    return [...own, ...busy];
  },
  get: async (id) => { if (!isUuid(id)) return null; const b = await call(`/amenities/bookings/${id}`); return b && bookingOf(b); },
};
// the gate: passes (a unit's own), visits, approvals; flags and patrols for the security team and the committee
const oversees = () => { const u = getAuthUser(); return u && u.category !== 'Resident'; };
const byId = (list) => async (id) => (await list()).find((x) => x.id === id) || null;
const oneOf = (path, map) => async (id) => { if (!isUuid(id)) return null; try { const x = await call(`${path}/${id}`); return x && map(x); } catch (e) { if (e instanceof AuthzError || /not found|404/i.test(e.message)) return null; throw e; } };
readers.gatePasses = { list: async () => (await call('/gate/passes')).map(gatePassOf), get: oneOf('/gate/passes', gatePassOf) };
readers.gateVisits = { list: async () => (await call('/gate/visits')).map(gateVisitOf), get: oneOf('/gate/visits', gateVisitOf) };
readers.gateApprovals = { list: async () => (await call('/gate/approvals')).map(gateApprovalOf), get: oneOf('/gate/approvals', gateApprovalOf) };
readers.gateFlags = { list: async () => { if (!oversees()) return []; const { noById } = await unitIndex(); return (await call('/gate/flags')).map((f) => gateFlagOf(f, noById)); } };
readers.gateFlags.get = byId(readers.gateFlags.list);
readers.gateScans = { list: async () => (oversees() ? (await call('/gate/scans')).map(gateScanOf) : []) }; readers.gateScans.get = byId(readers.gateScans.list);
readers.gatePulse = { list: async () => [], get: async () => null };   // the server keeps the console heartbeats
// notices, the inbox, polls and the forum
const myName = () => getPrincipal()?.name || getAuthUser()?.name || '';
const publisher = () => { const u = getAuthUser(); return !!u && (u.category === 'EC' || (u.roleIds || []).includes('super_admin') || (u.permissions || []).some((x) => x === 'MANAGE_NOTICE_TEMPLATES' || x === 'MANAGE_GOVERNANCE')); };
async function placeIndex() {
  const units = await allUnits();
  return {
    unitNoById: Object.fromEntries(units.map((u) => [u.id, u.unitNo])), unitIdByNo: Object.fromEntries(units.map((u) => [u.unitNo, u.id])),
    blockNameById: Object.fromEntries(units.filter((u) => u.blockId).map((u) => [u.blockId, u.blockName])), blockIdByName: Object.fromEntries(units.filter((u) => u.blockId).map((u) => [u.blockName, u.blockId])),
  };
}
readers.notifications = { list: async () => (await call('/notifications?limit=200')).map((n) => notificationOf(n, myName())) };
readers.notifications.get = byId(readers.notifications.list);
readers.broadcasts = {
  list: async () => { const [rows, ix] = await Promise.all([call('/comms/broadcasts'), placeIndex()]); return rows.map((b) => broadcastOf(b, { ...ix, myName: myName() })); },
  get: async (id) => { if (!isUuid(id)) return null; const [b, ix] = await Promise.all([call(`/comms/broadcasts/${id}`), placeIndex()]); return b && broadcastOf(b, { ...ix, myName: myName() }); },
};
readers.pollVotes = {
  // every sent poll with its results (and, for the committee, who voted what) in one call
  list: async () => {
    const polls = await call('/comms/broadcasts/polls');
    const me = getPrincipal(); const out = [];
    for (const [id, v] of Object.entries(polls || {})) {
      out.push(...pollVoteRows(id, v.voters ? { counts: [], total: 0, mine: [] } : v.results, { voters: v.voters || null, myName: myName(), myUnit: me?.unit || getAuthUser()?.unit || '' }));
    }
    return out;
  },
};
readers.pollVotes.get = byId(readers.pollVotes.list);
readers.forum = {
  // the topics, and every poll topic's results in one more call (not one per poll)
  list: async () => {
    const [topics, results] = await Promise.all([call('/comms/forum/topics'), call('/comms/forum/poll-results')]);
    return topics.map((t) => topicOf(t, t.kind === 'Poll' ? (results || {})[t.id] || null : null, myName()));
  },
  get: async (id) => { if (!isUuid(id)) return null; const t = await call(`/comms/forum/topics/${id}`); return t && topicOf(t, t.kind === 'Poll' ? await call(`/comms/forum/topics/${id}/results`) : null, myName()); },
};
readers.forumPosts = {
  list: async () => (await call('/comms/forum/posts')).map(postOf),   // every post of every topic in one call
};
readers.forumPosts.get = byId(readers.forumPosts.list);
// every register of the resource kit reads the same way
for (const [c, spec] of Object.entries(RESOURCES)) {
  readers[c] = {
    list: async () => (await call(`/${spec.path}`)).map((r) => resourceOf(r, spec)),
    get: async (id) => { if (!isUuid(id)) return null; const r = await call(`/${spec.path}/${id}`); return r && resourceOf(r, spec); },
  };
}
// files: bytes go up as the request body; a record's attachments are the files attached to it on the server
async function filesOf(ownerType, ownerId) { return (await call(`/files?ownerType=${ownerType}${ownerId ? `&ownerId=${ownerId}` : ''}`)).map(fileMeta); }
/** Add each record's attachments (files attached to it) under `field`. */
function withFiles(reader, ownerType, field, extra = () => ({})) {
  const group = async (rows) => {
    if (!rows.length) return rows;
    const by = {};
    for (const f of await call(`/files?ownerType=${ownerType}`)) (by[f.ownerId] ||= []).push(fileMeta(f));
    return rows.map((r) => (by[r.id] ? { ...r, [field]: by[r.id], ...extra(by[r.id]) } : r));
  };
  // one record: only its own files (not every file of its kind)
  const one = async (r) => { const mine = await filesOf(ownerType, r.id); return mine.length ? { ...r, [field]: mine, ...extra(mine) } : r; };
  return { list: async () => group(await reader.list()), get: async (id) => { const r = await reader.get(id); return r ? one(r) : r; } };
}
const photos = (metas) => ({ hasPhotos: metas.some((m) => /^image\//.test(m.mime)) });
readers.tickets = withFiles(readers.tickets, 'maintenance.ticket', 'attachments', photos);
readers.ticketComments = withFiles(readers.ticketComments, 'maintenance.comment', 'attachments');
readers.quotations = withFiles(readers.quotations, 'maintenance.quotation', 'attachments');
readers.amenities = withFiles(readers.amenities, 'amenity.booking', 'depositPhotos');
readers.vendors = withFiles(readers.vendors, 'vendor.vendor', 'attachments');
// asset papers are files attached to the record
const ASSET_FILES = { equipment: ['assets.equipment', 'files'], inventory: ['assets.inventory', 'attachments'], dgFuelLogs: ['assets.dg_fuel', 'bill'],
  electricityBills: ['assets.electricity_bill', 'billFile'], audits: ['assets.audit', 'report'], logEntries: ['assets.log_entry', 'attachments'] };
for (const [c, [owner, field]] of Object.entries(ASSET_FILES)) readers[c] = withFiles(readers[c], owner, field);
// report schedules: units and people by id on the server, by unit number and name in the app
async function peopleIndex() { const ms = await all('/members'); return { idByName: Object.fromEntries(ms.map((m) => [m.displayName, m.id])), nameById: Object.fromEntries(ms.map((m) => [m.id, m.displayName])) }; }
const scheduleReader = readers.reportSchedules;
const withAudience = async (rows) => {
  if (!rows.length) return rows;
  const [{ noById }, { nameById }] = await Promise.all([unitIndex(), peopleIndex()]);
  return rows.map((r) => ({ ...r, units: (r.unitIds || []).map((id) => noById[id]).filter(Boolean), people: (r.memberIds || []).map((id) => nameById[id]).filter(Boolean) }));
};
readers.reportSchedules = { list: async () => withAudience(await scheduleReader.list()), get: async (id) => { const r = await scheduleReader.get(id); return r ? (await withAudience([r]))[0] : r; } };
// the service directory: ratings and counts are worked out by the server
readers.serviceContacts = { list: async () => (await call('/vendors/directory')).map(contactOf), get: async (id) => { if (!isUuid(id)) return null; const c = await call(`/vendors/directory/${id}`); return c && contactOf(c); } };
readers.contactReviews = { list: async () => (await Promise.all((await call('/vendors/directory')).map((c) => call(`/vendors/directory/${c.id}/reviews`)))).flat().map(reviewOf) };
readers.contactReviews.get = byId(readers.contactReviews.list);
// governance: meetings with their papers; ballots with the frozen roll, the marks (which units voted) and, once closed, the box
readers.meetings = withFiles(withFiles({ list: async () => (await call('/governance/meetings')).map(meetingOf),
  get: async (id) => { if (!isUuid(id)) return null; const m = await call(`/governance/meetings/${id}`); return m && meetingOf(m); } }, 'governance.agenda', 'agendaFiles'), 'governance.minutes', 'minutesFiles');
const rollOf = async (b) => (b.status === 'Draft' ? [] : (await call(`/governance/ballots/${b.id}/roll`)) || []);
readers.ballots = {
  list: async () => Promise.all((await call('/governance/ballots')).map(async (b) => ballotOf(b, await rollOf(b)))),
  get: async (id) => { if (!isUuid(id)) return null; const b = await call(`/governance/ballots/${id}`); return b && ballotOf(b, await rollOf(b)); },
};
readers.voteRoll = { list: async () => (await Promise.all((await call('/governance/ballots')).map(async (b) => voteMarksOf(b.id, await rollOf(b))))).flat() };
readers.voteRoll.get = byId(readers.voteRoll.list);
readers.ballotBox = { list: async () => (await Promise.all((await call('/governance/ballots')).filter((b) => b.status === 'Closed')
  .map(async (b) => ((await call(`/governance/ballots/${b.id}/box`))?.rows || []).map((r) => boxRowOf(b.id, r))))).flat() };
readers.ballotBox.get = byId(readers.ballotBox.list);
/** E-voting's second factor and the vote, for src/lib/evoting.js: the code goes to the owner's registered mobile (shown here only by a development server). */
/** Send a schedule's report now: the server builds it from its own data, delivers it and keeps what was sent. */
export async function runReportNow(scheduleId) { return call(`/reports/schedules/${scheduleId}/run`, json('POST', {})); }
export const evote = {
  async request(ballot, unitNo) { const r = await call(`/governance/ballots/${ballot.id}/code`, json('POST', { unitId: voteUnit(ballot, unitNo) })); return { code: r.code || '', phoneLast4: r.phoneLast4 || '' }; },
  async verify(ballot, unitNo, code) { return (await call(`/governance/ballots/${ballot.id}/code/verify`, json('POST', { unitId: voteUnit(ballot, unitNo), code: String(code || '').trim() }))).proof; },
};
readers.attendance = { list: async () => (await call('/workforce/attendance')).map(attendanceOf) }; readers.attendance.get = byId(readers.attendance.list);
readers.workforce = { list: async () => (await call('/workforce/teams')).map(teamOf) }; readers.workforce.get = byId(readers.workforce.list);
readers.files = {
  list: async () => (await call('/files?ownerType=upload')).map((f) => fileRowOf(f)),
  get: async (id) => {
    if (!isUuid(id)) return null;
    const f = await call(`/files/${id}`); if (!f) return null;
    const res = await apiFetch(`/v1/files/${id}/content`);
    return fileRowOf(f, res.ok ? bytesDataUrl(await res.arrayBuffer(), f.mimeType) : '');
  },
};
/** The newest `max` rows of a paged list (a few calls of 200), never the whole of it. */
async function latest(path, max) {
  const out = []; const sep = path.includes('?') ? '&' : '?';
  for (let offset = 0; offset < max; offset += 200) {
    const p = await call(`${path}${sep}limit=${Math.min(200, max - offset)}&offset=${offset}`);
    out.push(...p.items);
    if (out.length >= p.total || !p.items.length) return out;
    if (out.length >= max && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('communityos:truncated', { detail: { path, cap: max } }));   // older rows exist
  }
  return out;
}
// the audit trail: the server's (written by every service), read a page at a time; a whole-list read gets the newest 2,000 only
readers.audit = {
  list: async () => { const { noById } = await unitIndex(); return (await latest('/audit', 2000)).map((a) => auditOf(a, noById)); },
  get: async (id) => (await readers.audit.list()).find((a) => a.id === id) || null,
};
readers.documents = { list: async () => (await call('/documents')).map(documentOf), get: async (id) => { if (!isUuid(id)) return null; const d = await call(`/documents/${id}`); return d && documentOf(d); } };
// cultural: donations (a unit's own, or all for the committee), expenses (the committee and the accounts)
readers.culturalDonations = { list: async () => (await call('/cultural/donations')).map(donationOf), get: async (id) => { if (!isUuid(id)) return null; const d = await call(`/cultural/donations/${id}`); return d && donationOf(d); } };
readers.culturalExpenses = {
  list: async () => { try { return (await call('/cultural/expenses')).map(expenseOf); } catch (e) { if (e instanceof AuthzError) return []; throw e; } },
  get: async (id) => { if (!isUuid(id)) return null; const x = await call(`/cultural/expenses/${id}`); return x && expenseOf(x); },
};
// finance: the cash book, releases, pay requests, bank lines (each read only by who may)
const orEmpty = (f) => async (...a) => { try { return await f(...a); } catch (e) { if (e instanceof AuthzError) return []; throw e; } };
readers.ledger = { list: orEmpty(async () => (await call('/finance/cash-book')).map(ledgerOf)), get: async (id) => { if (!isUuid(id)) return null; const e = await call(`/finance/cash-book/${id}`); return e && ledgerOf(e); } };
readers.releases = { list: orEmpty(async () => (await call('/finance/releases')).map(releaseOf)), get: async (id) => { if (!isUuid(id)) return null; const r = await call(`/finance/releases/${id}`); return r && releaseOf(r); } };
readers.payRequests = { list: orEmpty(async () => (await call('/finance/pay-requests')).map(payRequestOf)) }; readers.payRequests.get = byId(readers.payRequests.list);
readers.bankTxns = { list: orEmpty(async () => (await call('/finance/bank-lines')).map(bankTxnOf)) }; readers.bankTxns.get = byId(readers.bankTxns.list);
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
  if (spec.readOnly) throw new Error(`"${c}" is written by the server only.`);
  const fields = await resourceFields(c);
  let before = isUuid(rec.id) ? await call(`/${spec.path}/${rec.id}`) : null;
  if (!before && spec.singleton) before = (await call(`/${spec.path}`))[0] || null;
  const { idByNo } = spec.unit || spec.units ? await unitIndex() : { idByNo: {} };
  const refIds = {};
  for (const [appKey, r] of Object.entries(spec.refs || {})) refIds[appKey] = Object.fromEntries((await call(`/${RESOURCES[r.collection].path}`)).map((x) => [x[r.key], x.id]));
  const merged = before ? { ...resourceOf(before, spec), ...rec } : rec;          // a write is the whole record: keep what the app did not send
  const body = resourceBody(merged, spec, fields, idByNo, refIds);
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

async function putPass(rec) {
  const before = isUuid(rec.id) ? await readers.gatePasses.get(rec.id) : null;
  if (!before) { const { idByNo } = await unitIndex(); return gatePassOf(await call('/gate/passes', json('POST', passBody(rec, idByNo)))); }
  if (rec.status === 'Cancelled' && before.status !== 'Cancelled') return gatePassOf(await call(`/gate/passes/${rec.id}/cancel`, json('POST', {}, ifMatch(before.version))));
  return before;   // a pass is used at the gate and cancelled by its unit; it is not edited
}
async function putApproval(rec) {
  const before = isUuid(rec.id) ? await readers.gateApprovals.get(rec.id) : null;
  if (!before) throw new Error('Only the gate asks for an approval.');
  if ((rec.status === 'Approved' || rec.status === 'Denied') && rec.status !== before.status) {
    return gateApprovalOf(await call(`/gate/approvals/${rec.id}/answer`, json('POST', { decision: rec.status, always: !!rec.alwaysAllow })));
  }
  return before;
}
async function putFlag(rec) {
  const before = isUuid(rec.id) ? await readers.gateFlags.get(rec.id) : null;
  if (!before) throw new Error('Flags are raised by the gate itself.');
  if (rec.state === 'Closed' && before.state !== 'Closed') {
    const { noById } = await unitIndex();
    return gateFlagOf(await call(`/gate/flags/${rec.id}/resolve`, json('POST', { resolution: rec.resolution, note: rec.resolutionNote || null }, ifMatch(before.version))), noById);
  }
  return before;
}
// the inbox: the server writes the rows (from what happened); the app only marks its own as read
async function putNotification(rec) {
  const before = isUuid(rec.id) ? await readers.notifications.get(rec.id) : null;
  if (!before) return rec;   // a notification the app composed: on v2 the server sends it from the event itself
  if (rec.read && !before.read) await call(`/notifications/${rec.id}/read`, { method: 'POST' });
  return { ...before, read: !!rec.read || before.read };
}
async function putBroadcast(rec) {
  const before = isUuid(rec.id) ? await readers.broadcasts.get(rec.id) : null;
  const ix = await placeIndex();
  const map = (b) => broadcastOf(b, { ...ix, myName: myName() });
  if (!before) return map(await call('/comms/broadcasts', json('POST', { notice: broadcastDraft(rec, ix), send: rec.status === 'Sent', scheduleFor: rec.scheduledFor || null })));
  let version = before.version; let out = null;
  for (const cmd of broadcastCommands(before, rec, myName())) {
    const path = `/comms/broadcasts/${rec.id}${cmd.path ? `/${cmd.path}` : ''}`;
    const body = cmd.draft ? broadcastDraft(rec, ix) : (cmd.body || {});
    out = await call(path, json(cmd.draft ? 'PUT' : 'POST', body, cmd.versioned ? ifMatch(version) : {}));
    version = out.version;
  }
  return out ? map(out) : before;
}
async function putPollVote(rec) {
  if (!isUuid(rec.broadcastId)) throw new Error('A vote answers a poll.');
  await call(`/comms/broadcasts/${rec.broadcastId}/vote`, json('POST', { choices: rec.choices || [] }));
  return (await readers.pollVotes.list()).find((v) => v.broadcastId === rec.broadcastId && v.id.endsWith('-mine')) || rec;
}
async function putTopic(rec) {
  const before = isUuid(rec.id) ? await readers.forum.get(rec.id) : null;
  if (!before) {
    const t = await call('/comms/forum/topics', json('POST', { title: rec.title, category: rec.category || null, kind: rec.kind || 'Discussion', pollOptions: (rec.pollOptions || []).map((o) => (typeof o === 'string' ? o : o.label)) }));
    return readers.forum.get(t.id);
  }
  const me = myName();
  if ((rec.voters || []).includes(me) && !(before.voters || []).includes(me)) {
    const i = (rec.pollOptions || []).findIndex((o, k) => (o.votes || 0) > (before.pollOptions?.[k]?.votes || 0));
    if (i < 0) throw new Error('Choose an answer.');
    await call(`/comms/forum/topics/${rec.id}/vote`, json('POST', { choice: i }));
  }
  const change = {};
  for (const k of ['title', 'category', 'pinned', 'status']) if (rec[k] !== undefined && rec[k] !== before[k]) change[k] = rec[k];
  if (Object.keys(change).length) await call(`/comms/forum/topics/${rec.id}`, json('PATCH', change, ifMatch(before.version)));
  return readers.forum.get(rec.id);   // the reply count is the server's
}
async function putPost(rec) {
  const before = isUuid(rec.id) ? await readers.forumPosts.get(rec.id) : null;
  if (!before) return postOf(await call(`/comms/forum/topics/${encodeURIComponent(rec.topicId)}/posts`, json('POST', { parentId: isUuid(rec.parentId) ? rec.parentId : null, body: rec.body })));
  let out = null;
  if ((rec.reactions || 0) > (before.reactions || 0)) out = await call(`/comms/forum/posts/${rec.id}/react`, { method: 'POST' });
  if (rec.body !== undefined && rec.body !== before.body) out = await call(`/comms/forum/posts/${rec.id}`, json('PATCH', { body: rec.body }, ifMatch(out?.version ?? before.version)));
  if (rec.hidden !== undefined && !!rec.hidden !== before.hidden) out = await call(`/comms/forum/posts/${rec.id}/hide`, json('POST', { hidden: !!rec.hidden, reason: rec.hiddenReason || null }, ifMatch(out?.version ?? before.version)));
  return out ? postOf(out) : before;
}
async function putFile(rec) {
  if (isUuid(rec.id) && (await call(`/files/${rec.id}`))) throw new Error('An uploaded file is not changed - upload a new one.');
  const { bytes, mime } = dataUrlBytes(rec.dataUrl);
  const res = await apiFetch(`/v1/files?name=${encodeURIComponent(rec.name || 'file')}${rec.visibility ? `&visibility=${rec.visibility}` : ''}`,
    { method: 'POST', body: new Blob([bytes], { type: rec.mime || mime }), headers: { 'Content-Type': rec.mime || mime } });
  if (!res.ok) { let b = null; try { b = await res.json(); } catch { /* not JSON */ } throw new Error(b?.detail || `Upload failed (${res.status})`); }
  return fileRowOf(await res.json(), rec.dataUrl);
}
async function putDocument(rec) {
  const before = isUuid(rec.id) ? await readers.documents.get(rec.id) : null;
  const { idByNo } = await unitIndex();
  const body = documentBody(rec, idByNo);
  if (!before) {
    if (!isUuid(rec.fileId)) throw new Error('Upload the document\'s file first.');
    return documentOf(await call('/documents', json('POST', { fileId: rec.fileId, ...body })));
  }
  return documentOf(await call(`/documents/${rec.id}`, json('PUT', body, ifMatch(before.rowVersion))));
}
/** After a record is written: attach the files it lists that are not attached yet (they were uploaded first, unattached). */
const attaching = (put, ownerType, field) => async (rec) => {
  const wanted = (rec[field] || []).map((m) => m.fileId).filter(isUuid);
  const out = await put(rec);
  if (!wanted.length || !out?.id) return out;
  for (const id of wanted) await call(`/files/${id}/attach`, json('POST', { ownerType, ownerId: out.id }));
  return { ...out, [field]: await filesOf(ownerType, out.id) };
};
async function putContact(rec) {
  const before = isUuid(rec.id) ? await readers.serviceContacts.get(rec.id) : null;
  const body = contactBody({ ...(before || {}), ...rec });
  return contactOf(before ? await call(`/vendors/directory/${rec.id}`, json('PUT', body, ifMatch(before.version))) : await call('/vendors/directory', json('POST', body)));
}
/** A review is mine: the server keeps one per household and rewrites it when I review again. */
async function putReview(rec) {
  if (!isUuid(rec.contactId)) throw new Error('Which contact?');
  return reviewOf(await call(`/vendors/directory/${rec.contactId}/review`, json('PUT', { rating: Number(rec.rating), comment: rec.comment || null, recommend: rec.recommend || null })));
}
/** An item's details through the kit; a change of quantity is a movement (a count to the new quantity) - the server keeps the stock. */
async function putInventory(rec) {
  const before = isUuid(rec.id) ? await readers.inventory.get(rec.id) : null;
  const out = await putResource('inventory', rec);
  const want = Number(rec.quantity); const had = Number(before?.quantity ?? out.quantity ?? 0);
  if (rec.quantity === '' || rec.quantity == null || !Number.isFinite(want) || want === had) return out;
  const r = await call(`/assets/inventory/${out.id}/movements`, json('POST', { kind: want > had && rec.lastRestocked && rec.lastRestocked !== before?.lastRestocked ? 'Received' : 'Counted',
    quantity: want > had && rec.lastRestocked && rec.lastRestocked !== before?.lastRestocked ? want - had : want, note: rec.movementNote || null }));
  return { ...out, quantity: Number(r.item.quantity), lastRestocked: r.item.lastRestocked || '', stockStatus: Number(r.item.quantity) <= 0 ? 'Out of stock' : r.item.minStock != null && Number(r.item.quantity) <= Number(r.item.minStock) ? 'Low' : 'In stock' };
}
/** What was found on an asset: the server keeps the entry and moves the asset's condition with it. */
async function putConditionLog(rec) {
  if (isUuid(rec.id) && await readers.infraLog.get(rec.id)) throw new Error('The condition log is kept as written - add a new entry.');
  if (!isUuid(rec.assetId)) throw new Error('Which asset?');
  const e = await call('/assets/condition-log', json('POST', { assetId: rec.assetId, date: rec.date || null, condition: rec.condition, source: rec.source || null, note: rec.note || null,
    ticketId: isUuid(rec.ticketId) ? rec.ticketId : null }));
  return { id: e.id, shortId: e.shortId, assetId: e.assetId, assetName: e.assetName, date: e.date, condition: e.condition, source: e.source || '', note: e.note || '', ticketId: e.ticketId || '', by: rec.by || '' };
}
async function putReportSchedule(rec) {
  const [{ idByNo }, { idByName }] = await Promise.all([unitIndex(), peopleIndex()]);
  const unitIds = (rec.units || []).map((no) => { const id = idByNo[no]; if (!id) throw new Error(`Unit ${no} is not known to the back end.`); return id; });
  const memberIds = (rec.people || []).map((n) => { const id = idByName[n]; if (!id) throw new Error(`${n} is not a member on the back end.`); return id; });
  const out = await putResource('reportSchedules', { ...rec, unitIds, memberIds, lastRunKey: undefined });
  return (await withAudience([out]))[0];
}
/** Clocking in and out is done by the server at its own time; only a supervisor's correction sets times. */
async function putAttendance(rec) {
  const before = isUuid(rec.id) ? await readers.attendance.get(rec.id) : null;
  const pos = (p) => ({ lat: n2v(rec[`${p}Lat`]), lng: n2v(rec[`${p}Lng`]), acc: n2v(rec[`${p}Acc`]) });
  if (!before) return attendanceOf(await call('/workforce/attendance/clock-in', json('POST', { ...pos('in'), shiftType: rec.shiftType || null, note: rec.note || null })));
  if (!before.clockOut && rec.clockOut && rec.source !== 'Supervisor' && (!rec.clockIn || rec.clockIn === before.clockIn)) {
    return attendanceOf(await call('/workforce/attendance/clock-out', json('POST', { ...pos('out'), note: rec.note && rec.note !== before.note ? rec.note : null })));
  }
  if (rec.clockIn === before.clockIn && (rec.clockOut || '') === (before.clockOut || '')) return before;
  return attendanceOf(await call(`/workforce/attendance/${rec.id}`, json('PUT', { clockIn: rec.clockIn, clockOut: rec.clockOut || null, reason: rec.correctionNote || rec.note || '' }, ifMatch(before.version))));
}
async function putMeeting(rec) {
  const before = isUuid(rec.id) ? await readers.meetings.get(rec.id) : null;
  const body = meetingBody({ ...(before || {}), ...rec });
  return meetingOf(before ? await call(`/governance/meetings/${rec.id}`, json('PUT', body, ifMatch(before.version))) : await call('/governance/meetings', json('POST', body)));
}
const BALLOT_FIELDS = ['title', 'description', 'kind', 'options', 'opensOn', 'closesOn', 'quorumPct', 'passPct', 'meetingId'];
async function putBallot(rec) {
  let before = isUuid(rec.id) ? await readers.ballots.get(rec.id) : null;
  const edited = !before || BALLOT_FIELDS.some((k) => JSON.stringify(ballotBody({ ...before, ...rec })[k]) !== JSON.stringify(ballotBody(before)[k]));
  if (before && before.status !== 'Draft' && edited) throw new Error(before.status === 'Open' ? 'An open ballot cannot be edited' : 'A closed ballot can never be changed');
  if (!before) before = ballotOf(await call('/governance/ballots', json('POST', ballotBody(rec))));
  else if (edited) before = ballotOf(await call(`/governance/ballots/${rec.id}`, json('PUT', ballotBody({ ...before, ...rec }), ifMatch(before.version))), before.roll);
  // opening freezes the roll on the server (the roll and fingerprint the screen built are not used); closing checks the box there
  if (rec.status === 'Open' && before.status === 'Draft') return readers.ballots.get((await call(`/governance/ballots/${before.id}/open`, json('POST', {}, ifMatch(before.version)))).id);
  if (rec.status === 'Closed' && before.status === 'Open') return readers.ballots.get((await call(`/governance/ballots/${before.id}/close`, json('POST', {}, ifMatch(before.version)))).id);
  if (rec.status && rec.status !== before.status && rec.status !== 'Draft') throw new Error(rec.status === 'Closed' ? 'A ballot must be opened before it is closed' : 'An open ballot can only be closed');
  return before;
}
// a vote: the roll mark carries the proof of the code; the box row carries the choice - the server writes both at once when the choice arrives
const pendingVotes = new Map();
async function putVoteMark(rec) {
  if (!isUuid(rec.ballotId) || !rec.proof) throw new Error('Second-factor check missing or expired - request a new code');
  pendingVotes.set(rec.ballotId, { unit: rec.unit, proof: rec.proof });
  return { ...rec, proof: undefined, id: `${rec.ballotId}-pending` };
}
async function putBoxRow(rec) {
  const p = pendingVotes.get(rec.ballotId);
  if (!p) throw new Error('No verified voter roll mark for this ballot');
  pendingVotes.delete(rec.ballotId);
  const ballot = await readers.ballots.get(rec.ballotId);
  const r = await call(`/governance/ballots/${rec.ballotId}/votes`, json('POST', { unitId: voteUnit(ballot, p.unit), proof: p.proof, choice: rec.choice }));
  return { id: `${rec.ballotId}-${r.seq}`, ballotId: rec.ballotId, choice: rec.choice, seq: r.seq, receipt: r.receipt, hash: r.hash };
}
async function putDonation(rec) {
  const before = isUuid(rec.id) ? await readers.culturalDonations.get(rec.id) : null;
  const { idByNo } = await unitIndex();
  if (!before) return donationOf(await call('/cultural/donations', json('POST', { ...donationBody(rec, idByNo), received: rec.status === 'Received' })));
  let out = null; let version = before.version;
  const fields = ['donor', 'kind', 'towards', 'amount', 'date', 'anonymous', 'note', 'phone', 'members', 'sankalpam', ...(rec.status === 'Received' ? [] : ['mode', 'reference'])];
  if (before.status === 'Pledged' && fields.some((k) => String(rec[k] ?? '') !== String(before[k] ?? ''))) {
    out = await call(`/cultural/donations/${rec.id}`, json('PUT', donationBody({ ...before, ...rec }, idByNo), ifMatch(version))); version = out.version;
  }
  if (rec.status === 'Received' && before.status !== 'Received') {
    out = isUuid(rec.gatewayRef)
      ? await call(`/cultural/donations/${rec.id}/paid-online`, json('POST', { prepaymentId: rec.gatewayRef }, ifMatch(version)))
      : await call(`/cultural/donations/${rec.id}/receive`, json('POST', { mode: rec.mode || 'Cash', reference: rec.reference || null }, ifMatch(version)));
  }
  return out ? donationOf(out) : before;
}
async function putExpense(rec) {
  const before = isUuid(rec.id) ? await readers.culturalExpenses.get(rec.id) : null;
  if (!before) return expenseOf(await call(`/cultural/events/${encodeURIComponent(rec.eventId)}/expenses`, json('POST', expenseBody(rec))));
  let version = before.version; let out = null;
  for (const cmd of expenseCommands(before, rec)) {
    out = cmd.put ? await call(`/cultural/expenses/${rec.id}`, json('PUT', expenseBody({ ...before, ...rec }), ifMatch(version)))
      : await call(`/cultural/expenses/${rec.id}/${cmd.path}`, json('POST', cmd.body || {}, ifMatch(version)));
    version = out.version;
  }
  return out ? expenseOf(out) : before;
}
/** Seva / programme rows: the register's fields through the kit; joining or leaving the list is a sign-up command. */
const signing = (c, list, key) => async (rec) => {
  const before = isUuid(rec.id) ? await readers[c].get(rec.id) : null;
  if (!before) return putResource(c, rec);
  const names = (xs) => (xs || []).map((x) => x.name);
  const was = before[key] || []; const now = rec[key] || [];
  const me = myName();
  if (JSON.stringify(names(now)) !== JSON.stringify(names(was))) {
    const added = now.filter((x) => !names(was).includes(x.name)); const gone = was.filter((x) => !names(now).includes(x.name));
    for (const x of added) { if (x.name !== me) throw new Error('Sign up as yourself.'); await call(`/cultural/${list}/${rec.id}/signup`, json('POST', { people: x.people || null })); }
    for (const x of gone) await call(`/cultural/${list}/${rec.id}/signup${x.name === me ? '' : `?membershipId=${x.membershipId}`}`, { method: 'DELETE' });
  }
  const rest = { ...rec }; delete rest[key];
  const fields = Object.keys(rest).filter((k) => !['id', 'version', 'shortId', 'createdAt', 'updatedAt'].includes(k));
  if (fields.some((k) => JSON.stringify(rest[k] ?? '') !== JSON.stringify(before[k] ?? ''))) return putResource(c, { ...rest, version: undefined });
  return readers[c].get(rec.id);
};
const RESERVE_KEYS = ['reservedBy', 'reservedUnit', 'reservedAt', 'donationId'];
const TOTAL_KEYS = ['collected', 'pledged', 'families', 'donors', 'spent', 'lastUpdatedBy', 'recordUpdatedAt'];
const CREDIT_KEYS = ['creditedAmount', 'creditedAt', 'creditedBy', 'creditNote'];
const changedBut = (before, rec, ignore) => Object.keys(rec).filter((k) => !ignore.includes(k) && !['id', 'version', 'shortId', 'createdAt', 'updatedAt'].includes(k) && JSON.stringify(rec[k] ?? '') !== JSON.stringify(before[k] ?? ''));
/** An offering's reservation is made by pledging for it (and freed by withdrawing the pledge): those fields are never written here. */
async function putOffering(rec) {
  const before = isUuid(rec.id) ? await readers.culturalOfferings.get(rec.id) : null;
  if (before && !changedBut(before, rec, RESERVE_KEYS).length) return before;
  return putResource('culturalOfferings', rec);
}
/** An event: its totals are the server's (worked out from the rows); crediting unused budget is its own command. */
async function putEvent(rec) {
  const before = isUuid(rec.id) ? await readers.culturalEvents.get(rec.id) : null;
  if (!before) return putResource('culturalEvents', rec);
  let out = before;
  if (Number(rec.creditedAmount || 0) !== Number(before.creditedAmount || 0)) {
    await call(`/cultural/events/${rec.id}/credit`, json('POST', { amount: Number(rec.creditedAmount), note: rec.creditNote || null }, ifMatch(before.version)));
    out = await readers.culturalEvents.get(rec.id);
  }
  if (changedBut(before, rec, [...TOTAL_KEYS, ...CREDIT_KEYS]).length) out = await putResource('culturalEvents', { ...rec, version: out.version });
  return out;
}
async function putPhoto(rec) {
  const out = await putResource('culturalPhotos', rec);
  if (isUuid(rec.fileId)) await call(`/files/${rec.fileId}/attach`, json('POST', { ownerType: 'cultural.photo', ownerId: out.id }));
  return out;
}
async function putLedger(rec) {
  const before = isUuid(rec.id) ? await readers.ledger.get(rec.id) : null;
  if (!before) {
    if (isUuid(rec.reversalOf)) {
      const orig = await readers.ledger.get(rec.reversalOf);
      return ledgerOf(await call(`/finance/cash-book/${rec.reversalOf}/reverse`, json('POST', { reason: rec.reason || 'Reversed' }, ifMatch(orig.version))));
    }
    if (bookedByServer(rec)) return { ...rec, id: rec.id || '', bookedByServer: true };   // the server already has this money in its books
    if (rec.sourceType === 'release' && isUuid(rec.sourceId)) {
      const rel = await readers.releases.get(rec.sourceId);
      const paid = rel.status === 'Paid' ? rel : releaseOf(await call(`/finance/releases/${rec.sourceId}/pay`, json('POST', { mode: rec.mode || null, ref: rec.ref || null, date: rec.date || null }, ifMatch(rel.version))));
      return readers.ledger.get(paid.paidEntryId);
    }
    const { idByNo } = await unitIndex();
    return ledgerOf(await call('/finance/cash-book', json('POST', ledgerBody(rec, idByNo))));
  }
  let out = before;
  if ((rec.reconStatus || before.reconStatus) !== before.reconStatus) {
    if (rec.reconStatus === 'Matched' && isUuid(rec.bankTxnId)) await call(`/finance/bank-lines/${rec.bankTxnId}/match`, json('POST', { entryId: rec.id }));
    else if (before.reconStatus === 'Matched') await call(`/finance/bank-lines/${before.bankTxnId}/unmatch`, { method: 'POST' });
    if (rec.reconStatus === 'Not applicable' || (rec.reconStatus === 'Unreconciled' && before.reconStatus === 'Not applicable')) await call(`/finance/cash-book/${rec.id}/statement`, json('POST', { notApplicable: rec.reconStatus === 'Not applicable' }));
    out = await readers.ledger.get(rec.id);
  }
  const words = ['description', 'category', 'subCategory', 'itcStatus', 'itcNote'];
  if (words.some((k) => k in rec && String(rec[k] ?? '') !== String(out[k] ?? ''))) {
    out = ledgerOf(await call(`/finance/cash-book/${rec.id}`, json('PATCH', Object.fromEntries(words.map((k) => [k, (k in rec ? rec[k] : out[k]) || null])), ifMatch(out.version))));
  }
  const money = ['date', 'type', 'amount', 'account', 'vendor', 'baseAmount', 'gstRate', 'tdsRate', 'mode', 'ref'];
  if (money.some((k) => k in rec && String(rec[k] ?? '') !== String(before[k] ?? ''))) throw new Error('A payment is not edited - reverse it and record it again.');
  return out;
}
async function putRelease(rec) {
  const before = isUuid(rec.id) ? await readers.releases.get(rec.id) : null;
  if (!before) return releaseOf(await call('/finance/releases', json('POST', { ticketId: isUuid(rec.ticketId) ? rec.ticketId : null, expenseId: isUuid(rec.expenseId) ? rec.expenseId : null,
    kind: rec.kind || 'Release', amount: Number(rec.amount), vendor: rec.vendor || null, note: rec.note || null })));
  let version = before.version; let out = null;
  for (const cmd of releaseCommands(before, rec)) {
    out = cmd.put ? await call(`/finance/releases/${rec.id}`, json('PUT', { kind: rec.kind || null, amount: n2v(rec.amount), vendor: rec.vendor || null, note: rec.note || null }, ifMatch(version)))
      : await call(`/finance/releases/${rec.id}/${cmd.path}`, json('POST', cmd.body || {}, ifMatch(version)));
    version = out.version;
  }
  return out ? releaseOf(out) : before;
}
const n2v = (x) => (x === '' || x == null ? null : Number(x));
async function putPayRequest(rec) {
  const before = isUuid(rec.id) ? await readers.payRequests.get(rec.id) : null;
  if (!before) {
    let p = {}; try { p = typeof rec.payload === 'string' ? JSON.parse(rec.payload || '{}') : (rec.payload || {}); } catch { p = {}; }
    const { idByNo } = await unitIndex();
    return payRequestOf(await call('/finance/pay-requests', json('POST', ledgerBody({ type: 'Debit', date: new Date().toISOString().slice(0, 10), ...p, description: p.description || rec.description, amount: p.amount ?? rec.amount, vendor: p.vendor || rec.vendor }, idByNo))));
  }
  if (rec.status !== before.status && ['Approved', 'Rejected'].includes(rec.status)) {
    return payRequestOf(await call(`/finance/pay-requests/${rec.id}/decision`, json('POST', { approve: rec.status === 'Approved', note: rec.decisionNote || rec.note || null }, ifMatch(before.version))));
  }
  return before;
}
/** New statement lines are imported (the same line twice is skipped); a line's match is made from its cash book entry. */
async function putBankTxn(rec) {
  const before = isUuid(rec.id) ? await readers.bankTxns.get(rec.id) : null;
  if (before) return before;
  await call('/finance/bank-lines/import', json('POST', { account: rec.account, lines: [bankLineBody(rec)] }));
  return (await readers.bankTxns.list()).find((l) => l.account === rec.account && l.date === rec.date && l.narration === (rec.narration || '') && Number(l.debit) === Number(rec.debit || 0) && Number(l.credit) === Number(rec.credit || 0)) || rec;
}
const bankLineBody = (r) => ({ date: r.date, narration: r.narration || null, head: r.head || null, debit: n2v(r.debit), credit: n2v(r.credit), balance: n2v(r.balance), party: r.party || null, remarks: r.remarks || null });
const deskOnly = () => { throw new Error('Visits and patrol scans are recorded by the gate desk (the gate screens), not edited.'); };

async function putBooking(rec) {
  const before = isUuid(rec.id) ? await readers.amenities.get(rec.id) : null;
  if (!before) {
    const [types, { idByNo }] = await Promise.all([call('/amenities/types'), unitIndex()]);
    return bookingOf(await call('/amenities/bookings', json('POST', bookBody(rec, { amenityIdByName: Object.fromEntries(types.map((t) => [t.name, t.id])), unitIdByNo: idByNo }))));
  }
  const cmd = bookingCommand(rec);
  if (!cmd) {
    if (rec.status && rec.status !== before.status) throw new Error('Use the booking actions (cancel, receive payment, refund, deposit) - a booking is not edited directly.');
    return before;
  }
  return bookingOf(await call(`/amenities/bookings/${encodeURIComponent(rec.id)}/${cmd.path}`, json('POST', cmd.body, ifMatch(before.version))));
}

const WRITERS = { reportSchedules: putReportSchedule, attendance: putAttendance, workforce: async () => { throw new Error('Teams are worked out from field staff.'); }, inventory: putInventory, infraLog: putConditionLog, serviceContacts: putContact, contactReviews: putReview, meetings: putMeeting, ballots: putBallot, voteRoll: putVoteMark, ballotBox: putBoxRow, ledger: putLedger, releases: putRelease, payRequests: putPayRequest, bankTxns: putBankTxn, culturalDonations: putDonation, culturalExpenses: putExpense, culturalOfferings: putOffering, culturalEvents: putEvent, culturalPhotos: putPhoto, culturalSevas: signing('culturalSevas', 'seva', 'volunteers'), culturalPrograms: signing('culturalPrograms', 'programme', 'participants'), files: putFile, documents: putDocument, notificationOutbox: async (r) => r /* the server queues channel messages itself, from the event */, notifications: putNotification, broadcasts: putBroadcast, pollVotes: putPollVote, forum: putTopic, forumPosts: putPost, gatePasses: putPass, gateApprovals: putApproval, gateFlags: putFlag, gateVisits: deskOnly, gateScans: deskOnly, gatePulse: async (r) => r, amenities: putBooking, properties: putProperty, users: putUser, dues: putDue, tickets: putTicket, ticketComments: putComment, handymen: putFieldStaff, quotations: putQuotation };
WRITERS.tickets = attaching(WRITERS.tickets, 'maintenance.ticket', 'attachments');
WRITERS.ticketComments = attaching(WRITERS.ticketComments, 'maintenance.comment', 'attachments');
WRITERS.quotations = attaching(WRITERS.quotations, 'maintenance.quotation', 'attachments');
WRITERS.amenities = attaching(WRITERS.amenities, 'amenity.booking', 'depositPhotos');
WRITERS.meetings = attaching(attaching(WRITERS.meetings, 'governance.agenda', 'agendaFiles'), 'governance.minutes', 'minutesFiles');
for (const c of Object.keys(RESOURCES)) if (!WRITERS[c]) WRITERS[c] = (rec) => putResource(c, rec);
WRITERS.vendors = attaching(WRITERS.vendors, 'vendor.vendor', 'attachments');
for (const [c, [owner, field]] of Object.entries(ASSET_FILES)) WRITERS[c] = attaching(WRITERS[c], owner, field);
const warned = new Set();
const notYet = (c) => { if (!warned.has(c)) { warned.add(c); console.info(`[v2] "${c}" is not on the v2 back end yet; showing it empty.`); } };

// ---- lists the server pages itself (limit / offset, its own order, its own filters) ---------------------------------------------------------------
// A page that sorts, filters or searches in a way the server does not is answered the old way (the whole list, then paged here), so the screen
// never shows something different from before - only faster.
const unitParam = async (no) => { const id = (await unitIndex()).idByNo[no]; return id || '__unknown__'; };
const PAGED = {
  properties: { path: '/units', order: ['unit:asc'], search: 'q', filters: {}, rows: async (items) => items.map(propertyOf) },
  users: { path: '/members', order: ['name:asc'], search: 'q', filters: { status: (v) => ['status', v] },
    rows: async (items) => { const { noById } = await unitIndex(); return items.map((m) => userOf(m, noById)); } },
  dues: { path: '/dues', order: ['dueDate:desc'], search: null, filters: { unit: async (v) => ['unit', await unitParam(v)] }, rows: async (items) => items.map((d) => dueOf(d)) },
  // the Maintenance page's own filters, tiles (several statuses / priorities) and orders; "mine", "waiting for me" and "overdue" stay on the
  // whole list for now (they narrow by ids the page works out)
  audit: { path: '/audit', order: ['when:desc'], search: 'q', dateKey: 'when',
    filters: { action: (v) => ['action', v], unit: async (v) => ['unit', await unitParam(v)], recordId: (v) => (isUuid(v) ? ['entityId', v] : ['entityId', '__unknown__']),
      what: (v) => { const f = auditFilterOf(v); return f ? Object.entries(f)[0] : null; } },
    rows: async (items) => { const { noById } = await unitIndex(); return items.map((a) => auditOf(a, noById)); } },
  tickets: { path: '/tickets', order: ['recordCreatedAt:desc', 'slaDueAt:asc', 'status:asc'], orderParam: { 'recordCreatedAt:desc': 'created', 'slaDueAt:asc': 'sla', 'status:asc': 'status' },
    search: null, files: 'maintenance.ticket', multi: ['status', 'priority'],
    filters: { unit: async (v) => ['unit', await unitParam(v)], status: (v) => (Array.isArray(v) ? ['statusIn', v.join(',')] : ['status', v]), category: (v) => ['category', v],
      priority: (v) => ['priority', [].concat(v).join(',')], taskType: (v) => ['taskType', v], financial: (v) => (v === true || v === 'true' ? ['financial', 'true'] : null),
      scope: (v) => ['scope', v] },
    rows: async (items) => { const { noById } = await unitIndex(); return items.map((t) => ticketOf(t, noById)); } },
};
async function serverPage(c, params) {
  const spec = PAGED[c];
  if (!spec) return null;
  const { page = 1, pageSize = 50, sort, filters = {}, search = '', dateRange, period } = params;
  if (pageSize > 200 || period?.year || period?.month) return null;
  if ((dateRange?.from || dateRange?.to) && dateRange.key !== spec.dateKey) return null;      // a date range only on the list's own date
  if (sort?.key && !spec.order.includes(`${sort.key}:${sort.dir || 'asc'}`)) return null;
  if (search && !spec.search) return null;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v === '' || v == null || (Array.isArray(v) && v.length === 0)) continue;
    if ((Array.isArray(v) && !spec.multi?.includes(k)) || v === '__none__' || (Array.isArray(v) && v.includes('__none__')) || !spec.filters[k]) return null;   // lists of values, "not set", or a filter the server lacks
    const pair = await spec.filters[k](v);
    if (!pair) return null;
    const [name, value] = pair;
    if (value === '__unknown__') return { rows: [], total: 0, page: 1, pageSize, pages: 1 };
    q.set(name, value);
  }
  if (search) q.set(spec.search, search);
  if (dateRange?.from) q.set('from', dateRange.from);
  if (dateRange?.to) q.set('to', dateRange.to);
  const size = Math.max(1, pageSize); const p = Math.max(1, page);
  if (spec.orderParam) q.set('order', spec.orderParam[sort?.key ? `${sort.key}:${sort.dir || 'asc'}` : spec.order[0]]);
  q.set('limit', String(size)); q.set('offset', String((p - 1) * size));
  const res = await call(`${spec.path}?${q.toString()}`);
  let rows = await spec.rows(res.items || []);
  if (spec.files && rows.length) {
    const by = {};
    for (const f of await call(`/files?ownerType=${spec.files}`)) (by[f.ownerId] ||= []).push(fileMeta(f));
    rows = rows.map((r) => (by[r.id] ? { ...r, attachments: by[r.id], hasPhotos: by[r.id].some((m) => /^image\//.test(m.mime)) } : r));
  }
  return { rows: revs(rows), total: res.total, page: p, pageSize: size, pages: Math.max(1, Math.ceil(res.total / size)) };
}

/** The server's row version is the app's record revision: forms re-seed when it changes (a saved ticket, a changed setting ...). */
const rev = (r) => (r && typeof r === 'object' && !Array.isArray(r) && r.recVersion == null && (r.version ?? r.rowVersion) != null ? { ...r, recVersion: Number(r.version ?? r.rowVersion) } : r);
const revs = (rows) => (Array.isArray(rows) ? rows.map(rev) : rev(rows));

/** @type {import('../StorageAdapter').StorageAdapter} */
export const V2ApiAdapter = {
  async list(c) {
    if (readers[c]) return revs(await readers[c].list());
    if (LOCAL_COLLECTIONS.includes(c)) return SessionStorageAdapter.list(c);
    notYet(c); return [];
  },
  async query(c, params = {}) {
    const paged = await serverPage(c, params);   // one page from the server when it can sort, filter and search the way the page asks
    if (paged) return paged;
    const rows = await this.list(c);
    const { runQuery } = await import('../queryEngine.js');   // same paging / sort / search as the session store
    return runQuery(rows, params);
  },
  async get(c, id) {
    if (readers[c]) return rev(await readers[c].get(id));
    if (LOCAL_COLLECTIONS.includes(c)) return SessionStorageAdapter.get(c, id);
    notYet(c); return null;
  },
  async put(c, rec) {
    if (WRITERS[c]) { const { recVersion, __opts, ...clean } = rec || {}; const out = rev(await WRITERS[c](clean)); if (c === 'properties') dropUnits(); return out; }   // the revision is the read side's; writes carry `version`
    if (LOCAL_COLLECTIONS.includes(c)) return SessionStorageAdapter.put(c, rec);
    throw new NotOnV2Error(c);
  },
  async putMany(c, list) {
    if (c === 'bankTxns' && list.length > 1 && list.every((r) => !isUuid(r.id))) {           // a whole statement in one import
      const byAccount = {};
      for (const r of list) (byAccount[r.account] ||= []).push(bankLineBody(r));
      for (const [account, lines] of Object.entries(byAccount)) await call('/finance/bank-lines/import', json('POST', { account, lines }));
      return revs(await readers.bankTxns.list());
    }
    const out = []; for (const r of list) out.push(await this.put(c, r)); return out;
  },
  async remove(c, id) {
    if (LOCAL_COLLECTIONS.includes(c)) return SessionStorageAdapter.remove(c, id);
    if (c === 'infraLog' || c === 'mapVersions') throw new Error('A history is kept as written.');
    if (RESOURCES[c]) return removeResource(c, id);
    if (c === 'ledger') throw new Error('A payment is not deleted - reverse it.');
    if (c === 'voteRoll' || c === 'ballotBox') throw new Error('Voting records can never be changed or deleted');
    if (c === 'attendance') { const a = isUuid(id) ? await readers.attendance.get(id) : null; if (a) await call(`/workforce/attendance/${id}`, { method: 'DELETE', headers: ifMatch(a.version) }); return; }
    if (c === 'contactReviews') { if (isUuid(id)) await call(`/vendors/reviews/${id}`, { method: 'DELETE' }); return; }
    if (c === 'serviceContacts') { const x = isUuid(id) ? await readers.serviceContacts.get(id) : null; if (x) await call(`/vendors/directory/${id}`, { method: 'DELETE', headers: ifMatch(x.version) }); return; }
    if (c === 'meetings' || c === 'ballots') {
      const before = isUuid(id) ? await readers[c].get(id) : null;
      if (before) await call(`/governance/${c}/${id}`, { method: 'DELETE', headers: ifMatch(before.version) });
      return;
    }
    if (c === 'releases') { const r = isUuid(id) ? await readers.releases.get(id) : null; if (r) await call(`/finance/releases/${id}/cancel`, json('POST', { reason: 'Removed' }, ifMatch(r.version))); return; }
    if (c === 'culturalDonations' || c === 'culturalExpenses') {
      const before = isUuid(id) ? await readers[c].get(id) : null;
      if (before) await call(`/cultural/${c === 'culturalDonations' ? 'donations' : 'expenses'}/${id}`, { method: 'DELETE', headers: ifMatch(before.version) });
      return;
    }
    if (c === 'files') { if (isUuid(id)) await call(`/files/${id}`, { method: 'DELETE' }); return; }
    if (c === 'documents') { const d = isUuid(id) ? await readers.documents.get(id) : null; if (d) await call(`/documents/${id}`, { method: 'DELETE', headers: ifMatch(d.rowVersion) }); return; }
    if (c === 'forum' || c === 'forumPosts' || c === 'broadcasts') {
      const path = c === 'forum' ? `/comms/forum/topics/${id}` : c === 'forumPosts' ? `/comms/forum/posts/${id}` : `/comms/broadcasts/${id}`;
      const before = isUuid(id) ? await readers[c].get(id) : null;
      if (before) await call(path, { method: 'DELETE', headers: ifMatch(before.version) });
      return;
    }
    if (c === 'quotations') { const q = isUuid(id) ? await call(`/quotations/${id}`) : null; if (q) await call(`/quotations/${id}`, { method: 'DELETE', headers: ifMatch(q.version) }); return; }
    throw new Error(c === 'notifications' ? 'Notifications cannot be deleted.' : c === 'amenities' ? 'Bookings cannot be deleted - cancel them instead.' : c === 'dues' ? 'A bill is not deleted: cancel it with a reason.' : c === 'users' ? 'Deactivate the member instead.' : c === 'tickets' ? 'Tickets cannot be deleted - cancel or close them instead.' : `"${c}" cannot be removed on the v2 back end.`);
  },
  async replaceAll(c, records) { if (LOCAL_COLLECTIONS.includes(c)) return SessionStorageAdapter.replaceAll(c, records); throw new NotOnV2Error(c); },
  forCommunity() { return V2ApiAdapter; },          // the community comes from the access token, not from the client
  async clearCommunity() { throw new Error('Not available on the v2 back end.'); },
};
