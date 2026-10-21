// CommunityOS service worker: shows Web Push messages while the app is closed, and opens the app on the right page when one is tapped.
// The message is encrypted for this browser by the server (RFC 8291); the browser has already decrypted it when `push` fires.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { body: e.data ? e.data.text() : '' }; }
  // tag = the notification's id: the open app shows the same one with the same tag, so a person never sees it twice
  e.waitUntil(self.registration.showNotification(m.title || 'CommunityOS', { body: m.body || '', tag: m.tag || undefined, data: { link: m.link || '' } }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const link = (e.notification.data && e.notification.data.link) || '';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((tabs) => {
    const tab = tabs.find((t) => 'focus' in t);
    if (tab) { tab.postMessage({ type: 'communityos:open', link }); return tab.focus(); }
    return self.clients.openWindow(`/${link}`);
  }));
});
