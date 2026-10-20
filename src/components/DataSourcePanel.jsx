import React, { useState } from 'react';
import Modal from './Modal.jsx';
import { getDataSource, setDataSource, pingBackend } from '../lib/storage/dataSource.js';
import { copyCommunity } from '../lib/storage/migrate.js';
import { getCommunity } from '../lib/community.js';

const show = () => import.meta.env.DEV || import.meta.env.VITE_SHOW_DATA_SOURCE === 'true' || getDataSource().mode === 'api';

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
    try { setHealth(await pingBackend(url, token)); } catch (e) { setErr(e.message); }
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
        <label className="gg-row"><input type="radio" name="ds" data-testid="ds-mode-api" checked={mode === 'api'} onChange={() => setMode('api')} style={{ width: 'auto' }} /> <span><b>Back end</b> <span className="muted">· Spring Boot + PostgreSQL, data survives reloads and is shared</span></span></label>
        <div className="form-grid" style={{ marginTop: 10, opacity: mode === 'api' ? 1 : 0.6 }}>
          <div className="field"><label>Back end address</label><input data-testid="ds-url" value={url} onChange={(e) => { setUrl(e.target.value); setHealth(null); }} placeholder="/api or https://api.example.com/api" /></div>
          <div className="field"><label>Access key (optional)</label><input data-testid="ds-token" type="password" value={token} onChange={(e) => { setToken(e.target.value); setHealth(null); }} placeholder="only if the server asks for one" autoComplete="off" /></div>
        </div>
        <div className="form-actions" style={{ marginTop: 6 }}>
          <button type="button" className="btn secondary" data-testid="ds-test" disabled={!!busy} onClick={test}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
        </div>
        {err && <div className="notice error" role="alert" data-testid="ds-error">{err}</div>}
        {health && (
          <div className="notice" role="status" data-testid="ds-status">
            Connected · database <b>{health.database}</b> · version {health.version}
            <div className="muted" style={{ marginTop: 4 }}>{Object.entries(health.providers || {}).map(([k, v]) => `${k}: ${v}`).join(' · ')}</div>
          </div>
        )}
        {health && (
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
          <button type="button" className="btn" data-testid="ds-apply" disabled={!!busy || (mode === 'api' && !health)} onClick={apply}>{mode === cur.mode && url === cur.baseUrl && token === cur.token ? 'Reload' : 'Use this and reload'}</button>
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
        </div>
        {mode === 'api' && !health && <small className="muted">Test the connection first, so the app never reloads onto a back end that is not there.</small>}
      </div>
    </Modal>
  );
}

/** Small always-available chip (development, or whenever the back end is in use). */
export default function DataSourceChip() {
  const [open, setOpen] = useState(false);
  if (!show()) return null;
  const api = getDataSource().mode === 'api';
  return (
    <>
      <button type="button" data-testid="ds-chip" className={`ds-chip${api ? ' on' : ''}`} onClick={() => setOpen(true)} title="Where the data lives">
        {api ? '● Back end' : '○ Browser demo'}
      </button>
      {open && <DataSourcePanel onClose={() => setOpen(false)} />}
    </>
  );
}
