import React, { useCallback, useEffect, useRef, useState } from 'react';
import { listMine, markRead, markAllRead, NOTIFICATIONS } from '../lib/notifications.js';
import { ApprovalButtons } from './GateApproval.jsx';

export const ICON = { gate: '🚪', gate_approval: '🚪', amenity: '🏊', assigned: '📌', status: '🔁', decision: '✅', bill: '🧾', announcement: '📣', ballot: '🗳', meeting: '📅', shift: '🕒', forum_topic: '💬', forum_reply: '💬', poll: '📊', ballot_result: '🗳', ballot_reminder: '🗳', ticket_chat: '💬', ticket_new: '🆕', payment_made: '💳' };
const ago = (iso) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 1 ? 'now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
};

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
  const timer = useRef();
  const wrap = useRef(null);
  const itemsRef = useRef([]);
  useEffect(() => { itemsRef.current = items; }, [items]);

  const load = useCallback(async () => { setItems(await listMine()); }, []);
  useEffect(() => { load(); }, [load]);
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
          const os = new Notification(n.title, { body: n.body, tag: n.id, data: { url: n.link } });
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
    setPerm(await Notification.requestPermission());
  }

  return (
    <>
      <div className="bell-wrap" ref={wrap}>
        <button type="button" className="bell" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} onClick={() => (open ? closePanel() : setOpen(true))}>
          🔔{unread > 0 && <span className="bell-badge">{unread}</span>}
        </button>
        {open && (
          <div className="bell-panel" role="dialog" aria-label="Notifications">
            <div className="bell-head">
              <b>Notifications</b>
              {unread > 0 && <button type="button" className="link-btn" onClick={markAllRead}>Mark all read</button>}
              {onViewAll && <button type="button" className="link-btn" data-testid="bell-all" onClick={() => { closePanel(); onViewAll(); }}>View all</button>}
            </div>
            {perm === 'default' && <div className="bell-perm">Get alerts outside this tab too. <button type="button" className="link-btn" onClick={enable}>Enable browser alerts</button></div>}
            {perm === 'denied' && <div className="bell-perm muted">Browser alerts are blocked for this site.</div>}
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
