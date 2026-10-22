import React, { useEffect, useMemo, useState } from 'react';
import { storage, COLLECTIONS } from '../../lib/storage/index.js';
import { getDataSource } from '../../lib/storage/dataSource.js';

export const NO_BLOCK = '__none__';

/**
 * Each block's homes and how they are lived in: [{ name, total, ownerOccupied?, tenantOccupied?, vacant? }] (name '' = the units in no block).
 * On the back end the server counts them (one small query, however many units); the browser demo counts its own list.
 */
export async function blockCounts() {
  if (getDataSource().mode === 'v2') { const { unitsByBlock } = await import('../../lib/storage/v2/V2ApiAdapter.js'); return unitsByBlock(); }
  const by = new Map();
  for (const u of await storage.list(COLLECTIONS.PROPERTIES)) {
    const k = String(u.zone || '').trim();
    const c = by.get(k) || { name: k, total: 0, ownerOccupied: 0, tenantOccupied: 0, vacant: 0 };
    c.total += 1;
    if (u.occupancy === 'Owner occupied') c.ownerOccupied += 1; else if (u.occupancy === 'Tenant occupied') c.tenantOccupied += 1; else if (u.occupancy === 'Vacant') c.vacant += 1;
    by.set(k, c);
  }
  return [...by.values()].sort((a, b) => (!a.name) - (!b.name) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** The counts, read once and again whenever units change. */
export function useBlockCounts() {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let on = true;
    const load = () => blockCounts().then((r) => { if (on) setRows(r); }).catch(() => { if (on) setRows([]); });
    load();
    const h = (e) => { const c = e?.detail?.collection; if (!c || c === COLLECTIONS.PROPERTIES || c === COLLECTIONS.BLOCKS) load(); };
    window.addEventListener('communityos:changed', h);
    return () => { on = false; window.removeEventListener('communityos:changed', h); };
  }, []);
  return rows;
}

/**
 * Block-first navigation for a directory of thousands of homes: one card a block (its homes and how they are lived in), "All blocks" first,
 * a finder when there are many blocks. `value` is a block's name, NO_BLOCK for the units in no block, or '' for all.
 */
export default function BlockNavigator({ counts, value, onChange, label = 'Blocks' }) {
  const [find, setFind] = useState('');
  const list = counts || [];
  const total = list.reduce((n, b) => n + b.total, 0);
  const shown = useMemo(() => { const q = find.trim().toLowerCase(); return q ? list.filter((b) => (b.name || 'no block').toLowerCase().includes(q)) : list; }, [list, find]);
  if (!counts) return <div className="ud-blocks-wait muted">Counting the homes…</div>;
  if (list.length <= 1 && !list[0]?.name) return null;   // no blocks set up: nothing to pick
  const key = (b) => (b.name ? b.name : NO_BLOCK);
  const bar = (b) => (b.ownerOccupied == null ? null : (
    <span className="ud-bar" aria-hidden="true">
      <i className="o" style={{ width: `${(b.ownerOccupied / Math.max(1, b.total)) * 100}%` }} />
      <i className="t" style={{ width: `${(b.tenantOccupied / Math.max(1, b.total)) * 100}%` }} />
      <i className="v" style={{ width: `${(b.vacant / Math.max(1, b.total)) * 100}%` }} />
    </span>
  ));
  const title = (b) => (b.ownerOccupied == null ? `${b.total} homes` : `${b.total} homes · ${b.ownerOccupied} owner occupied · ${b.tenantOccupied} tenanted · ${b.vacant} vacant`);
  return (
    <div className="ud-blocks" data-testid="block-nav">
      <div className="ud-blocks-head">
        <b>{label}</b> <span className="muted">{list.filter((b) => b.name).length} blocks · {total.toLocaleString('en-IN')} homes</span>
        {list.length > 8 && <input className="ud-find" data-testid="block-find" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a block…" aria-label="Find a block" />}
      </div>
      <div className="ud-cards" role="listbox" aria-label={label}>
        <button type="button" role="option" aria-selected={!value} className={`ud-card${!value ? ' on' : ''}`} onClick={() => onChange('')} data-testid="block-all">
          <span className="ud-name">All blocks</span><b>{total.toLocaleString('en-IN')}</b>
        </button>
        {shown.map((b) => (
          <button key={key(b)} type="button" role="option" aria-selected={value === key(b)} title={title(b)} data-testid="block-card"
            className={`ud-card${value === key(b) ? ' on' : ''}${b.name ? '' : ' none'}`} onClick={() => onChange(value === key(b) ? '' : key(b))}>
            <span className="ud-name">{b.name || 'Not in a block'}</span><b>{b.total.toLocaleString('en-IN')}</b>{bar(b)}
          </button>
        ))}
        {!shown.length && <span className="muted" style={{ padding: 8 }}>No block matches “{find}”.</span>}
      </div>
      {list.some((b) => b.ownerOccupied != null) && <div className="ud-legend muted"><i className="o" /> Owner occupied <i className="t" /> Tenanted <i className="v" /> Vacant</div>}
    </div>
  );
}
