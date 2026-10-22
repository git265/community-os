-- Maintenance at a few hundred tickets a day: the list pages through (community_id, created_at) and counts on its own; the tiles count
-- finished tickets by status alone. "Closed this month" reads its own small index instead of every closed ticket.
-- (Partitioning was weighed and not taken: at ~110 000 tickets a year the indexes answer in milliseconds, while a partitioned ticket table
-- would need created_at in its primary key and in the nine tables that refer to a ticket.)
CREATE INDEX IF NOT EXISTS ticket_closed_recent ON maintenance.ticket (community_id, closed_at DESC) WHERE status = 'Closed';
