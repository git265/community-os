import { todayLocal } from '../locale.js';
// ID-number checks that can be done OFFLINE, without calling any government service. They catch typos, made-up numbers and the same
// document used for two people. They do NOT prove the document is genuine or that it belongs to the person in front of you: that needs
// a licensed verification service (UIDAI via an authorised KUA/AUA, DigiLocker, or a background-check vendor). The full number is
// never stored: only the last four digits and a salted hash used to spot duplicates.

// Verhoeff checksum, the one Aadhaar numbers use.
const D = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const P = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
export function verhoeff(num) {
  let c = 0; const a = String(num).split('').reverse().map(Number);
  for (let i = 0; i < a.length; i++) c = D[c][P[i % 8][a[i]]];
  return c === 0;
}
export const clean = (s) => String(s || '').replace(/[\s-]/g, '').toUpperCase();

/** { ok, problem, last4 } for the chosen ID type. */
export function checkIdNumber(type, raw) {
  const n = clean(raw); if (!n) return { ok: false, problem: 'Enter the number' };
  const last4 = n.slice(-4);
  switch (type) {
    case 'Aadhaar':
      if (!/^\d{12}$/.test(n)) return { ok: false, problem: 'An Aadhaar number has 12 digits' };
      if (/^[01]/.test(n)) return { ok: false, problem: 'An Aadhaar number never starts with 0 or 1' };
      if (!verhoeff(n)) return { ok: false, problem: 'The check digit does not match. A digit is probably wrong.' };
      return { ok: true, last4 };
    case 'Voter ID': return /^[A-Z]{3}\d{7}$/.test(n) ? { ok: true, last4 } : { ok: false, problem: 'A voter ID is 3 letters then 7 digits' };
    case 'Passport': return /^[A-PR-WY][1-9]\d{6}$/.test(n) ? { ok: true, last4 } : { ok: false, problem: 'An Indian passport is 1 letter then 7 digits' };
    case 'Driving licence': return /^[A-Z]{2}\d{2}(19|20)?\d{2}\d{7}$/.test(n) ? { ok: true, last4 } : { ok: false, problem: 'Format: state code, RTO, year, 7 digits (for example KA0120110012345)' };
    default: return n.length >= 6 ? { ok: true, last4 } : { ok: false, problem: 'Too short' };
  }
}
export const checkVehicle = (raw) => /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}$/.test(clean(raw)) || /^\d{2}BH\d{4}[A-Z]{1,2}$/.test(clean(raw));

/** Salted SHA-256 so two people with the same document number can be spotted without keeping the number. */
export async function idHash(type, raw, salt = 'communityos') {
  const data = new TextEncoder().encode(`${salt}|${type}|${clean(raw)}`);
  const h = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** How stale is a registry record? Returns problems worth a human's attention. */
export function freshness(p, { lastSeen, today = todayLocal(), staleDays = 60, reverifyDays = 365 } = {}) {
  const out = []; const days = (d) => Math.floor((new Date(today) - new Date(d)) / 864e5);
  if (p.status === 'Active') {
    if (p.policeExpiry && p.policeExpiry < today) out.push({ key: 'police', text: 'Police verification expired', fix: 'suspend' });
    if (p.personClass === 'Driver' && p.licenceExpiry && p.licenceExpiry < today) out.push({ key: 'licence', text: 'Driving licence expired', fix: 'suspend' });
    if (p.verifiedAt && days(p.verifiedAt) > reverifyDays) out.push({ key: 'reverify', text: `Last vetted ${days(p.verifiedAt)} days ago`, fix: 'review' });
    if (lastSeen === undefined || lastSeen === null) { if (p.verifiedAt && days(p.verifiedAt) > staleDays) out.push({ key: 'unseen', text: `Never seen at the gate in ${days(p.verifiedAt)} days`, fix: 'review' }); }
    else if (days(lastSeen) > staleDays) out.push({ key: 'unseen', text: `Not seen at the gate for ${days(lastSeen)} days`, fix: 'review' });
  }
  return out;
}
