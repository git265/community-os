import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext.jsx';
import { storage, COLLECTIONS } from '../lib/storage/index.js';
import { PhoneInput } from './PeopleFields.jsx';
import { lookupInvite, requestPhoneOtp, verifyPhoneOtp } from '../lib/portalAccess.js';
import { maskPhone } from '../lib/phone.js';
import { getAuthConfig } from '../lib/auth/session.js';
import { authProviderFor } from '../lib/auth/providers.js';
import { demoRoster, inviteInfo } from '../lib/auth/authApi.js';

const joinToken = () => (/#\/join\/([a-f0-9]+)/.exec(window.location.hash) || [])[1] || '';

const CATEGORY_LABELS = { EC: 'Executive Committee', Staff: 'Facility Staff', Resident: 'Owners & Residents' };

export default function LoginScreen() {
  const { roles: ctxRoles, login: appLogin, community, enforced, signedInAs } = useApp();
  // With a back end that enforces sign-in the roles are not known before sign-in: the demo roster (if switched on) or the sign-in answer provides them.
  const [serverRoles, setServerRoles] = useState([]);
  const roles = enforced ? serverRoles : ctxRoles;
  const cfg = getAuthConfig() || {};
  const provider = enforced ? authProviderFor(cfg) : null;
  const serverUser = useRef(null);   // the person the server signed in (phone sign-in)
  const who = useRef({ userId: '', phone: '' });
  const [signing, setSigning] = useState(false);
  const login = async (roleId, name, unit, email) => {
    if (/#\/join\//.test(window.location.hash)) { try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch { /* ignore */ } }
    if (!enforced) return appLogin(roleId, name, unit, email, who.current.userId, who.current.phone);
    if (signing) return undefined;
    setSigning(true);
    try {
      if (serverUser.current) {                       // signed in by phone: the server already holds the session; tell it which role / unit this visit is for
        let u = serverUser.current;
        if (roleId !== u.roleId || (unit && unit !== u.unit)) u = await provider.switchRole({ roleId, unit: unit || undefined });
        return await signedInAs(u);
      }
      const person = users.find((x) => x.id === who.current.userId);   // demo roster: "People" tab or "Demo roles"
      return await signedInAs(await provider.demo({ roleId, name, units: unit ? [unit] : [], unit, userId: who.current.userId || undefined, blocks: person?.blocks || [] }));
    } catch (e) { setOtp((o) => ({ ...o, error: e.message })); setStep(null); return undefined; } finally { setSigning(false); }
  };
  const [notice] = useState(() => { try { return sessionStorage.getItem('communityos:loginNotice') || ''; } catch { return ''; } });
  useEffect(() => { const t = setTimeout(() => { try { sessionStorage.removeItem('communityos:loginNotice'); } catch { /* ignore */ } }, 500); return () => clearTimeout(t); }, []);
  const [token] = useState(joinToken);
  const [invite, setInvite] = useState(null); // { state, invite, user }
  useEffect(() => {
    if (!token) return;
    if (!enforced) { lookupInvite(token).then(setInvite); return; }
    inviteInfo(token).then((i) => setInvite({ state: i.state, invite: { personName: i.personName, unit: i.unit, phone: i.phoneMasked } })).catch(() => setInvite({ state: 'unknown' }));
  }, [token, enforced]);
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState({ sent: null, code: '', error: '', busy: false });
  // Pre-login the app only needs unit numbers and the user directory (the real backend replaces this
  // whole screen with a proper authentication endpoint).
  const [properties, setProperties] = useState([]);
  const [users, setUsers] = useState([]);
  useEffect(() => {
    if (enforced) {
      if (!cfg.demoRoster) return;
      demoRoster().then((r) => { setServerRoles(r.roles); setProperties(r.units.map((x) => ({ id: x.unit, unit: x.unit, owner: x.owner }))); setUsers(r.people); }).catch(() => {});
      return;
    }
    storage.list(COLLECTIONS.PROPERTIES).then((rows) => setProperties(rows.map((r) => ({ id: r.id, unit: r.unit, owner: r.owner }))));
    storage.list(COLLECTIONS.USERS).then((rows) => setUsers(rows.filter((u) => u.status !== 'Inactive')));
  }, []);
  const [mode, setMode] = useState(joinToken() || (enforced && !cfg.demoRoster) ? 'phone' : (import.meta.env.VITE_LOGIN_DEFAULT || 'people')); // phone | people | demo (set VITE_LOGIN_DEFAULT=phone in production)
  const [step, setStep] = useState(null); // null | { kind:'role', user } | { kind:'unit', name, roleId, units:[{unit,label}], optional }
  const roleName = (id) => roles.find((r) => r.id === id)?.name || id;
  const catOf = (id) => roles.find((r) => r.id === id)?.category;

  const groups = ['EC', 'Staff', 'Resident'].map((cat) => ({ category: cat, roles: roles.filter((r) => r.category === cat) }));
  const userGroups = ['EC', 'Staff', 'Resident'].map((cat) => ({ category: cat, users: users.filter((u) => catOf(u.roleId) === cat) })).filter((g) => g.users.length);

  const allUnits = properties.map((p) => ({ unit: p.unit, label: `${p.unit} · ${p.owner}` }));

  // Decide what happens after a role has been chosen (for a given person / demo account).
  function proceed({ name, roleId, units, residentName, email }) {
    const cat = catOf(roleId);
    if (cat === 'Resident') {
      if (units?.length === 1) return login(roleId, name, units[0], email);
      return setStep({ kind: 'unit', name, roleId, email, optional: false, units: units?.length ? units.map((u) => ({ unit: u, label: u })) : allUnits, residentName });
    }
    if (cat === 'EC') {
      // EC members are owners too: a villa lets them raise maintenance requests like any owner.
      if (units?.length === 1) return login(roleId, name, units[0], email);
      if (units?.length > 1) return setStep({ kind: 'unit', name, roleId, email, optional: true, units: units.map((u) => ({ unit: u, label: u })) });
      if (!units) return setStep({ kind: 'unit', name, roleId, email, optional: true, units: allUnits });
    }
    return login(roleId, name, '', email);
  }

  useEffect(() => { if (invite?.state === 'ok') setPhone(invite.invite.phone); }, [invite]);
  const target = () => (enforced && token && invite?.state === 'ok' ? { invite: token } : { phone });

  async function sendCode() {
    setOtp((o) => ({ ...o, error: '', busy: true }));
    try {
      if (enforced) { const r = await provider.requestCode(target()); setOtp({ sent: { code: r.code, formatted: token ? maskPhone(r.phone) : phone, e164: r.phone }, code: '', error: '', busy: false }); }
      else { const r = await requestPhoneOtp(phone); setOtp({ sent: r, code: '', error: '', busy: false }); }
    }
    catch (e) { setOtp({ sent: null, code: '', error: e.message, busy: false }); }
  }
  async function checkCode() {
    setOtp((o) => ({ ...o, error: '', busy: true }));
    try {
      if (enforced) {
        const r = await provider.verify(target(), otp.code); setOtp({ sent: null, code: '', error: '', busy: false });
        const { verifyInfo } = await import('../lib/auth/authApi.js'); const info = verifyInfo();   // role names / categories the sign-in answer carried
        setServerRoles(info.roles || []); serverUser.current = r; who.current = { userId: r.id, phone: r.phone };
        const roleIds = r.roleIds?.length ? r.roleIds : [r.roleId];
        if (roleIds.length > 1) { setStep({ kind: 'role', user: r, roleIds }); return; }
        const cat = (info.roles || []).find((x) => x.id === r.roleId)?.category;
        if ((cat === 'Resident' || cat === 'EC') && r.units?.length > 1) { setStep({ kind: 'unit', name: r.name, roleId: r.roleId, email: r.email, optional: false, units: r.units.map((x) => ({ unit: x, label: x })) }); return; }
        await login(r.roleId, r.name, r.unit, r.email); return;
      }
      const u = await verifyPhoneOtp(phone, otp.code); setOtp({ sent: null, code: '', error: '', busy: false }); pickUser(u);
    }
    catch (e) { setOtp((o) => ({ ...o, error: e.message, busy: false })); }
  }

  function pickUser(u) {
    who.current = { userId: u.id || '', phone: u.phone || '' };
    const roleIds = [u.roleId, ...(u.extraRoleIds || [])].filter((id) => roles.some((r) => r.id === id));
    if (roleIds.length > 1) return setStep({ kind: 'role', user: u, roleIds });
    proceed({ name: u.name, roleId: roleIds[0] || u.roleId, units: u.units || [], email: u.email });
  }

  const Brand = (
    <div className="brand" style={{ color: '#fff', marginBottom: 6 }}>
      <span className="mark">⌂</span> {community?.name || 'CommunityOS'}
      {community && <small style={{ display: 'block', fontSize: 11, fontWeight: 400, opacity: 0.7 }}>CommunityOS</small>}
    </div>
  );

  if (step?.kind === 'role') {
    return (
      <div className="login-screen">
        <div className="login-card">
          {Brand}
          <p className="muted" style={{ marginBottom: 22 }}><b style={{ color: '#fff' }}>{step.user.name}</b> — sign in as which role?</p>
          <div className="login-group">
            {step.roleIds.map((id) => (
              <button key={id} className="login-role-btn" onClick={() => proceed({ name: step.user.name, roleId: id, units: step.user.units || [], email: step.user.email })}>
                {roleName(id)} <span className="muted">· {catOf(id)}</span>
              </button>
            ))}
          </div>
          <button className="btn secondary" style={{ marginTop: 16 }} onClick={() => setStep(null)}>Back</button>
        </div>
      </div>
    );
  }

  if (step?.kind === 'unit') {
    return (
      <div className="login-screen">
        <div className="login-card">
          {Brand}
          <p className="muted" style={{ marginBottom: 22 }}>
            Signing in as <b style={{ color: '#fff' }}>{roleName(step.roleId)}</b> — {step.optional ? 'which villa/unit do you own? (so you can also raise maintenance requests as an owner)' : 'which villa/unit?'}
          </p>
          <div className="login-group">
            {step.units.map((u) => (
              <button key={u.unit} className="login-role-btn" onClick={() => login(step.roleId, step.demo && catOf(step.roleId) === 'Resident' ? (properties.find((p) => p.unit === u.unit)?.owner || step.name) : step.name, u.unit, step.email)}>
                {u.label}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
            <button className="btn secondary" onClick={() => setStep(null)}>Back</button>
            {step.optional && <button className="btn secondary" onClick={() => login(step.roleId, step.name, '', step.email)}>Skip — no villa</button>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        {Brand}
        {notice && <div className="notice error" data-testid="login-notice" style={{ marginBottom: 12 }}>🔒 {notice}</div>}
        <div className="tabs" style={{ margin: '8px 0 14px' }}>
          <button className={mode === 'phone' ? 'active' : ''} data-testid="tab-phone" onClick={() => setMode('phone')}>Phone</button>
          {(!enforced || cfg.demoRoster) && <button className={mode === 'people' ? 'active' : ''} onClick={() => { who.current = { userId: '', phone: '' }; setMode('people'); }}>People</button>}
          {(!enforced || cfg.demoRoster) && <button className={mode === 'demo' ? 'active' : ''} onClick={() => { who.current = { userId: '', phone: '' }; setMode('demo'); }}>Demo roles</button>}
        </div>
        {mode === 'phone' && (
          <div data-testid="phone-login" style={{ padding: '0 4px' }}>
            {token && invite?.state === 'ok' && <div className="notice" data-testid="invite-ok" style={{ marginBottom: 12 }}>👋 <b>{invite.invite.personName}</b>, you have been registered for <b>{invite.invite.unit}</b> at <b>{community?.name}</b>. Confirm your phone number ({maskPhone(invite.invite.phone)}) to open the portal. If you already use CommunityOS in another community, this one is simply added to your account.</div>}
            {token && invite && invite.state !== 'ok' && <div className="notice error" data-testid="invite-bad" style={{ marginBottom: 12 }}>{invite.state === 'expired' ? 'This sign-in link has expired. Ask the community office to send a new one.' : invite.state === 'revoked' ? 'This sign-in link is no longer valid — the registered phone number was changed or removed. Ask the community office for a new link.' : 'This sign-in link is not recognised. Check that you opened the full link from your message.'}</div>}
            <p className="muted" style={{ marginBottom: 12 }}>Sign in with the mobile number registered for your home. We send a one-time code to it.</p>
            <div className="field" style={{ marginBottom: 10 }}>
              <label>Mobile number (with country code)</label>
              {token && invite?.state === 'ok' ? <input type="text" value={maskPhone(phone)} readOnly aria-label="Registered phone" /> : <PhoneInput value={phone} onChange={(v) => { setPhone(v); setOtp({ sent: null, code: '', error: '', busy: false }); }} label="Mobile number" testid="login-phone" />}
            </div>
            {!otp.sent && <button className="btn" data-testid="send-code" disabled={otp.busy || !phone} onClick={sendCode}>Send code</button>}
            {otp.sent && (
              <div>
                {otp.sent.code
                  ? <div className="notice" data-testid="sim-sms" style={{ margin: '8px 0' }}>📱 <b>Simulated SMS</b> to {otp.sent.formatted}: your code is <b data-testid="sim-code">{otp.sent.code}</b> <small className="muted">(demo only — a real SMS gateway sends this in production)</small></div>
                  : <div className="notice" data-testid="code-sent" style={{ margin: '8px 0' }}>📱 We sent a 6-digit code to <b>{otp.sent.formatted}</b>. It works for 5 minutes.</div>}
                <input type="text" inputMode="numeric" maxLength={6} aria-label="One-time code" data-testid="otp-input" style={{ width: '100%' }} placeholder="6-digit code" value={otp.code} onChange={(e) => setOtp((o) => ({ ...o, code: e.target.value }))} />
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button className="btn" data-testid="verify-code" disabled={otp.busy || otp.code.length < 6} onClick={checkCode}>Verify &amp; sign in</button>
                  <button className="btn secondary" onClick={() => setOtp({ sent: null, code: '', error: '', busy: false })}>Change number</button>
                </div>
              </div>
            )}
            {otp.error && <div className="field-error" data-testid="phone-error" style={{ marginTop: 8 }}>{otp.error}</div>}
          </div>
        )}
        {mode !== 'phone' && <p className="muted" style={{ marginBottom: 22 }}>
          {mode === 'people' ? 'Demo: sign in as a person without a code. Their role(s) and villa come from Administration → Users.' : 'Pick a role to preview the app as that role.'}
        </p>}

        {mode !== 'phone' && <div className="login-groups">
          {mode === 'people'
            ? userGroups.map((g) => (
              <div key={g.category} className="login-group">
                <div className="nav-label" style={{ color: '#9db5c7', margin: '0 0 8px' }}>{CATEGORY_LABELS[g.category]}</div>
                {g.users.map((u) => (
                  <button key={u.id} className="login-role-btn" onClick={() => pickUser(u)}>
                    {u.name}
                    <span className="muted"> · {roleName(u.roleId)}{u.extraRoleIds?.length ? ` +${u.extraRoleIds.length}` : ''}{u.units?.length ? ` · ${u.units.join(', ')}` : ''}</span>
                  </button>
                ))}
              </div>
            ))
            : groups.map((g) => (
              <div key={g.category} className="login-group">
                <div className="nav-label" style={{ color: '#9db5c7', margin: '0 0 8px' }}>{CATEGORY_LABELS[g.category]}</div>
                {g.roles.map((r) => (
                  <button key={r.id} className="login-role-btn" onClick={() => (r.category === 'Staff' ? login(r.id, r.name, '') : setStep({ kind: 'unit', name: r.category === 'EC' ? r.name : '', roleId: r.id, optional: r.category === 'EC', units: allUnits, demo: true }))}>
                    {r.name}
                  </button>
                ))}
              </div>
            ))}
        </div>}
      </div>
    </div>
  );
}
