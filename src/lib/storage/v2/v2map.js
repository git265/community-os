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
