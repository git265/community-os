import MyGateImport from './MyGateImport.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { SegTabs } from '../../components/ui.jsx';
import GateConsole from './GateConsole.jsx';
import GateVisits from './GateVisits.jsx';
import GateFlags from './GateFlags.jsx';
import GateRegistry from './GateRegistry.jsx';
import GateCrews from './GateCrews.jsx';
import GateRules from './GateRules.jsx';
import GateReports from './GateReports.jsx';
import GateSimulator from './GateSimulator.jsx';
import GateIncidents from './GateIncidents.jsx';
import GatePatrol from './GatePatrol.jsx';
import GateVehicles from './GateVehicles.jsx';
import GateBadge from './GateBadge.jsx';

/** Security & Visitors: the guard's console plus everything behind it. Tabs follow the role's tab switches. */
export default function GateModule() {
  const { role, roleId, hasPermission, tabAllowed } = useApp();
  const { records: flags } = useCollection(COLLECTIONS.GATE_FLAGS, 'Gate');
  const { records: people } = useCollection(COLLECTIONS.GATE_PEOPLE, 'Gate');
  const manage = roleId === 'super_admin' || hasPermission('MANAGE_SECURITY');
  const committee = roleId === 'super_admin' || role?.category === 'EC';
  const ok = (id) => (tabAllowed ? tabAllowed(id) : true);
  const tabs = [
    { key: 'console', label: 'Gate console', hidden: !ok('gate.console') },
    { key: 'visits', label: 'Visits', hidden: !ok('gate.visits') },
    { key: 'flags', label: 'Ghost flags', count: flags.filter((f) => f.state !== 'Closed').length, hidden: !ok('gate.flags') },
    { key: 'registry', label: 'Registry', count: people.filter((p) => ['Documents pending', 'Under review'].includes(p.status)).length, hidden: !ok('gate.registry') },
    { key: 'crews', label: 'Crews', hidden: !ok('gate.crews') },
    { key: 'vehicles', label: 'Vehicles', hidden: !ok('gate.vehicles') },
    { key: 'patrol', label: 'Patrol', hidden: !ok('gate.patrol') },
    { key: 'badge', label: 'My badge', hidden: !ok('gate.badge') },
    { key: 'incidents', label: 'Incidents', hidden: !ok('gate.incidents') },
    { key: 'rules', label: 'Rules & alerts', hidden: !ok('gate.rules') },
    { key: 'reports', label: 'Reports', hidden: !ok('gate.reports') },
    { key: 'mygate', label: 'Import from MyGate', hidden: !ok('gate.mygate') || !(committee || manage) },
    { key: 'sim', label: 'Gate simulator', hidden: !ok('gate.sim') || !(committee || manage) },
  ];
  const first = tabs.find((t) => !t.hidden)?.key || 'console';
  const [tab, setTab] = useState(first);
  useEffect(() => {
    try { const a = sessionStorage.getItem('communityos:openTab'); if (a && a.startsWith('gate.')) { setTab(a.slice(5)); sessionStorage.removeItem('communityos:openTab'); } } catch { /* ignore */ }
  }, []);
  const shown = tabs.find((t) => t.key === tab && !t.hidden) ? tab : first;
  const tabsRef = useRef(null);
  useEffect(() => { tabsRef.current?.querySelector('[aria-selected=true]')?.scrollIntoView?.({ inline: 'center', block: 'nearest' }); }, [shown]);
  return (
    <div data-testid="gate-module">
      <div className="page-head hide-sm"><h1>Security & Visitors</h1><p className="muted">Every person through the gate is recorded, approved by the villa or by a rule, and checked against the register.</p></div>
      <div className="gg-tabs-scroll" ref={tabsRef}><SegTabs tabs={tabs} value={shown} onChange={setTab} label="Security sections" /></div>
      <div style={{ marginTop: 14 }}>
        {shown === 'console' && <GateConsole />}
        {shown === 'visits' && <GateVisits />}
        {shown === 'flags' && <GateFlags canAct={manage || committee} />}
        {shown === 'registry' && <GateRegistry canEdit={manage || committee} />}
        {shown === 'crews' && <GateCrews canEdit={manage || committee} />}
        {shown === 'vehicles' && <GateVehicles canEdit={committee || roleId === 'facility_manager'} />}
        {shown === 'patrol' && <GatePatrol canEdit={committee || roleId === 'facility_manager'} />}
        {shown === 'badge' && <GateBadge />}
        {shown === 'incidents' && <GateIncidents canReport />}
        {shown === 'rules' && <GateRules canEdit={committee || roleId === 'facility_manager'} />}
        {shown === 'reports' && <GateReports />}
        {shown === 'mygate' && <MyGateImport />}
        {shown === 'sim' && <GateSimulator />}
      </div>
    </div>
  );
}
