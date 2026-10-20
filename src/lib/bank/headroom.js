// "Can we cover it?": cash and FDs on hand + income still to come, against the fixed expenses still to pay.
// Used by the Fixed expenses screen and the Billing dashboard so both always show the same figure.
export const DEFAULT_SETTINGS = { onHand: '', clubhouse: 0, interest: 0, water: 0, dg: 0, emergency: 0, others: 0 };

/** Deposits (fixed deposits, investments) still running for an account, as of a date (default: today). */
export const depositsOf = (deposits, accountName, asOf) => (deposits || []).filter((d) => d.account === accountName && (d.status || 'Active') === 'Active' && (!asOf || !d.startDate || d.startDate <= asOf)).reduce((t, d) => t + (Number(d.amount) || 0), 0);
/** Balance plus deposits for one account. */
export const accountTotal = (a, deposits) => Number(a.balance || 0) + depositsOf(deposits, a.name);

export function computeHeadroom(accounts, fixed, settings, deposits = []) {
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const counted = String(s.onHand || '').split(',').map((x) => x.trim()).filter(Boolean);
  const onHand = accounts.filter((a) => counted.includes(a.name)).reduce((t, a) => t + accountTotal(a, deposits), 0);
  const income = Number(s.clubhouse) + Number(s.interest) + Number(s.water) + Number(s.dg);
  const available = onHand + income - Number(s.emergency);
  const outstanding = fixed.reduce((t, f) => t + Number(f.avg || 0) * Number(f.months || 0), 0);
  const monthly = fixed.reduce((t, f) => t + Number(f.avg || 0), 0);
  const others = Number(s.others) || 0;
  const headroom = available - outstanding - others;
  return { s, counted, onHand, income, available, outstanding, monthly, others, headroom, monthsCover: monthly ? available / monthly : 0 };
}
