// ONE way the app talks to the back end. Everything that calls the API (records, files, payments, GST, sign-in) goes through here, so
// the rules for timeouts, retries, renewing a token and reading an error live in one place.
//
//   timeouts   reads 15 s, writes 30 s, file bytes 120 s  (a request that does not answer is abandoned, never left spinning)
//   retries    GET only, twice, when the network drops or the server says 502/503/504 (a read is safe to repeat; a write never is)
//   sign-in    a 401 renews the access token once and repeats the request; if that fails the person is signed out with a message
//   errors     403 -> AuthzError (message from the server), 409 -> ConflictError (carries the stored record), others -> Error
import { getDataSource } from '../storage/dataSource.js';
import { getAccessToken, refreshSession, clearSession, serverEnforces, serverDecides } from '../auth/session.js';

export class NetworkError extends Error { constructor(msg) { super(msg); this.name = 'NetworkError'; } }
export class TimeoutError extends Error { constructor(msg) { super(msg); this.name = 'TimeoutError'; } }
export class HttpFailure extends Error { constructor(status, message, body) { super(message); this.name = 'HttpFailure'; this.status = status; this.body = body; this.code = body?.code; } }

const TIMEOUTS = { read: 15000, write: 30000, bytes: 120000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_STATUS = new Set([502, 503, 504]);

async function once(url, init, timeout) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  init.signal?.addEventListener('abort', () => ctl.abort(), { once: true });   // the caller can stop it too (a long-lived stream)
  try { return await fetch(url, { ...init, signal: ctl.signal }); }
  catch (e) {
    if (e?.name === 'AbortError') throw new TimeoutError('The server is taking too long to answer. Nothing was lost - please try again in a moment.');
    throw new NetworkError('The back end is not reachable. Check your connection, or switch the Data source back to Session.');
  } finally { clearTimeout(timer); }
}

/**
 * fetch() with the community header, the access token, a timeout, safe retries for reads and one token renewal.
 * @param {{ base?: string, slug?: string, bytes?: boolean, retries?: number, timeout?: number, auth?: boolean }} opts
 */
export async function apiFetch(path, init = {}, opts = {}) {
  const { baseUrl, token: devKey } = getDataSource();
  const method = (init.method || 'GET').toUpperCase();
  const isRead = method === 'GET' || method === 'HEAD';
  const timeout = opts.timeout || (opts.bytes ? TIMEOUTS.bytes : isRead ? TIMEOUTS.read : TIMEOUTS.write);
  // A write carries an Idempotency-Key (the same one on every repeat of THIS call), so a repeat the server already did is answered, not done twice.
  // Only a server that enforces access understands it; files (bytes) and sign-in calls are left out.
  const keyed = !isRead && serverDecides() && !opts.bytes && !/\/content$|^\/auth\//.test(path);
  const idemKey = keyed ? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 8)}` : '';
  const maxRetries = opts.retries ?? (isRead ? 2 : keyed ? 1 : 0);   // a keyed write may be repeated once after a network failure (never after a timeout the server may have honoured... it replays anyway)
  let renewed = false;
  for (let attempt = 0; ; attempt++) {
    const bearer = opts.auth === false ? '' : (getAccessToken() || devKey);
    const headers = { ...(init.body && !(init.body instanceof Blob) && !init.headers?.['Content-Type'] ? { 'Content-Type': 'application/json' } : {}), ...(opts.slug ? { 'X-Community-Id': opts.slug } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(idemKey ? { 'Idempotency-Key': idemKey } : {}), ...(init.headers || {}) };
    let res;
    try { res = await once(`${opts.base || baseUrl}${path}`, { credentials: 'include', ...init, headers }, timeout); }
    catch (e) { if (attempt < maxRetries && e instanceof NetworkError) { await sleep(300 * 3 ** attempt); continue; } throw e; }
    if (RETRY_STATUS.has(res.status) && attempt < maxRetries) { await sleep(300 * 3 ** attempt); continue; }
    if (res.status === 429 && isRead && attempt < maxRetries) { await sleep(Math.min(5000, (Number(res.headers.get('Retry-After')) || 1) * 1000)); continue; }   // asked to slow down: wait as told, then repeat the read
    if (res.status === 401 && serverEnforces() && opts.auth !== false && !renewed) {
      renewed = true;
      if (await refreshSession()) continue;           // a fresh token: repeat the request once
      clearSession('Your session has ended. Please sign in again.');
    }
    return res;
  }
}

/** Reads a failed response into the right kind of error. */
export async function failureOf(res, what = '') {
  let body = null; try { body = await res.clone().json(); } catch { /* not JSON */ }
  const msg = body?.message || `Back end error ${res.status}`;
  if (res.status === 401 && serverEnforces()) clearSession(body?.code === 'deactivated' ? 'Your portal access has been withdrawn. Please contact the community office.' : 'Your session has ended. Please sign in again.');
  return new HttpFailure(res.status, what ? `${msg} (${what})` : msg, body);
}
