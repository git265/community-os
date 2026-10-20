import React, { useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { putRole, deleteRole } from '../../lib/access/roleStore.js';
import Modal from '../../components/Modal.jsx';

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const rolesOf = (u) => [u.roleId, ...(Array.isArray(u.extraRoleIds) ? u.extraRoleIds : [])];

/** Create, rename, staff and delete committees without touching code or remembering naming rules. */
export default function CommitteeManager({ kind, onClose }) {
  const { roles = [], refreshRoles } = useApp();
  const { records: users, save: saveUser, refresh } = useCollection(COLLECTIONS.USERS, 'Users');
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const sub = kind === 'sub';
  const list = sub ? roles.filter((r) => r.id.startsWith('committee_')) : roles.filter((r) => r.category === 'EC' && r.id !== 'super_admin' && !r.id.startsWith('committee_'));
  const active = users.filter((u) => u.status !== 'Inactive');
  const run = async (fn) => { setErr(''); setBusy(true); try { await fn(); await refreshRoles?.(); await refresh(); } catch (e) { setErr(e.message || 'Could not save.'); } setBusy(false); };

  const add = () => run(async () => {
    const nm = name.trim(); if (!nm) throw new Error('Type a name first.');
    const id = sub ? `committee_${slug(nm.replace(/ committee$/i, ''))}` : slug(nm);
    if (!id || id === 'committee_') throw new Error('Use letters or numbers in the name.');
    if (roles.some((r) => r.id === id || r.name.toLowerCase() === (sub ? `${nm.replace(/ committee$/i, '')} Committee` : nm).toLowerCase())) throw new Error('That name already exists.');
    await putRole({ id, name: sub ? `${nm.replace(/ committee$/i, '')} Committee` : nm, category: 'EC', permissions: [] });
    setName('');
  });
  const rename = (r) => { const nm = window.prompt('New name', r.name); if (nm && nm.trim() && nm.trim() !== r.name) run(() => putRole({ ...r, name: nm.trim() })); };
  const addMember = (r, uid) => { const u = users.find((x) => x.id === uid); if (u) run(() => saveUser({ ...u, extraRoleIds: [...(Array.isArray(u.extraRoleIds) ? u.extraRoleIds : []), r.id] })); };
  const removeMember = (r, u) => run(() => saveUser({ ...u, extraRoleIds: (u.extraRoleIds || []).filter((x) => x !== r.id) }));
  const remove = (r) => {
    const n = active.filter((u) => rolesOf(u).includes(r.id)).length;
    if (n) { setErr(`Remove its ${n} member${n === 1 ? '' : 's'} first.`); return; }
    if (window.confirm(`Delete "${r.name}"?`)) run(() => deleteRole(r.id));
  };

  return (
    <Modal title={sub ? 'Manage sub-committees' : 'Manage Executive Committee seats'} subtitle="Changes show on this page straight away. What a committee may do is set in Roles & Permissions." onClose={onClose}>
      <div data-testid="committee-manager">
        {err && <div className="notice" role="alert" style={{ borderColor: '#e5484d', color: '#c7364a' }}>{err}</div>}
        <ul className="list">
          {list.map((r) => {
            const members = active.filter((u) => rolesOf(u).includes(r.id));
            const free = active.filter((u) => !rolesOf(u).includes(r.id));
            return (
              <li key={r.id} data-testid={`cm-${r.id}`} style={{ display: 'block' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <b style={{ flex: 1 }}>{r.name}</b>
                  <button type="button" className="btn secondary small" disabled={busy} onClick={() => rename(r)}>Rename</button>
                  <button type="button" className="btn secondary small" disabled={busy} data-testid={`cm-del-${r.id}`} onClick={() => remove(r)}>Delete</button>
                </div>
                <div style={{ margin: '6px 0' }}>
                  {members.length === 0 && <span className="muted">No members yet. </span>}
                  {members.map((u) => (
                    <span key={u.id} className="chip-btn on" style={{ marginRight: 4 }}>{u.name}
                      {u.roleId === r.id ? <small className="muted"> (main role)</small> : <button type="button" aria-label={`Remove ${u.name}`} disabled={busy} onClick={() => removeMember(r, u)} style={{ border: 0, background: 'none', cursor: 'pointer' }}>×</button>}
                    </span>
                  ))}
                </div>
                <select aria-label={`Add member to ${r.name}`} data-testid={`cm-add-${r.id}`} value="" disabled={busy} onChange={(e) => e.target.value && addMember(r, e.target.value)}>
                  <option value="">+ add member</option>
                  {free.map((u) => <option key={u.id} value={u.id}>{u.name}{u.units ? ` · ${Array.isArray(u.units) ? u.units.join(', ') : u.units}` : ''}</option>)}
                </select>
              </li>
            );
          })}
        </ul>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input aria-label="New name" data-testid="cm-name" placeholder={sub ? 'New sub-committee, e.g. Sports' : 'New seat, e.g. Joint Secretary'} value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
          <button type="button" className="btn" data-testid="cm-add" disabled={busy} onClick={add}>Add</button>
        </div>
        <div className="form-actions"><button className="btn" onClick={onClose}>Done</button></div>
      </div>
    </Modal>
  );
}
