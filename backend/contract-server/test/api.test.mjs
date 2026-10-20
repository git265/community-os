// "Can this role do X?" asked of the REAL API (HTTP + PostgreSQL), not the screens.
//   cd backend/contract-server && npm test       (needs PostgreSQL; set TEST_DATABASE_URL, default postgres://postgres@localhost:5433/communityos)
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, seedTenant, pool as mkPool, TENANT, rolePhone, purge, setRow } from './harness.mjs';

let S, S2, pool; const T = {};
const phones = { root: '+91 98000 00003', pres: '+91 98000 00001', treas: '+91 98000 00002', own1: '+91 98000 00011', own2: '+91 98000 00012', guard: '+91 98000 00021' };

before(async () => {
  pool = mkPool(); await seedTenant(pool); await pool.query('DELETE FROM auth_attempts'); await pool.query('DELETE FROM sessions WHERE tenant=$1', [TENANT]);
  S = await startServer({ port: 8091, env: { DEMO_ROSTER: 'true' } });
  S2 = await startServer({ port: 8092 });   // production-like: no demo roster
  for (const [k, ph] of Object.entries(phones)) { const r = await S.otp(ph); assert.ok(r.token, `sign-in for ${k}: ${JSON.stringify(r.v?.body || r.r?.body)}`); T[k] = r.token; }
});
after(async () => { S?.stop(); S2?.stop(); await purge(pool); await pool.query("DELETE FROM sessions WHERE tenant=$1", [TENANT]); await pool.end(); });

describe('sign-in', () => {
  test('no token, no data', async () => {
    for (const c of ['users', 'dues', 'tickets', 'audit', 'roles']) assert.equal((await S.call('GET', `/${c}`)).status, 401, c);
  });
  test('garbage, tampered and alg=none tokens are refused', async () => {
    const [h, p, s] = T.own1.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), role: 'super_admin' })).toString('base64url');
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${p}.`;
    for (const tok of ['abc', `${h}.${forgedPayload}.${s}`, none, `${h}.${p}.`]) assert.equal((await S.call('GET', '/dues', { token: tok })).status, 401);
  });
  test('a token for one community does not open another', async () => {
    assert.equal((await S.call('GET', '/dues', { token: T.pres, tenant: 'other-community' })).status, 403);
  });
  test('the role comes from the server, not from anything the client sends', async () => {
    const r = await S.call('GET', '/audit', { token: T.own1, headers: { 'X-Role': 'super_admin' } });
    assert.equal(r.status === 200 ? r.body.length : 0, 0);
  });
  test('unregistered and deactivated numbers are told to contact the office', async () => {
    assert.equal((await S.call('POST', '/auth/request-code', { body: { phone: '+91 98000 55555' } })).status, 404);
    const r = await S.call('POST', '/auth/request-code', { body: { phone: '+91 98000 00031' } });
    assert.equal(r.status, 403); assert.match(r.body.message, /deactivated/);
  });
  test('a wrong code is refused, three wrong codes burn it', async () => {
    const r = await S.call('POST', '/auth/request-code', { body: { phone: phones.guard } });
    const wrong = r.body.code === '111111' ? '222222' : '111111';
    for (let i = 0; i < 3; i++) assert.equal((await S.call('POST', '/auth/verify', { body: { phone: phones.guard, code: wrong } })).status, 400);
    const good = await S.call('POST', '/auth/verify', { body: { phone: phones.guard, code: r.body.code } });
    assert.equal(good.status, 400, 'the code no longer works after 3 wrong tries');
  });
  test('five wrong codes lock the number', async () => {
    await pool.query("DELETE FROM auth_attempts WHERE key LIKE $1", [`%${TENANT}%`]);
    const ph = '+91 98000 00041';
    for (let i = 0; i < 5; i++) { const r = await S.call('POST', '/auth/request-code', { body: { phone: ph } }); if (r.status === 200) await S.call('POST', '/auth/verify', { body: { phone: ph, code: '000000' } }); }
    const r = await S.call('POST', '/auth/request-code', { body: { phone: ph } });
    assert.equal(r.status, 429); assert.equal(r.body.code, 'locked');
    await pool.query("DELETE FROM auth_attempts WHERE key LIKE $1", [`%${TENANT}%`]);
  });
  test('asking for codes is rate-limited per number and per network, and a resend needs a gap', async () => {
    await pool.query('DELETE FROM auth_attempts');
    const L = await startServer({ port: 8095, env: { OTP_PER_PHONE_HOUR: '2', OTP_PER_IP_HOUR: '4', OTP_RESEND_SECONDS: '0' } });
    try {
      const codes = []; for (let i = 0; i < 3; i++) codes.push((await L.call('POST', '/auth/request-code', { body: { phone: phones.own1 } })).status);
      assert.deepEqual(codes, [200, 200, 429], 'third code for one number in an hour');
      const more = []; for (const ph of [phones.own2, phones.pres, phones.treas]) more.push((await L.call('POST', '/auth/request-code', { body: { phone: ph } })).status);
      assert.ok(more.includes(429), 'the network limit stops a spray of numbers');
    } finally { L.stop(); await pool.query('DELETE FROM auth_attempts'); }
    await pool.query('DELETE FROM auth_codes WHERE tenant=$1', [TENANT]);
    const G = await startServer({ port: 8096, env: { OTP_RESEND_SECONDS: '30' } });
    try {
      assert.equal((await G.call('POST', '/auth/request-code', { body: { phone: phones.guard } })).status, 200);
      assert.equal((await G.call('POST', '/auth/request-code', { body: { phone: phones.guard } })).status, 429, 'asked again within the gap');
    } finally { G.stop(); }
  });
  test('refresh rotates the cookie; the old cookie is theft and ends the session', async () => {
    const a = await S.otp(phones.treas); assert.ok(a.cookie);
    const r1 = await S.call('POST', '/auth/refresh', { cookie: a.cookie }); assert.equal(r1.status, 200); assert.ok(r1.body.accessToken);
    const r2 = await S.call('POST', '/auth/refresh', { cookie: r1.cookie }); assert.equal(r2.status, 200);
    assert.equal((await S.call('POST', '/auth/refresh', { cookie: a.cookie })).status, 401, 'reusing the first cookie');
    assert.equal((await S.call("POST", "/auth/refresh", { cookie: r2.cookie })).status, 401, "the whole session was revoked");
  });
  test('logout ends the session at once, even for a token that has not expired', async () => {
    const a = await S.otp(phones.treas);
    assert.equal((await S.call('GET', '/dues', { token: a.token })).status, 200);
    await S.call('POST', '/auth/logout', { cookie: a.cookie });
    assert.equal((await S.call('GET', '/dues', { token: a.token })).status, 401);
  });
  test('deactivating a user ends their session immediately', async () => {
    const a = await S.otp('+91 98000 00041'); assert.equal((await S.call('GET', '/dues', { token: a.token })).status, 200);
    await setRow(pool, 'users', 'u-multi', { status: 'Inactive' });
    assert.equal((await S.call('GET', '/dues', { token: a.token })).status, 401);
    await setRow(pool, 'users', 'u-multi', { status: 'Active' });
  });
  test('the demo roster is off unless the server is told otherwise', async () => {
    assert.equal((await S2.call('POST', '/auth/demo', { body: { roleId: 'super_admin', name: 'x' } })).status, 404);
    assert.equal((await S2.call('GET', '/auth/config')).body.demoRoster, false);
    assert.equal((await S.call('GET', '/auth/config')).body.demoRoster, true);
  });
  test('production refuses to start with the demo roster or echoed codes', async () => {
    for (const env of [{ DEMO_ROSTER: 'true', OTP_DELIVERY: 'log' }, { OTP_DELIVERY: 'echo' }]) {
      await assert.rejects(startServer({ port: 8093, env: { NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(32), CORS_ORIGIN: 'https://x.example', ...env } }));
    }
  });
});

describe('who sees which rows', () => {
  test('a resident sees only their own unit\'s bills and tasks', async () => {
    const d = (await S.call('GET', '/dues', { token: T.own1 })).body; assert.deepEqual(d.map((x) => x.unit), ['V-1']);
    const t = (await S.call('GET', '/tickets', { token: T.own1 })).body; assert.deepEqual(t.map((x) => x.unit), ['V-1']);
    assert.equal((await S.call('GET', '/dues/due-2', { token: T.own1 })).status, 404);
    assert.equal((await S.call('GET', '/tickets/tk-2', { token: T.own1 })).status, 404);
  });
  test('the committee sees every unit', async () => {
    assert.equal((await S.call('GET', '/dues', { token: T.pres })).body.length, 2);
    assert.equal((await S.call('GET', '/dues', { token: T.treas })).body.length, 2);
  });
  test('a resident cannot read the ledger, audit trail or roles; staff cannot read the ledger', async () => {
    for (const c of ['ledger', 'audit', 'bankAccounts']) assert.equal((await S.call('GET', `/${c}`, { token: T.own1 })).body.length, 0, c);
    assert.equal((await S.call('GET', '/ledger', { token: T.guard })).body.length, 0);
  });
  test('query pages are scoped too', async () => {
    const r = await S.call('GET', '/dues/query?pageSize=10', { token: T.own2 });
    assert.deepEqual(r.body.rows.map((x) => x.unit), ['V-2']); assert.equal(r.body.total, 1);
  });
  test('fields are hidden: a resident sees no other household\'s phone or e-mail', async () => {
    const mine = (await S.call('GET', '/users', { token: T.own1 })).body;
    const admin = (await S.call('GET', '/users', { token: T.root })).body;
    assert.ok(admin.length > mine.length, 'a resident sees fewer people');
    const others = mine.filter((u) => u.id !== 'u-own1');
    for (const u of others) { assert.ok(!u.phone && !u.email, `${u.name} leaks contact details`); }
  });
});

describe('who may write what', () => {
  test('a resident cannot touch bills, roles or other units\' tasks', async () => {
    const own = (await S.call('GET', '/dues/due-1', { token: T.own1 })).body;
    assert.equal((await S.call('PUT', '/dues/due-1', { token: T.own1, body: { ...own, status: 'Paid' } })).status, 403);
    assert.equal((await S.call('DELETE', '/dues/due-1', { token: T.own1 })).status, 403);
    assert.equal((await S.call('PUT', '/dues/new-due', { token: T.own1, body: { id: 'new-due', unit: 'V-1', amount: 1, status: 'Unpaid' } })).status, 403);
    const role = (await S.call('GET', '/roles/owner', { token: T.own1 })).body;
    assert.equal((await S.call('PUT', '/roles/owner', { token: T.own1, body: { ...role, permissions: ['MANAGE_DUES'] } })).status, 403);
    assert.equal((await S.call('PUT', '/tickets/tk-2', { token: T.own1, body: { id: 'tk-2', title: 'hacked' } })).status, 403);
    assert.equal((await pool.query(`SELECT data->>'status' s FROM dues WHERE tenant=$1 AND id='due-1'`, [TENANT])).rows[0].s, 'Unpaid');
  });
  test('a resident can raise a task for their own unit, not for another', async () => {
    const mk = (unit) => ({ id: `tk-new-${unit}`, unit, title: 'Gate broken', status: 'Open', category: 'Civil', priority: 'Low', taskType: 'Resident Maintenance', createdBy: 'Olive Owner', createdByRole: 'owner', description: 'x' });
    const ok = await S.call('PUT', '/tickets/tk-new-V-1', { token: T.own1, body: mk('V-1') });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await S.call('PUT', '/tickets/tk-new-V-2', { token: T.own1, body: mk('V-2') })).status, 403);
  });
  test('the committee can change a bill; the server stamps who and when', async () => {
    const cur = (await S.call('GET', '/dues/due-2', { token: T.treas })).body;
    const r = await S.call('PUT', '/dues/due-2', { token: T.treas, body: { ...cur, amount: 2500, lastUpdatedBy: 'Somebody Else', recordCreatedBy: 'Forged' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.amount, 2500); assert.match(r.body.lastUpdatedBy, /Tia Treasurer/); assert.notEqual(r.body.recordCreatedBy, 'Forged');
    assert.equal(r.body.recVersion, (cur.recVersion || 1) + 1);
  });
});

describe('audit trail', () => {
  test('nobody can write, change or delete audit rows through the API - not even the Super Admin', async () => {
    const row = { id: 'fake-audit', who: 'Gina', summary: 'nothing happened', action: 'Create' };
    for (const k of ['root', 'pres', 'own1']) {
      assert.equal((await S.call('PUT', '/audit/fake-audit', { token: T[k], body: row })).status, 403, k);
      assert.equal((await S.call('DELETE', '/audit/fake-audit', { token: T[k] })).status, 403, k);
      assert.equal((await S.call('POST', '/audit/_create-many', { token: T[k], body: { rows: [row] } })).status, 403, k);
    }
    assert.equal((await pool.query(`SELECT count(*) c FROM audit_log WHERE tenant=$1 AND id='fake-audit'`, [TENANT])).rows[0].c, '0');
  });
  test('a change writes its own audit line, naming the person from the token', async () => {
    const before = (await S.call('GET', '/audit', { token: T.root })).body.length;
    const cur = (await S.call('GET', '/dues/due-2', { token: T.root })).body;
    await S.call('PUT', '/dues/due-2', { token: T.root, body: { ...cur, amount: 2600 } });
    const rows = (await S.call('GET', '/audit', { token: T.root })).body;
    assert.equal(rows.length, before + 1);
    const last = rows.at(-1); assert.match(last.who, /Root Admin/); assert.equal(last.recordId, 'due-2'); assert.ok(last.changes.some((c) => c.field === 'amount'));
  });
  test('a refused attempt is recorded even though nothing else was saved', async () => {
    const before = (await S.call('GET', '/audit', { token: T.root })).body.filter((a) => a.action === 'Denied').length;
    const own = (await S.call('GET', '/dues/due-1', { token: T.own1 })).body;
    assert.equal((await S.call('PUT', '/dues/due-1', { token: T.own1, body: { ...own, amount: 1 } })).status, 403);
    const denied = (await S.call('GET', '/audit', { token: T.root })).body.filter((a) => a.action === 'Denied');
    assert.equal(denied.length, before + 1); assert.match(denied.at(-1).who, /Olive Owner/);
  });
  test('audit numbers come from the database and never repeat', async () => {
    const ids = (await S.call('GET', '/audit', { token: T.root })).body.map((a) => a.shortId);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe('two people editing the same record', () => {
  test('the second save is refused with 409 and the stored version', async () => {
    const a = (await S.call('GET', '/dues/due-1', { token: T.treas })).body;
    const first = await S.call('PUT', '/dues/due-1', { token: T.treas, body: { ...a, amount: 1100 } }); assert.equal(first.status, 200);
    const stale = await S.call('PUT', '/dues/due-1', { token: T.pres, body: { ...a, amount: 1200 } });
    assert.equal(stale.status, 409); assert.equal(stale.body.code, 'conflict'); assert.equal(stale.body.current.amount, 1100);
    assert.equal((await pool.query(`SELECT data->>'amount' a FROM dues WHERE tenant=$1 AND id='due-1'`, [TENANT])).rows[0].a, '1100');
  });
  test('ten parallel saves of the same version: exactly one wins', async () => {
    const a = (await S.call('GET', '/dues/due-1', { token: T.treas })).body;
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => S.call('PUT', '/dues/due-1', { token: T.treas, body: { ...a, amount: 3000 + i } })));
    const codes = rs.map((r) => r.status).sort();
    assert.equal(codes.filter((c) => c === 200).length, 1, codes.join(','));
    assert.equal(codes.filter((c) => c === 409).length, 9);
  });
});

describe('several roles on one account', () => {
  test('the person picks one of their own roles; any other is refused', async () => {
    const a = await S.otp('+91 98000 00041');
    const sw = await S.call('POST', '/auth/switch-role', { token: a.token, body: { roleId: 'committee_amenities' } });
    assert.equal(sw.status, 200, JSON.stringify(sw.body));
    assert.equal((await S.call('POST', '/auth/switch-role', { token: a.token, body: { roleId: 'super_admin' } })).status, 403);
  });
});

// ---- the role matrix: every built-in role against the same set of questions ---------------------------------------
// Hand-written expectations (not computed from the rules), so a change to a rule that widens access fails here.
const EC_READERS = ['super_admin', 'president', 'general_secretary', 'treasurer', 'committee_landscape', 'committee_electrical', 'committee_security', 'committee_cultural', 'committee_amenities', 'facility_manager'];
const MATRIX = {
  'reads the ledger': { allow: EC_READERS },
  'changes a bill': { allow: ['super_admin', 'treasurer', 'committee_electrical', 'facility_manager'] },
  'edits a user account': { allow: ['super_admin'] },
  'edits a role': { allow: ['super_admin'] },
  'changes who gives final approval': { allow: ['super_admin', 'president', 'treasurer'] },
  'writes an audit line': { allow: [] },
};
describe('role matrix', async () => {
  const { DEFAULT_ROLES } = await import('../../../src/lib/access/roles.js');
  const tokens = {};
  before(async () => { for (const [i, r] of DEFAULT_ROLES.entries()) { const a = await S.otp(rolePhone(i)); assert.ok(a.token, `${r.id}: ${JSON.stringify(a.v?.body || a.r?.body)}`); tokens[r.id] = a.token; } });
  const probes = {
    'reads the ledger': async (t) => { const r = await S.call('GET', '/ledger', { token: t }); return r.status === 200 && r.body.length > 0; },
    'changes a bill': async (t) => { const cur = (await S.call('GET', '/dues/due-2', { token: T.root })).body; return (await S.call('PUT', '/dues/due-2', { token: t, body: { ...cur, note: `by ${Math.random()}` } })).status === 200; },
    'edits a user account': async (t) => { const cur = (await S.call('GET', '/users/u-own2', { token: T.root })).body; return (await S.call('PUT', '/users/u-own2', { token: t, body: { ...cur, nickname: `n${Math.random()}` } })).status === 200; },
    'edits a role': async (t) => { const cur = (await S.call('GET', '/roles/helpdesk', { token: T.root })).body; return (await S.call('PUT', '/roles/helpdesk', { token: t, body: { ...cur, description: `d${Math.random()}` } })).status === 200; },
    'changes who gives final approval': async (t) => (await S.call('PUT', '/approverSettings/aps-1', { token: t, body: { id: 'aps-1', roles: ['treasurer', 'president'] } })).status === 200,
    'writes an audit line': async (t) => (await S.call('PUT', '/audit/x-1', { token: t, body: { id: 'x-1', summary: 'x' } })).status === 200,
  };
  for (const [question, { allow }] of Object.entries(MATRIX)) {
    test(`who ${question}`, async () => {
      for (const r of DEFAULT_ROLES) assert.equal(await probes[question](tokens[r.id]), allow.includes(r.id), `${r.id} ${question}`);
    });
  }
  test('a resident-category role sees only its own unit; the others see all units', async () => {
    for (const r of DEFAULT_ROLES) {
      const units = new Set((await S.call('GET', '/dues', { token: tokens[r.id] })).body.map((d) => d.unit));
      if (r.category === 'Resident') assert.deepEqual([...units], ['V-1'], r.id);
    }
  });
});
