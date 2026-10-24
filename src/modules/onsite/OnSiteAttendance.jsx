import React, { useMemo, useState } from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { SegTabs } from '../../components/ui.jsx';
import AttendanceTab from '../workforce/AttendanceTab.jsx';
import { Photo, clock } from '../gate/gateUi.jsx';

const COUNTED = ['Inside', 'Exited', 'Auto-closed'];
const ym = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const dayOf = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function download(name, head, rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([[head.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n')], { type: 'text/csv' })), download: name });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** The month's muster of household staff or contractors, from their gate visits: days present, by villa or by contractor. */
function Muster({ who }) {
  const { records: visits } = useCollection(C.GATE_VISITS, 'Gate');
  const [month, setMonth] = useState(ym());
  const kinds = who === 'household' ? ['Maid / cook', 'Driver'] : ['Crew'];
  const today = dayOf(new Date().toISOString());
  const rows = useMemo(() => {
    const by = new Map();
    for (const v of visits) {
      if (!kinds.includes(v.kind) || !COUNTED.includes(v.state) || !v.inAt || dayOf(v.inAt).slice(0, 7) !== month) continue;
      const key = v.personId || `${v.name}|${v.phone}`;
      const r = by.get(key) || { name: v.name, photo: v.photo, kind: v.kind, where: new Set(), days: new Set(), inToday: '', outToday: '', insideNow: false };
      r.days.add(dayOf(v.inAt));
      (who === 'household' ? (v.unit && v.unit !== 'Common area' ? v.unit : '') : v.company) && r.where.add(who === 'household' ? v.unit : v.company);
      if (dayOf(v.inAt) === today) { if (!r.inToday || v.inAt < r.inToday) r.inToday = v.inAt; if (v.outAt && v.outAt > r.outToday) r.outToday = v.outAt; }
      if (v.state === 'Inside') r.insideNow = true;
      by.set(key, r);
    }
    return [...by.values()].map((r) => ({ ...r, where: [...r.where].join(', ') })).sort((a, b) => a.where.localeCompare(b.where) || a.name.localeCompare(b.name));
  }, [visits, month, who]); // eslint-disable-line react-hooks/exhaustive-deps
  const label = who === 'household' ? 'Villa' : 'Contractor';
  return (
    <div className="card" data-testid={`os-muster-${who}`}>
      <div className="toolbar" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <label className="muted" htmlFor={`m-${who}`}>Month</label>
        <input id={`m-${who}`} type="month" value={month} onChange={(e) => setMonth(e.target.value || ym())} style={{ width: 'auto' }} />
        <span className="muted">{rows.length} {who === 'household' ? 'household staff' : 'workers'}</span>
        <button type="button" className="btn secondary" style={{ marginLeft: 'auto' }} disabled={!rows.length}
          onClick={() => download(`muster-${who}-${month}.csv`, ['Name', 'Kind', label, 'Days present', 'In today', 'Out today'], rows.map((r) => [r.name, r.kind, r.where, r.days.size, clock(r.inToday), clock(r.outToday)]))}>Download CSV</button>
      </div>
      {rows.length === 0 && <div className="empty">No {who === 'household' ? 'household staff' : 'contractor workers'} came in this month.</div>}
      {rows.length > 0 && (
        <div className="table-wrap"><table><thead><tr><th></th><th>Name</th><th>{label}</th><th>Days present</th><th className="hide-sm">Today</th></tr></thead><tbody>
          {rows.map((r) => (
            <tr key={r.name + r.where}>
              <td><Photo src={r.photo} name={r.name} size={30} /></td>
              <td><b>{r.name}</b><br /><small className="muted">{r.kind}</small></td>
              <td>{r.where || '—'}</td>
              <td><b>{r.days.size}</b></td>
              <td className="hide-sm">{r.inToday ? `${clock(r.inToday)} – ${r.insideNow ? 'inside' : clock(r.outToday) || '?'}` : '—'}</td>
            </tr>
          ))}
        </tbody></table></div>
      )}
    </div>
  );
}

/** Attendance: staff sessions (from the app and the devices), and the month's muster of household staff and contractors. */
export default function OnSiteAttendance() {
  const [who, setWho] = useState('staff');
  return (
    <div data-testid="onsite-attendance">
      <SegTabs tabs={[{ key: 'staff', label: 'Staff' }, { key: 'household', label: 'Household' }, { key: 'contractors', label: 'Contractors' }]} value={who} onChange={setWho} label="Attendance of" variant="sub" />
      <div style={{ marginTop: 12 }}>
        {who === 'staff' && <AttendanceTab />}
        {who === 'household' && <Muster who="household" />}
        {who === 'contractors' && <Muster who="contractors" />}
      </div>
    </div>
  );
}
