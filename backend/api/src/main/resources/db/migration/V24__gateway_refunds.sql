-- =====================================================================================================================================
-- V24 refunds through the payment provider: a booking's fee or deposit paid online goes back to the card / UPI / bank it came from.
--   * a refund names what it is for (a booking's fee or deposit), the payment it returns, the provider's refund reference and its state:
--     Pending (asked for), Processed (the money went back) or Failed (the provider could not do it); the amount is never more than was paid
--   * a booking waits as "Refund initiated" (fee) / "Initiated" (deposit) until the provider says it is done
-- =====================================================================================================================================

CREATE TABLE IF NOT EXISTS billing.gateway_refund (
  community_id        uuid          NOT NULL REFERENCES platform.community (id),
  id                  uuid          NOT NULL DEFAULT gen_random_uuid(),
  short_id            text,
  owner_type          text          NOT NULL CHECK (owner_type IN ('amenity.booking')),
  owner_id            uuid          NOT NULL,
  part                text          NOT NULL CHECK (part IN ('fee', 'deposit')),
  payment_id          uuid          NOT NULL,
  provider            text          NOT NULL,
  provider_payment_ref text         NOT NULL,
  provider_refund_ref text,
  amount              numeric(14,2) NOT NULL CHECK (amount > 0),
  status              text          NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Processed', 'Failed')),
  failure_reason      text          CHECK (failure_reason IS NULL OR length(failure_reason) <= 500),
  processed_at        timestamptz,
  version             bigint        NOT NULL DEFAULT 1,
  created_at          timestamptz   NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz   NOT NULL DEFAULT now(),
  updated_by          uuid,
  PRIMARY KEY (community_id, id),
  UNIQUE (community_id, short_id),
  UNIQUE (provider, provider_refund_ref),
  FOREIGN KEY (community_id, payment_id) REFERENCES billing.payment (community_id, id),
  CHECK (status <> 'Processed' OR processed_at IS NOT NULL),
  CHECK (status <> 'Failed' OR failure_reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS gateway_refund_owner ON billing.gateway_refund (community_id, owner_type, owner_id);
CREATE INDEX IF NOT EXISTS gateway_refund_pending ON billing.gateway_refund (created_at) WHERE status = 'Pending';
DROP TRIGGER IF EXISTS short_id ON billing.gateway_refund;
CREATE TRIGGER short_id BEFORE INSERT ON billing.gateway_refund FOR EACH ROW EXECUTE FUNCTION platform.stamp_short_id('RFD', '0', '4');

-- a refund never returns more than its payment brought in
CREATE OR REPLACE FUNCTION billing.refund_within_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE paid numeric; back numeric;
BEGIN
  SELECT p.amount INTO paid FROM billing.payment p WHERE p.community_id = NEW.community_id AND p.id = NEW.payment_id;
  SELECT coalesce(sum(r.amount), 0) INTO back FROM billing.gateway_refund r
    WHERE r.community_id = NEW.community_id AND r.payment_id = NEW.payment_id AND r.status <> 'Failed' AND r.id <> NEW.id;
  IF NEW.status <> 'Failed' AND back + NEW.amount > paid THEN
    RAISE EXCEPTION 'a refund cannot return more than the payment brought in (% paid, % already back)', paid, back USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS within_payment ON billing.gateway_refund;
CREATE TRIGGER within_payment BEFORE INSERT OR UPDATE OF amount, status ON billing.gateway_refund FOR EACH ROW EXECUTE FUNCTION billing.refund_within_payment();

ALTER TABLE amenity.booking DROP CONSTRAINT IF EXISTS booking_refund_status,
  ADD CONSTRAINT booking_refund_status CHECK (refund_status IN ('None', 'Refund due', 'Refund initiated', 'Refunded', 'Credited to unit account'));
ALTER TABLE amenity.booking DROP CONSTRAINT IF EXISTS booking_deposit_refund_status,
  ADD CONSTRAINT booking_deposit_refund_status CHECK (deposit_refund_status IS NULL OR deposit_refund_status IN ('None', 'Due', 'Initiated', 'Paid', 'Credited to unit account'));

SELECT platform.apply_security();
