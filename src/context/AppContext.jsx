import { setLock } from '../lib/finance/lock.js';
import { logEvent } from '../lib/audit/auditLog.js';
import { tabOpen } from '../lib/access/tabs.js';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { COLLECTIONS } from '../lib/storage/index.js';
import { secureStorage } from '../lib/storage/secureStorage.js';
import { setPrincipal, setSchemaCache } from '../lib/security/principal.js';
import { AuthzError } from '../lib/security/authz.js';
import { loadSchemas } from '../lib/schema/schemaStore.js';
import { loadRoles } from '../lib/access/roleStore.js';
import { getCommunity } from '../lib/community.js';
import { getCommunityRecord, takeHandoff } from '../lib/platform/registry.js';
import { storage } from '../lib/storage/index.js';
import { setCommunityConfig } from '../lib/locale.js';
import { isApiMode } from '../lib/storage/index.js';
import { loadAuthConfig, publicCommunity, whoAmI } from '../lib/auth/authApi.js';
import { authProviderFor } from '../lib/auth/providers.js';
import { getAuthConfig, getAuthUser } from '../lib/auth/session.js';
import { getDataSource } from '../lib/storage/dataSource.js';

const AppCtx = createContext(null);

export function AppProvider({ children }) {
  const [roles, setRoles] = useState([]);
  const [schemas, setSchemas] = useState([]);
  const [ready, setReady] = useState(false);
  const [currentUser, setCurrentUser] = useState(null); // { roleId, name, phone } | null = logged out

  const [community, setCommunity] = useState(null); // the registry row of the community in the web address
  const [communityState, setCommunityState] = useState('loading'); // loading | ok | missing | suspended

  const [enforced, setEnforced] = useState(false);   // the back end decides who may do what (AUTH_MODE=enforce)

  // Everything that needs a signed-in person (field definitions, roles, community settings). In the browser demo this runs at start-up;
  // with a back end that enforces sign-in the server would refuse it earlier, so it runs once the person has signed in.
  const loadAfterSignIn = useCallback(async () => {
    setSchemas(await loadSchemas());
    setRoles(await loadRoles());
    setCommunityConfig((await storage.list(COLLECTIONS.COMMUNITY_CONFIG))[0]);
    setLock((await storage.list(COLLECTIONS.FINANCE_SETTINGS))[0]?.lockedUntil);
  }, []);

  /** A person the SERVER has signed in ({ id, name, roleId, roleIds, units, unit, blocks, email, phone }) becomes the current user. */
  const signedInAs = useCallback(async (u) => {
    await loadAfterSignIn();
    setCurrentUser({ roleId: u.roleId, name: u.name, phone: u.phone || '', unit: u.unit || u.units?.[0] || '', email: u.email || '', userId: u.id || '', blocks: u.blocks || [], units: u.units || [], roleIds: u.roleIds || [u.roleId] });
    setReady(true);
  }, [loadAfterSignIn]);

  useEffect(() => {
    (async () => {
      const slug = getCommunity();
      if (isApiMode()) {
        const cfg = await loadAuthConfig();
        if (cfg.mode === 'enforce') {
          setEnforced(true);
          const rec = await publicCommunity().catch(() => null);
          if (!rec) { setCommunityState('missing'); return; }
          setCommunity(rec);
          if (rec.status !== 'Active') { setCommunityState('suspended'); return; }
          setCommunityState('ok');
          const provider = authProviderFor(cfg);
          try {
            if (cfg.provider === 'oidc') await provider.finishCallback();
            let user = await provider.restore();          // a reload: the refresh cookie (or the identity provider's session) gives the session back
            if (user && !user.roleId) user = await whoAmI();
            if (user) { await signedInAs(user); return; }
          } catch { /* not signed in: show the sign-in screen */ }
          setReady(true);
          return;
        }
      }
      const rec = await getCommunityRecord(slug);
      if (!rec) { setCommunityState('missing'); return; }
      setCommunity(rec);
      if (rec.status !== 'Active') { setCommunityState('suspended'); return; }
      const { seedIfEmpty } = await import('../lib/seed/seedData.js'); // the demo data is only downloaded when a community has to be seeded
      await seedIfEmpty(rec);
      setSchemas(await loadSchemas());
      setRoles(await loadRoles());
      setCommunityConfig((await storage.list(COLLECTIONS.COMMUNITY_CONFIG))[0]); // currency, number grouping, financial-year start (before anything renders money)
      setLock((await storage.list(COLLECTIONS.FINANCE_SETTINGS))[0]?.lockedUntil); // closed books (period lock)
      setCommunityState('ok');
      setReady(true);
      // arrived from another community of the same person (single sign-on hand-off): sign in straight away
      const h = takeHandoff(slug);
      if (h) {
        const u = (await storage.list(COLLECTIONS.USERS)).find((x) => x.id === h.userId && x.status !== 'Inactive');
        if (u) {
          if (u.status === 'Invited') await storage.put(COLLECTIONS.USERS, { ...u, status: 'Active', activatedAt: new Date().toISOString() }); // already proven by phone in the other community
          setCurrentUser({ roleId: u.roleId, name: u.name, phone: u.phone || '', unit: u.units?.[0] || '', email: u.email || '', userId: u.id, blocks: u.blocks || [] });
        }
      }
    })();
  }, []);

  const refreshSchemas = useCallback(async () => {
    setSchemas(await loadSchemas());
  }, []);

  useEffect(() => { const h = () => refreshSchemas(); window.addEventListener('communityos:schemas', h); return () => window.removeEventListener('communityos:schemas', h); }, [refreshSchemas]);

  const refreshRoles = useCallback(async () => {
    setRoles(await loadRoles());
  }, []);

  const schemaFor = useCallback((sectionId) => schemas.find((s) => s.id === sectionId), [schemas]);
  const roleFor = useCallback((roleId) => roles.find((r) => r.id === roleId), [roles]);

  const roleId = currentUser?.roleId ?? null;
  const role = roleId ? roleFor(roleId) : null;

  // Set synchronously (not in an effect) so child hooks that load data on
  // mount already know who is calling - the equivalent of the JWT principal.
  setPrincipal(currentUser && role ? { roleId, role, name: currentUser.name, unit: currentUser.unit || '', blocks: Array.isArray(currentUser.blocks) ? currentUser.blocks : [], community: getCommunity() } : null);
  setSchemaCache(schemas);

  const hasPermission = useCallback(
    (permissionId) => !!role?.permissions?.includes(permissionId),
    [role]
  );

  const tabAllowed = useCallback((id) => tabOpen(role, id), [role]);

  // The session ended on the server (expired, signed out elsewhere, access withdrawn): back to the sign-in screen, with the reason.
  useEffect(() => {
    const h = (e) => {
      if (e.detail?.signedIn) return;
      if (e.detail?.reason) { try { sessionStorage.setItem('communityos:loginNotice', e.detail.reason); } catch { /* ignore */ } }
      setCurrentUser(null);
    };
    window.addEventListener('communityos:auth', h);
    return () => window.removeEventListener('communityos:auth', h);
  }, []);

  // A signed-in person whose account is deactivated meanwhile (e.g. their phone number was changed on the property register) is signed out.
  useEffect(() => {
    // Browser demo store only. With a back end (either kind) this is the server's business: it ends a deactivated person's session itself,
    // and polling the whole users list every 10 seconds from every open tab is exactly the traffic a back end must not get.
    if (!currentUser?.userId || enforced || isApiMode()) return undefined;
    let on = true;
    const check = async () => {
      const u = (await storage.list(COLLECTIONS.USERS)).find((x) => x.id === currentUser.userId);
      if (on && u && u.status === 'Inactive') {
        try { sessionStorage.setItem('communityos:loginNotice', 'Your portal access was deactivated because the phone number registered for your home was changed. Please contact the community office.'); } catch { /* ignore */ }
        setCurrentUser(null);
      }
    };
    const h = (e) => { if (!e.detail || e.detail.collection === COLLECTIONS.USERS) check(); };
    window.addEventListener('communityos:changed', h);
    window.addEventListener('focus', check);
    const t = setInterval(check, 10000);
    return () => { on = false; window.removeEventListener('communityos:changed', h); window.removeEventListener('focus', check); clearInterval(t); };
  }, [currentUser?.userId, enforced]);

  async function login(roleId, name, unit, email, userId, phone) {
    // block-limited staff: the blocks on their user row travel with the session (the principal) before any data is read
    let blocks = [];
    // on the v2 back end the server's answer to "who am I" already carries them (no need to read every member)
    if (getDataSource().mode === 'v2') blocks = getAuthUser()?.blocks || [];
    else { try { const us = await storage.list(COLLECTIONS.USERS); const u = us.find((x) => (userId && x.id === userId) || (x.name === name && x.roleId === roleId)); blocks = u?.blocks || []; } catch { /* no users yet */ } }
    // `unit` ties a Resident-category session to one villa/apartment, which is
    // what lets the Maintenance module scope a resident to their own
    // tickets only - see modules/tickets/ticketEngine.js#visibleTicketsFor.
    setCurrentUser({ roleId, name: name || roleFor(roleId)?.name || roleId, phone: phone || '', unit: unit || '', email: email || '', userId: userId || '', blocks });
    const who = `${name || roleFor(roleId)?.name || roleId} (${roleFor(roleId)?.name || roleId})`;
    logEvent({ who, what: 'Sign-in', action: 'Sign-in', summary: `${who} signed in${unit ? ` · ${unit}` : ''}`, unit: unit || '' });
  }
  function logout() {
    if (enforced) { authProviderFor(getAuthConfig()).signOut(); setCurrentUser(null); return; }
    if (currentUser) { const who = `${currentUser.name} (${roleFor(currentUser.roleId)?.name || currentUser.roleId})`; logEvent({ who, what: 'Sign-in', action: 'Sign-out', summary: `${who} signed out`, unit: currentUser.unit || '' }); }
    setCurrentUser(null);
  }
  /** Name and phone are what other people (and the poll / audit trail) see you as, so only the Super Admin changes them; everyone else asks the office. Role, villa, e-mail and id can never be changed here. */
  function updateProfile(patch) {
    if (currentUser?.roleId !== 'super_admin') return false;
    const { name, phone } = patch || {};
    setCurrentUser((u) => ({ ...u, ...(name !== undefined ? { name } : {}), ...(phone !== undefined ? { phone } : {}) }));
    return true;
  }

  const value = {
    roleId,
    role,
    roles,
    roleFor,
    hasPermission,
    tabAllowed,
    refreshRoles,
    currentUser,
    login,
    signedInAs,
    enforced,
    logout,
    updateProfile,
    schemas,
    schemaFor,
    refreshSchemas,
    ready,
    community,
    communityState,
  };

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export function useApp() {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}

/**
 * Generic CRUD hook any module can use against a given collection. All reads
 * and writes go through secureStorage: role/row/field authorization, record
 * metadata (id, lastUpdatedBy/At, version) and the audit trail with changed
 * fields are applied there, so no module can forget them.
 * `sectionLabel` is what shows up in the Audit Trail's "What" column.
 * save() resolves to the stored record, or null if the write was denied
 * (a "not permitted" toast is raised instead of throwing into the UI).
 */
export function useCollection(collection, sectionLabel = collection, { enabled = true } = {}) {
  const { schemaFor, currentUser, roleId } = useApp();
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  // The list is read only when the component actually USES it (reads `records` or `loading` while rendering) and `enabled` is true. A component that
  // only saves through this hook (a form, a dialog, a pay button) never downloads the whole collection, and a panel that is closed reads nothing.
  const wanted = useRef(false);
  const loaded = useRef(false);

  const refresh = useCallback(async () => {
    loaded.current = true;
    setRecords(await secureStorage.list(collection));
    setLoading(false);
  }, [collection, currentUser, roleId]);

  // a new person, role or collection: what was read for the old one no longer counts
  useEffect(() => { loaded.current = false; }, [refresh]);
  // after every render: read the list the first time it is wanted (and allowed)
  useEffect(() => {
    if (enabled && wanted.current && !loaded.current) refresh();
  });

  // Any write to this collection (from any component) refreshes every consumer that has read it.
  useEffect(() => {
    const onChange = (e) => { if (e.detail?.collection === collection && loaded.current && enabled) refresh(); };
    window.addEventListener('communityos:changed', onChange);
    return () => window.removeEventListener('communityos:changed', onChange);
  }, [collection, refresh, enabled]);

  const describeRecord = useCallback(
    (record) => {
      const schema = schemaFor(collection);
      const titleField = schema?.fields.find((f) => f.showInTable)?.key;
      return titleField ? String(record[titleField] ?? record.id) : record.id;
    },
    [collection, schemaFor]
  );

  const save = useCallback(
    async (record) => {
      // Show the edit at once (a toggle must not snap back while a remote back end answers); the real, stamped row replaces it
      // when the write finishes and the collection refreshes. A denied or failed write is rolled back by that same refresh.
      if (record?.id) setRecords((rs) => (rs.some((r) => r.id === record.id) ? rs.map((r) => (r.id === record.id ? { ...r, ...record } : r)) : rs));
      try {
        const saved = await secureStorage.put(collection, record, { summaryOf: describeRecord, label: sectionLabel });
        if (!saved) refresh();
        // the stored row, with the version the server stamped, replaces the optimistic one at once: a second save of the same record must send that version
        else if (saved.id) setRecords((rs) => (rs.some((r) => r.id === saved.id) ? rs.map((r) => (r.id === saved.id ? saved : r)) : rs));
        return saved;
      } catch (err) {
        refresh();
        if (err instanceof AuthzError) {
          window.dispatchEvent(new CustomEvent('communityos:denied', { detail: { message: err.message } }));
          return null;
        }
        throw err;
      }
    },
    [collection, sectionLabel, describeRecord, refresh]
  );

  const remove = useCallback(
    async (id) => {
      try {
        await secureStorage.remove(collection, id, { summaryOf: describeRecord, label: sectionLabel });
      } catch (err) {
        if (err instanceof AuthzError) {
          window.dispatchEvent(new CustomEvent('communityos:denied', { detail: { message: err.message } }));
          return;
        }
        throw err;
      }
    },
    [collection, sectionLabel, describeRecord]
  );

  return {
    get records() { wanted.current = true; return records; },
    get loading() { wanted.current = true; return enabled ? loading : false; },
    save, remove, refresh,
  };
}
