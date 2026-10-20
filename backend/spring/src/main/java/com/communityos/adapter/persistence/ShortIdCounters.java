package com.communityos.adapter.persistence;

import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Hands out short-id numbers (TKT-1058) and audit numbers from the database, so nobody has to read a whole collection to number one record.
 * One row per community and collection in `short_id_counters`; the first time, it is seeded from the highest number already in use.
 * The UPDATE ... RETURNING takes a row lock, so two requests can never get the same number; a rolled-back request leaves a gap, not a duplicate.
 */
public class ShortIdCounters {
    private final JdbcTemplate jdbc;

    public ShortIdCounters(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    /** @param seedSql a query returning the highest number in use (0 when none); `?` placeholders are filled from seedArgs */
    public long next(String tenant, String collection, long base, String seedSql, Object... seedArgs) {
        Long n = update(tenant, collection);
        if (n != null) return n;
        Long seed = jdbc.queryForObject(seedSql, Long.class, seedArgs);
        long start = Math.max(base, seed == null ? 0 : seed);
        return jdbc.queryForObject("INSERT INTO short_id_counters (tenant, collection, last) VALUES (?, ?, ?) "
                + "ON CONFLICT (tenant, collection) DO UPDATE SET last = short_id_counters.last + 1 RETURNING last", Long.class, tenant, collection, start + 1);
    }

    private Long update(String tenant, String collection) {
        return jdbc.query("UPDATE short_id_counters SET last = last + 1 WHERE tenant = ? AND collection = ? RETURNING last",
                (rs, i) -> rs.getLong(1), tenant, collection).stream().findFirst().orElse(null);
    }

    public long nextAudit() { return jdbc.queryForObject("SELECT nextval('audit_short_seq')", Long.class); }

    /** Highest numeric tail of data->>'shortId' (TKT-1057 -> 1057) in a table; the pattern ignores ids that are not PREFIX-digits. */
    public static String maxSql(String table, boolean byCollection) {
        return "SELECT COALESCE(max((substring(data->>'shortId' from '^[A-Za-z]+-([0-9]+)$'))::bigint), 0) FROM " + table
                + " WHERE tenant = ?" + (byCollection ? " AND collection = ?" : "");
    }
}
