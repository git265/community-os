import { storage, COLLECTIONS } from '../storage/index.js';
import { DEFAULT_ROLES, DEFAULT_GROUPS, groupIdForCategory, effectivePermissions, overridesFor } from './roles.js';
import { requirePermission, auditAdmin } from '../security/adminGuard.js';
import { getPrincipal } from '../security/principal.js';

export async function loadGroups() {
  const stored = await storage.list(COLLECTIONS.ROLE_GROUPS);
  if (stored.length > 0) return stored;
  for (const g of DEFAULT_GROUPS) await storage.put(COLLECTIONS.ROLE_GROUPS, g);
  return DEFAULT_GROUPS;
}

export async function loadRoles() {
  const stored = await storage.list(COLLECTIONS.ROLES);
  if (stored.length === 0) {
    await loadGroups();
    for (const role of DEFAULT_ROLES) await storage.put(COLLECTIONS.ROLES, role);
    return DEFAULT_ROLES;
  }
  // communities created before permission groups: put every role in the group of its access level, keeping exactly the permissions it had
  if (stored.some((r) => !r.groupId)) {
    const groups = await loadGroups();
    const out = [];
    for (const r of stored) {
      if (r.groupId) { out.push(r); continue; }
      const gid = groupIdForCategory(r.category);
      const gp = groups.find((g) => g.id === gid)?.permissions || [];
      const next = { ...r, groupId: gid, ...overridesFor(gp, r.permissions || []) };
      await storage.put(COLLECTIONS.ROLES, next);
      out.push(next);
    }
    return out;
  }
  return stored;
}

/** Saves a group and re-applies it to every role in it (their additions / removals are kept). */
export async function putGroup(group) {
  requirePermission('MANAGE_ROLES');
  const old = group.id ? await storage.get(COLLECTIONS.ROLE_GROUPS, group.id) : null;
  const saved = await storage.put(COLLECTIONS.ROLE_GROUPS, { ...group, id: group.id || `grp_${group.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${Date.now().toString(36)}`, lastUpdatedAt: new Date().toISOString(), lastUpdatedBy: getPrincipal()?.name });
  const roles = (await storage.list(COLLECTIONS.ROLES)).filter((r) => r.groupId === saved.id);
  for (const r of roles) {
    if (r.id === 'super_admin') continue;
    await storage.put(COLLECTIONS.ROLES, { ...r, category: saved.category, permissions: effectivePermissions(saved.permissions, r) });
  }
  const before = old?.permissions ?? []; const after = saved.permissions ?? [];
  const changes = [];
  const added = after.filter((x) => !before.includes(x)); const removed = before.filter((x) => !after.includes(x));
  if (added.length) changes.push({ field: 'permissions+', label: 'Group permissions added', from: '—', to: added.join(', ') });
  if (removed.length) changes.push({ field: 'permissions-', label: 'Group permissions removed', from: removed.join(', '), to: '—' });
  if (old && old.name !== saved.name) changes.push({ field: 'name', label: 'Group name', from: old.name, to: saved.name });
  if (old && old.category !== saved.category) changes.push({ field: 'category', label: 'Access level', from: old.category, to: saved.category });
  await auditAdmin({ what: 'Roles & Permissions', recordId: saved.id, action: old ? 'Update' : 'Create', summary: `Group: ${saved.name}`, changes });
  return saved;
}

export async function deleteGroup(id) {
  requirePermission('MANAGE_ROLES');
  const used = (await storage.list(COLLECTIONS.ROLES)).filter((r) => r.groupId === id);
  if (used.length) throw new Error(`${used.length} role${used.length === 1 ? ' is' : 's are'} still in this group. Move them to another group first.`);
  const old = await storage.get(COLLECTIONS.ROLE_GROUPS, id);
  await storage.remove(COLLECTIONS.ROLE_GROUPS, id);
  await auditAdmin({ what: 'Roles & Permissions', recordId: id, action: 'Delete', summary: `Group: ${old?.name ?? id}` });
}

export async function putRole(role) {
  requirePermission('MANAGE_ROLES');
  const old = role.id ? await storage.get(COLLECTIONS.ROLES, role.id) : null;
  // a role in a group holds the group's permissions + its own additions - its own removals; the group also fixes its access level
  if (role.groupId && role.id !== 'super_admin') {
    const g = await storage.get(COLLECTIONS.ROLE_GROUPS, role.groupId);
    if (g) role = { ...role, category: g.category, permissions: effectivePermissions(g.permissions, role) };
  }
  const saved = await storage.put(COLLECTIONS.ROLES, {
    ...role,
    lastUpdatedAt: new Date().toISOString(),
    lastUpdatedBy: getPrincipal()?.name,
  });
  const before = old?.permissions ?? [];
  const after = role.permissions ?? [];
  const changes = [];
  const added = after.filter((x) => !before.includes(x));
  const removed = before.filter((x) => !after.includes(x));
  if (added.length) changes.push({ field: 'permissions+', label: 'Permissions granted', from: '—', to: added.join(', ') });
  if (removed.length) changes.push({ field: 'permissions-', label: 'Permissions revoked', from: removed.join(', '), to: '—' });
  const hb = old?.hiddenTabs ?? []; const ha = role.hiddenTabs ?? [];
  const hidden = ha.filter((x) => !hb.includes(x)); const shown = hb.filter((x) => !ha.includes(x));
  const pb = old?.hiddenPages ?? []; const pa = role.hiddenPages ?? [];
  if (pa.filter((x) => !pb.includes(x)).length) changes.push({ field: 'pages-', label: 'Pages hidden', from: '—', to: pa.filter((x) => !pb.includes(x)).join(', ') });
  if (pb.filter((x) => !pa.includes(x)).length) changes.push({ field: 'pages+', label: 'Pages shown', from: pb.filter((x) => !pa.includes(x)).join(', '), to: '—' });
  if (hidden.length) changes.push({ field: 'tabs-', label: 'Tabs hidden', from: '—', to: hidden.join(', ') });
  if (shown.length) changes.push({ field: 'tabs+', label: 'Tabs shown', from: shown.join(', '), to: '—' });
  if (old && old.groupId !== role.groupId) changes.push({ field: 'group', label: 'Group', from: old.groupId || '—', to: role.groupId || '—' });
  if (old && old.category !== role.category) changes.push({ field: 'category', label: 'Access level', from: old.category, to: role.category });
  if (old && old.name !== role.name) changes.push({ field: 'name', label: 'Role name', from: old.name, to: role.name });
  await auditAdmin({ what: 'Roles & Permissions', recordId: saved.id ?? role.id, action: old ? 'Update' : 'Create', summary: role.name, changes });
  return saved;
}

export async function deleteRole(id) {
  requirePermission('MANAGE_ROLES');
  const old = await storage.get(COLLECTIONS.ROLES, id);
  await storage.remove(COLLECTIONS.ROLES, id);
  await auditAdmin({ what: 'Roles & Permissions', recordId: id, action: 'Delete', summary: old?.name ?? id });
}
