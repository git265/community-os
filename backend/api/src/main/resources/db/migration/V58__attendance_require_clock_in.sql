-- "Staff must clock in to use the portal" is kept with the community's attendance setting (it was only in the browser).
ALTER TABLE workforce.attendance_setting ADD COLUMN IF NOT EXISTS require_clock_in boolean NOT NULL DEFAULT true;
