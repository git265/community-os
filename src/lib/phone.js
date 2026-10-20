// Phone numbers: must carry a country code (+91 ...). Checked semantically (real country, valid length/pattern for that country,
// not a placeholder like +91 99999 99999), then stored in E.164 form (+919876543210) which is the person's identity key.
import { parsePhoneNumberFromString } from 'libphonenumber-js/min';

const placeholder = (national) => {
  const d = String(national).replace(/\D/g, '');
  if (d.length < 6) return false;
  if (/^(\d)\1+$/.test(d)) return true;                       // 9999999999
  const asc = '01234567890123456789', desc = '98765432109876543210';
  if (asc.includes(d) || desc.includes(d)) return true;       // 1234567890
  if (new Set(d.split('')).size <= 2 && d.length >= 8) return true; // 1212121212
  return false;
};

/** @returns {{ok:boolean, e164?:string, formatted?:string, country?:string, error?:string}} */
export function validatePhone(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, error: 'Phone number is required' };
  if (!text.startsWith('+')) return { ok: false, error: 'Start with the country code, e.g. +91 98450 71234' };
  let p;
  try { p = parsePhoneNumberFromString(text); } catch { p = null; }
  if (!p) return { ok: false, error: 'This is not a recognisable phone number — check the country code and digits' };
  if (!p.country && !p.isPossible()) return { ok: false, error: 'Unknown country code' };
  if (!p.isPossible()) return { ok: false, error: `Wrong number of digits for ${p.country || 'this country'}` };
  if (!p.isValid()) return { ok: false, error: `Not a valid ${p.country || ''} number — check the digits (area / mobile prefix)`.replace('  ', ' ') };
  if (placeholder(p.nationalNumber)) return { ok: false, error: 'This looks like a placeholder number — enter the real one' };
  return { ok: true, e164: p.number, formatted: p.formatInternational(), country: p.country || '' };
}

/** Normalise for comparing/matching two numbers (E.164 when valid, else digits only). */
export function phoneKey(raw) {
  const v = validatePhone(raw);
  return v.ok ? v.e164 : String(raw ?? '').replace(/[^\d+]/g, '');
}
export const maskPhone = (e164) => (e164 ? `${e164.slice(0, 3)}••••••${e164.slice(-3)}` : '');
