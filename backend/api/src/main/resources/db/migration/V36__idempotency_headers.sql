-- Every POST is idempotent (one filter): the reply kept for a retry carries the headers the app reads (ETag, Location, Content-Type) too.
ALTER TABLE integration.idempotency_key ADD COLUMN IF NOT EXISTS response_headers jsonb;
