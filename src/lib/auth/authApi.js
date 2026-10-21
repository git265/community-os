// The sign-in calls to the back end (backend/api: /api/v1/auth, see v2Auth.js and docs/INTEGRATIONS.md "Sign-in").
// The providers (providers.js) call these; the old /api servers and their extra calls (invite links, switching role) were retired.
import { setAuthConfig, getAuthConfig } from './session.js';
import * as v2 from './v2Auth.js';

const notYet = (what) => Promise.reject(new Error(`${what} is not available on the back end yet.`));

/** What the back end requires: { mode: 'enforce', provider: 'local' | 'oidc', ... }. Cached. */
export async function loadAuthConfig() {
  if (getAuthConfig()) return getAuthConfig();
  setAuthConfig(await v2.v2LoadAuthConfig());
  return getAuthConfig();
}
export const publicCommunity = () => v2.v2PublicCommunity();
export const inviteInfo = () => notYet('Sign-in links');
export const demoRoster = () => v2.v2DemoRoster();
export const requestCode = (target) => v2.v2RequestCode(target);                 // { phone }
export const verifyInfo = () => v2.v2VerifyInfo();
export const verifyCode = (target, code) => v2.v2Verify(target, code);
export const demoSignIn = (body) => v2.v2DemoSignIn(body);
export const switchRole = () => notYet('Switching role');
export const whoAmI = () => v2.v2WhoAmI();
export const renew = () => v2.v2Renew();   // the refresh cookie -> a new access token
export const signOutRemote = () => v2.v2Logout();
