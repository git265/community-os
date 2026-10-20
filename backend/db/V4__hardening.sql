-- Round 70: idempotency keys for every write, and a transactional outbox for downstream work (receipts, mail, invoices).
-- Both are plain PostgreSQL (unique constraints, SKIP LOCKED): no Redis or message broker is needed to be correct; they can be added behind the same tables later.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  tenant          text        NOT NULL,
  scope           text        NOT NULL,             -- who: the signed-in user id (a key is only meaningful for the person who made it)
  key             text        NOT NULL,             -- the Idempotency-Key header
  request_hash    text        NOT NULL,             -- method + path + body: the same key with a DIFFERENT request is refused
  state           text        NOT NULL DEFAULT 'InFlight',   -- InFlight | Done
  response_status integer,
  response_body   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, scope, key)
);
CREATE INDEX IF NOT EXISTS idempotency_keys_created ON idempotency_keys (created_at);

CREATE TABLE IF NOT EXISTS event_outbox (
  id              bigserial   PRIMARY KEY,
  tenant          text        NOT NULL,
  topic           text        NOT NULL,             -- 'payment.settled', ...
  payload         jsonb       NOT NULL DEFAULT '{}',
  status          text        NOT NULL DEFAULT 'Pending',    -- Pending | Sent | Dead
  attempts        integer     NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);
CREATE INDEX IF NOT EXISTS event_outbox_due ON event_outbox (next_attempt_at) WHERE status = 'Pending';
