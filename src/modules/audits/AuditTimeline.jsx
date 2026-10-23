import React, { useMemo, useState } from 'react';
import Tabs from '../../components/Tabs.jsx';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const RANK = { Fail: 3, 'Pass with observations': 2, Pending: 1, Pass: 0 };
const COLOR = { Fail: '#e5484d', 'Pass with observations': '#f59e0b', Pending: '#94a3b8', Pass: '#16a34a' };
const SHORT = { Fail: 'F', 'Pass with observations': 'O', Pending: '·', Pass: '✓' };
export const worst = (list) => list.reduce((w, a) => (RANK[a.result] > RANK[w] ? a.result : w), list[0].result);

/**
 * Ten years of audits at a glance. One row per audited area; each cell is a year (or, once a year is picked, a month)
 * coloured by the worst result in that period, with the number of audits in it. Tap a cell to open that area's history
 * for the period, so nothing is ever a long scroll.
 *   Years view   10 columns (the last 10 years that have audits)
 *   Months view  12 columns for the chosen year
 */
export default function AuditTimeline({ audits, onOpen }) {
  const years = useMemo(() => [...new Set(audits.map((a) => String(a.auditDate || '').slice(0, 4)).filter(Boolean))].sort().reverse(), [audits]);
  const [mode, setMode] = useState('years');
  const [year, setYear] = useState('');
  const y = year || years[0] || String(new Date().getFullYear());
  const areas = useMemo(() => [...new Set(audits.map((a) => a.area))].sort(), [audits]);
  const cols = mode === 'years' ? years.slice(0, 10).reverse() : MON.map((m, i) => ({ label: m, key: `${y}-${String(i + 1).padStart(2, '0')}` }));
  const keyOf = (a) => (mode === 'years' ? String(a.auditDate).slice(0, 4) : String(a.auditDate).slice(0, 7));
  const grid = useMemo(() => {
    const m = new Map();
    audits.forEach((a) => { const k = `${a.area}|${keyOf(a)}`; if (!m.has(k)) m.set(k, []); m.get(k).push(a); });
    return m;
  }, [audits, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!audits.length) return <div className="empty">No audits recorded yet.</div>;
  return (
    <div className="card" style={{ marginTop: 10 }} data-testid="audit-timeline">
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <Tabs style={{ margin: 0 }}>
          <button className={mode === 'years' ? 'active' : ''} data-testid="tl-years" onClick={() => setMode('years')}>10 years</button>
          <button className={mode === 'months' ? 'active' : ''} data-testid="tl-months" onClick={() => setMode('months')}>Month by month</button>
        </Tabs>
        {mode === 'months' && <select aria-label="Year" data-testid="tl-year" value={y} onChange={(e) => setYear(e.target.value)} style={{ width: 'auto' }}>{(years.length ? years : [y]).map((v) => <option key={v}>{v}</option>)}</select>}
        <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>
          {Object.keys(COLOR).map((k) => <span key={k} style={{ marginLeft: 8 }}><i style={{ display: 'inline-block', width: 10, height: 10, background: COLOR[k], borderRadius: 2, marginRight: 3 }} />{k === 'Pass with observations' ? 'Observations' : k}</span>)}
        </span>
      </div>
      <div className="tl-wrap">
        <div className="tl-grid" style={{ gridTemplateColumns: `minmax(120px, 1.4fr) repeat(${cols.length}, minmax(0, 1fr))` }} role="table">
          <div className="tl-h" />
          {cols.map((c) => <div key={c.key || c} className="tl-h">{c.label || c}</div>)}
          {areas.map((area) => (
            <React.Fragment key={area}>
              <div className="tl-area" title={area}>{area}</div>
              {cols.map((c) => {
                const k = c.key || c; const list = grid.get(`${area}|${k}`);
                if (!list) return <div key={k} className="tl-cell none" />;
                const w = worst(list);
                return <button key={k} type="button" className="tl-cell" data-testid="tl-cell" style={{ background: COLOR[w] }} title={`${area} · ${c.label || c}: ${list.length} audit${list.length === 1 ? '' : 's'}, worst result ${w}`} aria-label={`${area} ${c.label || c}: ${list.length} audits, ${w}`} onClick={() => onOpen(area, k)}>{list.length > 1 ? list.length : SHORT[w]}</button>;
              })}
            </React.Fragment>
          ))}
        </div>
      </div>
      <small className="muted">{mode === 'years' ? 'Each box is a year; the number shows how many audits were done when there was more than one.' : 'Each box is a month. Tap one to open that area’s audits.'}</small>
    </div>
  );
}
