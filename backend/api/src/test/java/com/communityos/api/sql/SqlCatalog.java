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
                "billing.adapter.JdbcBillingLookups", "billing.adapter.JdbcPaymentOrderRepository", "billing.adapter.JdbcPaymentRepository", "billing.adapter.JdbcJournalWriter",
                "maintenance.adapter.JdbcTicketRepository", "maintenance.adapter.JdbcMaintenanceDirectory", "maintenance.adapter.JdbcQuotationRepository",
                "maintenance.application.WishVotes", "approval.adapter.JdbcApprovalSettings", "amenity.adapter.JdbcBookingRepository", "amenity.adapter.JdbcAmenityCatalog",
                "gate.adapter.JdbcGateStore", "gate.adapter.JdbcGateDirectory"))
            CLASSES.put(c, "cos_app");
        for (String c : List.of("shared.jdbc.JdbcOutboxStore", "identity.adapter.JdbcOtpStore", "identity.adapter.JdbcRefreshTokenStore", "identity.adapter.JdbcPersonDirectory",
                "identity.adapter.JdbcRateLimiter", "identity.adapter.JdbcCallerLoader", "identity.adapter.JdbcCommunityDirectory", "billing.adapter.JdbcPlatformPayments", "shared.integration.WebhookFanout",
                "shared.integration.WebhookDeliveryWorker", "config.Jobs"))
            CLASSES.put(c, "cos_platform");
    }
    /** fragments that are only valid once composed */
    static final Set<String> FRAGMENTS = Set.of("JdbcMemberRepository.SELECT", "JdbcMemberRepository.FILTER", "JdbcUnitRepository.SELECT", "JdbcUnitRepository.FILTER",
        "JdbcDueRepository.COLUMNS", "JdbcDueRepository.FROM", "JdbcDueRepository.FILTER",
        "JdbcTicketRepository.COLUMNS", "JdbcTicketRepository.FROM", "JdbcTicketRepository.FILTER", "JdbcMaintenanceDirectory.STAFF", "JdbcMaintenanceDirectory.RECENT_COMMENTS",
        "JdbcQuotationRepository.COLUMNS", "JdbcQuotationRepository.LIVE", "JdbcBookingRepository.COLUMNS", "JdbcBookingRepository.FROM", "JdbcBookingRepository.FILTER",
        "JdbcAmenityCatalog.TYPE_COLUMNS", "JdbcGateStore.PASS_COLUMNS", "JdbcGateStore.VISIT_COLUMNS", "JdbcGateStore.VISIT_FILTER", "JdbcGateStore.APPROVAL_COLUMNS",
        "JdbcGateStore.FLAG_COLUMNS");

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
            Spec<?> ts = new com.communityos.api.maintenance.application.TicketPolicy().readScope(c);
            out.add(new Stmt("cos_app", "tickets.list." + i, com.communityos.api.maintenance.adapter.JdbcTicketRepository.listSql(ts.sql())));
            out.add(new Stmt("cos_app", "comments.recent." + i, com.communityos.api.maintenance.adapter.JdbcMaintenanceDirectory.recentSql(ts.sql())));
            out.add(new Stmt("cos_app", "tickets.get." + i, com.communityos.api.maintenance.adapter.JdbcTicketRepository.getSql(ts.sql())));
            Spec<?> bs = new com.communityos.api.amenity.application.BookingPolicy().readScope(c);
            out.add(new Stmt("cos_app", "bookings.list." + i, com.communityos.api.amenity.adapter.JdbcBookingRepository.listSql(bs.sql())));
            out.add(new Stmt("cos_app", "bookings.get." + i, com.communityos.api.amenity.adapter.JdbcBookingRepository.getSql(bs.sql())));
            Spec<?> gp = com.communityos.api.gate.application.GatePolicy.byUnit(c, "p.unit_id", (Object x) -> null), gv = com.communityos.api.gate.application.GatePolicy.byUnit(c, "v.unit_id", (Object x) -> null),
                ga = com.communityos.api.gate.application.GatePolicy.byUnit(c, "a.unit_id", (Object x) -> null);
            out.add(new Stmt("cos_app", "gate.passes." + i, com.communityos.api.gate.adapter.JdbcGateStore.passesSql(gp.sql())));
            out.add(new Stmt("cos_app", "gate.pass." + i, com.communityos.api.gate.adapter.JdbcGateStore.passSql(gp.sql())));
            out.add(new Stmt("cos_app", "gate.visits." + i, com.communityos.api.gate.adapter.JdbcGateStore.visitsSql(gv.sql())));
            out.add(new Stmt("cos_app", "gate.visit." + i, com.communityos.api.gate.adapter.JdbcGateStore.visitSql(gv.sql())));
            out.add(new Stmt("cos_app", "gate.approvals." + i, com.communityos.api.gate.adapter.JdbcGateStore.approvalsSql(ga.sql())));
            out.add(new Stmt("cos_app", "gate.approval." + i, com.communityos.api.gate.adapter.JdbcGateStore.approvalSql(ga.sql())));
            out.add(new Stmt("cos_app", "quotations.all." + i, com.communityos.api.maintenance.adapter.JdbcQuotationRepository.allSql(ts.sql())));
            // every resource of the kit: its list / detail with this caller's scope, a filtered list
            for (com.communityos.api.shared.resource.Resource<?> r : com.communityos.api.config.ResourcesConfig.all()) {
                Spec<?> rs = r.rules().readScope(c);
                var t = r.table();
                out.add(new Stmt("cos_app", t.collection() + ".list." + i, t.selectSql(rs.sql())));
                out.add(new Stmt("cos_app", t.collection() + ".get." + i, t.getSql(rs.sql())));
                if (!t.filters().isEmpty()) out.add(new Stmt("cos_app", t.collection() + ".filter." + i, t.selectSql(rs.sql(), t.filterSql(t.filters()))));
            }
        }
        for (com.communityos.api.shared.resource.Resource<?> r : com.communityos.api.config.ResourcesConfig.all()) {
            var t = r.table();
            out.add(new Stmt("cos_app", t.collection() + ".insert", t.insertSql()));
            out.add(new Stmt("cos_app", t.collection() + ".update", t.updateSql()));
            out.add(new Stmt("cos_app", t.collection() + ".delete", t.deleteSql()));
        }
        StringBuilder sb = new StringBuilder("\\set ON_ERROR_STOP 0\n");
        int n = 0;
        for (Stmt s : out) {
            n++;
            Map<String, Integer> idx = new LinkedHashMap<>();
            String q = NamedSql.replace(s.sql(), (name) -> "$" + idx.computeIfAbsent(name, (x) -> idx.size() + 1));
            String nulls = idx.isEmpty() ? "" : "(" + String.join(", ", java.util.Collections.nCopies(idx.size(), "NULL")) + ")";
            sb.append("\\echo == ").append(s.name()).append(" (").append(s.role()).append(")\n")
              .append("BEGIN; SET LOCAL ROLE ").append(s.role()).append("; SELECT set_config('app.community_id', (SELECT id::text FROM platform.community LIMIT 1), true) \\gset\n")
              .append("PREPARE s").append(n).append(" AS ").append(q.strip()).append(";\n")
              .append("EXPLAIN (COSTS OFF) EXECUTE s").append(n).append(nulls).append(" \\g /dev/null\n")
              .append("ROLLBACK;\n");
        }
        System.out.print(sb);
        System.err.println(out.size() + " statements");
    }
}
