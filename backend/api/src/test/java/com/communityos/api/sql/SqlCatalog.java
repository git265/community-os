package com.communityos.api.sql;

import com.communityos.api.Fixtures;
import com.communityos.api.billing.application.DuePolicy;
import com.communityos.api.identity.application.MemberPolicy;
import com.communityos.api.property.application.UnitPolicy;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Prints every SQL statement the JDBC adapters can send - their constants, plus the list / detail queries composed with the REAL access
 * specifications of several kinds of caller - as PREPARE + EXPLAIN EXECUTE under the role that runs them (cos_app or cos_platform).
 * tools/check-adapter-sql.sh feeds the output to psql against a migrated database: names, types, privileges and policies are all checked.
 *   java ... com.communityos.api.sql.SqlCatalog > /tmp/adapter-sql.sql
 */
public final class SqlCatalog {
    record Stmt(String role, String name, String sql) {}
    static final String P = "com.communityos.api.";
    static final Map<String, String> CLASSES = new LinkedHashMap<>();
    static {
        for (String c : List.of("shared.jdbc.JdbcOutboxWriter", "shared.jdbc.JdbcAuditWriter", "shared.jdbc.JdbcIdempotencyStore", "shared.jdbc.JdbcFieldDefinitions",
                "identity.adapter.JdbcMemberRepository", "identity.adapter.JdbcRoleCatalog", "property.adapter.JdbcUnitRepository", "billing.adapter.JdbcDueRepository",
                "billing.adapter.JdbcBillingLookups", "billing.adapter.JdbcPaymentOrderRepository", "billing.adapter.JdbcPaymentRepository", "billing.adapter.JdbcJournalWriter"))
            CLASSES.put(c, "cos_app");
        for (String c : List.of("shared.jdbc.JdbcOutboxStore", "identity.adapter.JdbcOtpStore", "identity.adapter.JdbcRefreshTokenStore", "identity.adapter.JdbcPersonDirectory",
                "identity.adapter.JdbcRateLimiter", "identity.adapter.JdbcCallerLoader", "identity.adapter.JdbcCommunityDirectory", "billing.adapter.JdbcPlatformPayments", "shared.integration.WebhookFanout",
                "shared.integration.WebhookDeliveryWorker"))
            CLASSES.put(c, "cos_platform");
    }
    /** fragments that are only valid once composed */
    static final Set<String> FRAGMENTS = Set.of("JdbcMemberRepository.SELECT", "JdbcMemberRepository.FILTER", "JdbcUnitRepository.SELECT", "JdbcUnitRepository.FILTER",
        "JdbcDueRepository.COLUMNS", "JdbcDueRepository.FROM", "JdbcDueRepository.FILTER");

    public static void main(String[] a) throws Exception {
        List<Stmt> out = new ArrayList<>();
        for (Map.Entry<String, String> e : CLASSES.entrySet()) {
            Class<?> c = Class.forName(P + e.getKey());
            for (Field f : c.getDeclaredFields()) {
                if (f.getType() != String.class || !Modifier.isStatic(f.getModifiers())) continue;
                f.setAccessible(true);
                String name = c.getSimpleName() + "." + f.getName();
                if (FRAGMENTS.contains(name)) continue;
                out.add(new Stmt(e.getValue(), name, (String) f.get(null)));
            }
        }
        // composed list / detail queries, with the real access specifications
        List<Caller> callers = List.of(Fixtures.owner(Fixtures.UNIT_A), Fixtures.treasurer(), Fixtures.utilityClerk(), Fixtures.helpdesk(),
            Fixtures.caller(Caller.Category.Staff, Set.of("accountant"), Set.of(), Set.of(Fixtures.BLOCK_1), Permission.MANAGE_DUES, Permission.MANAGE_UNITS));
        int i = 0;
        for (Caller c : callers) {
            i++;
            Spec<?> ms = new MemberPolicy().readScope(c), us = new UnitPolicy().readScope(c), ws = new UnitPolicy().writeScope(c), ds = new DuePolicy().readScope(c);
            out.add(new Stmt("cos_app", "members.list." + i, com.communityos.api.identity.adapter.JdbcMemberRepository.listSql(ms.sql())));
            out.add(new Stmt("cos_app", "members.get." + i, com.communityos.api.identity.adapter.JdbcMemberRepository.getSql(ms.sql())));
            out.add(new Stmt("cos_app", "units.list." + i, com.communityos.api.property.adapter.JdbcUnitRepository.listSql(us.sql())));
            out.add(new Stmt("cos_app", "units.get." + i, com.communityos.api.property.adapter.JdbcUnitRepository.getSql(ws.sql())));
            out.add(new Stmt("cos_app", "dues.list." + i, com.communityos.api.billing.adapter.JdbcDueRepository.listSql(ds.sql())));
            out.add(new Stmt("cos_app", "dues.get." + i, com.communityos.api.billing.adapter.JdbcDueRepository.getSql(ds.sql())));
        }
        StringBuilder sb = new StringBuilder("\\set ON_ERROR_STOP 0\n");
        int n = 0;
        for (Stmt s : out) {
            n++;
            Matcher m = Pattern.compile("(?<!:):([A-Za-z_][A-Za-z0-9_]*)").matcher(s.sql());
            Map<String, Integer> idx = new LinkedHashMap<>();
            StringBuilder q = new StringBuilder();
            while (m.find()) { int k = idx.computeIfAbsent(m.group(1), (x) -> idx.size() + 1); m.appendReplacement(q, "\\$" + k); }
            m.appendTail(q);
            String nulls = idx.isEmpty() ? "" : "(" + String.join(", ", java.util.Collections.nCopies(idx.size(), "NULL")) + ")";
            sb.append("\\echo == ").append(s.name()).append(" (").append(s.role()).append(")\n")
              .append("BEGIN; SET LOCAL ROLE ").append(s.role()).append("; SELECT set_config('app.community_id', (SELECT id::text FROM platform.community LIMIT 1), true) \\gset\n")
              .append("PREPARE s").append(n).append(" AS ").append(q.toString().strip()).append(";\n")
              .append("EXPLAIN (COSTS OFF) EXECUTE s").append(n).append(nulls).append(" \\g /dev/null\n")
              .append("ROLLBACK;\n");
        }
        System.out.print(sb);
        System.err.println(out.size() + " statements");
    }
}
