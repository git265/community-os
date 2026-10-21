-- A community's time zone decides its "today" on the server (shared/time/CommunityClock) and its report dates (reports): only a name
-- PostgreSQL (and so Java) knows is accepted, so a typo can never break either.
CREATE OR REPLACE FUNCTION platform.check_time_zone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = NEW.time_zone) OR NEW.time_zone !~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+)+$|^UTC$' THEN
    RAISE EXCEPTION 'unknown time zone: %', NEW.time_zone USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS community_time_zone ON platform.community;
CREATE TRIGGER community_time_zone BEFORE INSERT OR UPDATE OF time_zone ON platform.community FOR EACH ROW EXECUTE FUNCTION platform.check_time_zone();
