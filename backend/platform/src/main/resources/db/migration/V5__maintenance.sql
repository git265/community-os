-- =====================================================================================================================================
-- Maintenance: vendors, task types, tickets, their history, discussion, quotations / invoices, approval steps, fund releases
-- =====================================================================================================================================

CREATE TABLE vendors (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid NOT NULL REFERENCES communities (id),
  name          text NOT NULL,
  category      text,
  contact_name  text,
  phone_e164    text CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  email         citext,
  tax_id        text,                       -- GSTIN / VAT number
  pan           text CHECK (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  status        text NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'On hold', 'Blacklisted', 'Inactive')),
  contract_end  date,
  custom        jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(custom) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE (community_id, id), UNIQUE (community_id, name)
);
SELECT use_row_stamps('vendors');

CREATE TABLE task_types (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id     uuid NOT NULL REFERENCES communities (id),
  name             text NOT NULL,
  creator_scope    text NOT NULL CHECK (creator_scope IN ('Resident', 'EC / Staff', 'Anyone')),
  assignment_mode  text NOT NULL CHECK (assignment_mode IN ('Role queue', 'Direct assign')),
  resident_visible boolean NOT NULL DEFAULT false,
  resident_default boolean NOT NULL DEFAULT false,
  quotation_stage  text NOT NULL DEFAULT 'No' CHECK (quotation_stage IN ('No', 'Optional', 'Yes')),
  approval_stage   text NOT NULL DEFAULT 'No' CHECK (approval_stage IN ('No', 'Optional', 'Yes')),
  invoice_stage    text NOT NULL DEFAULT 'No' CHECK (invoice_stage IN ('No', 'Optional', 'Yes')),
  default_sla_hours integer CHECK (default_sla_hours > 0),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE (community_id, id), UNIQUE (community_id, name)
);
CREATE UNIQUE INDEX task_types_one_resident_default ON task_types (community_id) WHERE resident_default;
SELECT use_row_stamps('task_types');

CREATE TABLE ticket_categories (
  community_id  uuid NOT NULL REFERENCES communities (id),
  name          text NOT NULL,                  -- 'Plumbing', 'Electrical' ...: matches roles.trade
  coordinator_role_ids uuid[] NOT NULL DEFAULT '{}',
  default_vendor_id uuid,
  PRIMARY KEY (community_id, name),
  FOREIGN KEY (community_id, default_vendor_id) REFERENCES vendors (community_id, id)
);

CREATE TABLE tickets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id     uuid NOT NULL REFERENCES communities (id),
  ticket_no        text NOT NULL,                              -- TKT-1058
  task_type_id     uuid NOT NULL,
  scope            text NOT NULL DEFAULT 'Unit' CHECK (scope IN ('Unit', 'Community')),
  unit_id          uuid,                                       -- the unit, or the raiser's unit for a community request
  location         text,
  category         text NOT NULL,
  sub_category     text,
  title            text NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 200),
  description      text,
  priority         text NOT NULL DEFAULT 'Medium' CHECK (priority IN ('Low', 'Medium', 'High', 'Critical')),
  status           text NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Assigned', 'In Progress', 'On Hold', 'Completed', 'Closed', 'Cancelled')),
  assignee_user_id uuid,
  assignee_vendor_id uuid,
  sla_due_at       timestamptz,
  preferred_time   text,
  financial        boolean NOT NULL DEFAULT false,
  approved_amount  numeric(14,2) CHECK (approved_amount >= 0),
  materials_cost   numeric(14,2) NOT NULL DEFAULT 0 CHECK (materials_cost >= 0),
  awaiting_parts   boolean NOT NULL DEFAULT false,
  resident_rating  smallint CHECK (resident_rating BETWEEN 1 AND 5),
  raised_by_user_id uuid NOT NULL,                             -- the server's caller, never the payload
  closed_at        timestamptz,
  asset_id         uuid,
  custom           jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(custom) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE (community_id, id), UNIQUE (community_id, ticket_no),
  FOREIGN KEY (community_id, task_type_id) REFERENCES task_types (community_id, id),
  FOREIGN KEY (community_id, unit_id) REFERENCES units (community_id, id),
  FOREIGN KEY (community_id, category) REFERENCES ticket_categories (community_id, name),
  FOREIGN KEY (community_id, assignee_user_id) REFERENCES user_accounts (community_id, id),
  FOREIGN KEY (community_id, assignee_vendor_id) REFERENCES vendors (community_id, id),
  FOREIGN KEY (community_id, raised_by_user_id) REFERENCES user_accounts (community_id, id),
  CHECK (scope = 'Community' OR unit_id IS NOT NULL),
  CHECK (scope = 'Unit' OR length(btrim(COALESCE(location, ''))) > 0),
  CHECK (assignee_user_id IS NULL OR assignee_vendor_id IS NULL),
  CHECK (status NOT IN ('Assigned', 'In Progress') OR assignee_user_id IS NOT NULL OR assignee_vendor_id IS NOT NULL),
  CHECK ((status IN ('Closed', 'Cancelled')) = (closed_at IS NOT NULL)),
  CHECK (resident_rating IS NULL OR status IN ('Completed', 'Closed'))
);
CREATE INDEX tickets_queue ON tickets (community_id, category, status) WHERE status NOT IN ('Closed', 'Cancelled');
CREATE INDEX tickets_unit ON tickets (community_id, unit_id, created_at DESC);
CREATE INDEX tickets_assignee ON tickets (community_id, assignee_user_id, status) WHERE assignee_user_id IS NOT NULL;
CREATE INDEX tickets_status ON tickets (community_id, status, created_at DESC);
CREATE INDEX tickets_sla ON tickets (community_id, sla_due_at) WHERE status NOT IN ('Completed', 'Closed', 'Cancelled');
CREATE INDEX tickets_title_trgm ON tickets USING gin (title gin_trgm_ops);
SELECT use_row_stamps('tickets');

-- "me too": other units affected by a community request
CREATE TABLE ticket_affected_units (
  community_id  uuid NOT NULL,
  ticket_id     uuid NOT NULL,
  unit_id       uuid NOT NULL,
  added_at      timestamptz NOT NULL DEFAULT now(),
  added_by      uuid DEFAULT app_user(),
  PRIMARY KEY (community_id, ticket_id, unit_id),
  FOREIGN KEY (community_id, ticket_id) REFERENCES tickets (community_id, id) ON DELETE CASCADE,
  FOREIGN KEY (community_id, unit_id) REFERENCES units (community_id, id)
);

-- the status trail is written by a trigger: nobody can forge or rewrite it
CREATE TABLE ticket_status_history (
  id            bigint GENERATED ALWAYS AS IDENTITY,
  community_id  uuid NOT NULL,
  ticket_id     uuid NOT NULL,
  from_status   text,
  to_status     text NOT NULL,
  changed_at    timestamptz NOT NULL DEFAULT now(),
  changed_by    uuid,
  PRIMARY KEY (community_id, id),
  FOREIGN KEY (community_id, ticket_id) REFERENCES tickets (community_id, id) ON DELETE CASCADE
);
CREATE INDEX ticket_status_history_ticket ON ticket_status_history (community_id, ticket_id, changed_at);
CREATE TRIGGER ticket_status_history_append_only BEFORE UPDATE ON ticket_status_history FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE OR REPLACE FUNCTION record_ticket_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO ticket_status_history (community_id, ticket_id, from_status, to_status, changed_by)
    VALUES (NEW.community_id, NEW.id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status, app_user());
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER tickets_status_history AFTER INSERT OR UPDATE OF status ON tickets FOR EACH ROW EXECUTE FUNCTION record_ticket_status();

CREATE TABLE ticket_comments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid NOT NULL,
  ticket_id     uuid NOT NULL,
  author_user_id uuid NOT NULL,
  visibility    text NOT NULL DEFAULT 'Public' CHECK (visibility IN ('Public', 'Internal')),
  body          text NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE (community_id, id),
  FOREIGN KEY (community_id, ticket_id) REFERENCES tickets (community_id, id) ON DELETE CASCADE,
  FOREIGN KEY (community_id, author_user_id) REFERENCES user_accounts (community_id, id)
);
CREATE INDEX ticket_comments_ticket ON ticket_comments (community_id, ticket_id, created_at);
SELECT use_row_stamps('ticket_comments');

-- quotations and invoices collected for a ticket
CREATE TABLE ticket_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid NOT NULL,
  ticket_id     uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('Quotation', 'Invoice')),
  vendor_id     uuid,
  doc_no        text,
  net_amount    numeric(14,2) NOT NULL CHECK (net_amount >= 0),
  tax_rate      numeric(5,2) NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 100),
  tax_amount    numeric(14,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total_amount  numeric(14,2) GENERATED ALWAYS AS (net_amount + tax_amount) STORED,
  selected      boolean NOT NULL DEFAULT false,
  approval_waived boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Withdrawn')),
  file_id       uuid,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE (community_id, id),
  FOREIGN KEY (community_id, ticket_id) REFERENCES tickets (community_id, id),
  FOREIGN KEY (community_id, vendor_id) REFERENCES vendors (community_id, id)
);
CREATE INDEX ticket_documents_ticket ON ticket_documents (community_id, ticket_id);
SELECT use_row_stamps('ticket_documents');

-- ---- approval steps: one row per step per subject; each decision is recorded once, in the decider's own name ----------------------
CREATE TABLE approval_policies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid NOT NULL REFERENCES communities (id),
  subject_type  text NOT NULL CHECK (subject_type IN ('Ticket', 'TicketDocument', 'Release', 'Expense', 'PaymentRequest')),
  name          text NOT NULL,
  min_amount    numeric(14,2) NOT NULL DEFAULT 0 CHECK (min_amount >= 0),
  steps         jsonb NOT NULL CHECK (jsonb_typeof(steps) = 'array'),    -- [{name, approverRoles:[], needed:1, canFinish}]
  active        boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE (community_id, id)
);
SELECT use_row_stamps('approval_policies');

CREATE TABLE approval_steps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid NOT NULL,
  subject_type  text NOT NULL,
  subject_id    uuid NOT NULL,
  step_no       smallint NOT NULL CHECK (step_no > 0),
  name          text NOT NULL,
  approver_role_ids uuid[] NOT NULL,
  needed        smallint NOT NULL DEFAULT 1 CHECK (needed > 0),
  status        text NOT NULL DEFAULT 'Waiting' CHECK (status IN ('Waiting', 'Approved', 'Rejected', 'Skipped')),
  policy_id     uuid,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE (community_id, id), UNIQUE (community_id, subject_type, subject_id, step_no),
  FOREIGN KEY (community_id, policy_id) REFERENCES approval_policies (community_id, id)
);
SELECT use_row_stamps('approval_steps');

CREATE TABLE approval_decisions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid NOT NULL,
  step_id       uuid NOT NULL,
  decided_by    uuid NOT NULL DEFAULT app_user(),          -- always the caller
  decision      text NOT NULL CHECK (decision IN ('Approved', 'Rejected')),
  note          text,
  decided_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (community_id, step_id, decided_by),                 -- one decision per person per step
  FOREIGN KEY (community_id, step_id) REFERENCES approval_steps (community_id, id),
  FOREIGN KEY (community_id, decided_by) REFERENCES user_accounts (community_id, id)
);
CREATE TRIGGER approval_decisions_append_only BEFORE UPDATE OR DELETE ON approval_decisions FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE OR REPLACE FUNCTION decided_by_caller() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.decided_by := COALESCE(app_user(), NEW.decided_by); NEW.decided_at := now(); RETURN NEW; END $$;
CREATE TRIGGER approval_decisions_caller BEFORE INSERT ON approval_decisions FOR EACH ROW EXECUTE FUNCTION decided_by_caller();

-- staged / advance payments against an approved ticket amount
CREATE TABLE fund_releases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid NOT NULL,
  ticket_id     uuid NOT NULL,
  vendor_id     uuid,
  kind          text NOT NULL CHECK (kind IN ('Advance', 'Stage', 'Final')),
  amount        numeric(14,2) NOT NULL CHECK (amount > 0),
  status        text NOT NULL DEFAULT 'Waiting approval' CHECK (status IN ('Waiting approval', 'Approved', 'Rejected', 'Paid', 'Cancelled')),
  cancel_reason text,
  journal_entry_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 0,
  UNIQUE (community_id, id),
  FOREIGN KEY (community_id, ticket_id) REFERENCES tickets (community_id, id),
  FOREIGN KEY (community_id, vendor_id) REFERENCES vendors (community_id, id),
  FOREIGN KEY (community_id, journal_entry_id) REFERENCES journal_entries (community_id, id),
  CHECK ((status = 'Cancelled') = (cancel_reason IS NOT NULL)),
  CHECK ((status = 'Paid') = (journal_entry_id IS NOT NULL))
);
CREATE INDEX fund_releases_ticket ON fund_releases (community_id, ticket_id);
SELECT use_row_stamps('fund_releases');
-- the releases of a ticket never exceed its approved amount
CREATE OR REPLACE FUNCTION check_release_cap() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cap numeric(14,2); used numeric(14,2);
BEGIN
  SELECT approved_amount INTO cap FROM tickets WHERE community_id = NEW.community_id AND id = NEW.ticket_id FOR UPDATE;
  SELECT COALESCE(sum(amount), 0) INTO used FROM fund_releases
   WHERE community_id = NEW.community_id AND ticket_id = NEW.ticket_id AND id <> NEW.id AND status IN ('Waiting approval', 'Approved', 'Paid');
  IF NEW.status IN ('Waiting approval', 'Approved', 'Paid') AND (cap IS NULL OR used + NEW.amount > cap) THEN
    RAISE EXCEPTION 'releases (%) would exceed the approved amount (%)', used + NEW.amount, COALESCE(cap, 0) USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fund_releases_cap BEFORE INSERT OR UPDATE ON fund_releases FOR EACH ROW EXECUTE FUNCTION check_release_cap();
