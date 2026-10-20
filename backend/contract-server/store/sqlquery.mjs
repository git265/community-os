// Turns the app's query parameters (the same shape src/lib/storage/queryEngine.js understands) and a row-scope tree into SQL.
//
// scope tree (built by src/lib/security/authz.js, language neutral so the Spring service reads the same JSON):
//   { op:'eq', key, value } | { op:'ne', key, value } | { op:'in', key, values } | { op:'empty', key } | { op:'notEmpty', key }
//   { op:'and', of:[..] } | { op:'or', of:[..] } | { op:'true' } | { op:'false' }
// `key` is a JSON field name; if the table has a real column for it (tables.mjs) that column is used, else data->>'key'.
import { TYPED, DATE_COLUMNS } from './tables.mjs';

const KEY_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const COUNT_CAP = Number(process.env.COUNT_CAP || 100000);
const like = (s) => `%${String(s).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
export class BadQuery extends Error { constructor(m) { super(m); this.status = 400; } }

export function compile({ collection, tenant, params = {}, scope = null }) {
  const meta = TYPED[collection]; const typed = !!meta;
  const args = [tenant]; const arg = (v) => { args.push(v); return `$${args.length}`; };
  const where = typed ? ['tenant=$1'] : ['tenant=$1', `collection=${arg(collection)}`];
  const textCol = (k) => meta?.text[k] || null;
  const json = (k) => { if (!KEY_RE.test(k)) throw new BadQuery(`Bad field name: ${k}`); return `(data->>${arg(k)})`; };
  const text = (k) => textCol(k) || json(k);                      // a text expression for this field
  const same = (k, v) => (textCol(k) && v !== '' ? `${textCol(k)} = ${arg(v)}` : `COALESCE(${text(k)}, '') = ${arg(v)}`);

  // ---- row scope ----
  const sc = (n) => {
    if (!n || n.op === 'true') return 'TRUE';
    switch (n.op) {
      case 'false': return 'FALSE';
      case 'eq': return n.value === '' || n.value == null ? `COALESCE(${text(n.key)}, '') = ''` : same(n.key, String(n.value));
      case 'ne': return `COALESCE(${text(n.key)}, '') <> ${arg(String(n.value ?? ''))}`;
      case 'empty': return `COALESCE(${text(n.key)}, '') = ''`;
      case 'notEmpty': return `COALESCE(${text(n.key)}, '') <> ''`;
      case 'in': { const v = (n.values || []).map(String); if (!v.length) return 'FALSE'; const c = text(n.key); const base = `${c} = ANY(${arg(v.filter((x) => x !== ''))}::text[])`; return v.includes('') ? `(${base} OR COALESCE(${c}, '') = '')` : base; }
      case 'and': return n.of.length ? `(${n.of.map(sc).join(' AND ')})` : 'TRUE';
      case 'or': return n.of.length ? `(${n.of.map(sc).join(' OR ')})` : 'FALSE';
      default: throw new BadQuery(`Unknown scope operator ${n.op}`);
    }
  };
  if (scope) where.push(sc(scope));

  // ---- filters, dates, period, search ----
  for (const [k, v] of Object.entries(params.filters || {})) {
    if (v === '' || v == null || (Array.isArray(v) && !v.length)) continue;
    const vals = (Array.isArray(v) ? v : [v]).map(String);
    if (vals.includes('__none__')) { where.push(`COALESCE(${text(k)}, '') = ''`); continue; }
    const c = text(k); where.push(textCol(k) && !vals.includes('') ? `${c} = ANY(${arg(vals)}::text[])` : `COALESCE(${c}, '') = ANY(${arg(vals)}::text[])`);
  }
  const dr = params.dateRange;
  if (dr?.key && (dr.from || dr.to)) {
    const col = meta?.sort[dr.key];
    if (col && DATE_COLUMNS.has(col)) { if (dr.from) where.push(`${col} >= ${arg(dr.from)}::date`); if (dr.to) where.push(`${col} <= ${arg(dr.to)}::date`); }
    else { const k = json(dr.key); if (dr.from) where.push(`left(${k}, 10) >= ${arg(dr.from)}`); if (dr.to) where.push(`left(${k}, 10) <= ${arg(dr.to)}`); }
  }
  const pr = params.period;
  if (pr?.key && (pr.year || pr.month)) {
    const k = json(pr.key);
    if (pr.year) where.push(`split_part(${k}, '-', 1) = ${arg(String(pr.year))}`);
    if (pr.month) where.push(`split_part(${k}, '-', 2) = ${arg(String(pr.month))}`);
  }
  if (params.search) {
    const q = arg(like(params.search)); const keys = params.searchKeys || [];
    if (keys.length) where.push(`(${keys.map((k) => `${text(k)} ILIKE ${q}`).join(' OR ')})`);
    else where.push(`EXISTS (SELECT 1 FROM jsonb_each_text(data) e WHERE jsonb_typeof(data->e.key) NOT IN ('object','array') AND e.value ILIKE ${q})`);
  }
  const W = where.join(' AND ');
  const whereArgs = args.slice();   // the count query must not carry the sort parameter

  // ---- order ----
  let order = typed && meta.appendOnly ? 'ORDER BY at, seq' : 'ORDER BY seq';
  const s = params.sort;
  if (s?.key) {
    const dir = s.dir === 'desc' ? 'DESC' : 'ASC'; const col = meta?.sort[s.key];
    if (col) order = `ORDER BY ${col} ${dir} NULLS LAST, seq`;   // ties keep their original order, like the browser's stable sort
    else {
      const v = json(s.key);   // numbers sort as numbers (and before text), everything else as text - the browser comparator does the same
      order = `ORDER BY (CASE WHEN ${v} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN 0 ELSE 1 END) ${dir}, (CASE WHEN ${v} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN ${v}::numeric END) ${dir}, ${v} ${dir}, seq`;
    }
  }
  return { W, args, whereArgs, order, countCap: COUNT_CAP };
}
