-- Database-level tests for the v2 schema: run as the API role (cos_app), so row-level security and grants are really exercised.
--   psql -d cos_v2 -v ON_ERROR_STOP=1 -f src/test/sql/schema_tests.sql      (tools/test-schema.sh does migrate + run)
-- Each test is a DO block that RAISEs on failure; the last line prints the number of tests passed.
\set QUIET on
CREATE SCHEMA IF NOT EXISTS test;
CREATE TABLE IF NOT EXISTS test.result (name text PRIMARY KEY, ok boolean NOT NULL, detail text);
TRUNCATE test.result;
GRANT USAGE ON SCHEMA test TO cos_app, cos_platform; GRANT ALL ON test.result TO cos_app, cos_platform;

-- expect_error(sql, sqlstate): runs sql and passes only if it fails with that SQLSTATE (or any error when sqlstate is NULL)
CREATE OR REPLACE FUNCTION test.expect_error(q text, want text DEFAULT NULL) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE q; EXCEPTION WHEN others THEN
    IF want IS NULL OR SQLSTATE = want THEN RETURN 'ok: ' || SQLSTATE; END IF;
    RAISE EXCEPTION 'expected % but got % (%)', want, SQLSTATE, SQLERRM;
  END;
  RAISE EXCEPTION 'expected an error from: %', q;
END $$;
CREATE OR REPLACE FUNCTION test.pass(n text, d text DEFAULT '') RETURNS void LANGUAGE sql AS $$ INSERT INTO test.result VALUES (n, true, d) ON CONFLICT (name) DO UPDATE SET ok = true, detail = EXCLUDED.detail $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA test TO cos_app, cos_platform;

-- ---- fixtures (as the owner): two communities, provisioned with default roles, a unit and a member each ------------------------------------------
DELETE FROM platform.community WHERE slug IN ('test-a', 'test-b');
INSERT INTO platform.community (id, slug, name) VALUES ('00000000-0000-0000-0000-00000000000a', 'test-a', 'Test A'), ('00000000-0000-0000-0000-00000000000b', 'test-b', 'Test B');
SELECT platform.provision_community('00000000-0000-0000-0000-00000000000a');
SELECT platform.provision_community('00000000-0000-0000-0000-00000000000b');
INSERT INTO identity.person (id, phone_e164, full_name) VALUES ('00000000-0000-0000-0000-0000000000f1', '+919800000011', 'Olive Owner'), ('00000000-0000-0000-0000-0000000000f2', '+919800000012', 'Omar Owner')
  ON CONFLICT DO NOTHING;
SELECT set_config('app.community_id', '00000000-0000-0000-0000-00000000000a', false);
INSERT INTO identity.membership (community_id, id, person_id, display_name) VALUES ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f1', 'Olive Owner');
INSERT INTO property.unit (community_id, id, unit_no, unit_type) VALUES ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000c1', 'Villa 1', 'Villa');
SELECT set_config('app.community_id', '00000000-0000-0000-0000-00000000000b', false);
INSERT INTO identity.membership (community_id, id, person_id, display_name) VALUES ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000f2', 'Omar Owner');
INSERT INTO property.unit (community_id, id, unit_no, unit_type) VALUES ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000c2', 'Villa 1', 'Villa');
RESET app.community_id;

-- ---- 1. every tenant table is protected -------------------------------------------------------------------------------------------------------
DO $$ DECLARE missing text; BEGIN
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ') INTO missing
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = ANY (platform.tenant_schemas()) AND c.relkind IN ('r', 'p') AND NOT c.relispartition
    AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'community_id')
    AND NOT (n.nspname = 'platform' AND c.relname = 'short_id_counter')
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid));
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'tables without forced RLS + policy: %', missing; END IF;
  PERFORM test.pass('every tenant table has forced row-level security and a policy');
END $$;
DO $$ DECLARE missing text; BEGIN
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ') INTO missing
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = ANY (platform.tenant_schemas()) AND c.relkind IN ('r', 'p') AND NOT c.relispartition
    AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'updated_by')
    AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'stamp_row');
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'tables whose audit columns are not stamped: %', missing; END IF;
  PERFORM test.pass('every table with audit columns has the stamping trigger');
END $$;

SET ROLE cos_app;

-- ---- 2. isolation ---------------------------------------------------------------------------------------------------------------------------------
DO $$ DECLARE n int; BEGIN
  PERFORM set_config('app.community_id', '', true);
  SELECT count(*) INTO n FROM property.unit; IF n <> 0 THEN RAISE EXCEPTION 'no context, yet % units visible', n; END IF;
  PERFORM set_config('app.community_id', '00000000-0000-0000-0000-00000000000a', true);
  SELECT count(*) INTO n FROM property.unit; IF n <> 1 THEN RAISE EXCEPTION 'community A sees % units', n; END IF;
  SELECT count(*) INTO n FROM identity.membership; IF n <> 1 THEN RAISE EXCEPTION 'community A sees % memberships', n; END IF;
  SELECT count(*) INTO n FROM identity.person; IF n <> 1 THEN RAISE EXCEPTION 'community A sees % people', n; END IF;
  SELECT count(*) INTO n FROM platform.community; IF n <> 1 THEN RAISE EXCEPTION 'community A sees % communities', n; END IF;
  SELECT count(*) INTO n FROM identity.role; IF n <> 18 THEN RAISE EXCEPTION 'community A sees % roles (expected its own 18)', n; END IF;
  PERFORM test.pass('a community sees only its own rows; no context sees nothing');
END $$;
DO $$ BEGIN
  PERFORM set_config('app.community_id', '00000000-0000-0000-0000-00000000000a', true);
  PERFORM test.expect_error($q$INSERT INTO property.unit (community_id, unit_no, unit_type) VALUES ('00000000-0000-0000-0000-00000000000b', 'Villa 9', 'Villa')$q$, '42501');
  UPDATE property.unit SET community_id = '00000000-0000-0000-0000-00000000000b' WHERE unit_no = 'Villa 1';   -- the trigger keeps the stored community
  IF NOT EXISTS (SELECT 1 FROM property.unit WHERE unit_no = 'Villa 1' AND community_id = '00000000-0000-0000-0000-00000000000a') THEN RAISE EXCEPTION 'the unit left community A'; END IF;
  PERFORM test.pass('a row cannot be written into, or moved to, another community');
END $$;
DO $$ DECLARE n int; BEGIN
  PERFORM set_config('app.community_id', '00000000-0000-0000-0000-00000000000a', true);
  UPDATE property.unit SET occupancy = 'Vacant' WHERE id = '00000000-0000-0000-0000-0000000000c2';   -- community B's unit
  GET DIAGNOSTICS n = ROW_COUNT; IF n <> 0 THEN RAISE EXCEPTION 'updated another community''s unit'; END IF;
  DELETE FROM property.unit WHERE id = '00000000-0000-0000-0000-0000000000c2'; GET DIAGNOSTICS n = ROW_COUNT; IF n <> 0 THEN RAISE EXCEPTION 'deleted another community''s unit'; END IF;
  PERFORM test.pass('another community''s row cannot be updated or deleted, even by id');
END $$;

-- ---- 3. server-stamped columns ----------------------------------------------------------------------------------------------------------------------
DO $$ DECLARE r record; v1 bigint; BEGIN
  PERFORM set_config('app.community_id', '00000000-0000-0000-0000-00000000000a', true);
  PERFORM set_config('app.user_id', '00000000-0000-0000-0000-0000000000e1', true);
  INSERT INTO property.block (community_id, name, created_at, created_by, updated_at, updated_by, version, short_id)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'Tower T', '2000-01-01', gen_random_uuid(), '2000-01-01', gen_random_uuid(), 99, 'FAKE-1');
  SELECT * INTO r FROM property.block WHERE name = 'Tower T';
  IF r.created_at < now() - interval '1 minute' OR r.created_by <> '00000000-0000-0000-0000-0000000000e1' OR r.version <> 1 OR r.short_id = 'FAKE-1' OR r.updated_by <> r.created_by THEN
    RAISE EXCEPTION 'forged audit columns were kept: %', row_to_json(r); END IF;
  v1 := r.version;
  UPDATE property.block SET kind = 'Tower', created_at = '1999-01-01', created_by = gen_random_uuid(), version = 1000, short_id = 'FAKE-2', id = gen_random_uuid() WHERE name = 'Tower T';
  SELECT * INTO r FROM property.block WHERE name = 'Tower T';
  IF r.version <> v1 + 1 OR r.created_at < now() - interval '1 minute' OR r.short_id = 'FAKE-2' OR r.kind <> 'Tower' THEN RAISE EXCEPTION 'update kept forged values: %', row_to_json(r); END IF;
  PERFORM test.pass('created/updated time and person, version, id and short number are the database''s, whatever the statement says');
END $$;
DO $$ DECLARE a text; b text; BEGIN
  PERFORM set_config('app.community_id', '00000000-0000-0000-0000-00000000000a', true);
  INSERT INTO property.block (community_id, name) VALUES ('00000000-0000-0000-0000-00000000000a', 'Tower U') RETURNING short_id INTO a;
  INSERT INTO property.block (community_id, name) VALUES ('00000000-0000-0000-0000-00000000000a', 'Tower V') RETURNING short_id INTO b;
  IF a IS NULL OR b IS NULL OR a = b OR a !~ '^BLK-[0-9]{4}$' THEN RAISE EXCEPTION 'short numbers %, %', a, b; END IF;
  -- past 9 999 the number grows instead of being cut to four digits
  UPDATE platform.short_id_counter SET last_value = 9999 WHERE community_id = '00000000-0000-0000-0000-00000000000a' AND kind = 'BLK';
  INSERT INTO property.block (community_id, name) VALUES ('00000000-0000-0000-0000-00000000000a', 'Tower W') RETURNING short_id INTO b;
  IF b <> 'BLK-10000' THEN RAISE EXCEPTION 'number after 9999 is %', b; END IF;
  PERFORM test.pass('short numbers are given in order and never repeat, past 9 999 too', a || ' ' || b);
END $$;

-- ---- 4. money integrity -----------------------------------------------------------------------------------------------------------------------------
DO $$ DECLARE cat uuid; BEGIN
  PERFORM set_config('app.community_id', '00000000-0000-0000-0000-00000000000a', true);
  SELECT id INTO cat FROM billing.charge_category WHERE code = 'Maintenance';
  PERFORM test.expect_error(format($q$INSERT INTO billing.due (community_id, unit_id, category_id, amount, due_date) VALUES ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000c1', %L, -5, current_date)$q$, cat), '23514');
  PERFORM test.expect_error(format($q$INSERT INTO billing.due (community_id, unit_id, category_id, amount, paid_amount, due_date, status, paid_at) VALUES ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000c1', %L, 100, 150, current_date, 'Paid', now())$q$, cat), '23514');
  PERFORM test.expect_error(format($q$INSERT INTO billing.due (community_id, unit_id, category_id, amount, paid_amount, due_date, status, paid_at) VALUES ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000c1', %L, 100, 40, current_date, 'Paid', now())$q$, cat), '23514');
  PERFORM test.expect_error(format($q$INSERT INTO billing.due (community_id, unit_id, category_id, amount, due_date, status) VALUES ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000c1', %L, 100, current_date, 'Cancelled')$q$, cat), '23514');
  PERFORM test.expect_error(format($q$INSERT INTO billing.due (community_id, unit_id, category_id, amount, due_date) VALUES ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000c2', %L, 100, current_date)$q$, cat), '23503');
  PERFORM test.pass('a bill cannot be negative, overpaid, "Paid" when it is not, cancelled without a reason, or for another community''s unit');
END $$;

-- payment allocations and the ledger are checked at COMMIT: these run in their own transactions (BEGIN/COMMIT blocks), outside DO
SET app.community_id = '00000000-0000-0000-0000-00000000000a';
BEGIN;
INSERT INTO billing.due (community_id, id, unit_id, category_id, amount, due_date)
  SELECT '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-0000000000c1', id, 1000, current_date FROM billing.charge_category WHERE code = 'Maintenance';
INSERT INTO billing.payment (community_id, id, unit_id, amount, method, received_at) VALUES ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000c1', 500, 'Cash', now());
INSERT INTO billing.payment_allocation (community_id, payment_id, due_id, target_id, amount) VALUES ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000d001', 500);
COMMIT;
DO $$ BEGIN
  PERFORM set_config('app.community_id', '00000000-0000-0000-0000-00000000000a', true);
  -- a deferred constraint is checked at commit; SET CONSTRAINTS ALL IMMEDIATE checks it now, inside this block
  PERFORM test.expect_error($q$INSERT INTO billing.payment_allocation (community_id, payment_id, due_id, target_id, amount) SELECT '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000a001', id, id, 1 FROM billing.due WHERE id = '00000000-0000-0000-0000-00000000d001' ON CONFLICT (community_id, payment_id, target_type, target_id) DO UPDATE SET amount = 501; SET CONSTRAINTS ALL IMMEDIATE$q$, '23514');
  PERFORM test.expect_error($q$INSERT INTO billing.payment (community_id, unit_id, amount, method, provider, provider_payment_ref, received_at) VALUES ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000c1', 10, 'UPI', 'razorpay', 'pay_1', now()), ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000c1', 10, 'UPI', 'razorpay', 'pay_1', now())$q$, '23505');
  PERFORM test.expect_error($q$DELETE FROM billing.payment WHERE id = '00000000-0000-0000-0000-00000000a001'$q$, '42501');
  PERFORM test.pass('a payment is allocated at most once over, recorded once per provider reference, and never deleted');
END $$;

DO $$ DECLARE e uuid; bank uuid; inc uuid; BEGIN
  PERFORM set_config('app.community_id', '00000000-0000-0000-0000-00000000000a', true);
  SELECT id INTO bank FROM finance.account WHERE code = '1000'; SELECT id INTO inc FROM finance.account WHERE code = '4000';
  -- unbalanced: refused when posted
  INSERT INTO finance.journal_entry (community_id, entry_date, memo, source_type) VALUES ('00000000-0000-0000-0000-00000000000a', current_date, 'unbalanced', 'manual') RETURNING id INTO e;
  INSERT INTO finance.journal_line (community_id, entry_id, line_no, account_id, debit) VALUES ('00000000-0000-0000-0000-00000000000a', e, 1, bank, 100);
  INSERT INTO finance.journal_line (community_id, entry_id, line_no, account_id, credit) VALUES ('00000000-0000-0000-0000-00000000000a', e, 2, inc, 90);
  PERFORM test.expect_error(format($q$UPDATE finance.journal_entry SET status = 'Posted' WHERE id = %L; SET CONSTRAINTS ALL IMMEDIATE$q$, e), '23514');
  PERFORM test.expect_error(format($q$INSERT INTO finance.journal_line (community_id, entry_id, line_no, account_id, debit, credit) VALUES ('00000000-0000-0000-0000-00000000000a', %L, 3, %L, 5, 5)$q$, e, bank), '23514');
  -- balanced: posted, and from then on immutable
  UPDATE finance.journal_line SET credit = 100 WHERE entry_id = e AND line_no = 2;
  UPDATE finance.journal_entry SET status = 'Posted' WHERE id = e;
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM test.expect_error(format($q$UPDATE finance.journal_line SET debit = 1000 WHERE entry_id = %L AND line_no = 1$q$, e), '55000');
  PERFORM test.expect_error(format($q$INSERT INTO finance.journal_line (community_id, entry_id, line_no, account_id, debit) VALUES ('00000000-0000-0000-0000-00000000000a', %L, 9, %L, 1)$q$, e, bank), '55000');
  PERFORM test.expect_error(format($q$UPDATE finance.journal_entry SET memo = 'edited' WHERE id = %L$q$, e), '55000');
  PERFORM test.pass('a journal entry must balance to be posted, and a posted entry is never edited, extended or deleted');
END $$;
RESET ROLE;
INSERT INTO finance.period_lock (community_id, locked_until) VALUES ('00000000-0000-0000-0000-00000000000a', current_date - 1) ON CONFLICT (community_id) DO UPDATE SET locked_until = EXCLUDED.locked_until;
SET ROLE cos_app;
DO $$ BEGIN
  PERFORM set_config('app.community_id', '00000000-0000-0000-0000-00000000000a', true);
  PERFORM test.expect_error($q$INSERT INTO finance.journal_entry (community_id, entry_date, memo, source_type) VALUES ('00000000-0000-0000-0000-00000000000a', current_date - 5, 'back-dated', 'manual')$q$, '55000');
  PERFORM test.pass('nothing is posted into a closed period');
END $$;

-- ---- 5. audit trail ---------------------------------------------------------------------------------------------------------------------------------
DO $$ DECLARE r record; BEGIN
  PERFORM set_config('app.community_id', '00000000-0000-0000-0000-00000000000a', true);
  PERFORM set_config('app.user_id', '00000000-0000-0000-0000-0000000000e1', true);
  -- partitioned tables: a forged time would need the row moved to another month, which PostgreSQL refuses - so the insert fails instead
  PERFORM test.expect_error($q$INSERT INTO audit.audit_event (community_id, at, actor_label, action, entity, summary) VALUES ('00000000-0000-0000-0000-00000000000a', '2000-01-01', 'Olive', 'Update', 'billing.due', 'x')$q$, NULL);
  INSERT INTO audit.audit_event (community_id, actor_id, actor_label, action, entity, summary) VALUES ('00000000-0000-0000-0000-00000000000a', gen_random_uuid(), 'Olive', 'Update', 'billing.due', 'x');
  SELECT * INTO r FROM audit.audit_event ORDER BY at DESC LIMIT 1;
  IF r.at < now() - interval '1 minute' OR r.actor_id <> '00000000-0000-0000-0000-0000000000e1' THEN RAISE EXCEPTION 'audit time/actor forged: %', row_to_json(r); END IF;
  PERFORM test.expect_error($q$UPDATE audit.audit_event SET summary = 'rewritten'$q$, NULL);
  PERFORM test.expect_error($q$DELETE FROM audit.audit_event$q$, NULL);
  PERFORM test.pass('the audit trail is append-only and its time and actor are the server''s');
END $$;

-- ---- 6. partitions, sign-in tables, privileges ----------------------------------------------------------------------------------------------------
DO $$ DECLARE part text; BEGIN
  PERFORM set_config('app.community_id', '00000000-0000-0000-0000-00000000000a', true);
  INSERT INTO comms.notification (community_id, to_unit_id, event, title, link) VALUES ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000c1', 'bill', 'Your bill', '#/billing');
  SELECT tableoid::regclass::text INTO part FROM comms.notification LIMIT 1;
  IF part NOT LIKE 'comms.notification_20%' THEN RAISE EXCEPTION 'notification landed in %', part; END IF;
  PERFORM test.expect_error($q$INSERT INTO comms.notification (community_id, to_unit_id, event, title, link) VALUES ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000c1', 'x', 'Pay here', 'https://evil.example')$q$, '23514');
  PERFORM test.expect_error(format('SELECT * FROM %s', part), '42501');
  PERFORM test.pass('notifications go to the month''s partition, link only inside the app, and partitions are not readable directly', part);
END $$;
DO $$ BEGIN
  PERFORM test.expect_error('SELECT * FROM identity.refresh_token', '42501');
  PERFORM test.expect_error('SELECT * FROM identity.otp_challenge', '42501');
  PERFORM test.expect_error('CREATE TABLE property.hack (x int)', '42501');
  PERFORM test.expect_error('DROP TABLE property.unit', '42501');
  PERFORM test.pass('the API role cannot read sign-in secrets or change the schema');
END $$;
DO $$ BEGIN
  PERFORM set_config('app.community_id', '00000000-0000-0000-0000-00000000000a', true);
  PERFORM test.expect_error($q$INSERT INTO maintenance.ticket_comment (community_id, ticket_id, author_id, body) VALUES ('00000000-0000-0000-0000-00000000000a', gen_random_uuid(), gen_random_uuid(), 'orphan')$q$, '23503');
  PERFORM test.expect_error($q$INSERT INTO gate.pass (community_id, unit_id, visitor_name, type, code) VALUES ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000c2', 'x', 'One-time', '123456')$q$, '23503');
  PERFORM test.pass('module tables keep their references: no comment without its ticket, no pass for another community''s unit');
END $$;
DO $$ DECLARE tt uuid; tk uuid; sn text; BEGIN
  PERFORM set_config('app.community_id', '00000000-0000-0000-0000-00000000000a', true);
  SELECT id INTO tt FROM maintenance.task_type WHERE name = 'Resident Maintenance';
  IF tt IS NULL THEN RAISE EXCEPTION 'the default task types were not provisioned'; END IF;
  INSERT INTO maintenance.ticket (community_id, task_type_id, title, unit_id, category, raised_by_id)
    VALUES ('00000000-0000-0000-0000-00000000000a', tt, 'Leak in kitchen', '00000000-0000-0000-0000-0000000000c1', 'Plumbing', '00000000-0000-0000-0000-0000000000e1') RETURNING id, short_id INTO tk, sn;
  IF sn <> 'TKT-1051' THEN RAISE EXCEPTION 'first ticket number is %', sn; END IF;
  PERFORM test.expect_error($q$INSERT INTO maintenance.ticket (community_id, title, category, raised_by_id, status) VALUES ('00000000-0000-0000-0000-00000000000a', 'x yz', 'Plumbing', '00000000-0000-0000-0000-0000000000e1', 'Done')$q$, '23514');
  PERFORM test.expect_error($q$INSERT INTO maintenance.ticket (community_id, title, category, raised_by_id, scope) VALUES ('00000000-0000-0000-0000-00000000000a', 'Street light', 'Electrical', '00000000-0000-0000-0000-0000000000e1', 'Community')$q$, '23514');
  PERFORM test.expect_error(format($q$UPDATE maintenance.ticket SET status = 'Assigned' WHERE id = %L$q$, tk), '23514');
  PERFORM test.expect_error(format($q$UPDATE maintenance.ticket SET status = 'Cancelled' WHERE id = %L$q$, tk), '23514');
  PERFORM test.expect_error(format($q$UPDATE maintenance.ticket SET resident_rating = 9 WHERE id = %L$q$, tk), '23514');
  PERFORM test.expect_error(format($q$UPDATE maintenance.ticket SET assignee_id = '00000000-0000-0000-0000-0000000000e2' WHERE id = %L$q$, tk), '23503');
  PERFORM test.expect_error(format($q$INSERT INTO maintenance.ticket_comment (community_id, ticket_id, author_id, body, visibility) VALUES ('00000000-0000-0000-0000-00000000000a', %L, '00000000-0000-0000-0000-0000000000e1', 'x', 'Secret')$q$, tk), '23514');
  PERFORM test.pass('tickets: numbered from TKT-1051, status / scope / rating checked, an assignee from this community, a reason to cancel', sn);
END $$;
DO $$ DECLARE b uuid; t uuid; BEGIN
  PERFORM set_config('app.community_id', '00000000-0000-0000-0000-00000000000a', true);
  IF (SELECT count(*) FROM comms.notification_setting) <> 1 THEN RAISE EXCEPTION 'one notification settings row per community'; END IF;
  PERFORM test.expect_error($q$INSERT INTO comms.broadcast (community_id, type, audience, subject, status) VALUES ('00000000-0000-0000-0000-00000000000a', 'Poll', 'All residents', 'Pool?', 'Draft')$q$, '23514');
  PERFORM test.expect_error($q$INSERT INTO comms.broadcast (community_id, type, audience, subject, status) VALUES ('00000000-0000-0000-0000-00000000000a', 'Notice', 'All residents', 'x', 'Sent')$q$, '23514');
  INSERT INTO comms.broadcast (community_id, type, audience, subject, poll_options, status, sent_at)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'Poll', 'Owners', 'Pool?', '{Yes,No}', 'Sent', now()) RETURNING id INTO b;
  INSERT INTO comms.poll_vote (community_id, broadcast_id, voter_id, unit_id, choices) VALUES ('00000000-0000-0000-0000-00000000000a', b, '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', '{0}');
  PERFORM test.expect_error(format($q$INSERT INTO comms.poll_vote (community_id, broadcast_id, voter_id, unit_id, choices) VALUES ('00000000-0000-0000-0000-00000000000a', %L, '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', '{1}')$q$, b), '23505');
  INSERT INTO comms.forum_topic (community_id, title, author_id) VALUES ('00000000-0000-0000-0000-00000000000a', 'Pool timings', '00000000-0000-0000-0000-0000000000e1') RETURNING id INTO t;
  PERFORM test.expect_error(format($q$INSERT INTO comms.forum_post (community_id, topic_id, author_id, body, hidden) VALUES ('00000000-0000-0000-0000-00000000000a', %L, '00000000-0000-0000-0000-0000000000e1', 'x', true)$q$, t), '23514');
  PERFORM test.expect_error($q$INSERT INTO comms.notification (community_id, to_membership_id, event, title, body, link) VALUES ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', 'bill', 'x', 'y', 'https://x')$q$, '23514');
  PERFORM test.pass('comms: a poll has answers, a sent notice a time, one vote per unit, a hidden post a reason, a notification links inside the app');
END $$;
DO $$ DECLARE f uuid; BEGIN
  PERFORM set_config('app.community_id', '00000000-0000-0000-0000-00000000000a', true);
  INSERT INTO docs.file_object (community_id, file_name, mime_type, size_bytes, sha256, storage_key)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'a.pdf', 'application/pdf', 10, decode(repeat('ab', 32), 'hex'), 'k/' || gen_random_uuid()) RETURNING id INTO f;
  PERFORM test.expect_error(format($q$UPDATE docs.file_object SET owner_type = 'maintenance.ticket' WHERE id = %L$q$, f), '23514');
  PERFORM test.expect_error(format($q$UPDATE docs.file_object SET owner_type = 'gate.visit', owner_id = gen_random_uuid() WHERE id = %L$q$, f), '23514');
  PERFORM test.expect_error($q$INSERT INTO docs.document (community_id, title, access) VALUES ('00000000-0000-0000-0000-00000000000a', 'Deed', 'Villa owner / resident')$q$, '23514');
  PERFORM test.expect_error($q$INSERT INTO docs.folder (community_id, id, name, parent_id) VALUES ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000f001', 'Loop', '00000000-0000-0000-0000-00000000f001')$q$, '23514');
  PERFORM test.pass('files: attached to something real or to nothing; a villa document has its unit; a folder is not its own parent');
END $$;
DO $$ DECLARE e uuid; BEGIN
  PERFORM set_config('app.community_id', '00000000-0000-0000-0000-00000000000a', true);
  IF NOT EXISTS (SELECT 1 FROM finance.account WHERE code = '4400') THEN RAISE EXCEPTION 'Donations account not provisioned'; END IF;
  INSERT INTO cultural.event (community_id, name) VALUES ('00000000-0000-0000-0000-00000000000a', 'Holi') RETURNING id INTO e;
  PERFORM test.expect_error(format($q$INSERT INTO cultural.donation (community_id, event_id, donor, amount, status) VALUES ('00000000-0000-0000-0000-00000000000a', %L, 'x', 10, 'Received')$q$, e), '23514');
  PERFORM test.expect_error(format($q$INSERT INTO cultural.donation (community_id, event_id, donor, amount) VALUES ('00000000-0000-0000-0000-00000000000a', %L, 'x', 0)$q$, e), '23514');
  PERFORM test.expect_error(format($q$INSERT INTO cultural.expense (community_id, event_id, item, status) VALUES ('00000000-0000-0000-0000-00000000000a', %L, 'Flowers', 'Approved')$q$, e), '23514');
  PERFORM test.expect_error(format($q$UPDATE cultural.event SET credited_amount = 100, credited_at = now() WHERE id = %L$q$, e), '23514');
  PERFORM test.expect_error(format($q$INSERT INTO cultural.seva (community_id, event_id, title, volunteers) VALUES ('00000000-0000-0000-0000-00000000000a', %L, 'Stall', '{"a":1}')$q$, e), '23514');
  PERFORM test.pass('cultural: a receipt only for money received, amounts above zero, approved expenses have an amount, credit only once completed, sign-ups are lists');
END $$;
DO $$ BEGIN
  PERFORM set_config('app.community_id', '00000000-0000-0000-0000-00000000000a', true);
  PERFORM test.expect_error($q$INSERT INTO finance.cash_book_entry (community_id, date, type, amount, description) VALUES ('00000000-0000-0000-0000-00000000000a', current_date, 'Debit', 0, 'x')$q$, '23514');
  PERFORM test.expect_error($q$INSERT INTO finance.cash_book_entry (community_id, date, type, amount, description, recon_status) VALUES ('00000000-0000-0000-0000-00000000000a', current_date, 'Debit', 10, 'x', 'Matched')$q$, '23514');
  PERFORM test.expect_error($q$INSERT INTO finance.cash_book_entry (community_id, date, type, amount, description, reversal_of) VALUES ('00000000-0000-0000-0000-00000000000a', current_date, 'Credit', 10, 'x', 'CB-1')$q$, '23514');
  PERFORM test.expect_error($q$INSERT INTO finance.release (community_id, amount, status) VALUES ('00000000-0000-0000-0000-00000000000a', 10, 'Waiting approval')$q$, '23514');
  PERFORM test.expect_error($q$INSERT INTO finance.bank_txn (community_id, date, debit, credit, line_hash) VALUES ('00000000-0000-0000-0000-00000000000a', current_date, 5, 5, 'h1')$q$, '23514');
  PERFORM test.expect_error($q$INSERT INTO finance.pay_request (community_id, amount, status, requested_by_id, decided_by_id, decided_at) VALUES ('00000000-0000-0000-0000-00000000000a', 10, 'Approved', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e1', now())$q$, '23514');
  PERFORM test.pass('finance: cash book amounts above zero, matched means a bank line, a reversal has a reason, a release is on something, a bank line goes one way, no approving your own payment');
END $$;
DO $$ DECLARE b uuid; h text := repeat('a', 64); n int; BEGIN
  PERFORM set_config('app.community_id', '00000000-0000-0000-0000-00000000000a', true);
  PERFORM test.expect_error($q$INSERT INTO governance.meeting (community_id, title, committee, date, visibility) VALUES ('00000000-0000-0000-0000-00000000000a', 'AGM', 'EC', current_date, 'Published to residents')$q$, '23514');
  PERFORM test.expect_error($q$INSERT INTO governance.meeting (community_id, title, committee, date, start_time, end_time) VALUES ('00000000-0000-0000-0000-00000000000a', 'AGM', 'EC', current_date, '10:00', '09:00')$q$, '23514');
  INSERT INTO governance.ballot (community_id, title, kind, options, opens_on, closes_on) VALUES ('00000000-0000-0000-0000-00000000000a', 'Paint?', 'Resolution', '{For,Against}', current_date, current_date) RETURNING id INTO b;
  PERFORM test.expect_error(format($q$UPDATE governance.ballot SET status = 'Closed', closed_at = now(), votes_counted = 0 WHERE id = %L$q$, b), '23514');
  PERFORM test.expect_error(format($q$UPDATE governance.ballot SET status = 'Open' WHERE id = %L$q$, b), '23514');
  PERFORM test.expect_error(format($q$INSERT INTO governance.vote_roll (community_id, ballot_id, unit_id, marked_on) VALUES ('00000000-0000-0000-0000-00000000000a', %L, '00000000-0000-0000-0000-0000000000c1', current_date)$q$, b), '23514');
  UPDATE governance.ballot SET status = 'Open', opened_at = now(), roll_hash = h WHERE id = b;
  INSERT INTO governance.ballot_elector (community_id, ballot_id, unit_id, unit_no, owners) VALUES ('00000000-0000-0000-0000-00000000000a', b, '00000000-0000-0000-0000-0000000000c1', 'Villa 1', '[{"name":"A"}]');
  PERFORM test.expect_error(format($q$UPDATE governance.ballot SET title = 'Paint it red?' WHERE id = %L$q$, b), '23514');
  INSERT INTO governance.vote_roll (community_id, ballot_id, unit_id, marked_on) VALUES ('00000000-0000-0000-0000-00000000000a', b, '00000000-0000-0000-0000-0000000000c1', current_date);
  PERFORM test.expect_error(format($q$INSERT INTO governance.vote_roll (community_id, ballot_id, unit_id, marked_on) VALUES ('00000000-0000-0000-0000-00000000000a', %L, '00000000-0000-0000-0000-0000000000c1', current_date)$q$, b), '23505');
  INSERT INTO governance.ballot_box (community_id, ballot_id, seq, choice, receipt, prev_hash, hash) VALUES ('00000000-0000-0000-0000-00000000000a', b, 1, 'For', 'abcdefabcdef', repeat('0', 64), h);
  SELECT count(*) INTO n FROM governance.ballot_box WHERE ballot_id = b;
  IF n <> 0 THEN RAISE EXCEPTION 'the box was readable while voting was open'; END IF;
  PERFORM test.expect_error(format($q$DELETE FROM governance.ballot_elector WHERE ballot_id = %L$q$, b), '42501');
  UPDATE governance.ballot SET votes_cast = 1, chain_head = h WHERE id = b;
  UPDATE governance.ballot SET status = 'Closed', closed_at = now(), votes_counted = 1 WHERE id = b;
  SELECT count(*) INTO n FROM governance.ballot_box WHERE ballot_id = b;
  IF n <> 1 THEN RAISE EXCEPTION 'the box is not readable after the close'; END IF;
  PERFORM test.expect_error(format($q$UPDATE governance.ballot_box SET choice = 'Against' WHERE ballot_id = %L$q$, b), '42501');
  PERFORM test.expect_error(format($q$INSERT INTO governance.ballot_box (community_id, ballot_id, seq, choice, receipt, prev_hash, hash) VALUES ('00000000-0000-0000-0000-00000000000a', %L, 2, 'For', 'abcdefabcde0', %L, %L)$q$, b, h, h), '23514');
  PERFORM test.expect_error(format($q$UPDATE governance.ballot SET description = 'x' WHERE id = %L$q$, b), '23514');
  PERFORM test.pass('governance: a published meeting has its time, a ballot is opened before it closes, frozen once open, one mark per unit, a sealed box until the close, nothing changed or deleted');
END $$;
DO $$ DECLARE v uuid; k uuid; BEGIN
  PERFORM set_config('app.community_id', '00000000-0000-0000-0000-00000000000a', true);
  INSERT INTO vendor.vendor (community_id, name) VALUES ('00000000-0000-0000-0000-00000000000a', 'Aqua Pumps') RETURNING id INTO v;
  PERFORM test.expect_error($q$INSERT INTO vendor.vendor (community_id, name) VALUES ('00000000-0000-0000-0000-00000000000a', 'AQUA PUMPS')$q$, '23505');
  PERFORM test.expect_error($q$INSERT INTO vendor.vendor (community_id, name, gstin) VALUES ('00000000-0000-0000-0000-00000000000a', 'X', '1234')$q$, '23514');
  PERFORM test.expect_error(format($q$INSERT INTO vendor.service_line (community_id, vendor_id, service, signed_workers) VALUES ('00000000-0000-0000-0000-00000000000a', %L, 'Plumbing', -1)$q$, v), '23514');
  INSERT INTO vendor.service_contact (community_id, name) VALUES ('00000000-0000-0000-0000-00000000000a', 'Raju') RETURNING id INTO k;
  PERFORM test.expect_error(format($q$UPDATE vendor.service_contact SET status = 'Hidden' WHERE id = %L$q$, k), '23514');
  INSERT INTO vendor.contact_review (community_id, contact_id, rating, author_id, unit_id) VALUES ('00000000-0000-0000-0000-00000000000a', k, 5, '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1');
  PERFORM test.expect_error(format($q$INSERT INTO vendor.contact_review (community_id, contact_id, rating, author_id, unit_id) VALUES ('00000000-0000-0000-0000-00000000000a', %L, 4, '00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000c1')$q$, k), '23505');
  PERFORM test.expect_error(format($q$INSERT INTO vendor.contact_review (community_id, contact_id, rating, author_id) VALUES ('00000000-0000-0000-0000-00000000000a', %L, 6, '00000000-0000-0000-0000-0000000000e2')$q$, k), '23514');
  PERFORM test.pass('vendors: one vendor per name, a GSTIN that looks like one, no negative workers, a hidden contact has who hid it, 1-5 stars, one review per household');
END $$;
DO $$ DECLARE i uuid; e uuid; BEGIN
  PERFORM set_config('app.community_id', '00000000-0000-0000-0000-00000000000a', true);
  INSERT INTO assets.equipment (community_id, name) VALUES ('00000000-0000-0000-0000-00000000000a', 'STP pump A') RETURNING id INTO e;
  PERFORM test.expect_error($q$INSERT INTO assets.equipment (community_id, name) VALUES ('00000000-0000-0000-0000-00000000000a', 'stp PUMP a')$q$, '23505');
  PERFORM test.expect_error(format($q$UPDATE assets.equipment SET status = 'Broken' WHERE id = %L$q$, e), '23514');
  PERFORM test.expect_error(format($q$UPDATE assets.equipment SET quantity = 2, faulty = 3 WHERE id = %L$q$, e), '23514');
  INSERT INTO assets.inventory_item (community_id, item) VALUES ('00000000-0000-0000-0000-00000000000a', 'Salt') RETURNING id INTO i;
  PERFORM test.expect_error(format($q$UPDATE assets.inventory_item SET quantity = -1 WHERE id = %L$q$, i), '23514');
  INSERT INTO assets.inventory_movement (community_id, item_id, kind, quantity, balance, on_date) VALUES ('00000000-0000-0000-0000-00000000000a', i, 'Received', 5, 5, current_date);
  PERFORM test.expect_error(format($q$UPDATE assets.inventory_movement SET quantity = 50 WHERE item_id = %L$q$, i), '42501');
  PERFORM test.expect_error(format($q$INSERT INTO assets.inventory_movement (community_id, item_id, kind, quantity, balance, on_date) VALUES ('00000000-0000-0000-0000-00000000000a', %L, 'Issued', 0, 5, current_date)$q$, i), '23514');
  INSERT INTO assets.plant_log (community_id, date) VALUES ('00000000-0000-0000-0000-00000000000a', current_date);
  PERFORM test.expect_error($q$INSERT INTO assets.plant_log (community_id, date) VALUES ('00000000-0000-0000-0000-00000000000a', current_date)$q$, '23505');
  PERFORM test.expect_error($q$INSERT INTO assets.plant_log (community_id, date, bh_open, bh_close) VALUES ('00000000-0000-0000-0000-00000000000a', current_date - 1, 10, 5)$q$, '23514');
  PERFORM test.expect_error($q$INSERT INTO assets.electricity_bill (community_id, status) VALUES ('00000000-0000-0000-0000-00000000000a', 'Paid')$q$, '23514');
  PERFORM test.expect_error($q$INSERT INTO assets.unit_electricity (community_id, unit_id, month) VALUES ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000c1', '2026-13')$q$, '23514');
  PERFORM test.expect_error($q$INSERT INTO assets.dg_fuel_log (community_id, date, litres) VALUES ('00000000-0000-0000-0000-00000000000a', current_date, 0)$q$, '23514');
  PERFORM test.pass('assets: one asset per name, a condition from the list, stock never below zero and its movements kept, one plant log a day, meters forward, a paid bill has a date');
END $$;
DO $$ BEGIN
  PERFORM set_config('app.community_id', '00000000-0000-0000-0000-00000000000a', true);
  IF (SELECT count(*) FROM workforce.attendance_setting) <> 1 THEN RAISE EXCEPTION 'one attendance setting per community'; END IF;
  INSERT INTO workforce.attendance_session (community_id, member_id, date, clock_in) VALUES ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', current_date, now() - interval '1 hour');
  PERFORM test.expect_error($q$INSERT INTO workforce.attendance_session (community_id, member_id, date, clock_in) VALUES ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', current_date, now())$q$, '23505');
  PERFORM test.expect_error($q$UPDATE workforce.attendance_session SET clock_out = clock_in - interval '1 minute', hours = 0 WHERE member_id = '00000000-0000-0000-0000-0000000000e1'$q$, '23514');
  PERFORM test.expect_error($q$UPDATE workforce.attendance_session SET clock_out = now() WHERE member_id = '00000000-0000-0000-0000-0000000000e1'$q$, '23514');
  PERFORM test.expect_error($q$UPDATE workforce.attendance_session SET source = 'Supervisor' WHERE member_id = '00000000-0000-0000-0000-0000000000e1'$q$, '23514');
  PERFORM test.expect_error($q$UPDATE workforce.attendance_setting SET enforcement = 'Require location inside the site', site_lat = NULL$q$, '23514');
  PERFORM test.expect_error($q$INSERT INTO workforce.site_holiday (community_id, date, name, trash) VALUES ('00000000-0000-0000-0000-00000000000a', current_date, 'Diwali', 'Rescheduled')$q$, '23514');
  PERFORM test.pass('workforce: one setting, one open session a member, clock-out after clock-in with its hours, a correction has its supervisor and reason, a rescheduled pickup has its day');
END $$;
DO $$ DECLARE r uuid; BEGIN
  PERFORM set_config('app.community_id', '00000000-0000-0000-0000-00000000000a', true);
  PERFORM test.expect_error($q$INSERT INTO reports.schedule (community_id, name, report_type, frequency, audience) VALUES ('00000000-0000-0000-0000-00000000000a', 'x', 'gossip', 'Daily', 'Roles')$q$, '23514');
  PERFORM test.expect_error($q$INSERT INTO reports.schedule (community_id, name, report_type, frequency, audience) VALUES ('00000000-0000-0000-0000-00000000000a', 'x', 'custom', 'Daily', 'Roles')$q$, '23514');
  PERFORM test.expect_error($q$INSERT INTO reports.schedule (community_id, name, report_type, frequency, audience, channels) VALUES ('00000000-0000-0000-0000-00000000000a', 'x', 'dues', 'Daily', 'Roles', '{Pigeon}')$q$, '23514');
  INSERT INTO reports.run (community_id, name, title, summary) VALUES ('00000000-0000-0000-0000-00000000000a', 'Dues', 'Dues outstanding', '3 bills') RETURNING id INTO r;
  PERFORM test.expect_error(format($q$UPDATE reports.run SET title = 'x' WHERE id = %L$q$, r), '42501');
  PERFORM test.pass('reports: a schedule names a known report (a custom one its recipe) and known channels; a sent report is kept as sent');
END $$;
DO $$ DECLARE missing text; dup text; BEGIN
  -- every foreign key has an index on its columns (V27), except the ones that only record who did something (memberships are never deleted)
  SELECT string_agg(format('%s(%s)', c.conrelid::regclass, cols), ', ') INTO missing FROM (
    SELECT c.oid, c.conrelid, c.conkey, string_agg(a.attname, ',' ORDER BY u.o) AS cols, bool_or(a.attname ~ '(_by_id|_by_unit_id|author_id|reserved_unit_id)$' OR a.attname = 'permission') AS who
    FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid JOIN LATERAL unnest(c.conkey) WITH ORDINALITY u(k, o) ON true
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.k
    WHERE c.contype = 'f' AND NOT r.relispartition AND r.relnamespace::regnamespace::text NOT IN ('test')
    GROUP BY c.oid, c.conrelid, c.conkey) c
  WHERE NOT c.who AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid
    AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] @> c.conkey AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] <@ c.conkey);
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'foreign keys without an index: %', missing; END IF;
  -- no plain index is only the leading columns of another one
  WITH ix AS (SELECT i.indrelid t, i.indexrelid x, string_to_array(i.indkey::text, ' ') k, i.indisunique u FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
              WHERE i.indpred IS NULL AND i.indexprs IS NULL AND NOT c.relispartition AND c.relnamespace::regnamespace::text NOT LIKE 'pg_%' AND c.relnamespace::regnamespace::text NOT IN ('information_schema', 'test'))
  SELECT string_agg(format('%s (covered by %s)', a.x::regclass, b.x::regclass), ', ') INTO dup FROM ix a JOIN ix b ON a.t = b.t AND a.x <> b.x AND NOT a.u
    AND cardinality(a.k) <= cardinality(b.k) AND a.k = b.k[1:cardinality(a.k)] AND (cardinality(a.k) < cardinality(b.k) OR a.x > b.x);
  IF dup IS NOT NULL THEN RAISE EXCEPTION 'redundant indexes: %', dup; END IF;
  PERFORM test.pass('indexes: every foreign key that is joined or deleted through has one; none repeats another');
END $$;
RESET ROLE;
DO $$ BEGIN   -- as the owner (the platform console's role changes communities)
  PERFORM test.expect_error($q$UPDATE platform.community SET time_zone = 'Mars/Olympus' WHERE slug = 'test-a'$q$, '23514');
  PERFORM test.pass('a community time zone must be one PostgreSQL knows');
END $$;

SELECT format('%s schema tests passed', count(*)) AS result FROM test.result WHERE ok;
