import React, { useState } from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { admitPerson, barrierCycle, cameraSees, exitPerson, kioskOpen, plateEvent, scanCheckpoint, checkpointQr } from '../../lib/gate/engine.js';
import { GATE_NAMES } from '../../lib/gate/constants.js';
import { Photo } from './gateUi.jsx';

/** Stands in for the face terminal, FASTag reader, barrier sensor and cameras until the real devices are connected. */
export default function GateSimulator() {
  const { records: people } = useCollection(COLLECTIONS.GATE_PEOPLE, 'Gate');
  const { records: vehicles } = useCollection(COLLECTIONS.GATE_VEHICLES, 'Gate');
  const { records: props } = useCollection(COLLECTIONS.PROPERTIES, 'Units');
  const [log, setLog] = useState([]); const [gate, setGate] = useState(GATE_NAMES[0]);
  const [pid, setPid] = useState(''); const [dir, setDir] = useState('In'); const [villa, setVilla] = useState('');
  const [plate, setPlate] = useState(''); const [plateDir, setPlateDir] = useState('In'); const [count, setCount] = useState(2); const [cam, setCam] = useState('unknown');
  const { records: visits } = useCollection(COLLECTIONS.GATE_VISITS, 'Gate');
  const { records: cps } = useCollection(COLLECTIONS.GATE_CHECKPOINTS, 'Patrol');
  const [plateCount, setPlateCount] = useState('');
  const approved = visits.filter((v) => v.state === 'Approved');
  const person = people.find((p) => p.id === pid);
  const say = (device, ok, text) => setLog((l) => [{ t: new Date(), device, ok, text }, ...l].slice(0, 12));
  async function face() {
    if (!person) return say('Face terminal', false, 'Pick a person');
    const r = dir === 'In' ? await admitPerson(person, { gate, method: 'Face', unit: villa }) : await exitPerson(person, 'Face');
    say('Face terminal', !!r.ok, r.ok ? `${person.name} ${dir === 'In' ? 'recognised. Door opens' : 'signed out'}${r.visit?.unit && dir === 'In' ? ` (${r.visit.unit})` : ''}.` : `${person.name}: ${r.reason}${r.outcome === 'need-villa' ? ' Enter the villa below and scan again.' : ''}`);
  }
  async function fastag() {
    if (!plate.trim()) return say('FASTag reader', false, 'Choose or type a plate');
    const r = await plateEvent({ plate, gate, direction: plateDir, people: plateCount }); say('FASTag reader', !!r.ok, r.ok ? `${plate} ${plateDir === 'In' ? 'read. Barrier opens' : 'left'}.` : `${plate}: ${r.reason}`);
  }
  async function barrier() { const r = await barrierCycle({ gate, vehicles: Number(count) || 1 }); say('Barrier sensor', r.ok, r.ok ? `Counted ${r.counted}, register shows ${r.recorded}. All accounted for.` : `Counted ${r.counted} vehicle(s), register shows ${r.recorded}. Tailgate flag raised.`); }
  async function camera() {
    const p = cam === 'unknown' ? null : people.find((x) => x.id === cam);
    const r = await cameraSees({ gate, person: p }); say('Camera', r.ok, r.ok ? `${p.name} already has an open entry. Nothing to flag.` : `${p?.name || 'An unknown person'} seen inside with no entry record. Watching for the grace window.`);
  }
  return (
    <div data-testid="gate-sim">
      <div className="notice">Demo only. This panel stands in for the face terminal, FASTag reader, barrier sensor and cameras. In a real install those devices send the same events to the same rules.</div>
      <div className="gg-grid2">
        <div>
          <div className="card" style={{ marginBottom: 14 }}>
            <label className="gg-row" style={{ gap: 8, marginBottom: 8 }}>Gate <select value={gate} data-testid="sim-gate" onChange={(e) => setGate(e.target.value)} style={{ width: 'auto' }}>{GATE_NAMES.map((g) => <option key={g}>{g}</option>)}</select></label>
            <h3 style={{ marginTop: 0 }}>🪪 Face terminal</h3>
            <div className="form-grid">
              <div className="field"><label>Person</label><select data-testid="sim-person" value={pid} onChange={(e) => setPid(e.target.value)}><option value="">Choose…</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.personClass} · {p.status}</option>)}</select></div>
              <div className="field"><label>Direction</label><select data-testid="sim-dir" value={dir} onChange={(e) => setDir(e.target.value)}><option>In</option><option>Out</option></select></div>
              {person?.personClass === 'Delivery rider' && <div className="field"><label>Villa (rider keys it in)</label><input list="sim-units" data-testid="sim-villa" value={villa} onChange={(e) => setVilla(e.target.value)} /></div>}
              <div className="form-actions"><button type="button" className="btn" data-testid="sim-face" onClick={face}>Scan face</button></div>
            </div>
            {person && <div className="gg-row"><Photo src={person.photo} name={person.name} size={44} /><small className="muted">{person.name} would look like this on the terminal.</small></div>}
          </div>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>🚗 FASTag / plate reader</h3>
            <div className="form-grid">
              <div className="field"><label>Plate</label><input list="sim-plates" data-testid="sim-plate" value={plate} onChange={(e) => setPlate(e.target.value)} placeholder="KA 05 AB 1122" /><datalist id="sim-plates">{vehicles.map((v) => <option key={v.id} value={v.plate}>{v.owner} · {v.status}</option>)}</datalist></div>
              <div className="field"><label>Direction</label><select value={plateDir} onChange={(e) => setPlateDir(e.target.value)}><option>In</option><option>Out</option></select></div>
              <div className="field"><label>People the camera counted (optional)</label><input type="number" min="0" data-testid="sim-plate-people" value={plateCount} onChange={(e) => setPlateCount(e.target.value)} /></div>
              <div className="form-actions"><button type="button" className="btn" data-testid="sim-fastag" onClick={fastag}>Read plate</button></div>
            </div>
          </div>
        </div>
        <div>
          <div className="card" style={{ marginBottom: 14 }}>
            <h3 style={{ marginTop: 0 }}>🚧 Barrier sensor</h3>
            <p className="muted" style={{ marginTop: 0 }}>The sensor counts vehicles in one open-close cycle. If more crossed than the register shows, someone followed someone.</p>
            <div className="gg-row"><label>Vehicles counted <input type="number" min="1" max="5" data-testid="sim-count" value={count} onChange={(e) => setCount(e.target.value)} style={{ width: 80 }} /></label><button type="button" className="btn" data-testid="sim-barrier" onClick={barrier}>Barrier cycle</button></div>
            <h3>📷 Camera inside the community</h3>
            <div className="gg-row"><select data-testid="sim-cam" value={cam} onChange={(e) => setCam(e.target.value)} style={{ width: 'auto' }}><option value="unknown">An unknown person</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select><button type="button" className="btn" data-testid="sim-camera" onClick={camera}>Camera sees person</button></div>
          </div>
          <div className="card" style={{ marginBottom: 14 }} data-testid="sim-kiosk">
            <h3 style={{ marginTop: 0 }}>🖥 Face kiosk</h3>
            <p className="muted" style={{ marginTop: 0 }}>Visitors the villa has approved and who are waiting to be let in. Turn the kiosk on in Rules & alerts.</p>
            {approved.length === 0 && <div className="empty">Nobody approved is waiting.</div>}
            {approved.map((v) => <div className="gg-check" key={v.id} data-testid="kiosk-row"><span style={{ flex: 1 }}><b>{v.name}</b> <small className="muted">→ {v.unit}</small></span>
              <button type="button" className="btn good sm" data-testid="kiosk-match" onClick={async () => { const r = await kioskOpen(v, { matched: true }); say('Face kiosk', !!r.ok, r.ok ? `${v.name} recognised. Gate opens.` : r.reason); }}>Face matches</button>{' '}
              <button type="button" className="btn secondary sm" data-testid="kiosk-nomatch" onClick={async () => { const r = await kioskOpen(v, { matched: false }); say('Face kiosk', false, `${v.name}: ${r.reason}`); }}>No match</button></div>)}
          </div>
          <div className="card" style={{ marginBottom: 14 }} data-testid="sim-patrol">
            <h3 style={{ marginTop: 0 }}>📍 Patrol post (QR on the wall)</h3>
            <p className="muted" style={{ marginTop: 0 }}>Scans as the person signed in now.</p>
            <div className="gg-chips">{[...cps].sort((a, b) => (a.order || 0) - (b.order || 0)).map((c) => <button type="button" key={c.id} data-testid="sim-cp" onClick={async () => { const r = await scanCheckpoint(checkpointQr(c)); say('Patrol post', !!r.ok, r.ok ? `${c.name} scanned${r.round ? ` (${r.round.name}: ${r.progress.done.length}/${r.progress.total})` : ''}.` : `${c.name}: ${r.reason}`); }}>{c.name}</button>)}</div>
          </div>
          <div className="card"><h3 style={{ marginTop: 0 }}>Device log</h3>{log.length === 0 && <div className="empty">Nothing yet.</div>}
            {log.map((l, i) => <div className="gg-check" key={i} data-testid="sim-log"><i>{l.ok ? '✅' : '⚠️'}</i><span style={{ flex: 1 }}><b>{l.device}</b> · {l.text}</span><small className="muted">{l.t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</small></div>)}</div>
        </div>
      </div>
      <datalist id="sim-units">{props.map((p) => <option key={p.id} value={p.unit} />)}</datalist>
    </div>
  );
}
