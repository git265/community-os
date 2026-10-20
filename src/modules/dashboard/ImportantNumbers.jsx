import React, { useMemo, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { hhmm } from '../../lib/attendance.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import RecordModal from '../billing/RecordModal.jsx';
import Modal from '../../components/Modal.jsx';

// what a resident may see of the people on duty: the roles they would actually ring
const PUBLIC_ROLE = /security|guard|facility|manager|plant|operator|electric|plumb|lift|mep|supervisor/i;
const tel = (p) => `tel:${String(p).replace(/[^\d+*#]/g, '')}`;
const KEY = 'communityos:numbersCollapsed';
const readCollapsed = () => { try { const v = localStorage.getItem(KEY); if (v !== null) return v === '1'; } catch { /* ignore */ } return typeof window !== 'undefined' && window.innerWidth < 700; };

/** Super Admin: add, rename, reorder, hide and delete the sections numbers are filed under. */
function SectionManager({ sections, numbers, onClose, save, remove, saveNumber }) {
  const [name, setName] = useState(''); const [err, setErr] = useState('');
  const next = sections.reduce((m, s) => Math.max(m, Number(s.sortOrder) || 0), 0) + 1;
  const add = async () => {
    const nm = name.trim(); if (!nm) return setErr('Type a section name');
    if (sections.some((s) => s.name.toLowerCase() === nm.toLowerCase())) return setErr('That section already exists');
    await save({ name: nm, icon: '📞', sortOrder: next, active: true }); setName(''); setErr('');
  };
  const rename = async (s) => {
    const nm = window.prompt('New name', s.name); if (!nm || !nm.trim() || nm.trim() === s.name) return;
    if (sections.some((x) => x.id !== s.id && x.name.toLowerCase() === nm.trim().toLowerCase())) return setErr('That section already exists');
    await save({ ...s, name: nm.trim() });
    for (const n of numbers.filter((x) => x.group === s.name)) await saveNumber({ ...n, group: nm.trim() }); // numbers follow the rename
  };
  const move = async (s, d) => {
    const list = [...sections].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)); const i = list.findIndex((x) => x.id === s.id); const j = i + d;
    if (j < 0 || j >= list.length) return;
    await save({ ...list[i], sortOrder: list[j].sortOrder }); await save({ ...list[j], sortOrder: list[i].sortOrder });
  };
  const del = async (s) => {
    const n = numbers.filter((x) => x.group === s.name).length;
    if (n) return setErr(`${n} number${n === 1 ? ' is' : 's are'} still in "${s.name}". Move or delete them first.`);
    if (window.confirm(`Delete the section "${s.name}"?`)) await remove(s);
  };
  return (
    <Modal title="Manage sections" subtitle="Sections group the numbers on the Command Center. Only the Super Admin can change them." onClose={onClose}>
      <div data-testid="number-sections">
        {err && <div className="notice error" role="alert">{err}</div>}
        <ul className="list">{[...sections].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)).map((s) => (
          <li key={s.id} data-testid={`sec-${s.name}`} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <b style={{ flex: 1, minWidth: 120, opacity: s.active === false ? 0.5 : 1 }}>{s.icon} {s.name} <small className="muted">({numbers.filter((x) => x.group === s.name).length})</small></b>
            <button type="button" className="btn secondary small" aria-label={`Move ${s.name} up`} onClick={() => move(s, -1)}>↑</button>
            <button type="button" className="btn secondary small" aria-label={`Move ${s.name} down`} onClick={() => move(s, 1)}>↓</button>
            <button type="button" className="btn secondary small" onClick={() => save({ ...s, active: s.active === false })}>{s.active === false ? 'Show' : 'Hide'}</button>
            <button type="button" className="btn secondary small" onClick={() => rename(s)}>Rename</button>
            <button type="button" className="btn secondary small" data-testid={`sec-del-${s.name}`} onClick={() => del(s)}>Delete</button>
          </li>))}</ul>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <input aria-label="New section" data-testid="sec-name" placeholder="New section, e.g. Lifts" value={name} onChange={(e) => { setName(e.target.value); setErr(''); }} style={{ flex: 1 }} />
          <button type="button" className="btn" data-testid="sec-add" onClick={add}>Add</button>
        </div>
        <div className="form-actions"><button type="button" className="btn" onClick={onClose}>Done</button></div>
      </div>
    </Modal>
  );
}

/** Emergency and important numbers: compact, collapsible, grouped in sections the Super Admin controls. Everyone sees it; the committee and Facility Manager keep the numbers. */
export default function ImportantNumbers() {
  const { role, roleId } = useApp();
  const { records, refresh, save: saveNumber } = useCollection(COLLECTIONS.IMPORTANT_NUMBERS, 'Important numbers');
  const { records: sections, save: saveSection, remove: removeSection } = useCollection(COLLECTIONS.NUMBER_SECTIONS, 'Important number sections');
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [dutyOpen, setDutyOpen] = useState(false);
  // who is on duty (and their phone) is read only when "On duty now" is opened
  const { records: attendance, loading: dutyLoading } = useCollection(COLLECTIONS.ATTENDANCE, 'Attendance', { enabled: dutyOpen });
  const { records: handymen } = useCollection(COLLECTIONS.HANDYMEN, 'Field Staff', { enabled: dutyOpen });
  const { records: users } = useCollection(COLLECTIONS.USERS, 'Users', { enabled: dutyOpen });
  const [open, setOpen] = useState('');
  const [edit, setEdit] = useState(null);
  const [manage, setManage] = useState(false);
  const [q, setQ] = useState('');
  const canEdit = canWriteCollection(COLLECTIONS.IMPORTANT_NUMBERS, getPrincipal());
  const isAdmin = roleId === 'super_admin';
  const resident = role?.category === 'Resident' || role?.category === 'Vendor';
  const toggle = () => setCollapsed((c) => { const n = !c; try { localStorage.setItem(KEY, n ? '1' : '0'); } catch { /* ignore */ } return n; });

  const duty = useMemo(() => {
    const phoneOf = (n) => handymen.find((h) => h.name === n)?.phone || users.find((u) => u.name === n)?.phone || '';
    const m = new Map();
    attendance.filter((a) => !a.clockOut).forEach((a) => m.set(a.staffName, { name: a.staffName, role: a.roleName || handymen.find((h) => h.name === a.staffName)?.trade || 'Staff', since: a.clockIn, phone: phoneOf(a.staffName) }));
    handymen.filter((h) => h.clockedIn && !m.has(h.name)).forEach((h) => m.set(h.name, { name: h.name, role: h.trade || 'Staff', since: '', phone: h.phone || '' }));
    return [...m.values()].filter((p) => p.phone && (!resident || PUBLIC_ROLE.test(p.role))).sort((a, b) => a.role.localeCompare(b.role));
  }, [attendance, handymen, users, resident]);

  const rows = records.filter((r) => r.active !== false && (!q || `${r.name} ${r.phone} ${r.note} ${r.group}`.toLowerCase().includes(q.toLowerCase())));
  const secList = [...sections].filter((s) => s.active !== false || isAdmin).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  const by = (g) => rows.filter((r) => (r.group || 'Other') === g).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  const known = new Set(sections.map((s) => s.name));
  const orphan = rows.filter((r) => r.group && !known.has(r.group)); // a number whose section was removed still shows, under Other
  const groups = secList.filter((s) => s.active !== false && (by(s.name).length || (canEdit && !q)));
  const sos = rows.filter((r) => r.group === 'Emergency').slice(0, 3);

  return (
    <div className="card nums" style={{ marginTop: 12 }} data-testid="important-numbers" data-collapsed={collapsed ? 'true' : 'false'}>
      <div className="nums-head">
        <button type="button" className="nums-title" aria-expanded={!collapsed} data-testid="numbers-toggle" onClick={toggle}>
          <span aria-hidden>{collapsed ? '▸' : '▾'}</span> <b>Important numbers</b> <small className="muted">{rows.length}</small>
        </button>
        <span className="nums-actions">
          {canEdit && !collapsed && <button type="button" className="link-btn" data-testid="number-add" onClick={() => setEdit({ group: open || secList[0]?.name || 'Emergency', active: true })}>+ Add</button>}
          {isAdmin && !collapsed && <button type="button" className="link-btn" data-testid="sections-manage" onClick={() => setManage(true)}>Sections</button>}
        </span>
      </div>
      {sos.length > 0 && (
        <div className="nums-sos">
          {sos.map((r) => <a key={r.id} className="btn deny sm" data-testid="sos" href={tel(r.phone)}>🚨 {r.name} {r.phone}</a>)}
        </div>
      )}
      {!collapsed && (
        <>
          <input className="search nums-search" aria-label="Search numbers" placeholder="Search a number" value={q} onChange={(e) => setQ(e.target.value)} />
          {!q && (
            <details className="nums-sec" data-testid="numbers-duty" open={dutyOpen} onToggle={(e) => setDutyOpen(e.currentTarget.open)}>
              <summary>🟢 On duty now {dutyOpen && !dutyLoading && <small className="muted">({duty.length})</small>}</summary>
              {dutyOpen && (dutyLoading ? <div className="empty">Loading…</div> : duty.length === 0 ? <div className="empty">Nobody is clocked in.</div> : null)}
              <ul className="nums-list">{duty.map((p) => (
                <li key={p.name} data-testid="numbers-duty-row"><span className="grow"><b>{p.name}</b> <small className="muted">{p.role}{p.since ? ` · since ${hhmm(p.since)}` : ''}</small></span>
                  <a className="duty-call" href={tel(p.phone)} aria-label={`Call ${p.name}`} title={p.phone}>📞</a></li>))}</ul>
            </details>
          )}
          {groups.map((s) => (
            <details key={s.id} className="nums-sec" open={open === s.name || !!q} onToggle={(e) => { if (e.target.open) setOpen(s.name); }} data-testid={`numbers-${s.name}`}>
              <summary>{s.icon} {s.name} <small className="muted">({by(s.name).length})</small></summary>
              {by(s.name).length === 0 && <div className="empty">Nothing here yet.</div>}
              <ul className="nums-list">{by(s.name).map((r) => (
                <li key={r.id} data-testid="number-row"><span className="grow"><b>{r.name}</b> <small className="muted">{[r.phone, r.available, r.note].filter(Boolean).join(' · ')}</small></span>
                  {canEdit && <button type="button" className="link-btn" aria-label={`Edit ${r.name}`} onClick={() => setEdit(r)}>Edit</button>}
                  <a className="duty-call" href={tel(r.phone)} aria-label={`Call ${r.name}`} title={r.phone}>📞</a></li>))}</ul>
            </details>
          ))}
          {orphan.length > 0 && (
            <details className="nums-sec" data-testid="numbers-orphan"><summary>☎ Other <small className="muted">({orphan.length})</small></summary>
              <ul className="nums-list">{orphan.map((r) => <li key={r.id}><span className="grow"><b>{r.name}</b> <small className="muted">{r.phone}</small></span>{canEdit && <button type="button" className="link-btn" onClick={() => setEdit(r)}>Edit</button>}<a className="duty-call" href={tel(r.phone)} aria-label={`Call ${r.name}`}>📞</a></li>)}</ul></details>
          )}
        </>
      )}
      {edit && <RecordModal collection={COLLECTIONS.IMPORTANT_NUMBERS} label="Important numbers" record={edit} title={edit.id ? 'Edit number' : 'Add a number'} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); refresh?.(); }} />}
      {manage && <SectionManager sections={sections} numbers={records} save={saveSection} remove={removeSection} saveNumber={saveNumber} onClose={() => { setManage(false); refresh?.(); }} />}
    </div>
  );
}
