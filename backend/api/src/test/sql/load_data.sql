-- Synthetic load for the sizing target: 100 communities x 1 000 units, 12 months of bills, a busy year of notifications and gate entries.
--   psql -d cos_v2_load -f src/test/sql/load_data.sql     (run as the owner; triggers stamp every row as in production)
\timing on
SET synchronous_commit = off;
INSERT INTO platform.community (slug, name) SELECT format('community-%s', g), format('Community %s', g) FROM generate_series(1, 100) g;
SELECT platform.provision_community(id) FROM platform.community;

-- people and memberships: one owner per unit
INSERT INTO identity.person (phone_e164, full_name)
  SELECT format('+9198%s', lpad((c.n * 1000 + u)::text, 8, '0')), format('Owner %s-%s', c.n, u)
  FROM (SELECT id, row_number() OVER (ORDER BY slug) AS n FROM platform.community) c, generate_series(1, 1000) u;

-- units, memberships and occupants, per community (the RLS context is set per community, as the API does)
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT id, row_number() OVER (ORDER BY slug) AS n FROM platform.community LOOP
    PERFORM set_config('app.community_id', c.id::text, true);
    INSERT INTO property.block (community_id, name) SELECT c.id, format('Block %s', b) FROM generate_series(1, 10) b;
    INSERT INTO property.unit (community_id, unit_no, block_id, unit_type, occupancy)
      SELECT c.id, format('Villa %s', u), (SELECT id FROM property.block WHERE community_id = c.id AND name = format('Block %s', 1 + (u - 1) / 100)), 'Villa',
             CASE WHEN u % 10 = 0 THEN 'Tenant occupied' ELSE 'Owner occupied' END
      FROM generate_series(1, 1000) u;
    INSERT INTO identity.membership (community_id, person_id, display_name)
      SELECT c.id, p.id, p.full_name FROM identity.person p WHERE p.phone_e164 LIKE format('+9198%s%%', lpad(c.n::text, 5, '0'));
    INSERT INTO property.occupant (community_id, unit_id, person_id, relation, full_name, phone_e164, is_primary)
      SELECT c.id, un.id, p.id, 'Owner', p.full_name, p.phone_e164, true
      FROM property.unit un JOIN identity.person p ON p.phone_e164 = format('+9198%s', lpad((c.n * 1000 + substring(un.unit_no FROM '[0-9]+')::int)::text, 8, '0'))
      WHERE un.community_id = c.id;
  END LOOP;
END $$;

-- 12 months of maintenance bills for every unit (1.2 M), the older months paid
DO $$ DECLARE c record; cat uuid; BEGIN
  FOR c IN SELECT id FROM platform.community LOOP
    PERFORM set_config('app.community_id', c.id::text, true);
    SELECT id INTO cat FROM billing.charge_category WHERE community_id = c.id AND code = 'Maintenance';
    INSERT INTO billing.due (community_id, unit_id, category_id, billed_month, amount, tax_amount, due_date, status, paid_amount, paid_at)
      SELECT c.id, un.id, cat, (date_trunc('month', current_date) - make_interval(months => m))::date, 3000, 540,
             ((date_trunc('month', current_date) - make_interval(months => m)) + interval '10 days')::date,
             CASE WHEN m > 1 THEN 'Paid' ELSE 'Unpaid' END, CASE WHEN m > 1 THEN 3540 ELSE 0 END, CASE WHEN m > 1 THEN now() - make_interval(months => m) END
      FROM property.unit un, generate_series(0, 11) m WHERE un.community_id = c.id;
  END LOOP;
END $$;

-- tickets (100 k), notifications (2 M, this month and last), gate entries (1 M)
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT id FROM platform.community LOOP
    PERFORM set_config('app.community_id', c.id::text, true);
    INSERT INTO maintenance.ticket (community_id, unit_id, title, category, priority, status)
      SELECT c.id, un.id, 'Leak', (ARRAY['Plumbing', 'Electrical', 'Carpentry', 'Civil'])[1 + (random() * 3)::int], 'Medium',
             (ARRAY['Open', 'Assigned', 'In Progress', 'Completed', 'Closed'])[1 + (random() * 4)::int]
      FROM property.unit un WHERE un.community_id = c.id;
    INSERT INTO comms.notification (community_id, to_unit_id, event, title, link, read_at)
      SELECT c.id, un.id, 'bill', format('Bill %s', k), '#/billing', CASE WHEN k < 15 THEN now() END
      FROM property.unit un, generate_series(1, 20) k WHERE un.community_id = c.id;
    INSERT INTO gate.visit (community_id, unit_id, name, kind, state)
      SELECT c.id, un.id, 'Courier', 'Delivery', 'Exited' FROM property.unit un, generate_series(1, 10) k WHERE un.community_id = c.id;
  END LOOP;
END $$;
RESET app.community_id;
ANALYZE;
SELECT (SELECT count(*) FROM platform.community) AS communities, (SELECT count(*) FROM property.unit) AS units, (SELECT count(*) FROM billing.due) AS bills,
       (SELECT count(*) FROM maintenance.ticket) AS tickets, (SELECT count(*) FROM comms.notification) AS notifications, (SELECT count(*) FROM gate.visit) AS gate_visits;
