// One place that explains a charge: the tax breakdown, the due date, and how a late fee applies.
// The same functions feed the on-screen <BillTerms/>, notifications, e-mails/SMS, receipts and booking messages,
// so a rule change (or another country's tax) is made once. Pure functions - no storage, no React.
import { region } from './region/regions.js';
import { money } from './locale.js';
import { addDaysIso, addMonthsIso, daysBetween, dmy, r2, todayIso, ruleFor } from './finance/rules.js';

/**
 * Break a price into taxable value + tax lines, in the active country's style.
 * - rate % with mode 'Inclusive' (tax is inside the price) or 'Exclusive' (tax is added on top)
 * - or a flat tax amount already inside `total` (utility bills)
 */
export function taxBreakdown({ amount, rate = 0, mode = 'Exclusive', flatTax = 0 }) {
  const reg = region(); const tx = reg.tax;
  const a = Number(amount) || 0; const r = Number(rate) || 0;
  let taxable = a; let tax = 0; let total = a;
  if (r > 0) {
    if (mode === 'Inclusive') { taxable = r2(a / (1 + r / 100)); tax = r2(a - taxable); total = a; } else { taxable = a; tax = r2((a * r) / 100); total = r2(a + tax); }
  } else if (Number(flatTax) > 0) { tax = r2(flatTax); taxable = r2(a - tax); total = a; }
  const lines = tax > 0 ? tx.split.map((s, i, arr) => ({ label: s.label, rate: r > 0 ? r2(r * s.share) : 0, amount: i === arr.length - 1 ? r2(tax - arr.slice(0, -1).reduce((n, x) => n + r2(tax * x.share), 0)) : r2(tax * s.share) })) : [];
  return { taxName: tx.name, idLabel: tx.idLabel, rate: r, mode, taxable, tax, total, lines };
}

/** "Pay by 15 Oct 2026 - 3 days left" / "Overdue by 4 days" - with a tone the UI can colour. */
export function dueInfo(dueDate, status, today = todayIso()) {
  if (status === 'Paid') return { tone: 'paid', text: 'Paid', days: 0 };
  if (!dueDate) return { tone: 'ok', text: 'No due date', days: 0 };
  const left = daysBetween(today, String(dueDate).slice(0, 10));
  if (left < 0) return { tone: 'over', text: `Overdue by ${-left} day${left === -1 ? '' : 's'} (was due ${dmy(dueDate)})`, days: left };
  if (left === 0) return { tone: 'soon', text: `Due today (${dmy(dueDate)})`, days: 0 };
  return { tone: left <= 3 ? 'soon' : 'ok', text: `Pay by ${dmy(dueDate)} · ${left} day${left === 1 ? '' : 's'} left`, days: left };
}

/** The community's late-fee rule in one sentence. `s` is lateFeeSettings(). */
export function penaltyRule(settings, category) {
  const s0 = settings;
  const s = s0 && s0.enabled ? ruleFor(s0, category) : null;
  if (!s) return 'No late fee is charged on this bill.';
  const amt = s.kind === 'Fixed per month' ? `a fixed ${money(s.value)}` : `${s.value}% of the bill`;
  return `If not paid by the due date${s.grace ? ` plus ${s.grace} day${s.grace === 1 ? '' : 's'} grace` : ''}, a late fee of ${amt} is added for every month it stays unpaid${s.maxMonths ? `, up to ${s.maxMonths} month${s.maxMonths === 1 ? '' : 's'}` : ''}. Late fees do not earn late fees.`;
}

/** What the penalty would be - first charge date and amount - or what has already accrued. */
export function penaltyExample(due, settings, today = todayIso()) {
  const s = settings && settings.enabled ? ruleFor(settings, due?.category) : null;
  if (!s || !due?.dueDate || due.status === 'Paid' || due.category === 'Late fee') return null;
  const base = Number(due.grossAmount) || Number(due.amount) || 0;
  const per = s.kind === 'Fixed per month' ? r2(s.value) : r2((base * s.value) / 100);
  const start = addDaysIso(due.dueDate, s.grace); // same rule as planLateFees: one fee each month once today is past this date
  let months = 0;
  for (let k = 1; k <= (s.maxMonths || 36); k += 1) { if (today > addMonthsIso(start, k - 1)) months = k; else break; }
  return months > 0 ? { accrued: true, per, months, total: r2(per * months), from: start } : { accrued: false, per, months: 0, total: 0, from: start };
}

/** Plain-text lines (for notifications, e-mail, SMS, receipts). Shape: [heading, ...lines]. */
export function billTermsLines({ due, amount, rate, mode, flatTax, dueDate, status, settings, today = todayIso(), showPenalty = true }) {
  const d = due || {};
  const tb = taxBreakdown({ amount: amount ?? d.amount, rate: rate ?? d.gstRate, mode: mode ?? d.gstMode, flatTax: flatTax ?? d.tax });
  const out = [];
  if (tb.tax > 0) {
    out.push(`${tb.taxName} breakdown: taxable ${money(tb.taxable)}${tb.lines.map((l) => ` + ${l.label}${l.rate ? ` ${l.rate}%` : ''} ${money(l.amount)}`).join('')} = ${money(tb.total)}${tb.mode === 'Inclusive' && tb.rate ? ' (tax included in the price)' : ''}`);
  }
  const di = dueInfo(dueDate ?? d.dueDate, status ?? d.status, today);
  if (dueDate ?? d.dueDate) out.push(`${di.tone === 'over' ? '⚠ ' : ''}${di.text}`);
  if (showPenalty && settings) {
    out.push(penaltyRule(settings, d.category));
    const ex = penaltyExample({ ...d, amount: amount ?? d.amount, dueDate: dueDate ?? d.dueDate, status: status ?? d.status }, settings, today);
    if (ex) out.push(ex.accrued ? `Late fee so far: ${ex.months} month(s) × ${money(ex.per)} = ${money(ex.total)}.` : `Example: if unpaid after ${dmy(ex.from)}, ${money(ex.per)} is added each month.`);
  }
  return out;
}
export const billTermsText = (args) => billTermsLines(args).join('\n');
