import React, { useCallback, useEffect, useState } from 'react';
import Modal from '../../components/Modal.jsx';
import { communityUrl, resolveSlug, usesSubdomains, SLUG_RE } from '../../lib/community.js';
import {
  UNIT_TYPES, listCommunities, createCommunity, setCommunityStatus, membersOf, addMember, allPeople,
  platformSession, platformSignIn, platformSignOut, registryOnServer,
} from '../../lib/platform/registry.js';
import { DEFAULT_ROLES, CATEGORIES } from '../../lib/access/roles.js';
import { storage, COLLECTIONS, isApiMode } from '../../lib/storage/index.js';

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
const CAT_LABEL = { EC: 'Executive Committee', Staff: 'Facility staff', Resident: 'Owners & residents' };

/** What a new community starts with - shown on the create form so the platform admin knows what "default" means. */
const DEFAULTS = [
  `${DEFAULT_ROLES.length} roles with their permissions (Super Admin, EC, facility staff, owners/residents…)`,
  'Every module and its field-level access rules',
  'Task types and the approval workflow, categories, quick phrases',
  'Notice / bill templates and merge fields',
  'Amenity types, committees and office-bearer slots (empty)',
  'Import rules for bank statements and villa electricity',
  'The first Super Admin you name below',
];

function Field({ label, error, children }) {
  return <div className={`field${error ? ' invalid' : ''}`}><label>{label}</label>{children}{error && <div className="field-error">{error}</div>}</div>;
}

function NewCommunity({ onClose, onCreated }) {
  const [v, setV] = useState({ name: '', slug: '', address: '', unitTypes: UNIT_TYPES[0], demoData: false, largeData: false, adminName: '', adminEmail: '', adminPhone: '' });
  const [touchedSlug, setTouchedSlug] = useState(false);
  const [errs, setErrs] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k, val) => setV((x) => ({ ...x, [k]: val }));
  const sample = communityUrl(v.slug || 'your-community', window.location);

  async function submit() {
    setBusy(true);
    const out = await createCommunity(v);
    setBusy(false);
    if (out.errors) return setErrs(out.errors);
    onCreated(out.community);
  }

  return (
    <Modal title="New community" subtitle="Creates a separate community with its own web address, roles, users and data." onClose={onClose}>
      <div className="form-grid">
        <Field label="Community name *" error={errs.name}>
          <input aria-label="Community name" value={v.name} onChange={(e) => { set('name', e.target.value); if (!touchedSlug) set('slug', slugify(e.target.value)); }} placeholder="e.g. Palm Meadows" />
        </Field>
        <Field label="Web address *" error={errs.slug}>
          <input aria-label="Web address" value={v.slug} onChange={(e) => { setTouchedSlug(true); set('slug', e.target.value.toLowerCase()); }} placeholder="palm-meadows" />
          <small className="muted" style={{ wordBreak: 'break-all' }}>{sample}</small>
        </Field>
        <Field label="Address"><input value={v.address} onChange={(e) => set('address', e.target.value)} placeholder="Street, city" /></Field>
        <Field label="Unit types">
          <select value={v.unitTypes} onChange={(e) => set('unitTypes', e.target.value)}>{UNIT_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
        </Field>
        <div style={{ gridColumn: '1 / -1' }}><b>First Super Admin</b> <small className="muted">(identified by e-mail; the same e-mail can belong to other communities with a different role)</small></div>
        <Field label="Name *" error={errs.adminName}><input aria-label="Admin name" value={v.adminName} onChange={(e) => set('adminName', e.target.value)} /></Field>
        <Field label="E-mail *" error={errs.adminEmail}><input aria-label="Admin e-mail" value={v.adminEmail} onChange={(e) => set('adminEmail', e.target.value)} /></Field>
        <Field label={registryOnServer() ? 'Phone * (signs in with a code sent here)' : 'Phone'} error={errs.adminPhone}><input aria-label="Admin phone" value={v.adminPhone} onChange={(e) => set('adminPhone', e.target.value)} placeholder="+91 98450 71234" /></Field>
      </div>
      {errs.form && <div className="notice error" style={{ marginTop: 10 }} data-testid="create-error">{errs.form}</div>}
      <div className="card" style={{ marginTop: 12, background: '#f7f9fb' }}>
        <b>Every new community starts with</b>
        <ul style={{ margin: '6px 0 0 18px' }}>{DEFAULTS.map((d) => <li key={d}>{d}</li>)}</ul>
        <label className="check" style={{ marginTop: 10 }}>
          <input type="checkbox" checked={v.demoData} onChange={(e) => set('demoData', e.target.checked)} /> Also load the La Paloma <b>demo data</b> (sample villas, tickets, bills…) — for sandboxes and training only
        </label>
        {!registryOnServer() && <label className="check" style={{ display: 'block', marginTop: 6 }}><input type="checkbox" data-testid="large-data" checked={v.largeData} onChange={(e) => set('largeData', e.target.checked)} /> Load <b>large test data</b> — 5 blocks, 2,000 units, a year of dues, thousands of tickets and bookings, several clubhouses and pools (to try the app at township size)</label>}
      </div>
      <div className="form-actions">
        <button className="btn" disabled={busy} onClick={submit}>{busy ? 'Creating…' : 'Create community'}</button>
        <button className="btn secondary" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

function Members({ community, onClose }) {
  const [rows, setRows] = useState([]);
  const [roles, setRoles] = useState(DEFAULT_ROLES);
  const [draft, setDraft] = useState({ name: '', email: '', phone: '', roleId: '', unit: '' });
  const [errs, setErrs] = useState({});
  const load = useCallback(async () => {
    setRows(await membersOf(community.slug));
    const r = await storage.forCommunity(community.slug).list(COLLECTIONS.ROLES);
    if (r.length) setRoles(r);
  }, [community.slug]);
  useEffect(() => { load(); }, [load]);
  const roleName = (id) => roles.find((r) => r.id === id)?.name || id;
  async function add() {
    const out = await addMember(community.slug, draft);
    if (out.errors) return setErrs(out.errors);
    setErrs({}); setDraft({ name: '', email: '', phone: '', roleId: '', unit: '' }); load();
  }
  const cat = roles.find((r) => r.id === draft.roleId)?.category;
  return (
    <Modal title={`${community.name} · people`} subtitle="Everyone who can sign in to this community, with the role they hold here." onClose={onClose}>
      <div className="table-wrap"><table className="resp-table"><thead><tr><th>Name</th><th>E-mail</th><th>Role(s) here</th><th>Villa / unit</th></tr></thead>
        <tbody>{rows.map((u) => (
          <tr key={u.id}><td data-label="Name">{u.name}</td><td data-label="E-mail">{u.email || '—'}</td>
            <td data-label="Role(s) here">{[u.roleId, ...(u.extraRoleIds || [])].map(roleName).join(', ')}</td><td data-label="Villa / unit">{(u.units || []).join(', ') || '—'}</td></tr>
        ))}</tbody></table>{rows.length === 0 && <div className="empty">No one yet.</div>}</div>
      <h3 style={{ marginBottom: 4 }}>Add a person</h3>
      <p className="muted" style={{ marginTop: 0 }}>Use the same e-mail as in another community to give one person several communities, each with its own role.</p>
      <div className="form-grid">
        <Field label="Name *" error={errs.name}><input aria-label="Person name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
        <Field label="E-mail *" error={errs.email}><input aria-label="Person e-mail" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} /></Field>
        <Field label="Phone" error={errs.phone}><input aria-label="Person phone" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} /></Field>
        <Field label="Role *" error={errs.roleId}>
          <select aria-label="Person role" value={draft.roleId} onChange={(e) => setDraft({ ...draft, roleId: e.target.value })}>
            <option value="">Select a role…</option>
            {CATEGORIES.map((c) => <optgroup key={c} label={CAT_LABEL[c]}>{roles.filter((r) => r.category === c).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</optgroup>)}
          </select>
        </Field>
        {cat === 'Resident' && <Field label="Villa / unit"><input value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} placeholder="e.g. Villa 12" /></Field>}
      </div>
      <div className="form-actions"><button className="btn" onClick={add}>Add person</button><button className="btn secondary" onClick={onClose}>Close</button></div>
    </Modal>
  );
}

export default function PlatformApp() {
  const [session, setSession] = useState(platformSession());
  const [tab, setTab] = useState('communities');
  const [communities, setCommunities] = useState([]);
  const [counts, setCounts] = useState({});
  const [people, setPeople] = useState([]);
  const [creating, setCreating] = useState(false);
  const [members, setMembers] = useState(null);
  const [flash, setFlash] = useState('');
  const [failure, setFailure] = useState('');
  const [key, setKey] = useState('');

  const refresh = useCallback(async () => {
    try {
      const list = await listCommunities();
      setCommunities(list); setFailure('');
      const c = {};
      if (registryOnServer()) { for (const x of list) c[x.slug] = x.people ?? '—'; setCounts(c); setPeople([]); return; }   // the server shows counts only, never a community's people
      for (const x of list) c[x.slug] = (await membersOf(x.slug)).length;
      setCounts(c);
      setPeople(await allPeople());
    } catch (e) {
      if (e.status === 401 || e.status === 403) { platformSignOut(); setSession(null); }
      setFailure(e.message);
    }
  }, []);
  useEffect(() => { if (session) refresh(); }, [session, refresh]);

  if (!session) {
    return (
      <div className="login-screen"><div className="login-card">
        <div className="brand" style={{ color: '#fff' }}><span className="mark">⌂</span> CommunityOS <small style={{ display: 'block', fontSize: 11, fontWeight: 400, opacity: 0.7 }}>Platform administration</small></div>
        <p className="muted" style={{ margin: '16px 0 22px' }}>Create and manage communities. Platform admins do not see a community’s day-to-day data.</p>
        {isApiMode() ? (
          <form onSubmit={(e) => { e.preventDefault(); if (!key.trim()) return; platformSignIn('Platform Admin', key.trim()); setSession(platformSession()); }}>
            <div className="field"><label htmlFor="pkey" style={{ color: '#fff' }}>Platform key</label><input id="pkey" type="password" autoComplete="current-password" data-testid="platform-key" value={key} onChange={(e) => setKey(e.target.value)} /></div>
            <button className="btn" type="submit" style={{ width: '100%', marginTop: 8 }}>Sign in</button>
            {failure && <div className="notice error" style={{ marginTop: 10 }}>{failure}</div>}
            <p className="muted" style={{ fontSize: 12, marginTop: 14 }}>The key set on the server as PLATFORM_ADMIN_KEY (Spring: app.platform.admin-key). It is kept for this browser tab only.</p>
          </form>
        ) : (
          <>
            <div className="login-group"><button className="login-role-btn" onClick={() => { platformSignIn('Platform Admin'); setSession(platformSession()); }}>Platform Admin</button></div>
            <p className="muted" style={{ fontSize: 12, marginTop: 14 }}>Demo sign-in. In production this is a separate identity with multi-factor authentication.</p>
          </>
        )}
      </div></div>
    );
  }

  return (
    <div className="platform">
      <header className="top" style={{ position: 'static' }}>
        <div className="crumb"><span className="mark">⌂</span> CommunityOS · Platform</div>
        <div className="top-right"><span className="role">Platform Admin</span><button className="btn secondary" onClick={() => { platformSignOut(); setSession(null); }}>Sign out</button></div>
      </header>
      <section className="content">
        <div className="page-head"><div><h1>Communities</h1><p>Each community has its own web address, roles, users and data. One person can belong to several, with a different role in each.</p></div>
          <button className="btn" onClick={() => setCreating(true)}>+ New community</button></div>
        {flash && <div className="notice success" style={{ marginBottom: 10 }}>{flash}</div>}
        {failure && <div className="notice error" style={{ marginBottom: 10 }}>{failure}</div>}
        <div className="tabs"><button className={tab === 'communities' ? 'active' : ''} onClick={() => setTab('communities')}>Communities ({communities.length})</button>{!registryOnServer() && <button className={tab === 'people' ? 'active' : ''} onClick={() => setTab('people')}>People across communities</button>}</div>

        {tab === 'communities' ? (
          <div className="card"><div className="table-wrap"><table className="resp-table">
            <thead><tr><th>Community</th><th>Web address</th><th>Unit types</th><th>People</th><th>Status</th><th>Created</th><th /></tr></thead>
            <tbody>{communities.map((c) => (
              <tr key={c.slug} data-testid={`community-${c.slug}`}>
                <td data-label="Community"><b>{c.name}</b>{c.demoData && <span className="tag purple" style={{ marginLeft: 6 }}>Demo data</span>}<br /><small className="muted">{c.address || '—'}</small></td>
                <td data-label="Web address"><a href={communityUrl(c.slug)}>{communityUrl(c.slug).replace(/^https?:\/\//, '')}</a></td>
                <td data-label="Unit types">{c.unitTypes}</td>
                <td data-label="People">{counts[c.slug] ?? '…'}</td>
                <td data-label="Status"><span className={`tag ${c.status === 'Active' ? 'green' : 'red'}`}>{c.status}</span></td>
                <td data-label="Created">{c.createdAt}</td>
                <td data-label="" style={{ whiteSpace: 'nowrap' }}>
                  <a className="btn secondary sm" href={communityUrl(c.slug)}>Open</a>{' '}
                  {!registryOnServer() && <><button className="btn secondary sm" onClick={() => setMembers(c)}>People</button>{' '}</>}
                  <button className="btn secondary sm" onClick={async () => { try { await setCommunityStatus(c.slug, c.status === 'Active' ? 'Suspended' : 'Active'); } catch (e) { setFailure(e.message); } refresh(); }}>{c.status === 'Active' ? 'Suspend' : 'Activate'}</button>
                </td>
              </tr>
            ))}</tbody></table></div></div>
        ) : (
          <div className="card"><div className="table-wrap"><table className="resp-table">
            <thead><tr><th>Person</th><th>E-mail</th><th>Communities and roles</th></tr></thead>
            <tbody>{people.map((p) => (
              <tr key={p.key} data-testid="person-row"><td data-label="Person"><b>{p.name}</b></td><td data-label="E-mail">{p.email || '—'}</td>
                <td data-label="Communities and roles">{p.memberships.map((m) => <div key={m.slug}>{m.community} <span className="muted">· {m.roles.join(', ')}</span></div>)}</td></tr>
            ))}</tbody></table></div></div>
        )}
      </section>
      {creating && <NewCommunity onClose={() => setCreating(false)} onCreated={(c) => { setCreating(false); setFlash(`${c.name} is ready at ${communityUrl(c.slug).replace(/^https?:\/\//, '')}`); refresh(); }} />}
      {members && <Members community={members} onClose={() => { setMembers(null); refresh(); }} />}
    </div>
  );
}
