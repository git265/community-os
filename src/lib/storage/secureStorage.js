// secureStorage = storage + authorization + record metadata + audit.
// EVERY module reads/writes through this (via useCollection), never through
// the raw adapter. It plays the role of the Spring Boot controller/service
// layer: authenticate -> authorize -> stamp -> persist -> audit.
import { storage, isApiMode, serverReads } from './index.js';
import { remoteSecure } from './remoteSecure.js';
import { serverDecides } from '../auth/session.js';
import { ConflictError } from '../security/errors.js';
import { COLLECTIONS } from './StorageAdapter.js';
import { runQuery } from './queryEngine.js';
import { getPrincipal, getSchema } from '../security/principal.js';
import { lockError, setLock } from '../finance/lock.js';
import { authorizeWrite, setSecondStepRoles, setFinalCanDecideEC, canReadCollection, maskRecord, hiddenFieldKeys, rowScope, blockWriteOk, AuthzError, META_KEYS } from '../security/authz.js';
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
  noticeTemplates: 'NTP', mergeFields: 'MRG', forum: 'TPC', forumPosts: 'PST', wishes: 'WSH', infraPlans: 'PLN', infraLayers: 'LYR', infraLog: 'ILG', eventWork: 'EWK', reportSchedules: 'RPS', reportRuns: 'RPR', meetings: 'MTG', documents: 'DOC',
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

const notify = (collection) => window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection } }));
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

// ---- SERVER fast path: the database applies the row scope, the filters, the sort and the page ---------------------------------------------
// Only when the scope is exactly expressible as data (scope.sql, or no row rule at all) and nothing in the request could reveal a field the caller may
// not see (a filter / sort / search on a hidden field would leak its value one yes-or-no at a time). Anything else takes the in-memory path above,
// which is always correct. The API tests compare both paths for every role.
const queryKeys = (params = {}) => [...Object.keys(params.filters || {}), params.sort?.key, params.dateRange?.key, params.period?.key, ...(params.searchKeys || [])].filter(Boolean);
async function fastScope(collection, params = null) {
  if (!serverReads.available() || collection === COLLECTIONS.BALLOT_BOX) return null;
  const p = getPrincipal();
  if (!p || !canReadCollection(collection, p)) return null;
  const scope = await rowScope(collection, p, readRaw);
  if (scope.predicate && !scope.sql) return null;                                  // not expressible: use memory
  if (params) {
    const hidden = hiddenFieldKeys(getSchema(collection), p.roleId, p);
    if (queryKeys(params).some((k) => hidden.includes(k))) return null;
    if (params.search && !(params.searchKeys || []).length && hidden.length) return null;
    if (scope.transform && (queryKeys(params).length || params.search)) return null;   // a row transform may change the very values being filtered
  }
  return { p, scope };
}
const shape = (rows, scope, schema, p) => rows.map((r) => maskRecord(scope.transform ? scope.transform(r) : r, schema, p.roleId, p));

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

const localSecure = {
  async list(collection) {
    const f = await fastScope(collection);
    if (f) return shape(await serverReads.selectScoped(collection, f.scope.sql || null), f.scope, getSchema(collection), f.p);
    return scoped(collection);
  },

  /** Server-side style paging: scope -> mask -> filter/sort/page. */
  async query(collection, params = {}) {
    const f = await fastScope(collection, params);
    if (f) { const r = await serverReads.queryScoped(collection, params, f.scope.sql || null); return { ...r, rows: shape(r.rows, f.scope, getSchema(collection), f.p) }; }
    return runQuery(await scoped(collection), params);
  },

  async get(collection, id) {
    const f = await fastScope(collection);
    let row;
    if (f) { const r = await serverReads.getScoped(collection, id, f.scope.sql || null); row = r ? shape([r], f.scope, getSchema(collection), f.p)[0] : null; }
    else row = (await scoped(collection)).find((r) => r.id === id) ?? null;
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
    const verdict = authorizeWrite({ collection, p, schema, old, next: record, op: isNew ? 'create' : 'update' });
    if (!verdict.ok) await denied(collection, isNew ? 'Create' : 'Update', record, verdict.reason);
    if (!(await blockWriteOk(collection, record, old, p, readRaw))) await denied(collection, isNew ? 'Create' : 'Update', record, 'This unit is outside the blocks you manage');
    { const le = lockError(collection, record, old); if (le) await denied(collection, isNew ? 'Create' : 'Update', record, le); }
    // Money rules (releases / payments / invoices / task approvals) apply to everyone, the Super Admin included.
    { const me = await moneyPreWrite({ collection, record, old, op: isNew ? 'create' : 'update', list: (c) => storage.list(c) }); if (me) await denied(collection, isNew ? 'Create' : 'Update', record, me); }
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
        const pool = new Set([...ec.map((r) => r.personName || r.roleTitle), ...coordinators]);
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
    if (!isNew && changes.length === 0) return old; // nothing changed -> no write, no audit noise

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
    if (collection === COLLECTIONS.AMENITIES && amenityAction) {
      try { await amenityPostWrite({ old, next: stamped, action: amenityAction }); } catch (e) { console.warn('amenity post-processing failed', e); }
    }
    // A bill paid (or un-paid): its own transaction in Payments, linked to the bill.
    if (collection === COLLECTIONS.DUES && (isNew || old?.status !== stamped.status || old?.amount !== stamped.amount || old?.paidAt !== stamped.paidAt)) {
      try { await syncDuePayment(stamped, { nextShortId }); } catch (e) { console.warn('ledger sync failed', e); }
    }
    if (collection === COLLECTIONS.FINANCE_SETTINGS) setLock(stamped.lockedUntil);
    notify(collection);
    return saved;
  },

  /** Bulk create (statement import): authorised once, written in one go, one audit line for the whole batch. */
  async importMany(collection, rows, { label, summary } = {}) {
    const p = getPrincipal();
    const schema = getSchema(collection);
    if (!rows.length) return 0;
    const verdict = authorizeWrite({ collection, p, schema, old: null, next: rows[0], op: 'create' });
    if (!verdict.ok) await denied(collection, 'Import', rows[0], verdict.reason);
    const existing = await storage.list(collection);
    const pre = shortPrefix(collection);
    let n = existing.reduce((m, r) => Math.max(m, Number(String(r.shortId || '').replace(`${pre}-`, '')) || 0), 0);
    const now = new Date().toISOString();
    const stamped = rows.map((r) => ({
      ...r, id: newId(), shortId: `${pre}-${String(++n).padStart(4, '0')}`, recVersion: 1,
      recordCreatedAt: now, recordCreatedBy: actorLabel(p), lastUpdatedAt: now, lastUpdatedBy: actorLabel(p),
    }));
    await storage.replaceAll(collection, [...existing, ...stamped]);
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
    const verdict = authorizeWrite({ collection, p, schema, old: null, next: rows[0], op: 'create' });
    if (!verdict.ok) await denied(collection, 'Create', rows[0], verdict.reason);
    for (const r of rows) if (!(await blockWriteOk(collection, r, null, p, readRaw))) await denied(collection, 'Create', r, 'This unit is outside the blocks you manage');
    for (const r of rows) { const le = lockError(collection, r, null); if (le) await denied(collection, 'Create', r, le); }
    const existing = await storage.list(collection);
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
    return stamped;
  },

  /** Bulk update of existing rows (each keeps its id; fields in the given row replace the old ones). One authorisation check, one write, one audit line. */
  async updateMany(collection, rows, { label, summary } = {}) {
    const p = getPrincipal();
    const schema = getSchema(collection);
    if (!rows.length) return [];
    const all = await storage.list(collection);
    const byId = new Map(all.map((r) => [r.id, r]));
    const now = new Date().toISOString();
    const out = [];
    for (const r of rows) {
      const old = byId.get(r.id);
      if (!old) continue;
      const verdict = authorizeWrite({ collection, p, schema, old, next: { ...old, ...r }, op: 'update' });
      if (!verdict.ok) await denied(collection, 'Update', old, verdict.reason);
      if (!(await blockWriteOk(collection, { ...old, ...r }, old, p, readRaw))) await denied(collection, 'Update', old, 'This unit is outside the blocks you manage');
      const merged = { ...old, ...r };
      out.push({ ...merged, recVersion: (old.recVersion || 1) + 1, lastUpdatedAt: now, lastUpdatedBy: actorLabel(p), ...trailFor(old, merged, schema, now, actorLabel(p)) });
    }
    await storage.putMany(collection, out);
    await logChange({ who: actorLabel(p), whoName: p.name, what: label ?? schema?.label ?? collection, collection, recordId: '', recordShortId: '', unit: '', action: 'Update', summary: summary || `Updated ${out.length} records`, changes: [] });
    notify(collection);
    return out;
  },

  async remove(collection, id, { summaryOf, label } = {}) {
    const p = getPrincipal();
    const schema = getSchema(collection);
    const old = await storage.get(collection, id);
    if (collection === COLLECTIONS.AUDIT) await denied(collection, 'Delete', old ?? { id }, 'The audit trail can never be edited or deleted');
    if (EV_IMMUTABLE.has(collection) || (collection === COLLECTIONS.BALLOTS && old && old.status !== 'Draft')) await denied(collection, 'Delete', old ?? { id }, 'Voting records can never be changed or deleted');
    const verdict = authorizeWrite({ collection, p, schema, old, next: old ?? {}, op: 'delete' });
    if (!verdict.ok) await denied(collection, 'Delete', old ?? { id }, verdict.reason);
    if (!(await blockWriteOk(collection, old, old, p, readRaw))) await denied(collection, 'Delete', old ?? { id }, 'This unit is outside the blocks you manage');
    { const le = lockError(collection, old, old); if (le) await denied(collection, 'Delete', old ?? { id }, le); }
    { const me = await moneyPreWrite({ collection, record: old, old, op: 'delete', list: (c) => storage.list(c) }); if (me) await denied(collection, 'Delete', old ?? { id }, me); }
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

// In the browser demo the rules run here. When the back end enforces sign-in, the same calls go to the server, which runs the same rules.
const METHODS = ['list', 'query', 'get', 'put', 'importMany', 'createMany', 'updateMany', 'remove'];
export const secureStorage = Object.fromEntries(METHODS.map((m) => [m, (...a) => (isApiMode() && serverDecides() ? remoteSecure[m](...a) : localSecure[m](...a))]));
