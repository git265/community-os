import React, { useEffect, useState } from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { ENFORCE, getPosition } from '../../lib/attendance.js';

/** Site location + how strict clock-in is. Supervisors only. */
export default function SiteRulesTab() {
  const { records, save } = useCollection(C.ATTENDANCE_SETTINGS, 'Attendance Settings');
  const row = records[0];
  const [f, setF] = useState({ siteName: '', siteLat: '', siteLng: '', radiusM: 300, enforcement: ENFORCE.record, graceMinutes: 15, requireClockIn: true, maxShiftHours: 12 });
  const [msg, setMsg] = useState('');
  useEffect(() => { if (row) setF((x) => ({ ...x, ...row })); }, [row?.id, row?.recVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  async function here() { setMsg('Getting your location…'); const p = await getPosition(); if (p.error) setMsg(p.error); else { setF((x) => ({ ...x, siteLat: p.lat, siteLng: p.lng })); setMsg(`Site set to your current position (±${p.acc} m). Save to keep it.`); } }
  async function submit(e) {
    e.preventDefault();
    const lat = f.siteLat === '' ? null : Number(f.siteLat); const lng = f.siteLng === '' ? null : Number(f.siteLng);
    if ((lat != null && (lat < -90 || lat > 90)) || (lng != null && (lng < -180 || lng > 180))) return setMsg('Latitude must be -90 to 90 and longitude -180 to 180');
    const out = await save({ ...(row || {}), ...f, siteLat: lat, siteLng: lng, radiusM: Number(f.radiusM) || 300, graceMinutes: Number(f.graceMinutes) || 0, maxShiftHours: Number(f.maxShiftHours) || 12 });
    setMsg(out ? 'Saved.' : '');
  }
  return (
    <form className="card" onSubmit={submit} data-testid="site-rules">
      <h3 style={{ marginTop: 0 }}>Site location & clock-in rules</h3>
      <p className="muted">Each clock-in / clock-out stores the phone’s GPS position. If a site location is set, the punch is flagged <b>Inside site</b> or <b>Outside site</b> by distance.</p>
      <div className="form-grid">
        <div className="field"><label>Site name</label><input aria-label="Site name" value={f.siteName || ''} onChange={(e) => set('siteName', e.target.value)} /></div>
        <div className="field"><label>Allowed radius (metres)</label><input type="number" aria-label="Allowed radius" value={f.radiusM} onChange={(e) => set('radiusM', e.target.value)} /></div>
        <div className="field"><label>Latitude</label><input type="number" step="any" aria-label="Latitude" value={f.siteLat ?? ''} onChange={(e) => set('siteLat', e.target.value)} /></div>
        <div className="field"><label>Longitude</label><input type="number" step="any" aria-label="Longitude" value={f.siteLng ?? ''} onChange={(e) => set('siteLng', e.target.value)} /></div>
        <div className="field"><label>Clock-in rule</label><select aria-label="Clock-in rule" value={f.enforcement} onChange={(e) => set('enforcement', e.target.value)}>{Object.values(ENFORCE).map((o) => <option key={o}>{o}</option>)}</select></div>
        <div className="field"><label>Late after (minutes past shift start)</label><input type="number" aria-label="Grace minutes" value={f.graceMinutes} onChange={(e) => set('graceMinutes', e.target.value)} /></div>
        <div className="field"><label>Staff must clock in to use the portal</label><select aria-label="Require clock-in" data-testid="require-clock-in" value={f.requireClockIn === false ? 'No' : 'Yes'} onChange={(e) => set('requireClockIn', e.target.value === 'Yes')}><option>Yes</option><option>No</option></select></div>
        <div className="field"><label>Close forgotten sessions after (hours)</label><input type="number" min="4" max="24" aria-label="Auto clock-out hours" value={f.maxShiftHours ?? 12} onChange={(e) => set('maxShiftHours', e.target.value)} /></div>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>After the shift ends, staff see an amber bar and get a reminder every 30 minutes; a session still open after the hours above is closed automatically and flagged <b>Auto</b> for correction.</p>
      <div className="form-actions"><button type="button" className="btn secondary" data-testid="use-here" onClick={here}>📍 Use my current location as the site</button><button type="submit" className="btn" data-testid="site-save">Save</button></div>
      {msg && <div className="notice" data-testid="site-msg">{msg}</div>}
    </form>
  );
}
