// GST test for maintenance dues. Pure functions, so the screen can preview a change before it is saved.
// Rule used (as explained in CBIC Circular 109/28/2019): a residents' association is exempt on maintenance charged up to a limit per
// residence per month; above it, GST applies to the WHOLE counted amount. Which bill categories "count" is a setting, because it must be
// confirmed with the society's CA. Nothing here changes a bill; it measures, previews and reports.

export const MODES = ['Counts toward limit', 'Excluded (pass-through)', 'Taxed separately', 'Exempt'];
export const DEFAULT_SETTINGS = { id: 'default', registered: 'No', annualTurnover: 0, registrationThreshold: 2000000, limitPerMonth: 7500, note: '' };
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Is GST to be charged at all? Registered societies charge it above the limit; an unregistered one does not, but should watch the threshold. */
export function gstStatus(s) {
  const st = { ...DEFAULT_SETTINGS, ...(s || {}) };
  const over = Number(st.annualTurnover) >= Number(st.registrationThreshold) && Number(st.registrationThreshold) > 0;
  if (st.registered === 'Yes') return { charges: true, tone: 'ok', text: 'Registered for GST: bills above the limit carry GST.' };
  if (over) return { charges: false, tone: 'bad', text: 'Not registered, but yearly turnover is at or above the registration threshold. Ask your CA about registering.' };
  return { charges: false, tone: 'ok', text: 'Not registered and under the threshold: no GST is charged.' };
}

export const rulesByCategory = (rules) => new Map((rules || []).map((r) => [r.category, r]));

/**
 * One month, every unit. Returns { rows, byAccount, totals }.
 * rows: { unit, counted, excluded, separate, total, over, near, gst, parts: {category: amount} }
 */
export function analyse({ dues, rules, settings, month }) {
  const st = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const limit = Number(st.limitPerMonth) || 0;
  const by = rulesByCategory(rules);
  const charges = gstStatus(st).charges;
  const units = new Map(); const byAccount = new Map();
  for (const d of dues || []) {
    if (d.status === 'Cancelled') continue;
    if (month && d.billedMonth !== month) continue;
    const rule = by.get(d.category);
    const amt = Number(d.amount) || 0;
    const mode = rule?.mode || 'Counts toward limit';
    const u = units.get(d.unit) || { unit: d.unit, counted: 0, excluded: 0, separate: 0, exempt: 0, total: 0, gstOn: 0, parts: {} };
    u.total += amt; u.parts[d.category] = (u.parts[d.category] || 0) + amt;
    if (mode === 'Counts toward limit') { u.counted += amt; u.gstOn += amt * ((Number(rule?.gstRate) || 0) / 100); }
    else if (mode === 'Excluded (pass-through)') u.excluded += amt;
    else if (mode === 'Taxed separately') u.separate += amt;
    else u.exempt += amt;
    units.set(d.unit, u);
    const acc = rule?.account || '(no account set)';
    byAccount.set(acc, (byAccount.get(acc) || 0) + amt);
  }
  const rows = [...units.values()].map((u) => {
    const over = u.counted > limit;
    return { ...u, counted: r2(u.counted), total: r2(u.total), over, near: !over && limit > 0 && u.counted >= limit * 0.9, gst: over && charges ? r2(u.gstOn) : 0, headroom: r2(limit - u.counted) };
  }).sort((a, b) => b.counted - a.counted);
  const totals = {
    units: rows.length, over: rows.filter((r) => r.over).length, near: rows.filter((r) => r.near).length,
    gst: r2(rows.reduce((n, r) => n + r.gst, 0)), counted: r2(rows.reduce((n, r) => n + r.counted, 0)), total: r2(rows.reduce((n, r) => n + r.total, 0)),
  };
  return { rows, byAccount: [...byAccount.entries()].map(([account, amount]) => ({ account, amount: r2(amount) })).sort((a, b) => b.amount - a.amount), totals, limit, charges };
}

/** Months that have bills, newest first. */
export function monthsOf(dues) {
  const seen = new Map();
  for (const d of dues || []) { if (d.billedMonth && !seen.has(d.billedMonth)) seen.set(d.billedMonth, new Date(`1 ${d.billedMonth}`).getTime() || 0); }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
}

export function toCsv(result, month) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Unit', 'Month', 'Counted (₹)', 'Excluded (₹)', 'Taxed separately (₹)', 'All bills (₹)', 'Limit (₹)', 'Over limit', 'GST (₹)'];
  return [head.map(q).join(','), ...result.rows.map((r) => [r.unit, month, r.counted, r.excluded, r.separate, r.total, result.limit, r.over ? 'Yes' : 'No', r.gst].map(q).join(','))].join('\n');
}
