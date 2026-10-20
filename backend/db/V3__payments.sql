-- Online payments settled by the SERVER: an order is created and priced here, the provider's signed webhook (or the reconcile job)
-- settles it, and the bill + ledger entry + receipt are written in ONE transaction. The browser only ever sees the order's status.
CREATE TABLE IF NOT EXISTS payment_orders (
  order_id        text PRIMARY KEY,
  tenant          text        NOT NULL,
  purpose         text        NOT NULL,            -- 'due' | 'donation' | 'booking'
  refs            jsonb       NOT NULL DEFAULT '[]',
  unit            text        NOT NULL DEFAULT '',
  payer           text        NOT NULL DEFAULT '',
  payer_id        text        NOT NULL DEFAULT '', -- users document id of whoever started it
  amount          numeric(14,2) NOT NULL,          -- priced by the server, never taken from the browser
  currency        text        NOT NULL DEFAULT 'INR',
  status          text        NOT NULL DEFAULT 'Created',   -- Created | Pending | Paid | Failed | Expired
  idempotency_key text,
  meta            jsonb       NOT NULL DEFAULT '{}',
  provider        text        NOT NULL DEFAULT 'simulated',
  provider_ref    text,
  payment_id      text,
  method          text,
  bank            jsonb,                           -- simulated provider only: what "the bank" decided
  consumed_by     text,                            -- booking id that used this payment (a payment buys one booking)
  note            text,
  attempts        int         NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  paid_at         timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_orders_idem ON payment_orders (tenant, idempotency_key) WHERE status IN ('Created','Pending','Paid') AND idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_orders_open ON payment_orders (status, updated_at) WHERE status IN ('Created','Pending');
CREATE INDEX IF NOT EXISTS payment_orders_payment ON payment_orders (tenant, payment_id);

-- every provider event is processed once, whatever number of times the provider repeats it
CREATE TABLE IF NOT EXISTS payment_events (
  event_id    text PRIMARY KEY,
  order_id    text NOT NULL,
  type        text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
