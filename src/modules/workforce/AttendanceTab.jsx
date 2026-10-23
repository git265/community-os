import React, { useEffect, useMemo, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import Modal from '../../components/Modal.jsx';
import { hhmm, mapLink, summarise, loadReport } from '../../lib/attendance.js';
import { iso, addDays, weekStart, monthStart, monthEnd } from '../../lib/shifts.js';
import { fmtDate } from '../../lib/locale.js';
import PageActions from '../../components/PageActions.jsx';

const dshort = (s) => fmtDate(s);
function csv(name, rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const keys = Object.keys(rows[0] || {});
  const blob = new Blob([[keys.map(esc).join(','), ...rows.map((r) => keys.map((k) => esc(r[k])).join(','))].join('\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const toIso = (date, t) => (date && /^\d\d:\d\d$/.test(t) ? new Date(`${date}T${t}:00`).toISOString() : '');
const toHM = (v) => (v ? hhmm(v) : '');

function EntryForm({ row, names, onClose }) {
  const { save, remove } = useCollection(C.ATTENDANCE, 'Attendance');
  const [f, setF] = useState({ staffName: row.staffName || '', date: row.date || '', tin: toHM(row.clockIn), tout: toHM(row.clockOut), note: row.note || '' });
  const [err, setErr] = useState('');
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  async function submit(e) {
    e.preventDefault();
    if (!f.staffName.trim() || !f.date) return setErr('Choose the staff member and the date');
    if (!/^\d\d:\d\d$/.test(f.tin)) return setErr('Clock-in time is required (HH:MM)');
    if (f.tout && !/^\d\d:\d\d$/.test(f.tout)) return setErr('Clock-out must be HH:MM');
    if (f.tout && f.tout <= f.tin) return setErr('Clock-out must be after clock-in');
    if (!f.note.trim()) return setErr('Please give the reason (it is kept in the audit trail)');
    const ci = toIso(f.date, f.tin); const co = f.tout ? toIso(f.date, f.tout) : '';
    const out = await save({ ...row, staffName: f.staffName.trim(), date: f.date, clockIn: ci, clockOut: co, hours: co ? Math.round(((new Date(co) - new Date(ci)) / 3600000) * 100) / 100 : 0, note: f.note.trim(), source: row.source || 'Manager entry', inSite: row.inSite || 'Manual entry', roleName: row.roleName || '' });
    if (out) onClose();
  }
  return (
    <Modal title={row.id ? 'Correct attendance' : 'Manual attendance entry'} subtitle="Corrections are audited. The original punch's GPS position is kept." onClose={onClose}>
      <form className="form-grid" onSubmit={submit} data-testid="att-form">
        <div className="field"><label>Staff member *</label><input list="att-names" aria-label="Staff member" value={f.staffName} onChange={(e) => set('staffName', e.target.value)} /><datalist id="att-names">{names.map((n) => <option key={n} value={n} />)}</datalist></div>
        <div className="field"><label>Date *</label><input type="date" aria-label="Date" value={f.date} onChange={(e) => set('date', e.target.value)} /></div>
        <div className="field"><label>Clock in *</label><input type="time" aria-label="Clock in" value={f.tin} onChange={(e) => set('tin', e.target.value)} /></div>
        <div className="field"><label>Clock out</label><input type="time" aria-label="Clock out" value={f.tout} onChange={(e) => set('tout', e.target.value)} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Reason / note *</label><input aria-label="Reason" value={f.note} onChange={(e) => set('note', e.target.value)} placeholder="e.g. Forgot to clock out; confirmed by supervisor" /></div>
        {err && <div className="field-error" style={{ gridColumn: '1 / -1' }}>{err}</div>}
        <div className="form-actions"><button type="submit" className="btn" data-testid="att-save">Save</button>{row.id && <button type="button" className="btn danger" onClick={async () => { if (window.confirm('Delete this attendance entry?')) { await remove(row.id); onClose(); } }}>Delete</button>}<button type="button" className="btn secondary" onClick={onClose}>Cancel</button></div>
      </form>
    </Modal>
  );
}

const Place = ({ site, lat, lng, dist }) => (lat == null ? <span className="muted">{site || 'No location'}</span> : <a href={mapLink(lat, lng)} target="_blank" rel="noreferrer" title={`${lat}, ${lng}`}><span className={`tag ${site === 'Inside site' ? 'green' : site === 'Outside site' ? 'red' : ''}`}>{site}{dist != null ? ` · ${dist} m` : ''}</span></a>);

/** Attendance: staff see their own punches; supervisors and the committee get the report (filters, per-person totals, CSV). */
export default function AttendanceTab() {
  const { roleId } = useApp();
  const p = getPrincipal();
  const manager = roleId === 'super_admin' || p?.role?.permissions?.includes('MANAGE_FIELD_DUTIES') || p?.role?.category === 'EC';
  const canEdit = canWriteCollection(C.ATTENDANCE, p) && (roleId === 'super_admin' || p?.role?.permissions?.includes('MANAGE_FIELD_DUTIES'));
  const { records } = useCollection(C.ATTENDANCE, 'Attendance');
  const { records: crew } = useCollection(C.HANDYMEN, 'Field Staff');
  const today = iso(new Date());
  const [preset, setPreset] = useState('month');
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(today);
  const [who, setWho] = useState('');
  const [flag, setFlag] = useState('');
  const [modal, setModal] = useState(null);
  function applyPreset(k) {
    setPreset(k);
    if (k === 'today') { setFrom(today); setTo(today); } else if (k === 'week') { setFrom(weekStart(today)); setTo(addDays(weekStart(today), 6)); } else if (k === 'month') { setFrom(monthStart(today)); setTo(monthEnd(today)); } else if (k === 'last30') { setFrom(addDays(today, -29)); setTo(today); }
  }
  const names = [...new Set([...records.map((r) => r.staffName), ...crew.map((c) => c.name)])].filter(Boolean).sort();
  // the report: each session with the gate's badge-in / badge-out beside it (built by the server on the back end), reloaded when punches change
  const [lines, setLines] = useState(null); const [loadErr, setLoadErr] = useState('');
  useEffect(() => {
    let live = true;
    loadReport({ from, to, mineOnly: !manager }).then((l) => { if (live) { setLines(l); setLoadErr(''); } }).catch((e) => { if (live) { setLines([]); setLoadErr(e.message || 'The report could not be loaded'); } });
    return () => { live = false; };
  }, [records, from, to, manager]);
  const rows = useMemo(() => (lines || []).filter((r) => (!who || r.staffName === who)
    && (!flag || (flag === 'late' && r.lateMin > 0) || (flag === 'outside' && (r.inSite === 'Outside site' || r.outSite === 'Outside site')) || (flag === 'nogps' && r.inSite === 'Location unavailable') || (flag === 'open' && !r.gateOnly && !r.clockOut)
      || (flag === 'gate' && r.flags?.length > 0) || (flag === 'gateonly' && r.gateOnly))), [lines, who, flag]);
  const sessionsOnly = useMemo(() => rows.filter((r) => !r.gateOnly), [rows]);
  const gateIssues = useMemo(() => rows.reduce((m, r) => (r.flags?.length ? m.set(r.staffName, (m.get(r.staffName) || 0) + 1) : m), new Map()), [rows]);
  const totals = useMemo(() => summarise(sessionsOnly).map((t) => ({ ...t, gate: gateIssues.get(t.name) || 0 })), [sessionsOnly, gateIssues]);
  const anyGate = rows.some((r) => r.gateIn);
  const onDuty = records.filter((r) => !r.clockOut && r.date >= addDays(today, -1));
  const hrs = (r) => (r.gateOnly ? 0 : r.clockOut ? Number(r.hours) || 0 : Math.max(0, (Date.now() - new Date(r.clockIn)) / 3600000));
  const sessionCsv = () => rows.map((r) => ({ Date: r.date, Staff: r.staffName, Role: r.roleName, Shift: r.shiftType, 'Clock in': hhmm(r.clockIn), 'Clock out': hhmm(r.clockOut), Hours: hrs(r).toFixed(2), 'Late (min)': r.lateMin || 0, 'In location': r.inSite, 'In lat': r.inLat, 'In lng': r.inLng, 'In accuracy (m)': r.inAcc, 'Out location': r.outSite, 'Out lat': r.outLat, 'Out lng': r.outLng, 'Gate in': hhmm(r.gateIn), 'Gate out': r.gateInside ? 'inside' : hhmm(r.gateOut), 'Gate hours': r.gateHours ?? '', 'Gate check': (r.flags || []).join('; '), Note: r.note || '' }));

  return (
    <div data-testid="attendance-tab">
      {manager && (
        <div className="card" style={{ marginBottom: 12 }} data-testid="on-duty">
          <b>On duty now ({onDuty.length})</b>
          {onDuty.length === 0 ? <div className="muted">Nobody is clocked in.</div> : <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>{onDuty.map((r) => <span key={r.id} className="tag green">{r.staffName}{r.roleName ? ` (${r.roleName})` : ""} · since {hhmm(r.clockIn)}</span>)}</div>}
        </div>
      )}
      <div className="card">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
          <h3 style={{ margin: 0, flex: 1 }}>{manager ? 'Attendance report' : 'My attendance'}</h3>
          {[['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['last30', 'Last 30 days']].map(([k, l]) => <button key={k} type="button" className={`chip-btn${preset === k ? ' on' : ''}`} onClick={() => applyPreset(k)}>{l}</button>)}
          <input type="date" aria-label="From" value={from} onChange={(e) => { setPreset('custom'); setFrom(e.target.value); }} style={{ width: 'auto' }} />
          <input type="date" aria-label="To" value={to} onChange={(e) => { setPreset('custom'); setTo(e.target.value); }} style={{ width: 'auto' }} />
          {manager && <select aria-label="Person" value={who} onChange={(e) => setWho(e.target.value)} style={{ width: 'auto' }}><option value="">Everyone</option>{names.map((n) => <option key={n}>{n}</option>)}</select>}
          {manager && <select aria-label="Exceptions" value={flag} onChange={(e) => setFlag(e.target.value)} style={{ width: 'auto' }}><option value="">All punches</option><option value="late">Late arrivals</option><option value="outside">Outside the site</option><option value="nogps">No location</option><option value="open">Still clocked in</option><option value="gate">Gate and clock disagree</option><option value="gateonly">At the gate, not clocked in</option></select>}
          <PageActions inline>
          <button type="button" className="btn secondary sm" data-testid="att-csv" disabled={!rows.length} onClick={() => csv(`attendance-${from}-to-${to}.csv`, sessionCsv())}>⬇ CSV</button>
          {manager && <button type="button" className="btn secondary sm" disabled={!totals.length} onClick={() => csv(`attendance-summary-${from}-to-${to}.csv`, totals.map((t) => ({ Staff: t.name, Role: t.role, 'Days present': t.days, Sessions: t.sessions, 'Total hours': t.hours, 'Late arrivals': t.late, 'Outside site': t.outside, 'No location': t.noGps, 'Gate checks': t.gate })))}>⬇ Summary CSV</button>}
          {canEdit && <button type="button" className="btn sm" data-testid="att-add" onClick={() => setModal({ date: today, source: 'Manager entry' })}>+ Manual entry</button>}
          </PageActions>
        </div>

        {manager && totals.length > 0 && (
          <table className="table" data-testid="att-summary" style={{ marginBottom: 12 }}><thead><tr><th>Staff</th><th>Days present</th><th>Total hours</th><th>Late</th><th>Outside site</th><th>No location</th><th>Gate checks</th></tr></thead>
            <tbody>{totals.map((t) => <tr key={t.name}><td data-label="Staff"><b>{t.name}</b><br /><small className="muted">{t.role}</small></td><td data-label="Days">{t.days}</td><td data-label="Hours">{t.hours.toFixed(1)}</td><td data-label="Late">{t.late || '—'}</td><td data-label="Outside">{t.outside || '—'}</td><td data-label="No location">{t.noGps || '—'}</td><td data-label="Gate checks">{t.gate ? <span className="tag orange">{t.gate}</span> : '—'}</td></tr>)}</tbody></table>
        )}

        {loadErr && <div className="field-error" role="alert">{loadErr}</div>}
        {lines === null ? <div className="muted">Loading…</div> : rows.length === 0 ? <div className="empty">No punches in this period.</div> : (
          <table className="table" data-testid="att-rows"><thead><tr><th>Date</th>{manager && <th>Staff</th>}<th>Shift</th><th>In</th><th>Out</th><th>Hours</th><th>Gate in / out</th><th>Clock-in place</th><th>Clock-out place</th>{canEdit && <th />}</tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} data-testid="att-row"><td data-label="Date">{dshort(r.date)}</td>{manager && <td data-label="Staff"><b>{r.staffName}</b></td>}<td data-label="Shift">{r.shiftType || '—'}{r.lateMin > 0 ? <small className="tag orange" style={{ marginLeft: 4 }}>{r.lateMin} min late</small> : null}</td>
                <td data-label="In">{r.gateOnly ? <span className="muted">not clocked in</span> : hhmm(r.clockIn) || '—'}</td><td data-label="Out">{r.gateOnly ? '—' : r.clockOut ? hhmm(r.clockOut) : <span className="tag green">on duty</span>}</td><td data-label="Hours">{r.gateOnly ? '—' : hrs(r).toFixed(2)}</td>
                <td data-label="Gate" data-testid="att-gate">{r.gateIn ? <>{hhmm(r.gateIn)} – {r.gateInside ? <span className="tag green">inside</span> : hhmm(r.gateOut)}{r.gateHours != null ? <small className="muted"> · {Number(r.gateHours).toFixed(1)} h</small> : null}</> : <span className="muted">{anyGate ? 'no badge' : '—'}</span>}
                  {(r.flags || []).map((f) => <div key={f}><small className="tag orange" data-testid="att-flag">{f}</small></div>)}</td>
                <td data-label="In place">{r.gateOnly ? '—' : <Place site={r.inSite} lat={r.inLat} lng={r.inLng} dist={r.inDist} />}</td><td data-label="Out place">{r.clockOut ? <Place site={r.outSite} lat={r.outLat} lng={r.outLng} dist={r.outDist} /> : '—'}</td>
                {canEdit && <td>{!r.gateOnly && <button type="button" className="btn secondary sm" onClick={() => setModal(records.find((x) => x.id === r.id) || r)}>Correct</button>}</td>}</tr>
            ))}</tbody></table>
        )}
      </div>
      {modal && <EntryForm row={modal} names={names} onClose={() => setModal(null)} />}
    </div>
  );
}
