-- Sign-in: one-time codes, sessions and the attempt log used for rate limits and lockouts.
-- Only HASHES are stored (code, refresh token). Roles are NOT here: they live in the `users` / `roles` documents.
CREATE TABLE IF NOT EXISTS auth_codes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant     text        NOT NULL,
  phone      text        NOT NULL,                 -- E.164-style key: '+' and digits
  salt       text        NOT NULL,
  code_hash  text        NOT NULL,                 -- sha256(salt:tenant:phone:code)
  tries      int         NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_codes_lookup ON auth_codes (tenant, phone, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id           uuid PRIMARY KEY,
  tenant       text        NOT NULL,
  user_id      text        NOT NULL,               -- users document id (or 'demo:<role>' for the demo roster)
  role_id      text        NOT NULL,
  refresh_hash text        NOT NULL,               -- sha256 of the refresh token; rotated on every refresh
  used_hashes  text[]      NOT NULL DEFAULT '{}',  -- every refresh token this session has already used: presenting one again = theft, session revoked
  demo         boolean     NOT NULL DEFAULT false,
  profile      jsonb,                              -- demo sessions only: name / units / blocks
  ip           text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS sessions_refresh ON sessions (refresh_hash);
CREATE INDEX IF NOT EXISTS sessions_used ON sessions USING gin (used_hashes);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (tenant, user_id);

CREATE TABLE IF NOT EXISTS auth_attempts (
  id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key    text        NOT NULL,                     -- 'code:phone:<p>', 'code:ip:<ip>', 'fail:phone:<p>'
  at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_attempts_key ON auth_attempts (key, at DESC);

-- Audit numbers (AUD-00001 ...) are handed out by the database, not by whoever happens to read the list first.
CREATE SEQUENCE IF NOT EXISTS audit_short_seq;
