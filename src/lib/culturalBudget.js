// Budget (the estimate made in advance) against actual spend for cultural events, plus crediting the unused part back to the fund.
// Actual = the figure carried over from the old spreadsheets when there is one, otherwise what the expense list adds up to.
const num = (v) => Number(v) || 0;

export const actualOf = (e) => (e.historicalActual != null && e.historicalActual !== '' ? num(e.historicalActual) : num(e.spent));
export const hasActual = (e) => actualOf(e) > 0;
export const yearOf = (e) => String(e.startDate || '').slice(0, 4);
/** Money left over from the estimate once the event is finished: only for completed events with an actual and a budget above it. */
export const savingOf = (e) => (e.status === 'Completed' && hasActual(e) && num(e.budget) > actualOf(e) ? num(e.budget) - actualOf(e) : 0);
export const creditedOf = (e) => num(e.creditedAmount);
export const toCredit = (e) => Math.max(0, savingOf(e) - creditedOf(e));
/** What an event still holds back from its fund: its budget until it is done, then what was really spent (+ any saving not yet credited). */
export const committedOf = (e) => {
  if (e.status === 'Cancelled') return 0;
  if (e.status === 'Completed' && hasActual(e)) return Math.max(actualOf(e), num(e.budget) - creditedOf(e));
  return num(e.budget);
};
export const seriesOf = (e) => (e.series && String(e.series).trim()) || String(e.name || '').replace(/\b(19|20)\d{2}\b/g, '').replace(/\s+/g, ' ').trim();

export function summarize(events) {
  const done = events.filter((e) => e.status !== 'Cancelled');
  const withBoth = done.filter((e) => hasActual(e) && num(e.budget) > 0);
  const budget = done.reduce((n, e) => n + num(e.budget), 0);
  const actual = done.reduce((n, e) => n + actualOf(e), 0);
  const budgetOfDone = withBoth.reduce((n, e) => n + num(e.budget), 0);
  const actualOfDone = withBoth.reduce((n, e) => n + actualOf(e), 0);
  return {
    events: done.length, budget, actual,
    compared: withBoth.length, budgetOfDone, actualOfDone, variance: budgetOfDone - actualOfDone, // + = under budget
    over: withBoth.filter((e) => actualOf(e) > num(e.budget)).length,
    under: withBoth.filter((e) => actualOf(e) < num(e.budget)).length,
    unspent: done.reduce((n, e) => n + toCredit(e), 0),
    credited: done.reduce((n, e) => n + creditedOf(e), 0),
    awaiting: done.filter((e) => e.status === 'Completed' && !hasActual(e) && num(e.budget) > 0).length,
  };
}
