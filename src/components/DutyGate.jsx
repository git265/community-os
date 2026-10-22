import React, { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context/AppContext.jsx';
import ClockCard from './ClockCard.jsx';
import { DUTY_DEFAULTS, dutyState, hhmm, isClockRole, loadSettings, openSession, runDutyWatch, clockOut } from '../lib/attendance.js';

/** Live duty state for the signed-in staff member: the open session, the settings, and the minute-by-minute watch. */
export function useDuty() {
  const { role, currentUser } = useApp();
  const staff = isClockRole(role);
  const [s, setS] = useState({ ready: !staff, open: null, settings: {} });
  const [, tick] = useState(0);
  const load = useCallback(async () => {
    if (!staff) return;
    const [open, settings] = await Promise.all([openSession(), loadSettings()]);
    setS({ ready: true, open, settings });
    return { open, settings };
  }, [staff, currentUser?.name]);
  useEffect(() => { setS({ ready: !staff, open: null, settings: {} }); load(); }, [load, staff]);
  useEffect(() => {
    if (!staff) return undefined;
    const h = () => load();
    window.addEventListener('communityos:changed', h);
    const t = setInterval(async () => { tick((x) => x + 1); const cur = await load(); if (cur?.open) { const r = await runDutyWatch(cur.open, cur.settings); if (r === 'auto') load(); } }, 60000);
    return () => { window.removeEventListener('communityos:changed', h); clearInterval(t); };
  }, [staff, load]);
  const required = staff && s.settings.requireClockIn !== false && DUTY_DEFAULTS.requireClockIn;
  return { ...s, staff, required, locked: staff && s.ready && required && !s.open, state: dutyState(s.open, s.settings), reload: load };
}

/** Full-page lock: staff must clock in before the portal opens. */
export function ClockGate({ onDone }) {
  const { currentUser } = useApp();
  return (
    <div className="clock-gate" data-testid="clock-gate">
      <div className="card" style={{ maxWidth: 520, margin: '0 auto' }}>
        <div style={{ fontSize: 40, textAlign: 'center' }}>🔒</div>
        <h2 style={{ textAlign: 'center', margin: '4px 0' }}>Clock in to start your day</h2>
        <p className="muted" style={{ textAlign: 'center', marginTop: 0 }}>Hi {currentUser?.name?.split(' ')[0] || 'there'} - the portal opens once you have clocked in. Remember to clock out when your shift ends.</p>
        <ClockCard onChange={onDone} />
      </div>
    </div>
  );
}

/** Slim bar shown on every page while on duty: how long, and one tap to clock out. Turns amber/red when the shift is over. */
export function OnDutyBar({ duty }) {
  const { open, state } = duty;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  if (!open) return null;
  const mins = Math.max(0, Math.floor((Date.now() - new Date(open.clockIn)) / 60000));
  const cls = state.key === 'over' ? 'over' : state.key === 'due' ? 'due' : '';
  async function out() {
    setBusy(true); setMsg('');
    try {
      const res = await clockOut(open);
      if (res.blocked) setMsg(res.blocked);
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }
  return (
    <div className={`duty-bar ${cls}`} data-testid="duty-bar" data-state={state.key}>
      <span className="duty-dot" />
      <span className="duty-text">
        On duty since <b>{hhmm(open.clockIn)}</b> · {Math.floor(mins / 60)}h {mins % 60}m
        {state.key === 'due' && <> · <b>shift ended {state.overMin >= 60 ? `${Math.floor(state.overMin / 60)}h ${state.overMin % 60}m` : `${state.overMin} min`} ago</b></>}
        {state.key === 'over' && <> · <b>closing automatically</b></>}
        {msg && <> · {msg}</>}
      </span>
    </div>
  );
}
