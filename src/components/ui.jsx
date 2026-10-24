import React from 'react';
import Tabs from './Tabs.jsx';

/**
 * Small shared building blocks so every screen uses the same compact, thumb-friendly patterns:
 *   SegTabs   - underlined tab strip with optional count / dot badges (ticket detail, any multi-section sheet)
 *   Segmented - pill switch for 2-4 choices (Mine/All, Public/Internal, priority)
 *   StatTiles - row of tappable count tiles that double as filters
 *   ActionBar - sticky bottom bar for the primary action(s) of a sheet
 *   Chips     - wrap-around choice chips (categories, quick phrases)
 */

export function SegTabs({ tabs, value, onChange, label = 'Sections', variant }) {
  return (
    <Tabs base="seg-tabs" className={variant === 'pill' ? 'pill' : ''} role="tablist" aria-label={label}>
      {tabs.filter((t) => t && !t.hidden).map((t) => (
        <button key={t.key} type="button" role="tab" aria-selected={value === t.key} data-testid={`tab-${t.key}`}
          className={value === t.key ? 'on' : ''} onClick={() => onChange(t.key)}>
          {t.label}
          {t.count != null && t.count > 0 && <span className="seg-badge">{t.count}</span>}
          {t.dot && <span className="seg-dot" aria-label="needs attention" />}
        </button>
      ))}
    </Tabs>
  );
}

export function Segmented({ options, value, onChange, label, tone }) {
  return (
    <div className={`segmented${tone ? ' ' + tone : ''}`} role="group" aria-label={label}>
      {options.map((o) => {
        const opt = typeof o === 'string' ? { value: o, label: o } : o;
        return (
          <button key={opt.value} type="button" aria-pressed={value === opt.value} className={value === opt.value ? `on ${opt.tone || ''}` : ''}
            onClick={() => onChange(opt.value)}>{opt.label}{opt.count != null ? <small>{opt.count}</small> : null}</button>
        );
      })}
    </div>
  );
}

export function StatTiles({ items, value, onChange, label = 'Filter' }) {
  return (
    <div className="stat-tiles" role="group" aria-label={label}>
      {items.map((s) => (
        <button key={s.key} type="button" aria-pressed={value === s.key} data-testid={`tile-${s.key}`}
          className={`stat-tile${value === s.key ? ' on' : ''}${s.tone ? ' ' + s.tone : ''}`} onClick={() => onChange(value === s.key && s.key !== 'all' ? 'all' : s.key)}>
          <b>{s.count}</b><span>{s.label}</span>
        </button>
      ))}
    </div>
  );
}

export function ActionBar({ children }) {
  return <div className="action-bar">{children}</div>;
}

export function Chips({ options, value, onChange, label }) {
  return (
    <div className="chips" role="group" aria-label={label}>
      {options.map((o) => {
        const opt = typeof o === 'string' ? { value: o, label: o } : o;
        return <button key={opt.value} type="button" aria-pressed={value === opt.value} className={`chip${value === opt.value ? ' on' : ''}`} onClick={() => onChange(opt.value)}>{opt.label}</button>;
      })}
    </div>
  );
}

export function MoneyTiles({ items }) {
  return (
    <div className="money-tiles">
      {items.map((m) => (
        m.onClick
          ? <button type="button" key={m.label} className={`money-tile clickable ${m.tone || ''}${m.active ? ' on' : ''}`} aria-pressed={!!m.active} data-testid={m.testid} onClick={m.onClick}><small>{m.label}</small><b>{m.value}</b>{m.sub && <em>{m.sub}</em>}</button>
          : <div key={m.label} className={`money-tile ${m.tone || ''}`}><small>{m.label}</small><b>{m.value}</b>{m.sub && <em>{m.sub}</em>}</div>
      ))}
    </div>
  );
}
