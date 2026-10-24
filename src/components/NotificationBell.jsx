import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { listMine, markRead, markAllRead, NOTIFICATIONS } from '../lib/notifications.js';
import { getDataSource } from '../lib/storage/dataSource.js';
import { apiFetch } from '../lib/net/request.js';
import { startLive, isLive, enablePush, alertsSetup } from '../lib/push.js';
import { ApprovalButtons } from './GateApproval.jsx';

export const ICON = { gate: '🚪', gate_approval: '🚪', amenity: '🏊', assigned: '📌', status: '🔁', decision: '✅', bill: '🧾', announcement: '📣', ballot: '🗳', meeting: '📅', shift: '🕒', forum_topic: '💬', forum_reply: '💬', poll: '📊', ballot_result: '🗳', ballot_reminder: '🗳', ticket_chat: '💬', ticket_new: '🆕', payment_made: '💳' };
const ago = (iso) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 1 ? 'now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
};

// "Not now" on the alerts card: asked again after 30 days, on this device only (a convenience - a private window just asks again)
const ASK_KEY = 'communityos:alertsAsk';
const askedLately = () => { try { return Date.now() - Number(localStorage.getItem(ASK_KEY) || 0) < 30 * 864e5; } catch { return false; } };
const snooze = () => { try { localStorage.setItem(ASK_KEY, String(Date.now())); } catch { /* blocked storage: asked again next visit */ } };

/**
 * Bell + panel + phone-style push banner. `onOpen(link)` navigates to the deep link (opens that exact ticket).
 * A "push" is simulated three ways: the in-app banner (what a phone shows), the bell list (notification centre),
 * and - if the browser permits - a real OS notification whose click runs the same deep link.
 */
export default function NotificationBell({ onOpen, onViewAll }) {
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [banner, setBanner] = useState(null);
  const [perm, setPerm] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const [setup, setSetup] = useState(null);       // the one-time card: turn alerts on here, or (iPhone in Safari) add the app to the Home Screen
  const timer = useRef();
  const wrap = useRef(null);
  const itemsRef = useRef([]);
  useEffect(() => { itemsRef.current = items; }, [items]);

  const load = useCallback(async () => { setItems(await listMine()); }, []);
  useEffect(() => { load(); }, [load]);
  // On the v2 back end other people's actions reach this inbox on the server. The server PUSHES each one to the open app over a live stream
  // (lib/push.js); after a reconnect the list is read again to catch up. Only while the stream is down does the bell ask for the unread
  // COUNT now and then (one number), fetching the list again only when it changed. Closed apps get Web Push through the service worker.
  useEffect(() => {
    if (getDataSource().mode !== 'v2') return undefined;
    let first = true;
    const stop = startLive({ onReconnect: () => { if (first) first = false; else load(); } });
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') enablePush();
    const fromWorker = (e) => { if (e.data?.type === 'communityos:open') onOpen(e.data.link); };   // a push notification was tapped
    navigator.serviceWorker?.addEventListener('message', fromWorker);
    return () => { stop(); navigator.serviceWorker?.removeEventListener('message', fromWorker); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);
  useEffect(() => {
    const s = alertsSetup();
    if (!s || askedLately()) return undefined;
    const t = setTimeout(() => setSetup(alertsSetup()), 3000);    // after the first screen has settled
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (getDataSource().mode !== 'v2') return undefined;
    let on = true;
    const tick = async (force) => {
      if (isLive() && force !== true) return;
      try {
        const res = await apiFetch('/v1/notifications/unread-count');
        if (!res.ok) return;
        const { count } = await res.json();
        if (on && count !== itemsRef.current.filter((n) => !n.read).length) load();
      } catch { /* offline: try again next time */ }
    };
    const t = setInterval(tick, 30000);
    const vis = () => { if (document.visibilityState === 'visible') tick(true); };
    document.addEventListener('visibilitychange', vis);
    return () => { on = false; clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, [load]);
  useEffect(() => {
    const changed = (e) => { if (!e.detail?.collection || e.detail.collection === NOTIFICATIONS) load(); };
    const pushed = async (e) => {
      const mine = await listMine();
      setItems(mine);
      const n = e.detail?.notification;
      if (!n || !mine.some((x) => x.id === n.id)) return; // addressed to someone else (other device / other login)
      setBanner(n);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setBanner(null), 7000);
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          const os = new Notification(n.title, { body: n.body, tag: n.id, data: { url: n.link }, icon: '/icons/icon-192.png' });
          os.onclick = () => { window.focus(); go(n); };
        } catch { /* some mobile browsers only allow service-worker notifications */ }
      }
    };
    window.addEventListener('communityos:changed', changed);
    window.addEventListener('communityos:notify', pushed);
    return () => { window.removeEventListener('communityos:changed', changed); window.removeEventListener('communityos:notify', pushed); clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const unread = items.filter((n) => !n.read).length;
  // Seeing the list counts as reading it: close the panel (button, outside click, Esc) and everything that was shown is marked read.
  const closePanel = useCallback(() => {
    setOpen(false);
    if (itemsRef.current.some((n) => !n.read)) markAllRead();
  }, []);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (wrap.current && !wrap.current.contains(e.target)) closePanel(); };
    const esc = (e) => { if (e.key === 'Escape') closePanel(); };
    document.addEventListener('mousedown', away); document.addEventListener('touchstart', away, { passive: true }); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('touchstart', away); document.removeEventListener('keydown', esc); };
  }, [open, closePanel]);
  async function go(n) {
    setOpen(false); setBanner(null);
    await markRead(n.id);
    onOpen(n.link);
  }
  async function enable() {
    if (typeof Notification === 'undefined') return;
    const p = await Notification.requestPermission();
    setPerm(p); setSetup(null);
    if (p === 'granted') enablePush();                 // and on this device when the app is closed (v2: Web Push)
    else snooze();
  }
  const later = () => { snooze(); setSetup(null); };
  const homeScreen = alertsSetup() === 'home-screen';

  return (
    <>
      <div className="bell-wrap" ref={wrap}>
        <button type="button" className="bell" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} onClick={() => (open ? closePanel() : setOpen(true))}>
          <span className="bell-emo">🔔</span><svg className="bell-svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8" /><path d="M10 20a2 2 0 0 0 4 0" /></svg>{unread > 0 && <span className="bell-badge">{unread}</span>}
        </button>
        {open && (
          <div className="bell-panel" role="dialog" aria-label="Notifications">
            <div className="bell-head">
              <b>Notifications</b>
              {unread > 0 && <button type="button" className="link-btn" onClick={markAllRead}>Mark all read</button>}
              {onViewAll && <button type="button" className="link-btn" data-testid="bell-all" onClick={() => { closePanel(); onViewAll(); }}>View all</button>}
            </div>
            {perm === 'default' && <div className="bell-perm">Get alerts outside this tab too. <button type="button" className="link-btn" onClick={enable}>Enable browser alerts</button></div>}
            {perm === 'denied' && <div className="bell-perm muted">Browser alerts are blocked for this site. Allow notifications in the browser's site settings to get them.</div>}
            {homeScreen && <div className="bell-perm" data-testid="bell-home-screen">On iPhone, alerts come to the Home Screen app: in Safari tap Share, then Add to Home Screen, and open it from there.</div>}
            {items.length === 0 && <div className="empty" style={{ padding: 16 }}>Nothing yet. You are told when a task is assigned to you or your ticket changes status.</div>}
            <ul className="bell-list">
              {items.map((n) => (
                <li key={n.id}>
                  <button type="button" className={n.read ? '' : 'unread'} onClick={() => go(n)}>
                    {n.image ? <img className="gg-notif-img" src={n.image} alt="" data-testid="notif-photo" /> : <span className="bell-ico">{ICON[n.kind] || '🔁'}</span>}
                    <span className="bell-txt"><b>{n.title}</b><small>{n.body}</small><small className="muted">{ago(n.createdAt)}{n.ticketNumber ? ` · opens ${n.ticketNumber}` : ''}</small></span>
                  </button>
                  {n.kind === 'gate_approval' && n.approvalId && <div style={{ padding: '0 12px 8px 76px' }}><ApprovalButtons approvalId={n.approvalId} compact /></div>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {setup && !banner && createPortal(
        <div className="alerts-ask" role="dialog" aria-label="Alerts on this device" data-testid="alerts-ask">
          <span className="alerts-ask-ico" aria-hidden="true">🔔</span>
          <div className="alerts-ask-txt">
            {setup === 'ask'
              ? <><b>Get alerts on this device</b><small>Even when the app is closed: ticket updates, bills, guests at the gate.</small></>
              : <><b>Get alerts on your iPhone</b><small>Add this app to your Home Screen: in Safari tap Share, then Add to Home Screen. Open it from there and turn alerts on.</small></>}
          </div>
          <div className="alerts-ask-btns">
            {setup === 'ask' && <button type="button" className="btn sm" data-testid="alerts-on" onClick={enable}>Turn on</button>}
            <button type="button" className="btn secondary sm" data-testid="alerts-later" onClick={later}>{setup === 'ask' ? 'Not now' : 'Got it'}</button>
          </div>
        </div>, document.body)}
      {banner && (
        <button type="button" className="push-banner" onClick={() => go(banner)} role="alert">
          <span className="push-app">⌂ CommunityOS · now</span>
          {banner.image && <img className="gg-notif-img" src={banner.image} alt="" data-testid="banner-photo" style={{ width: 72, height: 72 }} />}
          <b>{banner.title}</b>
          <span>{banner.body}</span>
        </button>
      )}
    </>
  );
}
