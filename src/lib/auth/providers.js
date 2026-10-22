// AuthProvider: how a person proves who they are. The rest of the app depends only on this shape and on the TOKEN it produces
// (claims: sub, community[], role; the person's roles and units are read from the `users` table by the server):
//
//   restore()  -> user | null     quietly get a session back after a page reload (refresh cookie / identity-provider session)
//   signOut()                     end it
//   (LocalOtpProvider also has requestCode / verify; OidcProvider has start / finishCallback)
//
// LocalOtpProvider  the back end sends a one-time code to the registered phone (AUTH_PROVIDER=local).
// OidcProvider      Keycloak / Auth0 / Entra ...: Authorization Code + PKCE in the browser (AUTH_PROVIDER=oidc). The provider only says WHO;
//                   the community's own users table says what they may do, so changing a role never needs a change in the provider.
import { renew, requestCode, verifyCode, signOutRemote, demoSignIn, switchRole as switchRoleApi } from './authApi.js';
import { clearSession, setSession, setRefresher, getAccessToken } from './session.js';

export class LocalOtpProvider {
  id = 'local';
  async restore() {
    // a sign-out the server did not hear about (offline at the time): tell it now, and do not quietly sign back in with the old cookie
    if (pendingSignOut()) { if (await signOutRemote()) setPendingSignOut(false); return null; }
    const r = await renew(); return r?.user || null;
  }
  requestCode(target) { return requestCode(target); }
  verify(target, code, extra) { return verifyCode(target, code, extra).then((r) => r.user); }
  demo(body) { return demoSignIn(body).then((r) => r.user); }
  switchRole(body) { return switchRoleApi(body).then((r) => r.user); }
  async signOut() { const told = await signOutRemote(); setPendingSignOut(!told); clearSession(); return false; }
}

// kept in localStorage (every tab of this browser shares the refresh cookie); cleared by the next sign-in
const PENDING_SIGN_OUT = 'communityos:pendingSignOut';
const pendingSignOut = () => { try { return localStorage.getItem(PENDING_SIGN_OUT) === '1'; } catch { return false; } };
export function setPendingSignOut(on) { try { if (on) localStorage.setItem(PENDING_SIGN_OUT, '1'); else localStorage.removeItem(PENDING_SIGN_OUT); } catch { /* ignore */ } }

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rnd = (n = 32) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const KEYS = { verifier: 'communityos:oidc:verifier', state: 'communityos:oidc:state', refresh: 'communityos:oidc:rt' };

export class OidcProvider {
  id = 'oidc';
  /** @param {{ issuer: string, clientId: string, redirectUri?: string, scope?: string }} cfg */
  constructor(cfg) { this.cfg = { scope: 'openid profile email phone', redirectUri: `${window.location.origin}${window.location.pathname}`, ...cfg }; }
  async #meta() { return this.meta ||= await (await fetch(`${this.cfg.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`)).json(); }
  async start() {
    const verifier = rnd(48); const state = rnd(16);
    sessionStorage.setItem(KEYS.verifier, verifier); sessionStorage.setItem(KEYS.state, state);
    const challenge = b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const m = await this.#meta();
    const q = new URLSearchParams({ response_type: 'code', client_id: this.cfg.clientId, redirect_uri: this.cfg.redirectUri, scope: this.cfg.scope, state, code_challenge: challenge, code_challenge_method: 'S256' });
    window.location.assign(`${m.authorization_endpoint}?${q}`);
  }
  async #token(params) {
    const m = await this.#meta();
    const res = await fetch(m.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.cfg.clientId, ...params }) });
    if (!res.ok) throw new Error('The identity provider refused the sign-in. Please try again.');
    const t = await res.json();
    if (t.refresh_token) sessionStorage.setItem(KEYS.refresh, t.refresh_token);
    setSession({ accessToken: t.access_token, expiresIn: t.expires_in });
    return t;
  }
  /** Call on the redirect back from the provider (?code=...&state=...). Returns true when a session was started. */
  async finishCallback() {
    const q = new URLSearchParams(window.location.search); const code = q.get('code');
    if (!code) return false;
    if (q.get('state') !== sessionStorage.getItem(KEYS.state)) throw new Error('Sign-in was not started from this page. Please try again.');
    await this.#token({ grant_type: 'authorization_code', code, redirect_uri: this.cfg.redirectUri, code_verifier: sessionStorage.getItem(KEYS.verifier) });
    sessionStorage.removeItem(KEYS.verifier); sessionStorage.removeItem(KEYS.state);
    window.history.replaceState(null, '', window.location.pathname + window.location.hash);
    return true;
  }
  async restore() {
    const rt = sessionStorage.getItem(KEYS.refresh); if (!rt) return null;
    try { await this.#token({ grant_type: 'refresh_token', refresh_token: rt }); return {}; } catch { sessionStorage.removeItem(KEYS.refresh); return null; }
  }
  async signOut() {
    sessionStorage.removeItem(KEYS.refresh); clearSession();
    try { const m = await this.#meta(); if (m.end_session_endpoint) { window.location.assign(`${m.end_session_endpoint}?post_logout_redirect_uri=${encodeURIComponent(this.cfg.redirectUri)}&client_id=${this.cfg.clientId}`); return true; } } catch { /* signed out here at least */ }
    return false;
  }
}

let active = null;
/** The provider the back end asked for (GET /auth/config). The renewal hook is registered here, once. */
export function authProviderFor(config) {
  if (active && active.id === (config.provider || 'local')) return active;
  active = config.provider === 'oidc'
    ? new OidcProvider({ issuer: config.oidc?.issuer, clientId: config.oidc?.clientId || import.meta.env.VITE_OIDC_CLIENT_ID || 'communityos-web' })
    : new LocalOtpProvider();
  setRefresher(async () => { const u = await active.restore(); return !!u && !!getAccessToken(); });
  return active;
}
