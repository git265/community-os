import React, { useMemo, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { hhmm } from '../../lib/attendance.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import RecordModal from '../billing/RecordModal.jsx';

// what a resident may see of the people on duty: the roles they would actually ring
const PUBLIC_ROLE = /security|guard|facility|manager|plant|operator|electric|plumb|lift|mep|supervisor/i;
const tel = (p) => `tel:${String(p).replace(/[^\d+*#]/g, '')}`;
const KEY = 'communityos:numbersCollapsed';
const readCollapsed = () => { try { const v = localStorage.getItem(KEY); if (v !== null) return v === '1'; } catch { /* ignore */ } return typeof window !== 'undefined' && window.innerWidth < 700; };

/** Emergency and important numbers: compact, collapsible, grouped in sections the Super Admin controls. Everyone sees it; the committee and Facility Manager keep the numbers. */
export default function ImportantNumbers() {
  const { role, roleId } = useApp();
  const { records, refresh } = useCollection(COLLECTIONS.IMPORTANT_NUMBERS, 'Important numbers');
  const { records: sections } = useCollection(COLLECTIONS.NUMBER_SECTIONS, 'Important number sections');
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [dutyOpen, setDutyOpen] = useState(false);
  // who is on duty (and their phone) is read only when "On duty now" is opened
  const { records: attendance, loading: dutyLoading } = useCollection(COLLECTIONS.ATTENDANCE, 'Attendance', { enabled: dutyOpen });
  const { records: handymen } = useCollection(COLLECTIONS.HANDYMEN, 'Field Staff', { enabled: dutyOpen });
  const { records: users } = useCollection(COLLECTIONS.USERS, 'Users', { enabled: dutyOpen });
  const [open, setOpen] = useState('');
  const [edit, setEdit] = useState(null);
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

  const rows = records.filter((r) => r.active !== false);
  const secList = [...sections].filter((s) => s.active !== false || isAdmin).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  const by = (g) => rows.filter((r) => (r.group || 'Other') === g).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  // Only two things here: who is on duty now, and the Emergency numbers
  const groups = secList.filter((s) => s.active !== false && s.name === 'Emergency');
  const emergency = by('Emergency');

  return (
    <div className="card nums" style={{ marginTop: 12 }} data-testid="important-numbers" data-collapsed={collapsed ? 'true' : 'false'}>
      <div className="nums-head">
        <button type="button" className="nums-title" aria-expanded={!collapsed} data-testid="numbers-toggle" onClick={toggle}>
          <span aria-hidden>{collapsed ? '▸' : '▾'}</span> <b>Important numbers</b> <small className="muted">{emergency.length}</small>
        </button>
        <span className="nums-actions">
          {canEdit && !collapsed && <button type="button" className="link-btn" data-testid="number-add" onClick={() => setEdit({ group: 'Emergency', active: true })}>+ Add</button>}
        </span>
      </div>
      {!collapsed && (
        <>
          {(
            <details className="nums-sec" data-testid="numbers-duty" open={dutyOpen} onToggle={(e) => setDutyOpen(e.currentTarget.open)}>
              <summary>🟢 On duty now {dutyOpen && !dutyLoading && <small className="muted">({duty.length})</small>}</summary>
              {dutyOpen && (dutyLoading ? <div className="empty">Loading…</div> : duty.length === 0 ? <div className="empty">Nobody is clocked in.</div> : null)}
              <ul className="nums-list">{duty.map((p) => (
                <li key={p.name} data-testid="numbers-duty-row"><span className="grow"><b>{p.name}</b> <small className="muted">{p.role}{p.since ? ` · since ${hhmm(p.since)}` : ''}</small></span>
                  <a className="duty-call" href={tel(p.phone)} aria-label={`Call ${p.name}`} title={p.phone}>📞</a></li>))}</ul>
            </details>
          )}
          {groups.map((s) => (
            <details key={s.id} className="nums-sec" open={open === s.name} onToggle={(e) => { if (e.target.open) setOpen(s.name); }} data-testid={`numbers-${s.name}`}>
              <summary>{s.icon} {s.name} <small className="muted">({by(s.name).length})</small></summary>
              {by(s.name).length === 0 && <div className="empty">Nothing here yet.</div>}
              <ul className="nums-list">{by(s.name).map((r) => (
                <li key={r.id} data-testid="number-row"><span className="grow"><b>{r.name}</b> <small className="muted">{[r.phone, r.available, r.note].filter(Boolean).join(' · ')}</small></span>
                  {canEdit && <button type="button" className="link-btn" aria-label={`Edit ${r.name}`} onClick={() => setEdit(r)}>Edit</button>}
                  <a className="duty-call" href={tel(r.phone)} aria-label={`Call ${r.name}`} title={r.phone}>📞</a></li>))}</ul>
            </details>
          ))}
        </>
      )}
      {edit && <RecordModal collection={COLLECTIONS.IMPORTANT_NUMBERS} label="Important numbers" record={edit} title={edit.id ? 'Edit number' : 'Add a number'} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); refresh?.(); }} />}
    </div>
  );
}
