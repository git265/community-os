package com.communityos.api.billing.adapter;

import com.communityos.api.billing.application.port.JournalWriter;
import com.communityos.api.billing.domain.Journal;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** Writes the entry as Draft with its lines, then Posted; the deferred trigger re-checks the balance at commit and the period lock on insert. */
public final class JdbcJournalWriter implements JournalWriter {
    static final String ENTRY = """
        INSERT INTO finance.journal_entry (community_id, entry_date, memo, source_type, source_id)
        VALUES (platform.current_community(), CAST(:date AS date), left(:memo, 500), :type, CAST(:source AS uuid)) RETURNING id""";
    static final String LINE = """
        INSERT INTO finance.journal_line (community_id, entry_id, line_no, account_id, unit_id, debit, credit, narration)
        VALUES (platform.current_community(), CAST(:entry AS uuid), :no,
                COALESCE(CAST(:accountId AS uuid), (SELECT a.id FROM finance.account a WHERE a.code = COALESCE(CAST(:code AS text), '4000'))),
                CAST(:unit AS uuid), :debit, :credit, :narration)""";
    static final String POST = "UPDATE finance.journal_entry SET status = 'Posted' WHERE id = CAST(:entry AS uuid) AND status = 'Draft'";

    private final NamedParameterJdbcTemplate jdbc;
    public JdbcJournalWriter(NamedParameterJdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Override public void post(Journal.Entry e) {
        Map<String, Object> h = new HashMap<>();
        h.put("date", java.sql.Date.valueOf(e.date())); h.put("memo", e.memo()); h.put("type", e.sourceType()); h.put("source", e.sourceId() == null ? null : e.sourceId().toString());
        UUID entry = jdbc.queryForObject(ENTRY, h, UUID.class);
        int no = 1;
        for (Journal.Line l : e.lines()) {
            Map<String, Object> p = new HashMap<>();
            p.put("entry", entry.toString()); p.put("no", no++); p.put("accountId", l.accountId() == null ? null : l.accountId().toString()); p.put("code", l.accountCode());
            p.put("unit", l.unitId() == null ? null : l.unitId().toString()); p.put("debit", l.debit().amount()); p.put("credit", l.credit().amount()); p.put("narration", l.narration());
            jdbc.update(LINE, p);
        }
        jdbc.update(POST, Map.of("entry", entry.toString()));
    }
}
