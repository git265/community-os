-- =====================================================================================================================================
-- Amenities: the catalogue, bookings (no double booking, enforced by the database), add-on items, deposits
-- =====================================================================================================================================

CREATE TABLE amenity_types (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id     uuid NOT NULL REFERENCES communities (id),
  facility_id      uuid,
  name             text NOT NULL,
  active           boolean NOT NULL DEFAULT true,
  booking_mode     text NOT NULL DEFAULT 'Time slot' CHECK (booking_mode IN ('Time slot', 'Full day')),
  reservation      text NOT NULL DEFAULT 'Reservation required' CHECK (reservation IN ('Reservation required', 'Walk-in')),
  exclusive        boolean NOT NULL DEFAULT true,          -- one booking at a time (a hall); false = shared (a gym with capacity)
  capacity         integer CHECK (capacity > 0),
  rate             numeric(14,2) NOT NULL DEFAULT 0 CHECK (rate >= 0),
  rate_unit        text NOT NULL DEFAULT 'Free' CHECK (rate_unit IN ('Per hour', 'Per day / event', 'Free')),
  weekend_rate     numeric(14,2) CHECK (weekend_rate >= 0),
  tax_rate         numeric(5,2) NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 100),
  tax_inclusive    boolean NOT NULL DEFAULT false,
  deposit_amount   numeric(14,2) NOT NULL DEFAULT 0 CHECK (deposit_amount >= 0),
  min_notice_hours integer NOT NULL DEFAULT 0 CHECK (min_notice_hours >= 0),
  max_advance_days integer NOT NULL DEFAULT 90 CHECK (max_advance_days BETWEEN 1 AND 730),
  max_per_day      smallint CHECK (max_per_day > 0),
  max_per_month    smallint CHECK (max_per_month > 0),
  max_upcoming     smallint CHECK (max_upcoming > 0),
  opening_hours    jsonb CHECK (opening_hours IS NULL OR jsonb_typeof(opening_hours) = 'object'),   -- {"mon": ["06:00","22:00"], ...}
  cancellation_rules jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(cancellation_rules) = 'array'), -- [{hoursBefore, refundPercent}]
  blackout_dates   date[] NOT NULL DEFAULT '{}',
  allowed_unit_types text[] NOT NULL DEFAULT '{}',
  income_account_id uuid,
  rules_html       text,
  custom           jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(custom) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE (community_id, id), UNIQUE (community_id, name),
  FOREIGN KEY (community_id, facility_id) REFERENCES facilities (community_id, id),
  FOREIGN KEY (community_id, income_account_id) REFERENCES gl_accounts (community_id, id),
  CHECK (exclusive OR capacity IS NOT NULL)
);
SELECT use_row_stamps('amenity_types');

CREATE TABLE amenity_bookings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id     uuid NOT NULL,
  booking_no       text NOT NULL,
  amenity_type_id  uuid NOT NULL,
  unit_id          uuid,                                    -- NULL = an association booking
  booked_for       text NOT NULL DEFAULT 'Unit' CHECK (booked_for IN ('Unit', 'Association')),
  booked_by_user_id uuid NOT NULL,
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  period           tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED,
  exclusive        boolean NOT NULL,                        -- copied from the amenity at booking time (the exclusion below uses it)
  guests           smallint CHECK (guests >= 0),
  status           text NOT NULL DEFAULT 'Pending payment' CHECK (status IN ('Pending payment', 'Confirmed', 'Completed', 'Cancelled', 'No-show')),
  -- the price, decided by the server's pricing rules and frozen on the booking
  base_amount      numeric(14,2) NOT NULL DEFAULT 0 CHECK (base_amount >= 0),
  extras_amount    numeric(14,2) NOT NULL DEFAULT 0 CHECK (extras_amount >= 0),
  tax_amount       numeric(14,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  deposit_amount   numeric(14,2) NOT NULL DEFAULT 0 CHECK (deposit_amount >= 0),
  waived_amount    numeric(14,2) NOT NULL DEFAULT 0 CHECK (waived_amount >= 0),
  waive_reason     text,
  total_payable    numeric(14,2) GENERATED ALWAYS AS (base_amount + extras_amount + tax_amount + deposit_amount - waived_amount) STORED,
  payment_id       uuid,
  deposit_status   text NOT NULL DEFAULT 'None' CHECK (deposit_status IN ('None', 'Held', 'Refunded', 'Forfeited', 'Part refunded')),
  refund_amount    numeric(14,2) NOT NULL DEFAULT 0 CHECK (refund_amount >= 0),
  cancel_reason    text,
  cancelled_at     timestamptz,
  policy_snapshot  jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(policy_snapshot) = 'object'),  -- the rules in force when booked
  custom           jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(custom) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE (community_id, id), UNIQUE (community_id, booking_no),
  FOREIGN KEY (community_id, amenity_type_id) REFERENCES amenity_types (community_id, id),
  FOREIGN KEY (community_id, unit_id) REFERENCES units (community_id, id),
  FOREIGN KEY (community_id, booked_by_user_id) REFERENCES user_accounts (community_id, id),
  FOREIGN KEY (community_id, payment_id) REFERENCES payments (community_id, id),
  CHECK (ends_at > starts_at AND ends_at <= starts_at + interval '14 days'),
  CHECK ((booked_for = 'Unit') = (unit_id IS NOT NULL)),
  CHECK (waived_amount <= base_amount + extras_amount + tax_amount),
  CHECK ((waived_amount > 0) <= (waive_reason IS NOT NULL)),
  CHECK ((status = 'Cancelled') = (cancelled_at IS NOT NULL)),
  CHECK (refund_amount <= base_amount + extras_amount + tax_amount + deposit_amount),
  -- no two live bookings of an exclusive amenity overlap, whatever the application does and however many servers run
  EXCLUDE USING gist (community_id WITH =, amenity_type_id WITH =, period WITH &&) WHERE (exclusive AND status IN ('Pending payment', 'Confirmed'))
);
CREATE INDEX amenity_bookings_calendar ON amenity_bookings USING gist (community_id, amenity_type_id, period);
CREATE INDEX amenity_bookings_unit ON amenity_bookings (community_id, unit_id, starts_at DESC);
CREATE INDEX amenity_bookings_pending ON amenity_bookings (community_id, created_at) WHERE status = 'Pending payment';
SELECT use_row_stamps('amenity_bookings');

CREATE TABLE amenity_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid NOT NULL REFERENCES communities (id),
  name          text NOT NULL,
  stock         integer NOT NULL CHECK (stock >= 0),
  unit_price    numeric(14,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  active        boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE (community_id, id), UNIQUE (community_id, name)
);
SELECT use_row_stamps('amenity_items');

CREATE TABLE amenity_booking_items (
  community_id  uuid NOT NULL,
  booking_id    uuid NOT NULL,
  item_id       uuid NOT NULL,
  quantity      integer NOT NULL CHECK (quantity > 0),
  unit_price    numeric(14,2) NOT NULL CHECK (unit_price >= 0),      -- frozen at booking time
  PRIMARY KEY (community_id, booking_id, item_id),
  FOREIGN KEY (community_id, booking_id) REFERENCES amenity_bookings (community_id, id) ON DELETE CASCADE,
  FOREIGN KEY (community_id, item_id) REFERENCES amenity_items (community_id, id)
);
