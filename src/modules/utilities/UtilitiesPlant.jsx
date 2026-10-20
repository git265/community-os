import React, { useState } from 'react';
import { useApp } from '../../context/AppContext.jsx';
import { pageOpen } from '../../lib/access/tabs.js';
import { utilitiesVisible, plantVisible } from '../../lib/access/visibility.js';
import UtilitiesModule from './UtilitiesModule.jsx';
import AssocBills from './AssocBills.jsx';
import AssetsModule from '../assets/AssetsModule.jsx';

const isHandyman = (role) => !!role?.id?.startsWith('handyman_');
/** Who sees what: the same rules the two old pages (Utilities, Plant & Assets) had, now sections of one page. */
export { utilitiesVisible, plantVisible };

const ASSET_TABS = ['plant', 'summary', 'dg', 'electricity', 'villas', 'logs'];
const STORE_TABS = ['inventory', 'equipment'];

/**
 * Utilities & Assets: one page for everything about the services that keep the community running.
 *   💧 Meter readings & billing  - villa meters → bills to owners (readings, rate cards, bill templates)
 *   🧾 Association bills          - what the association pays (electricity, water, gas, diesel, internet…)
 *   ⚙ Plant & operations         - water & sewage plant logs, DG fuel, electricity, villa electricity, other logs
 *   🧰 Inventory & Assets         - inventory and the equipment / warranty register
 * Each section keeps the per-role access of the page it came from.
 */
export default function UtilitiesPlant({ onNavigate }) {
  const { role, hasPermission, tabAllowed } = useApp();
  const u = !!role && utilitiesVisible(role, hasPermission) && pageOpen(role, 'utilities');
  const a = !!role && plantVisible(role) && pageOpen(role, 'assets');
  const sections = [
    u && ['meters', '💧 Meter readings & billing', 'Villa meters → bills to owners'],
    u && tabAllowed('util.assoc') && ['assoc', '🧾 Association bills', 'What the association pays'],
    a && ASSET_TABS.some((t) => tabAllowed(`assets.${t}`)) && ['ops', '⚙ Plant & operations', 'Plants, DG fuel, electricity, logs'],
    a && STORE_TABS.some((t) => tabAllowed(`assets.${t}`)) && ['stores', '🧰 Inventory & Assets', 'Inventory, equipment, warranties'],
  ].filter(Boolean);
  const [raw, setRaw] = useState(() => {
    try {
      const sec = sessionStorage.getItem('communityos:openSection'); const tab = sessionStorage.getItem('communityos:openTab') || '';
      if (sec) setTimeout(() => sessionStorage.removeItem('communityos:openSection'), 400);
      if (sec) return sec;
      if (tab === 'assoc') return 'assoc';
      if (['readings', 'billing', 'templates'].includes(tab)) return 'meters';
      if (STORE_TABS.includes(tab)) return 'stores';
      if (ASSET_TABS.includes(tab) || tab.startsWith('log:')) return 'ops';
    } catch { /* ignore */ }
    return '';
  });
  const cur = sections.find(([id]) => id === raw) ? raw : sections[0]?.[0];
  if (!sections.length) return <div className="empty">Nothing here is available for your role.</div>;
  return (
    <div data-testid="utilities-plant">
      <div className="up-sections" role="tablist" aria-label="Utilities and plant sections">
        {sections.map(([id, label, hint]) => (
          <button key={id} type="button" role="tab" aria-selected={cur === id} className={`up-sec${cur === id ? ' on' : ''}`} data-testid={`up-${id}`} onClick={() => setRaw(id)}>
            <b>{label}</b><small>{hint}</small>
          </button>
        ))}
      </div>
      {cur === 'meters' && <UtilitiesModule key="m" onNavigate={onNavigate} hideAssoc />}
      {cur === 'assoc' && <AssocBills key="a" onNavigate={onNavigate} />}
      {cur === 'ops' && <AssetsModule key="o" only="ops" />}
      {cur === 'stores' && <AssetsModule key="s" only="assets" />}
    </div>
  );
}
