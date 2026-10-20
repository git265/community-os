package com.communityos.service;

import com.communityos.config.AppProperties;
import com.communityos.domain.PageResult;
import com.communityos.domain.QuerySpec;
import com.communityos.domain.ScopeNode;
import com.communityos.port.DocumentRepository;
import com.communityos.web.BadRequestException;
import com.communityos.web.Names;
import com.communityos.web.NotFoundException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import org.springframework.stereotype.Service;

/** Use cases on documents. Knows nothing about HTTP or SQL: it talks to the DocumentRepository port. */
@Service
public class DocumentService {
    private final DocumentRepository repo;
    private final Tx tx;
    private final Set<String> platformCollections;

    public DocumentService(DocumentRepository repo, Tx tx, AppProperties props) {
        this.repo = repo; this.tx = tx;
        this.platformCollections = Set.copyOf(props.storage().platformCollections());
    }

    /** The registry of communities is shared; everything else belongs to the caller's community. */
    public String tenantFor(String community, String collection) {
        return platformCollections.contains(collection) ? "platform" : Names.tenant(community);
    }

    public List<JsonNode> list(String community, String collection) {
        return repo.list(tenantFor(community, collection), Names.collection(collection));
    }

    public JsonNode get(String community, String collection, String id) {
        return repo.get(tenantFor(community, collection), Names.collection(collection), Names.id(id))
                .orElseThrow(() -> new NotFoundException("Not found."));
    }

    public JsonNode put(String community, String collection, String id, JsonNode body) {
        if (!body.isObject()) throw new BadRequestException("The body must be a JSON object.");
        if (!id.equals(body.path("id").asText(null))) throw new BadRequestException("The id in the body must match the address.");
        return repo.upsert(tenantFor(community, collection), Names.collection(collection), Names.id(id), stamp((ObjectNode) body));
    }

    public List<JsonNode> putMany(String community, String collection, List<JsonNode> body) {
        body.forEach(this::requireId);
        body.forEach(b -> stamp((ObjectNode) b));
        return tx.run(() -> repo.upsertAll(tenantFor(community, collection), Names.collection(collection), body));
    }

    public void replaceAll(String community, String collection, List<JsonNode> body) {
        body.forEach(this::requireId);
        body.forEach(b -> stamp((ObjectNode) b));
        tx.run(() -> repo.replaceAll(tenantFor(community, collection), Names.collection(collection), body));
    }

    public void delete(String community, String collection, String id) {
        repo.delete(tenantFor(community, collection), Names.collection(collection), Names.id(id));
    }

    public PageResult query(String community, String collection, QuerySpec spec) {
        return repo.query(tenantFor(community, collection), Names.collection(collection), spec);
    }

    /** One page, limited by the caller's row scope in the SQL WHERE (typed tables); other collections are unscoped here. */
    public PageResult query(String community, String collection, QuerySpec spec, ScopeNode scope) {
        String t = tenantFor(community, collection); String c = Names.collection(collection);
        if (repo.supportsScope(c)) return repo.queryScoped(t, c, spec, scope);
        if (scope instanceof ScopeNode.None) return new PageResult(List.of(), 0, 1, Math.max(1, spec.pageSize()), 1);
        return repo.query(t, c, spec);
    }

    public void resetCommunity(String community) {
        String t = Names.tenant(community);
        if ("platform".equals(t)) throw new BadRequestException("The platform registry cannot be reset.");
        repo.deleteTenant(t);
    }

    private void requireId(JsonNode n) {
        if (!n.isObject() || !n.hasNonNull("id") || !n.get("id").isTextual()) throw new BadRequestException("Every record needs a text \"id\".");
        Names.id(n.get("id").asText());
    }

    private ObjectNode stamp(ObjectNode n) { n.put("updatedAt", Instant.now().toString()); return n; }
}
