// The starting data of a new community, for the Spring service (resources/rulebook/new-community.json): exactly what the platform console
// writes in the browser and on the Node server (seedData.js provisionSource + seedCommunity, and the default roles), with placeholders the
// Java fills in: __COMMUNITY_NAME__, __ADMIN_NAME__, __ADMIN_EMAIL__, __ADMIN_PHONE__ and the time __NOW__.
//
//   node --import ./register-hooks.mjs test/gen-new-community.mjs     (from backend/contract-server; or: npm run gen:new-community)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NOW = '2000-01-01T00:00:00.000Z';
const RealDate = Date;
globalThis.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return RealDate.parse(NOW); } };
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../../../src/lib');
const OUT = path.resolve(here, '../../spring/src/main/resources/rulebook/new-community.json');
const seed = await import(path.join(SRC, 'seed/seedData.js'));
const { DEFAULT_ROLES } = await import(path.join(SRC, 'access/roles.js'));

const rows = {};
const store = { list: async (c) => rows[c] || [], replaceAll: async (c, list) => { rows[c] = list; }, put: async (c, r) => { (rows[c] ||= []).push(r); } };
const source = await seed.provisionSource({ slug: 'x', name: '__COMMUNITY_NAME__', demoData: false }, { name: '__ADMIN_NAME__', email: '__ADMIN_EMAIL__', phone: '__ADMIN_PHONE__' });
await seed.seedCommunity(store, source);
if (!(rows.roles || []).length) rows.roles = DEFAULT_ROLES.map((r) => ({ ...r }));
const text = JSON.stringify(rows, null, 0).replaceAll(NOW, '__NOW__').replaceAll('__admin_email__', '__ADMIN_EMAIL__');
fs.writeFileSync(OUT, text);
console.log(`${Object.keys(rows).length} collections, ${Object.values(rows).reduce((n, l) => n + l.length, 0)} rows, ${text.length} bytes -> ${path.relative(process.cwd(), OUT)}`);
