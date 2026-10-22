// Which notices a person has opened. On the back end the server keeps it (a notice opened through GET /comms/broadcasts/{id} is marked
// viewed for that member, and every notice carries the reader's own viewedAt); in the browser demo it is kept for the person in this browser.
import { storage, COLLECTIONS } from './storage/index.js';
import { isApiMode } from './storage/dataSource.js';

const key = (who) => `communityos:noticeReads:${who || 'me'}`;
function readIds(who) { try { return new Set(JSON.parse(localStorage.getItem(key(who)) || '[]')); } catch { return new Set(); } }
function keepIds(who, ids) { try { localStorage.setItem(key(who), JSON.stringify([...ids].slice(-2000))); } catch { /* storage full or blocked: reads are a convenience */ } }

/** Has this person opened the notice? */
export function isRead(notice, who) { return isApiMode() ? !!notice?.viewedAt : readIds(who).has(notice?.id); }

/** Mark it opened (once). Resolves to the notice as it is now (with its viewedAt on the back end). */
export async function markRead(notice, who) {
  if (!notice?.id || isRead(notice, who)) return notice;
  if (isApiMode()) {
    const fresh = await storage.get(COLLECTIONS.BROADCASTS, notice.id).catch(() => null);   // opening it is what marks it viewed on the server
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: COLLECTIONS.BROADCASTS } }));
    return fresh || { ...notice, viewedAt: new Date().toISOString() };
  }
  const ids = readIds(who); ids.add(notice.id); keepIds(who, ids);
  return notice;
}

/** Mark every notice in the list opened. */
export async function markAllRead(notices, who) {
  if (isApiMode()) { for (const n of notices) if (!isRead(n, who)) await markRead(n, who); return; }
  const ids = readIds(who); for (const n of notices) ids.add(n.id); keepIds(who, ids);
}
