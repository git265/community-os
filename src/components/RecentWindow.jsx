import React from 'react';

/** Paid / Skipped lists show only the last 6 months by default; this is the cut-off date and the "Show all" line. */
export const recentCutoff = (months = 6) => { const d = new Date(); d.setMonth(d.getMonth() - months); return d.toISOString().slice(0, 10); };
export const inRecent = (date, cutoff) => !date || String(date).slice(0, 10) >= cutoff;

export function RecentNote({ total, shown, all, onToggle, months = 6 }) {
  if (total === 0 || (total === shown && !all)) return null;
  return (
    <p className="muted" data-testid="recent-note" style={{ margin: '8px 0 0', fontSize: 13 }}>
      {all ? `Showing all ${total}.` : `Showing the last ${months} months (${shown} of ${total}).`}{' '}
      <button type="button" className="link-btn" data-testid="recent-toggle" onClick={onToggle}>{all ? `Show last ${months} months only` : 'Show all'}</button>
    </p>
  );
}
