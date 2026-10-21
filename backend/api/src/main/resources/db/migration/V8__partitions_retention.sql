-- =====================================================================================================================================
-- V8 monthly partitions and retention for the time-series tables
--   platform.ensure_partitions(months_ahead)  creates this month .. N months ahead for every partitioned table (a scheduled job calls it daily)
--   platform.drop_partitions_before(table, cutoff)  detaches and drops whole months past the retention period (no row-by-row DELETE)
-- =====================================================================================================================================

CREATE OR REPLACE FUNCTION platform.partitioned_tables() RETURNS TABLE (schema_name text, table_name text) LANGUAGE sql STABLE AS $$
  SELECT n.nspname::text, c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'p' AND n.nspname IN ('audit', 'comms', 'gate', 'workforce', 'integration') $$;

CREATE OR REPLACE FUNCTION platform.ensure_partitions(months_ahead int DEFAULT 2, months_back int DEFAULT 1) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE t record; m date; made int := 0; part text;
BEGIN
  FOR t IN SELECT * FROM platform.partitioned_tables() LOOP
    m := (date_trunc('month', now()) - make_interval(months => months_back))::date;
    WHILE m <= (date_trunc('month', now()) + make_interval(months => months_ahead))::date LOOP
      part := format('%s_%s', t.table_name, to_char(m, 'YYYY_MM'));
      IF to_regclass(format('%I.%I', t.schema_name, part)) IS NULL THEN
        BEGIN
          EXECUTE format('CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)', t.schema_name, part, t.schema_name, t.table_name, m, (m + interval '1 month')::date);
          made := made + 1;
        EXCEPTION WHEN check_violation OR invalid_object_definition THEN
          RAISE NOTICE 'rows for % already sit in the default partition of %.%; move them first', m, t.schema_name, t.table_name;
        END;
      END IF;
      m := (m + interval '1 month')::date;
    END LOOP;
  END LOOP;
  RETURN made;
END $$;

CREATE OR REPLACE FUNCTION platform.drop_partitions_before(qualified_table text, cutoff date) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE r record; dropped int := 0;
BEGIN
  IF qualified_table LIKE 'audit.%' THEN RAISE EXCEPTION 'the audit trail is kept; archive it instead of dropping'; END IF;
  FOR r IN
    SELECT c.oid::regclass AS part, pg_get_expr(c.relpartbound, c.oid) AS bound FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = qualified_table::regclass AND pg_get_expr(c.relpartbound, c.oid) LIKE 'FOR VALUES FROM%'
  LOOP
    IF substring(r.bound FROM 'TO \(''([0-9-]+)')::date <= cutoff THEN
      EXECUTE format('ALTER TABLE %s DETACH PARTITION %s', qualified_table, r.part);
      EXECUTE format('DROP TABLE %s', r.part);
      dropped := dropped + 1;
    END IF;
  END LOOP;
  RETURN dropped;
END $$;

SELECT platform.ensure_partitions(3, 1);
