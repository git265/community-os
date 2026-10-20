-- Every SQL statement of JdbcPaymentStore / JdbcEventOutboxStore / JdbcIdempotencyStore as a prepared statement, run in a rolled-back transaction.
-- Use: createdb x; psql -d x -f ../../db/V3__payments.sql -f ../../db/V4__hardening.sql; psql -d x -f this file. Any error stops it (ON_ERROR_STOP).
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO payment_orders (order_id, tenant, purpose, refs, unit, payer, payer_id, amount, currency, idempotency_key, meta, provider, provider_ref) VALUES ('ORD_1','t','due','["d1"]'::jsonb,'A','Asha','u1',1000.50,'INR','k1','{"description":"x"}'::jsonb,'simulated','sim_1');
INSERT INTO payment_orders (order_id, tenant, purpose, refs, unit, payer, payer_id, amount, currency, idempotency_key, meta, provider, provider_ref) VALUES ('ORD_2','t','booking','[]'::jsonb,'A','Asha','u1',750,'INR',NULL,'{}'::jsonb,'simulated','sim_2');
PREPARE g(text,text) AS SELECT * FROM payment_orders WHERE order_id=$1 AND tenant=$2;                          EXECUTE g('ORD_1','t');
PREPARE l(text,text) AS SELECT * FROM payment_orders WHERE order_id=$1 AND tenant=$2 FOR UPDATE;               EXECUTE l('ORD_1','t');
PREPARE lk(text,text) AS SELECT * FROM payment_orders WHERE tenant=$1 AND idempotency_key=$2 AND status IN ('Created','Pending') FOR UPDATE; EXECUTE lk('t','k1');
PREPARE pw(text,text) AS SELECT 1 FROM payment_orders WHERE tenant=$1 AND idempotency_key=$2 AND status='Paid';  EXECUTE pw('t','k1');
PREPARE ub(text,text,numeric,text) AS SELECT * FROM payment_orders WHERE tenant=$1 AND purpose='booking' AND status='Paid' AND consumed_by IS NULL AND unit=$2 AND amount=$3 AND payer_id=$4 ORDER BY paid_at DESC LIMIT 1; EXECUTE ub('t','A',750,'u1');
PREPARE ev(text,text,text) AS INSERT INTO payment_events (event_id, order_id, type) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING; EXECUTE ev('E1','ORD_1','payment.captured'); EXECUTE ev('E1','ORD_1','payment.captured');
SELECT count(*) AS events_after_duplicate FROM payment_events;
PREPARE mp(text,text,text) AS UPDATE payment_orders SET status='Paid', payment_id=$1, method=$2, paid_at=now(), updated_at=now() WHERE order_id=$3; EXECUTE mp('PAY1','UPI','ORD_1');
PREPARE mf(text,text) AS UPDATE payment_orders SET status='Failed', note=$1, updated_at=now() WHERE order_id=$2; EXECUTE mf('x','ORD_2');
PREPARE mo(text,text,text,text) AS UPDATE payment_orders SET status=$1, method=COALESCE($2, method), note=COALESCE($3, note), updated_at=now() WHERE order_id=$4 AND status IN ('Created','Pending'); EXECUTE mo('Failed',NULL,NULL,'ORD_1');
PREPARE rb(text,text) AS UPDATE payment_orders SET bank=$1::jsonb, attempts=attempts+1, updated_at=now() WHERE order_id=$2; EXECUTE rb('{"outcome":"success"}','ORD_2');
PREPARE on_(float8,int) AS SELECT * FROM payment_orders WHERE status IN ('Created','Pending') AND updated_at < now() - make_interval(secs => $1) ORDER BY created_at LIMIT $2; EXECUTE on_(0,200);
PREPARE pb(text,text) AS SELECT * FROM payment_orders WHERE tenant=$1 AND payment_id=$2 AND purpose='booking' AND status='Paid'; EXECUTE pb('t','PAY1');
PREPARE cl(text,text,text) AS UPDATE payment_orders SET consumed_by=$1 WHERE order_id=$2 AND (consumed_by IS NULL OR consumed_by=$3); EXECUTE cl('bk','ORD_2','bk');
-- outbox
PREPARE oe(text,text,text) AS INSERT INTO event_outbox (tenant, topic, payload) VALUES ($1,$2,$3::jsonb); EXECUTE oe('t','payment.settled','{"orderId":"ORD_1"}');
PREPARE od(int) AS SELECT id, tenant, topic, payload, attempts, created_at FROM event_outbox WHERE status='Pending' AND next_attempt_at <= now() ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED; EXECUTE od(50);
PREPARE os(bigint) AS UPDATE event_outbox SET status='Sent', sent_at=now(), attempts=attempts+1, last_error=NULL WHERE id=$1; EXECUTE os(1);
PREPARE orr(int,text,float8,bigint) AS UPDATE event_outbox SET attempts=$1, last_error=$2, next_attempt_at=now() + make_interval(secs => $3) WHERE id=$4; EXECUTE orr(1,'e',10,1);
PREPARE odd(int,text,bigint) AS UPDATE event_outbox SET status='Dead', attempts=$1, last_error=$2 WHERE id=$3; EXECUTE odd(3,'e',1);
SELECT status, count(*) AS n FROM event_outbox GROUP BY status;
-- idempotency
PREPARE ib(text,text,text,text) AS INSERT INTO idempotency_keys (tenant, scope, key, request_hash) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING; EXECUTE ib('t','-','key-12345678','h'); EXECUTE ib('t','-','key-12345678','h');
PREPARE ifd(text,text,text) AS SELECT request_hash, state, response_status, response_body FROM idempotency_keys WHERE tenant=$1 AND scope=$2 AND key=$3; EXECUTE ifd('t','-','key-12345678');
PREPARE ic(int,text,text,text,text) AS UPDATE idempotency_keys SET state='Done', response_status=$1, response_body=$2 WHERE tenant=$3 AND scope=$4 AND key=$5; EXECUTE ic(201,'{}','t','-','key-12345678');
PREPARE icl(int) AS DELETE FROM idempotency_keys WHERE created_at < now() - make_interval(hours => $1); EXECUTE icl(24);
PREPARE ir(text,text,text) AS DELETE FROM idempotency_keys WHERE tenant=$1 AND scope=$2 AND key=$3; EXECUTE ir('t','-','key-12345678');
ROLLBACK;
