import { SessionStorageAdapter } from './SessionStorageAdapter.js';
import { V2ApiAdapter } from './v2/V2ApiAdapter.js';
import { getDataSource } from './dataSource.js';
import { getCommunity } from '../community.js';
import { getAuthUser } from '../auth/session.js';
import { COLLECTIONS } from './StorageAdapter.js';
import { announceChange } from './changes.js';
export { COLLECTIONS };
export { getDataSource, setDataSource, isApiMode, pingBackend } from './dataSource.js';

// THE swap point. `storage` is a thin facade: every call goes to whichever adapter the Data source setting names RIGHT NOW
// (session = browser demo store, v2 = the Spring Boot + PostgreSQL back end). Modules never know which one answered.
// To add a third kind of store (Firebase, Mongo over REST ...), write an adapter with the same methods and add it to ADAPTERS.
export const ADAPTERS = { session: SessionStorageAdapter, v2: V2ApiAdapter };
export const activeAdapter = () => ADAPTERS[getDataSource().mode] || SessionStorageAdapter;

const METHODS = ['list', 'query', 'get', 'put', 'putMany', 'remove', 'replaceAll', 'forCommunity', 'clearCommunity'];
// Back end only: identical reads that are in flight at the same moment share ONE request (two components asking for `users`
// while the page opens, React's double effect in dev ...). Nothing is stored after the answer arrives, so there is no cache to go
// stale or to hold memory: the next read after that is a fresh request. A write drops the waiting reads of its collection so
// nobody joins a read that started before the write.
const READS = new Set(['list', 'get', 'query']);
const WRITES = new Set(['put', 'putMany', 'remove', 'replaceAll']);
// Every write, however it got here (the rule book, a bill run, a background job), tells the screens which collection changed, so the
// lists behind a pop-up reload. Not for the audit trail (every save writes a line), file bytes or the guards' heartbeat.
const QUIET = new Set([COLLECTIONS.AUDIT, COLLECTIONS.FILES, COLLECTIONS.GATE_PULSE]);
const told = (c) => { if (typeof c === 'string' && c && !QUIET.has(c)) announceChange(c); };
// On the back end one save can change other records too (the server books the payment of a paid bill, prices a booking's bill ...):
// the lists of those reload as well. (In the browser store each of those writes passes through here and is announced by itself.)
const ALSO = {
  [COLLECTIONS.DUES]: [COLLECTIONS.LEDGER],
  [COLLECTIONS.AMENITIES]: [COLLECTIONS.DUES, COLLECTIONS.LEDGER],
  [COLLECTIONS.READINGS]: [COLLECTIONS.DUES],
  [COLLECTIONS.QUOTATIONS]: [COLLECTIONS.TICKETS, COLLECTIONS.LEDGER],
  [COLLECTIONS.RELEASES]: [COLLECTIONS.LEDGER, COLLECTIONS.QUOTATIONS],
  [COLLECTIONS.CULTURAL_DONATIONS]: [COLLECTIONS.LEDGER],
  [COLLECTIONS.CULTURAL_EXPENSES]: [COLLECTIONS.LEDGER],
  [COLLECTIONS.ASSOC_BILLS]: [COLLECTIONS.LEDGER],
  [COLLECTIONS.BANK_TXNS]: [COLLECTIONS.LEDGER],
  [COLLECTIONS.LEDGER]: [COLLECTIONS.BANK_TXNS, COLLECTIONS.DUES],
};
const toldV2 = (c) => { told(c); for (const x of ALSO[c] || []) told(x); };
const inflight = new Map(); // `${slug}|${collection}|${method}|${args}` -> Promise
// Reference lists - units, members, roles, staff, task types, settings, catalogues - are read by many screens and change seldom: on the back end
// (v2) an answer is kept for KEEP_MS, so moving between pages does not fetch them again. Kept answers are dropped by ANY write from this tab,
// by every change announced here (communityos:changed), and by every notification the server pushes (someone else did something). Records that
// move (bills, payments, tickets, the gate desk, notifications) are never kept: every read of those goes to the server.
const KEEP_MS = 30000;
const KEPT = new Set([COLLECTIONS.PROPERTIES, COLLECTIONS.USERS, COLLECTIONS.ROLES, COLLECTIONS.HANDYMEN, COLLECTIONS.TASK_TYPES, COLLECTIONS.CATEGORY_MAP,
  COLLECTIONS.AMENITY_TYPES, COLLECTIONS.AMENITY_SETTINGS, COLLECTIONS.FINANCE_SETTINGS, COLLECTIONS.UTILITY_TYPES, COLLECTIONS.VENDORS, COLLECTIONS.NOTICE_TEMPLATES,
  COLLECTIONS.MERGE_FIELDS, COLLECTIONS.EC_ROLES, COLLECTIONS.GATE_PEOPLE, COLLECTIONS.GATE_LINKS, COLLECTIONS.GATE_VEHICLES]);
const kept = new Map(); // key -> { at, value }
const slugNow = () => { try { return getCommunity(); } catch { return ''; } };
let generation = 0;   // a read that started before a write must not keep its (older) answer
export const forgetKept = () => { generation += 1; kept.clear(); };
const whoNow = () => { const u = getAuthUser(); return u ? String(u.membershipId || u.id || u.personId || u.name || '') : ''; };
const dropReads = (slug, collection) => { const p = `${slug}|`; const c = `|${collection}|`; for (const k of inflight.keys()) if (k.startsWith(p) && k.includes(c)) inflight.delete(k); };
export const storage = Object.fromEntries(METHODS.map((m) => [m, (...args) => {
  const a = activeAdapter();
  if (a !== V2ApiAdapter) {
    if (!WRITES.has(m)) return a[m](...args);
    return Promise.resolve(a[m](...args)).then((v) => { told(args[0]); return v; });
  }
  const slug = slugNow(); const collection = typeof args[0] === 'string' ? args[0] : '';
  if (READS.has(m)) {
    const key = `${slug}|${whoNow()}|${collection}|${m}|${JSON.stringify(args.slice(1))}`;
    const keep = a === V2ApiAdapter && KEPT.has(collection);
    const k = keep && kept.get(key);
    if (k && Date.now() - k.at < KEEP_MS) return Promise.resolve(k.value && typeof k.value === 'object' ? structuredClone(k.value) : k.value);
    const hit = inflight.get(key);
    if (hit) return hit.then((r) => (r && typeof r === 'object' ? structuredClone(r) : r)); // each caller gets its own copy to sort or edit
    const gen = generation;
    const pr = a[m](...args).then((v) => { if (keep && gen === generation) kept.set(key, { at: Date.now(), value: v && typeof v === 'object' ? structuredClone(v) : v }); return v; })
      .finally(() => { if (inflight.get(key) === pr) inflight.delete(key); });
    inflight.set(key, pr);
    return pr;
  }
  if (m === 'put' || m === 'putMany' || m === 'remove' || m === 'replaceAll') {
    dropReads(slug, collection); forgetKept();
    return a[m](...args).then((v) => { toldV2(collection); return v; }).finally(() => { dropReads(slug, collection); forgetKept(); });   // a write can change other lists too (a payment, a bill)
  }
  return a[m](...args);
}]));

// Whatever announces a change to a collection (any write in this tab, however it got there) also empties what was kept for it.
if (typeof window !== 'undefined') {
  window.addEventListener('communityos:changed', (e) => {
    const c = e.detail?.collection;
    if (c) dropReads(slugNow(), c); else inflight.clear();
    forgetKept();
  });
  window.addEventListener('communityos:notify', forgetKept);
  window.addEventListener('communityos:auth', forgetKept);    // signed in or out: nothing kept for the last person survives   // the server pushed news: someone else changed something
}
