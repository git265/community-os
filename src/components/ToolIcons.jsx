import React, { useEffect, useRef, useState } from 'react';
import { usePhone } from './Tabs.jsx';

/** Line icons for list toolbars (they take the text colour). */
export const SearchIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
);
export const SlidersIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" />
  </svg>
);

/** The filter button of a list: on a phone the sliders icon (with how many filters are on), on a computer "⚙ Filters". */
export function FilterButton({ open, count = 0, onClick, className = '', testid }) {
  const phone = usePhone();
  return (
    <button type="button" className={`btn secondary ${phone ? 'icon-tool' : ''} ${className}`.trim()} aria-expanded={open} aria-label="Sort, filter and export" title="Filters" data-testid={testid} onClick={onClick}>
      {phone ? <><SlidersIcon />{count > 0 && <span className="icon-tool-badge">{count}</span>}</> : <>⚙ Filters{count > 0 ? ` (${count})` : ''}</>}
    </button>
  );
}

/**
 * A list's search box. On a computer: the box, as before. On a phone: a magnifying-glass button that opens the box
 * (it stays open while it holds text; ✕ clears and closes it), so the list starts higher up the screen.
 */
export function PhoneSearch({ value, onChange, placeholder = 'Search…', className = 'search', type, testid, ariaLabel, onOpenChange, style }) {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  const shown = !phone || open || !!value;
  useEffect(() => { onOpenChange?.(phone && shown); }, [phone, shown]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (phone && open) box.current?.focus(); }, [phone, open]);
  if (!shown) {
    return <button type="button" className="btn secondary icon-tool" aria-label={ariaLabel || 'Search'} title="Search" data-testid={testid ? `${testid}-open` : undefined} onClick={() => setOpen(true)}><SearchIcon /></button>;
  }
  const input = <input ref={box} type={type} className={className} style={phone ? undefined : style} aria-label={ariaLabel} data-testid={testid} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />;
  if (!phone) return input;
  return (
    <span className="phone-search">
      {input}
      <button type="button" className="phone-search-x" aria-label="Close search" onClick={() => { onChange(''); setOpen(false); }}>✕</button>
    </span>
  );
}

/**
 * A toolbar's filters (dropdowns, Clear...). On a computer: shown inline, as before. On a phone: hidden behind the sliders
 * button (it shows how many are set), opening as a full-width row under the toolbar.
 */
export function PhoneFilters({ count = 0, children, testid }) {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  if (!phone) return <>{children}</>;
  return (
    <>
      <FilterButton open={open} count={count} testid={testid} onClick={() => setOpen((v) => !v)} />
      {open && <div className="phone-filters" data-testid={testid ? `${testid}-panel` : undefined}>{children}</div>}
    </>
  );
}
