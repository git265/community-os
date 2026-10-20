// Meetings: who can see them and who is told.
//   Internal (committee only)  - only the Executive Committee / management staff see the meeting, its agenda and minutes.
//   Published to residents     - owners and residents see it (and its agenda, and minutes once added) and are NOTIFIED:
//        first publish        -> "New meeting"           every update that matters (date, time, place, cancelled) -> "Meeting updated"
//        minutes added        -> "Minutes are available"
//   Notifications = the in-app bell (all owner/resident roles) + WhatsApp / SMS / e-mail for the people who chose those channels
//   under Notifications -> My channels (see lib/notify.js; outbox rows are demo: queued, not delivered).
//   Meetings created before this option existed count as Published (they were visible to everyone already).
import { storage } from './storage/index.js';
import { COLLECTIONS as C } from './storage/StorageAdapter.js';
import { notify } from './notify.js';
import { uuid } from './uuid.js';
import { pushNotification } from './notifications.js';
import { peopleOf } from './people.js';

export const INTERNAL = 'Internal (committee only)';
export const PUBLISHED = 'Published to residents';
export const isPublished = (m) => !!m && m.visibility !== INTERNAL;
const SYSTEM = 'System · meetings';
const WATCH = ['date', 'startTime', 'endTime', 'location', 'status', 'title'];

export async function meetingPreWrite({ record, old }) {
  const r = { ...record };
  if (isPublished(r)) r.publishedAt = old?.publishedAt || (r.visibility === PUBLISHED ? new Date().toISOString() : '');
  else r.publishedAt = '';
  return { record: r };
}

async function residentRoleIds() {
  const roles = await storage.list(C.ROLES);
  const ids = roles.filter((r) => r.category === 'Resident').map((r) => r.id);
  return ids.length ? ids : ['owner', 'resident'];
}

export async function meetingPostWrite({ old, next, actor }) {
  if (!isPublished(next)) return;
  const wasPublished = !!old && isPublished(old) && !!old.publishedAt;
  if (next.status === 'Cancelled' && old?.status === 'Cancelled') return; // already told
  let kind = null;
  if (!wasPublished) kind = 'published';
  else if (WATCH.some((k) => JSON.stringify(next[k]) !== JSON.stringify(old[k]))) kind = next.status === 'Cancelled' && old.status !== 'Cancelled' ? 'cancelled' : 'updated';
  else if (next.minutes && !old.minutes) kind = 'minutes';
  if (!kind) return;
  const when = `${next.date || ''}${next.startTime ? ` at ${next.startTime}` : ''}`;
  const head = { published: 'New meeting', updated: 'Meeting updated', cancelled: 'Meeting cancelled', minutes: 'Minutes available' }[kind];
  const text = {
    published: `${next.title} (${next.committee}) is scheduled for ${when}${next.location ? ` · ${next.location}` : ''}. The agenda is in Governance.`,
    updated: `${next.title} is now ${when}${next.location ? ` · ${next.location}` : ''}.`,
    cancelled: `${next.title} on ${next.date} has been cancelled.`,
    minutes: `Minutes of ${next.title} (${next.date}) are now available in Governance.`,
  }[kind];
  await notify({ event: 'meeting', kind: 'meeting', title: `${head} · ${next.title}`, body: text, link: '#/governance', by: actor || '', toRoleIds: await residentRoleIds() });
  window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: C.NOTIFICATION_OUTBOX } }));
  window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: 'notifications' } }));
}
