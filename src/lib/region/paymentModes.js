// Payment modes for the active country. The arrays below are LIVE: setActiveRegion() rewrites them in place, so every screen
// that imports them follows the community's country without being re-written. Cash, Cheque and Bank transfer exist everywhere;
// the online rails (UPI in India, ACH in the US, PayNow in Singapore ...) come from the region profile (regions.js -> payments).

/** Every mode any country can use. Used as the stored value list so old records keep validating after a country change. */
export const KNOWN_MODES = ['UPI', 'Card', 'Net banking', 'Apple Pay', 'Direct debit', 'ACH', 'PayNow', 'PayID', 'Bank transfer', 'Cheque', 'Cash', 'Unit credit', 'In kind'];

export const ONLINE_MODES = [];   // taken through the payment gateway
export const OFFICE_MODES = ['Cash', 'Cheque']; // paid at the office
export const PAYMENT_MODES = [];  // online + office
export const ALL_MODES = [];      // what finance can record (online rails, Cheque, Cash, Bank transfer)
export const REF_MODES = [];      // modes that need a cheque number / transaction reference
export const PAYOUT_MODES = [];   // ways to pay money out (refunds, deposits)
export const DONATION_MODES = []; // cultural donations: online rails, Cash, Cheque, Card
let qr = true;

const fill = (arr, list) => { arr.length = 0; list.forEach((m) => { if (!arr.includes(m)) arr.push(m); }); };

export function syncPaymentModes(region) {
  const p = region?.payments || {};
  const online = p.online || ['Card'];
  fill(ONLINE_MODES, online);
  fill(PAYMENT_MODES, [...online, ...OFFICE_MODES]);
  fill(ALL_MODES, [...online, 'Cheque', 'Cash', 'Bank transfer']);
  fill(REF_MODES, [...online.filter((m) => m !== 'Card'), 'Bank transfer', 'Cheque']);
  fill(PAYOUT_MODES, ['Cash', 'Cheque', 'Bank transfer', ...online.filter((m) => m !== 'Card' && m !== 'Direct debit' && m !== 'Apple Pay')]);
  fill(DONATION_MODES, [...online.filter((m) => m !== 'Direct debit' && m !== 'Apple Pay'), 'Cash', 'Cheque', 'Card', 'In kind']);
  qr = !!p.upiQr;
}
export const needsRef = (m) => REF_MODES.includes(m);
/** UPI deep links and QR codes are an India-only rail. */
export const upiQrEnabled = () => qr;
export const defaultOnlineMode = () => ONLINE_MODES[0] || 'Card';
syncPaymentModes(null);
