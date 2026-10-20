// The platform console's server side (AUTH_MODE=enforce): list the communities, create a new one, suspend / re-activate one.
//
//   GET   /api/platform/communities                 the registry
//   POST  /api/platform/communities                 { name, slug, address, unitTypes, demoData, adminName, adminEmail, adminPhone }
//   PATCH /api/platform/communities/{slug}          { status: 'Active' | 'Suspended' }
//
// The caller is the operator of the platform, not a member of a community: every call carries X-Platform-Key = PLATFORM_ADMIN_KEY
// (a long random secret set on the server; without it these calls are refused). A new community is written in ONE transaction:
// its registry row, its starting data (the same defaults the browser console writes: roles, task types, templates ... or the demo data)
// and its first Super Admin, who then signs in with the phone number given here.
import crypto from 'node:crypto';

export async function createPlatform({ pool, svc, srcDir, HttpError }) {
  const KEY = process.env.PLATFORM_ADMIN_KEY || '';
  const here = (p) => new URL(p, srcDir).href;
  const registry = await import(here('lib/platform/registry.js'));
  const seed = await import(here('lib/seed/seedData.js'));
  const { storage, COLLECTIONS: C } = await import(here('lib/storage/index.js'));
  const { DEFAULT_ROLES } = await import(here('lib/access/roles.js'));
  const { validatePhone } = await import(here('lib/phone.js'));
  const { logChange } = await import(here('lib/audit/auditLog.js'));
  const WHO = 'Platform admin';

  function check(req) {
    if (KEY.length < 16) throw new HttpError(403, 'The platform console is switched off on this server: set PLATFORM_ADMIN_KEY (16 characters or more).');
    const got = Buffer.from(String(req.headers['x-platform-key'] || ''));
    const want = Buffer.from(KEY);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw Object.assign(new HttpError(401, 'Wrong or missing platform key.'), { code: 'platform-key' });
  }
  const bad = (errors) => Object.assign(new HttpError(400, Object.values(errors)[0]), { errors, code: 'invalid' });

  /** The registry, each with the number of people who can sign in to it (never their names: the platform does not see a community's data). */
  async function list() {
    const rows = await svc.runSystem('platform', WHO, {}, async () => storage.list(C.COMMUNITIES));
    const counts = new Map((await pool.query("SELECT tenant, count(*)::int AS n FROM users WHERE coalesce(status, '') <> 'Inactive' GROUP BY tenant")).rows.map((r) => [r.tenant, r.n]));
    return rows.map((c) => ({ ...c, people: counts.get(c.slug) || 0 })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  async function create(v) {
    const slug = String(v?.slug || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(slug)) throw bad({ slug: 'Use 3–30 letters, numbers or hyphens (no spaces)' });
    return svc.runSystem(slug, WHO, { write: true }, async () => {
      const existing = await storage.list(C.COMMUNITIES);
      const errors = registry.validateNewCommunity(v, existing);
      const phone = validatePhone(v.adminPhone);   // the first Super Admin signs in with a one-time code sent to this number
      if (!phone.ok) errors.adminPhone = String(v.adminPhone || '').trim() ? phone.error : 'The first Super Admin signs in with this phone number: it is required';
      if (Object.keys(errors).length) throw bad(errors);
      if ((await storage.list(C.USERS)).length) throw new HttpError(409, 'That web address already holds a community\'s data. Pick another address.');
      const community = {
        id: slug, slug, name: v.name.trim(), address: String(v.address || '').trim(), unitTypes: registry.UNIT_TYPES.includes(v.unitTypes) ? v.unitTypes : registry.UNIT_TYPES[0],
        status: 'Active', demoData: !!v.demoData, createdAt: new Date().toISOString().slice(0, 10), createdBy: WHO,
      };
      await storage.put(C.COMMUNITIES, community);
      const source = await seed.provisionSource(community, { name: v.adminName.trim(), email: v.adminEmail, phone: phone.e164 });
      // seedCommunity keeps one run per store object: give this request its own
      const store = new Proxy({}, { get: (_, m) => (...a) => storage[m](...a) });
      await seed.seedCommunity(store, source);
      if ((await storage.list(C.ROLES)).length === 0) for (const r of DEFAULT_ROLES) await storage.put(C.ROLES, r);
      await logChange({ who: WHO, whoName: WHO, what: 'Communities', collection: C.COMMUNITIES, recordId: slug, recordShortId: slug, unit: '', action: 'Create',
        summary: `${community.name} (${slug}) created${community.demoData ? ' with the demo data' : ''}; first Super Admin ${v.adminName.trim()} (${phone.formatted})`, changes: [] });
      return { community };
    });
  }

  async function setStatus(slug, status) {
    if (!['Active', 'Suspended'].includes(status)) throw bad({ status: 'Status is Active or Suspended' });
    return svc.runSystem('platform', WHO, { write: true }, async () => {
      const c = (await storage.list(C.COMMUNITIES)).find((r) => r.slug === slug);
      if (!c) throw new HttpError(404, 'No such community.');
      const out = { ...c, status };
      await storage.put(C.COMMUNITIES, out);
      await logChange({ who: WHO, whoName: WHO, what: 'Communities', collection: C.COMMUNITIES, recordId: slug, recordShortId: slug, unit: '', action: 'Update', summary: `${c.name}: status ${c.status} → ${status}`,
        changes: [{ field: 'status', label: 'Status', from: c.status, to: status }] });
      return out;
    });
  }

  async function route(req, parts, body) {
    check(req);
    if (parts[1] !== 'communities') throw new HttpError(404, 'Not found.');
    if (!parts[2] && req.method === 'GET') return list();
    if (!parts[2] && req.method === 'POST') return create(await body());
    if (parts[2] && req.method === 'PATCH') return setStatus(parts[2], (await body())?.status);
    throw new HttpError(405, 'Not supported.');
  }
  return { route, list, create, setStatus, enabled: KEY.length >= 16 };
}
