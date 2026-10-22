import React, { useEffect, useState } from 'react';
import { onActivity } from '../lib/net/activity.js';

/** The app-wide "it is working" signal: after 1 s of a write or a clicked action, a thin bar and "Working…"; "You are offline" without network. */
export default function ActivityBar() {
  const [n, setN] = useState(0);
  const [since, setSince] = useState(0);
  const [tick, setTick] = useState(0);
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  useEffect(() => onActivity((c) => { setN(c); setSince((s) => (c > 0 ? s || Date.now() : 0)); }), []);
  useEffect(() => {
    const up = () => setOnline(true); const down = () => setOnline(false);
    window.addEventListener('online', up); window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  useEffect(() => { if (!n) return undefined; const t = setInterval(() => setTick((x) => x + 1), 500); return () => clearInterval(t); }, [n]);
  const age = n && since ? Date.now() - since : 0;   // eslint-disable-line no-unused-vars
  void tick;
  return (
    <>
      {!online && <div className="offline-banner" role="status" data-testid="offline">📡 You are offline. Changes cannot be saved until the connection is back.</div>}
      {n > 0 && age >= 1000 && (
        <div className="activity" role="status" aria-live="polite" data-testid="activity">
          <div className="activity-bar" />
          <span className="activity-pill">{age >= 12000 ? 'Still working… the server is slow, please wait' : 'Working…'}</span>
        </div>
      )}
    </>
  );
}
