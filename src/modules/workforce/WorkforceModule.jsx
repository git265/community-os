import React, { useEffect, useState } from 'react';
import { useApp } from '../../context/AppContext.jsx';
import { getPrincipal } from '../../lib/security/principal.js';
import ShiftsModule from '../shifts/ShiftsModule.jsx';
import AttendanceTab from './AttendanceTab.jsx';
import SiteRulesTab from './SiteRulesTab.jsx';

/** Workforce & attendance: clock in/out, attendance reports, shift planning and the site / GPS rules. */
export default function WorkforceModule() {
  const { role, roleId, tabAllowed } = useApp();
  const p = getPrincipal();
  const sup = roleId === 'super_admin' || p?.role?.permissions?.includes('MANAGE_FIELD_DUTIES');
  const tabs = [['attendance', 'Attendance'], ['shifts', 'Shift planner'], ...(sup ? [['site', 'Site & GPS rules']] : [])].filter(([k]) => tabAllowed(`workforce.${k}`));
  const [tab, setTab] = useState(() => { try { const t = sessionStorage.getItem('communityos:openTab'); if (t) return t; } catch { /* ignore */ } return 'attendance'; });
  useEffect(() => { try { sessionStorage.removeItem('communityos:openTab'); } catch { /* ignore */ } }, []);
  useEffect(() => { if (!tabs.some(([k]) => k === tab)) setTab(tabs[0]?.[0] || 'attendance'); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      <div className="page-head"><div><h1>Workforce</h1><p>Attendance reports (clock in/out is the button in the top bar), GPS records, shift planning and site rules for facility and field staff.</p></div></div>
      <div className="tabs">{tabs.map(([k, l]) => <button key={k} type="button" data-testid={`wtab-${k}`} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      {tab === 'attendance' && <AttendanceTab />}
      {tab === 'shifts' && <ShiftsModule embedded />}
      {tab === 'site' && sup && <SiteRulesTab />}
    </div>
  );
}
