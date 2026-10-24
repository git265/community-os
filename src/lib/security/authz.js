// Authorization for every read and write that goes through secureStorage.
// This is the CLIENT-side enforcement layer - the same rules must be applied
// server-side by Spring Security (@PreAuthorize on each endpoint + a Jackson
// field filter driven by the schema's viewableBy/editableBy) because anything
// running in the browser can be bypassed. See README "Security model".
//
// Three layers, in order:
//   1. Collection access  - may this role touch the collection at all?
//   2. Row scope          - residents only get their own unit's rows
//   3. Field access       - viewableBy masks reads, editableBy gates writes
import { todayLocal } from '../locale.js';
import { isUtility } from '../utilityTypes.js';
import { COLLECTIONS as C } from '../storage/StorageAdapter.js';
import { planState, stepEligible, legacy as planLegacy } from '../approval/engine.js';
import { canEdit, canView } from '../access/permissions.js';
import { ALLOWED_TYPES, MAX_BYTES } from '../files/fileValidation.js';
import { docVisible } from '../docGroups.js';

export const META_KEYS = ['id', 'shortId', 'recVersion', 'recordCreatedAt', 'recordCreatedBy', 'lastUpdatedAt', 'lastUpdatedBy', 'updatedAt', 'timeline', 'dateStamps'];

import { AuthzError } from './errors.js';
export { AuthzError };

const has = (p, perm) => !!p?.role?.permissions?.includes(perm);
const anyPerm = (p, perms = []) => perms.some((x) => has(p, x));
export const isAdmin = (p) => p?.roleId === 'super_admin';
export const isResident = (p) => p?.role?.category === 'Resident';
export const isHandyman = (p) => !!p?.roleId?.startsWith('handyman_');
/** Cultural managers (events, programmes, volunteers) and the accountants who verify the money. */
const canCultural = (p) => anyPerm(p, ['MANAGE_CULTURAL', 'MANAGE_LEDGER']);
const canCulturalEvents = (p) => anyPerm(p, ['MANAGE_CULTURAL']);
const isEC = (p) => p?.role?.category === 'EC';
const isStaff = (p) => p?.role?.category === 'Staff';
/** Gate staff: the security committee / EC and the guards (MANAGE_SECURITY). */
const gateStaff = (p) => !isResident(p) && (isEC(p) || anyPerm(p, ['MANAGE_SECURITY']));
/** Gate staff plus the Facility Manager (who owns crew work orders and approves unlisted workers). */
const gateOrFM = (p) => gateStaff(p) || (!isResident(p) && anyPerm(p, ['MANAGE_FIELD_DUTIES']));
// The two people who coordinate the facilities contract day-to-day: Facility Manager + MEP.
export const isCoordinator = (p) => p?.roleId === 'facility_manager' || p?.roleId === 'handyman_mep';
// Who may see/collect quotations: EC, Facility Manager, MEP.
export const canManageReadings = (p) => p?.role?.category === 'EC' || has(p, 'MANAGE_UTILITY_READINGS') || has(p, 'MANAGE_UTILITY_BILLING');
export const isQuoteRole = (p) => isEC(p) || isCoordinator(p);

// Roles allowed to give the final (second-step) approval on a financial task. This is configurable data
// (Maintenance -> Final approvers); secureStorage refreshes it before every ticket write.
export const DEFAULT_SECOND_STEP = ['treasurer', 'president'];
let secondStepRoles = DEFAULT_SECOND_STEP;
export function setSecondStepRoles(list) { secondStepRoles = Array.isArray(list) && list.length ? list : DEFAULT_SECOND_STEP; }
export const isSecondApprover = (p) => !!p && (isAdmin(p) || secondStepRoles.includes(p.roleId));
let finalCanDecideEC = true;
export function setFinalCanDecideEC(v) { finalCanDecideEC = v !== false; }
const SETTINGS_EDITORS = ['president', 'treasurer'];

// Assets & utilities (DG fuel, electricity bills, villa electricity, equipment): readable by everyone on the management side,
// writable by the EC / coordinators and anyone who records meter readings or manages utility billing.
const canAssetsRead = (p) => !isResident(p);
const canAssetsWrite = (p) => isQuoteRole(p) || anyPerm(p, ['MANAGE_UTILITY_READINGS', 'MANAGE_UTILITY_BILLING']);
// Event work (the to-do list behind a festival or a booking): written by the people who run the facilities (EC, Facility Manager, MEP)
// and by the organisers of cultural events and bookings; every staff role can read it. Reports: set up by the EC, the Facility Manager and notification managers.
const canEventWork = (p) => isQuoteRole(p) || anyPerm(p, ['MANAGE_CULTURAL', 'MANAGE_AMENITIES']);
export const canReports = (p) => isEC(p) || p?.roleId === 'facility_manager' || anyPerm(p, ['MANAGE_NOTIFICATIONS']);
const FINANCE_BILL_PERMS = ['MANAGE_DUES', 'MANAGE_UTILITY_BILLING', 'MANAGE_LEDGER'];
const GATE_VILLA_COLLECTIONS = [C.GATE_PEOPLE, C.GATE_LINKS, C.GATE_PASSES, C.GATE_VISITS, C.GATE_APPROVALS, C.GATE_VEHICLES, C.GATE_VILLA_RULES, C.GATE_PASS_TEMPLATES];
/** Trade workers (plumbing, electrical, security, general): they work their trade's queue. MEP coordinates the contract and sees everything. */
const isTradeWorker = (p) => isHandyman(p) && p.roleId !== 'handyman_mep';
/** "Handyman · Plumbing" -> "Plumbing" (same as tradeFromRoleName in modules/tickets/ticketEngine.js). */
const tradeOf = (p) => { const parts = String(p?.role?.name || '').split('·'); return parts.length > 1 ? parts[1].trim() : null; };
/** The tickets a trade worker deals with: their trade's queue (never the EC / FM internal tasks), and anything assigned to them or their crew. */
async function tradeTicketIds(p, readRaw) {
  const trade = tradeOf(p);
  const internal = new Set((await readRaw(C.TASK_TYPES)).filter((t) => t.creatorScope === 'EC / Staff').map((t) => t.name));
  const crew = new Set([p.name, ...(await readRaw(C.HANDYMEN)).filter((h) => !!trade && h.trade === trade).map((h) => h.name)].filter(Boolean));
  return new Set((await readRaw(C.TICKETS)).filter((t) => (!!t.assignedTo && crew.has(t.assignedTo)) || (!!trade && t.category === trade && !internal.has(t.taskType))).map((t) => t.id));
}
/** In-app notifications (the bell): a row is for this person by name, by villa (residents) or by role. Also used by lib/notifications.js. */
export const IN_APP_NOTIFICATIONS = 'notifications';
export function notificationForMe(n, p) {
  if (!p || !n) return false;
  if (n.toName && n.toName === p.name) return true;
  if (n.toUnit) return p.role?.category === 'Resident' && n.toUnit === p.unit;
  return Array.isArray(n.toRoleIds) && n.toRoleIds.includes(p.roleId);
}
const ASSET_COLLECTIONS = [C.LOG_ENTRIES, C.PLANT_LOGS, C.DG_FUEL_LOGS, C.ELECTRICITY_BILLS, C.ASSOC_BILLS, C.VILLA_ELECTRICITY, C.EQUIPMENT, C.INFRA_PLANS, C.INFRA_LAYERS, C.INFRA_LOG, C.MAP_VERSIONS];

/* ---------------------------------------------------------------- reads -- */

// Collections residents/field staff must not read at all.
const READ_RULES = {
  // Payments Cross-check: EC, the Treasurer's accounting roles and the Facility Manager (who needs to see what has been paid to vendors).
  [C.LEDGER]: (p) => isEC(p) || p?.roleId === 'facility_manager' || anyPerm(p, ['MANAGE_LEDGER', 'MANAGE_DUES', 'MANAGE_UTILITY_BILLING']),
  [C.FUNDS]: (p) => isEC(p) || anyPerm(p, ['MANAGE_LEDGER', 'MANAGE_DUES', 'MANAGE_UTILITY_BILLING']),
  // Bank accounts, statements, budget and fixed expenses: EC and the accounting roles only.
  [C.BANK_ACCOUNTS]: (p) => isEC(p) || anyPerm(p, ['MANAGE_LEDGER']),
  [C.BANK_TXNS]: (p) => isEC(p) || anyPerm(p, ['MANAGE_LEDGER']),
  [C.DEPOSITS]: (p) => isEC(p) || anyPerm(p, ['MANAGE_LEDGER']),
  [C.BUDGET_LINES]: (p) => isEC(p) || anyPerm(p, ['MANAGE_LEDGER']),
  [C.FIXED_EXPENSES]: (p) => isEC(p) || anyPerm(p, ['MANAGE_LEDGER']),
  ...Object.fromEntries(ASSET_COLLECTIONS.map((c) => [c, canAssetsRead])),
  [C.VILLA_IMPORT_RULES]: canAssetsRead,
  // a unit's history of who lived there: its managers and the committee (residents see who lives with them now, not who did before)
  [C.UNIT_CHANGES]: (p) => !isResident(p) && (isEC(p) || anyPerm(p, ['MANAGE_UNITS'])),
  [C.EVENT_WORK]: (p) => !isResident(p),
  // planned works: the staff and the committee (residents and vendors do not see the plant rounds)
  [C.CHECKLISTS]: (p) => !isResident(p) && p?.role?.category !== 'Vendor',
  [C.CHECKLIST_ROUNDS]: (p) => !isResident(p) && p?.role?.category !== 'Vendor',
  [C.REPORT_SCHEDULES]: canReports,
  [C.REPORT_RUNS]: canReports,
  [C.LEDGER_SKIPS]: (p) => isEC(p) || p?.roleId === 'facility_manager' || anyPerm(p, ['MANAGE_LEDGER']),
  [C.TAX_SETTINGS]: (p) => isEC(p) || anyPerm(p, ['MANAGE_LEDGER']),
  [C.TAX_COMPONENTS]: (p) => isEC(p) || anyPerm(p, ['MANAGE_LEDGER']),
  [C.PAYMENT_ROUTING]: (p) => isEC(p) || p?.roleId === 'facility_manager' || anyPerm(p, ['MANAGE_LEDGER']),
  [C.IMPORT_PROFILES]: (p) => isEC(p) || anyPerm(p, ['MANAGE_LEDGER']),
  [C.FINANCE_SETTINGS]: (p) => isEC(p) || anyPerm(p, ['MANAGE_LEDGER']),
  [C.APPROVAL_POLICIES]: (p) => !isResident(p),
  [C.RELEASES]: (p) => isEC(p) || isQuoteRole(p) || anyPerm(p, ['MANAGE_LEDGER', 'MANAGE_CULTURAL']),
  ...Object.fromEntries([C.LEVIES, C.DEMAND_NOTICES, C.PAY_REQUESTS, C.RECURRING_BILLS, C.CASH_COUNTS].map((c) => [c, (p) => isEC(p) || anyPerm(p, ['MANAGE_LEDGER', 'MANAGE_DUES'])])),
  [C.CULTURAL_EXPENSES]: (p) => !isResident(p) && canCultural(p),
  [C.ATTENDANCE]: (p) => !isResident(p),
  [C.ATTENDANCE_SETTINGS]: (p) => !isResident(p),
  [C.WORKFORCE]: (p) => !isResident(p),
  [C.SHIFTS]: (p) => !isResident(p),
  // Amenity money & messaging: settings rows are readable by everyone (rates/GST are shown to residents; recipients are stripped for them in rowScope);
  // templates, the outbox and credit ledgers are management-side only (a resident sees just their own villa's credit rows via rowScope).
  [C.NOTIFICATION_TEMPLATES]: (p) => !isResident(p),
  [C.PORTAL_INVITES]: (p) => isEC(p) || anyPerm(p, ['MANAGE_USERS']),
  [C.NOTIFICATION_OUTBOX]: (p) => isEC(p) || anyPerm(p, ['MANAGE_AMENITIES', 'MANAGE_NOTIFICATIONS']),
  [C.GATE_FLAGS]: (p) => !isResident(p),
  [C.GATE_CHECKPOINTS]: (p) => !isResident(p),
  [C.GATE_ROUNDS]: (p) => !isResident(p),
  [C.GATE_SCANS]: (p) => !isResident(p),
  [C.GATE_WORKORDERS]: (p) => !isResident(p),
  [C.INCIDENTS]: (p) => isEC(p) || has(p, 'MANAGE_SECURITY') || has(p, 'MANAGE_FIELD_DUTIES'),
  [C.BILLING_TEMPLATES]: (p) => !isResident(p),
  [C.UTILITY_TYPES]: (p) => !isResident(p),
  [C.LOG_TYPES]: (p) => !isResident(p),
  // names + roles are a staff directory (needed to pick who a task is assigned to); phone/email stay admin-only by field.
  // residents may look up the committee members' names (see rowScope), nothing else
  [C.CATEGORY_MAP]: (p) => !isResident(p),
  [C.QUOTATIONS]: (p) => isQuoteRole(p),
  [C.APPROVER_SETTINGS]: (p) => !isResident(p),
  [C.VENDORS]: (p) => !isResident(p),
  [C.VENDOR_COMMENTS]: (p) => isQuoteRole(p) || has(p, 'MANAGE_VENDORS'),
  [C.INVENTORY]: (p) => !isResident(p),
  [C.INVENTORY_RULES]: (p) => !isResident(p),
  [C.READINGS]: (p) => canManageReadings(p),
  // r77 - data that belongs to a villa or a person reaches only the people who deal with it.
  // Bills: the owner (own unit, rowScope), the EC and the finance roles; meter-reading roles see only the utility bills they publish (rowScope).
  [C.DUES]: (p) => isResident(p) || isEC(p) || anyPerm(p, FINANCE_BILL_PERMS) || canManageReadings(p),
  // Refund credits per villa: the owner, the EC, amenity and finance managers.
  [C.UNIT_CREDITS]: (p) => isResident(p) || isEC(p) || anyPerm(p, ['MANAGE_AMENITIES', ...FINANCE_BILL_PERMS]),
  // Who gave how much: the donor's villa, the EC and the cultural / accounting roles.
  [C.CULTURAL_DONATIONS]: (p) => isResident(p) || isEC(p) || canCultural(p),
  // A villa's visitors, passes, household staff, vehicles and gate rules: that villa, and the security team / Facility Manager.
  ...Object.fromEntries(GATE_VILLA_COLLECTIONS.map((c) => [c, (p) => isResident(p) || gateOrFM(p)])),
  [C.GATE_FLAGS]: gateOrFM,
  [C.GATE_WORKORDERS]: gateOrFM,
};

export function canReadCollection(collection, p) {
  if (!p) return false;
  if (isAdmin(p)) return true;
  const rule = READ_RULES[collection];
  return rule ? rule(p) : true;
}

const DIRECTORY_FIELDS = ['id', 'unit', 'type', 'zone', 'owner', 'ownerPhone', 'occupancy'];

/** Does an announcement address this (resident) principal? */
export function broadcastReaches(b, p) {
  const owner = p.roleId === 'owner';
  switch (b.audience) {
    case 'All residents': return true;
    case 'Owners': return owner;
    // villa / apartment / block audiences are expanded to the exact units when the message is sent (audienceUnits); the unit-name guess is only for older messages
    case 'All villas': return (b.audienceUnits || []).length ? b.audienceUnits.includes(p.unit) : /villa/i.test(p.unit || '');
    case 'All apartments': case 'Apartment blocks': return (b.audienceUnits || []).length ? b.audienceUnits.includes(p.unit) : !!p.unit && !/villa/i.test(p.unit);
    case 'Selected villas': case 'Selected apartments': case 'Selected blocks': return (b.audienceUnits || []).includes(p.unit);
    default: return false; // EC members, Staff
  }
}

/** Row-level scope. Returns a predicate (rows the principal may see) and, optionally, a row transform. */
/** A folder can be limited to chosen roles (accessRoles); the limit applies to everything inside it, sub-folders included. Empty = no extra limit. */
export function folderAllowed(folderId, folders, p) {
  let cur = folders.find((f) => f.id === folderId); let n = 0;
  while (cur && n++ < 30) {
    const roles = Array.isArray(cur.accessRoles) ? cur.accessRoles : [];
    if (roles.length && !roles.includes(p.roleId) && !(roles.includes('group:EC') && p.role?.category === 'EC')) return false;
    cur = folders.find((f) => f.id === cur.parentId);
  }
  return true;
}

/**
 * Row scope as DATA. Every scope the database can apply exactly is also described as a small tree (`scope.sql`), so the server can put it in the
 * WHERE clause instead of loading the collection and filtering in memory. The tree must mean EXACTLY what `predicate` means (the API tests compare
 * both for every role); a scope that cannot be expressed this way simply has no `sql` and is applied in memory as before.
 * Nodes: eq / ne / in / empty / notEmpty / and / or / true / false. (Its consumer, the retired Node server, is gone: nothing reads `sql` now;
 * backend/api has its own policies. Kept until the browser rule book is trimmed to the Session demo.)
 */
export const S = {
  eq: (key, value) => ({ op: 'eq', key, value }), ne: (key, value) => ({ op: 'ne', key, value }), in: (key, values) => ({ op: 'in', key, values: [...values] }),
  empty: (key) => ({ op: 'empty', key }), notEmpty: (key) => ({ op: 'notEmpty', key }),
  and: (...of) => ({ op: 'and', of }), or: (...of) => ({ op: 'or', of }), TRUE: { op: 'true' }, FALSE: { op: 'false' },
};
const ownUnit = (unit) => (unit ? S.eq('unit', unit) : S.FALSE);   // `!!unit && r.unit === unit`

/** The field keys this person may NOT see in a collection (the same rule maskRecord applies). */
export function hiddenFieldKeys(schema, roleId, p) {
  if (!schema) return [];
  if (p && PERMISSION_GATED[schema.id]?.(p)) return [];
  return schema.fields.filter((f) => !canView(f, roleId)).map((f) => f.key);
}

// BLOCK-LIMITED STAFF: a user whose record lists blocks (users.blocks) sees and changes only the units of those blocks
// (a Block Admin / Block Secretary in a community of several towers). Rows that name no unit stay visible.
const BLOCK_UNIT_COLLECTIONS = [C.DUES, C.TICKETS, C.AMENITIES, C.READINGS, C.VILLA_ELECTRICITY, C.UNIT_CREDITS, C.GATE_VISITS, C.GATE_PASSES, C.GATE_APPROVALS, C.GATE_LINKS, C.GATE_VILLA_RULES, C.CULTURAL_DONATIONS];
export const blocksOf = (p) => (Array.isArray(p?.blocks) ? p.blocks.filter(Boolean) : []);
const blockLimited = (p) => !!p && !isAdmin(p) && !isResident(p) && blocksOf(p).length > 0;
async function unitsInBlocks(p, readRaw) {
  const mine = new Set(blocksOf(p));
  return new Set((await readRaw(C.PROPERTIES)).filter((u) => mine.has(u.zone)).map((u) => u.unit));
}
/** May this person write this record, given the blocks they are limited to? (true for everyone not block-limited) */
export async function blockWriteOk(collection, record, old, p, readRaw) {
  if (!blockLimited(p)) return true;
  if (collection === C.PROPERTIES) { const mine = new Set(blocksOf(p)); return mine.has(record?.zone) && (!old || mine.has(old.zone)); }
  if (!BLOCK_UNIT_COLLECTIONS.includes(collection)) return true;
  const units = await unitsInBlocks(p, readRaw);
  const ok = (r) => !r || !r.unit || units.has(r.unit);
  return ok(record) && ok(old);
}
async function withBlockScope(collection, p, readRaw, base) {
  if (!blockLimited(p)) return base;
  let extra = null; let extraSql = null;
  if (collection === C.PROPERTIES) { const mine = new Set(blocksOf(p)); extra = (r) => mine.has(r.zone); extraSql = S.in('zone', mine); }
  else if (BLOCK_UNIT_COLLECTIONS.includes(collection)) { const units = await unitsInBlocks(p, readRaw); extra = (r) => !r.unit || units.has(r.unit); extraSql = S.or(S.empty('unit'), S.in('unit', units)); }
  if (!extra) return base;
  const bp = base.predicate;
  const { sql: _drop, ...rest } = base;
  const sql = !bp ? extraSql : base.sql ? S.and(base.sql, extraSql) : undefined;      // exact only when both halves are
  return { ...rest, predicate: (r) => extra(r) && (!bp || bp(r)), ...(sql ? { sql } : {}) };
}

export async function rowScope(collection, p, readRaw) {
  const base = await withBlockScope(collection, p, readRaw, await baseRowScope(collection, p, readRaw));
  if (isAdmin(p) || (collection !== C.DOCUMENTS && collection !== C.DOC_FOLDERS)) return base;
  const folders = await readRaw(C.DOC_FOLDERS);
  const bp = base.predicate;
  const { sql: _s, ...plain } = base;   // a folder rule is walked in memory: no database form
  if (collection === C.DOC_FOLDERS) return { ...plain, predicate: (r) => folderAllowed(r.id, folders, p) && (!bp || bp(r)) };
  return { ...plain, predicate: (r) => (!r.folderId || folderAllowed(r.folderId, folders, p)) && (!bp || bp(r)) };
}

async function baseRowScope(collection, p, readRaw) {
  if (isAdmin(p)) return {};
  const unit = p.unit;
  if (collection === C.FILES) return filesScope(p, readRaw);
  if (collection === C.USER_PROFILES) return has(p, 'MANAGE_USERS') ? {} : { predicate: (r) => String(r.userName || '').trim().toLowerCase() === String(p.name || '').trim().toLowerCase() };
  // the bell and the message-channel choices are personal
  if (collection === IN_APP_NOTIFICATIONS) return { predicate: (r) => notificationForMe(r, p) };
  if (collection === C.NOTIFICATION_PREFS) return anyPerm(p, ['MANAGE_NOTIFICATIONS', 'MANAGE_USERS']) ? {} : { predicate: (r) => !!p.name && r.userName === p.name };
  if (isResident(p)) {
    switch (collection) {
      case C.CULTURAL_EVENTS: return { predicate: (r) => r.visibility === 'Published' };
      case C.AUDITS: return { predicate: (r) => r.visibility === 'Published' };
      case C.SERVICE_CONTACTS: return { predicate: (r) => r.status !== 'Hidden' };
      case C.CULTURAL_BROCHURE: {
        const pub = new Set((await readRaw(C.CULTURAL_EVENTS)).filter((e) => e.visibility === 'Published' && e.brochureStatus === 'Published' && e.showBrochure !== 'No').map((e) => e.id));
        return { predicate: (r) => pub.has(r.eventId) };
      }
      case C.CULTURAL_PROGRAMS: case C.CULTURAL_SEVAS: case C.CULTURAL_OFFERINGS: {
        // the programme / agenda has its own publish switch; the rest follows the event
        const pub = new Set((await readRaw(C.CULTURAL_EVENTS)).filter((e) => e.visibility === 'Published').map((e) => e.id));
        return { predicate: (r) => pub.has(r.eventId) };
      }
      case C.CULTURAL_DONATIONS: return { predicate: (r) => !!unit && r.unit === unit, sql: ownUnit(unit) };
      // GateGuard: a villa sees only its own gate records, plus vetted (Active) people it may link to its household
      case C.GATE_PEOPLE: return { predicate: (r) => r.status === 'Active' || (!!unit && r.invitedByUnit === unit) };
      case C.GATE_PASS_TEMPLATES: return { predicate: (r) => !r.unit || (!!unit && r.unit === unit) };
      case C.GATE_LINKS: case C.GATE_PASSES: case C.GATE_VISITS: case C.GATE_APPROVALS: case C.GATE_VEHICLES: case C.GATE_VILLA_RULES: return { predicate: (r) => !!unit && r.unit === unit, sql: ownUnit(unit) };
      case C.TICKETS: {
        // own unit AND only task types flagged resident-visible (EC/FM tasks, quotes, invoices never reach residents)
        const visible = new Set((await readRaw(C.TASK_TYPES)).filter((t) => t.residentVisible).map((t) => t.name));
        return { predicate: (r) => (r.unit === unit || r.scope === 'Community') && visible.has(r.taskType), sql: S.and(S.or(S.eq('unit', unit || ''), S.eq('scope', 'Community')), S.in('taskType', visible)) };
      }
      case C.MEETINGS:
        // residents only see meetings the committee has published (older meetings without the setting count as published)
        return { predicate: (r) => r.visibility !== 'Internal (committee only)' };
      case C.DUES:
        return { predicate: (r) => r.unit === unit, sql: S.eq('unit', unit || '') };
      case C.TICKET_COMMENTS: {
        const mine = new Set((await readRaw(C.TICKETS)).filter((t) => t.unit === unit).map((t) => t.id));
        return { predicate: (r) => mine.has(r.ticketId) && r.visibility !== 'Internal' };
      }
      case C.DOCUMENTS:
        return { predicate: (r) => docVisible(r, p) };
      case C.USERS: {
        const ecRoles = new Set((await readRaw(C.ROLES)).filter((r) => r.category === 'EC' && r.id !== 'super_admin').map((r) => r.id));
        return { predicate: (r) => r.status !== 'Inactive' && [r.roleId, ...(r.extraRoleIds || [])].some((x) => ecRoles.has(x)) };
      }
      case C.BROADCASTS:
        // residents only get announcements addressed to them
        return { predicate: (r) => r.status === 'Sent' && broadcastReaches(r, p) };
      case C.VOTE_ROLL:
        // everyone can see WHICH units voted (the roll), but not the voter's name
        return { transform: (r) => ({ ...r, owner: '' }) };
      case C.POLL_VOTES:
        return { transform: (r) => (r.unit === unit ? r : { ...r, voter: '', unit: '—' }) };
      case C.AMENITIES:
        // availability must stay visible (calendar), the booker's identity - and money - must not.
        return { transform: (r) => (r.unit === unit ? r : { id: r.id, amenity: r.amenity, date: r.date, slot: r.slot, status: r.status, unit: '—', shortId: r.shortId }) };
      case C.UNIT_CREDITS:
        return { predicate: (r) => r.unit === unit, sql: S.eq('unit', unit || '') };
      case C.AMENITY_SETTINGS:
        return { transform: (r) => { const { adminRecipients, reportRecipients, ...rest } = r; return rest; } };
      case C.PROPERTIES:
        return {
          transform: (r) => {
            if (r.unit === unit) return r;
            const out = {};
            DIRECTORY_FIELDS.forEach((k) => { if (k in r) out[k] = r[k]; });
            return { ...out, ...pickMeta(r) };
          },
        };
      case C.AUDIT:
        return { predicate: (r) => !!unit && r.unit === unit, sql: ownUnit(unit) };
      default:
        return {};
    }
  }
  if (collection === C.ATTENDANCE && !has(p, 'MANAGE_FIELD_DUTIES') && !isEC(p)) return { predicate: (r) => r.staffName === p.name }; // staff see only their own punches
  // trade workers: their trade's queue and what is assigned to them (and the discussion on those tickets)
  if (isTradeWorker(p) && (collection === C.TICKETS || collection === C.TICKET_COMMENTS)) {
    const mine = await tradeTicketIds(p, readRaw);
    return collection === C.TICKETS ? { predicate: (r) => mine.has(r.id) } : { predicate: (r) => mine.has(r.ticketId) };
  }
  // a meter-reading role without finance access sees only the utility bills (water / DG ...), never maintenance or other dues
  if (collection === C.DUES && !isEC(p) && !anyPerm(p, FINANCE_BILL_PERMS)) return { predicate: (r) => isUtility(r.category) };
  // staff who do not run amenities see when a facility is taken and by which unit, not the money
  if (collection === C.AMENITIES && !isEC(p) && !anyPerm(p, ['MANAGE_AMENITIES', 'MANAGE_LEDGER'])) {
    return { transform: (r) => { const out = {}; ['id', 'amenity', 'date', 'slot', 'status', 'unit', 'shortId'].forEach((k) => { if (k in r) out[k] = r[k]; }); return out; } };
  }
  if (collection === C.DOCUMENTS) return { predicate: (r) => docVisible(r, p) };
  if (collection === C.AUDIT && !has(p, 'VIEW_AUDIT_LOG')) {
    return { predicate: (r) => !!r.unit, sql: S.notEmpty('unit') }; // unit activity only, never the full log
  }
  return {};
}

/** Uploaded files inherit the visibility of what they are attached to. */
async function filesScope(p, readRaw) {
  const resident = isResident(p);
  const ownTickets = resident ? new Set((await readRaw(C.TICKETS)).filter((t) => t.unit === p.unit || t.scope === 'Community').map((t) => t.id)) : null;
  const ownBookings = resident ? new Set((await readRaw(C.AMENITIES)).filter((b) => b.unit === p.unit).map((b) => b.id)) : null;
  const pubAudits = resident ? new Set((await readRaw(C.AUDITS)).filter((a) => a.visibility === 'Published').map((a) => a.id)) : null;
  const allDocs = await readRaw(C.DOCUMENTS);
  const folders = await readRaw(C.DOC_FOLDERS);
  const docOk = (r) => docVisible(r, p) && (!r.folderId || folderAllowed(r.folderId, folders, p));
  const docIds = resident ? new Set(allDocs.filter((r) => docOk(r)).map((d) => d.fileId)) : null;
  const pubBrochure = resident ? new Set((await readRaw(C.CULTURAL_EVENTS)).filter((e) => e.visibility === 'Published' && e.brochureStatus === 'Published' && e.showBrochure !== 'No').map((e) => e.id)) : null;
  const hiddenDocFiles = new Set(allDocs.filter((r) => !docOk(r)).map((d) => d.fileId)); // files of documents this person's group may not open
  // meter photos: staff who manage readings, and the owner of the villa once the bill is published to them
  const ownReadings = resident ? new Set((await readRaw(C.DUES)).filter((d) => d.unit === p.unit && d.readingId).map((d) => d.readingId)) : null;
  const tradeTickets = isTradeWorker(p) ? await tradeTicketIds(p, readRaw) : null; // a trade worker: photos of their own tickets only
  return {
    predicate: (r) => {
      switch (r.ownerType) {
        case 'ticket': return resident ? ownTickets.has(r.ownerId) : tradeTickets ? tradeTickets.has(r.ownerId) : true;
        case 'amenityDeposit': return resident ? ownBookings.has(r.ownerId) : true; // deposit-inspection photos: amenity staff, and the villa that booked
        case 'ticketInternal': return !resident && (!tradeTickets || tradeTickets.has(r.ownerId)); // files attached to Internal chat notes
        case 'quotation': return isQuoteRole(p);
        case 'audit': return resident ? pubAudits.has(r.ownerId) : true; // audit reports: management, and residents once the audit is published
        case 'ledger': return canReadCollection(C.LEDGER, p);
        case 'culturalExpense': return canReadCollection(C.CULTURAL_EXPENSES, p);
        case 'vendor': return canReadCollection(C.VENDOR_COMMENTS, p);
        case 'inventory': return canReadCollection(C.INVENTORY, p);
        case 'reading': return resident ? ownReadings.has(r.ownerId) : canManageReadings(p);
        case 'meeting': return true;
        case 'culturalBrochure': return resident ? pubBrochure.has(r.ownerId) : true; // pictures of a published brochure
        default: return resident ? docIds.has(r.id) : !hiddenDocFiles.has(r.id);
      }
    },
  };
}

function pickMeta(r) {
  const m = {};
  META_KEYS.forEach((k) => { if (k in r) m[k] = r[k]; });
  return m;
}

/** Drop every field the role may not view (schema viewableBy). Meta + unknown keys pass. */
// Collections whose access is granted by a permission (so any role can be given it in Roles & Permissions),
// not by listing role ids in the schema. Holders see every field of these.
const PERMISSION_GATED = { [C.EVENT_WORK]: (p) => !isResident(p), [C.CHECKLISTS]: (p) => !isResident(p), [C.CHECKLIST_ROUNDS]: (p) => !isResident(p), [C.ATTENDANCE]: (p) => !isResident(p), [C.SHIFTS]: (p) => !isResident(p), [C.REPORT_SCHEDULES]: canReports, [C.REPORT_RUNS]: canReports, ...Object.fromEntries(ASSET_COLLECTIONS.map((c) => [c, canAssetsRead])), [C.VILLA_IMPORT_RULES]: canAssetsRead, [C.READINGS]: canManageReadings, [C.INVENTORY]: (p) => !isResident(p), [C.INVENTORY_RULES]: (p) => !isResident(p), [C.VENDOR_COMMENTS]: (p) => isQuoteRole(p) || has(p, 'MANAGE_VENDORS') };

export function maskRecord(record, schema, roleId, p) {
  if (!schema || !record) return record;
  if (p && PERMISSION_GATED[schema.id]?.(p)) return record;
  const hidden = schema.fields.filter((f) => !canView(f, roleId)).map((f) => f.key);
  if (hidden.length === 0) return record;
  const out = { ...record };
  hidden.forEach((k) => delete out[k]);
  // the record's own time trail must not repeat a hidden field (an approval's history, when a hidden date was set)
  if (Array.isArray(out.timeline)) out.timeline = out.timeline.filter((e) => !hidden.includes(e?.field));
  if (out.dateStamps && typeof out.dateStamps === 'object' && !Array.isArray(out.dateStamps)) out.dateStamps = Object.fromEntries(Object.entries(out.dateStamps).filter(([k]) => !hidden.includes(k)));
  return out;
}

/* ------------------------------------------------- what a write may carry -- */
// r77: the server decides what a saved record contains, whatever the request says. Runs before authorizeWrite, for every write
// (single and bulk), with the caller's row scope (rowScope). The Super Admin is not limited here.

/** Who wrote it: set by the server on create, never changed afterwards (except by the Super Admin). */
const IDENTITY = {
  [C.TICKETS]: { createdBy: 'name', createdByRole: 'roleId' },
  [C.TICKET_COMMENTS]: { author: 'name', authorRoleId: 'roleId' },
  [C.FORUM_POSTS]: { author: 'name', authorRoleId: 'roleId' },
  [C.CONTACT_REVIEWS]: { author: 'name' },
  [C.SERVICE_CONTACTS]: { addedBy: 'name' },
  [C.CULTURAL_PHOTOS]: { uploadedBy: 'name' },
  [C.POLL_VOTES]: { voter: 'name' },
  [C.USER_PROFILES]: { userName: 'name' },
  [C.NOTIFICATION_PREFS]: { userName: 'name' },
  [C.WISHES]: { raisedBy: 'name', raisedByRole: 'roleId' },
  [IN_APP_NOTIFICATIONS]: { by: 'name' },
};
/** For a resident, the villa a record is for is always their own. */
const RESIDENT_UNIT = { [C.POLL_VOTES]: 'unit', [C.CONTACT_REVIEWS]: 'unit', [C.SERVICE_CONTACTS]: 'addedByUnit', [C.WISHES]: 'unit' };
/** A new record of these may be out of the creator's own view at first (a photo before its ticket is saved, a message to someone else,
 *  a document for another group): their create rules live elsewhere. Every other create must be a record the creator may see. */
const CREATE_OUT_OF_SCOPE_OK = new Set([C.FILES, IN_APP_NOTIFICATIONS, C.DOCUMENTS, C.DOC_FOLDERS, C.TICKET_COMMENTS]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Normalise a write to what this person may actually do, or refuse it.
 *   - update / delete: the stored record must be one they can see (row scope) - you cannot touch what you cannot see;
 *   - update: fields they cannot see (masked or hidden by the row scope) keep their stored value, and a field they may not edit
 *     cannot be removed by leaving it out; they cannot add a field they may not see;
 *   - create: fields they may not see are dropped;
 *   (after authorizeWrite, staysInScope checks the result is still in their scope.)
 *   - identity fields (who raised / wrote / voted) are the caller's on create and frozen afterwards; a resident's villa is their own.
 * Returns { ok:true, record } or { ok:false, reason }.
 */
/** Made by the server on every save: whatever a request says for these is dropped (who/when created and last updated, version, short number, trails). */
export const SERVER_OWNED = { '*': META_KEYS.filter((k) => k !== 'id'), [C.TICKETS]: ['ticketNumber', 'statusHistory'] };
const withoutServerOwned = (collection, r) => { const o = { ...(r || {}) }; [...SERVER_OWNED['*'], ...(SERVER_OWNED[collection] || [])].forEach((k) => delete o[k]); return o; };

export function prepareWrite({ collection, p, schema, old, next, op, scope = {} }) {
  if (!p) return deny('Not signed in');
  if (op === 'delete') return isAdmin(p) || !old || !scope.predicate || scope.predicate(old) ? { ok: true, record: next } : deny('Not found');
  if (isAdmin(p)) return { ok: true, record: withoutServerOwned(collection, next) };
  if (old && scope.predicate && !scope.predicate(old)) return deny('Not found');
  const rec = withoutServerOwned(collection, next);
  const fields = schema?.fields || [];
  const editable = (k) => { const f = fields.find((x) => x.key === k); return !!f && canEdit(f, p.roleId); };
  const masked = new Set(hiddenFieldKeys(schema, p.roleId, p));                 // fields this role is not shown
  const writeOnly = (k) => masked.has(k) && editable(k);                          // e.g. a vote's proof: sent, never shown
  if (old) {
    // what they were shown: row transform, then field masking
    const seen = maskRecord(scope.transform ? scope.transform(old) : old, schema, p.roleId, p);
    const owned = new Set([...SERVER_OWNED['*'], ...(SERVER_OWNED[collection] || [])]);
    for (const k of Object.keys(old)) {
      if (owned.has(k)) continue;                                                        // the server stamps these again
      const shown = k in seen && same(seen[k], old[k]);
      if (!shown) { if (!(writeOnly(k) && k in rec)) rec[k] = old[k]; }          // not shown to them: keeps its stored value
      else if (!(k in rec) && !editable(k)) rec[k] = old[k];                       // cannot remove what you may not edit
    }
    for (const k of Object.keys(rec)) if (!(k in old) && masked.has(k) && !writeOnly(k)) delete rec[k];   // cannot add a field you may not see
  } else {
    for (const k of masked) if (!writeOnly(k)) delete rec[k];
  }
  for (const [k, from] of Object.entries(IDENTITY[collection] || {})) {
    if (!old) rec[k] = p[from] ?? '';
    else if (k in old) rec[k] = old[k]; else delete rec[k];
  }
  const uk = RESIDENT_UNIT[collection];
  if (uk && isResident(p)) { if (!old) rec[uk] = p.unit || ''; else if (uk in old) rec[uk] = old[uk]; }
  return { ok: true, record: rec };
}

/** After authorisation: the saved record must still be one the caller may see (create: except CREATE_OUT_OF_SCOPE_OK). */
export function staysInScope({ collection, p, old, record, op, scope = {} }) {
  if (!p || isAdmin(p) || op === 'delete' || !scope.predicate || scope.predicate(record)) return OK;
  if (!old && CREATE_OUT_OF_SCOPE_OK.has(collection)) return OK;
  return deny(old ? 'You cannot move this record out of your own view' : 'You can only create records you are allowed to see');
}

/** What the caller gets back after a write: the record as they would read it, or only its ids when it is not theirs to read. */
export function shapeForReader(record, { collection, p, schema, scope = {} }) {
  if (!record || !p) return record;
  if (isAdmin(p)) return record;
  const ids = { id: record.id, ...(record.shortId ? { shortId: record.shortId } : {}), ...(record.recVersion != null ? { recVersion: record.recVersion } : {}) };
  if (!canReadCollection(collection, p) || (scope.predicate && !scope.predicate(record))) return ids;
  return maskRecord(scope.transform ? scope.transform(record) : record, schema, p.roleId, p);
}

/* --------------------------------------------------------------- writes -- */

// Collection -> permissions (any-of) / categories that may create + update.
const WRITE_RULES = {
  [C.PROPERTIES]: { perms: ['MANAGE_UNITS'] },
  [C.UNIT_CHANGES]: { perms: ['MANAGE_UNITS'] },
  [C.TASK_TYPES]: { perms: ['MANAGE_TICKET_TYPES'] },
  [C.QUICK_PHRASES]: { perms: ['MANAGE_TICKETS'] },
  [C.TRADE_AVAILABILITY]: { perms: ['MANAGE_TICKETS', 'MANAGE_FIELD_DUTIES'] },
  [C.HANDYMEN]: { perms: ['MANAGE_TICKETS', 'MANAGE_FIELD_DUTIES'], categories: ['Staff'] },
  [C.DUES]: { perms: ['MANAGE_DUES', 'MANAGE_UTILITY_BILLING'] },
  [C.FUNDS]: { perms: ['MANAGE_LEDGER'] },
  [C.LEDGER]: { perms: ['MANAGE_LEDGER'] },
  [C.BANK_ACCOUNTS]: { perms: ['MANAGE_LEDGER'] },
  [C.BANK_TXNS]: { perms: ['MANAGE_LEDGER'] },
  [C.DEPOSITS]: { perms: ['MANAGE_LEDGER'] },
  [C.BUDGET_LINES]: { perms: ['MANAGE_LEDGER'] },
  [C.FIXED_EXPENSES]: { perms: ['MANAGE_LEDGER'] },
  [C.LEDGER_SKIPS]: { perms: ['MANAGE_LEDGER'] },
  [C.TAX_SETTINGS]: { perms: ['MANAGE_LEDGER'] },
  [C.TAX_COMPONENTS]: { perms: ['MANAGE_LEDGER'] },
  [C.PAYMENT_ROUTING]: { perms: ['MANAGE_LEDGER'] },
  [C.IMPORT_PROFILES]: { perms: ['MANAGE_LEDGER'] },
  [C.FINANCE_SETTINGS]: { perms: ['MANAGE_LEDGER'] },
  [C.APPROVAL_POLICIES]: { perms: ['MANAGE_LEDGER'] },
  [C.RELEASES]: { perms: ['MANAGE_LEDGER'] },
  [C.LEVIES]: { perms: ['MANAGE_LEDGER', 'MANAGE_DUES'] },
  [C.DEMAND_NOTICES]: { perms: ['MANAGE_LEDGER', 'MANAGE_DUES'] },
  [C.PAY_REQUESTS]: { perms: ['MANAGE_LEDGER'] },
  [C.RECURRING_BILLS]: { perms: ['MANAGE_LEDGER'] },
  [C.CASH_COUNTS]: { perms: ['MANAGE_LEDGER'] },
  [C.BILLING_TEMPLATES]: { perms: ['MANAGE_UTILITY_BILLING'] },
  [C.UTILITY_TYPES]: { perms: ['MANAGE_UTILITY_TYPES'] },
  [C.LOG_TYPES]: { perms: ['MANAGE_UTILITY_TYPES'] },
  [C.WORKFORCE]: { perms: ['MANAGE_FIELD_DUTIES'] },
  [C.SHIFTS]: { perms: ['MANAGE_FIELD_DUTIES'] },
  [C.CULTURAL_EVENTS]: { perms: ['MANAGE_CULTURAL'] },
  [C.CULTURAL_EXPENSES]: { perms: ['MANAGE_CULTURAL', 'MANAGE_LEDGER'] },
  [C.ATTENDANCE_SETTINGS]: { perms: ['MANAGE_FIELD_DUTIES'] },
  [C.SITE_CALENDAR]: { perms: ['MANAGE_FIELD_DUTIES', 'MANAGE_SECURITY'] },
  [C.SITE_SERVICES]: { perms: ['MANAGE_FIELD_DUTIES', 'MANAGE_SECURITY'] },
  [C.SITE_HOLIDAYS]: { perms: ['MANAGE_FIELD_DUTIES', 'MANAGE_SECURITY'] },
  [C.AMENITY_ITEMS]: { perms: ['MANAGE_AMENITIES', 'MANAGE_AMENITY_RATES'] },
  [C.AMENITY_TYPES]: { perms: ['MANAGE_AMENITIES', 'MANAGE_AMENITY_RATES', 'MANAGE_AMENITY_RULES'] },
  [C.INCIDENTS]: { perms: ['MANAGE_SECURITY'] },
  [C.VENDORS]: { perms: ['MANAGE_VENDORS'] },
  [C.NOTICE_TEMPLATES]: { perms: ['MANAGE_NOTICE_TEMPLATES'] },
  [C.MERGE_FIELDS]: { perms: ['MANAGE_NOTICE_TEMPLATES'] },
  [C.BALLOTS]: { perms: ['MANAGE_GOVERNANCE'] },
  [C.MEETINGS]: { perms: ['MANAGE_GOVERNANCE'] },
  [C.EC_ROLES]: { perms: ['MANAGE_GOVERNANCE'] },
  [C.SUBCOMMITTEES]: { perms: ['MANAGE_GOVERNANCE'] },
  [C.APPROVALS]: { perms: ['MANAGE_GOVERNANCE'] },
  [C.DOCUMENTS]: { perms: ['MANAGE_DOCUMENTS'] },
  [C.DOC_FOLDERS]: { perms: ['MANAGE_DOCUMENTS'] },
  [C.CATEGORY_MAP]: { perms: ['MANAGE_VENDORS', 'MANAGE_TICKET_TYPES'] },
  [C.USERS]: { perms: ['MANAGE_USERS'] },
  [C.ROLES]: { perms: ['MANAGE_ROLES'] },
  [C.ROLE_GROUPS]: { perms: ['MANAGE_ROLES'] },
  // r77: every collection has an owner - a write nobody was given is refused (see authorizeWrite: fail closed)
  [C.BLOCKS]: { perms: ['MANAGE_UNITS'] },
  [C.FACILITIES]: { perms: ['MANAGE_UNITS', 'MANAGE_AMENITIES'] },
  [C.SERVICE_NOTICES]: { perms: [], categories: ['EC', 'Staff'] },
  [C.CULTURAL_BROCHURE]: { perms: ['MANAGE_CULTURAL'] },
  [C.NOTIFICATION_SETTINGS]: { perms: ['MANAGE_NOTIFICATIONS'] },
  [C.VENDOR_SERVICES]: { perms: ['MANAGE_VENDORS'] },
  [C.IMPORTANT_NUMBERS]: { perms: ['MANAGE_FIELD_DUTIES', 'MANAGE_SECURITY'], categories: ['EC'] },
};
const ADMIN_ONLY = [C.SCHEMA, C.COMMUNITY_CONFIG, C.NUMBER_SECTIONS];
const SYSTEM_ONLY = [C.AUDIT, C.REPORT_RUNS, C.NOTIFICATION_OUTBOX, C.UNIT_CREDITS, C.PORTAL_INVITES, C.COMMUNITIES]; // only the audit writer (raw storage) may add rows; nobody edits/deletes
// Written by any signed-in person, with every rule in their own pre-write step (lib/evoting.js): the voter roll and the sealed box.
const OPEN_WRITES = new Set([C.VOTE_ROLL, C.BALLOT_BOX]);
/** Every collection the app knows. A write to any other name is refused (nobody can invent a collection in the database). */
export const KNOWN_COLLECTIONS = new Set([...Object.values(C), IN_APP_NOTIFICATIONS]);

const changedKeys = (old, next) =>
  Object.keys(next).filter((k) => !META_KEYS.includes(k) && JSON.stringify(next[k]) !== JSON.stringify(old?.[k]));

const deny = (reason) => ({ ok: false, reason });
const OK = { ok: true };

/**
 * Rules-driven approvals: a record's `plan` (JSON) holds the steps and who decided them. When the plan changes, the actor must be
 * eligible for the step they decided (EC / final approvers / a named role or person), decide as themselves, and the old two-slot fields
 * must match what the plan says. Returns undefined when the plan did not change (the classic role checks then apply).
 */
const parsePlan = (s) => { try { return s ? (typeof s === 'string' ? JSON.parse(s) : s) : null; } catch { return null; } };
const planHelpers = { isEC: (p) => isEC(p) && (finalCanDecideEC || isAdmin(p) || !secondStepRoles.includes(p.roleId)), isFinal: (p) => isSecondApprover(p), isAdmin: (p) => isAdmin(p) };
export function planChange(p, old, next, shape = 'doc') {
  const np = parsePlan(next.plan); const op = parsePlan(old?.plan);
  if (!np || JSON.stringify(op) === JSON.stringify(np)) return undefined;
  if (JSON.stringify(op?.overrides || []) !== JSON.stringify(np.overrides || [])) {
    if (!isAdmin(p)) return deny('Only a Super Admin can change the approvals of one task');
    if ((np.overrides || []).length !== (op?.overrides || []).length + 1 || !String(np.overrides[np.overrides.length - 1]?.reason || '').trim()) return deny('Give a reason for changing the approvals');
  }
  const base = op || { steps: np.steps.map((s) => ({ ...s, decisions: [] })) };
  const cur = planState(base);
  for (let i = 0; i < np.steps.length; i += 1) {
    const o = base.steps[i]?.decisions || []; const n = np.steps[i].decisions || [];
    if (n.length > o.length) {
      const added = n.slice(o.length);
      if (added.some((d) => d.by !== p.name && !isAdmin(p))) return deny('An approval is always recorded in your own name');
      const stepNow = cur.key === 'pending' ? cur.step : null;
      const target = op ? stepNow : np.steps[i];
      if (!target || (op && cur.index !== i)) return deny('That step is not waiting for a decision');
      if (!stepEligible(target, p, planHelpers)) return deny(`Only ${target.approvers.map((a) => a.value).join(' or ')} can decide this step`);
    } else if (n.length < o.length) {
      const gone = o.filter((d) => !n.some((x) => x.by === d.by && x.at === d.at && x.value === d.value));
      if (gone.some((d) => d.by !== p.name && !isAdmin(p))) return deny('Only the person who decided can undo it');
    }
  }
  const want = planLegacy(np, shape);
  const bad = Object.keys(want).filter((k) => (next[k] ?? '') !== (want[k] ?? '') && !(next[k] == null && want[k] == null));
  if (bad.length && shape !== 'expense') return deny('The approval fields do not match the approval steps');
  return OK;
}

function onlyKeys(old, next, allowed, who) {
  const bad = changedKeys(old, next).filter((k) => !allowed.includes(k));
  return bad.length ? deny(`${who} may not change: ${bad.join(', ')}`) : OK;
}
function forbidKeys(old, next, forbidden, who) {
  const bad = changedKeys(old, next).filter((k) => forbidden.includes(k));
  return bad.length ? deny(`${who} may not change: ${bad.join(', ')}`) : OK;
}

const AMENITY_MONEY_KEYS = ['rate', 'rateUnit', 'weekendRate', 'gstApplicable', 'gstRate', 'gstMode', 'depositAmount', 'cancellationRules', 'minNoticeHours', 'maxAdvanceDays', 'price'];
const AMENITY_NOTIFY_KEYS = ['adminRecipients', 'reportRecipients', 'dailyReport', 'dailyReportTime', 'summaryReport', 'reminderOn', 'notifyOwner', 'notifyAdmin'];
const TICKET_CREATORS_STAFF = ['facility_manager', 'handyman_mep'];
const FIN_FIELDS = ['financial', 'selectedQuotationId', 'selectedQuotationIds', 'selectedInvoiceId', 'approvalStage', 'approvedAmount', 'invoiceApprovalMode', 'quotationStatus', 'invoiceStatus', 'paymentStatus', 'ecApproval', 'ecApprovedBy', 'ecApprovedAt', 'finalRequired', 'treasurerApproval', 'treasurerApprovedBy', 'treasurerApprovedAt'];
const EC_APPROVAL_FIELDS = ['ecApproval', 'ecApprovedBy', 'ecApprovedAt', 'finalRequired'];
const TREASURER_APPROVAL_FIELDS = ['treasurerApproval', 'treasurerApprovedBy', 'treasurerApprovedAt'];
// Status values that mean "an EC member signed this off" - only EC members may pick them.
export const EC_ONLY_STATUS = { quotationStatus: ['EC Approved', 'Treasurer Approved'], invoiceStatus: ['EC Approved', 'Treasurer Approved'] };

const isResetValue = (v) => v === 'Pending' || v === '' || v === undefined || v === null;
const todayStr = () => todayLocal();

/** SLA due: a future date when set; once the task exists only EC members may change it. */
function ticketSlaGuard(p, old, next) {
  if ((next.slaDueAt || '') === (old?.slaDueAt || '')) return OK;
  if (old && !isEC(p)) return deny('Only EC members can change the SLA due date once the task is created');
  if (next.slaDueAt && !(/^\d{4}-\d{2}-\d{2}$/.test(next.slaDueAt) && next.slaDueAt >= todayStr())) return deny('SLA due must be today or a future date');
  return OK;
}

function ticketFinanceGuard(p, old, next) {
  for (const [field, values] of Object.entries(EC_ONLY_STATUS)) {
    if (next[field] !== old?.[field] && values.includes(next[field]) && !isEC(p)) {
      return deny(`Only EC members can set ${field === 'quotationStatus' ? 'Quotation' : 'Invoice'} status to "${next[field]}"`);
    }
  }
  // The "involves a financial transaction" checkbox: only roles holding SET_FINANCIAL_FLAG (default EC + Super Admin). The UI also locks it once a payment exists.
  if (old && !!next.financial !== !!old.financial) {
    if (!(isAdmin(p) || anyPerm(p, ['SET_FINANCIAL_FLAG']))) return deny('Only the EC and Super Admin (or roles given the permission) can change whether a task involves a financial transaction');
  }
  const changed = changedKeys(old, next);
  // Uploading a new quotation / invoice (or picking another quotation) restarts the chain: the Facility Manager / MEP
  // may put the approvals back to Pending, but never record an approval themselves.
  const isReset = (keys) => isQuoteRole(p) && keys.every((k) => isResetValue(next[k]));
  // EC approval: any EC member. Treasurer approval: only the Treasurer or the President.
  const ecKeys = changed.filter((k) => EC_APPROVAL_FIELDS.includes(k));
  const trKeys = changed.filter((k) => TREASURER_APPROVAL_FIELDS.includes(k));
  const pc = planChange(p, old, next, 'ticket');
  if (pc && !pc.ok) return pc;
  if (pc?.ok) return OK;
  if (ecKeys.length && !isEC(p) && !isReset(ecKeys)) return deny('Only EC members can record the EC approval');
  if (trKeys.length && !isSecondApprover(p) && !isReset(trKeys)) return deny('Only the roles set as final approvers (Maintenance → Final approvers) can record the final approval');
  return OK;
}

/** A resident may add or remove only THEIR OWN entry in a sign-up list ({name, unit, phone}) and cannot exceed `limit` (0 = no limit). */
function selfSignupOnly(p, oldList = [], newList = [], limit = 0) {
  const o = Array.isArray(oldList) ? oldList : []; const n = Array.isArray(newList) ? newList : [];
  const others = (l) => JSON.stringify(l.filter((x) => x.name !== p.name));
  if (others(o) !== others(n)) return deny('You can only add or remove your own name');
  const mine = n.filter((x) => x.name === p.name);
  if (mine.length > 1 || mine.some((x) => x.unit !== p.unit)) return deny('One sign-up per person, for your own villa');
  const heads = (l) => l.reduce((s, x) => s + Math.max(1, Math.min(20, Number(x.people) || 1)), 0); // people, when the sign-up carries a count
  const counted = n.some((x) => x.people != null) || o.some((x) => x.people != null);
  const used = (l) => (counted ? heads(l) : l.length);
  if (limit > 0 && used(n) > limit && used(n) > used(o)) return deny('This is already full');
  return OK;
}
const signupGuard = (listKey, limitKey) => ({ p, old, next, op }) => {
  if (canCulturalEvents(p)) return OK;
  if (!isResident(p) || op === 'delete' || !old) return deny('Requires permission: MANAGE_CULTURAL');
  const base = onlyKeys(old, next, [listKey], 'Residents');
  if (!base.ok) return base;
  return selfSignupOnly(p, old[listKey], next[listKey], Number(old[limitKey]) || 0);
};

const RESIDENT_PLEDGE_KEYS = ['eventId', 'offeringId', 'unit', 'status', 'date', 'amount', 'towards', 'kind', 'mode', 'reference', 'anonymous', 'note', 'donor', 'phone', 'members', 'sankalpam', 'paymentClaimedAt', 'receiptNo'];
/** Fields a resident's new maintenance request may carry besides the ones they can edit; their values are checked below or set by the server. */
const RESIDENT_TICKET_START = ['taskType', 'scope', 'status', 'priority', 'assignedTo', 'slaDueAt', 'residentRating', 'createdBy', 'createdByRole', 'createdAt'];
function residentTicketCreate(p, next, schema) {
  const editable = new Set((schema?.fields || []).filter((f) => canEdit(f, p.roleId)).map((f) => f.key));
  const bad = Object.keys(next).filter((k) => !META_KEYS.includes(k) && !editable.has(k) && !RESIDENT_TICKET_START.includes(k));
  if (bad.length) return deny(`A new request cannot set: ${bad.join(', ')}`);
  if (next.scope != null && !['Unit', 'Community'].includes(next.scope)) return deny('A request is for your unit or the community');
  if (next.status != null && !['Open', 'Assigned'].includes(next.status)) return deny('A new request starts Open');
  const prio = (schema?.fields || []).find((f) => f.key === 'priority')?.options;
  if (next.priority != null && next.priority !== '' && Array.isArray(prio) && !prio.includes(next.priority)) return deny('Pick a priority from the list');
  if ((next.affectedUnits || []).some((u) => u !== p.unit)) return deny('You can only add your own villa');
  if (Number(next.residentRating) || 0) return deny('Rate the work once it is done');
  return ticketSlaGuard(p, null, next);
}
const NEAR_MS = 5 * 60 * 1000;
const nearNow = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) && Math.abs(t - Date.now()) <= NEAR_MS; };
const hoursBetween = (a, b) => Math.max(0, Math.round(((Date.parse(b) - Date.parse(a)) / 3600000) * 100) / 100);

const CUSTOM = {
  // ---- GateGuard ----------------------------------------------------------------------------------------------------------
  [C.GATE_VISITS]: ({ p }) => (gateStaff(p) ? undefined : deny('Only gate staff record entries and exits')),
  [C.GATE_FLAGS]: ({ p }) => (gateStaff(p) ? undefined : deny('Only gate staff handle ghost entry flags')),
  [C.GATE_SCANS]: ({ p }) => (gateStaff(p) ? undefined : deny('Only gate staff record patrol scans')),
  [C.GATE_PASS_TEMPLATES]: ({ p, old, next }) => (gateStaff(p) ? OK : (isResident(p) && p.unit && (next || old)?.unit === p.unit && (!old || old.unit === p.unit) ? OK : deny('A villa keeps only its own pass templates'))),
  [C.GATE_VEHICLES]: ({ p }) => (gateStaff(p) ? undefined : deny('Only the security team manages the FASTag / plate list')),
  [C.GATE_SETTINGS]: ({ p }) => (isEC(p) || p?.roleId === 'facility_manager' || p?.role?.id === 'facility_manager' ? undefined : deny('Only the committee or Facility Manager set the gate rules')),
  [C.GATE_WORKORDERS]: ({ p }) => (gateOrFM(p) ? undefined : deny('Only the security team or Facility Manager manage crew work orders')),
  // the vetted registry: staff run the vetting; a resident may only INVITE someone for their own household (no checks, no status)
  [C.GATE_PEOPLE]: ({ p, old, next, op }) => {
    if (gateOrFM(p)) return undefined;
    if (!isResident(p) || !p.unit) return deny('Only the security team vets people for the gate');
    if (op === 'delete') return old && old.invitedByUnit === p.unit && ['Invited', 'Documents pending'].includes(old.status) ? OK : deny('You can only withdraw your own invitation before vetting starts');
    if (['Active', 'Under review', 'Suspended', 'Blocked'].includes(next.status)) return deny('Only the security team can vet or change the status');
    if (old && (old.invitedByUnit !== p.unit || ['Active', 'Under review', 'Suspended', 'Blocked'].includes(old.status))) return deny('This person is already with the security team');
    const bad = (old ? changedKeys(old, next) : Object.keys(next)).filter((k) => ['idChecked', 'addressChecked', 'policeVerified', 'policeExpiry', 'referenceChecked', 'faceEnrolled', 'reviewNote', 'statusReason'].includes(k) && next[k]);
    if (bad.length) return deny('Vetting checks are ticked by the security team');
    return next.invitedByUnit === p.unit ? OK : deny('Invite people for your own villa');
  },
  // links, passes and delivery rules: staff everything; a villa only its own
  [C.GATE_LINKS]: ({ p, old, next }) => (gateOrFM(p) ? undefined : (isResident(p) && p.unit && (old || next)?.unit === p.unit && (!old || next.unit === p.unit) ? OK : deny('A villa manages only its own household staff'))),
  [C.GATE_PASSES]: ({ p, old, next, op }) => {
    if (gateStaff(p)) return OK;
    if (!(isResident(p) && p.unit && (old || next)?.unit === p.unit && (!old || next.unit === p.unit))) return deny('A villa manages only its own guest passes');
    if (op === 'delete') return OK;
    // the gate counts the uses and closes a used pass: a villa cannot reset either
    if (!old && (Number(next.usedCount) || 0) !== 0) return deny('A new pass has not been used yet');
    if (old && (Number(next.usedCount) || 0) !== (Number(old.usedCount) || 0)) return deny('Uses of a pass are counted by the gate');
    if (next.status === 'Used' && old?.status !== 'Used') return deny('The gate marks a pass as used');
    if (old && ['Used', 'Expired'].includes(old.status) && next.status !== old.status) return deny('A used or expired pass cannot be reopened - make a new one');
    return OK;
  },
  // patrol set-up and the guard consoles' heartbeat: the security team only
  [C.GATE_CHECKPOINTS]: ({ p }) => (gateStaff(p) ? undefined : deny('Only the security team sets up patrol checkpoints')),
  [C.GATE_ROUNDS]: ({ p }) => (gateStaff(p) ? undefined : deny('Only the security team plans patrol rounds')),
  [C.GATE_PULSE]: ({ p }) => (gateStaff(p) ? OK : deny('Only gate consoles report their heartbeat')),
  [C.GATE_VILLA_RULES]: ({ p, old, next }) => (gateStaff(p) ? undefined : (isResident(p) && p.unit && (old || next)?.unit === p.unit && (!old || next.unit === p.unit) ? OK : deny('A villa sets only its own gate rules'))),
  // an approval is asked by the gate and ANSWERED by the villa (or, for an unlisted worker, by the Facility Manager)
  [C.GATE_APPROVALS]: ({ p, old, next, op }) => {
    if (gateOrFM(p) && !isResident(p)) return OK;
    if (!isResident(p) || !old || op === 'delete') return deny('Only the gate asks for an approval');
    if (old.unit !== p.unit) return deny('This approval is for another villa');
    const only = onlyKeys(old, next, ['status', 'answeredAt', 'answeredBy', 'alwaysAllow'], 'A resident');
    if (!only.ok) return only;
    return ['Approved', 'Denied'].includes(next.status) && ['Pending', 'No answer'].includes(old.status) ? OK : deny('Answer with Approve or Deny');
  },
  // Payments Cross-check: ledger managers. The one exception: a final approver (Treasurer / President) crediting an event's unused budget
  // leaves an internal record here (no bank movement) even if their role does not manage the ledger.
  [C.LEDGER]: ({ p, old, next }) => {
    if (anyPerm(p, ['MANAGE_LEDGER'])) return undefined; // normal field checks follow
    if (!old && next.sourceType === 'culturalCredit' && next.internal === true && isSecondApprover(p)) return OK;
    return deny('Requires permission: MANAGE_LEDGER');
  },
  [C.CULTURAL_SEVAS]: signupGuard('volunteers', 'needed'),
  [C.CULTURAL_PROGRAMS]: signupGuard('participants', 'capacity'),
  // a resident may only reserve a free fixed slot for their own villa, or release their own reservation
  [C.CULTURAL_OFFERINGS]: ({ p, old, next, op }) => {
    if (canCulturalEvents(p)) return OK;
    if (!isResident(p) || op === 'delete' || !old) return deny('Requires permission: MANAGE_CULTURAL');
    const base = onlyKeys(old, next, ['reservedBy', 'reservedUnit', 'reservedAt', 'donationId'], 'Residents');
    if (!base.ok) return base;
    if (old.kind !== 'Fixed slot') return deny('This offering is a community pool - pledge any amount instead of reserving it');
    if (!old.reservedUnit) return next.reservedUnit === p.unit && !!p.unit ? OK : deny('Reserve a slot for your own villa');
    if (old.reservedUnit === p.unit && (!next.reservedUnit || next.reservedUnit === p.unit)) return OK; // releasing / completing their own reservation
    return deny('This slot is already reserved');
  },
  // Event expenses go through the same two steps as a task: an EC member approves first, then (when the expense needs it - see the event's
  // "Treasurer approval over" limit, stored on the row as finalRequired) a final approver (Treasurer / President, Maintenance -> Final approvers).
  [C.CULTURAL_EXPENSES]: ({ p, old, next, op }) => {
    const approver = isSecondApprover(p);
    const ec = isEC(p) || isAdmin(p);
    const EC_KEYS = ['ecApproval', 'ecApprovedBy', 'ecApprovedAt', 'ecNote'];
    if (op === 'delete') return approver || old?.status === 'Pending approval' || old?.status === 'Rejected' ? OK : deny('An approved expense cannot be deleted - ask the Treasurer');
    if (!old) return next.status === 'Pending approval' && !next.approvedBy && isResetValue(next.ecApproval) ? OK : deny('A new expense always starts as Pending approval');
    const pc = planChange(p, old, next, 'expense');
    if (pc && !pc.ok) return pc;
    if (pc?.ok) {
      if (old.status !== 'Pending approval') return deny('This expense is already decided');
      const st = planState(parsePlan(next.plan));
      const want = st.key === 'approved' ? 'Approved' : st.key === 'rejected' ? 'Rejected' : 'Pending approval';
      return next.status === want ? OK : deny('The status must match the approval steps');
    }
    const ch = changedKeys(old, next);
    const ecCh = ch.some((k) => EC_KEYS.includes(k));
    const decision = ch.some((k) => ['status', 'approvedBy', 'approvedAt', 'approvalNote'].includes(k));
    const resubmit = old.status === 'Rejected' && next.status === 'Pending approval' && !next.approvedBy && isResetValue(next.ecApproval);
    if (resubmit) return OK;
    const ecState = old.ecApproval || 'Pending';
    if (ecCh) {
      if (!ec) return deny('Only EC members can record the EC approval');
      if (!isAdmin(p) && old.recordCreatedBy && old.recordCreatedBy === p.name) return deny('Another EC member must approve an expense you raised');
      if (old.status !== 'Pending approval' || ecState !== 'Pending') return deny('The EC step of this expense is already decided');
    }
    if (decision) {
      const to = next.status;
      if (to === 'Paid') { if (!approver || old.status !== 'Approved') return deny('Only a final approver can mark an Approved expense as paid'); return OK; }
      if (old.status !== 'Pending approval') return deny('This expense is already decided');
      const ecStepNow = ecCh && next.ecApproval !== 'Pending';
      if (to === 'Rejected') return ecStepNow || (approver && ecState === 'Approved') ? OK : deny('Reject it at your own step: EC first, then the final approver');
      if (to === 'Approved') {
        if (approver && ecState === 'Approved') return OK;
        if (ecStepNow && next.ecApproval === 'Approved' && next.finalRequired === false) return OK;
        return deny(ecState === 'Approved' ? 'Only the Treasurer or President (final approvers) can give the final approval' : 'The EC must approve this expense first');
      }
      return deny('Invalid expense decision');
    }
    if (old.status === 'Pending approval' && ecCh && next.ecApproval === 'Approved') return OK; // EC approved, now waits for the final approver
    if ((old.status !== 'Pending approval' || ecState === 'Approved') && old.status !== 'Rejected' && ch.some((k) => ['item', 'category', 'vendor', 'amount', 'date', 'fund', 'eventId', 'finalRequired'].includes(k))) {
      return deny('This expense is already under final approval or decided - ask the approver to send it back for changes');
    }
    return OK;
  },
  // Attendance: staff clock themselves in and out (their own row, today, system-style fields only); managers (Manage field-staff duties) can correct any row.
  [C.ATTENDANCE]: ({ p, old, next, op }) => {
    if (has(p, 'MANAGE_FIELD_DUTIES')) return OK;
    if (isResident(p)) return deny('Residents do not have attendance records');
    if (op === 'delete') return deny('Only a supervisor can delete an attendance entry');
    if (next.staffName !== p.name) return deny('You can only clock yourself in or out');
    if (!old) {
      if (next.clockOut || next.source !== 'Self') return deny('A new entry is a clock-in; clock out later');
      return nearNow(next.clockIn) ? OK : deny('Clock in at the current time');
    }
    if (old.clockOut) return deny('This entry is already closed - ask your supervisor to correct it');
    const ch = changedKeys(old, next);
    if (!ch.every((k) => ['clockOut', 'outLat', 'outLng', 'outAcc', 'outSite', 'outDist', 'hours', 'note'].includes(k))) return deny('You can only clock out of your own open entry');
    if (ch.includes('clockOut') && !nearNow(next.clockOut)) return deny('Clock out at the current time');
    if (ch.includes('hours') && Math.abs((Number(next.hours) || 0) - hoursBetween(old.clockIn, next.clockOut || old.clockOut)) > 0.011) return deny('Hours are worked out from your clock-in and clock-out');
    return OK;
  },
  [C.CULTURAL_DONATIONS]: ({ p, old, next, op }) => {
    if (canCultural(p)) return OK;
    if (!isResident(p) || !p.unit) return deny('Requires permission: MANAGE_CULTURAL or MANAGE_LEDGER');
    if (next.unit !== p.unit) return deny('You can only pledge for your own villa');
    if (op === 'delete') return old?.status === 'Pledged' ? OK : deny('A confirmed donation cannot be withdrawn - contact the committee');
    if (!old) {
      const bad = Object.keys(next).filter((k) => !META_KEYS.includes(k) && !RESIDENT_PLEDGE_KEYS.includes(k));
      if (bad.length) return deny(`A pledge cannot set: ${bad.join(', ')}`);
      if (next.gatewayRef) return deny('Online payments are recorded by the payment service');
      return next.status === 'Pledged' && !next.receiptNo ? OK : deny('A new pledge starts as Pledged; the committee confirms receipt');
    }
    if (old.status !== 'Pledged') return deny('This donation is already confirmed and cannot be changed');
    return onlyKeys(old, next, ['amount', 'towards', 'kind', 'mode', 'reference', 'anonymous', 'note', 'donor', 'phone', 'members', 'sankalpam', 'paymentClaimedAt'], 'Residents');
  },
  // Event photos: committee (MANAGE_CULTURAL) manage all; anyone else who may sign in as owner/resident/EC/staff adds their own and
  // edits or removes only what they uploaded. (Per-event "Committee only" uploads are enforced by the screen now and by the API later.)
  [C.CULTURAL_PHOTOS]: ({ p, old, next, op }) => {
    if (canCulturalEvents(p)) return OK;
    if (p.role?.category === 'Vendor') return deny('Vendors cannot add event photos');
    if (!old) return next.uploadedBy === p.name ? OK : deny('Photos are added in your own name');
    if (old.uploadedBy !== p.name) return deny('You can change or remove only photos you uploaded');
    if (op === 'delete') return OK;
    return onlyKeys(old, next, ['caption', 'takenOn'], 'Uploaders');
  },
  [C.TICKETS]: ({ p, old, next, op, schema }) => {
    if (op === 'delete') return deny('Tickets cannot be deleted - cancel or close them instead');
    if (isResident(p)) {
      if (!p.unit) return deny('Residents can only act on tickets for their own unit');
      if (old && old.scope === 'Community' && old.unit !== p.unit) {
        // someone else's community request: the only thing a resident may do is add / remove their own "me too"
        const keys = changedKeys(old, next).filter((k) => k !== 'affectedUnits');
        if (keys.length) return deny('You can only add your villa to this community request ("Me too")');
        const a = old.affectedUnits || []; const b = next.affectedUnits || [];
        const diff = [...a.filter((u) => !b.includes(u)), ...b.filter((u) => !a.includes(u))];
        return diff.every((u) => u === p.unit) ? OK : deny('You can only add or remove your own villa');
      }
      if (next.unit !== p.unit) return deny('Residents can only act on tickets for their own unit');
      if (!old) {
        if (next.scope === 'Community' && !String(next.location || '').trim()) return deny('Say where in the community the problem is');
        if (next.createdByRole && next.createdByRole !== p.roleId) return deny('Ticket creator mismatch');
        return residentTicketCreate(p, next, schema);
      }
      const base = onlyKeys(old, next, ['description', 'attachments', 'photos', 'hasPhotos', 'preferredTime', 'residentRating', 'status', 'cancelledAt', 'cancelledBy', 'cancelReason', 'affectedUnits', 'location'], 'Residents');
      if (!base.ok) return base;
      if (next.status !== old.status) {
        // the owner confirms finished work: Completed -> Closed
        if (next.status === 'Closed' && old.status === 'Completed') return OK;
        if (next.status !== 'Cancelled') return deny('Residents can only Cancel a ticket, or Close it once the team marks it Completed');
        if (['Closed', 'Cancelled'].includes(old.status)) return deny('This ticket is already finished');
      }
      return OK;
    }
    if (!old && isStaff(p) && !TICKET_CREATORS_STAFF.includes(p.roleId)) return deny('Only the Facility Manager and MEP can create tasks');
    if (old && ['Closed', 'Cancelled'].includes(old.status) && next.status !== old.status && !isEC(p)) return deny('Only EC members can reopen a closed ticket');
    // Close / Cancel: only the ticket owner (Closed once it is Completed), EC members, or - for the automatic close after the
    // last approval - a final approver. The assignee as such cannot close or cancel.
    if (old && next.status !== old.status && ['Closed', 'Cancelled'].includes(next.status) && !isEC(p) && !isAdmin(p)) {
      const owner = old.createdBy === p.name || old.createdByRole === p.roleId;
      const okClose = next.status === 'Closed' && ((owner && old.status === 'Completed') || isSecondApprover(p));
      const okCancel = next.status === 'Cancelled' && owner;
      if (!okClose && !okCancel) return deny('Only the ticket owner, an EC member or the final approver can close or cancel a ticket - not the assignee');
    }
    const sla = ticketSlaGuard(p, old, next);
    if (!sla.ok) return sla;
    const fin = ticketFinanceGuard(p, old, next);
    if (!fin.ok) return fin;
    if (p.roleId === 'handyman_mep') {
      // MEP coordinates the contract with the Facility Manager: full working access except identity fields.
      return old ? forbidKeys(old, next, ['taskType', 'unit', 'createdBy', 'createdByRole', 'ticketNumber', 'residentRating'], 'MEP') : OK;
    }
    if (isHandyman(p)) {
      if (!old) return OK;
      return forbidKeys(old, next, ['taskType', 'unit', 'category', 'priority', ...FIN_FIELDS.filter((k) => k !== 'materialsCost'), 'residentRating', 'createdBy', 'createdByRole', 'ticketNumber'], 'Field staff');
    }
    return null; // EC / Facility Manager -> schema field rules
  },

  [C.TICKET_COMMENTS]: ({ p, old, next, op }) => {
    if (op === 'delete' || old) return has(p, 'MANAGE_TICKETS') ? OK : deny('Comments cannot be edited or deleted');
    if (isResident(p) && next.visibility === 'Internal') return deny('Residents cannot post internal comments');
    return OK;
  },

  // Bills: finance roles manage them freely; meter-reading roles can only create the Water / DG bill when they publish a reading.
  [C.DUES]: ({ p, old, next, op }) => {
    // An owner can pay their own unit's bill - and change nothing else on it.
    if (isResident(p)) {
      if (op === 'delete' || !old) return deny('Requires permission: MANAGE_DUES or MANAGE_UTILITY_BILLING');
      if (!p.unit || old.unit !== p.unit) return deny('You can only pay your own unit\'s dues');
      if (old.status === 'Paid') return deny('This bill is already paid');
      if (old.status === 'Cancelled') return deny('This bill was cancelled');
      if (next.status !== 'Paid') return deny('Residents can only mark a bill as paid');
      return onlyKeys(old, next, ['status', 'paymentMode', 'paymentRef', 'paidAt', 'paidBy', 'receiptNo'], 'Residents');
    }
    if (anyPerm(p, ['MANAGE_DUES', 'MANAGE_UTILITY_BILLING'])) return null;
    if (canManageReadings(p)) {
      return !old && op !== 'delete' && isUtility(next.category) && next.readingId ? OK : deny('Meter-reading roles can only publish a Water / DG bill - other dues need Manage dues');
    }
    return deny('Requires permission: MANAGE_DUES or MANAGE_UTILITY_BILLING');
  },

  [C.READINGS]: ({ p, old, op }) => {
    if (!canManageReadings(p)) return deny('Requires permission: MANAGE_UTILITY_READINGS');
    if (op === 'delete') return old?.status === 'Published' ? deny('A published reading cannot be deleted') : OK;
    if (old?.status === 'Published') return deny('This reading is already published to the owner and is locked');
    return OK;
  },

  [C.APPROVER_SETTINGS]: ({ p }) => (SETTINGS_EDITORS.includes(p.roleId) ? OK : deny('Only the President or the Treasurer can change who gives the final approval')),
  // Cultural events: the committee manages them; crediting the unused budget back to the fund is the final approvers' call.
  [C.CULTURAL_EVENTS]: ({ p, old, next }) => {
    const credit = ['creditedAmount', 'creditedAt', 'creditedBy', 'creditNote'];
    const ch = changedKeys(old, next);
    const touchesCredit = ch.some((k) => credit.includes(k));
    if (touchesCredit) {
      if (!isSecondApprover(p)) return deny('Only the Treasurer or the final approvers can credit unused budget back to the fund');
      if (old?.status !== 'Completed' && next.status !== 'Completed') return deny('Credit the unused budget once the event is completed');
      const actual = next.historicalActual != null && next.historicalActual !== '' ? Number(next.historicalActual) : Number(next.spent) || 0;
      const saving = Math.max(0, (Number(next.budget) || 0) - actual);
      if (Number(next.creditedAmount) > saving + 0.5) return deny('The credit cannot be more than the unused budget');
      if (!(actual > 0)) return deny('Enter the actual spend before crediting the unused budget');
      if (ch.some((k) => !credit.includes(k) && !['recordUpdatedAt', 'lastUpdatedBy'].includes(k))) return deny('Credit the budget on its own, without changing other details');
      return OK;
    }
    return anyPerm(p, ['MANAGE_CULTURAL']) ? undefined : deny('Requires permission: MANAGE_CULTURAL'); // undefined = carry on with the normal field checks
  },
  [C.QUOTATIONS]: ({ p, old, next }) => {
    if (!isQuoteRole(p)) return deny('Only the EC, Facility Manager or MEP can manage quotations');
    if (next.kind !== 'Invoice' && old?.kind !== 'Invoice') return OK;
    // Invoices: each one is approved on its own - EC first, then a final approver. Nobody records an approval at creation.
    const ch = changedKeys(old, next);
    if (!old && (!isResetValue(next.ecApproval) || !isResetValue(next.finalApproval))) return deny('A new invoice always starts with approvals Pending');
    if (old && ch.includes('approvalWaived')) return deny('Whether an invoice needs approval is fixed when it is uploaded');
    if (!old) return OK;
    // Correction: the EC (or Super Admin) sends an approved invoice back with a reason - approvals return to Pending (moneyGuard checks nothing is paid on it).
    if (old.correctionNote !== next.correctionNote && String(next.correctionNote || '').trim() && isResetValue(next.ecApproval) && isResetValue(next.finalApproval)) {
      return isEC(p) || isAdmin(p) ? OK : deny('Only the EC can send an approved invoice back for correction');
    }
    const pc = planChange(p, old, next, 'doc');
    if (pc && !pc.ok) return pc;
    if (!pc && ch.some((k) => ['ecApproval', 'ecApprovedBy', 'ecApprovedAt', 'finalRequired'].includes(k)) && !isEC(p)) return deny('Only EC members can record the EC approval');
    if (!pc && ch.some((k) => ['finalApproval', 'finalApprovedBy', 'finalApprovedAt'].includes(k)) && !isSecondApprover(p)) return deny('Only the roles set as final approvers (Maintenance → Final approvers) can record the final approval');
    if (old && ch.includes('selected') && next.selected === false && !(isResetValue(next.ecApproval) && isResetValue(next.finalApproval))) return deny('Unselecting an invoice restarts its approval - clear the EC and final approval together with it');
    if (old && ch.some((k) => ['amount', 'baseAmount', 'gstAmount', 'gstRate', 'gstMode', 'vendor'].includes(k)) && (old.ecApproval === 'Approved' || old.finalApproval === 'Approved')) return deny('An approved invoice cannot be edited');
    if (next.finalApproval === 'Approved' && (old?.finalApproval !== 'Approved') && (next.ecApproval ?? old?.ecApproval) !== 'Approved') return deny('Final approval needs the EC approval first');
    return OK;
  },

  // Fund releases against an approved task amount: raised by the EC / coordinators, approved through the rules-driven plan, paid by the accounting roles.
  [C.RELEASES]: ({ p, old, next, op }) => {
    const cultural = !!(next?.expenseId || old?.expenseId);
    if (!(isQuoteRole(p) || anyPerm(p, ['MANAGE_LEDGER']) || (cultural && anyPerm(p, ['MANAGE_CULTURAL'])))) return deny(cultural ? 'Only the EC, cultural managers or accounting roles can handle cultural releases' : 'Only the EC, Facility Manager or accounting roles can handle releases');
    if (op === 'delete') return old?.status === 'Waiting approval' || old?.status === 'Rejected' ? OK : deny('An approved or paid release cannot be deleted');
    if (!old) return next.status === 'Waiting approval' && !(parsePlan(next.plan)?.steps || []).some((s) => (s.decisions || []).length) ? OK : deny('A new release always starts as Waiting approval');
    const pc = planChange(p, old, next, 'expense');
    if (pc && !pc.ok) return pc;
    if (next.status !== old.status) {
      if (old.status === 'Waiting approval') {
        const st = planState(parsePlan(next.plan)).key;
        const want = st === 'approved' ? 'Approved' : st === 'rejected' ? 'Rejected' : 'Waiting approval';
        return pc?.ok && next.status === want ? OK : deny('The status must follow the approval steps');
      }
      if (old.status === 'Approved' && next.status === 'Paid') return isEC(p) || anyPerm(p, ['MANAGE_LEDGER']) ? OK : deny('Only the accounting roles can mark a release as paid');
      if (old.status === 'Rejected' && next.status === 'Waiting approval') return OK;
      // correction: an unpaid release is cancelled with a reason (EC or accounting); a Paid one goes back to Approved only after its payment is reversed (checked in moneyGuard)
      if (next.status === 'Cancelled' && ['Waiting approval', 'Approved'].includes(old.status)) return isEC(p) || isAdmin(p) || anyPerm(p, ['MANAGE_LEDGER']) ? OK : deny('Only the EC or accounting roles can cancel a release');
      if (old.status === 'Paid' && next.status === 'Approved') return anyPerm(p, ['MANAGE_LEDGER']) || isAdmin(p) ? OK : deny('Only accounting roles can reopen a paid release');
      return deny('Invalid release status change');
    }
    if (pc?.ok && old.status === 'Waiting approval') return OK;
    if (old.status !== 'Waiting approval' && changedKeys(old, next).some((k) => ['amount', 'kind', 'vendor'].includes(k))) return deny('A decided release cannot be changed');
    return OK;
  },
  [C.VENDOR_COMMENTS]: ({ p, old, op }) => {
    if (op === 'delete' || old) return deny('Comments cannot be edited or deleted');
    return isQuoteRole(p) || has(p, 'MANAGE_VENDORS') ? OK : deny('Only EC, Facility Manager, MEP or vendor managers can comment');
  },

  [C.EVENT_WORK]: ({ p }) => (canEventWork(p) ? OK : deny('Only the EC, Facility Manager, MEP or the event organisers can change event work')),
  // planned works: the EC, Facility Manager and MEP plan the checklists; the staff fill in the rounds; a finished round is the record of the work
  [C.CHECKLISTS]: ({ p, op }) => (op === 'delete' ? deny('Switch a checklist off instead: its rounds are the history') : isQuoteRole(p) ? OK : deny('Only the EC, Facility Manager or MEP plan the checklists')),
  [C.CHECKLIST_ROUNDS]: ({ p, op, old }) => (isResident(p) || p?.role?.category === 'Vendor' ? deny('Only the staff and the committee fill in planned works')
    : op === 'delete' && old?.status === 'Done' ? deny('A finished round is the record of the work') : OK),
  [C.REPORT_SCHEDULES]: ({ p }) => (canReports(p) ? OK : deny('Only the EC, Facility Manager or notification managers can set up reports')),
  // Supplies: EC, Facility Manager and MEP maintain stock; other staff can look.
  [C.INVENTORY]: ({ p }) => (isQuoteRole(p) ? OK : deny('Only the EC, Facility Manager or MEP can update inventory')),
  [C.INVENTORY_RULES]: ({ p }) => (isQuoteRole(p) ? OK : deny('Only the EC, Facility Manager or MEP can change inventory import rules')),
  ...Object.fromEntries(ASSET_COLLECTIONS.map((c) => [c, ({ p }) => (canAssetsWrite(p) ? OK : deny('Only the EC, Facility Manager, MEP or the people who record meter readings can change these records'))])),
  // An asset's name is fixed once it is saved: only an admin or an EC member can rename it (tickets and the map quote this name).
  [C.EQUIPMENT]: ({ p, old, next }) => (!canAssetsWrite(p) ? deny('Only the EC, Facility Manager, MEP or the people who record meter readings can change these records') : old && (next.name || '') !== (old.name || '') && !isEC(p) && !isAdmin(p) ? deny('An asset\'s name is fixed once saved. Only an admin or an EC member can rename it') : OK),

  // Poll answers: your own, never on someone else's behalf, never deleted.
  [C.POLL_VOTES]: ({ p, old, next, op }) => (op === 'delete' ? deny('Poll votes cannot be deleted') : next.voter !== p.name || (old && old.voter !== p.name) ? deny('You can only answer a poll as yourself') : OK),
  // Self-service profile details: your own row only (the Super Admin can fix anyone's).
  [C.USER_PROFILES]: ({ p, old, next, op }) => (op === 'delete' ? deny('Profile details cannot be deleted') : next.userName !== p.name || (old && old.userName !== p.name) ? deny('You can only change your own profile details') : OK),
  // Import rules are set up by the Super Admin only.
  [C.VILLA_IMPORT_RULES]: ({ p }) => (isAdmin(p) ? OK : deny('Only the Super Admin can change import rules')),
  [C.IMPORT_PROFILES]: ({ p }) => (isAdmin(p) || anyPerm(p, ['MANAGE_LEDGER']) ? OK : deny('Only the Super Admin or finance editors can change import rules')),

  [C.FILES]: ({ p, old, next, op }) => {
    if (op === 'delete' || old) return has(p, 'MANAGE_DOCUMENTS') ? OK : deny('Uploaded files cannot be changed or deleted');
    const ext = String(next.name || '').split('.').pop().toLowerCase();
    if (!ALLOWED_TYPES.some((t) => t.ext.includes(ext))) return deny(`.${ext} files are not allowed`);
    if (Number(next.size) > MAX_BYTES + 1024) return deny('File is too large');
    return OK;
  },

  // Audits: the EC and the facility coordinators record them; everyone else only reads what is published.
  [C.AUDITS]: ({ p }) => (isQuoteRole(p) ? OK : deny('Only the EC, Facility Manager or MEP can record audits')),
  // Community directory: any resident / member can recommend someone and review them; you edit or remove only your own entries; moderators (EC) can hide or delete any.
  [C.SERVICE_CONTACTS]: ({ p, old, next, op }) => {
    const mod = isEC(p) || has(p, 'MODERATE_FORUM'); const mine = (r) => r && r.addedBy === p.name;
    if (op === 'delete') return mine(old) || mod ? OK : deny('You can only remove contacts you added');
    if (!old) return next.addedBy === p.name ? OK : deny('Added-by must be you');
    if (mod) return OK;
    if (!mine(old)) return deny('You can only edit contacts you added - leave a review instead');
    if (next.status !== old.status && next.status === 'Hidden') return deny('Only moderators can hide a contact');
    return OK;
  },
  [C.CONTACT_REVIEWS]: ({ p, old, next, op }) => {
    const mod = isEC(p) || has(p, 'MODERATE_FORUM'); const mine = (r) => r && r.author === p.name;
    if (op === 'delete') return mine(old) || mod ? OK : deny('You can only delete your own review');
    if (!old) return next.author === p.name && Number(next.rating) >= 1 && Number(next.rating) <= 5 ? OK : deny('Give a rating from 1 to 5 as yourself');
    if (mine(old) || mod) return Number(next.rating) >= 1 && Number(next.rating) <= 5 ? OK : deny('Rating must be 1 to 5');
    return deny('You can only edit your own review');
  },

  [C.FORUM]: ({ p, old, next, op }) => {
    if (op === 'delete') return has(p, 'MODERATE_FORUM') ? OK : deny('Only moderators can delete topics');
    if (has(p, 'MODERATE_FORUM')) return OK;
    if (!old) {
      if (next.pinned || (next.status && next.status !== 'Open') || (Number(next.replies) || 0) !== 0 || (next.voters || []).length || (next.pollOptions || []).some((o) => (Number(o?.votes) || 0) !== 0)) return deny('A new topic starts open, unpinned, with no replies or votes');
      return OK;
    }
    const base = onlyKeys(old, next, ['replies', 'pollOptions', 'voters'], 'Members');
    if (!base.ok) return base;
    const r0 = Number(old.replies) || 0; const r1 = Number(next.replies) || 0;
    if (r1 < 0 || Math.abs(r1 - r0) > 1) return deny('The reply count follows the posts');
    if (JSON.stringify(old.pollOptions || []) !== JSON.stringify(next.pollOptions || []) || JSON.stringify(old.voters || []) !== JSON.stringify(next.voters || [])) {
      const v0 = old.voters || []; const v1 = next.voters || [];
      if (v0.includes(p.name)) return deny('You have already voted');
      if (v1.length !== v0.length + 1 || v1[v1.length - 1] !== p.name || v0.some((x, i) => v1[i] !== x)) return deny('You can only add your own vote');
      const o0 = old.pollOptions || []; const o1 = next.pollOptions || [];
      const sameLabels = o0.length === o1.length && o0.every((o, i) => JSON.stringify({ ...o, votes: 0 }) === JSON.stringify({ ...o1[i], votes: 0 }));
      const diffs = o1.map((o, i) => (Number(o?.votes) || 0) - (Number(o0[i]?.votes) || 0));
      if (!sameLabels || diffs.some((d) => d < 0 || d > 1) || diffs.reduce((a, b) => a + b, 0) !== 1) return deny('One vote adds one to one answer');
    }
    return OK;
  },
  // Wishlist: anyone with a unit (or the EC) raises an idea as themselves; the raiser edits the text only while it is still
  // Submitted; ANY resident may toggle their own villa in `votes` and nothing else; the EC manages status / decision / conversion.
  [C.WISHES]: ({ p, old, next, op }) => {
    const mgr = has(p, 'MANAGE_TICKETS') || isEC(p) || isAdmin(p);
    const mine = (r) => r && r.raisedBy === p.name;
    if (op === 'delete') return mgr || (mine(old) && ['Submitted', 'Withdrawn'].includes(old.status)) ? OK : deny('Only the EC, or you while the idea is still Submitted, can delete it');
    if (!old) {
      if (p.category === 'Vendor' || p.role?.category === 'Vendor') return deny('Vendors cannot raise wishlist ideas');
      if (next.raisedBy && next.raisedBy !== p.name) return deny('Ideas are raised as yourself');
      if (!mgr && next.status && next.status !== 'Submitted') return deny('New ideas start as Submitted');
      return OK;
    }
    if (mgr) return OK;
    const changed = changedKeys(old, next);
    const only = (ks) => changed.every((k) => ks.includes(k));
    if (changed.every((k) => k === 'votes')) {
      const a = new Set(old.votes || []); const b = new Set(next.votes || []);
      const diff = [...a].filter((x) => !b.has(x)).concat([...b].filter((x) => !a.has(x)));
      if (!p.unit || diff.some((u) => u !== p.unit)) return deny('You can only add or remove your own villa\'s vote');
      if (['Done', 'Declined', 'Withdrawn'].includes(old.status)) return deny('Voting is closed on this idea');
      return OK;
    }
    if (mine(old) && old.status === 'Submitted' && only(['title', 'description', 'category', 'location', 'attachments', 'status'])) {
      if (changed.includes('status') && next.status !== 'Withdrawn') return deny('You can only withdraw your idea');
      return OK;
    }
    if (mine(old) && changed.every((k) => k === 'status') && next.status === 'Withdrawn') return OK;
    return deny('Only the EC can change an idea\'s status or decision');
  },
  [C.FORUM_POSTS]: ({ p, old, next, op }) => {
    const mine = (r) => r && r.author === p.name;
    if (op === 'delete') return mine(old) || has(p, 'MODERATE_FORUM') ? OK : deny('You can only delete your own posts');
    if (!old) return !next.authorRoleId || next.authorRoleId === p.roleId ? OK : deny('Author mismatch');
    if (mine(old) || has(p, 'MODERATE_FORUM')) return OK;
    return onlyKeys(old, next, ['reactions'], 'Members');
  },

  // The amenity catalog: money fields need MANAGE_AMENITY_RATES, the rules text MANAGE_AMENITY_RULES, everything else MANAGE_AMENITIES.
  // These are ordinary permissions, so Super Admin chooses which roles hold each one (Roles & Permissions).
  [C.AMENITY_TYPES]: ({ p, old, next, op }) => {
    if (op === 'delete') return has(p, 'MANAGE_AMENITIES') ? OK : deny('Requires amenities management access');
    const changed = old ? changedKeys(old, next) : Object.keys(next).filter((k) => !META_KEYS.includes(k));
    const money = changed.filter((k) => AMENITY_MONEY_KEYS.includes(k));
    const rules = changed.filter((k) => k === 'rules');
    const rest = changed.filter((k) => !AMENITY_MONEY_KEYS.includes(k) && k !== 'rules');
    if (money.length && !has(p, 'MANAGE_AMENITY_RATES')) return deny('Changing rates, GST, deposits or cancellation rules needs the "Change amenity rates" permission');
    if (rules.length && !has(p, 'MANAGE_AMENITY_RULES')) return deny('Editing rules & regulations needs the "Edit amenity rules" permission');
    if (rest.length && !has(p, 'MANAGE_AMENITIES')) return deny('Requires amenities management access');
    return OK;
  },
  [C.AMENITY_SETTINGS]: ({ p, old, next, op }) => {
    if (op === 'delete') return has(p, 'MANAGE_AMENITIES') ? OK : deny('Requires amenities management access');
    const changed = old ? changedKeys(old, next) : Object.keys(next).filter((k) => !META_KEYS.includes(k));
    const notif = changed.filter((k) => AMENITY_NOTIFY_KEYS.includes(k));
    const money = changed.filter((k) => !AMENITY_NOTIFY_KEYS.includes(k));
    if (money.length && !(has(p, 'MANAGE_AMENITY_RATES') || has(p, 'MANAGE_AMENITIES'))) return deny('Changing GST / payment / refund settings needs the "Change amenity rates" permission');
    if (notif.length && !has(p, 'MANAGE_NOTIFICATIONS')) return deny('Changing who is notified and when reports go out needs the "Edit notification templates" permission');
    return OK;
  },
  [C.NOTIFICATION_TEMPLATES]: ({ p }) => (has(p, 'MANAGE_NOTIFICATIONS') ? OK : deny('Editing notification templates needs the "Edit notification templates" permission')),

  // Bookings. Residents create a booking for their own villa and may only ask to CANCEL it; every amount, payment state and
  // refund is computed by the server-side rules (lib/amenityServer.js), never taken from the client. Staff act through
  // explicit actions (receive payment, pay refund, settle deposit) - they need amenities management access.
  [C.AMENITIES]: ({ p, old, next, op }) => {
    if (op === 'delete') return deny('Bookings cannot be deleted - cancel them instead');
    if (isResident(p)) {
      if (!p.unit || next.unit !== p.unit) return deny('You can only book or change bookings for your own unit');
      if (!old) return OK;
      const base = onlyKeys(old, next, ['_action', 'cancelReason', 'status', 'paymentMode', 'waive', 'refundOverride', 'refundTo'], 'Residents');
      if (!base.ok) return base;
      return next._action === 'cancel' ? OK : deny('Residents can only cancel their booking');
    }
    return has(p, 'MANAGE_AMENITIES') || isEC(p) ? OK : deny('Requires amenities management access');
  },

  [C.BROADCASTS]: ({ p, old, next, op }) => {
    if (isEC(p) || anyPerm(p, ['MANAGE_NOTICE_TEMPLATES', 'MANAGE_GOVERNANCE'])) return OK;
    if (!old || op === 'delete') return deny('Only the committee can send or remove broadcasts');
    const base = onlyKeys(old, next, ['signedBy'], 'Members');
    if (!base.ok) return base;
    const names = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
    const a = names(old.signedBy); const b = names(next.signedBy);
    if (a.some((x) => !b.includes(x)) || b.filter((x) => !a.includes(x)).some((x) => x !== p.name)) return deny('You can only add your own signature');
    return OK;
  },
  // the bell: anyone signed in may notify someone (the server records who sent it); only the addressee marks it read; nobody deletes
  [IN_APP_NOTIFICATIONS]: ({ p, old, next, op }) => {
    if (op === 'delete') return deny('Notifications cannot be deleted');
    if (!old) {
      if (next.read) return deny('A new notification starts unread');
      if (next.link && !/^#\//.test(String(next.link))) return deny('A notification links only to a page of this app');
      return OK;
    }
    if (!notificationForMe(old, p)) return deny('This notification is not addressed to you');
    return onlyKeys(old, next, ['read'], 'You');
  },
  [C.NOTIFICATION_PREFS]: ({ p, old, next, op }) => ((!old || old.userName === p.name) && (op === 'delete' || next.userName === p.name) ? OK : deny('You can only change your own notification choices')),
  // the field-staff roster: managers add and remove people; a staff member only switches their own (or their trade's) on-duty flag
  [C.HANDYMEN]: ({ p, old, op }) => {
    if (anyPerm(p, ['MANAGE_TICKETS', 'MANAGE_FIELD_DUTIES'])) return undefined;
    if (isStaff(p) && old && op !== 'delete' && (old.name === p.name || (!!tradeOf(p) && old.trade === tradeOf(p)))) return undefined;   // field checks follow (clockedIn only)
    return deny('Only the Facility Manager or ticket managers change the field-staff roster');
  },
};

/**
 * Decide a write. Returns { ok:true } or { ok:false, reason }.
 * `old` is the stored record (null on create); `next` the incoming record.
 */
export function authorizeWrite({ collection, p, schema, old, next, op }) {
  if (!p) return deny('Not signed in');
  if (isAdmin(p)) return OK;
  if (!KNOWN_COLLECTIONS.has(collection)) return deny('Unknown collection');
  if (ADMIN_ONLY.includes(collection)) return deny('Super Admin only');
  if (SYSTEM_ONLY.includes(collection)) return deny('System-managed collection');

  const custom = CUSTOM[collection];
  if (custom) {
    const res = custom({ p, old, next, op, schema });
    if (res && !res.ok) return res;
    if (res && res.ok) return fieldCheck({ collection, p, schema, old, next, op, skipSchema: true });
  } else {
    const rule = WRITE_RULES[collection];
    if (rule) {
      const allowed = anyPerm(p, rule.perms) || (rule.categories || []).includes(p.role?.category);
      if (!allowed) return deny(rule.perms.length ? `Requires permission: ${rule.perms.join(' or ')}` : 'Your role cannot change these records');
    } else if (!OPEN_WRITES.has(collection)) return deny('Your role cannot change these records');   // fail closed: no rule, no write
  }
  if (op === 'delete') return OK;
  return fieldCheck({ collection, p, schema, old, next, op, skipSchema: false });
}

/** editableBy enforcement for updates (creates are gated by collection access). */
function fieldCheck({ p, schema, old, next, op, skipSchema }) {
  if (skipSchema || !schema || !old || op === 'delete') return OK;
  const denied = changedKeys(old, next)
    .map((k) => schema.fields.find((f) => f.key === k))
    .filter((f) => f && !canEdit(f, p.roleId));
  return denied.length ? deny(`Your role cannot edit: ${denied.map((f) => f.label).join(', ')}`) : OK;
}

/** For UI: may this principal write to the collection at all (create)? */
const UI_WRITE = { [C.AUDITS]: isQuoteRole, [C.EVENT_WORK]: canEventWork, [C.CHECKLISTS]: isQuoteRole, [C.CHECKLIST_ROUNDS]: (p) => !isResident(p) && p?.role?.category !== 'Vendor', [C.REPORT_SCHEDULES]: canReports, [C.VILLA_IMPORT_RULES]: isAdmin, ...Object.fromEntries(ASSET_COLLECTIONS.map((c) => [c, canAssetsWrite])), [C.APPROVER_SETTINGS]: (p) => SETTINGS_EDITORS.includes(p.roleId), [C.READINGS]: canManageReadings, [C.INVENTORY]: (p) => isQuoteRole(p), [C.INVENTORY_RULES]: (p) => isQuoteRole(p), [C.COMMUNITY_CONFIG]: isAdmin, [C.VENDOR_COMMENTS]: (p) => isQuoteRole(p) || has(p, 'MANAGE_VENDORS') };
export function canWriteCollection(collection, p) {
  if (!p) return false;
  if (isAdmin(p)) return true;
  if (UI_WRITE[collection]) return UI_WRITE[collection](p);
  if (ADMIN_ONLY.includes(collection) || SYSTEM_ONLY.includes(collection) || !KNOWN_COLLECTIONS.has(collection)) return false;
  const rule = WRITE_RULES[collection];
  if (!rule) return !!CUSTOM[collection] || OPEN_WRITES.has(collection);   // a custom rule decides per record; no rule at all = nobody
  return anyPerm(p, rule.perms) || (rule.categories || []).includes(p.role?.category);
}
