import React, { useEffect, useState } from 'react';
import { secureStorage } from '../lib/storage/secureStorage.js';
import { COLLECTIONS } from '../lib/storage/index.js';
import { specNamesFor, parseSpecs } from '../lib/assets/specs.js';

/**
 * Specifications that fit the kind of asset: the form shows the few that matter for a pump, a street light or a pipe, and
 * "+ Another spec" for anything else. Stored as one JSON object ({ "Power (HP)": "7.5" }) so any kind works without new columns.
 */
export default function SpecsField({ type, value, onChange, editable = true }) {
  const [layers, setLayers] = useState([]);
  const [extra, setExtra] = useState({ k: '', v: '' });
  useEffect(() => { secureStorage.list(COLLECTIONS.INFRA_LAYERS).then(setLayers).catch(() => {}); }, []);
  const specs = parseSpecs(value);
  const { names, source } = specNamesFor(type, layers);
  const own = Object.keys(specs).filter((k) => !names.includes(k));
  const set = (k, v) => { const next = { ...specs, [k]: v }; if (!String(v).trim()) delete next[k]; onChange(JSON.stringify(next)); };
  if (!editable) {
    const rows = Object.entries(specs).filter(([, v]) => String(v).trim());
    return <div className="ro-value">{rows.length ? rows.map(([k, v]) => `${k}: ${v}`).join(' · ') : '—'}</div>;
  }
  return (
    <div data-testid="specs-field">
      <small className="muted" data-testid="specs-source">{type ? `Specifications for ${type}` : 'Choose the type first'}{source === 'generic' ? ' (generic — add what matters)' : source.startsWith('like') ? ` (${source})` : source === 'yours' ? ' (your list)' : ''}</small>
      <div className="specs-grid">
        {[...new Set([...names, ...own])].map((k) => (
          <div key={k} className="spec-cell"><label>{k}</label><input aria-label={k} data-testid="spec-input" value={specs[k] ?? ''} onChange={(e) => set(k, e.target.value)} /></div>
        ))}
      </div>
      <div className="spec-add">
        <input aria-label="Another spec name" data-testid="spec-new-name" placeholder="Another spec, e.g. Warranty class" value={extra.k} onChange={(e) => setExtra({ ...extra, k: e.target.value })} />
        <input aria-label="Another spec value" data-testid="spec-new-value" placeholder="Value" value={extra.v} onChange={(e) => setExtra({ ...extra, v: e.target.value })} />
        <button type="button" className="btn secondary sm" data-testid="spec-add" disabled={!extra.k.trim() || !extra.v.trim()} onClick={() => { set(extra.k.trim(), extra.v.trim()); setExtra({ k: '', v: '' }); }}>Add</button>
      </div>
    </div>
  );
}
