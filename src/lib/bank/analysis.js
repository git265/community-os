import { fyStartMonth, todayLocal } from '../locale.js';
// Bank statement analysis for the Accounts & Budget screen.
//
// The Treasurer's workbook categorises every bank line by hand ("Remarks" / "Paid-Received" columns). Here the same
// job is a small ordered rule list: the first matching rule decides the budget HEAD. Rules are deliberately plain
// so the Treasurer can read them; anything unmatched lands in "Other income" / "Other expense" for review.

import { INCOME_HEADS, EXPENSE_HEADS, NEUTRAL_HEADS, BUDGET_HEADS, BANK_RULES } from '../lists/configLists.js';
export const BANK_ACCOUNT_NAMES = ['Maintenance', 'Electricity/Water/Tax', 'Sinking', 'Corpus', 'Cultural', 'Ganesh']; // the demo community's accounts (seed only)
// Heads are the community's own (Community setup -> Lists); these are live lists.
export { INCOME_HEADS, EXPENSE_HEADS, NEUTRAL_HEADS, BUDGET_HEADS };

const R = (re, head, only) => ({ re, head, only });
// text rules (narration + remarks + party, upper-cased); `only` limits a rule to deposits ('in') or withdrawals ('out')
const RULES = [
  R(/IB FUNDS TRANSFER|INTER ?ACCOUNT|INTERNAL TRANSFER|ACCOUNT OPENING/, 'Transfers'),
  R(/FD BOOKED|FD REDEEM|FD BORKEN|FD BROKEN|FD CLOSURE|PREMATURE|FD MATURITY/, 'Fixed deposits'),
  R(/TAX RECOVER|TDS ON INTEREST/, 'TDS on FD interest'),
  R(/INTEREST/, 'Interest', 'in'),
  R(/WATER BILL/, 'Water bills', 'in'),
  R(/\bDG\b.*BILL|DG BILL|DG CHARGES/, 'DG bills', 'in'),
  R(/CLUB ?HOUSE|VIVISH|UPI SETTLEMENT|BQ HALL|LAWN BOOKING/, 'Clubhouse', 'in'),
  R(/RENT/, 'Rental', 'in'),
  R(/MAINT[A-Z]*NCE|MAINATAINENCE/, 'Maintenance dues', 'in'),
  R(/\bARC\b/, 'ARC wages', 'out'),
  R(/SECURITY|SECUREFIRST/, 'Security', 'out'),
  R(/ELECTRICITY|SOUTHERNPOWER|TSSPDCL/, 'Electricity', 'out'),
  R(/BHAGIRATHA|BHAGIRATA|BHAIGRATHA|DRINKING WATER/, 'Bhagiratha (water)', 'out'),
  R(/\bCH\b|CH ?(CANCEL|REFUND)|CLUB ?HOUSE.*REFUND|DEPOSIT REFUND/, 'Clubhouse', 'out'), // booking / deposit refunds net off clubhouse income
  R(/DIESEL|DEISEL/, 'Diesel', 'out'),
  R(/INCOME TAX/, 'Income tax', 'out'),
  R(/\bGST\b/, 'GST', 'out'),
  R(/\bTDS\b/, 'TDS', 'out'),
  R(/LEGAL|LAWYER|ACCOUNTANT|ACCOUNTING|AUDIT|\bCA FEE/, 'Legal & accounting', 'out'),
  R(/PETTY/, 'Petty expense', 'out'),
  R(/\bAMC\b|LIFT|\bWTP\b|CAMERA|BOOM BARRIER|GYM|\bSALT\b/, 'AMC & infrastructure', 'out'),
  R(/FENC(E|ING)|SPEED ?BREAKER|PLANTS?\b|SPRINKLER|CCTV|CARPET GRASS|VERMICOMPOST|MOTOR|REPAIR|PAINT|PARK ?PLUS|SHADE GRASS|GRASS|SIGNAGE|\bSTP\b/, 'Repairs & improvements', 'out'),
  R(/GARBAGE|WASTE|GANDIPET|PEST|POLICE|SALARY/, 'Operations', 'out'),
];

/** Budget head for one statement line. `t` = { account, narration, remarks, party, debit, credit }. */
const has = (h) => BUDGET_HEADS.includes(h);
const customHit = (r, text, dir) => {
  if (r.only && r.only !== dir) return false;
  const m = /^\/(.+)\/$/.exec(r.match);
  if (m) { try { return new RegExp(m[1], 'i').test(text); } catch { return false; } }
  return text.includes(r.match.toUpperCase());
};
export function categorize(t) {
  const text = `${t.narration || ''} ${t.remarks || ''} ${t.party || ''}`.toUpperCase();
  const dir = Number(t.credit) > 0 ? 'in' : 'out';
  // the community's own rules first, then the built-in ones - which only apply while their head exists in the community's list
  for (const r of BANK_RULES) if (customHit(r, text, dir)) return r.head;
  for (const r of RULES) if (has(r.head) && (!r.only || r.only === dir) && r.re.test(text)) {
    // temple priest salary etc. on the Ganesh account is temple spend, not general operations
    if (r.head === 'Operations' && t.account === 'Ganesh' && has('Cultural & temple spend')) return 'Cultural & temple spend';
    return r.head;
  }
  if (/^V\d+$/i.test(t.party || '') && dir === 'in' && has('Maintenance dues')) return 'Maintenance dues';
  if ((t.account === 'Cultural' || t.account === 'Ganesh') && has('Cultural & temple income')) return dir === 'in' ? 'Cultural & temple income' : 'Cultural & temple spend';
  if (t.account === 'Sinking' && dir === 'out' && has('Capital projects')) return 'Capital projects';
  return dir === 'in' ? 'Other income' : 'Other expense';
}

export const kindOfHead = (h) => (INCOME_HEADS.includes(h) ? 'Income' : EXPENSE_HEADS.includes(h) ? 'Expense' : 'Neutral');


// ---- Financial years: with an April start FY27 = 1 Apr 2026 - 31 Mar 2027; the label is the year the FY ENDS. The start month is the
// community's choice (Community setup); a January start makes FY27 the calendar year 2027. ----
const fyNum = (label) => Number(String(label).replace(/\D/g, ''));
const lastDay = (y, m) => new Date(y, m, 0).getDate();
export const fyRange = (label) => {
  const y = 2000 + fyNum(label); const sm = fyStartMonth();
  if (sm === 1) return { from: `${y}-01-01`, to: `${y}-12-31` };
  const em = sm - 1;
  return { from: `${y - 1}-${String(sm).padStart(2, '0')}-01`, to: `${y}-${String(em).padStart(2, '0')}-${lastDay(y, em)}` };
};
export const fyOfDate = (iso) => { const y = Number(iso.slice(0, 4)); const m = Number(iso.slice(5, 7)); const sm = fyStartMonth(); return `FY${String((sm > 1 && m >= sm ? y + 1 : y) % 100).padStart(2, '0')}`; };
export const prevFy = (label) => `FY${String(fyNum(label) - 1).padStart(2, '0')}`;
export const currentFy = () => fyOfDate(todayLocal());
/** Financial year a statement line counts in: its date, except maintenance dues paid in advance and remarked "FY27". */
export function fyOfTxn(t) {
  const byDate = fyOfDate(t.date);
  if (t.head === 'Maintenance dues') {
    const m = /FY\s?(\d{2})/i.exec(t.remarks || '');
    if (m && Number(m[1]) > fyNum(byDate) && Number(m[1]) - fyNum(byDate) <= 1) return `FY${m[1]}`;
  }
  return byDate;
}
export function fyOptions(txns, budget = []) {
  const set = new Set([currentFy(), ...budget.map((b) => b.fy).filter(Boolean), ...txns.map((t) => fyOfDate(t.date))]);
  return [...set].sort();
}

/** Actuals per head for one financial year (default: FY27). Neutral heads (transfers, FD movements) are left out. */
export function actualsByHead(txns, fy = 'FY27') {
  const out = {};
  for (const t of txns) {
    if (fyOfTxn(t) !== fy) continue;
    const kind = kindOfHead(t.head);
    if (kind === 'Neutral') continue;
    const v = kind === 'Income' ? Number(t.credit) - Number(t.debit) : Number(t.debit) - Number(t.credit);
    out[t.head] = (out[t.head] || 0) + v;
  }
  return out;
}

/** Last statement date inside a financial year (or null). */
export const lastDateIn = (txns, fy) => txns.reduce((m, t) => (fyOfDate(t.date) === fy && t.date > m ? t.date : m), '') || null;

/** Sum the actuals of a comma-separated list of heads. */
export const sumHeads = (actuals, heads) => String(heads || '').split(',').map((s) => s.trim()).filter(Boolean).reduce((s, h) => s + (actuals[h] || 0), 0);

/** Statement closing balance of an account on/before a date (the bank's own running balance column). */
export function balanceAsOf(txns, account, date) {
  const rows = txns.filter((t) => t.account === account && t.date <= date);
  if (!rows.length) return null;
  const last = rows.reduce((a, b) => (b.date >= a.date ? b : a));
  return { balance: Number(last.balance), date: last.date };
}

export const monthEnd = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthLabel = (ym) => `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
