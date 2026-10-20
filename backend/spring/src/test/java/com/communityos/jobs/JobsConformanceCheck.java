package com.communityos.jobs;

import com.communityos.adapter.gst.SimulatedGstProvider;
import com.communityos.adapter.persistence.InMemoryDocumentRepository;
import com.communityos.amenities.AmenityConformanceCheck;
import com.communityos.finance.BillTerms;
import com.communityos.finance.FinDates;
import com.communityos.finance.ItcJob;
import com.communityos.finance.LateFees;
import com.communityos.finance.RecurringBills;
import com.communityos.finance.SystemWriter;
import com.communityos.finance.UtilityTypes;
import com.communityos.notify.DueReminders;
import com.communityos.notify.EventNotifications;
import com.communityos.notify.Notifier;
import com.communityos.port.DocumentRepository;
import com.communityos.reports.ReportSchedules;
import com.communityos.security.Constants;
import com.communityos.security.Js;
import com.communityos.security.Principal;
import com.communityos.service.audit.AuditTrail;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.InputStream;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.zip.GZIPInputStream;

/**
 * Replays what the real JavaScript wrote and returned for ~15,000 operations (backend/contract-server/test/gen-jobs-golden.mjs, `npm run gen:jobs`, in the
 * India time zone): task, approval and invoice messages, the messages after a write, late fees, recurring bills, payment reminders with their bill terms,
 * e-voting reminders, the GST input-credit check, utility types and the report schedules. Reports every place the Java gives a different answer: the rows
 * it added (in order), the rows it changed, the audit lines and what it returned.
 */
public final class JobsConformanceCheck {
    private static final List<String> TRACK = List.of("dues", "notifications", "notificationOutbox", "assocBills", "recurringBills", "ledger", "taxSettings", "utilityTypes", "schema", "noticeTemplates", "reportRuns", "reportSchedules");
    static final ZoneId ZONE = AmenityConformanceCheck.ZONE;
    private final ObjectMapper json = new ObjectMapper();
    private final List<String> problems = new ArrayList<>();
    private final Map<String, Integer> seen = new LinkedHashMap<>();
    private int ops;
    private String only;   // a kind to replay alone (debugging)

    public static void main(String[] args) throws Exception {
        JobsConformanceCheck c = new JobsConformanceCheck();
        if (args.length > 1) c.only = args[1];
        c.run();
        System.out.println("operations=" + c.ops + " mismatches=" + c.problems.size() + " " + c.seen);
        c.problems.stream().limit(args.length > 0 ? Integer.parseInt(args[0]) : 8).forEach(System.out::println);
        System.exit(c.problems.isEmpty() ? 0 : 1);
    }

    List<String> problems() { return problems; }
    int ops() { return ops; }
    Map<String, Integer> seen() { return seen; }
    private void count(String k, int n) { seen.merge(k, n, Integer::sum); }

    private static Principal actor(JsonNode a) {
        JsonNode role = a.path("role");
        return new Principal(a.path("roleId").asText(), new Principal.Role(a.path("roleId").asText(), role.path("name").asText(), role.path("category").asText(), Set.of()), a.path("name").asText(), a.path("unit").asText(""), List.of());
    }
    private static JsonNode orNull(JsonNode n) { return n == null || n.isNull() || n.isMissingNode() ? null : n; }

    void run() throws Exception {
        JsonNode gold;
        try (InputStream in = JobsConformanceCheck.class.getResourceAsStream("/jobs/golden.json.gz")) {
            if (in == null) throw new IllegalStateException("jobs/golden.json.gz is missing: run `npm run gen:jobs` in backend/contract-server");
            gold = json.readTree(new GZIPInputStream(in));
        }
        Constants constants = Constants.load(json);
        for (JsonNode c : gold.get("cases")) {
            Clock clock = Clock.fixed(Instant.parse(c.get("now").asText()), ZoneOffset.UTC);
            JsonNode world = c.get("world");
            for (JsonNode op : c.get("ops")) {
                String kind = op.get("kind").asText();
                if (only != null && !only.equals(kind)) continue;
                ops++;
                DocumentRepository repo = new InMemoryDocumentRepository();
                world.fields().forEachRemaining(e -> e.getValue().forEach(r -> repo.upsert("t", e.getKey(), r.path("id").asText(java.util.UUID.randomUUID().toString()), r)));
                Map<String, Map<String, String>> before = snapshot(repo);
                int auditBefore = repo.list("t", "audit").size();
                AuditTrail audit = new AuditTrail(repo, json, clock);
                SystemWriter w = new SystemWriter(repo, audit, json, clock, constants);
                Notifier notifier = new Notifier(w);
                EventNotifications events = new EventNotifications(w, notifier);
                JsonNode want = op.get("expected");
                JsonNode ret = null;
                try {
                    switch (kind) {
                        case "ticket" -> {
                            JsonNode old = orNull(op.get("old")), next = op.get("next"); Principal p = actor(op.get("actor"));
                            events.ticketChange("t", old, next, p); events.approvalNeeded("t", old, next, p); events.afterWrite("t", "tickets", old, next, p);
                        }
                        case "invoice" -> events.invoiceChange("t", orNull(op.get("old")), op.get("next"), actor(op.get("actor")));
                        case "afterWrite" -> events.afterWrite("t", op.get("collection").asText(), orNull(op.get("old")), op.get("next"), actor(op.get("actor")));
                        case "lateFees" -> {
                            LateFees.Applied a = new LateFees(w).apply("t", op.get("asOf").asText(), "Billing", op.get("auto").asBoolean(), orNull(op.get("only")) == null ? null : op.get("only").asText());
                            ret = json.createObjectNode().put("created", a.created()).set("total", com.communityos.amenities.AmenityEngine.num(a.total()));
                            count("lateFeeRows", a.created());
                        }
                        case "autoLateFees" -> { int n = new LateFees(w).runAuto("t", ZONE); ret = json.getNodeFactory().numberNode(n); count("autoLateFeeRows", n); }
                        case "recurring" -> { int n = new RecurringBills(w).run("t", ZONE); ret = json.getNodeFactory().numberNode(n); count("recurringBills", n); }
                        case "reminders" -> { int n = new DueReminders(w, notifier).run("t", ZONE, op.get("force").asBoolean()); ret = json.getNodeFactory().numberNode(n); count("reminders", n); }
                        case "terms" -> {
                            List<JsonNode> fin = repo.list("t", "financeSettings");
                            LateFees.Settings s;
                            try { s = LateFees.settings(fin.isEmpty() ? json.createObjectNode() : fin.get(0), json); } catch (RuntimeException e) { s = null; }
                            ret = json.getNodeFactory().textNode(BillTerms.termsFor(op.get("due"), s, FinDates.today(clock, ZONE)));
                        }
                        case "ballotReminders" -> { int n = events.ballotReminders("t", ZONE); ret = json.getNodeFactory().numberNode(n); count("ballotReminders", n); }
                        case "itc" -> { ItcJob.Counts r = new ItcJob(w, new SimulatedGstProvider()).runAuto("t"); ret = r == null ? null : counts(r); if (r != null) count("itcChecked", r.checked()); }
                        case "itcChecks" -> { ItcJob.Counts r = new ItcJob(w, new SimulatedGstProvider()).runChecks("t", ItcJob.SYSTEM, op.get("only").asText()); ret = counts(r); count("itcChecked", r.checked()); }
                        case "utilityTypes" -> new UtilityTypes(w).ensure("t");
                        case "reports" -> { int n = new ReportSchedules(w, notifier).runDue("t", ZONE); ret = json.getNodeFactory().numberNode(n); count("reportsRun", n); }
                        case "runSchedule" -> {
                            ReportSchedules.Run r = new ReportSchedules(w, notifier).runSchedule("t", op.get("schedule"), ZONE, ReportSchedules.SYSTEM, true);
                            ret = json.createObjectNode().put("silent", r.silent()).put("inApp", r.inApp()).put("queued", r.queued()).put("skipped", r.skipped()).put("sentTo", r.sentTo());
                        }
                        default -> throw new IllegalStateException(kind);
                    }
                } catch (RuntimeException e) {
                    if (problems.isEmpty()) e.printStackTrace();
                    add(kind, op, "CRASH " + e);
                    continue;
                }
                count(kind, 1);
                String diff = compare(want, ret, before, repo, auditBefore);
                if (diff != null) add(kind, op, diff);
                else for (String coll : TRACK) { count("rows:" + coll, want.get("created").get(coll).size()); count("changed:" + coll, want.get("changed").get(coll).size()); }
                if (diff == null && kind.equals("runSchedule") && op.path("schedule").path("reportType").asText().equals("custom")) count("customReports", 1);
            }
        }
    }

    private ObjectNode counts(ItcJob.Counts r) { return json.createObjectNode().put("checked", r.checked()).put("ok", r.ok()).put("attention", r.attention()); }

    private void add(String kind, JsonNode op, String diff) {
        if (problems.size() < 300) problems.add(kind + (op.has("collection") ? " " + op.get("collection").asText() : "") + "\n" + diff + "\n   op=" + abbreviate(op.toString()));
    }
    private static String abbreviate(String s) { return s.length() > 1500 ? s.substring(0, 1500) + "..." : s; }

    private Map<String, Map<String, String>> snapshot(DocumentRepository repo) {
        Map<String, Map<String, String>> out = new HashMap<>();
        for (String c : TRACK) { Map<String, String> m = new LinkedHashMap<>(); for (JsonNode r : repo.list("t", c)) if (r.has("id")) m.put(r.path("id").asText(""), AmenityConformanceCheck.canon(r)); out.put(c, m); }
        return out;
    }

    private String compare(JsonNode want, JsonNode ret, Map<String, Map<String, String>> before, DocumentRepository repo, int auditBefore) {
        String a = AmenityConformanceCheck.canon(want.get("ret")), b = AmenityConformanceCheck.canon(ret == null ? json.nullNode() : ret);
        if (!a.equals(b)) return "returned\n   want: " + a + "\n   got:  " + b;
        for (String c : TRACK) {
            List<String> gotNew = new ArrayList<>();
            Map<String, String> gotChanged = new LinkedHashMap<>();
            for (JsonNode r : repo.list("t", c)) {
                if (!r.has("id")) continue;   // rows without an id cannot be told apart: left out on both sides
                String id = r.path("id").asText("");
                if (!before.get(c).containsKey(id)) { ObjectNode o = r.deepCopy(); o.remove("id"); gotNew.add(AmenityConformanceCheck.canon(o)); }
                else if (!before.get(c).get(id).equals(AmenityConformanceCheck.canon(r))) gotChanged.put(id, AmenityConformanceCheck.canon(r));
            }
            List<String> wantNew = new ArrayList<>();
            want.get("created").get(c).forEach(r -> wantNew.add(AmenityConformanceCheck.canon(r)));
            if (!wantNew.equals(gotNew)) return "new rows in " + c + "\n   want (" + wantNew.size() + "): " + wantNew + "\n   got  (" + gotNew.size() + "): " + gotNew;
            Map<String, String> wantChanged = new LinkedHashMap<>();
            want.get("changed").get(c).fields().forEachRemaining(e -> wantChanged.put(e.getKey(), AmenityConformanceCheck.canon(e.getValue())));
            if (!wantChanged.equals(gotChanged)) return "changed rows in " + c + "\n   want: " + wantChanged + "\n   got:  " + gotChanged;
        }
        ArrayNode gotAudit = json.createArrayNode();
        List<JsonNode> rows = repo.list("t", "audit");
        for (JsonNode r : rows.subList(auditBefore, rows.size()))
            gotAudit.addObject().put("who", r.path("who").asText()).put("what", r.path("what").asText()).put("action", r.path("action").asText()).put("summary", r.path("summary").asText()).put("unit", r.path("unit").asText());
        String wa = AmenityConformanceCheck.canon(want.get("audit")), ga = AmenityConformanceCheck.canon(gotAudit);
        if (!wa.equals(ga)) return "audit\n   want: " + wa + "\n   got:  " + ga;
        return null;
    }
}
