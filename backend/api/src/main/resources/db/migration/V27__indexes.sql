-- Indexes found by checking every foreign key and every index (docs/REDESIGN.md section 2).
--
-- 1. Foreign keys with no index on the referencing side. Without one, deleting or changing the parent row scans the whole child table under a
--    lock, and the joins and look-ups below scan too. Columns that only record WHO did something (booked_by, sent_by, uploaded_by ...) point at
--    memberships, which are deactivated, never deleted, and are not searched by: they are left without one.
CREATE INDEX IF NOT EXISTS payment_by_order          ON billing.payment (community_id, order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS gateway_refund_by_payment ON billing.gateway_refund (community_id, payment_id);
CREATE INDEX IF NOT EXISTS due_by_category           ON billing.due (community_id, category_id);
CREATE INDEX IF NOT EXISTS due_late_fee_for          ON billing.due (community_id, late_fee_for) WHERE late_fee_for IS NOT NULL;
CREATE INDEX IF NOT EXISTS due_correction_of         ON billing.due (community_id, correction_of) WHERE correction_of IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_order_by_unit     ON billing.payment_order (community_id, unit_id);
CREATE INDEX IF NOT EXISTS booking_by_payment        ON amenity.booking (community_id, payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS item_by_type              ON amenity.item (community_id, amenity_type_id);
CREATE INDEX IF NOT EXISTS ticket_by_task_type       ON maintenance.ticket (community_id, task_type_id);
CREATE INDEX IF NOT EXISTS movement_by_ticket        ON assets.inventory_movement (community_id, ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS webhook_delivery_by_sub   ON integration.webhook_delivery (community_id, subscription_id);
CREATE INDEX IF NOT EXISTS push_queue_by_sub         ON comms.push_queue (community_id, subscription_id);
CREATE INDEX IF NOT EXISTS membership_role_by_role   ON identity.membership_role (community_id, role_id);
CREATE INDEX IF NOT EXISTS membership_block_by_block ON identity.membership_block (community_id, block_id);
CREATE INDEX IF NOT EXISTS refresh_token_by_member   ON identity.refresh_token (community_id, membership_id);
CREATE INDEX IF NOT EXISTS portal_invite_by_member   ON identity.portal_invite (community_id, membership_id);
CREATE INDEX IF NOT EXISTS role_by_group             ON identity.role (community_id, group_id);
CREATE INDEX IF NOT EXISTS photo_by_file             ON cultural.photo (community_id, file_id);
CREATE INDEX IF NOT EXISTS ballot_by_meeting         ON governance.ballot (community_id, meeting_id) WHERE meeting_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ballot_elector_by_unit    ON governance.ballot_elector (community_id, unit_id);
CREATE INDEX IF NOT EXISTS journal_line_by_fund      ON finance.journal_line (community_id, fund_id) WHERE fund_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS account_by_parent         ON finance.account (community_id, parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS facility_by_block         ON property.facility (community_id, block_id);
CREATE INDEX IF NOT EXISTS gate_person_by_unit       ON gate.person (community_id, invited_by_unit_id) WHERE invited_by_unit_id IS NOT NULL;

-- 2. Indexes another index already covers (the same leading columns; a b-tree reads either way): they only slowed writes down.
DROP INDEX IF EXISTS maintenance.maintenance_ticket_status;   -- ticket_status_recent (community_id, status, created_at DESC)
DROP INDEX IF EXISTS audit.audit_time;                        -- audit_event_pkey     (community_id, at, id)
DROP INDEX IF EXISTS gate.gate_visit_recent;                  -- visit_pkey           (community_id, created_at, id)
DROP INDEX IF EXISTS gate.gate_scan_recent;                   -- scan_pkey            (community_id, created_at, id)
DROP INDEX IF EXISTS comms.comms_outbox_message_recent;       -- outbox_message_pkey  (community_id, created_at, id)
