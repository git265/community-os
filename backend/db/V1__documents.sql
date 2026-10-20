-- One generic document table for EVERY collection (properties, dues, tickets, ...). A new collection or a new field in the
-- UI needs NO migration: the record is the JSONB `data` column. Tenancy is a column, so one database serves many communities.
-- This file is the single source of truth: Flyway runs it for the Spring Boot service (copied to
-- backend/spring/src/main/resources/db/migration) and contract-server/server.mjs runs it too.
CREATE TABLE IF NOT EXISTS documents (
  tenant      text        NOT NULL,                -- community slug, or 'platform' for the shared registry
  collection  text        NOT NULL,                -- 'properties', 'dues', 'tickets' ...
  id          text        NOT NULL,                -- the record id (a UUID string made by the app)
  data        jsonb       NOT NULL,                -- the whole record
  updated_at  timestamptz NOT NULL DEFAULT now(),
  seq         bigint      GENERATED ALWAYS AS IDENTITY,   -- insertion order, so an un-sorted list comes back in the order it was created
  PRIMARY KEY (tenant, collection, id)
);
CREATE INDEX IF NOT EXISTS documents_data_gin ON documents USING gin (data jsonb_path_ops);
CREATE INDEX IF NOT EXISTS documents_order    ON documents (tenant, collection, seq);
-- Add expression indexes for the columns your big lists filter on, e.g.:
--   CREATE INDEX documents_dues_status ON documents (tenant, (data->>'status')) WHERE collection = 'dues';
