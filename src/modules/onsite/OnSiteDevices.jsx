import React, { useMemo, useState } from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { GATE_NAMES } from '../../lib/gate/constants.js';
import {
  KINDS, DRIVERS, DIRECTIONS, CAPABILITIES, CONSENT_TEXT, isOnline, onV2, listDevices, listBridges, listFaces, enrolments, saveDevice, addBridge, revokeBridge, saveFace,
  openDoor, resync, demoPunch,
} from '../../lib/site/site.js';
import Modal from '../../components/Modal.jsx';
import { usePrompt } from '../../components/PromptDialog.jsx';
import { Segmented } from '../../components/ui.jsx';
import { Photo, PhotoCapture, stamp } from '../gate/gateUi.jsx';
import { useLoad, ago } from './useSite.js';

const say = (e) => window.dispatchEvent(new CustomEvent('communityos:denied', { detail: { message: e.message, kind: 'error' } }));
const EMPTY = { name: '', gate: GATE_NAMES[0], kind: 'Face terminal', make: 'Hikvision', model: 'DS-K1T344MBWX-QRE1', driver: 'hikvision-isapi', direction: 'In', capabilities: ['Face', 'Card', 'QR', 'Relay'],
  bridgeId: '', host: '', port: '', useTls: false, username: 'admin', password: '', doorNo: 1, capacity: 3000, status: 'Active' };

function DeviceForm({ device, bridges, onClose }) {
  const [f, setF] = useState(() => (device ? { ...EMPTY, ...device, password: '', port: device.port ?? '', capacity: device.capacity ?? '', bridgeId: device.bridgeId || '' } : { ...EMPTY, bridgeId: bridges.find((b) => b.status === 'Active')?.id || '' }));
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const isapi = f.driver === 'hikvision-isapi';
  async function submit(e) {
    e.preventDefault(); setBusy(true); setErr('');
    const num = (v) => (v === '' || v == null ? null : Number(v));
    try {
      await saveDevice(device?.id, { name: f.name.trim(), gate: f.gate, kind: f.kind, make: f.make || null, model: f.model || null, driver: f.driver, direction: f.direction, capabilities: f.capabilities,
        bridgeId: isapi ? f.bridgeId || null : null, host: isapi ? f.host.trim() || null : null, port: isapi ? num(f.port) : null, useTls: !!f.useTls, username: isapi ? f.username || null : null,
        password: f.password || null, doorNo: num(f.doorNo) || 1, capacity: num(f.capacity), status: f.status });
      onClose();
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  }
  return (
    <Modal title={device ? `Change ${device.name}` : 'Add a device'} subtitle="Its bridge reaches it on the community network; CommunityOS puts the right people on it." onClose={onClose} wide>
      <form className="form-grid" onSubmit={submit} data-testid="os-device-form">
        <div className="field"><label>Name *</label><input aria-label="Name" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Main gate face" /></div>
        <div className="field"><label>Gate</label><select aria-label="Gate" value={f.gate} onChange={(e) => set('gate', e.target.value)}>{[...new Set([...GATE_NAMES, f.gate])].map((g) => <option key={g}>{g}</option>)}</select></div>
        <div className="field"><label>Kind</label><select aria-label="Kind" value={f.kind} onChange={(e) => set('kind', e.target.value)}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select></div>
        <div className="field"><label>Reached by</label><select aria-label="Driver" value={f.driver} onChange={(e) => set('driver', e.target.value)}>{DRIVERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div className="field"><label>Make</label><input aria-label="Make" value={f.make || ''} onChange={(e) => set('make', e.target.value)} /></div>
        <div className="field"><label>Model</label><input aria-label="Model" value={f.model || ''} onChange={(e) => set('model', e.target.value)} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Counts people going</label><Segmented options={DIRECTIONS} value={f.direction} onChange={(v) => set('direction', v)} label="Direction" />
          <small className="muted">{f.direction === 'Both' ? 'One terminal for both ways: its check-in / check-out key decides, otherwise the next punch after an In is an Out.' : `Every punch here is an ${f.direction}.`}</small></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>It can read</label><div className="gg-chips">{CAPABILITIES.map((c) => <button key={c} type="button" className={f.capabilities.includes(c) ? 'on' : ''} aria-pressed={f.capabilities.includes(c)}
          onClick={() => set('capabilities', f.capabilities.includes(c) ? f.capabilities.filter((x) => x !== c) : [...f.capabilities, c])}>{c === 'Relay' ? 'Opens a door' : c}</button>)}</div></div>
        {isapi && <>
          <div className="field"><label>Site bridge *</label><select aria-label="Bridge" value={f.bridgeId} onChange={(e) => set('bridgeId', e.target.value)}><option value="">Choose…</option>{bridges.filter((b) => b.status === 'Active' || b.id === f.bridgeId).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
            {!bridges.some((b) => b.status === 'Active') && <small className="field-error">Add a bridge first (below).</small>}</div>
          <div className="field"><label>Address on the network *</label><input aria-label="Address" value={f.host} onChange={(e) => set('host', e.target.value)} placeholder="192.168.1.64" /></div>
          <div className="field"><label>Port</label><input aria-label="Port" inputMode="numeric" value={f.port} onChange={(e) => set('port', e.target.value.replace(/\D/g, ''))} placeholder={f.useTls ? '443' : '80'} /></div>
          <div className="field"><label className="gg-row" style={{ gap: 6 }}><input type="checkbox" checked={!!f.useTls} onChange={(e) => set('useTls', e.target.checked)} style={{ width: 'auto' }} /> https</label></div>
          <div className="field"><label>Admin user</label><input aria-label="Admin user" value={f.username || ''} onChange={(e) => set('username', e.target.value)} /></div>
          <div className="field"><label>Admin password{device?.hasPassword ? '' : ' *'}</label><input aria-label="Admin password" type="password" autoComplete="new-password" value={f.password} onChange={(e) => set('password', e.target.value)} placeholder={device?.hasPassword ? 'Unchanged' : ''} />
            <small className="muted">Kept encrypted; only this device's bridge gets it.</small></div>
          <div className="field"><label>Door number</label><input aria-label="Door number" inputMode="numeric" value={f.doorNo} onChange={(e) => set('doorNo', e.target.value.replace(/\D/g, ''))} /></div>
        </>}
        <div className="field"><label>Capacity (people)</label><input aria-label="Capacity" inputMode="numeric" value={f.capacity} onChange={(e) => set('capacity', e.target.value.replace(/\D/g, ''))} /></div>
        <div className="field"><label>Status</label><select aria-label="Status" value={f.status} onChange={(e) => set('status', e.target.value)}><option>Active</option><option>Paused</option></select></div>
        {err && <div className="field-error" style={{ gridColumn: '1 / -1' }}>{err}</div>}
        <div className="form-actions"><button type="submit" className="btn" disabled={busy} data-testid="os-device-save">{busy ? 'Saving…' : device ? 'Save' : 'Add device'}</button><button type="button" className="btn secondary" onClick={onClose}>Cancel</button></div>
      </form>
    </Modal>
  );
}

function WhoIsOn({ device, onClose }) {
  const list = useLoad(() => enrolments(device.id), { deps: [device.id] });
  const rows = (list.data || []).filter((e) => e.state !== 'Removed').sort((a, b) => a.name.localeCompare(b.name));
  return (
    <Modal title={`On ${device.name}`} subtitle={`${rows.filter((e) => e.state === 'Enrolled').length} enrolled${device.capacity ? ` of ${device.capacity}` : ''}`} onClose={onClose}>
      {list.error && <div className="field-error">{list.error}</div>}
      {rows.length === 0 && !list.error && <div className="empty">Nobody yet. People go on a device once they have given consent.</div>}
      {rows.map((e) => (
        <div key={e.employeeNo} className="gg-mini" data-testid="os-enrolment">
          <div className="gg-main"><b>{e.name}</b><small className="muted">{e.subjectKind === 'member' ? 'Staff' : 'Registry'}{e.cardNo ? ` · card ${e.cardNo}` : ''}{e.validTo ? ` · until ${e.validTo}` : ''}{e.lastError ? ` · ${e.lastError}` : ''}</small></div>
          <span className={`tag ${e.state === 'Enrolled' ? 'green' : e.state === 'Failed' ? 'gg-tag-coral' : 'orange'}`}>{e.state}</span>
        </div>
      ))}
    </Modal>
  );
}

function NewToken({ made, onClose }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(made.token); setCopied(true); } catch { /* the person copies it by hand */ } };
  return (
    <Modal title={`Bridge ${made.bridge.name} added`} subtitle="Copy the token now: it is shown only this once." onClose={onClose}>
      <div className="os-token" data-testid="os-bridge-token">{made.token}</div>
      <p><button type="button" className="btn" onClick={copy}>{copied ? 'Copied' : 'Copy token'}</button></p>
      <p className="muted">On the gate PC, in the CommunityOS <code>bridge</code> folder:</p>
      <pre className="os-pre">{`COS_SERVER=${location.origin} \\\nCOS_BRIDGE_TOKEN=<the token> \\\nnpm start`}</pre>
      <p className="muted">The bridge connects out to CommunityOS; no port is opened at the gate. Its README covers running it as a service.</p>
    </Modal>
  );
}

function ConsentForm({ initial, people, staff, onClose }) {
  const [kind, setKind] = useState(initial?.subjectKind || 'person');
  const [id, setId] = useState(initial?.subjectId || '');
  const [consent, setConsent] = useState(initial ? !!initial.consentAt && !initial.withdrawnAt : false);
  const [card, setCard] = useState(initial?.cardNo || ''); const [photo, setPhoto] = useState(''); const [text, setText] = useState(initial?.consentText || CONSENT_TEXT);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const choices = kind === 'person' ? people.filter((p) => p.status === 'Active') : staff;
  const person = kind === 'person' ? people.find((p) => p.id === id) : null;
  async function submit(e) {
    e.preventDefault(); setErr('');
    if (!id) return setErr(`Choose the ${kind === 'person' ? 'person' : 'staff member'}`);
    if (photo && !consent) return setErr('Tick the consent before adding a face photo');
    setBusy(true);
    try { await saveFace(kind, id, { consent, photo: kind === 'member' ? photo || null : null, cardNo: card.trim() || null, text: text.trim() === CONSENT_TEXT ? null : text.trim() }); onClose(); }
    catch (x) { setErr(x.message); } finally { setBusy(false); }
  }
  return (
    <Modal title={initial ? `Face consent: ${initial.name}` : 'Record face consent'} subtitle="Only people who agreed go on the devices. Withdrawing takes them off at once." onClose={onClose}>
      <form className="form-grid" onSubmit={submit} data-testid="os-consent-form">
        {!initial && <div className="field" style={{ gridColumn: '1 / -1' }}><Segmented options={['Registry person', 'Staff member']} value={kind === 'person' ? 'Registry person' : 'Staff member'} onChange={(v) => { setKind(v === 'Staff member' ? 'member' : 'person'); setId(''); }} label="Who" /></div>}
        {!initial && <div className="field" style={{ gridColumn: '1 / -1' }}><label>{kind === 'person' ? 'Person (cleared)' : 'Staff member'} *</label>
          <select aria-label="Who" data-testid="os-consent-who" value={id} onChange={(e) => setId(e.target.value)}><option value="">Choose…</option>{choices.map((p) => <option key={p.id} value={p.id}>{p.name}{p.personClass ? ` · ${p.personClass}` : ''}</option>)}</select></div>}
        {kind === 'person' && person && <div className="field" style={{ gridColumn: '1 / -1' }}><div className="gg-row"><Photo src={person.photo} name={person.name} size={56} /><small className="muted">Their registry photo is the face the device gets. {person.photo?.startsWith('data:image/svg') ? 'This one is a drawing: take a real photo in the registry first.' : ''}</small></div></div>}
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>What they agree to</label><textarea aria-label="Consent wording" rows={3} value={text} onChange={(e) => setText(e.target.value)} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label className="gg-row" style={{ gap: 8 }}><input type="checkbox" data-testid="os-consent-tick" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ width: 'auto' }} /> They agreed (signed or told in person)</label></div>
        <div className="field"><label>Card number (QR or M1 card)</label><input aria-label="Card number" inputMode="numeric" value={card} onChange={(e) => setCard(e.target.value.replace(/\D/g, ''))} placeholder="Optional" /></div>
        {kind === 'member' && consent && <PhotoCapture value={photo} onChange={setPhoto} label={initial?.hasPhoto ? 'New face photo (optional)' : 'Face photo'} testid="os-face-photo" demoName={onV2() ? '' : (staff.find((s) => s.id === id)?.name || 'Staff')} />}
        {err && <div className="field-error" style={{ gridColumn: '1 / -1' }}>{err}</div>}
        <div className="form-actions"><button type="submit" className="btn" disabled={busy} data-testid="os-consent-save">{busy ? 'Saving…' : 'Save'}</button><button type="button" className="btn secondary" onClick={onClose}>Cancel</button></div>
      </form>
    </Modal>
  );
}

/** The browser demo: someone presents a face at a demo terminal. */
function DemoPunch({ device, people, staff }) {
  const [who, setWho] = useState(''); const [last, setLast] = useState('');
  async function go() {
    const [k, id] = who.split(':');
    const sel = k === 'p' ? people.find((p) => p.id === id) : k === 'm' ? staff.find((s) => s.id === id) : null;
    const ev = await demoPunch(device, sel ? { kind: k === 'p' ? 'person' : 'member', id: sel.id, name: sel.name, record: sel, roleName: sel.roleId } : null).catch((e) => ({ outcome: e.message }));
    setLast(`${sel?.name || 'Unknown face'}: ${ev.outcome}`);
  }
  return (
    <div className="gg-actions" style={{ alignItems: 'center' }}>
      <select aria-label="Who presents a face" data-testid="os-demo-who" value={who} onChange={(e) => setWho(e.target.value)} style={{ width: 'auto', maxWidth: 260 }}>
        <option value="">Someone it does not know</option>
        <optgroup label="Registry">{people.filter((p) => p.status === 'Active').map((p) => <option key={p.id} value={`p:${p.id}`}>{p.name} · {p.personClass}</option>)}</optgroup>
        <optgroup label="Staff">{staff.map((s) => <option key={s.id} value={`m:${s.id}`}>{s.name}</option>)}</optgroup>
      </select>
      <button type="button" className="btn secondary" data-testid="os-demo-punch" onClick={go}>Try a punch</button>
      {last && <small className="muted" data-testid="os-demo-result">{last}</small>}
    </div>
  );
}

/** Devices: each terminal and bridge, who is on them, and face consent. */
export default function OnSiteDevices({ rights }) {
  const devices = useLoad(listDevices, { every: 30000 });
  const bridges = useLoad(listBridges, { every: 60000 });
  const faces = useLoad(listFaces);
  const { records: people } = useCollection(C.GATE_PEOPLE, 'Gate');
  const { records: users } = useCollection(C.USERS, 'Users');
  const { records: roles } = useCollection(C.ROLES, 'Roles');
  const staff = useMemo(() => { const cat = new Map(roles.map((r) => [r.id, r.category])); return users.filter((u) => cat.get(u.roleId) === 'Staff' && u.status !== 'Inactive').sort((a, b) => a.name.localeCompare(b.name)); }, [users, roles]);
  const [edit, setEdit] = useState(null); const [on, setOn] = useState(null); const [token, setToken] = useState(null); const [consent, setConsent] = useState(null);
  const { ask, node } = usePrompt();
  const bl = bridges.data || [];
  async function newBridge() {
    const v = await ask({ title: 'Add a site bridge', subtitle: 'The small always-on computer at the gate that talks to the devices.', confirm: 'Add bridge', fields: [{ key: 'name', label: 'Name', required: true, value: 'Gate PC' }] });
    if (v) try { setToken(await addBridge(v.name.trim())); } catch (e) { say(e); }
  }
  async function revoke(b) {
    const v = await ask({ title: `Revoke ${b.name}?`, subtitle: 'Its token stops working at once. The devices on it keep working on their own until a new bridge takes over.', confirm: 'Revoke', fields: [{ key: 'sure', label: 'Type REVOKE to confirm', required: true }] });
    if (v && v.sure.trim().toUpperCase() === 'REVOKE') try { await revokeBridge(b.id); } catch (e) { say(e); }
  }
  async function door(d) {
    const v = await ask({ title: `Open ${d.name}`, subtitle: 'The door opens at once and the security team is told.', confirm: 'Open the door', fields: [{ key: 'reason', label: 'Reason', required: true }] });
    if (v) try { await openDoor(d, v.reason.trim()); } catch (e) { say(e); }
  }
  async function again(d) {
    try { const r = await resync(d.id); window.dispatchEvent(new CustomEvent('communityos:denied', { detail: { kind: 'success', message: `${d.name}: ${r?.enrol ?? 0} to put on, ${r?.remove ?? 0} to take off` } })); } catch (e) { say(e); }
  }
  return (
    <div data-testid="onsite-devices">
      <section className="card" style={{ marginBottom: 14 }}>
        <div className="os-head"><b>Devices</b>{rights.manages && <button type="button" className="btn" data-testid="os-add-device" onClick={() => setEdit({})}>Add device</button>}</div>
        {devices.error && <div className="field-error">{devices.error}</div>}
        {(devices.data || []).length === 0 && !devices.error && <div className="empty">No devices yet. Add the bridge first, then the terminal.</div>}
        {(devices.data || []).map((d) => {
          const up = isOnline(d);
          return (
            <div key={d.id} className={`gg-card ${d.status !== 'Active' ? '' : up ? '' : 'bad'}`} data-testid="os-device-card">
              <i className={`os-dot big ${d.status !== 'Active' ? 'off' : up ? 'ok' : 'bad'}`} aria-hidden="true" />
              <div className="gg-main">
                <b>{d.name} <small className="muted">· {d.shortId} · {d.gate} · counts {d.direction === 'Both' ? 'in and out' : d.direction.toLowerCase()}</small></b>
                <span>{[d.kind, d.make, d.model].filter(Boolean).join(' · ')}{d.host ? ` · ${d.host}${d.port ? `:${d.port}` : ''}` : ''}</span>
                <small className="muted">{d.status !== 'Active' ? 'Paused' : up ? `Online · last heard ${ago(d.lastSeenAt)}` : (d.lastSeenAt ? `Offline · last heard ${ago(d.lastSeenAt)}` : 'Not connected yet: start its bridge')}
                  {d.clockDriftS != null && ` · clock ${Math.abs(d.clockDriftS) <= 5 ? 'on time' : `${d.clockDriftS > 0 ? '+' : ''}${d.clockDriftS} s`}`}
                  {d.enrolledCount != null && ` · ${d.enrolledCount}${d.capacity ? ` of ${d.capacity}` : ''} ${d.enrolledCount === 1 && !d.capacity ? 'person' : 'people'} on it`}{d.firmware ? ` · firmware ${d.firmware}` : ''}</small>
                {d.lastError && <small className="field-error">{d.lastError}</small>}
                <div className="gg-actions">
                  <button type="button" className="btn secondary" onClick={() => setOn(d)}>Who is on it</button>
                  {rights.manages && <button type="button" className="btn secondary" onClick={() => setEdit(d)}>Change</button>}
                  {rights.manages && d.status === 'Active' && <button type="button" className="btn secondary" onClick={() => again(d)}>Resync</button>}
                  {rights.door && d.status === 'Active' && d.capabilities.includes('Relay') && <button type="button" className="btn secondary" disabled={!up} title={up ? '' : 'The device is offline'} onClick={() => door(d)}>Open door</button>}
                </div>
                {!onV2() && d.status === 'Active' && <DemoPunch device={d} people={people} staff={staff} />}
              </div>
            </div>
          );
        })}
      </section>
      <section className="card" style={{ marginBottom: 14 }}>
        <div className="os-head"><b>Site bridges</b>{rights.manages && <button type="button" className="btn secondary" data-testid="os-add-bridge" onClick={newBridge}>Add bridge</button>}</div>
        {bl.length === 0 && <div className="empty">No bridge yet. A bridge is the small computer at the gate that talks to the devices.</div>}
        {bl.map((b) => (
          <div key={b.id} className="gg-mini" data-testid="os-bridge">
            <i className={`os-dot ${b.status !== 'Active' ? 'off' : b.lastSeenAt && Date.now() - new Date(b.lastSeenAt) < 180000 ? 'ok' : 'bad'}`} aria-hidden="true" />
            <div className="gg-main"><b>{b.name} <span className="muted" style={{ fontWeight: 400 }}>· {b.shortId}</span></b><small className="muted">{b.status === 'Active' ? `Last heard ${ago(b.lastSeenAt)}${b.agentVersion ? ` · ${b.agentVersion}` : ''} · token …${b.tokenHint}` : 'Revoked'}</small></div>
            {rights.manages && b.status === 'Active' && <button type="button" className="link-btn" onClick={() => revoke(b)}>Revoke</button>}
          </div>
        ))}
      </section>
      <section className="card">
        <div className="os-head"><b>People on the devices</b>{rights.records && <button type="button" className="btn secondary" data-testid="os-add-consent" onClick={() => setConsent({})}>Record consent</button>}</div>
        <p className="muted" style={{ marginTop: 4 }}>Cleared registry people who work for a villa or are on an active roster, and staff with their own photo, go on every device once they agree. Staff photos are deleted 30 days after they leave.</p>
        {faces.error && <div className="field-error">{faces.error}</div>}
        {(faces.data || []).length === 0 && !faces.error && <div className="empty">No consent recorded yet.</div>}
        {(faces.data || []).map((f) => {
          const agreed = f.consentAt && !f.withdrawnAt;
          return (
            <div key={`${f.subjectKind}:${f.subjectId}`} className="gg-mini clickable" data-testid="os-face" onClick={() => rights.records && setConsent(f)}>
              <div className="gg-main"><b>{f.name}</b><small className="muted">{f.subjectKind === 'member' ? 'Staff' : 'Registry'}{agreed ? ` · agreed ${stamp(f.consentAt)}` : f.withdrawnAt ? ` · withdrew ${stamp(f.withdrawnAt)}` : ' · not agreed'}{f.cardNo ? ` · card ${f.cardNo}` : ''}{!f.hasPhoto ? ' · no photo' : ''}</small></div>
              <span className="muted hide-sm" style={{ marginRight: 8 }}>{agreed ? `on ${f.onDevices}` : ''}</span>
              <span className={`tag ${agreed ? 'green' : f.withdrawnAt ? '' : 'orange'}`}>{agreed ? 'Agreed' : f.withdrawnAt ? 'Withdrawn' : 'Not agreed'}</span>
            </div>
          );
        })}
      </section>
      {edit && <DeviceForm device={edit.id ? edit : null} bridges={bl} onClose={() => setEdit(null)} />}
      {on && <WhoIsOn device={on} onClose={() => setOn(null)} />}
      {token && <NewToken made={token} onClose={() => setToken(null)} />}
      {consent && <ConsentForm initial={consent.subjectId ? consent : null} people={people} staff={staff} onClose={() => setConsent(null)} />}
      {node}
    </div>
  );
}

