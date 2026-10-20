import { getRegionByCode, setActiveRegion } from './region/regions.js';
// Per-community money / number / financial-year settings (communityConfig row, set by the Super Admin in Community setup).
// Defaults are the original La Paloma values (₹, Indian grouping, April-March) so nothing changes until someone changes them.
//
// How the rest of the app follows: every `toLocaleString('en-IN')` in the code is routed through numberLocale() below, the
// financial-year helpers (lib/bank/analysis.js) read fyStartMonth(), and the currency symbol is swapped in the page text when
// it is not ₹. The config is loaded once when a community opens (context/AppContext.jsx) and a change reloads the page.

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
import { applyConfigLists } from './lists/configLists.js';
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
export const propertyTypes = () => (cfg.propertyTypes?.length ? cfg.propertyTypes : DEFAULTS.propertyTypes);
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
export const money = (n, opts) => `${currencySymbol()}${fmtNum(Math.round(Number(n) || 0), opts)}`;
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
