// MyGate -> CommunityOS migration. MyGate's admin portal lets a society download its lists as Excel / CSV; this module reads
// those files and turns them into CommunityOS records. It never talks to MyGate: no login, no API, no scraping.
//
// The exact column headings differ between MyGate versions and societies, so nothing is hard-wired: every column is
// recognised by synonyms (autoMap), the admin sees and can change the match, every row is checked, and nothing is written until
// the review step is accepted. Datasets: Daily help -> registry (+ villa links), Vehicles, Visitor log (history).
// Residents & flats go through the existing Unit import (modules/setup/UnitImport.jsx), which already knows these headings.
import { todayLocal } from '../locale.js';
import { validatePhone } from '../phone.js';
import { PERSON_CLASSES } from '../gate/constants.js';

const nh = (s) => String(s ?? '').toLowerCase().replace(/[._\-/\\()]+/g, ' ').replace(/\s+/g, ' ').trim();

// ---- value helpers ---------------------------------------------------------------------------------------
/** A phone number as MyGate exports it (often 10 digits, no country code) -> E.164, or an error. */
export function phoneFrom(raw, dial = '+91') {
  let t = String(raw ?? '').trim().replace(/\.0$/, ''); // Excel turns 9845012345 into 9845012345.0
  if (!t) return { ok: false, error: 'Phone number is missing' };
  if (!t.startsWith('+')) { const d = t.replace(/\D/g, ''); t = d.length === 10 ? `${dial}${d}` : d.length === 12 && d.startsWith('91') ? `+${d}` : d.length === 11 && d.startsWith('0') ? `${dial}${d.slice(1)}` : t; }
  return validatePhone(t);
}

const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
/** Date / time as exported: a real Date, an ISO text, or day-first text like 05/10/2026 14:32 or 5-Oct-2026 2:32 PM. -> ISO text or ''. */
export function whenFrom(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString();
  const t = String(v ?? '').trim(); if (!t) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) { const d = new Date(t); return Number.isNaN(d.getTime()) ? '' : d.toISOString(); }
  const m = /^(\d{1,2})[/\-. ]([A-Za-z]{3,9}|\d{1,2})[/\-. ](\d{2,4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/.exec(t);
  if (!m) return '';
  const day = Number(m[1]); const mon = /^\d/.test(m[2]) ? Number(m[2]) - 1 : MON[m[2].slice(0, 3).toLowerCase()];
  if (mon === undefined || Number.isNaN(mon) || mon > 11) return '';
  let yr = Number(m[3]); if (yr < 100) yr += 2000;
  let hh = Number(m[4] || 0); const mm = Number(m[5] || 0); const ss = Number(m[6] || 0);
  if (m[7]) { const pm = /p/i.test(m[7]); if (pm && hh < 12) hh += 12; if (!pm && hh === 12) hh = 0; }
  const d = new Date(yr, mon, day, hh, mm, ss);
  return Number.isNaN(d.getTime()) || d.getDate() !== day ? '' : d.toISOString();
}

export const classOfHelp = (t) => {
  const s = nh(t);
  if (/maid|cook|house ?help|housekeep|domestic|cleaner|sweeper|chef/.test(s)) return 'Maid / cook';
  if (/nanny|baby|child|caretaker|care taker|attendant|nurse|elder/.test(s)) return 'Nanny / caretaker';
  if (/driver|chauffeur/.test(s)) return 'Driver';
  if (/garden|mali|landscap/.test(s)) return 'Landscaper';
  if (/deliver|courier|rider/.test(s)) return 'Delivery rider';
  if (/labou?r|worker|plumb|electric|carpent|paint/.test(s)) return 'Daily worker';
  return PERSON_CLASSES.includes(String(t)) ? String(t) : 'Other';
};
export const kindOfVisit = (t) => {
  const s = nh(t);
  if (/deliver|courier|food|grocer|parcel|swiggy|zomato|amazon|flipkart/.test(s)) return 'Delivery';
  if (/cab|taxi|ola|uber|rapido/.test(s)) return 'Cab';
  if (/maid|cook|daily help|house ?help/.test(s)) return 'Maid / cook';
  if (/driver/.test(s)) return 'Driver';
  if (/vendor|service|contractor|plumb|electric|technician|repair/.test(s)) return 'Crew';
  if (/guest|visitor|friend|family|relative/.test(s)) return 'Guest';
  return 'Other';
};
export const normPlate = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const splitUnits = (v) => String(v ?? '').split(/[,;/\n|]+/).map((x) => x.trim()).filter(Boolean);

// ---- dataset definitions -----------------------------------------------------------------------------------
// fields: [key, label, required]; syn: heading words (checked exact first, then "contains").
export const DATASETS = {
  dailyHelp: {
    id: 'dailyHelp', label: 'Daily help & staff', note: 'Maids, cooks, drivers, nannies registered by residents in MyGate. Added to the gate registry and linked to their villas.',
    fields: [['name', 'Name', true], ['phone', 'Mobile', true], ['type', 'Kind of work', false], ['units', 'Villa(s) they work in', false], ['idLast4', 'ID number (only the last 4 digits are kept)', false], ['vehicleNo', 'Vehicle number', false]],
    syn: {
      name: ['name', 'staff name', 'daily help name', 'helper name', 'full name'], phone: ['mobile', 'mobile no', 'phone', 'contact', 'contact number', 'mobile number', 'phone number'],
      type: ['type', 'category', 'service', 'role', 'staff type', 'designation', 'work', 'kind of work', 'skill'],
      units: ['flats', 'flat', 'flat no', 'flat numbers', 'unit', 'units', 'villa', 'villa no', 'works in', 'employer flats', 'houses', 'house no'],
      idLast4: ['id number', 'aadhaar', 'aadhar', 'id proof number', 'government id'], vehicleNo: ['vehicle', 'vehicle no', 'vehicle number', 'registration no'],
    },
  },
  vehicles: {
    id: 'vehicles', label: 'Vehicles', note: 'Resident vehicles (number plates) so the gate recognises them. Plates already in the register are updated.',
    fields: [['plate', 'Number plate', true], ['unit', 'Villa / flat', false], ['owner', 'Owner / driver', false], ['fastag', 'FASTag id', false]],
    syn: {
      plate: ['vehicle number', 'vehicle no', 'registration number', 'registration no', 'reg no', 'plate', 'number plate', 'vehicle'], unit: ['flat', 'flat no', 'unit', 'villa', 'villa no', 'house no'],
      owner: ['owner', 'owner name', 'resident name', 'name'], fastag: ['fastag', 'fastag id', 'tag id'],
    },
  },
  visits: {
    id: 'visits', label: 'Visitor log (history)', note: 'Past entries kept as read-only history in Visits, so reports and "who came last year" keep working. Marked as imported.',
    fields: [['name', 'Visitor name', true], ['inAt', 'Entry time', true], ['outAt', 'Exit time', false], ['unit', 'Visiting villa / flat', false], ['kind', 'Type of visitor', false], ['purpose', 'Purpose', false], ['phone', 'Mobile', false], ['vehicle', 'Vehicle number', false], ['company', 'Company', false], ['gate', 'Gate', false]],
    syn: {
      name: ['visitor name', 'name', 'guest name'], inAt: ['entry time', 'in time', 'check in', 'checkin', 'entered at', 'entry date time', 'in', 'date time', 'visit time', 'entry'],
      outAt: ['exit time', 'out time', 'check out', 'checkout', 'exited at', 'exit date time', 'out', 'exit'], unit: ['flat', 'flat no', 'unit', 'villa', 'visiting', 'visiting flat', 'house no', 'to meet flat'],
      kind: ['visitor type', 'type', 'category', 'visit type', 'purpose type'], purpose: ['purpose', 'reason', 'remarks', 'service'], phone: ['mobile', 'phone', 'contact', 'mobile no'],
      vehicle: ['vehicle', 'vehicle no', 'vehicle number'], company: ['company', 'delivery company', 'brand', 'company name'], gate: ['gate', 'gate name', 'entry gate'],
    },
  },
};

export function autoMap(headers, ds) {
  const h = headers.map(nh); const used = new Set(); const out = {};
  for (const pass of ['exact', 'contains']) {
    for (const [f] of ds.fields) {
      if (out[f] >= 0) continue;
      for (const syn of ds.syn[f] || []) {
        const i = h.findIndex((x, k) => !used.has(k) && x && (pass === 'exact' ? x === syn : (x.includes(syn) && syn.length > 3)));
        if (i >= 0) { out[f] = i; used.add(i); break; }
      }
    }
  }
  ds.fields.forEach(([f]) => { if (!(out[f] >= 0)) out[f] = -1; });
  return out;
}
export function guessHeaderRow(grid, ds) {
  for (let i = 0; i < Math.min(grid.length, 15); i += 1) {
    const m = autoMap(grid[i] || [], ds);
    if (ds.fields.filter(([f, , req]) => req && m[f] >= 0).length === ds.fields.filter(([, , req]) => req).length) return i;
  }
  return 0;
}

// ---- row builders: (grid, headerRow, map, ctx) -> { rows, errors, warnings } ---------------------------------------
const cell = (map, r) => (f) => (map[f] >= 0 ? String(r[map[f]] ?? '').trim() : '');
const blank = (r) => !r || r.every((c) => String(c ?? '').trim() === '');

/** ctx: { dial, status, existingPeople, existingLinks, units:Set(lowercase unit numbers) } */
export function buildDailyHelp(grid, headerRow, map, ctx) {
  const rows = []; const errors = []; const warnings = []; const seen = new Set();
  const byPhone = new Map((ctx.existingPeople || []).map((p) => [String(p.phone || ''), p]));
  for (let i = headerRow + 1; i < grid.length; i += 1) {
    const r = grid[i]; if (blank(r)) continue;
    const get = cell(map, r); const line = i + 1; const name = get('name');
    const fail = (message) => errors.push({ line, who: name || '—', message });
    if (!name) { fail('Name is missing'); continue; }
    const ph = phoneFrom(get('phone'), ctx.dial); if (!ph.ok) { fail(`Mobile: ${ph.error}`); continue; }
    if (seen.has(ph.e164)) { fail('This mobile number appears twice in the file'); continue; }
    seen.add(ph.e164);
    const units = splitUnits(get('units')); const good = []; const unknown = [];
    for (const u of units) (ctx.units && ctx.units.size && !ctx.units.has(u.toLowerCase()) ? unknown : good).push(u);
    if (unknown.length) warnings.push({ line, who: name, message: `Villa not in the directory, link skipped: ${unknown.join(', ')}` });
    const digits = get('idLast4').replace(/\D/g, '');
    const old = byPhone.get(ph.e164);
    const record = old ? { id: old.id, name: old.name || name } : {
      name, phone: ph.e164, personClass: classOfHelp(get('type')), status: ctx.status,
      ...(digits.length >= 4 ? { idType: 'Aadhaar', idLast4: digits.slice(-4) } : {}),
      ...(get('vehicleNo') ? { vehicleNo: normPlate(get('vehicleNo')) } : {}),
      reviewNote: `Imported from MyGate on ${todayLocal()}. Check ID and police verification before relying on this entry.`,
    };
    const have = new Set((ctx.existingLinks || []).filter((l) => old && l.personId === old.id && l.status !== 'Ended').map((l) => String(l.unit).toLowerCase()));
    rows.push({ line, record, isNew: !old, units: good.filter((u) => !have.has(u.toLowerCase())) });
  }
  return { rows, errors, warnings };
}

export function buildVehicles(grid, headerRow, map, ctx) {
  const rows = []; const errors = []; const warnings = []; const seen = new Set();
  const byPlate = new Map((ctx.existingVehicles || []).map((v) => [normPlate(v.plate), v]));
  for (let i = headerRow + 1; i < grid.length; i += 1) {
    const r = grid[i]; if (blank(r)) continue;
    const get = cell(map, r); const line = i + 1; const plate = normPlate(get('plate'));
    const fail = (message) => errors.push({ line, who: plate || '—', message });
    if (!plate) { fail('Vehicle number is missing'); continue; }
    if (!/^[A-Z0-9]{4,12}$/.test(plate)) { fail('That does not look like a number plate'); continue; }
    if (seen.has(plate)) { fail('This vehicle appears twice in the file'); continue; }
    seen.add(plate);
    const unit = get('unit');
    if (unit && ctx.units && ctx.units.size && !ctx.units.has(unit.toLowerCase())) warnings.push({ line, who: plate, message: `Villa "${unit}" is not in the directory` });
    const old = byPlate.get(plate);
    rows.push({ line, isNew: !old, record: { ...(old ? { id: old.id } : { status: 'Active', vehicleClass: 'Resident' }), plate, unit: unit || old?.unit || '', owner: get('owner') || old?.owner || '', ...(get('fastag') ? { fastag: get('fastag') } : {}) } });
  }
  return { rows, errors, warnings };
}

export function buildVisits(grid, headerRow, map, ctx) {
  const rows = []; const errors = []; const warnings = []; const seen = new Set(ctx.existingKeys || []);
  const maskTail = (e164) => (e164 ? `••••••${e164.slice(-4)}` : '');
  for (let i = headerRow + 1; i < grid.length; i += 1) {
    const r = grid[i]; if (blank(r)) continue;
    const get = cell(map, r); const line = i + 1; const name = get('name');
    const fail = (message) => errors.push({ line, who: name || '—', message });
    if (!name) { fail('Visitor name is missing'); continue; }
    const inAt = whenFrom(r[map.inAt]); if (!inAt) { fail('Entry time is missing or not a date'); continue; }
    let outAt = map.outAt >= 0 ? whenFrom(r[map.outAt]) : '';
    if (outAt && outAt < inAt) { warnings.push({ line, who: name, message: 'Exit is before entry; exit time dropped' }); outAt = ''; }
    const unit = get('unit'); const key = `${name.toLowerCase()}|${unit.toLowerCase()}|${inAt}`;
    if (seen.has(key)) { fail('Already in the log (same name, villa and time)'); continue; }
    seen.add(key);
    const ph = get('phone') ? phoneFrom(get('phone'), ctx.dial) : { ok: false };
    rows.push({ line, isNew: true, record: {
      name, kind: kindOfVisit(get('kind') || get('purpose')), unit, gate: get('gate') || 'Main gate', purpose: get('purpose'), company: get('company'), vehicle: normPlate(get('vehicle')),
      phone: ctx.keepPhones ? (ph.ok ? ph.e164 : get('phone')) : maskTail(ph.ok ? ph.e164 : ''), state: outAt ? 'Exited' : 'Auto-closed', method: 'Imported from MyGate',
      inAt, outAt: outAt || inAt, note: 'Imported history',
    } });
  }
  return { rows, errors, warnings };
}

export const BUILDERS = { dailyHelp: buildDailyHelp, vehicles: buildVehicles, visits: buildVisits };
export const visitKey = (v) => `${String(v.name || '').toLowerCase()}|${String(v.unit || '').toLowerCase()}|${v.inAt}`;

// ---- template / export (the same column layout the importer reads, so a download can be uploaded again) --------------
export const TEMPLATE = {
  dailyHelp: [['Name', 'Mobile', 'Type', 'Flats', 'ID number'], ['Lakshmi Devi', '9845012345', 'Maid', 'A-001, A-002', ''], ['Ravi Kumar', '+91 98450 67890', 'Driver', 'B-0101', '']],
  vehicles: [['Vehicle number', 'Flat', 'Owner', 'FASTag'], ['KA 01 AB 1234', 'A-001', 'Ananya Mehta', ''], ['KA 05 MN 4321', 'B-0101', 'Vikram Shah', '']],
  visits: [['Visitor name', 'Entry time', 'Exit time', 'Flat', 'Type', 'Purpose', 'Mobile', 'Vehicle', 'Company'], ['Suresh', '05/10/2026 14:32', '05/10/2026 15:10', 'A-001', 'Guest', 'Family visit', '9845011111', '', '']],
};
export function exportGrid(id, { people = [], links = [], vehicles = [], visits = [] }) {
  if (id === 'dailyHelp') return [TEMPLATE.dailyHelp[0], ...people.map((p) => [p.name, p.phone, p.personClass, links.filter((l) => l.personId === p.id && l.status !== 'Ended').map((l) => l.unit).join(', '), p.idLast4 ? `XXXX${p.idLast4}` : ''])];
  if (id === 'vehicles') return [TEMPLATE.vehicles[0], ...vehicles.map((v) => [v.plate, v.unit, v.owner, v.fastag || ''])];
  return [TEMPLATE.visits[0], ...visits.map((v) => [v.name, v.inAt, v.outAt, v.unit, v.kind, v.purpose, v.phone, v.vehicle, v.company])];
}
