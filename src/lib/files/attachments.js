// Staging + persisting of file attachments (tickets, quotations, chart-of-accounts entries).
//
// Flow: the user picks files -> each is shrunk (photos only), validated (type, signature, size,
// active content, malware test string, optional ClamAV hook) and kept in memory as "pending".
// Nothing is stored until the owning form is SAVED; then persistPending() writes the bytes to the
// FILES collection and returns small metadata objects ({ fileId, name, size, mime, scanStatus })
// that live on the owning record. On the Spring Boot side this becomes a multipart upload to
// object storage + a ClamAV scan; the record keeps the same metadata.
import { validateFile, fileToBase64Url } from './fileValidation.js';
import { secureStorage } from '../storage/secureStorage.js';
import { COLLECTIONS } from '../storage/index.js';
import { AuthzError } from '../security/authz.js';

/** Phone photos are several MB: downscale to a sensible JPEG before validating (sessionStorage is small). */
export async function shrinkImage(file, maxSide = 1600, quality = 0.8) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.size < 300 * 1024) return file;
  try {
    const url = URL.createObjectURL(file);
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
    URL.revokeObjectURL(url);
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

/** Validate a batch. Returns { accepted: [{file, validation}], rejected: [{name, reason}] }. */
export async function screenFiles(fileList) {
  const accepted = [];
  const rejected = [];
  for (const raw of Array.from(fileList || [])) {
    const file = await shrinkImage(raw);
    const validation = await validateFile(file, { allowImages: true });
    if (validation.ok) accepted.push({ file, validation });
    else rejected.push({ name: raw.name, reason: validation.reason });
  }
  return { accepted, rejected };
}

/** Store the pending files; returns metadata for the owning record. Returns null if any write was denied. */
export async function persistPending(pending, { ownerType, ownerId }) {
  const metas = [];
  for (const { file, validation } of pending) {
    try {
      const dataUrl = await fileToBase64Url(file);   // reading the file can fail too (moved, too big for the browser): said, never left spinning
      const saved = await secureStorage.put(COLLECTIONS.FILES, {
        name: file.name, mime: file.type, size: file.size, scanStatus: validation.status, dataUrl, ownerType, ownerId,
      });
      metas.push({ fileId: saved.id, name: file.name, size: file.size, mime: file.type, scanStatus: validation.status === 'clean' ? 'Clean' : 'Checked' });
    } catch (err) {
      if (err instanceof AuthzError) {
        window.dispatchEvent(new CustomEvent('communityos:denied', { detail: { message: err.message } }));
        return null;
      }
      // anything else (storage full, blocked, ...) must never leave the form stuck on "Saving…"
      const net = err?.name === 'NetworkError' || err?.name === 'TimeoutError';
      window.dispatchEvent(new CustomEvent('communityos:denied', { detail: { kind: net ? 'network' : 'error', message: `Could not upload ${file.name}: ${err?.message || 'storage error'} Nothing was saved - press Save again.` } }));
      return null;
    }
  }
  return metas;
}

export async function loadFileData(fileId) {
  const f = await secureStorage.get(COLLECTIONS.FILES, fileId);
  return f?.dataUrl || null;
}

export async function downloadAttachment(meta) {
  const dataUrl = await loadFileData(meta.fileId);
  if (!dataUrl) return;
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = meta.name || 'file';
  a.click();
}

export const isImageMeta = (m) => /^image\//.test(m?.mime || '');
