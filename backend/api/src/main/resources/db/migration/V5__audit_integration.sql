-- =====================================================================================================================================
-- V5 audit trail and integration plumbing
--   audit.audit_event         append-only, partitioned by month; nobody (not even the application role) can update or delete a row
--   integration.outbox_event  domain events written in the same transaction as the change; a relay delivers them (at-least-once)
--   integration.inbound_event provider webhooks seen, so a repeated delivery is ignored (idempotent consumer)
--   integration.idempotency_key  Idempotency-Key header: a retried POST returns the first answer instead of running twice
--   integration.api_client / webhook_subscription / webhook_delivery  for future integrations (machine clients, outgoing webhooks)
-- =====================================================================================================================================

CREATE TABLE IF NOT EXISTS audit.audit_event (
  community_id  uuid        NOT NULL,
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  at            timestamptz NOT NULL DEFAULT now(),
  short_id      text,
  actor_id      uuid,                                   -- membership id (NULL = system job)
  actor_label   text        NOT NULL,                   -- "Tia Treasurer (Treasurer)" as it was at the time
  action        text        NOT NULL CHECK (action IN ('Create', 'Update', 'Delete', 'Denied', 'Sign-in', 'Sign-out', 'Export', 'System')),
  entity        text        NOT NULL,                   -- billing.due, maintenance.ticket ...
  entity_id     uuid,
  entity_short_id text,
  unit_id       uuid,
  summary       text        NOT NULL CHECK (length(summary) <= 2000),
  changes       jsonb       NOT NULL DEFAULT '[]',      -- [{field, label, from, to}] with secrets redacted
  ip            inet,
  request_id    text,
  user_agent    text,
  PRIMARY KEY (community_id, at, id)
) PARTITION BY RANGE (at);
CREATE TABLE IF NOT EXISTS audit.audit_event_default PARTITION OF audit.audit_event DEFAULT;
CREATE INDEX IF NOT EXISTS audit_time   ON audit.audit_event (community_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_entity ON audit.audit_event (community_id, entity, entity_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_unit   ON audit.audit_event (community_id, unit_id, at DESC) WHERE unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_actor  ON audit.audit_event (community_id, actor_id, at DESC);

CREATE OR REPLACE FUNCTION audit.append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'the audit trail is append-only' USING ERRCODE = '42501'; END $$;
-- the time and the actor of an audit line are the server's, like every other row
CREATE OR REPLACE FUNCTION audit.stamp_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.at := now(); NEW.actor_id := COALESCE(platform.current_actor(), NEW.actor_id); RETURN NEW; END $$;

-- ---- outbox (transactional) ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integration.outbox_event (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  community_id    uuid        NOT NULL,
  event_id        uuid        NOT NULL DEFAULT gen_random_uuid() UNIQUE,   -- consumers de-duplicate on this
  topic           text        NOT NULL CHECK (topic ~ '^[a-z]+(\.[a-z-]+)+$'),     -- billing.due.paid, maintenance.ticket.assigned ...
  aggregate_type  text        NOT NULL,
  aggregate_id    uuid        NOT NULL,
  payload         jsonb       NOT NULL,
  headers         jsonb       NOT NULL DEFAULT '{}',
  status          text        NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Sent', 'Dead')),
  attempts        integer     NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_due ON integration.outbox_event (next_attempt_at) WHERE status = 'Pending';
CREATE INDEX IF NOT EXISTS outbox_aggregate ON integration.outbox_event (community_id, aggregate_type, aggregate_id);

CREATE TABLE IF NOT EXISTS integration.inbound_event (
  provider     text        NOT NULL,
  event_id     text        NOT NULL,
  community_id uuid,
  type         text        NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  PRIMARY KEY (provider, event_id)
);

CREATE TABLE IF NOT EXISTS integration.idempotency_key (
  community_id    uuid        NOT NULL,
  principal_id    uuid        NOT NULL,                -- a key only means something for the caller who sent it
  key             text        NOT NULL CHECK (length(key) BETWEEN 8 AND 128),
  request_hash    bytea       NOT NULL,                -- method + path + body: the same key with a different request is refused (422)
  state           text        NOT NULL DEFAULT 'InFlight' CHECK (state IN ('InFlight', 'Done')),
  response_status smallint,
  response_body   bytea,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, principal_id, key)
);
CREATE INDEX IF NOT EXISTS idempotency_created ON integration.idempotency_key (created_at);

-- ---- future integrations ------------------------------------------------------------------------------------------------------------------
-- machine clients (an accounting package, a gate terminal, MyGate) use OAuth2 client credentials with these scopes
CREATE TABLE IF NOT EXISTS integration.api_client (
  community_id  uuid        NOT NULL REFERENCES platform.community (id) ON DELETE CASCADE,
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  name          text        NOT NULL,
  client_id     text        NOT NULL UNIQUE,
  secret_hash   bytea       NOT NULL,                  -- Argon2/bcrypt of the client secret
  scopes        text[]      NOT NULL CHECK (cardinality(scopes) > 0),
  allowed_ips   cidr[]      NOT NULL DEFAULT '{}',
  active        boolean     NOT NULL DEFAULT true,
  last_used_at  timestamptz,
  version       bigint      NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  PRIMARY KEY (community_id, id)
);
-- outgoing webhooks: a community subscribes an external system to topics; each delivery is signed (HMAC-SHA256) and retried with backoff
CREATE TABLE IF NOT EXISTS integration.webhook_subscription (
  community_id  uuid        NOT NULL REFERENCES platform.community (id) ON DELETE CASCADE,
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  url           text        NOT NULL CHECK (url ~ '^https://'),
  topics        text[]      NOT NULL CHECK (cardinality(topics) > 0),
  secret_ref    text        NOT NULL,                  -- name of the secret in the vault, never the secret itself
  active        boolean     NOT NULL DEFAULT true,
  version       bigint      NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  PRIMARY KEY (community_id, id)
);
CREATE TABLE IF NOT EXISTS integration.webhook_delivery (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  community_id    uuid        NOT NULL,
  subscription_id uuid        NOT NULL,
  event_id        uuid        NOT NULL,
  status          text        NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Delivered', 'Dead')),
  attempts        integer     NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  response_status smallint,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, event_id),
  FOREIGN KEY (community_id, subscription_id) REFERENCES integration.webhook_subscription (community_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS webhook_delivery_due ON integration.webhook_delivery (next_attempt_at) WHERE status = 'Pending';

-- ---- files: metadata here, bytes in object storage (S3 / Azure Blob); the key is server-made and never reused -----------------------------
CREATE TABLE IF NOT EXISTS docs.file_object (
  community_id  uuid        NOT NULL REFERENCES platform.community (id),
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  short_id      text,
  owner_type    text        NOT NULL CHECK (owner_type ~ '^[a-z][a-zA-Z.]{1,60}$'),   -- what it is attached to: maintenance.ticket, docs.document ...
  owner_id      uuid,
  file_name     text        NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255 AND file_name !~ '[/\\]'),
  mime_type     text        NOT NULL,
  size_bytes    bigint      NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 26214400),
  sha256        bytea       NOT NULL CHECK (octet_length(sha256) = 32),
  storage_key   text        NOT NULL UNIQUE,                                      -- bucket/key, made by the server
  scan_status   text        NOT NULL DEFAULT 'Pending' CHECK (scan_status IN ('Pending', 'Clean', 'Infected', 'Error')),
  visibility    text        NOT NULL DEFAULT 'Owner' CHECK (visibility IN ('Owner', 'Community', 'Staff', 'Committee')),
  custom        jsonb       NOT NULL DEFAULT '{}',
  version       bigint      NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  PRIMARY KEY (community_id, id)
);
CREATE INDEX IF NOT EXISTS file_owner ON docs.file_object (community_id, owner_type, owner_id);

