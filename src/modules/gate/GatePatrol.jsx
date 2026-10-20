import React, { useMemo, useState } from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { checkpointQr, roundProgress, roundsFor, scanCheckpoint } from '../../lib/gate/engine.js';
import { qrDataUrl } from '../../lib/payments.js';
import { DAYS } from '../../lib/gate/constants.js';
import { Chips, clock, useTick } from './gateUi.jsx';
import { QrImage, ScanBox } from './QrImage.jsx';

const code = () => Math.random().toString(36).slice(2, 10);
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function printSheet(cps) {
  const items = [];
  for (const c of cps) items.push({ c, img: await qrDataUrl(checkpointQr(c)) });
  const w = window.open('', '_blank'); if (!w) return false;
  w.document.write(`<!doctype html><title>Patrol checkpoints</title><style>body{font-family:sans-serif;margin:16px}.g{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}.c{border:2px solid #222;border-radius:12px;padding:14px;text-align:center;break-inside:avoid}.c img{width:220px}h2{margin:6px 0 0}</style><div class="g">${items.map(({ c, img }) => `<div class="c"><img src="${img}"><h2>${c.name}</h2><div>${c.area || ''}</div><small>Scan with the Security app</small></div>`).join('')}</div>`);
  w.document.close(); setTimeout(() => w.print(), 300); return true;
}

/** Checkpoint QR patrols: scan the code on each post; a round that is not walked inside its window raises a flag. */
export default function GatePatrol({ canEdit = false }) {
  const { records: cps, save: saveCp, remove: removeCp } = useCollection(COLLECTIONS.GATE_CHECKPOINTS, 'Patrol');
  const { records: rounds, save: saveRound, remove: removeRound } = useCollection(COLLECTIONS.GATE_ROUNDS, 'Patrol');
  const { records: scans } = useCollection(COLLECTIONS.GATE_SCANS, 'Patrol');
  const [msg, setMsg] = useState(null); const [cpForm, setCpForm] = useState(null); const [rForm, setRForm] = useState(null);
  useTick(15000);
  const sortedCps = useMemo(() => [...cps].sort((a, b) => (a.order || 0) - (b.order || 0)), [cps]);
  const now = new Date(); const today = dayKey(now);
  const todays = roundsFor(rounds, now).sort((a, b) => a.start - b.start);
  const todayScans = scans.filter((s) => s.day === today || new Date(s.at) >= new Date(now.getTime() - 36 * 3600000));
  const nameOf = (id) => cps.find((c) => c.id === id)?.name || id;
  async function onScan(text) {
    const r = await scanCheckpoint(text);
    setMsg(r.ok ? { ok: true, text: `${r.checkpoint.name} scanned${r.round ? ` · ${r.round.name}: ${r.progress.done.length} of ${r.progress.total}` : ' · outside a scheduled round'}.` } : { ok: false, text: r.reason });
  }
  // the last seven days: how many scheduled rounds were fully walked
  const week = useMemo(() => {
    const out = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(); d.setDate(d.getDate() - i); const rs = roundsFor(rounds, d).filter((r) => r.end < now);
      if (!rs.length) continue;
      const done = rs.filter((r) => roundProgress(r, scans).complete).length;
      out.push({ day: dayKey(d), done, total: rs.length });
    }
    return out;
  }, [rounds, scans]); // eslint-disable-line react-hooks/exhaustive-deps
  const statusOf = (r) => { const pr = roundProgress(r, todayScans); return now < r.start ? ['Later', ''] : now <= r.end ? [pr.complete ? 'Done' : 'Now', pr.complete ? 'green' : 'orange'] : [pr.complete ? 'Done' : 'Missed', pr.complete ? 'green' : 'gg-tag-coral']; };
  return (
    <div data-testid="gate-patrol">
      <div className="card" style={{ marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>Scan a checkpoint</h2>
        <ScanBox onText={onScan} placeholder="Scan the code on the post" testid="cp-scan" button="Scan" />
        {msg && <div className={`notice${msg.ok ? '' : ' error'}`} data-testid="cp-msg" role="status" style={{ marginTop: 8 }}>{msg.text}</div>}
      </div>
      <div className="card" style={{ marginBottom: 14 }} data-testid="rounds-today">
        <h2 style={{ marginTop: 0 }}>Today's rounds</h2>
        {todays.length === 0 && <div className="empty">No rounds are scheduled today.</div>}
        {todays.map((r) => { const pr = roundProgress(r, todayScans); const [label, tone] = statusOf(r); return (
          <div className="gg-check" key={r.id} data-testid="round-row" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <span style={{ flex: 1, minWidth: 180 }}><b>{r.name}</b> <small className="muted">{clock(r.start.toISOString())}–{clock(r.end.toISOString())} · {pr.done.length}/{pr.total}</small>
              <div className="gg-chips hide-sm" style={{ marginTop: 4 }}>{(r.checkpointIds || []).map((id) => <button type="button" key={id} className={pr.done.includes(id) ? 'on' : ''} tabIndex={-1} style={{ cursor: 'default' }}>{pr.done.includes(id) ? '✓ ' : ''}{nameOf(id)}</button>)}</div></span>
            <span className={`tag ${tone}`} data-testid="round-status">{label}</span>
          </div>); })}
        {week.length > 0 && <small className="muted" data-testid="patrol-week">Last 7 days: {week.reduce((a, d) => a + d.done, 0)} of {week.reduce((a, d) => a + d.total, 0)} rounds fully walked.</small>}
      </div>
      {canEdit && (
        <>
          <div className="card" style={{ marginBottom: 14 }} data-testid="cp-setup">
            <div className="gg-row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}><h2 style={{ margin: 0 }}>Checkpoints</h2>
              <div className="gg-actions"><button type="button" className="btn secondary" data-testid="cp-print" onClick={() => printSheet(sortedCps.filter((c) => c.active !== false))}>Print QR sheet</button><button type="button" className="btn" data-testid="cp-add" onClick={() => setCpForm({ name: '', area: '', order: (sortedCps.length || 0) + 1, active: true })}>+ Checkpoint</button></div></div>
            <p className="muted hide-sm">Stick each QR where a guard must walk: a post, a plant room, the far boundary. Anyone can photograph a printed code, so the scan also needs a gap of a few seconds from the last one.</p>
            {cpForm && (
              <div className="form-grid" data-testid="cp-form" style={{ margin: '10px 0' }}>
                <div className="field"><label>Name *</label><input data-testid="cp-name" value={cpForm.name} onChange={(e) => setCpForm({ ...cpForm, name: e.target.value })} /></div>
                <div className="field"><label>Where</label><input value={cpForm.area} onChange={(e) => setCpForm({ ...cpForm, area: e.target.value })} /></div>
                <div className="field"><label>Order</label><input type="number" value={cpForm.order} onChange={(e) => setCpForm({ ...cpForm, order: Number(e.target.value) })} /></div>
                <div className="form-actions"><button type="button" className="btn" data-testid="cp-save" disabled={!cpForm.name.trim()} onClick={async () => { await saveCp({ ...cpForm, name: cpForm.name.trim(), code: cpForm.code || code() }); setCpForm(null); }}>Save</button><button type="button" className="btn secondary" onClick={() => setCpForm(null)}>Cancel</button></div>
              </div>
            )}
            {sortedCps.map((c) => (
              <div className="gg-check" key={c.id} data-testid="cp-row" style={{ flexWrap: 'wrap' }}>
                <QrImage text={checkpointQr(c)} size={64} testid="cp-qr" />
                <span style={{ flex: 1, minWidth: 140 }}><b>{c.name}</b> {c.active === false && <span className="tag">not in use</span>}<br /><small className="muted">{c.area}</small></span>
                <button type="button" className="link-btn" onClick={() => setCpForm(c)}>Edit</button>
                <button type="button" className="link-btn" data-testid="cp-renew" title="Issue a new QR; the old printed one stops working" onClick={() => saveCp({ ...c, code: code() })}>New QR</button>
                <button type="button" className="link-btn" onClick={() => saveCp({ ...c, active: c.active === false })}>{c.active === false ? 'Use' : 'Pause'}</button>
              </div>
            ))}
          </div>
          <div className="card" style={{ marginBottom: 14 }} data-testid="round-setup">
            <div className="gg-row" style={{ justifyContent: 'space-between' }}><h2 style={{ margin: 0 }}>Rounds</h2><button type="button" className="btn" data-testid="round-add" onClick={() => setRForm({ name: '', time: '22:00', windowMin: 60, checkpointIds: sortedCps.map((c) => c.id), days: [], active: true })}>+ Round</button></div>
            {rForm && (
              <div className="form-grid" data-testid="round-form" style={{ margin: '10px 0' }}>
                <div className="field"><label>Name *</label><input data-testid="round-name" value={rForm.name} onChange={(e) => setRForm({ ...rForm, name: e.target.value })} /></div>
                <div className="field"><label>Starts at</label><input type="time" data-testid="round-time" value={rForm.time} onChange={(e) => setRForm({ ...rForm, time: e.target.value })} /></div>
                <div className="field"><label>Minutes allowed</label><input type="number" min="10" value={rForm.windowMin} onChange={(e) => setRForm({ ...rForm, windowMin: Number(e.target.value) })} /></div>
                <div className="field" style={{ gridColumn: '1 / -1' }}><label>Checkpoints on this round</label>
                  <div className="gg-chips">{sortedCps.map((c) => <button type="button" key={c.id} className={(rForm.checkpointIds || []).includes(c.id) ? 'on' : ''} onClick={() => setRForm({ ...rForm, checkpointIds: (rForm.checkpointIds || []).includes(c.id) ? rForm.checkpointIds.filter((x) => x !== c.id) : [...(rForm.checkpointIds || []), c.id] })}>{c.name}</button>)}</div></div>
                <div className="field" style={{ gridColumn: '1 / -1' }}><label>Days (none = every day)</label><Chips multi options={DAYS} value={rForm.days || []} onChange={(v) => setRForm({ ...rForm, days: v })} label="Days" /></div>
                <div className="form-actions"><button type="button" className="btn" data-testid="round-save" disabled={!rForm.name.trim() || !(rForm.checkpointIds || []).length} onClick={async () => { await saveRound({ ...rForm, name: rForm.name.trim() }); setRForm(null); }}>Save</button><button type="button" className="btn secondary" onClick={() => setRForm(null)}>Cancel</button></div>
              </div>
            )}
            {rounds.map((r) => (
              <div className="gg-check" key={r.id} data-testid="round-def"><span style={{ flex: 1 }}><b>{r.name}</b> <small className="muted">{r.time} · {r.windowMin || 60} min · {(r.checkpointIds || []).length} checkpoints · {(r.days || []).length ? r.days.join(', ') : 'every day'}</small></span>
                <button type="button" className="link-btn" onClick={() => setRForm(r)}>Edit</button><button type="button" className="link-btn" onClick={() => saveRound({ ...r, active: r.active === false })}>{r.active === false ? 'Use' : 'Pause'}</button><button type="button" className="link-btn" onClick={() => removeRound(r)}>Delete</button></div>
            ))}
          </div>
        </>
      )}
      <div className="card" data-testid="scan-log"><h2 style={{ marginTop: 0 }}>Recent scans</h2>
        {scans.length === 0 ? <div className="empty">No scans yet.</div> : [...scans].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 12).map((s) => <div className="gg-check" key={s.id}><span style={{ flex: 1 }}><b>{s.checkpointName}</b> <small className="muted">{s.guard}{s.roundName ? ` · ${s.roundName}` : ''}</small></span><small className="muted">{clock(s.at)}</small></div>)}
      </div>
    </div>
  );
}
