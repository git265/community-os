// E-voting for registered owners.
//
// Design goals (what "no fraud" means here):
//  1. ONE VOTE PER UNIT, ONLY BY REGISTERED OWNERS. The electorate ("roll") is frozen from the Properties register the moment
//     voting opens and is fingerprinted (SHA-256). Only an owner (primary or secondary) of a unit on that roll can vote for it,
//     and the voter roll accepts one mark per unit - a second attempt is rejected.
//  2. TWO FACTORS. Factor 1 = the signed-in owner session for that unit. Factor 2 = a 6-digit one-time code sent to the owner's
//     registered mobile (5 min expiry, 3 attempts, 30 s resend gap, stored only as a salted hash). A verified code becomes a
//     single-use proof that the write path demands.
//  3. SECRET BUT VERIFIABLE BALLOT. "Who voted" (voter roll) and "what was voted" (ballot box) are separate records. The box row
//     has no unit, name or time of day. Every box row carries a receipt code the voter keeps, and rows form a hash chain
//     (each hash covers the previous one), so any later edit, deletion or insertion is detected by Verify.
//  4. NOTHING CAN BE CHANGED. Roll marks and ballot rows can never be edited or deleted - not even by the Super Admin. An open
//     ballot cannot be edited (only closed), and nobody - including admins - can read the box until the ballot is closed.
//  5. AUDITED. Opening, closing and every roll mark are audit-logged; box writes are deliberately NOT attributed to anyone.
//
// This runs in the browser, which is not a trust boundary. In production the same checks must run in the Spring Boot service
// (see README "E-voting"): OTP via an SMS/e-mail gateway, the box and roll in separate tables with separate DB roles, the
// chain head anchored by an external timestamp.
import { storage } from './storage/index.js';
import { getDataSource } from './storage/dataSource.js';
import { evote } from './storage/v2/V2ApiAdapter.js';
import { COLLECTIONS as C } from './storage/StorageAdapter.js';
import { ownersOf } from './people.js';

export const FOR_AGAINST = ['For', 'Against', 'Abstain'];
export const todayStr = () => new Date().toISOString().slice(0, 10);

// SubtleCrypto is missing in insecure contexts (plain http on a phone), so keep a small pure-JS SHA-256 as the fallback.
function sha256Js(msg) {
  const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  const bytes = new TextEncoder().encode(msg);
  const l = bytes.length; const total = (((l + 9 + 63) >> 6) << 6);
  const m = new Uint8Array(total); m.set(bytes); m[l] = 0x80;
  const dv = new DataView(m.buffer); dv.setUint32(total - 8, Math.floor((l * 8) / 4294967296)); dv.setUint32(total - 4, (l * 8) >>> 0);
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64); const rr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < total; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) { const s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3); const s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10); w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0; }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((v, i) => { H[i] = (H[i] + v) >>> 0; });
  }
  return H.map((v) => v.toString(16).padStart(8, '0')).join('');
}
export async function sha256Hex(text) {
  const s = String(text);
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return sha256Js(s);
}
export const __sha256Js = sha256Js;
const rand = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

/* ----------------------------------------------------------- electorate -- */
const last4 = (s) => String(s || '').replace(/\D/g, '').slice(-4);
/** Everyone who may vote: one entry per unit that has a registered owner. */
export function buildRoll(properties) {
  return properties
    .filter((p) => p.unit && p.owner)
    .map((p) => {
      const owners = ownersOf(p); // primary + additional owners; tenants and family contacts never vote in owner ballots
      return { unit: p.unit, owners: owners.map((o) => o.name), phones: Object.fromEntries(owners.map((o) => [o.name, last4(o.phone)])), phoneLast4: last4(p.ownerPhone) };
    })
    .sort((a, b) => String(a.unit).localeCompare(String(b.unit), undefined, { numeric: true }));
}
export const rollHash = (roll) => sha256Hex(JSON.stringify(roll));
const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
export const rollEntryFor = (ballot, unit) => (ballot?.roll || []).find((r) => r.unit === unit) || null;
/** May this signed-in person vote for this unit on this ballot? Returns '' when yes, otherwise the reason. */
export function whyCannotVote(ballot, principal) {
  if (!ballot || !principal) return 'Not signed in';
  if (typeof ballot.whyNotMe === 'string' && getDataSource().mode === 'v2') return ballot.whyNotMe;   // the v2 server decides from the frozen roll
  if (ballot.status !== 'Open') return ballot.status === 'Draft' ? 'Voting has not opened yet' : 'Voting is closed';
  const t = todayStr();
  if (t < ballot.opensOn) return `Voting opens on ${ballot.opensOn}`;
  if (t > ballot.closesOn) return 'The voting window has ended';
  if (principal.roleId !== 'owner') return 'Only registered owners can vote (tenants and other residents are not on the owners’ roll)';
  const entry = rollEntryFor(ballot, principal.unit);
  if (!entry) return `${principal.unit || 'Your unit'} is not on this ballot’s voter roll`;
  if (!entry.owners.some((o) => sameName(o, principal.name))) return 'Only the registered owner of the unit can vote for it';
  return '';
}

/* ------------------------------------------------------------ 2nd factor -- */
const OTP_TTL = 5 * 60e3; const OTP_TRIES = 3; const OTP_GAP = 30e3; const PROOF_TTL = 2 * 60e3;
const challenges = new Map(); // key -> { hash, salt, exp, tries, sentAt }
const proofs = new Map();     // token -> { key, exp }
const boxAllowance = new Map(); // key -> remaining ballot-box writes granted by the last roll mark
const keyOf = (ballotId, unit, name) => `${ballotId}|${unit}|${String(name).toLowerCase()}`;

// On the back end (v2) the code is asked for and checked THERE: the proof the voter-roll write demands has to live where the write is checked, and
// a browser is not a place to keep a second factor. The same two functions serve both modes.

/** Sends a code to the owner's registered mobile. Returns the code ONLY because this demo has no SMS gateway (shown as a simulated SMS); a real server never returns it. */
export async function requestOtp(ballot, principal) {
  if (getDataSource().mode === 'v2') return evote.request(ballot, principal?.unit);
  const reason = whyCannotVote(ballot, principal);
  if (reason) throw new Error(reason);
  const key = keyOf(ballot.id, principal.unit, principal.name);
  const prev = challenges.get(key);
  if (prev && Date.now() - prev.sentAt < OTP_GAP) throw new Error(`Please wait ${Math.ceil((OTP_GAP - (Date.now() - prev.sentAt)) / 1000)} seconds before asking for another code.`);
  const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  const salt = rand(8);
  challenges.set(key, { salt, hash: await sha256Hex(`${salt}:${key}:${code}`), exp: Date.now() + OTP_TTL, tries: 0, sentAt: Date.now() });
  const entry = rollEntryFor(ballot, principal.unit);
  return { code, phoneLast4: entry?.phones?.[entry.owners.find((o) => sameName(o, principal.name))] || entry?.phoneLast4 || '' };
}
/** Checks the code; on success returns a single-use proof token. */
export async function verifyOtp(ballot, principal, code) {
  if (getDataSource().mode === 'v2') return evote.verify(ballot, principal?.unit, code);
  const key = keyOf(ballot.id, principal.unit, principal.name);
  const ch = challenges.get(key);
  if (!ch) throw new Error('Ask for a code first.');
  if (Date.now() > ch.exp) { challenges.delete(key); throw new Error('That code has expired. Ask for a new one.'); }
  if (ch.tries >= OTP_TRIES) { challenges.delete(key); throw new Error('Too many wrong attempts. Ask for a new code.'); }
  ch.tries += 1;
  if ((await sha256Hex(`${ch.salt}:${key}:${String(code).trim()}`)) !== ch.hash) throw new Error(`That code is not right (${OTP_TRIES - ch.tries} attempt${OTP_TRIES - ch.tries === 1 ? '' : 's'} left).`);
  challenges.delete(key);
  const token = rand(16);
  proofs.set(token, { key, exp: Date.now() + PROOF_TTL });
  return token;
}
function consumeProof(token, key) {
  const pr = proofs.get(token);
  proofs.delete(token); // single use, valid or not
  return !!pr && pr.key === key && Date.now() <= pr.exp;
}

/* ------------------------------------------------------------ hash chain -- */
export const chainHash = (prev, seq, receipt, choice) => sha256Hex(`${prev}|${seq}|${receipt}|${choice}`);
export const GENESIS = '0'.repeat(64);
/** Recomputes the chain over a ballot's box rows. Returns { ok, head, count, brokenAt }. */
export async function verifyChain(rows) {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  let prev = GENESIS;
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    if (r.seq !== i + 1 || r.prevHash !== prev || r.hash !== await chainHash(prev, r.seq, r.receipt, r.choice)) return { ok: false, head: prev, count: sorted.length, brokenAt: i + 1 };
    prev = r.hash;
  }
  return { ok: true, head: prev, count: sorted.length, brokenAt: 0 };
}
export function tally(ballot, rows, rollSize) {
  const counts = Object.fromEntries((ballot.options || []).map((o) => [o, 0]));
  rows.forEach((r) => { counts[r.choice] = (counts[r.choice] || 0) + 1; });
  const cast = rows.length;
  const quorumMet = rollSize ? (cast / rollSize) * 100 >= Number(ballot.quorumPct || 0) : false;
  let outcome = '';
  if (ballot.kind === 'Resolution' && 'For' in counts && 'Against' in counts) {
    const f = counts.For || 0; const a = counts.Against || 0;
    const passes = f + a > 0 && (f / (f + a)) * 100 > Number(ballot.passPct || 50);
    outcome = !quorumMet ? 'No quorum' : passes ? 'Passed' : 'Not passed';
  } else {
    const top = Object.entries(counts).sort((x, y) => y[1] - x[1]);
    outcome = !quorumMet ? 'No quorum' : top[0] && top[0][1] > 0 && (!top[1] || top[0][1] > top[1][1]) ? `Winner: ${top[0][0]}` : 'Tie / no votes';
  }
  return { counts, cast, quorumMet, outcome, turnoutPct: rollSize ? Math.round((cast / rollSize) * 1000) / 10 : 0 };
}

/* ---------------------------------------- write-path enforcement (async) -- */
export const EV_COLLECTIONS = new Set([C.BALLOTS, C.VOTE_ROLL, C.BALLOT_BOX]);
export const EV_IMMUTABLE = new Set([C.VOTE_ROLL, C.BALLOT_BOX]);
const OPEN_LOCKED_KEYS = ['title', 'description', 'kind', 'options', 'opensOn', 'closesOn', 'quorumPct', 'passPct', 'roll', 'rollHash'];

/**
 * Called by secureStorage before every write to the e-voting collections - for EVERY role including the Super Admin.
 * Returns { error } to refuse, or { patch } to overwrite server-controlled fields.
 */
export async function evotingPreWrite({ collection, record, old, p }) {
  if (!p) return { error: 'Not signed in' };
  if (collection === C.BALLOTS) {
    if (old?.status === 'Closed') return { error: 'A closed ballot can never be changed' };
    if (old?.status === 'Open') {
      const touched = OPEN_LOCKED_KEYS.filter((k) => JSON.stringify(record[k]) !== JSON.stringify(old[k]));
      if (touched.length) return { error: 'An open ballot cannot be edited' };
      if (record.status === 'Open') return { patch: {} };
      if (record.status !== 'Closed') return { error: 'An open ballot can only be closed' };
      if (todayStr() < old.closesOn) return { error: `Voting stays open until ${old.closesOn}` };
      const rows = (await storage.list(C.BALLOT_BOX)).filter((r) => r.ballotId === old.id);
      const chain = await verifyChain(rows);
      if (!chain.ok) return { error: `The ballot box failed its integrity check at vote ${chain.brokenAt}; it cannot be closed normally` };
      return { patch: { closedAt: todayStr(), chainHead: chain.head, votesCounted: chain.count } };
    }
    if (record.status === 'Open') {
      // Draft -> Open (or created open): freeze and fingerprint the electorate
      if (!Array.isArray(record.roll) || !record.roll.length) return { error: 'The voter roll is empty' };
      if (record.rollHash !== await rollHash(record.roll)) return { error: 'The voter roll does not match its fingerprint' };
      if (!Array.isArray(record.options) || record.options.length < 2) return { error: 'A ballot needs at least two options' };
      return { patch: { openedAt: todayStr() } };
    }
    if (record.status === 'Closed') return { error: 'A ballot must be opened before it is closed' };
    return { patch: {} };
  }
  if (old) return { error: 'Voting records can never be changed or deleted' };
  const ballot = record.ballotId ? await storage.get(C.BALLOTS, record.ballotId) : null;
  if (!ballot) return { error: 'No such ballot' };
  if (collection === C.VOTE_ROLL) {
    const why = whyCannotVote(ballot, p);
    if (why) return { error: why };
    if (record.unit !== p.unit) return { error: 'You can only vote for the unit you are signed in as' };
    const dup = (await storage.list(C.VOTE_ROLL)).find((r) => r.ballotId === ballot.id && r.unit === p.unit);
    if (dup) return { error: `${p.unit} has already voted on this ballot${dup.owner ? ` (by ${dup.owner})` : ''} — one vote per villa` };
    const key = keyOf(ballot.id, p.unit, p.name);
    if (!consumeProof(record.proof, key)) return { error: 'Second-factor check missing or expired - request a new code' };
    boxAllowance.set(key, 1);
    return { patch: { proof: undefined, owner: p.name, markedOn: todayStr() } };
  }
  if (collection === C.BALLOT_BOX) {
    const key = keyOf(ballot.id, p.unit, p.name);
    if (!boxAllowance.get(key)) return { error: 'No verified voter roll mark for this ballot' };
    if (ballot.status !== 'Open') return { error: 'Voting is closed' };
    if (!(ballot.options || []).includes(record.choice)) return { error: 'That is not an option on this ballot' };
    boxAllowance.delete(key);
    const rows = (await storage.list(C.BALLOT_BOX)).filter((r) => r.ballotId === ballot.id);
    const seq = rows.length + 1;
    const prev = rows.find((r) => r.seq === seq - 1)?.hash || GENESIS;
    const receipt = rand(6);
    return { patch: { seq, prevHash: prev, receipt, hash: await chainHash(prev, seq, receipt, record.choice) } };
  }
  return { error: 'Unknown voting record' };
}
