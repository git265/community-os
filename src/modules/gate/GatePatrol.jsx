import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { checkpointQr, getSettings, roundProgress, roundsFor, scanCheckpoint } from '../../lib/gate/engine.js';
import { nfcSupported, readTag, labelTag } from '../../lib/gate/nfc.js';
import { getDataSource } from '../../lib/storage/dataSource.js';
import { qrDataUrl } from '../../lib/payments.js';
import { DAYS } from '../../lib/gate/constants.js';
import { Chips, clock, useTick } from './gateUi.jsx';
import { QrImage, ScanBox } from './QrImage.jsx';
import { escapeHtml } from '../../lib/escapeHtml.js';
import { getPosition, mapLink } from '../../lib/attendance.js';

/** What a scan's place means, in a few words (and whether the guard should see it as a warning). */
function placeWords(place, dist) {
  switch (place) {
    case 'At the post': return { text: `at the post${dist != null ? ` (${dist} m)` : ''}`, warn: false };
    case 'Away from the post': return { text: `⚠ ${dist} m from the post. Security is told`, warn: true };
    case 'Location off': return { text: "⚠ the phone's location is off. Turn it on for patrols; security is told", warn: true };
    case 'Weak signal': return { text: 'GPS signal weak, place not checked', warn: false };
    case 'Post not mapped': return { text: 'this post is not pinned yet', warn: false };
    case 'No location': return { text: 'no location from the phone', warn: false };
    default: return { text: '', warn: false };
  }
}
const PLACE_TONE = { 'At the post': 'green', 'Away from the post': 'gg-tag-coral', 'Location off': 'gg-tag-coral' };

const code = () => Math.random().toString(36).slice(2, 10);
const demoSerial = () => `DE${Array.from({ length: 6 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function printSheet(cps) {
  const items = [];
  for (const c of cps) items.push({ c, img: await qrDataUrl(checkpointQr(c)) });
  const w = window.open('', '_blank'); if (!w) return false;
  w.document.write(`<!doctype html><title>Patrol checkpoints</title><style>body{font-family:sans-serif;margin:16px}.g{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}.c{border:2px solid #222;border-radius:12px;padding:14px;text-align:center;break-inside:avoid}.c img{width:220px}h2{margin:6px 0 0}</style><div class="g">${items.map(({ c, img }) => `<div class="c"><img src="${escapeHtml(img)}"><h2>${escapeHtml(c.name)}</h2><div>${escapeHtml(c.area || '')}</div><small>Scan with the Security app</small></div>`).join('')}</div>`);
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
  async function onScan(text, tag = '') {
    setMsg({ ok: true, text: 'Getting the location…' });
    const position = await getPosition(10000);   // kept with the scan and checked against the post's pin
    const r = await scanCheckpoint(text, { position, tag });
    if (!r.ok) { setMsg({ ok: false, text: r.reason }); return; }
    const w = placeWords(r.place, r.distM);
    setMsg({ ok: !w.warn, text: `${r.checkpoint.name} ${tag ? 'tag tapped' : 'scanned'}${r.round ? ` · ${r.round.name}: ${r.progress.done.length} of ${r.progress.total}` : ' · outside a scheduled round'}${w.text ? ` · ${w.text}` : ''}.` });
  }
  // NFC tags (optional, the community's choice in the gate rules): tap the post's tag instead of scanning its QR
  const [nfcMode, setNfcMode] = useState('Off');
  useEffect(() => { getSettings().then((x) => setNfcMode(x?.patrolNfc || 'Off')).catch(() => {}); }, []);
  const canNfc = nfcSupported(); const demo = getDataSource().mode !== 'v2' && !canNfc;   // the browser demo on a computer: a pretend tap
  const listening = useRef(null); const [waiting, setWaiting] = useState('');
  const stopListening = () => { listening.current?.abort(); listening.current = null; setWaiting(''); };
  useEffect(() => stopListening, []);
  async function tapTag() {
    stopListening(); const ctl = new AbortController(); listening.current = ctl; setWaiting('scan');
    setMsg({ ok: true, text: 'Hold the top of the phone on the tag at the post…' });
    try { const t = await readTag({ signal: ctl.signal, onUnreadable: () => setMsg({ ok: false, text: 'The tag could not be read. Hold the phone still on it.' }) }); setWaiting(''); await onScan('', t.serial); }
    catch (e) { setWaiting(''); if (e.message !== 'Stopped') setMsg({ ok: false, text: e.message }); }
  }
  const [tagMsg, setTagMsg] = useState(null);
  async function fitTag(c) {
    const put = async (serial) => {
      if (cps.some((x) => x.id !== c.id && x.nfcTag && x.nfcTag === serial)) { setTagMsg({ ok: false, id: c.id, text: 'This tag is already fitted at another post.' }); return; }
      const saved = await saveCp({ ...c, nfcTag: serial });
      setTagMsg(saved ? { ok: true, id: c.id, text: `Tag fitted at ${c.name}. Guards now tap it on their rounds.` } : { ok: false, id: c.id, text: 'Not saved. Is this tag already fitted at another post?' });
    };
    if (demo) { await put(demoSerial()); return; }
    stopListening(); const ctl = new AbortController(); listening.current = ctl; setWaiting(c.id);
    setTagMsg({ ok: true, id: c.id, text: 'Hold the phone on the new tag…' });
    try {
      const t = await readTag({ signal: ctl.signal, onUnreadable: () => setTagMsg({ ok: false, id: c.id, prepare: true, text: 'This tag could not be read. A new tag may need preparing first.' }) });
      setWaiting('');
      if (!t.serial) { setTagMsg({ ok: false, id: c.id, text: 'This tag has no serial number the phone can read. Use another tag (an NTAG213 or NTAG215 sticker works).' }); return; }
      await put(t.serial);
    } catch (e) { setWaiting(''); if (e.message !== 'Stopped') setTagMsg({ ok: false, id: c.id, text: e.message }); }
  }
  async function prepareTag(c) {
    stopListening(); setTagMsg({ ok: true, id: c.id, text: 'Hold the phone on the tag to prepare it…' });
    try { await labelTag(`CommunityOS checkpoint: ${c.name}`); setTagMsg({ ok: true, id: c.id, text: 'Prepared. Now tap Fit tag and hold the phone on it again.' }); }
    catch (e) { setTagMsg({ ok: false, id: c.id, text: e.message }); }
  }
  const tagged = cps.filter((c) => c.nfcTag && c.active !== false);
  // pin a post where the phone is now (the FM stands at the post)
  const [pinMsg, setPinMsg] = useState(null);
  async function pinHere(c) {
    setPinMsg({ ok: true, id: c.id, text: 'Getting the location…' });
    const p = await getPosition(15000);
    if (p.error) { setPinMsg({ ok: false, id: c.id, text: `${p.error}. Allow location for this site and try again at the post.` }); return; }
    await saveCp({ ...c, lat: p.lat, lng: p.lng });
    setPinMsg({ ok: p.acc <= 30, id: c.id, text: p.acc <= 30 ? `${c.name} pinned (GPS within ${p.acc} m).` : `${c.name} pinned, but the GPS was only within ${p.acc} m. Stand in the open and pin again for a better pin.` });
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
        {nfcMode !== 'Off' && (canNfc ? (
          <div className="gg-actions" style={{ marginTop: 8 }}>
            {waiting === 'scan' ? <button type="button" className="btn secondary" onClick={stopListening}>Stop</button>
              : <button type="button" className="btn" data-testid="cp-tap" onClick={tapTag}>📶 Tap NFC tag</button>}
            <small className="muted">{nfcMode === 'Tag where fitted' ? 'Posts with a tag take only the tag.' : 'Tap the tag or scan the QR: either counts.'}</small>
          </div>
        ) : demo ? (
          tagged.length > 0 && <div className="gg-actions" style={{ marginTop: 8, alignItems: 'center' }}>
            <select aria-label="Tag to tap" data-testid="cp-demo-tag" defaultValue="" onChange={(e) => { const v = e.target.value; e.target.value = ''; if (v) onScan('', v); }} style={{ width: 'auto' }}>
              <option value="">Demo: tap the tag at…</option>{tagged.map((c) => <option key={c.id} value={c.nfcTag}>{c.name}</option>)}</select>
            <small className="muted">This computer has no NFC: the demo pretends the phone touched the tag.</small>
          </div>
        ) : nfcMode === 'Tag where fitted' && tagged.length > 0 && (
          <div className="notice" style={{ marginTop: 8 }} data-testid="cp-no-nfc">This phone cannot read NFC tags. Posts with a tag ({tagged.map((c) => c.name).join(', ')}) need a phone that can: Android with Chrome, NFC on.</div>
        ))}
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
            <p className="muted hide-sm">Stick each QR where a guard must walk: a post, a plant room, the far boundary. Then stand at each post and tap Pin here: every scan keeps the phone's GPS, and a scan away from its post, with the location off, or two posts scanned from one spot is flagged.</p>
            {nfcMode !== 'Off' && <p className="muted hide-sm" data-testid="cp-nfc-help">NFC tags are on ({nfcMode}). Stick an NFC tag (an NTAG213 sticker) at a post, then tap Fit tag and hold an Android phone on it. Only a fingerprint of the tag is kept, so a copy of its QR or of what is written on it does not count.</p>}
            {cpForm && (
              <div className="form-grid" data-testid="cp-form" style={{ margin: '10px 0' }}>
                <div className="field"><label>Name *</label><input data-testid="cp-name" value={cpForm.name} onChange={(e) => setCpForm({ ...cpForm, name: e.target.value })} /></div>
                <div className="field"><label>Where</label><input value={cpForm.area} onChange={(e) => setCpForm({ ...cpForm, area: e.target.value })} /></div>
                <div className="field"><label>Order</label><input type="number" value={cpForm.order} onChange={(e) => setCpForm({ ...cpForm, order: Number(e.target.value) })} /></div>
                <div className="field"><label>Counts as at the post within (m)</label><input type="number" min="10" max="500" data-testid="cp-radius" placeholder="40" value={cpForm.radiusM ?? ''} onChange={(e) => setCpForm({ ...cpForm, radiusM: e.target.value === '' ? null : Number(e.target.value) })} /></div>
                <div className="form-actions"><button type="button" className="btn" data-testid="cp-save" disabled={!cpForm.name.trim()} onClick={async () => { await saveCp({ ...cpForm, name: cpForm.name.trim(), code: cpForm.code || code() }); setCpForm(null); }}>Save</button><button type="button" className="btn secondary" onClick={() => setCpForm(null)}>Cancel</button></div>
              </div>
            )}
            {sortedCps.map((c) => (
              <div className="gg-check" key={c.id} data-testid="cp-row" style={{ flexWrap: 'wrap' }}>
                <QrImage text={checkpointQr(c)} size={64} testid="cp-qr" />
                <span style={{ flex: 1, minWidth: 140 }}><b>{c.name}</b> {c.active === false && <span className="tag">not in use</span>}<br /><small className="muted">{c.area}{c.area ? ' · ' : ''}{c.lat != null && c.lat !== '' ? <a href={mapLink(c.lat, c.lng)} target="_blank" rel="noreferrer" data-testid="cp-pinned">📍 pinned · {c.radiusM || 40} m</a> : <span data-testid="cp-unpinned">not pinned</span>}</small>
                  {nfcMode !== 'Off' && <small style={{ display: 'block' }}>{c.nfcTag ? <span className="tag green" data-testid="cp-tag">🏷 NFC tag fitted</span> : <span className="muted" data-testid="cp-no-tag">no NFC tag</span>}</small>}
                  {pinMsg?.id === c.id && <small className={pinMsg.ok ? 'muted' : 'field-error'} style={{ display: 'block' }} role="status">{pinMsg.text}</small>}
                  {tagMsg?.id === c.id && <small className={tagMsg.ok ? 'muted' : 'field-error'} style={{ display: 'block' }} role="status" data-testid="cp-tag-msg">{tagMsg.text}{tagMsg.prepare && <> <button type="button" className="link-btn" onClick={() => prepareTag(c)}>Prepare tag</button></>}</small>}</span>
                <button type="button" className="link-btn" data-testid="cp-pin" title="Stand at the post: its place is taken from this phone's GPS" onClick={() => pinHere(c)}>Pin here</button>
                {nfcMode !== 'Off' && (canNfc || demo) && (waiting === c.id ? <button type="button" className="link-btn" onClick={stopListening}>Stop</button>
                  : <button type="button" className="link-btn" data-testid="cp-fit-tag" title="Hold the phone on the tag stuck at this post" onClick={() => fitTag(c)}>{c.nfcTag ? 'Replace tag' : demo ? 'Fit demo tag' : 'Fit tag'}</button>)}
                {nfcMode !== 'Off' && c.nfcTag && <button type="button" className="link-btn" data-testid="cp-remove-tag" onClick={() => saveCp({ ...c, nfcTag: '' })}>Remove tag</button>}
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
        {scans.length === 0 ? <div className="empty">No scans yet.</div> : [...scans].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 12).map((s) => <div className="gg-check" key={s.id}><span style={{ flex: 1 }}><b>{s.checkpointName}</b> <small className="muted">{s.guard}{s.roundName ? ` · ${s.roundName}` : ''}</small>{s.method === 'NFC' && <> <span className="tag" data-testid="scan-nfc">NFC</span></>}{s.place && <><br /><span className={`tag ${PLACE_TONE[s.place] || ''}`} data-testid="scan-place">{s.place}{s.distM != null && s.distM !== '' ? ` · ${s.distM} m` : ''}</span>{s.lat != null && s.lat !== '' && <> <a href={mapLink(s.lat, s.lng)} target="_blank" rel="noreferrer"><small>map</small></a></>}</>}</span><small className="muted">{clock(s.at)}</small></div>)}
      </div>
    </div>
  );
}
