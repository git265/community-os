// Sign-in, sessions and tokens for the contract server. Mirrors the Spring `Authenticator` port (see docs/INTEGRATIONS.md "Sign-in").
//
//   AUTH_MODE=open     (default, developer convenience) nobody signs in; the API behaves as before.
//   AUTH_MODE=enforce  every /api call except /health and /auth/* needs "Authorization: Bearer <access token>".
//   AUTH_PROVIDER=local  the server itself sends/checks one-time codes (phone) and issues tokens (HS256).
//   AUTH_PROVIDER=oidc   an identity provider (Keycloak ...) issues the tokens; the server only VALIDATES them (RS256 via JWKS).
//
// Whatever the provider, the application sees ONE shape: a token whose claims are
//   sub (user id or the provider's subject), community (LIST of community ids, or "*"), role (optional), sid (local sessions)
// and it looks the person up in the `users` table. Roles stay in `users`/`roles`; the provider never decides them.
import crypto from 'node:crypto';

export class AuthError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); } }

const env = process.env;
export const CFG = {
  mode: env.AUTH_MODE === 'enforce' ? 'enforce' : 'open',
  provider: env.AUTH_PROVIDER === 'oidc' ? 'oidc' : 'local',
  production: env.NODE_ENV === 'production',
  demoRoster: env.DEMO_ROSTER === 'true',                       // production refuses to start with this on
  otpDelivery: env.OTP_DELIVERY || 'echo',                      // echo: return the code (demo) | log: print it | (production: an SMS/WhatsApp provider)
  accessTtl: Number(env.ACCESS_TOKEN_MINUTES || 15) * 60,
  refreshTtl: Number(env.REFRESH_TOKEN_DAYS || 7) * 86400,
  otpTtl: Number(env.OTP_MINUTES || 5) * 60,
  otpTries: Number(env.OTP_TRIES || 3),
  resendGap: Number(env.OTP_RESEND_SECONDS || 20),
  codesPerPhoneHour: Number(env.OTP_PER_PHONE_HOUR || 5),
  codesPerIpHour: Number(env.OTP_PER_IP_HOUR || 30),
  lockAfter: Number(env.LOCK_AFTER_FAILURES || 5),
  lockMinutes: Number(env.LOCK_MINUTES || 15),
  issuer: env.JWT_ISSUER || 'communityos',
  oidcIssuer: env.OIDC_ISSUER_URI || '',
  oidcAudience: env.OIDC_AUDIENCE || '',
  communityClaim: env.JWT_TENANT_CLAIM || 'community',
  subjectMatch: env.OIDC_USER_MATCH || 'subject,phone,email',     // how an OIDC identity is matched to a users row, in order
  secureCookie: env.COOKIE_SECURE === 'true' || env.NODE_ENV === 'production',
};
if (CFG.production && CFG.demoRoster) throw new Error('DEMO_ROSTER=true is not allowed when NODE_ENV=production.');
if (CFG.production && CFG.otpDelivery === 'echo') throw new Error('OTP_DELIVERY=echo returns the code in the response; not allowed when NODE_ENV=production.');
if (CFG.production && CFG.mode !== 'enforce') throw new Error('AUTH_MODE must be "enforce" when NODE_ENV=production.');
const SECRET = env.JWT_SECRET || (CFG.mode === 'enforce' && CFG.provider === 'local' && CFG.production ? (() => { throw new Error('Set JWT_SECRET.'); })() : crypto.randomBytes(32).toString('hex'));

// ---- small helpers ---------------------------------------------------------------------------------------------
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const now = () => Math.floor(Date.now() / 1000);
export const phoneKey = (raw) => { const d = String(raw ?? '').replace(/[^\d]/g, ''); return d ? `+${d}` : ''; };
const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

export function signJwt(claims, ttl = CFG.accessTtl) {
  const body = { iss: CFG.issuer, iat: now(), exp: now() + ttl, ...claims };
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const data = `${head}.${b64u(JSON.stringify(body))}`;
  return `${data}.${crypto.createHmac('sha256', SECRET).update(data).digest('base64url')}`;
}

// ---- OIDC: validate RS256 tokens against the provider's JWKS ------------------------------------------------------
let jwks = { at: 0, keys: [] };
async function jwksKey(kid) {
  if (Date.now() - jwks.at > 10 * 60e3 || !jwks.keys.find((k) => k.kid === kid)) {
    const conf = await (await fetch(`${CFG.oidcIssuer.replace(/\/$/, '')}/.well-known/openid-configuration`)).json();
    jwks = { at: Date.now(), keys: (await (await fetch(conf.jwks_uri)).json()).keys || [] };
  }
  const k = jwks.keys.find((x) => x.kid === kid);
  if (!k) throw new AuthError(401, 'Unknown signing key.');
  return crypto.createPublicKey({ key: k, format: 'jwk' });
}

/** Verifies a bearer token and returns its claims. Never trusts anything before the signature is checked. */
export async function verifyJwt(token) {
  const [h, p, s] = String(token || '').split('.');
  if (!h || !p || !s) throw new AuthError(401, 'Sign in again.');
  let head, claims;
  try { head = JSON.parse(Buffer.from(h, 'base64url')); claims = JSON.parse(Buffer.from(p, 'base64url')); } catch { throw new AuthError(401, 'Sign in again.'); }
  if (CFG.provider === 'oidc') {
    if (head.alg !== 'RS256') throw new AuthError(401, 'Sign in again.');
    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), await jwksKey(head.kid), Buffer.from(s, 'base64url'));
    if (!ok) throw new AuthError(401, 'Sign in again.');
    if (claims.iss !== CFG.oidcIssuer) throw new AuthError(401, 'Sign in again.');
    if (CFG.oidcAudience && ![].concat(claims.aud || []).includes(CFG.oidcAudience)) throw new AuthError(401, 'Sign in again.');
  } else {
    if (head.alg !== 'HS256') throw new AuthError(401, 'Sign in again.');   // rejects alg:none and algorithm-confusion tokens
    const want = crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url');
    if (!eq(want, s)) throw new AuthError(401, 'Sign in again.');
    if (claims.iss !== CFG.issuer) throw new AuthError(401, 'Sign in again.');
  }
  if (!claims.exp || claims.exp < now()) throw new AuthError(401, 'Your session has expired.', { code: 'expired' });
  return claims;
}

/** The claims contract: does this token allow this community? community may be a list, a single id, or "*". */
export function allowsCommunity(claims, tenant) {
  const v = claims[CFG.communityClaim];
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : [];
  return list.includes('*') || list.includes(tenant);
}

// ---- the auth service ------------------------------------------------------------------------------------------------
export const maskPhone = (e164) => (e164 ? `${e164.slice(0, 3)}••••••${e164.slice(-3)}` : '');

export function createAuth({ pool, getUsers, getUser, list, get, audit }) {
  const cookieName = 'cos_rt';
  const readCookie = (req) => (String(req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === cookieName) || [])[1] || '';
  const setCookie = (res, value, maxAge) => res.setHeader('Set-Cookie', `${cookieName}=${value}; HttpOnly; Path=/api/auth; SameSite=${CFG.secureCookie ? 'None' : 'Lax'}; Max-Age=${maxAge}${CFG.secureCookie ? '; Secure' : ''}`);
  const ipOf = (req) => (process.env.TRUST_PROXY === 'true' && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket?.remoteAddress || '';   // X-Forwarded-For is believed only behind a proxy you run (TRUST_PROXY=true)

  async function count(key, seconds) {
    return Number((await pool.query(`SELECT count(*) FROM auth_attempts WHERE key=$1 AND at > now() - ($2 || ' seconds')::interval`, [key, String(seconds)])).rows[0].count);
  }
  const note = (key) => pool.query('INSERT INTO auth_attempts (key) VALUES ($1)', [key]);

  async function usersByPhone(tenant, phone) {
    // the users table has the number as digits: an index lookup, not a scan of every user
    return (await pool.query('SELECT data FROM users WHERE tenant=$1 AND phone=$2', [tenant, String(phone).replace(/\D/g, '')])).rows.map((r) => r.data);
  }
  const roleInfo = async (tenant, ids) => { const all = await list(tenant, 'roles'); return ids.map((id) => { const r = all.find((x) => x.id === id); return { id, name: r?.name || id, category: r?.category || '' }; }); };
  const rolesOf = (u) => [u.roleId, ...(u.extraRoleIds || [])].filter(Boolean);
  const publicUser = (u, roleId, unit) => ({ id: u.id, name: u.name, roleId, roleIds: rolesOf(u), units: u.units || [], unit: unit ?? (u.units || [])[0] ?? '', blocks: u.blocks || [], email: u.email || '', phone: u.phone || '' });

  function accessToken({ tenant, userId, roleId, sid, demo, profile, communities }) {
    return signJwt({ sub: userId, sid, role: roleId, demo: !!demo, [CFG.communityClaim]: communities || [tenant], ...(demo ? { name: profile?.name, units: profile?.units || [], blocks: profile?.blocks || [] } : {}) });
  }

  async function startSession(req, res, { tenant, userId, roleId, demo = false, profile = null }) {
    const sid = crypto.randomUUID(); const refresh = crypto.randomBytes(32).toString('base64url');
    await pool.query(`INSERT INTO sessions (id, tenant, user_id, role_id, refresh_hash, demo, profile, ip, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + ($9 || ' seconds')::interval)`,
      [sid, tenant, userId, roleId, sha(refresh), demo, profile ? JSON.stringify(profile) : null, ipOf(req), String(CFG.refreshTtl)]);
    setCookie(res, refresh, CFG.refreshTtl);
    return { accessToken: accessToken({ tenant, userId, roleId, sid, demo, profile }), expiresIn: CFG.accessTtl, sid };
  }

  // the phone number a request is about: typed in, or (invite link) read from the invite so the link never has to reveal it
  async function phoneOf(tenant, body) {
    if (body.invite) {
      const inv = (await list(tenant, 'portalInvites')).find((i) => i.token === String(body.invite));
      if (!inv) throw new AuthError(404, 'This sign-in link is not valid. Ask the community office for a new one.');
      return phoneKey(inv.phone);
    }
    return phoneKey(body.phone);
  }

  const handlers = {
    // GET /api/auth/config : what the sign-in screen needs before anyone is signed in
    async config() {
      return { mode: CFG.mode, authority: CFG.mode === 'enforce' ? 'server' : 'browser', provider: CFG.provider, demoRoster: CFG.demoRoster && !CFG.production, otpEcho: CFG.otpDelivery === 'echo', oidc: CFG.provider === 'oidc' ? { issuer: CFG.oidcIssuer, clientId: env.OIDC_CLIENT_ID || 'communityos-web' } : null, accessTokenSeconds: CFG.accessTtl };
    },

    // GET /api/auth/community : the little the sign-in screen may show before anyone is signed in
    async community(tenant) {
      const c = await get('platform', 'communities', tenant);
      if (!c) throw new AuthError(404, 'No such community.');
      return { id: c.id, slug: c.slug, name: c.name, status: c.status, unitTypes: c.unitTypes || '' };
    },

    // GET /api/auth/invite/{token} : what the "you were registered" link may reveal (never the full phone number)
    async invite(tenant, token) {
      const inv = (await list(tenant, 'portalInvites')).find((i) => i.token === token);
      if (!inv) return { state: 'unknown' };
      const u = (await getUsers(tenant)).find((x) => x.phone && phoneKey(x.phone) === phoneKey(inv.phone));
      const state = inv.status === 'Revoked' || !u || u.status === 'Inactive' ? 'revoked' : (inv.expiresAt < new Date().toISOString().slice(0, 10) ? 'expired' : 'ok');
      return { state, personName: inv.personName || '', unit: inv.unit || '', phoneMasked: maskPhone(phoneKey(inv.phone)) };
    },

    // GET /api/auth/roster : demo roster only (DEMO_ROSTER=true): the roles / people / units to pick from on the demo sign-in tabs
    async roster(tenant) {
      if (!CFG.demoRoster || CFG.production) throw new AuthError(404, 'Not found.');
      const [roles, props, users] = await Promise.all([list(tenant, 'roles'), list(tenant, 'properties'), getUsers(tenant)]);
      return { roles: roles.map((r) => ({ id: r.id, name: r.name, category: r.category })), units: props.map((p) => ({ unit: p.unit, owner: p.owner })), people: users.filter((u) => u.status !== 'Inactive').map((u) => ({ id: u.id, name: u.name, roleId: u.roleId, extraRoleIds: u.extraRoleIds || [], units: u.units || [], blocks: u.blocks || [] })) };
    },

    // POST /api/auth/request-code {phone | invite}
    async requestCode(req, tenant, body) {
      if (CFG.provider !== 'local') throw new AuthError(404, 'Codes are sent by your identity provider.');
      const phone = await phoneOf(tenant, body);
      if (phone.length < 8) throw new AuthError(400, 'Enter the phone number with its country code, e.g. +91 98450 71234.');
      const ip = ipOf(req);
      if (await count(`code:ip:${ip}`, 3600) >= CFG.codesPerIpHour) throw new AuthError(429, 'Too many requests from this network. Try again later.');
      if (await count(`fail:phone:${tenant}:${phone}`, CFG.lockMinutes * 60) >= CFG.lockAfter) throw new AuthError(429, `Too many wrong codes. This number is locked for ${CFG.lockMinutes} minutes.`, { code: 'locked' });
      await note(`code:ip:${ip}`);
      const users = await usersByPhone(tenant, phone);
      if (!users.length) throw new AuthError(404, 'This number is not registered in this community. Ask the community office to add it to your property.');
      if (users.every((u) => u.status === 'Inactive')) throw new AuthError(403, 'Access for this number has been deactivated. Please contact the community office.');
      const last = (await pool.query(`SELECT extract(epoch from now()-created_at) AS age FROM auth_codes WHERE tenant=$1 AND phone=$2 ORDER BY created_at DESC LIMIT 1`, [tenant, phone])).rows[0];
      if (last && Number(last.age) < CFG.resendGap) throw new AuthError(429, `Please wait ${Math.ceil(CFG.resendGap - Number(last.age))} seconds before asking for another code.`);
      if (await count(`code:phone:${tenant}:${phone}`, 3600) >= CFG.codesPerPhoneHour) throw new AuthError(429, 'Too many codes asked for this number. Try again in an hour.');
      await note(`code:phone:${tenant}:${phone}`);
      const code = String(100000 + crypto.randomInt(900000)); const salt = crypto.randomBytes(8).toString('hex');
      await pool.query(`UPDATE auth_codes SET used_at=now() WHERE tenant=$1 AND phone=$2 AND used_at IS NULL`, [tenant, phone]);
      await pool.query(`INSERT INTO auth_codes (tenant, phone, salt, code_hash, expires_at) VALUES ($1,$2,$3,$4, now() + ($5 || ' seconds')::interval)`, [tenant, phone, salt, sha(`${salt}:${tenant}:${phone}:${code}`), String(CFG.otpTtl)]);
      if (CFG.otpDelivery === 'log') console.log(`[otp] ${tenant} ${phone}: ${code}`);   // production: replace with the SMS / WhatsApp provider
      return { sent: true, phone, expiresIn: CFG.otpTtl, ...(CFG.otpDelivery === 'echo' ? { code } : {}) };
    },

    // POST /api/auth/verify {phone, code, roleId?}
    async verify(req, res, tenant, body) {
      if (CFG.provider !== 'local') throw new AuthError(404, 'Sign in through your identity provider.');
      const phone = await phoneOf(tenant, body); const code = String(body.code ?? '').trim();
      if (await count(`fail:phone:${tenant}:${phone}`, CFG.lockMinutes * 60) >= CFG.lockAfter) throw new AuthError(429, `Too many wrong codes. This number is locked for ${CFG.lockMinutes} minutes.`, { code: 'locked' });
      const row = (await pool.query(`SELECT * FROM auth_codes WHERE tenant=$1 AND phone=$2 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1`, [tenant, phone])).rows[0];
      if (!row) throw new AuthError(400, 'Ask for a code first.');
      if (new Date(row.expires_at) < new Date()) { await pool.query('UPDATE auth_codes SET used_at=now() WHERE id=$1', [row.id]); throw new AuthError(400, 'That code has expired. Ask for a new one.'); }
      if (row.tries >= CFG.otpTries) { await pool.query('UPDATE auth_codes SET used_at=now() WHERE id=$1', [row.id]); throw new AuthError(400, 'Too many wrong attempts. Ask for a new code.'); }
      const bump = await pool.query('UPDATE auth_codes SET tries = tries + 1 WHERE id=$1 AND tries < $2 RETURNING tries', [row.id, CFG.otpTries]);   // atomic: parallel guesses cannot exceed the limit
      if (!bump.rowCount) throw new AuthError(400, 'Too many wrong attempts. Ask for a new code.');
      if (!eq(sha(`${row.salt}:${tenant}:${phone}:${code}`), row.code_hash)) {
        await note(`fail:phone:${tenant}:${phone}`);
        const left = CFG.otpTries - bump.rows[0].tries;
        await audit(tenant, { who: phone, what: 'Sign-in', action: 'Sign-in failed', summary: `Wrong code for ${phone}`, ip: ipOf(req) });
        throw new AuthError(400, `That code is not right (${left} attempt${left === 1 ? '' : 's'} left).`);
      }
      await pool.query('UPDATE auth_codes SET used_at=now() WHERE id=$1', [row.id]);
      const users = (await usersByPhone(tenant, phone)).filter((u) => u.status !== 'Inactive');
      let u = users[0];
      if (!u) throw new AuthError(403, 'Access for this number is no longer active.');
      if (u.status === 'Invited') u = await activate(tenant, u);
      await pool.query(`UPDATE documents SET data = data || $3::jsonb, updated_at = now() WHERE tenant=$1 AND collection='portalInvites' AND regexp_replace(coalesce(data->>'phone',''), '[^0-9]', '', 'g') = $2 AND data->>'status' = 'Sent'`, [tenant, phone.replace(/\D/g, ''), JSON.stringify({ status: 'Accepted', acceptedAt: new Date().toISOString() })]);
      const roleIds = rolesOf(u);
      const roleId = body.roleId && roleIds.includes(body.roleId) ? body.roleId : roleIds[0];
      const s = await startSession(req, res, { tenant, userId: u.id, roleId, profile: body.unit && (u.units || []).includes(body.unit) ? { unit: body.unit } : null });
      await audit(tenant, { who: u.name, what: 'Sign-in', action: 'Sign-in', summary: `${u.name} signed in as ${roleId}`, ip: ipOf(req) });
      return { accessToken: s.accessToken, expiresIn: s.expiresIn, user: publicUser(u, roleId, body.unit && (u.units || []).includes(body.unit) ? body.unit : undefined), roles: await roleInfo(tenant, roleIds) };
    },

    // POST /api/auth/demo {roleId, name, units, blocks}  : only when DEMO_ROSTER=true (never in production)
    async demo(req, res, tenant, body) {
      if (!CFG.demoRoster || CFG.production) throw new AuthError(404, 'Not found.');
      if (!body.roleId) throw new AuthError(400, 'Choose a role.');
      const units = [].concat(body.units || []).slice(0, 20);
      const profile = { name: String(body.name || body.roleId).slice(0, 80), units, unit: body.unit || units[0] || '', blocks: [].concat(body.blocks || []).slice(0, 20) };
      const s = await startSession(req, res, { tenant, userId: `demo:${body.userId || body.roleId}`, roleId: body.roleId, demo: true, profile });
      await audit(tenant, { who: profile.name, what: 'Sign-in', action: 'Sign-in', summary: `${profile.name} signed in (demo roster) as ${body.roleId}`, ip: ipOf(req) });
      return { accessToken: s.accessToken, expiresIn: s.expiresIn, user: { id: `demo:${body.userId || body.roleId}`, name: profile.name, roleId: body.roleId, roleIds: [body.roleId], units: profile.units, blocks: profile.blocks, email: '', phone: '' } };
    },

    // POST /api/auth/refresh : cookie in, new access token + rotated cookie out. Presenting an OLD refresh token revokes the session.
    async refresh(req, res, tenant) {
      const token = readCookie(req);
      if (!token) throw new AuthError(401, 'Sign in again.');
      const h = sha(token);
      const s = (await pool.query('SELECT * FROM sessions WHERE refresh_hash=$1 OR used_hashes @> ARRAY[$1]::text[]', [h])).rows[0];
      if (!s) throw new AuthError(401, 'Sign in again.');
      if (s.refresh_hash !== h) { await pool.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [s.id]); throw new AuthError(401, 'Sign in again.'); }
      if (s.revoked_at || new Date(s.expires_at) < new Date()) throw new AuthError(401, 'Sign in again.');
      if (tenant && s.tenant !== tenant) throw new AuthError(401, 'Sign in again.');
      let user = null;
      if (!s.demo) {
        user = await getUser(s.tenant, s.user_id);
        if (!user || user.status === 'Inactive') { await pool.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [s.id]); throw new AuthError(401, 'Access has been withdrawn. Please contact the community office.'); }
      }
      const next = crypto.randomBytes(32).toString('base64url');
      await pool.query(`UPDATE sessions SET used_hashes = (used_hashes || refresh_hash)[GREATEST(1, cardinality(used_hashes || refresh_hash) - 99):cardinality(used_hashes || refresh_hash)], refresh_hash=$2, last_used_at=now() WHERE id=$1`, [s.id, sha(next)]);
      setCookie(res, next, CFG.refreshTtl);
      const roleId = user && !rolesOf(user).includes(s.role_id) ? rolesOf(user)[0] : s.role_id;
      return { accessToken: accessToken({ tenant: s.tenant, userId: s.user_id, roleId, sid: s.id, demo: s.demo, profile: s.profile }), expiresIn: CFG.accessTtl, user: user ? publicUser(user, roleId, s.profile?.unit) : { id: s.user_id, roleId, roleIds: [roleId], ...(s.profile || {}) } };
    },

    // POST /api/auth/switch-role {roleId} (needs the access token) : a person with several roles changes the one the session acts as
    async switchRole(req, res, claims, tenant, body) {
      const s = (await pool.query('SELECT * FROM sessions WHERE id=$1 AND revoked_at IS NULL', [claims.sid])).rows[0];
      if (!s) throw new AuthError(401, 'Sign in again.');
      const user = s.demo ? null : await getUser(s.tenant, s.user_id);
      if (s.demo) throw new AuthError(403, 'Demo sessions cannot switch role; sign in again.');
      const roleId = body.roleId || s.role_id;
      if (!user || !rolesOf(user).includes(roleId)) throw new AuthError(403, 'That role is not assigned to you.');
      if (body.unit && !(user.units || []).includes(body.unit)) throw new AuthError(403, 'That unit is not yours.');
      await pool.query('UPDATE sessions SET role_id=$2, profile = COALESCE(profile, \'{}\'::jsonb) || $3::jsonb WHERE id=$1', [s.id, roleId, JSON.stringify(body.unit ? { unit: body.unit } : {})]);
      return { accessToken: accessToken({ tenant: s.tenant, userId: s.user_id, roleId, sid: s.id, demo: false }), expiresIn: CFG.accessTtl, user: publicUser(user, roleId, body.unit) };
    },

    // GET /api/auth/me : who the token says I am, as the app needs it
    async me(p) {
      if (p.demo) return { id: p.userId, name: p.name, roleId: p.roleId, roleIds: [p.roleId], units: p.units, unit: p.unit, blocks: p.blocks, email: '', phone: '' };
      return publicUser(await getUser(p.tenant, p.userId), p.roleId, p.unit);
    },

    // POST /api/auth/logout : revokes the session behind the cookie
    async logout(req, res) {
      const token = readCookie(req);
      if (token) await pool.query('UPDATE sessions SET revoked_at=now() WHERE (refresh_hash=$1 OR used_hashes @> ARRAY[$1]::text[]) AND revoked_at IS NULL', [sha(token)]);
      setCookie(res, '', 0);
      return null;
    },
  };

  async function activate(tenant, u) {
    const next = { ...u, status: 'Active', activatedAt: new Date().toISOString() };
    await pool.query(`UPDATE users SET data = data || $3::jsonb, updated_at = now() WHERE tenant=$1 AND id=$2`, [tenant, u.id, JSON.stringify({ status: 'Active', activatedAt: next.activatedAt })]);
    return next;
  }

  /**
   * Turns a bearer token into the PRINCIPAL the rest of the server uses: { userId, roleId, name, units, blocks, demo, sid }.
   * Local tokens: the session must still be live and the users row still active. OIDC tokens: the users row is found by the provider's
   * subject / phone / email claims (OIDC_USER_MATCH); an identity with no users row is told to contact the office - never auto-created.
   */
  const principalFrom = async (req, tenant) => ({ ...(await principalInner(req, tenant)), tenant });
  async function principalInner(req, tenant) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) throw new AuthError(401, 'Sign in to continue.', { code: 'unauthenticated' });
    const claims = await verifyJwt(m[1]);
    if (!allowsCommunity(claims, tenant)) throw new AuthError(403, 'This sign-in does not cover this community.');
    if (CFG.provider === 'oidc') {
      const users = (await getUsers(tenant)).filter((u) => u.status !== 'Inactive');
      const by = { subject: (u) => u.authSubject && u.authSubject === claims.sub, phone: (u) => claims.phone_number && u.phone && phoneKey(u.phone) === phoneKey(claims.phone_number),
        email: (u) => claims.email && u.email && String(u.email).toLowerCase() === String(claims.email).toLowerCase() };
      let u = null;
      for (const how of CFG.subjectMatch.split(',')) { u = users.find(by[how.trim()] || (() => false)); if (u) break; }
      if (!u) throw new AuthError(403, 'You are signed in, but this community has no account for you yet. Please contact the community office.', { code: 'no-account' });
      const want = claims.role || claims.roleId;
      const roleId = want && rolesOf(u).includes(want) ? want : rolesOf(u)[0];
      return { userId: u.id, roleId, name: u.name, units: u.units || [], blocks: u.blocks || [], phone: u.phone || '', email: u.email || '', demo: false, sid: claims.sid || '' };
    }
    const s = (await pool.query('SELECT revoked_at, expires_at, role_id, profile FROM sessions WHERE id=$1', [claims.sid])).rows[0];
    if (!s || s.revoked_at || new Date(s.expires_at) < new Date()) throw new AuthError(401, 'Your session has ended. Please sign in again.', { code: 'expired' });
    if (claims.demo) {
      if (!CFG.demoRoster) throw new AuthError(401, 'Your session has ended. Please sign in again.');
      return { userId: claims.sub, roleId: s.role_id, name: claims.name || claims.sub, units: claims.units || [], unit: s.profile?.unit || (claims.units || [])[0] || '', blocks: claims.blocks || [], phone: '', email: '', demo: true, sid: claims.sid };
    }
    const u = await getUser(tenant, claims.sub);
    if (!u || u.status === 'Inactive') throw new AuthError(401, 'Access has been withdrawn. Please contact the community office.', { code: 'deactivated' });
    const roleId = rolesOf(u).includes(s.role_id) ? s.role_id : rolesOf(u)[0];
    const unit = s.profile?.unit && (u.units || []).includes(s.profile.unit) ? s.profile.unit : (u.units || [])[0] || '';
    return { tenant, userId: u.id, roleId, name: u.name, units: u.units || [], unit, blocks: u.blocks || [], phone: u.phone || '', email: u.email || '', demo: false, sid: claims.sid };
  }

  return { handlers, principalFrom, claimsFrom: (req) => verifyJwt((/^Bearer (.+)$/.exec(req.headers.authorization || '') || [])[1]) };
}
