import React, { useEffect, useMemo, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { unitRoster } from '../../lib/unitRoster.js';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { CATEGORIES } from '../../lib/access/roles.js';
import ServerTable from '../../components/ServerTable.jsx';
import { usePhone } from '../../components/Tabs.jsx';
import Modal from '../../components/Modal.jsx';
import RecordMeta from '../../components/RecordMeta.jsx';
import { secureStorage } from '../../lib/storage/secureStorage.js';
import { validatePhone } from '../../lib/phone.js';
import { emailError } from '../../lib/validate.js';

const CATEGORY_LABEL = { EC: 'Executive Committee', Staff: 'Facility staff', Resident: 'Owners & residents' };
const blank = () => ({ name: '', phone: '', email: '', status: 'Active', roleId: '', extraRoleIds: [], units: [], blocks: [] });

/**
 * Administration -> Users. A user = a person who can sign in: one primary role + optional extra roles
 * (e.g. Owner + Amenities Committee) + the villa(s) they own. The role's CATEGORY (EC / Staff / Resident)
 * is not stored on the user - it always comes from the role, so changing a role's category in
 * Roles & Permissions immediately changes what every user holding it can reach.
 */
export default function UsersModule() {
  const { roles, roleFor } = useApp();
  const { save } = useCollection(COLLECTIONS.USERS, 'Users');
  const [editing, setEditing] = useState(null);
  const phone = usePhone();
  const docked = !!editing?.id && !phone;   // a computer: the person opens beside the list
  const [draft, setDraft] = useState(blank());
  const [errs, setErrs] = useState({});
  const [villas, setVillas] = useState([]);
  const [blockNames, setBlockNames] = useState([]);
  const [vq, setVq] = useState('');
  const [loadErr, setLoadErr] = useState('');
  useEffect(() => { secureStorage.list(COLLECTIONS.BLOCKS).then((r) => setBlockNames(r.map((b) => b.name).sort())).catch((e) => setLoadErr(`Blocks could not be read (${e?.message || 'error'}).`)); }, []);
  useEffect(() => { unitRoster().then((r) => setVillas(r.map((p) => p.unit).sort())).catch((e) => setLoadErr(`Units could not be read (${e?.message || 'error'}).`)); }, []);

  const grouped = useMemo(() => CATEGORIES.map((c) => ({ category: c, roles: roles.filter((r) => r.category === c) })), [roles]);
  const catOf = (id) => roleFor(id)?.category;
  const allRoleIds = [draft.roleId, ...draft.extraRoleIds].filter(Boolean);
  const needsVilla = allRoleIds.some((id) => catOf(id) === 'Resident');

  function open(u) {
    setErrs({});
    setEditing(u);
    setDraft(u.id ? { ...blank(), ...u, extraRoleIds: u.extraRoleIds || [], units: u.units || [], blocks: u.blocks || [] } : blank());
  }
  const toggle = (key, v) => setDraft((d) => ({ ...d, [key]: d[key].includes(v) ? d[key].filter((x) => x !== v) : [...d[key], v] }));

  async function submit(e) {
    e.preventDefault();
    const er = {};
    if (!draft.name.trim()) er.name = 'Name is required';
    else if (draft.name.trim().length > 120) er.name = 'A name has up to 120 characters';
    if (1 + draft.extraRoleIds.filter((x) => x !== draft.roleId).length > 5) er.roleId = 'Up to 5 roles (the primary one and 4 more)';
    if (!draft.roleId) er.roleId = 'Primary role is required';
    // the phone is the sign-in key: check it whenever it is typed or changed (an old stored value is left alone until edited)
    const ph = String(draft.phone || '').trim();
    if (!editing?.id && !ph) er.phone = 'Phone is required - it is how the person signs in';
    else if (ph && ph !== String(editing?.phone || '').trim()) { const v = validatePhone(ph); if (!v.ok) er.phone = v.error; }
    const em = emailError(draft.email); if (em) er.email = em;
    if (needsVilla && draft.units.length === 0) er.units = 'Owners/residents need at least one villa/unit';
    setErrs(er);
    if (Object.keys(er).length) return;
    const saved = await save({ ...draft, name: draft.name.trim(), phone: String(draft.phone || '').trim(), email: String(draft.email || '').trim().toLowerCase(), extraRoleIds: draft.extraRoleIds.filter((x) => x !== draft.roleId) });
    if (saved) setEditing(null);
  }

  const roleName = (id) => roleFor(id)?.name || id;
  const columns = [
    { key: 'name', label: 'Name', render: (u) => <b>{u.name}</b> },
    { key: 'roleId', label: 'Role', render: (u) => roleName(u.roleId) },
    { key: 'category', label: 'Group', sortable: false, render: (u) => <span className="tag blue">{catOf(u.roleId) || '—'}</span> },
    { key: 'extraRoleIds', label: 'Also', sortable: false, render: (u) => (u.extraRoleIds?.length ? u.extraRoleIds.map(roleName).join(', ') : '—') },
    { key: 'units', label: 'Villas / units', sortable: false, render: (u) => (u.units?.length ? u.units.join(', ') : '—') },
    { key: 'phone', label: 'Phone' },
    { key: 'status', label: 'Status', render: (u) => <span className={`tag ${u.status === 'Active' ? 'green' : 'orange'}`}>{u.status}</span> },
  ];

  return (
    <div className={docked ? 'list-docked' : undefined}>
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <p>People who can sign in. Each has a role (which sets their category and permissions), optional extra roles and their villa(s).</p>
        </div>
        <button className="btn" onClick={() => open({})}>+ Add user</button>
      </div>
      <div className="card">
        <ServerTable
          collection={COLLECTIONS.USERS}
          columns={columns}
          baseSort={{ key: 'name', dir: 'asc' }}
          filters={[{ key: 'status', label: 'All status', options: ['Active', 'Inactive'] }]}
          searchKeys={['name', 'phone', 'email', 'units', 'roleId']}
          showId
          onRowClick={open}
          rowClassName={(u) => (u.id === editing?.id ? 'row-sel' : '')}
          cardsAlways={docked}
          emptyText="No users."
        />
      </div>

      {editing && (
        <Modal dock={!!editing.id} title={editing.id ? 'Edit user' : 'Add a user'} subtitle="Who can sign in: their main role, any extra roles, and the villa(s) they own." onClose={() => setEditing(null)}>
          <form className="form-grid" onSubmit={submit} noValidate>
            {loadErr && <div className="notice error" data-testid="user-load-error" style={{ gridColumn: '1 / -1' }}>{loadErr} Close and open the form again.</div>}
            <div className={`field${errs.name ? ' invalid' : ''}`}><label>Name *</label><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />{errs.name && <div className="field-error">{errs.name}</div>}</div>
            <div className="field"><label>Status</label>
              <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
                <option>Active</option><option>Inactive</option>
              </select>
              {draft.status === 'Inactive' && <small className="muted">Inactive users can't sign in.</small>}
            </div>
            <div className={`field${errs.phone ? ' invalid' : ''}`}><label>Phone{editing.id ? '' : ' *'}</label><input value={draft.phone} maxLength={20} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} placeholder="+91 98450 71234" />{errs.phone && <div className="field-error">{errs.phone}</div>}</div>
            <div className={`field${errs.email ? ' invalid' : ''}`}><label>Email</label><input maxLength={200} value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />{errs.email && <div className="field-error">{errs.email}</div>}</div>

            <div className={`field${errs.roleId ? ' invalid' : ''}`} style={{ gridColumn: '1 / -1' }}>
              <label>Primary role *</label>
              <select value={draft.roleId} onChange={(e) => setDraft({ ...draft, roleId: e.target.value })}>
                <option value="">Select…</option>
                {grouped.map((g) => (
                  <optgroup key={g.category} label={CATEGORY_LABEL[g.category]}>
                    {g.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </optgroup>
                ))}
              </select>
              {errs.roleId && <div className="field-error">{errs.roleId}</div>}
              {draft.roleId && <small className="muted">Group: <b>{catOf(draft.roleId)}</b> · {roleFor(draft.roleId)?.permissions?.length || 0} permissions</small>}
            </div>

            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Additional roles <small className="muted">(the person chooses which one to sign in as)</small></label>
              {grouped.map((g) => (
                <div key={g.category} style={{ marginBottom: 6 }}>
                  <div className="muted" style={{ fontSize: 12, fontWeight: 650 }}>{CATEGORY_LABEL[g.category]}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {g.roles.filter((r) => r.id !== draft.roleId).map((r) => (
                      <label key={r.id} className={`chip-btn${draft.extraRoleIds.includes(r.id) ? ' on' : ''}`} style={{ cursor: 'pointer' }}>
                        <input type="checkbox" style={{ display: 'none' }} checked={draft.extraRoleIds.includes(r.id)} onChange={() => toggle('extraRoleIds', r.id)} />
                        {draft.extraRoleIds.includes(r.id) ? '✓ ' : ''}{r.name}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className={`field${errs.units ? ' invalid' : ''}`} style={{ gridColumn: '1 / -1' }}>
              <label>Villas / units owned{needsVilla ? ' *' : ''}</label>
              {draft.units.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>{draft.units.map((v) => <button type="button" key={v} className="chip-btn on" onClick={() => toggle('units', v)} aria-label={`Remove ${v}`}>✓ {v} ✕</button>)}</div>}
              <input aria-label="Search units" data-testid="user-unit-search" value={vq} onChange={(e) => setVq(e.target.value)} placeholder={`Search ${villas.length} units to add…`} />
              {vq.trim() && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  {villas.filter((v) => !draft.units.includes(v) && v.toLowerCase().includes(vq.trim().toLowerCase())).slice(0, 30).map((v) => (
                    <button type="button" key={v} className="chip-btn" onClick={() => { toggle('units', v); setVq(''); }}>+ {v}</button>
                  ))}
                </div>
              )}
              {errs.units && <div className="field-error">{errs.units}</div>}
              <small className="muted">Required for owner/resident roles. EC members who also own a villa add it here to raise maintenance requests as an owner.</small>
            </div>

            {!needsVilla && blockNames.length > 0 && (
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Limited to blocks <small className="muted">(blank = whole community)</small></label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {blockNames.map((b) => (
                    <label key={b} className={`chip-btn${draft.blocks.includes(b) ? ' on' : ''}`} style={{ cursor: 'pointer' }}>
                      <input type="checkbox" style={{ display: 'none' }} checked={draft.blocks.includes(b)} onChange={() => toggle('blocks', b)} />
                      {draft.blocks.includes(b) ? '✓ ' : ''}{b}
                    </label>
                  ))}
                </div>
                <small className="muted">A block secretary / block admin sees and manages only the units, dues, tickets and bookings of the ticked blocks.</small>
              </div>
            )}

            <div style={{ gridColumn: '1 / -1' }}><RecordMeta record={editing} /></div>
            <div className="form-actions">
              <button type="submit" className="btn">Save</button>
              <button type="button" className="btn secondary" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
