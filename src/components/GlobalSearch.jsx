import React, { useEffect, useRef, useState } from 'react';
import { search } from '../lib/globalSearch.js';
import { SearchIcon } from './ToolIcons.jsx';

/** Search box in the header (press / or Ctrl+K anywhere): pages, sections and records the person may open. */
export default function GlobalSearch({ pages, onGo }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [res, setRes] = useState([]);
  const [idx, setIdx] = useState(0);
  const input = useRef(null);
  const session = useRef(null);   // the records read for THIS opening of the search box; dropped when it closes
  useEffect(() => {
    const h = (e) => {
      const tag = (e.target?.tagName || '').toLowerCase();
      const typing = ['input', 'textarea', 'select'].includes(tag) || e.target?.isContentEditable;
      if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) { e.preventDefault(); setOpen(true); }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);
  useEffect(() => { if (open) { session.current = {}; setTimeout(() => input.current?.focus(), 30); } else { session.current = null; setQ(''); setRes([]); } }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    let on = true;
    const t = setTimeout(() => search(q, { pages, session: session.current }).then((r) => { if (on) { setRes(r); setIdx(0); } }).catch(() => {}), 120);
    return () => { on = false; clearTimeout(t); };
  }, [q, open, pages]);
  const go = (r) => { setOpen(false); onGo(r); };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(res.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter' && res[idx]) { e.preventDefault(); go(res[idx]); }
  };
  return (
    <>
      <button type="button" className="btn secondary sm" data-testid="search-open" aria-label="Search" title="Search (press /)" onClick={() => setOpen(true)} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><span className="search-emo">🔍</span><span className="search-svg"><SearchIcon /></span> <span className="search-label">Search</span><span className="search-ph">Search tickets, homes, people…</span><kbd className="search-kbd">{/Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘K' : 'Ctrl K'}</kbd></button>
      {open && (
        <div className="modal-overlay" onClick={() => setOpen(false)} style={{ alignItems: 'flex-start', paddingTop: 70 }}>
          <div className="modal-card" role="dialog" aria-label="Search" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560, width: '92%' }} data-testid="search-dialog">
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input ref={input} aria-label="Search the portal" data-testid="search-input" placeholder="Search pages, tasks, villas, documents, staff…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} style={{ flex: 1, minWidth: 0, fontSize: 16, padding: '10px 12px' }} /><button type="button" className="btn secondary sm" aria-label="Close search" data-testid="search-close" onClick={() => setOpen(false)}>✕</button></div>
            <div style={{ maxHeight: 380, overflow: 'auto', marginTop: 8 }} data-testid="search-results">
              {res.length === 0 && <div className="muted" style={{ padding: 10 }}>{q ? 'No matches.' : 'Type to search. Try “attendance”, “trash”, a villa number or a ticket number.'}</div>}
              {res.map((r, i) => (
                <button key={r.id} type="button" data-testid="search-result" onMouseEnter={() => setIdx(i)} onClick={() => go(r)} style={{ display: 'flex', gap: 10, width: '100%', textAlign: 'left', padding: '8px 10px', border: 0, borderRadius: 6, background: i === idx ? '#eef4ff' : 'transparent', cursor: 'pointer', alignItems: 'center' }}>
                  <span style={{ width: 22, textAlign: 'center' }}>{r.icon}</span><span style={{ flex: 1 }}><b>{r.label}</b><br /><small className="muted">{r.sub}</small></span>
                </button>
              ))}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>↑↓ to move · Enter to open · Esc to close</div>
          </div>
        </div>
      )}
    </>
  );
}
