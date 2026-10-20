package com.communityos.people;

import com.communityos.adapter.persistence.InMemoryDocumentRepository;
import com.communityos.amenities.AmenityConformanceCheck;
import com.communityos.finance.SystemWriter;
import com.communityos.notify.Notifier;
import com.communityos.port.DocumentRepository;
import com.communityos.security.Constants;
import com.communityos.service.audit.AuditTrail;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.InputStream;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.*;
import java.util.zip.GZIPInputStream;

/**
 * Replays what the real JavaScript answered (backend/contract-server/test/gen-people-golden.mjs, `npm run gen:people`): ~24,000 typed phone numbers
 * (validatePhone / phoneKey), the property checks before a save, the portal-access work after it (users, invites, SMS + WhatsApp rows, the audit line),
 * the access warning of the property form, the meeting publish time and the meeting messages, and the community addresses invite links start with.
 */
public final class PeopleConformanceCheck {
    private static final List<String> TRACK = List.of("users", "portalInvites", "notificationOutbox", "notifications");
    private final ObjectMapper json = new ObjectMapper();
    private final List<String> problems = new ArrayList<>();
    private final Map<String, Integer> seen = new LinkedHashMap<>();
    private int ops;
    private String only;

    public static void main(String[] args) throws Exception {
        PeopleConformanceCheck c = new PeopleConformanceCheck();
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
    private static JsonNode orNull(JsonNode n) { return n == null || n.isNull() || n.isMissingNode() ? null : n; }
    private static String canon(JsonNode n) { return AmenityConformanceCheck.canon(n); }

    /** The ids, tokens and short ids the generator handed out (a counter each), so both sides name new rows alike. */
    static final class TestEnv implements PropertyHooks.Env {
        final String now; final DocumentRepository repo; int ids, tokens;
        TestEnv(String now, DocumentRepository repo) { this.now = now; this.repo = repo; }
        public String now() { return now; }
        public String uuid() { return "id-" + (++ids); }
        public String token() {
            int n = ++tokens; StringBuilder b = new StringBuilder();
            for (int i = 0; i < 12; i++) b.append(String.format("%02x", (n * 37 + i * 11) & 255));
            return b.toString();
        }
        /** nextId(collection, prefix) of propertyServer.js: the highest number after "PREFIX-" + 1. */
        public String nextShortId(String tenant, String collection, String prefix) {
            long max = 0;
            for (JsonNode r : repo.list(tenant, collection)) {
                String s = com.communityos.security.Js.orEmpty(r.path("shortId").isMissingNode() ? null : r.get("shortId")).replaceFirst(java.util.regex.Pattern.quote(prefix + "-"), "").trim();
                double d;
                if (s.isEmpty()) d = 0;
                else if (s.matches("[+-]?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?")) d = Double.parseDouble(s);
                else continue;
                if (d > max) max = (long) d;
            }
            return prefix + "-" + String.format("%04d", max + 1);
        }
    }

    void run() throws Exception {
        JsonNode gold;
        try (InputStream in = PeopleConformanceCheck.class.getResourceAsStream("/people/golden.json.gz")) {
            if (in == null) throw new IllegalStateException("people/golden.json.gz is missing: run `npm run gen:people` in backend/contract-server");
            gold = json.readTree(new GZIPInputStream(in));
        }
        String defaultCommunity = gold.get("defaultCommunity").asText();
        if (only == null || only.equals("phones")) for (JsonNode p : gold.get("phones")) {
            ops++;
            String in = p.get("in").asText();
            Phones.Result r;
            try { r = Phones.validate(in); } catch (RuntimeException e) { add("phone", p, "CRASH " + e); continue; }
            ObjectNode got = json.createObjectNode().put("ok", r.ok());
            if (r.ok()) got.put("e164", r.e164()).put("formatted", r.formatted()).put("country", r.country()); else got.put("error", r.error());
            String a = canon(p.get("out")), b = canon(got);
            if (!a.equals(b)) { add("phone", p, "validate\n   want: " + a + "\n   got:  " + b); continue; }
            String k = Phones.key(in);
            if (!k.equals(p.get("key").asText())) { add("phone", p, "key\n   want: " + p.get("key").asText() + "\n   got:  " + k); continue; }
            count(r.ok() ? "validPhones" : "refusedPhones", 1);
        }
        if (only == null || only.equals("links")) for (JsonNode l : gold.get("links")) {
            ops++;
            String got = CommunityUrls.of(l.get("host").asText(), l.get("slug").asText(), defaultCommunity);
            if (!got.equals(l.get("url").asText())) add("link", l, "want " + l.get("url").asText() + " got " + got); else count("links", 1);
        }
        Constants constants = Constants.load(json);
        for (JsonNode c : gold.get("cases")) {
            String now = c.get("now").asText();
            Clock clock = Clock.fixed(Instant.parse(now), ZoneOffset.UTC);
            JsonNode world = c.get("world");
            for (JsonNode op : c.get("ops")) {
                String kind = op.get("kind").asText();
                if (only != null && !only.equals(kind)) continue;
                ops++;
                DocumentRepository repo = new InMemoryDocumentRepository();
                world.fields().forEachRemaining(e -> e.getValue().forEach(r -> repo.upsert("t", e.getKey(), r.path("id").asText(UUID.randomUUID().toString()), r)));
                Map<String, Map<String, String>> before = snapshot(repo);
                int auditBefore = repo.list("t", "audit").size();
                AuditTrail audit = new AuditTrail(repo, json, clock);
                SystemWriter w = new SystemWriter(repo, audit, json, clock, constants);
                TestEnv env = new TestEnv(now, repo);
                JsonNode want = op.get("expected");
                JsonNode ret = null;
                try {
                    switch (kind) {
                        case "prePut" -> {
                            int[] n = { 0 };
                            PropertyHooks.Pre r = PropertyHooks.preWrite((ObjectNode) op.get("record"), orNull(op.get("old")), repo.list("t", "properties"), () -> "id-" + (++n[0]));
                            ret = r.error() != null ? json.createObjectNode().put("error", r.error()) : json.createObjectNode().set("record", r.record());
                            count(r.error() != null ? "refusedProperties" : "acceptedProperties", 1);
                        }
                        case "postPut" -> {
                            List<String> ev = new PropertyHooks.Run(repo, audit, "t", op.get("slug").asText(), new SiteProperties(op.get("host").asText(), defaultCommunity), env)
                                    .postWrite(orNull(op.get("old")), op.get("next"), op.get("actor").asText());
                            count("accessEvents", ev.size());
                        }
                        case "impact" -> ret = PropertyHooks.accessImpact(orNull(op.get("old")), op.get("next"));
                        case "meetingPre" -> ret = json.createObjectNode().set("record", MeetingHooks.preWrite((ObjectNode) op.get("record"), orNull(op.get("old")), now));
                        case "meetingPost" -> { if (MeetingHooks.postWrite(new Notifier(w), repo, "t", orNull(op.get("old")), op.get("next"), op.get("actor").asText())) count("meetingMessages", 1); }
                        default -> throw new IllegalStateException(kind);
                    }
                } catch (RuntimeException e) {
                    if (want.path("ret").has("crash")) { count("crashesAlike", 1); continue; }
                    if (problems.isEmpty()) e.printStackTrace();
                    add(kind, op, "CRASH " + e);
                    continue;
                }
                count(kind, 1);
                String diff = compare(want, ret, before, repo, auditBefore, !kind.equals("impact"));
                if (diff != null) add(kind, op, diff);
                else if (want.has("created")) for (String coll : TRACK) { count("rows:" + coll, want.get("created").get(coll).size()); count("changed:" + coll, want.get("changed").get(coll).size()); }
            }
        }
    }

    private void add(String kind, JsonNode op, String diff) {
        if (problems.size() < 300) problems.add(kind + "\n" + diff + "\n   op=" + abbreviate(op.toString()));
    }
    private static String abbreviate(String s) { return s.length() > 1500 ? s.substring(0, 1500) + "..." : s; }

    private Map<String, Map<String, String>> snapshot(DocumentRepository repo) {
        Map<String, Map<String, String>> out = new HashMap<>();
        for (String c : TRACK) { Map<String, String> m = new LinkedHashMap<>(); for (JsonNode r : repo.list("t", c)) if (r.has("id")) m.put(r.path("id").asText(""), canon(r)); out.put(c, m); }
        return out;
    }

    private String compare(JsonNode want, JsonNode ret, Map<String, Map<String, String>> before, DocumentRepository repo, int auditBefore, boolean rows) {
        String a = canon(want.get("ret")), b = canon(ret == null ? json.nullNode() : ret);
        if (!a.equals(b)) return "returned\n   want: " + a + "\n   got:  " + b;
        if (!rows || !want.has("created")) return null;
        for (String c : TRACK) {
            List<String> gotNew = new ArrayList<>();
            Map<String, String> gotChanged = new LinkedHashMap<>();
            for (JsonNode r : repo.list("t", c)) {
                if (!r.has("id")) continue;
                String id = r.path("id").asText("");
                if (!before.get(c).containsKey(id)) { ObjectNode o = r.deepCopy(); o.remove("id"); gotNew.add(canon(o)); }
                else if (!before.get(c).get(id).equals(canon(r))) gotChanged.put(id, canon(r));
            }
            List<String> wantNew = new ArrayList<>();
            want.get("created").get(c).forEach(r -> wantNew.add(canon(r)));
            if (!wantNew.equals(gotNew)) return "new rows in " + c + "\n   want (" + wantNew.size() + "): " + wantNew + "\n   got  (" + gotNew.size() + "): " + gotNew;
            Map<String, String> wantChanged = new LinkedHashMap<>();
            want.get("changed").get(c).fields().forEachRemaining(e -> wantChanged.put(e.getKey(), canon(e.getValue())));
            if (!wantChanged.equals(gotChanged)) return "changed rows in " + c + "\n   want: " + wantChanged + "\n   got:  " + gotChanged;
        }
        ArrayNode gotAudit = json.createArrayNode();
        List<JsonNode> list = repo.list("t", "audit");
        for (JsonNode r : list.subList(auditBefore, list.size()))
            gotAudit.addObject().put("who", r.path("who").asText()).put("whoName", r.path("whoName").asText()).put("what", r.path("what").asText()).put("action", r.path("action").asText())
                    .put("summary", r.path("summary").asText()).put("unit", r.path("unit").asText()).put("recordId", r.path("recordId").asText());
        String wa = canon(want.get("audit")), ga = canon(gotAudit);
        if (!wa.equals(ga)) return "audit\n   want: " + wa + "\n   got:  " + ga;
        return null;
    }
}
