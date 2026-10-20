// Pure helpers for the daily plant logs (Bhagiratha supply, WTP / STP treated-water meters, salt and chlorine stock).
// Kept free of React so the rules are easy to test and to move to the server later.

export const BH_FACTOR = 10; // the Bhagiratha meter dial is in 10 KL units: KL = (closing - opening) x 10
export const METERS = [
  { id: 'bh', label: 'Bhagiratha', open: 'bhOpen', close: 'bhClose', kl: 'bhKl', factor: BH_FACTOR, color: '#2563eb' },
  { id: 'wtp', label: 'WTP treated', open: 'wtpOpen', close: 'wtpClose', kl: 'wtpKl', factor: 1, color: '#059669' },
  { id: 'stp', label: 'STP treated', open: 'stpOpen', close: 'stpClose', kl: 'stpKl', factor: 1, color: '#ea580c' },
];

const has = (v) => v !== '' && v != null && !Number.isNaN(Number(v));
export const monthOfDate = (d) => String(d || '').slice(0, 7);

/** KL for one meter on one day: the stored figure, else worked out from the two readings. */
export function klOf(row, m) {
  if (!row) return null;
  if (has(row[m.kl])) return Number(row[m.kl]);
  if (has(row[m.open]) && has(row[m.close])) return (Number(row[m.close]) - Number(row[m.open])) * m.factor;
  return null;
}

/** Fill in the derived KL fields on a draft (used by the entry dialog and the importer). */
export function withKl(row) {
  const out = { ...row };
  METERS.forEach((m) => { if (has(out[m.open]) && has(out[m.close])) out[m.kl] = Math.round((Number(out[m.close]) - Number(out[m.open])) * m.factor * 100) / 100; else delete out[m.kl]; });
  return out;
}

export function validate(row) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row.date || ''))) return 'Choose the log date.';
  for (const m of METERS) {
    const a = row[m.open]; const b = row[m.close];
    if (has(a) !== has(b)) return `${m.label}: enter both the opening and the closing reading, or leave both empty.`;
    if (has(a) && Number(b) < Number(a)) return `${m.label}: the closing reading (${b}) is lower than the opening (${a}).`;
    if (has(a) && Number(a) < 0) return `${m.label}: readings cannot be negative.`;
  }
  for (const k of ['saltStock', 'saltUsed', 'chlorineStock', 'chlorineUsed']) if (has(row[k]) && Number(row[k]) < 0) return 'Stock and use cannot be negative.';
  if (has(row.saltUsed) && has(row.saltStock) && Number(row.saltUsed) > Number(row.saltStock)) return `Salt used (${row.saltUsed} kg) is more than the stock (${row.saltStock} kg).`;
  if (has(row.chlorineUsed) && has(row.chlorineStock) && Number(row.chlorineUsed) > Number(row.chlorineStock)) return `Chlorine used (${row.chlorineUsed} L) is more than the stock (${row.chlorineStock} L).`;
  const any = METERS.some((m) => has(row[m.open])) || ['saltStock', 'saltUsed', 'chlorineStock', 'chlorineUsed'].some((k) => has(row[k]));
  return any ? '' : 'Enter at least one reading for the day.';
}

const byDate = (rows) => [...rows].sort((a, b) => (a.date < b.date ? -1 : 1));

/** The previous log (before `date`) that has a given field, for pre-filling the opening reading. */
export function previousWith(rows, date, field) {
  return byDate(rows).filter((r) => r.date < date && has(r[field])).pop() || null;
}

/** Suggested opening values for a new day: yesterday's closing reading, and the stock left after yesterday's use. */
export function suggestOpening(rows, date) {
  const out = {};
  METERS.forEach((m) => { const p = previousWith(rows, date, m.close); if (p) out[m.open] = Number(p[m.close]); });
  const s = previousWith(rows, date, 'saltStock'); if (s) out.saltStock = Math.max(0, Number(s.saltStock) - Number(s.saltUsed || 0));
  const c = previousWith(rows, date, 'chlorineStock'); if (c) out.chlorineStock = Math.max(0, Number(c.chlorineStock) - Number(c.chlorineUsed || 0));
  return out;
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };

/** Flags for one month: readings that jump (opening differs from the previous closing), days far from the usual, and missing days. */
export function checks(rows, month) {
  const sorted = byDate(rows);
  const flags = [];
  METERS.forEach((m) => {
    // one pass over all logs (10 years = ~3,650 rows) to find each day's previous closing reading
    const prevOf = new Map(); let last = null;
    for (const x of sorted) { prevOf.set(x.id, last); if (has(x[m.close])) last = x; }
    const inMonth = sorted.filter((r) => monthOfDate(r.date) === month && klOf(r, m) != null);
    const vals = inMonth.map((r) => klOf(r, m));
    const med = median(vals);
    inMonth.forEach((r) => {
      const v = klOf(r, m);
      if (med > 0 && vals.length >= 5 && (v < med * 0.5 || v > med * 1.6)) flags.push({ date: r.date, meter: m.id, kind: 'outlier', text: `${m.label} ${Math.round(v)} KL on ${r.date.slice(8)}/${r.date.slice(5, 7)} is far from the usual ~${Math.round(med)} KL.` });
      const prev = prevOf.get(r.id);
      if (prev && has(r[m.open]) && Number(r[m.open]) !== Number(prev[m.close])) flags.push({ date: r.date, meter: m.id, kind: 'gap', text: `${m.label} opening ${r[m.open]} on ${r.date.slice(8)}/${r.date.slice(5, 7)} differs from the previous closing ${prev[m.close]}.` });
    });
    if (inMonth.length) {
      const [y, mo] = month.split('-').map(Number);
      const days = new Date(y, mo, 0).getDate();
      const last = Math.min(days, Number(inMonth[inMonth.length - 1].date.slice(8)));
      const have = new Set(inMonth.map((r) => Number(r.date.slice(8))));
      const miss = []; for (let d = 1; d <= last; d++) if (!have.has(d)) miss.push(d);
      if (miss.length) flags.push({ date: '', meter: m.id, kind: 'missing', text: `${m.label}: no reading for ${miss.length > 4 ? `${miss.length} days (${miss.slice(0, 4).join(', ')}…)` : `day${miss.length > 1 ? 's' : ''} ${miss.join(', ')}`}.` });
    }
  });
  return flags;
}

/** Stock position of salt and chlorine: latest stock after use, average daily use, days left and every restock seen. */
export function stockOf(rows, kind) {
  const f = kind === 'salt' ? { stock: 'saltStock', used: 'saltUsed', unit: 'kg', label: 'Salt' } : { stock: 'chlorineStock', used: 'chlorineUsed', unit: 'L', label: 'Chlorine' };
  const list = byDate(rows).filter((r) => has(r[f.stock]));
  if (!list.length) return { ...f, left: null, daily: null, days: null, restocks: [], date: '' };
  const restocks = [];
  for (let i = 1; i < list.length; i++) {
    const expected = Number(list[i - 1][f.stock]) - Number(list[i - 1][f.used] || 0);
    const got = Number(list[i][f.stock]) - expected;
    if (got > Math.max(1, expected * 0.1)) restocks.push({ date: list[i].date, qty: Math.round(got * 10) / 10 });
  }
  const last = list[list.length - 1];
  const left = Math.max(0, Number(last[f.stock]) - Number(last[f.used] || 0));
  const recent = list.slice(-14).filter((r) => has(r[f.used]));
  const daily = recent.length ? recent.reduce((s, r) => s + Number(r[f.used]), 0) / recent.length : null;
  return { ...f, left, daily, days: daily > 0 ? Math.floor(left / daily) : null, restocks, date: last.date };
}

export function monthTotals(rows, month) {
  const r = rows.filter((x) => monthOfDate(x.date) === month);
  const sum = (k) => r.reduce((s, x) => s + (has(x[k]) ? Number(x[k]) : 0), 0);
  const kl = (m) => r.reduce((s, x) => s + (klOf(x, m) || 0), 0);
  const bh = kl(METERS[0]); const wtp = kl(METERS[1]); const stp = kl(METERS[2]);
  return { days: r.length, bh, wtp, stp, stpPct: wtp > 0 ? (stp / wtp) * 100 : null, salt: sum('saltUsed'), chlorine: sum('chlorineUsed'),
    hasMeters: r.some((x) => METERS.some((m) => klOf(x, m) != null)), hasChem: r.some((x) => has(x.saltUsed) || has(x.chlorineUsed)) };
}

/** Header names in a sheet -> field, for the importer. Sheet name decides the meter. */
export function parseWorkbook(XLSX, wb) {
  const rows = {};
  const iso = (v) => {
    if (v instanceof Date) { const d = new Date(v.getTime() + 12 * 3600e3); return d.toISOString().slice(0, 10); }
    const t = String(v ?? '').trim(); return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : '';
  };
  const get = (d) => (rows[d] ||= { date: d });
  const used = [];
  wb.SheetNames.forEach((name) => {
    const n = name.toLowerCase();
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, cellDates: true, defval: null });
    const hi = grid.findIndex((r) => r.some((c) => /^date$/i.test(String(c ?? '').trim())));
    if (hi < 0) return;
    const head = grid[hi].map((c) => String(c ?? '').toLowerCase().trim());
    const di = head.findIndex((h) => h === 'date');
    const col = (re) => head.findIndex((h) => re.test(h));
    let count = 0;
    const each = (fn) => grid.slice(hi + 1).forEach((r) => { const d = iso(r[di]); if (d) { fn(get(d), r); count++; } });
    const num = (v) => (has(v) ? Number(v) : undefined);
    if (n.includes('bhagirath')) {
      const o = col(/^opening/); const c = col(/^closing/);
      each((x, r) => { x.bhOpen = num(r[o]); x.bhClose = num(r[c]); });
    } else if (n.includes('wtp') || n.includes('stp')) {
      const k = n.includes('wtp') ? 'wtp' : 'stp';
      const o = col(/initial|opening/); const c = col(/final|closing/);
      each((x, r) => { x[`${k}Open`] = num(r[o]); x[`${k}Close`] = num(r[c]); });
    } else if (n.includes('salt') || n.includes('chlorine')) {
      const ss = col(/salt stock/); const su = col(/salt use/); const cs = col(/chlorine stock/); const cu = col(/chlorine use/);
      each((x, r) => { x.saltStock = num(r[ss]); x.saltUsed = num(r[su]); x.chlorineStock = num(r[cs]); x.chlorineUsed = num(r[cu]); });
    } else return;
    used.push(`${name} (${count} days)`);
  });
  const list = Object.values(rows).map((r) => withKl(Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)))).filter((r) => !validate(r)).sort((a, b) => (a.date < b.date ? -1 : 1));
  return { rows: list, used };
}
