// Server-side rules for the property register (the part a Spring Boot service would own).
//
//   propertyPreWrite  - BEFORE a property is stored: every phone must carry a country code and be a real number (see phone.js);
//                       the primary owner's phone is mandatory, a tenant (and phone) when "Tenant occupied", a phone for every
//                       additional owner / tenant / contact; numbers are stored in E.164; old secondary-owner fields are folded
//                       into the "people" list. One phone = one person (same number on two different names is refused).
//   propertyPostWrite - AFTER it is stored: portal access follows the phone numbers on the register.
//        new number on a property  -> a person row is created/updated in Users ('Invited'), and a sign-in link is queued to that
//                                     number (SMS + WhatsApp). A number already known in this community just gets the villa added.
//        number changed / removed  -> the old number loses access to this villa at once; if that was all they had in this
//                                     community their account is deactivated; open invites for it are revoked; the new number is invited.
//   pollPreWrite      - one poll answer per villa.
//
// Messages are only QUEUED into the notification outbox here: a real SMS / WhatsApp gateway (and a real one-time-code login) must
// be added in the Spring Boot service. The invite token below stands in for a signed, single-use, expiring link.
import { storage } from './storage/index.js';
import { COLLECTIONS as C } from './storage/StorageAdapter.js';
import { logChange } from './audit/auditLog.js';
import { uuid } from './uuid.js';
import { validatePhone, phoneKey } from './phone.js';
import { peopleOf, isOwnerRelation } from './people.js';
import { getCommunity, communityUrl } from './community.js';
import { normalize as tidyUnit, key as unitKey, unitProblem, ruleFor } from './unitNaming.js';
const lowerEmail = (e) => String(e || '').trim().toLowerCase();
/** The owner of a unit added in bulk before its owner is known (filled in later, or by the Excel import). */
export const OWNER_LATER = 'To be updated';

const SYSTEM = 'System · portal access';
const INVITE_DAYS = 7;
const changed = (collection) => window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection } }));
const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

async function nextId(collection, prefix) {
  const rows = await storage.list(collection);
  const max = rows.reduce((m, r) => { const n = Number(String(r.shortId || '').replace(`${prefix}-`, '')); return Number.isFinite(n) && n > m ? n : m; }, 0);
  return `${prefix}-${String(max + 1).padStart(4, '0')}`;
}
async function systemPut(collection, prefix, row) {
  const now = new Date().toISOString();
  const full = { ...row, id: row.id || uuid(), shortId: row.shortId || await nextId(collection, prefix), recVersion: 1, recordCreatedAt: now, recordCreatedBy: SYSTEM, lastUpdatedAt: now, lastUpdatedBy: SYSTEM };
  await storage.put(collection, full);
  changed(collection);
  return full;
}

/* ------------------------------------------------------------ before ---- */

export async function propertyPreWrite({ record, old, isNew }) {
  const r = { ...record };
  // the unit number: the character rules, the block's (or the community's) naming pattern, one unit per number whatever its case
  r.unit = tidyUnit(r.unit);
  // checked when a unit is added or renamed (as on the server): moving a unit to another block keeps its number
  if (isNew || !old || old.unit !== r.unit) {
    const [cfg] = await storage.list(C.COMMUNITY_CONFIG);
    const rule = ruleFor(r.zone, await storage.list(C.BLOCKS), cfg?.unitPattern);
    const why = unitProblem(r.unit, rule.pattern, rule.block);
    if (why) return { error: why };
    const clash = (await storage.list(C.PROPERTIES)).find((p) => p.id !== r.id && unitKey(p.unit) === unitKey(r.unit));
    if (clash) return { error: `There is already a unit “${clash.unit}” (unit numbers are the same whatever their case)` };
  }
  // e-mail addresses are kept in lower case
  for (const k of ['ownerEmail', 'tenantEmail']) if (r[k]) r[k] = lowerEmail(r[k]);
  // fold the old "secondary owner" columns into the people list
  if (!Array.isArray(r.people) && (r.secondaryOwner || old?.secondaryOwner)) {
    r.people = r.secondaryOwner ? [{ id: uuid(), relation: 'Additional owner', name: r.secondaryOwner, phone: r.secondaryOwnerPhone || '', email: '' }] : [];
  }
  delete r.secondaryOwner; delete r.secondaryOwnerPhone;
  if (!Array.isArray(r.people)) r.people = [];
  r.people = r.people.map((x) => ({ ...x, id: x.id || uuid(), name: String(x.name || '').trim(), email: lowerEmail(x.email) }));

  if (!String(r.owner || '').trim()) return { error: 'The primary owner (on the lease / title) is required' };
  if (!r.occupancy) return { error: 'Say who occupies the property: owner, tenant or vacant' };
  if (r.occupancy === 'Tenant occupied' && !String(r.tenant || '').trim()) return { error: 'A tenant name is required when the property is tenant occupied' };
  if (r.occupancy !== 'Tenant occupied' && !String(r.tenant || '').trim()) { r.tenant = ''; r.tenantPhone = ''; r.tenantEmail = ''; }

  const seen = new Map(); // e164 -> name
  const check = (label, name, phone, required) => {
    if (!String(phone || '').trim()) return required ? `${label}: phone number is required` : '';
    const v = validatePhone(phone);
    if (!v.ok) return `${label} (${name || 'unnamed'}): ${v.error}`;
    if (seen.has(v.e164) && !sameName(seen.get(v.e164), name)) return `${label}: ${v.formatted} is already used for ${seen.get(v.e164)} on this property — one number identifies one person`;
    seen.set(v.e164, name);
    return v.e164;
  };
  const slots = [['Primary owner', r.owner, 'ownerPhone', String(r.owner).trim() !== OWNER_LATER]];   // a placeholder owner has no phone yet
  if (String(r.tenant || '').trim()) slots.push(['Tenant', r.tenant, 'tenantPhone', true]);
  for (const [label, name, key, req] of slots) {
    const out = check(label, name, r[key], req);
    if (out && !out.startsWith('+')) return { error: out };
    r[key] = out;
  }
  for (const x of r.people) {
    if (!x.name) return { error: 'Every additional person needs a name' };
    const out = check(x.relation || 'Additional person', x.name, x.phone, true);
    if (!out.startsWith('+')) return { error: out };
    x.phone = out;
  }
  // the same number must not belong to a different person on another property
  const others = (await storage.list(C.PROPERTIES)).filter((p) => p.id !== r.id);
  for (const [e164, name] of seen) {
    for (const o of others) {
      const clash = peopleOf(o).find((x) => x.phone && phoneKey(x.phone) === e164 && !sameName(x.name, name));
      if (clash) return { error: `${validatePhone(e164).formatted} already belongs to ${clash.name} (${o.unit}). One phone number identifies one person across the community.` };
    }
  }
  return { record: r };
}

/** One poll answer per villa: a second member of the same household changes the household's answer instead of adding another. */
export async function pollPreWrite({ record, old }) {
  if (!record.unit) return {};
  const votes = (await storage.list(C.POLL_VOTES)).filter((v) => v.broadcastId === record.broadcastId && v.unit === record.unit && v.id !== record.id);
  if (votes.length && !sameName(votes[0].voter, record.voter)) return { error: `${record.unit} has already voted on this poll (by ${votes[0].voter}). There is one vote per villa.` };
  return {};
}

/* ------------------------------------------------------------ after ----- */

const isResidentRole = (id) => id === 'owner' || id === 'resident';
const userPhone = (u) => (u.phone ? phoneKey(u.phone) : '');

async function communityName() {
  const mf = (await storage.list(C.MERGE_FIELDS)).find((m) => m.token === '{{SOCIETY_NAME}}');
  return mf?.defaultValue || 'your community';
}

export const inviteLink = (token) => `${communityUrl(getCommunity())}#/join/${token}`;

async function queueInvite(person, unit, community) {
  // revoke older open invites for the same number + villa, then issue a fresh one
  const invites = await storage.list(C.PORTAL_INVITES);
  for (const i of invites.filter((x) => x.phone === person.phone && x.unit === unit && x.status === 'Sent')) await storage.put(C.PORTAL_INVITES, { ...i, status: 'Revoked', revokedReason: 'Replaced by a new invite' });
  const token = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 864e5).toISOString().slice(0, 10);
  const invite = await systemPut(C.PORTAL_INVITES, 'PIV', { token, phone: person.phone, personName: person.name, unit, communitySlug: getCommunity(), relation: person.relation, status: 'Sent', expiresAt });
  const link = inviteLink(token);
  const body = `Hello ${person.name}, you have been registered for ${unit} at ${community}. Open ${link} to access the community portal (valid till ${expiresAt}). If you are already on CommunityOS, this community is simply added to your account.`;
  for (const channel of ['SMS', 'WhatsApp']) {
    await systemPut(C.NOTIFICATION_OUTBOX, 'OUT', { event: 'portal_invite', channel, to: person.phone, subject: 'Your community portal access', body, unit, status: 'Queued — demo, not delivered', createdAt: new Date().toISOString() });
  }
  return invite;
}

async function queueNotice(person, text, event) {
  await systemPut(C.NOTIFICATION_OUTBOX, 'OUT', { event, channel: 'SMS', to: person.phone, subject: 'Portal access update', body: text, status: 'Queued — demo, not delivered', createdAt: new Date().toISOString() });
}

export async function propertyPostWrite({ old, next, actor }) {
  const unit = next.unit;
  const community = await communityName();
  const before = old ? peopleOf(old).filter((x) => x.phone).map((x) => ({ ...x, phone: phoneKey(x.phone) })) : [];
  const after = peopleOf(next).filter((x) => x.phone).map((x) => ({ ...x, phone: phoneKey(x.phone) }));
  const afterPhones = new Set(after.map((x) => x.phone));
  let users = await storage.list(C.USERS);
  const events = [];
  const saveUser = async (u) => { await storage.put(C.USERS, u); users = users.map((x) => (x.id === u.id ? u : x)); };

  // 1) numbers that left this property (changed or removed)
  for (const gone of before.filter((x) => !afterPhones.has(x.phone))) {
    for (const i of (await storage.list(C.PORTAL_INVITES)).filter((x) => x.phone === gone.phone && x.unit === unit && x.status === 'Sent')) {
      await storage.put(C.PORTAL_INVITES, { ...i, status: 'Revoked', revokedReason: 'Phone number changed or person removed' });
    }
    const u = users.find((x) => userPhone(x) === gone.phone && x.status !== 'Inactive');
    if (!u) { events.push(`${gone.name}: old number ${gone.phone} had no portal account`); continue; }
    const units = (u.units || []).filter((x) => x !== unit);
    const keepsOtherVilla = units.length > 0;
    if (keepsOtherVilla || !isResidentRole(u.roleId) || (u.extraRoleIds || []).some((id) => !isResidentRole(id))) {
      await saveUser({ ...u, units });
      events.push(`${u.name} (${gone.phone}) no longer linked to ${unit}${keepsOtherVilla ? ` — keeps access through ${units.join(', ')}` : ' — keeps their committee / staff role'}`);
    } else {
      await saveUser({ ...u, units, status: 'Inactive', deactivatedAt: new Date().toISOString(), deactivatedReason: `Phone number on ${unit} was ${next.owner === gone.name || old?.owner === gone.name ? 'changed' : 'changed or the person was removed'} by ${actor}` });
      events.push(`Portal access DEACTIVATED for ${u.name} (${gone.phone})`);
    }
    await queueNotice(gone, `Your access to ${community} for ${unit} has been removed because the registered phone number changed. Contact the community office if this is a mistake.`, 'portal_access_removed');
  }

  // 2) numbers now on this property
  for (const person of after) {
    const existing = users.find((x) => userPhone(x) === person.phone);
    const wasThere = before.some((x) => x.phone === person.phone);
    const roleId = person.isOwner ? 'owner' : 'resident';
    if (!existing) {
      const row = { id: uuid(), shortId: await nextId(C.USERS, 'USR'), recVersion: 1, name: person.name, phone: person.phone, email: person.email || '', status: 'Invited', roleId, extraRoleIds: [], units: [unit], portalSource: 'property', recordCreatedAt: new Date().toISOString(), recordCreatedBy: SYSTEM, lastUpdatedAt: new Date().toISOString(), lastUpdatedBy: SYSTEM };
      await storage.put(C.USERS, row); users = [...users, row];
      await queueInvite(person, unit, community);
      events.push(`Invite sent to ${person.name} (${person.phone}) for ${unit}`);
      continue;
    }
    let u = { ...existing };
    const reactivated = u.status === 'Inactive';
    // blanked rather than deleted: the database stores merge fields into the saved row, so a deleted field would come back
    if (reactivated) { u.status = 'Invited'; u.deactivatedAt = ''; u.deactivatedReason = ''; u.roleId = isResidentRole(u.roleId) ? roleId : u.roleId; u.units = []; }
    if (!(u.units || []).includes(unit)) u.units = [...(u.units || []), unit];
    if (person.isOwner && u.roleId === 'resident') u.roleId = 'owner';
    if (!person.isOwner && u.roleId === 'owner' && !(u.extraRoleIds || []).includes('resident')) u.extraRoleIds = [...(u.extraRoleIds || []), 'resident'];
    if (sameName(u.name, person.name) === false && isResidentRole(u.roleId)) u.name = person.name;
    if (person.email && !u.email) u.email = person.email;
    await saveUser(u);
    if (reactivated || (!wasThere && u.status === 'Invited')) { await queueInvite(person, unit, community); events.push(`Invite sent to ${person.name} (${person.phone}) for ${unit}`); }
    else if (!wasThere) { await queueNotice(person, `${unit} has been added to your ${community} account. Sign in with your phone number.`, 'portal_unit_added'); events.push(`${unit} added to existing account of ${person.name}`); }
  }

  if (events.length) {
    await logChange({ who: SYSTEM, whoName: actor, what: 'Portal access', collection: C.PROPERTIES, recordId: next.id, recordShortId: next.shortId, unit, action: 'Update', summary: events.join(' · ').slice(0, 400), changes: [] });
  }
  changed(C.USERS);
}

/** What will happen to portal access if this draft is saved over `old`? Used for the live warning in the property form. */
export function accessImpact(old, draft) {
  const lines = []; let needsAck = false;
  const norm = (list) => list.filter((x) => x.phone).map((x) => ({ ...x, key: phoneKey(x.phone) }));
  const before = old?.id ? norm(peopleOf(old)) : [];
  const after = norm(peopleOf(draft));
  const afterKeys = new Set(after.map((x) => x.key)); const beforeKeys = new Set(before.map((x) => x.key));
  for (const g of before.filter((x) => !afterKeys.has(x.key))) {
    const repl = after.find((x) => x.name === g.name && !beforeKeys.has(x.key));
    lines.push(repl
      ? `⚠ ${g.name}'s number is changing from ${validatePhone(g.phone).formatted || g.phone} to ${validatePhone(repl.phone).formatted || repl.phone}. Portal access on the old number is deactivated immediately and a new sign-in link is sent to the new number.`
      : `⚠ ${g.name} (${validatePhone(g.phone).formatted || g.phone}) is being removed. Their portal access to this community is deactivated immediately.`);
    needsAck = true;
  }
  const added = after.filter((x) => !beforeKeys.has(x.key) && !(before.length && before.some((b) => b.name === x.name)));
  if (added.length) lines.push(`ℹ A sign-in link will be sent by SMS / WhatsApp to: ${added.map((x) => `${x.name} (${validatePhone(x.phone).formatted || x.phone})`).join(', ')}. If they already use another community here, this one is added to their account.`);
  if (draft.occupancy === 'Tenant occupied') lines.push('ℹ Tenant occupied: the tenant gets portal access and communications; only owners vote in e-voting.');
  return { lines, needsAck };
}
