-- =====================================================================================================================================
-- CommunityOS v2 schema · V1 foundation
--
-- Shape: one PostgreSQL database, one schema per bounded context, a real table for every object. Every tenant-owned row carries
-- community_id and is protected by row-level security (RLS): the application sets `app.community_id` / `app.user_id` with SET LOCAL at the
-- start of each transaction (TenantContext in the Spring service), and PostgreSQL itself refuses rows of any other community.
-- Audit columns (created_*, updated_*, version) and short numbers (TKT-1051) are stamped by triggers: whatever a request sends for them is
-- overwritten, so they cannot be forged even by a bug in the application.
--
-- Sizing target: 100 communities x 1 000 units (100 000 units, ~1.2 M bills and ~2.4 M ledger lines a year, ~10 M notifications and
-- ~18 M gate entries a year). Time-series tables are partitioned by month (see V8); everything else is indexed (community_id, ...).
-- =====================================================================================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;      -- gen_random_uuid(), digest()
CREATE EXTENSION IF NOT EXISTS citext;        -- case-insensitive e-mail

-- ---- database roles (create once per cluster; Flyway runs as cos_owner) ------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cos_app') THEN CREATE ROLE cos_app NOLOGIN; END IF;            -- the API: RLS applies
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cos_platform') THEN CREATE ROLE cos_platform NOLOGIN BYPASSRLS; END IF;   -- platform console, cross-community jobs
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cos_readonly') THEN CREATE ROLE cos_readonly NOLOGIN; END IF;   -- reporting replica users
END $$;

CREATE SCHEMA IF NOT EXISTS platform;
CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS property;
CREATE SCHEMA IF NOT EXISTS billing;
CREATE SCHEMA IF NOT EXISTS finance;
CREATE SCHEMA IF NOT EXISTS maintenance;
CREATE SCHEMA IF NOT EXISTS amenity;
CREATE SCHEMA IF NOT EXISTS gate;
CREATE SCHEMA IF NOT EXISTS comms;
CREATE SCHEMA IF NOT EXISTS governance;
CREATE SCHEMA IF NOT EXISTS cultural;
CREATE SCHEMA IF NOT EXISTS workforce;
CREATE SCHEMA IF NOT EXISTS assets;
CREATE SCHEMA IF NOT EXISTS docs;
CREATE SCHEMA IF NOT EXISTS vendor;
CREATE SCHEMA IF NOT EXISTS reports;
CREATE SCHEMA IF NOT EXISTS config;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS integration;

-- ---- request context ------------------------------------------------------------------------------------------------------------------------
-- Set by the API at the start of every transaction:  SET LOCAL app.community_id = '<uuid>';  SET LOCAL app.user_id = '<uuid>';
-- Not set => NULL => no tenant row is visible or writable (fail closed).
CREATE OR REPLACE FUNCTION platform.current_community() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.community_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION platform.current_actor() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

-- ---- server-stamped audit columns -------------------------------------------------------------------------------------------------------------
-- Every tenant table has: community_id, id, version, created_at, created_by, updated_at, updated_by. On INSERT the trigger sets created_* and
-- updated_* from the clock and the request context; on UPDATE it keeps id / community_id / created_* as stored and bumps version.
CREATE OR REPLACE FUNCTION platform.stamp_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    NEW.created_by := platform.current_actor();
    NEW.version    := 1;
  ELSE
    NEW.id           := OLD.id;
    NEW.community_id := OLD.community_id;
    NEW.created_at   := OLD.created_at;
    NEW.created_by   := OLD.created_by;
    NEW.version      := OLD.version + 1;
  END IF;
  NEW.updated_at := now();
  NEW.updated_by := platform.current_actor();
  RETURN NEW;
END $$;

-- ---- short numbers people quote (TKT-1051, DUE-0007): one counter row per community and kind, taken inside the inserting transaction ---------
CREATE TABLE IF NOT EXISTS platform.short_id_counter (
  community_id uuid   NOT NULL,
  kind         text   NOT NULL,
  last_value   bigint NOT NULL,
  PRIMARY KEY (community_id, kind)
);
-- usage: CREATE TRIGGER ... BEFORE INSERT ... EXECUTE FUNCTION platform.stamp_short_id('TKT', '1050', '0')
--   arg 1 prefix, arg 2 first value - 1, arg 3 zero padding width (0 = none)
CREATE OR REPLACE FUNCTION platform.stamp_short_id() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n bigint; prefix text := TG_ARGV[0]; base bigint := COALESCE(TG_ARGV[1], '0')::bigint; pad int := COALESCE(TG_ARGV[2], '4')::int;
BEGIN
  INSERT INTO platform.short_id_counter AS c (community_id, kind, last_value) VALUES (NEW.community_id, prefix, base + 1)
  ON CONFLICT (community_id, kind) DO UPDATE SET last_value = c.last_value + 1
  RETURNING last_value INTO n;
  NEW.short_id := prefix || '-' || CASE WHEN pad > 0 AND length(n::text) < pad THEN lpad(n::text, pad, '0') ELSE n::text END;   -- lpad would cut 10000 to 1000
  RETURN NEW;
END $$;
-- a short number never changes once given
CREATE OR REPLACE FUNCTION platform.keep_short_id() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.short_id := OLD.short_id; RETURN NEW; END $$;

-- =====================================================================================================================================
-- platform: the communities themselves (not tenant-scoped; read through the platform role or by id)
-- =====================================================================================================================================
CREATE TABLE IF NOT EXISTS platform.community (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text        NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name          text        NOT NULL CHECK (length(name) BETWEEN 2 AND 200),
  legal_name    text,
  region_code   text        NOT NULL DEFAULT 'IN' CHECK (region_code ~ '^[A-Z]{2}$'),
  currency      char(3)     NOT NULL DEFAULT 'INR',
  time_zone     text        NOT NULL DEFAULT 'Asia/Kolkata',
  fy_start_month smallint   NOT NULL DEFAULT 4 CHECK (fy_start_month BETWEEN 1 AND 12),
  status        text        NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Suspended', 'Closed')),
  plan          text        NOT NULL DEFAULT 'Standard',
  unit_limit    integer     NOT NULL DEFAULT 1000 CHECK (unit_limit > 0),
  custom        jsonb       NOT NULL DEFAULT '{}',
  version       bigint      NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- one row per community: what used to be communityConfig (legal details, tax registration, statement texts ...)
CREATE TABLE IF NOT EXISTS platform.community_settings (
  community_id     uuid        NOT NULL REFERENCES platform.community (id) ON DELETE CASCADE,
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  registration_no  text,
  pan_no           text,
  tax_registered   boolean     NOT NULL DEFAULT true,
  tax_id           text,
  address          text,
  contact_phone    text,
  contact_email    citext,
  website          text,
  signatory        text,
  pay_instructions text,
  statement_note   text,
  property_types   text[]      NOT NULL DEFAULT ARRAY['Villa', 'Apartment'],
  custom           jsonb       NOT NULL DEFAULT '{}',
  version          bigint      NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  PRIMARY KEY (community_id, id),
  UNIQUE (community_id)
);
