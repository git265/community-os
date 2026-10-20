import React, { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context/AppContext.jsx';
import { secureStorage } from '../lib/storage/secureStorage.js';
import { COLLECTIONS as C } from '../lib/storage/StorageAdapter.js';
import { clockIn, clockOut, hhmm, localDate, mapLink } from '../lib/attendance.js';

/** Clock in / clock out for staff roles, with GPS. Compact = the small status line used in the page header. */
export default function ClockCard({ onChange }) {
  const { currentUser } = useApp();
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [tick, setTick] = useState(0);
  const load = useCallback(async () => {
    const all = await secureStorage.list(C.ATTENDANCE).catch(() => []);
    setRows(all.filter((r) => r.staffName === currentUser?.name && r.date >= localDate(new Date(Date.now() - 86400000))).sort((a, b) => String(a.clockIn).localeCompare(String(b.clockIn))));
  }, [currentUser?.name]);
  useEffect(() => { load(); const h = () => load(); window.addEventListener('communityos:changed', h); const t = setInterval(() => setTick((x) => x + 1), 30000); return () => { window.removeEventListener('communityos:changed', h); clearInterval(t); }; }, [load]);

  const open = [...rows].reverse().find((r) => !r.clockOut);
  const today = rows.filter((r) => r.date === localDate());
  const hoursToday = today.reduce((s, r) => s + (r.clockOut ? Number(r.hours) || 0 : (Date.now() - new Date(r.clockIn)) / 3600000), 0);
  const since = open ? Math.max(0, Math.floor((Date.now() - new Date(open.clockIn)) / 60000)) : 0;

  async function go() {
    setBusy(true); setMsg('Getting your location…');
    try {
      const res = open ? await clockOut(open) : await clockIn();
      if (res.blocked) { setMsg(res.blocked); return; }
      const where = res.pos?.error ? `${res.pos.error} — recorded without location.` : `Location recorded (±${res.pos.acc} m) · ${res.chk.site}${res.chk.dist != null ? `, ${res.chk.dist} m from the site` : ''}.`;
      setMsg(`${open ? 'Clocked out' : 'Clocked in'} at ${hhmm(new Date().toISOString())}. ${where}`);
      await load(); onChange?.();
    } catch (e) { setMsg(e.message || 'Could not record the punch'); } finally { setBusy(false); }
  }
  void tick;
  return (
    <div className="card" data-testid="clock-card" style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>⏱ Attendance</div>
          <div className="muted" data-testid="clock-status">{open ? <>On duty since <b>{hhmm(open.clockIn)}</b> · {Math.floor(since / 60)}h {since % 60}m</> : 'Not clocked in'} · today {hoursToday.toFixed(1)} h</div>
          {open?.inLat != null && <small className="muted">Clock-in position: <a href={mapLink(open.inLat, open.inLng)} target="_blank" rel="noreferrer">{open.inLat}, {open.inLng}</a> · {open.inSite}{open.lateMin > 0 ? ` · ${open.lateMin} min late` : ''}</small>}
          {open && open.inLat == null && <small className="muted">Clocked in without a location{open.note ? ` (${open.note})` : ''}.</small>}
        </div>
        <button type="button" className={`btn ${open ? 'danger' : 'good'}`} style={{ minWidth: 150, padding: '12px 18px', fontSize: 16 }} disabled={busy} data-testid={open ? 'clock-out' : 'clock-in'} onClick={go}>{busy ? 'Please wait…' : open ? '■ Clock out' : '▶ Clock in'}</button>
      </div>
      {msg && <div className="notice" style={{ marginTop: 8 }} data-testid="clock-msg">{msg}</div>}
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Your position is read only when you tap the button — it is not tracked in the background.</div>
    </div>
  );
}
