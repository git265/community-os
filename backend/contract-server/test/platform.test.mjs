// Creating a community on a server that enforces access, a payer with several villas, and the portal invite link.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, seedTenant, pool as mkPool, purge, rowsOf, setRow } from './harness.mjs';

const TENANT = 'authz-platform';   // its own community: the other test files run at the same time

const KEY = 'platform-key-for-tests-0123';
const NEW = 'palm-meadows-t';
let S, pool, root;
const P = (method, path, body, key = KEY) => S.call(method, `/platform${path}`, { body, headers: { 'X-Platform-Key': key } });

before(async () => {
  pool = mkPool(); await seedTenant(pool, TENANT); await purge(pool, NEW); await pool.query("DELETE FROM documents WHERE tenant='platform' AND collection='communities' AND id=$1", [NEW]);
  await pool.query('DELETE FROM auth_attempts');
  S = await startServer({ port: 8096, tenant: TENANT, env: { PLATFORM_ADMIN_KEY: KEY, PUBLIC_APP_URL: 'https://app.communityos.example' } });
  root = (await S.otp('+91 98000 00003')).token;
});
after(async () => { S?.stop(); await purge(pool, TENANT); await purge(pool, NEW); await pool.query("DELETE FROM documents WHERE tenant='platform' AND collection='communities' AND id=$1", [NEW]); await pool.end(); });

describe('the platform console', () => {
  test('without the platform key nothing is listed or created', async () => {
    assert.equal((await P('GET', '/communities', undefined, 'wrong-key-wrong-key')).status, 401);
    assert.equal((await P('POST', '/communities', { name: 'X', slug: 'xx-yy' }, '')).status, 401);
  });
  test('a new community gets its defaults and a first Super Admin who signs in with a code', async () => {
    const refused = await P('POST', '/communities', { name: 'Palm Meadows', slug: NEW, adminName: 'Ravi', adminEmail: 'ravi@palm.in', adminPhone: '98450 1' });
    assert.equal(refused.status, 400); assert.ok(refused.body.errors.adminPhone);
    const r = await P('POST', '/communities', { name: 'Palm Meadows', slug: NEW, adminName: 'Ravi', adminEmail: 'ravi@palm.in', adminPhone: '+91 90080 12345' });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.community.slug, NEW);
    assert.equal((await P('POST', '/communities', { name: 'Again', slug: NEW, adminName: 'R', adminEmail: 'r@x.in', adminPhone: '+91 90080 12345' })).status, 400);   // address taken
    const listed = (await P('GET', '/communities')).body.find((c) => c.slug === NEW);
    assert.equal(listed.people, 1);
    assert.ok((await rowsOf(pool, 'roles', NEW)).length >= 10);
    assert.ok((await rowsOf(pool, 'taskTypes', NEW)).length > 0);
    const s = await S.call('POST', '/auth/request-code', { tenant: NEW, body: { phone: '+91 90080 12345' } });
    const v = await S.call('POST', '/auth/verify', { tenant: NEW, body: { phone: '+91 90080 12345', code: s.body.code } });
    assert.equal(v.status, 200); assert.equal(v.body.user.roleId, 'super_admin');
    const cfg = (await S.call('GET', '/communityConfig', { tenant: NEW, token: v.body.accessToken })).body;
    assert.equal(cfg[0].legalName, 'Palm Meadows');
    assert.equal((await S.call('GET', '/dues', { tenant: TENANT, token: v.body.accessToken })).status === 200, false);   // not a key to another community
  });
  test('a community can be suspended and re-activated', async () => {
    assert.equal((await P('PATCH', `/communities/${NEW}`, { status: 'Suspended' })).body.status, 'Suspended');
    assert.equal((await P('PATCH', `/communities/${NEW}`, { status: 'Active' })).body.status, 'Active');
    assert.equal((await P('PATCH', `/communities/${NEW}`, { status: 'Gone' })).status, 400);
  });
});

describe('the property register', () => {
  test('a new number on a property is invited with a link to this community', async () => {
    const r = await S.call('PUT', '/properties/p-V-2', { token: root, body: { id: 'p-V-2', unit: 'V-2', type: 'Villa', owner: 'Omar Owner', ownerPhone: '+91 98000 00012', occupancy: 'Tenant occupied', tenant: 'Tina Tenant', tenantPhone: '+91 90000 55511', recVersion: 1 } });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.tenantPhone, '+919000055511');
    const out = (await rowsOf(pool, 'notificationOutbox', TENANT)).filter((o) => o.event === 'portal_invite' && o.to === '+919000055511');
    assert.equal(out.length, 2);
    assert.match(out[0].body, /https:\/\/authz-platform\.communityos\.example\/#\/join\/[0-9a-f]{24}/);
  });
  test('a phone without the country code is refused', async () => {
    const r = await S.call('PUT', '/properties/p-V-1', { token: root, body: { id: 'p-V-1', unit: 'V-1', owner: 'Owner of V-1', ownerPhone: '98000 09999', occupancy: 'Owner occupied', recVersion: 1 } });
    assert.equal(r.status, 403); assert.match(r.body.message, /country code/);
  });
});

describe('a payer with several villas', () => {
  test('pays the bills of each of them, never another\'s', async () => {
    await setRow(pool, 'users', 'u-own1', { units: ['V-1', 'V-4'] }, TENANT);
    const t = (await S.otp('+91 98000 00011')).token;
    await pool.query("INSERT INTO dues (tenant, id, data) VALUES ($1, 'due-v4', $2) ON CONFLICT DO NOTHING", [TENANT, JSON.stringify({ id: 'due-v4', unit: 'V-4', amount: 400, status: 'Unpaid', category: 'Maintenance', dueDate: '2026-10-10', recVersion: 1, shortId: 'DUE-0444' })]);
    const second = await S.call('POST', '/payments/orders', { token: t, body: { purpose: 'due', refs: ['due-v4'] } });
    assert.equal(second.status, 200, JSON.stringify(second.body)); assert.equal(second.body.unit, 'V-4');
    assert.equal((await S.call('POST', '/payments/orders', { token: t, body: { purpose: 'due', refs: ['due-2'] } })).status, 403);
  });
});
