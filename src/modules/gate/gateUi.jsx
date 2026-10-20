import React, { useEffect, useRef, useState } from 'react';
import { avatar, fileToPhoto } from '../../lib/gate/photo.js';

export const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
export const stamp = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
export const sameDay = (iso, d = new Date()) => !!iso && new Date(iso).toDateString() === d.toDateString();
export const TONE = { Active: 'green', Inside: 'green', Exited: '', 'Auto-closed': '', Approved: 'green', Closed: '', 'Awaiting approval': 'orange', Pending: 'orange', Watching: 'orange', 'Under review': 'blue', 'Documents pending': 'orange', Invited: 'blue', Open: 'coral', Denied: 'coral', Refused: 'coral', Blocked: 'coral', Suspended: 'coral', 'No answer': 'coral', 'Left at gate': 'blue' };
export function StateTag({ state }) { const t = TONE[state] ?? ''; return <span className={`tag ${t === 'coral' ? 'gg-tag-coral' : t}`}>{state}</span>; }

/** A person's photo, or a coloured stand-in when there is none. */
export function Photo({ src, name, size = 44, round = false }) {
  return <img className={`gg-photo${round ? ' round' : ''}`} width={size} height={size} src={src || avatar(name || '?')} alt={name ? `Photo of ${name}` : 'Photo'} />;
}

/** Take or pick a photo (camera on a phone). `demoName` adds a "Use a sample photo" button so the flow can be tried without a camera. */
export function PhotoCapture({ value, onChange, label = 'Photo', demoName = '', testid = 'photo-input', required = false }) {
  const ref = useRef(null); const [err, setErr] = useState('');
  async function pick(e) {
    const f = e.target.files?.[0]; if (!f) return;
    try { setErr(''); onChange(await fileToPhoto(f)); } catch (x) { setErr(x.message); }
  }
  return (
    <div className="field" style={{ gridColumn: '1 / -1' }}>
      <label>{label}{required ? ' *' : ''}</label>
      <div className="gg-row">
        {value ? <img className="gg-photo gg-big" src={value} alt="Captured" /> : <div className="gg-photo gg-big" style={{ display: 'grid', placeItems: 'center', color: '#9aa3b2' }}>No photo</div>}
        <div>
          <input ref={ref} type="file" accept="image/*" capture="environment" data-testid={testid} onChange={pick} style={{ display: 'none' }} />
          <button type="button" className="btn secondary" onClick={() => ref.current?.click()}>📷 {value ? 'Retake' : 'Take photo'}</button>{' '}
          {demoName && <button type="button" className="btn secondary" data-testid={`${testid}-sample`} onClick={() => onChange(avatar(demoName, 3))}>Use sample photo</button>}
          {value && <button type="button" className="link-btn" style={{ marginLeft: 8 }} onClick={() => onChange('')}>Remove</button>}
          {err && <div className="field-error">{err}</div>}
        </div>
      </div>
    </div>
  );
}

/** Re-render every second (countdowns). */
export function useTick(ms = 1000) { const [, set] = useState(0); useEffect(() => { const t = setInterval(() => set((n) => n + 1), ms); return () => clearInterval(t); }, [ms]); }
export function Countdown({ until }) {
  useTick();
  const s = Math.round((new Date(until).getTime() - Date.now()) / 1000);
  if (!until) return null;
  if (s <= 0) return <span className="muted">time is up</span>;
  return <span>{s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`} left</span>;
}
export function Chips({ options, value, onChange, multi = false, label }) {
  const on = (o) => (multi ? (value || []).includes(o) : value === o);
  const click = (o) => onChange(multi ? (on(o) ? value.filter((x) => x !== o) : [...(value || []), o]) : o);
  return <div className="gg-chips" role="group" aria-label={label}>{options.map((o) => <button type="button" key={o} className={on(o) ? 'on' : ''} aria-pressed={on(o)} onClick={() => click(o)}>{o}</button>)}</div>;
}
export function Kpi({ label, value, warn, sub, short }) { return <div className={`gg-kpi${warn ? ' warn' : ''}`}><span className="muted">{short ? <><span className="hide-sm">{label}</span><span className="show-sm">{short}</span></> : label}</span><b>{value}</b>{sub && <small className="muted">{sub}</small>}</div>; }
