// Reads an inventory list from Excel / CSV and tags every line with the right category.
//   1. columns are matched by header name (synonyms) - the person can correct them
//   2. the category comes from the mapping rules (keywords in the item description, or the file's own category text)
//   3. units of measure are normalised (pcs / no. / each -> Nos, ltr -> Litres ...)
import { isSameName, normalize } from './fuzzy.js';
import { readWorkbook } from './files/xlsxRead.js';

export const FIELDS = [
  ['item', 'Item / description', true],
  ['category', 'Category (in the file)', false],
  ['quantity', 'Quantity', true],
  ['uom', 'Unit', false],
  ['minStock', 'Re-order level', false],
  ['location', 'Kept at / store', false],
  ['vendor', 'Supplier', false],
  ['lastRestocked', 'Last restocked / purchased', false],
  ['warrantyUntil', 'Warranty until', false],
  ['notes', 'Notes / remarks', false],
];

const SYN = {
  item: ['item', 'item name', 'item description', 'description', 'material', 'material name', 'product', 'product name', 'particulars', 'name', 'article', 'stock item'],
  category: ['category', 'item category', 'group', 'item group', 'type', 'department', 'head', 'class'],
  quantity: ['quantity', 'qty', 'stock', 'closing stock', 'current stock', 'balance', 'on hand', 'available', 'no of items', 'count', 'quantity in stock'],
  uom: ['uom', 'unit', 'units', 'unit of measure', 'measure'],
  minStock: ['min', 'min stock', 'minimum', 'minimum stock', 'reorder', 're order', 'reorder level', 're order level', 'reorder qty', 'safety stock'],
  location: ['location', 'store', 'kept at', 'stored at', 'godown', 'place', 'storage', 'room'],
  vendor: ['vendor', 'supplier', 'usual supplier', 'purchased from', 'party', 'brand'],
  lastRestocked: ['last restocked', 'last purchase', 'last purchased', 'purchase date', 'date', 'restocked on', 'received on'],
  warrantyUntil: ['warranty until', 'warranty', 'warranty expiry', 'warranty end', 'warranty till'],
  notes: ['notes', 'remarks', 'comments', 'note', 'remark'],
};

const nh = (s) => normalize(String(s ?? '')).replace(/\s+/g, ' ');

/** header row -> { field: column index } (-1 when not found). Exact synonym first, then "contains". */
export function autoMap(headers) {
  const h = headers.map(nh); const used = new Set(); const out = {};
  for (const pass of ['exact', 'contains']) {
    for (const [f] of FIELDS) {
      if (out[f] >= 0) continue;
      let idx = -1;
      for (const syn of SYN[f]) {
        idx = h.findIndex((x, i) => !used.has(i) && x && (pass === 'exact' ? x === syn : (x.includes(syn) && syn.length > 3)));
        if (idx >= 0) break;
      }
      if (idx >= 0) { out[f] = idx; used.add(idx); }
    }
  }
  FIELDS.forEach(([f]) => { if (out[f] === undefined) out[f] = -1; });
  return out;
}

/** The first row (within the first 15) that looks like a header: has an item-ish and a quantity-ish cell. */
export function guessHeaderRow(grid) {
  for (let i = 0; i < Math.min(grid.length, 15); i++) {
    const m = autoMap(grid[i] || []);
    if (m.item >= 0 && m.quantity >= 0) return i;
  }
  for (let i = 0; i < Math.min(grid.length, 15); i++) if (autoMap(grid[i] || []).item >= 0) return i;
  return 0;
}

const UOM = {
  Nos: ['nos', 'no', 'no.', 'pcs', 'pc', 'piece', 'pieces', 'each', 'ea', 'unit', 'units', 'number', 'numbers', 'qty'],
  Kg: ['kg', 'kgs', 'kilogram', 'kilograms', 'kilo', 'gm', 'g', 'gram', 'grams'],
  Litres: ['l', 'lt', 'ltr', 'ltrs', 'litre', 'litres', 'liter', 'liters'],
  Metres: ['m', 'mtr', 'mtrs', 'meter', 'meters', 'metre', 'metres', 'ft', 'feet', 'rft'],
  Boxes: ['box', 'boxes', 'pkt', 'packet', 'packets', 'carton', 'cartons', 'pack', 'packs', 'bundle', 'bundles'],
  Sets: ['set', 'sets', 'kit', 'kits', 'pair', 'pairs'],
};
export function normUom(v) {
  const t = String(v ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!t) return '';
  for (const [k, list] of Object.entries(UOM)) if (list.includes(t)) return k;
  return '';
}

/** Starter rules. Keywords are matched as whole words against the item description (plural "s" ignored). Higher priority wins; then the longer keyword. */
export const DEFAULT_RULES = [
  { name: 'Electrical items', category: 'Electrical', uom: 'Nos', priority: 50, keywords: ['bulb', 'led', 'lamp', 'tube light', 'tubelight', 'switch', 'socket', 'mcb', 'mccb', 'fuse', 'wire', 'cable', 'contactor', 'relay', 'starter', 'extension board', 'plug', 'battery', 'inverter', 'floodlight', 'street light', 'led panel', 'timer', 'capacitor', 'lug', 'cable tie', 'junction box'] },
  { name: 'Plumbing items', category: 'Plumbing', uom: 'Nos', priority: 50, keywords: ['pipe', 'tap', 'valve', 'coupling', 'elbow', 'tee', 'union', 'pvc', 'cpvc', 'upvc', 'flush', 'faucet', 'teflon', 'shower', 'plumbing', 'float', 'ball cock', 'nipple', 'reducer', 'bib cock', 'angle cock', 'hose pipe', 'water tank', 'tank', 'solvent cement'] },
  { name: 'Pumps, motors and mechanical (MEP)', category: 'MEP', uom: 'Nos', priority: 60, keywords: ['pump', 'motor', 'bearing', 'impeller', 'mechanical seal', 'belt', 'gearbox', 'compressor', 'ac gas', 'refrigerant', 'blower', 'diffuser', 'aerator', 'ahu', 'chiller', 'vfd', 'pressure gauge', 'flow meter', 'dosing', 'filter media', 'sand filter', 'membrane', 'ro membrane', 'lubricant', 'grease', 'oil seal', 'gasket'] },
  { name: 'Cleaning and housekeeping', category: 'Housekeeping', uom: 'Nos', priority: 50, keywords: ['broom', 'mop', 'phenyl', 'phenol', 'detergent', 'sanitizer', 'sanitiser', 'floor cleaner', 'dustbin', 'garbage bag', 'bin liner', 'soap', 'bleach', 'toilet cleaner', 'tissue', 'hand wash', 'handwash', 'duster', 'wiper', 'scrubber', 'glass cleaner', 'harpic', 'lizol', 'naphthalene', 'room freshener', 'cleaning', 'gloves'] },
  { name: 'Garden supplies', category: 'Gardening', uom: 'Nos', priority: 50, keywords: ['fertilizer', 'fertiliser', 'manure', 'seed', 'sapling', 'pesticide', 'insecticide', 'grass', 'trimmer', 'sprinkler', 'plant', 'soil', 'coco peat', 'cocopeat', 'compost', 'pot', 'secateur', 'shears', 'weedicide', 'drip', 'lawn', 'garden'] },
  { name: 'Carpentry and hardware', category: 'Carpentry', uom: 'Nos', priority: 50, keywords: ['plywood', 'hinge', 'screw', 'nail', 'lock', 'door', 'adhesive', 'fevicol', 'sandpaper', 'drill bit', 'bolt', 'nut', 'washer', 'handle', 'latch', 'glue', 'putty', 'paint', 'brush', 'roller', 'varnish', 'primer', 'wood'] },
  { name: 'Security items', category: 'Security', uom: 'Nos', priority: 60, keywords: ['cctv', 'camera', 'walkie', 'walkie talkie', 'torch', 'boom barrier', 'id card', 'baton', 'uniform', 'whistle', 'dvr', 'nvr', 'access card', 'rfid', 'fastag', 'metal detector', 'reflective jacket', 'raincoat', 'visitor pass'] },
  { name: 'Clubhouse and pool', category: 'Amenities', uom: 'Nos', priority: 70, keywords: ['chlorine', 'pool', 'shuttle', 'shuttlecock', 'racket', 'racquet', 'badminton', 'tennis', 'gym', 'towel', 'filter sand', 'ph tester', 'ph test', 'alum', 'soda ash', 'swimming', 'table tennis', 'tt ball', 'cricket', 'football', 'basketball', 'carrom', 'yoga mat', 'dumbbell', 'treadmill', 'sports'] },
  { name: 'Festival and cultural', category: 'Cultural', uom: 'Nos', priority: 55, keywords: ['decor', 'decoration', 'banner', 'flex', 'flower', 'garland', 'stage', 'mic', 'speaker', 'rangoli', 'lights string', 'fairy light', 'diya', 'puja', 'idol', 'tent', 'chair cover', 'festival'] },
  { name: 'Office and helpdesk', category: 'Helpdesk', uom: 'Nos', priority: 50, keywords: ['stationery', 'paper', 'a4', 'pen', 'register', 'printer', 'toner', 'cartridge', 'file', 'folder', 'stapler', 'marker', 'notebook', 'receipt book', 'stamp pad', 'envelope', 'tape', 'cello tape', 'whiteboard'] },
];

// words that should win over a rule's category only when nothing else matches
const stemW = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const words = (s) => normalize(s).split(' ').filter(Boolean).map(stemW);

function kwMatches(text, kw) {
  const k = words(kw); if (!k.length) return false;
  const w = words(text);
  for (let i = 0; i + k.length <= w.length; i++) { let ok = true; for (let j = 0; j < k.length; j++) if (w[i + j] !== k[j]) { ok = false; break; } if (ok) return true; }
  return false;
}

/**
 * Which category does this line belong to?
 * Rules matching on the file's own category text are tried first, then rules matching the item description. Returns
 * { category, uom, location, minStock, rule, keyword, how } - how: 'rule' | 'file-category' | 'none'.
 */
export function classify({ item, fileCategory }, rules, categories) {
  const active = rules.filter((r) => r.active !== false && r.category && categories.includes(r.category));
  const order = (a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0);
  const kws = (r) => (Array.isArray(r.keywords) ? r.keywords : String(r.keywords || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
  if (fileCategory) {
    for (const r of active.filter((x) => x.matchOn === 'Category column in the file').sort(order)) {
      const k = kws(r).find((kw) => kwMatches(fileCategory, kw) || nh(fileCategory) === nh(kw)); if (k) return { ...pick(r), rule: r.name, keyword: k, how: 'rule' };
    }
    const direct = categories.find((c) => nh(c) === nh(fileCategory)); if (direct) return { category: direct, rule: '', keyword: fileCategory, how: 'file-category' };
  }
  let best = null;
  for (const r of active.filter((x) => x.matchOn !== 'Category column in the file')) {
    for (const k of kws(r)) {
      if (!kwMatches(item, k)) continue;
      const score = (Number(r.priority) || 0) * 100 + words(k).length * 10 + Math.min(k.length, 9);
      if (!best || score > best.score) best = { score, r, k };
    }
  }
  if (best) return { ...pick(best.r), rule: best.r.name, keyword: best.k, how: 'rule' };
  return { category: categories.includes('General') ? 'General' : categories[0], rule: '', keyword: '', how: 'none' };
}
const pick = (r) => ({ category: r.category, uom: r.uom || '', location: r.location || '', minStock: r.minStock === undefined || r.minStock === '' ? '' : Number(r.minStock) });

const toNum = (v) => { if (v === '' || v === null || v === undefined) return 0; const n = typeof v === 'number' ? v : Number(String(v).replace(/[,₹\s]/g, '')); return Number.isFinite(n) ? n : 0; };
const iso = (v) => {
  if (v instanceof Date && !Number.isNaN(v.getTime())) { const d = new Date(v.getTime() + 12 * 3600e3); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; }
  const t = String(v ?? '').trim(); let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(t); if (m) { const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`; }
  return '';
};

/** Grid rows -> import lines, each classified and checked against the stock already in the portal. */
export function buildLines(grid, headerRow, map, { rules, categories, stock, locations = [] }) {
  const cell = (r, f) => (map[f] >= 0 ? r[map[f]] : '');
  const lines = []; let skipped = 0;
  for (const r of grid.slice(headerRow + 1)) {
    const item = String(cell(r, 'item') ?? '').replace(/\s+/g, ' ').trim();
    if (!item) { skipped++; continue; }
    const fileCategory = String(cell(r, 'category') ?? '').trim();
    const c = classify({ item, fileCategory }, rules, categories);
    const uomIn = String(cell(r, 'uom') ?? '').trim();
    const uom = normUom(uomIn) || c.uom || 'Nos';
    const locIn = String(cell(r, 'location') ?? '').trim();
    const location = locIn || c.location || 'Main store';
    const min = map.minStock >= 0 && cell(r, 'minStock') !== '' ? toNum(cell(r, 'minStock')) : (c.minStock === '' ? 0 : c.minStock);
    const existing = stock.find((s) => isSameName(item, s.item));
    lines.push({
      key: `${lines.length}-${item}`, include: true, item, category: c.category, auto: c.category, how: c.how, rule: c.rule, keyword: c.keyword, fileCategory,
      quantity: toNum(cell(r, 'quantity')), uom, minStock: min, location, vendor: String(cell(r, 'vendor') ?? '').trim(),
      lastRestocked: iso(cell(r, 'lastRestocked')), warrantyUntil: iso(cell(r, 'warrantyUntil')), notes: String(cell(r, 'notes') ?? '').trim(),
      existingId: existing?.id || '', existingQty: existing ? Number(existing.quantity) || 0 : 0, existingName: existing?.item || '',
    });
  }
  // the same item twice in the file: keep the first, flag the rest
  const seen = new Set();
  lines.forEach((l) => { const k = normalize(l.item); if (seen.has(k)) { l.include = false; l.dup = true; } seen.add(k); });
  return { lines, skipped };
}

/** A short rule keyword from an item name: drop sizes / numbers / units, keep up to 3 words. "Cable tie 200 mm" -> "cable tie". */
export function suggestKeyword(item) {
  const w = String(item).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((x) => x && !/\d/.test(x) && !/^(mm|cm|m|kg|ltr|l|w|v|amp|inch|ft|nos|pcs|set|of|for|the|and|with)$/.test(x));
  return w.slice(0, 3).join(' ');
}

export async function readInventoryFile(file) {
  const XLSX = await import('xlsx');
  const wb = await readWorkbook(await file.arrayBuffer(), { type: 'array', cellDates: true });
  return { wb, XLSX, sheets: wb.SheetNames };
}
export const sheetGrid = (XLSX, wb, name) => XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });

export async function downloadTemplate() {
  const XLSX = await import('xlsx');
  const ws = XLSX.utils.aoa_to_sheet([
    ['Item description', 'Category', 'Quantity', 'Unit', 'Re-order level', 'Kept at', 'Supplier', 'Last restocked', 'Warranty until', 'Notes'],
    ['LED bulb 9W cool white', '', 40, 'Nos', 10, 'Main store', 'Sri Ganesh Electricals', '2026-09-10', '', 'Corridor lights'],
    ['PVC pipe 1 inch', '', 25, 'Metres', 5, 'Main store', '', '', '', ''],
    ['Floor cleaner 5L', '', 6, 'Litres', 2, 'Clubhouse', '', '', '', ''],
    ['Pool chlorine tablets', '', 12, 'Kg', 4, 'Clubhouse', '', '', '', ''],
  ]);
  ws['!cols'] = [{ wch: 30 }, { wch: 14 }, { wch: 10 }, { wch: 8 }, { wch: 14 }, { wch: 14 }, { wch: 24 }, { wch: 14 }, { wch: 14 }, { wch: 24 }];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Inventory'); XLSX.writeFile(wb, 'inventory-import-template.xlsx');
}
