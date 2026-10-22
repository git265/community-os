-- Reconciliation: the server compares the money records with each other and with the payment provider, and keeps what does not add up as
-- an issue for the treasurer (found once, seen again on every run until it is resolved or set aside with a note).
--   * one refund in flight per booking part (two people pressing at once cannot send a refund twice)
--   * orders that expired or failed are asked about again (hourly, for a week): money captured late is recorded, never lost
--   * a payment's refunded amount follows its processed refunds

CREATE UNIQUE INDEX IF NOT EXISTS gateway_refund_one_pending ON billing.gateway_refund (community_id, owner_type, owner_id, part) WHERE status = 'Pending';

ALTER TABLE billing.payment_order ADD COLUMN IF NOT EXISTS checked_at timestamptz;
CREATE INDEX IF NOT EXISTS payment_order_closed_recent ON billing.payment_order (updated_at) WHERE status IN ('Expired', 'Failed');

CREATE TABLE IF NOT EXISTS billing.recon_issue (
  community_id  uuid          NOT NULL REFERENCES platform.community (id),
  id            uuid          NOT NULL DEFAULT gen_random_uuid(),
  short_id      text,
  kind          text          NOT NULL CHECK (kind IN ('late-capture', 'duplicate-capture', 'amount-mismatch', 'allocation-mismatch', 'bill-paid-mismatch',
                                                     'refund-unanswered', 'ledger-unbalanced', 'credit-mismatch')),
  ref_type      text          NOT NULL CHECK (ref_type IN ('payment', 'payment_order', 'due', 'gateway_refund', 'ledger')),
  ref_id        uuid          NOT NULL,                     -- the record it is about (the community's id for a whole-ledger check)
  ref_short_id  text,
  provider_ref  text,
  expected      numeric(14,2),
  actual        numeric(14,2),
  detail        text          NOT NULL CHECK (length(detail) <= 500),
  status        text          NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Resolved', 'Ignored')),
  note          text          CHECK (note IS NULL OR length(note) <= 500),
  resolved_by   uuid,
  resolved_at   timestamptz,
  found_at      timestamptz   NOT NULL DEFAULT now(),
  last_seen_at  timestamptz   NOT NULL DEFAULT now(),
  version       bigint        NOT NULL DEFAULT 1,
  created_at    timestamptz   NOT NULL DEFAULT now(), created_by uuid,
  updated_at    timestamptz   NOT NULL DEFAULT now(), updated_by uuid,
  PRIMARY KEY (community_id, id),
  UNIQUE (community_id, short_id),
  UNIQUE (community_id, kind, ref_id),
  CHECK (status = 'Open' OR (resolved_at IS NOT NULL AND note IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS recon_issue_open ON billing.recon_issue (community_id, found_at DESC) WHERE status = 'Open';
DROP TRIGGER IF EXISTS short_id ON billing.recon_issue;
CREATE TRIGGER short_id BEFORE INSERT ON billing.recon_issue FOR EACH ROW EXECUTE FUNCTION platform.stamp_short_id('REC', '0', '4');

SELECT platform.apply_security();
