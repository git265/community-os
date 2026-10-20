package com.communityos.web;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import com.communityos.config.AppProperties;
import com.communityos.domain.PageResult;
import com.communityos.domain.QuerySpec;
import com.communityos.service.DocumentService;
import com.communityos.service.SecureRecordService;
import com.communityos.service.SecureRecordService.WriteOptions;
import com.communityos.service.TenantGuard;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.Authentication;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * The generic REST surface the UI's ApiStorageAdapter calls. Thin: check the community, hand over to {@link SecureRecordService}, which
 * applies the authorization rules (who may see or change what) and writes the audit trail.
 */
@Tag(name = "Records")
@RestController
@RequestMapping("/api/{collection}")
public class DocumentController {
    private final SecureRecordService records;
    private final DocumentService raw;
    private final TenantGuard guard;
    private final boolean trustedCaller;

    public DocumentController(SecureRecordService records, DocumentService raw, TenantGuard guard, AppProperties props) {
        this.records = records; this.raw = raw; this.guard = guard;
        this.trustedCaller = !"jwt".equals(props.security().mode());   // none / api-key: a script or local development, not a person
    }

    @Operation(summary = "List the records", description = "The records of the collection that the caller's role and villa may see, with hidden fields removed. Prefer /query for big collections.")
    @GetMapping
    public List<JsonNode> list(@PathVariable String collection, @RequestHeader("X-Community-Id") String c, Authentication who) {
        return records.list(guard.resolve(c, who), who, collection);
    }

    @Operation(summary = "Get one record", description = "404 when it does not exist or is not visible to the caller.")
    @GetMapping("/{id}")
    public JsonNode get(@PathVariable String collection, @PathVariable String id, @RequestHeader("X-Community-Id") String c, Authentication who) {
        return records.get(guard.resolve(c, who), who, collection, id);
    }

    @Operation(summary = "Create or update one record",
            description = "The id in the body must match the address. The server checks the caller's rights, stamps the short id, version, author and time trail, and writes the audit line. "
                    + "Send the recVersion you loaded: 409 (with the stored record in `current`) when someone else saved first. Optional `__opts` {label, summary} names the audit line.")
    @PutMapping("/{id}")
    public JsonNode put(@PathVariable String collection, @PathVariable String id, @RequestBody JsonNode body, @RequestHeader("X-Community-Id") String c, Authentication who) {
        if (!body.isObject()) throw new BadRequestException("The body must be a JSON object.");
        if (!id.equals(body.path("id").asText(null))) throw new BadRequestException("The id in the body must match the address.");
        ObjectNode record = ((ObjectNode) body).deepCopy();
        JsonNode opts = record.remove("__opts");
        return records.put(guard.resolve(c, who), who, collection, record, options(opts));
    }

    @Operation(summary = "Delete one record", description = "Typed tables refuse when other records still point at it. The audit trail cannot be deleted. Tickets are cancelled, not deleted.")
    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable String collection, @PathVariable String id, @RequestHeader("X-Community-Id") String c, Authentication who) {
        records.delete(guard.resolve(c, who), who, collection, id);
        return ResponseEntity.noContent().build();
    }

    @Operation(summary = "Create many records", description = "Body {rows, opts}. Authorised once, written together, one audit line. Returns the stored rows with their new ids.")
    @PostMapping("/_create-many")
    public List<JsonNode> createMany(@PathVariable String collection, @RequestBody JsonNode body, @RequestHeader("X-Community-Id") String c, Authentication who) {
        return records.createMany(guard.resolve(c, who), who, collection, rows(body), options(body.path("opts")));
    }

    @Operation(summary = "Update many records", description = "Body {rows, opts}. Each row keeps its id; the sent fields replace the stored ones. Each is checked on its own.")
    @PostMapping("/_update-many")
    public List<JsonNode> updateMany(@PathVariable String collection, @RequestBody JsonNode body, @RequestHeader("X-Community-Id") String c, Authentication who) {
        return records.updateMany(guard.resolve(c, who), who, collection, rows(body), options(body.path("opts")));
    }

    @Operation(summary = "Import many new records", description = "Body {rows, opts}. Like _create-many (authorised once, stamped, one audit line); answers {count}. A statement or register import.")
    @PostMapping("/_import-many")
    public Map<String, Integer> importMany(@PathVariable String collection, @RequestBody JsonNode body, @RequestHeader("X-Community-Id") String c, Authentication who) {
        return Map.of("count", records.createMany(guard.resolve(c, who), who, collection, rows(body), options(body.path("opts"))).size());
    }

    @Operation(summary = "Save many records (trusted callers only)", description = "All or nothing, WITHOUT the per-record rules. Only for a script or local development (security mode none / api-key); with real sign-in use _create-many / _update-many.")
    @PostMapping("/bulk")
    public List<JsonNode> bulk(@PathVariable String collection, @RequestBody List<JsonNode> body, @RequestHeader("X-Community-Id") String c, Authentication who) {
        requireTrusted();
        return raw.putMany(guard.resolve(c, who), collection, body);
    }

    @Operation(summary = "Replace a whole collection (trusted callers only)", description = "Removes every record, then inserts these, in one transaction. Not available to signed-in people.")
    @PutMapping
    public ResponseEntity<Void> replace(@PathVariable String collection, @RequestBody List<JsonNode> body, @RequestHeader("X-Community-Id") String c, Authentication who) {
        requireTrusted();
        raw.replaceAll(guard.resolve(c, who), collection, body);
        return ResponseEntity.noContent().build();
    }

    private void requireTrusted() {
        if (!trustedCaller) throw new AccessDeniedException("Replacing a whole collection is not available to clients.");
    }

    /** Query string -> QuerySpec. Filters arrive as f.<field>=value (repeat for several values). */
    @Operation(summary = "Query one page", description = "Filters f.<field>=value, sort=field:asc|desc, search, searchKey, dateKey/from/to, periodKey/year/month, page, pageSize (max 1000). The caller's row scope (own unit, own block) is applied in the SQL WHERE for typed tables, and hidden fields never appear. total stops counting at 100000 and `approx` is then true.")
    @GetMapping("/query")
    public PageResult query(@PathVariable String collection, @RequestParam MultiValueMap<String, String> p,
                            @RequestHeader("X-Community-Id") String c, Authentication who) {
        Map<String, List<String>> filters = new LinkedHashMap<>();
        p.forEach((k, v) -> { if (k.startsWith("f.")) filters.put(k.substring(2), new ArrayList<>(v)); });
        String[] sort = p.getOrDefault("sort", List.of("")).get(0).split(":");
        QuerySpec spec = new QuerySpec(num(p, "page", 1), num(p, "pageSize", 50), sort[0], sort.length > 1 ? sort[1] : "asc",
                one(p, "search"), p.getOrDefault("searchKey", List.of()), one(p, "dateKey"), one(p, "from"), one(p, "to"),
                one(p, "periodKey"), one(p, "year"), one(p, "month"), filters);
        return records.query(guard.resolve(c, who), who, collection, spec);
    }

    private static List<JsonNode> rows(JsonNode body) {
        List<JsonNode> out = new ArrayList<>();
        JsonNode r = body.path("rows");
        if (!r.isArray()) throw new BadRequestException("Send {\"rows\": [ ... ]}.");
        r.forEach((x) -> { if (!x.isObject()) throw new BadRequestException("Every row must be a JSON object."); out.add(x); });
        return out;
    }

    private static WriteOptions options(JsonNode o) {
        if (o == null || !o.isObject()) return WriteOptions.NONE;
        return new WriteOptions(o.hasNonNull("label") ? o.get("label").asText() : null, o.hasNonNull("summary") ? o.get("summary").asText() : null);
    }

    private static String one(MultiValueMap<String, String> p, String k) { String v = p.getFirst(k); return v == null ? "" : v; }
    private static int num(MultiValueMap<String, String> p, String k, int dflt) {
        try { return Integer.parseInt(one(p, k)); } catch (NumberFormatException e) { return dflt; }
    }
}
