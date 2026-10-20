// ObjectStore - where file BYTES live (photos, documents). Rows keep only a small pointer ({ key, fileId }).
// Same idea as StorageAdapter: screens call put()/url()/remove(); which provider is behind it is configuration.
//
//   Browser demo storage   keeps bytes in the FILES collection (this demo). Same key layout as the real thing.
//   Amazon S3 / Azure Blob  the browser asks YOUR Spring Boot API for a short-lived upload URL (S3 presigned PUT / Azure SAS),
//                           uploads straight to the bucket (no bytes pass through the app server), then tells the API it is done.
//                           Reads use a short-lived signed GET URL, so the bucket stays private.
//
//   POST {api}/files/presign   { key, mime, size }          -> { uploadUrl, headers, objectKey }
//   POST {api}/files/complete  { objectKey }                -> { fileId }   (server scans with ClamAV, then marks it available)
//   GET  {api}/files/{fileId}/url                           -> { url, expiresAt }
//   DELETE {api}/files/{fileId}
import { secureStorage } from '../storage/secureStorage.js';
import { COLLECTIONS, isApiMode } from '../storage/index.js';
import { backendFetch } from '../storage/dataSource.js';
import { fileToBase64Url } from './fileValidation.js';
import { getCommunityConfig } from '../locale.js';
import { resolveSlug } from '../community.js';
import { uuid } from '../uuid.js';

/** Community-scoped, tidy, collision-free object keys: communities/<slug>/<area>/<owner>/<uuid>-<name>. */
export function objectKey(area, ownerId, fileName) {
  const safe = String(fileName || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80);
  return `communities/${resolveSlug()}/${area}/${ownerId || 'general'}/${uuid().slice(0, 8)}-${safe}`;
}

export class ObjectStore {
  constructor(id, name) { this.id = id; this.name = name; }
  /** @returns {Promise<{key:string,fileId:string}>} */
  async put(/* key, file, meta */) { throw new Error(`${this.name}: put not implemented`); }
  /** A URL the browser can show/download for a short time. */
  async url(/* fileId */) { throw new Error(`${this.name}: url not implemented`); }
  async remove(/* fileId */) { /* optional */ }
}

class BrowserDemoStore extends ObjectStore {
  constructor() { super('browser', 'Browser demo storage'); }
  async put(key, file, meta = {}) {
    const saved = await secureStorage.put(COLLECTIONS.FILES, { name: file.name, mime: file.type, size: file.size, scanStatus: meta.scanStatus || 'checked-locally', dataUrl: await fileToBase64Url(file), ownerType: meta.ownerType || 'photo', ownerId: meta.ownerId || '', objectKey: key });
    return { key, fileId: saved.id };
  }
  async url(fileId) { return (await secureStorage.get(COLLECTIONS.FILES, fileId))?.dataUrl || ''; }
  async remove(fileId) { try { await secureStorage.remove(COLLECTIONS.FILES, fileId); } catch { /* keep going */ } }
}

/** Production adapter for S3 and Azure Blob (both use "signed URL" uploads, so one class covers both). */
export class SignedUrlStore extends ObjectStore {
  constructor(id, name, api) { super(id, name); this.api = api; }
  async #json(path, init) { const r = await backendFetch(path, init, resolveSlug(), this.api); if (!r.ok) throw new Error(`${this.name}: ${r.status}`); return r.json(); }
  async put(key, file) {
    const { uploadUrl, headers, objectKey } = await this.#json('/files/presign', { method: 'POST', body: JSON.stringify({ key, mime: file.type, size: file.size }) });
    const up = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type, ...(headers || {}) }, body: file });
    if (!up.ok) throw new Error(`${this.name}: upload failed (${up.status})`);
    const { fileId } = await this.#json('/files/complete', { method: 'POST', body: JSON.stringify({ objectKey }) });
    return { key: objectKey, fileId };
  }
  async url(fileId) { return (await this.#json(`/files/${encodeURIComponent(fileId)}/url`)).url; }
  async remove(fileId) { await this.#json(`/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' }); }
}

/** Data source = Back end: file rows go through the storage adapter, which sends the bytes to the server's FileStorage port
 *  (local disk, S3, Azure ...) and keeps only a small metadata row in the database. Nothing else in the UI changes. */
class ServerFileStore extends BrowserDemoStore {
  constructor() { super(); this.id = 'server'; this.name = 'Back end file storage'; }
}

const stores = {};
export const registerObjectStore = (s) => { stores[s.id] = s; return s; };
registerObjectStore(new BrowserDemoStore());
registerObjectStore(new ServerFileStore());
registerObjectStore(new SignedUrlStore('s3', 'Amazon S3'));
registerObjectStore(new SignedUrlStore('azure', 'Azure Blob Storage'));

/** The community's chosen store; falls back to the demo store when the chosen one needs an API that is not connected. */
export function activeObjectStore() {
  if (isApiMode() && !import.meta.env.VITE_SIGNED_URL_UPLOADS) return stores.server; // the server decides where bytes live (see docs/INTEGRATIONS.md)
  const pick = getCommunityConfig().fileStorage;
  const id = /S3/.test(pick || '') ? 's3' : /Azure/.test(pick || '') ? 'azure' : 'browser';
  const useApi = import.meta.env.VITE_USE_API === 'true' || !!import.meta.env.VITE_API_URL;
  return id !== 'browser' && !useApi ? stores.browser : (stores[id] || stores.browser);
}
