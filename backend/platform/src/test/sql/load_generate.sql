-- Load data for 100 communities x 1,000 units, one year of activity. Generated set-based (triggers off while loading: the integrity
-- triggers are measured separately in load_writes.sql). Run as a superuser on a database with every migration applied.
\timing on
SET session_replication_role = replica;      -- bulk load: skip triggers and FK checks (the data below is consistent by construction)
SET maintenance_work_mem = '512MB';

INSERT INTO communities (id, slug, name, status)
SELECT md5('c' || c)::uuid, 'community-' || c, 'Community ' || c, 'Active' FROM generate_series(1, 100) c;

INSERT INTO unit_types (community_id, code, active) SELECT id, t, true FROM communities, unnest(ARRAY['Villa', 'Apartment']) t;
INSERT INTO blocks (id, community_id, name) SELECT md5('b' || c.id || b)::uuid, c.id, 'Block ' || b FROM communities c, generate_series(1, 4) b;

INSERT INTO units (id, community_id, unit_no, block_id, unit_type, area_sqft)
SELECT md5('u' || c.id || u)::uuid, c.id, 'Unit ' || u, md5('b' || c.id || (1 + u % 4))::uuid, CASE WHEN u % 3 = 0 THEN 'Villa' ELSE 'Apartment' END, 800 + (u % 7) * 150
FROM communities c, generate_series(1, 1000) u;

INSERT INTO people (id, community_id, full_name, phone_e164)
SELECT md5('p' || c.id || u)::uuid, c.id, 'Owner ' || u, '+91' || (7000000000 + row_number() OVER ())::text
FROM communities c, generate_series(1, 1000) u;
INSERT INTO unit_occupancies (community_id, unit_id, person_id, relation, is_primary)
SELECT c.id, md5('u' || c.id || u)::uuid, md5('p' || c.id || u)::uuid, 'Owner', true FROM communities c, generate_series(1, 1000) u;
INSERT INTO user_accounts (id, community_id, person_id, login_phone)
SELECT md5('a' || p.id)::uuid, p.community_id, p.id, p.phone_e164 FROM people p;

INSERT INTO roles (id, community_id, code, name, category, trade)
SELECT md5('r' || c.id || r.code)::uuid, c.id, r.code, r.name, r.cat, r.trade
FROM communities c, (VALUES ('owner', 'Owner', 'Resident', NULL), ('treasurer', 'Treasurer', 'EC', NULL), ('facility_manager', 'Facility Manager', 'Staff', NULL), ('handyman_plumbing', 'Handyman · Plumbing', 'Staff', 'Plumbing')) r(code, name, cat, trade);
INSERT INTO user_roles (id, community_id, user_id, role_id)
SELECT md5('ur' || a.id)::uuid, a.community_id, a.id, md5('r' || a.community_id || 'owner')::uuid FROM user_accounts a;
INSERT INTO user_role_scopes (community_id, user_role_id, unit_id)
SELECT o.community_id, md5('ur' || md5('a' || o.person_id)::uuid)::uuid, o.unit_id FROM unit_occupancies o;

-- chart of accounts, charge types
INSERT INTO gl_accounts (id, community_id, code, name, kind, is_receivable, is_bank)
SELECT md5('g' || c.id || g.code)::uuid, c.id, g.code, g.name, g.kind, g.recv, g.bank
FROM communities c, (VALUES ('1000', 'Bank', 'Asset', false, true), ('1200', 'Owners receivable', 'Asset', true, false), ('4000', 'Maintenance income', 'Income', false, false), ('4100', 'Water income', 'Income', false, false)) g(code, name, kind, recv, bank);
INSERT INTO bank_accounts (id, community_id, gl_account_id, name) SELECT md5('ba' || c.id)::uuid, c.id, md5('g' || c.id || '1000')::uuid, 'Main account' FROM communities c;
INSERT INTO charge_types (id, community_id, code, name, income_account_id, metered)
SELECT md5('ct' || c.id || t.code)::uuid, c.id, t.code, t.name, md5('g' || c.id || t.acct)::uuid, t.code = 'WATER'
FROM communities c, (VALUES ('MAINT', 'Maintenance', '4000'), ('WATER', 'Water', '4100')) t(code, name, acct);

-- 12 months of maintenance bills + 12 of water: 2.4 million bills
INSERT INTO bills (id, community_id, bill_no, unit_id, charge_type_id, period_month, net_amount, tax_amount, due_date, issued_on, status, amount_paid)
SELECT id, community_id, bill_no, unit_id, charge_type_id, period_month, net, 0, due_date, issued_on, CASE WHEN paid THEN 'Paid' ELSE 'Unpaid' END, CASE WHEN paid THEN net ELSE 0 END
FROM (
  SELECT md5('bl' || u.id || m || t)::uuid AS id, u.community_id, 'BIL-' || lpad((row_number() OVER (PARTITION BY u.community_id ORDER BY m, t, u.unit_no))::text, 7, '0') AS bill_no,
         u.id AS unit_id, md5('ct' || u.community_id || t)::uuid AS charge_type_id, (date '2025-11-01' + make_interval(months => m))::date AS period_month,
         (CASE t WHEN 'MAINT' THEN 3000 ELSE 300 + (abs(hashtext(u.id::text || m)) % 400) END)::numeric(14,2) AS net,
         (date '2025-11-10' + make_interval(months => m))::date AS due_date, (date '2025-11-01' + make_interval(months => m))::date AS issued_on,
         (m < 11 OR abs(hashtext(u.id::text || m || t)) % 10 < 7) AS paid
  FROM units u, generate_series(0, 11) m, unnest(ARRAY['MAINT', 'WATER']) t
) x;

-- one payment per paid bill, allocated in full
INSERT INTO payments (id, community_id, receipt_no, unit_id, amount, currency, method, status, received_on, settled_at, bank_account_id)
SELECT md5('py' || b.id)::uuid, b.community_id, 'RCP-' || b.bill_no, b.unit_id, b.total_amount, 'INR', 'UPI', 'Settled', b.due_date - 3, (b.due_date - 3)::timestamptz, md5('ba' || b.community_id)::uuid
FROM bills b WHERE b.status = 'Paid';
INSERT INTO payment_allocations (community_id, payment_id, bill_id, amount)
SELECT b.community_id, md5('py' || b.id)::uuid, b.id, b.total_amount FROM bills b WHERE b.status = 'Paid';

-- the journal: each bill (Dr receivable / Cr income) and each payment (Dr bank / Cr receivable): ~4.6 million entries, ~9 million lines
INSERT INTO journal_entries (id, community_id, entry_no, entry_date, memo, source_type, source_id)
SELECT md5('jb' || b.id)::uuid, b.community_id, 'JE-B' || b.bill_no, b.issued_on, 'Bill ' || b.bill_no, 'Bill', b.id FROM bills b;
INSERT INTO journal_lines (community_id, entry_id, account_id, debit, credit, unit_id)
SELECT b.community_id, md5('jb' || b.id)::uuid, md5('g' || b.community_id || '1200')::uuid, b.total_amount, 0, b.unit_id FROM bills b
UNION ALL
SELECT b.community_id, md5('jb' || b.id)::uuid, ct.income_account_id, 0, b.total_amount, b.unit_id FROM bills b JOIN charge_types ct ON ct.community_id = b.community_id AND ct.id = b.charge_type_id;
INSERT INTO journal_entries (id, community_id, entry_no, entry_date, memo, source_type, source_id)
SELECT md5('jp' || p.id)::uuid, p.community_id, 'JE-' || p.receipt_no, p.received_on, 'Payment ' || p.receipt_no, 'Payment', p.id FROM payments p;
INSERT INTO journal_lines (community_id, entry_id, account_id, debit, credit, unit_id)
SELECT p.community_id, md5('jp' || p.id)::uuid, md5('g' || p.community_id || '1000')::uuid, p.amount, 0, p.unit_id FROM payments p
UNION ALL
SELECT p.community_id, md5('jp' || p.id)::uuid, md5('g' || p.community_id || '1200')::uuid, 0, p.amount, p.unit_id FROM payments p;

-- maintenance: 2 tickets per unit per year (200,000), each with an open / assigned / closed history
INSERT INTO ticket_categories (community_id, name) SELECT c.id, k FROM communities c, unnest(ARRAY['Plumbing', 'Electrical', 'Carpentry', 'Civil & Painting']) k;
INSERT INTO task_types (id, community_id, name, creator_scope, assignment_mode, resident_visible, resident_default)
SELECT md5('tt' || c.id)::uuid, c.id, 'Resident Maintenance', 'Resident', 'Role queue', true, true FROM communities c;
INSERT INTO tickets (id, community_id, ticket_no, task_type_id, unit_id, category, title, status, priority, raised_by_user_id, assignee_user_id, closed_at, created_at)
SELECT md5('tk' || u.id || n)::uuid, u.community_id, 'TKT-' || (1050 + row_number() OVER (PARTITION BY u.community_id ORDER BY u.unit_no, n)), md5('tt' || u.community_id)::uuid, u.id,
       (ARRAY['Plumbing', 'Electrical', 'Carpentry', 'Civil & Painting'])[1 + abs(hashtext(u.id::text || n)) % 4], 'Issue ' || n || ' in ' || u.unit_no,
       CASE WHEN n = 1 THEN 'Closed' WHEN abs(hashtext(u.id::text)) % 5 = 0 THEN 'Open' ELSE 'Assigned' END,
       (ARRAY['Low', 'Medium', 'High', 'Critical'])[1 + abs(hashtext(u.id::text || 'p' || n)) % 4],
       md5('a' || md5('p' || u.community_id || substr(u.unit_no, 6))::uuid)::uuid,
       CASE WHEN n = 1 OR abs(hashtext(u.id::text)) % 5 <> 0 THEN md5('a' || md5('p' || u.community_id || substr(u.unit_no, 6))::uuid)::uuid END,
       CASE WHEN n = 1 THEN now() - interval '30 days' END, now() - make_interval(days => (abs(hashtext(u.id::text || n)) % 360))
FROM units u, generate_series(1, 2) n;
INSERT INTO ticket_status_history (community_id, ticket_id, from_status, to_status, changed_at)
SELECT community_id, id, NULL, 'Open', created_at FROM tickets UNION ALL SELECT community_id, id, 'Open', status, created_at + interval '1 hour' FROM tickets WHERE status <> 'Open';

-- amenities: 5 per community, ~2 bookings per unit per year (200,000)
INSERT INTO amenity_types (id, community_id, name, exclusive, rate, rate_unit)
SELECT md5('am' || c.id || a)::uuid, c.id, 'Amenity ' || a, true, 500, 'Per hour' FROM communities c, generate_series(1, 5) a;
INSERT INTO amenity_bookings (community_id, booking_no, amenity_type_id, unit_id, booked_by_user_id, starts_at, ends_at, exclusive, status, base_amount)
SELECT u.community_id, 'BKG-' || row_number() OVER (PARTITION BY u.community_id ORDER BY u.unit_no, n), md5('am' || u.community_id || (1 + (k % 5)))::uuid, u.id,
       md5('a' || md5('p' || u.community_id || substr(u.unit_no, 6))::uuid)::uuid,
       ts, ts + interval '1 hour', true, 'Confirmed', 500
FROM (SELECT u.*, n, (row_number() OVER (PARTITION BY u.community_id ORDER BY u.unit_no, n)) AS k FROM units u, generate_series(1, 2) n) u,
     LATERAL (SELECT timestamptz '2026-01-01 06:00+05:30' + make_interval(days => ((u.k / 5) / 16)::int, hours => ((u.k / 5) % 16)::int) AS ts) s;

-- notifications: one month, 20 per unit (2,000,000) + the audit trail: one year, 30 per unit (3,000,000)
SELECT ensure_month_partitions('notifications', date '2025-11-01', date '2026-12-01');
INSERT INTO notifications (community_id, created_at, recipient_unit_id, event_type, title, body, link)
SELECT u.community_id, now() - make_interval(hours => n * 30), u.id, 'bill', 'Message ' || n, 'Body', '/billing'
FROM units u, generate_series(1, 20) n;
UPDATE notifications SET read_at = created_at + interval '1 hour' WHERE abs(hashtext(id::text)) % 3 <> 0;
INSERT INTO audit_events (community_id, occurred_at, actor_label, action, resource, resource_id, unit_id, summary)
SELECT u.community_id, now() - make_interval(hours => n * 290), 'Owner', 'Update', 'bills', md5('bl' || u.id || (n % 12) || 'MAINT')::uuid, u.id, 'change ' || n
FROM units u, generate_series(1, 30) n;

SET session_replication_role = origin;
ANALYZE;
SELECT relname AS table, n_live_tup AS rows FROM pg_stat_user_tables WHERE n_live_tup > 50000 ORDER BY n_live_tup DESC;
SELECT pg_size_pretty(pg_database_size(current_database())) AS database_size;
