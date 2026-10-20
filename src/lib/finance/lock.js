// Period lock: once the books are closed up to a date, nobody can add, change or delete a payment dated on or before it.
// The date lives in the Finance settings row (Billing -> Dues -> Rules). secureStorage asks lockError() before a ledger write.
import { COLLECTIONS as C } from '../storage/StorageAdapter.js';

let lockedUntilGlobal = '';
let lockResolver = null;
/** SERVER ONLY: the closed-books date of the request's community. */
export const setLockResolver = (fn) => { lockResolver = fn; };
export const setLock = (d) => { lockedUntilGlobal = String(d || '').slice(0, 10); };
export const getLock = () => (lockResolver ? lockResolver() || '' : lockedUntilGlobal);
const LOCKED = [C.LEDGER];
const dmy = (s) => new Date(`${s}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

/** A message when this write touches a closed period, else ''. `old` is the stored row (for edits and deletes). */
export function lockError(collection, record, old) {
  const lockedUntil = getLock();
  if (!lockedUntil || !LOCKED.includes(collection)) return '';
  const dates = [record?.date, old?.date].filter(Boolean).map((d) => String(d).slice(0, 10));
  if (dates.some((d) => d <= lockedUntil)) return `The books are closed up to ${dmy(lockedUntil)}. A payment dated on or before that day cannot be added, changed or removed - ask the Treasurer to reopen the period if it is a genuine correction.`;
  return '';
}
