// secureStorage = storage + authorization + record metadata + audit.
// EVERY module reads/writes through this (via useCollection), never through
// the raw adapter. It plays the role of the Spring Boot controller/service
// layer: authenticate -> authorize -> stamp -> persist -> audit.
import { track } from '../net/activity.js';
import { storage, isApiMode } from './index.js';
import { remoteSecure } from './remoteSecure.js';
import { serverDecides } from '../auth/session.js';
import { ConflictError } from '../security/errors.js';
import { COLLECTIONS } from './StorageAdapter.js';
import { runQuery } from './queryEngine.js';
import { getPrincipal, getSchema } from '../security/principal.js';
import { lockError, setLock } from '../finance/lock.js';
import { authorizeWrite, setSecondStepRoles, setFinalCanDecideEC, canReadCollection, maskRecord, hiddenFieldKeys, rowScope, blockWriteOk, AuthzError, META_KEYS, prepareWrite, staysInScope, shapeForReader, isAdmin, isResident } from '../security/authz.js';
import { dispatchCategory, isQueueType } from '../ticketQueue.js';
import { diffRecords, snapshotRecord, logChange } from '../audit/auditLog.js';
import { notifyAfterWrite } from '../notifyExtra.js';
import { notifyTicketChange, notifyApprovalNeeded, notifyInvoiceChange } from '../notifications.js';
import { syncDuePayment } from '../utilityLedger.js';
import { EV_COLLECTIONS, EV_IMMUTABLE, evotingPreWrite } from '../evoting.js';
import { uuid } from '../uuid.js';
import { trailFor } from './trail.js';
import { amenityPreWrite, amenityPostWrite } from '../amenityServer.js';
import { recordMapVersion } from '../infra/mapVersions.js';
import { meetingPreWrite, meetingPostWrite } from '../meetingServer.js';
import { moneyPreWrite } from '../approval/moneyGuard.js';
import { propertyPreWrite, propertyPostWrite, pollPreWrite } from '../propertyServer.js';
import { announceChange } from './changes.js';

// Every record has TWO identifiers:
//   id      - a UUID, the primary key. Used for storage/lookup/links. NEVER shown in the UI.
//   shortId - human-readable, per module (TKT-1051, LED-0003 ...). This is what people see and quote.
const PREFIX = {
  mapVersions: 'MVR',
  amenityItems: 'AIT',
  communityConfig: 'CFG', vendorServices: 'VSV', numberSections: 'NSC', taxSettings: 'TXS', taxComponents: 'TXC', levies: 'LEV', demandNotices: 'DMN', payRequests: 'PRQ', approvalPolicies: 'APL', releases: 'REL', recurringBills: 'RCB', cashCounts: 'CSH', blocks: 'BLK', facilities: 'FAC', paymentRouting: 'PRT', audits: 'AUD', serviceContacts: 'SVC', contactReviews: 'CRV',
  assocBills: 'ABL', deposits: 'DEP', inventoryRules: 'IRL', userProfiles: 'UPR', categoryMap: 'CAT', quotations: 'QUO', files: 'FIL', ecRoles: 'ECR', subcommittees: 'SUB', approvals: 'APR', approverSettings: 'APS', bankAccounts: 'BAC', bankTxns: 'BTX', budgetLines: 'BUD', fixedExpenses: 'FIX', importProfiles: 'IMP', ledgerSkips: 'LSK', dgFuelLogs: 'DGF', plantLogs: 'PLG', logTypes: 'LGT', logEntries: 'LGE', electricityBills: 'ELB', villaElectricity: 'VEL', equipment: 'EQP', financeSettings: 'FST',
  gatePeople: 'GPR', gateLinks: 'GLK', gatePasses: 'GPS', gateVisits: 'GVT', gateApprovals: 'GAP', gateFlags: 'GFL', gateVehicles: 'GVH', gateWorkOrders: 'GWO', gateVillaRules: 'GVR', gateSettings: 'GST',
  tradeAvailability: 'TRD', meetings: 'MTG', funds: 'FND',
  properties: 'UNIT', tickets: 'TKT', ticketComments: 'CMT', taskTypes: 'TTY', dues: 'DUE', funds: 'FND', ledger: 'LED',
  utilityTypes: 'UTY', amenities: 'BKG', amenityTypes: 'AMT', amenitySettings: 'AMS', notificationTemplates: 'NTM', notificationOutbox: 'OUT', unitCredits: 'UCR', portalInvites: 'PIV', visitors: 'VIS', incidents: 'INC', vendors: 'VEN', broadcasts: 'BRD',
  noticeTemplates: 'NTP', mergeFields: 'MRG', forum: 'TPC', forumPosts: 'PST', wishes: 'WSH', infraPlans: 'PLN', infraLayers: 'LYR', infraLog: 'ILG', eventWork: 'EWK', checklists: 'PMC', checklistRounds: 'PMR', reportSchedules: 'RPS', reportRuns: 'RPR', meetings: 'MTG', documents: 'DOC',
  handymen: 'HMN', shifts: 'SHF', attendance: 'ATT', attendanceSettings: 'ATS', siteCalendar: 'CAL', siteServices: 'SVC', siteHolidays: 'HOL', docFolders: 'FLD', culturalEvents: 'EVT', culturalPrograms: 'PRG', culturalSevas: 'SEV', culturalDonations: 'DON', culturalOfferings: 'OFR', culturalExpenses: 'EXP', quickPhrases: 'QPH', billingTemplates: 'BTP', workforce: 'WRK', villaImportRules: 'VIR', ballots: 'BAL', voteRoll: 'VRL', ballotBox: 'BBX', pollVotes: 'PLV', users: 'USR', roles: 'ROL', vendorComments: 'VCM', inventory: 'INV', readings: 'RDG',
};
export { ConflictError };
let versionCheck = () => false;
/** SERVER ONLY: turns on the optimistic-lock check for writes that arrive over HTTP (the caller says which version it loaded). */
export const setVersionCheck = (fn) => { versionCheck = fn; };
export const shortPrefix = (collection) => PREFIX[collection] || collection.slice(0, 3).toUpperCase();
export function newId() {
  return uuid();
}

let shortIds = null;
/** SERVER ONLY: (collection, base, prefix) -> next number, from a counter in the database instead of reading the whole collection. */
export const setShortIdAllocator = (fn) => { shortIds = fn; };
const TICKET_BASE = 1050; // ticket numbers continue from TKT-1051
/** Next short id for a module: PREFIX-0001 (tickets: TKT-1051...). Computed from RAW rows so a resident's limited view can't cause duplicates. */
export async function nextShortId(collection) {
  const p = shortPrefix(collection);
  if (shortIds) { const n = await shortIds(collection, collection === COLLECTIONS.TICKETS ? TICKET_BASE : 0, p); return `${p}-${collection === COLLECTIONS.TICKETS ? n : String(n).padStart(4, '0')}`; }   // server: a counter row, not a scan
  const rows = await storage.list(collection);
  const max = rows.reduce((m, r) => {
    const n = Number(String(r.shortId || r.ticketNumber || '').replace(`${p}-`, '').replace(/^TKT-/, ''));
    return Number.isFinite(n) && n > m ? n : m;
  }, collection === COLLECTIONS.TICKETS ? TICKET_BASE : 0);
  const next = max + 1;
  return `${p}-${collection === COLLECTIONS.TICKETS ? next : String(next).padStart(4, '0')}`;
}

// Collections whose changes are NOT written to the audit trail: the discussion forum
// (conversation, not records) and raw file bytes (the owning record carries the audit).
const NO_AUDIT = new Set([COLLECTIONS.FORUM, COLLECTIONS.FORUM_POSTS, COLLECTIONS.FILES, COLLECTIONS.VENDOR_COMMENTS, COLLECTIONS.BALLOT_BOX, COLLECTIONS.POLL_VOTES]);

const notify = (collection) => announceChange(collection);
const actorLabel = (p) => (p.name === p.role?.name ? p.name : `${p.name} (${p.role?.name ?? p.roleId})`);
const unitOf = (r) => r?.unit || r?.hostUnit || '';

async function readRaw(collection) {
  return storage.list(collection);
}

async function scoped(collection) {
  const p = getPrincipal();
  if (!p || !canReadCollection(collection, p)) return [];
  const schema = getSchema(collection);
  const scope = await rowScope(collection, p, readRaw);
  let rows = await readRaw(collection);
  // The ballot box stays sealed (for everyone, the Super Admin included) until the ballot is closed.
  if (collection === COLLECTIONS.BALLOT_BOX) {
    const closed = new Set((await readRaw(COLLECTIONS.BALLOTS)).filter((b) => b.status === 'Closed').map((b) => b.id));
    rows = rows.filter((r) => closed.has(r.ballotId));
  }
  if (scope.predicate) rows = rows.filter(scope.predicate);
  if (scope.transform) rows = rows.map(scope.transform);
  return rows.map((r) => maskRecord(r, schema, p.roleId, p));
}

async function denied(collection, op, record, reason) {
  const p = getPrincipal();
  if (p && collection !== COLLECTIONS.AUDIT && !NO_AUDIT.has(collection)) {
    await logChange({
      who: actorLabel(p), whoName: p.name, what: getSchema(collection)?.label ?? collection, collection, recordId: record?.id ?? '', recordShortId: record?.shortId ?? '', unit: unitOf(record),
      action: 'Denied', summary: `${op} blocked: ${reason}`, changes: [],
    });
  }
  throw new AuthzError(reason);
}

// ---- r77: one set of write checks for single and bulk writes -----------------------------------------------------------------------
/** The caller's row scope for a write (the Super Admin has none). */
const writeScope = async (collection, p) => (p && !isAdmin(p) ? rowScope(collection, p, readRaw) : {});
/** A record that points at another one (a comment at its ticket, a review at its contact ...) may only point at one the caller can see. */
const PARENTS = {
  [COLLECTIONS.TICKET_COMMENTS]: ['ticketId', COLLECTIONS.TICKETS], [COLLECTIONS.CONTACT_REVIEWS]: ['contactId', COLLECTIONS.SERVICE_CONTACTS],
  [COLLECTIONS.FORUM_POSTS]: ['topicId', COLLECTIONS.FORUM], [COLLECTIONS.CULTURAL_PHOTOS]: ['eventId', COLLECTIONS.CULTURAL_EVENTS],
  [COLLECTIONS.CULTURAL_DONATIONS]: ['eventId', COLLECTIONS.CULTURAL_EVENTS], [COLLECTIONS.POLL_VOTES]: ['broadcastId', COLLECTIONS.BROADCASTS],
  [COLLECTIONS.GATE_LINKS]: ['personId', COLLECTIONS.GATE_PEOPLE], [COLLECTIONS.QUOTATIONS]: ['ticketId', COLLECTIONS.TICKETS],
};
async function parentVisible(collection, record, old, p) {
  const ref = PARENTS[collection];
  if (!ref || !p || isAdmin(p)) return true;
  const [key, parentCollection] = ref;
  const id = record?.[key];
  if (!id || (old && old[key] === id)) return true;          // not pointing anywhere new
  if (!canReadCollection(parentCollection, p)) return false;
  const parent = await storage.get(parentCollection, id);
  if (!parent) return false;
  const sc = await rowScope(parentCollection, p, readRaw);
  return !sc.predicate || sc.predicate(parent);
}
/** prepare -> authorize -> blocks -> closed books -> money -> parent: throws (and audits) a refusal, returns the record to save. */
async function checkWrite(collection, record, old, op, p, schema) {
  const verb = op === 'create' ? 'Create' : op === 'delete' ? 'Delete' : 'Update';
  const scope = await writeScope(collection, p);
  const prep = prepareWrite({ collection, p, schema, old, next: record, op, scope });
  if (!prep.ok) await denied(collection, verb, old ?? record ?? {}, prep.reason);
  const rec = prep.record;
  const verdict = authorizeWrite({ collection, p, schema, old, next: op === 'delete' ? (old ?? {}) : rec, op });
  if (!verdict.ok) await denied(collection, verb, old ?? rec ?? {}, verdict.reason);
  { const st = staysInScope({ collection, p, old, record: rec, op, scope }); if (!st.ok) await denied(collection, verb, old ?? rec ?? {}, st.reason); }
  if (!(await blockWriteOk(collection, op === 'delete' ? old : rec, old, p, readRaw))) await denied(collection, verb, old ?? rec ?? {}, 'This unit is outside the blocks you manage');
  { const le = lockError(collection, op === 'delete' ? old : rec, old); if (le) await denied(collection, verb, old ?? rec ?? {}, le); }
  { const me = await moneyPreWrite({ collection, record: op === 'delete' ? old : rec, old, op, list: (c) => storage.list(c) }); if (me) await denied(collection, verb, old ?? rec ?? {}, me); }
  if (op !== 'delete' && !(await parentVisible(collection, rec, old, p))) await denied(collection, verb, rec, 'That record is not yours to add to');
  // e-mail addresses (where mail goes, and the sign-in name for e-mail sign-in) are stored in lower case, in every collection
  for (const k of Object.keys(rec)) if ((k === 'email' || /Email$/.test(k)) && typeof rec[k] === 'string') rec[k] = rec[k].trim().toLowerCase();
  return { record: rec, scope };
}
/** A resident's new request: the server, not the browser, decides the type, the first assignee and the starting values. */
async function residentTicketStart(record) {
  const types = await storage.list(COLLECTIONS.TASK_TYPES);
  const tt = types.find((t) => t.name === record.taskType);
  if (!tt || !(tt.creatorScope === 'Resident' || tt.residentDefault)) return { error: 'Raise this request with a resident request type' };
  // it joins its category's queue; the next free technician is given it after it is saved (dispatchCategory)
  return { record: { ...record, status: 'Open', assignedTo: '', paymentStatus: 'Not Paid', awaitingParts: false, materialsCost: 0, residentRating: 0 } };
}
// Bulk writes skip the per-record server steps (prices, votes, ticket rules, money): these collections are saved one record at a time.
const NO_BULK = new Set([COLLECTIONS.AMENITIES, COLLECTIONS.BALLOTS, COLLECTIONS.VOTE_ROLL, COLLECTIONS.BALLOT_BOX, COLLECTIONS.POLL_VOTES, COLLECTIONS.MEETINGS,
  COLLECTIONS.TICKETS, COLLECTIONS.TICKET_COMMENTS, COLLECTIONS.RELEASES, COLLECTIONS.LEDGER, COLLECTIONS.QUOTATIONS, COLLECTIONS.FILES, 'notifications']);
// one unit per number in a batch too (whatever its case)
async function unitOnce(rec, seen) {
  const k = String(rec.unit || '').toLowerCase();
  if (seen.has(k)) await denied(COLLECTIONS.PROPERTIES, 'Create', rec, `“${rec.unit}” is in this batch twice (unit numbers are the same whatever their case)`);
  seen.add(k);
}
const stripMeta = (r) => { const o = { ...r }; META_KEYS.forEach((k) => { if (k !== 'id') delete o[k]; }); return o; };

const localSecure = {
  async list(collection) {
    return scoped(collection);
  },

  /** Server-side style paging: scope -> mask -> filter/sort/page. */
  async query(collection, params = {}) {
    return runQuery(await scoped(collection), params);
  },

  async get(collection, id) {
    const row = (await scoped(collection)).find((r) => r.id === id) ?? null;
    // Listing a back end gives file METADATA only (bytes are not sent in lists). Fetch the bytes for the one file being opened.
    if (row && collection === COLLECTIONS.FILES && !row.dataUrl && row.hasContent) return (await storage.get(collection, id)) ?? row;
    return row;
  },

  async put(collection, record, { summaryOf, label } = {}) {
    const p = getPrincipal();
    const schema = getSchema(collection);
    const old = record.id ? await storage.get(collection, record.id) : null;
    const isNew = !old;
    if (old && record.recVersion != null && old.recVersion != null && Number(record.recVersion) !== Number(old.recVersion) && versionCheck()) throw new ConflictError(old);
    // the final-approval roles are configurable data: load them for the authorization guards below
    if (collection === COLLECTIONS.TICKETS || collection === COLLECTIONS.CULTURAL_EXPENSES || collection === COLLECTIONS.QUOTATIONS || collection === COLLECTIONS.RELEASES) { setSecondStepRoles((await storage.list(COLLECTIONS.APPROVER_SETTINGS))[0]?.roles); setFinalCanDecideEC((await storage.list(COLLECTIONS.FINANCE_SETTINGS))[0]?.finalCanDecideEC); }
    // r77: what the caller may write is decided here (scope, hidden fields, identity), then authorised; money rules apply to everyone.
    const checked = await checkWrite(collection, record, old, isNew ? 'create' : 'update', p, schema);
    record = checked.record;
    const shape = (r) => shapeForReader(r, { collection, p, schema, scope: checked.scope });
    // a trade worker hands a ticket only to themselves or a colleague of the same trade (or back to the queue)
    if (collection === COLLECTIONS.TICKETS && old && p?.roleId?.startsWith('handyman_') && p.roleId !== 'handyman_mep' && (record.assignedTo || '') !== (old.assignedTo || '') && record.assignedTo) {
      const trade = String(p.role?.name || '').split('·')[1]?.trim();
      const lc = (x) => String(x || '').trim().toLowerCase();
      const crew = new Set([p.name, ...(await storage.list(COLLECTIONS.HANDYMEN)).filter((h) => !!trade && lc(h.trade) === lc(trade)).map((h) => h.name)].map(lc));
      if (!crew.has(lc(record.assignedTo))) await denied(collection, 'Update', record, 'Hand the ticket to yourself or a colleague of your trade');
    }
    if (collection === COLLECTIONS.TICKETS && isNew && isResident(p)) {
      const r = await residentTicketStart(record);
      if (r.error) await denied(collection, 'Create', record, r.error);
      record = r.record;
    }
    // E-voting rules apply to everyone, the Super Admin included: eligibility, 2nd factor, immutability, sealed box.
    if (EV_COLLECTIONS.has(collection)) {
      const ev = await evotingPreWrite({ collection, record, old, p });
      if (ev.error) await denied(collection, isNew ? 'Create' : 'Update', { id: collection === COLLECTIONS.BALLOT_BOX ? '' : record?.id }, ev.error);
      record = { ...record, ...(ev.patch || {}) };
      Object.keys(record).forEach((k) => { if (record[k] === undefined) delete record[k]; });
    }

    // Amenity bookings: prices, payment state, cancellation refunds and deposits are decided here, never by the client.
    let amenityAction = null;
    if (collection === COLLECTIONS.AMENITIES) {
      const r = await amenityPreWrite({ record, old, isNew, p });
      if (r.error) await denied(collection, isNew ? 'Create' : 'Update', record, r.error);
      record = r.record;
      amenityAction = r.action || null;
    }

    // Property register: phones are validated and normalised here; saving people triggers portal invites / deactivations afterwards.
    let propertyChange = null;
    if (collection === COLLECTIONS.PROPERTIES) {
      const r = await propertyPreWrite({ record, old, isNew });
      if (r.error) await denied(collection, isNew ? 'Create' : 'Update', record, r.error);
      record = r.record;
      propertyChange = { old };
    }
    // Blocks: a name and a code are unique whatever their case; a block's own naming pattern must be one the rules understand
    if (collection === COLLECTIONS.BLOCKS) {
      const { patternProblem, key: nameKey } = await import('../unitNaming.js');
      record = { ...record, name: String(record.name || '').trim().replace(/\s+/g, ' '), code: String(record.code || '').trim(), unitPattern: String(record.unitPattern || '').trim() };
      const why = patternProblem(record.unitPattern);
      if (why) await denied(collection, isNew ? 'Create' : 'Update', record, why);
      for (const b of await storage.list(COLLECTIONS.BLOCKS)) {
        if (b.id === record.id) continue;
        if (nameKey(b.name) === nameKey(record.name)) await denied(collection, isNew ? 'Create' : 'Update', record, `There is already a block “${b.name}”`);
        if (record.code && nameKey(b.code) === nameKey(record.code)) await denied(collection, isNew ? 'Create' : 'Update', record, `Block “${b.name}” already has the code ${b.code}`);
      }
    }
    // Amenities: a name is unique whatever its case; a rename is carried to its bookings and add-on items (they name it), as the server's ids do
    let amenityRename = null;
    if (collection === COLLECTIONS.AMENITY_TYPES) {
      const name = String(record.name ?? old?.name ?? '').trim().replace(/\s+/g, ' ');
      if (name.length < 2 || name.length > 60) await denied(collection, isNew ? 'Create' : 'Update', record, 'A name has 2 to 60 characters');
      const clash = (await storage.list(COLLECTIONS.AMENITY_TYPES)).find((t) => t.id !== record.id && String(t.name).trim().toLowerCase() === name.toLowerCase());
      if (clash) await denied(collection, isNew ? 'Create' : 'Update', record, `There is already an amenity “${clash.name}”`);
      record = { ...record, name };
      if (old && old.name !== name) amenityRename = { from: old.name, to: name };
    }
    let meetingChange = null;
    if (collection === COLLECTIONS.MEETINGS) {
      record = (await meetingPreWrite({ record, old })).record;
      meetingChange = { old };
    }
    // One poll answer per villa.
    if (collection === COLLECTIONS.POLL_VOTES) {
      const r = await pollPreWrite({ record, old });
      if (r.error) await denied(collection, isNew ? 'Create' : 'Update', record, r.error);
    }

    // Business rule: internal (EC / FM / MEP created) tasks can only be assigned to
    // EC members or vendors - never owners/residents or facility staff.
    if (collection === COLLECTIONS.TICKETS && isNew && !record.assignedTo) {
      const types = await storage.list(COLLECTIONS.TASK_TYPES);
      if (types.find((t) => t.name === record.taskType)?.creatorScope === 'EC / Staff') await denied(collection, 'Create', record, 'Assigned to is required');
    }
    if (collection === COLLECTIONS.TICKETS && record.assignedTo && record.assignedTo !== old?.assignedTo) {
      const types = await storage.list(COLLECTIONS.TASK_TYPES);
      const tt = types.find((t) => t.name === (record.taskType ?? old?.taskType));
      if (tt?.creatorScope === 'EC / Staff') {
        const [ec, users, coverage, allRoles] = await Promise.all([storage.list(COLLECTIONS.EC_ROLES), storage.list(COLLECTIONS.USERS), storage.list(COLLECTIONS.CATEGORY_MAP), storage.list(COLLECTIONS.ROLES)]);
        // ...and the people in the roles that coordinate the task's category (Category coverage -> Coordinated by)
        const coordIds = new Set((coverage.find((c) => c.category === (record.category ?? old?.category))?.coordinator || []));
        const inEcGroup = (r) => coordIds.has('group:EC') && allRoles.find((x) => x.id === r)?.category === 'EC';
        const coordinators = users.filter((u) => u.status !== 'Inactive' && [u.roleId, ...(u.extraRoleIds || [])].some((r) => coordIds.has(r) || inEcGroup(r))).map((u) => u.name);
        // ...and anyone signed in through an EC role (an EC member asking for a payment is given the task themselves)
        const ecRoleIds = new Set(allRoles.filter((x) => x.category === 'EC').map((x) => x.id));
        const ecUsers = users.filter((u) => u.status !== 'Inactive' && [u.roleId, ...(u.extraRoleIds || [])].some((r) => ecRoleIds.has(r))).map((u) => u.name);
        const pool = new Set([...ec.map((r) => r.personName || r.roleTitle), ...coordinators, ...ecUsers, ...(p && ecRoleIds.has(p.roleId) && record.assignedTo === p.name ? [p.name] : [])]);
        if (!pool.has(record.assignedTo)) await denied(collection, isNew ? 'Create' : 'Update', record, 'Internal tasks can only be assigned to EC members or the coordinators of the task\'s category - not vendors, owners or residents');
      }
    }

    // Approval sequencing: Treasurer approval only after the EC approval. Quotations are optional.
    if (collection === COLLECTIONS.TICKETS && old) {
      const ecNow = record.ecApproval ?? old.ecApproval;
      if (record.treasurerApproval === 'Approved' && old.treasurerApproval !== 'Approved' && ecNow !== 'Approved') {
        await denied(collection, 'Update', record, 'Treasurer approval needs the EC approval first');
      }
    }

    const now = new Date().toISOString();
    const id = record.id || newId();
    const incoming = { ...record, id };
    // client can never forge metadata - strip and re-stamp
    META_KEYS.forEach((k) => { if (k !== 'id') delete incoming[k]; });
    const changes = isNew ? snapshotRecord(incoming, schema, 'create') : diffRecords(old, incoming, schema);
    if (!isNew && changes.length === 0) return shape(old); // nothing changed -> no write, no audit noise

    let shortId = old?.shortId;
    if (!shortId) shortId = await nextShortId(collection);
    const stamped = {
      ...incoming,
      shortId,
      ...(collection === COLLECTIONS.TICKETS ? { ticketNumber: shortId } : {}),
      recVersion: (old?.recVersion ?? 0) + 1,
      recordCreatedAt: old?.recordCreatedAt ?? now,
      recordCreatedBy: old?.recordCreatedBy ?? actorLabel(p),
      lastUpdatedAt: now,
      lastUpdatedBy: actorLabel(p),
      // the ballot box keeps no trace of who or when (to the minute): only the day
      ...(collection === COLLECTIONS.BALLOT_BOX ? { recordCreatedAt: now.slice(0, 10), recordCreatedBy: 'Ballot box', lastUpdatedAt: now.slice(0, 10), lastUpdatedBy: 'Ballot box' } : {}),
    };
    // Status movement trail (shown as the breadcrumb): appended only when the status actually changes; clients cannot forge it.
    if (collection === COLLECTIONS.TICKETS) {
      const trail = Array.isArray(old?.statusHistory) ? [...old.statusHistory] : (old?.status ? [{ status: old.status, at: old.recordCreatedAt || now, by: old.createdBy || '' }] : []);
      if (!old || stamped.status !== old.status) trail.push({ status: stamped.status, at: now, by: actorLabel(p) });
      stamped.statusHistory = trail;
    }
    if (collection !== COLLECTIONS.BALLOT_BOX) Object.assign(stamped, trailFor(old, stamped, schema, now, actorLabel(p))); // time trail (ballot box keeps none, by design)
    const saved = await storage.put(collection, stamped);
    if (collection === COLLECTIONS.EQUIPMENT || collection === COLLECTIONS.INFRA_PLANS) await recordMapVersion({ collection, old, next: stamped, who: actorLabel(p), action: isNew ? 'create' : 'update' });
    if (collection !== COLLECTIONS.AUDIT && !NO_AUDIT.has(collection)) {
      await logChange({
        who: actorLabel(p), whoName: p.name, what: label ?? schema?.label ?? collection, collection, recordId: id, recordShortId: shortId, unit: unitOf(stamped),
        action: isNew ? 'Create' : 'Update', summary: summaryOf ? summaryOf(stamped) : shortId, changes,
      });
    }
    if (collection === COLLECTIONS.TICKETS) {
      try { const roles = await storage.list(COLLECTIONS.ROLES); await notifyTicketChange({ old, next: stamped, actor: p, users: await storage.list(COLLECTIONS.USERS), roles }); await notifyApprovalNeeded({ old, next: stamped, actor: p, roles }); } catch (e) { console.warn('notification failed', e); }
    }
    if (collection !== COLLECTIONS.AUDIT && collection !== 'notifications' && collection !== COLLECTIONS.NOTIFICATION_OUTBOX) { try { await notifyAfterWrite({ collection, old, next: stamped, actor: p }); } catch (e) { console.warn('extra notification failed', e); } }
    if (collection === COLLECTIONS.QUOTATIONS) {
      try { await notifyInvoiceChange({ old, next: stamped, actor: p, roles: await storage.list(COLLECTIONS.ROLES) }); } catch (e) { console.warn('invoice notification failed', e); }
    }
    if (meetingChange) {
      try { await meetingPostWrite({ old: meetingChange.old, next: stamped, actor: actorLabel(p) }); } catch (e) { console.warn('meeting notification failed', e); }
    }
    if (propertyChange) {
      try { await propertyPostWrite({ old: propertyChange.old, next: stamped, actor: actorLabel(p) }); } catch (e) { console.warn('property access sync failed', e); }
    }
    if (amenityRename) {
      for (const b of await storage.list(COLLECTIONS.AMENITIES)) if (b.amenity === amenityRename.from) await storage.put(COLLECTIONS.AMENITIES, { ...b, amenity: amenityRename.to });
      for (const it of await storage.list(COLLECTIONS.AMENITY_ITEMS)) if (it.amenity === amenityRename.from) await storage.put(COLLECTIONS.AMENITY_ITEMS, { ...it, amenity: amenityRename.to });
      notify(COLLECTIONS.AMENITIES); notify(COLLECTIONS.AMENITY_ITEMS);
    }
    if (collection === COLLECTIONS.AMENITIES && amenityAction) {
      try { await amenityPostWrite({ old, next: stamped, action: amenityAction }); } catch (e) { console.warn('amenity post-processing failed', e); }
    }
    // A bill paid (or un-paid): its own transaction in Payments, linked to the bill.
    if (collection === COLLECTIONS.DUES && (isNew || old?.status !== stamped.status || old?.amount !== stamped.amount || old?.paidAt !== stamped.paidAt)) {
      try { await syncDuePayment(stamped, { nextShortId }); } catch (e) { console.warn('ledger sync failed', e); }
    }
    if (collection === COLLECTIONS.FINANCE_SETTINGS) setLock(stamped.lockedUntil);
    // maintenance tickets: a new one, or one that freed its technician (done, on hold, cancelled, handed back), moves its category's queue;
    // a technician coming on shift takes the oldest waiting ticket of their trade
    let fresh = saved;
    try {
      if (collection === COLLECTIONS.TICKETS && (isNew || old.status !== stamped.status || old.assignedTo !== stamped.assignedTo || old.category !== stamped.category)) {
        const tt = (await storage.list(COLLECTIONS.TASK_TYPES)).find((t) => t.name === stamped.taskType);
        if (isQueueType(tt)) {
          await dispatchCategory(stamped.category);
          if (old && old.category !== stamped.category) await dispatchCategory(old.category);
          fresh = (await storage.get(collection, id)) || saved;
        }
      }
      if (collection === COLLECTIONS.HANDYMEN && stamped.clockedIn && !old?.clockedIn) await dispatchCategory(stamped.trade);
    } catch (e) { console.warn('dispatch failed', e); }
    notify(collection);
    return shape(fresh);
  },

  /** Bulk create (statement import): authorised once, written in one go, one audit line for the whole batch. */
  async importMany(collection, rows, { label, summary } = {}) {
    const p = getPrincipal();
    const schema = getSchema(collection);
    if (!rows.length) return 0;
    if (NO_BULK.has(collection)) await denied(collection, 'Import', rows[0], 'These records are saved one at a time');
    const checkedRows = []; const batchUnits = new Set();
    for (const r of rows) {   // every row is checked, not just the first
      let rec = (await checkWrite(collection, { ...stripMeta(r), id: undefined }, null, 'create', p, schema)).record;
      if (collection === COLLECTIONS.PROPERTIES) { const pr = await propertyPreWrite({ record: rec, old: null, isNew: true }); if (pr.error) await denied(collection, 'Import', rec, pr.error); rec = pr.record; await unitOnce(rec, batchUnits); }
      checkedRows.push(rec);
    }
    const existing = await storage.list(collection);
    const pre = shortPrefix(collection);
    let n = existing.reduce((m, r) => Math.max(m, Number(String(r.shortId || '').replace(`${pre}-`, '')) || 0), 0);
    const now = new Date().toISOString();
    const stamped = checkedRows.map((r) => ({
      ...r, id: newId(), shortId: `${pre}-${String(++n).padStart(4, '0')}`, recVersion: 1,
      recordCreatedAt: now, recordCreatedBy: actorLabel(p), lastUpdatedAt: now, lastUpdatedBy: actorLabel(p),
    }));
    await storage.putMany(collection, stamped);
    await logChange({ who: actorLabel(p), whoName: p.name, what: label ?? schema?.label ?? collection, collection, recordId: '', recordShortId: '', unit: '', action: 'Create', summary: summary || `Imported ${stamped.length} rows`, changes: [] });
    notify(collection);
    return stamped.length;
  },

  /**
   * Bulk create (a bill run, a fee published to every unit): authorised once, stamped, written in ONE go, one audit line.
   * Returns the stamped rows (with their new ids) so the caller can link other records to them.
   */
  async createMany(collection, rows, { label, summary } = {}) {
    const p = getPrincipal();
    const schema = getSchema(collection);
    if (!rows.length) return [];
    if (NO_BULK.has(collection)) await denied(collection, 'Create', rows[0], 'These records are saved one at a time');
    const existing = await storage.list(collection);
    const taken = new Set(existing.map((r) => r.id));
    const checkedRows = []; let scope = {}; const batchUnits = new Set();
    for (const r of rows) {   // every row is checked, and a "new" row can never overwrite an existing one
      if (r.id && taken.has(r.id)) await denied(collection, 'Create', r, 'A record with this id already exists');
      const c = await checkWrite(collection, stripMeta(r), null, 'create', p, schema); scope = c.scope;
      let rec = c.record;
      if (collection === COLLECTIONS.PROPERTIES) { const pr = await propertyPreWrite({ record: rec, old: null, isNew: true }); if (pr.error) await denied(collection, 'Create', rec, pr.error); rec = pr.record; await unitOnce(rec, batchUnits); }
      if (rec.id) taken.add(rec.id);
      checkedRows.push(rec);
    }
    rows = checkedRows;
    const pre = shortPrefix(collection);
    let n = existing.reduce((m, r) => Math.max(m, Number(String(r.shortId || '').replace(`${pre}-`, '')) || 0), 0);
    const now = new Date().toISOString();
    const stamped = rows.map((r) => ({
      ...r, id: r.id || newId(), shortId: `${pre}-${String(++n).padStart(4, '0')}`, recVersion: 1,
      recordCreatedAt: now, recordCreatedBy: actorLabel(p), lastUpdatedAt: now, lastUpdatedBy: actorLabel(p),
      ...trailFor(null, r, schema, now, actorLabel(p)),
    }));
    await storage.putMany(collection, stamped);
    await logChange({ who: actorLabel(p), whoName: p.name, what: label ?? schema?.label ?? collection, collection, recordId: '', recordShortId: '', unit: '', action: 'Create', summary: summary || `Created ${stamped.length} records`, changes: [] });
    notify(collection);
    return stamped.map((r) => shapeForReader(r, { collection, p, schema, scope }));
  },

  /** Bulk update of existing rows (each keeps its id; fields in the given row replace the old ones). One authorisation check, one write, one audit line. */
  async updateMany(collection, rows, { label, summary } = {}) {
    const p = getPrincipal();
    const schema = getSchema(collection);
    if (!rows.length) return [];
    if (NO_BULK.has(collection)) await denied(collection, 'Update', rows[0], 'These records are saved one at a time');
    const all = await storage.list(collection);
    const byId = new Map(all.map((r) => [r.id, r]));
    const now = new Date().toISOString();
    const out = []; let scope = {};
    for (const r of rows) {
      const old = byId.get(r.id);
      if (!old) continue;
      const c = await checkWrite(collection, { ...old, ...stripMeta(r), id: old.id }, old, 'update', p, schema); scope = c.scope;
      let merged = c.record;
      if (collection === COLLECTIONS.PROPERTIES) { const pr = await propertyPreWrite({ record: merged, old, isNew: false }); if (pr.error) await denied(collection, 'Update', merged, pr.error); merged = pr.record; }
      META_KEYS.forEach((k) => { if (k in old) merged[k] = old[k]; else delete merged[k]; });   // the server keeps the metadata
      out.push({ ...merged, recVersion: (old.recVersion || 1) + 1, lastUpdatedAt: now, lastUpdatedBy: actorLabel(p), ...trailFor(old, merged, schema, now, actorLabel(p)) });
    }
    await storage.putMany(collection, out);
    await logChange({ who: actorLabel(p), whoName: p.name, what: label ?? schema?.label ?? collection, collection, recordId: '', recordShortId: '', unit: '', action: 'Update', summary: summary || `Updated ${out.length} records`, changes: [] });
    notify(collection);
    return out.map((r) => shapeForReader(r, { collection, p, schema, scope }));
  },

  async remove(collection, id, { summaryOf, label } = {}) {
    const p = getPrincipal();
    const schema = getSchema(collection);
    const old = await storage.get(collection, id);
    if (collection === COLLECTIONS.AUDIT) await denied(collection, 'Delete', old ?? { id }, 'The audit trail can never be edited or deleted');
    if (EV_IMMUTABLE.has(collection) || (collection === COLLECTIONS.BALLOTS && old && old.status !== 'Draft')) await denied(collection, 'Delete', old ?? { id }, 'Voting records can never be changed or deleted');
    if (!old && !isAdmin(p)) await denied(collection, 'Delete', { id }, 'Not found');
    await checkWrite(collection, old ?? { id }, old, 'delete', p, schema);
    if (collection === COLLECTIONS.AMENITY_TYPES && old) { const why = await amenityInUse(old); if (why) await denied(collection, 'Delete', old, why); }
    await storage.remove(collection, id);
    if (collection === COLLECTIONS.EQUIPMENT && old) await recordMapVersion({ collection, old, who: actorLabel(p), action: 'delete' });
    if (collection !== COLLECTIONS.AUDIT && !NO_AUDIT.has(collection)) {
      await logChange({
        who: actorLabel(p), whoName: p.name, what: label ?? schema?.label ?? collection, collection, recordId: id, recordShortId: old?.shortId ?? '', unit: unitOf(old),
        action: 'Delete', summary: old && summaryOf ? summaryOf(old) : (old?.shortId ?? ''), changes: old ? snapshotRecord(old, schema, 'delete') : [],
      });
    }
    notify(collection);
  },
};

/** Why an amenity cannot be deleted (the same words as the server), or ''. One with bookings, past ones too, is closed instead. */
export async function amenityInUse(a) {
  const booked = (await storage.list(COLLECTIONS.AMENITIES)).filter((b) => b.amenity === a.name).length;
  if (booked) return `${a.name} has ${booked} booking${booked === 1 ? '' : 's'} (past ones count too), so it is kept for their history. Switch off "Open for booking" to stop new bookings.`;
  const items = (await storage.list(COLLECTIONS.AMENITY_ITEMS)).filter((i) => i.amenity === a.name).length;
  if (items) return `${items} add-on item${items === 1 ? ' is' : 's are'} offered only with ${a.name}. Offer them with every amenity, or delete them, first.`;
  return '';
}

// In the browser demo the rules run here. When the back end enforces sign-in, the same calls go to the server, which runs the same rules.
const METHODS = ['list', 'query', 'get', 'put', 'importMany', 'createMany', 'updateMany', 'remove'];
// Writes are followed for the person (lib/net/activity.js): the button that started one is busy until it settles. Reads are not.
const WRITES = new Set(['put', 'importMany', 'createMany', 'updateMany', 'remove']);
export const secureStorage = Object.fromEntries(METHODS.map((m) => [m, (...a) => {
  const run = () => (isApiMode() && serverDecides() ? remoteSecure[m](...a) : localSecure[m](...a));
  return WRITES.has(m) ? track(run(), { write: true }) : run();
}]));
