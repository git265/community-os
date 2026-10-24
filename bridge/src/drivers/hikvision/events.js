// A Hikvision access event (major 5) as the punch CommunityOS keeps. Minor codes differ a little between firmware versions: these
// are the common ones; check them against the terminal's own event list when installing. COS_PASS_MINORS / COS_FAIL_MINORS add
// others, and a code the bridge does not know is logged once (and not sent).
import { log } from '../../log.js';

export const FACE_PASS = 75, FACE_FAIL = 76;
// passed: card (1), card + PIN (2), card or fingerprint by firmware (38), face (75), fingerprint (113)
const PASS = new Set([1, 2, 38, 75, 113]);
// refused: card + PIN wrong (3), no right (6), outside its period (7), expired (8), unknown card (9), fingerprint (39), face (76)
const FAIL = new Set([3, 6, 7, 8, 9, 39, 76]);
const FACE = new Set([75, 76]), FINGER = new Set([39, 113]);
const REASONS = { 3: 'Wrong PIN', 6: 'No access right', 7: 'Outside the allowed schedule', 8: 'Expired', 9: 'Unknown card or QR code',
  39: 'Fingerprint not recognised', 76: 'Face not recognised' };
const warned = new Set();

export function classify(minor, extra = { pass: [], fail: [] }) {
  if (PASS.has(minor) || extra.pass.includes(minor)) return 'Allowed';
  if (FAIL.has(minor) || extra.fail.includes(minor)) return 'Refused';
  if (!warned.has(minor)) { warned.add(minor); log.info(`event code 5/${minor} is not a punch (door state, alarm, ...): not sent (add it to COS_PASS_MINORS or COS_FAIL_MINORS if it is)`); }
  return null;
}

/** InfoList item -> punch, or null when it is not someone presenting a face, card, finger or QR code. */
export function toPunch(e, extra) {
  if (Number(e.major) !== 5) return null;
  const minor = Number(e.minor);
  const result = classify(minor, extra);
  if (!result || !Number.isFinite(Number(e.serialNo))) return null;
  const card = e.cardNo ? String(e.cardNo).trim() : '';
  const mode = String(e.currentVerifyMode || '').toLowerCase();
  // a QR code is read as a card number; the verify mode (or card type) tells them apart where the firmware says so
  const credential = FACE.has(minor) ? 'Face' : card ? (/qr/.test(mode) || /qr/i.test(String(e.cardType || '')) ? 'QR' : 'Card') : FINGER.has(minor) || minor === 38 ? 'Fingerprint' : /face/.test(mode) ? 'Face' : 'Other';
  const emp = e.employeeNoString ?? (e.employeeNo === undefined || e.employeeNo === 0 ? null : String(e.employeeNo));
  return {
    eventNo: Number(e.serialNo),
    at: parseTime(e.time),
    credential,
    employeeNo: emp ? String(emp) : null,
    cardNo: card || null,
    result,
    reason: result === 'Refused' ? REASONS[minor] || `Refused (code ${minor})` : null,
    attendanceStatus: e.attendanceStatus && e.attendanceStatus !== 'undefined' ? e.attendanceStatus : null,
    photo: null,
    raw: { major: 5, minor, verifyMode: e.currentVerifyMode || null, door: e.doorNo ?? null, mask: e.mask ?? null, pictureURL: e.pictureURL ? true : undefined },
    pictureURL: e.pictureURL || null,
  };
}

/** The device's time ("2026-10-23T09:15:02+05:30"); one with no zone is read as the bridge's own. */
export function parseTime(s) {
  if (!s) return new Date().toISOString();
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/** A time as the device wants it in a search or for its clock: local wall time with the device's offset ("+05:30"). */
export function deviceTime(date, offset) {
  const off = offset && /^[+-]\d{2}:\d{2}$/.test(offset) ? offset : '+00:00';
  const sign = off[0] === '-' ? -1 : 1, mins = sign * (Number(off.slice(1, 3)) * 60 + Number(off.slice(4, 6)));
  const t = new Date(date.getTime() + mins * 60_000).toISOString().slice(0, 19);
  return t + off;
}
/** The offset at the end of a device time ("+05:30"), if it has one. */
export function offsetOf(s) { const m = /([+-]\d{2}:\d{2})$/.exec(s || ''); return m ? m[1] : (/Z$/.test(s || '') ? '+00:00' : null); }
