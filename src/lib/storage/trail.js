// Every write leaves a time trail on the record itself, stamped by the server-side write path (clients cannot forge it):
//   timeline    one entry each time a status-like field changes: { field, label, from, to, at, by }
//               (status, paymentStatus, depositStatus, refundStatus, ecApproval ... any key ending in "status"/"approval")
//   dateStamps  the exact moment a date field was set or changed: { paidAt: '2026-10-15T14:03:22Z', ... }
// Together with recordCreatedAt / lastUpdatedAt this answers "when did it happen?" for any record, without a per-module log.
const STATUS_KEY = /(status|approval)$/i;
const TRAIL_SKIP = new Set(['statusHistory', 'timeline', 'dateStamps']);

export function trailFor(old, next, schema, now, by) {
  const labelOf = (k) => schema?.fields?.find((f) => f.key === k)?.label || k;
  const timeline = Array.isArray(old?.timeline) ? [...old.timeline] : [];
  for (const k of Object.keys(next)) {
    if (TRAIL_SKIP.has(k) || !STATUS_KEY.test(k) || typeof next[k] !== 'string' || !next[k]) continue;
    const was = old ? old[k] : undefined;
    if (was !== next[k]) timeline.push({ field: k, label: labelOf(k), from: was ?? '', to: next[k], at: now, by });
  }
  const dateStamps = { ...(old?.dateStamps || {}) };
  for (const f of schema?.fields || []) {
    if (f.type !== 'date') continue;
    const v = next[f.key];
    if (v && (!old || old[f.key] !== v)) dateStamps[f.key] = now;
  }
  // date-only values kept under plain keys (paidAt, refundPaidAt, receivedOn ...) get their time of day too
  for (const k of Object.keys(next)) {
    if (!/(At|On)$/.test(k) || k === 'recordCreatedAt' || k === 'lastUpdatedAt') continue;
    const v = next[k];
    if (typeof v === 'string' && /^\d{4}-\d\d-\d\d$/.test(v) && (!old || old[k] !== v)) dateStamps[k] = now;
  }
  return { timeline, dateStamps };
}

/** Time of day for a date field if we know it ('' otherwise). */
export const stampOf = (rec, key) => rec?.dateStamps?.[key] || '';
