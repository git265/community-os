import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { listMine, markRead, markAllRead, NOTIFICATIONS } from '../../lib/notifications.js';
import { EVENTS, CHANNELS, chKey, eventLabel, getMyPrefs, saveMyPrefs, getSettings, saveSettings } from '../../lib/notify.js';
import { ICON } from '../../components/NotificationBell.jsx';
import { ApprovalButtons } from '../../components/GateApproval.jsx';
import { loadRoles } from '../../lib/access/roleStore.js';
import { canReadCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import { fmtDateTime } from '../../lib/locale.js';

const when = (iso) => fmtDateTime(iso);

function Inbox({ onNavigate }) {
  const [items, setItems] = useState([]);
  const [kind, setKind] = useState('');
  const [onlyUnread, setOnlyUnread] = useState(false);
  const load = useCallback(async () => setItems(await listMine()), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => () => { markAllRead(); }, []); // having looked at the list counts as read
  useEffect(() => { const h = (e) => { if (!e.detail?.collection || e.detail.collection === NOTIFICATIONS) load(); }; window.addEventListener('communityos:changed', h); window.addEventListener('communityos:notify', load); return () => { window.removeEventListener('communityos:changed', h); window.removeEventListener('communityos:notify', load); }; }, [load]);
  const kinds = [...new Set(items.map((n) => n.event || n.kind))];
  const shown = items.filter((n) => (!kind || (n.event || n.kind) === kind) && (!onlyUnread || !n.read));
  return (
    <div data-testid="notif-inbox">
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <select aria-label="Type" value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 'auto' }}><option value="">All types</option>{kinds.map((k) => <option key={k} value={k}>{eventLabel(k)}</option>)}</select>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={onlyUnread} onChange={(e) => setOnlyUnread(e.target.checked)} /> Unread only</label>
        <button type="button" className="btn secondary sm" style={{ marginLeft: 'auto' }} onClick={markAllRead}>Mark all read</button>
      </div>
      {shown.length === 0 && <div className="empty">No notifications{kind || onlyUnread ? ' match these filters' : ' yet'}. You are told here when something needs your attention.</div>}
      <ul className="list">
        {shown.map((n) => (
          <li key={n.id} style={{ cursor: 'pointer', alignItems: 'flex-start', opacity: n.read ? 0.7 : 1 }} onClick={async () => { await markRead(n.id); if (n.link) onNavigate?.(n.link); }}>
            {n.image ? <img className="gg-notif-img" src={n.image} alt="" style={{ marginRight: 10 }} data-testid="inbox-photo" /> : <span style={{ fontSize: 20, marginRight: 8 }}>{ICON[n.event] || ICON[n.kind] || '🔔'}</span>}
            <span style={{ flex: 1 }}><b>{n.title}</b>{!n.read && <span className="tag blue" style={{ marginLeft: 6 }}>New</span>}<br /><small>{n.body}</small><br /><small className="muted">{when(n.createdAt)}{n.by ? ` · by ${n.by}` : ''}</small>{n.kind === 'gate_approval' && n.approvalId && <ApprovalButtons approvalId={n.approvalId} />}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MyChannels() {
  const { currentUser } = useApp();
  const [prefs, setPrefs] = useState({ whatsapp: false, sms: false, email: false });
  const [offered, setOffered] = useState({});
  const [saved, setSaved] = useState('');
  useEffect(() => { (async () => { setPrefs(await getMyPrefs(currentUser.name)); setOffered(await getSettings()); })(); }, [currentUser.name]);
  const set = async (c, v) => { const next = { ...prefs, [chKey(c)]: v }; setPrefs(next); await saveMyPrefs(currentUser.name, next); setSaved('Saved'); setTimeout(() => setSaved(''), 1500); };
  const allOff = (c) => EVENTS.every((e) => offered[e.id]?.[chKey(c)] === false);
  return (
    <div data-testid="notif-prefs">
      <p className="muted" style={{ marginTop: 0 }}>The app is always on — you will always see notifications in the bell and in this list. Choose any extra channels you also want. Messages go to the phone number / e-mail on your portal profile.</p>
      <div className="card" style={{ marginBottom: 10 }}>
        <label style={{ display: 'flex', gap: 10, alignItems: 'center' }}><input type="checkbox" checked disabled /> <b>🔔 App</b> <span className="tag green">Always on · default</span></label>
      </div>
      {CHANNELS.map((c) => (
        <div className="card" key={c} style={{ marginBottom: 10 }}>
          <label style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input type="checkbox" aria-label={`Also notify me by ${c}`} data-testid={`pref-${chKey(c)}`} checked={!!prefs[chKey(c)]} disabled={allOff(c)} onChange={(e) => set(c, e.target.checked)} />
            <b>{{ WhatsApp: '💬', SMS: '📱', Email: '✉️' }[c]} {c}</b>
            <small className="muted">{c === 'Email' ? (currentUser.email || 'no e-mail on your profile yet') : (currentUser.phone || 'no phone on your profile yet')}</small>
            {allOff(c) && <span className="tag">Not offered by the community</span>}
          </label>
        </div>
      ))}
      {saved && <div className="notice">{saved}</div>}
      <div className="muted" style={{ fontSize: 12 }}>Demo build: WhatsApp / SMS / e-mail messages are queued in the Delivery log but not actually sent until a messaging gateway is connected.</div>
    </div>
  );
}

function ChannelSettings() {
  const [events, setEvents] = useState({});
  const [saved, setSaved] = useState('');
  const [roles, setRoles] = useState([]);
  useEffect(() => { getSettings().then(setEvents); loadRoles().then((r) => setRoles(r.filter((x) => x.id !== 'super_admin'))); }, []);
  const also = (e) => events[e]?.alsoRoles || [];
  const setAlso = async (e, list) => {
    const next = { ...events, [e]: { ...(events[e] || {}), alsoRoles: list } };
    setEvents(next); await saveSettings(next); setSaved('Saved'); setTimeout(() => setSaved(''), 1500);
  };
  const on = (e, c) => events[e]?.[chKey(c)] !== false;
  const toggle = async (e, c) => {
    const cur = events[e] || {};
    const next = { ...events, [e]: { ...cur, [chKey(c)]: !on(e, c) } };
    setEvents(next); await saveSettings(next); setSaved('Saved'); setTimeout(() => setSaved(''), 1500);
  };
  return (
    <div data-testid="notif-settings">
      <p className="muted" style={{ marginTop: 0 }}>The app is always used. Choose which extra channels people may opt in to for each kind of notification. Switching one off stops those messages for everyone. “Also tell” adds roles to a notification's audience on top of the people it is already addressed to.</p>
      <table className="table">
        <thead><tr><th>Notification</th><th>🔔 App</th>{CHANNELS.map((c) => <th key={c}>{c}</th>)}<th>Also tell (roles)</th></tr></thead>
        <tbody>
          {EVENTS.map((e) => (
            <tr key={e.id}><td data-label="Notification"><b>{e.label}</b><br /><small className="muted">{e.group}</small></td><td data-label="App"><input type="checkbox" checked disabled /></td>
              {CHANNELS.map((c) => <td key={c} data-label={c}><input type="checkbox" aria-label={`${e.label} by ${c}`} checked={on(e.id, c)} onChange={() => toggle(e.id, c)} /></td>)}
              <td data-label="Also tell">
                {also(e.id).map((r) => <span key={r} className="chip-btn on" style={{ marginRight: 4 }}>{roles.find((x) => x.id === r)?.name || r} <button type="button" aria-label={`Remove ${r}`} onClick={() => setAlso(e.id, also(e.id).filter((x) => x !== r))} style={{ border: 0, background: 'none', cursor: 'pointer' }}>×</button></span>)}
                <select aria-label={`Also tell for ${e.label}`} data-testid={`also-${e.id}`} value="" onChange={(ev) => { if (ev.target.value) setAlso(e.id, [...also(e.id), ev.target.value]); }}><option value="">+ add role</option>{roles.filter((r) => !also(e.id).includes(r.id)).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
              </td></tr>
          ))}
        </tbody>
      </table>
      {saved && <div className="notice">{saved}</div>}
    </div>
  );
}

function DeliveryLog() {
  const { records } = useCollection(COLLECTIONS.NOTIFICATION_OUTBOX, 'Notification Outbox');
  const [ch, setCh] = useState('');
  const rows = useMemo(() => [...records].filter((r) => !ch || r.channel === ch).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))), [records, ch]);
  return (
    <div data-testid="notif-log">
      <div style={{ marginBottom: 10 }}><select aria-label="Channel" value={ch} onChange={(e) => setCh(e.target.value)} style={{ width: 'auto' }}><option value="">All channels</option>{CHANNELS.map((c) => <option key={c}>{c}</option>)}</select> <small className="muted">{rows.length} message{rows.length === 1 ? '' : 's'}</small></div>
      {rows.length === 0 ? <div className="empty">Nothing queued yet. Messages appear here when someone has chosen WhatsApp, SMS or e-mail.</div> : (
        <table className="table"><thead><tr><th>When</th><th>Channel</th><th>To</th><th>Message</th><th>Status</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id}><td data-label="When">{when(r.createdAt)}</td><td data-label="Channel">{r.channel}</td><td data-label="To">{r.toName ? `${r.toName} · ` : ''}{r.to || '—'}</td><td data-label="Message"><b>{r.subject}</b><br /><small>{r.body}</small></td><td data-label="Status"><small>{r.status}</small></td></tr>)}</tbody></table>
      )}
    </div>
  );
}

/** Notification centre: everything addressed to me, my channels, and (management) channel settings + the delivery log. */
export default function NotificationsModule({ onNavigate }) {
  const [tab, setTab] = useState('inbox');
  const { tabAllowed } = useApp();
  const p = getPrincipal();
  const admin = canReadCollection(COLLECTIONS.NOTIFICATION_OUTBOX, p);
  const tabs = [['inbox', '🔔 My notifications'], ['prefs', 'My channels'], ...(admin ? [['settings', 'Channel settings'], ['log', 'Delivery log']] : [])].filter(([k]) => !tabAllowed || tabAllowed(`notif.${k}`));
  const cur = tabs.find(([k]) => k === tab) ? tab : tabs[0]?.[0];
  const open = (link) => { window.location.hash = link; window.dispatchEvent(new CustomEvent('communityos:openlink', { detail: { link } })); };
  return (
    <div>
      <div className="page-head"><div><h1>Notifications</h1><p>Everything you have been told, and how you want to be reached. The app is always on; WhatsApp, SMS and e-mail are optional extras.</p></div></div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>{tabs.map(([k, l]) => <button key={k} type="button" data-testid={`ntab-${k}`} className={`chip-btn${cur === k ? ' on' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div>
      <div className="card">
        {cur === 'inbox' && <Inbox onNavigate={open} />}
        {cur === 'prefs' && <MyChannels />}
        {cur === 'settings' && admin && <ChannelSettings />}
        {cur === 'log' && admin && <DeliveryLog />}
      </div>
    </div>
  );
}
