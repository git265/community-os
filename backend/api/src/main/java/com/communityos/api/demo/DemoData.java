package com.communityos.api.demo;

import com.communityos.api.amenity.application.BookingService;
import com.communityos.api.assets.application.AssetService;
import com.communityos.api.billing.adapter.gateway.SimulatedGateway;
import com.communityos.api.billing.application.CounterSettlement;
import com.communityos.api.billing.application.DueService;
import com.communityos.api.billing.application.PaymentService;
import com.communityos.api.comms.application.BroadcastService;
import com.communityos.api.comms.application.ForumService;
import com.communityos.api.cultural.application.DonationService;
import com.communityos.api.cultural.application.ExpenseService;
import com.communityos.api.docs.application.DocumentService;
import com.communityos.api.docs.application.FileService;
import com.communityos.api.finance.application.BankService;
import com.communityos.api.finance.application.CashBookService;
import com.communityos.api.gate.application.GateService;
import com.communityos.api.governance.application.BallotService;
import com.communityos.api.governance.application.MeetingService;
import com.communityos.api.identity.application.MemberService;
import com.communityos.api.identity.domain.MemberView;
import com.communityos.api.maintenance.application.FieldStaffService;
import com.communityos.api.maintenance.application.QuotationService;
import com.communityos.api.maintenance.application.TicketService;
import com.communityos.api.property.application.UnitService;
import com.communityos.api.property.domain.Unit;
import com.communityos.api.shared.domain.Ids.CommunityId;
import com.communityos.api.shared.domain.Ids.MembershipId;
import com.communityos.api.shared.domain.Ids.UnitId;
import com.communityos.api.shared.resource.Item;
import com.communityos.api.shared.resource.ResourceRegistry;
import com.communityos.api.shared.resource.ResourceService;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.CallerLoader;
import com.communityos.api.shared.tenancy.CallerHolder;
import com.communityos.api.vendor.application.DirectoryService;
import com.communityos.api.workforce.application.AttendanceService;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.lang.reflect.RecordComponent;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.function.Supplier;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/**
 * The La Paloma demo on the v2 server: the browser's own sample data (src/lib/seed, written to demo/la-paloma.json by tools/export-demo-seed.mjs),
 * loaded through the real services, as the people who would do each thing and at the time it happened (ReplayClock): the treasurer raises a
 * bill in April and the owner pays it in April, a booking is made the week before its date, the plumber clocks in on his own morning. So the
 * books, the audit trail, the inboxes and every rule are what they would be had people used the app.
 *
 * What the server cannot take as written is reported, not forced in: a row a rule refuses is listed under problems, a collection the v2
 * server does not keep (or keeps itself) under skipped. It runs once per community (its first member's phone is the marker); dev and test only.
 */
public final class DemoData {
    /** The services the demo uses - the same ones the API uses. */
    public record Services(NamedParameterJdbcTemplate jdbc, ObjectMapper json, CallerLoader callers, MemberService members, FieldStaffService staff, UnitService units,
                           DueService dues, CounterSettlement counter, PaymentService payments, Optional<SimulatedGateway> gateway, TicketService tickets,
                           QuotationService quotations, ResourceService kit, ResourceRegistry registry, BookingService bookings, GateService gate, BroadcastService notices,
                           ForumService forum, FileService files, DocumentService documents, DonationService donations, ExpenseService expenses, CashBookService cash,
                           BankService bank, MeetingService meetings, BallotService ballots, DirectoryService directory, AssetService assets, AttendanceService attendance,
                           Clock clock, ZoneId zone) {}
    /** Blocks and units are the community's set-up (the platform's, not a member's): the caller creates the ones the sample data names. */
    public interface Setup { void units(CommunityId community, List<BlockSpec> blocks, List<UnitSpec> units); }
    public record BlockSpec(String name, String kind) {}
    public record UnitSpec(String unitNo, String unitType, String block) {}
    public record Result(boolean loaded, String message, Map<String, Integer> rows, Map<String, String> skipped, List<String> problems) {
        public int members() { return rows.getOrDefault("users", 0) + rows.getOrDefault("handymen (as members)", 0); }
        public int bills() { return rows.getOrDefault("dues", 0); }
    }

    final Services s;
    final ObjectMapper lenient;
    CommunityId community;
    Caller admin;
    LocalDate today;
    JsonNode collections;
    /** "collection:seedId" -> the id the server gave that row */
    final Map<String, UUID> ids = new HashMap<>();
    final Map<String, UUID> unitIds = new HashMap<>();
    /** display name -> member, and the members by role code (first first) */
    final Map<String, MemberView> byName = new LinkedHashMap<>();
    final Map<String, List<MemberView>> byRole = new LinkedHashMap<>();
    final Map<String, Integer> rows = new TreeMap<>();
    final Map<String, String> skipped = new TreeMap<>();
    final List<String> problems = new ArrayList<>();

    public DemoData(Services s) {
        this.s = s;
        this.lenient = s.json().copy().configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false)
            .configure(DeserializationFeature.ACCEPT_SINGLE_VALUE_AS_ARRAY, true).configure(DeserializationFeature.ACCEPT_EMPTY_STRING_AS_NULL_OBJECT, true)
            .configure(DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES, false);   // a yes/no the browser row does not have is "no", as on the app's form
    }

    /** demo/la-paloma.json from the class path (the file tools/export-demo-seed.mjs writes). */
    public static JsonNode bundled(ObjectMapper json) {
        try (var in = DemoData.class.getResourceAsStream("/demo/la-paloma.json")) {
            if (in == null) throw new IllegalStateException("demo/la-paloma.json is missing: run node tools/export-demo-seed.mjs");
            return json.readTree(in);
        } catch (java.io.IOException e) { throw new IllegalStateException("demo/la-paloma.json cannot be read", e); }
    }

    /** Load the sample data into the community, as its Super Admin and the people in it. Safe to call again: the second time it says so and does nothing. */
    public Result load(CommunityId community, Caller superAdmin, JsonNode seed, Setup setup) {
        this.community = community; this.admin = superAdmin; this.today = LocalDate.now(s.clock().withZone(s.zone()));
        this.collections = seed.path("collections");
        JsonNode users = collections.path("users");
        String marker = users.isEmpty() ? null : phone(users.get(0).path("phone").asText());
        if (marker != null && Boolean.TRUE.equals(as(superAdmin, () -> !s.jdbc().query("SELECT 1 AS x FROM identity.membership m JOIN identity.person p ON p.id = m.person_id WHERE p.phone_e164 = :p",
                Map.of("p", marker), (rs, i) -> 1).isEmpty())))
            return new Result(false, "The demo is already loaded in this community", Map.of(), Map.of(), List.of());

        seed.path("kinds").fields().forEachRemaining((k) -> { if ("browser-only".equals(k.getValue().asText())) skipped.put(k.getKey(), "kept in the browser on the v2 back end"); });
        units(setup);
        people();
        DemoFlows flows = new DemoFlows(this);
        for (String c : order(flows)) {
            if (c.equals("properties") || c.equals("users") || c.equals("handymen")) continue;
            JsonNode list = collections.path(c);
            if (flows.handles(c)) flows.load(c, list);
            else if (kit(c).isPresent()) register(c, list);
            else skipped.putIfAbsent(c, DemoFlows.NOT_ON_V2.getOrDefault(c, "not on the v2 back end"));
        }
        flows.finish();
        closeEvents();
        int n = rows.values().stream().mapToInt(Integer::intValue).sum();
        return new Result(true, "La Paloma sample data loaded: " + n + " records" + (problems.isEmpty() ? "" : ", " + problems.size() + " refused"), rows, skipped, problems);
    }

    // ---- blocks, units, people -----------------------------------------------------------------------------------------------------------------
    void units(Setup setup) {
        Map<String, String> blockOf = new HashMap<>(), typeOf = new HashMap<>();
        for (JsonNode p : collections.path("properties")) {
            if (!p.path("zone").asText().isBlank()) blockOf.put(p.path("unit").asText(), p.path("zone").asText());
            typeOf.put(p.path("unit").asText(), p.path("type").asText("Villa"));
        }
        Set<String> wanted = new LinkedHashSet<>();
        collectUnits(collections, wanted);
        wanted.removeIf((u) -> u.isBlank() || u.equals("Common area") || u.startsWith("Association"));
        List<BlockSpec> blocks = new ArrayList<>();
        for (JsonNode b : collections.path("blocks")) blocks.add(new BlockSpec(b.path("name").asText(), blockKind(b.path("kind").asText())));
        List<UnitSpec> specs = new ArrayList<>();
        for (String u : wanted) specs.add(new UnitSpec(u, typeOf.getOrDefault(u, u.startsWith("Villa") ? "Villa" : "Apartment"), blockOf.get(u)));
        if (setup != null) setup.units(community, blocks, specs);
        for (Map.Entry<String, Object> u : as(admin, () -> s.jdbc().query("SELECT id, unit_no FROM property.unit", Map.of(), (rs, i) -> Map.<String, Object>entry(rs.getString("unit_no"), rs.getObject("id", UUID.class)))))
            unitIds.put(u.getKey(), (UUID) u.getValue());
        for (String u : wanted) if (!unitIds.containsKey(u)) problems.add("units " + u + ": the community has no such unit");
        // a unit's own details (type, occupancy, area) through the unit service
        for (JsonNode p : collections.path("properties")) {
            UUID id = unitIds.get(p.path("unit").asText());
            if (id == null) continue;
            attempt("properties", p, () -> {
                Unit u = as(admin, () -> s.units().get(admin, new UnitId(id)));
                as(admin, () -> s.units().change(admin, new UnitId(id), u.version(), new Unit.Changes(text(p, "type"), text(p, "occupancy"), dec(p, "areaSqft"), null, null),
                    Map.of()));
                return id;
            });
        }
    }
    static String blockKind(String k) { return k.contains("Tower") ? "Tower" : k.contains("lane") || k.contains("Lane") ? "Lane" : k.contains("Phase") ? "Phase" : k.contains("Zone") ? "Zone" : "Block"; }
    static void collectUnits(JsonNode n, Set<String> out) {
        if (n.isObject()) {
            if (n.size() == 1 && n.has("$unit")) { out.add(n.get("$unit").asText()); return; }
            for (Iterator<Map.Entry<String, JsonNode>> it = n.fields(); it.hasNext(); ) {
                Map.Entry<String, JsonNode> e = it.next();
                if ((e.getKey().equals("unit") || e.getKey().equals("addedByUnit")) && e.getValue().isTextual()) out.add(e.getValue().asText());
                else if (e.getKey().equals("units") && e.getValue().isArray()) e.getValue().forEach((x) -> { if (x.isTextual()) out.add(x.asText()); });
                else collectUnits(e.getValue(), out);
            }
        } else if (n.isArray()) n.forEach((x) -> collectUnits(x, out));
    }

    /** The members: committee, staff, owners and tenants (with their unit), their other roles; field staff who had no account get one. */
    void people() {
        Map<String, String> relation = new HashMap<>();   // "name|unit" -> Owner / Co-owner / Tenant
        for (JsonNode p : collections.path("properties")) {
            String u = p.path("unit").asText();
            relation.put(p.path("owner").asText() + "|" + u, "Owner");
            if (!p.path("tenant").asText().isBlank()) relation.put(p.path("tenant").asText() + "|" + u, "Tenant");
            for (JsonNode x : p.path("people")) relation.put(x.path("name").asText() + "|" + u, x.path("relation").asText().contains("owner") ? "Co-owner" : "Family");
        }
        for (JsonNode u : collections.path("users")) {
            attempt("users", u, () -> {
                String unitNo = u.path("units").isArray() && !u.path("units").isEmpty() ? u.path("units").get(0).asText() : null;
                UUID unit = unitNo == null ? null : unitIds.get(unitNo);
                String rel = unit == null ? null : relation.getOrDefault(u.path("name").asText() + "|" + unitNo, "resident".equals(u.path("roleId").asText()) ? "Tenant" : "Owner");
                MemberView added = as(admin, () -> s.members().add(admin, new MemberService.AddMember(phone(u.path("phone").asText()), u.path("name").asText(), null, u.path("roleId").asText(),
                    unit == null ? null : new UnitId(unit), rel)));
                MemberView m = added;
                List<String> extra = new ArrayList<>();
                u.path("extraRoleIds").forEach((x) -> extra.add(x.asText()));
                if (!extra.isEmpty()) {
                    List<String> all = new ArrayList<>(List.of(u.path("roleId").asText())); all.addAll(extra);
                    m = as(admin, () -> s.members().changeRoles(admin, added.id(), new MemberService.ChangeRoles(all, u.path("roleId").asText()), s.members().get(admin, added.id()).version()));
                }
                remember(m);
                return m.id().value();
            });
        }
        // the homes' owners, co-owners and tenants the sample names without an account: members too (Owner / Resident), so on the v2 back end the unit
        // directory, the owners' list and the voter roll name them as the browser demo does
        for (JsonNode p : collections.path("properties")) {
            UUID unit = unitIds.get(p.path("unit").asText());
            if (unit == null) continue;
            List<String[]> people = new ArrayList<>();   // name, phone, role, relation
            people.add(new String[] {p.path("owner").asText(), p.path("ownerPhone").asText(), "owner", "Owner"});
            for (JsonNode x : p.path("people")) if (x.path("relation").asText().toLowerCase().contains("owner")) people.add(new String[] {x.path("name").asText(), x.path("phone").asText(), "owner", "Co-owner"});
            people.add(new String[] {p.path("tenant").asText(), p.path("tenantPhone").asText(), "resident", "Tenant"});
            for (String[] w : people) {
                String ph = phone(w[1]);
                if (w[0].isBlank() || ph == null || ph.isBlank() || byName.containsKey(w[0])) continue;
                attempt("owners & tenants (as members)", p, () -> {
                    MemberView m = as(admin, () -> s.members().add(admin, new MemberService.AddMember(ph, w[0], null, w[2], new UnitId(unit), w[3])));
                    remember(m);
                    return m.id().value();
                });
            }
        }
        // field staff: the members who work the trades (a handyman without an account becomes a member with the trade's role)
        for (JsonNode h : collections.path("handymen")) {
            attempt("handymen", h, () -> {
                MemberView m = byName.get(h.path("name").asText());
                if (m == null) {
                    String role = switch (h.path("trade").asText()) { case "Plumbing" -> "handyman_plumbing"; case "Electrical" -> "handyman_electrical"; case "MEP" -> "handyman_mep";
                        case "Security" -> "handyman_security"; default -> "handyman_general"; };
                    m = as(admin, () -> s.members().add(admin, new MemberService.AddMember(phone(h.path("phone").asText()), h.path("name").asText(), null, role, null, null)));
                    remember(m); rows.merge("handymen (as members)", 1, Integer::sum);
                }
                MembershipId mid = m.id();
                var f = as(admin, () -> s.staff().add(admin, mid, h.path("trade").asText(), text(h, "shift"), phone(h.path("phone").asText())));
                return f.id();
            });
        }
        for (JsonNode u : collections.path("users")) {
            if (!"Inactive".equals(u.path("status").asText())) continue;
            MemberView m = byName.get(u.path("name").asText());
            if (m != null) attempt("users (deactivated)", u, () -> as(admin, () -> s.members().deactivate(admin, m.id(), s.members().get(admin, m.id()).version())).id().value());
        }
    }
    void remember(MemberView m) {
        byName.put(m.displayName(), m);
        for (MemberView.Role r : m.roles()) byRole.computeIfAbsent(r.code(), (k) -> new ArrayList<>()).add(m);
    }

    /** The member a sample row names: by name, else by role ("Facility Manager", "Treasurer"), else the Super Admin. */
    Caller who(String name, String roleCode) {
        MemberView m = name == null ? null : byName.get(name.strip());
        if (m == null && roleCode != null && byRole.containsKey(roleCode)) m = byRole.get(roleCode).get(0);
        if (m == null && name != null) {
            String code = name.strip().toLowerCase().replace(' ', '_').replace("secretary", "general_secretary").replace("general_general_", "general_");
            if (byRole.containsKey(code)) m = byRole.get(code).get(0);
            else if (name.contains("Committee") && byRole.containsKey("committee_" + name.strip().split(" ")[0].toLowerCase())) m = byRole.get("committee_" + name.strip().split(" ")[0].toLowerCase()).get(0);
        }
        return m == null ? admin : caller(m);
    }
    Caller role(String code) { return byRole.containsKey(code) ? caller(byRole.get(code).get(0)) : admin; }
    /** The member living in (or owning) a unit, else the Super Admin. */
    Caller ofUnit(String unitNo) {
        UUID u = unitIds.get(unitNo);
        if (u == null) return admin;
        for (MemberView m : byName.values()) if (m.units().contains(new UnitId(u)) && "Active".equals(m.status())) return caller(m);
        return admin;
    }
    private final Map<MembershipId, Caller> callers = new HashMap<>();
    Caller caller(MemberView m) {
        return callers.computeIfAbsent(m.id(), (k) -> s.callers().load(m.person(), community, m.id()).orElseThrow(() -> new IllegalStateException("cannot sign in as " + m.displayName())));
    }

    // ---- the registers (the resource kit): the exported body, its references swapped for the server's ids ----------------------------------------
    Optional<ResourceRegistry.Entry<?>> kit(String collection) {
        return s.registry().all().stream().filter((e) -> e.resource().table().collection().equals(collection)).findFirst();
    }
    void register(String c, JsonNode list) {
        ResourceRegistry.Entry<?> e = kit(c).orElseThrow();
        if (e.resource().table().path().endsWith("/runs") || e.resource().table().path().endsWith("/outbox")) { skipped.put(c, "written by the server"); return; }
        for (JsonNode row : list) attempt(c, row, () -> {
            JsonNode body = resolve(row);
            // an event that is over takes its pledges, receipts and expenses first: it is opened now and closed again at the end (closeEvents)
            if ("culturalEvents".equals(c) && List.of("Completed", "Cancelled").contains(body.path("status").asText())) {
                later.add(row); ((ObjectNode) body).put("status", "Open");
            }
            return put(e, body);
        });
    }
    private final List<JsonNode> later = new ArrayList<>();
    void closeEvents() {
        ResourceRegistry.Entry<?> e = kit("culturalEvents").orElseThrow();
        for (JsonNode row : later) attempt("culturalEvents (closed)", row, () -> replace(e, ids.get("culturalEvents:" + row.path("id").asText()), resolve(row)));
    }
    private <F extends Record> UUID replace(ResourceRegistry.Entry<F> e, UUID id, JsonNode body) {
        if (id == null) throw new IllegalArgumentException("it was not loaded");
        Item<F> it = as(admin, () -> s.kit().get(admin, e.resource(), e.repository(), id));
        ObjectNode merged = lenient.valueToTree(it.data());
        body.fields().forEachRemaining((f) -> { if (!f.getKey().equals("id")) merged.set(f.getKey(), f.getValue()); });
        F f = read(e, merged);
        return as(admin, () -> s.kit().replace(admin, e.resource(), e.repository(), id, it.version(), f)).id();
    }
    private <F extends Record> UUID put(ResourceRegistry.Entry<F> e, JsonNode body) {
        ObjectNode b = ((ObjectNode) body.deepCopy()); b.remove("id");
        F fields = read(e, b);
        // only a row the community had before the load can be "the same" (two sample rows may share a name: both are kept)
        List<Item<F>> existing = as(admin, () -> s.kit().list(admin, e.resource(), e.repository())).stream().filter((it) -> !made.contains(it.id())).toList();
        Item<F> same = existing.stream().filter((it) -> sameKey(it.data(), fields)).findFirst().orElse(null);
        if (same == null && existing.size() == 1 && singleton(e)) same = existing.get(0);
        if (same != null) {
            // a default the community was given: the browser's version of it, keeping what the browser row does not say (as the app's save does)
            ObjectNode merged = lenient.valueToTree(same.data());
            b.fields().forEachRemaining((f) -> merged.set(f.getKey(), f.getValue()));
            F f = read(e, merged); Item<F> x = same;
            made.add(x.id());
            return as(admin, () -> s.kit().replace(admin, e.resource(), e.repository(), x.id(), x.version(), f)).id();
        }
        UUID id = as(admin, () -> s.kit().create(admin, e.resource(), e.repository(), fields)).id();
        made.add(id);
        return id;
    }
    private final Set<UUID> made = new HashSet<>();
    private <F extends Record> F read(ResourceRegistry.Entry<F> e, JsonNode b) {
        try { return lenient.treeToValue(b, e.resource().table().type()); }
        catch (Exception x) { throw new IllegalArgumentException("not a valid " + e.resource().table().collection() + ": " + x.getMessage().split("\n")[0]); }
    }
    static boolean singleton(ResourceRegistry.Entry<?> e) { String p = e.resource().table().path(); return p.endsWith("settings") || p.endsWith("attendance-settings"); }
    /** Two register rows are the same thing when their first naming field (name, title, phrase, token ...) matches - a default the community was given. */
    static boolean sameKey(Record a, Record b) {
        for (String k : List.of("name", "title", "phrase", "token", "code", "category", "event", "item", "label", "service")) {
            Object x = component(a, k), y = component(b, k);
            if (y != null) return x != null && x.toString().equalsIgnoreCase(y.toString()) && sameOrNull(component(a, "channel"), component(b, "channel")) && sameOrNull(component(a, "audience"), component(b, "audience"));
        }
        return false;
    }
    private static boolean sameOrNull(Object a, Object b) { return a == null || b == null || Objects.equals(a, b); }
    static Object component(Record r, String name) {
        for (RecordComponent c : r.getClass().getRecordComponents()) if (c.getName().equals(name)) {
            try { return c.getAccessor().invoke(r); } catch (ReflectiveOperationException e) { return null; }
        }
        return null;
    }

    /** {"$ref": "c:id"} -> the server's id of that row; {"$unit": "Villa 1"} -> the unit's id; {"$member": "Name"} -> the membership id. Anything unknown becomes null. */
    JsonNode resolve(JsonNode n) {
        if (n.isObject()) {
            if (n.size() == 1 && n.has("$ref")) { UUID id = ids.get(n.get("$ref").asText()); return id == null ? JsonNodeFactory.instance.nullNode() : JsonNodeFactory.instance.textNode(id.toString()); }
            if (n.size() == 1 && n.has("$unit")) { UUID id = unitIds.get(n.get("$unit").asText()); return id == null ? JsonNodeFactory.instance.nullNode() : JsonNodeFactory.instance.textNode(id.toString()); }
            if (n.size() == 1 && n.has("$role")) { UUID id = roleId(n.get("$role").asText()); return id == null ? JsonNodeFactory.instance.nullNode() : JsonNodeFactory.instance.textNode(id.toString()); }
            if (n.size() == 1 && n.has("$member")) { MemberView m = byName.get(n.get("$member").asText()); return m == null ? JsonNodeFactory.instance.nullNode() : JsonNodeFactory.instance.textNode(m.id().value().toString()); }
            ObjectNode out = JsonNodeFactory.instance.objectNode();
            n.fields().forEachRemaining((e) -> out.set(e.getKey(), resolve(e.getValue())));
            return out;
        }
        if (n.isArray()) {
            ArrayNode out = JsonNodeFactory.instance.arrayNode();
            n.forEach((x) -> { JsonNode r = resolve(x); if (!(r.isNull() && x.isObject())) out.add(r); });
            return out;
        }
        return n;
    }
    private final Map<String, UUID> roles = new HashMap<>();
    UUID roleId(String code) {
        return roles.computeIfAbsent(code, (k) -> as(admin, () -> s.jdbc().query("SELECT id FROM identity.role WHERE code = :c", Map.of("c", k), (rs, i) -> rs.getObject("id", UUID.class)))
            .stream().findFirst().orElse(null));
    }
    UUID ref(JsonNode row, String field) { JsonNode r = resolve(row.path(field)); return r.isTextual() ? UUID.fromString(r.asText()) : null; }

    /** The order to load in: every collection after the ones its rows point at (a few back-references are made by the server instead). */
    List<String> order(DemoFlows flows) {
        Map<String, Set<String>> deps = new LinkedHashMap<>();
        collections.fieldNames().forEachRemaining((c) -> {
            Set<String> d = new HashSet<>();
            for (JsonNode row : collections.path(c)) row.fields().forEachRemaining((f) -> { if (!DemoFlows.BACK_REFS.contains(c + "." + f.getKey())) refsIn(f.getValue(), d); });
            d.addAll(flows.after(c));
            d.remove(c);
            deps.put(c, d);
        });
        List<String> out = new ArrayList<>(); Set<String> done = new HashSet<>();
        while (out.size() < deps.size()) {
            boolean moved = false;
            for (Map.Entry<String, Set<String>> e : deps.entrySet()) {
                if (done.contains(e.getKey())) continue;
                if (e.getValue().stream().allMatch((d) -> done.contains(d) || !deps.containsKey(d))) { out.add(e.getKey()); done.add(e.getKey()); moved = true; }
            }
            if (!moved) { String next = deps.keySet().stream().filter((k) -> !done.contains(k)).findFirst().orElseThrow(); out.add(next); done.add(next); problems.add("order: a loop through " + next); }
        }
        return out;
    }
    static void refsIn(JsonNode n, Set<String> out) {
        if (n.isObject() && n.size() == 1 && n.has("$ref")) { out.add(n.get("$ref").asText().split(":")[0]); return; }
        if (n.isContainerNode()) n.forEach((x) -> refsIn(x, out));
    }

    // ---- helpers ----------------------------------------------------------------------------------------------------------------------------------
    /** Run one row's work; remember the id it got, count it, or note why the server refused it (and go on). */
    void attempt(String collection, JsonNode row, Supplier<UUID> work) {
        String seedId = row.path("id").asText("?");
        try {
            UUID id = work.get();
            if (id != null) ids.put(collection + ":" + seedId, id);
            rows.merge(collection, 1, Integer::sum);
        } catch (RuntimeException e) {
            String m = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
            problems.add(collection + " " + seedId + ": " + m.split("\n")[0]);
        }
    }
    /** Do it as that person, at that moment (the moment only on this thread; see ReplayClock). */
    <T> T as(Caller c, Supplier<T> work) { return CallerHolder.runAs(c, work); }
    <T> T at(Instant when, Caller c, Supplier<T> work) {
        if (when == null || !when.isBefore(Instant.now(s.clock()))) return as(c, work);
        return ReplayClock.at(when, () -> as(c, work));
    }
    Instant on(LocalDate d, int hour) { return d == null ? null : d.atTime(LocalTime.of(hour, 0)).atZone(s.zone()).toInstant(); }

    static String phone(String p) { return p == null ? null : p.replaceAll("[^+0-9]", ""); }
    static String text(JsonNode r, String f) { String v = r.path(f).asText(null); return v == null || v.isBlank() || r.path(f).isNull() ? null : v; }
    static BigDecimal dec(JsonNode r, String f) { JsonNode v = r.path(f); if (v.isNumber()) return v.decimalValue(); if (v.isTextual() && !v.asText().isBlank()) try { return new BigDecimal(v.asText().replace(",", "")); } catch (NumberFormatException e) { return null; } return null; }
    static LocalDate date(JsonNode r, String f) {
        String v = text(r, f);
        if (v == null) return null;
        try { return v.length() >= 10 && v.charAt(4) == '-' ? LocalDate.parse(v.substring(0, 10)) : LocalDate.parse(v, java.time.format.DateTimeFormatter.ofPattern("dd MMM yyyy", java.util.Locale.ENGLISH)); }
        catch (java.time.format.DateTimeParseException e) { return null; }
    }
    static Instant instant(JsonNode r, String f) { String v = text(r, f); if (v == null) return null; try { return Instant.parse(v); } catch (java.time.format.DateTimeParseException e) { return null; } }
    static LocalTime time(JsonNode r, String f) { String v = text(r, f); if (v == null) return null; try { return LocalTime.parse(v.length() == 4 ? "0" + v : v.substring(0, 5)); } catch (RuntimeException e) { return null; } }
}
