// Cultural event photos: pick -> check -> thumbnail -> object store -> gallery row, all automatically.
// Optional: file a photo into the Documents repository (Cultural / <year> / <event name>) so it is kept with the community's records.
import { screenFiles } from './files/attachments.js';
import { activeObjectStore, objectKey } from './files/objectStore.js';
import { secureStorage } from './storage/secureStorage.js';
import { COLLECTIONS } from './storage/index.js';
import { getPrincipal } from './security/principal.js';

/** A small JPEG data URL for the tile grid (so the grid never downloads full-size photos). */
export async function makeThumb(file, side = 360, quality = 0.72) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const scale = Math.min(1, side / Math.max(img.width, img.height));
    const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  } finally { URL.revokeObjectURL(url); }
}

/**
 * Upload many photos. Calls onProgress({ done, total, name }) as each finishes. Returns { added: [rows], rejected: [{name, reason}] }.
 * `toDocuments` also files each photo into Documents (needs permission; skipped silently otherwise).
 */
export async function uploadPhotos(fileList, { ev, caption = '', toDocuments = false, onProgress } = {}) {
  const p = getPrincipal();
  const { accepted, rejected } = await screenFiles(Array.from(fileList || []).filter((f) => f.type.startsWith('image/')));
  const skipped = Array.from(fileList || []).filter((f) => !f.type.startsWith('image/')).map((f) => ({ name: f.name, reason: 'Only pictures can be added to the gallery' }));
  const store = activeObjectStore();
  const added = [];
  let done = 0;
  for (const { file, validation } of accepted) {
    onProgress?.({ done, total: accepted.length, name: file.name });
    try {
      const thumb = await makeThumb(file);
      const { key, fileId } = await store.put(objectKey(`cultural/${eventYear(ev)}`, eventSlug(ev), file.name), file, { ownerType: 'culturalPhoto', ownerId: ev.id, scanStatus: validation.status });
      let row = await secureStorage.put(COLLECTIONS.CULTURAL_PHOTOS, { eventId: ev.id, caption, takenOn: new Date().toISOString().slice(0, 10), fileName: file.name, mime: file.type, fileSize: Math.ceil(file.size / 1024), fileId, objectKey: key, store: store.id, thumb, uploadedBy: p?.name || '' });
      if (toDocuments) { const d = await publishToDocuments(row, ev).catch(() => null); if (d) row = await secureStorage.put(COLLECTIONS.CULTURAL_PHOTOS, { ...row, documentId: d.shortId || d.id }); }
      added.push(row);
    } catch (e) { rejected.push({ name: file.name, reason: e?.message || 'Could not upload' }); }
    done += 1;
  }
  onProgress?.({ done, total: accepted.length, name: '' });
  return { added, rejected: [...rejected, ...skipped] };
}

/** The year an event belongs to (its start date), used in the file path and the Documents folder. */
export const eventYear = (ev) => String(ev?.startDate || ev?.date || new Date().toISOString()).slice(0, 4);
/** Folder-safe event name: "Navaratri 2026" -> navaratri-2026. The short id keeps two events with one name apart. */
export const eventSlug = (ev) => `${String(ev?.name || 'event').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'event'}${ev?.shortId ? `-${String(ev.shortId).toLowerCase()}` : ''}`;

/** File a gallery photo into Documents under "Cultural / <year> / <event>" (folders created on first use). Same bytes, no copy. */
export async function publishToDocuments(photo, ev) {
  const folders = await secureStorage.list(COLLECTIONS.DOC_FOLDERS);
  const mk = (name, parentId) => secureStorage.put(COLLECTIONS.DOC_FOLDERS, { name, parentId, accessRoles: [] });
  let top = folders.find((f) => !f.parentId && f.name === 'Cultural');
  const old = folders.find((f) => !f.parentId && f.name === 'Cultural events'); // earlier layout: Cultural events / <event>
  if (!top && old) top = await secureStorage.put(COLLECTIONS.DOC_FOLDERS, { ...old, name: 'Cultural' });
  if (!top) top = await mk('Cultural', '');
  const year = eventYear(ev);
  let yf = folders.find((f) => f.parentId === top.id && f.name === year);
  if (!yf) yf = await mk(year, top.id);
  let sub = folders.find((f) => f.parentId === yf.id && f.name === ev.name);
  if (!sub) {
    const legacy = folders.find((f) => f.parentId === top.id && f.name === ev.name); // move an old event folder under its year
    sub = legacy ? await secureStorage.put(COLLECTIONS.DOC_FOLDERS, { ...legacy, parentId: yf.id }) : await mk(ev.name, yf.id);
  }
  return secureStorage.put(COLLECTIONS.DOCUMENTS, {
    title: photo.caption || photo.fileName, category: 'Association', version: '1', access: 'Everyone', folderId: sub.id,
    fileId: photo.fileId, fileName: photo.fileName, mime: photo.mime, fileSize: photo.fileSize, scanStatus: 'Passed local checks', objectKey: photo.objectKey,
  });
}

export async function removePhoto(photo) {
  await secureStorage.remove(COLLECTIONS.CULTURAL_PHOTOS, photo.id);
  if (!photo.documentId) await activeObjectStore().remove(photo.fileId); // bytes stay if the photo is also filed in Documents
}
