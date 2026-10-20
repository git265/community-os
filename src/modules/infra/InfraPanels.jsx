import React, { useEffect, useMemo, useState } from 'react';
import Modal from '../../components/Modal.jsx';
import { parseSpecs } from '../../lib/assets/specs.js';
import { repairKindOf } from './AssetTaskDialog.jsx';
import MapHistory from './MapHistory.jsx';
import { TICKET_CATEGORIES } from '../../lib/schema/registry.js';
import {
  COND_COLOR, COND_HELP, CONDITIONS, effectiveCondition, faultyOf, fmtLength, isOverdue, layerOf, parseBreaks, parseShape, pathLength, pointsAlong, shapeJson, units, warrantySoon,
} from './infraModel.js';

const today = () => new Date().toISOString().slice(0, 10);
const dmy = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

/** The side panels and dialogs of the Site map: overview legend, one asset's record, add-an-asset, set-the-scale. */
export function Overview({ hereAssets, open, countOf, unplaced, canEdit, plan, layers, boundary, onFilter, onPlace, onPick }) {
  return (
    <div data-testid="infra-overview">
      <h3 style={{ marginTop: 0 }}>{plan.name}</h3>
      <p className="muted" style={{ marginTop: 0 }}>{hereAssets.length} asset{hereAssets.length === 1 ? '' : 's'} · {hereAssets.reduce((s, a) => s + units(a), 0)} items{plan.metersPerPx ? '' : ' · scale not set'}</p>
      <div className="infra-legend">
        {['Working', 'Needs attention', 'Under repair', 'Out of service'].map((c) => (
          <button key={c} type="button" className="infra-legend-row" onClick={() => onFilter(c === 'Working' ? 'All' : c)}>
            <span className="dot" style={{ background: COND_COLOR[c] }} /><span><b>{c}</b> <small>{COND_HELP[c]}</small></span><em>{countOf(c)}</em>
          </button>
        ))}
        <div className="infra-legend-row static"><span className="ring" /><span><b>Overdue check</b> <small>Next service date has passed</small></span><em>{countOf('Overdue')}</em></div>
      </div>
      {unplaced.length > 0 && (
        <div data-testid="infra-unplaced" style={{ marginTop: 14 }}>
          <h4 style={{ margin: '0 0 6px' }}>Not on the plan yet ({unplaced.length})</h4>
          <div className="infra-unplaced">
            {unplaced.slice(0, 40).map((a) => (
              <div key={a.id} className="infra-un-row"><button type="button" className="linklike" onClick={() => onPick(a)}>{a.name}</button><small className="muted">{a.type}</small>{canEdit && <button type="button" className="btn secondary sm" data-testid={`place-${a.id}`} onClick={() => onPlace(a)}>Place</button>}</div>
            ))}
            {unplaced.length > 40 && <small className="muted">…and {unplaced.length - 40} more (use Find, or the All assets tab)</small>}
          </div>
        </div>
      )}
      <p className="muted" data-testid="infra-boundary-note" style={{ fontSize: 12.5, marginTop: 14 }}>{boundary ? '⬡ Community boundary set: pins, lines and outlines can only be placed inside the dashed edge.' : canEdit ? '⬡ No community boundary yet. Draw one so nothing can be placed outside the community.' : ''}</p>
      {canEdit && <p className="muted" style={{ fontSize: 12.5, marginTop: 14 }}>Use “＋ Add on plan” to draw a pin, a line along a road or pipe, or an outline.</p>}
    </div>
  );
}

export function AssetPanel({ outside, asset: a, plan, layers, open, tickets, log, canEdit, me, onClose, onTask, onOpenTask, onRedraw, onBreak, onFull, onFocus, saveAsset, removeAsset, saveLog, onSelect, impact = null, highlight = false, onHighlight, onShare, onRestored, onFocusValve }) {
  const L = layerOf(layers, a.type);
  const cond = effectiveCondition(a, open);
  const shape = parseShape(a);
  const linked = tickets.filter((t) => t.assetId === a.id).sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
  const openTasks = linked.filter((t) => !['Closed', 'Cancelled'].includes(t.status));
  const history = log.filter((r) => r.assetId === a.id).sort((x, y) => (String(y.date) + String(y.recordCreatedAt || '')).localeCompare(String(x.date) + String(x.recordCreatedAt || ''))).slice(0, 6);
  const [status, setStatus] = useState(a.status || 'Working');
  const [faulty, setFaulty] = useState(String(a.faulty || 0));
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const [confirmSplit, setConfirmSplit] = useState(false);
  useEffect(() => { setStatus(a.status || 'Working'); setFaulty(String(a.faulty || 0)); setNote(''); setMsg(''); setConfirmSplit(false); }, [a.id, a.status, a.faulty]);
  const group = units(a) > 1;
  const length = shape?.t === 'line' ? fmtLength(pathLength(shape.c), plan.metersPerPx) : '';
  const canSplit = canEdit && !outside && shape?.t === 'line' && L.dots && group && units(a) <= 300;

  async function record() {
    const f = group ? Math.max(0, Math.min(units(a), Math.floor(Number(faulty) || 0))) : 0;
    const saved = await saveAsset({ ...a, status, faulty: f, lastInspected: today() });
    if (!saved) { setMsg('Not saved'); return; }
    const what = group && f ? `${f} of ${units(a)} faulty` : '';
    await saveLog({ assetId: a.id, assetName: a.name, date: today(), condition: status, source: 'Inspection', note: [what, note.trim()].filter(Boolean).join('. '), by: me });
    setNote(''); setMsg('Condition recorded');
  }
  async function split() {
    const pts = pointsAlong(shape.c, units(a)); const f = faultyOf(a);
    for (let i = 0; i < pts.length; i++) {
      // eslint-disable-next-line no-await-in-loop
      await saveAsset({ name: `${a.name} #${i + 1}`, type: a.type, area: a.area, location: a.location || '', quantity: 1, make: a.make || '', model: a.model || '', rating: a.rating || '', installDate: a.installDate || '', warrantyUntil: a.warrantyUntil || '', amcVendor: a.amcVendor || '', lastService: a.lastService || '', nextService: a.nextService || '', status: i >= pts.length - f ? 'Out of service' : (a.status === 'Out of service' ? 'Working' : a.status), faulty: 0, shape: shapeJson({ t: 'point', c: pts[i].map(Math.round) }), planId: plan.id });
    }
    await removeAsset(a.id);
    onClose();
  }

  return (
    <div data-testid="asset-panel">
      <div className="infra-panel-head">
        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: 0 }}>{L.icon} {a.name}</h3>
          <div className="muted" style={{ fontSize: 13 }}><span className="mono" data-testid="asset-id">{a.shortId || ''}</span>{a.shortId ? ' · ' : ''}{a.type} · {a.area || 'No area'}{a.location ? ` · ${a.location}` : ''}</div>
        </div>
        <button type="button" className="btn secondary sm" onClick={onClose} aria-label="Close asset">✕</button>
      </div>
      <div style={{ margin: '10px 0' }}>
        <span className="infra-cond big" data-testid="asset-cond"><span className="dot" style={{ background: COND_COLOR[cond] }} />{cond}</span>
        {cond !== a.status && <small className="muted" style={{ marginLeft: 8 }}>{cond === 'Under repair' ? `recorded as ${a.status} · repair task open` : `recorded as ${a.status}`}</small>}
        {isOverdue(a) && <span className="tag amber" style={{ marginLeft: 8 }}>service overdue</span>}
      </div>
      <dl className="infra-facts">
        <dt>Kind of repair</dt><dd data-testid="asset-repair-kind">{repairKindOf(a, TICKET_CATEGORIES)}</dd>
        {group && <><dt>Quantity</dt><dd>{units(a)}{faultyOf(a) ? ` · ${faultyOf(a)} faulty` : ''}</dd></>}
        {length && <><dt>Length</dt><dd>{length}</dd></>}
        {(a.make || a.model) && <><dt>Make</dt><dd>{[a.make, a.model].filter(Boolean).join(' ')}{a.rating ? ` · ${a.rating}` : ''}</dd></>}
        {Object.entries(parseSpecs(a.specs)).filter(([, v]) => String(v).trim()).map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd data-testid="asset-spec">{v}</dd></React.Fragment>)}
        {a.amcVendor && <><dt>Service by</dt><dd>{a.amcVendor}</dd></>}
        <dt>Last service</dt><dd>{dmy(a.lastService)}</dd>
        <dt>Next service</dt><dd>{dmy(a.nextService)}</dd>
        {a.warrantyUntil && <><dt>Warranty</dt><dd>{dmy(a.warrantyUntil)} {warrantySoon(a) && <span className="tag amber">ends soon</span>}</dd></>}
        {a.lastInspected && <><dt>Last inspected</dt><dd>{dmy(a.lastInspected)}</dd></>}
      </dl>

      {outside && <div className="notice error" data-testid="asset-outside" style={{ margin: '0 0 10px', fontSize: 13 }}>This asset is outside the community boundary. {canEdit ? 'Redraw it inside the boundary to edit it.' : ''}</div>}
      <div className="infra-actions">
        {openTasks.length ? (
          <>
            <button type="button" className="btn" data-testid="asset-raise-task" disabled title="A task is already open on this asset. Close it before raising another.">🛠 Task open · {openTasks[0].ticketNumber}</button>
            <button type="button" className="btn secondary" data-testid="asset-open-task" onClick={() => onOpenTask?.(openTasks[0])}>Open task</button>
          </>
        ) : <button type="button" className="btn" data-testid="asset-raise-task" onClick={onTask}>🛠 Raise task</button>}
        {shape && <button type="button" className="btn secondary" onClick={onFocus}>◎ Show</button>}
        {canEdit && <button type="button" className="btn secondary" data-testid="asset-redraw" onClick={onRedraw}>{shape ? '✎ Redraw' : '📍 Place on plan'}</button>}
        {canEdit && shape?.t === 'line' && <button type="button" className="btn secondary" data-testid="asset-mark-break" onClick={onBreak}>✕ Mark a break</button>}
        {canEdit && <button type="button" className="btn secondary" data-testid="asset-full" onClick={onFull}>Full record</button>}
      </div>
      {parseBreaks(a).length > 0 && (
        <div className="card" style={{ margin: '8px 0', padding: 10 }} data-testid="asset-breaks"><b>Marked breaks ({parseBreaks(a).length})</b>
          {parseBreaks(a).map((b, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
              <span className="tag red">✕ {i + 1}</span><small className="muted">{b.at}{b.by ? ` · ${b.by}` : ''}</small>
              <input aria-label={`Note for break ${i + 1}`} placeholder="Note (e.g. leaking at joint)" defaultValue={b.note || ''} disabled={!canEdit} style={{ flex: 1, minWidth: 120 }}
                onBlur={(e) => { if (e.target.value !== (b.note || '')) saveAsset({ ...a, breaks: JSON.stringify(parseBreaks(a).map((x, j) => (j === i ? { ...x, note: e.target.value } : x))) }); }} />
              {canEdit && <button type="button" className="btn secondary sm" data-testid="break-fixed" onClick={() => saveAsset({ ...a, breaks: JSON.stringify(parseBreaks(a).filter((_, j) => j !== i)) })}>Fixed</button>}
            </div>))}
        </div>)}

      {canEdit && (
        <div className="infra-record" data-testid="asset-record">
          <h4>Record a condition</h4>
          <div className="form-grid">
            <div className="field"><label>Condition</label>
              <select aria-label="Condition" data-testid="asset-status" value={status} onChange={(e) => setStatus(e.target.value)}>{CONDITIONS.map((c) => <option key={c}>{c}</option>)}</select>
            </div>
            {group && <div className="field"><label>Faulty (of {units(a)})</label><input type="number" min="0" max={units(a)} aria-label="Faulty count" data-testid="asset-faulty" value={faulty} onChange={(e) => setFaulty(e.target.value)} /></div>}
            <div className="field" style={{ gridColumn: '1 / -1' }}><label>Note</label><input aria-label="Note" data-testid="asset-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was found" /></div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <button type="button" className="btn secondary" data-testid="asset-record-save" onClick={record}>Save condition</button>
            {msg && <small className="muted" data-testid="asset-record-msg">{msg}</small>}
          </div>
        </div>
      )}
      {canSplit && (
        <div style={{ marginTop: 10 }}>
          {!confirmSplit ? <button type="button" className="btn secondary sm" data-testid="asset-split" onClick={() => setConfirmSplit(true)}>Split into {units(a)} individual items</button>
            : <div className="infra-confirm"><small>This replaces the group with {units(a)} separate pins you can fault and repair one by one.</small><button type="button" className="btn sm" data-testid="asset-split-go" onClick={split}>Split now</button><button type="button" className="btn secondary sm" onClick={() => setConfirmSplit(false)}>Keep as group</button></div>}
        </div>
      )}

      {impact && (impact.configured || impact.valve) && (
        <div className="infra-impact" data-testid="asset-impact" style={{ marginTop: 14 }}>
          <h4 style={{ margin: '0 0 6px' }}>Who is affected</h4>
          {impact.configured ? (
            <p style={{ margin: '0 0 6px' }}><b data-testid="impact-count">{impact.units.length}</b> unit{impact.units.length === 1 ? '' : 's'} lose service{impact.blocks.length ? ` in ${impact.blocks.join(', ')}` : ''}.</p>
          ) : <p className="muted" style={{ margin: '0 0 6px' }}>Not set up. Add the blocks or units it serves in Edit.</p>}
          {impact.units.length > 0 && <p className="muted" style={{ margin: '0 0 6px', fontSize: 13 }} data-testid="impact-units">{impact.units.slice(0, 12).join(', ')}{impact.units.length > 12 ? ` and ${impact.units.length - 12} more` : ''}</p>}
          {impact.valve ? <p style={{ margin: '0 0 6px' }}>🚰 Close <b data-testid="impact-valve">{impact.valve.name}</b> first.</p> : (L.geometry === 'Line' && <p className="muted" style={{ margin: '0 0 6px', fontSize: 13 }}>No isolation valve chosen. Add one in Edit so the task can say what to close.</p>)}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button type="button" className={`btn sm${highlight ? '' : ' secondary'}`} data-testid="impact-show" aria-pressed={highlight} onClick={() => onHighlight?.(!highlight)}>{highlight ? 'Hide on map' : 'Show on map'}</button>
            {impact.valve && <button type="button" className="btn secondary sm" data-testid="impact-valve-go" onClick={onFocusValve}>Go to the valve</button>}
          </div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 12 }}><button type="button" className="btn secondary sm" data-testid="asset-share" onClick={onShare}>🔗 Copy link to this asset</button></div>
      <h4 style={{ margin: '14px 0 6px' }}>Maintenance tasks</h4>
      {linked.length === 0 ? <p className="muted" style={{ margin: 0 }}>None yet.</p> : (
        <ul className="infra-list" data-testid="asset-tasks">
          {linked.slice(0, 6).map((t) => <li key={t.id}><button type="button" className="tag blue linklike" data-testid="asset-task-id" title="Open this task in Maintenance" onClick={() => onOpenTask?.(t)}>{t.ticketNumber || t.shortId || 'Task'}</button> {t.title} <small className="muted">· {t.status}{t.source === 'Site map' ? ' · 🗺 raised from the map' : ''}</small></li>)}
        </ul>
      )}
      <h4 style={{ margin: '14px 0 6px' }}>History</h4>
      {history.length === 0 ? <p className="muted" style={{ margin: 0 }}>No condition has been recorded.</p> : (
        <ul className="infra-list" data-testid="asset-history">
          {history.map((r) => <li key={r.id}><span className="dot" style={{ background: COND_COLOR[r.condition] || '#9aa4b2' }} /> <b>{r.condition}</b> <small className="muted">{dmy(r.date)} · {r.source}{r.by ? ` · ${r.by}` : ''}</small>{r.note ? <div className="muted" style={{ fontSize: 12.5 }}>{r.note}</div> : null}</li>)}
        </ul>
      )}
      <MapHistory recordId={a.id} canEdit={canEdit} save={saveAsset} title="Position and map changes" onRestored={onRestored} />
    </div>
  );
}

export function CalibrateDialog({ shape, plan, onClose, onSave }) {
  const px = pathLength(shape.c);
  const [m, setM] = useState('');
  const [err, setErr] = useState('');
  return (
    <Modal title="Set the plan scale" subtitle="Tell us how far apart the two points you tapped really are, for example the width of a road or the length of a plot." onClose={onClose}>
      <div className="form-grid" data-testid="calibrate-dialog">
        <div className="field"><label>Distance in metres *</label><input type="number" min="0.1" step="0.1" aria-label="Distance in metres" data-testid="calibrate-metres" value={m} onChange={(e) => setM(e.target.value)} autoFocus /></div>
        {plan.metersPerPx > 0 && <div className="muted" style={{ alignSelf: 'end' }}>Currently {Math.round(px * plan.metersPerPx)} m by the old scale.</div>}
        {err && <div className="field-error" style={{ gridColumn: '1 / -1' }}>{err}</div>}
        <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn secondary" onClick={onClose}>Cancel</button>
          <button className="btn" data-testid="calibrate-save" onClick={() => { const v = Number(m); if (!(v > 0) || px < 5) { setErr('Enter the distance in metres'); return; } onSave(v / px); }}>Save scale</button>
        </div>
      </div>
    </Modal>
  );
}
