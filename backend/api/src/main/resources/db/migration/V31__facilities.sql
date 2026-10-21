-- Facilities & locations are kept on the back end (the resource kit, /api/v1/property/facilities), with a note on each.
-- The kind is a short name: the app offers a list and a community may add its own (pump room, HT yard ...).
ALTER TABLE property.facility ADD COLUMN IF NOT EXISTS notes text CHECK (notes IS NULL OR length(notes) <= 2000);
ALTER TABLE property.facility DROP CONSTRAINT IF EXISTS facility_kind;
ALTER TABLE property.facility ADD CONSTRAINT facility_kind CHECK (length(kind) BETWEEN 1 AND 60);
