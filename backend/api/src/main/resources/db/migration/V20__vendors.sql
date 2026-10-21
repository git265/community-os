-- =====================================================================================================================================
-- V20 vendors and the community's service directory:
--   * a vendor has a name (unique), a category and contract type from the lists, a well-formed GSTIN / e-mail; its papers are attached files
--   * a service line names its vendor by id (no longer by name), with a number of workers that is not negative
--   * a discussion comment is on a vendor, by someone, never empty
--   * a directory contact has a name and a status; who added it and from which unit are the server's
--   * a review is 1 to 5 stars on a contact, one per unit (a resident) or per person (staff), by its author
-- =====================================================================================================================================

-- ---- vendors ---------------------------------------------------------------------------------------------------------------------------
UPDATE vendor.vendor SET name = '(unnamed vendor)' WHERE name IS NULL OR btrim(name) = '';
UPDATE vendor.vendor SET category = 'Other' WHERE category IS NOT NULL AND category NOT IN ('Facilities Management', 'Maintenance', 'Security', 'Landscaping', 'Utilities', 'Cleaning',
  'Lift / AMC', 'Audit / inspection agency', 'Other');
UPDATE vendor.vendor SET contract_type = NULL WHERE contract_type IS NOT NULL AND contract_type NOT IN ('Contract', 'AMC', 'Local / no contract');
UPDATE vendor.vendor SET gstin = upper(btrim(gstin)) WHERE gstin IS NOT NULL;
UPDATE vendor.vendor SET gstin = NULL WHERE gstin = '';
ALTER TABLE vendor.vendor
  DROP COLUMN IF EXISTS attachments,
  ALTER COLUMN name SET NOT NULL,
  ADD CONSTRAINT vendor_name CHECK (length(name) BETWEEN 1 AND 200),
  ADD CONSTRAINT vendor_category CHECK (category IS NULL OR category IN ('Facilities Management', 'Maintenance', 'Security', 'Landscaping', 'Utilities', 'Cleaning', 'Lift / AMC',
                                                                        'Audit / inspection agency', 'Other')),
  ADD CONSTRAINT vendor_contract CHECK (contract_type IS NULL OR contract_type IN ('Contract', 'AMC', 'Local / no contract')),
  ADD CONSTRAINT vendor_gstin CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$'),
  ADD CONSTRAINT vendor_email CHECK (contact_email IS NULL OR contact_email = '' OR contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  ADD CONSTRAINT vendor_text CHECK (length(coalesce(description, '')) <= 20000 AND length(coalesce(address, '')) <= 1000);
CREATE UNIQUE INDEX IF NOT EXISTS vendor_name_once ON vendor.vendor (community_id, lower(name));

-- ---- service lines: by vendor id ---------------------------------------------------------------------------------------------------------
ALTER TABLE vendor.service_line ADD COLUMN IF NOT EXISTS vendor_id uuid;
UPDATE vendor.service_line s SET vendor_id = v.id FROM vendor.vendor v WHERE v.community_id = s.community_id AND lower(v.name) = lower(s.vendor_name) AND s.vendor_id IS NULL;
DELETE FROM vendor.service_line WHERE vendor_id IS NULL;
ALTER TABLE vendor.service_line
  DROP COLUMN IF EXISTS vendor_name,
  ALTER COLUMN vendor_id SET NOT NULL,
  ALTER COLUMN signed_workers TYPE integer USING round(signed_workers)::integer,
  ADD CONSTRAINT service_line_vendor FOREIGN KEY (community_id, vendor_id) REFERENCES vendor.vendor (community_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT service_line_service CHECK (service IS NOT NULL AND length(service) BETWEEN 1 AND 80),
  ADD CONSTRAINT service_line_workers CHECK (signed_workers IS NULL OR signed_workers >= 0);
CREATE INDEX IF NOT EXISTS service_line_by_vendor ON vendor.service_line (community_id, vendor_id);

-- ---- discussion ----------------------------------------------------------------------------------------------------------------------------
DELETE FROM vendor.comment WHERE vendor_id IS NULL OR body IS NULL OR btrim(body) = '';
ALTER TABLE vendor.comment
  ALTER COLUMN vendor_id SET NOT NULL,
  ALTER COLUMN body SET NOT NULL,
  ADD CONSTRAINT comment_vendor FOREIGN KEY (community_id, vendor_id) REFERENCES vendor.vendor (community_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT comment_body CHECK (length(body) BETWEEN 1 AND 20000);
CREATE INDEX IF NOT EXISTS comment_by_vendor ON vendor.comment (community_id, vendor_id, created_at);

-- ---- the directory ---------------------------------------------------------------------------------------------------------------------------
UPDATE vendor.service_contact SET status = 'Active' WHERE status IS NULL OR status NOT IN ('Active', 'Hidden');
UPDATE vendor.service_contact SET name = '(unnamed)' WHERE name IS NULL OR btrim(name) = '';
ALTER TABLE vendor.service_contact
  ADD COLUMN IF NOT EXISTS added_by_unit_id uuid,
  ADD COLUMN IF NOT EXISTS hidden_by_id uuid,
  ADD COLUMN IF NOT EXISTS hidden_reason text,
  DROP COLUMN IF EXISTS added_by_unit,
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'Active',
  ADD CONSTRAINT contact_name CHECK (length(name) BETWEEN 1 AND 120),
  ADD CONSTRAINT contact_status CHECK (status IN ('Active', 'Hidden')),
  ADD CONSTRAINT contact_hidden CHECK (status = 'Active' OR hidden_by_id IS NOT NULL),
  ADD CONSTRAINT contact_phone CHECK (phone IS NULL OR phone ~ '^\+?[0-9 ()-]{6,20}$'),
  ADD CONSTRAINT contact_text CHECK (length(coalesce(notes, '')) <= 4000 AND length(coalesce(rate, '')) <= 120 AND length(coalesce(area, '')) <= 120 AND length(coalesce(category, '')) <= 80),
  ADD CONSTRAINT contact_unit FOREIGN KEY (community_id, added_by_unit_id) REFERENCES property.unit (community_id, id);

DELETE FROM vendor.contact_review WHERE contact_id IS NULL OR author_id IS NULL OR rating IS NULL OR rating < 1 OR rating > 5;
DELETE FROM vendor.contact_review r USING vendor.contact_review o
  WHERE o.community_id = r.community_id AND o.contact_id = r.contact_id AND o.author_id = r.author_id AND o.created_at > r.created_at;
ALTER TABLE vendor.contact_review
  ALTER COLUMN contact_id SET NOT NULL,
  ALTER COLUMN author_id SET NOT NULL,
  ALTER COLUMN rating TYPE integer USING round(rating)::integer,
  ALTER COLUMN rating SET NOT NULL,
  ADD CONSTRAINT review_contact FOREIGN KEY (community_id, contact_id) REFERENCES vendor.service_contact (community_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT review_unit FOREIGN KEY (community_id, unit_id) REFERENCES property.unit (community_id, id),
  ADD CONSTRAINT review_rating CHECK (rating BETWEEN 1 AND 5),
  ADD CONSTRAINT review_recommend CHECK (recommend IS NULL OR recommend IN ('Yes', 'No')),
  ADD CONSTRAINT review_comment CHECK (length(coalesce(comment, '')) <= 4000);
CREATE UNIQUE INDEX IF NOT EXISTS review_once_per_person ON vendor.contact_review (community_id, contact_id, author_id);
CREATE UNIQUE INDEX IF NOT EXISTS review_once_per_unit ON vendor.contact_review (community_id, contact_id, unit_id) WHERE unit_id IS NOT NULL;

ALTER TABLE docs.file_object DROP CONSTRAINT IF EXISTS file_object_owner_kind,
  ADD CONSTRAINT file_object_owner_kind CHECK (owner_type IN ('upload', 'maintenance.ticket', 'maintenance.comment', 'maintenance.quotation', 'amenity.booking', 'docs.document',
                                                              'cultural.photo', 'cultural.brochure', 'governance.agenda', 'governance.minutes', 'vendor.vendor'));

SELECT platform.apply_security();
