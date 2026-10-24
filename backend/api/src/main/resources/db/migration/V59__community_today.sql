-- "Today" in SQL is the community's own calendar day: the database keeps moments in UTC (timestamptz, session time zone UTC), so its
-- current_date is UTC's - before 05:30 in India it is still yesterday. Queries on the tenant connection use platform.today() instead.
CREATE OR REPLACE FUNCTION platform.today() RETURNS date LANGUAGE sql STABLE AS $$
  SELECT (now() AT TIME ZONE coalesce((SELECT c.time_zone FROM platform.community c WHERE c.id = platform.current_community()), 'Asia/Kolkata'))::date
$$;
ALTER TABLE maintenance.checklist ALTER COLUMN starts_on SET DEFAULT platform.today();
