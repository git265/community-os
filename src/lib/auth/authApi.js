// The sign-in calls to the back end (see backend/contract-server/auth.mjs and docs/INTEGRATIONS.md "Sign-in").
import { apiFetch, failureOf } from '../net/request.js';
import { resolveSlug } from '../community.js';
import { setSession, setAuthConfig, getAuthConfig } from './session.js';

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
  let cfg;
  try { cfg = await get('/auth/config'); } catch { cfg = { mode: 'open', provider: 'local' }; }   // an older back end has no sign-in: it behaves as before
  setAuthConfig(cfg);
  return cfg;
}
export const publicCommunity = () => get('/auth/community');
export const inviteInfo = (token) => get(`/auth/invite/${encodeURIComponent(token)}`);
export const demoRoster = () => get('/auth/roster');
export const requestCode = (target) => post('/auth/request-code', target);                 // { phone } | { invite }
let lastVerify = {};
export const verifyInfo = () => lastVerify;
export const verifyCode = async (target, code, extra = {}) => { const r = await post('/auth/verify', { ...target, code, ...extra }); lastVerify = r; setSession(r); return r; };
export const demoSignIn = async (body) => { const r = await post('/auth/demo', body); setSession(r); return r; };
export const switchRole = async (body) => { const r = await post('/auth/switch-role', body, { auth: true }); setSession(r); return r; };
export const whoAmI = async () => {
  const res = await apiFetch('/auth/me', {}, { slug: slug() });
  if (!res.ok) throw new Error('Not signed in.');
  return res.json();
};
export const renew = async () => {   // the refresh cookie -> a new access token
  try { const res = await apiFetch('/auth/refresh', { method: 'POST', body: '{}' }, { slug: slug(), auth: false, retries: 0 }); if (!res.ok) return null; const r = await res.json(); setSession(r); return r; }
  catch { return null; }
};
export const signOutRemote = () => post('/auth/logout', {}).catch(() => {});
