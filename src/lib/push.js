// Push on the v2 back end, two ways:
//   live stream  while the app is open: one long-lived response from the server (Server-Sent Events) carries each new notification the moment
//                it is written. Read with fetch, not EventSource, because the stream needs the Authorization header. Reconnects by itself.
//   Web Push     while the app is closed: the browser's push service wakes the service worker (public/sw.js), which shows the notification.
//                Needs the person's permission; the subscription is sent to the server and removed again at sign-out.
import { apiFetch } from './net/request.js';
import { getDataSource } from './storage/dataSource.js';
import { getAccessToken, getAuthUser } from './auth/session.js';
import { notificationOf } from './storage/v2/v2map.js';

let live = false;
const CHANGED_BY = {
  bill: ['dues', 'ledger'], payment_made: ['dues', 'ledger'], amenity_booking: ['amenities'], gate_crew_inout: ['gateVisits'], payment: ['dues', 'ledger'], refund: ['amenities', 'ledger'], amenity: ['amenities'], booking: ['amenities'],
  assigned: ['tickets'], status: ['tickets'], ticket_new: ['tickets'], ticket_chat: ['ticketComments'], decision: ['tickets', 'quotations', 'releases'],
  ticket_assigned: ['tickets'], ticket_status: ['tickets'], ticket_decision: ['tickets', 'quotations'], release: ['releases'], stock_low: ['inventory'],
  gate_guest_arrived: ['gateVisits'], gate_guest_exit: ['gateVisits'], gate_delivery: ['gateVisits'], gate_staff_inout: ['gateVisits'], gate_overstay: ['gateFlags'], gate_override: ['gateVisits'],
  gate: ['gateVisits'], gate_approval: ['gateApprovals', 'gateVisits'], announcement: ['broadcasts'], poll: ['broadcasts'], forum_topic: ['forum'], forum_reply: ['forumPosts'],
  meeting: ['meetings'], ballot: ['ballots'], ballot_result: ['ballots'], cultural: ['culturalDonations', 'culturalExpenses', 'culturalEvents'],
  // properties, users, documents, vendors and attendance: the server sends no notification for them (backend/api comms Recipes), so nothing to map
};
/** True while the live stream is connected (the bell then stops asking for the unread count). */
export const isLive = () => live;

/** Splits a Server-Sent Events byte stream into { event, data } messages. */
export function sseParser(onMessage) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
      let event = 'message'; const data = [];
      for (const line of block.split(/\r?\n/)) {
        if (!line || line.startsWith(':')) continue;
        const c = line.indexOf(':'); const field = c < 0 ? line : line.slice(0, c); const value = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
        if (field === 'event') event = value; else if (field === 'data') data.push(value);
      }
      if (data.length || event !== 'message') onMessage({ event, data: data.join('\n') });
    }
  };
}

/**
 * Opens the live stream and keeps it open (after it ends - every few minutes by design - or fails, it reconnects, waiting longer after each
 * failure). `onReconnect` runs on every (re)connection so the caller can catch up on anything sent while it was away. Returns a stop function.
 */
export function startLive({ onReconnect } = {}) {
  if (getDataSource().mode !== 'v2') return () => {};
  let stopped = false; let ctl = null; let wait = 1000;
  const run = async () => {
    while (!stopped) {
      if (!getAccessToken()) { await sleep(2000); continue; }
      ctl = new AbortController();
      try {
        const res = await apiFetch('/v1/notifications/stream', { headers: { Accept: 'text/event-stream' }, signal: ctl.signal }, { retries: 0, timeout: 20000 });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        live = true; wait = 1000; onReconnect?.();
        const reader = res.body.getReader(); const dec = new TextDecoder();
        const feed = sseParser(({ event, data }) => {
          if (event !== 'notification') return;
          let n; try { n = JSON.parse(data); } catch { return; }
          window.dispatchEvent(new CustomEvent('communityos:notify', { detail: { notification: notificationOf(n, getAuthUser()?.name || '') } }));
          // someone else's action: the lists it touched reload on the screens showing them (a bill paid, a booking, a ticket moved)
          for (const c of CHANGED_BY[n.event] || CHANGED_BY[n.kind] || []) window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: c } }));
        });
        for (;;) { const { done, value } = await reader.read(); if (done) break; feed(dec.decode(value, { stream: true })); }
        live = false; if (!stopped) await sleep(1000);                  // the server ends each stream after a few minutes: open the next one
      } catch { live = false; if (!stopped) { await sleep(wait); wait = Math.min(30000, wait * 2); } }
    }
  };
  run();
  return () => { stopped = true; live = false; ctl?.abort(); };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const supported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
const keyBytes = (b64) => { const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4)); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };

/** Subscribes this browser to Web Push for the signed-in member (only once they have allowed notifications). Quietly does nothing elsewhere. */
export async function enablePush() {
  if (getDataSource().mode !== 'v2' || !supported() || Notification.permission !== 'granted') return false;
  try {
    const kr = await apiFetch('/v1/push/key');
    if (!kr.ok) return false;
    const { publicKey } = await kr.json();
    if (!publicKey) return false;                                         // this server sends no Web Push
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    const key = keyBytes(publicKey);
    const same = sub?.options?.applicationServerKey && new Uint8Array(sub.options.applicationServerKey).every((b, i) => b === key[i]);
    if (sub && !same) { await sub.unsubscribe(); sub = null; }            // the server's key changed: subscribe again with the new one
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const res = await apiFetch('/v1/push/subscriptions', { method: 'POST', body: JSON.stringify(sub.toJSON()) });
    return res.ok;
  } catch { return false; }
}

/** At sign-out: this browser stops getting the member's notifications (on the server and in the browser). Call before the token is dropped. */
export async function disablePush() {
  if (getDataSource().mode !== 'v2' || !supported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    await apiFetch(`/v1/push/subscriptions?endpoint=${encodeURIComponent(sub.endpoint)}`, { method: 'DELETE' }).catch(() => {});
    await sub.unsubscribe();
  } catch { /* nothing to undo */ }
}
