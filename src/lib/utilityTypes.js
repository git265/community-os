// Utility types = the metered, per-unit-billed utilities (Water and DG by default; more can be added by the Super Admin).
import { storage } from './storage/index.js';
import { COLLECTIONS } from './storage/StorageAdapter.js';
import { uuid } from './uuid.js';

export const DEFAULT_UTILITY_TYPES = [
  { id: 'ut-water', name: 'Water', icon: '💧', label: 'Water', unitName: 'kL', active: true },
  { id: 'ut-dg', name: 'DG', icon: '⚡', label: 'DG (generator)', unitName: 'kWh', active: true },
];
let names = new Set(DEFAULT_UTILITY_TYPES.map((u) => u.name));
export const isUtility = (n) => names.has(n);
export const utilityNames = () => [...names];

export async function refreshUtilityNames() {
  const rows = await storage.list(COLLECTIONS.UTILITY_TYPES);
  names = new Set([...DEFAULT_UTILITY_TYPES.map((u) => u.name), ...rows.map((r) => r.name)]);
  return utilityNames();
}

/** Older communities (and new empty ones) get Water + DG as rows so they can be edited. */
export async function ensureUtilityTypes() {
  const rows = await storage.list(COLLECTIONS.UTILITY_TYPES);
  if (!rows.length) {
    const now = new Date().toISOString();
    for (const u of DEFAULT_UTILITY_TYPES) await storage.put(COLLECTIONS.UTILITY_TYPES, { ...u, id: uuid(), shortId: `UTY-${u.name === 'Water' ? '0001' : '0002'}`, recVersion: 1, recordCreatedAt: now, recordCreatedBy: 'System', lastUpdatedAt: now, lastUpdatedBy: 'System' });
    window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: COLLECTIONS.UTILITY_TYPES } }));
  }
  await syncUtilityOptions();
  return refreshUtilityNames();
}

const billName = (n) => `${n} bill`;
/** Adds `value` to a select field's options (before "Other" / "Announcement" when present). Returns true when something changed. */
async function addOption(sectionId, key, value, before = ['Other', 'Announcement']) {
  const schema = await storage.get(COLLECTIONS.SCHEMA, sectionId);
  const f = schema?.fields.find((x) => x.key === key);
  if (!f || !Array.isArray(f.options) || f.options.includes(value)) return false;
  const tail = f.options.filter((o) => before.includes(o));
  const opts = [...f.options.filter((o) => !before.includes(o)), value, ...tail];
  await storage.put(COLLECTIONS.SCHEMA, { ...schema, fields: schema.fields.map((x) => (x.key === key ? { ...x, options: opts } : x)) });
  return true;
}

/** Every utility gets its own "<Utility> bill" notice template (starter wording, editable in Utilities → Bill templates). */
export async function ensureUtilityNoticeTemplates() {
  const types = await storage.list(COLLECTIONS.UTILITY_TYPES);
  const tpls = await storage.list(COLLECTIONS.NOTICE_TEMPLATES);
  let n = tpls.reduce((m, r) => Math.max(m, Number(String(r.shortId || '').replace('NTP-', '')) || 0), 0);
  let added = false;
  for (const t of types) {
    if (t.active === false || tpls.some((x) => x.appliesTo === billName(t.name))) continue;
    const now = new Date().toISOString();
    await storage.put(COLLECTIONS.NOTICE_TEMPLATES, {
      id: uuid(), shortId: `NTP-${String(++n).padStart(4, '0')}`, recVersion: 1, name: billName(t.name), appliesTo: billName(t.name), logo: t.icon || '📊',
      headerText: `{{SOCIETY_NAME}} · ${t.label || t.name} bill`,
      body: `Dear owner of {{UNIT}},\n\n${t.label || t.name} bill for {{MONTH}}\nMeter: {{PREVIOUS_READING}} → {{CURRENT_READING}} = {{UNITS_CONSUMED}} ${t.unitName || 'units'}\nRate: ₹{{RATE}} per unit · Fixed charge ₹{{FIXED_CHARGE}} · Tax ₹{{TAX}}\nAmount payable: ₹{{AMOUNT}} by {{DUE_DATE}}.\n\nThank you,\n{{SOCIETY_NAME}} Management`,
      recordCreatedAt: now, recordCreatedBy: 'System · utilities', lastUpdatedAt: now, lastUpdatedBy: 'System · utilities',
    });
    added = true;
  }
  if (added) window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: COLLECTIONS.NOTICE_TEMPLATES } }));
}

/** Makes every utility a valid choice wherever one is picked (bill category, rate card, readings, "notice used for") and gives it a notice template. */
export async function syncUtilityOptions() {
  const types = await storage.list(COLLECTIONS.UTILITY_TYPES);
  let touched = false;
  for (const t of types) {
    for (const [sec, key, val] of [[COLLECTIONS.DUES, 'category', t.name], [COLLECTIONS.BILLING_TEMPLATES, 'type', t.name], [COLLECTIONS.READINGS, 'utility', t.name], [COLLECTIONS.NOTICE_TEMPLATES, 'appliesTo', billName(t.name)]]) {
      if (await addOption(sec, key, val)) touched = true;
    }
  }
  await ensureUtilityNoticeTemplates();
  await refreshUtilityNames();
  if (touched) window.dispatchEvent(new CustomEvent('communityos:schemas'));
}

/** A new utility must also be a valid choice wherever a utility is picked. Runs as part of the authorised "add utility" action. */
export async function addUtilityToSchemas() {
  await syncUtilityOptions();
}
