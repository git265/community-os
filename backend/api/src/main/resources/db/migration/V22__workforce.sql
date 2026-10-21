-- =====================================================================================================================================
-- V22 workforce: attendance (clock in / out), the site and its rules, holidays, timetabled services, the calendar, planned shifts.
--   * a session belongs to a member, starts and ends at real times (end after start), at most one open session per member; how it was
--     made (by the person, corrected by a supervisor with a reason, closed by the server) is recorded
--   * one attendance setting per community: the site, its radius, how strictly location is required, the grace period, shift start times
--   * holidays (one a day), services and calendar rules from their lists; a planned shift is one per field-staff member and day
-- =====================================================================================================================================

-- ---- attendance -------------------------------------------------------------------------------------------------------------------------
ALTER TABLE workforce.attendance_session ADD COLUMN IF NOT EXISTS member_id uuid;
UPDATE workforce.attendance_session s SET member_id = m.id FROM identity.membership m
  WHERE s.member_id IS NULL AND m.community_id = s.community_id AND lower(m.display_name) = lower(s.staff_name);
DELETE FROM workforce.attendance_session WHERE member_id IS NULL OR clock_in IS NULL OR clock_in !~ '^\d{4}-\d{2}-\d{2}T';
UPDATE workforce.attendance_session SET clock_out = NULL WHERE clock_out IS NOT NULL AND clock_out !~ '^\d{4}-\d{2}-\d{2}T';
ALTER TABLE workforce.attendance_session
  ALTER COLUMN clock_in TYPE timestamptz USING clock_in::timestamptz,
  ALTER COLUMN clock_out TYPE timestamptz USING clock_out::timestamptz;
UPDATE workforce.attendance_session SET clock_out = NULL WHERE clock_out IS NOT NULL AND clock_out <= clock_in;
UPDATE workforce.attendance_session SET source = 'Self' WHERE source IS NULL OR source NOT IN ('Self', 'Supervisor', 'Auto-closed');
UPDATE workforce.attendance_session SET date = clock_in::date WHERE date IS NULL;
-- only the latest open session of a member stays open
UPDATE workforce.attendance_session s SET clock_out = s.clock_in + interval '1 minute', source = 'Auto-closed'
  WHERE s.clock_out IS NULL AND EXISTS (SELECT 1 FROM workforce.attendance_session o WHERE o.community_id = s.community_id AND o.member_id = s.member_id AND o.clock_out IS NULL AND o.clock_in > s.clock_in);
UPDATE workforce.attendance_session SET hours = round(extract(epoch FROM clock_out - clock_in) / 3600.0, 2) WHERE clock_out IS NOT NULL;
ALTER TABLE workforce.attendance_session
  ADD COLUMN IF NOT EXISTS corrected_by_id uuid,
  ADD COLUMN IF NOT EXISTS correction_note text,
  ALTER COLUMN member_id SET NOT NULL,
  ALTER COLUMN clock_in SET NOT NULL,
  ALTER COLUMN date SET NOT NULL,
  ALTER COLUMN source SET NOT NULL,
  ALTER COLUMN source SET DEFAULT 'Self',
  ADD CONSTRAINT attendance_member FOREIGN KEY (community_id, member_id) REFERENCES identity.membership (community_id, id),
  ADD CONSTRAINT attendance_times CHECK (clock_out IS NULL OR clock_out > clock_in),
  ADD CONSTRAINT attendance_hours CHECK ((clock_out IS NULL AND hours IS NULL) OR (clock_out IS NOT NULL AND hours IS NOT NULL AND hours >= 0)),
  ADD CONSTRAINT attendance_source CHECK (source IN ('Self', 'Supervisor', 'Auto-closed')),
  ADD CONSTRAINT attendance_corrected CHECK (source <> 'Supervisor' OR (corrected_by_id IS NOT NULL AND correction_note IS NOT NULL)),
  ADD CONSTRAINT attendance_late CHECK (late_min IS NULL OR late_min >= 0),
  ADD CONSTRAINT attendance_site CHECK ((in_site IS NULL OR in_site IN ('Inside site', 'Outside site', 'No location')) AND (out_site IS NULL OR out_site IN ('Inside site', 'Outside site', 'No location')));
CREATE UNIQUE INDEX IF NOT EXISTS attendance_one_open ON workforce.attendance_session (community_id, member_id) WHERE clock_out IS NULL;
CREATE INDEX IF NOT EXISTS attendance_by_member ON workforce.attendance_session (community_id, member_id, clock_in DESC);
CREATE INDEX IF NOT EXISTS attendance_by_date ON workforce.attendance_session (community_id, date);

DELETE FROM workforce.attendance_setting s USING workforce.attendance_setting o WHERE o.community_id = s.community_id AND o.created_at > s.created_at;
UPDATE workforce.attendance_setting SET enforcement = 'Record only (flag exceptions)' WHERE enforcement IS NULL
  OR enforcement NOT IN ('Record only (flag exceptions)', 'Require location', 'Require location inside the site');
ALTER TABLE workforce.attendance_setting
  ADD COLUMN IF NOT EXISTS shift_starts jsonb NOT NULL DEFAULT '{"Morning": "06:00", "Afternoon": "14:00", "General": "09:00"}',
  ADD COLUMN IF NOT EXISTS max_shift_hours numeric(4,1) NOT NULL DEFAULT 12,
  ALTER COLUMN enforcement SET NOT NULL,
  ALTER COLUMN enforcement SET DEFAULT 'Record only (flag exceptions)',
  ADD CONSTRAINT attendance_enforcement CHECK (enforcement IN ('Record only (flag exceptions)', 'Require location', 'Require location inside the site')),
  ADD CONSTRAINT attendance_site_values CHECK ((radius_m IS NULL OR radius_m BETWEEN 10 AND 20000) AND (grace_minutes IS NULL OR grace_minutes BETWEEN 0 AND 240)
                                               AND (site_lat IS NULL OR site_lat BETWEEN -90 AND 90) AND (site_lng IS NULL OR site_lng BETWEEN -180 AND 180)),
  ADD CONSTRAINT attendance_site_needed CHECK (enforcement <> 'Require location inside the site' OR (site_lat IS NOT NULL AND site_lng IS NOT NULL)),
  ADD CONSTRAINT attendance_shift_starts CHECK (jsonb_typeof(shift_starts) = 'object'),
  ADD CONSTRAINT attendance_max_hours CHECK (max_shift_hours BETWEEN 1 AND 24);
CREATE UNIQUE INDEX IF NOT EXISTS attendance_setting_one ON workforce.attendance_setting (community_id);

-- ---- the site's rules ---------------------------------------------------------------------------------------------------------------------
DELETE FROM workforce.site_holiday WHERE date IS NULL;
DELETE FROM workforce.site_holiday h USING workforce.site_holiday o WHERE o.community_id = h.community_id AND o.date = h.date AND o.created_at > h.created_at;
ALTER TABLE workforce.site_holiday
  ALTER COLUMN date SET NOT NULL,
  ADD CONSTRAINT holiday_trash CHECK (trash IS NULL OR trash IN ('No pickup', 'Pickup as usual', 'Rescheduled')),
  ADD CONSTRAINT holiday_rescheduled CHECK (trash IS DISTINCT FROM 'Rescheduled' OR trash_new_date IS NOT NULL),
  ADD CONSTRAINT holiday_workers CHECK (workers IS NULL OR workers IN ('Not allowed', 'Allowed as usual', 'Limited hours')),
  ADD CONSTRAINT holiday_hours CHECK (workers IS DISTINCT FROM 'Limited hours' OR (workers_from IS NOT NULL AND workers_to IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS holiday_one_a_day ON workforce.site_holiday (community_id, date);

ALTER TABLE workforce.site_service
  ADD CONSTRAINT service_mode CHECK (mode IS NULL OR mode IN ('Collection', 'Access')),
  ADD CONSTRAINT service_times CHECK ((start_time IS NULL OR start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') AND (end_time IS NULL OR end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'));
ALTER TABLE workforce.site_calendar_rule
  ADD CONSTRAINT calendar_repeat CHECK (repeat IS NULL OR repeat IN ('Weekly', 'One date', 'Date range')),
  ADD CONSTRAINT calendar_allowed CHECK (allowed IS NULL OR allowed IN ('Allowed', 'Not allowed')),
  ADD CONSTRAINT calendar_dates CHECK (end_date IS NULL OR date IS NULL OR end_date >= date);

-- ---- planned shifts: by field-staff id ------------------------------------------------------------------------------------------------------
DELETE FROM workforce.shift WHERE staff_id IS NULL OR date IS NULL OR NOT EXISTS (SELECT 1 FROM maintenance.field_staff f WHERE f.community_id = shift.community_id AND f.id = shift.staff_id);
DELETE FROM workforce.shift s USING workforce.shift o WHERE o.community_id = s.community_id AND o.staff_id = s.staff_id AND o.date = s.date AND o.created_at > s.created_at;
ALTER TABLE workforce.shift
  DROP COLUMN IF EXISTS staff_name,
  DROP COLUMN IF EXISTS trade,
  ALTER COLUMN staff_id SET NOT NULL,
  ALTER COLUMN date SET NOT NULL,
  ALTER COLUMN shift_type SET NOT NULL,
  ADD CONSTRAINT shift_staff FOREIGN KEY (community_id, staff_id) REFERENCES maintenance.field_staff (community_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT shift_type_text CHECK (length(shift_type) BETWEEN 1 AND 40);
CREATE UNIQUE INDEX IF NOT EXISTS shift_one_a_day ON workforce.shift (community_id, staff_id, date);

-- ---- a new community starts with its attendance setting ------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform.provision_workforce(p_community uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO workforce.attendance_setting (community_id, site_name, radius_m, grace_minutes) VALUES (p_community, 'Main gate', 300, 15)
  ON CONFLICT (community_id) DO NOTHING;
END $$;
CREATE OR REPLACE FUNCTION platform.provision_community(p_community uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM platform.provision_core(p_community);
  PERFORM platform.provision_maintenance(p_community);
  PERFORM platform.provision_finance(p_community);
  PERFORM platform.provision_amenities(p_community);
  PERFORM platform.provision_gate(p_community);
  PERFORM platform.provision_comms(p_community);
  PERFORM platform.provision_cultural(p_community);
  PERFORM platform.provision_ledger(p_community);
  PERFORM platform.provision_workforce(p_community);
END $$;
SELECT platform.provision_workforce(id) FROM platform.community;

SELECT platform.apply_security();
