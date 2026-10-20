// The one place that knows where a collection lives (typed table or the generic documents table) and how to read and write it.
// Everything above it (the service layer, the open-mode routes, jobs) talks to a collection by name only.
//
//   const repo = createRepository({ q })      q(sql, args) runs on the caller's connection/transaction
//   repo.list(tenant, c)  get  put  remove  removeAll  lock  page  select  getWhere  purgeTenant
import { TYPED, ALL_TABLES } from './tables.mjs';
import { compile } from './sqlquery.mjs';

export function createRepository({ q, HttpError }) {
  const httpErr = (s, m, code) => Object.assign(new HttpError(s, m), code ? { code } : {});
  const meta = (c) => TYPED[c] || null;
  const tableOf = (c) => meta(c)?.table || 'documents';

  // a database rule that fired is a plain answer to the caller, not a server fault
  const explain = (e, c, op) => {
    if (e?.code === '23503') return op === 'delete' ? httpErr(409, 'This record is still in use by other records (bills, bookings...). Remove or reassign those first.', 'in-use')
      : httpErr(400, `That unit does not exist in this community. Add it under Properties first.`, 'unknown-unit');
    if (e?.code === '23505') return httpErr(409, 'A record with the same unique value (for example the unit) already exists.', 'duplicate');
    return e;
  };

  const list = async (t, c) => {
    const m = meta(c);
    if (!m) return (await q('SELECT data FROM documents WHERE tenant=$1 AND collection=$2 ORDER BY seq', [t, c])).rows.map((r) => r.data);
    return (await q(`SELECT data FROM ${m.table} WHERE tenant=$1 ORDER BY ${m.appendOnly ? 'at, seq' : 'seq'}`, [t])).rows.map((r) => r.data);
  };
  const get = async (t, c, id) => {
    const m = meta(c);
    const r = m ? await q(`SELECT data FROM ${m.table} WHERE tenant=$1 AND id=$2 LIMIT 1`, [t, id]) : await q('SELECT data FROM documents WHERE tenant=$1 AND collection=$2 AND id=$3', [t, c, id]);
    return r.rows[0]?.data ?? null;
  };
  const put = async (t, c, rec) => {
    const m = meta(c); const json = JSON.stringify(rec);
    try {
      if (!m) return (await q(`INSERT INTO documents (tenant, collection, id, data, updated_at) VALUES ($1,$2,$3,$4::jsonb, now())
        ON CONFLICT (tenant, collection, id) DO UPDATE SET data = documents.data || EXCLUDED.data, updated_at = now() RETURNING data`, [t, c, rec.id, json])).rows[0].data;
      if (m.appendOnly) {   // the audit trail: insert only, the columns are filled from the same record
        const at = rec.when && !Number.isNaN(Date.parse(rec.when)) ? rec.when : new Date().toISOString();
        const r = await q(`INSERT INTO audit_log (tenant, id, at, short_id, who, who_name, action, collection, record_id, record_short_id, unit, summary, ip, request_id, data)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb) ON CONFLICT (tenant, at, id) DO NOTHING RETURNING data`,
          [t, rec.id, at, rec.shortId ?? null, rec.who ?? null, rec.whoName ?? null, rec.action ?? null, rec.collection ?? null, rec.recordId ?? null, rec.recordShortId ?? null,
            rec.unit || null, typeof rec.summary === 'string' ? rec.summary.slice(0, 2000) : null, rec.ip ?? null, rec.requestId ?? null, json]);
        return r.rows[0]?.data ?? rec;
      }
      return (await q(`INSERT INTO ${m.table} (tenant, id, data, updated_at) VALUES ($1,$2,$3::jsonb, now())
        ON CONFLICT (tenant, id) DO UPDATE SET data = ${m.table}.data || EXCLUDED.data, updated_at = now() RETURNING data`, [t, rec.id, json])).rows[0].data;
    } catch (e) { throw explain(e, c, 'put'); }
  };
  const remove = async (t, c, id) => {
    const m = meta(c);
    if (m?.appendOnly) throw httpErr(403, 'The audit trail cannot be deleted.');
    try { await (m ? q(`DELETE FROM ${m.table} WHERE tenant=$1 AND id=$2`, [t, id]) : q('DELETE FROM documents WHERE tenant=$1 AND collection=$2 AND id=$3', [t, c, id])); }
    catch (e) { throw explain(e, c, 'delete'); }
  };
  const removeAll = async (t, c) => {
    const m = meta(c);
    if (m?.appendOnly) throw httpErr(403, 'The audit trail cannot be deleted.');
    try { await (m ? q(`DELETE FROM ${m.table} WHERE tenant=$1`, [t]) : q('DELETE FROM documents WHERE tenant=$1 AND collection=$2', [t, c])); }
    catch (e) { throw explain(e, c, 'delete'); }
  };
  // writers of the same record queue up here (SELECT ... FOR UPDATE), so the version check that follows sees the latest saved version
  const lock = async (t, c, ids) => {
    const m = meta(c);
    for (const id of [...new Set(ids)].filter(Boolean).sort()) await (m ? q(`SELECT 1 FROM ${m.table} WHERE tenant=$1 AND id=$2 FOR UPDATE`, [t, id]) : q('SELECT 1 FROM documents WHERE tenant=$1 AND collection=$2 AND id=$3 FOR UPDATE', [t, c, id]));
  };

  /** One page, filtered / sorted / row-scoped by the database. */
  const page = async (t, c, params, scope) => {
    const { W, args, whereArgs, order, countCap } = compile({ collection: c, tenant: t, params, scope }); const tbl = tableOf(c);
    const size = Math.min(1000, Math.max(1, Number(params.pageSize) || 50));
    // counting stops at countCap so a huge table never costs a full count; `approx` tells the screen the number is a floor
    const counted = Number((await q(`SELECT count(*) FROM (SELECT 1 FROM ${tbl} WHERE ${W} LIMIT ${countCap + 1}) s`, whereArgs)).rows[0].count);
    const approx = counted > countCap; const total = Math.min(counted, countCap);
    const pages = Math.max(1, Math.ceil(total / size)); const pg = Math.min(Math.max(1, Number(params.page) || 1), pages);
    const { rows } = await q(`SELECT data FROM ${tbl} WHERE ${W} ${order} LIMIT ${size} OFFSET ${(pg - 1) * size}`, args);
    return { rows: rows.map((r) => r.data), total, page: pg, pageSize: size, pages, ...(approx ? { approx: true } : {}) };
  };
  /** Every row the scope allows (no paging), in the collection's natural order. */
  const select = async (t, c, scope) => {
    const { W, args, order } = compile({ collection: c, tenant: t, params: {}, scope }); const tbl = tableOf(c);
    return (await q(`SELECT data FROM ${tbl} WHERE ${W} ${order}`, args)).rows.map((r) => r.data);
  };
  const getWhere = async (t, c, id, scope) => {
    const { W, args } = compile({ collection: c, tenant: t, params: {}, scope }); const tbl = tableOf(c); args.push(id);
    return (await q(`SELECT data FROM ${tbl} WHERE ${W} AND id=$${args.length} LIMIT 1`, args)).rows[0]?.data ?? null;
  };
  /** Wipes a community (admin reset): every table. */
  const purgeTenant = async (t) => { for (const tbl of [...new Set(ALL_TABLES)].reverse()) await q(`DELETE FROM ${tbl} WHERE tenant=$1`, [t]); };

  return { list, get, put, remove, removeAll, lock, page, select, getWhere, purgeTenant };
}
