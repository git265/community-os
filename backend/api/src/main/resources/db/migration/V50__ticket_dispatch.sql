-- =====================================================================================================================================
-- V50 Ticket dispatch: maintenance tickets (role-queue task types) go to the next free technician of their category, in the order received.
--   * category_coverage: how soon a technician should start a ticket, and how long the work should take, before reminders go out
--   * ticket_nudge: the reminders already sent (not started in time, taking too long), once per ticket, kind, stage and assignment
-- =====================================================================================================================================
ALTER TABLE maintenance.category_coverage
  ADD COLUMN IF NOT EXISTS start_within_min integer CHECK (start_within_min IS NULL OR start_within_min BETWEEN 5 AND 1440),
  ADD COLUMN IF NOT EXISTS fix_within_hours integer CHECK (fix_within_hours IS NULL OR fix_within_hours BETWEEN 1 AND 240);

CREATE TABLE IF NOT EXISTS maintenance.ticket_nudge (
  community_id uuid        NOT NULL REFERENCES platform.community (id),
  ticket_id    uuid        NOT NULL,
  kind         text        NOT NULL CHECK (kind IN ('start', 'fix')),     -- start: assigned but not started; fix: in progress for too long
  stage        integer     NOT NULL CHECK (stage IN (1, 2)),              -- 1: the technician; 2: the technician and the facility manager
  since        timestamptz NOT NULL,                                       -- the assignment (or the start) it is about: a new one starts afresh
  sent_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, ticket_id, kind, stage, since),
  FOREIGN KEY (community_id, ticket_id) REFERENCES maintenance.ticket (community_id, id) ON DELETE CASCADE
);

-- the queue of a category: its open tickets in the order received
CREATE INDEX IF NOT EXISTS ticket_waiting ON maintenance.ticket (community_id, category, created_at) WHERE status = 'Open' AND assignee_id IS NULL;
-- who is working on what
CREATE INDEX IF NOT EXISTS ticket_held ON maintenance.ticket (community_id, assignee_id) WHERE status IN ('Assigned', 'In Progress');

SELECT platform.apply_security();
