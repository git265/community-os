package com.communityos.adapter.persistence.typed;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.communityos.domain.QuerySpec;
import com.communityos.domain.ScopeNode;
import com.communityos.web.BadRequestException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** Pure unit tests (no database): the SQL text and the bind values for typed tables. Mirrors the Node store/sqlquery.mjs behaviour. */
class QueryCompilerTest {
    private static final CollectionMapping DUES = CollectionMappings.of("dues").orElseThrow();
    private static QuerySpec spec(String sortKey, Map<String, List<String>> filters) {
        return new QuerySpec(1, 50, sortKey, "desc", "", List.of(), "", "", "", "", "", "", filters);
    }

    @Test void ownUnitScopeUsesTheColumnNotTheJson() throws Exception {
        ScopeNode scope = ScopeNode.parse(new ObjectMapper().readTree("{\"op\":\"eq\",\"key\":\"unit\",\"value\":\"A-101\"}"));
        QueryCompiler.Compiled c = QueryCompiler.compile(DUES, "la-paloma", spec("", Map.of()), scope);
        assertTrue(c.where().contains("unit = ?"));
        assertFalse(c.where().contains("data->>"));
        assertEquals(List.of("la-paloma", "A-101"), c.whereArgs());
    }

    @Test void typedSortColumnWinsAndKeepsOrderOnTies() {
        QueryCompiler.Compiled c = QueryCompiler.compile(DUES, "t", spec("dueDate", Map.of()), null);
        assertEquals(" ORDER BY due_date DESC NULLS LAST, seq", c.order());
        assertTrue(c.orderArgs().isEmpty());
    }

    @Test void unknownFieldIsBoundNeverWrittenIntoTheSql() {
        QueryCompiler.Compiled c = QueryCompiler.compile(DUES, "t", spec("", Map.of("flat", List.of("x"))), null);
        assertTrue(c.where().contains("(data->>?)"));
        assertTrue(c.whereArgs().contains("flat"));
    }

    @Test void badFieldNameIsRefused() {
        assertThrows(BadRequestException.class, () -> QueryCompiler.compile(DUES, "t", spec("a'; drop table dues;--", Map.of()), null));
    }

    @Test void emptyInListMatchesNothing() {
        QueryCompiler.Compiled c = QueryCompiler.compile(DUES, "t", spec("", Map.of()), new ScopeNode.In("unit", List.of()));
        assertTrue(c.where().endsWith("FALSE"));
    }

    @Test void auditIsAppendOnlyAndOrderedByTime() {
        CollectionMapping audit = CollectionMappings.of("audit").orElseThrow();
        assertTrue(audit.appendOnly());
        assertEquals(" ORDER BY at, seq", QueryCompiler.compile(audit, "t", spec("", Map.of()), null).order());
    }

    @Test void onlyTheSevenHotCollectionsAreTyped() {
        for (String c : List.of("properties", "users", "dues", "amenities", "tickets", "ledger", "audit")) assertTrue(CollectionMappings.isTyped(c), c);
        for (String c : List.of("forum", "notices", "settings")) assertFalse(CollectionMappings.isTyped(c), c);
    }
}
