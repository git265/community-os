package com.communityos.adapter.persistence.typed;

import java.util.Map;

/**
 * Where one collection lives when it has a real table. Mirrors backend/contract-server/store/tables.mjs; keep the two in step.
 *
 * @param table      the table (db/V5__typed_tables.sql)
 * @param text       JSON key -> TEXT column that reads the same as data->>key (filters, row scope and equality use it and its index)
 * @param sort       JSON key -> typed column (date / timestamp / number) used by ORDER BY and date ranges
 * @param appendOnly rows are only ever inserted (the audit trail): no update, no delete
 */
public record CollectionMapping(String table, Map<String, String> text, Map<String, String> sort, boolean appendOnly) {
    public String textColumn(String key) { return text.get(key); }
    public String sortColumn(String key) { return sort.get(key); }
}
