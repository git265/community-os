import React, { useMemo, useState } from 'react';

/** Expands "135, 140-145, A-1204" against the known units. Returns { units, unknown }. */
export function parseUnitList(text, known, kind) {
  const names = new Set(known);
  const prefix = kind === 'Villa' ? 'Villa ' : '';
  const units = []; const unknown = [];
  for (const raw of String(text || '').split(/[,\n;]+/).map((s) => s.trim()).filter(Boolean)) {
    const range = /^(?:villa\s*)?(\d+)\s*[-–to]+\s*(\d+)$/i.exec(raw);
    if (range && kind === 'Villa') {
      const a = Number(range[1]); const b = Number(range[2]);
      for (let n = Math.min(a, b); n <= Math.max(a, b); n++) { const u = `${prefix}${n}`; (names.has(u) ? units : unknown).push(u); }
      continue;
    }
    const cand = /^\d+$/.test(raw) ? `${prefix}${raw}` : (known.find((k) => k.toLowerCase() === raw.toLowerCase()) || raw);
    (names.has(cand) ? units : unknown).push(cand);
  }
  return { units: [...new Set(units)], unknown: [...new Set(unknown)] };
}

/**
 * Picks the units an announcement goes to. Three ways in: tick units from the searchable list, tick a whole zone / tower at
 * once, or paste a list / range such as "135, 140-150".
 */
export default function AudiencePicker({ kind, properties, value, onChange }) {
  const all = useMemo(() => properties.filter((p) => p.type === kind).sort((a, b) => String(a.unit).localeCompare(String(b.unit), undefined, { numeric: true })), [properties, kind]);
  const [q, setQ] = useState('');
  const [zone, setZone] = useState('');
  const [paste, setPaste] = useState('');
  const [note, setNote] = useState('');
  const [limit, setLimit] = useState(300); // a community of thousands of units: draw the list a screenful at a time
  const zones = [...new Set(all.map((p) => p.zone).filter(Boolean))].sort();
  const shown = all.filter((p) => (!zone || p.zone === zone) && (!q || `${p.unit} ${p.owner || ''}`.toLowerCase().includes(q.toLowerCase())));
  const sel = new Set(value);
  const toggle = (u) => onChange(sel.has(u) ? value.filter((x) => x !== u) : [...value, u]);
  const addMany = (units) => onChange([...new Set([...value, ...units])]);
  const noun = kind === 'Villa' ? 'villas' : kind === 'Apartment' ? 'apartments' : `${String(kind).toLowerCase()} units`;

  function applyPaste() {
    const { units, unknown } = parseUnitList(paste, all.map((p) => p.unit), kind);
    addMany(units);
    setNote(`${units.length} added${unknown.length ? ` · not found: ${unknown.slice(0, 6).join(', ')}${unknown.length > 6 ? '…' : ''}` : ''}`);
    if (!unknown.length) setPaste('');
  }

  return (
    <div className="card" style={{ padding: 12, marginTop: 10 }} data-testid="audience-picker">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
        <b>Choose {noun} <span className="muted" style={{ fontWeight: 400 }}>· {value.length} selected</span></b>
        <span style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn secondary sm" onClick={() => addMany(shown.map((p) => p.unit))}>Select shown ({shown.length})</button>
          <button type="button" className="btn secondary sm" disabled={!value.length} onClick={() => onChange([])}>Clear</button>
        </span>
      </div>
      <div className="form-grid" style={{ marginTop: 8 }}>
        <div className="field"><label>Search</label><input aria-label={`Search ${noun}`} value={q} placeholder={kind === 'Villa' ? 'Villa number or owner' : 'Flat or owner'} onChange={(e) => setQ(e.target.value)} /></div>
        {zones.length > 0 && (
          <div className="field"><label>{kind === 'Villa' ? 'Zone' : 'Tower / block'}</label>
            <select aria-label="Zone filter" value={zone} onChange={(e) => setZone(e.target.value)}><option value="">All</option>{zones.map((z) => <option key={z}>{z}</option>)}</select>
          </div>
        )}
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Or type / paste a list</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input aria-label="Paste unit list" value={paste} placeholder={kind === 'Villa' ? 'e.g. 12, 35, 135-150' : 'e.g. A-1204, B-0302'} onChange={(e) => setPaste(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyPaste(); } }} />
            <button type="button" className="btn secondary" onClick={applyPaste}>Add</button>
          </div>
          {note && <small className="muted">{note}</small>}
        </div>
      </div>
      <div style={{ maxHeight: 180, overflow: 'auto', marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {shown.slice(0, limit).map((p) => (
          <label key={p.unit} className={`chip-btn${sel.has(p.unit) ? ' on' : ''}`} title={p.owner}>
            <input type="checkbox" aria-label={p.unit} checked={sel.has(p.unit)} onChange={() => toggle(p.unit)} style={{ display: 'none' }} />{p.unit.replace(/^Villa /, '')}
          </label>
        ))}
        {shown.length > limit && <button type="button" className="btn secondary sm" data-testid="picker-more" onClick={() => setLimit((l) => l + 500)}>Show more ({shown.length - limit} left)</button>}
        {shown.length === 0 && <small className="muted">No {noun} match.</small>}
      </div>
      {value.length > 0 && (
        <div style={{ marginTop: 8 }}><small className="muted">Selected: {value.slice(0, 20).map((u) => u.replace(/^Villa /, '')).join(', ')}{value.length > 20 ? ` … +${value.length - 20} more` : ''}</small></div>
      )}
    </div>
  );
}
