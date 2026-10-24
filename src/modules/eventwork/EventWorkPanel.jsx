import React, { useMemo, useState } from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import { notify } from '../../lib/notify.js';
import RecordModal from '../billing/RecordModal.jsx';
import { fmtDate, todayLocal, plannedTime } from '../../lib/locale.js';

export const PHASES = ['Before the event', 'During the event', 'After the event'];
export const OWNER_ROLE_IDS = { 'Facility Manager': ['facility_manager'], MEP: ['handyman_mep'] };
const TONE = { 'Not started': '', 'In progress': 'blue', Blocked: 'red', Done: 'green', Cancelled: '' };
const today = () => todayLocal();
export const dmy = (s) => fmtDate(s, { year: false });
const late = (w) => !['Done', 'Cancelled'].includes(w.status) && w.neededOn < today();

/** Tell the owning role when work is given or changed. */
export async function tellOwner(w, old) {
  const was = old ? `${old.ownerRole}|${old.status}|${old.neededOn}|${old.staffRequested}` : '';
  if (was === `${w.ownerRole}|${w.status}|${w.neededOn}|${w.staffRequested}`) return;
  await notify({ event: 'event_work', title: `${old ? 'Event work updated' : 'Event work for you'} · ${w.eventName}`, body: `${w.title} — ${w.phase.toLowerCase()}, needed ${dmy(w.neededOn)}${w.staffRequested ? `, ${w.staffRequested} ${w.staffType || 'people'} requested` : ''}. Status: ${w.status}.`, link: '', kind: 'event_work', by: getPrincipal()?.name || '', toRoleIds: OWNER_ROLE_IDS[w.ownerRole] || [], ...(w.ownerName ? { toName: w.ownerName } : {}) });
}

export function WorkRow({ w, canWrite, onEdit, showEvent }) {
  const { save } = useCollection(C.EVENT_WORK, 'Event work');
  const done = w.status === 'Done';
  return (
    <li data-testid="work-row" style={{ display: 'block' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {canWrite && <input type="checkbox" aria-label={`Mark ${w.title} done`} data-testid="work-done" checked={done} onChange={async (e) => { const n = { ...w, status: e.target.checked ? 'Done' : 'In progress', doneAt: e.target.checked ? today() : '' }; await save(n); }} />}
        <b style={done ? { textDecoration: 'line-through', opacity: 0.6 } : undefined}>{w.title}</b>
        <span className={`tag ${TONE[w.status] || ''}`}>{w.status}</span>
        {late(w) && <span className="tag red">Late</span>}
        <span className="tag blue">{w.ownerRole}{w.ownerName ? ` · ${w.ownerName}` : ''}</span>
        <span style={{ flex: 1 }} />
        {canWrite && <button className="btn secondary sm" onClick={() => onEdit(w)}>Edit</button>}
      </div>
      <small className="muted">{showEvent ? `${w.eventName} · ` : ''}{w.phase} · needed {dmy(w.neededOn)}{w.startTime ? ` ${plannedTime(`${w.startTime}${w.endTime ? `–${w.endTime}` : ''}`)}` : ''}{w.staffRequested ? ` · ${w.staffConfirmed || 0}/${w.staffRequested} ${w.staffType || 'people'} confirmed` : ''}</small>
      {w.details && <div style={{ fontSize: 13 }}>{w.details}</div>}
    </li>
  );
}

/** Work list for ONE event (cultural event or booking). */
export default function EventWorkPanel({ kind, eventId, eventName, eventDate }) {
  const { records } = useCollection(C.EVENT_WORK, 'Event work');
  const canWrite = canWriteCollection(C.EVENT_WORK, getPrincipal());
  const [edit, setEdit] = useState(null);
  const mine = useMemo(() => records.filter((w) => w.eventId === eventId).sort((a, b) => String(a.neededOn).localeCompare(String(b.neededOn))), [records, eventId]);
  const open = mine.filter((w) => !['Done', 'Cancelled'].includes(w.status)).length;
  const people = mine.filter((w) => w.status !== 'Cancelled').reduce((s, w) => s + (Number(w.staffRequested) || 0), 0);
  return (
    <div data-testid="event-work-panel">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <b>{mine.length} item{mine.length === 1 ? '' : 's'}</b><span className="muted">· {open} to do · {people} people requested</span><span style={{ flex: 1 }} />
        {canWrite && <button className="btn sm" data-testid="add-work" onClick={() => setEdit({ eventKind: kind, eventId, eventName, eventDate, phase: 'Before the event', neededOn: eventDate, status: 'Not started', ownerRole: 'Facility Manager' })}>+ Add work</button>}
      </div>
      {mine.length === 0 ? <div className="empty">No work planned for this event yet.</div> : PHASES.map((p) => { const l = mine.filter((w) => w.phase === p); return l.length ? (
        <div key={p} style={{ marginBottom: 10 }}><h4 style={{ margin: '6px 0' }}>{p}</h4><ul className="list">{l.map((w) => <WorkRow key={w.id} w={w} canWrite={canWrite} onEdit={setEdit} />)}</ul></div>) : null; })}
      {edit && <RecordModal collection={C.EVENT_WORK} label="Event work" record={edit} title={edit.id ? 'Edit work' : 'Add work'} subtitle={eventName} hide={['eventKind', 'eventName', 'eventDate']} allowDelete={!!edit.id} onSaved={tellOwner} onClose={() => setEdit(null)} />}
    </div>
  );
}
