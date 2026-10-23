import React, { useEffect, useState } from 'react';
import { useApp } from '../../context/AppContext.jsx';
import { PERMISSIONS, CATEGORIES, effectivePermissions } from '../../lib/access/roles.js';
import { TAB_CATALOG, PAGE_CATALOG, tabPage } from '../../lib/access/tabs.js';
import { putRole, deleteRole, loadGroups, putGroup, deleteGroup } from '../../lib/access/roleStore.js';
import { SegTabs } from '../../components/ui.jsx';
import { logChange } from '../../lib/audit/auditLog.js';
import { storage, COLLECTIONS } from '../../lib/storage/index.js';
import { PhoneSearch, PhoneFilters } from '../../components/ToolIcons.jsx';

export default function RolesModule() {
  const { roles, refreshRoles, role: currentRole } = useApp();
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [newRole, setNewRole] = useState({ name: '', groupId: 'grp_resident' });
  const [nameErr, setNameErr] = useState('');
  const [nameDraft, setNameDraft] = useState(null);
  const [tab, setTab] = useState('roles');
  const [groups, setGroups] = useState([]);
  const [groupErr, setGroupErr] = useState('');
  const [editingGroup, setEditingGroup] = useState(null);
  const [newGroup, setNewGroup] = useState(null);
  const refreshGroups = async () => setGroups(await loadGroups());
  useEffect(() => { refreshGroups(); }, [roles]); // eslint-disable-line react-hooks/exhaustive-deps
  const groupOf = (r) => groups.find((g) => g.id === r.groupId);

  const filtered = query
    ? roles.filter((r) => `${r.name} ${r.category}`.toLowerCase().includes(query.toLowerCase()))
    : roles;

  const editing = roles.find((r) => r.id === editingId);
  const [userCounts, setUserCounts] = useState({});
  useEffect(() => {
    storage.list(COLLECTIONS.USERS).then((us) => {
      const c = {};
      us.filter((u) => u.status !== 'Inactive').forEach((u) => [u.roleId, ...(u.extraRoleIds || [])].forEach((id) => { c[id] = (c[id] || 0) + 1; }));
      setUserCounts(c);
    });
  }, [roles]);

  /** Tick/untick one permission: ticking one the group already gives just clears a removal; unticking one the group gives records a removal. */
  async function togglePermission(role, permId) {
    const gp = groupOf(role)?.permissions || [];
    const on = effectivePermissions(gp, role).includes(permId);
    let added = [...(role.addedPermissions || [])]; let removed = [...(role.removedPermissions || [])];
    if (on) { if (gp.includes(permId)) removed = [...new Set([...removed, permId])]; else added = added.filter((x) => x !== permId); }
    else if (gp.includes(permId)) removed = removed.filter((x) => x !== permId); else added = [...new Set([...added, permId])];
    await putRole({ ...role, addedPermissions: added, removedPermissions: removed });
    await logChange({ sectionLabel: 'Roles & Permissions', action: 'Update', summary: `${role.name}: ${permId}`, roleLabel: currentRole?.name ?? 'Unknown' });
    await refreshRoles();
  }
  async function resetToGroup(role) {
    await putRole({ ...role, addedPermissions: [], removedPermissions: [] });
    await refreshRoles();
  }
  async function changeGroup(role, groupId) {
    const g = groups.find((x) => x.id === groupId);
    if (!g || g.id === role.groupId) return;
    if (!window.confirm(`Move "${role.name}" to the group "${g.name}"?\n\nIt will inherit that group’s default permissions and access level (${g.category}); the role’s own additions/removals are kept. Everyone with this role is affected immediately.`)) return;
    await putRole({ ...role, groupId });
    await refreshRoles();
  }

  async function toggleTab(role, tabId) {
    const hidden = role.hiddenTabs || [];
    await putRole({ ...role, hiddenTabs: hidden.includes(tabId) ? hidden.filter((x) => x !== tabId) : [...hidden, tabId] });
    await refreshRoles();
  }

  async function togglePage(role, pageId) {
    const hidden = role.hiddenPages || [];
    await putRole({ ...role, hiddenPages: hidden.includes(pageId) ? hidden.filter((x) => x !== pageId) : [...hidden, pageId] });
    await refreshRoles();
  }

  async function renameRole(role, name) {
    await putRole({ ...role, name });
    await refreshRoles();
  }

  async function addRole(e) {
    e.preventDefault();
    if (!newRole.name.trim()) return setNameErr('Role name is required');
    setNameErr('');
    const id = `custom_${newRole.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${Date.now().toString(36)}`;
    const role = { id, name: newRole.name, groupId: newRole.groupId, category: groups.find((g) => g.id === newRole.groupId)?.category || 'Resident', addedPermissions: [], removedPermissions: [], permissions: [], isCustom: true };
    await putRole(role);
    await logChange({ sectionLabel: 'Roles & Permissions', action: 'Create', summary: role.name, roleLabel: currentRole?.name ?? 'Unknown' });
    await refreshRoles();
    setNewRole({ name: '', groupId: 'grp_resident' });
    setCreating(false);
  }

  async function removeRole(role) {
    await deleteRole(role.id);
    await logChange({ sectionLabel: 'Roles & Permissions', action: 'Delete', summary: role.name, roleLabel: currentRole?.name ?? 'Unknown' });
    setEditingId(null);
    await refreshRoles();
  }

  async function saveGroupDraft(g) {
    setGroupErr('');
    if (!g.name?.trim()) return setGroupErr('Group name is required');
    try { await putGroup({ ...g, name: g.name.trim() }); await refreshGroups(); await refreshRoles(); setEditingGroup(null); setNewGroup(null); } catch (e) { setGroupErr(e.message); }
  }
  async function removeGroupNow(g) {
    setGroupErr('');
    if (!window.confirm(`Delete the group "${g.name}"?`)) return;
    try { await deleteGroup(g.id); await refreshGroups(); setEditingGroup(null); } catch (e) { setGroupErr(e.message); }
  }
  const effective = editing ? effectivePermissions(groupOf(editing)?.permissions || [], editing) : [];
  const gPerms = editing ? groupOf(editing)?.permissions || [] : [];
  const stateOf = (p) => { const inG = gPerms.includes(p); const on = effective.includes(p); return inG && on ? 'inherited' : !inG && on ? 'added' : inG && !on ? 'removed' : 'none'; };
  const overrides = editing ? (editing.addedPermissions?.length || 0) + (editing.removedPermissions?.length || 0) : 0;
  const groupDraft = editingGroup || newGroup;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Roles & permissions</h1>
          <p>{PERMISSIONS.length} capabilities. Groups hold default permissions; each role inherits its group’s and can add or remove individual ones.</p>
        </div>
        {tab === 'roles' ? <button className="btn" onClick={() => setCreating((v) => !v)}>+ Add custom role</button> : <button className="btn" data-testid="add-group" onClick={() => { setEditingGroup(null); setNewGroup({ name: '', category: 'Staff', description: '', permissions: [] }); }}>+ Add group</button>}
      </div>
      <SegTabs label="Roles or groups" value={tab} onChange={setTab} tabs={[{ key: 'roles', label: 'Roles', count: 0 }, { key: 'groups', label: 'Groups' }]} />
      <div style={{ height: 12 }} />

      {tab === 'groups' && (
        <div data-testid="groups-panel">
          {groupErr && <div className="notice error">{groupErr}</div>}
          <div className="grid two">
            {groups.map((g) => {
              const members = roles.filter((r) => r.groupId === g.id);
              return (
                <div key={g.id} className="card" data-testid={`group-${g.id}`}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <div><b style={{ fontSize: 16 }}>{g.name}</b> <span className="tag blue">{g.category}</span><div className="muted" style={{ fontSize: 13 }}>{g.description || 'No description'}</div></div>
                    <button className="btn secondary sm" onClick={() => { setNewGroup(null); setEditingGroup({ ...g }); }}>Edit</button>
                  </div>
                  <div className="muted" style={{ marginTop: 8, fontSize: 13 }}><b>{members.length}</b> role{members.length === 1 ? '' : 's'}: {members.map((m) => m.name).join(', ') || '—'}</div>
                  <div style={{ marginTop: 6 }}>{(g.permissions || []).length ? (g.permissions || []).map((id) => <span key={id} className="tag" style={{ marginRight: 4, marginBottom: 4 }}>{PERMISSIONS.find((p) => p.id === id)?.label || id}</span>) : <span className="muted">No default permissions</span>}</div>
                </div>
              );
            })}
          </div>
          {groupDraft && (
            <div className="card" style={{ marginTop: 16 }} data-testid="group-editor">
              <h3 style={{ margin: 0 }}>{groupDraft.id ? `Edit group · ${groupDraft.name}` : 'New group'}</h3>
              <div className="form-grid" style={{ marginTop: 10 }}>
                <div className="field"><label>Group name *</label><input aria-label="Group name" value={groupDraft.name} onChange={(e) => (groupDraft.id ? setEditingGroup({ ...groupDraft, name: e.target.value }) : setNewGroup({ ...groupDraft, name: e.target.value }))} /></div>
                <div className="field"><label>Access level (what data members can see)</label>
                  <select aria-label="Access level" value={groupDraft.category} onChange={(e) => (groupDraft.id ? setEditingGroup({ ...groupDraft, category: e.target.value }) : setNewGroup({ ...groupDraft, category: e.target.value }))}>
                    {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                  </select>
                </div>
                <div className="field" style={{ gridColumn: '1 / -1' }}><label>Description</label><input aria-label="Group description" value={groupDraft.description || ''} onChange={(e) => (groupDraft.id ? setEditingGroup({ ...groupDraft, description: e.target.value }) : setNewGroup({ ...groupDraft, description: e.target.value }))} /></div>
              </div>
              <p className="muted" style={{ margin: '8px 0 4px' }}>Default permissions — every role in this group gets these (a role can still remove or add individual ones).</p>
              <div className="grid two">
                {PERMISSIONS.map((p) => (
                  <label key={p.id} className="person" style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                    <input type="checkbox" aria-label={`Group default: ${p.label}`} checked={(groupDraft.permissions || []).includes(p.id)}
                      onChange={() => { const list = groupDraft.permissions || []; const next = { ...groupDraft, permissions: list.includes(p.id) ? list.filter((x) => x !== p.id) : [...list, p.id] }; groupDraft.id ? setEditingGroup(next) : setNewGroup(next); }} />
                    {p.label}
                  </label>
                ))}
              </div>
              <div className="form-actions"><button className="btn" data-testid="save-group" onClick={() => saveGroupDraft(groupDraft)}>{groupDraft.id ? 'Save group' : 'Create group'}</button>
                {groupDraft.id && <button className="btn secondary" onClick={() => removeGroupNow(groupDraft)}>Delete group</button>}
                <button className="btn secondary" onClick={() => { setEditingGroup(null); setNewGroup(null); setGroupErr(''); }}>Cancel</button></div>
              <small className="muted">Saving re-applies the defaults to every role in the group immediately.</small>
            </div>
          )}
        </div>
      )}

      {tab === 'roles' && creating && (
        <div className="card" style={{ marginBottom: 16 }}>
          <form className="form-grid" onSubmit={addRole}>
            <div style={{ gridColumn: "1 / -1" }}><h3 style={{ margin: 0 }}>Create a role</h3><p className="muted" style={{ margin: "2px 0 0" }}>Name the role and pick its group; it starts with the group’s permissions and you can then add or remove individual ones.</p></div>
            <div className={`field${nameErr ? ' invalid' : ''}`}><label>Role name *</label><input value={newRole.name} onChange={(e) => setNewRole((r) => ({ ...r, name: e.target.value }))} placeholder="Pool Committee" />{nameErr && <div className="field-error">{nameErr}</div>}</div>
            <div className="field"><label>Group</label>
              <select aria-label="New role group" value={newRole.groupId} onChange={(e) => setNewRole((r) => ({ ...r, groupId: e.target.value }))}>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.category})</option>)}
              </select>
            </div>
            <div className="form-actions">
              <button type="submit" className="btn">Create role</button>
              <button type="button" className="btn secondary" onClick={() => setCreating(false)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {tab === 'roles' && (<>
      <div className="toolbar" style={{ marginBottom: 14 }}>
        <PhoneSearch className="search" placeholder="Search roles" value={query} onChange={(v) => setQuery(v)} />
      </div>

      <div className="card table-wrap">
        <table>
          <thead><tr><th>Role</th><th>Group</th><th>Access</th><th>Users</th><th>Permissions</th></tr></thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} onClick={() => { setNameDraft(null); setEditingId(r.id); }}>
                <td><b>{r.name}</b>{r.isCustom && <span className="tag blue" style={{ marginLeft: 6 }}>Custom</span>}</td>
                <td className="muted">{groupOf(r)?.name || r.category}</td>
                <td className="muted">{r.category}</td>
                <td>{userCounts[r.id] || 0}</td>
                <td>{r.permissions.length} of {PERMISSIONS.length}{(r.addedPermissions?.length || r.removedPermissions?.length) && r.id !== 'super_admin' ? <small className="muted"> · {(r.addedPermissions || []).length ? `+${r.addedPermissions.length}` : ''} {(r.removedPermissions || []).length ? `−${r.removedPermissions.length}` : ''}</small> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="card" style={{ marginTop: 16 }} data-testid="role-editor">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
            <div className={`field${nameDraft !== null && !nameDraft.trim() ? ' invalid' : ''}`} style={{ maxWidth: 320 }}>
              <label>Role name *</label>
              <input value={nameDraft ?? editing.name} onChange={(e) => { setNameDraft(e.target.value); if (e.target.value.trim()) renameRole(editing, e.target.value); }} onBlur={() => setNameDraft(null)} />
              {nameDraft !== null && !nameDraft.trim() && <div className="field-error">Role name is required</div>}
            </div>
            <div className="field" style={{ maxWidth: 260 }}>
              <label>Group (inherits its permissions)</label>
              <select aria-label="Role group" value={editing.groupId || ''} onChange={(e) => changeGroup(editing, e.target.value)} disabled={editing.id === 'super_admin'}>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.category})</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {editing.isCustom && <button className="btn secondary" onClick={() => removeRole(editing)}>Delete role</button>}
              <button className="btn secondary" onClick={() => { setNameDraft(null); setEditingId(null); }}>Close</button>
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '14px 0 6px', gap: 8, flexWrap: 'wrap' }}>
            <div className="muted" style={{ fontSize: 13 }}>Ticked = this role has it. <span className="tag">from group</span> default · <span className="tag green">+ added</span> on top of the group · <span className="tag red">− removed</span> from the group.</div>
            {editing.id !== 'super_admin' && overrides > 0 && <button className="btn secondary sm" data-testid="reset-to-group" onClick={() => resetToGroup(editing)}>Reset to group defaults ({overrides})</button>}
          </div>
          <div className="grid two">
            {PERMISSIONS.map((p) => {
              const st = editing.id === 'super_admin' ? 'inherited' : stateOf(p.id);
              return (
                <label key={p.id} className="person" style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                  <input type="checkbox" aria-label={p.label} disabled={editing.id === 'super_admin'} checked={editing.id === 'super_admin' || effective.includes(p.id)} onChange={() => togglePermission(editing, p.id)} />
                  <span style={{ flex: 1 }}>{p.label}</span>
                  {st === 'inherited' && editing.id !== 'super_admin' && <span className="tag">from group</span>}
                  {st === 'added' && <span className="tag green">+ added</span>}
                  {st === 'removed' && <span className="tag red">− removed</span>}
                </label>
              );
            })}
          </div>
          <h3 style={{ margin: '18px 0 4px' }}>Pages (left menu)</h3>
          <p className="muted" style={{ margin: '0 0 8px' }}>Untick a page to hide it from this role. A page still needs the permissions it already requires; ticking never grants access.</p>
          <div className="chip-row" data-testid="page-toggles">
            {PAGE_CATALOG.map(([id, label]) => (
              <label key={id} className={`chip-btn${!(editing.hiddenPages || []).includes(id) ? ' on' : ''}`}>
                <input type="checkbox" aria-label={`Page: ${label}`} style={{ display: 'none' }} disabled={editing.id === 'super_admin'} checked={!(editing.hiddenPages || []).includes(id)} onChange={() => togglePage(editing, id)} />{label}
              </label>
            ))}
          </div>
          <h3 style={{ margin: '18px 0 4px' }}>Page tabs</h3>
          <p className="muted" style={{ margin: '0 0 8px' }}>Tick the tabs this role may open inside each page. Unticking hides a tab even if the role’s permissions would allow it; ticking never grants access the permissions don’t already give. {editing.id === 'super_admin' ? 'Super Admin always sees every tab.' : ''}</p>
          <div className="grid two">
            {TAB_CATALOG.map((g) => { const pageOff = (editing.hiddenPages || []).includes(tabPage(g.tabs[0][0])); return (
              <div key={g.page} className="person" style={{ display: 'block', opacity: pageOff ? 0.55 : 1 }} data-page-off={pageOff ? 'true' : undefined}>
                <b>{g.page}</b>{pageOff && <small className="muted" style={{ display: 'block' }}>Page switched off for this role — all its tabs are hidden.</small>}
                {g.tabs.map(([id, label]) => (
                  <label key={id} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginTop: 6 }}>
                    <input type="checkbox" aria-label={`${g.page}: ${label}`} disabled={editing.id === 'super_admin' || pageOff} checked={!pageOff && !(editing.hiddenTabs || []).includes(id)} onChange={() => toggleTab(editing, id)} />
                    {label}
                  </label>
                ))}
              </div>
            ); })}
          </div>
        </div>
      )}
      </>)}
    </div>
  );
}
