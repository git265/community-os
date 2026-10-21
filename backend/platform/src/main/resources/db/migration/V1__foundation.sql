-- =====================================================================================================================================
-- CommunityOS platform schema v2 - foundation
--
-- Conventions (every migration follows them):
--   * One table per business object. Known fields are real, typed columns with constraints; fields a community adds in Studio live in
--     `custom jsonb` (always a JSON object) and are validated by the application against custom_field_defs.
--   * Multi-tenant, shared tables: every community-owned row carries community_id. PostgreSQL row-level security (V90) limits every query
--     to the community set for the current transaction (app.community_id), so a missing WHERE clause can never leak another community.
--   * Primary keys are UUIDs. Every community table also has UNIQUE (community_id, id) so that references are composite foreign keys:
--     a bill can only point at a unit OF THE SAME community.
--   * created_at / created_by / updated_at / updated_by / version are set by triggers from the transaction's settings (app.user_id),
--     never by the request: a client cannot forge who changed a record or when.
--   * version is the optimistic-locking counter (ETag / If-Match on the API).
--   * Money is numeric(14,2) with explicit sign checks; currencies are ISO 4217 codes.
--   * Status columns are CHECK-constrained to the states the code knows; configurable vocabularies are reference tables, not free text.
-- =====================================================================================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid(), digest()
CREATE EXTENSION IF NOT EXISTS citext;       -- case-insensitive e-mail / slug
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- exclusion constraints (no double booking)
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- fast "contains" search on names

-- ---- request context -----------------------------------------------------------------------------------------------------------------
-- The application sets these with set_config(..., true) as the first statement of every transaction (TenantContextDataSource).
CREATE OR REPLACE FUNCTION app_community() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.community_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_user() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

-- ---- server-owned row metadata ---------------------------------------------------------------------------------------------------------
-- BEFORE INSERT: stamp created_* / updated_*, version 0. BEFORE UPDATE: keep created_*, stamp updated_*, version + 1.
-- Whatever the statement supplied for these columns is overwritten.
CREATE OR REPLACE FUNCTION stamp_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now(); NEW.created_by := app_user();
    NEW.updated_at := now(); NEW.updated_by := app_user();
    NEW.version := 0;
  ELSE
    NEW.created_at := OLD.created_at; NEW.created_by := OLD.created_by;
    NEW.updated_at := now(); NEW.updated_by := app_user();
    NEW.version := OLD.version + 1;
    IF NEW.community_id IS DISTINCT FROM OLD.community_id THEN RAISE EXCEPTION 'a record cannot move to another community' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  RETURN NEW;
END $$;

-- Attach the standard metadata trigger to a table (used by every migration).
CREATE OR REPLACE FUNCTION use_row_stamps(t regclass) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS stamp_row ON %s', t);
  EXECUTE format('CREATE TRIGGER stamp_row BEFORE INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION stamp_row()', t);
END $$;

-- Rows that are history must never change (audit, journal lines, status history ...).
CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege'; END $$;

-- ---- communities (the tenants) ---------------------------------------------------------------------------------------------------------
CREATE TABLE communities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name          text   NOT NULL CHECK (length(name) BETWEEN 2 AND 200),
  legal_name    text,
  country_code  char(2) NOT NULL DEFAULT 'IN' CHECK (country_code ~ '^[A-Z]{2}$'),
  currency      char(3) NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  time_zone     text   NOT NULL DEFAULT 'Asia/Kolkata',
  fy_start_month smallint NOT NULL DEFAULT 4 CHECK (fy_start_month BETWEEN 1 AND 12),
  tax_id        text,
  status        text   NOT NULL DEFAULT 'Active' CHECK (status IN ('Provisioning', 'Active', 'Suspended', 'Closed')),
  books_locked_until date,                                  -- closed accounting period: postings on or before it are refused
  settings      jsonb  NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(settings) = 'object'),
  custom        jsonb  NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(custom) = 'object'),
  -- standard metadata (communities are platform rows: community_id is the row itself)
  community_id  uuid GENERATED ALWAYS AS (id) STORED,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version integer NOT NULL DEFAULT 0
);
CREATE OR REPLACE FUNCTION stamp_community() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN NEW.created_at := now(); NEW.created_by := app_user(); NEW.version := 0;
  ELSE NEW.created_at := OLD.created_at; NEW.created_by := OLD.created_by; NEW.version := OLD.version + 1; END IF;
  NEW.updated_at := now(); NEW.updated_by := app_user();
  RETURN NEW;
END $$;
CREATE TRIGGER stamp_row BEFORE INSERT OR UPDATE ON communities FOR EACH ROW EXECUTE FUNCTION stamp_community();

-- ---- human-facing numbers (TKT-1058, BIL-000231): one counter row per community and series, taken with UPDATE ... RETURNING -------------
CREATE TABLE number_series (
  community_id uuid   NOT NULL REFERENCES communities (id),
  series       text   NOT NULL CHECK (series ~ '^[A-Z]{2,5}$'),
  last_value   bigint NOT NULL DEFAULT 0 CHECK (last_value >= 0),
  PRIMARY KEY (community_id, series)
);
CREATE OR REPLACE FUNCTION next_number(c uuid, s text, start_at bigint DEFAULT 0) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  INSERT INTO number_series (community_id, series, last_value) VALUES (c, s, start_at + 1)
  ON CONFLICT (community_id, series) DO UPDATE SET last_value = number_series.last_value + 1
  RETURNING last_value INTO v;
  RETURN v;
END $$;

-- ---- audit trail: append-only, one partition per month ---------------------------------------------------------------------------------
CREATE TABLE audit_events (
  community_id uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  actor_label  text        NOT NULL,                       -- "Tia Treasurer (Treasurer)" as it was at the time
  action       text        NOT NULL CHECK (action IN ('Create', 'Update', 'Delete', 'Denied', 'Sign-in', 'Sign-out', 'Export', 'Approve', 'Reject', 'Post', 'Reverse')),
  resource     text        NOT NULL,                       -- 'bills', 'tickets' ...
  resource_id  uuid,
  resource_no  text,                                       -- the number people quote
  unit_id      uuid,
  summary      text        NOT NULL DEFAULT '' CHECK (length(summary) <= 2000),
  changes      jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(changes) = 'array'),   -- [{field, from, to}] with secrets redacted
  ip           inet,
  request_id   text,
  PRIMARY KEY (community_id, occurred_at, id)
) PARTITION BY RANGE (occurred_at);
CREATE TABLE audit_events_default PARTITION OF audit_events DEFAULT;
CREATE INDEX audit_events_resource ON audit_events (community_id, resource, resource_id, occurred_at DESC);
CREATE INDEX audit_events_unit ON audit_events (community_id, unit_id, occurred_at DESC) WHERE unit_id IS NOT NULL;
CREATE INDEX audit_events_actor ON audit_events (community_id, actor_user_id, occurred_at DESC);
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Monthly partitions for any range (called at start-up and daily by the scheduler, so next month always exists).
CREATE OR REPLACE FUNCTION ensure_month_partitions(parent regclass, from_month date, to_month date) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE m date := date_trunc('month', from_month)::date; made integer := 0; nm date; part text;
BEGIN
  WHILE m <= date_trunc('month', to_month)::date LOOP
    nm := (m + interval '1 month')::date;
    part := format('%s_%s', parent::text, to_char(m, 'YYYY_MM'));
    IF to_regclass(part) IS NULL THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)', part, parent, m, nm);
      made := made + 1;
    END IF;
    m := nm;
  END LOOP;
  RETURN made;
END $$;
SELECT ensure_month_partitions('audit_events', (current_date - interval '24 months')::date, (current_date + interval '3 months')::date);

-- ---- transactional outbox: integration events written in the same transaction as the change, published after commit -----------------
CREATE TABLE outbox_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  community_id    uuid        NOT NULL REFERENCES communities (id),
  event_id        uuid        NOT NULL DEFAULT gen_random_uuid() UNIQUE,   -- consumers de-duplicate on it
  aggregate_type  text        NOT NULL,
  aggregate_id    uuid        NOT NULL,
  event_type      text        NOT NULL,                       -- 'bill.issued', 'payment.settled', 'ticket.assigned' ...
  payload         jsonb       NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  status          text        NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Published', 'Dead')),
  attempts        integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  published_at    timestamptz
);
CREATE INDEX outbox_due ON outbox_events (next_attempt_at) WHERE status = 'Pending';
CREATE INDEX outbox_aggregate ON outbox_events (community_id, aggregate_type, aggregate_id);

-- ---- inbox: events and webhooks received from outside, recorded once (exactly-once processing on at-least-once delivery) ------------
CREATE TABLE inbox_messages (
  source        text        NOT NULL,                         -- 'razorpay', 'stripe', 'whatsapp' ...
  message_id    text        NOT NULL,
  community_id  uuid        REFERENCES communities (id),
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  payload_hash  bytea       NOT NULL,
  PRIMARY KEY (source, message_id)
);

-- ---- idempotency keys: a retried POST returns the first answer instead of running twice -----------------------------------------------
CREATE TABLE idempotency_keys (
  community_id    uuid        NOT NULL REFERENCES communities (id),
  user_id         uuid        NOT NULL,
  idem_key        text        NOT NULL CHECK (length(idem_key) BETWEEN 8 AND 128),
  request_hash    bytea       NOT NULL,                       -- method + path + body: the same key for a different request is refused
  state           text        NOT NULL DEFAULT 'InFlight' CHECK (state IN ('InFlight', 'Done')),
  response_status smallint,
  response_body   bytea,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (community_id, user_id, idem_key)
);
CREATE INDEX idempotency_expiry ON idempotency_keys (expires_at);
