-- A ticket not done by its SLA date is told about once per SLA date (the assignee and the dispatch team). The alerts are kept beside the
-- ticket, not on it, so the job never changes the ticket's version under someone editing it; moving the SLA date and missing it again tells
-- them again.
CREATE TABLE IF NOT EXISTS maintenance.ticket_sla_alert (
  community_id uuid        NOT NULL REFERENCES platform.community (id),
  ticket_id    uuid        NOT NULL,
  due_on       date        NOT NULL,
  alerted_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, ticket_id, due_on),
  FOREIGN KEY (community_id, ticket_id) REFERENCES maintenance.ticket (community_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ticket_sla_due ON maintenance.ticket (community_id, sla_due_at)
  WHERE status IN ('Open', 'Assigned', 'In Progress', 'On Hold') AND sla_due_at IS NOT NULL;

SELECT platform.apply_security();
