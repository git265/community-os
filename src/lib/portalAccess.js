// Phone-number sign-in and the invite link ("#/join/<token>") sent when a property is registered.
// Phone = identity. This browser demo has no SMS gateway: the one-time code is returned so the screen can show it as a simulated SMS.
// In production: the Spring Boot service sends the code/link through an SMS or WhatsApp provider and issues the session itself.
import { logEvent } from './audit/auditLog.js';
import { storage } from './storage/index.js';
import { COLLECTIONS as C } from './storage/StorageAdapter.js';
import { validatePhone, phoneKey } from './phone.js';
import { sha256Hex } from './evoting.js';

const OTP_TTL = 5 * 60e3; const TRIES = 3; const GAP = 20e3;
const challenges = new Map();
const today = () => new Date().toISOString().slice(0, 10);

/** Looks an invite up (raw storage - this runs before anyone is signed in). */
export async function lookupInvite(token) {
  const inv = (await storage.list(C.PORTAL_INVITES)).find((i) => i.token === token);
  if (!inv) return { state: 'unknown' };
  if (inv.status === 'Revoked') return { state: 'revoked', invite: inv };
  if (inv.expiresAt < today()) return { state: 'expired', invite: inv };
  const u = (await storage.list(C.USERS)).find((x) => x.phone && phoneKey(x.phone) === inv.phone);
  if (!u || u.status === 'Inactive') return { state: 'revoked', invite: inv };
  return { state: 'ok', invite: inv, user: u };
}

/** Step 1: send a one-time code to a registered phone. */
export async function requestPhoneOtp(rawPhone) {
  const v = validatePhone(rawPhone);
  if (!v.ok) throw new Error(v.error);
  const users = (await storage.list(C.USERS)).filter((u) => u.phone && phoneKey(u.phone) === v.e164);
  if (!users.length) throw new Error('This number is not registered in this community. Ask the community office to add it to your property.');
  if (users.every((u) => u.status === 'Inactive')) throw new Error('Access for this number has been deactivated (the phone number registered for the property was changed). Please contact the community office.');
  const prev = challenges.get(v.e164);
  if (prev && Date.now() - prev.sentAt < GAP) throw new Error(`Please wait ${Math.ceil((GAP - (Date.now() - prev.sentAt)) / 1000)} seconds before asking for another code.`);
  const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  const salt = Math.random().toString(16).slice(2);
  challenges.set(v.e164, { salt, hash: await sha256Hex(`${salt}:${v.e164}:${code}`), exp: Date.now() + OTP_TTL, tries: 0, sentAt: Date.now() });
  return { code, e164: v.e164, formatted: v.formatted };
}

/** Step 2: check the code. Returns the person's account row (activated if it was only invited). */
export async function verifyPhoneOtp(rawPhone, code) {
  const v = validatePhone(rawPhone);
  if (!v.ok) throw new Error(v.error);
  const ch = challenges.get(v.e164);
  if (!ch) throw new Error('Ask for a code first.');
  if (Date.now() > ch.exp) { challenges.delete(v.e164); throw new Error('That code has expired. Ask for a new one.'); }
  if (ch.tries >= TRIES) { challenges.delete(v.e164); throw new Error('Too many wrong attempts. Ask for a new code.'); }
  ch.tries += 1;
  if ((await sha256Hex(`${ch.salt}:${v.e164}:${String(code).trim()}`)) !== ch.hash) throw new Error(`That code is not right (${TRIES - ch.tries} attempt${TRIES - ch.tries === 1 ? '' : 's'} left).`);
  challenges.delete(v.e164);
  let u = (await storage.list(C.USERS)).find((x) => x.status !== 'Inactive' && x.phone && phoneKey(x.phone) === v.e164);
  if (!u) throw new Error('Access for this number is no longer active.');
  if (u.status === 'Invited') { u = { ...u, status: 'Active', activatedAt: new Date().toISOString() }; await storage.put(C.USERS, u); logEvent({ who: u.name || 'Portal user', what: 'Users', action: 'Update', recordId: u.id, recordShortId: u.shortId || '', summary: `${u.name || u.phone} activated portal access (first sign-in)`, changes: [{ field: 'status', label: 'Status', from: 'Invited', to: 'Active' }] }); }
  for (const i of (await storage.list(C.PORTAL_INVITES)).filter((x) => x.phone === v.e164 && x.status === 'Sent')) await storage.put(C.PORTAL_INVITES, { ...i, status: 'Accepted', acceptedAt: new Date().toISOString() });
  return u;
}
