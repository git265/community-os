// Maintenance → Planned works: recurring checklists (the STP / WTP weekly, monthly and yearly works, DG checks, pool tests ...) and their rounds.
// The board shows each checklist's round for this period (and the last one, if it was missed); a round is filled in task by task.
import React, { useMemo, useRef, useState } from 'react';
import Modal from '../../components/Modal.jsx';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import { AttachmentList, AttachmentPicker } from '../../components/Attachments.jsx';
import { persistPending } from '../../lib/files/attachments.js';
import { StatTiles, Segmented } from '../../components/ui.jsx';
import { printTable } from '../../components/TablePrint.jsx';
import { readWorkbook } from '../../lib/files/xlsxRead.js';
import { escapeHtml } from '../../lib/escapeHtml.js';
import { uuid } from '../../lib/uuid.js';
import { fmtDate, fmtDateTime } from '../../lib/locale.js';
import { FREQUENCIES, RESULTS, WEEKDAYS, STARTERS, checklistRow, periodOf, dueText, parseList, tasksFromText, itemsFor, countsOf, boardOf, parseSheet, isoDay } from '../../lib/plannedWorks.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dmy = (s) => fmtDate(s, { empty: '—' });
const RESULT_OPTIONS = RESULTS.map((r) => ({ value: r, label: r, tone: r === 'Done' ? 'pw-ok' : r === 'Not OK' ? 'pw-bad' : '' }));
const STATE = { overdue: ['Overdue', 'red'], missed: ['Missed', 'red'], done: ['Done', 'green'] };
const stateTag = (b) => {
  if (STATE[b.state]) return STATE[b.state];
  return b.days === 0 ? ['Due today', 'orange'] : [`Due in ${b.days} day${b.days === 1 ? '' : 's'}`, 'blue'];
};
const openTicket = (ref) => window.dispatchEvent(new CustomEvent('communityos:openlink', { detail: { link: `#/ticket/${ref}` } }));

export default function PlannedWorks({ onRaise = null, categories = [] }) {
  const { roles = [], community } = useApp();
  const me = getPrincipal();
  const canPlan = canWriteCollection(C.CHECKLISTS, me);
  const canFill = canWriteCollection(C.CHECKLIST_ROUNDS, me);
  const { records: checklists, save: saveChecklist, loading } = useCollection(C.CHECKLISTS, 'Planned works');
  const { records: rounds, save: saveRound } = useCollection(C.CHECKLIST_ROUNDS, 'Planned works');
  const [editing, setEditing] = useState(null);   // a checklist draft
  const { records: users } = useCollection(C.USERS, 'Users', { enabled: !!editing });   // read only to pick a person
  const [view, setView] = useState('board');
  const [tile, setTile] = useState('all');
  const [area, setArea] = useState('');
  const [freq, setFreq] = useState('');
  const [open, setOpen] = useState(null);         // { checklist, period, round }
  const [history, setHistory] = useState(null);   // a checklist
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const today = isoDay(new Date());

  const roleName = (id) => roles.find((r) => r.id === id)?.name || id || '';
  const whoOf = (c) => [c.assigneeName, roleName(c.assigneeRole)].filter(Boolean).join(' · ') || 'Facility Manager';
  const board = useMemo(() => boardOf(checklists, rounds, today), [checklists, rounds, today]);
  const areas = useMemo(() => [...new Set(checklists.map((c) => c.area).filter(Boolean))].sort(), [checklists]);
  const shown = board.filter((b) => (!area || b.checklist.area === area) && (!freq || b.checklist.frequency === freq));
  const late = (b) => b.state === 'overdue' || b.state === 'missed';
  const soon = (b) => b.state === 'due' && b.days <= 7;
  const tiles = [
    { key: 'all', label: 'All rounds', count: shown.length },
    { key: 'late', label: 'Overdue or missed', count: shown.filter(late).length, tone: 'warn' },
    { key: 'week', label: 'Due in 7 days', count: shown.filter(soon).length },
    { key: 'done', label: 'Done this period', count: shown.filter((b) => b.state === 'done').length },
  ];
  const list = shown.filter((b) => tile === 'all' || (tile === 'late' ? late(b) : tile === 'week' ? soon(b) : b.state === 'done'));
  // completion by area: this period's rounds that are done, of all this period's rounds
  const byArea = useMemo(() => {
    const m = new Map();
    for (const b of board) {
      if (b.state === 'missed') continue;
      const k = b.checklist.area || 'Other';
      const x = m.get(k) || { done: 0, total: 0 }; x.total += 1; if (b.state === 'done') x.done += 1; m.set(k, x);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [board]);
  const missing = STARTERS.filter((s) => !checklists.some((c) => c.name.toLowerCase() === s.name.toLowerCase()));

  async function addStarters() {
    if (!missing.length) return;
    setBusy(true);
    try { for (const s of missing) { if (!(await saveChecklist(checklistRow(s)))) break; } } finally { setBusy(false); }
  }
  const blank = () => ({ name: '', area: area || '', category: '', frequency: 'Weekly', dueDay: 7, dueMonth: null, startsOn: today, assigneeRole: '', assigneeId: '', tasks: '[]', active: true, notes: '' });

  if (loading && !checklists.length) return <div className="empty">Loading planned works…</div>;
  return (
    <div data-testid="planned-works">
      <div className="pw-head">
        <Segmented options={[{ value: 'board', label: 'Due now' }, { value: 'lists', label: `Checklists (${checklists.length})` }]} value={view} onChange={setView} label="Planned works view" />
        <span style={{ flex: 1 }} />
        {canPlan && missing.length > 0 && <button type="button" className="btn secondary" data-testid="pw-starters" disabled={busy} onClick={addStarters}>{busy ? 'Adding…' : `+ Starter checklists (${missing.length})`}</button>}
        {canPlan && <button type="button" className="btn secondary" data-testid="pw-import" onClick={() => setImporting(true)}>Import sheet</button>}
        {canPlan && <button type="button" className="btn" data-testid="pw-new" onClick={() => setEditing(blank())}>+ Checklist</button>}
      </div>

      {!checklists.length ? (
        <div className="empty" data-testid="pw-empty">
          No planned works yet. {canPlan ? 'Add the starter checklists (STP / WTP works, DG set, electrical panels, pumps, pool and tanks), import your works sheet, or make your own.' : 'The Facility Manager or MEP sets them up.'}
        </div>
      ) : view === 'board' ? (
        <>
          <StatTiles label="Planned works — tap a tile to filter" items={tiles} value={tile} onChange={setTile} />
          <div className="pw-filters">
            <select aria-label="Area" data-testid="pw-area" value={area} onChange={(e) => setArea(e.target.value)}><option value="">All areas</option>{areas.map((a) => <option key={a}>{a}</option>)}</select>
            <select aria-label="How often" data-testid="pw-freq" value={freq} onChange={(e) => setFreq(e.target.value)}><option value="">Any frequency</option>{FREQUENCIES.map((f) => <option key={f}>{f}</option>)}</select>
            <div className="pw-areas" data-testid="pw-by-area">{byArea.map(([k, x]) => <span key={k} className={`tag ${x.done === x.total ? 'green' : 'blue'}`}>{k} {x.done}/{x.total}</span>)}</div>
          </div>
          {!list.length ? <div className="empty">Nothing here.</div> : (
            <div className="pw-list">
              {list.map((b) => {
                const c = b.checklist; const items = itemsFor(c, b.round); const n = countsOf(items); const [label, tone] = stateTag(b);
                return (
                  <button type="button" key={`${c.id}|${b.period.key}`} className="pw-row" data-testid="pw-row" onClick={() => setOpen({ checklist: c, period: b.period, round: b.round })}>
                    <span className="pw-main">
                      <b>{c.name}</b>
                      <small className="muted">{[c.area, c.frequency, b.period.label, `due ${dmy(b.period.dueOn)}`, whoOf(c)].filter(Boolean).join(' · ')}</small>
                      {b.lastDone && b.state !== 'done' && <small className="muted">Last done {b.lastDone.period ? periodOf(c, b.lastDone.dueOn).label : ''} · {dmy(b.lastDone.completedAt || b.lastDone.dueOn)}</small>}
                    </span>
                    <span className="pw-side">
                      <span className={`tag ${tone}`}>{label}</span>
                      <small>{n.done}/{n.total}{n.notOk ? <span className="tag red" style={{ marginLeft: 6 }}>{n.notOk} not OK</span> : null}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <div className="card"><div className="table-wrap"><table className="resp-table" data-testid="pw-lists">
          <thead><tr><th>Checklist</th><th>Area</th><th>How often</th><th>Done by</th><th>Tasks</th><th>Last done</th><th /></tr></thead>
          <tbody>{[...checklists].sort((a, b) => (a.active === false) - (b.active === false) || a.name.localeCompare(b.name)).map((c) => {
            const last = rounds.filter((r) => r.checklistId === c.id && r.status === 'Done').sort((a, b) => (a.dueOn < b.dueOn ? 1 : -1))[0];
            return (
              <tr key={c.id} className={c.active === false ? 'muted' : ''}>
                <td data-label="Checklist"><b>{c.name}</b>{c.active === false && <span className="tag" style={{ marginLeft: 6 }}>Off</span>}</td>
                <td data-label="Area">{c.area || '—'}</td>
                <td data-label="How often">{c.frequency} <small className="muted">{dueText(c)}</small></td>
                <td data-label="Done by">{whoOf(c)}</td>
                <td data-label="Tasks">{parseList(c.tasks).length}</td>
                <td data-label="Last done">{last ? `${periodOf(c, last.dueOn).label} · ${dmy(last.completedAt || last.dueOn)}` : '—'}</td>
                <td data-label="">
                  <button type="button" className="btn secondary sm" data-testid="pw-history" onClick={() => setHistory(c)}>History</button>{' '}
                  {canPlan && <button type="button" className="btn secondary sm" data-testid="pw-edit" onClick={() => setEditing({ ...c })}>Edit</button>}
                </td>
              </tr>
            );
          })}</tbody>
        </table></div></div>
      )}

      {open && <RoundDialog {...open} canFill={canFill} canReopen={canPlan} onRaise={onRaise} save={saveRound} community={community?.name} onClose={() => setOpen(null)} />}
      {history && <HistoryDialog checklist={history} rounds={rounds.filter((r) => r.checklistId === history.id)} community={community?.name}
        onOpen={(r) => setOpen({ checklist: history, period: { ...periodOf(history, r.dueOn), key: r.period, dueOn: r.dueOn }, round: r })} onClose={() => setHistory(null)} />}
      {editing && <ChecklistEditor draft={editing} all={checklists} roles={roles} users={users} categories={categories} save={saveChecklist} onClose={() => setEditing(null)} />}
      {importing && <ImportDialog existing={checklists} save={saveChecklist} onClose={() => setImporting(false)} />}
    </div>
  );
}

/** One round: each task Done / Not OK / N/A with a remark; photos; Save (in progress) or Finish. A finished round reads as a sheet. */
function RoundDialog({ checklist, period, round, canFill, canReopen, onRaise, save, community, onClose }) {
  const [cur, setCur] = useState(round);   // the round as saved (its id and version once it exists)
  const [items, setItems] = useState(() => itemsFor(checklist, round));
  const itemsRef = useRef(items); itemsRef.current = items;
  const [notes, setNotes] = useState(round?.notes || '');
  const [files, setFiles] = useState(Array.isArray(round?.photos) ? round.photos : []);
  const [detach, setDetach] = useState([]);
  const [pending, setPending] = useState([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [id] = useState(() => round?.id || uuid());
  const sheet = useRef(null);
  const done = cur?.status === 'Done';
  const locked = done || !canFill;
  const n = countsOf(items);
  const set = (i, patch) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  async function persist(status, list = itemsRef.current) {
    setErr('');
    if (status === 'Done' && list.some((x) => !x.result)) { setErr('Mark every task Done, Not OK or N/A before finishing the round.'); return null; }
    if (status === 'Done' && list.some((x) => x.result === 'Not OK' && !String(x.remark || '').trim())) { setErr('Say what is wrong for each task marked Not OK.'); return null; }
    setBusy(true);
    try {
      let metas = files;
      if (pending.length) { const added = await persistPending(pending, { ownerType: 'checklistRound', ownerId: cur?.id || id }); if (!added) return null; metas = [...files, ...added]; }
      const rec = await save({
        ...(cur || {}), id: cur?.id || id, checklistId: checklist.id, period: period.key, dueOn: period.dueOn, status, items: JSON.stringify(list), notes: notes.trim(), photos: metas,
        completedAt: status === 'Done' ? (cur?.completedAt || new Date().toISOString()) : null, doneBy: getPrincipal()?.name || '', ...(detach.length ? { _detach: detach } : {}),
      });
      if (rec) { setCur(rec); setPending([]); setDetach([]); setFiles(Array.isArray(rec.photos) ? rec.photos : metas); }
      return rec;
    } finally { setBusy(false); }
  }
  // Not OK: the technician decides each time whether it needs a ticket; the ticket's number is kept on the task
  function raise(i) {
    const x = itemsRef.current[i];
    onRaise({
      title: `${checklist.name}: ${x.text}`.slice(0, 140), category: checklist.category || '', location: checklist.area || '',
      description: `<p>Planned works · ${escapeHtml(checklist.name)} · ${escapeHtml(period.label)}</p>${x.remark ? `<p>${escapeHtml(x.remark)}</p>` : ''}`,
    }, async (saved) => {
      const ref = saved?.ticketNumber || saved?.shortId || '';
      if (!ref) return;
      const next = itemsRef.current.map((y, j) => (j === i ? { ...y, ticketRef: ref } : y));
      setItems(next); itemsRef.current = next;
      await persist(cur?.status === 'Done' ? 'Done' : 'In progress', next);
    });
  }
  const ticketCell = (x, i) => (x.result !== 'Not OK' ? null : x.ticketRef
    ? <button type="button" className="link-btn" data-testid="pw-ticket" onClick={() => { onClose(); openTicket(x.ticketRef); }}>🎫 {x.ticketRef}</button>
    : onRaise && canFill ? <button type="button" className="btn secondary sm" data-testid="pw-raise" disabled={busy} onClick={() => raise(i)}>Raise a ticket</button> : null);

  return (
    <Modal title={`${checklist.name} · ${period.label}`} subtitle={`${checklist.area ? `${checklist.area} · ` : ''}due ${dmy(period.dueOn)}${done ? ` · finished ${fmtDateTime(cur.completedAt)}${cur.doneBy ? ` by ${cur.doneBy}` : ''}` : cur?.doneBy ? ` · last saved by ${cur.doneBy}` : ''}`} onClose={onClose} wide>
      {err && <div className="notice error" data-testid="pw-error">{err}</div>}
      {done ? (
        <div className="table-wrap"><table className="table resp-table" ref={sheet} data-testid="pw-sheet">
          <thead><tr><th>S.No</th><th>Work</th><th>Result</th><th>Remarks</th><th>Ticket</th></tr></thead>
          <tbody>{items.map((x, i) => (
            <tr key={x.taskId || i}><td data-label="S.No">{i + 1}</td><td data-label="Work">{x.text}</td>
              <td data-label="Result"><span className={`tag ${x.result === 'Not OK' ? 'red' : x.result === 'Done' ? 'green' : ''}`}>{x.result || '—'}</span></td>
              <td data-label="Remarks">{x.remark || '—'}</td><td data-label="Ticket">{ticketCell(x, i) || '—'}</td></tr>
          ))}</tbody>
        </table></div>
      ) : (
        <div className="pw-items" data-testid="pw-items">
          {!canFill && <div className="notice">Only the staff and the committee fill in planned works.</div>}
          {items.map((x, i) => (
            <div key={x.taskId || i} className={`pw-item${x.result === 'Not OK' ? ' bad' : ''}`} data-testid="pw-item">
              <div className="pw-item-text"><span className="muted">{i + 1}.</span> {x.text}</div>
              <div className="pw-item-acts">
                {locked ? <span className="tag">{x.result || '—'}</span>
                  : <Segmented options={RESULT_OPTIONS} value={x.result} onChange={(v) => set(i, { result: x.result === v ? '' : v })} label={`Result: ${x.text}`} />}
                <input aria-label={`Remark: ${x.text}`} className="pw-remark" placeholder={x.result === 'Not OK' ? 'What is wrong?' : 'Remark (optional)'} value={x.remark || ''} disabled={locked} maxLength={1000} onChange={(e) => set(i, { remark: e.target.value })} />
                {ticketCell(x, i)}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="field" style={{ marginTop: 12 }}><label>Photos</label>
        <AttachmentList items={files} onRemove={locked ? undefined : (i) => { const f = files[i]; setFiles(files.filter((_, j) => j !== i)); if (f?.fileId) setDetach((d) => [...d, f.fileId]); }} />
        {!locked && <AttachmentPicker pending={pending} onChange={setPending} label="Add photo" compact />}
      </div>
      <div className="field" style={{ marginTop: 8 }}><label>Notes</label>
        {locked ? <div>{notes || <span className="muted">—</span>}</div> : <textarea aria-label="Notes" rows={2} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} />}
      </div>
      <div className="form-actions pw-actions">
        {done && <button type="button" className="btn secondary" data-testid="pw-print" onClick={() => sheet.current && printTable(sheet.current, `${checklist.name} · ${period.label}`, community)}>🖨 Print</button>}
        {done && canReopen && <button type="button" className="btn secondary" data-testid="pw-reopen" disabled={busy} onClick={() => persist('In progress')}>Reopen</button>}
        {!locked && <span className="muted pw-count">{n.done}/{n.total} marked</span>}
        {!locked && n.done < n.total && <button type="button" className="btn secondary" data-testid="pw-all-done" onClick={() => setItems((xs) => xs.map((x) => (x.result ? x : { ...x, result: 'Done' })))}>Rest done</button>}
        {!locked && <button type="button" className="btn secondary" data-testid="pw-save" disabled={busy} onClick={async () => { if (await persist('In progress')) onClose(); }}>Save</button>}
        {!locked && <button type="button" className="btn" data-testid="pw-finish" disabled={busy} onClick={async () => { if (await persist('Done')) onClose(); }}>{busy ? 'Saving…' : 'Finish'}</button>}
        {locked && <button type="button" className="btn secondary" onClick={onClose}>Close</button>}
      </div>
    </Modal>
  );
}

/** A checklist's rounds, newest first, and a blank sheet to print and fill by hand. */
function HistoryDialog({ checklist, rounds, community, onOpen, onClose }) {
  const blankSheet = useRef(null);
  const tasks = parseList(checklist.tasks);
  const rows = [...rounds].sort((a, b) => (a.dueOn < b.dueOn ? 1 : -1));
  return (
    <Modal title={`History · ${checklist.name}`} subtitle={`${checklist.frequency}, ${dueText(checklist)}`} onClose={onClose} wide>
      {!rows.length ? <div className="empty">No rounds yet.</div> : (
        <div className="pw-list" data-testid="pw-history-list">
          {rows.map((r) => {
            const n = countsOf(parseList(r.items));
            return (
              <button type="button" key={r.id} className="pw-row" onClick={() => onOpen(r)}>
                <span className="pw-main"><b>{periodOf(checklist, r.dueOn).label}</b><small className="muted">due {dmy(r.dueOn)}{r.status === 'Done' ? ` · finished ${fmtDateTime(r.completedAt)}` : ''}{r.doneBy ? ` · ${r.doneBy}` : ''}</small></span>
                <span className="pw-side"><span className={`tag ${r.status === 'Done' ? 'green' : 'orange'}`}>{r.status}</span><small>{n.done}/{n.total}{n.notOk ? <span className="tag red" style={{ marginLeft: 6 }}>{n.notOk} not OK</span> : null}</small></span>
              </button>
            );
          })}
        </div>
      )}
      <table className="resp-table" ref={blankSheet} style={{ display: 'none' }}>
        <thead><tr><th>S.No</th><th>Work</th><th>Done / Not OK / N/A</th><th>Remarks</th></tr></thead>
        <tbody>{tasks.map((t, i) => <tr key={t.id}><td>{i + 1}</td><td>{t.text}</td><td>&nbsp;</td><td>&nbsp;</td></tr>)}</tbody>
      </table>
      <div className="form-actions">
        <button type="button" className="btn secondary" data-testid="pw-print-blank" onClick={() => printTable(blankSheet.current, `${checklist.name} · ${periodOf(checklist).label}`, community)}>🖨 Blank sheet</button>
        <button type="button" className="btn secondary" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

/** Make or change a checklist: what, how often and by when, by whom, its tasks (one per line). */
function ChecklistEditor({ draft, all, roles, users, categories, save, onClose }) {
  const [f, setF] = useState(() => ({ ...draft, dueDay: draft.dueDay ?? '', dueMonth: draft.dueMonth ?? '', assigneeRole: draft.assigneeRole || '', assigneeId: draft.assigneeId || '', tasksText: parseList(draft.tasks).map((t) => t.text).join('\n') }));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const put = (patch) => setF((x) => ({ ...x, ...patch }));
  const staffRoles = roles.filter((r) => r.category === 'Staff');
  const people = users.filter((u) => u.status !== 'Inactive' && staffRoles.some((r) => r.id === u.roleId) && (!f.assigneeRole || u.roleId === f.assigneeRole || (u.extraRoleIds || []).includes(f.assigneeRole)));
  const months = { Quarterly: 3, 'Half-yearly': 6, Yearly: 12 }[f.frequency] || 0;
  const cats = [...new Set([...categories, f.category].filter(Boolean))];
  async function submit() {
    setErr('');
    const name = String(f.name || '').trim();
    if (name.length < 2 || name.length > 120) return setErr('Name the checklist (2 to 120 characters), e.g. STP weekly works');
    if (all.some((c) => c.id !== draft.id && c.name.toLowerCase() === name.toLowerCase())) return setErr(`${name} already exists`);
    const tasks = tasksFromText(f.tasksText, parseList(draft.tasks));
    if (!tasks.length) return setErr('Add at least one task, one per line');
    if (tasks.length > 100) return setErr('Up to 100 tasks');
    if (tasks.some((t) => t.text.length > 300)) return setErr('A task has up to 300 characters');
    const num = (v) => (v === '' || v == null ? null : Number(v));
    setBusy(true);
    try {
      const rec = await save({
        ...draft, name, area: String(f.area || '').trim(), category: f.category || '', frequency: f.frequency, startsOn: f.startsOn || isoDay(new Date()),
        dueDay: f.frequency === 'Daily' ? null : num(f.dueDay), dueMonth: months ? num(f.dueMonth) : null,
        assigneeRole: f.assigneeRole || null, assigneeId: f.assigneeId || null, assigneeName: users.find((u) => u.id === f.assigneeId)?.name || (f.assigneeId ? draft.assigneeName || '' : ''),
        tasks: JSON.stringify(tasks), active: f.active !== false, notes: String(f.notes || '').trim(),
      });
      if (rec) onClose();
    } finally { setBusy(false); }
  }
  return (
    <Modal title={draft.id ? `Edit · ${draft.name}` : 'New checklist'} subtitle="A round of work done every day, week, month, quarter, half-year or year. Each round is ticked off task by task." onClose={onClose} wide>
      {err && <div className="notice error" data-testid="pw-edit-error">{err}</div>}
      <div className="form-grid" data-testid="pw-editor">
        <div className="field"><label>Name *</label><input aria-label="Name" value={f.name} maxLength={120} onChange={(e) => put({ name: e.target.value })} placeholder="STP weekly works" /></div>
        <div className="field"><label>Area</label><input aria-label="Area" list="pw-area-list" value={f.area || ''} maxLength={80} onChange={(e) => put({ area: e.target.value })} placeholder="STP, WTP, DG set, Swimming pool…" />
          <datalist id="pw-area-list">{[...new Set(all.map((c) => c.area).filter(Boolean))].map((a) => <option key={a} value={a} />)}</datalist></div>
        <div className="field"><label>How often *</label><select aria-label="How often" value={f.frequency} onChange={(e) => put({ frequency: e.target.value, dueDay: e.target.value === 'Weekly' ? 7 : '', dueMonth: '' })}>{FREQUENCIES.map((x) => <option key={x}>{x}</option>)}</select></div>
        {f.frequency === 'Weekly' && <div className="field"><label>Due by</label><select aria-label="Due by" value={f.dueDay || 7} onChange={(e) => put({ dueDay: Number(e.target.value) })}>{WEEKDAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</select></div>}
        {months > 0 && <div className="field"><label>Due in</label><select aria-label="Due in" value={f.dueMonth} onChange={(e) => put({ dueMonth: e.target.value })}>
          <option value="">{f.frequency === 'Yearly' ? 'December' : 'the last month'}</option>
          {Array.from({ length: months }, (_, i) => <option key={i} value={i + 1}>{f.frequency === 'Yearly' ? MONTHS[i] : `month ${i + 1} of the ${f.frequency === 'Quarterly' ? 'quarter' : 'half-year'}`}</option>)}</select></div>}
        {f.frequency !== 'Weekly' && f.frequency !== 'Daily' && <div className="field"><label>Due by day</label><input aria-label="Due by day" type="number" min={1} max={31} value={f.dueDay} onChange={(e) => put({ dueDay: e.target.value })} placeholder="last day" /></div>}
        <div className="field"><label>Category (for tickets)</label><select aria-label="Category" value={f.category || ''} onChange={(e) => put({ category: e.target.value })}><option value="">—</option>{cats.map((x) => <option key={x}>{x}</option>)}</select></div>
        <div className="field"><label>Done by (team)</label><select aria-label="Done by" value={f.assigneeRole} onChange={(e) => put({ assigneeRole: e.target.value, assigneeId: '' })}><option value="">Facility Manager</option>{staffRoles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></div>
        <div className="field"><label>Person (optional)</label><select aria-label="Person" value={f.assigneeId} onChange={(e) => put({ assigneeId: e.target.value })}><option value="">Anyone in the team</option>
          {f.assigneeId && !people.some((u) => u.id === f.assigneeId) && <option value={f.assigneeId}>{draft.assigneeName || 'Current person'}</option>}
          {people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
        <div className="field"><label>Starts on</label><input aria-label="Starts on" type="date" value={f.startsOn || ''} onChange={(e) => put({ startsOn: e.target.value })} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Tasks * <small className="muted">one per line</small></label>
          <textarea aria-label="Tasks" rows={8} value={f.tasksText} onChange={(e) => put({ tasksText: e.target.value })} placeholder={'Clean diffusers and strainers\nCheck blower air pressure'} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Notes</label><input aria-label="Notes" value={f.notes || ''} maxLength={2000} onChange={(e) => put({ notes: e.target.value })} /></div>
        {draft.id && <label className="check" style={{ gridColumn: '1 / -1' }}><input type="checkbox" checked={f.active !== false} onChange={(e) => put({ active: e.target.checked })} /> In use (switch off to stop its rounds; its history stays)</label>}
      </div>
      <div className="form-actions"><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button type="button" className="btn" data-testid="pw-editor-save" disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Save'}</button></div>
    </Modal>
  );
}

/** Import a works sheet (Excel, or text pasted from it): section rows like "WTP MONTHLY WORKS" with numbered tasks under each. */
function ImportDialog({ existing, save, onClose }) {
  const [sections, setSections] = useState(null);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const read = (rows) => { const s = parseSheet(rows); setErr(s.length ? '' : 'No sections with numbered tasks found. A section row names the area and how often, e.g. "WTP MONTHLY WORKS".'); setSections(s.map((x) => ({ ...x, take: !existing.some((c) => c.name.toLowerCase() === x.name.toLowerCase()) }))); };
  async function pick(e) {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    try {
      const XLSX = await import('xlsx');
      const wb = await readWorkbook(await file.arrayBuffer(), { type: 'array' });
      read(wb.SheetNames.flatMap((n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' })));
    } catch (x) { setErr(`Could not read ${file.name}: ${x?.message || x}`); }
  }
  const put = (i, patch) => setSections((ss) => ss.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  async function go() {
    const take = sections.filter((s) => s.take);
    if (!take.length) return setErr('Tick at least one section');
    const names = new Set(existing.map((c) => c.name.toLowerCase()));
    for (const s of take) { if (names.has(s.name.trim().toLowerCase())) return setErr(`${s.name} already exists - rename it or untick it`); names.add(s.name.trim().toLowerCase()); }
    setBusy(true);
    try { for (const s of take) { if (!(await save(checklistRow({ ...s, name: s.name.trim(), tasks: s.tasks.slice(0, 100) })))) return; } onClose(); } finally { setBusy(false); }
  }
  return (
    <Modal title="Import a works sheet" subtitle="An Excel sheet like “STP and WTP weekly, monthly and yearly works”: a row per section (WTP MONTHLY WORKS …) and numbered tasks under it. Tasks above the first section are taken as weekly works." onClose={onClose} wide>
      {err && <div className="notice error" data-testid="pw-import-error">{err}</div>}
      {!sections ? (
        <>
          <div className="field"><label>Excel file</label><input type="file" aria-label="Excel file" data-testid="pw-import-file" accept=".xlsx,.xls,.csv" onChange={pick} /></div>
          <div className="field"><label>…or paste the rows</label><textarea aria-label="Pasted rows" data-testid="pw-import-text" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={'WTP MONTHLY WORKS\n1\tComplete filter backwash and media inspection\n2\tTighten electrical terminals and panel cleaning'} /></div>
          <div className="form-actions"><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button type="button" className="btn" disabled={!text.trim()} onClick={() => read(text.split('\n').map((l) => l.split('\t')))}>Read rows</button></div>
        </>
      ) : (
        <>
          <div className="pw-list" data-testid="pw-import-preview">
            {sections.map((s, i) => (
              <div key={i} className="pw-import-row">
                <label className="check"><input type="checkbox" checked={s.take} onChange={(e) => put(i, { take: e.target.checked })} /> </label>
                <input aria-label="Checklist name" value={s.name} onChange={(e) => put(i, { name: e.target.value })} />
                <select aria-label="How often" value={s.frequency} onChange={(e) => put(i, { frequency: e.target.value })}>{FREQUENCIES.map((x) => <option key={x}>{x}</option>)}</select>
                <small className="muted">{s.tasks.length} tasks: {s.tasks.slice(0, 2).join('; ')}{s.tasks.length > 2 ? '…' : ''}</small>
              </div>
            ))}
          </div>
          <div className="form-actions"><button type="button" className="btn secondary" onClick={() => setSections(null)}>Back</button><button type="button" className="btn" data-testid="pw-import-go" disabled={busy} onClick={go}>{busy ? 'Adding…' : `Add ${sections.filter((s) => s.take).length} checklists`}</button></div>
        </>
      )}
    </Modal>
  );
}
