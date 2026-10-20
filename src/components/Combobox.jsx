import React, { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Searchable combobox. options: [{ value, label, hint? }].
 * allowCustom: a typed value that is not in the list is accepted (e.g. a one-off vendor).
 * Keyboard: ↑ ↓ to move, Enter to pick, Esc to close.
 */
export default function Combobox({ value, onChange, options, placeholder = 'Search…', allowCustom = false, disabled = false, invalid = false }) {
  const selected = options.find((o) => o.value === value);
  const shown = selected ? selected.label : value || '';
  const [query, setQuery] = useState(null); // null = not editing
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrap = useRef(null);

  const text = query ?? shown;
  const filtered = useMemo(() => {
    const q = (query || '').trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => `${o.label} ${o.hint || ''} ${o.value}`.toLowerCase().includes(q));
  }, [options, query]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    const away = (e) => { if (wrap.current && !wrap.current.contains(e.target)) close(true); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  });

  function close(commit) {
    if (commit && query !== null) {
      const typed = query.trim();
      if (typed === '') { if (value) onChange(''); }
      else if (allowCustom && !options.some((o) => o.label === typed || o.value === typed)) onChange(typed);
      else {
        const m = options.find((o) => o.label === typed || o.value === typed);
        if (m && m.value !== value) onChange(m.value);
      }
    }
    setQuery(null);
    setOpen(false);
  }
  function pick(o) { onChange(o.value); setQuery(null); setOpen(false); }

  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { if (open) { e.preventDefault(); if (filtered[active]) pick(filtered[active]); else close(true); } }
    else if (e.key === 'Escape') { setQuery(null); setOpen(false); }
  }

  return (
    <div className={`combobox${invalid ? ' invalid' : ''}`} ref={wrap}>
      <input
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onKeyDown={onKey}
      />
      {value && !disabled && <button type="button" className="cb-clear" aria-label="Clear" onMouseDown={(e) => { e.preventDefault(); onChange(''); setQuery(null); }}>✕</button>}
      {open && !disabled && (
        <ul className="cb-list" role="listbox">
          {filtered.length === 0 && <li className="cb-empty">{allowCustom && query ? `Press Enter to use “${query}”` : 'No matches'}</li>}
          {filtered.map((o, i) => (
            <li key={o.value} role="option" aria-selected={o.value === value} className={`${i === active ? 'active' : ''}${o.value === value ? ' sel' : ''}`} onMouseDown={(e) => { e.preventDefault(); pick(o); }} onMouseEnter={() => setActive(i)}>
              <span>{o.label}</span>{o.hint && <small>{o.hint}</small>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
