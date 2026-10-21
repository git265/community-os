-- =====================================================================================================================================
-- Database roles and row-level security
--
--   cos_migrator  owns the schema (Flyway runs as it). Not used by the running service.
--   cos_app       the service's runtime login: no DDL, no BYPASSRLS, cannot touch append-only history except to insert.
--   cos_platform  the platform console and background provisioning: may cross communities (BYPASSRLS), used only by those code paths.
--
-- Every table with a community_id column gets FORCE ROW LEVEL SECURITY and one policy: the row's community must be the one set for the
-- current transaction (app.community_id). If nothing is set, nothing is visible and nothing can be written.
-- =====================================================================================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cos_app') THEN CREATE ROLE cos_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cos_platform') THEN CREATE ROLE cos_platform NOLOGIN BYPASSRLS; END IF;
END $$;
-- (deployments create the LOGIN users and GRANT these roles to them: e.g. CREATE USER cos_service PASSWORD '...' IN ROLE cos_app)

GRANT USAGE ON SCHEMA public TO cos_app, cos_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cos_app, cos_platform;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cos_app, cos_platform;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO cos_app, cos_platform;
-- history is insert-only for the service (the triggers refuse changes too: two independent locks)
REVOKE UPDATE, DELETE ON audit_events, journal_entries, journal_lines, payment_allocations, unit_credit_movements, approval_decisions, ticket_status_history,
  vote_roll, ballot_box FROM cos_app;
-- platform-level reference data is read-only for the service
REVOKE INSERT, UPDATE, DELETE ON permissions, signing_keys FROM cos_app;

-- ---- row-level security on every community table ------------------------------------------------------------------------------------
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND NOT c.relispartition
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'community_id' AND NOT a.attisdropped)
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('DROP POLICY IF EXISTS community_isolation ON %I', t.relname);
    EXECUTE format('CREATE POLICY community_isolation ON %I USING (community_id = app_community()) WITH CHECK (community_id = app_community())', t.relname);
  END LOOP;
END $$;

-- Sign-in happens before a community is "set": these two narrow functions are the only way to look across that line.
-- They run as their owner (SECURITY DEFINER), return the minimum, and have a fixed search_path.
CREATE OR REPLACE FUNCTION community_by_slug(p_slug text) RETURNS TABLE (id uuid, status text, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT c.id, c.status, c.name FROM communities c WHERE c.slug = p_slug::citext $$;

-- Refresh tokens are presented without a community: find which one (by the token's hash) so the service can then work under RLS.
CREATE OR REPLACE FUNCTION refresh_token_community(p_hash bytea) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT r.community_id FROM refresh_tokens r WHERE r.token_hash = p_hash $$;

-- A payment provider's webhook names an order, not a community.
CREATE OR REPLACE FUNCTION payment_community(p_provider text, p_order text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT p.community_id FROM payments p WHERE p.provider = p_provider AND p.provider_order_id = p_order LIMIT 1 $$;

REVOKE ALL ON FUNCTION community_by_slug(text), refresh_token_community(bytea), payment_community(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION community_by_slug(text), refresh_token_community(bytea), payment_community(text, text) TO cos_app;

-- The background jobs (outbox publisher, message sender, partition maintenance) work across communities through cos_platform;
-- the outbox and deliveries tables are also readable by cos_app inside its own community.

-- Monthly partitions are reached through their parent (where the policy is); direct access to a partition is not granted.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relispartition AND c.relkind = 'r' LOOP
    EXECUTE format('REVOKE ALL ON %I FROM cos_app', t.relname);
  END LOOP;
END $$;
