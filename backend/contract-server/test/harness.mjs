// Test harness: starts the contract server in enforce mode on a scratch community and gives tests a tiny HTTP client.
import '../register-hooks.mjs';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import pg from 'pg';
import { TYPED, ALL_TABLES } from '../store/tables.mjs';

export const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres@localhost:5433/communityos';
export const TENANT = 'authz-test'; const DEFAULT_TENANT = TENANT;
export const rolePhone = (i) => `+91 98001 ${String(10000 + i).slice(1).padStart(5, '0')}`;
const { DEFAULT_ROLES } = await import('../../../src/lib/access/roles.js');
const id = () => crypto.randomUUID();

// helpers that know where a collection lives (typed table or documents)
export const purge = async (pool, tenant = TENANT) => { for (const t of [...ALL_TABLES].reverse()) await pool.query(`DELETE FROM ${t} WHERE tenant=$1`, [tenant]); };
export const rowOf = async (pool, c, id, tenant = TENANT) => (TYPED[c] ? (await pool.query(`SELECT data FROM ${TYPED[c].table} WHERE tenant=$1 AND id=$2`, [tenant, id])) : (await pool.query('SELECT data FROM documents WHERE tenant=$1 AND collection=$2 AND id=$3', [tenant, c, id]))).rows[0]?.data;
export const rowsOf = async (pool, c, tenant = TENANT) => (TYPED[c] ? (await pool.query(`SELECT data FROM ${TYPED[c].table} WHERE tenant=$1 ORDER BY seq`, [tenant])) : (await pool.query('SELECT data FROM documents WHERE tenant=$1 AND collection=$2 ORDER BY seq', [tenant, c]))).rows.map((r) => r.data);
export const setRow = (pool, c, id, patchJson, tenant = TENANT) => pool.query(TYPED[c] ? `UPDATE ${TYPED[c].table} SET data = data || $3::jsonb WHERE tenant=$1 AND id=$2` : `UPDATE documents SET data = data || $3::jsonb WHERE tenant=$1 AND collection='${c}' AND id=$2`, [tenant, id, JSON.stringify(patchJson)]);

export async function seedTenant(pool, TENANT = DEFAULT_TENANT) {
  await purge(pool, TENANT);
  const put = (c, r) => (TYPED[c]
    ? pool.query(`INSERT INTO ${TYPED[c].table} (tenant, id, data) VALUES ($1,$2,$3)`, [TENANT, r.id, JSON.stringify({ recVersion: 1, shortId: `${c.slice(0, 3).toUpperCase()}-${r.id.slice(0, 4)}`, ...r })])
    : pool.query('INSERT INTO documents (tenant, collection, id, data) VALUES ($1,$2,$3,$4)', [TENANT, c, r.id, JSON.stringify({ recVersion: 1, shortId: `${c.slice(0, 3).toUpperCase()}-${r.id.slice(0, 4)}`, ...r })]));
  for (const r of DEFAULT_ROLES) await put('roles', r);
  const U = (key, name, roleId, phone, units = [], extra = {}) => ({ id: `u-${key}`, name, roleId, phone, email: `${key}@example.com`, units, status: 'Active', ...extra });
  const users = [
    U('root', 'Root Admin', 'super_admin', '+91 98000 00003'), U('pres', 'Pat President', 'president', '+91 98000 00001'), U('treas', 'Tia Treasurer', 'treasurer', '+91 98000 00002'),
    U('own1', 'Olive Owner', 'owner', '+91 98000 00011', ['V-1']), U('own2', 'Omar Owner', 'owner', '+91 98000 00012', ['V-2']),
    U('guard', 'Gus Guard', 'handyman_security', '+91 98000 00021'), U('gone', 'Gina Gone', 'owner', '+91 98000 00031', ['V-3'], { status: 'Inactive' }),
    U('multi', 'Max Multi', 'owner', '+91 98000 00041', ['V-4'], { extraRoleIds: ['committee_amenities'] }),
    U('blk', 'Bea Block', 'general_secretary', '+91 98000 00051', [], { blocks: ['A'] }),
  ];
  DEFAULT_ROLES.forEach((r, i) => users.push(U(`role-${r.id}`, `Test ${r.name}`, r.id, `+91 98001 ${String(10000 + i).slice(1).padStart(5, '0')}`, r.category === 'Resident' ? ['V-1'] : [])));
  for (const u of users) await put('users', u);
  for (const u of ['V-1', 'V-2', 'V-3', 'V-4']) await put('properties', { id: `p-${u}`, unit: u, type: 'Villa', zone: u === 'V-1' || u === 'V-3' ? 'A' : 'B', owner: `Owner of ${u}`, ownerPhone: '+91 98000 09999', ownerEmail: `${u}@example.com` });
  await put('taskTypes', { id: 'tt-1', name: 'Resident Maintenance', residentVisible: true, creatorScope: 'Resident' });
  await put('ledger', { id: 'led-1', type: 'Income', amount: 500, date: '2026-10-01', unit: 'V-1', description: 'Opening' });
  await put('dues', { id: 'due-1', unit: 'V-1', amount: 1000, status: 'Unpaid', category: 'Maintenance', dueDate: '2026-10-10' });
  await put('dues', { id: 'due-2', unit: 'V-2', amount: 2000, status: 'Unpaid', category: 'Maintenance', dueDate: '2026-10-10' });
  await put('tickets', { id: 'tk-1', unit: 'V-1', title: 'Leak', status: 'Open', category: 'Plumbing', priority: 'High', taskType: 'Resident Maintenance', createdBy: 'Olive Owner', createdByRole: 'owner', description: 'Leak in kitchen' });
  await put('tickets', { id: 'tk-2', unit: 'V-2', title: 'Lamp', status: 'Open', category: 'Electrical', priority: 'Low', taskType: 'Resident Maintenance', createdBy: 'Omar Owner', createdByRole: 'owner', description: 'Lamp out' });
  return users;
}

/** Extra rows for the scope tests only (kept apart so the other suites' expectations stay simple). */
export async function seedExtras(pool, TENANT) {
  const put = (c, r) => pool.query(`INSERT INTO ${TYPED[c].table} (tenant, id, data) VALUES ($1,$2,$3)`, [TENANT, r.id, JSON.stringify({ recVersion: 1, shortId: `${c.slice(0, 3).toUpperCase()}-${r.id.slice(0, 4)}`, ...r })]);
  await put('dues', { id: 'due-3', unit: '', amount: 3000, status: 'Unpaid', category: 'Corpus', dueDate: '2026-11-10' });
  await put('dues', { id: 'due-4', unit: 'V-3', amount: 4000, status: 'Paid', category: 'Maintenance', dueDate: '2026-09-10' });
  await put('amenities', { id: 'bk-1', amenity: 'Clubhouse', unit: 'V-1', date: '2026-12-01', slot: 'Full day', status: 'Confirmed', paymentStatus: 'Paid', totalPayable: 7950, bookedBy: 'Olive Owner' });
  await put('amenities', { id: 'bk-2', amenity: 'Clubhouse', unit: 'V-2', date: '2026-12-02', slot: 'Full day', status: 'Confirmed', paymentStatus: 'Unpaid', totalPayable: 7950, bookedBy: 'Omar Owner' });
  await put('amenities', { id: 'bk-3', amenity: 'Yoga Room', unit: 'V-3', date: '2026-12-03', slot: '06:00', status: 'Confirmed', paymentStatus: 'Paid', totalPayable: 0, bookedBy: 'Gina Gone' });
  for (const [i, unit] of [['1', 'V-1'], ['2', 'V-2'], ['3', ''], ['4', 'V-3']]) await pool.query(`INSERT INTO audit_log (tenant, id, at, short_id, who, who_name, action, collection, record_id, unit, summary, data) VALUES ($1,$2,$3,$4,'Seed','Seed','Update','dues',$5,$6,'seed',$7)`,
    [TENANT, `aud-${i}`, `2026-10-0${i}T10:00:00Z`, `AUD-9000${i}`, `due-${i}`, unit || null, JSON.stringify({ id: `aud-${i}`, shortId: `AUD-9000${i}`, when: `2026-10-0${i}T10:00:00Z`, who: 'Seed', whoName: 'Seed', action: 'Update', collection: 'dues', recordId: `due-${i}`, unit, summary: 'seed', changes: [] })]);
  await put('tickets', { id: 'tk-3', unit: '', scope: 'Community', title: 'Street light', status: 'Open', category: 'Electrical', priority: 'Low', taskType: 'Resident Maintenance', createdBy: 'Pat President', createdByRole: 'president', description: 'Road lamp', location: 'Main road' });
}

export async function startServer({ port, env = {}, tenant: defaultTenant = DEFAULT_TENANT }) {
  const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, DATABASE_URL: DB, PORT: String(port), AUTH_MODE: 'enforce', OTP_DELIVERY: 'echo', OTP_RESEND_SECONDS: '0', OTP_PER_IP_HOUR: '100000', OTP_PER_PHONE_HOUR: '100000', RATE_LIMIT: 'off', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://localhost:${port}/api/health`)).ok) break; } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 250)); if (child.exitCode !== null) throw new Error(`server exited: ${log}`); }
  const base = `http://localhost:${port}/api`;
  const call = async (method, path, { token, body, tenant = defaultTenant, headers = {}, cookie } = {}) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Community-Id': tenant, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  };
  const demo = async (roleId, name, units = []) => (await call('POST', '/auth/demo', { body: { roleId, name, units } })).body?.accessToken;
  const otp = async (phone) => {   // the real sign-in: ask for a code, enter it
    const r = await call('POST', '/auth/request-code', { body: { phone } });
    if (r.status !== 200) return { r };
    const v = await call('POST', '/auth/verify', { body: { phone, code: r.body.code } });
    return { r, v, token: v.body?.accessToken, cookie: v.cookie };
  };
  return { call, demo, otp, stop: () => child.kill(), log: () => log, base };
}
export const pool = () => new pg.Pool({ connectionString: DB });
