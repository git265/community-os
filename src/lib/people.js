// Who is attached to a property: the primary owner (on the lease / title), an optional tenant, and any number of additional
// owners / tenants / contacts ("people") who also receive communications. Older records had secondaryOwner + secondaryOwnerPhone.
export const RELATIONS = ['Additional owner', 'Additional tenant', 'Family / other contact'];
export const isOwnerRelation = (r) => r === 'Additional owner';

/** Every person on a property, in one list, with the slot they sit in. */
export function peopleOf(prop) {
  if (!prop) return [];
  const out = [];
  if (prop.owner) out.push({ slot: 'primary', name: prop.owner, phone: prop.ownerPhone || '', email: prop.ownerEmail || '', relation: 'Primary owner', isOwner: true });
  if (prop.tenant) out.push({ slot: 'tenant', name: prop.tenant, phone: prop.tenantPhone || '', email: prop.tenantEmail || '', relation: 'Tenant', isOwner: false });
  const extra = Array.isArray(prop.people) ? prop.people : [];
  extra.forEach((x) => { if (x?.name) out.push({ slot: x.id || `p:${x.name}`, name: x.name, phone: x.phone || '', email: x.email || '', relation: x.relation || 'Additional owner', isOwner: isOwnerRelation(x.relation || 'Additional owner') }); });
  if (!extra.length && prop.secondaryOwner) out.push({ slot: 'secondary', name: prop.secondaryOwner, phone: prop.secondaryOwnerPhone || '', email: '', relation: 'Additional owner', isOwner: true });
  return out;
}
export const ownersOf = (prop) => peopleOf(prop).filter((x) => x.isOwner);
