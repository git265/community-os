package com.communityos.service;

import com.communityos.access.AuthzDeniedException;
import com.communityos.access.CommunityMeta;
import com.communityos.access.CommunityMetaLoader;
import com.communityos.access.PeriodLock;
import com.communityos.access.PrincipalResolver;
import com.communityos.access.ServerHooks;
import com.communityos.adapter.persistence.RowQuery;
import com.communityos.config.AppProperties;
import com.communityos.evoting.EVotingGuard;
import com.communityos.evoting.EVotingState;
import com.communityos.evoting.RandomSource;
import com.communityos.domain.PageResult;
import com.communityos.domain.QuerySpec;
import com.communityos.domain.ScopeNode;
import com.communityos.port.DocumentRepository;
import com.communityos.security.BlockScope;
import com.communityos.payments.FinanceSettlement;
import com.communityos.security.Constants;
import com.communityos.security.FieldMasking;
import com.communityos.security.Js;
import com.communityos.security.Perms;
import com.communityos.security.Principal;
import com.communityos.amenities.AmenityPosting;
import com.communityos.amenities.AmenityRules;
import com.communityos.amenities.Defaulters;
import com.communityos.payments.BookingClaims;
import com.communityos.security.MoneyGuard;
import com.communityos.security.PollRules;
import com.communityos.security.RawReader;
import com.communityos.security.ReadRules;
import com.communityos.security.RowScope;
import com.communityos.security.RowScopes;
import com.communityos.security.Schema;
import com.communityos.security.Verdict;
import com.communityos.security.WriteCall;
import com.communityos.security.WriteRules;
import com.communityos.security.WritePrep;
import com.communityos.service.audit.AuditDiff;
import com.communityos.service.audit.AuditTrail;
import com.communityos.service.audit.RecordTrail;
import com.communityos.service.audit.Stamps;
import com.communityos.web.BadRequestException;
import com.communityos.web.ConflictException;
import com.communityos.web.Names;
import com.communityos.web.NotFoundException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Service;

/**
 * Every read and write of a community's records, with the rules on. For each call: who is asking (token -> users record -> role), whether
 * their role may touch the collection, which ROWS they may see (own villa, own block ...), which FIELDS are hidden from them, then for a
 * write: the rule book's verdict, the block limit, the closed-books date, the version they loaded (409 when someone else saved first), the
 * server-stamped metadata (short id, version, who and when, time trail) and the audit line, all in ONE transaction with the record locked.
 *
 * The Java form of src/lib/storage/secureStorage.js + the guards in backend/contract-server/service.mjs. The rules themselves
 * (com.communityos.security) are proven identical to the JavaScript ones by RuleBookConformanceTest.
 */
@Service
public class SecureRecordService {
    private static final Logger log = LoggerFactory.getLogger(SecureRecordService.class);
    /** Payments are settled by the payment service, never written by the app (not even by the Super Admin). */
    private static final Set<String> RESIDENT_NO_DIRECT = Set.of("dues", "ledger", "unitCredits");
    private static final long TICKET_BASE = 1050;   // ticket numbers continue from TKT-1051
    private static final Set<String> META_WATCHED = CommunityMetaLoader.WATCHED;

    private final DocumentRepository repo;
    private final CommunityMetaLoader metas;
    private final PrincipalResolver principals;
    private final WriteRules rules;
    private final ServerHooks hooks;
    private final AuditTrail audit;
    private final Tx tx;
    private final ObjectMapper json;
    private final Clock clock;
    private final Constants constants;
    private final FinanceSettlement finance;
    private final AmenityPosting amenityPosting;
    private final com.communityos.notify.EventNotifications events;
    private final BookingClaims claims;
    private final EVotingState evotingState;
    private final RandomSource random;
    private final ZoneId zone = ZoneId.systemDefault();   // the community's local time, as the JavaScript server reads it (set TZ / -Duser.timezone)
    private final Set<String> platformCollections;

    public SecureRecordService(DocumentRepository repo, CommunityMetaLoader metas, PrincipalResolver principals, WriteRules rules, ServerHooks hooks,
                               AuditTrail audit, Tx tx, ObjectMapper json, Clock clock, Constants constants, AppProperties props, FinanceSettlement finance, BookingClaims claims,
                               EVotingState evotingState, RandomSource random) {
        this.repo = repo; this.metas = metas; this.principals = principals; this.rules = rules; this.hooks = hooks; this.audit = audit;
        this.tx = tx; this.json = json; this.clock = clock; this.constants = constants; this.finance = finance; this.claims = claims; this.evotingState = evotingState; this.random = random;
        this.amenityPosting = new AmenityPosting(repo, audit, json, clock, constants, new com.communityos.amenities.AmenityNotifier(repo, new com.communityos.amenities.AmenitySystem(repo, audit, clock, constants), json));
        this.platformCollections = Set.copyOf(props.storage().platformCollections());
        com.communityos.finance.SystemWriter writer = new com.communityos.finance.SystemWriter(repo, audit, json, clock, constants);
        this.writer = writer;
        this.notifier = new com.communityos.notify.Notifier(writer);
        this.events = new com.communityos.notify.EventNotifications(writer, notifier);
    }

    private final com.communityos.finance.SystemWriter writer;
    private final com.communityos.notify.Notifier notifier;
    private final java.security.SecureRandom inviteRandom = new java.security.SecureRandom();
    private com.communityos.people.SiteProperties site = com.communityos.people.SiteProperties.defaults();
    /** Where people open the app (app.site.*): the start of the sign-in links in portal invites. */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    public void setSite(com.communityos.people.SiteProperties site) { if (site != null) this.site = site; }

    // ---- who is asking -----------------------------------------------------------------------------------------------------

    /** The caller in one community: principal, rule data, and the storage tenant of the collection being touched. */
    private record Caller(String community, Principal p, CommunityMeta meta) {}

    private Caller caller(String community, Authentication who) {
        String tenant = Names.tenant(community);
        CommunityMeta meta = metas.of(tenant);
        return new Caller(tenant, principals.resolve(who, tenant, meta), meta);
    }

    private String tenantFor(String community, String collection) { return platformCollections.contains(collection) ? "platform" : community; }

    public Principal principal(String community, Authentication who) { return caller(community, who).p(); }
    public boolean canRead(String community, Authentication who, String collection) { Caller c = caller(community, who); return ReadRules.canRead(collection, c.p()); }
    public boolean canWrite(String community, Authentication who, String collection) { Caller c = caller(community, who); return rules.canWriteCollection(collection, c.p()); }
    /** May replace the bytes of a saved file: the Super Admin and document managers (the same rule as editing a file record). */
    public boolean mayManageFiles(String community, Authentication who) { Principal p = caller(community, who).p(); return Perms.isAdmin(p) || Perms.has(p, "MANAGE_DOCUMENTS"); }

    // ---- reads -------------------------------------------------------------------------------------------------------------

    /** Raw rows of any collection of this community (what the row rules look at), read once per call. */
    private RawReader raw(Caller c) {
        Map<String, List<JsonNode>> memo = new HashMap<>();
        return (collection) -> memo.computeIfAbsent(collection, (k) -> repo.list(tenantFor(c.community(), k), k));
    }

    private ScopeNode sqlOf(RowScope s) { return s.sql() == null ? new ScopeNode.All() : s.sql(); }

    /** The in-memory path, always correct: scope -> transform -> mask. */
    private List<JsonNode> scoped(Caller c, String collection) {
        Principal p = c.p();
        if (!ReadRules.canRead(collection, p)) return List.of();
        Schema schema = c.meta().catalog().schema(collection);
        RawReader raw = raw(c);
        RowScope scope = RowScopes.rowScope(collection, p, raw, c.meta().ctx());
        List<JsonNode> rows = raw.read(collection);
        if ("ballotBox".equals(collection)) {   // the ballot box stays sealed, for everyone, until the ballot is closed
            Set<String> closed = new LinkedHashSet<>();
            for (JsonNode b : raw.read("ballots")) if (Js.is(b, "status", "Closed")) closed.add(Js.str(b, "id"));
            rows = rows.stream().filter((r) -> closed.contains(Js.str(r, "ballotId"))).toList();
        }
        List<JsonNode> out = new ArrayList<>(rows.size());
        for (JsonNode r : rows) {
            if (scope.predicate() != null && !scope.predicate().test(r)) continue;
            JsonNode x = scope.transform() != null ? scope.transform().apply(r) : r;
            out.add(FieldMasking.mask(x, schema, p.roleId(), p));
        }
        return out;
    }

    /** The database applies the scope (typed tables, or no row rule at all), unless a field the caller may not see could be revealed by the request. */
    private record Fast(RowScope scope) {}

    private Fast fast(Caller c, String collection, QuerySpec spec) {
        Principal p = c.p();
        if ("ballotBox".equals(collection) || !ReadRules.canRead(collection, p)) return null;
        RowScope scope = RowScopes.rowScope(collection, p, raw(c), c.meta().ctx());
        if (scope.predicate() != null && scope.sql() == null) return null;                         // not expressible as SQL: use memory
        if (!repo.supportsScope(collection) && (scope.predicate() != null || scope.sql() != null)) return null;   // this table cannot push a row rule down
        if (spec != null) {
            Schema schema = c.meta().catalog().schema(collection);
            List<String> hidden = FieldMasking.hiddenFieldKeys(schema, p.roleId(), p);
            List<String> keys = queryKeys(spec);
            if (keys.stream().anyMatch(hidden::contains)) return null;
            if (!spec.search().isBlank() && spec.searchKeys().isEmpty() && !hidden.isEmpty()) return null;
            if (scope.transform() != null && (!keys.isEmpty() || !spec.search().isBlank())) return null;   // a transform may change the very values being filtered
        }
        return new Fast(scope);
    }

    private static List<String> queryKeys(QuerySpec s) {
        List<String> keys = new ArrayList<>(s.filters().keySet());
        for (String k : new String[]{s.sortKey(), s.dateKey(), s.periodKey()}) if (k != null && !k.isBlank()) keys.add(k);
        keys.addAll(s.searchKeys());
        return keys;
    }

    private JsonNode shape(JsonNode row, RowScope scope, Schema schema, Principal p) {
        return FieldMasking.mask(scope.transform() != null ? scope.transform().apply(row) : row, schema, p.roleId(), p);
    }

    public List<JsonNode> list(String community, Authentication who, String collection) {
        Names.collection(collection);
        Caller c = caller(community, who);
        Fast f = fast(c, collection, null);
        if (f == null) return scoped(c, collection);
        Schema schema = c.meta().catalog().schema(collection);
        List<JsonNode> out = new ArrayList<>();
        for (JsonNode r : repo.listScoped(tenantFor(c.community(), collection), collection, sqlOf(f.scope()))) out.add(shape(r, f.scope(), schema, c.p()));
        return out;
    }

    public PageResult query(String community, Authentication who, String collection, QuerySpec spec) {
        Names.collection(collection);
        Caller c = caller(community, who);
        Fast f = fast(c, collection, spec);
        if (f == null) return RowQuery.run(scoped(c, collection), spec);
        Schema schema = c.meta().catalog().schema(collection);
        PageResult r = repo.queryScoped(tenantFor(c.community(), collection), collection, spec, sqlOf(f.scope()));
        List<JsonNode> rows = new ArrayList<>();
        for (JsonNode row : r.rows()) rows.add(shape(row, f.scope(), schema, c.p()));
        return new PageResult(rows, r.total(), r.page(), r.pageSize(), r.pages(), r.approx());
    }

    public JsonNode get(String community, Authentication who, String collection, String id) {
        Names.collection(collection); Names.id(id);
        Caller c = caller(community, who);
        Fast f = fast(c, collection, null);
        if (f != null) {
            Optional<JsonNode> r = repo.getScoped(tenantFor(c.community(), collection), collection, id, sqlOf(f.scope()));
            return r.map((row) -> shape(row, f.scope(), c.meta().catalog().schema(collection), c.p())).orElseThrow(() -> new NotFoundException("Not found."));
        }
        return scoped(c, collection).stream().filter((r) -> Js.is(r, "id", id)).findFirst().orElseThrow(() -> new NotFoundException("Not found."));
    }

    // ---- writes ------------------------------------------------------------------------------------------------------------

    /** Optional text the screen sends with a save: a label for the audit line and a ready-made summary. */
    public record WriteOptions(String label, String summary) {
        public static final WriteOptions NONE = new WriteOptions(null, null);
    }

    private AuthzDeniedException denied(Caller c, String collection, String op, JsonNode record, String reason) {
        ObjectNode entry = AuditTrail.audited(collection)
                ? audit.entry(c.p(), labelOf(c, collection, null), collection, record, "Denied", op + " blocked: " + reason, null) : null;
        return new AuthzDeniedException(reason, entry);
    }

    private String labelOf(Caller c, String collection, String label) {
        if (label != null && !label.isBlank()) return label;
        Schema s = c.meta().catalog().schema(collection);
        return s != null && s.label() != null ? s.label() : collection;
    }

    /** Runs a write in one transaction; a refusal rolls it back and is then written to the audit trail on its own. */
    private <T> T write(Caller c, java.util.function.Supplier<T> work) {
        try {
            T out = tx.run(work);
            return out;
        } catch (AuthzDeniedException d) {
            if (d.auditEntry() != null) {
                try { audit.write(c.community(), d.auditEntry()); } catch (RuntimeException e) { log.warn("could not record a refused write in the audit trail", e); }
            }
            throw d;
        }
    }

    private void clientGuard(Caller c, String collection, String op, JsonNode record) {
        if (Perms.isResident(c.p()) && RESIDENT_NO_DIRECT.contains(collection))
            throw denied(c, collection, op, record, "Payments are confirmed by the payment service, not by the app. Use Pay on the bill.");
    }

    /** The server's decision on a booking write (AmenityRules reads nothing itself: the lists, the clock and the two lookups come from here). */
    private AmenityRules.Result amenityDecision(Caller c, ObjectNode record, JsonNode old, boolean isNew, String id) {
        RawReader raw = raw(c);
        List<JsonNode> settingsRows = raw.read("amenitySettings"), financeRows = raw.read("financeSettings");
        AmenityRules.Ctx ctx = new AmenityRules.Ctx(raw.read("amenityTypes"), settingsRows.isEmpty() ? json.createObjectNode() : settingsRows.get(0), raw.read("amenities"),
                raw.read("unitCredits"), raw.read("properties"), raw.read("amenityItems"));
        JsonNode finance = financeRows.isEmpty() ? json.createObjectNode() : financeRows.get(0);
        String localToday = LocalDate.now(clock.withZone(zone)).toString();
        AmenityRules.DefaulterCheck defaulter = (unit) -> Defaulters.block(unit, finance, Js.truthy(finance, "blockDefaulters") ? raw.read("dues") : List.of(), localToday, zone);
        AmenityRules.PaymentVerifier verifier = claims == null ? null
                : (ref, unit, amount, bookingId) -> claims.claimForBooking(c.community(), ref, unit, BigDecimal.valueOf(amount), bookingId);
        return AmenityRules.preWrite(ctx, record, old, isNew, c.p(), clock, zone, verifier, id, defaulter, () -> AmenityRules.gatewayRef(clock));
    }

    private String hookRefusal(String collection, JsonNode old, JsonNode next) { return hooks.refusal(collection, old, next); }

    /**
     * The business rules that are part of the server and apply to everyone, the Super Admin included: the money rules (releases, payments,
     * invoices and quotations, task approvals) and one poll answer per villa. They run on every write path, bulk ones too (the Node server only runs them for single writes; checking bulk writes as well is stricter, never looser).
     * @return the reason to refuse, or null when the write may go on
     */
    /** Bookings are priced, checked and paid one at a time: a bulk write would skip all of that (the Node server has the same gap; here it is closed). */
    private void bulkGuard(Caller c, String collection, String op, JsonNode first) {
        if ("amenities".equals(collection)) throw denied(c, collection, op, first, "Amenity bookings are made and changed one at a time, so each one is priced and checked.");
        if (EVotingGuard.covers(collection)) throw denied(c, collection, op, first, "Ballots, voter-roll marks and votes are written one at a time, so each one is checked.");
        if (NO_BULK.contains(collection)) throw denied(c, collection, op, first, "These records are saved one at a time");
    }

    private String builtInRefusal(RawReader raw, String collection, JsonNode record, JsonNode old, String op) {
        String why = "";
        if (MoneyGuard.covers(collection)) why = MoneyGuard.preWrite(collection, record, old, op, new MoneyGuard.Lists(raw::read));
        else if (PollRules.covers(collection) && !"delete".equals(op)) why = PollRules.preWrite(record, raw);   // one answer per villa
        return why.isEmpty() ? null : why;
    }

    // ---- r77: one set of write checks for single and bulk writes (checkWrite in secureStorage.js) ------------------------------------
    private record Checked(ObjectNode record, RowScope scope) {}
    /** A record that points at another one may only point at one the caller can see. */
    private static final Map<String, String[]> PARENTS = Map.of(
            "ticketComments", new String[]{"ticketId", "tickets"}, "contactReviews", new String[]{"contactId", "serviceContacts"},
            "forumPosts", new String[]{"topicId", "forum"}, "culturalPhotos", new String[]{"eventId", "culturalEvents"},
            "culturalDonations", new String[]{"eventId", "culturalEvents"}, "pollVotes", new String[]{"broadcastId", "broadcasts"},
            "gateLinks", new String[]{"personId", "gatePeople"}, "quotations", new String[]{"ticketId", "tickets"});
    /** Bulk writes skip the per-record server steps (prices, votes, ticket rules, money): these collections are saved one record at a time. */
    private static final Set<String> NO_BULK = Set.of("amenities", "ballots", "voteRoll", "ballotBox", "pollVotes", "meetings", "tickets", "ticketComments", "releases", "ledger", "quotations", "files", "notifications");

    private RowScope writeScope(Caller c, String collection, RawReader raw) { return Perms.isAdmin(c.p()) ? RowScope.ALL : RowScopes.rowScope(collection, c.p(), raw, c.meta().ctx()); }

    private boolean parentVisible(Caller c, String collection, JsonNode record, JsonNode old, RawReader raw) {
        String[] ref = PARENTS.get(collection);
        if (ref == null || Perms.isAdmin(c.p())) return true;
        JsonNode idNode = Js.f(record, ref[0]);
        if (!Js.truthy(idNode) || (old != null && !Js.differs(Js.f(old, ref[0]), idNode))) return true;   // not pointing anywhere new
        if (!ReadRules.canRead(ref[1], c.p())) return false;
        String pid = Js.str(idNode);
        JsonNode parent = raw.read(ref[1]).stream().filter((r) -> Js.is(r, "id", pid)).findFirst().orElse(null);
        if (parent == null) return false;
        RowScope sc = RowScopes.rowScope(ref[1], c.p(), raw, c.meta().ctx());
        return sc.predicate() == null || sc.predicate().test(parent);
    }

    /** prepare -> authorize -> blocks -> closed books -> money -> parent: a refusal is thrown (and audited); returns the record to save. */
    private Checked checkWrite(Caller c, String collection, JsonNode record, JsonNode old, String op, Schema schema, RawReader raw) {
        Principal p = c.p();
        String verb = "create".equals(op) ? "Create" : "delete".equals(op) ? "Delete" : "Update";
        JsonNode subject = old != null ? old : record;
        RowScope scope = writeScope(c, collection, raw);
        WritePrep.Prepared prep = WritePrep.prepare(collection, p, schema, old, record, op, scope);
        if (!prep.ok()) throw denied(c, collection, verb, subject, prep.reason());
        ObjectNode rec = prep.record() != null && prep.record().isObject() ? (ObjectNode) prep.record() : json.createObjectNode();
        JsonNode judged = "delete".equals(op) ? (old != null ? old : json.createObjectNode()) : rec;
        Verdict v = rules.authorize(new WriteCall(collection, p, schema, old, judged, op, c.meta().ctx()));
        if (!v.ok()) throw denied(c, collection, verb, old != null ? old : rec, v.reason());
        String stays = WritePrep.staysInScope(collection, p, old, rec, op, scope);
        if (stays != null) throw denied(c, collection, verb, old != null ? old : rec, stays);
        JsonNode target = "delete".equals(op) ? old : rec;
        if (!BlockScope.writeOk(collection, target, old, p, raw)) throw denied(c, collection, verb, old != null ? old : rec, "This unit is outside the blocks you manage");
        String locked = PeriodLock.error(c.meta().lockedUntil(), collection, target, old);
        if (locked != null) throw denied(c, collection, verb, old != null ? old : rec, locked);
        String money = builtInRefusal(raw, collection, target, old, op);
        if (money != null) throw denied(c, collection, verb, old != null ? old : rec, money);
        if (!"delete".equals(op) && !parentVisible(c, collection, rec, old, raw)) throw denied(c, collection, verb, rec, "That record is not yours to add to");
        return new Checked(rec, scope);
    }

    private JsonNode shapeFor(Caller c, String collection, Schema schema, RowScope scope, JsonNode r) { return WritePrep.shapeForReader(r, collection, c.p(), schema, scope); }

    private static ObjectNode withoutMeta(JsonNode r) { ObjectNode o = ((ObjectNode) r).deepCopy(); for (String k : RowScopes.META_KEYS) if (!k.equals("id")) o.remove(k); return o; }

    /** A resident's new request: the server decides the type, the first assignee and the starting values (residentTicketStart). */
    private ObjectNode residentTicketStart(Caller c, ObjectNode record, RawReader raw) {
        JsonNode tt = taskType(c.community(), Js.str(record, "taskType"));
        if (!(Js.is(tt, "creatorScope", "Resident") || Js.truthy(tt, "residentDefault"))) throw denied(c, "tickets", "Create", record, "Raise this request with a resident request type");
        List<JsonNode> team = raw.read("handymen").stream().filter((h) -> !Js.differs(Js.f(h, "trade"), Js.f(record, "category"))).toList();
        JsonNode who = team.size() == 1 && Js.truthy(team.get(0), "clockedIn") ? team.get(0) : null;   // pickAssignee: only one person on the trade, and on duty
        ObjectNode out = record.deepCopy();
        out.put("status", who != null ? "Assigned" : "Open").put("assignedTo", who != null ? Js.str(who, "name") : "")
           .put("paymentStatus", "Not Paid").put("awaitingParts", false).put("materialsCost", 0).put("residentRating", 0);
        return out;
    }

    public JsonNode put(String community, Authentication who, String collection, JsonNode body, WriteOptions opts) {
        Names.collection(collection);
        if (body == null || !body.isObject()) throw new BadRequestException("The body must be a JSON object.");
        String id = body.hasNonNull("id") && body.get("id").isTextual() ? body.get("id").asText() : UUID.randomUUID().toString();
        Names.id(id);
        Caller c = caller(community, who);
        return write(c, () -> putInTx(c, collection, id, (ObjectNode) body.deepCopy(), opts == null ? WriteOptions.NONE : opts, true));
    }

    private JsonNode putInTx(Caller c, String collection, String id, ObjectNode record, WriteOptions opts, boolean checkVersion) {
        Principal p = c.p();
        String t = tenantFor(c.community(), collection);
        Schema schema = c.meta().catalog().schema(collection);
        clientGuard(c, collection, "Update", record);
        repo.lock(t, collection, List.of(id));                     // writers of the same record queue up here, so the version check sees the latest version
        JsonNode old = repo.get(t, collection, id).orElse(null);
        boolean isNew = old == null;
        String op = isNew ? "create" : "update"; String opWord = isNew ? "Create" : "Update";

        if (old != null && record.hasNonNull("recVersion") && old.hasNonNull("recVersion")
                && Js.toNumber(record.get("recVersion")) != Js.toNumber(old.get("recVersion")) && checkVersion) throw new ConflictException(old);

        // r77: what the caller may write is decided here (scope, hidden fields, identity), then authorised; money rules apply to everyone
        RawReader rr = raw(c);
        Checked checked = checkWrite(c, collection, record, old, op, schema, rr);
        record = checked.record();
        final RowScope writeScope = checked.scope();
        if ("tickets".equals(collection) && isNew && Perms.isResident(p)) record = residentTicketStart(c, record, rr);
        // e-voting: eligibility, the second factor, immutability and the sealed, hash-chained box. For everyone, the Super Admin included.
        if (EVotingGuard.covers(collection)) {
            if (!"ballots".equals(collection) && Js.truthy(record, "ballotId") && record.get("ballotId").isTextual())
                repo.lock(c.community(), "ballots", List.of(record.get("ballotId").asText()));   // one vote at a time per ballot: no two rows can take the same place in the chain
            EVotingGuard.Result ev = EVotingGuard.preWrite(t, collection, record, old, p, (col) -> raw(c).read(col), evotingState, clock, random);
            if (ev.error() != null) throw denied(c, collection, opWord, "ballotBox".equals(collection) ? json.createObjectNode().put("id", "") : json.createObjectNode().put("id", id), ev.error());
            record.setAll(ev.patch());
            ev.remove().forEach(record::remove);
        }
        // an amenity booking: the price, the payment state and the effect of an action are decided here, never by the client
        String amenityAction = null;
        if ("amenities".equals(collection)) {
            AmenityRules.Result r = amenityDecision(c, record, old, isNew, id);
            if (r.error() != null) throw denied(c, collection, opWord, record, r.error());
            record = (ObjectNode) r.record();
            amenityAction = r.action();
        }
        // the property register: real phone numbers in E.164, one number = one person; a meeting: when it was first published
        if ("properties".equals(collection)) {
            com.communityos.people.PropertyHooks.Pre pre = com.communityos.people.PropertyHooks.preWrite(record, old, raw(c).read("properties"), () -> UUID.randomUUID().toString());
            if (pre.error() != null) throw denied(c, collection, opWord, record, pre.error());
            record = pre.record();
        }
        if ("meetings".equals(collection)) record = com.communityos.people.MeetingHooks.preWrite(record, old, Stamps.iso(clock));
        String refusal = hookRefusal(collection, old, record);
        if (refusal != null) throw denied(c, collection, opWord, record, refusal);
        ticketBusinessRules(c, collection, old, record, isNew, opWord);

        String now = Stamps.iso(clock);
        // a client can never forge metadata: strip it and stamp again
        ObjectNode incoming = record.deepCopy();
        incoming.put("id", id);
        for (String k : RowScopes.META_KEYS) if (!k.equals("id")) incoming.remove(k);
        ArrayNode changes = isNew ? AuditDiff.snapshot(json, incoming, schema, "create") : AuditDiff.diff(json, old, incoming, schema);
        if (!isNew && changes.isEmpty()) return shapeFor(c, collection, schema, writeScope, old);   // nothing changed: no write, no audit noise

        String shortId = old != null && Js.truthy(old, "shortId") ? Js.str(old, "shortId") : nextShortId(t, collection);
        ObjectNode stamped = incoming.deepCopy();
        stamped.put("shortId", shortId);
        if ("tickets".equals(collection)) stamped.put("ticketNumber", shortId);
        stamped.put("recVersion", (old == null || !old.hasNonNull("recVersion") ? 0L : (long) Js.toNumber(old.get("recVersion"))) + 1L);
        stamped.put("recordCreatedAt", old != null && Js.truthy(old, "recordCreatedAt") ? Js.str(old, "recordCreatedAt") : now);
        stamped.put("recordCreatedBy", old != null && Js.truthy(old, "recordCreatedBy") ? Js.str(old, "recordCreatedBy") : p.label());
        stamped.put("lastUpdatedAt", now);
        stamped.put("lastUpdatedBy", p.label());
        if ("tickets".equals(collection)) stamped.set("statusHistory", statusTrail(old, stamped, now, p));
        if ("ballotBox".equals(collection)) {   // the ballot box keeps no trace of who or when (to the minute): only the day, and no time trail
            String day = now.substring(0, 10);
            stamped.put("recordCreatedAt", day).put("recordCreatedBy", "Ballot box").put("lastUpdatedAt", day).put("lastUpdatedBy", "Ballot box");
        } else stamped.setAll(RecordTrail.of(json, old, stamped, schema, now, p.label()));

        JsonNode saved = repo.upsert(t, collection, id, stamped);
        if (AuditTrail.audited(collection)) {
            String summary = opts.summary() != null && !opts.summary().isBlank() ? opts.summary() : shortId;
            audit.write(c.community(), audit.entry(p, labelOf(c, collection, opts.label()), collection, id, shortId, unitOf(stamped), opWord, summary, changes));
        }
        // the money of the booking (fee, deposit, unit credit, refunds) is posted in the same transaction: both happen or neither does
        if ("amenities".equals(collection) && amenityAction != null && !amenityAction.isEmpty()) amenityPosting.postWrite(t, stamped, amenityAction);
        if ("dues".equals(collection) && (isNew || !Js.strictEq(Js.f(old, "status"), Js.f(stamped, "status")) || !Js.strictEq(Js.f(old, "amount"), Js.f(stamped, "amount"))
                || !Js.strictEq(Js.f(old, "paidAt"), Js.f(stamped, "paidAt")))) {
            // a bill paid (or un-paid): its own line in the payment ledger, linked to the bill (like the Node server, a failure is logged and does not undo the save)
            try { finance.syncDuePayment(t, c.meta(), stamped, "System · bill payments"); } catch (RuntimeException e) { log.warn("ledger sync failed for bill {}: {}", id, e.getMessage()); }
        }
        notifyAfterSave(t, collection, old, stamped, p);
        if (META_WATCHED.contains(collection)) metas.invalidate(c.community());
        return shapeFor(c, collection, schema, writeScope, saved);   // the reply is the record as the caller may read it
    }

    /**
     * The messages a save sets off (secureStorage.js after a put): a task assigned or moved on, a quotation or invoice waiting for an approver, forum, polls,
     * e-voting results, task chat and releases. Written in the same transaction as the save; a message that cannot be made is logged and the save stands.
     */
    private void notifyAfterSave(String t, String collection, JsonNode old, JsonNode stamped, Principal p) {
        if ("tickets".equals(collection)) {
            try { events.ticketChange(t, old, stamped, p); events.approvalNeeded(t, old, stamped, p); } catch (RuntimeException e) { log.warn("notification failed for {} {}: {}", collection, Js.str(stamped, "id"), e.toString()); }
        }
        if (!AuditTrail.COLLECTION.equals(collection) && !"notifications".equals(collection) && !"notificationOutbox".equals(collection) && com.communityos.notify.EventNotifications.handles(collection)) {
            try { events.afterWrite(t, collection, old, stamped, p); } catch (RuntimeException e) { log.warn("extra notification failed for {} {}: {}", collection, Js.str(stamped, "id"), e.toString()); }
        }
        if ("quotations".equals(collection)) {
            try { events.invoiceChange(t, old, stamped, p); } catch (RuntimeException e) { log.warn("invoice notification failed for {}: {}", Js.str(stamped, "id"), e.toString()); }
        }
        if ("meetings".equals(collection)) {   // residents are told when a published meeting is new, moved, cancelled or has minutes
            try { com.communityos.people.MeetingHooks.postWrite(notifier, repo, t, old, stamped, p.label()); } catch (RuntimeException e) { log.warn("meeting notification failed for {}: {}", Js.str(stamped, "id"), e.toString()); }
        }
        if ("properties".equals(collection)) {   // portal access follows the phone numbers on the register: invites, re-links, deactivations
            try { new com.communityos.people.PropertyHooks.Run(repo, audit, t, t, site, com.communityos.people.PropertyHooks.env(writer, inviteRandom)).postWrite(old, stamped, p.label()); }
            catch (RuntimeException e) { log.warn("property access sync failed for {}: {}", Js.str(stamped, "id"), e.toString()); }
        }
    }

    private static String unitOf(JsonNode r) { return Js.truthy(r, "unit") ? Js.str(r, "unit") : Js.str(r, "hostUnit"); }

    private String nextShortId(String tenant, String collection) {
        String prefix = constants.shortPrefix(collection);
        boolean tickets = "tickets".equals(collection);
        long n = repo.nextShortNumber(tenant, collection, tickets ? TICKET_BASE : 0);
        return prefix + "-" + (tickets ? String.valueOf(n) : String.format("%04d", n));
    }

    /** Movement of a task's status, shown as the breadcrumb: appended only when the status actually changes; clients cannot forge it. */
    private ArrayNode statusTrail(JsonNode old, JsonNode stamped, String now, Principal p) {
        ArrayNode trail = json.createArrayNode();
        JsonNode prior = Js.f(old, "statusHistory");
        if (prior.isArray()) trail.addAll((ArrayNode) prior.deepCopy());
        else if (old != null && Js.truthy(old, "status")) {
            String at = Js.truthy(old, "recordCreatedAt") ? Js.str(old, "recordCreatedAt") : now;
            trail.add(json.createObjectNode().put("status", Js.str(old, "status")).put("at", at).put("by", Js.str(old, "createdBy")));
        }
        if (old == null || !Js.strictEq(Js.f(stamped, "status"), Js.f(old, "status")))
            trail.add(json.createObjectNode().put("status", Js.str(stamped, "status")).put("at", now).put("by", p.label()));
        return trail;
    }

    /** Business rules of a task that sit beside the permission rules (secureStorage.js). */
    private void ticketBusinessRules(Caller c, String collection, JsonNode old, JsonNode record, boolean isNew, String opWord) {
        if (!"tickets".equals(collection)) return;
        String t = c.community();
        JsonNode assigned = Js.f(record, "assignedTo");
        Principal p = c.p();
        // a trade worker hands a ticket only to themselves or a colleague of the same trade (or back to the queue)
        if (old != null && p.roleId() != null && p.roleId().startsWith("handyman_") && !"handyman_mep".equals(p.roleId()) && Js.truthy(assigned)
                && !Changes_orEmpty(record, "assignedTo").equals(Changes_orEmpty(old, "assignedTo"))) {
            String name = p.role() == null || p.role().name() == null ? "" : p.role().name();
            String[] parts = name.split("·", -1);
            String trade = parts.length > 1 ? Js.trim(parts[1]) : "";
            Set<String> crew = new LinkedHashSet<>(); if (p.name() != null) crew.add(p.name());
            if (!trade.isEmpty()) for (JsonNode h : repo.list(t, "handymen")) if (Js.is(h, "trade", trade)) crew.add(Js.str(h, "name"));
            if (!crew.contains(Js.str(assigned))) throw denied(c, collection, opWord, record, "Hand the ticket to yourself or a colleague of your trade");
        }
        if (isNew && !Js.truthy(assigned)) {
            JsonNode tt = taskType(t, Js.str(record, "taskType"));
            if (Js.is(tt, "creatorScope", "EC / Staff")) throw denied(c, collection, "Create", record, "Assigned to is required");
        }
        if (Js.truthy(assigned) && !Js.strictEq(assigned, Js.f(old, "assignedTo"))) {
            String typeName = Js.f(record, "taskType").isMissingNode() || Js.f(record, "taskType").isNull() ? Js.str(old, "taskType") : Js.str(record, "taskType");
            JsonNode tt = taskType(t, typeName);
            if (Js.is(tt, "creatorScope", "EC / Staff")) {
                String category = Js.f(record, "category").isMissingNode() || Js.f(record, "category").isNull() ? Js.str(old, "category") : Js.str(record, "category");
                Set<String> coordIds = new LinkedHashSet<>();
                for (JsonNode cov : repo.list(t, "categoryMap")) if (category.equals(Js.text(cov, "category"))) { for (JsonNode x : Js.list(cov, "coordinator")) coordIds.add(Js.str(x)); break; }
                Map<String, String> categoryOfRole = new HashMap<>();
                for (JsonNode r : repo.list(t, "roles")) categoryOfRole.put(Js.str(r, "id"), Js.str(r, "category"));
                Set<String> pool = new LinkedHashSet<>();
                for (JsonNode r : repo.list(t, "ecRoles")) pool.add(Js.truthy(r, "personName") ? Js.str(r, "personName") : Js.str(r, "roleTitle"));
                for (JsonNode u : repo.list(t, "users")) {
                    if (Js.is(u, "status", "Inactive")) continue;
                    List<String> roles = new ArrayList<>();
                    if (Js.truthy(u, "roleId")) roles.add(Js.str(u, "roleId"));
                    for (JsonNode x : Js.list(u, "extraRoleIds")) roles.add(Js.str(x));
                    boolean coordinates = roles.stream().anyMatch((r) -> coordIds.contains(r) || (coordIds.contains("group:EC") && "EC".equals(categoryOfRole.get(r))));
                    if (coordinates) pool.add(Js.str(u, "name"));
                }
                if (!pool.contains(Js.str(assigned))) throw denied(c, collection, opWord, record, "Internal tasks can only be assigned to EC members or the coordinators of the task's category - not vendors, owners or residents");
            }
        }
        if (old != null) {   // approval sequencing: Treasurer approval only after the EC approval
            JsonNode ecNow = Js.f(record, "ecApproval").isMissingNode() || Js.f(record, "ecApproval").isNull() ? Js.f(old, "ecApproval") : Js.f(record, "ecApproval");
            if (Js.is(record, "treasurerApproval", "Approved") && !Js.is(old, "treasurerApproval", "Approved") && !(ecNow.isTextual() && "Approved".equals(ecNow.asText())))
                throw denied(c, collection, "Update", record, "Treasurer approval needs the EC approval first");
        }
    }

    private static String Changes_orEmpty(JsonNode rec, String key) { JsonNode v = Js.f(rec, key); return Js.truthy(v) ? Js.str(v) : ""; }

    private JsonNode taskType(String tenant, String name) {
        for (JsonNode tt : repo.list(tenant, "taskTypes")) if (name.equals(Js.text(tt, "name"))) return tt;
        return Js.MISSING;
    }

    public void delete(String community, Authentication who, String collection, String id) {
        Names.collection(collection); Names.id(id);
        Caller c = caller(community, who);
        write(c, () -> { deleteInTx(c, collection, id); return null; });
    }

    private void deleteInTx(Caller c, String collection, String id) {
        Principal p = c.p();
        String t = tenantFor(c.community(), collection);
        Schema schema = c.meta().catalog().schema(collection);
        ObjectNode ref = json.createObjectNode().put("id", id);
        clientGuard(c, collection, "Delete", ref);
        repo.lock(t, collection, List.of(id));
        JsonNode old = repo.get(t, collection, id).orElse(null);
        JsonNode subject = old != null ? old : ref;
        if ("audit".equals(collection)) throw denied(c, collection, "Delete", subject, "The audit trail can never be edited or deleted");
        if (Set.of("voteRoll", "ballotBox").contains(collection) || ("ballots".equals(collection) && old != null && !Js.is(old, "status", "Draft")))
            throw denied(c, collection, "Delete", subject, "Voting records can never be changed or deleted");
        if (old == null && !Perms.isAdmin(p)) throw denied(c, collection, "Delete", subject, "Not found");
        checkWrite(c, collection, old != null ? old : ref, old, "delete", schema, raw(c));   // scope, rule, blocks, closed books, money
        String refusal = hookRefusal(collection, old, old);
        if (refusal != null) throw denied(c, collection, "Delete", subject, refusal);
        repo.delete(t, collection, id);
        if (AuditTrail.audited(collection)) {
            String shortId = old == null ? "" : Js.str(old, "shortId");
            audit.write(c.community(), audit.entry(p, labelOf(c, collection, null), collection, id, shortId, unitOf(old), "Delete", old != null ? shortId : "",
                    old != null ? AuditDiff.snapshot(json, old, schema, "delete") : null));
        }
        if (META_WATCHED.contains(collection)) metas.invalidate(c.community());
    }

    /** Bulk create (a bill run, a fee published to every unit): authorised once, stamped, written together, one audit line. */
    public List<JsonNode> createMany(String community, Authentication who, String collection, List<JsonNode> rows, WriteOptions opts) {
        Names.collection(collection);
        if (rows.isEmpty()) return List.of();
        Caller c = caller(community, who);
        return write(c, () -> {
            Principal p = c.p(); String t = tenantFor(c.community(), collection); Schema schema = c.meta().catalog().schema(collection);
            clientGuard(c, collection, "Create", rows.get(0));
            bulkGuard(c, collection, "Create", rows.get(0));
            RawReader raw = raw(c);
            Set<String> taken = new java.util.HashSet<>();
            for (JsonNode r : raw.read(collection)) taken.add(Js.str(r, "id"));
            List<JsonNode> checkedRows = new ArrayList<>(); RowScope scope = RowScope.ALL;
            for (JsonNode r0 : rows) {   // every row is checked, and a "new" row can never overwrite an existing one
                if (Js.truthy(r0, "id") && taken.contains(Js.str(r0, "id"))) throw denied(c, collection, "Create", r0, "A record with this id already exists");
                Checked ch = checkWrite(c, collection, withoutMeta(r0), null, "create", schema, raw); scope = ch.scope();
                ObjectNode r = ch.record();
                if ("properties".equals(collection)) {
                    com.communityos.people.PropertyHooks.Pre pre = com.communityos.people.PropertyHooks.preWrite(r, null, raw.read("properties"), () -> UUID.randomUUID().toString());
                    if (pre.error() != null) throw denied(c, collection, "Create", r, pre.error());
                    r = pre.record();
                }
                String refusal = hookRefusal(collection, null, r);
                if (refusal != null) throw denied(c, collection, "Create", r, refusal);
                if (Js.truthy(r, "id")) taken.add(Js.str(r, "id"));
                checkedRows.add(r);
            }
            final RowScope replyScope = scope;
            String now = Stamps.iso(clock);
            List<JsonNode> stamped = new ArrayList<>();
            for (JsonNode r : checkedRows) {
                ObjectNode s = ((ObjectNode) r).deepCopy();
                for (String k : RowScopes.META_KEYS) s.remove(k);
                s.put("id", Js.truthy(r, "id") ? Js.str(r, "id") : UUID.randomUUID().toString());
                s.put("shortId", nextShortId(t, collection)).put("recVersion", 1).put("recordCreatedAt", now).put("recordCreatedBy", p.label())
                        .put("lastUpdatedAt", now).put("lastUpdatedBy", p.label());
                s.setAll(RecordTrail.of(json, null, s, schema, now, p.label()));
                stamped.add(s);
            }
            List<JsonNode> saved = repo.upsertAll(t, collection, stamped);
            if (AuditTrail.audited(collection)) {
                String summary = opts != null && opts.summary() != null && !opts.summary().isBlank() ? opts.summary() : "Created " + saved.size() + " records";
                audit.write(c.community(), audit.entry(p, labelOf(c, collection, opts == null ? null : opts.label()), collection, "", "", "", "Create", summary, null));
            }
            return saved.stream().map((r) -> shapeFor(c, collection, schema, replyScope, r)).toList();
        });
    }

    /** Bulk update of existing rows (each keeps its id; the sent fields replace the stored ones). One audit line. */
    public List<JsonNode> updateMany(String community, Authentication who, String collection, List<JsonNode> rows, WriteOptions opts) {
        Names.collection(collection);
        if (rows.isEmpty()) return List.of();
        Caller c = caller(community, who);
        return write(c, () -> {
            Principal p = c.p(); String t = tenantFor(c.community(), collection); Schema schema = c.meta().catalog().schema(collection);
            clientGuard(c, collection, "Update", rows.get(0));
            bulkGuard(c, collection, "Update", rows.get(0));
            List<String> ids = rows.stream().map((r) -> Js.str(r, "id")).filter((i) -> !i.isEmpty()).toList();
            repo.lock(t, collection, ids);
            RawReader raw = raw(c);
            String now = Stamps.iso(clock);
            List<JsonNode> out = new ArrayList<>();
            RowScope[] lastScope = { RowScope.ALL };
            for (JsonNode r : rows) {
                JsonNode old = repo.get(t, collection, Js.str(r, "id")).orElse(null);
                if (old == null) continue;
                ObjectNode asked = ((ObjectNode) old).deepCopy();
                asked.setAll(withoutMeta(r));
                Checked ch = checkWrite(c, collection, asked, old, "update", schema, raw); lastScope[0] = ch.scope();
                ObjectNode merged = ch.record();
                if ("properties".equals(collection)) {
                    com.communityos.people.PropertyHooks.Pre pre = com.communityos.people.PropertyHooks.preWrite(merged, old, raw.read("properties"), () -> UUID.randomUUID().toString());
                    if (pre.error() != null) throw denied(c, collection, "Update", merged, pre.error());
                    merged = pre.record();
                }
                for (String k : RowScopes.META_KEYS) { if (old.has(k)) merged.set(k, old.get(k)); else merged.remove(k); }   // the server keeps the metadata
                String refusal = hookRefusal(collection, old, merged);
                if (refusal != null) throw denied(c, collection, "Update", old, refusal);
                ObjectNode s = merged.deepCopy();
                s.put("recVersion", (Js.truthy(old, "recVersion") ? (long) Js.number(old, "recVersion") : 1L) + 1L);
                s.put("lastUpdatedAt", now).put("lastUpdatedBy", p.label());
                s.setAll(RecordTrail.of(json, old, merged, schema, now, p.label()));
                out.add(s);
            }
            List<JsonNode> saved = repo.upsertAll(t, collection, out);
            if (AuditTrail.audited(collection)) {
                String summary = opts != null && opts.summary() != null && !opts.summary().isBlank() ? opts.summary() : "Updated " + saved.size() + " records";
                audit.write(c.community(), audit.entry(p, labelOf(c, collection, opts == null ? null : opts.label()), collection, "", "", "", "Update", summary, null));
            }
            return saved.stream().map((r) -> shapeFor(c, collection, schema, lastScope[0], r)).toList();
        });
    }
}
