-- =====================================================================================================================================
-- V43 patrol location: each post can be pinned (latitude, longitude, how far from it still counts as at the post); each scan keeps the
-- phone's GPS, its accuracy, the distance from the post and what that means. A scan away from its post, with the location turned off, or
-- two posts scanned from the same spot raise a 'Patrol location' flag.
-- =====================================================================================================================================
ALTER TABLE gate.checkpoint
  ADD COLUMN IF NOT EXISTS lat numeric(9,6),
  ADD COLUMN IF NOT EXISTS lng numeric(9,6),
  ADD COLUMN IF NOT EXISTS radius_m integer,
  ADD CONSTRAINT checkpoint_place CHECK ((lat IS NULL) = (lng IS NULL) AND (lat IS NULL OR (lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180))
                                        AND (radius_m IS NULL OR radius_m BETWEEN 10 AND 500));
ALTER TABLE gate.scan
  ADD COLUMN IF NOT EXISTS lat numeric(9,6),
  ADD COLUMN IF NOT EXISTS lng numeric(9,6),
  ADD COLUMN IF NOT EXISTS acc_m integer,
  ADD COLUMN IF NOT EXISTS dist_m integer,
  ADD COLUMN IF NOT EXISTS place text,
  ADD CONSTRAINT scan_place CHECK (place IS NULL OR place IN ('At the post', 'Away from the post', 'Weak signal', 'No location', 'Location off', 'Post not mapped')),
  ADD CONSTRAINT scan_gps CHECK ((lat IS NULL) = (lng IS NULL) AND coalesce(acc_m, 0) >= 0 AND coalesce(dist_m, 0) >= 0);
ALTER TABLE gate.flag DROP CONSTRAINT IF EXISTS flag_type,
  ADD CONSTRAINT flag_type CHECK (type IN ('Unrecorded entry', 'Tailgate', 'Override entry', 'Identity mismatch', 'Wrong destination', 'Overstay', 'Blocked person attempt',
                                           'Guard silence', 'Headcount mismatch', 'Manual open', 'Missed patrol', 'Reported person', 'Patrol location'));
