// Sign-in against the typed v2 API (backend/api):
//   GET  /v1/public/communities/{slug}  the community this page is for (its id goes into the token request: no "pick a community" step)
//   POST /v1/auth/otp     { phone }                         -> { challengeId }       (same answer for unknown numbers)
//   POST /v1/auth/token   { challengeId, code, communityId } -> access token; the refresh token is an HttpOnly cookie on /api/v1/auth
//   POST /v1/auth/refresh (cookie)                          -> a new access token (the refresh token rotates)
//   POST /v1/auth/logout  (cookie)
//   GET  /v1/me                                             -> who I am here: roles, permissions, units (read from the database per call)
import { setCommunityTimeZone } from '../locale.js';
import { apiFetch } from '../net/request.js';
import { setSession } from './session.js';
import { resolveSlug } from '../community.js';
import { meUser } from '../storage/v2/v2map.js';

let challengeId = null;
let communityId = null;
let lastVerify = {};
export const v2VerifyInfo = () => lastVerify;
export const v2AuthConfig = () => ({ mode: 'enforce', provider: 'local', authority: 'server', api: 'v2' });

async function send(path, init, auth) {
  const res = await apiFetch(`/v1${path}`, init, { auth, retries: init.method === 'POST' ? 0 : undefined });
  let body = null; try { body = res.status === 204 ? null : await res.json(); } catch { /* not JSON */ }
  if (!res.ok) { const e = new Error(body?.detail || `Sign-in failed (${res.status})`); e.status = res.status; e.code = body?.code; throw e; }
  return body;
}
const post = (path, body, auth = false) => send(path, { method: 'POST', body: JSON.stringify(body || {}) }, auth);

export async function v2PublicCommunity() {
  const c = await send(`/public/communities/${encodeURIComponent(resolveSlug())}`, {}, false);
  communityId = c.id;
  setCommunityTimeZone(c.timeZone);   // its planned times (meetings, pass hours) are shown with its zone when this browser is elsewhere
  return { id: c.id, slug: c.slug, name: c.name, status: c.status, timeZone: c.timeZone || '' };
}
export async function v2RequestCode(target) {
  if (!target?.phone) throw new Error('Sign-in links are not on the v2 back end yet - enter your phone number.');
  const r = await post('/auth/otp', { phone: target.phone });
  challengeId = r.challengeId;
  return { phone: target.phone, expiresInSeconds: r.expiresInSeconds };
}
export async function v2Verify(target, code) {
  if (!challengeId) throw new Error('Ask for a code first.');
  const r = await post('/auth/token', { challengeId, code, communityId, client: 'web' });
  if (r.status !== 'signed-in') throw new Error('This phone number is not a member of this community.');
  challengeId = null;
  return signedIn(r);
}
export async function v2Renew() {
  try { return await signedIn(await post('/auth/refresh', { client: 'web' })); } catch { return null; }
}
/** End the session on the server (the refresh token is revoked and its cookie cleared). Resolves false when the server could not be told. */
export const v2Logout = () => post('/auth/logout', {}).then(() => true, (e) => !!e?.status && e.status < 500);

// ---- the demo (a development server with cos.demo.enabled only; a production server answers 404 and none of this shows) ----------------------
let roster = null;
/** The sign-in settings, with the demo roster when the server offers one. */
export async function v2LoadAuthConfig() {
  const cfg = v2AuthConfig();
  try { roster = await send(`/demo/roster/${encodeURIComponent(resolveSlug())}`, {}, false); cfg.demoRoster = true; } catch { roster = null; }
  return cfg;
}
export async function v2DemoRoster() {
  const r = roster || await send(`/demo/roster/${encodeURIComponent(resolveSlug())}`, {}, false);
  return { roles: r.roles, units: r.units, people: r.people.map((p) => ({ ...p, units: p.units || [], extraRoleIds: p.extraRoleIds || [] })) };
}
/** Sign in as someone on the roster (by id), or as the first member with the role (and unit) picked on "Demo roles". */
export async function v2DemoSignIn(body) {
  if (!communityId) await v2PublicCommunity();
  const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.userId || '');
  const r = await post('/demo/sign-in', { communityId, membershipId: isId ? body.userId : null, roleCode: isId ? null : body.roleId, unit: isId ? null : (body.unit || null), client: 'web' });
  return signedIn(r);
}

export async function v2WhoAmI() {
  const me = await send('/me', {}, true);
  const noById = {};
  for (const id of me.units.slice(0, 20)) { try { const u = await send(`/units/${encodeURIComponent(id)}`, {}, true); noById[id] = u.unitNo; } catch { /* label falls back to the id */ } }
  const user = meUser(me, noById);
  lastVerify = { roles: me.roles.map((code) => ({ id: code, category: me.category })) };
  return user;
}

async function signedIn(r) {
  const expiresIn = Math.max(30, Math.round((Date.parse(r.expiresAt) - Date.now()) / 1000));
  setSession({ accessToken: r.accessToken, expiresIn });
  const user = await v2WhoAmI();
  setSession({ accessToken: r.accessToken, expiresIn, user });
  return { user, roles: lastVerify.roles };
}
