// The signed-in session as the BROWSER holds it: an access token that lives in memory only (never localStorage / sessionStorage,
// so a script injected into the page cannot lift it from storage) and a refresh cookie the browser keeps out of reach of scripts (HttpOnly).
// Reloading the page therefore asks the server for a new access token with that cookie (see AuthProvider.restore).
let state = { token: '', exp: 0, user: null, config: null };
let refresher = null;
let inflight = null;

export const getAccessToken = () => state.token;
export const getAuthUser = () => state.user;
export const getAuthConfig = () => state.config;
/** True when the back end enforces sign-in (AUTH_MODE=enforce): then the server, not this browser, decides what a person may do. */
export const serverEnforces = () => state.config?.mode === 'enforce';
export function setAuthConfig(config) { state = { ...state, config }; }
/**
 * True when the back end, not this browser, decides what a write does: it checks the rules, stamps the version and writes the audit line.
 * That is a back end that enforces sign-in, and also the Spring service in its open development modes (it always runs its own rule book and
 * version check, and says so with `authority: 'server'`). The browser then sends the version it loaded and lets the server number the next one.
 */
export const serverDecides = () => state.config?.mode === 'enforce' || state.config?.authority === 'server';

export function setSession({ accessToken, expiresIn, user }) {
  state = { ...state, token: accessToken, exp: Date.now() + (expiresIn || 900) * 1000, user: user || state.user };
  window.dispatchEvent(new CustomEvent('communityos:auth', { detail: { signedIn: true } }));
}
export function clearSession(reason = '') {
  const was = !!state.token;
  state = { ...state, token: '', exp: 0, user: null };
  if (was || reason) window.dispatchEvent(new CustomEvent('communityos:auth', { detail: { signedIn: false, reason } }));
}
/** How the session is renewed (registered by the active AuthProvider). */
export const setRefresher = (fn) => { refresher = fn; };
/** One renewal at a time, however many requests found the token expired together. Resolves true if there is a fresh token. */
export function refreshSession() {
  if (!refresher) return Promise.resolve(false);
  inflight ||= refresher().then((ok) => ok, () => false).finally(() => { inflight = null; });
  return inflight;
}
export const tokenExpiresInMs = () => (state.token ? state.exp - Date.now() : 0);
