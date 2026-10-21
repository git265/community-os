// Shared query semantics used by every adapter. SessionStorageAdapter runs it
// in the browser; the Spring Boot backend implements the SAME parameters in
// SQL where it can (see V2ApiAdapter serverPage), so every table in
// the app is "server-side" by contract: it only ever asks for one page.
//
// params = {
//   page: 1, pageSize: 50,
//   sort: { key, dir: 'asc'|'desc' },
//   filters: { field: value | [values] },         // exact match(es)
//   search: 'text', searchKeys: ['a','b'],         // contains, case-insensitive
//   dateRange: { key, from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
// }
export const DEFAULT_PAGE_SIZE = 50;

function cmp(a, b) {
  const an = Number(a), bn = Number(b);
  if (a !== '' && b !== '' && a != null && b != null && !isNaN(an) && !isNaN(bn)) return an - bn;
  const ad = Date.parse(a), bd = Date.parse(b);
  if (typeof a === 'string' && typeof b === 'string' && /\d{4}-\d{2}-\d{2}/.test(a) && !isNaN(ad) && !isNaN(bd)) return ad - bd;
  return String(a ?? '').localeCompare(String(b ?? ''));
}

export function runQuery(rows, params = {}) {
  const { page = 1, pageSize = DEFAULT_PAGE_SIZE, sort, filters = {}, search = '', searchKeys, dateRange, period } = params;
  let out = rows;
  // period: { key, year, month } on a 'YYYY-MM' text field - filter by year and/or calendar month
  if (period?.key && (period.year || period.month)) {
    out = out.filter((r) => {
      const [y = '', m = ''] = String(r[period.key] ?? '').split('-');
      return (!period.year || y === String(period.year)) && (!period.month || m === String(period.month));
    });
  }
  for (const [k, v] of Object.entries(filters)) {
    if (v === '__none__' || (Array.isArray(v) && v.includes('__none__'))) { out = out.filter((r) => !r[k]); continue; } // "not set" (the wire form sends a list)
    if (v === '' || v == null || (Array.isArray(v) && v.length === 0)) continue;
    out = out.filter((r) => (Array.isArray(v) ? v.map(String).includes(String(r[k] ?? '')) : String(r[k] ?? '') === String(v)));
  }
  if (dateRange?.key && (dateRange.from || dateRange.to)) {
    const from = dateRange.from ? new Date(`${dateRange.from}T00:00:00`).getTime() : -Infinity;
    const to = dateRange.to ? new Date(`${dateRange.to}T23:59:59.999`).getTime() : Infinity;
    out = out.filter((r) => {
      const raw = String(r[dateRange.key] ?? '');
      // a plain yyyy-mm-dd is a calendar day: read it in the same (local) time as the range ends, not as UTC midnight
      const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T12:00:00` : raw);
      return !isNaN(t) && t >= from && t <= to;
    });
  }
  if (search) {
    const q = search.toLowerCase();
    out = out.filter((r) =>
      (searchKeys?.length ? searchKeys.map((k) => r[k]) : Object.values(r)).some((v) => typeof v !== 'object' && String(v ?? '').toLowerCase().includes(q))
    );
  }
  if (sort?.key) {
    const dir = sort.dir === 'desc' ? -1 : 1;
    out = [...out].sort((a, b) => dir * cmp(a[sort.key], b[sort.key]));
  }
  const total = out.length;
  const size = Math.max(1, pageSize);
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(1, page), pages);
  return { rows: out.slice((p - 1) * size, p * size), total, page: p, pageSize: size, pages };
}
