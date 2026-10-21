import React, { useState } from 'react';
import Modal from './Modal.jsx';
import { getDataSource, setDataSource, pingBackend } from '../lib/storage/dataSource.js';
import { copyCommunity } from '../lib/storage/migrate.js';
import { getCommunity } from '../lib/community.js';
import { apiFetch } from '../lib/net/request.js';

/** Development server only: how the simulated payment service answers (normal / slow / down) and whether the bank refuses refunds. */
function SimulatedBank() {
  const [m, setM] = useState(null);
  const [err, setErr] = useState('');
  const call = async (init) => {
    setErr('');
    try {
      const res = await apiFetch('/v1/dev/simulated-bank', init ? { ...init, headers: { 'Content-Type': 'application/json' } } : {});
      if (res.status === 404) { setM('none'); return; }   // not a development server: nothing to show
      if (!res.ok) { setErr(res.status === 401 ? 'Sign in to change the simulated bank.' : `The server answered ${res.status}.`); return; }
      setM(await res.json());
    } catch (e) { setErr(e.message); }
  };
  React.useEffect(() => { call(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  const put = (patch) => call({ method: 'PUT', body: JSON.stringify(patch) });
  if (m === 'none') return null;
  return (
    <div style={{ marginTop: 10 }} data-testid="sim-bank">
      <div className="muted" style={{ marginBottom: 6 }}>Simulated payment service (development)</div>
      {m && (
        <div className="form-actions" style={{ alignItems: 'center' }}>
          <select value={m.service} onChange={(e) => put({ service: e.target.value })} data-testid="sim-bank-service" style={{ width: 'auto' }}>
            <option value="normal">Answers normally</option>
            <option value="slow">Slow ({m.slowSeconds} s a call)</option>
            <option value="down">Down (not answering)</option>
          </select>
          <label className="gg-row" style={{ gap: 6 }}><input type="checkbox" checked={!!m.refundsFail} onChange={(e) => put({ refundsFail: e.target.checked })} data-testid="sim-bank-refunds" style={{ width: 'auto' }} /> Bank refuses refunds</label>
        </div>
      )}
      {m && <small className="muted" style={{ display: 'block', marginTop: 4 }}>Slow bank charges after {m.pendingSeconds} s · lost confirmation settles after {m.lostSeconds} s · refunds finish after {m.refundSeconds} s</small>}
      {err && <small className="muted" data-testid="sim-bank-error">{err}</small>}
    </div>
  );
}

const show = () => import.meta.env.DEV || import.meta.env.VITE_SHOW_DATA_SOURCE === 'true' || getDataSource().mode !== 'session';

/** Where the data lives: the browser demo store or the Spring Boot + PostgreSQL back end. Flip, test, copy data across. */
export function DataSourcePanel({ onClose }) {
  const cur = getDataSource();
  const [mode, setMode] = useState(cur.mode);
  const [url, setUrl] = useState(cur.baseUrl);
  const [token, setToken] = useState(cur.token);
  const [health, setHealth] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState('');

  async function test() {
    setBusy('test'); setErr(''); setHealth(null);
    try { setHealth(await pingBackend(url, token, mode)); } catch (e) { setErr(e.message); }
    setBusy('');
  }
  function apply() {
    setDataSource({ mode, baseUrl: url, token });
    window.location.reload();
  }
  async function copy(from, to) {
    const label = from === 'session' ? 'this browser’s demo data into the back end' : 'the back end’s data into this browser';
    if (!window.confirm(`Copy ${label}?\n\nExisting rows of "${getCommunity()}" in the target are replaced.`)) return;
    setBusy('copy'); setErr('');
    const keep = getDataSource();
    try {
      setDataSource({ baseUrl: url, token }); // the adapters read the address from settings
      const r = await copyCommunity(from, to, { slug: getCommunity(), onProgress: (d, t, n) => setProgress(n ? `${d + 1}/${t} · ${n}` : 'Done') });
      setProgress(`Copied ${r.rows} rows from ${r.collections} collections.`);
    } catch (e) { setErr(e.message); setProgress(''); }
    setDataSource(keep);
    setBusy('');
  }

  return (
    <Modal title="Data source" subtitle="Where this app reads and writes its data. Switching reloads the app." onClose={onClose}>
      <div data-testid="ds-panel">
        <label className="gg-row"><input type="radio" name="ds" data-testid="ds-mode-session" checked={mode === 'session'} onChange={() => setMode('session')} style={{ width: 'auto' }} /> <span><b>Browser session</b> <span className="muted">· demo data in this tab, nothing to install, resets when the tab closes</span></span></label>
        <label className="gg-row"><input type="radio" name="ds" data-testid="ds-mode-api" checked={mode === 'api'} onChange={() => setMode('api')} style={{ width: 'auto' }} /> <span><b>Back end (old API)</b> <span className="muted">· the earlier /api contract (backend/contract-server); not the Spring Boot API in backend/api</span></span></label>
        <label className="gg-row"><input type="radio" name="ds" data-testid="ds-mode-v2" checked={mode === 'v2'} onChange={() => setMode('v2')} style={{ width: 'auto' }} /> <span><b>Back end v2</b> <span className="muted">· Spring Boot + PostgreSQL (backend/api, /api/v1): every module, demo sign-in in dev</span></span></label>
        <div className="form-grid" style={{ marginTop: 10, opacity: mode !== 'session' ? 1 : 0.6 }}>
          <div className="field"><label>Back end address</label><input data-testid="ds-url" value={url} onChange={(e) => { setUrl(e.target.value); setHealth(null); }} placeholder="/api or https://api.example.com/api" /></div>
          <div className="field"><label>Access key (optional)</label><input data-testid="ds-token" type="password" value={token} onChange={(e) => { setToken(e.target.value); setHealth(null); }} placeholder="only if the server asks for one" autoComplete="off" /></div>
        </div>
        <div className="form-actions" style={{ marginTop: 6 }}>
          <button type="button" className="btn secondary" data-testid="ds-test" disabled={!!busy} onClick={test}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
        </div>
        {err && <div className="notice error" role="alert" data-testid="ds-error">{err}</div>}
        {health && (
          <div className="notice" role="status" data-testid="ds-status">
            {health.api === 'v2' ? <>Connected · API <b>v2</b></> : <>Connected · database <b>{health.database}</b> · version {health.version}</>}
            <div className="muted" style={{ marginTop: 4 }}>{Object.entries(health.providers || {}).map(([k, v]) => `${k}: ${v}`).join(' · ')}</div>
          </div>
        )}
        {health && mode === 'v2' && <SimulatedBank />}
        {health && mode === 'v2' && (
          <small className="muted" style={{ display: 'block', marginTop: 10 }} data-testid="ds-v2-data">
            The v2 server keeps its own data; browser data is not copied into it. In development it loads the demo community itself
            (the <code>demo</code> step in Docker, or <code>POST /api/v1/demo/load/{getCommunity()}</code>).
          </small>
        )}
        {health && mode === 'api' && (
          <div style={{ marginTop: 10 }}>
            <div className="muted" style={{ marginBottom: 6 }}>Move data for “{getCommunity()}”</div>
            <div className="form-actions">
              <button type="button" className="btn secondary sm" data-testid="ds-push" disabled={!!busy} onClick={() => copy('session', 'api')}>Browser → back end</button>
              <button type="button" className="btn secondary sm" data-testid="ds-pull" disabled={!!busy} onClick={() => copy('api', 'session')}>Back end → browser</button>
            </div>
            <small className="muted" style={{ display: 'block', marginTop: 6 }}>Records and uploaded files live only in the source they were created in. Anything you added in the browser is gone when the tab closes unless you copy it to the back end first.</small>
            {progress && <small className="muted" data-testid="ds-progress" role="status">{progress}</small>}
          </div>
        )}
        <div className="form-actions" style={{ marginTop: 14 }}>
          <button type="button" className="btn" data-testid="ds-apply" disabled={!!busy || (mode !== 'session' && !health)} onClick={apply}>{mode === cur.mode && url === cur.baseUrl && token === cur.token ? 'Reload' : 'Use this and reload'}</button>
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
        </div>
        {mode !== 'session' && !health && <small className="muted">Test the connection first, so the app never reloads onto a back end that is not there.</small>}
      </div>
    </Modal>
  );
}

/** Small always-available chip (development, or whenever the back end is in use). */
export default function DataSourceChip() {
  const [open, setOpen] = useState(false);
  if (!show()) return null;
  const api = getDataSource().mode !== 'session';
  return (
    <>
      <button type="button" data-testid="ds-chip" className={`ds-chip${api ? ' on' : ''}`} onClick={() => setOpen(true)} title="Where the data lives">
        {api ? (getDataSource().mode === 'v2' ? '● Back end v2' : '● Back end (old API)') : '○ Browser demo'}
      </button>
      {open && <DataSourcePanel onClose={() => setOpen(false)} />}
    </>
  );
}
