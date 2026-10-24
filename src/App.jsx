import React, { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { AppProvider, useApp, useCollection } from './context/AppContext.jsx';
import { COLLECTIONS } from './lib/storage/index.js';
import { runAmenityScheduler } from './lib/amenityServer.js';
import { runDueReminders } from './lib/dueReminders.js';
import { runAutoItc } from './lib/finance/itc.js';
import { startInlineErrors } from './lib/inlineErrors.js';
import { runBallotReminders, runSlaAlerts } from './lib/notifyExtra.js';
import { runPlannedReminders } from './lib/plannedWorks.js';
import { runReportSchedules } from './lib/reports/run.js';
import { runRecurringBills, runAutoLateFees } from './lib/finance/rules.js';
import { pageOpen } from './lib/access/tabs.js';
import { ensureUtilityTypes } from './lib/utilityTypes.js';
import { serverDecides } from './lib/auth/session.js';
import { getCommunity, communityUrl, PLATFORM } from './lib/community.js';
import { membershipsFor, setHandoff } from './lib/platform/registry.js';
import LoginScreen from './components/LoginScreen.jsx';
import Modal from './components/Modal.jsx';
import NotificationBell from './components/NotificationBell.jsx';
import ActivityBar from './components/ActivityBar.jsx';
import { installActivity } from './lib/net/activity.js';
import TruncatedNotice from './components/TruncatedNotice.jsx';
import GlobalSearch from './components/GlobalSearch.jsx';
import ClockCard from './components/ClockCard.jsx';
import { isClockRole } from './lib/attendance.js';
import { useDuty, ClockGate, OnDutyBar } from './components/DutyGate.jsx';
import { storageOverflowed } from './lib/storage/SessionStorageAdapter.js';
import { show as dataSourceShown } from './components/DataSourcePanel.jsx';
import { getDataSource } from './lib/storage/dataSource.js';
import { getLayout, setLayout, applyLayout } from './lib/layoutPref.js';
import { installSaveFeedback } from './lib/saveFeedback.js';
import { utilitiesVisible, plantVisible } from './lib/access/visibility.js';
import { validatePhone } from './lib/phone.js';

/** Each page is its own chunk: it downloads the first time someone opens it, so the first screen only carries the shell. */
const lazyPage = (load) => { const C = lazy(load); C.preload = load; return C; };
const PlatformApp = lazyPage(() => import('./modules/platform/PlatformApp.jsx'));
const ReportsModule = lazyPage(() => import('./modules/reports/ReportsModule.jsx'));
const DashboardModule = lazyPage(() => import('./modules/dashboard/DashboardModule.jsx'));
const PropertiesModule = lazyPage(() => import('./modules/properties/PropertiesModule.jsx'));
const TicketsModule = lazyPage(() => import('./modules/tickets/TicketsModule.jsx'));
const BillingModule = lazyPage(() => import('./modules/billing/BillingModule.jsx'));
const AmenitiesModule = lazyPage(() => import('./modules/amenities/AmenitiesModule.jsx'));
const WorkforceModule = lazyPage(() => import('./modules/workforce/WorkforceModule.jsx'));
const CalendarModule = lazyPage(() => import('./modules/calendar/CalendarModule.jsx'));
const NotificationsModule = lazyPage(() => import('./modules/notifications/NotificationsModule.jsx'));
const CulturalModule = lazyPage(() => import('./modules/cultural/CulturalModule.jsx'));
const SecurityModule = lazyPage(() => import('./modules/gate/GateModule.jsx'));
const MyGate = lazyPage(() => import('./modules/gate/MyGate.jsx'));
const VendorsModule = lazyPage(() => import('./modules/vendors/VendorsModule.jsx'));
const CommunicationsModule = lazyPage(() => import('./modules/communications/CommunicationsModule.jsx'));
const GovernanceModule = lazyPage(() => import('./modules/governance/GovernanceModule.jsx'));
const DocumentsModule = lazyPage(() => import('./modules/documents/DocumentsModule.jsx'));
const StudioModule = lazyPage(() => import('./modules/studio/StudioModule.jsx'));
const SetupModule = lazyPage(() => import('./modules/setup/SetupModule.jsx'));
const RolesModule = lazyPage(() => import('./modules/roles/RolesModule.jsx'));
const UsersModule = lazyPage(() => import('./modules/users/UsersModule.jsx'));
const AuditModule = lazyPage(() => import('./modules/audit/AuditModule.jsx'));
const AuditsModule = lazyPage(() => import('./modules/audits/AuditsModule.jsx'));
const DirectoryModule = lazyPage(() => import('./modules/directory/DirectoryModule.jsx'));
const SiteMap = lazyPage(() => import('./modules/infra/SiteMap.jsx'));
const UtilitiesPlant = lazyPage(() => import('./modules/utilities/UtilitiesPlant.jsx'));

const isHandyman = (role) => !!role?.id?.startsWith('handyman_');

// Each item's `visible` decides nav inclusion for the current role - this is
// where "handymen see only Tickets" and "owners never see Accounting/
// Security" are enforced, alongside the 17-permission model.
const NAV_GROUPS = [
  {
    key: 'home', label: 'Overview', short: 'Home', icon: '▦',
    items: [
      { id: 'dashboard', label: 'Command Center', icon: '▦', Component: DashboardModule, visible: (role) => !isHandyman(role) },
      { id: 'tickets', label: 'Maintenance', icon: '◉', Component: TicketsModule, visible: () => true },
    ],
  },
  {
    key: 'ops', label: 'Operations', short: 'Operations', icon: '₹',
    items: [
      { id: 'billing', label: 'Billing & Finance', icon: '₹', Component: BillingModule, visible: (role) => !isHandyman(role) },
      { id: 'utilities', label: 'Utilities & Assets', icon: '💧', Component: UtilitiesPlant, pages: ['utilities', 'assets'], visible: (role, has) => utilitiesVisible(role, has) || plantVisible(role) },
      { id: 'sitemap', label: 'Site map', icon: '🗺', Component: SiteMap, visible: (role) => role.category !== 'Resident' && role.category !== 'Vendor' },
      { id: 'reports', label: 'Reports', icon: '📊', Component: ReportsModule, visible: (role, has) => role.category === 'EC' || role.id === 'facility_manager' || has('MANAGE_NOTIFICATIONS') },
      { id: 'audits', label: 'Audits', icon: '✔', Component: AuditsModule, visible: (role) => !isHandyman(role) },
      { id: 'amenities', label: 'Amenities', icon: '▣', Component: AmenitiesModule, visible: (role) => !isHandyman(role) },
      { id: 'mygate', label: 'My Gate', icon: '🚪', Component: MyGate, visible: (role, has, me) => role.category === 'Resident' || !!me?.unit },   // an owner on the committee has a gate too
      { id: 'vendors', label: 'Vendors', icon: '♙', Component: VendorsModule, visible: (role, has) => has('MANAGE_VENDORS') },
    ],
  },
  {
    key: 'security', label: 'Security', short: 'Security', icon: '◇',
    items: [
      { id: 'security', label: 'Security & Visitors', icon: '◇', Component: SecurityModule, visible: (role, has) => role.category !== 'Resident' && (has('MANAGE_SECURITY') || role.category === 'EC' || role.id === 'facility_manager') },
      { id: 'shifts', label: 'Workforce', icon: '🕒', Component: WorkforceModule, visible: (role) => role.category !== 'Resident' },
    ],
  },
  {
    key: 'community', label: 'Community', short: 'Community', icon: '🎭',
    items: [
      { id: 'properties', label: 'Unit Directory', icon: '⌂', Component: PropertiesModule, visible: (role) => !isHandyman(role) },
      { id: 'calendar', label: 'Calendar', icon: '📅', Component: CalendarModule, visible: () => true },
      { id: 'directory', label: 'Service directory', icon: '☎', Component: DirectoryModule, visible: (role) => !isHandyman(role) },
      { id: 'cultural', label: 'Cultural', icon: '🎭', Component: CulturalModule, visible: (role) => !isHandyman(role) },
      { id: 'communications', label: 'Communications', icon: '✉', Component: CommunicationsModule, visible: (role) => !isHandyman(role) },
      { id: 'governance', label: 'Governance', icon: '⚖', Component: GovernanceModule, visible: (role) => !isHandyman(role) },
      { id: 'documents', label: 'Documents', icon: '▤', Component: DocumentsModule, visible: (role) => !isHandyman(role) },
      { id: 'notifications', label: 'Notifications', icon: '🔔', Component: NotificationsModule, visible: () => true, hidden: true },
    ],
  },
  {
    key: 'admin', label: 'Administration', short: 'Admin', icon: '⚙',
    items: [
      { id: 'users', label: 'Users', icon: '👤', Component: UsersModule, visible: (role, has) => has('MANAGE_USERS') },
      { id: 'setup', label: 'Community setup', icon: '🏘', Component: SetupModule, visible: (role, has) => role.id === 'super_admin' || has('MANAGE_UNITS') || has('MANAGE_AMENITIES') },
      { id: 'roles', label: 'Roles & Permissions', icon: '🛡', Component: RolesModule, visible: (role, has) => has('MANAGE_ROLES') },
      { id: 'studio', label: 'No-code Studio', icon: '⚙', Component: StudioModule, visible: (role, has) => has('MANAGE_ROLES') },
      { id: 'audit', label: 'Audit Trail', icon: '◷', Component: AuditModule, visible: (role, has) => has('VIEW_AUDIT_LOG') },
    ],
  },
];

const SELF_FIELDS = [['altPhone', 'Alternate phone', 'tel', '+91 90000 00000'], ['emergencyName', 'Emergency contact name', 'text', ''], ['emergencyPhone', 'Emergency contact phone', 'tel', '+91 90000 00000'], ['vehicles', 'Vehicle numbers', 'text', 'KA 01 AB 1234, KA 05 CD 5678']];
const LANGS = ['English', 'Hindi', 'Telugu', 'Kannada', 'Tamil', 'Malayalam', 'Marathi', 'Other'];

/** Identity details (name, phone, e-mail, role, villa) are managed by the Super Admin; everything else about you is yours to keep up to date. */
function ProfileModal({ onClose }) {
  const { currentUser, updateProfile, role } = useApp();
  const admin = currentUser?.roleId === 'super_admin';
  const [name, setName] = useState(currentUser?.name ?? '');
  const [phone, setPhone] = useState(currentUser?.phone ?? '');
  const [nameErr, setNameErr] = useState('');
  const { records: profiles, save: saveProfile } = useCollection(COLLECTIONS.USER_PROFILES, 'My profile details');
  const mine = profiles.find((x) => String(x.userName || '').trim().toLowerCase() === String(currentUser?.name || '').trim().toLowerCase());
  const [edits, setEdits] = useState({});
  const [err, setErr] = useState('');
  const val = (k) => edits[k] ?? mine?.[k] ?? '';
  const set = (k, v) => { setEdits((e) => ({ ...e, [k]: v })); setErr(''); };
  const Locked = ({ label, value }) => <div className="field"><label>{label} <span title="Managed by the Super Admin" aria-hidden="true">🔒</span></label><input aria-label={label} value={value || '—'} readOnly disabled /></div>;
  async function save() {
    if (admin && !name.trim()) return setNameErr('Name is required');
    if (admin && String(phone || '').trim() && String(phone).trim() !== String(currentUser?.phone || '').trim()) { const v = validatePhone(phone); if (!v.ok) return setErr(`Phone: ${v.error}`); }
    for (const [k, label] of [['altPhone', 'Alternate phone'], ['emergencyPhone', 'Emergency phone']]) {
      if (String(val(k) || '').trim() && String(val(k)).trim() !== String(mine?.[k] || '').trim()) { const v = validatePhone(val(k)); if (!v.ok) return setErr(`${label}: ${v.error}`); }
    }
    if (Object.keys(edits).length) {
      const rec = { ...(mine || {}), userName: currentUser.name, ...Object.fromEntries(SELF_FIELDS.map(([k]) => [k, String(val(k)).trim()])), language: val('language') };
      const ok = await saveProfile(rec);
      if (!ok) return undefined;
    }
    if (admin) updateProfile({ name: name.trim(), phone: String(phone || '').trim() });
    onClose(); return undefined;
  }
  return (
    <Modal title="My profile" subtitle="Keep your own details up to date. The locked ones are managed by the Super Admin or the office; ask them to change those." onClose={onClose}>
      <div className="form-grid" data-testid="profile-form">
        {admin ? (
          <>
            <div className={`field${nameErr ? ' invalid' : ''}`}><label>Name *</label><input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />{nameErr && <div className="field-error">{nameErr}</div>}</div>
            <div className="field"><label>Phone</label><input aria-label="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 90000 00000" /></div>
          </>
        ) : (
          <>
            <Locked label="Name" value={currentUser?.name} />
            <Locked label="Phone" value={currentUser?.phone} />
          </>
        )}
        <Locked label="Role" value={role?.name || currentUser?.roleId} />
        {currentUser?.unit ? <Locked label="Villa / unit" value={currentUser.unit} /> : null}
        {currentUser?.email ? <Locked label="E-mail" value={currentUser.email} /> : null}
      </div>
      <h4 style={{ margin: '14px 0 6px' }}>Your details</h4>
      <div className="form-grid" data-testid="profile-self">
        {SELF_FIELDS.map(([k, label, type, ph]) => <div className="field" key={k}><label>{label}</label><input aria-label={label} data-testid={`pf-${k}`} type={type} value={val(k)} onChange={(e) => set(k, e.target.value)} placeholder={ph} /></div>)}
        <div className="field"><label>Preferred language</label><select aria-label="Preferred language" data-testid="pf-language" value={val('language') || 'English'} onChange={(e) => set('language', e.target.value)}>{LANGS.map((l) => <option key={l}>{l}</option>)}</select></div>
      </div>
      {err && <div className="field-error">{err}</div>}
      <div className="form-actions">
        <button className="btn" data-testid="profile-save" onClick={save}>Save</button>
        <button className="btn secondary" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

/**
 * The desktop header shows the open page's one-line description under its title. It is the first
 * paragraph of the page's own head (`.page-head`), read from the screen as the page draws it and kept
 * up to date; that paragraph is then marked `desc-moved` and hidden on a computer (phones keep it).
 */
function usePageDescription() {
  const [desc, setDesc] = useState('');
  useEffect(() => {
    let raf = 0;
    const read = () => {
      raf = 0;
      const head = document.querySelector('.app .content .page-head');
      const p = head?.querySelector(':scope > div > p, :scope > p');
      if (p && !p.classList.contains('desc-moved')) p.classList.add('desc-moved');
      setDesc((p?.textContent || '').replace(/\s+/g, ' ').trim());
    };
    const kick = () => { if (!raf) raf = requestAnimationFrame(read); };
    const mo = new MutationObserver(kick);
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    kick();
    return () => { mo.disconnect(); cancelAnimationFrame(raf); };
  }, []);
  return desc;
}

function Shell() {
  const { currentUser, role, roles, hasPermission, logout, ready, community } = useApp();
  const [otherCommunities, setOtherCommunities] = useState([]);
  // the same person (e-mail) in other communities, each with its own role: offered in the profile menu
  useEffect(() => startInlineErrors(), []);
  useEffect(() => {
    let on = true;
    membershipsFor(currentUser?.email, currentUser?.phone).then((m) => on && setOtherCommunities(m.filter((x) => x.community.slug !== getCommunity())));
    return () => { on = false; };
  }, [currentUser?.email, currentUser?.phone]);
  const [active, setActiveRaw] = useState('dashboard');
  const activeRef = React.useRef('dashboard');
  const setActive = useCallback((id) => {
    if (id === activeRef.current) return;
    const prev = activeRef.current;
    setTrail((t) => [...t.slice(-19), prev]);
    activeRef.current = id; setActiveRaw(id);
  }, []);
  const goBack = () => { setTrail((t) => { const prev = t[t.length - 1]; if (prev) { activeRef.current = prev; setActiveRaw(prev); setNavKey((k) => k + 1); } return t.slice(0, -1); }); };
  const [moreOpen, setMoreOpen] = useState(null); // group key whose pages are shown in the phone sheet
  const [navFind, setNavFind] = useState('');
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);
  // phone layout chosen by this person: Compact (rows, the default) or Comfortable (cards)
  const who = currentUser?.id || currentUser?.phone || currentUser?.name || '';
  const [layout, setLayoutState] = useState(() => getLayout(who));
  useEffect(() => { const v = getLayout(who); setLayoutState(v); applyLayout(v); }, [who]);
  const pickLayout = (v) => { setLayout(v, who); setLayoutState(v); };
  // the profile menu closes when you click or tap anywhere else, or press Esc
  useEffect(() => {
    if (!profileMenuOpen) return undefined;
    const away = (e) => { if (!e.target.closest?.('.profile-menu, .brand, .community, .avatar')) setProfileMenuOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setProfileMenuOpen(false); };
    document.addEventListener('mousedown', away); document.addEventListener('touchstart', away, { passive: true }); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('touchstart', away); document.removeEventListener('keydown', esc); };
  }, [profileMenuOpen]);
  const [toast, setToast] = useState('');
  const [spill, setSpill] = useState(() => storageOverflowed()); // the demo store ran out of browser space and holds a big collection in memory
  useEffect(() => { const f = () => setSpill(true); window.addEventListener('communityos:storage-overflow', f); return () => window.removeEventListener('communityos:storage-overflow', f); }, []);
  const [navKey, setNavKey] = useState(0);
  const pageDesc = usePageDescription();
  const [clockOpen, setClockOpen] = useState(false);
  const duty = useDuty();
  const [navUse, setNavUse] = useState(() => { try { return JSON.parse(localStorage.getItem(`communityos:navUse:${role?.id}`) || '{}'); } catch { return {}; } });
  useEffect(() => { try { setNavUse(JSON.parse(localStorage.getItem(`communityos:navUse:${role?.id}`) || '{}')); } catch { setNavUse({}); } }, [role?.id]);
  const [trail, setTrail] = useState([]); // pages visited before this one, for the back arrow

  /** Deep link (#/ticket/TKT-1055): go to Maintenance and open that ticket. Works from the bell, a push banner, or a pasted URL. */
  const openLink = useCallback((link) => {
    const am = /#?\/amenities\/([^/?]+)/.exec(link || '');
    if (am) {
      try { sessionStorage.setItem('communityos:openBooking', decodeURIComponent(am[1])); } catch { /* ignore */ }
      setActive('amenities'); setNavKey((k) => k + 1);
      return;
    }
    const set = (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } };
    const fm = /#?\/forum\/([^/?]+)/.exec(link || '');
    if (fm) { set('communityos:openTab', 'forum'); set('communityos:openTopic', decodeURIComponent(fm[1])); setActive('communications'); setNavKey((k) => k + 1); return; }
    const bm = /#?\/ballot\/([^/?]+)/.exec(link || '');
    if (bm) { set('communityos:openTab', 'evote'); setActive('communications'); setNavKey((k) => k + 1); return; }
    const cu = /#?\/cultural\/(expense|donation|event)\/([^/?]+)/.exec(link || '');   // an expense, a donation or an event: its event, on the right tab
    if (cu) { set('communityos:culturalOpen', JSON.stringify({ kind: cu[1], id: decodeURIComponent(cu[2]) })); setActive('cultural'); setNavKey((k) => k + 1); return; }
    const mp = /^#?\/map\b(\?.*)?$/.exec(link || '');
    if (mp) { set('communityos:mapLink', mp[1] || ''); setActive('sitemap'); setNavKey((k) => k + 1); return; }
    if (/^#?\/planned\b/.test(link || '')) { set('communityos:openTab', 'planned'); setActive('tickets'); setNavKey((k) => k + 1); return; }   // Maintenance → Planned works
    if (/^#?\/onsite\b/.test(link || '')) { set('communityos:openTab', 'live'); setActive('shifts'); setNavKey((k) => k + 1); return; }   // On site is part of Workforce now
    const pg = /^#?\/(governance|billing|communications|cultural|shifts|calendar|notifications|inventory|utilities|documents|audits|directory|security|mygate)\b/.exec(link || '');
    if (pg) { if (pg[1] === 'inventory') set('communityos:openSection', 'stores'); setActive(pg[1] === 'inventory' ? 'utilities' : pg[1]); setNavKey((k) => k + 1); return; }
    const m = /#?\/ticket\/([^/?]+)(\/chat)?/.exec(link || '');
    if (!m) return;
    set('communityos:openTicket', decodeURIComponent(m[1]));
    if (m[2]) set('communityos:openTicketTab', 'chat');
    if (window.location.hash !== `#/ticket/${m[1]}`) window.history.replaceState(null, '', `#/ticket/${m[1]}`);
    setActive('tickets');
    setNavKey((k) => k + 1);
  }, []);
  useEffect(() => { const h = (e) => openLink(e.detail?.link); window.addEventListener('communityos:openlink', h); return () => window.removeEventListener('communityos:openlink', h); }, [openLink]);
  // a link opened from outside (phone notification tap, shared URL): handle it once signed in
  useEffect(() => { if (ready && role && /#\/(ticket|forum|ballot)\/|#\/map\b/.test(window.location.hash)) openLink(window.location.hash); }, [ready, role, openLink]);

  // Amenity "cron": release unpaid bookings, reminders, daily/summary reports. Idempotent; runs on sign-in and every 5 minutes while open.
  useEffect(() => {
    if (!ready || !role) return undefined;
    if (serverDecides()) return undefined;   // with a back end that enforces sign-in these jobs run on the server (backend/api, config/Jobs.java), once, instead of in every open browser
    ensureUtilityTypes().catch(() => {});
    const run = () => (jobsRunning ||= runJobsOnce().finally(() => { jobsRunning = null; }));
    // in order (bills before late fees before reminders), but each job on its own: one failing job does not skip the rest
    const JOBS = [['amenities', runAmenityScheduler], ['recurring bills', runRecurringBills], ['late fees', runAutoLateFees], ['due reminders', runDueReminders], ['ballot reminders', runBallotReminders], ['ticket SLA alerts', runSlaAlerts], ['input credit', runAutoItc], ['report schedules', runReportSchedules], ['planned works', runPlannedReminders]];
    const runJobsOnce = async () => {
      for (const [name, job] of JOBS) {
        try { await job(); } catch (e) { console.warn(`Background job "${name}" failed:`, e?.name || 'Error', e?.status || e?.code || ''); } // no message: it can carry names or units
      }
      window.dispatchEvent(new CustomEvent('communityos:changed'));
    };
    const t0 = setTimeout(run, 1500); const iv = setInterval(run, 5 * 60 * 1000);
    return () => { clearTimeout(t0); clearInterval(iv); };
  }, [ready, role]);

  // Authorization denials from the secure storage layer surface here.
  useEffect(() => {
    let t;
    installActivity();
    installSaveFeedback();
    const onDenied = (e) => { setToast({ text: e.detail?.message || 'Not permitted', kind: e.detail?.kind || 'denied' }); clearTimeout(t); t = setTimeout(() => setToast(''), e.detail?.kind === 'success' ? 3200 : e.detail?.kind && e.detail.kind !== 'denied' ? 7000 : 4500); };
    window.addEventListener('communityos:denied', onDenied);
    return () => { window.removeEventListener('communityos:denied', onDenied); clearTimeout(t); };
  }, []);

  if (!ready || !role) return <div className="empty">Loading…</div>;

  const visibleGroups = NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((n) => n.visible(role, hasPermission, currentUser) && (n.pages ? n.pages.some((pg) => pageOpen(role, pg)) : pageOpen(role, n.id))),
  })).map((g) => ({ ...g, shown: g.items.filter((n) => !n.hidden) })).filter((g) => g.shown.length > 0);

  const visibleItems = visibleGroups.flatMap((g) => g.items);
  const activeId = visibleItems.find((n) => n.id === active) ? active : visibleItems[0]?.id;
  const Active = visibleItems.find((n) => n.id === activeId)?.Component;
  const activeLabel = visibleItems.find((n) => n.id === activeId)?.label;

  const activeGroup = visibleGroups.find((g) => g.items.some((n) => n.id === activeId))?.key;
  const sheetOpen = moreOpen === 'all';
  /** Phone bottom bar: Home + the three pages this person opens most (role defaults until they have a history), then More. Every frequent page is ONE tap. */
  const shownItems = visibleGroups.flatMap((g) => g.shown);
  const homeItem = shownItems.find((n) => n.id === 'dashboard') || shownItems.find((n) => n.id === 'tickets') || shownItems[0];
  // what each kind of person opens most, until their own use takes over
  const DEFAULTS = role.category === 'Resident' ? ['tickets', 'mygate', 'amenities']
    : role.id === 'super_admin' ? ['tickets', 'billing', 'properties']
    : role.id === 'treasurer' ? ['billing', 'tickets', 'communications']
    : role.category === 'EC' ? ['tickets', 'communications', 'billing']
    : role.id === 'facility_manager' ? ['tickets', 'utilities', 'shifts']
    : role.id === 'helpdesk' ? ['tickets', 'security', 'communications']
    : /security|guard/.test(role.id) ? ['security', 'tickets', 'shifts']
    : ['tickets', 'shifts', 'calendar'];
  const pool = shownItems.filter((n) => n.id !== homeItem?.id);
  const score = (n) => (navUse[n.id] || 0) * 10 + Math.max(0, 3 - (DEFAULTS.indexOf(n.id) < 0 ? 9 : DEFAULTS.indexOf(n.id)));
  const pinned = [homeItem, ...[...pool].sort((a, b) => score(b) - score(a)).slice(0, 3)].filter(Boolean);
  // the More sheet: the pages used most after the bottom bar's, then every page by group (and a finder)
  const recent = pool.filter((n) => !pinned.includes(n) && (navUse[n.id] || 0) > 0).sort((a, b) => (navUse[b.id] || 0) - (navUse[a.id] || 0)).slice(0, 4);

  function select(id) {
    setActive(id);
    setMoreOpen(null);
    setNavUse((u) => { const n = { ...u, [id]: (u[id] || 0) + 1 }; try { localStorage.setItem(`communityos:navUse:${role?.id}`, JSON.stringify(n)); } catch { /* ignore */ } return n; });
  }
  /** A global-search result: open its page (and the tab inside it), or deep-link to the record. */
  function goResult(r) {
    if (r.link) { openLink(r.link); return; }
    if (r.tab) { try { sessionStorage.setItem('communityos:openTab', r.tab); } catch { /* ignore */ } }
    setActive(r.page === 'assets' ? 'utilities' : r.page); setMoreOpen(null); setNavKey((k) => k + 1);
  }

  const initials = (currentUser?.name || '?').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  return (
    <div className="app">
      <aside className="side">
        <div className="brand" onClick={() => setProfileMenuOpen((v) => !v)} style={{ cursor: 'pointer' }}>
          <span className="mark">{(community?.name || 'CommunityOS').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()}</span>
          <span className="brand-txt"><b>{community?.name || 'CommunityOS'}</b><small>{role.name}{currentUser.unit ? ` · ${currentUser.unit}` : ''}</small></span>
        </div>
        <div className="community" onClick={() => setProfileMenuOpen((v) => !v)} style={{ cursor: 'pointer' }}>
          <small>SIGNED IN AS</small>
          <b>{currentUser.name}</b>
          <small>{role.name}{currentUser.unit ? ` · ${currentUser.unit}` : ''}</small>
        </div>
        {visibleGroups.map((g) => (
          <div key={g.key} data-testid={`navsec-${g.key}`}>
            <div className="nav-label">{g.label.toUpperCase()}</div>
            <nav className="nav">
              {g.shown.map((n) => (
                <button key={n.id} className={n.id === activeId ? 'active' : ''} onClick={() => select(n.id)}>
                  <span className="ico">{n.icon}</span>{n.label}
                </button>
              ))}
            </nav>
          </div>
        ))}
      </aside>

      <main className="main">
        <header className="top">
          <div className="crumb-wrap">{trail.length > 0 && <button type="button" className="back-btn" data-testid="nav-back" aria-label="Back to previous page" onClick={goBack}>←</button>}<div className="crumb-txt"><div className="crumb">{activeLabel}</div>{pageDesc && <div className="crumb-desc" title={pageDesc}>{pageDesc}</div>}</div></div>
          <div className="top-right">
            {isClockRole(role) && (() => { const mins = duty.open ? Math.max(0, Math.floor((Date.now() - new Date(duty.open.clockIn)) / 60000)) : 0; return (
              <button type="button" className={`btn sm ${duty.open ? 'danger' : 'good'}`} data-testid="clock-chip" aria-label={duty.open ? 'On duty, tap to end your shift' : 'Off duty, tap to start your shift'} onClick={() => setClockOpen(true)}>
                {duty.open ? <>● <span className="search-label">On duty {Math.floor(mins / 60)}h {mins % 60}m ·</span> ■ Clock out</> : <>⏱ Clock in</>}</button>); })()}
            <GlobalSearch pages={shownItems.map((n) => ({ id: n.id, label: n.label, icon: n.icon }))} onGo={goResult} />
            <NotificationBell onOpen={openLink} onViewAll={() => openLink('#/notifications')} />
            <span className="role">{role.name}</span>
            <div className="avatar" onClick={() => setProfileMenuOpen((v) => !v)}>{initials}</div>
          </div>
        </header>
        <TruncatedNotice />
        {duty.staff && <OnDutyBar duty={duty} />}
        <section className="content">
          {duty.staff && !duty.ready ? null : duty.locked ? <ClockGate onDone={duty.reload} /> : Active && <Suspense fallback={<div className="page-loading" role="status" aria-live="polite">Loading…</div>}><Active key={`${activeId}-${navKey}`} onNavigate={select} /></Suspense>}
        </section>
      </main>

      <nav className="bottom-nav mobile-only">
        {pinned.map((n) => (
          <button key={n.id} data-testid={`bn-${n.id}`} className={n.id === activeId ? 'active' : ''} onClick={() => select(n.id)}>
            <span className="ico">{n.icon}</span>
            <small>{n.id === homeItem?.id ? 'Home' : shortLabel(n.label)}</small>
          </button>
        ))}
        <button data-testid="bn-more" className={sheetOpen || !pinned.some((n) => n.id === activeId) ? 'active' : ''} onClick={() => setMoreOpen((k) => (k === 'all' ? null : 'all'))}>
          <span className="ico">☰</span><small>More</small>
        </button>
      </nav>

      {clockOpen && <Modal title="Clock in / out" subtitle="Your GPS position is recorded when you tap the button." onClose={() => setClockOpen(false)}><ClockCard onChange={() => { duty.reload?.(); }} /></Modal>}

      {sheetOpen && (
        <div className="more-sheet mobile-only" data-testid="nav-sheet" onClick={() => setMoreOpen(null)}>
          <div className="more-sheet-inner" onClick={(e) => e.stopPropagation()}>
            <input className="search sheet-find" data-testid="sheet-find" value={navFind} onChange={(e) => setNavFind(e.target.value)} placeholder="Find a page…" aria-label="Find a page" />
            {navFind.trim() ? (
              <div className="sheet-grid">
                {shownItems.filter((n) => n.label.toLowerCase().includes(navFind.trim().toLowerCase())).map((n) => (
                  <button key={n.id} data-testid={`sheet-${n.id}`} className={n.id === activeId ? 'active' : ''} onClick={() => { setNavFind(''); select(n.id); }}><span className="ico">{n.icon}</span>{n.label}</button>
                ))}
              </div>
            ) : (
              <>
                {recent.length > 0 && (<><div className="sheet-title">Recent</div><div className="sheet-grid">
                  {recent.map((n) => <button key={n.id} className={n.id === activeId ? 'active' : ''} onClick={() => select(n.id)}><span className="ico">{n.icon}</span>{n.label}</button>)}
                </div></>)}
                {visibleGroups.map((g) => (
                  <div key={g.key}>
                    <div className="sheet-title">{g.label}</div>
                    <div className="sheet-grid">
                      {g.shown.map((n) => (
                        <button key={n.id} data-testid={`sheet-${n.id}`} className={n.id === activeId ? 'active' : ''} onClick={() => select(n.id)}>
                          <span className="ico">{n.icon}</span>{n.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {profileMenuOpen && (
        <div className="profile-menu">
          <button onClick={() => { setEditingProfile(true); setProfileMenuOpen(false); }}>My profile</button>
          <div className="menu-seg mobile-only" role="group" aria-label="Layout on this phone">
            <span>Layout</span>
            {[['compact', 'Compact'], ['comfortable', 'Comfortable']].map(([v, l]) => <button key={v} type="button" aria-pressed={layout === v} data-testid={`layout-${v}`} onClick={() => pickLayout(v)}>{l}</button>)}
          </div>
          {dataSourceShown() && <button className="mobile-only" data-testid="menu-data-source" onClick={() => { window.dispatchEvent(new CustomEvent('communityos:data-source')); setProfileMenuOpen(false); }}>Data source · {getDataSource().mode === 'session' ? 'Browser demo' : 'Back end'}</button>}
          <button onClick={() => { if (duty.open && !window.confirm('You are still clocked in. Switch account without clocking out?')) return; logout(); setProfileMenuOpen(false); }}>Switch account</button>
          {otherCommunities.map(({ community: c, user: u }) => (
            <button key={c.slug} data-testid={`switch-${c.slug}`} onClick={() => { setHandoff(c.slug, u.id); window.location.href = communityUrl(c.slug); }}>
              Switch to {c.name} <small className="muted">· {[u.roleId, ...(u.extraRoleIds || [])].map((id) => roles.find((r) => r.id === id)?.name || id.replace(/_/g, ' ')).join(', ')}</small>
            </button>
          ))}
          {community?.demoData && <button onClick={async () => { if (window.confirm('Reset all demo data and reload?')) { const { resetDemoData } = await import('./lib/seed/seedData.js'); resetDemoData(); window.location.reload(); } }}>Reset demo data</button>}
        </div>
      )}

      {toast && <div className={`toast ${toast.kind}`} role="alert" data-testid="toast">{toast.kind === 'success' ? '✓' : toast.kind === 'network' ? '📡' : toast.kind === 'error' ? '⚠' : '🔒'} {toast.text}</div>}
      <ActivityBar />
      {spill && <div className="notice" role="status" data-testid="spill-banner" style={{ position: 'fixed', left: 8, right: 8, bottom: 64, zIndex: 50, margin: 0 }}>Large community: this browser demo ran out of its 5 MB store, so big lists are held in memory until you reload. The real database back end has no such limit. <button className="link-btn" onClick={() => setSpill(false)}>Dismiss</button></div>}

      {editingProfile && <ProfileModal onClose={() => setEditingProfile(false)} />}
    </div>
  );
}

/** A page's name for the phone's bottom bar (five fit across). */
const shortLabel = (l) => l.replace(' & Finance', '').replace('Security & Visitors', 'Security').replace('Utilities & Assets', 'Utilities').replace('Unit Directory', 'Homes')
  .replace('Communications', 'Notices').replace('Service directory', 'Services').replace('No-code ', '').replace('Command Center', 'Home');

function Notice({ title, text }) {
  return (
    <div className="login-screen"><div className="login-card"><div className="brand" style={{ color: '#fff' }}><span className="mark">⌂</span> CommunityOS</div>
      <h2 style={{ color: '#fff' }}>{title}</h2><p className="muted">{text}</p>
    </div></div>
  );
}

function Root() {
  const { currentUser, ready, communityState } = useApp();
  if (communityState === 'missing') return <Notice title="Community not found" text={`There is no community at this web address (“${getCommunity()}”). Check the link, or ask the platform administrator.`} />;
  if (communityState === 'suspended') return <Notice title="Community suspended" text="This community has been suspended by the platform administrator. Please contact them to restore access." />;
  if (!ready) return <div className="empty">Loading…</div>;
  return currentUser ? <Shell /> : <LoginScreen />;
}

/** Phones: give every table row labels from its header so the stylesheet can show rows as compact cards (no sideways scrolling). */
function useResponsiveTables() {
  useEffect(() => {
    let raf = 0;
    const run = () => {
      raf = 0;
      document.querySelectorAll('.content table:not([data-keep]):not(.changes)').forEach((t) => {
        t.classList.add('resp-table');
        const heads = [];
        t.querySelectorAll('thead th').forEach((th) => { const n = th.colSpan || 1; for (let i = 0; i < n; i++) heads.push(th.textContent.trim()); });
        if (!heads.length) return;
        t.querySelectorAll('tbody tr').forEach((tr) => {
          let i = 0;
          tr.querySelectorAll(':scope > td').forEach((td) => { if (!td.hasAttribute('data-label')) td.setAttribute('data-label', heads[i] || ''); const tx = td.textContent.trim(); if ((tx === '' || tx === '—' || tx === '-') && !td.querySelector('button,input,select,a,img')) td.setAttribute('data-empty', ''); else td.removeAttribute('data-empty'); i += td.colSpan || 1; });
        });
      });
    };
    const mo = new MutationObserver(() => { if (!raf) raf = requestAnimationFrame(run); });
    mo.observe(document.body, { childList: true, subtree: true });
    run();
    return () => { mo.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, []);
}

let jobsRunning = null; // the background jobs never overlap themselves (a second tab can still run them; they are idempotent)
export default function App() {
  useResponsiveTables();
  // the web address decides: the platform console, or one community (each with its own data, roles and users)
  if (getCommunity() === PLATFORM) return <PlatformApp />;
  return (
    <AppProvider>
      <Root />
    </AppProvider>
  );
}
