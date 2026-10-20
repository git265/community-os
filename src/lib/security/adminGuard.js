import { getPrincipal } from './principal.js';
import { AuthzError, isAdmin } from './authz.js';
import { logChange } from '../audit/auditLog.js';

/** Throws unless the caller holds `permission` (Super Admin always passes). */
export function requirePermission(permission) {
  const p = getPrincipal();
  if (!p) throw new AuthzError('Not signed in');
  if (!isAdmin(p) && !p.role?.permissions?.includes(permission)) throw new AuthzError(`Requires permission: ${permission}`);
  return p;
}

/** Audit helper for the admin stores (roles / schema) that bypass useCollection. */
export async function auditAdmin({ what, recordId, action, summary, changes = [] }) {
  const p = getPrincipal();
  if (!p) return;
  const label = p.name === p.role?.name ? p.name : `${p.name} (${p.role?.name ?? p.roleId})`;
  await logChange({ who: label, whoName: p.name, what, collection: what, recordId, unit: '', action, summary, changes });
}
