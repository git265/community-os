// The sign-in calls to the back end (see backend/contract-server/auth.mjs and docs/INTEGRATIONS.md "Sign-in").
import { apiFetch, failureOf } from '../net/request.js';
import { resolveSlug } from '../community.js';
import { setSession, setAuthConfig, getAuthConfig } from './session.js';
import { getDataSource } from '../storage/dataSource.js';
import * as v2 from './v2Auth.js';

const isV2 = () => getDataSource().mode === 'v2';   // the typed v2 API (backend/api) has its own sign-in endpoints
const notOnV2 = (what) => Promise.reject(new Error(`${what} is not available on the v2 back end yet.`));

const slug = () => resolveSlug();
async function post(path, body, { auth = false } = {}) {
  const res = await apiFetch(path, { method: 'POST', body: JSON.stringify(body || {}) }, { slug: slug(), auth, retries: 0 });
  if (!res.ok) { const e = await failureOf(res); throw new Error(e.message); }
  return res.status === 204 ? null : res.json();
}
async function get(path) {
  const res = await apiFetch(path, {}, { slug: slug(), auth: false });
  if (!res.ok) { const e = await failureOf(res); throw new Error(e.message); }
  return res.json();
}

/** What the back end requires: { mode: 'open' | 'enforce', provider: 'local' | 'oidc', demoRoster, otpEcho, oidc }. Cached. */
export async function loadAuthConfig() {
  if (getAuthConfig()) return getAuthConfig();
  if (isV2()) { setAuthConfig(await v2.v2LoadAuthConfig()); return getAuthConfig(); }
  let cfg;
  try { cfg = await get('/auth/config'); } catch { cfg = { mode: 'open', provider: 'local' }; }   // an older back end has no sign-in: it behaves as before
  setAuthConfig(cfg);
  return cfg;
}
export const publicCommunity = () => (isV2() ? v2.v2PublicCommunity() : get('/auth/community'));
export const inviteInfo = (token) => (isV2() ? notOnV2('Sign-in links') : get(`/auth/invite/${encodeURIComponent(token)}`));
export const demoRoster = () => (isV2() ? v2.v2DemoRoster() : get('/auth/roster'));
export const requestCode = (target) => (isV2() ? v2.v2RequestCode(target) : post('/auth/request-code', target));                 // { phone } | { invite }
let lastVerify = {};
export const verifyInfo = () => (isV2() ? v2.v2VerifyInfo() : lastVerify);
export const verifyCode = async (target, code, extra = {}) => { if (isV2()) return v2.v2Verify(target, code); const r = await post('/auth/verify', { ...target, code, ...extra }); lastVerify = r; setSession(r); return r; };
export const demoSignIn = async (body) => { if (isV2()) return v2.v2DemoSignIn(body); const r = await post('/auth/demo', body); setSession(r); return r; };
export const switchRole = async (body) => { if (isV2()) return notOnV2('Switching role'); const r = await post('/auth/switch-role', body, { auth: true }); setSession(r); return r; };
export const whoAmI = async () => {
  if (isV2()) return v2.v2WhoAmI();
  const res = await apiFetch('/auth/me', {}, { slug: slug() });
  if (!res.ok) throw new Error('Not signed in.');
  return res.json();
};
export const renew = async () => {   // the refresh cookie -> a new access token
  if (isV2()) return v2.v2Renew();
  try { const res = await apiFetch('/auth/refresh', { method: 'POST', body: '{}' }, { slug: slug(), auth: false, retries: 0 }); if (!res.ok) return null; const r = await res.json(); setSession(r); return r; }
  catch { return null; }
};
export const signOutRemote = () => (isV2() ? v2.v2Logout() : post('/auth/logout', {}).catch(() => {}));
