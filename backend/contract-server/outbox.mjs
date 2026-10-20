// Transactional outbox: work that must happen AFTER something was saved (receipt message, e-mail, invoice, webhook to another system) is written
// as a row in the SAME transaction as the change; a worker then delivers it, retrying with back-off, and parks it as 'Dead' after MAX attempts.
// So a crash between "payment saved" and "message sent" can never lose the message, and a down mail server never undoes a payment.
//   emit(x, topic, payload)  inside a request/transaction   |   register(topic, handler)  |   start()  the worker loop (OUTBOX_SECONDS, 0 = off)
//   OUTBOX_WEBHOOK_URL: if set, every event is also POSTed there as JSON (to feed a queue such as Kafka/RabbitMQ through a connector).
export const OUTBOX = { get seconds() { return Number(process.env.OUTBOX_SECONDS || 5); }, get maxAttempts() { return Number(process.env.OUTBOX_MAX_ATTEMPTS || 8); }, get url() { return process.env.OUTBOX_WEBHOOK_URL || ''; } };
export function createOutbox({ pool, now = () => Date.now() }) {
  const handlers = new Map();
  const register = (topic, fn) => handlers.set(topic, fn);
  const emit = (x, topic, payload) => x.q('INSERT INTO event_outbox (tenant, topic, payload) VALUES ($1,$2,$3)', [x.tenant, topic, JSON.stringify(payload || {})]);
  const backoff = (n) => Math.min(3600, 2 ** n * 5);   // seconds: 10, 20, 40 ... capped at an hour
  async function dispatch(limit = 50) {
    const c = await pool.connect(); const out = { sent: 0, retried: 0, dead: 0 };
    try {
      await c.query('BEGIN');
      const rows = (await c.query(`SELECT * FROM event_outbox WHERE status='Pending' AND next_attempt_at <= now() ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit])).rows;   // two workers never take the same row
      for (const r of rows) {
        try {
          const h = handlers.get(r.topic); if (h) await h(r);
          if (OUTBOX.url) { const res = await fetch(OUTBOX.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `outbox-${r.id}` }, body: JSON.stringify({ id: r.id, tenant: r.tenant, topic: r.topic, payload: r.payload, at: r.created_at }), signal: AbortSignal.timeout(8000) }); if (!res.ok) throw new Error(`webhook answered ${res.status}`); }
          await c.query(`UPDATE event_outbox SET status='Sent', sent_at=now(), attempts=attempts+1, last_error=NULL WHERE id=$1`, [r.id]); out.sent++;
        } catch (e) {
          const n = r.attempts + 1;
          if (n >= OUTBOX.maxAttempts) { await c.query(`UPDATE event_outbox SET status='Dead', attempts=$2, last_error=$3 WHERE id=$1`, [r.id, n, String(e.message).slice(0, 500)]); out.dead++; console.error(`[outbox] event ${r.id} (${r.topic}) gave up after ${n} attempts: ${e.message}`); }
          else { await c.query(`UPDATE event_outbox SET attempts=$2, last_error=$3, next_attempt_at=now() + ($4 || ' seconds')::interval WHERE id=$1`, [r.id, n, String(e.message).slice(0, 500), String(backoff(n))]); out.retried++; }
        }
      }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    return out;
  }
  let timer = null;
  const start = () => { if (OUTBOX.seconds > 0 && !timer) { timer = setInterval(() => dispatch().catch((e) => console.error('[outbox]', e.message)), OUTBOX.seconds * 1000); timer.unref?.(); } };
  return { emit, register, dispatch, start };
}
