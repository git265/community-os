-- Chairs, tables, cloths ... can be booked on their own: an amenity whose reservation is "Items only (no space)" reserves no space (any number
-- of units book it the same day) and must name items; the items are one stock for the community, shared by every booking that day.
ALTER TABLE amenity.amenity_type DROP CONSTRAINT IF EXISTS amenity_type_reservation;
ALTER TABLE amenity.amenity_type ADD CONSTRAINT amenity_type_reservation
  CHECK (reservation IS NULL OR reservation IN ('Reservation required', 'Walk-in (no reservation)', 'Items only (no space)'));
