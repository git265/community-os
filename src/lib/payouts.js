// Provider payouts on the back end: a money-in bank line is the online payments of a few days less the provider's fees. The server proposes
// which payments it carries (or the treasurer picks), then books Dr bank / Dr fees / Cr gateway clearing and matches the line, in one step.
import { apiFetch, failureOf } from './net/request.js';
import { getDataSource } from './storage/dataSource.js';

export const payoutsOnServer = () => getDataSource().mode === 'v2';
async function call(path, init) {
  const res = await apiFetch(`/v1/finance/bank-lines/${path}`, init);
  if (!res.ok) throw await failureOf(res, 'payout');
  return res.json();
}
export const proposePayout = (lineId) => call(`${lineId}/payout`);
export async function matchPayout(lineId, paymentIds) {
  const out = await call(`${lineId}/payout`, { method: 'POST', body: JSON.stringify({ paymentIds }) });
  (await import('./storage/index.js')).forgetKept?.();
  return out;
}
