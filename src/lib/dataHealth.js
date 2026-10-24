// Data health: finds records that point at something that does not exist, records with an important gap, and records nobody has touched
// for too long. Pure: give it the lists, get the findings. The Reports -> Data health tab and the Command Center warning both use it.
import { localDay } from './locale.js';
import { TICKET_CATEGORIES } from './lists/configLists.js';
import { categoryFor, assetCategories } from './assets/repairKind.js';

export const KINDS = ['Broken link', 'Missing', 'Mismatch', 'Stale'];
const day = (iso) => localDay(iso || '');
const daysSince = (iso, now) => (iso ? Math.floor((now - new Date(day(iso)).getTime()) / 86400000) : null);
const OPEN = (t) => !['Closed', 'Cancelled', 'Completed'].includes(t.status);
const COMMON = /^(common area|community|whole community|all|shared)/i;

export function analyze(D, { now = Date.now(), staleServiceDays = 0 } = {}) {
  const out = [];
  // each finding can point at the record it is about: { collection, id }, so the page can open it for review
  const add0 = (area, kind, title, detail, ref = '', target = null) => out.push({ id: `${area}-${kind}-${out.length}`, area, kind, title, detail, ref, target });
  const add = (area, kind, title, detail, ref = '') => add0(area, kind, title, detail, ref);
  const mk = (collection, id) => (area, kind, title, detail, ref = '') => add0(area, kind, title, detail, ref, id ? { collection, id } : null);
  const L = (k) => D[k] || [];
  const units = new Set(L('properties').map((p) => p.unit));
  const assets = new Map(L('equipment').map((a) => [a.id, a]));
  const facilities = new Set(L('facilities').map((f) => f.name));
  const vendors = new Set(L('vendors').map((v) => v.name));
  const people = new Set([...L('users').map((u) => u.name), ...L('handymen').map((h) => h.name), ...vendors, ...L('ecRoles').map((e) => e.personName).filter(Boolean)]);
  const cov = new Map(L('categoryMap').map((c) => [c.category, c]));
  const cats = new Set([...TICKET_CATEGORIES, ...cov.keys()]);
  const catList = [...cats];
  const roleIds = new Set(L('roles').map((r) => r.id));

  // ---- maintenance tasks
  for (const t of L('tickets')) { const add = mk('tickets', t.id);
    const ref = t.ticketNumber || t.id;
    if (t.assetId && !assets.has(t.assetId)) add('Maintenance', 'Broken link', `${ref}: the asset no longer exists`, `The task points at "${t.assetName || t.assetId}", which is not in the asset register. Re-link it to the right asset or clear it.`, ref);
    else if (!t.assetId && t.assetName) add('Maintenance', 'Broken link', `${ref}: asset "${t.assetName}" was typed, not picked`, 'It is not linked to any register asset, so its cost and condition cannot roll up.', ref);
    { const a = t.assetId ? assets.get(t.assetId) : null; if (a && t.category && cats.has(t.category) && !assetCategories(a, catList).includes(t.category)) add('Maintenance', 'Mismatch', `${ref}: task is under ${t.category}, but "${a.name}" is filed under ${assetCategories(a, catList).join(' / ') || 'no category'}`, 'Either the task category or the asset category is wrong. Fix the asset (Kind of repair / Also offered for) so it is found under the right category.', ref); }
    if (t.category && !cats.has(t.category)) add('Maintenance', 'Broken link', `${ref}: category "${t.category}" is not in the category list`, 'Pick a current category.', ref);
    const subs = cov.get(t.category)?.subCategories || [];
    if (OPEN(t) && t.category && subs.length && !t.subCategory && t.scope !== 'Unit' && !/resident/i.test(t.taskType || '')) add('Maintenance', 'Missing', `${ref}: no sub-category`, `${t.category} has sub-categories but this task has none.`, ref);
    if (t.subCategory && subs.length && !subs.includes(t.subCategory)) add('Maintenance', 'Broken link', `${ref}: sub-category "${t.subCategory}" does not belong to ${t.category}`, 'Choose one from the category.', ref);
    if (t.unit && !COMMON.test(t.unit) && t.scope !== 'Community' && !units.has(t.unit) && /^(villa|[a-z]-?\d)/i.test(t.unit)) add('Maintenance', 'Broken link', `${ref}: location "${t.unit}" is not a unit`, 'Check the villa or apartment number.', ref);
    if (OPEN(t) && t.assignedTo && !people.has(t.assignedTo)) add('Maintenance', 'Broken link', `${ref}: assigned to "${t.assignedTo}", who is not a known user, staff member or vendor`, 'Reassign it.', ref);
    if (OPEN(t) && !t.assignedTo && ['Assigned', 'In Progress'].includes(t.status)) add('Maintenance', 'Missing', `${ref}: ${t.status} but nobody is assigned`, 'Assign someone.', ref);
    const age = daysSince(t.lastUpdatedAt || t.recordCreatedAt, now);
    if (OPEN(t) && age != null && age > 30) add('Maintenance', 'Stale', `${ref}: open and untouched for ${age} days`, `${t.title}. Update it, put it on hold or close it.`, ref);
    if (OPEN(t) && t.slaDueAt && day(t.slaDueAt) < day(new Date(now).toISOString())) add('Maintenance', 'Stale', `${ref}: past its SLA date (${t.slaDueAt})`, t.title, ref);
  }

  // ---- assets
  for (const a of L('equipment')) { const add = mk('equipment', a.id);
    const ref = a.shortId || a.name;
    if (a.area && !facilities.has(a.area)) add('Assets', 'Broken link', `${a.name}: place "${a.area}" is not in Facilities`, 'Add the place under Community setup or change the asset.', ref);
    if (!a.repairCategory) add('Assets', 'Missing', `${a.name}: no kind of repair`, 'Without it the asset is not offered when a task of that category is raised.', ref);
    else if (!cats.has(a.repairCategory)) add('Assets', 'Broken link', `${a.name}: kind of repair "${a.repairCategory}" is not a category`, '', ref);
    if (a.repairCategory && cats.has(a.repairCategory)) { const guess = categoryFor(a.type, catList); const also = Array.isArray(a.alsoCategories) ? a.alsoCategories : []; if (guess && guess !== a.repairCategory && !also.includes(guess) && !(['MEP', 'General'].includes(guess))) add('Assets', 'Mismatch', `${a.name}: type "${a.type}" usually belongs to ${guess}, but it is filed under ${a.repairCategory}`, `If both teams look after it, add ${guess} under "Also offered for". Otherwise correct the kind of repair.`, ref); }
    if (a.amcVendor && !vendors.has(a.amcVendor)) add('Assets', 'Broken link', `${a.name}: service vendor "${a.amcVendor}" is not in Vendors`, '', ref);
    if (!a.location && !a.shape) add('Assets', 'Missing', `${a.name}: no exact location`, 'Add a location or place it on the Site map.', ref);
    if (a.nextService && day(a.nextService) < day(new Date(now).toISOString()) && !['Retired'].includes(a.status)) add('Assets', 'Stale', `${a.name}: service overdue since ${a.nextService}`, '', ref);
    if (a.warrantyUntil && daysSince(a.warrantyUntil, now) < 0 && daysSince(a.warrantyUntil, now) > -30) add('Assets', 'Stale', `${a.name}: warranty ends ${a.warrantyUntil}`, 'Claim anything pending now.', ref);
    const insp = daysSince(a.lastInspected || a.lastService, now);
    if (a.status !== 'Retired' && insp != null && insp > 365) add('Assets', 'Stale', `${a.name}: not inspected for ${insp} days`, '', ref);
  }

  // a category whose tasks must name an asset, but no asset is filed under it
  for (const [c, row] of cov) {
    if (row.assetLink !== 'Required') continue;
    if (!L('equipment').some((a) => assetCategories(a, catList).includes(c))) add0('Categories', 'Missing', `${c}: tasks must name an asset, but no asset is filed under ${c}`, 'Open an asset and set its kind of repair, or switch the asset requirement for this category.', c, { collection: 'categoryMap', id: row.id });
  }

  // ---- inventory
  for (const i of L('inventory')) { const add = mk('inventory', i.id);
    const ref = i.item;
    if (i.category && !cats.has(i.category)) add('Inventory', 'Broken link', `${i.item}: category "${i.category}" is not a category`, '', ref);
    if (i.location && !facilities.has(i.location) && !/store|stp|wtp|clubhouse|pump|yard/i.test(i.location)) add('Inventory', 'Broken link', `${i.item}: kept at "${i.location}", which is not a facility`, '', ref);
    if (i.vendor && !vendors.has(i.vendor)) add('Inventory', 'Broken link', `${i.item}: supplier "${i.vendor}" is not in Vendors`, '', ref);
    if (Number(i.quantity) < Number(i.minStock || 0)) add('Inventory', 'Missing', `${i.item}: ${i.quantity} left, below the re-order level of ${i.minStock}`, '', ref);
    const r = daysSince(i.lastRestocked, now);
    if (r != null && r > 365 && Number(i.quantity) > 0) add('Inventory', 'Stale', `${i.item}: not restocked or counted for ${r} days`, 'Check the stock is still there.', ref);
  }

  // ---- units, people, money
  for (const p of L('properties')) { const add = mk('properties', p.id);
    if (!p.ownerPhone) add('Units', 'Missing', `${p.unit}: no owner mobile`, 'The owner cannot be reached or invited.', p.unit);
    if (p.occupancy === 'Tenant occupied' && !p.tenantPhone) add('Units', 'Missing', `${p.unit}: tenant occupied but no tenant mobile`, '', p.unit);
  }
  for (const u of L('users')) { const add = mk('users', u.id); if (u.roleId && roleIds.size && !roleIds.has(u.roleId)) add('Users', 'Broken link', `${u.name}: role "${u.roleId}" does not exist`, '', u.name); }
  for (const u of L('users')) { const add = mk('users', u.id); for (const un of u.units || []) if (!units.has(un)) add('Users', 'Broken link', `${u.name}: linked to unit "${un}", which does not exist`, '', u.name); }
  for (const d of L('dues')) { const add = mk('dues', d.id); if (d.unit && !units.has(d.unit) && !/association|common/i.test(d.unit)) add('Billing', 'Broken link', `${d.shortId || d.id}: bill for unknown unit "${d.unit}"`, '', d.shortId || d.id); }
  for (const d of L('dues')) { const add = mk('dues', d.id); if (!['Paid', 'Cancelled'].includes(d.status) && d.dueDate && daysSince(d.dueDate, now) > 90) add('Billing', 'Stale', `${d.shortId || d.id} (${d.unit}): unpaid ${daysSince(d.dueDate, now)} days past due`, 'Chase it, write it off or settle it.', d.shortId || d.id); }
  for (const q of L('quotations')) { const add = mk('quotations', q.id); if (q.ticketId && !L('tickets').some((t) => t.id === q.ticketId)) add('Billing', 'Broken link', `Quotation ${q.shortId || q.id}: its task no longer exists`, '', q.shortId || q.id); }

  // ---- amenities
  const amen = new Map(L('amenityTypes').map((a) => [a.name, a]));
  for (const b of L('amenities')) { const add = mk('amenities', b.id); if (!amen.has(b.amenity)) add('Amenities', 'Broken link', `Booking ${b.shortId || b.id}: amenity "${b.amenity}" is not in the catalog`, '', b.shortId || b.id); }
  for (const b of L('amenities')) { const add = mk('amenities', b.id); if (b.unit && !units.has(b.unit) && !/^association/i.test(b.unit)) add('Amenities', 'Broken link', `Booking ${b.shortId || b.id}: unit "${b.unit}" does not exist`, '', b.shortId || b.id); }
  for (const a of L('amenityTypes')) { const add = mk('amenityTypes', a.id);
    if (a.facility && !facilities.has(a.facility)) add('Amenities', 'Broken link', `${a.name}: located at "${a.facility}", which is not a facility`, '', a.name);
    if (a.active !== false && a.reservation !== 'Walk-in (no reservation)' && !a.hours) add('Amenities', 'Missing', `${a.name}: no opening hours`, '', a.name);
    if (!a.rules || a.rules === '<p></p>') add('Amenities', 'Missing', `${a.name}: no rules & regulations`, '', a.name);
  }

  // ---- categories
  for (const c of catList) { const row = cov.get(c); if (!row) add('Categories', 'Missing', `${c}: no coverage row`, 'Nobody is set to coordinate or be assigned this category.', c); else if (!row.coordinator?.length && !row.vendor) add('Categories', 'Missing', `${c}: no coordinator or vendor`, '', c); }

  // ---- security registry
  const gp = L('gatePeople');
  for (const p of gp) { const add = mk('gatePeople', p.id);
    if (p.status === 'Active' && p.policeExpiry && daysSince(p.policeExpiry, now) > 0) add('Security', 'Stale', `${p.name}: police verification expired ${p.policeExpiry}`, 'They are still Active. Re-verify or suspend.', p.name);
    if (p.status === 'Active' && p.licenceExpiry && daysSince(p.licenceExpiry, now) > 0) add('Security', 'Stale', `${p.name}: driving licence expired ${p.licenceExpiry}`, '', p.name);
    if (p.status === 'Active' && !p.phone) add('Security', 'Missing', `${p.name}: no mobile number`, '', p.name);
    const seen = daysSince(p.lastSeenAt || p.lastReviewedAt, now);
    if (p.status === 'Active' && ['Maid / cook', 'Driver', 'Nanny / caretaker'].includes(p.personClass) && seen != null && seen > 90) add('Security', 'Stale', `${p.name}: not seen at the gate for ${seen} days`, 'Still working here? Confirm or end the link.', p.name);
  }
  const personIds = new Set(gp.map((p) => p.id));
  for (const l of L('gateLinks')) { const add = mk('gateLinks', l.id); if (l.personId && !personIds.has(l.personId)) add('Security', 'Broken link', `Villa link for "${l.personName}": the person is not in the registry`, '', l.personName); if (l.unit && !units.has(l.unit)) add('Security', 'Broken link', `${l.personName}: linked to unknown villa "${l.unit}"`, '', l.personName); }
  for (const l of L('gateLinks')) { const add = mk('gateLinks', l.id); const p = gp.find((x) => x.id === l.personId); if (p && l.status !== 'Ended' && ['Suspended', 'Blocked'].includes(p.status)) add('Security', 'Missing', `${p.name} is ${p.status} but still linked to ${l.unit}`, 'End the link.', p.name); }
  for (const v of L('gateVisits')) { const add = mk('gateVisits', v.id); if (v.state === 'Inside' && daysSince(v.inAt, now) >= 1) add('Security', 'Stale', `${v.name}: shown inside since ${day(v.inAt)}`, 'Check them out.', v.name); }
  return out;
}

export const summarize = (issues) => KINDS.map((k) => ({ kind: k, count: issues.filter((i) => i.kind === k).length }));
export const COLLECTION_KEYS = { tickets: 'tickets', equipment: 'equipment', facilities: 'facilities', vendors: 'vendors', users: 'users', handymen: 'handymen', ecRoles: 'ecRoles', categoryMap: 'categoryMap', roles: 'roles', inventory: 'inventory', properties: 'properties', dues: 'dues', quotations: 'quotations', amenities: 'amenities', amenityTypes: 'amenityTypes', gatePeople: 'gatePeople', gateLinks: 'gateLinks', gateVisits: 'gateVisits' };
