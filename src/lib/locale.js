import { getRegionByCode, setActiveRegion } from './region/regions.js';
// Per-community money / number / financial-year settings (communityConfig row, set by the Super Admin in Community setup).
// Defaults are the original La Paloma values (₹, Indian grouping, April-March) so nothing changes until someone changes them.
//
// How the rest of the app follows: every `toLocaleString('en-IN')` in the code is routed through numberLocale() below, the
// financial-year helpers (lib/bank/analysis.js) read fyStartMonth(), and the currency symbol is swapped in the page text when
// it is not ₹. The config is loaded once when a community opens (context/AppContext.jsx) and a change reloads the page.

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
import { applyConfigLists } from './lists/configLists.js';
import { getDataSource } from './storage/dataSource.js';
const DEFAULTS = { currencySymbol: '₹', numberFormat: 'Indian (12,34,567)', fyStartMonth: 'April', amountUnit: 'Lakh / crore', propertyTypes: ['Villa', 'Apartment'] };
let cfg = { ...DEFAULTS };

export function setCommunityConfig(row) {
  // country profile first (its currency/number/FY defaults), then whatever the community set explicitly
  const reg = getRegionByCode(row?.region || 'IN');
  setActiveRegion(reg.code);
  applyConfigLists(row?.customLists);
  cfg = { ...DEFAULTS, ...reg.defaults, ...Object.fromEntries(Object.entries(row || {}).filter(([, v]) => v !== '' && v != null && !(Array.isArray(v) && !v.length))) };
  installSymbolSwap();
}
export const getCommunityConfig = () => cfg;
/** The community's tax number (GSTIN / TRN / VAT no.) - one place, Community setup > Community details. Empty when the community says it is not registered. */
export const communityTaxId = () => (cfg?.taxRegistered === 'No' ? '' : String(cfg?.taxId || '').trim());
export const currencySymbol = () => cfg.currencySymbol || '₹';
export const fyStartMonth = () => { const i = MONTH_NAMES.indexOf(cfg.fyStartMonth); return i < 0 ? 4 : i + 1; };
// the back end keeps a unit's type to Villa or Apartment; the community's own list (Plot, Shop ...) is for the browser demo
export const propertyTypes = () => (getDataSource().mode === 'v2' ? DEFAULTS.propertyTypes : cfg.propertyTypes?.length ? cfg.propertyTypes : DEFAULTS.propertyTypes);
export function numberLocale() {
  const f = String(cfg.numberFormat || '');
  if (f.startsWith('International')) return 'en-US';
  if (f.startsWith('European')) return 'de-DE';
  return 'en-IN';
}

// Every existing toLocaleString('en-IN') follows the community's number grouping, with no edit to those call sites.
if (!Number.prototype.__cosPatched) {
  const orig = Number.prototype.toLocaleString;
  Number.prototype.toLocaleString = function patched(loc, opts) { return orig.call(this, loc === 'en-IN' ? numberLocale() : loc, opts); }; // eslint-disable-line no-extend-native
  Object.defineProperty(Number.prototype, '__cosPatched', { value: true });
}

export const fmtNum = (n, opts) => (Number(n) || 0).toLocaleString(numberLocale(), opts);
/** "₹12,34,567" - whole rupees. `{ round: false }` keeps the paise as typed (up to 3 decimals, or set maximumFractionDigits). */
export const money = (n, { round = true, ...opts } = {}) => `${currencySymbol()}${fmtNum(round ? Math.round(Number(n) || 0) : Number(n) || 0, opts)}`;

// ---- Time. Every MOMENT the system records (created, paid, clocked in, entered the gate ...) is kept in UTC - the database's timestamptz,
// sent as ISO with its zone ("2026-10-24T19:30:00Z") - and shown on THIS BROWSER's clock. A DAY (a due date, a booking date) is a plain
// calendar date and is never shifted. A PLANNED clock time (a meeting at 18:00, pass hours) is the community's own and is shown as it is,
// with the community's zone when the browser is elsewhere (plannedTime).
const MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
/** A Date, or an ISO date-time string (as opposed to a plain YYYY-MM-DD day). */
export const isMoment = (v) => v instanceof Date || (typeof v === 'string' && MOMENT.test(v));
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** The calendar day of a value on this browser: a moment is the day it falls on here; a plain date stays itself. */
export const localDay = (v) => {
  if (v == null || v === '') return '';
  if (isMoment(v)) { const d = v instanceof Date ? v : new Date(v); return Number.isNaN(d.getTime()) ? String(v).slice(0, 10) : ymd(d); }
  return String(v).slice(0, 10);
};
/** Today as YYYY-MM-DD on this device's calendar (toISOString() is UTC: before 05:30 in India it still says yesterday). */
export const todayLocal = () => ymd(new Date());
/** The day `n` days from today on this device's calendar (negative: back). */
export const daysFromToday = (n) => { const d = new Date(); d.setDate(d.getDate() + Number(n || 0)); return ymd(d); };
/** "14:30" on this browser's clock for a moment. */
export const fmtTime = (v) => { if (!v) return ''; const d = new Date(v); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); };

// the community's own zone (the server's platform.community.time_zone; until it is known, the country's)
let communityZone = '';
export const setCommunityTimeZone = (z) => { communityZone = z || ''; };
export const communityTimeZone = () => communityZone || getRegionByCode(cfg.region || 'IN').timeZone || 'Asia/Kolkata';
const zonePart = (zone, style, locale = 'en-US') => { try { return new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: style }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value || ''; } catch { return ''; } };
/** ' IST' when this browser is not on the community's clock right now, else ''. */
export function plannedZone() {
  const cz = communityTimeZone(); let bz = '';
  try { bz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* unknown: say nothing */ }
  if (!cz || !bz || cz === bz || zonePart(cz, 'shortOffset') === zonePart(bz, 'shortOffset')) return '';
  const name = zonePart(cz, 'short', 'en-IN') || zonePart(cz, 'shortOffset');
  return name ? ` ${name}` : '';
}
/** A planned clock time ("18:00", "06:00–14:00") as the community keeps it, with its zone when the browser is elsewhere. */
export const plannedTime = (t) => (t ? `${t}${plannedZone()}` : '');

// Dates, one style everywhere: "05 Mar 2026" (a day: YYYY-MM-DD, or the day a moment falls on here) and "05 Mar, 14:30" (a moment, this browser's clock).
const asDay = (s) => new Date(`${localDay(s)}T00:00:00`);
/** `{ year: false }` -> "05 Mar"; `empty` is what a blank date shows ('' or '—'). */
export const fmtDate = (s, { year = true, empty = '' } = {}) => (s ? asDay(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', ...(year ? { year: 'numeric' } : {}) }) : empty);
export const fmtDateTime = (iso, { empty = '' } = {}) => (iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : empty);
/** Whatever a "when" field holds, shown in the house style: a moment on this browser's clock, a day as a date, anything else as it is. */
export const fmtWhen = (v, { empty = '' } = {}) => (v == null || v === '' ? empty : isMoment(v) ? fmtDateTime(v) : /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? fmtDate(v) : String(v));
/** 12,50,000 -> "12.50 L" / "1.25 M" / full, per the community's choice. */
export function compactMoney(n) {
  const v = Number(n) || 0; const a = Math.abs(v); const sym = currencySymbol();
  if (cfg.amountUnit === 'Full amount') return money(v);
  if (cfg.amountUnit === 'Thousand / million') return a >= 1e6 ? `${sym}${(v / 1e6).toFixed(2)}M` : a >= 1e3 ? `${sym}${(v / 1e3).toFixed(1)}K` : money(v);
  return a >= 1e7 ? `${sym}${(v / 1e7).toFixed(2)} Cr` : a >= 1e5 ? `${sym}${(v / 1e5).toFixed(2)} L` : money(v);
}

// The literal ₹ appears in hundreds of labels and messages; for a community on another currency swap it in the page text.
let observer = null;
function swap(node, sym) {
  if (node.nodeType === 3) { if (node.nodeValue.includes('₹')) node.nodeValue = node.nodeValue.replace(/₹/g, sym); return; }
  if (node.nodeType !== 1 || /^(SCRIPT|STYLE|TEXTAREA|INPUT)$/.test(node.tagName)) return;
  for (const c of node.childNodes) swap(c, sym);
}
function installSymbolSwap() {
  if (typeof document === 'undefined') return;
  const sym = currencySymbol();
  if (observer) { observer.disconnect(); observer = null; }
  if (sym === '₹') return;
  const run = () => {
    swap(document.body, sym);
    observer = new MutationObserver((muts) => muts.forEach((m) => { if (m.type === 'characterData') swap(m.target, sym); m.addedNodes.forEach((n) => swap(n, sym)); }));
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  };
  if (document.body) run(); else document.addEventListener('DOMContentLoaded', run);
}
