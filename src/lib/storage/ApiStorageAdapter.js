// StorageAdapter over HTTP: talks to the Spring Boot service in /backend (PostgreSQL, one JSONB document per record).
// Same methods and record shape as SessionStorageAdapter, so no module changes when the data source is flipped.
// The wire contract is in docs/BACKEND.md; the server side implements it in com.communityos.web.DocumentController.
//
//   GET    {base}/{collection}                list
//   GET    {base}/{collection}/{id}           one (404 -> null)
//   PUT    {base}/{collection}/{id}           upsert (shallow-merged into the stored document), returns the Record
//   DELETE {base}/{collection}/{id}
//   GET    {base}/{collection}/query?...      server-side paging, sort, filter, search (see queryEngine.js for the meaning)
//   POST   {base}/{collection}/bulk           body Record[] -> upsert all in ONE transaction
//   PUT    {base}/{collection}                body Record[] -> replace the whole collection (seed / import only)
//
// FILES: rows in the `files` collection carry bytes as a data URL. Bytes never go into the database; they go to the
// server's FileStorage port (local disk, S3, Azure ...):
//   PUT/GET/DELETE {base}/files/{id}/content      raw bytes
// and only the small metadata row is stored as a document.
import { getCommunity } from '../community.js';
import { apiFetch } from '../net/request.js';
import { AuthzError, ConflictError } from '../security/errors.js';
import { clearSession, serverEnforces } from '../auth/session.js';

const FILES = 'files';

async function http(slug, path, init = {}, raw = false) {
  const res = await apiFetch(path, init, { slug, bytes: raw || init.body instanceof Blob });   // timeouts / retries / token renewal: net/request.js
  if (res.status === 404 && init.method !== 'DELETE' && !raw) return null;
  if (!res.ok) {
    let body = null; try { body = await res.json(); } catch { /* not JSON */ }
    if (res.status === 401 && serverEnforces()) clearSession(body?.code === 'deactivated' ? 'Your portal access has been withdrawn. Please contact the community office.' : 'Your session has ended. Please sign in again.');
    if (res.status === 403 && body?.code === 'denied') throw new AuthzError(body.message);
    if (res.status === 409 && body?.code === 'conflict') throw new ConflictError(body.current, body.message);
    throw new Error(`${body?.message || `Back end error ${res.status}`} (${init.method || 'GET'} ${path})`);
  }
  if (raw) return res;
  if (res.status === 204) return null;
  return res.json();
}

const dataUrlToBlob = async (u) => (await fetch(u)).blob();
const blobToDataUrl = (b) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => no(r.error); r.readAsDataURL(b); });

function queryString(params = {}) {
  const q = new URLSearchParams();
  q.set('page', params.page ?? 1);
  q.set('pageSize', params.pageSize ?? 50);
  if (params.sort?.key) q.set('sort', `${params.sort.key}:${params.sort.dir || 'asc'}`);
  if (params.search) q.set('search', params.search);
  (params.searchKeys || []).forEach((k) => q.append('searchKey', k));
  if (params.dateRange?.key) {
    q.set('dateKey', params.dateRange.key);
    if (params.dateRange.from) q.set('from', params.dateRange.from);
    if (params.dateRange.to) q.set('to', params.dateRange.to);
  }
  if (params.period?.key && (params.period.year || params.period.month)) {
    q.set('periodKey', params.period.key);
    if (params.period.year) q.set('year', params.period.year);
    if (params.period.month) q.set('month', params.period.month);
  }
  for (const [k, v] of Object.entries(params.filters || {})) {
    if (v === '' || v == null || (Array.isArray(v) && !v.length)) continue;
    (Array.isArray(v) ? v : [v]).forEach((x) => q.append(`f.${k}`, x));
  }
  return q.toString();
}

function make(slugOf) {
  const call = (path, init, raw) => http(slugOf(), path, init, raw);
  const self = {
    async list(collection) { return (await call(`/${collection}`)) || []; },
    async query(collection, params) { return call(`/${collection}/query?${queryString(params)}`); },
    async get(collection, id) {
      const row = await call(`/${collection}/${encodeURIComponent(id)}`);
      if (row && collection === FILES && !row.dataUrl && row.hasContent !== false) {
        try { row.dataUrl = await blobToDataUrl(await (await call(`/${FILES}/${encodeURIComponent(id)}/content`, {}, true)).blob()); } catch { /* bytes missing: caller shows "no longer available" */ }
      }
      return row;
    },
    async put(collection, record) {
      if (collection === FILES && record.dataUrl) {
        const blob = await dataUrlToBlob(record.dataUrl);
        const { dataUrl, ...meta } = record;
        await call(`/${FILES}/${encodeURIComponent(record.id)}/content`, { method: 'PUT', body: blob, headers: { 'Content-Type': blob.type || record.mime || 'application/octet-stream' } }, true);
        return { ...(await call(`/${FILES}/${encodeURIComponent(record.id)}`, { method: 'PUT', body: JSON.stringify({ ...meta, hasContent: true }) })), dataUrl };
      }
      return call(`/${collection}/${encodeURIComponent(record.id)}`, { method: 'PUT', body: JSON.stringify(record) });
    },
    async putMany(collection, list) {
      if (collection === FILES) { const out = []; for (const r of list) out.push(await self.put(collection, r)); return out; }
      return list.length ? call(`/${collection}/bulk`, { method: 'POST', body: JSON.stringify(list) }) : [];
    },
    async remove(collection, id) {
      if (collection === FILES) await call(`/${FILES}/${encodeURIComponent(id)}/content`, { method: 'DELETE' }, true).catch(() => {});
      await call(`/${collection}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    async replaceAll(collection, records) {
      await call(`/${collection}`, { method: 'PUT', body: JSON.stringify(records) });
    },
  };
  return self;
}

/** @type {import('./StorageAdapter').StorageAdapter} */
export const ApiStorageAdapter = {
  ...make(getCommunity),
  forCommunity(slug) { return make(() => slug); },
  /** A call that is not a plain record read/write (bulk endpoints of the service layer). */
  rpc(path, method, body) { return http(getCommunity(), path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }); },
  /** Demo reset: needs app.admin.allow-tenant-reset=true on the server (off by default in production). */
  async clearCommunity(slug) { await http(slug, `/admin/tenants/${encodeURIComponent(slug)}`, { method: 'DELETE' }, true); },
};
