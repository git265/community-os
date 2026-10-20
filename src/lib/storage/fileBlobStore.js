// File bytes (photos, PDFs, documents) live in IndexedDB, not sessionStorage: sessionStorage has a ~5 MB quota for EVERYTHING, so a
// few attachments used to overflow it and make saves hang. IndexedDB holds hundreds of MB. Rows are keyed  <community>|<id>.
// (In production the bytes go to object storage and only the metadata row stays in the database.)
const DB = 'communityos-files';
const STORE = 'files';
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
    tx.oncomplete = () => resolve(out.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Storage is full - delete some files and try again.'));
  });
};
export const blobStoreAvailable = () => typeof indexedDB !== 'undefined';
export async function blobList(slug) {
  const all = await run('readonly', (s) => s.getAll());
  return all.filter((r) => r.k.startsWith(`${slug}|`)).map(({ k, ...row }) => row);
}
export async function blobGet(slug, id) {
  const r = await run('readonly', (s) => s.get(`${slug}|${id}`));
  if (!r) return null;
  const { k, ...row } = r; return row;
}
export const blobPut = (slug, row) => run('readwrite', (s) => s.put({ ...row, k: `${slug}|${row.id}` }));
export const blobRemove = (slug, id) => run('readwrite', (s) => s.delete(`${slug}|${id}`));
export async function blobClear(slug) {
  const rows = await blobList(slug);
  for (const r of rows) await blobRemove(slug, r.id);
}
