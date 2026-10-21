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
    orderId: o.id, shortId: o.shortId, amount: num(o.amount), currency: o.currency, status: o.status, provider: o.provider, unitId: o.unitId,
    refs: o.items.map((i) => i.dueId), providerOrderRef: o.checkout?.providerOrderRef || null, checkout: o.checkout || {}, expiresAt: o.expiresAt,
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
  };
}
/** Fields a ticket edit may send (PATCH); the commands (assign, status, rating, me-too) are separate. */
export const TICKET_EDIT = ['title', 'description', 'category', 'subCategory', 'priority', 'location', 'preferredTime', 'slaDueAt', 'awaitingParts', 'materialsCost', 'financial', 'workDone'];
/** The financial workflow - quotations, invoices, approvals - comes with the next maintenance step on v2. */
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
export const categoryOf = (c) => ({ id: c.id, category: c.category, subCategories: c.subCategories || [], coordinator: c.coordinatorRoles || [], assetLink: c.assetLink || '', notes: c.notes || '', vendor: '' });
export const phraseOf = (p) => ({ id: p.id, phrase: p.phrase, category: p.category });
