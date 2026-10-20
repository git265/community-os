import React, { useMemo } from 'react';
import { COND_COLOR, areaRollup } from './infraModel.js';

const dmy = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const today = () => new Date().toISOString().slice(0, 10);

/** One row per area: worst condition, how many items, open tasks, next service and cover running out. Tap a row to see it on the map. */
export default function HealthBoard({ assets, openMap, onShow }) {
  const rows = useMemo(() => areaRollup(assets, openMap), [assets, openMap]);
  const counts = useMemo(() => {
    const c = { Working: 0, 'Needs attention': 0, 'Under repair': 0, 'Out of service': 0 };
    rows.forEach((r) => { if (c[r.worst] !== undefined) c[r.worst] += 1; });
    return c;
  }, [rows]);
  if (!rows.length) return <div className="card muted" data-testid="board-empty">No assets yet. Add them on the map, from the All assets tab, or import a CSV in Plans &amp; layers.</div>;
  return (
    <div data-testid="health-board">
      <div className="infra-board-tiles">
        {Object.entries(counts).map(([k, v]) => (
          <div key={k} className="infra-tile"><span className="dot" style={{ background: COND_COLOR[k] }} /><b>{v}</b><small>{k === 'Working' ? 'areas working' : k.toLowerCase()}</small></div>
        ))}
      </div>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Area</th><th>Condition</th><th>Items</th><th>Open tasks</th><th>Next service</th><th>Cover ending (60 days)</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.area} data-testid={`board-row-${r.area}`} onClick={() => onShow(r.area)} style={{ cursor: 'pointer' }}>
                <td><b>{r.area}</b></td>
                <td><span className="infra-cond"><span className="dot" style={{ background: COND_COLOR[r.worst] }} />{r.worst === 'Standby' ? 'Standby / retired' : r.worst}</span></td>
                <td>{r.units}{r.faulty > 0 && <span className="muted"> · {r.faulty} faulty</span>}</td>
                <td>{r.openTasks > 0 ? <span className="tag blue">{r.openTasks}</span> : <span className="muted">0</span>}</td>
                <td>{r.nextService ? <span className={r.nextService < today() ? 'tag red' : ''}>{dmy(r.nextService)}{r.nextService < today() ? ' · overdue' : ''}</span> : <span className="muted">—</span>}</td>
                <td>{r.warranty > 0 ? <span className="tag amber">{r.warranty}</span> : <span className="muted">—</span>}</td>
                <td className="muted" style={{ textAlign: 'right' }}>Show on map ›</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ fontSize: 12.5 }}>An area shows its worst condition. A group with a few faulty items (for example 3 of 40 street lights) shows amber; coral starts when 30% or more are faulty.</p>
    </div>
  );
}
