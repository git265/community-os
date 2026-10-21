// Sign-in against the typed v2 API (backend/api):
//   GET  /v1/public/communities/{slug}  the community this page is for (its id goes into the token request: no "pick a community" step)
//   POST /v1/auth/otp     { phone }                         -> { challengeId }       (same answer for unknown numbers)
//   POST /v1/auth/token   { challengeId, code, communityId } -> access token; the refresh token is an HttpOnly cookie on /api/v1/auth
//   POST /v1/auth/refresh (cookie)                          -> a new access token (the refresh token rotates)
//   POST /v1/auth/logout  (cookie)
//   GET  /v1/me                                             -> who I am here: roles, permissions, units (read from the database per call)
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
  return { id: c.id, slug: c.slug, name: c.name, status: c.status };
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
export const v2Logout = () => post('/auth/logout', {}).catch(() => {});

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
