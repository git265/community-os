// Where collections too big for sessionStorage (~5 MB) are kept. The adapter reads them from memory; this store only makes them
// survive a reload of the SAME tab: entries are tagged with the tab's id (kept in sessionStorage) and old ones are swept away.
// Demo adapter only - the real back end is PostgreSQL.
const DB = 'communityos-spill';
const STORE = 'collections';
const MAX_AGE = 24 * 3600 * 1000;
let dbp = null;
const open = () => {
  if (!dbp) dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'k' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
};
const run = async (mode, fn) => {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const out = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(out?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
};
const tabId = () => { try { let t = sessionStorage.getItem('communityos:tabId'); if (!t) { t = Math.random().toString(36).slice(2); sessionStorage.setItem('communityos:tabId', t); } return t; } catch { return 'tab'; } };
const available = () => typeof indexedDB !== 'undefined';

/** All collections this tab spilled earlier, as { storageKey: records }; sweeps entries of other/old tabs. */
export async function spillLoad() {
  if (!available()) return {};
  try {
    const me = tabId(); const now = Date.now(); const out = {};
    const all = await run('readonly', (s) => s.getAll());
    const stale = [];
    for (const r of all) {
      if (r.tab === me) out[r.key] = r.records;
      else if (now - (r.at || 0) > MAX_AGE) stale.push(r.k);
    }
    if (stale.length) await run('readwrite', (s) => { stale.forEach((k) => s.delete(k)); return null; });
    return out;
  } catch { return {}; }
}

const timers = new Map();
export function spillSave(key, getRecords) {
  if (!available()) return;
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => {
    run('readwrite', (s) => s.put({ k: `${tabId()}|${key}`, tab: tabId(), key, records: getRecords(), at: Date.now() })).catch(() => {});
  }, 400));
}
export function spillRemove(keys) {
  if (!available() || !keys.length) return;
  run('readwrite', (s) => { keys.forEach((k) => s.delete(`${tabId()}|${k}`)); return null; }).catch(() => {});
}
