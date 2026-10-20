package com.communityos.access;

import com.communityos.config.AppProperties;
import com.communityos.port.DocumentRepository;
import com.communityos.security.Constants;
import com.communityos.security.Js;
import com.communityos.security.RuleContext;
import com.communityos.security.SchemaCatalog;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;

/**
 * Reads, per community, the data the authorization rules depend on: fresh for every request by default (app.security.meta-ttl-ms=0). A value above 0 keeps it that long, so a request
 * does not read five collections to answer one question. A write to any of these collections drops the cache for that community at once
 * ({@link #invalidate}); another server instance sees the change within the TTL. Same idea as metaFor() in the Node server.
 */
@Component
public class CommunityMetaLoader {
    /** Collections whose rows feed the rules. */
    public static final Set<String> WATCHED = Set.of("roles", "schema", "financeSettings", "approverSettings", "utilityTypes", "users");

    private record Entry(CommunityMeta meta, long at) {}

    private final DocumentRepository repo;
    private final ObjectMapper json;
    private final Constants constants;
    private final Clock clock;
    private final long ttlMs;
    private final Map<String, Entry> cache = new ConcurrentHashMap<>();

    public CommunityMetaLoader(DocumentRepository repo, ObjectMapper json, Constants constants, Clock clock, AppProperties props) {
        this.repo = repo; this.json = json; this.constants = constants; this.clock = clock; this.ttlMs = props.security().metaTtlMs();
    }

    public CommunityMeta of(String tenant) {
        long now = clock.millis();
        Entry hit = cache.get(tenant);
        if (hit != null && now - hit.at() < ttlMs) return hit.meta();
        CommunityMeta fresh = load(tenant);
        cache.put(tenant, new Entry(fresh, now));
        return fresh;
    }

    public void invalidate(String tenant) { cache.remove(tenant); }

    private CommunityMeta load(String tenant) {
        List<JsonNode> roles = repo.list(tenant, "roles");
        List<JsonNode> schemas = repo.list(tenant, "schema");
        JsonNode finance = first(repo.list(tenant, "financeSettings"));
        JsonNode approvers = first(repo.list(tenant, "approverSettings"));
        Set<String> utilities = new LinkedHashSet<>(constants.utilityTypes());
        for (JsonNode u : repo.list(tenant, "utilityTypes")) { String n = Js.text(u, "name"); if (n != null) utilities.add(n); }
        List<String> second = new ArrayList<>();
        for (JsonNode r : Js.list(approvers, "roles")) if (r.isTextual()) second.add(r.asText());
        boolean finalCanDecideEC = !Js.f(finance, "finalCanDecideEC").isBoolean() || Js.f(finance, "finalCanDecideEC").asBoolean();   // only an explicit false turns it off
        String lockedUntil = Js.str(finance, "lockedUntil");
        lockedUntil = lockedUntil.length() > 10 ? lockedUntil.substring(0, 10) : lockedUntil;
        RuleContext ctx = RuleContext.defaults(constants).withApprovers(second, finalCanDecideEC).withUtilityNames(utilities).withClock(clock);
        return new CommunityMeta(SchemaCatalog.merge(json, schemas, roles), ctx, lockedUntil);
    }

    private static JsonNode first(List<JsonNode> rows) { return rows.isEmpty() ? Js.MISSING : rows.get(0); }
}
