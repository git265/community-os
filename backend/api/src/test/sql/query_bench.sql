-- Hot queries timed as the API role (row-level security on) inside one community of the 100 x 1 000 load. Prints plan shape and time.
SELECT id AS community FROM platform.community WHERE slug = 'community-50' \gset
SELECT set_config('app.community_id', :'community', false) \gset
SELECT id AS unit FROM property.unit WHERE community_id = :'community' AND unit_no = 'Villa 777' \gset
SET ROLE cos_app;
\echo '1. a resident''s bills (newest first)'
EXPLAIN (ANALYZE, COSTS OFF, TIMING ON, SUMMARY ON) SELECT id, short_id, billed_month, total, paid_amount, status, due_date FROM billing.due WHERE unit_id = :'unit' ORDER BY due_date DESC LIMIT 50;
\echo '2. the treasurer''s open bills, oldest due first, one page'
EXPLAIN (ANALYZE, COSTS OFF, TIMING ON, SUMMARY ON) SELECT id, short_id, unit_id, total - paid_amount AS outstanding, due_date FROM billing.due WHERE status IN ('Unpaid', 'Partly paid') ORDER BY due_date, id LIMIT 50;
\echo '3. collection for the month (all 1 000 units)'
EXPLAIN (ANALYZE, COSTS OFF, TIMING ON, SUMMARY ON) SELECT count(*), sum(total), sum(paid_amount) FROM billing.due WHERE billed_month = date_trunc('month', current_date)::date;
\echo '4. a unit''s unread notifications (the bell)'
EXPLAIN (ANALYZE, COSTS OFF, TIMING ON, SUMMARY ON) SELECT id, title, link, created_at FROM comms.notification WHERE to_unit_id = :'unit' AND read_at IS NULL ORDER BY created_at DESC LIMIT 20;
\echo '5. the plumbing queue'
EXPLAIN (ANALYZE, COSTS OFF, TIMING ON, SUMMARY ON) SELECT id, short_id, unit_id, status FROM maintenance.ticket WHERE category = 'Plumbing' AND status IN ('Open', 'Assigned') ORDER BY created_at DESC LIMIT 50;
\echo '6. today''s gate entries'
EXPLAIN (ANALYZE, COSTS OFF, TIMING ON, SUMMARY ON) SELECT id, name, unit_id, state FROM gate.visit WHERE created_at >= date_trunc('day', now()) ORDER BY created_at DESC LIMIT 100;
\echo '7. a unit by its number'
EXPLAIN (ANALYZE, COSTS OFF, TIMING ON, SUMMARY ON) SELECT * FROM property.unit WHERE unit_no = 'Villa 431';
