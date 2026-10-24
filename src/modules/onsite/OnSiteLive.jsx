import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { GROUPS, groupOf, isOnline, listBridges, listDevices, listEvents, eventPhoto, openDoor } from '../../lib/site/site.js';
import { CREW_CLASSES } from '../../lib/gate/constants.js';
import { usePrompt } from '../../components/PromptDialog.jsx';
import Modal from '../../components/Modal.jsx';
import { Photo, StateTag, clock, Countdown } from '../gate/gateUi.jsx';
import { useLoad, reread, ago } from './useSite.js';

const DAY = 86400000;
const recent = (iso) => !!iso && Date.now() - new Date(iso).getTime() < DAY;
const latest = (v) => (v.outAt && v.outAt > (v.inAt || '') ? v.outAt : v.inAt);

/** A punch the platform kept without a visit (refused, unknown, a double tap): its group from who it was. */
function eventGroup(e, people) {
  if (e.subjectKind === 'member') return 'Staff';
  if (e.subjectKind === 'person') { const p = people.find((x) => x.id === e.subjectId); return p && CREW_CLASSES.includes(p.personClass) ? 'Contractors' : 'Household'; }
  return 'Visitors';
}

function Snapshot({ e, onClose }) {
  const [src, setSrc] = useState(null);
  useEffect(() => { eventPhoto(e.id).then(setSrc).catch(() => setSrc('')); }, [e.id]);
  return (
    <Modal title={e.name || 'Unknown person'} subtitle={`${e.deviceName} · ${clock(e.at)} · ${e.credential}`} onClose={onClose}>
      {src === null ? <p className="muted">Loading…</p> : src ? <img src={src} alt="Snapshot from the device" style={{ maxWidth: '100%', borderRadius: 10 }} data-testid="os-snapshot" /> : <p className="muted">The device sent no snapshot.</p>}
      <p>{e.outcome || e.reason}</p>
    </Modal>
  );
}

/** Live: who is inside now by group, open flags, the devices, every punch and entry, and the visitors waiting for a decision. */
export default function OnSiteLive({ rights, onNavigate }) {
  const { records: visits } = useCollection(C.GATE_VISITS, 'Gate');
  const { records: flags } = useCollection(C.GATE_FLAGS, 'Gate');
  const { records: approvals } = useCollection(C.GATE_APPROVALS, 'Gate');
  const { records: people } = useCollection(C.GATE_PEOPLE, 'Gate');
  const devices = useLoad(listDevices, { every: 30000 });
  const bridges = useLoad(listBridges, { every: 60000 });
  const events = useLoad(() => listEvents({ limit: 150 }), { every: 8000 });
  const [group, setGroup] = useState('All');
  const [snap, setSnap] = useState(null);
  const { ask, node } = usePrompt();
  // a new punch from a device means new visits, flags or attendance on the server: read them again
  const top = useRef(null);
  useEffect(() => {
    const first = events.data?.[0]?.id || null;
    if (top.current !== null && first !== top.current) reread(C.GATE_VISITS, C.GATE_FLAGS, C.GATE_APPROVALS);
    top.current = first;
  }, [events.data]);
  useEffect(() => { const t = setInterval(() => reread(C.GATE_APPROVALS, C.GATE_VISITS), 20000); return () => clearInterval(t); }, []);

  const inside = useMemo(() => visits.filter((v) => v.state === 'Inside'), [visits]);
  const count = (g) => inside.filter((v) => groupOf(v.kind) === g).length;
  const openFlags = flags.filter((f) => f.state === 'Open').length;
  const waiting = approvals.filter((a) => a.status === 'Pending' || a.status === 'No answer').sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)));
  const feed = useMemo(() => {
    const rows = visits.filter((v) => recent(latest(v)) && v.state !== 'Awaiting approval')
      .map((v) => ({ key: `v${v.id}`, at: latest(v), group: groupOf(v.kind), visit: v }));
    for (const e of events.data || []) if (!e.visitId) rows.push({ key: `e${e.id}`, at: e.at, group: eventGroup(e, people), event: e });
    return rows.filter((r) => group === 'All' || r.group === group).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 80);
  }, [visits, events.data, people, group]);

  async function door(d) {
    const v = await ask({ title: `Open ${d.name}`, subtitle: 'The door opens at once and the security team is told. Say why.', confirm: 'Open the door', fields: [{ key: 'reason', label: 'Reason', required: true }] });
    if (!v) return;
    try { await openDoor(d, v.reason.trim()); } catch (e) { window.dispatchEvent(new CustomEvent('communityos:denied', { detail: { message: e.message, kind: 'error' } })); }
  }
  const toGate = (tab) => { try { sessionStorage.setItem('communityos:openTab', `gate.${tab}`); } catch { /* ignore */ } onNavigate?.('security'); };
  const tiles = [...GROUPS.map((g) => ({ g, n: count(g) })), { g: 'Open flags', n: openFlags, warn: openFlags > 0 }];

  return (
    <div data-testid="onsite-live">
      <div className="os-tiles" role="group" aria-label="Inside now">
        {tiles.map((t) => (
          <button key={t.g} type="button" className={`gg-kpi${t.warn ? ' warn' : ''}${group === t.g ? ' on' : ''}`} data-testid={`os-tile-${t.g.replace(/\s/g, '').toLowerCase()}`}
            onClick={() => (t.g === 'Open flags' ? toGate('flags') : setGroup(group === t.g ? 'All' : t.g))}>
            <span className="muted">{t.g}</span><b>{t.n}</b><small className="muted">{t.g === 'Open flags' ? 'to act on' : 'inside now'}</small>
          </button>
        ))}
      </div>
      <div className="os-strip card" data-testid="os-devices-strip">
        <b>Devices</b>
        {(devices.data || []).length === 0 && <span className="muted">{devices.error || 'None yet'}</span>}
        {(devices.data || []).map((d) => (
          <span key={d.id} className="os-dev" data-testid="os-device">
            <i className={`os-dot ${d.status !== 'Active' ? 'off' : isOnline(d) ? 'ok' : 'bad'}`} aria-hidden="true" />
            {d.name}<small className="muted"> · {d.status !== 'Active' ? 'paused' : isOnline(d) ? 'online' : (d.lastSeenAt ? `offline ${ago(d.lastSeenAt)}` : 'not connected yet')}</small>
            {rights.door && d.status === 'Active' && d.capabilities.includes('Relay') && <button type="button" className="link-btn" data-testid="os-open-door" disabled={!isOnline(d)} title={isOnline(d) ? '' : 'The device is offline'} onClick={() => door(d)}>Open door</button>}
          </span>
        ))}
        {(bridges.data || []).filter((b) => b.status === 'Active').map((b) => (
          <span key={b.id} className="os-dev"><i className={`os-dot ${b.lastSeenAt && Date.now() - new Date(b.lastSeenAt) < 180000 ? 'ok' : 'bad'}`} aria-hidden="true" />{b.name}<small className="muted"> · bridge, {ago(b.lastSeenAt)}</small></span>
        ))}
      </div>
      <div className="os-cols">
        <section className="card" data-testid="os-feed">
          <div className="os-head"><b>Punches and entries</b><small className="muted hide-sm">last 24 hours</small></div>
          <div className="gg-chips" style={{ margin: '8px 0 10px' }}>{['All', ...GROUPS].map((g) => <button key={g} type="button" className={group === g ? 'on' : ''} aria-pressed={group === g} onClick={() => setGroup(g)}>{g}</button>)}</div>
          {feed.length === 0 && <div className="empty">Nothing yet{group === 'All' ? '' : ` for ${group.toLowerCase()}`}.</div>}
          {feed.map((r) => (r.visit ? (
            <div key={r.key} className="gg-mini" data-testid="os-feed-row">
              <Photo src={r.visit.photo} name={r.visit.name} size={36} />
              <div className="gg-main"><b>{r.visit.name}</b><small className="muted">{[r.visit.kind, r.visit.unit && r.visit.unit !== 'Common area' && r.visit.unit, r.visit.company, r.visit.vehicle].filter(Boolean).join(' · ')}</small>
                <small className="muted">{['Refused', 'Denied', 'Left at gate'].includes(r.visit.state) ? `Turned away ${clock(r.visit.outAt || r.visit.inAt)}${r.visit.method ? ` · ${r.visit.method}` : ''}`
                  : r.visit.outAt && r.visit.outAt >= (r.visit.inAt || '') ? `Out ${clock(r.visit.outAt)}${r.visit.outMethod ? ` · ${r.visit.outMethod}` : ''}` : `In ${clock(r.visit.inAt)}${r.visit.method ? ` · ${r.visit.method}` : ''}`}</small></div>
              <StateTag state={r.visit.state} />
            </div>
          ) : (
            <div key={r.key} className="gg-mini" data-testid="os-feed-event">
              <span className={`os-badge ${r.event.result === 'Refused' || !r.event.subjectId ? 'bad' : ''}`} aria-hidden="true">{r.event.credential === 'Face' ? '☺' : '▤'}</span>
              <div className="gg-main"><b>{r.event.name || 'Unknown person'}</b><small className="muted">{r.event.credential} · {r.event.deviceName} · {clock(r.event.at)}</small><small className="muted">{r.event.outcome}</small></div>
              {r.event.hasPhoto ? <button type="button" className="link-btn" onClick={() => setSnap(r.event)}>Snapshot</button> : <span className={`tag ${r.event.result === 'Refused' || !r.event.subjectId ? 'gg-tag-coral' : ''}`}>{r.event.result === 'Refused' ? 'Refused' : r.event.subjectId ? 'Not counted' : 'Unknown'}</span>}
            </div>
          )))}
        </section>
        <section className="card" data-testid="os-waiting">
          <div className="os-head"><b>Waiting for a decision</b>{waiting.length > 0 && <span className="tag orange">{waiting.length}</span>}</div>
          {waiting.length === 0 && <div className="empty">Nobody is waiting.</div>}
          {waiting.map((a) => (
            <div key={a.id} className="gg-card hot" data-testid="os-waiting-card">
              <Photo src={a.photo} name={a.name} size={44} />
              <div className="gg-main"><b>{a.name}</b><small className="muted">{[a.kind, a.unit, a.purpose].filter(Boolean).join(' · ')}</small>
                <small className="muted">{a.status === 'Pending' ? <>Asked {clock(a.requestedAt)} · <Countdown until={a.expiresAt} /></> : 'No answer: the guard decides'}</small>
                {rights.door && <div className="gg-actions"><button type="button" className="btn secondary" onClick={() => toGate('console')}>Open in the gate console</button></div>}
              </div>
            </div>
          ))}
        </section>
      </div>
      {snap && <Snapshot e={snap} onClose={() => setSnap(null)} />}
      {node}
    </div>
  );
}
