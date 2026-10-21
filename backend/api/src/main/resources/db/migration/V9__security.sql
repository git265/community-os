-- =====================================================================================================================================
-- V9 security for EVERY tenant table, applied by one idempotent function (later migrations call it again after adding tables):
--   * row-level security, FORCED (applies to the table owner too): a row is visible / writable only inside its own community
--   * audit columns and version stamped by the database (platform.stamp_row); short numbers given once and never changed
--   * least-privilege grants: the API role (cos_app) gets data access only, never DDL; sign-in tables are for the auth (platform) role only;
--     money history (payments, journal) cannot be deleted; the audit trail is insert + select only
--   * child partitions are not granted: everything goes through the parent, where the policy is
-- =====================================================================================================================================

CREATE OR REPLACE FUNCTION platform.tenant_schemas() RETURNS text[] LANGUAGE sql IMMUTABLE AS
$$ SELECT ARRAY['identity', 'property', 'billing', 'finance', 'maintenance', 'amenity', 'gate', 'comms', 'governance', 'cultural', 'workforce', 'assets', 'docs', 'vendor', 'reports', 'config', 'audit', 'integration', 'platform'] $$;

CREATE OR REPLACE FUNCTION platform.apply_security() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE t record; n int := 0; has_stamp boolean; has_short boolean; s text;
BEGIN
  FOREACH s IN ARRAY platform.tenant_schemas() LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO cos_app, cos_platform, cos_readonly', s);
  END LOOP;

  FOR t IN
    SELECT n2.nspname AS sch, c.relname AS tbl, c.relkind AS kind
    FROM pg_class c JOIN pg_namespace n2 ON n2.oid = c.relnamespace
    WHERE n2.nspname = ANY (platform.tenant_schemas()) AND c.relkind IN ('r', 'p') AND NOT c.relispartition
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'community_id' AND NOT a.attisdropped)
      AND NOT (n2.nspname = 'platform' AND c.relname = 'short_id_counter')
  LOOP
    -- 1. row-level security
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', t.sch, t.tbl);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', t.sch, t.tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I.%I', t.sch, t.tbl);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I.%I USING (community_id = platform.current_community()) WITH CHECK (community_id = platform.current_community())', t.sch, t.tbl);
    -- 2. audit columns stamped by the database
    SELECT count(*) = 3 INTO has_stamp FROM pg_attribute a WHERE a.attrelid = format('%I.%I', t.sch, t.tbl)::regclass AND a.attname IN ('version', 'created_by', 'updated_by') AND NOT a.attisdropped;
    IF has_stamp THEN
      EXECUTE format('DROP TRIGGER IF EXISTS stamp_row ON %I.%I', t.sch, t.tbl);
      EXECUTE format('CREATE TRIGGER stamp_row BEFORE INSERT OR UPDATE ON %I.%I FOR EACH ROW EXECUTE FUNCTION platform.stamp_row()', t.sch, t.tbl);
    END IF;
    SELECT count(*) = 1 INTO has_short FROM pg_attribute a WHERE a.attrelid = format('%I.%I', t.sch, t.tbl)::regclass AND a.attname = 'short_id' AND NOT a.attisdropped;
    IF has_short THEN
      EXECUTE format('DROP TRIGGER IF EXISTS keep_short_id ON %I.%I', t.sch, t.tbl);
      EXECUTE format('CREATE TRIGGER keep_short_id BEFORE UPDATE ON %I.%I FOR EACH ROW EXECUTE FUNCTION platform.keep_short_id()', t.sch, t.tbl);
    END IF;
    -- 3. grants
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO cos_app', t.sch, t.tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO cos_platform', t.sch, t.tbl);
    EXECUTE format('GRANT SELECT ON %I.%I TO cos_readonly', t.sch, t.tbl);
    n := n + 1;
  END LOOP;

  -- child partitions: reachable only through the parent (where the policy is)
  FOR t IN SELECT n2.nspname AS sch, c.relname AS tbl FROM pg_class c JOIN pg_namespace n2 ON n2.oid = c.relnamespace
           WHERE c.relispartition AND c.relkind IN ('r', 'p') AND n2.nspname = ANY (platform.tenant_schemas()) LOOP
    EXECUTE format('REVOKE ALL ON %I.%I FROM cos_app, cos_readonly', t.sch, t.tbl);
  END LOOP;

  -- money history and the audit trail
  REVOKE DELETE ON billing.payment, billing.payment_allocation, finance.journal_entry, finance.journal_line FROM cos_app;
  REVOKE UPDATE, DELETE ON audit.audit_event FROM cos_app, cos_platform;
  DROP TRIGGER IF EXISTS append_only ON audit.audit_event;
  CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON audit.audit_event FOR EACH ROW EXECUTE FUNCTION audit.append_only();
  DROP TRIGGER IF EXISTS stamp_event ON audit.audit_event;
  CREATE TRIGGER stamp_event BEFORE INSERT ON audit.audit_event FOR EACH ROW EXECUTE FUNCTION audit.stamp_event();

  -- sign-in tables: the auth service's platform connection only
  REVOKE ALL ON identity.otp_challenge, identity.refresh_token, identity.auth_attempt FROM cos_app, cos_readonly;
  GRANT SELECT, INSERT, UPDATE, DELETE ON identity.otp_challenge, identity.refresh_token, identity.auth_attempt TO cos_platform;
  GRANT USAGE ON ALL SEQUENCES IN SCHEMA identity, integration TO cos_platform;
  GRANT USAGE ON ALL SEQUENCES IN SCHEMA integration TO cos_app;

  -- integration tables without community-scoped access patterns
  GRANT SELECT, INSERT, UPDATE ON integration.outbox_event TO cos_app;
  GRANT SELECT, INSERT, UPDATE ON integration.outbox_event, integration.inbound_event, integration.webhook_delivery TO cos_platform;
  GRANT INSERT, SELECT, UPDATE ON platform.short_id_counter TO cos_app, cos_platform;

  -- people: global rows, visible to a community only when they are its members
  ALTER TABLE identity.person ENABLE ROW LEVEL SECURITY;
  ALTER TABLE identity.person FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS member_of_community ON identity.person;
  CREATE POLICY member_of_community ON identity.person FOR SELECT TO cos_app
    USING (EXISTS (SELECT 1 FROM identity.membership m WHERE m.person_id = person.id AND m.community_id = platform.current_community()));
  DROP POLICY IF EXISTS platform_all ON identity.person;
  CREATE POLICY platform_all ON identity.person TO cos_platform USING (true) WITH CHECK (true);
  GRANT SELECT ON identity.person TO cos_app;
  GRANT SELECT, INSERT, UPDATE ON identity.person TO cos_platform;
  GRANT SELECT ON identity.permission TO cos_app, cos_platform;

  -- the community row: a member reads their own community; the platform console manages all
  ALTER TABLE platform.community ENABLE ROW LEVEL SECURITY;
  ALTER TABLE platform.community FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS own_community ON platform.community;
  CREATE POLICY own_community ON platform.community FOR SELECT TO cos_app USING (id = platform.current_community());
  DROP POLICY IF EXISTS platform_all ON platform.community;
  CREATE POLICY platform_all ON platform.community TO cos_platform USING (true) WITH CHECK (true);
  GRANT SELECT ON platform.community TO cos_app;
  GRANT SELECT, INSERT, UPDATE ON platform.community TO cos_platform;
  RETURN n;
END $$;

-- short numbers of the hand-written tables (the generated ones get theirs in V6)
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT * FROM (VALUES ('property.block', 'BLK'), ('property.facility', 'FAC'), ('property.unit', 'UNIT'), ('billing.due', 'DUE'), ('billing.unit_credit', 'UCR'),
      ('billing.payment_order', 'ORD'), ('billing.payment', 'RCP'), ('finance.fund', 'FND'), ('finance.journal_entry', 'JRN'), ('identity.portal_invite', 'PIV'),
      ('docs.file_object', 'FIL'), ('audit.audit_event', 'AUD')) AS v(tbl, prefix) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS short_id ON %s', r.tbl);
    EXECUTE format('CREATE TRIGGER short_id BEFORE INSERT ON %s FOR EACH ROW EXECUTE FUNCTION platform.stamp_short_id(%L, %L, %L)', r.tbl, r.prefix, '0', '4');
  END LOOP;
END $$;

-- platform-wide tables need the platform role
GRANT SELECT ON platform.module_table TO cos_app, cos_platform;

SELECT platform.apply_security();
