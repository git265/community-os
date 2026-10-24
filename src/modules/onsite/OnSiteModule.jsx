import React, { useState } from 'react';
import { useApp } from '../../context/AppContext.jsx';
import { SegTabs } from '../../components/ui.jsx';
import { siteRights } from '../../lib/site/site.js';
import OnSiteLive from './OnSiteLive.jsx';
import OnSiteAttendance from './OnSiteAttendance.jsx';
import OnSiteDevices from './OnSiteDevices.jsx';

/** On site: one page for security and workforce. Who is inside now and every punch (Live), the day's attendance, and the gate devices. */
export default function OnSiteModule({ onNavigate }) {
  const app = useApp();
  const rights = siteRights(app);
  const ok = (id) => (app.tabAllowed ? app.tabAllowed(id) : true);
  const tabs = [
    { key: 'live', label: 'Live', hidden: !ok('onsite.live') },
    { key: 'attendance', label: 'Attendance', hidden: !ok('onsite.attendance') || !rights.manages },
    { key: 'devices', label: 'Devices', hidden: !ok('onsite.devices') || !rights.manages },
  ];
  const first = tabs.find((t) => !t.hidden)?.key || 'live';
  const [tab, setTab] = useState(first);
  const shown = tabs.find((t) => t.key === tab && !t.hidden) ? tab : first;
  if (!rights.views) return <div className="empty">On site is for the security team, the facility manager and the committee.</div>;
  return (
    <div data-testid="onsite-module">
      <div className="page-head hide-sm"><h1>On site</h1><p className="muted">Who is inside now, every punch from the gate devices, the day's attendance, and the devices themselves.</p></div>
      <SegTabs tabs={tabs} value={shown} onChange={setTab} label="On site sections" />
      <div style={{ marginTop: 14 }}>
        {shown === 'live' && <OnSiteLive rights={rights} onNavigate={onNavigate} />}
        {shown === 'attendance' && <OnSiteAttendance />}
        {shown === 'devices' && <OnSiteDevices rights={rights} />}
      </div>
    </div>
  );
}
