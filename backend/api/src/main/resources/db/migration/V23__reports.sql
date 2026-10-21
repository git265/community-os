-- =====================================================================================================================================
-- V23 reports: scheduled reports and the record of what was sent.
--   * a schedule names a report the server knows (or a custom recipe), a period, a format, when it runs and to whom - roles, members or
--     units by id (no longer by name or unit number); the day it last ran is the server's
--   * a sent report keeps what was sent (title, summary lines, columns, rows) and to whom; it is never changed
-- =====================================================================================================================================

UPDATE reports.schedule SET name = coalesce(nullif(btrim(name), ''), '(unnamed report)');
UPDATE reports.schedule SET frequency = 'Daily' WHERE frequency IS NULL OR frequency NOT IN ('Daily', 'Weekly', 'Monthly');
UPDATE reports.schedule SET audience = 'Roles' WHERE audience IS NULL OR audience NOT IN ('Roles', 'People', 'All villas', 'Selected villas');
UPDATE reports.schedule SET format = 'Summary' WHERE format IS NULL OR format NOT IN ('Summary', 'Detailed', 'Excel', 'CSV');
UPDATE reports.schedule SET active = coalesce(active, true), skip_empty = coalesce(skip_empty, false), time = coalesce(time, '08:00');
DELETE FROM reports.schedule WHERE report_type IS NULL OR report_type NOT IN ('bookings', 'dues', 'collections', 'water', 'tasks', 'audits', 'infra', 'eventwork', 'custom');
ALTER TABLE reports.schedule
  ADD COLUMN IF NOT EXISTS unit_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS member_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS recipe jsonb;
UPDATE reports.schedule s SET unit_ids = coalesce((SELECT array_agg(u.id) FROM property.unit u WHERE u.community_id = s.community_id AND u.unit_no = ANY (s.units)), '{}') WHERE s.units IS NOT NULL;
UPDATE reports.schedule s SET member_ids = coalesce((SELECT array_agg(m.id) FROM identity.membership m WHERE m.community_id = s.community_id AND m.display_name = ANY (s.people)), '{}') WHERE s.people IS NOT NULL;
UPDATE reports.schedule SET month_day = least(greatest(round(month_day), 1), 31) WHERE month_day IS NOT NULL;
ALTER TABLE reports.schedule
  DROP COLUMN IF EXISTS units,
  DROP COLUMN IF EXISTS people,
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN report_type SET NOT NULL,
  ALTER COLUMN frequency SET NOT NULL,
  ALTER COLUMN audience SET NOT NULL,
  ALTER COLUMN format SET NOT NULL,
  ALTER COLUMN format SET DEFAULT 'Summary',
  ALTER COLUMN time SET NOT NULL,
  ALTER COLUMN time SET DEFAULT '08:00',
  ALTER COLUMN active SET NOT NULL,
  ALTER COLUMN active SET DEFAULT true,
  ALTER COLUMN skip_empty SET NOT NULL,
  ALTER COLUMN skip_empty SET DEFAULT false,
  ALTER COLUMN month_day TYPE integer USING month_day::integer,
  ALTER COLUMN channels SET DEFAULT '{In-app}',
  ADD CONSTRAINT schedule_name CHECK (length(name) BETWEEN 1 AND 120),
  ADD CONSTRAINT schedule_type CHECK (report_type IN ('bookings', 'dues', 'collections', 'water', 'tasks', 'audits', 'infra', 'eventwork', 'custom')),
  ADD CONSTRAINT schedule_custom CHECK (report_type <> 'custom' OR recipe IS NOT NULL),
  ADD CONSTRAINT schedule_period CHECK (period IS NULL OR period IN ('today', 'tomorrow', 'today_tomorrow', 'yesterday', 'next7', 'next14', 'last7', 'last30', 'mtd', 'prevMonth', 'asof')),
  ADD CONSTRAINT schedule_frequency CHECK (frequency IN ('Daily', 'Weekly', 'Monthly')),
  ADD CONSTRAINT schedule_weekday CHECK (weekday IS NULL OR weekday IN ('Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday')),
  ADD CONSTRAINT schedule_month_day CHECK (month_day IS NULL OR month_day BETWEEN 1 AND 31),
  ADD CONSTRAINT schedule_audience CHECK (audience IN ('Roles', 'People', 'All villas', 'Selected villas')),
  ADD CONSTRAINT schedule_format CHECK (format IN ('Summary', 'Detailed', 'Excel', 'CSV')),
  ADD CONSTRAINT schedule_channels CHECK (channels IS NULL OR channels <@ ARRAY['In-app', 'Email', 'SMS', 'WhatsApp']);

DELETE FROM reports.run WHERE run_at IS NULL;
ALTER TABLE reports.run
  ADD COLUMN IF NOT EXISTS report_type text,
  ADD COLUMN IF NOT EXISTS period_from date,
  ADD COLUMN IF NOT EXISTS period_to date,
  ADD COLUMN IF NOT EXISTS delivered integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS manual boolean NOT NULL DEFAULT false,
  ALTER COLUMN rows TYPE jsonb USING CASE WHEN rows IS NULL OR rows = '' THEN '[]'::jsonb ELSE rows::jsonb END,
  ALTER COLUMN rows SET NOT NULL,
  ALTER COLUMN rows SET DEFAULT '[]',
  ALTER COLUMN run_at SET NOT NULL,
  ALTER COLUMN run_at SET DEFAULT now(),
  ADD CONSTRAINT run_schedule FOREIGN KEY (community_id, schedule_id) REFERENCES reports.schedule (community_id, id) ON DELETE SET NULL (schedule_id),
  ADD CONSTRAINT run_rows CHECK (jsonb_typeof(rows) = 'array' AND jsonb_array_length(rows) <= 5000);
CREATE INDEX IF NOT EXISTS run_by_schedule ON reports.run (community_id, schedule_id, run_at DESC);

CREATE OR REPLACE FUNCTION reports.sent_as_it_was() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.schedule_id IS NULL AND OLD.schedule_id IS NOT NULL
     AND (NEW.title, NEW.summary, NEW.rows, NEW.sent_to, NEW.run_at) IS NOT DISTINCT FROM (OLD.title, OLD.summary, OLD.rows, OLD.sent_to, OLD.run_at) THEN RETURN NEW;   -- its schedule was deleted
  END IF;
  RAISE EXCEPTION 'a sent report is kept as it was sent' USING ERRCODE = '42501';
END $$;
DROP TRIGGER IF EXISTS kept ON reports.run;
CREATE TRIGGER kept BEFORE UPDATE ON reports.run FOR EACH ROW EXECUTE FUNCTION reports.sent_as_it_was();

SELECT platform.apply_security();
