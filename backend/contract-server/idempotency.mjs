// Idempotency-Key for every write: a retry (network timeout, double tap, proxy replay) gets the ORIGINAL answer and does not do the work twice.
//   same key + same request  -> the stored response is replayed (header Idempotent-Replay: true)
//   same key + other request -> 422 (a key may only ever mean one request)
//   same key while the first is still running -> 409 (try again shortly)
// Keys live 24 h (cleaned by the jobs). The row is a plain PostgreSQL unique key: no Redis needed.
import crypto from 'node:crypto';
const KEY_OK = /^[A-Za-z0-9_.:-]{8,100}$/;
export const TTL_HOURS = Number(process.env.IDEMPOTENCY_HOURS || 24);

export function createIdempotency({ pool, HttpError }) {
  async function wrap(req, res, { tenant, scope, rawBody }, handler) {
    const key = req.headers['idempotency-key'];
    if (!key || !['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) return handler();
    if (!KEY_OK.test(String(key))) throw new HttpError(400, 'Idempotency-Key must be 8-100 letters, digits or _ . : -');
    const hash = crypto.createHash('sha256').update(`${req.method} ${req.url}\n`).update(rawBody || '').digest('hex');
    const ins = await pool.query(`INSERT INTO idempotency_keys (tenant, scope, key, request_hash) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [tenant, scope, key, hash]);
    if (!ins.rowCount) {
      const row = (await pool.query('SELECT * FROM idempotency_keys WHERE tenant=$1 AND scope=$2 AND key=$3', [tenant, scope, key])).rows[0];
      if (!row) return handler();                                    // expired between the two statements: treat as new
      if (row.request_hash !== hash) throw Object.assign(new HttpError(422, 'This Idempotency-Key was already used for a different request.'), { code: 'idempotency-mismatch' });
      if (row.state !== 'Done') throw Object.assign(new HttpError(409, 'The first attempt of this request is still running. Try again in a moment.'), { code: 'in-flight' });
      res.setHeader('Idempotent-Replay', 'true');
      res.writeHead(row.response_status, { 'Content-Type': 'application/json' }); return res.end(row.response_body || '');
    }
    // capture what the handler sends
    let status = 200; const chunks = []; const wh = res.writeHead.bind(res); const end = res.end.bind(res);
    res.writeHead = (s, ...a) => { status = s; return wh(s, ...a); };
    res.end = (b, ...a) => { if (b) chunks.push(Buffer.from(b)); const keep = status < 500 && status !== 429; const body = Buffer.concat(chunks).toString();
      (keep ? pool.query(`UPDATE idempotency_keys SET state='Done', response_status=$4, response_body=$5 WHERE tenant=$1 AND scope=$2 AND key=$3`, [tenant, scope, key, status, body])
            : pool.query('DELETE FROM idempotency_keys WHERE tenant=$1 AND scope=$2 AND key=$3', [tenant, scope, key])).catch(() => {});   // a server error is not remembered: the retry runs for real
      return end(b, ...a); };
    try { return await handler(); }
    catch (e) { if (!res.headersSent) await pool.query('DELETE FROM idempotency_keys WHERE tenant=$1 AND scope=$2 AND key=$3', [tenant, scope, key]).catch(() => {}); throw e; }   // an error thrown here is answered by the caller; let a retry try again
  }
  const cleanup = () => pool.query(`DELETE FROM idempotency_keys WHERE created_at < now() - ($1 || ' hours')::interval`, [String(TTL_HOURS)]);
  return { wrap, cleanup };
}
