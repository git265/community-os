import React, { useEffect, useState } from 'react';
import { useApp } from '../../context/AppContext.jsx';
import { getPrincipal } from '../../lib/security/principal.js';
import { siteRights } from '../../lib/site/site.js';
import ShiftsModule from '../shifts/ShiftsModule.jsx';
import AttendanceTab from './AttendanceTab.jsx';
import SiteRulesTab from './SiteRulesTab.jsx';
import OnSiteLive from '../onsite/OnSiteLive.jsx';
import OnSiteAttendance from '../onsite/OnSiteAttendance.jsx';
import OnSiteDevices from '../onsite/OnSiteDevices.jsx';
import Tabs from '../../components/Tabs.jsx';

/** Workforce: who is on site now, attendance (staff, and the household staff and contractors at the gate), shift planning, the gate devices
 *  and the site / GPS rules. What was the separate On site page is here: the security team, the facility manager and the committee see its tabs. */
export default function WorkforceModule({ onNavigate }) {
  const app = useApp();
  const { roleId, tabAllowed } = app;
  const p = getPrincipal();
  const sup = roleId === 'super_admin' || p?.role?.permissions?.includes('MANAGE_FIELD_DUTIES');
  const site = siteRights(app);
  // the managers' attendance has the household and contractor musters beside the staff's; everyone else sees the staff attendance
  const musters = site.manages && tabAllowed('onsite.attendance');
  const tabs = [
    ...(site.views && tabAllowed('onsite.live') ? [['live', 'On site now']] : []),
    ...(tabAllowed('workforce.attendance') || musters ? [['attendance', 'Attendance']] : []),
    ...(tabAllowed('workforce.shifts') ? [['shifts', 'Shift planner']] : []),
    ...(site.manages && tabAllowed('onsite.devices') ? [['devices', 'Devices']] : []),
    ...(sup && tabAllowed('workforce.site') ? [['site', 'Site & GPS rules']] : []),
  ];
  const first = tabs[0]?.[0] || 'attendance';
  const [tab, setTab] = useState(() => { try { const t = sessionStorage.getItem('communityos:openTab'); if (t) return t; } catch { /* ignore */ } return first; });
  useEffect(() => { try { sessionStorage.removeItem('communityos:openTab'); } catch { /* ignore */ } }, []);
  useEffect(() => { if (!tabs.some(([k]) => k === tab)) setTab(first); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div data-testid="workforce-module">
      <div className="page-head"><div><h1>Workforce</h1><p>Who is on site now, attendance (clock in/out is the button in the top bar), shift planning, the gate devices and site rules.</p></div></div>
      <Tabs>{tabs.map(([k, l]) => <button key={k} type="button" data-testid={`wtab-${k}`} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>)}</Tabs>
      {tab === 'live' && site.views && <div style={{ marginTop: 14 }}><OnSiteLive rights={site} onNavigate={onNavigate} /></div>}
      {tab === 'attendance' && (musters ? <div style={{ marginTop: 14 }}><OnSiteAttendance /></div> : <AttendanceTab />)}
      {tab === 'shifts' && <ShiftsModule embedded />}
      {tab === 'devices' && site.manages && <div style={{ marginTop: 14 }}><OnSiteDevices rights={site} /></div>}
      {tab === 'site' && sup && <SiteRulesTab />}
    </div>
  );
}
