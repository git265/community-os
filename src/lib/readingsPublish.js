// Publishing meter readings on the back end: the server prices each bill from the rate card and raises it with the reading in one step
// (POST /billing/readings/publish) and tells each owner. In the browser demo the screen does it (createMany + updateMany).
import { apiFetch, failureOf } from './net/request.js';
import { getDataSource } from './storage/dataSource.js';

export const publishOnServer = () => getDataSource().mode === 'v2';
/** [{ readingId, published, billShortId, amount, reason }] - one per reading; a refused one says why and the others go ahead. */
export async function publishReadings(readingIds, dueDate) {
  const res = await apiFetch('/v1/billing/readings/publish', { method: 'POST', body: JSON.stringify({ readingIds, dueDate }) });
  if (!res.ok) throw await failureOf(res, 'publishing');
  const { forgetKept } = await import('./storage/index.js'); forgetKept?.();   // the bills and readings lists changed on the server
  return res.json();
}
