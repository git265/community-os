// The PLATFORM layer: which communities exist, who runs the platform, and who belongs to which community.
// It sits above every community (its rows are stored under  communityos:platform:*  here, in a platform database later).
//
//  - Communities  : name, web address (slug), unit types, status (Active / Suspended), demo-data flag.
//  - Memberships  : NOT stored twice. A person is one e-mail address; each community keeps its own user row for them
//                   (own role(s), own villa). membershipsFor(email) finds every community that has that e-mail.
//                   In production this is the platform "accounts" service behind single sign-on.

import { logEvent } from '../audit/auditLog.js';
import { storage, COLLECTIONS } from '../storage/index.js';
import { DEFAULT_COMMUNITY, RESERVED_SLUGS, SLUG_RE } from '../community.js';
import { DEFAULT_ROLES } from '../access/roles.js';
import { phoneKey, validatePhone } from '../phone.js';
import { isApiMode } from '../storage/dataSource.js';
import { apiFetch } from '../net/request.js';
import { isEmail } from '../validate.js';

const C = COLLECTIONS.COMMUNITIES;
const SESSION_KEY = 'communityos:platformSession';
const HANDOFF_KEY = 'communityos:handoff';

export const UNIT_TYPES = ['Villas and apartments', 'Villas only', 'Apartments only'];

// ---- when the back end enforces access, the registry is the server's (/api/platform, signed with the platform key) ----
let direct = false;   // the server said it does not enforce access: the console writes the registry itself, as in the browser-only demo
async function server(method, path, body) {
  if (!isApiMode() || direct) return undefined;
  const res = await apiFetch(`/platform${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}), headers: { 'X-Platform-Key': platformSession()?.key || '' } }, { auth: false });
  const b = await res.json().catch(() => ({}));
  if (res.status === 404 && b.code === 'platform-direct') { direct = true; return undefined; }
  if (!res.ok) throw Object.assign(new Error(b.message || `The server refused this (${res.status}).`), { status: res.status, errors: b.errors, code: b.code });
  return b;
}
/** True when communities are created and listed by the server (API mode with an enforcing back end). */
export const registryOnServer = () => isApiMode() && !direct;

/** Make sure the built-in demo community is in the registry. */
export async function ensureRegistry() {
  const rows = await storage.list(C);
  if (!rows.some((r) => r.slug === DEFAULT_COMMUNITY)) {
    await storage.put(C, { id: DEFAULT_COMMUNITY, slug: DEFAULT_COMMUNITY, name: 'La Paloma', address: '', unitTypes: 'Villas and apartments', status: 'Active', demoData: true, createdAt: new Date().toISOString().slice(0, 10), createdBy: 'Platform' });
  }
}

export async function listCommunities() {
  const remote = await server('GET', '/communities');
  if (remote !== undefined) return remote;
  await ensureRegistry();
  return (await storage.list(C)).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getCommunityRecord(slug) {
  await ensureRegistry();
  return (await storage.list(C)).find((r) => r.slug === slug) || null;
}

export function validateNewCommunity(v, existing) {
  const e = {};
  if (!v.name?.trim()) e.name = 'Community name is required';
  const slug = (v.slug || '').trim().toLowerCase();
  if (!slug) e.slug = 'Web address is required';
  else if (!SLUG_RE.test(slug)) e.slug = 'Use 3–30 letters, numbers or hyphens (no spaces)';
  else if (RESERVED_SLUGS.includes(slug)) e.slug = 'That address is reserved';
  else if (existing.some((c) => c.slug === slug)) e.slug = 'That web address is already taken';
  if (!v.adminName?.trim()) e.adminName = 'First Super Admin name is required';
  if (!isEmail(v.adminEmail)) e.adminEmail = 'A valid e-mail is required (it identifies the person across communities)';
  if (String(v.adminPhone || '').trim()) { const ph = validatePhone(v.adminPhone); if (!ph.ok) e.adminPhone = ph.error; }
  return e;
}

/** Create a community and its starting data: default roles/permissions, defaults (task types, templates...) and the first Super Admin. */
export async function createCommunity(v, by = 'Platform admin') {
  if (registryOnServer()) {
    try {
      const out = await server('POST', '/communities', v);
      if (out !== undefined) return out;
    } catch (e) { return { errors: e.errors || { form: e.message } }; }
  }
  const existing = await listCommunities();
  const errs = validateNewCommunity(v, existing);
  if (Object.keys(errs).length) return { errors: errs };
  const slug = v.slug.trim().toLowerCase();
  const community = { id: slug, slug, name: v.name.trim(), address: (v.address || '').trim(), unitTypes: v.unitTypes || UNIT_TYPES[0], status: 'Active', demoData: !!v.demoData, ...(v.largeData ? { largeData: { blocks: 5, unitsPerBlock: 400, months: 12 } } : {}), createdAt: new Date().toISOString().slice(0, 10), createdBy: by };
  await storage.put(C, community);
  const { provisionCommunity } = await import('../seed/seedData.js');
  await provisionCommunity(community, { name: v.adminName.trim(), email: v.adminEmail, phone: v.adminPhone });
  // the default roles are written now so the new community has them from its first sign-in
  const store = storage.forCommunity(slug);
  if ((await store.list(COLLECTIONS.ROLES)).length === 0) for (const r of DEFAULT_ROLES) await store.put(COLLECTIONS.ROLES, r);
  return { community };
}

export async function setCommunityStatus(slug, status) {
  const remote = await server('PATCH', `/communities/${encodeURIComponent(slug)}`, { status });
  if (remote !== undefined) return remote;
  const c = await getCommunityRecord(slug);
  if (!c) return null;
  const out = await storage.put(C, { ...c, status });
  logEvent({ who: 'Platform admin', what: 'Communities', action: 'Update', recordId: slug, summary: `${c.name}: status ${c.status} → ${status}`, changes: [{ field: 'status', label: 'Status', from: c.status, to: status }] });
  return out;
}

/** Everyone in one community. */
export async function membersOf(slug) {
  return (await storage.forCommunity(slug).list(COLLECTIONS.USERS)).filter((u) => u.status !== 'Inactive');
}

/** Add a person (by e-mail) to a community with a role - the same person can hold different roles in different communities. */
export async function addMember(slug, p) {
  const store = storage.forCommunity(slug);
  const users = await store.list(COLLECTIONS.USERS);
  const email = (p.email || '').trim().toLowerCase();
  const e = {};
  if (!p.name?.trim()) e.name = 'Name is required';
  if (!isEmail(email)) e.email = 'A valid e-mail is required';
  else if (users.some((u) => (u.email || '').toLowerCase() === email && u.status !== 'Inactive')) e.email = 'This person is already in the community';
  if (String(p.phone || '').trim()) { const ph = validatePhone(p.phone); if (!ph.ok) e.phone = ph.error; }
  if (!p.roleId) e.roleId = 'Pick a role';
  if (Object.keys(e).length) return { errors: e };
  const { stampRow } = await import('../seed/seedData.js');
  const row = stampRow(COLLECTIONS.USERS, { name: p.name.trim(), phone: p.phone || '', email, status: 'Active', roleId: p.roleId, extraRoleIds: [], units: p.unit ? [p.unit] : [] }, users.length);
  await store.put(COLLECTIONS.USERS, row);
  return { user: row };
}

/** Every ACTIVE community this person belongs to - matched by e-mail OR by registered phone number (E.164) - with their row there. */
export async function membershipsFor(email, phone = '') {
  const key = (email || '').trim().toLowerCase();
  const pk = phone ? phoneKey(phone) : '';
  if (!key && !pk) return [];
  const out = [];
  for (const c of await listCommunities()) {
    if (c.status !== 'Active') continue;
    const u = (await storage.forCommunity(c.slug).list(COLLECTIONS.USERS)).find((x) => x.status !== 'Inactive' && ((key && (x.email || '').toLowerCase() === key) || (pk && x.phone && phoneKey(x.phone) === pk)));
    if (u) out.push({ community: c, user: u });
  }
  return out;
}

/** All people across the platform, grouped by e-mail. */
export async function allPeople() {
  const map = new Map();
  for (const c of await listCommunities()) {
    const roles = await storage.forCommunity(c.slug).list(COLLECTIONS.ROLES);
    for (const u of await storage.forCommunity(c.slug).list(COLLECTIONS.USERS)) {
      if (u.status === 'Inactive') continue;
      const key = (u.email || '').toLowerCase() || `no-email:${c.slug}:${u.id}`;
      const rn = (id) => roles.find((r) => r.id === id)?.name || DEFAULT_ROLES.find((r) => r.id === id)?.name || id;
      if (!map.has(key)) map.set(key, { key, email: u.email || '', name: u.name, memberships: [] });
      map.get(key).memberships.push({ slug: c.slug, community: c.name, roles: [u.roleId, ...(u.extraRoleIds || [])].map(rn) });
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---- platform-admin session (demo sign-in; production: a separate identity with MFA) ----
export const platformSession = () => { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; } };
export const platformSignIn = (name = 'Platform Admin', key = '') => sessionStorage.setItem(SESSION_KEY, JSON.stringify({ name, at: Date.now(), ...(key ? { key } : {}) }));
export const platformSignOut = () => sessionStorage.removeItem(SESSION_KEY);

// ---- moving between communities (single sign-on hand-off) ----
export function setHandoff(slug, userId) { try { sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ slug, userId, at: Date.now() })); } catch { /* ignore */ } }
export function takeHandoff(slug) {
  try {
    const h = JSON.parse(sessionStorage.getItem(HANDOFF_KEY) || 'null');
    sessionStorage.removeItem(HANDOFF_KEY);
    return h && h.slug === slug && Date.now() - h.at < 30000 ? h : null;
  } catch { return null; }
}
