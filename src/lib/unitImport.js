// Excel import of the unit directory: one row per unit (unit, block, type, owner, phone, ...). Built for onboarding a large
// community (thousands of units) in one go: columns are recognised by their heading, every row is checked, and the whole file is
// written in a single operation. The same checks as the Add-property form apply (owner, valid phone, tenant when tenant occupied).
import { validatePhone } from './phone.js';

export const UNIT_FIELDS = [
  ['unit', 'Unit number', true], ['zone', 'Block / tower', false], ['type', 'Property type', false], ['owner', 'Owner name', true], ['ownerPhone', 'Owner phone', true],
  ['ownerEmail', 'Owner e-mail', false], ['occupancy', 'Occupancy', false], ['tenant', 'Tenant name', false], ['tenantPhone', 'Tenant phone', false],
  ['areaSqft', 'Area (sq ft)', false], ['bedrooms', 'Bedrooms', false], ['parking', 'Parking slots', false],
];
const SYN = {
  unit: ['unit', 'unit no', 'unit number', 'flat', 'flat no', 'villa', 'villa no', 'villa number', 'house no', 'apartment', 'property'],
  zone: ['block', 'tower', 'zone', 'phase', 'wing', 'lane', 'cluster', 'building'],
  type: ['type', 'property type', 'unit type', 'kind'],
  owner: ['owner', 'owner name', 'primary owner', 'name', 'resident name', 'owner full name'],
  ownerPhone: ['owner phone', 'owner mobile', 'owner contact', 'phone', 'mobile', 'mobile no', 'contact', 'contact number', 'whatsapp'],
  ownerEmail: ['owner email', 'owner e-mail', 'email', 'e-mail', 'mail id'],
  occupancy: ['occupancy', 'occupied by', 'status', 'occupied', 'occupancy status'],
  tenant: ['tenant', 'tenant name'],
  tenantPhone: ['tenant phone', 'tenant mobile', 'tenant contact'],
  areaSqft: ['area', 'sqft', 'sq ft', 'area sqft', 'super built up', 'built up area', 'size'],
  bedrooms: ['bedrooms', 'bhk', 'beds', 'bedroom'],
  parking: ['parking', 'parking slots', 'car parking', 'parkings'],
};
const nh = (s) => String(s ?? '').toLowerCase().replace(/[._\-/\\()]+/g, ' ').replace(/\s+/g, ' ').trim();

export function autoMapUnits(headers) {
  const h = headers.map(nh); const used = new Set(); const out = {};
  for (const pass of ['exact', 'contains']) {
    for (const [f] of UNIT_FIELDS) {
      if (out[f] >= 0) continue;
      for (const syn of SYN[f]) {
        const i = h.findIndex((x, k) => !used.has(k) && x && (pass === 'exact' ? x === syn : (x.includes(syn) && syn.length > 3)));
        if (i >= 0) { out[f] = i; used.add(i); break; }
      }
    }
  }
  UNIT_FIELDS.forEach(([f]) => { if (!(out[f] >= 0)) out[f] = -1; });
  return out;
}
export function guessUnitHeaderRow(grid) {
  for (let i = 0; i < Math.min(grid.length, 15); i += 1) { const m = autoMapUnits(grid[i] || []); if (m.unit >= 0 && (m.owner >= 0 || m.ownerPhone >= 0)) return i; }
  return 0;
}

const OCC = (v, hasTenant) => {
  const t = nh(v);
  if (/vacan|empty/.test(t)) return 'Vacant';
  if (/tenant|rent|lease/.test(t)) return 'Tenant occupied';
  if (/owner|self/.test(t)) return 'Owner occupied';
  return hasTenant ? 'Tenant occupied' : 'Owner occupied';
};

/**
 * Turn the sheet into rows. `existing` = the current directory. Returns { rows, errors, news, updates } where each row is
 * { line, record, isNew } and each error { line, unit, message }.
 */
export function buildUnitRows(grid, headerRow, map, { existing = [], defaultType = 'Villa' } = {}) {
  const byUnit = new Map(existing.map((p) => [String(p.unit).trim().toLowerCase(), p]));
  const get = (r, f) => (map[f] >= 0 ? String(r[map[f]] ?? '').trim() : '');
  const rows = []; const errors = []; const seenUnit = new Set(); const phoneOwner = new Map();
  existing.forEach((p) => { const v = p.ownerPhone && validatePhone(p.ownerPhone); if (v?.ok) phoneOwner.set(v.e164, `${p.owner}|${p.unit}`); });
  for (let i = headerRow + 1; i < grid.length; i += 1) {
    const r = grid[i]; if (!r || r.every((c) => String(c ?? '').trim() === '')) continue;
    const line = i + 1; const unit = get(r, 'unit');
    const fail = (message) => errors.push({ line, unit: unit || '—', message });
    if (!unit) { fail('Unit number is missing'); continue; }
    if (seenUnit.has(unit.toLowerCase())) { fail('This unit appears twice in the file'); continue; }
    seenUnit.add(unit.toLowerCase());
    const owner = get(r, 'owner'); if (!owner) { fail('Owner name is missing'); continue; }
    const ph = validatePhone(get(r, 'ownerPhone'));
    if (!ph.ok) { fail(`Owner phone: ${ph.error}`); continue; }
    const tenant = get(r, 'tenant'); const occ = OCC(get(r, 'occupancy'), !!tenant);
    let tenantPhone = '';
    if (occ === 'Tenant occupied') {
      if (!tenant) { fail('Tenant occupied but no tenant name'); continue; }
      const tp = validatePhone(get(r, 'tenantPhone')); if (!tp.ok) { fail(`Tenant phone: ${tp.error}`); continue; }
      tenantPhone = tp.e164;
    }
    const clash = phoneOwner.get(ph.e164);
    if (clash && clash.split('|')[1].toLowerCase() !== unit.toLowerCase() && clash.split('|')[0].toLowerCase() !== owner.toLowerCase()) { fail(`Phone already belongs to ${clash.split('|')[0]} (${clash.split('|')[1]})`); continue; }
    phoneOwner.set(ph.e164, `${owner}|${unit}`);
    const num = (f) => { const v = get(r, f); return v === '' || Number.isNaN(Number(v)) ? undefined : Number(v); };
    const old = byUnit.get(unit.toLowerCase());
    const record = {
      ...(old ? { id: old.id } : {}), unit: old?.unit || unit, type: get(r, 'type') || old?.type || defaultType, zone: get(r, 'zone') || old?.zone || '', owner, ownerPhone: ph.e164,
      ownerEmail: get(r, 'ownerEmail') || old?.ownerEmail || '', occupancy: occ, tenant: occ === 'Tenant occupied' ? tenant : '', tenantPhone,
      ...(num('areaSqft') !== undefined ? { areaSqft: num('areaSqft') } : {}), ...(num('bedrooms') !== undefined ? { bedrooms: num('bedrooms') } : {}), ...(num('parking') !== undefined ? { parking: num('parking') } : {}),
      people: old?.people || [],
    };
    rows.push({ line, record, isNew: !old });
  }
  return { rows, errors, news: rows.filter((x) => x.isNew).length, updates: rows.filter((x) => !x.isNew).length };
}

export async function downloadUnitTemplate() {
  const XLSX = await import('xlsx');
  const ws = XLSX.utils.aoa_to_sheet([
    ['Unit', 'Block', 'Type', 'Owner', 'Owner phone', 'Owner email', 'Occupancy', 'Tenant', 'Tenant phone', 'Area (sq ft)', 'Bedrooms', 'Parking'],
    ['A-001', 'Lane A', 'Villa', 'Ananya Mehta', '+91 98220 10001', 'ananya@example.com', 'Owner occupied', '', '', 3200, 4, 2],
    ['B-0101', 'Tower B', 'Apartment', 'Vikram Shah', '+91 98220 10003', '', 'Tenant occupied', 'Kavita Rao', '+91 98220 10006', 1450, 3, 1],
  ]);
  ws['!cols'] = [{ wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 22 }, { wch: 18 }, { wch: 22 }, { wch: 16 }, { wch: 18 }, { wch: 18 }, { wch: 12 }, { wch: 10 }, { wch: 9 }];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Units'); XLSX.writeFile(wb, 'unit-import-template.xlsx');
}
