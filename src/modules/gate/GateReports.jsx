import React, { useMemo, useState } from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { Kpi, sameDay } from './gateUi.jsx';
import { dur } from './GateVisits.jsx';
import { expiring } from './GateRegistry.jsx';

const mins = (a, b) => (a && b ? Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000)) : 0);
export default function GateReports() {
  const { records: visits } = useCollection(COLLECTIONS.GATE_VISITS, 'Gate');
  const { records: flags } = useCollection(COLLECTIONS.GATE_FLAGS, 'Gate');
  const { records: approvals } = useCollection(COLLECTIONS.GATE_APPROVALS, 'Gate');
  const { records: people } = useCollection(COLLECTIONS.GATE_PEOPLE, 'Gate');
  const [range, setRange] = useState('today');
  const inRange = (iso) => range === 'all' || (range === 'today' ? sameDay(iso) : Date.now() - new Date(iso).getTime() <= Number(range) * 86400000);
  const r = useMemo(() => {
    const vs = visits.filter((v) => inRange(v.inAt)); const entered = vs.filter((v) => ['Inside', 'Exited', 'Auto-closed'].includes(v.state));
    const byKind = Object.entries(entered.reduce((m, v) => ({ ...m, [v.kind]: (m[v.kind] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1]);
    const fs = flags.filter((f) => inRange(f.raisedAt)); const aps = approvals.filter((a) => inRange(a.requestedAt));
    const answered = aps.filter((a) => a.answeredAt && a.answeredBy && !/^Automatic/.test(a.answeredBy));
    const avg = answered.length ? Math.round(answered.reduce((s, a) => s + (new Date(a.answeredAt) - new Date(a.requestedAt)) / 1000, 0) / answered.length) : null;
    const hours = Object.values(entered.filter((v) => ['Maid / cook', 'Driver', 'Crew'].includes(v.kind) && v.outAt).reduce((m, v) => { const k = v.personId || v.name; m[k] = m[k] || { name: v.name, kind: v.kind, company: v.company, m: 0, days: new Set() }; m[k].m += mins(v.inAt, v.outAt); m[k].days.add(new Date(v.inAt).toDateString()); return m; }, {})).sort((a, b) => b.m - a.m);
    const deliveries = Object.entries(vs.filter((v) => v.kind === 'Delivery').reduce((m, v) => ({ ...m, [v.company || 'Other']: (m[v.company || 'Other'] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1]);
    const byFlag = Object.entries(fs.reduce((m, f) => ({ ...m, [f.type]: (m[f.type] || 0) + 1 }), {}));
    return { vs, entered, byKind, fs, aps, answered, avg, hours, deliveries, byFlag };
  }, [visits, flags, approvals, range]); // eslint-disable-line react-hooks/exhaustive-deps
  const noAns = r.aps.filter((a) => a.status === 'No answer' || /^Automatic/.test(a.answeredBy || '')).length;
  const overrides = r.vs.filter((v) => v.method === 'Override').length;
  return (
    <div data-testid="gate-reports">
      <div className="gg-row" style={{ marginBottom: 12 }}><select aria-label="Period" value={range} onChange={(e) => setRange(e.target.value)} style={{ width: 'auto' }}><option value="today">Today</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="all">All time</option></select></div>
      <div className="gg-kpis">
        <Kpi label="Entries" value={r.entered.length} sub={`${r.vs.filter((v) => v.state === 'Inside').length} still inside`} />
        <Kpi label="Overrides" value={overrides} warn={overrides > 0} />
        <Kpi label="Ghost flags" value={r.fs.length} sub={`${r.fs.filter((f) => f.state !== 'Closed').length} not closed`} warn={r.fs.some((f) => f.state !== 'Closed')} />
        <Kpi label="Median approval time" value={r.avg == null ? '—' : `${r.avg} s`} sub={`${r.aps.length} asked · ${noAns} unanswered`} />
      </div>
      <div className="gg-grid2">
        <div className="card"><h3 style={{ marginTop: 0 }}>Entries by kind</h3>{r.byKind.length === 0 ? <div className="empty">No entries in this period.</div> : <table><tbody>{r.byKind.map(([k, n]) => <tr key={k}><td>{k}</td><td style={{ width: 60 }}><b>{n}</b></td></tr>)}</tbody></table>}
          <h3>Deliveries by company</h3>{r.deliveries.length === 0 ? <div className="empty">None.</div> : <table><tbody>{r.deliveries.map(([k, n]) => <tr key={k}><td>{k}</td><td style={{ width: 60 }}><b>{n}</b></td></tr>)}</tbody></table>}
          <h3>Flags by type</h3>{r.byFlag.length === 0 ? <div className="empty">None.</div> : <table><tbody>{r.byFlag.map(([k, n]) => <tr key={k}><td>{k}</td><td style={{ width: 60 }}><b>{n}</b></td></tr>)}</tbody></table>}
        </div>
        <div className="card"><h3 style={{ marginTop: 0 }}>Hours on site (maids, drivers, crews)</h3>
          {r.hours.length === 0 ? <div className="empty">No completed visits yet.</div> : <table data-testid="hours-table"><thead><tr><th>Who</th><th>Days</th><th>Time</th></tr></thead><tbody>{r.hours.map((h) => <tr key={h.name}><td><b>{h.name}</b><br /><small className="muted">{h.company || h.kind}</small></td><td>{h.days.size}</td><td>{dur(h.m)}</td></tr>)}</tbody></table>}
          <h3>Vetting health</h3>
          <table><tbody>
            <tr><td>Active people</td><td><b>{people.filter((p) => p.status === 'Active').length}</b></td></tr>
            <tr><td>In the vetting queue</td><td><b>{people.filter((p) => ['Documents pending', 'Under review'].includes(p.status)).length}</b></td></tr>
            <tr><td>Police certificate expiring in 30 days</td><td><b>{people.filter(expiring).length}</b></td></tr>
            <tr><td>Suspended or blocked</td><td><b>{people.filter((p) => ['Suspended', 'Blocked'].includes(p.status)).length}</b></td></tr>
          </tbody></table>
        </div>
      </div>
    </div>
  );
}
