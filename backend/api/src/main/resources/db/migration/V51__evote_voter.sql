-- =====================================================================================================================================
-- V51 E-vote number: each unit votes through one owner - the primary owner, unless an admin picks another of its owners. Only that owner is on
-- a ballot's roll for the unit, and the one-time code goes to their mobile. The owner leaving the unit ends the choice (back to the primary).
-- =====================================================================================================================================
ALTER TABLE property.unit ADD COLUMN IF NOT EXISTS evote_occupant_id uuid;
ALTER TABLE property.unit DROP CONSTRAINT IF EXISTS unit_evote_occupant;
ALTER TABLE property.unit ADD CONSTRAINT unit_evote_occupant FOREIGN KEY (community_id, evote_occupant_id)
  REFERENCES property.occupant (community_id, id) ON DELETE SET NULL (evote_occupant_id);

SELECT platform.apply_security();
