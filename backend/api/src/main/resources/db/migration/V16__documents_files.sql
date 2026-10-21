-- =====================================================================================================================================
-- V16 documents and files.
--   * a file's bytes live in object storage (the FileStorage port: a local folder in development, S3 / Azure Blob later); its metadata here
--   * a file is uploaded first (owned by its uploader, attached to nothing), then attached to exactly one thing: a ticket, a comment,
--     a quotation, a booking's deposit, a document - who may open it follows from the thing it is attached to
--   * a document is a file with a title, a group of readers, an optional unit and expiry, in a folder; folders may be limited to roles
--     (the limit holds for everything below them) - docs.folder_open() answers that for a caller's roles
-- =====================================================================================================================================

-- ---- files -----------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE docs.file_object
  ADD COLUMN IF NOT EXISTS uploaded_by_id uuid,
  ADD COLUMN IF NOT EXISTS attached_at timestamptz,
  ALTER COLUMN owner_type SET DEFAULT 'upload',
  ADD FOREIGN KEY (community_id, uploaded_by_id) REFERENCES identity.membership (community_id, id),
  ADD CONSTRAINT file_object_owner CHECK ((owner_type = 'upload') = (owner_id IS NULL)),
  ADD CONSTRAINT file_object_owner_kind CHECK (owner_type IN ('upload', 'maintenance.ticket', 'maintenance.comment', 'maintenance.quotation', 'amenity.booking', 'docs.document')),
  ADD CONSTRAINT file_object_mime CHECK (mime_type ~ '^[a-z]+/[a-z0-9.+-]{1,80}$');
COMMENT ON COLUMN docs.file_object.storage_key IS 'where the bytes are in the object store - made by the server, never reused, never shown to a client';

-- ---- folders ---------------------------------------------------------------------------------------------------------------------------------
UPDATE docs.folder SET name = 'Folder ' || short_id WHERE name IS NULL OR btrim(name) = '';
ALTER TABLE docs.folder
  ALTER COLUMN name SET NOT NULL,
  ADD CONSTRAINT folder_name CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  ADD CONSTRAINT folder_not_own_parent CHECK (parent_id IS DISTINCT FROM id);
CREATE UNIQUE INDEX IF NOT EXISTS folder_name_in_parent ON docs.folder (community_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

/** May someone with these role codes (EC: also 'group:EC') open this folder? Every folder above it must allow them too. */
CREATE OR REPLACE FUNCTION docs.folder_open(p_folder uuid, p_roles text[]) RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH RECURSIVE up AS (
    SELECT f.id, f.parent_id, f.access_roles, 1 AS depth FROM docs.folder f WHERE f.id = p_folder
    UNION ALL
    SELECT f.id, f.parent_id, f.access_roles, up.depth + 1 FROM docs.folder f JOIN up ON f.id = up.parent_id WHERE up.depth < 30)
  SELECT NOT EXISTS (SELECT 1 FROM up WHERE cardinality(up.access_roles) > 0 AND NOT (up.access_roles && p_roles))
$$;

-- ---- documents -------------------------------------------------------------------------------------------------------------------------------
UPDATE docs.document SET title = 'Document ' || short_id WHERE title IS NULL OR btrim(title) = '';
UPDATE docs.document SET access = 'Everyone' WHERE access IS NULL OR access IN ('All residents');
UPDATE docs.document SET access = 'All owners' WHERE access = 'Owners';
UPDATE docs.document SET access = 'Villa owner / resident' WHERE access = 'Restricted';
ALTER TABLE docs.document
  ADD COLUMN IF NOT EXISTS file_id uuid,
  ADD COLUMN IF NOT EXISTS edition text,
  ADD COLUMN IF NOT EXISTS uploaded_by_id uuid,
  ALTER COLUMN title SET NOT NULL,
  ALTER COLUMN access SET NOT NULL,
  ALTER COLUMN access SET DEFAULT 'Everyone',
  ADD FOREIGN KEY (community_id, file_id) REFERENCES docs.file_object (community_id, id),
  ADD FOREIGN KEY (community_id, uploaded_by_id) REFERENCES identity.membership (community_id, id),
  ADD CONSTRAINT document_title CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  ADD CONSTRAINT document_access CHECK (length(access) BETWEEN 2 AND 60),
  ADD CONSTRAINT document_unit CHECK (access <> 'Villa owner / resident' OR unit_id IS NOT NULL),
  ADD CONSTRAINT document_category CHECK (category IS NULL OR length(category) <= 60),
  ADD CONSTRAINT document_edition CHECK (edition IS NULL OR length(edition) <= 40);
CREATE UNIQUE INDEX IF NOT EXISTS document_one_file ON docs.document (community_id, file_id) WHERE file_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS document_by_folder ON docs.document (community_id, folder_id);
CREATE INDEX IF NOT EXISTS document_by_unit ON docs.document (community_id, unit_id) WHERE unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS document_expiring ON docs.document (community_id, expiry) WHERE expiry IS NOT NULL;

SELECT platform.apply_security();
