// Coarse, module-level capability flags - "can this role see/do X at all".
// Distinct from the per-field viewableBy/editableBy in schema/registry.js,
// which is finer-grained ("can this role edit THIS field of THIS section").
// Nav visibility and cross-cutting actions (forum moderation, audit access,
// role management) key off these; field-level editing keys off the schema.
export const PERMISSIONS = [
  { id: 'MANAGE_ROLES', label: 'Manage roles & permissions' },
  { id: 'MANAGE_USERS', label: 'Manage users' },
  { id: 'MANAGE_UNITS', label: 'Manage units directory' },
  { id: 'MANAGE_DOCUMENTS', label: 'Manage documents' },
  { id: 'MANAGE_CULTURAL', label: 'Manage cultural events, donations & expenses' },
  { id: 'MANAGE_DUES', label: 'Manage dues' },
  { id: 'MANAGE_LEDGER', label: 'Manage accounting / ledger' },
  { id: 'MANAGE_AMENITIES', label: 'Manage amenities (bookings, payments, refunds, deposits)' },
  { id: 'MANAGE_AMENITY_RATES', label: 'Change amenity rates, GST, deposits & cancellation rules' },
  { id: 'MANAGE_AMENITY_RULES', label: 'Edit amenity rules & regulations' },
  { id: 'MANAGE_NOTIFICATIONS', label: 'Edit notification templates, recipients & reports' },
  { id: 'MANAGE_TICKETS', label: 'Manage maintenance tickets' },
  { id: 'SET_FINANCIAL_FLAG', label: 'Mark a task as involving a financial transaction (default: EC and Super Admin)' },
  { id: 'MANAGE_TICKET_TYPES', label: 'Manage ticket categories' },
  { id: 'MANAGE_VENDORS', label: 'Manage vendors' },
  { id: 'MODERATE_FORUM', label: 'Moderate forum' },
  { id: 'MANAGE_FIELD_DUTIES', label: 'Manage field-staff duties' },
  { id: 'VIEW_AUDIT_LOG', label: 'View audit log' },
  { id: 'MANAGE_UTILITY_BILLING', label: 'Manage utility billing' },
  { id: 'MANAGE_UTILITY_TYPES', label: 'Add / edit utility types (water, DG, gas, …) and custom logs' },
  { id: 'MANAGE_UTILITY_READINGS', label: 'Record & publish water / DG meter readings' },
  { id: 'MANAGE_NOTICE_TEMPLATES', label: 'Manage notice templates' },
  { id: 'MANAGE_SECURITY', label: 'Manage security & visitors' },
  { id: 'MANAGE_GOVERNANCE', label: 'Manage governance & committees' },
];

export const CATEGORIES = ['EC', 'Staff', 'Resident'];

const ALL_PERMS = PERMISSIONS.map((p) => p.id);
const NONE = [];

/** Permission groups. A group is a named bundle of default permissions plus an access level (EC / Staff / Resident - what data the
 * members can see). A role joins one group, inherits its permissions, and can then add or remove individual permissions
 * (role.addedPermissions / role.removedPermissions). Super Admin manages groups and roles in Roles & Permissions. */
export const DEFAULT_GROUPS = [
  { id: 'grp_ec', name: 'Executive Committee', category: 'EC', description: 'Elected committee members', permissions: ['MODERATE_FORUM', 'VIEW_AUDIT_LOG', 'SET_FINANCIAL_FLAG'] },
  { id: 'grp_staff', name: 'Staff', category: 'Staff', description: 'Facility and field staff', permissions: ['MANAGE_UTILITY_READINGS'] },
  { id: 'grp_resident', name: 'Residents', category: 'Resident', description: 'Owners and residents', permissions: [] },
];
export const groupIdForCategory = (c) => (DEFAULT_GROUPS.find((g) => g.category === c) || DEFAULT_GROUPS[2]).id;
/** What a role really holds = the group's permissions + the role's additions - the role's removals. */
export function effectivePermissions(groupPerms = [], role = {}) {
  const set = new Set([...(groupPerms || []), ...(role.addedPermissions || [])]);
  (role.removedPermissions || []).forEach((p) => set.delete(p));
  return [...set];
}
/** Turn a plain permission list into overrides against a group (used to migrate roles created before groups existed). */
export function overridesFor(groupPerms = [], perms = []) {
  return { addedPermissions: perms.filter((p) => !groupPerms.includes(p)), removedPermissions: groupPerms.filter((p) => !perms.includes(p)) };
}

/** Seeded on first run into the ROLES collection; Super Admin can edit or
 * add to this afterwards - this is just the starting data. */
const BASE_ROLES = [
  { id: 'super_admin', name: 'Super Admin', category: 'EC', permissions: ALL_PERMS },
  { id: 'president', name: 'President', category: 'EC', permissions: ['MANAGE_CULTURAL', 'MANAGE_GOVERNANCE', 'MANAGE_DOCUMENTS', 'MODERATE_FORUM', 'VIEW_AUDIT_LOG', 'MANAGE_AMENITY_RATES', 'MANAGE_AMENITY_RULES', 'MANAGE_NOTIFICATIONS'] },
  { id: 'general_secretary', name: 'General Secretary', category: 'EC', permissions: ['MANAGE_CULTURAL', 'MANAGE_GOVERNANCE', 'MANAGE_DOCUMENTS', 'MANAGE_NOTICE_TEMPLATES', 'MODERATE_FORUM', 'MANAGE_UNITS', 'VIEW_AUDIT_LOG', 'MANAGE_AMENITY_RULES', 'MANAGE_NOTIFICATIONS'] },
  { id: 'treasurer', name: 'Treasurer', category: 'EC', permissions: ['MANAGE_DUES', 'MANAGE_LEDGER', 'MANAGE_UTILITY_BILLING', 'MANAGE_VENDORS', 'VIEW_AUDIT_LOG', 'MANAGE_AMENITY_RATES'] },
  { id: 'committee_landscape', name: 'Landscape Committee', category: 'EC', permissions: ['MANAGE_VENDORS'] },
  { id: 'committee_electrical', name: 'Electrical Committee', category: 'EC', permissions: ['MANAGE_VENDORS', 'MANAGE_UTILITY_BILLING'] },
  { id: 'committee_security', name: 'Security Committee', category: 'EC', permissions: ['MANAGE_SECURITY'] },
  { id: 'committee_cultural', name: 'Cultural Committee', category: 'EC', permissions: ['MODERATE_FORUM', 'MANAGE_DOCUMENTS', 'MANAGE_CULTURAL', 'MANAGE_NOTIFICATIONS'] },
  { id: 'committee_amenities', name: 'Amenities Committee', category: 'EC', permissions: ['MANAGE_AMENITIES', 'MANAGE_AMENITY_RATES', 'MANAGE_AMENITY_RULES', 'MANAGE_NOTIFICATIONS'] },
  { id: 'facility_manager', name: 'Facility Manager', category: 'Staff', permissions: ['MANAGE_TICKETS', 'MANAGE_TICKET_TYPES', 'MANAGE_FIELD_DUTIES', 'MANAGE_UTILITY_BILLING', 'MANAGE_UTILITY_READINGS', 'MANAGE_VENDORS', 'MANAGE_AMENITIES', 'MANAGE_AMENITY_RULES', 'MANAGE_UNITS'] },
  { id: 'helpdesk', name: 'Helpdesk', category: 'Staff', permissions: ['MANAGE_UTILITY_READINGS'] },
  { id: 'handyman_plumbing', name: 'Handyman · Plumbing', category: 'Staff', permissions: NONE },
  { id: 'handyman_electrical', name: 'Handyman · Electrical', category: 'Staff', permissions: NONE },
  { id: 'handyman_security', name: 'Handyman · Security', category: 'Staff', permissions: ['MANAGE_SECURITY'] },
  { id: 'handyman_mep', name: 'Handyman · MEP', category: 'Staff', permissions: ['MANAGE_UTILITY_READINGS'] },
  { id: 'handyman_general', name: 'Handyman · General', category: 'Staff', permissions: NONE },
  { id: 'owner', name: 'Owner', category: 'Resident', permissions: NONE },
  { id: 'resident', name: 'Resident', category: 'Resident', permissions: NONE },
];

export const DEFAULT_ROLES = BASE_ROLES.map((r) => {
  const gp = DEFAULT_GROUPS.find((g) => g.id === groupIdForCategory(r.category)).permissions;
  return { ...r, groupId: groupIdForCategory(r.category), ...overridesFor(gp, r.permissions) };
});

export const HANDYMAN_ROLE_IDS = DEFAULT_ROLES.filter((r) => r.id.startsWith('handyman_')).map((r) => r.id);

export function isSuperAdmin(roleId) {
  return roleId === 'super_admin';
}

export function hasPermission(role, permissionId) {
  return !!role?.permissions?.includes(permissionId);
}
