import React, { useMemo, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import { SHIFT_TYPES, shiftTime, iso, addDays, weekStart, monthStart, monthEnd, WEEKDAYS, weekdayIdx, datesIn, effectiveShift, planShifts } from '../../lib/shifts.js';

const clsOf = (k) => SHIFT_TYPES.find((s) => s.key === k)?.cls || '';
const short = (k) => ({ Morning: 'M', Afternoon: 'A', Night: 'N', General: 'G', Off: 'Off' }[k] || k);
const label = (s) => new Date(`${s}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });

function ShiftTag({ type, planned }) {
  return <span className={`tag ${clsOf(type)}`} title={`${type} · ${shiftTime(type)}${planned ? '' : ' (usual shift – not planned yet)'}`} style={planned ? undefined : { opacity: 0.6, fontStyle: 'italic' }}>{short(type)}</span>;
}

/** Staff shift planner: Day / Week / Month views and a bulk "assign" panel (a day, a week, a month or a custom range). */
export default function ShiftsModule({ embedded = false }) {
  const { records: staff } = useCollection(COLLECTIONS.HANDYMEN, 'Field Staff');
  const { records: shifts } = useCollection(COLLECTIONS.SHIFTS, 'Staff Shifts');
  const canPlan = canWriteCollection(COLLECTIONS.SHIFTS, getPrincipal());
  const [view, setView] = useState(() => (typeof window !== 'undefined' && window.innerWidth < 700 ? 'day' : 'week'));
  const [anchor, setAnchor] = useState(iso(new Date()));
  const [trade, setTrade] = useState('');
  const [msg, setMsg] = useState('');
  const [bulk, setBulk] = useState({ ids: [], shiftType: 'Morning', range: 'week', from: iso(new Date()), to: iso(new Date()), days: [0, 1, 2, 3, 4, 5, 6] });

  const byKey = useMemo(() => new Map(shifts.map((r) => [`${r.staffId}|${r.date}`, r])), [shifts]);
  const trades = [...new Set(staff.map((s) => s.trade))];
  const people = staff.filter((s) => !trade || s.trade === trade);

  const range = view === 'day' ? [anchor, anchor] : view === 'week' ? [weekStart(anchor), addDays(weekStart(anchor), 6)] : [monthStart(anchor), monthEnd(anchor)];
  const step = (dir) => {
    if (view === 'day') setAnchor(addDays(anchor, dir));
    else if (view === 'week') setAnchor(addDays(anchor, 7 * dir));
    else { const d = new Date(`${anchor}T00:00:00`); d.setMonth(d.getMonth() + dir, 1); setAnchor(iso(d)); }
  };
  const title = view === 'day' ? new Date(`${anchor}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })
    : view === 'week' ? `${label(range[0])} – ${label(range[1])} ${range[1].slice(0, 4)}`
    : new Date(`${anchor}T00:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  async function setOne(st, date, shiftType) {
    try { await planShifts({ staff: [st], dates: [date], shiftType }); setMsg(`${st.name}: ${shiftType} on ${label(date)}`); } catch (e) { setMsg(e.message); }
  }

  async function applyBulk() {
    const chosen = staff.filter((s) => bulk.ids.includes(s.id));
    if (!chosen.length) { setMsg('Choose at least one staff member.'); return; }
    let from; let to;
    if (bulk.range === 'day') [from, to] = [anchor, anchor];
    else if (bulk.range === 'week') [from, to] = [weekStart(anchor), addDays(weekStart(anchor), 6)];
    else if (bulk.range === 'month') [from, to] = [monthStart(anchor), monthEnd(anchor)];
    else [from, to] = [bulk.from, bulk.to];
    if (!from || !to || to < from) { setMsg('The end date must be on or after the start date.'); return; }
    const dates = datesIn(from, to, bulk.range === 'day' ? [0, 1, 2, 3, 4, 5, 6] : bulk.days);
    if (!dates.length) { setMsg('No days match the weekdays you picked.'); return; }
    try {
      const n = await planShifts({ staff: chosen, dates, shiftType: bulk.shiftType });
      setMsg(`Planned ${bulk.shiftType} for ${chosen.length} staff over ${dates.length} day${dates.length === 1 ? '' : 's'} (${n} entries).`);
    } catch (e) { setMsg(e.message); }
  }

  const toggle = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const days = datesIn(range[0], range[1]);
  const today = iso(new Date());
  const cell = (st, date) => {
    const e = effectiveShift(st, date, byKey);
    return canPlan
      ? <select aria-label={`${st.name} ${date}`} data-testid="shift-cell" value={e.shiftType} onChange={(ev) => setOne(st, date, ev.target.value)} style={{ width: 'auto', padding: '2px 4px', fontSize: 12, opacity: e.planned ? 1 : 0.6 }}>{SHIFT_TYPES.map((s) => <option key={s.key}>{s.key}</option>)}</select>
      : <ShiftTag type={e.shiftType} planned={e.planned} />;
  };
  const countsOn = (date) => {
    const c = {}; people.forEach((st) => { const t = effectiveShift(st, date, byKey).shiftType; c[t] = (c[t] || 0) + 1; }); return c;
  };

  return (
    <div>
      {!embedded && (<div className="page-head"><div><h1>Staff Shifts</h1><p>Plan who works which shift — for a day, a week or a whole month. Days you don’t plan follow each person’s usual shift (shown faded).</p></div></div>)}

      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {['day', 'week', 'month'].map((v) => <button key={v} type="button" data-testid={`view-${v}`} className={`chip-btn${view === v ? ' on' : ''}`} onClick={() => setView(v)}>{v[0].toUpperCase() + v.slice(1)}</button>)}
          <button type="button" className="btn secondary sm" onClick={() => step(-1)} aria-label="Previous">‹</button>
          <b data-testid="shift-title" style={{ minWidth: 160, textAlign: 'center' }}>{title}</b>
          <button type="button" className="btn secondary sm" onClick={() => step(1)} aria-label="Next">›</button>
          <button type="button" className="btn secondary sm" onClick={() => setAnchor(today)}>Today</button>
          <select aria-label="Trade" value={trade} onChange={(e) => setTrade(e.target.value)} style={{ width: 'auto', marginLeft: 'auto' }}>
            <option value="">All trades</option>{trades.map((t) => <option key={t}>{t}</option>)}
          </select>
        </div>
        <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>{SHIFT_TYPES.map((s) => `${short(s.key)} = ${s.key === 'Off' ? 'Day off' : `${s.key} ${s.time}`}`).join(' · ')}</div>
      </div>

      {msg && <div className="notice" data-testid="shift-msg">{msg}</div>}

      <div className="card" style={{ overflowX: 'auto' }}>
        {view === 'day' && (
          <div data-testid="shift-day">
            {SHIFT_TYPES.map((s) => {
              const list = people.filter((st) => effectiveShift(st, anchor, byKey).shiftType === s.key);
              return (
                <div key={s.key} style={{ marginBottom: 12 }}>
                  <h3 style={{ margin: '0 0 6px' }}><span className={`tag ${s.cls}`}>{s.key}</span> <small className="muted">{s.time} · {list.length} staff</small></h3>
                  {list.length === 0 ? <div className="muted">Nobody.</div> : (
                    <ul className="list">{list.map((st) => (
                      <li key={st.id}><span style={{ flex: 1 }}><b>{st.name}</b> <small className="muted">{st.trade}</small>{!effectiveShift(st, anchor, byKey).planned && <small className="muted"> · usual shift</small>}</span>{cell(st, anchor)}</li>
                    ))}</ul>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {view === 'week' && (
          <table className="table" data-keep data-testid="shift-week">
            <thead><tr><th>Staff</th>{days.map((d) => <th key={d} style={d === today ? { color: 'var(--blue)' } : undefined}>{WEEKDAYS[weekdayIdx(d)]}<br /><small>{label(d)}</small></th>)}</tr></thead>
            <tbody>
              {people.map((st) => (<tr key={st.id}><td data-label="Staff"><b>{st.name}</b><br /><small className="muted">{st.trade}</small></td>{days.map((d) => <td key={d} data-label={`${WEEKDAYS[weekdayIdx(d)]} ${label(d)}`}>{cell(st, d)}</td>)}</tr>))}
              {!people.length && <tr><td colSpan={8} className="muted">No staff.</td></tr>}
            </tbody>
          </table>
        )}

        {view === 'month' && (
          <div data-testid="shift-month">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(70px, 1fr))', gap: 4 }}>
              {WEEKDAYS.map((w) => <b key={w} className="muted" style={{ textAlign: 'center' }}>{w}</b>)}
              {Array.from({ length: weekdayIdx(range[0]) }).map((_, i) => <div key={`b${i}`} />)}
              {days.map((d) => {
                const c = countsOn(d);
                return (
                  <button type="button" key={d} data-testid={`month-day-${d}`} onClick={() => { setAnchor(d); setView('day'); }} className="card" style={{ padding: 6, textAlign: 'left', border: d === today ? '2px solid var(--blue)' : undefined }}>
                    <b>{Number(d.slice(8))}</b>
                    <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap', marginTop: 2 }}>{SHIFT_TYPES.filter((s) => c[s.key]).map((s) => <span key={s.key} className={`tag ${s.cls}`} style={{ fontSize: 10 }}>{short(s.key)} {c[s.key]}</span>)}</div>
                  </button>
                );
              })}
            </div>
            <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>Click a day to see and change who works it.</div>
          </div>
        )}
      </div>

      {canPlan && (
        <div className="card" style={{ marginTop: 12 }} data-testid="shift-bulk">
          <h2 style={{ marginTop: 0 }}>Assign shifts in bulk</h2>
          <div className="field"><label>Staff</label>
            <div className="chip-row">
              <button type="button" className="chip-btn" onClick={() => setBulk({ ...bulk, ids: people.map((s) => s.id) })}>Select all shown</button>
              {people.map((s) => <label key={s.id} className={`chip-btn${bulk.ids.includes(s.id) ? ' on' : ''}`}><input type="checkbox" style={{ display: 'none' }} checked={bulk.ids.includes(s.id)} onChange={() => setBulk({ ...bulk, ids: toggle(bulk.ids, s.id) })} />{s.name}</label>)}
            </div>
          </div>
          <div className="form-grid">
            <div className="field"><label>Shift</label><select aria-label="Bulk shift" value={bulk.shiftType} onChange={(e) => setBulk({ ...bulk, shiftType: e.target.value })}>{SHIFT_TYPES.map((s) => <option key={s.key}>{s.key}</option>)}</select></div>
            <div className="field"><label>For</label>
              <select aria-label="Bulk range" value={bulk.range} onChange={(e) => setBulk({ ...bulk, range: e.target.value })}>
                <option value="day">The day shown ({label(anchor)})</option>
                <option value="week">The week shown ({label(weekStart(anchor))} – {label(addDays(weekStart(anchor), 6))})</option>
                <option value="month">The month shown</option>
                <option value="custom">A custom date range</option>
              </select>
            </div>
            {bulk.range === 'custom' && <>
              <div className="field"><label>From</label><input type="date" aria-label="Bulk from" value={bulk.from} onChange={(e) => setBulk({ ...bulk, from: e.target.value })} /></div>
              <div className="field"><label>To</label><input type="date" aria-label="Bulk to" value={bulk.to} onChange={(e) => setBulk({ ...bulk, to: e.target.value })} /></div>
            </>}
          </div>
          {bulk.range !== 'day' && (
            <div className="field"><label>On these weekdays</label>
              <div className="chip-row">{WEEKDAYS.map((w, i) => <label key={w} className={`chip-btn${bulk.days.includes(i) ? ' on' : ''}`}><input type="checkbox" style={{ display: 'none' }} checked={bulk.days.includes(i)} onChange={() => setBulk({ ...bulk, days: toggle(bulk.days, i) })} />{w}</label>)}</div>
            </div>
          )}
          <button type="button" className="btn" data-testid="shift-apply" onClick={applyBulk}>Apply</button>
        </div>
      )}
    </div>
  );
}
