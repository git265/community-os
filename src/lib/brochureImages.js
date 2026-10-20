// Pictures on an event brochure: pick -> check -> shrink to print size -> object store. The row keeps only a pointer and a small preview.
import { screenFiles } from './files/attachments.js';
import { activeObjectStore, objectKey } from './files/objectStore.js';
import { makeThumb, eventYear, eventSlug } from './culturalPhotos.js';

/** Shrink a picture to at most `side` pixels (JPEG), so a 12 MB camera photo does not make a 12 MB brochure. */
export async function shrinkImage(file, side = 1600, quality = 0.85) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const scale = Math.min(1, side / Math.max(img.width, img.height));
    const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
    return new File([blob], String(file.name || 'picture').replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } finally { URL.revokeObjectURL(url); }
}

/** Upload one picture for a brochure page. Returns the fields to merge into the page row, or throws with a plain reason. */
export async function addBrochureImage(file, ev) {
  if (!file?.type?.startsWith('image/')) throw new Error('Only pictures can be added to a brochure');
  const { accepted, rejected } = await screenFiles([file]);
  if (!accepted.length) throw new Error(rejected[0]?.reason || 'That file was not accepted');
  const small = await shrinkImage(file);
  const store = activeObjectStore();
  const { key, fileId } = await store.put(objectKey(`cultural/${eventYear(ev)}/brochure`, eventSlug(ev), small.name), small, { ownerType: 'culturalBrochure', ownerId: ev.id, scanStatus: accepted[0].validation.status });
  return { fileId, objectKey: key, thumb: await makeThumb(small, 480, 0.72), imageName: file.name };
}

/** Full-size URL of a page's picture (falls back to the preview). */
export async function imageUrl(row) {
  if (!row?.fileId) return '';
  try { return (await activeObjectStore().url(row.fileId)) || row.thumb || ''; } catch { return row.thumb || ''; }
}

/** Remove the picture bytes unless another page (a copied event) still points at them. */
export async function dropImage(row, allRows) {
  if (!row?.fileId) return;
  if (allRows.some((r) => r.id !== row.id && r.fileId === row.fileId)) return;
  await activeObjectStore().remove(row.fileId);
}
