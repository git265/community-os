-- Schema tests: run as the service role (cos_app) against a fresh database with every migration applied.
--   psql -v ON_ERROR_STOP=1 -d <db> -f src/test/sql/schema_tests.sql
-- Each check raises an exception when it fails; the script ends with "schema tests: all passed".
\set QUIET on
SET client_min_messages = notice;

-- ---- helpers ------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION t_expect_error(stmt text, want_state text, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
    EXECUTE 'SET CONSTRAINTS ALL IMMEDIATE';   -- deferred checks (journal balance) fire here
  EXCEPTION WHEN others THEN
    IF want_state IS NOT NULL AND SQLSTATE <> want_state THEN RAISE EXCEPTION 'FAIL %: expected SQLSTATE % but got % (%)', label, want_state, SQLSTATE, SQLERRM; END IF;
    RAISE NOTICE 'ok   %  (% %)', label, SQLSTATE, left(SQLERRM, 80);
    RETURN;
  END;
  RAISE EXCEPTION 'FAIL %: the statement was accepted', label;
END $$;
CREATE OR REPLACE FUNCTION t_assert(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS NOT TRUE THEN RAISE EXCEPTION 'FAIL %', label; END IF; RAISE NOTICE 'ok   %', label; END $$;
GRANT EXECUTE ON FUNCTION t_expect_error(text, text, text), t_assert(boolean, text) TO cos_app;

-- ---- fixtures, made by the platform (crosses communities) --------------------------------------------------------------------------
INSERT INTO communities (id, slug, name) VALUES ('00000000-0000-0000-0000-00000000000a', 'alpha', 'Alpha Residency'), ('00000000-0000-0000-0000-00000000000b', 'beta', 'Beta Towers');
DO $$
DECLARE c uuid; tag text;
BEGIN
  FOREACH tag IN ARRAY ARRAY['a', 'b'] LOOP
    c := ('00000000-0000-0000-0000-00000000000' || tag)::uuid;
    PERFORM set_config('app.community_id', c::text, false);
    INSERT INTO unit_types VALUES (c, 'Villa', true);
    INSERT INTO blocks (id, community_id, name) VALUES (('10000000-0000-0000-0000-00000000000' || tag)::uuid, c, 'Lane 1');
    INSERT INTO units (id, community_id, unit_no, block_id, unit_type) VALUES (('20000000-0000-0000-0000-00000000000' || tag)::uuid, c, 'Villa 1', ('10000000-0000-0000-0000-00000000000' || tag)::uuid, 'Villa');
    INSERT INTO people (id, community_id, full_name, phone_e164) VALUES (('30000000-0000-0000-0000-00000000000' || tag)::uuid, c, 'Owner ' || tag, '+9198000000' || CASE tag WHEN 'a' THEN '11' ELSE '12' END);
    INSERT INTO user_accounts (id, community_id, person_id, login_phone) VALUES (('40000000-0000-0000-0000-00000000000' || tag)::uuid, c, ('30000000-0000-0000-0000-00000000000' || tag)::uuid, '+9198000000' || CASE tag WHEN 'a' THEN '11' ELSE '12' END);
    INSERT INTO gl_accounts (id, community_id, code, name, kind, is_receivable) VALUES (('50000000-0000-0000-0000-0000000000a' || tag)::uuid, c, '1200', 'Owners receivable', 'Asset', true);
    INSERT INTO gl_accounts (id, community_id, code, name, kind) VALUES (('50000000-0000-0000-0000-0000000000b' || tag)::uuid, c, '4000', 'Maintenance income', 'Income');
    INSERT INTO gl_accounts (id, community_id, code, name, kind, is_bank) VALUES (('50000000-0000-0000-0000-0000000000c' || tag)::uuid, c, '1000', 'Bank', 'Asset', true);
    INSERT INTO charge_types (id, community_id, code, name, income_account_id) VALUES (('60000000-0000-0000-0000-00000000000' || tag)::uuid, c, 'MAINT', 'Maintenance', ('50000000-0000-0000-0000-0000000000b' || tag)::uuid);
    INSERT INTO amenity_types (id, community_id, name, exclusive, rate, rate_unit) VALUES (('70000000-0000-0000-0000-00000000000' || tag)::uuid, c, 'Clubhouse', true, 500, 'Per hour');
    INSERT INTO ticket_categories (community_id, name) VALUES (c, 'Plumbing');
    INSERT INTO task_types (id, community_id, name, creator_scope, assignment_mode, resident_visible, resident_default) VALUES (('80000000-0000-0000-0000-00000000000' || tag)::uuid, c, 'Resident Maintenance', 'Resident', 'Role queue', true, true);
  END LOOP;
END $$;
SELECT set_config('app.community_id', '', false);

-- ---- everything below runs as the service ------------------------------------------------------------------------------------------
SET ROLE cos_app;

-- 1. isolation ------------------------------------------------------------------------------------------------------------------------
SELECT t_assert((SELECT count(*) FROM units) = 0, 'no community set: nothing is visible');
SELECT t_expect_error($$INSERT INTO blocks (community_id, name) VALUES ('00000000-0000-0000-0000-00000000000a', 'X')$$, '42501', 'no community set: nothing can be written');
SELECT set_config('app.community_id', '00000000-0000-0000-0000-00000000000a', false), set_config('app.user_id', '40000000-0000-0000-0000-00000000000a', false);
SELECT t_assert((SELECT count(*) FROM units) = 1 AND (SELECT unit_no FROM units) = 'Villa 1', 'community A sees only its own unit');
SELECT t_assert((SELECT count(*) FROM units WHERE id = '20000000-0000-0000-0000-00000000000b') = 0, 'community B''s unit is invisible even by id');
SELECT t_expect_error($$INSERT INTO blocks (community_id, name) VALUES ('00000000-0000-0000-0000-00000000000b', 'Sneaky')$$, '42501', 'cannot write a row into another community');
SELECT t_expect_error($$UPDATE units SET community_id = '00000000-0000-0000-0000-00000000000b'$$, NULL, 'cannot move a row to another community');
SELECT t_expect_error($$SELECT count(*) FROM notifications_default$$, '42501', 'partitions cannot be read directly, only through the policy');

-- 2. a reference to another community's row is impossible -------------------------------------------------------------------------
SELECT t_expect_error($$INSERT INTO bills (community_id, bill_no, unit_id, charge_type_id, net_amount, due_date)
  VALUES ('00000000-0000-0000-0000-00000000000a', 'BIL-X', '20000000-0000-0000-0000-00000000000b', '60000000-0000-0000-0000-00000000000a', 100, current_date)$$, '23503', 'a bill cannot point at another community''s unit');

-- 3. who and when are the server's ----------------------------------------------------------------------------------------------
INSERT INTO bills (id, community_id, bill_no, unit_id, charge_type_id, net_amount, due_date, created_at, created_by, updated_at, updated_by, version)
  VALUES ('90000000-0000-0000-0000-000000000001', app_community(), 'BIL-000001', '20000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-00000000000a', 1000, current_date + 10,
          '2000-01-01', '40000000-0000-0000-0000-00000000000b', '2000-01-01', '40000000-0000-0000-0000-00000000000b', 99);
SELECT t_assert((SELECT created_at > now() - interval '1 minute' AND created_by = app_user() AND version = 0 FROM bills WHERE bill_no = 'BIL-000001'), 'created_at / created_by / version on insert come from the server');
UPDATE bills SET description = 'Oct maintenance', updated_by = '40000000-0000-0000-0000-00000000000b', created_at = '2001-01-01', version = 42 WHERE bill_no = 'BIL-000001';
SELECT t_assert((SELECT version = 1 AND updated_by = app_user() AND created_at > now() - interval '1 minute' FROM bills WHERE bill_no = 'BIL-000001'), 'an update cannot set version, updated_by or created_at');

-- 4. a bill is paid only through a payment, and is fixed once issued -------------------------------------------------------------
SELECT t_expect_error($$UPDATE bills SET amount_paid = 1000 WHERE bill_no = 'BIL-000001'$$, '23514', 'amount paid cannot be set directly');
SELECT t_expect_error($$UPDATE bills SET status = 'Paid' WHERE bill_no = 'BIL-000001'$$, '23514', 'a bill cannot be marked paid directly');
SELECT t_expect_error($$UPDATE bills SET net_amount = 1 WHERE bill_no = 'BIL-000001'$$, '23514', 'an issued amount cannot be changed');
SELECT t_expect_error($$DELETE FROM bills WHERE bill_no = 'BIL-000001'$$, '42501', 'bills are never deleted');
SELECT t_expect_error($$INSERT INTO bills (community_id, bill_no, unit_id, charge_type_id, net_amount, due_date) VALUES (app_community(), 'BIL-NEG', '20000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-00000000000a', -5, current_date)$$, '23514', 'no negative bill');

INSERT INTO payments (id, community_id, receipt_no, unit_id, amount, currency, method, status, settled_at) VALUES ('91000000-0000-0000-0000-000000000001', app_community(), 'RCP-1', '20000000-0000-0000-0000-00000000000a', 700, 'INR', 'UPI', 'Settled', now());
INSERT INTO payment_allocations (community_id, payment_id, bill_id, amount) VALUES (app_community(), '91000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-000000000001', 600);
SELECT t_assert((SELECT status = 'Partially paid' AND amount_paid = 600 FROM bills WHERE bill_no = 'BIL-000001'), 'an allocation moves the bill to Partially paid');
SELECT t_expect_error($$INSERT INTO payment_allocations (community_id, payment_id, bill_id, amount) VALUES (app_community(), '91000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-000000000001', 200)$$, '23514', 'a payment cannot be spent twice');
INSERT INTO payments (id, community_id, receipt_no, unit_id, amount, currency, method, status, settled_at) VALUES ('91000000-0000-0000-0000-000000000002', app_community(), 'RCP-2', '20000000-0000-0000-0000-00000000000a', 900, 'INR', 'UPI', 'Settled', now());
SELECT t_expect_error($$INSERT INTO payment_allocations (community_id, payment_id, bill_id, amount) VALUES (app_community(), '91000000-0000-0000-0000-000000000002', '90000000-0000-0000-0000-000000000001', 500)$$, '23514', 'a bill cannot be over-paid');
INSERT INTO payment_allocations (community_id, payment_id, bill_id, amount) VALUES (app_community(), '91000000-0000-0000-0000-000000000002', '90000000-0000-0000-0000-000000000001', 400);
SELECT t_assert((SELECT status = 'Paid' AND amount_paid = 1000 FROM bills WHERE bill_no = 'BIL-000001'), 'fully allocated: Paid');
SELECT t_expect_error($$UPDATE bills SET status = 'Cancelled', cancelled_reason = 'oops' WHERE bill_no = 'BIL-000001'$$, '23514', 'a bill with payments cannot be cancelled');
SELECT t_expect_error($$UPDATE payment_allocations SET amount = 1$$, '42501', 'allocations are append-only');

-- 5. the journal balances, never changes, and respects closed books ------------------------------------------------------------
BEGIN;
INSERT INTO journal_entries (id, community_id, entry_no, entry_date, memo, source_type) VALUES ('92000000-0000-0000-0000-000000000001', app_community(), 'JE-1', current_date, 'Bill BIL-000001', 'Bill');
INSERT INTO journal_lines (community_id, entry_id, account_id, debit) VALUES (app_community(), '92000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-0000000000aa', 1000);
INSERT INTO journal_lines (community_id, entry_id, account_id, credit) VALUES (app_community(), '92000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-0000000000ba', 1000);
COMMIT;
SELECT t_assert((SELECT count(*) = 2 FROM journal_lines), 'a balanced entry is accepted (posted in one transaction)');
SELECT t_expect_error($$INSERT INTO journal_entries (id, community_id, entry_no, entry_date, memo, source_type) VALUES ('92000000-0000-0000-0000-000000000002', app_community(), 'JE-2', current_date, 'bad', 'Adjustment');
  INSERT INTO journal_lines (community_id, entry_id, account_id, debit) VALUES (app_community(), '92000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-0000000000aa', 50)$$, '23514', 'an unbalanced entry is refused at commit');
SELECT t_expect_error($$INSERT INTO journal_lines (community_id, entry_id, account_id, debit, credit) VALUES (app_community(), '92000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-0000000000aa', 5, 5)$$, '23514', 'a line is a debit or a credit, not both');
SELECT t_expect_error($$UPDATE journal_lines SET debit = 1$$, '42501', 'posted lines never change');
SELECT t_expect_error($$DELETE FROM journal_entries$$, '42501', 'posted entries are never deleted');

-- 6. no double booking, whatever the application does ----------------------------------------------------------------------------
INSERT INTO amenity_bookings (community_id, booking_no, amenity_type_id, unit_id, booked_by_user_id, starts_at, ends_at, exclusive, status)
  VALUES (app_community(), 'BKG-1', '70000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a', app_user(), '2030-01-01 10:00+00', '2030-01-01 12:00+00', true, 'Confirmed');
SELECT t_expect_error($$INSERT INTO amenity_bookings (community_id, booking_no, amenity_type_id, unit_id, booked_by_user_id, starts_at, ends_at, exclusive, status)
  VALUES (app_community(), 'BKG-2', '70000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a', app_user(), '2030-01-01 11:00+00', '2030-01-01 13:00+00', true, 'Pending payment')$$, '23P01', 'an overlapping booking of an exclusive amenity is refused');
INSERT INTO amenity_bookings (community_id, booking_no, amenity_type_id, unit_id, booked_by_user_id, starts_at, ends_at, exclusive, status)
  VALUES (app_community(), 'BKG-3', '70000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a', app_user(), '2030-01-01 12:00+00', '2030-01-01 13:00+00', true, 'Confirmed');
SELECT t_assert(true, 'back-to-back bookings are fine');
SELECT t_expect_error($$INSERT INTO amenity_bookings (community_id, booking_no, amenity_type_id, unit_id, booked_by_user_id, starts_at, ends_at, exclusive, waived_amount, base_amount)
  VALUES (app_community(), 'BKG-4', '70000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a', app_user(), '2030-02-01 10:00+00', '2030-02-01 11:00+00', true, 100, 500)$$, '23514', 'a waiver needs a reason');

-- 7. notifications: in-app links only, content fixed, sender is the caller ----------------------------------------------------
INSERT INTO notifications (community_id, recipient_unit_id, event_type, title, link, sender_user_id) VALUES (app_community(), '20000000-0000-0000-0000-00000000000a', 'bill', 'Your bill', '/billing', '40000000-0000-0000-0000-00000000000b');
SELECT t_assert((SELECT sender_user_id = app_user() FROM notifications WHERE title = 'Your bill'), 'the sender is the caller, not the payload');
SELECT t_expect_error($$INSERT INTO notifications (community_id, recipient_unit_id, event_type, title, link) VALUES (app_community(), '20000000-0000-0000-0000-00000000000a', 'bill', 'Pay here', 'https://evil.example')$$, '23514', 'no external links');
SELECT t_expect_error($$UPDATE notifications SET title = 'Changed'$$, '23514', 'a notification''s text cannot change');
UPDATE notifications SET read_at = now();
SELECT t_assert((SELECT read_at IS NOT NULL FROM notifications LIMIT 1), 'it can be marked read');

-- 8. tickets: the status trail is the database's; rules on scope and assignment ------------------------------------------------
INSERT INTO tickets (id, community_id, ticket_no, task_type_id, unit_id, category, title, raised_by_user_id) VALUES ('93000000-0000-0000-0000-000000000001', app_community(), 'TKT-1', '80000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a', 'Plumbing', 'Kitchen tap leaks', app_user());
SELECT t_expect_error($$UPDATE tickets SET status = 'Assigned'$$, '23514', 'Assigned needs an assignee');
UPDATE tickets SET status = 'Assigned', assignee_user_id = app_user();
SELECT t_assert((SELECT count(*) = 2 FROM ticket_status_history), 'every status change is recorded by the database');
SELECT t_expect_error($$UPDATE ticket_status_history SET to_status = 'Closed'$$, '42501', 'the status trail cannot be rewritten');
SELECT t_expect_error($$INSERT INTO tickets (community_id, ticket_no, task_type_id, scope, category, title, raised_by_user_id) VALUES (app_community(), 'TKT-2', '80000000-0000-0000-0000-00000000000a', 'Community', 'Plumbing', 'Road lamp', app_user())$$, '23514', 'a community request needs a location');

-- 9. approvals are recorded in the caller's own name -------------------------------------------------------------------------
INSERT INTO approval_steps (id, community_id, subject_type, subject_id, step_no, name, approver_role_ids) VALUES ('94000000-0000-0000-0000-000000000001', app_community(), 'Ticket', '93000000-0000-0000-0000-000000000001', 1, 'EC', '{}');
INSERT INTO approval_decisions (community_id, step_id, decided_by, decision) VALUES (app_community(), '94000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-00000000000b', 'Approved');
SELECT t_assert((SELECT decided_by = app_user() FROM approval_decisions), 'a decision is always the caller''s');
SELECT t_expect_error($$UPDATE approval_decisions SET decision = 'Rejected'$$, '42501', 'a decision cannot be changed afterwards');

-- 10. releases never exceed the approved amount; unit credit never goes negative ------------------------------------------------
UPDATE tickets SET approved_amount = 1000, financial = true;
INSERT INTO fund_releases (community_id, ticket_id, kind, amount) VALUES (app_community(), '93000000-0000-0000-0000-000000000001', 'Advance', 800);
SELECT t_expect_error($$INSERT INTO fund_releases (community_id, ticket_id, kind, amount) VALUES (app_community(), '93000000-0000-0000-0000-000000000001', 'Stage', 300)$$, '23514', 'releases cannot exceed the approved amount');
INSERT INTO unit_credit_movements (community_id, unit_id, amount, reason, source_type) VALUES (app_community(), '20000000-0000-0000-0000-00000000000a', 100, 'refund', 'Refund');
SELECT t_expect_error($$INSERT INTO unit_credit_movements (community_id, unit_id, amount, reason, source_type) VALUES (app_community(), '20000000-0000-0000-0000-00000000000a', -150, 'use', 'Bill')$$, '23514', 'unit credit cannot go below zero');

-- 11. history tables are insert-only for the service ------------------------------------------------------------------------
INSERT INTO audit_events (community_id, actor_label, action, resource, summary) VALUES (app_community(), 'Owner a', 'Update', 'bills', 'x');
SELECT t_expect_error($$DELETE FROM audit_events$$, '42501', 'the audit trail cannot be deleted');
SELECT t_expect_error($$UPDATE audit_events SET summary = 'y'$$, '42501', 'the audit trail cannot be edited');

-- 12. community B still sees nothing of A ------------------------------------------------------------------------------------
SELECT set_config('app.community_id', '00000000-0000-0000-0000-00000000000b', false);
SELECT t_assert((SELECT count(*) FROM bills) = 0 AND (SELECT count(*) FROM notifications) = 0 AND (SELECT count(*) FROM audit_events) = 0 AND (SELECT count(*) FROM tickets) = 0, 'community B sees none of A''s bills, messages, audit or tickets');
RESET ROLE;
\echo schema tests: all passed
