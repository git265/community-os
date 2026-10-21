import { SessionStorageAdapter } from './SessionStorageAdapter.js';
import { V2ApiAdapter } from './v2/V2ApiAdapter.js';
import { getDataSource } from './dataSource.js';
import { getCommunity } from '../community.js';
export { COLLECTIONS } from './StorageAdapter.js';
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
const inflight = new Map(); // `${slug}|${collection}|${method}|${args}` -> Promise
// No data is cached in the browser: every read that is not already in flight goes to the server. (Until round 76 a list of settings and
// reference collections - users, roles, fee settings ... - was kept for 3 seconds; it is gone, so another person's change shows at once.)
const slugNow = () => { try { return getCommunity(); } catch { return ''; } };
const dropReads = (slug, collection) => { const p = `${slug}|${collection}|`; for (const k of inflight.keys()) if (k.startsWith(p)) inflight.delete(k); };
export const storage = Object.fromEntries(METHODS.map((m) => [m, (...args) => {
  const a = activeAdapter();
  if (a !== V2ApiAdapter) return a[m](...args);
  const slug = slugNow(); const collection = typeof args[0] === 'string' ? args[0] : '';
  if (READS.has(m)) {
    const key = `${slug}|${collection}|${m}|${JSON.stringify(args.slice(1))}`;
    const hit = inflight.get(key);
    if (hit) return hit.then((r) => (r && typeof r === 'object' ? structuredClone(r) : r)); // each caller gets its own copy to sort or edit
    const pr = a[m](...args).finally(() => { if (inflight.get(key) === pr) inflight.delete(key); });
    inflight.set(key, pr);
    return pr;
  }
  if (m === 'put' || m === 'putMany' || m === 'remove' || m === 'replaceAll') {
    dropReads(slug, collection);
    return a[m](...args).finally(() => dropReads(slug, collection));
  }
  return a[m](...args);
}]));

// Whatever announces a change to a collection (any write in this tab, however it got there) also empties what was kept for it.
if (typeof window !== 'undefined') {
  window.addEventListener('communityos:changed', (e) => {
    const c = e.detail?.collection;
    if (c) dropReads(slugNow(), c); else inflight.clear();
  });
}
