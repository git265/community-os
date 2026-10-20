// Lists a community can change without a code change: shift types, amenity time slots, ticket categories, document groups.
// The arrays are LIVE (rewritten in place when the community's setup loads), so every screen and schema that imports them
// follows the community's own list. The defaults below are what a community gets until it edits them in Community setup -> Lists.
// Stored as one JSON text on the community config row (customLists); a backend would keep the same JSON in its settings table.

export const DOC_VILLA_GROUP = 'Villa owner / resident';
export const DEFAULT_SHIFTS = [
  { key: 'Morning', time: '06:00–14:00', cls: 'green' },
  { key: 'Afternoon', time: '14:00–22:00', cls: 'orange' },
  { key: 'Night', time: '22:00–06:00', cls: 'purple' },
  { key: 'General', time: '09:00–18:00', cls: 'blue' },
  { key: 'Off', time: 'Day off', cls: '' },
];
export const DEFAULT_SLOTS = ['08:00–09:00', '09:00–10:00', '10:00–11:00', '16:00–17:00', '17:00–18:00', '18:00–19:00', '19:00–20:00', '20:00–21:00'];
export const DEFAULT_CATEGORIES = ['Plumbing', 'Electrical', 'MEP', 'Carpentry', 'Civil & Painting', 'Water & Sewage', 'Housekeeping', 'Gardening', 'Landscape', 'Security', 'Fire safety', 'Amenities', 'Cultural', 'Helpdesk', 'General', 'Other'];
export const BUILT_IN_DOC_GROUPS = ['Everyone', 'All owners', 'Executive Committee', 'EC + Finance', 'Staff', DOC_VILLA_GROUP];
export const SHIFT_COLOURS = ['green', 'orange', 'purple', 'blue', 'red', 'yellow', ''];

export const SHIFT_TYPES = DEFAULT_SHIFTS.map((s) => ({ ...s }));
export const AMENITY_SLOTS = [...DEFAULT_SLOTS];
export const TICKET_CATEGORIES = [...DEFAULT_CATEGORIES];
export const DOC_GROUPS = [...BUILT_IN_DOC_GROUPS];
/** Extra document groups: { name, roles: [roleId ...] } - visible to those roles (admins always see everything). */
export const CUSTOM_DOC_GROUPS = [];

// ---- Accounts & budget: heads (what money is for), statement matching rules, deposit types, account names
export const DEFAULT_INCOME_HEADS = ['Maintenance dues', 'Clubhouse', 'Interest', 'Rental', 'Water bills', 'DG bills', 'Cultural & temple income', 'Other income'];
export const DEFAULT_EXPENSE_HEADS = ['ARC wages', 'Security', 'Electricity', 'Bhagiratha (water)', 'Diesel', 'Operations', 'Petty expense', 'TDS', 'Income tax', 'GST', 'Legal & accounting', 'AMC & infrastructure', 'Repairs & improvements', 'Cultural & temple spend', 'Capital projects', 'Other expense'];
export const DEFAULT_NEUTRAL_HEADS = ['TDS on FD interest', 'Transfers', 'Fixed deposits'];
/** A starting point for communities outside the original one: plain HOA / condo / co-op heads. */
export const GENERIC_HEADS = {
  income: ['Assessments / maintenance dues', 'Late fees & fines', 'Amenity & hall bookings', 'Interest', 'Rental income', 'Utility recharges', 'Other income'],
  expense: ['Payroll & wages', 'Security', 'Utilities', 'Landscaping & grounds', 'Repairs & maintenance', 'Contracts & AMC', 'Insurance', 'Management fees', 'Legal & accounting', 'Taxes', 'Reserve contributions', 'Capital projects', 'Other expense'],
  neutral: ['Transfers', 'Deposits & investments'],
};
/** Starter statement rules that go with GENERIC_HEADS. */
export const GENERIC_RULES = [
  { match: 'ASSESSMENT', head: 'Assessments / maintenance dues', only: 'in' }, { match: 'MAINTENANCE', head: 'Assessments / maintenance dues', only: 'in' }, { match: 'HOA DUES', head: 'Assessments / maintenance dues', only: 'in' },
  { match: 'INTEREST', head: 'Interest', only: 'in' }, { match: 'LATE FEE', head: 'Late fees & fines', only: 'in' }, { match: 'RENT', head: 'Rental income', only: 'in' },
  { match: 'TRANSFER', head: 'Transfers', only: '' }, { match: 'PAYROLL', head: 'Payroll & wages', only: 'out' }, { match: 'SALARY', head: 'Payroll & wages', only: 'out' },
  { match: 'SECURITY', head: 'Security', only: 'out' }, { match: 'ELECTRIC', head: 'Utilities', only: 'out' }, { match: 'WATER', head: 'Utilities', only: 'out' }, { match: 'GAS', head: 'Utilities', only: 'out' },
  { match: 'LANDSCAP', head: 'Landscaping & grounds', only: 'out' }, { match: 'INSURANCE', head: 'Insurance', only: 'out' }, { match: 'ATTORNEY', head: 'Legal & accounting', only: 'out' }, { match: 'ACCOUNTANT', head: 'Legal & accounting', only: 'out' },
  { match: 'REPAIR', head: 'Repairs & maintenance', only: 'out' }, { match: 'MANAGEMENT FEE', head: 'Management fees', only: 'out' }, { match: 'TAX', head: 'Taxes', only: 'out' }, { match: 'RESERVE', head: 'Reserve contributions', only: 'out' },
];
export const DEFAULT_DEPOSIT_TYPES = ['Fixed deposit', 'Sweep-in deposit', 'Recurring deposit', 'Certificate of deposit', 'Treasury bill', 'Money market', 'Bond', 'Other'];
export const INCOME_HEADS = [...DEFAULT_INCOME_HEADS];
export const EXPENSE_HEADS = [...DEFAULT_EXPENSE_HEADS];
export const NEUTRAL_HEADS = [...DEFAULT_NEUTRAL_HEADS];
export const BUDGET_HEADS = [...DEFAULT_INCOME_HEADS, ...DEFAULT_EXPENSE_HEADS, ...DEFAULT_NEUTRAL_HEADS];
export const DEPOSIT_TYPES = [...DEFAULT_DEPOSIT_TYPES];
/** Statement matching rules the community wrote: { match: 'keyword or /regex/', head, only: 'in' | 'out' | '' }. Tried before the built-in ones. */
export const BANK_RULES = [];

const put = (arr, list) => { arr.length = 0; list.forEach((x) => arr.push(x)); };

export function currentLists() {
  return { shifts: SHIFT_TYPES.map((s) => ({ ...s })), slots: [...AMENITY_SLOTS], ticketCategories: [...TICKET_CATEGORIES], docGroups: CUSTOM_DOC_GROUPS.map((g) => ({ name: g.name, roles: [...g.roles] })), incomeHeads: [...INCOME_HEADS], expenseHeads: [...EXPENSE_HEADS], neutralHeads: [...NEUTRAL_HEADS], depositTypes: [...DEPOSIT_TYPES], bankRules: BANK_RULES.map((r) => ({ ...r })) };
}
const uniq = (xs) => [...new Set(xs.map((x) => String(x).trim()).filter(Boolean))];

/** Clean a lists object (from the editor or from storage) into valid lists. 'Off' always stays (a day off must exist). */
export function cleanLists(raw) {
  const l = raw || {};
  const seen = new Set();
  let shifts = (Array.isArray(l.shifts) ? l.shifts : []).map((s) => ({ key: String(s.key || '').trim(), time: String(s.time || '').trim(), cls: SHIFT_COLOURS.includes(s.cls) ? s.cls : '' })).filter((s) => s.key && !seen.has(s.key.toLowerCase()) && seen.add(s.key.toLowerCase()));
  if (!shifts.some((s) => s.key === 'Off')) shifts = [...shifts, { key: 'Off', time: 'Day off', cls: '' }];
  const slots = uniq(Array.isArray(l.slots) ? l.slots : []);
  const cats = uniq(Array.isArray(l.ticketCategories) ? l.ticketCategories : []);
  const names = new Set(BUILT_IN_DOC_GROUPS.map((g) => g.toLowerCase()));
  const groups = (Array.isArray(l.docGroups) ? l.docGroups : []).map((g) => ({ name: String(g.name || '').trim(), roles: Array.isArray(g.roles) ? g.roles : [] })).filter((g) => g.name && !names.has(g.name.toLowerCase()) && names.add(g.name.toLowerCase()));
  const ensure = (xs, dflt, must) => { const v = uniq(Array.isArray(xs) ? xs : []); const out = v.length ? v : [...dflt]; return must && !out.includes(must) ? [...out, must] : out; };
  const income = ensure(l.incomeHeads, DEFAULT_INCOME_HEADS, 'Other income');
  const expense = ensure(l.expenseHeads, DEFAULT_EXPENSE_HEADS, 'Other expense').filter((h) => !income.includes(h));
  const neutral = ensure(l.neutralHeads, DEFAULT_NEUTRAL_HEADS).filter((h) => !income.includes(h) && !expense.includes(h));
  const heads = new Set([...income, ...expense, ...neutral]);
  const bankRules = (Array.isArray(l.bankRules) ? l.bankRules : []).map((r) => ({ match: String(r.match || '').trim(), head: String(r.head || '').trim(), only: r.only === 'in' || r.only === 'out' ? r.only : '' })).filter((r) => r.match && heads.has(r.head));
  return { incomeHeads: income, expenseHeads: expense, neutralHeads: neutral, depositTypes: ensure(l.depositTypes, DEFAULT_DEPOSIT_TYPES), bankRules, shifts: shifts.length > 1 ? shifts : DEFAULT_SHIFTS.map((s) => ({ ...s })), slots: slots.length ? slots : [...DEFAULT_SLOTS], ticketCategories: cats.length ? cats : [...DEFAULT_CATEGORIES], docGroups: groups };
}

/** Apply a community's saved lists (JSON text or object). Empty / invalid = the defaults. */
export function applyConfigLists(raw) {
  let obj = null;
  try { obj = typeof raw === 'string' ? (raw ? JSON.parse(raw) : null) : raw; } catch { obj = null; }
  const c = cleanLists(obj);
  put(SHIFT_TYPES, c.shifts);
  put(AMENITY_SLOTS, c.slots);
  put(TICKET_CATEGORIES, c.ticketCategories);
  put(CUSTOM_DOC_GROUPS, c.docGroups);
  put(INCOME_HEADS, c.incomeHeads); put(EXPENSE_HEADS, c.expenseHeads); put(NEUTRAL_HEADS, c.neutralHeads);
  put(BUDGET_HEADS, [...c.incomeHeads, ...c.expenseHeads, ...c.neutralHeads]);
  put(DEPOSIT_TYPES, c.depositTypes); put(BANK_RULES, c.bankRules);
  put(DOC_GROUPS, [...BUILT_IN_DOC_GROUPS, ...c.docGroups.map((g) => g.name)]);
}
