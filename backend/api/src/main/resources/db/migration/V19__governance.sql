-- =====================================================================================================================================
-- V19 governance: meetings (agenda, minutes, publishing to residents) and e-voting for registered owners.
--   * a meeting is checked: its status and who can see it, a time that ends after it starts, a published meeting has its publishing time;
--     its papers are files attached to it (agenda / minutes), no longer a list inside the row
--   * a ballot is a draft (edited freely), open (nothing about the question, options, dates or voters can change) or closed (nothing at all)
--   * the electorate is frozen when voting opens: one row per unit with its owners (ballot_elector), fingerprinted on the ballot
--   * WHO voted (vote_roll: one mark per unit) and WHAT was voted (ballot_box: no unit, no person, no time, no stamp) are separate tables;
--     the box rows form a hash chain whose head is kept on the ballot, and nobody - not even the API role - can read the box before it closes
--   * marks, box rows and the frozen roll can never be changed or deleted (triggers, whatever the role)
--   * the second factor: a 6-digit code to the owner's mobile (kept only as an HMAC), 3 tries, then a single-use proof (kept as a hash)
-- =====================================================================================================================================

-- ---- meetings -------------------------------------------------------------------------------------------------------------------------
UPDATE governance.meeting SET title = '(untitled)' WHERE title IS NULL OR btrim(title) = '';
UPDATE governance.meeting SET committee = 'Executive Committee' WHERE committee IS NULL OR btrim(committee) = '';
UPDATE governance.meeting SET date = created_at::date WHERE date IS NULL;
UPDATE governance.meeting SET status = 'Scheduled' WHERE status IS NULL OR status NOT IN ('Scheduled', 'Completed', 'Cancelled');
-- older meetings without the setting count as published (as the app always showed them)
UPDATE governance.meeting SET visibility = 'Published to residents' WHERE visibility IS NULL OR visibility NOT IN ('Internal (committee only)', 'Published to residents');
UPDATE governance.meeting SET published_at = created_at WHERE visibility = 'Published to residents' AND published_at IS NULL;
UPDATE governance.meeting SET end_time = NULL WHERE end_time IS NOT NULL AND start_time IS NOT NULL AND end_time <= start_time;

ALTER TABLE governance.meeting
  DROP COLUMN IF EXISTS agenda_files,
  DROP COLUMN IF EXISTS minutes_files,
  ADD COLUMN IF NOT EXISTS published_by_id uuid,
  ADD COLUMN IF NOT EXISTS minutes_at timestamptz,
  ADD COLUMN IF NOT EXISTS minutes_by_id uuid,
  ADD COLUMN IF NOT EXISTS cancel_reason text,
  ALTER COLUMN title SET NOT NULL,
  ALTER COLUMN committee SET NOT NULL,
  ALTER COLUMN date SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'Scheduled',
  ALTER COLUMN visibility SET NOT NULL,
  ALTER COLUMN visibility SET DEFAULT 'Internal (committee only)',
  ADD CONSTRAINT meeting_title CHECK (length(title) BETWEEN 1 AND 200),
  ADD CONSTRAINT meeting_committee CHECK (length(committee) BETWEEN 1 AND 80),
  ADD CONSTRAINT meeting_status CHECK (status IN ('Scheduled', 'Completed', 'Cancelled')),
  ADD CONSTRAINT meeting_visibility CHECK (visibility IN ('Internal (committee only)', 'Published to residents')),
  ADD CONSTRAINT meeting_published CHECK (visibility = 'Internal (committee only)' OR published_at IS NOT NULL),
  ADD CONSTRAINT meeting_times CHECK (end_time IS NULL OR start_time IS NULL OR end_time > start_time),
  ADD CONSTRAINT meeting_location CHECK (location IS NULL OR length(location) <= 300),
  ADD CONSTRAINT meeting_text CHECK (length(coalesce(agenda, '')) <= 100000 AND length(coalesce(minutes, '')) <= 100000),
  ADD CONSTRAINT meeting_minutes_after CHECK (minutes IS NULL OR status <> 'Cancelled');
CREATE INDEX IF NOT EXISTS governance_meeting_date ON governance.meeting (community_id, date DESC);

ALTER TABLE docs.file_object DROP CONSTRAINT IF EXISTS file_object_owner_kind,
  ADD CONSTRAINT file_object_owner_kind CHECK (owner_type IN ('upload', 'maintenance.ticket', 'maintenance.comment', 'maintenance.quotation', 'amenity.booking', 'docs.document',
                                                              'cultural.photo', 'cultural.brochure', 'governance.agenda', 'governance.minutes'));

-- ---- ballots --------------------------------------------------------------------------------------------------------------------------
UPDATE governance.ballot SET status = 'Draft' WHERE status IS NULL;
UPDATE governance.ballot SET kind = 'Resolution' WHERE kind IS NULL;
ALTER TABLE governance.ballot
  DROP COLUMN IF EXISTS roll,
  ADD COLUMN IF NOT EXISTS votes_cast integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS opened_by_id uuid,
  ADD COLUMN IF NOT EXISTS closed_by_id uuid,
  ADD COLUMN IF NOT EXISTS meeting_id uuid,
  ALTER COLUMN title SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'Draft',
  ALTER COLUMN kind SET NOT NULL,
  ALTER COLUMN opened_at TYPE timestamptz USING opened_at,
  ALTER COLUMN closed_at TYPE timestamptz USING closed_at,
  ALTER COLUMN votes_counted TYPE integer USING votes_counted::integer,
  ADD CONSTRAINT ballot_title CHECK (length(title) BETWEEN 1 AND 200),
  ADD CONSTRAINT ballot_status CHECK (status IN ('Draft', 'Open', 'Closed')),
  ADD CONSTRAINT ballot_kind CHECK (kind IN ('Resolution', 'Choose one')),
  ADD CONSTRAINT ballot_options CHECK (cardinality(options) BETWEEN 0 AND 10),
  ADD CONSTRAINT ballot_resolution CHECK (status = 'Draft' OR kind <> 'Resolution' OR ('For' = ANY (options) AND 'Against' = ANY (options))),
  ADD CONSTRAINT ballot_dates CHECK (opens_on IS NULL OR closes_on IS NULL OR closes_on >= opens_on),
  ADD CONSTRAINT ballot_pcts CHECK ((quorum_pct IS NULL OR quorum_pct BETWEEN 0 AND 100) AND (pass_pct IS NULL OR pass_pct BETWEEN 0 AND 100)),
  ADD CONSTRAINT ballot_opened CHECK (status = 'Draft' OR (opened_at IS NOT NULL AND roll_hash IS NOT NULL AND cardinality(options) >= 2 AND opens_on IS NOT NULL AND closes_on IS NOT NULL)),
  ADD CONSTRAINT ballot_closed CHECK ((status = 'Closed') = (closed_at IS NOT NULL) AND (status <> 'Closed' OR votes_counted = votes_cast)),
  ADD CONSTRAINT ballot_cast CHECK (votes_cast >= 0 AND (votes_cast = 0) = (chain_head IS NULL)),
  ADD CONSTRAINT ballot_meeting FOREIGN KEY (community_id, meeting_id) REFERENCES governance.meeting (community_id, id);

-- the frozen electorate: the units with a registered owner when voting opened, and those owners ([{occupantId, personId, name, phoneLast4}])
CREATE TABLE IF NOT EXISTS governance.ballot_elector (
  community_id uuid NOT NULL REFERENCES platform.community (id),
  ballot_id    uuid NOT NULL,
  unit_id      uuid NOT NULL,
  unit_no      text NOT NULL,
  owners       jsonb NOT NULL CHECK (jsonb_typeof(owners) = 'array' AND jsonb_array_length(owners) >= 1),
  PRIMARY KEY (community_id, ballot_id, unit_id),
  FOREIGN KEY (community_id, ballot_id) REFERENCES governance.ballot (community_id, id),
  FOREIGN KEY (community_id, unit_id) REFERENCES property.unit (community_id, id)
);

-- who voted: one mark per unit and ballot (any registered owner of the unit may cast it)
DELETE FROM governance.vote_roll WHERE ballot_id IS NULL OR unit_id IS NULL;
ALTER TABLE governance.vote_roll
  DROP COLUMN IF EXISTS proof,
  ADD COLUMN IF NOT EXISTS voter_id uuid,
  ALTER COLUMN ballot_id SET NOT NULL,
  ALTER COLUMN unit_id SET NOT NULL,
  ALTER COLUMN marked_on TYPE date USING CASE WHEN marked_on ~ '^\d{4}-\d{2}-\d{2}' THEN substring(marked_on FROM 1 FOR 10)::date ELSE created_at::date END,
  ALTER COLUMN marked_on SET NOT NULL,
  ADD CONSTRAINT vote_roll_ballot FOREIGN KEY (community_id, ballot_id) REFERENCES governance.ballot (community_id, id),
  ADD CONSTRAINT vote_roll_unit FOREIGN KEY (community_id, unit_id) REFERENCES property.unit (community_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS vote_roll_one_per_unit ON governance.vote_roll (community_id, ballot_id, unit_id);

-- what was voted: nothing that points at a person, a unit or a time of day (no stamp columns, so no stamp trigger)
DROP TRIGGER IF EXISTS short_id ON governance.ballot_box;
DROP TRIGGER IF EXISTS stamp_row ON governance.ballot_box;
DROP TRIGGER IF EXISTS keep_short_id ON governance.ballot_box;
DROP INDEX IF EXISTS governance.governance_ballot_box_recent;
DELETE FROM governance.ballot_box WHERE ballot_id IS NULL OR choice IS NULL OR seq IS NULL;
ALTER TABLE governance.ballot_box
  DROP CONSTRAINT IF EXISTS ballot_box_community_id_short_id_key,
  DROP COLUMN IF EXISTS short_id,
  DROP COLUMN IF EXISTS custom,
  DROP COLUMN IF EXISTS version,
  DROP COLUMN IF EXISTS created_at,
  DROP COLUMN IF EXISTS created_by,
  DROP COLUMN IF EXISTS updated_at,
  DROP COLUMN IF EXISTS updated_by,
  ALTER COLUMN ballot_id SET NOT NULL,
  ALTER COLUMN choice SET NOT NULL,
  ALTER COLUMN seq SET NOT NULL,
  ALTER COLUMN receipt SET NOT NULL,
  ALTER COLUMN prev_hash SET NOT NULL,
  ALTER COLUMN hash SET NOT NULL,
  ADD CONSTRAINT ballot_box_ballot FOREIGN KEY (community_id, ballot_id) REFERENCES governance.ballot (community_id, id),
  ADD CONSTRAINT ballot_box_seq CHECK (seq >= 1),
  ADD CONSTRAINT ballot_box_hashes CHECK (prev_hash ~ '^[0-9a-f]{64}$' AND hash ~ '^[0-9a-f]{64}$' AND receipt ~ '^[0-9a-f]{12}$');
CREATE UNIQUE INDEX IF NOT EXISTS ballot_box_seq_once ON governance.ballot_box (community_id, ballot_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS ballot_box_receipt_once ON governance.ballot_box (community_id, ballot_id, receipt);

-- the second factor: one live code per voter, unit and ballot
CREATE TABLE IF NOT EXISTS governance.vote_challenge (
  community_id     uuid        NOT NULL REFERENCES platform.community (id),
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  ballot_id        uuid        NOT NULL,
  unit_id          uuid        NOT NULL,
  person_id        uuid        NOT NULL,
  code_hash        bytea       NOT NULL,
  attempts         integer     NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  sent_at          timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  proof_hash       bytea,
  proof_expires_at timestamptz,
  PRIMARY KEY (community_id, id),
  UNIQUE (community_id, ballot_id, unit_id, person_id),
  FOREIGN KEY (community_id, ballot_id) REFERENCES governance.ballot (community_id, id) ON DELETE CASCADE,
  CHECK (expires_at > sent_at),
  CHECK ((proof_hash IS NULL) = (proof_expires_at IS NULL))
);

-- ---- the rules no role can get round ---------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION governance.ballot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'Draft' THEN RAISE EXCEPTION 'only a draft ballot can be deleted' USING ERRCODE = '23514'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'Closed' THEN RAISE EXCEPTION 'a closed ballot can never be changed' USING ERRCODE = '23514'; END IF;
  IF OLD.status = 'Draft' AND NEW.status = 'Closed' THEN RAISE EXCEPTION 'a ballot must be opened before it is closed' USING ERRCODE = '23514'; END IF;
  IF OLD.status = 'Open' THEN
    IF NEW.status NOT IN ('Open', 'Closed') THEN RAISE EXCEPTION 'an open ballot can only be closed' USING ERRCODE = '23514'; END IF;
    IF (NEW.title, NEW.description, NEW.kind, NEW.options, NEW.opens_on, NEW.closes_on, NEW.quorum_pct, NEW.pass_pct, NEW.roll_hash, NEW.opened_at, NEW.meeting_id)
       IS DISTINCT FROM (OLD.title, OLD.description, OLD.kind, OLD.options, OLD.opens_on, OLD.closes_on, OLD.quorum_pct, OLD.pass_pct, OLD.roll_hash, OLD.opened_at, OLD.meeting_id)
    THEN RAISE EXCEPTION 'an open ballot cannot be edited' USING ERRCODE = '23514'; END IF;
    IF NEW.votes_cast < OLD.votes_cast THEN RAISE EXCEPTION 'votes are never taken back' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ballot_guard ON governance.ballot;
CREATE TRIGGER ballot_guard BEFORE UPDATE OR DELETE ON governance.ballot FOR EACH ROW EXECUTE FUNCTION governance.ballot_guard();

CREATE OR REPLACE FUNCTION governance.voting_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'voting records can never be changed or deleted' USING ERRCODE = '42501'; END $$;
DROP TRIGGER IF EXISTS append_only ON governance.vote_roll;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON governance.vote_roll FOR EACH ROW EXECUTE FUNCTION governance.voting_record();
DROP TRIGGER IF EXISTS append_only ON governance.ballot_box;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON governance.ballot_box FOR EACH ROW EXECUTE FUNCTION governance.voting_record();
DROP TRIGGER IF EXISTS append_only ON governance.ballot_elector;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON governance.ballot_elector FOR EACH ROW EXECUTE FUNCTION governance.voting_record();

-- a box can be written to while voting is open, but read only once the ballot is closed
CREATE OR REPLACE FUNCTION governance.ballot_box_open() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM governance.ballot b WHERE b.community_id = NEW.community_id AND b.id = NEW.ballot_id AND b.status = 'Open') THEN
    RAISE EXCEPTION 'voting is closed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS only_while_open ON governance.ballot_box;
CREATE TRIGGER only_while_open BEFORE INSERT ON governance.ballot_box FOR EACH ROW EXECUTE FUNCTION governance.ballot_box_open();
DROP TRIGGER IF EXISTS only_while_open ON governance.vote_roll;
CREATE TRIGGER only_while_open BEFORE INSERT ON governance.vote_roll FOR EACH ROW EXECUTE FUNCTION governance.ballot_box_open();

SELECT platform.apply_security();

DROP POLICY IF EXISTS sealed_until_closed ON governance.ballot_box;
CREATE POLICY sealed_until_closed ON governance.ballot_box AS RESTRICTIVE FOR SELECT
  USING (EXISTS (SELECT 1 FROM governance.ballot b WHERE b.community_id = ballot_box.community_id AND b.id = ballot_box.ballot_id AND b.status = 'Closed'));
REVOKE UPDATE, DELETE ON governance.vote_roll, governance.ballot_box, governance.ballot_elector FROM cos_app;
REVOKE ALL ON governance.vote_challenge FROM cos_readonly;
