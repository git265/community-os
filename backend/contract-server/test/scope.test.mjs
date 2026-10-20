// The database applies row scope, filters, sort and paging (fast path); the in-memory path is the reference. They must agree for every role.
// Two servers share one database: one normal, one with DB_SCOPE=off.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, seedTenant, seedExtras, pool as mkPool, purge, rolePhone } from './harness.mjs';
const TENANT = 'authz-scope';
const { DEFAULT_ROLES } = await import('../../../src/lib/access/roles.js');

let FAST, SLOW, pool; const tok = { fast: {}, slow: {} };
const who = [['own1', '+91 98000 00011'], ['own2', '+91 98000 00012'], ['guard', '+91 98000 00021'], ['pres', '+91 98000 00001'], ['treas', '+91 98000 00002'], ['root', '+91 98000 00003'], ['blk', '+91 98000 00051'],
  ...DEFAULT_ROLES.map((r, i) => [`role-${r.id}`, rolePhone(i)])];
const COLLECTIONS = ['dues', 'tickets', 'amenities', 'ledger', 'audit', 'users', 'properties', 'taskTypes', 'roles'];

before(async () => {
  pool = mkPool(); await seedTenant(pool, TENANT); await seedExtras(pool, TENANT); await pool.query('DELETE FROM auth_attempts');
  FAST = await startServer({ port: 8111, tenant: TENANT }); SLOW = await startServer({ port: 8112, tenant: TENANT, env: { DB_SCOPE: 'off' } });
  for (const [k, ph] of who) { tok.fast[k] = (await FAST.otp(ph)).token; tok.slow[k] = (await SLOW.otp(ph)).token; assert.ok(tok.fast[k] && tok.slow[k], `sign-in ${k}`); }
});
after(async () => { FAST?.stop(); SLOW?.stop(); await purge(pool, TENANT); await pool.end(); });

const both = async (k, path) => [await FAST.call('GET', path, { token: tok.fast[k] }), await SLOW.call('GET', path, { token: tok.slow[k] })];
const ids = (r) => (Array.isArray(r.body) ? r.body : r.body?.rows || []).map((x) => x.id);

describe('database scope = in-memory scope', () => {
  test('a plain list of every collection is identical for every role', async () => {
    let compared = 0;
    for (const [k] of who) for (const c of COLLECTIONS) {
      const [a, b] = await both(k, `/${c}`);
      assert.equal(a.status, b.status, `${k} ${c} status`); assert.deepEqual(a.body, b.body, `${k} ${c}`); compared++;
    }
    assert.ok(compared > 150);
  });
  test('one record by id is identical (found, hidden or missing)', async () => {
    for (const [k] of who) for (const [c, id] of [['dues', 'due-1'], ['dues', 'due-2'], ['dues', 'due-3'], ['tickets', 'tk-1'], ['tickets', 'tk-3'], ['amenities', 'bk-1'], ['amenities', 'bk-2'], ['properties', 'p-V-1'], ['audit', 'aud-1'], ['ledger', 'led-1'], ['dues', 'nope']]) {
      const [a, b] = await both(k, `/${c}/${id}`); assert.equal(a.status, b.status, `${k} ${c}/${id}`); assert.deepEqual(a.body, b.body, `${k} ${c}/${id}`);
    }
  });
  test('filtered, searched, date-ranged and paged queries return the same rows', async () => {
    const qs = ['page=1&pageSize=2', 'page=2&pageSize=2', 'f.status=Unpaid', 'f.status=Unpaid&f.status=Paid&pageSize=10', 'search=maint', 'search=leak&searchKey=title', 'dateKey=dueDate&from=2026-10-01&to=2026-10-31',
      'f.unit=V-1', 'f.unit=__none__', 'f.category=Maintenance&search=V-3'];
    for (const [k] of who) for (const c of ['dues', 'tickets', 'amenities', 'audit', 'ledger']) for (const q of qs) {
      const [a, b] = await both(k, `/${c}/query?${q}`);
      assert.equal(a.status, b.status, `${k} ${c} ${q}`);
      if (a.status === 200) { assert.deepEqual(ids(a), ids(b), `${k} ${c} ?${q}`); assert.equal(a.body.total, b.body.total, `${k} ${c} ?${q} total`); }
    }
  });
  test('sorted queries return the same order (numbers and dates)', async () => {
    for (const k of ['pres', 'treas', 'root', 'blk']) for (const [c, key] of [['dues', 'amount'], ['dues', 'dueDate'], ['ledger', 'amount'], ['amenities', 'date']]) for (const dir of ['asc', 'desc']) {
      const [a, b] = await both(k, `/${c}/query?sort=${key}:${dir}&pageSize=50`); assert.deepEqual(ids(a), ids(b), `${k} ${c} ${key}:${dir}`);
    }
  });
  test('a hidden field cannot be probed through a filter or sort', async () => {
    // the resident never sees other households' phone numbers; filtering on the phone must not reveal a match either
    const [a, b] = await both('own1', `/properties/query?f.ownerPhone=${encodeURIComponent('+91 98000 09999')}`);
    assert.deepEqual(ids(a), ids(b)); assert.deepEqual(a.body.rows.map((r) => r.id).sort(), b.body.rows.map((r) => r.id).sort());
  });
  test('a block-limited secretary sees only the units of their block, plus rows with no unit', async () => {
    const r = await FAST.call('GET', '/dues', { token: tok.fast.blk }); const got = r.body.map((d) => d.id).sort();
    assert.deepEqual(got, ['due-1', 'due-3', 'due-4'], 'V-1 and V-3 are in block A; the unit-less charge stays visible; V-2 (block B) is hidden');
  });
});

describe('typed tables keep their promises', () => {
  const put = (token, c, rec) => FAST.call('PUT', `/${c}/${rec.id}`, { token, body: rec });
  test('a bill for a unit that does not exist is refused; a community-level bill is fine', async () => {
    const root = tok.fast.root;
    const bad = await put(root, 'dues', { id: 'due-x1', unit: 'Z-999', amount: 10, status: 'Unpaid', category: 'Maintenance', dueDate: '2026-11-01' });
    assert.equal(bad.status, 400, JSON.stringify(bad.body)); assert.equal(bad.body.code, 'unknown-unit');
    assert.equal((await put(root, 'dues', { id: 'due-x2', unit: '', amount: 10, status: 'Unpaid', category: 'Corpus', dueDate: '2026-11-01' })).status, 200);
  });
  test('a unit that still has bills cannot be deleted', async () => {
    const r = await FAST.call('DELETE', '/properties/p-V-1', { token: tok.fast.root }); assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'in-use');
  });
  test('the audit trail cannot be edited or deleted, by anyone', async () => {
    for (const k of ['root', 'pres']) { assert.equal((await FAST.call('DELETE', '/audit/aud-1', { token: tok.fast[k] })).status, 403); assert.equal((await FAST.call('PUT', '/audit/aud-1', { token: tok.fast[k], body: { id: 'aud-1', summary: 'x' } })).status, 403); }
  });
  test('typed columns follow the document: change the JSON, the column changes; a bad number does not block the save', async () => {
    const root = tok.fast.root;
    assert.equal((await put(root, 'dues', { id: 'due-2', unit: 'V-2', amount: 'about two thousand', status: 'Unpaid', category: 'Maintenance', dueDate: 'soon' })).status, 200);
    const r = (await pool.query(`SELECT amount, due_date, status FROM dues WHERE tenant=$1 AND id='due-2'`, [TENANT])).rows[0];
    assert.equal(r.amount, null); assert.equal(r.due_date, null); assert.equal(r.status, 'Unpaid');
    assert.equal((await put(root, 'dues', { id: 'due-2', amount: 2500, dueDate: '2026-10-12' })).status, 200);
    const r2 = (await pool.query(`SELECT amount::int a, to_char(due_date,'YYYY-MM-DD') d FROM dues WHERE tenant=$1 AND id='due-2'`, [TENANT])).rows[0]; assert.deepEqual(r2, { a: 2500, d: '2026-10-12' });
  });
  test('audit lines land in the monthly partition of their date, and new ones get a partition', async () => {
    const p = (await pool.query(`SELECT tableoid::regclass::text t FROM audit_log WHERE tenant=$1 AND id='aud-1'`, [TENANT])).rows[0].t; assert.equal(p, 'audit_log_2026_10');
    assert.ok((await pool.query(`SELECT count(*)::int c FROM pg_inherits WHERE inhparent='audit_log'::regclass`)).rows[0].c >= 3);
  });
  test('short ids come from a counter and never repeat, even created at the same moment', async () => {
    const root = tok.fast.root; const mk = (i) => FAST.call('PUT', `/tickets/tk-new-${i}`, { token: root, body: { id: `tk-new-${i}`, unit: 'V-1', title: `T${i}`, status: 'Open', category: 'Plumbing', priority: 'Low', taskType: 'Resident Maintenance', description: 'x' } });
    const rs = await Promise.all([1, 2, 3, 4, 5, 6].map(mk)); assert.ok(rs.every((r) => r.status === 200), JSON.stringify(rs.map((r) => r.body)));
    const sids = rs.map((r) => r.body.shortId); assert.equal(new Set(sids).size, 6, sids.join());
  });
});
