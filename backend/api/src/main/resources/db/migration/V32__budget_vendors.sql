-- A budget expense line can be for one vendor and one of its categories (SecureFirst · Security): payments to that vendor in that category
-- count against it, so the forecast is followed per vendor category.
ALTER TABLE finance.budget_line ADD COLUMN IF NOT EXISTS vendor text CHECK (vendor IS NULL OR length(vendor) BETWEEN 1 AND 200);
ALTER TABLE finance.budget_line ADD COLUMN IF NOT EXISTS vendor_service text CHECK (vendor_service IS NULL OR length(vendor_service) BETWEEN 1 AND 80);
ALTER TABLE finance.budget_line DROP CONSTRAINT IF EXISTS budget_line_vendor_service;
ALTER TABLE finance.budget_line ADD CONSTRAINT budget_line_vendor_service CHECK (vendor_service IS NULL OR vendor IS NOT NULL);
CREATE INDEX IF NOT EXISTS budget_line_by_vendor ON finance.budget_line (community_id, lower(vendor)) WHERE vendor IS NOT NULL;
