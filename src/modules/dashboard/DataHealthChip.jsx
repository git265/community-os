import React from 'react';
import { useApp } from '../../context/AppContext.jsx';

/**
 * For the people who keep the data: a link to Reports -> Data health. The check reads almost every collection, so it runs only when that page is
 * opened (until round 76 it ran on every visit to the home page, which downloaded vendors, quotations, inventory, equipment, bookings, gate data ...).
 */
export default function DataHealthChip({ onNavigate }) {
  const { role, roleId } = useApp();
  const keeper = roleId === 'super_admin' || role?.category === 'EC' || roleId === 'facility_manager';
  if (!keeper || !onNavigate) return null;
  return (
    <button type="button" className="link-btn" data-testid="health-chip" style={{ marginTop: 12 }} onClick={() => { try { sessionStorage.setItem('communityos:openTab', 'reports.health'); } catch { /* ignore */ } onNavigate('reports'); }}>
      Check data health ›
    </button>
  );
}
