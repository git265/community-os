// WHICH storage the app talks to is a runtime choice, not a build choice:
//
//   session  the browser demo store (sessionStorage + IndexedDB). Nothing to install; resets with the tab.
//   v2       the back end: Spring Boot + PostgreSQL (backend/api, /api/v1). The only back end since the old /api servers were retired.
//
// The choice is kept in localStorage so it survives reloads and tabs, and can be flipped from the "Data source" panel
// (login screen, and Super Admin -> profile menu) without rebuilding. Build-time defaults:
//   VITE_USE_API=v2              start on the back end
//   VITE_API_BASE_URL=/api       where the back end lives (a Vite proxy or an absolute https://api.example.com/api)
//   VITE_API_KEY=...             optional bearer token for dev (real sign-in: see docs/BACKEND.md "Authentication")
import { apiFetch } from '../net/request.js';
const KEY = 'communityos:dataSource';

const defaults = () => ({
  mode: import.meta.env.VITE_USE_API === 'v2' || import.meta.env.VITE_USE_API === 'true' ? 'v2' : 'session',
  baseUrl: import.meta.env.VITE_API_BASE_URL || '/api',
  token: import.meta.env.VITE_API_KEY || '',
});

export function getDataSource() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved && (saved.mode === 'session' || saved.mode === 'v2')) return { ...defaults(), ...saved };   // a saved 'api' (the retired old back end) falls back to the default
  } catch { /* unavailable: use defaults */ }
  return defaults();
}

export const isApiMode = () => getDataSource().mode === 'v2';   // the back end holds the data

/** Save the choice. The app must reload afterwards, because screens keep what they loaded in memory. */
export function setDataSource(next) {
  const merged = { ...getDataSource(), ...next };
  merged.baseUrl = String(merged.baseUrl || '/api').trim().replace(/\/+$/, '') || '/api';
  try { localStorage.setItem(KEY, JSON.stringify(merged)); } catch { /* ignore */ }
  return merged;
}

/** GET {base}/health - { status, database, version, providers:{...} } or throws a readable error. */
export async function pingBackend(baseUrl = getDataSource().baseUrl, token = getDataSource().token, mode = getDataSource().mode) {
  let res;
  try {
    res = await fetch(`${String(baseUrl).replace(/\/+$/, '')}${mode === 'v2' ? '/v1/public/health' : '/health'}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  } catch {
    throw new Error('Cannot reach the back end at that address. Is it running, and is CORS allowed for this site?');
  }
  if (!res.ok) throw new Error(`The back end answered ${res.status}. Check the address and the access key.`);
  let body;
  try { body = await res.json(); } catch { throw new Error('That address did not answer like CommunityOS. Check the address.'); }
  if (!body || !body.status) throw new Error('That address did not answer like CommunityOS. Check the address.');
  return body;
}

/** fetch() against the back end with the same base address, access key and community header the storage adapter uses.
 *  Payments, GST and signed-URL file calls all go through this, so one setting (and one place to add real sign-in) covers them. */
export function backendFetch(path, init = {}, slug, base) {
  // `base` overrides the address only (a GST service on another host, say). Timeouts, safe retries, the access token and its renewal live in net/request.js.
  return apiFetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers || {}) } }, { slug, base });
}
