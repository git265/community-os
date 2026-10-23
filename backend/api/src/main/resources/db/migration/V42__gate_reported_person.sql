-- =====================================================================================================================================
-- V42 gate: a unit can report a household worker to security. The report is a flag ('Reported person') that stays open until security
-- closes it; each time the worker comes to the gate meanwhile, another one (tied to that visit) tells security again.
-- =====================================================================================================================================
ALTER TABLE gate.flag DROP CONSTRAINT IF EXISTS flag_type,
  ADD CONSTRAINT flag_type CHECK (type IN ('Unrecorded entry', 'Tailgate', 'Override entry', 'Identity mismatch', 'Wrong destination', 'Overstay', 'Blocked person attempt',
                                           'Guard silence', 'Headcount mismatch', 'Manual open', 'Missed patrol', 'Reported person'));
CREATE INDEX IF NOT EXISTS flag_open_reports ON gate.flag (community_id, person_id) WHERE type = 'Reported person' AND state <> 'Closed' AND visit_id IS NULL;
