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
  financeSettings: { path: 'finance/settings', rename: { finalCanDecideEC: 'finalCanDecideEc' }, singleton: true },
};
const invert = (o = {}) => Object.fromEntries(Object.entries(o).map(([k, v]) => [v, k]));
/** A row of the API as the app's record: renamed fields back, nulls as '' (the app's forms expect text), the unit number for a unit id. */
export function resourceOf(row, spec = {}) {
  const back = invert(spec.rename);
  const out = {};
  for (const [k, v] of Object.entries(row)) out[back[k] || k] = v === null ? '' : v;
  if (spec.unit) { out.unitId = row.unitId || ''; out.unit = row.unit || ''; }
  return out;
}
/** The body of a write: exactly `fields` (the resource's request type), from the app's record; '' becomes null, absent stays absent. */
export function resourceBody(rec, spec, fields, unitIdByNo = {}, refIds = {}) {
  const ren = spec.rename || {};
  const appKey = invert(ren);
  const refByField = Object.fromEntries(Object.entries(spec.refs || {}).map(([k, r]) => [r.field, { ...r, appKey: k }]));
  const body = {};
  for (const f of fields) {
    let v;
    if (refByField[f]) {
      const r = refByField[f]; const shown = rec[r.appKey];
      v = rec[f] || (shown ? (refIds[r.appKey] || {})[shown] : null) || null;
      if (shown && !v) throw new Error(`"${shown}" is not known to the back end.`);
    } else if (spec.unit && f === 'unitId') {
      v = rec.unitId || (rec.unit ? unitIdByNo[rec.unit] : null) || null;
      if (rec.unit && !v) throw new Error(`Unit ${rec.unit} is not known to the back end.`);
    } else v = rec[appKey[f] || f];
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
