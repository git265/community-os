// Record shapes: the app's collections (properties, users, dues, roles) <-> the typed /api/v1 resources (units, members, dues, roles).
// Pure functions, no I/O - the adapter (V2ApiAdapter.js) does the calls. Money travels as decimal strings on the wire ("3540.00") and is a
// number in the app, as before. Only fields the server lets a caller change are ever sent; everything else is the server's.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const num = (s) => (s == null || s === '' ? null : Number(s));
export const money = (n) => (n == null || n === '' ? null : Number(n).toFixed(2));

/** '2026-09-01' -> 'Sep 2026' (the app's billed-month label) */
export function monthLabel(iso) {
  if (!iso) return '';
  const [y, m] = String(iso).split('-');
  return `${MONTHS[Number(m) - 1]} ${y}`;
}
/** 'Sep 2026' | '2026-09' | '2026-09-01' -> '2026-09-01'; anything else -> null (a late-fee label, say) */
export function monthDate(label) {
  if (!label) return null;
  const s = String(label).trim();
  let m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-01`;
  m = /^([A-Za-z]{3})[a-z]*\s+(\d{4})$/.exec(s);
  if (m) { const i = MONTHS.findIndex((x) => x.toLowerCase() === m[1].toLowerCase()); if (i >= 0) return `${m[2]}-${String(i + 1).padStart(2, '0')}-01`; }
  return null;
}

// ---- units <-> properties ----------------------------------------------------------------------------------------------------------------
export function propertyOf(u) {
  return {
    ...(u.custom || {}),
    id: u.id, shortId: u.shortId, unit: u.unitNo, type: u.unitType, zone: u.blockName || '', blockId: u.blockId || null, occupancy: u.occupancy,
    areaSqft: num(u.areaSqft), maintenancePlan: u.maintenancePlan || '', sanctionedKw: num(u.sanctionedKw), status: u.status,
    version: u.version, updatedAt: u.updatedAt,
  };
}
const UNIT_FIELDS = { type: 'unitType', occupancy: 'occupancy', areaSqft: 'areaSqft', maintenancePlan: 'maintenancePlan', sanctionedKw: 'sanctionedKw' };
const UNIT_FIXED = new Set(['id', 'shortId', 'unit', 'zone', 'blockId', 'status', 'version', 'updatedAt', 'createdAt', 'createdBy', 'lastUpdatedAt', 'lastUpdatedBy',
  'owner', 'ownerPhone', 'ownerEmail', 'tenant', 'tenantPhone', 'tenantEmail', 'people', 'secondaryOwner', 'secondaryOwnerPhone', 'billTo', 'outstanding']);
/** Only what changed, as the PATCH body (null when nothing the server accepts changed). Unknown keys go to `custom` (the server checks them). */
export function unitPatch(before, after) {
  const body = {}; const custom = {};
  for (const [k, v] of Object.entries(after)) {
    if (UNIT_FIXED.has(k) || JSON.stringify(before?.[k]) === JSON.stringify(v)) continue;
    if (UNIT_FIELDS[k]) body[UNIT_FIELDS[k]] = k === 'areaSqft' || k === 'sanctionedKw' ? (v === '' || v == null ? null : Number(v)) : (v || null);
    else custom[k] = v === '' ? null : v;
  }
  if (Object.keys(custom).length) body.custom = custom;
  return Object.keys(body).length ? body : null;
}

// ---- members <-> users ---------------------------------------------------------------------------------------------------------------------
export function userOf(m, unitNoById = {}) {
  const primary = m.roles.find((r) => r.primary) || m.roles[0];
  return {
    id: m.id, name: m.displayName, phone: m.phone || '', status: m.status, roleId: primary?.code || '',
    extraRoleIds: m.roles.filter((r) => r !== primary).map((r) => r.code), units: (m.units || []).map((id) => unitNoById[id] || id), unitIds: m.units || [],
    version: m.version, createdAt: m.createdAt, updatedAt: m.updatedAt,
  };
}

// ---- dues ----------------------------------------------------------------------------------------------------------------------------------
export function dueOf(d, today = new Date().toISOString().slice(0, 10)) {
  const open = d.status === 'Unpaid' || d.status === 'Partly paid';
  return {
    id: d.id, shortId: d.shortId, unit: d.unitNo || '', unitId: d.unitId, category: d.categoryCode, categoryName: d.category, utility: d.utility,
    amount: num(d.total), baseAmount: num(d.amount), tax: num(d.tax), grossAmount: num(d.total), paidAmount: num(d.paid), outstanding: num(d.outstanding),
    billedMonth: monthLabel(d.billedMonth), billedMonthDate: d.billedMonth, description: d.description || '', dueDate: d.dueDate,
    status: open && d.dueDate < today && d.status === 'Unpaid' ? 'Overdue' : d.status, serverStatus: d.status,
    paidAt: d.paidAt ? String(d.paidAt).slice(0, 10) : '', cancelReason: d.reason || '', version: d.version,
  };
}
/** A new bill: the amount typed is before tax; the server adds the category's tax and returns the true total. */
export function raiseBody(rec, unitIdByNo) {
  const unitId = rec.unitId || unitIdByNo[rec.unit];
  if (!unitId) throw new Error(`Unit ${rec.unit || '?'} is not known to the back end.`);
  return { unitId, categoryCode: rec.category, billedMonth: monthDate(rec.billedMonth), description: rec.description || rec.notice || null, amount: money(rec.baseAmount ?? rec.amount), dueDate: rec.dueDate };
}

// ---- roles ---------------------------------------------------------------------------------------------------------------------------------
export const roleOf = (r) => ({ id: r.code, name: r.name, category: r.category, permissions: r.permissions, builtIn: true });

// ---- the signed-in person (GET /v1/me) as the app's user -----------------------------------------------------------------------------------
export function meUser(me, unitNoById = {}) {
  return {
    id: me.membershipId, name: me.displayName, roleId: me.roles[0] || '', roleIds: me.roles, category: me.category,
    units: me.units.map((id) => unitNoById[id] || id), unit: unitNoById[me.units[0]] || '', blocks: me.blocks, trade: me.trade || '', permissions: me.permissions,
  };
}

// ---- payment orders as the payment service's order shape --------------------------------------------------------------------------------------
export function orderOf(o) {
  return {
    orderId: o.id, shortId: o.shortId, purpose: o.purpose || 'due', amount: num(o.amount), currency: o.currency, status: o.status, provider: o.provider, unitId: o.unitId,
    refs: (o.items || []).map((i) => i.dueId || i.targetId), providerOrderRef: o.checkout?.providerOrderRef || null, checkout: o.checkout || {}, expiresAt: o.expiresAt,
    paymentId: o.paymentId || null,
  };
}

// ---- maintenance: tickets, discussion, task types, field staff, categories, phrases ------------------------------------------------------------
export function ticketOf(t, unitNoById = {}) {
  return {
    id: t.id, shortId: t.shortId, ticketNumber: t.shortId, taskTypeId: t.taskTypeId, taskType: t.taskType || '', title: t.title, description: t.description || '',
    unit: t.unitNo || '', unitId: t.unitId, scope: t.scope, location: t.location || '', category: t.category, subCategory: t.subCategory || '', priority: t.priority,
    status: t.status, assignedTo: t.assigneeName || '', assigneeId: t.assigneeId, slaDueAt: t.slaDueAt || '', preferredTime: t.preferredTime || '',
    affectedUnits: (t.affectedUnitIds || []).map((id) => unitNoById[id] || id), affectedUnitIds: t.affectedUnitIds || [], residentRating: t.residentRating || 0,
    createdBy: t.raisedByName || '', createdByRole: t.raisedByRole || '', raisedById: t.raisedById, awaitingParts: !!t.awaitingParts, materialsCost: num(t.materialsCost) || 0,
    financial: !!t.financial, workDone: t.workDone || '', cancelReason: t.cancelReason || '', reopenCount: t.reopenCount || 0,
    createdAt: t.createdAt, recordCreatedAt: t.createdAt, updatedAt: t.updatedAt, attachments: [], hasPhotos: false, paymentStatus: 'Not Paid', version: t.version,
    quotationStatus: t.quotationStatus || 'None', invoiceStatus: t.invoiceStatus || 'None', approvedAmount: num(t.approvedAmount) || 0,
    selectedQuotationId: t.selectedQuotationId || '', selectedInvoiceId: t.selectedInvoiceId || '', ecApproval: t.ecApproval || '', treasurerApproval: t.treasurerApproval || '',
    finalRequired: !!t.finalRequired,
  };
}
/** Fields a ticket edit may send (PATCH); the commands (assign, status, rating, me-too) are separate. */
export const TICKET_EDIT = ['title', 'description', 'category', 'subCategory', 'priority', 'location', 'preferredTime', 'slaDueAt', 'awaitingParts', 'materialsCost', 'financial', 'workDone'];
/** The money side of a ticket: derived by the server from its quotations and invoices (never sent with a ticket edit). */
export const TICKET_FINANCE = ['quotationStatus', 'selectedQuotationId', 'selectedQuotationIds', 'selectedInvoiceId', 'approvalStage', 'invoiceApprovalMode', 'approvedAmount',
  'ecApproval', 'ecApprovedBy', 'ecApprovedAt', 'finalRequired', 'treasurerApproval', 'treasurerApprovedBy', 'treasurerApprovedAt', 'invoiceStatus', 'plan', 'advanceCeiling', 'advanceReason'];
export function ticketPatch(before, after) {
  const body = {};
  for (const k of TICKET_EDIT) {
    if (!(k in after) || JSON.stringify(before[k] ?? '') === JSON.stringify(after[k] ?? '')) continue;
    const v = after[k];
    body[k] = k === 'materialsCost' ? money(v || 0) : (k === 'slaDueAt' || k === 'workDone') ? (v || null) : (k === 'awaitingParts' || k === 'financial') ? !!v : (v ?? '');
  }
  return Object.keys(body).length ? body : null;
}
export function raiseTicketBody(rec, { taskTypeIdByName, unitIdByNo, resident }) {
  const unitId = rec.unitId || (rec.unit ? unitIdByNo[rec.unit] : null) || null;
  if (rec.unit && !unitId) throw new Error(`Unit ${rec.unit} is not known to the back end.`);
  return {
    taskTypeId: rec.taskTypeId || taskTypeIdByName[rec.taskType] || null, title: rec.title, description: rec.description || null, unitId,
    scope: rec.scope || 'Unit', location: rec.location || null, category: rec.category, subCategory: rec.subCategory || null, priority: rec.priority || 'Medium',
    preferredTime: rec.preferredTime || null, slaDueAt: resident ? null : (rec.slaDueAt || null),   // a resident's SLA is the committee's to set
  };
}
export const commentOf = (c) => ({ id: c.id, shortId: c.shortId, ticketId: c.ticketId, author: c.authorName, authorId: c.authorId, visibility: c.visibility, body: c.body, createdAt: c.createdAt, attachments: [] });
export const taskTypeOf = (t) => ({ id: t.id, name: t.name, icon: t.icon, creatorScope: t.creatorScope, assignmentMode: t.assignmentMode, quotationStage: t.quotationStage || 'No',
  ecApprovalStage: t.ecApprovalStage || 'No', treasurerStage: t.treasurerStage || 'No', invoiceStage: t.invoiceStage || 'No', paymentStage: t.paymentStage || 'No',
  residentVisible: t.residentVisible, residentDefault: t.residentDefault, canRaise: t.canRaise });
export const fieldStaffOf = (f) => ({ id: f.id, shortId: f.shortId, membershipId: f.membershipId, name: f.name, trade: f.trade, shift: f.shift || '', phone: f.phone || '', clockedIn: f.clockedIn, version: f.version });

// ---- quotations and invoices ------------------------------------------------------------------------------------------------------------------
/** A server plan as the app's engine reads it: decisions carry the person's name in `by` (the app compares names). */
export function legacyPlan(plan) {
  if (!plan) return null;
  return { ...plan, steps: (plan.steps || []).map((st) => ({ ...st, decisions: (st.decisions || []).map((d) => ({ by: d.name || d.by, byId: d.by, at: d.at, value: d.value, comment: d.comment || '' })) })) };
}
export function quotationOf(q) {
  return {
    id: q.id, shortId: q.shortId, ticketId: q.ticketId, kind: q.kind, vendor: q.vendor || '', amount: num(q.amount), baseAmount: num(q.baseAmount), gstMode: q.gstMode || 'None',
    gstRate: num(q.gstRate) || 0, gstAmount: num(q.gstAmount) || 0, quoteDate: q.quoteDate || '', note: q.note || '', selected: !!q.selected, overBudget: !!q.overBudget,
    approvalWaived: !!q.approvalWaived, correctionNote: q.correctionNote || '', ecApproval: q.ecApproval || 'Pending', ecApprovedBy: q.ecApprovedBy || '',
    ecApprovedAt: q.ecApprovedAt ? String(q.ecApprovedAt).slice(0, 10) : '', finalRequired: !!q.finalRequired, finalApproval: q.finalApproval || 'Pending',
    finalApprovedBy: q.finalApprovedBy || '', finalApprovedAt: q.finalApprovedAt ? String(q.finalApprovedAt).slice(0, 10) : '', plan: q.plan ? JSON.stringify(legacyPlan(q.plan)) : '',
    status: q.status, waitingFor: q.waitingFor || '', canDecide: !q.whyNotMe, whyNotMe: q.whyNotMe || '', createdBy: q.createdByName || '', createdAt: q.createdAt, attachments: [], version: q.version,
  };
}
/** What is written on the document: for GST "Extra" the amount before tax, otherwise the total. */
export function addDocumentBody(rec) {
  const mode = rec.gstMode || 'None';
  const written = mode === 'Extra' ? (rec.baseAmount ?? rec.amount) : (rec.amount ?? rec.baseAmount);
  return { kind: rec.kind || 'Quotation', vendor: rec.vendor || null, amount: money(written), gstMode: mode, gstRate: mode === 'None' ? null : Number(rec.gstRate) || 0,
    quoteDate: rec.quoteDate || null, note: rec.note || null };
}
const planOf = (p) => { if (!p) return null; if (typeof p === 'object') return p; try { return JSON.parse(p); } catch { return null; } };
const decisions = (p) => (planOf(p)?.steps || []).flatMap((st) => st.decisions || []);
const skipped = (p) => (planOf(p)?.steps || []).filter((st) => st.skipped).length;
/**
 * The command a changed quotation means: select | decision {value, comment, finish} | send-back {note}; null when nothing the server acts on changed.
 * The app's approval engine records a decision on the plan (or on the old two slots); the server re-checks it and records it itself.
 */
export function quotationCommands(before, after) {
  const out = [];
  if (after.selected && !before.selected && after.kind !== 'Invoice') out.push({ path: 'select' });
  const was = decisions(before.plan); const now = decisions(after.plan);
  if (now.length > was.length) {
    const d = now[now.length - 1];
    out.push({ path: 'decision', body: { value: d.value, comment: d.comment || null, finish: skipped(after.plan) > skipped(before.plan) } });
  } else if (now.length < was.length) out.push({ path: 'decision', body: { value: 'Pending' } });
  else {
    const slot = (r) => `${r.ecApproval || 'Pending'}|${r.finalApproval || 'Pending'}`;
    if (slot(after) !== slot(before)) {
      const value = after.ecApproval !== before.ecApproval ? after.ecApproval : after.finalApproval;
      out.push({ path: 'decision', body: { value: value === 'Approved' || value === 'Rejected' ? value : 'Pending', comment: after.decisionNote || null } });
    }
  }
  if (after.correctionNote && after.correctionNote !== before.correctionNote) out.push({ path: 'send-back', body: { note: after.correctionNote } });
  const fixed = ['kind', 'amount', 'baseAmount', 'gstMode', 'gstRate', 'ticketId'];
  const edited = fixed.filter((k) => k in after && String(after[k] ?? '') !== String(before[k] ?? '') && !(k === 'gstRate' && !Number(after[k]) && !Number(before[k])));
  if (edited.length) throw new Error('The amounts on a quotation or invoice are not edited - remove it and add it again (or send an approved invoice back for correction).');
  return out;
}

// ---- registers served by the resource kit (/v1/{module}/{resource}) -----------------------------------------------------------------------
/**
 * collection -> where it is served and how its fields differ from the app's: rename = { appKey: apiField }; unit = the app's `unit` (a unit
 * number) is the API's unitId; singleton = one row per community (a put changes it). Which fields a write carries comes from the server
 * (GET /v1/meta/resources) - exactly the fields of that resource's request type.
 */
export const RESOURCES = {
  taskTypes: { path: 'maintenance/task-types' },
  categoryMap: { path: 'maintenance/categories' },
  quickPhrases: { path: 'maintenance/quick-phrases' },
  approverSettings: { path: 'maintenance/approver-settings' },
  wishes: { path: 'maintenance/wishes', unit: true },
  serviceNotices: { path: 'maintenance/service-notices' },
  eventWork: { path: 'maintenance/event-work' },
  tradeAvailability: { path: 'maintenance/trade-availability' },
  approvalPolicies: { path: 'finance/approval-policies' },
  amenityTypes: { path: 'amenities/types' },
  amenityItems: { path: 'amenities/items', refs: { amenity: { field: 'amenityTypeId', collection: 'amenityTypes', key: 'name' } } },
  amenitySettings: { path: 'amenities/settings', singleton: true },
  gatePeople: { path: 'gate/people', units: { invitedByUnit: 'invitedByUnitId' } },
  gateLinks: { path: 'gate/household-links', unit: true },
  gateVillaRules: { path: 'gate/unit-rules', unit: true },
  gatePassTemplates: { path: 'gate/pass-templates', unit: true },
  gateVehicles: { path: 'gate/vehicles', unit: true },
  gateWorkOrders: { path: 'gate/work-orders' },
  gateCheckpoints: { path: 'gate/checkpoints' },
  gateRounds: { path: 'gate/rounds' },
  incidents: { path: 'gate/incidents' },
  gateSettings: { path: 'gate/settings', singleton: true, json: ['durations', 'events'] },
  docFolders: { path: 'documents/folders' },
  culturalEvents: { path: 'cultural/events' },
  culturalPrograms: { path: 'cultural/programme' },
  culturalSevas: { path: 'cultural/seva' },
  culturalOfferings: { path: 'cultural/offerings' },
  culturalBrochure: { path: 'cultural/brochure' },
  culturalPhotos: { path: 'cultural/photos' },
  funds: { path: 'finance/funds' },
  bankAccounts: { path: 'finance/bank-accounts' },
  budgetLines: { path: 'finance/budget-lines' },
  fixedExpenses: { path: 'finance/fixed-expenses' },
  deposits: { path: 'finance/deposits' },
  cashCounts: { path: 'finance/cash-counts' },
  importProfiles: { path: 'finance/import-profiles' },
  ledgerSkips: { path: 'finance/ledger-skips' },
  assocBills: { path: 'finance/association-bills', json: ['billFile'] },
  financeSettings: { path: 'finance/settings', rename: { finalCanDecideEC: 'finalCanDecideEc' }, singleton: true },
  importantNumbers: { path: 'comms/important-numbers' },
  numberSections: { path: 'comms/number-sections' },
  mergeFields: { path: 'comms/merge-fields' },
  noticeTemplates: { path: 'comms/notice-templates' },
  notificationTemplates: { path: 'comms/notification-templates' },
  notificationPrefs: { path: 'comms/notification-prefs' },
  notificationSettings: { path: 'comms/notification-settings', singleton: true, json: ['events'], alias: 'default' },
  notificationOutbox: { path: 'comms/outbox', readOnly: true },
};
const invert = (o = {}) => Object.fromEntries(Object.entries(o).map(([k, v]) => [v, k]));
/** A row of the API as the app's record: renamed fields back, nulls as '' (the app's forms expect text), the unit number for a unit id. */
const unitFields = (spec) => ({ ...(spec.unit ? { unit: 'unitId' } : {}), ...(spec.units || {}) });
export function resourceOf(row, spec = {}) {
  const back = invert(spec.rename);
  const out = {};
  for (const [k, v] of Object.entries(row)) out[back[k] || k] = v === null ? '' : v;
  for (const [appKey, apiField] of Object.entries(unitFields(spec))) { out[apiField] = row[apiField] || ''; out[appKey] = row[appKey] || ''; }
  if (spec.alias) { out.serverId = row.id; out.id = spec.alias; }   // the app finds this one row by a fixed id ('default')
  return out;
}
/** The body of a write: exactly `fields` (the resource's request type), from the app's record; '' becomes null, absent stays absent. */
export function resourceBody(rec, spec, fields, unitIdByNo = {}, refIds = {}) {
  const ren = spec.rename || {};
  const appKey = invert(ren);
  const refByField = Object.fromEntries(Object.entries(spec.refs || {}).map(([k, r]) => [r.field, { ...r, appKey: k }]));
  const unitByField = invert(unitFields(spec));
  const body = {};
  for (const f of fields) {
    let v;
    if (refByField[f]) {
      const r = refByField[f]; const shown = rec[r.appKey];
      v = rec[f] || (shown ? (refIds[r.appKey] || {})[shown] : null) || null;
      if (shown && !v) throw new Error(`"${shown}" is not known to the back end.`);
    } else if (unitByField[f]) {
      const no = rec[unitByField[f]];
      v = rec[f] || (no ? unitIdByNo[no] : null) || null;
      if (no && !v) throw new Error(`Unit ${no} is not known to the back end.`);
    } else v = rec[appKey[f] || f];
    if ((spec.json || []).includes(f) && typeof v === 'string') { try { v = v ? JSON.parse(v) : null; } catch { throw new Error(`${f} is not valid JSON.`); } }
    if (v === undefined) continue;
    body[f] = v === '' ? null : v;
  }
  return body;
}
export const isUuid = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);


// ---- amenity bookings -----------------------------------------------------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
/** An instant as the app's local "YYYY-MM-DDTHH:MM:SS" (how the booking screens compare start times). */
export function localStamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}
const day = (iso) => (iso ? String(iso).slice(0, 10) : '');
export function bookingOf(b) {
  return {
    id: b.id, shortId: b.shortId, amenity: b.amenity, amenityTypeId: b.amenityTypeId, unit: b.bookedFor === 'Association' ? `Association · ${b.association}` : (b.unitNo || ''),
    unitId: b.unitId, date: b.date, slot: b.slot, startAt: localStamp(b.startAt), status: b.status, paymentMode: b.paymentMode || '', paymentStatus: b.paymentStatus,
    bookedFor: b.bookedFor, association: b.association || '', rate: num(b.rate) || 0, rateUnit: b.rateUnit || '', qty: 1, baseAmount: num(b.baseAmount) || 0, gstRate: num(b.gstRate) || 0,
    gstAmount: num(b.gstAmount) || 0, gstMode: b.gstMode || '', feeTotal: num(b.feeTotal) || 0, depositAmount: num(b.depositAmount) || 0, totalPayable: num(b.totalPayable) || 0,
    extras: (b.extras || []).length ? JSON.stringify(b.extras) : '', extrasTotal: num(b.extrasTotal) || 0, policySnapshot: (b.policySnapshot || []).map((t) => ({ hoursBefore: num(t.hoursBefore), refundPct: num(t.refundPct) })),
    chargeWaived: !!b.chargeWaived, waivedAmount: num(b.waivedAmount) || 0, waiveReason: b.waiveReason || '', creditApplied: num(b.creditApplied) || 0, paidAmount: num(b.paidAmount) || 0,
    paidAt: day(b.paidAt), paymentRef: b.paymentRef || '', depositStatus: b.depositStatus, refundStatus: b.refundStatus, refundAmount: num(b.refundAmount) || 0,
    cancelReason: b.cancelReason || '', cancelledAt: b.cancelledAt || '', cancelledBy: b.cancelledBy || '', refundPct: num(b.refundPct), refundFeeAmount: num(b.refundFeeAmount),
    depositReturned: num(b.depositReturned), retainedAmount: num(b.retainedAmount), refundTo: b.refundTo || '', refundPaidAt: day(b.refundPaidAt), refundPayoutMode: b.refundPayoutMode || '',
    refundRef: b.refundRef || '', depositDeduction: num(b.depositDeduction), depositDeductionReason: b.depositDeductionReason || '', depositSettledAt: day(b.depositSettledAt),
    depositRefundMode: b.depositRefundMode || '', depositRefundStatus: b.depositRefundStatus || '', depositRefundPaidAt: day(b.depositRefundPaidAt), depositRefundRef: b.depositRefundRef || '',
    feeCorrectedFrom: num(b.feeCorrectedFrom), feeCorrectionReason: b.feeCorrectionReason || '', bookedBy: b.bookedBy || '', owed: num(b.owed) || 0,
    recordCreatedAt: b.createdAt, version: b.version,
  };
}
/** Someone else's booking, as only "this time is taken" (a resident never sees whose it is). */
export function busyOf(t, amenityName, i) {
  const lines = Object.entries(t.items || {}).map(([itemId, qty]) => ({ itemId, qty }));
  return { id: `busy-${t.amenityTypeId}-${t.date}-${t.slot}-${i}`, amenity: amenityName, date: t.date, slot: t.slot, status: 'Confirmed', unit: '', busy: true, extras: i === 0 && lines.length ? JSON.stringify(lines) : '' };
}
/** A new booking: what to book and how it is paid; the server prices it. extras on the app's record is {itemId: qty} (JSON). */
export function bookBody(rec, { amenityIdByName, unitIdByNo }) {
  const amenityTypeId = rec.amenityTypeId || amenityIdByName[rec.amenity];
  if (!amenityTypeId) throw new Error(`"${rec.amenity}" is not known to the back end.`);
  const assoc = rec.bookedFor === 'Association';
  const unitId = assoc ? null : (rec.unitId || unitIdByNo[rec.unit] || null);
  if (!assoc && rec.unit && !unitId) throw new Error(`Unit ${rec.unit} is not known to the back end.`);
  let picks = {};
  try { const p = typeof rec.extras === 'string' && rec.extras ? JSON.parse(rec.extras) : (rec.extras || {}); picks = Array.isArray(p) ? Object.fromEntries(p.map((l) => [l.itemId, l.qty])) : p; } catch { picks = {}; }
  return {
    amenityTypeId, unitId, date: rec.date, slot: rec.slot || null, paymentMode: rec.paymentMode || null, prepaymentId: isUuid(rec.paymentRef) ? rec.paymentRef : null,
    useCredit: !!rec.useCredit, bookedFor: assoc ? 'Association' : 'Unit', association: assoc ? (rec.association || '').trim() : null, freeOfCharge: !!rec.freeOfCharge,
    waiveReason: rec.waiveReason || null, extras: Object.fromEntries(Object.entries(picks).filter(([, q]) => Number(q) > 0).map(([k, q]) => [k, Math.floor(Number(q))])),
  };
}
/** The app's booking actions (_action on the record) -> the command and its body. */
export function bookingCommand(rec) {
  const a = rec._action; const n = (x) => (x === '' || x == null ? null : Number(x));
  switch (a) {
    case 'cancel': return { path: 'cancel', body: { reason: rec.cancelReason || null, refundToCredit: rec.refundTo === 'credit' ? true : rec.refundTo === 'original' ? false : null, waive: !!rec.waive, refundOverride: n(rec.refundOverride) } };
    case 'receive_payment': return { path: 'payment', body: { mode: rec.paymentMode, reference: rec.paymentRef || null } };
    case 'mark_refund_paid': return { path: 'refund-paid', body: { mode: rec.payoutMode || null, reference: rec.paymentRef || null, initiate: !!rec.initiate } };
    case 'refund_to_credit': return { path: 'refund-to-credit', body: {} };
    case 'complete': return { path: 'complete', body: {} };
    case 'settle_deposit': return { path: 'deposit', body: { deduction: n(rec.depositDeduction) || 0, reason: rec.deductionReason || null, payoutMode: rec.payoutMode || null } };
    case 'mark_deposit_paid': return { path: 'deposit-paid', body: { mode: rec.payoutMode || null, reference: rec.paymentRef || null, initiate: !!rec.initiate } };
    case 'adjust_fee': return { path: 'fee', body: { fee: n(rec.newFee), reason: rec.adjustReason || '' } };
    default: return null;
  }
}

// ---- gate ---------------------------------------------------------------------------------------------------------------------------------------
const hhmm = (t) => (t ? String(t).slice(0, 5) : '');
const isoOr = (t) => t || '';
export function gatePassOf(p) {
  return {
    id: p.id, shortId: p.shortId, visitorName: p.visitorName, phone: p.phone || '', unit: p.unitNo || '', unitId: p.unit || '', type: p.type, validFrom: p.validFrom || '', validTo: p.validTo || '',
    fromTime: hhmm(p.fromTime), toTime: hhmm(p.toTime), days: p.days || [], vehicle: p.vehicle || '', guestCap: p.guestCap ?? '', goodsKind: p.goodsKind || '', peopleCount: p.peopleCount ?? '',
    material: p.material || '', carryingOut: !!p.carryingOut, outItems: p.outItems || '', usedCount: p.usedCount || 0, code: p.code, photo: p.photo || '', hostName: p.hostName || '',
    status: p.status, recordCreatedAt: p.createdAt, version: p.version,
  };
}
export function gateVisitOf(v) {
  return {
    id: v.id, shortId: v.shortId, name: v.name, kind: v.kind, unit: v.unitNo || (v.unit ? '' : 'Common area'), unitId: v.unit || '', gate: v.gate || '', company: v.company || '', vehicle: v.vehicle || '',
    phone: v.phone || '', purpose: v.purpose || '', state: v.state, method: v.method || '', inAt: isoOr(v.inAt), outAt: isoOr(v.outAt), expectedUntil: isoOr(v.expectedUntil), photo: v.photo || '',
    personId: v.personId || '', passId: v.passId || '', workOrderId: v.workOrderId || '', approvalId: v.approvalId || '', note: v.note || '', headcountExpected: v.headcountExpected ?? '',
    headcountIn: v.headcountIn ?? '', headcountOut: v.headcountOut ?? '', material: v.material || '', carryingOut: !!v.carryingOut, outItems: v.outItems || '', openReason: v.openReason || '',
    outMethod: v.outMethod || '', verifiedBy: v.verifiedByName || '', version: v.version,
  };
}
export function gateApprovalOf(a) {
  return {
    id: a.id, shortId: a.shortId, name: a.name, unit: a.unitNo || 'Common area', unitId: a.unit || '', company: a.company || '', purpose: a.purpose || '', vehicle: a.vehicle || '', gate: a.gate || '',
    photo: a.photo || '', visitId: a.visitId || '', kind: a.kind || '', status: a.status, requestedAt: isoOr(a.requestedAt), expiresAt: isoOr(a.expiresAt), fallback: a.fallback || '',
    answeredAt: isoOr(a.answeredAt), answeredBy: a.answeredByName || '', alwaysAllow: !!a.alwaysAllow, version: a.version,
  };
}
export function gateFlagOf(f, unitNoById = {}) {
  return {
    id: f.id, shortId: f.shortId, type: f.type, state: f.state, gate: f.gate || '', personName: f.personName || '', unit: f.unit ? (unitNoById[f.unit] || '') : '', detail: f.detail || '',
    raisedAt: isoOr(f.raisedAt), graceUntil: isoOr(f.graceUntil), visitId: f.visitId || '', personId: f.personId || '', photo: f.photo || '', resolution: f.resolution || '',
    resolutionNote: f.resolutionNote || '', resolvedBy: f.resolvedByName || '', resolvedAt: isoOr(f.resolvedAt), roundId: f.roundId || '', day: f.day || '', version: f.version,
  };
}
export const gateScanOf = (s, i) => ({ id: `scan-${s.at}-${i}`, checkpointId: s.checkpointId, checkpointName: s.checkpointName, guard: s.guard, at: s.at, roundId: s.roundId || '', roundName: s.roundName || '', day: s.day, note: s.note || '' });
/** A new pass from the app's record: what the pass is; the code, status and use count are the server's. */
export function passBody(rec, unitIdByNo) {
  const unitId = rec.unitId || (rec.unit ? unitIdByNo[rec.unit] : null) || null;
  if (rec.unit && !unitId) throw new Error(`Unit ${rec.unit} is not known to the back end.`);
  const n = (x) => (x === '' || x == null ? null : Number(x));
  return {
    visitorName: rec.visitorName, phone: rec.phone || null, unitId, type: rec.type || 'One-time', validFrom: rec.validFrom || null, validTo: rec.validTo || null, fromTime: rec.fromTime || null,
    toTime: rec.toTime || null, days: rec.days || [], vehicle: rec.vehicle || null, guestCap: n(rec.guestCap), goodsKind: rec.goodsKind || null, peopleCount: n(rec.peopleCount),
    material: rec.material || null, carryingOut: !!rec.carryingOut, outItems: rec.outItems || null, photo: rec.photo || null,
  };
}

// ---- notifications, notices, forum ----------------------------------------------------------------------------------------------------------------
/** An inbox row (always the reader's own): addressed to them by name, so the app's "is it for me" check holds. */
export function notificationOf(n, myName) {
  return {
    id: n.id, kind: n.kind || n.event, event: n.event, title: n.title, body: n.body || '', link: n.link || '', read: !!n.readAt, readAt: n.readAt || '', createdAt: n.createdAt,
    by: n.sender || '', toName: myName || '', refId: n.refId || '',
  };
}
/** A notice as the app shows it: unit numbers and block names instead of ids; who signed (the committee sees all, a reader only themself). */
export function broadcastOf(b, { unitNoById = {}, blockNameById = {}, myName = '' } = {}) {
  const signed = b.signedBy && b.signedBy.length ? b.signedBy : (b.signedAt && myName ? [myName] : []);
  return {
    id: b.id, shortId: b.shortId, type: b.type, audience: b.audience, subject: b.subject, message: b.message || '',
    audienceUnits: (b.unitIds || []).map((id) => unitNoById[id] || id), audienceBlocks: (b.blockIds || []).map((id) => blockNameById[id] || id),
    eventDate: b.eventDate || '', startTime: b.startTime || '', endTime: b.endTime || '', affects: b.affects || '', pollOptions: b.pollOptions || [], pollMultiple: !!b.pollMultiple,
    pollClosesOn: b.pollClosesOn || '', sentAt: day(b.sentAt), status: b.status, scheduledFor: b.scheduledFor || '', sentBy: b.sentBy || '', recipients: b.recipients, viewed: b.viewed,
    signed: b.signed, pushDelivered: b.pushDelivered, requiresSignature: !!b.requiresSignature, reminderFrequency: b.reminderFrequency || 'None', signedBy: signed.join(', '),
    viewedAt: b.viewedAt || '', signedAt: b.signedAt || '', version: b.version, recordCreatedAt: b.createdAt,
  };
}
/** The notice the app wrote -> the draft the server takes (ids for units and blocks; counts, status and sender are the server's). */
export function broadcastDraft(rec, { unitIdByNo = {}, blockIdByName = {} } = {}) {
  const ids = (xs, map, what) => (xs || []).map((x) => { const id = isUuid(x) ? x : map[x]; if (!id) throw new Error(`${what} ${x} is not known to the back end.`); return id; });
  const selectedUnits = /^Selected (villas|apartments)$/.test(rec.audience || '');
  return {
    type: rec.type || 'Announcement', audience: rec.audience || 'All residents', subject: (rec.subject || '').trim(), message: rec.message || null,
    unitIds: selectedUnits ? ids(rec.audienceUnits, unitIdByNo, 'Unit') : [], blockIds: rec.audience === 'Selected blocks' ? ids(rec.audienceBlocks, blockIdByName, 'Block') : [],
    eventDate: rec.eventDate || null, startTime: rec.startTime || null, endTime: rec.endTime || null, affects: rec.affects || null,
    pollOptions: rec.type === 'Poll' ? (rec.pollOptions || []) : [], pollMultiple: !!rec.pollMultiple, pollClosesOn: rec.pollClosesOn || null,
    requiresSignature: !!rec.requiresSignature, reminderFrequency: rec.reminderFrequency || 'None',
  };
}
const names = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
/** What a change to a notice means, in the order to send: sign, move the maintenance window, edit the draft, send. */
export function broadcastCommands(before, rec, myName) {
  const out = [];
  if (myName && names(rec.signedBy).includes(myName) && !names(before.signedBy).includes(myName)) out.push({ path: 'sign' });
  const timeMoved = ['eventDate', 'startTime', 'endTime'].some((k) => (rec[k] ?? '') !== (before[k] ?? ''));
  if (before.status === 'Sent') {
    if (timeMoved) out.push({ path: 'reschedule', body: { eventDate: rec.eventDate, startTime: rec.startTime, endTime: rec.endTime || null }, versioned: true });
    return out;
  }
  const draftKeys = ['type', 'audience', 'subject', 'message', 'audienceUnits', 'audienceBlocks', 'eventDate', 'startTime', 'endTime', 'affects', 'pollOptions', 'pollMultiple', 'pollClosesOn',
    'requiresSignature', 'reminderFrequency'];
  if (draftKeys.some((k) => JSON.stringify(rec[k] ?? '') !== JSON.stringify(before[k] ?? ''))) out.push({ path: '', draft: true, versioned: true });
  if (rec.status === 'Sent') out.push({ path: 'send', versioned: true });
  return out;
}
/**
 * A poll's answers as the app's vote rows: the committee gets the real rows (who voted what); a reader gets their own unit's row and
 * anonymous rows that add up to the same counts (the server never tells a reader who else voted).
 */
export function pollVoteRows(pollId, result, { voters = null, myName = '', myUnit = '' } = {}) {
  if (voters) return voters.map((v, i) => ({ id: `${pollId}-v${i}`, broadcastId: pollId, voter: v.name || '', unit: v.unitNo || '', choices: v.choices || [] }));
  const rows = [];
  const mine = result.mine || [];
  if (mine.length) rows.push({ id: `${pollId}-mine`, broadcastId: pollId, voter: result.mineBy || myName, unit: myUnit, choices: mine });
  const others = result.total - (mine.length ? 1 : 0);
  const left = (result.counts || []).map((n, i) => n - (mine.includes(String(i)) ? 1 : 0));
  for (let r = 0; r < others; r += 1) rows.push({ id: `${pollId}-o${r}`, broadcastId: pollId, voter: '', unit: '—', choices: [] });
  left.forEach((n, i) => { for (let k = 0; k < n && others > 0; k += 1) rows[(mine.length ? 1 : 0) + (k % others)].choices.push(String(i)); });
  return rows;
}
/** A forum topic as the app shows it; a poll carries its counts and whether the reader has voted. */
export function topicOf(t, result = null, myName = '') {
  return {
    id: t.id, shortId: t.shortId, title: t.title, category: t.category, kind: t.kind, replies: t.replies, pinned: !!t.pinned, status: t.status, author: t.author || '',
    authorId: t.authorId || '', lastPostAt: t.lastPostAt || '', createdAt: t.createdAt, version: t.version,
    ...(t.kind === 'Poll' ? { pollOptions: (t.pollOptions || []).map((label, i) => ({ label, votes: result?.counts?.[i] || 0 })), voters: result?.mine?.length ? [myName] : [] } : {}),
  };
}
export function postOf(p) {
  return {
    id: p.id, shortId: p.shortId, topicId: p.topicId, parentId: p.parentId || '', author: p.author || '', authorRoleId: p.authorRole || '', body: p.hidden && !p.body ? '' : p.body,
    hidden: !!p.hidden, hiddenReason: p.hiddenReason || '', reactions: p.reactions || 0, createdAt: p.createdAt, editedAt: p.editedAt || '', version: p.version,
  };
}

// ---- files and documents ------------------------------------------------------------------------------------------------------------------------
/** A file as the app's attachment list shows it. 'Pending' = passed the server's checks, not virus-scanned (no scanner configured). */
export const fileMeta = (f) => ({ fileId: f.id, name: f.fileName, size: f.sizeBytes, mime: f.mimeType, scanStatus: f.scanStatus === 'Clean' ? 'Clean' : f.scanStatus === 'Pending' ? 'Checked' : f.scanStatus });
/** The app's FILES row (bytes as a data URL). */
export const fileRowOf = (f, dataUrl = '') => ({ id: f.id, shortId: f.shortId, name: f.fileName, mime: f.mimeType, size: f.sizeBytes, scanStatus: f.scanStatus, ownerType: f.ownerType, ownerId: f.ownerId || '', dataUrl, hasContent: true, version: f.version });
/** data: URL -> its bytes and type (no network). */
export function dataUrlBytes(url) {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(String(url || ''));
  if (!m) throw new Error('The file has no content.');
  const raw = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
  const bytes = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return { bytes, mime: m[1] || 'application/octet-stream' };
}
export function bytesDataUrl(buf, mime) {
  const b = new Uint8Array(buf); let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return `data:${mime};base64,${btoa(s)}`;
}
/** A document as the app shows it. The app's "version" is the document's own label (edition); the record's version is kept as rowVersion. */
export function documentOf(d) {
  return {
    id: d.id, shortId: d.shortId, title: d.title, category: d.category || '', version: d.edition || '', access: d.access, unit: d.unitNo || '', unitId: d.unitId || '',
    expiry: d.expiry || '', folderId: d.folderId || '', fileId: d.fileId || '', fileName: d.fileName || '', fileSize: d.fileSize ? Math.ceil(d.fileSize / 1024) : 0, mime: d.mimeType || '',
    scanStatus: d.scanStatus === 'Clean' ? 'Clean (server scan)' : 'Passed server checks', uploadedBy: d.uploadedBy || '', recordCreatedAt: d.createdAt, lastUpdatedAt: d.updatedAt, rowVersion: d.version,
  };
}
export function documentBody(rec, unitIdByNo = {}) {
  const unitId = rec.unitId || (rec.unit ? unitIdByNo[rec.unit] : null) || null;
  if (rec.unit && !unitId) throw new Error(`Unit ${rec.unit} is not known to the back end.`);
  return { title: rec.title, category: rec.category || null, edition: rec.version ? String(rec.version) : null, access: rec.access || 'Everyone', unitId, expiry: rec.expiry || null, folderId: isUuid(rec.folderId) ? rec.folderId : null };
}

// ---- cultural: donations, expenses, sign-ups ----------------------------------------------------------------------------------------------------
export function donationOf(d) {
  return {
    id: d.id, shortId: d.shortId, eventId: d.eventId, donor: d.donor, unit: d.unitNo || '', unitId: d.unitId || '', kind: d.kind, towards: d.towards || 'General', amount: num(d.amount),
    date: d.date || '', mode: d.mode || '', reference: d.reference || '', status: d.status, receiptNo: d.receiptNo || '', offeringId: d.offeringId || '', phone: d.phone || '',
    members: d.members || '', sankalpam: d.sankalpam || '', anonymous: !!d.anonymous, note: d.note || '', receivedBy: d.receivedBy || '', gatewayRef: d.mode === 'Online' ? (d.paymentId || '') : '',
    recordCreatedAt: d.createdAt, version: d.version,
  };
}
export function donationBody(rec, unitIdByNo = {}) {
  const unitId = rec.unitId || (rec.unit ? unitIdByNo[rec.unit] : null) || null;
  if (rec.unit && !unitId && rec.unit !== '—') throw new Error(`Unit ${rec.unit} is not known to the back end.`);
  const n = (x) => (x === '' || x == null ? null : Number(x));
  return {
    eventId: rec.eventId, donor: rec.donor || null, unitId, kind: rec.kind || 'Donation', towards: rec.towards || 'General', amount: n(rec.amount), date: rec.date || null, mode: rec.mode || null,
    reference: rec.reference || null, anonymous: !!rec.anonymous, note: rec.note || null, phone: rec.phone || null, members: rec.members || null, sankalpam: rec.sankalpam || null,
    offeringId: isUuid(rec.offeringId) ? rec.offeringId : null,
  };
}
const day10 = (t) => (t ? String(t).slice(0, 10) : '');
export function expenseOf(x) {
  let plan = '';
  try { plan = x.plan ? JSON.stringify(legacyPlan(typeof x.plan === 'string' ? JSON.parse(x.plan) : x.plan)) : ''; } catch { plan = ''; }
  return {
    id: x.id, shortId: x.shortId, eventId: x.eventId, item: x.item, category: x.category || '', vendor: x.vendor || '', amount: num(x.amount) ?? '', estimate: num(x.estimate) ?? '',
    date: x.date || '', status: x.status, fund: x.fund || '', plan, note: x.note || '', ecApproval: x.ecApproval || 'Pending', ecApprovedBy: x.ecApprovedBy || '', ecApprovedAt: day10(x.ecApprovedAt),
    ecNote: x.ecNote || '', finalRequired: x.finalRequired ?? null, approvedBy: x.approvedBy || '', approvedAt: day10(x.approvedAt), approvalNote: x.approvalNote || '', paidBy: x.paidBy || '',
    recordCreatedBy: x.raisedBy || '', canDecide: !x.whyNotMe, whyNotMe: x.whyNotMe || '', attachments: [], version: x.version,
  };
}
export const expenseBody = (r) => ({ item: r.item, category: r.category || null, vendor: r.vendor || null, amount: r.amount === '' || r.amount == null ? null : Number(r.amount),
  estimate: r.estimate === '' || r.estimate == null ? null : Number(r.estimate), date: r.date || null, fund: r.fund || null, note: r.note || null });
/** A change to an expense: its fields (a PUT - also how a rejected one is sent again), a decision found on the plan or the slots, paying. */
export function expenseCommands(before, after) {
  const out = [];
  const keys = ['item', 'category', 'vendor', 'amount', 'estimate', 'date', 'fund', 'note'];
  const edited = keys.some((k) => String(after[k] ?? '') !== String(before[k] ?? ''));
  const resubmit = before.status === 'Rejected' && after.status === 'Pending approval';
  if (edited || resubmit) out.push({ path: '', put: true });
  if (!resubmit) {
    const was = decisions(before.plan); const now = decisions(after.plan);
    if (now.length > was.length) { const d = now[now.length - 1]; out.push({ path: 'decision', body: { value: d.value, comment: d.comment || null, finish: skipped(after.plan) > skipped(before.plan) } }); }
    else if (now.length < was.length) out.push({ path: 'decision', body: { value: 'Pending' } });
    else if (now.length === was.length && (after.ecApproval || 'Pending') !== (before.ecApproval || 'Pending') && ['Approved', 'Rejected'].includes(after.ecApproval)) {
      out.push({ path: 'decision', body: { value: after.ecApproval, comment: after.ecNote || null, finish: after.finalRequired === false } });
    } else if (now.length === was.length && after.status !== before.status && ['Approved', 'Rejected'].includes(after.status) && before.status === 'Pending approval') {
      out.push({ path: 'decision', body: { value: after.status, comment: after.approvalNote || null } });
    }
  }
  if (after.status === 'Paid' && before.status !== 'Paid') out.push({ path: 'pay', body: { mode: after.paidMode || null } });
  return out;
}
/** A sign-up list as the app keeps it (name, unit, people), keeping the member id for removing someone. */
export const signupsOf = (list) => (list || []).map((x) => ({ name: x.name, unit: x.unit || '', phone: '', membershipId: x.membershipId, ...(x.people ? { people: x.people } : {}) }));

// ---- finance: the cash book, releases, pay requests, bank lines ---------------------------------------------------------------------------------
const n2 = (x) => (x === '' || x == null ? null : Number(x));
export function ledgerOf(e) {
  return {
    id: e.id, shortId: e.shortId, date: e.date, account: e.account || '', description: e.description, category: e.category || '', subCategory: e.subCategory || '', type: e.type,
    amount: num(e.amount), vendor: e.vendor || '', taskRef: e.taskRef || '', noTask: e.noTask || '', module: e.module || '', sourceType: e.sourceType || '', sourceLabel: e.sourceLabel || '',
    sourceId: e.sourceId || '', mode: e.mode || '', ref: e.ref || '', unit: e.unitNo || '', unitId: e.unitId || '', bookingNo: e.bookingNo || '', invoiceNo: e.invoiceNo || '', billNo: e.billNo || '',
    baseAmount: num(e.baseAmount) ?? '', gstRate: num(e.gstRate) ?? '', gstAmount: num(e.gstAmount) || 0, tdsSection: e.tdsSection || '', tdsRate: num(e.tdsRate) ?? '', tdsAmount: num(e.tdsAmount) || 0,
    fund: e.fund || '', itcStatus: e.itcStatus || '', itcNote: e.itcNote || '', internal: !!e.internal, reversalOf: e.reversalOf || '', reason: e.reason || '', reconStatus: e.reconStatus,
    bankTxnId: e.bankTxnId || '', recordCreatedBy: e.enteredBy || '', recordCreatedAt: e.createdAt, attachments: [], version: e.version,
  };
}
/** The cash book entry the server takes (taxes and the bank amount are worked out there when a base is given). */
export function ledgerBody(r, unitIdByNo = {}) {
  const unitId = r.unitId || (r.unit ? unitIdByNo[r.unit] : null) || null;
  return {
    date: r.date, account: r.account || null, description: r.description, category: r.category || null, subCategory: r.subCategory || null, type: r.type || 'Debit', amount: n2(r.amount),
    vendor: r.vendor || null, taskRef: r.taskRef || null, noTask: r.noTask || null, module: r.module || null, sourceType: r.sourceType || null, sourceLabel: r.sourceLabel || null,
    sourceId: isUuid(r.sourceId) ? r.sourceId : null, mode: r.mode || null, ref: r.ref || null, unitId, bookingNo: r.bookingNo || null, invoiceNo: r.invoiceNo || null, billNo: r.billNo || null,
    baseAmount: n2(r.baseAmount), gstRate: n2(r.gstRate), tdsSection: r.tdsSection || null, tdsRate: n2(r.tdsRate), fund: r.fund || null, itcStatus: r.itcStatus || null, itcNote: r.itcNote || null,
  };
}
/** Lines the server books itself (bill payments, bookings, donations): the app writing them again on v2 would count the money twice. */
export const bookedByServer = (r) => /^(due|amenity|booking|donation|payment):/.test(String(r.sourceId || '')) || ['duePayment', 'booking', 'donation'].includes(r.sourceType);
export function releaseOf(r) {
  let plan = '';
  try { plan = r.plan ? JSON.stringify(legacyPlan(typeof r.plan === 'string' ? JSON.parse(r.plan) : r.plan)) : ''; } catch { plan = ''; }
  return {
    id: r.id, shortId: r.shortId, ticketId: r.ticketId || '', ticketShortId: r.ticketShortId || '', expenseId: r.expenseId || '', kind: r.kind, amount: num(r.amount), vendor: r.vendor || '',
    note: r.note || '', status: r.status, cancelReason: r.cancelReason || '', requestedBy: r.raisedBy || '', recordCreatedBy: r.raisedBy || '', settled: r.status === 'Paid', plan,
    paidEntryId: r.paidEntryId || '', canDecide: !r.whyNotMe, whyNotMe: r.whyNotMe || '', recordCreatedAt: r.createdAt, version: r.version,
  };
}
export function releaseCommands(before, after) {
  const out = [];
  if (after.status === 'Cancelled' && before.status !== 'Cancelled') return [{ path: 'cancel', body: { reason: after.cancelReason || after.reason || '' } }];
  const resubmit = before.status === 'Rejected' && after.status === 'Waiting approval';
  const edited = ['kind', 'amount', 'vendor', 'note'].some((k) => String(after[k] ?? '') !== String(before[k] ?? ''));
  if (resubmit || edited) out.push({ put: true });
  if (!resubmit) {
    const was = decisions(before.plan); const now = decisions(after.plan);
    if (now.length > was.length) { const d = now[now.length - 1]; out.push({ path: 'decision', body: { value: d.value, comment: d.comment || null, finish: skipped(after.plan) > skipped(before.plan) } }); }
    else if (now.length < was.length) out.push({ path: 'decision', body: { value: 'Pending' } });
  }
  if (after.status === 'Paid' && before.status === 'Approved') out.push({ path: 'pay', body: { mode: after.mode || null, ref: after.ref || null } });
  return out;
}
export const payRequestOf = (p) => ({ id: p.id, shortId: p.shortId, description: p.description, amount: num(p.amount), vendor: p.vendor || '', requestedBy: p.requestedBy || '', status: p.status,
  decidedBy: p.decidedBy || '', decisionNote: p.decisionNote || '', payload: p.payload || '', entryId: p.entryId || '', recordCreatedAt: p.createdAt, version: p.version });
export const bankTxnOf = (l) => ({ id: l.id, shortId: l.shortId, date: l.date, account: l.account, narration: l.narration || '', head: l.head || '', debit: num(l.debit) || 0, credit: num(l.credit) || 0,
  balance: num(l.balance) ?? '', party: l.party || '', remarks: l.remarks || '', matchedLedgerId: l.matchedEntryId || '', version: l.version });

// ---- governance: meetings and e-voting ----------------------------------------------------------------------------------------------------------
export const meetingOf = (m) => ({ id: m.id, shortId: m.shortId, title: m.title, committee: m.committee, date: m.date, startTime: hhmm(m.startTime), endTime: hhmm(m.endTime),
  location: m.location || '', status: m.status, visibility: m.visibility, publishedAt: m.publishedAt || '', agenda: m.agenda || '', minutes: m.minutes || '', minutesAt: m.minutesAt || '',
  cancelReason: m.cancelReason || '', agendaFiles: [], minutesFiles: [], recordCreatedAt: m.createdAt, version: m.version });
const blankHtml = (s) => !s || !String(s).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
export const meetingBody = (r) => ({ title: r.title, committee: r.committee, date: r.date, startTime: r.startTime || null, endTime: r.endTime || null, location: r.location || null,
  status: r.status || null, visibility: r.visibility || null, agenda: blankHtml(r.agenda) ? null : r.agenda, minutes: blankHtml(r.minutes) ? null : r.minutes, cancelReason: r.cancelReason || null });
/** A ballot as the e-voting screen shows it. `roll` is the frozen roll (one entry per unit; owner names only where the server shows them). The server says
 *  whether the reader may vote (`whyNotMe`, '' = yes) and for which unit (`myUnits`). */
export const ballotOf = (b, roll = []) => ({ id: b.id, shortId: b.shortId, title: b.title, description: b.description || '', kind: b.kind, options: b.options || [], opensOn: b.opensOn, closesOn: b.closesOn,
  quorumPct: num(b.quorumPct) ?? 0, passPct: num(b.passPct) ?? 50, status: b.status, rollHash: b.rollHash || '', roll: roll.map((e) => ({ unit: e.unitNo, owners: e.owners || [], phoneLast4: e.phoneLast4 || '' })),
  openedAt: b.openedAt || '', closedAt: b.closedAt || '', chainHead: b.chainHead || '', votesCounted: b.votesCounted ?? '', votesCast: b.votesCast || 0, meetingId: b.meetingId || '',
  whyNotMe: b.whyNotMe || '', myUnits: (b.myUnits || []).map((u) => ({ unitId: u.unitId, unit: u.unitNo, voted: !!u.voted, whyNot: u.whyNot || '' })), outcome: b.results?.outcome || '', version: b.version });
export const ballotBody = (r) => ({ title: r.title, description: blankHtml(r.description) ? null : r.description, kind: r.kind || 'Resolution', options: (r.options || []).map((o) => String(o).trim()).filter(Boolean),
  opensOn: r.opensOn, closesOn: r.closesOn, quorumPct: num(r.quorumPct) ?? null, passPct: num(r.passPct) ?? null, meetingId: isUuid(r.meetingId) ? r.meetingId : null });
/** Which units voted (from the roll): the voter's name only where the server gives it. */
export const voteMarksOf = (ballotId, roll) => roll.filter((e) => e.voted).map((e) => ({ id: `${ballotId}-${e.unitId}`, ballotId, unit: e.unitNo, owner: e.votedBy || '', markedOn: e.markedOn || '' }));
export const boxRowOf = (ballotId, r) => ({ id: `${ballotId}-${r.seq}`, ballotId, seq: r.seq, receipt: r.receipt, choice: r.choice, prevHash: r.prevHash, hash: r.hash });
/** The unit a vote is for: the signed-in unit when it is one of mine on this ballot, else my only one. */
export const voteUnit = (ballot, unitNo) => (ballot?.myUnits || []).find((u) => u.unit === unitNo)?.unitId || ((ballot?.myUnits || []).length === 1 ? ballot.myUnits[0].unitId : null);
