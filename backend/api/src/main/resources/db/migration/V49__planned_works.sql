-- =====================================================================================================================================
-- V49 Planned works: recurring checklists of work (the STP / WTP weekly, monthly and yearly works, DG checks, pool tests ...)
--   * checklist        what is done, how often and by when, by which team or person; its tasks as JSON text [{id, text}]
--   * checklist_round  one period's round of a checklist (a week, a month ...): each task Done / Not OK / N/A with a remark, as JSON text
--   * checklist_alert  the reminders already sent (due today, overdue), once per checklist and period, kept beside the checklist
-- =====================================================================================================================================
CREATE TABLE IF NOT EXISTS maintenance.checklist (
  community_id  uuid        NOT NULL REFERENCES platform.community (id),
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  short_id      text,
  name          text        NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  area          text        CHECK (area IS NULL OR length(area) <= 80),            -- WTP, STP, DG set, Swimming pool ...
  category      text        CHECK (category IS NULL OR length(category) <= 60),    -- the maintenance category a ticket from it is raised in
  frequency     text        NOT NULL CHECK (frequency IN ('Daily', 'Weekly', 'Monthly', 'Quarterly', 'Half-yearly', 'Yearly')),
  due_day       integer     CHECK (due_day IS NULL OR due_day BETWEEN 1 AND 31),   -- weekly: 1 Monday .. 7 Sunday; otherwise the day of the month
  due_month     integer     CHECK (due_month IS NULL OR due_month BETWEEN 1 AND 12), -- the month within the quarter, half-year or year
  starts_on     date        NOT NULL DEFAULT current_date,
  assignee_role text        CHECK (assignee_role IS NULL OR length(assignee_role) <= 60),
  assignee_id   uuid,
  tasks         text        NOT NULL DEFAULT '[]',
  active        boolean     NOT NULL DEFAULT true,
  notes         text        CHECK (notes IS NULL OR length(notes) <= 2000),
  custom        jsonb       NOT NULL DEFAULT '{}',
  version       bigint      NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  PRIMARY KEY (community_id, id),
  UNIQUE (community_id, short_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS checklist_name_once ON maintenance.checklist (community_id, lower(name));
DROP TRIGGER IF EXISTS short_id ON maintenance.checklist;
CREATE TRIGGER short_id BEFORE INSERT ON maintenance.checklist FOR EACH ROW EXECUTE FUNCTION platform.stamp_short_id('PMC', '0', '3');

CREATE TABLE IF NOT EXISTS maintenance.checklist_round (
  community_id  uuid        NOT NULL REFERENCES platform.community (id),
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  short_id      text,
  checklist_id  uuid        NOT NULL,
  period        text        NOT NULL CHECK (length(period) BETWEEN 4 AND 20),     -- W:2026-W43, M:2026-10, Q:2026-Q4, H:2026-H2, Y:2026, D:2026-10-24
  due_on        date        NOT NULL,
  status        text        NOT NULL DEFAULT 'In progress' CHECK (status IN ('In progress', 'Done')),
  items         text        NOT NULL DEFAULT '[]',
  notes         text        CHECK (notes IS NULL OR length(notes) <= 4000),
  completed_at  timestamptz,
  custom        jsonb       NOT NULL DEFAULT '{}',
  version       bigint      NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  PRIMARY KEY (community_id, id),
  UNIQUE (community_id, short_id),
  UNIQUE (community_id, checklist_id, period),
  FOREIGN KEY (community_id, checklist_id) REFERENCES maintenance.checklist (community_id, id) ON DELETE CASCADE,
  CHECK ((status = 'Done') = (completed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS checklist_round_recent ON maintenance.checklist_round (community_id, checklist_id, due_on DESC);
DROP TRIGGER IF EXISTS short_id ON maintenance.checklist_round;
CREATE TRIGGER short_id BEFORE INSERT ON maintenance.checklist_round FOR EACH ROW EXECUTE FUNCTION platform.stamp_short_id('PMR', '0', '4');

CREATE TABLE IF NOT EXISTS maintenance.checklist_alert (
  community_id uuid        NOT NULL REFERENCES platform.community (id),
  checklist_id uuid        NOT NULL,
  period       text        NOT NULL,
  kind         text        NOT NULL CHECK (kind IN ('due', 'overdue')),
  alerted_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, checklist_id, period, kind),
  FOREIGN KEY (community_id, checklist_id) REFERENCES maintenance.checklist (community_id, id) ON DELETE CASCADE
);

-- a round's photos are files attached to it (owner type maintenance.checklist_round). The owner type's pattern (V5) had no underscore, which
-- also refused the files of assets.dg_fuel, assets.electricity_bill and assets.log_entry: the named list below is what decides the kinds.
ALTER TABLE docs.file_object DROP CONSTRAINT IF EXISTS file_object_owner_type_check,
  ADD CONSTRAINT file_object_owner_type_check CHECK (owner_type ~ '^[a-z][a-zA-Z._]{1,60}$');
ALTER TABLE docs.file_object DROP CONSTRAINT IF EXISTS file_object_owner_kind,
  ADD CONSTRAINT file_object_owner_kind CHECK (owner_type IN ('upload', 'maintenance.ticket', 'maintenance.comment', 'maintenance.quotation', 'amenity.booking', 'docs.document',
                                                              'cultural.photo', 'cultural.brochure', 'governance.agenda', 'governance.minutes', 'vendor.vendor',
                                                              'assets.equipment', 'assets.inventory', 'assets.dg_fuel', 'assets.electricity_bill', 'assets.audit', 'assets.log_entry',
                                                              'billing.reading', 'maintenance.checklist_round'));

SELECT platform.apply_security();
