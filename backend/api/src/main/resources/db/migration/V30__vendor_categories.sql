-- One vendor, several categories: each service line is one category the vendor handles (Security, Housekeeping, Landscaping ...) with its own
-- head count, split into the vendor's own employees (signed_workers) and the sub-contractors they bring (contractors). The gate registry and the
-- fixed monthly expenses can name the line a person or a commitment belongs to, so attendance and cost are counted per category.
ALTER TABLE vendor.service_line ADD COLUMN IF NOT EXISTS contractors integer CHECK (contractors IS NULL OR contractors >= 0);
ALTER TABLE gate.person          ADD COLUMN IF NOT EXISTS vendor_service text CHECK (vendor_service IS NULL OR length(vendor_service) BETWEEN 1 AND 80);
ALTER TABLE finance.fixed_expense ADD COLUMN IF NOT EXISTS vendor_service text CHECK (vendor_service IS NULL OR length(vendor_service) BETWEEN 1 AND 80);
-- a vendor names a category once
CREATE UNIQUE INDEX IF NOT EXISTS service_line_once ON vendor.service_line (community_id, vendor_id, lower(service));

