package com.communityos.api.shared.resource;

import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tenancy.CallerHolder;
import com.communityos.api.shared.web.ETags;
import com.communityos.api.shared.web.Idempotency;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.swagger.v3.oas.annotations.tags.Tag;
import java.util.List;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * The simple resources of every module at /api/v1/{module}/{resource}: GET list, GET one, POST, PUT (whole record, If-Match), DELETE (If-Match).
 * The body is read into that resource's own record type, with unknown properties refused - so a request carries exactly the fields of that
 * resource and nothing else (no id, version, times or community). Dedicated controllers (tickets, bookings ...) take precedence over these paths.
 */
@RestController
@Tag(name = "Resources")
public class ResourceController {
    static final String MODULES = "maintenance|amenities|gate|comms|docs|cultural|finance|governance|vendors|assets|workforce|reports|property";
    private final ResourceRegistry registry; private final ResourceService service; private final ObjectMapper json; private final Idempotency idempotency;
    public ResourceController(ResourceRegistry registry, ResourceService service, ObjectMapper json, Idempotency idempotency) {
        this.registry = registry; this.service = service; this.json = json; this.idempotency = idempotency;
    }

    @GetMapping("/api/v1/meta/resources")
    public List<ResourceRegistry.Meta> meta() { CallerHolder.require(); return registry.meta(); }

    @GetMapping("/api/v1/{module:" + MODULES + "}/{resource}")
    public List<JsonNode> list(@PathVariable String module, @PathVariable String resource, @RequestParam java.util.Map<String, String> query) { return list(entry(module, resource), query); }
    @GetMapping("/api/v1/{module:" + MODULES + "}/{resource}/{id}")
    public ResponseEntity<JsonNode> get(@PathVariable String module, @PathVariable String resource, @PathVariable UUID id) { return one(entry(module, resource), id); }
    @PostMapping("/api/v1/{module:" + MODULES + "}/{resource}")
    public ResponseEntity<JsonNode> create(@PathVariable String module, @PathVariable String resource, @RequestBody JsonNode body,
                                           @RequestHeader(name = "Idempotency-Key", required = false) String key) {
        ResourceRegistry.Entry<?> e = entry(module, resource);
        Caller c = CallerHolder.require();
        Idempotency.Reply<JsonNode> r = idempotency.run(c, key, "POST /api/v1/" + module + "/" + resource, body, JsonNode.class, 201, () -> create(e, c, body));
        return ResponseEntity.status(r.status()).header("ETag", ETags.of(r.body().path("version").asLong())).body(r.body());
    }
    @PutMapping("/api/v1/{module:" + MODULES + "}/{resource}/{id}")
    public ResponseEntity<JsonNode> replace(@PathVariable String module, @PathVariable String resource, @PathVariable UUID id, @RequestBody JsonNode body,
                                            @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        JsonNode out = replace(entry(module, resource), CallerHolder.require(), id, ETags.require(ifMatch), body);
        return ResponseEntity.ok().header("ETag", ETags.of(out.path("version").asLong())).body(out);
    }
    @DeleteMapping("/api/v1/{module:" + MODULES + "}/{resource}/{id}")
    public ResponseEntity<Void> delete(@PathVariable String module, @PathVariable String resource, @PathVariable UUID id,
                                       @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        delete(entry(module, resource), CallerHolder.require(), id, ETags.require(ifMatch));
        return ResponseEntity.noContent().build();
    }

    private ResourceRegistry.Entry<?> entry(String module, String resource) {
        return registry.byPath(module + "/" + resource).orElseThrow(() -> new DomainException.NotFound("Resource " + module + "/" + resource));
    }
    private <F extends Record> List<JsonNode> list(ResourceRegistry.Entry<F> e, java.util.Map<String, String> query) {
        java.util.Map<String, String> filters = new java.util.HashMap<>(query);
        filters.keySet().retainAll(e.resource().table().filters());
        return service.list(CallerHolder.require(), e.resource(), e.repository(), filters).stream().map(this::flat).toList();
    }
    private <F extends Record> ResponseEntity<JsonNode> one(ResourceRegistry.Entry<F> e, UUID id) {
        Item<F> it = service.get(CallerHolder.require(), e.resource(), e.repository(), id);
        return ResponseEntity.ok().header("ETag", ETags.of(it.version())).body(flat(it));
    }
    private <F extends Record> JsonNode create(ResourceRegistry.Entry<F> e, Caller c, JsonNode body) { return flat(service.create(c, e.resource(), e.repository(), read(e, body))); }
    private <F extends Record> JsonNode replace(ResourceRegistry.Entry<F> e, Caller c, UUID id, long v, JsonNode body) { return flat(service.replace(c, e.resource(), e.repository(), id, v, read(e, body))); }
    private <F extends Record> void delete(ResourceRegistry.Entry<F> e, Caller c, UUID id, long v) { service.delete(c, e.resource(), e.repository(), id, v); }

    private <F extends Record> F read(ResourceRegistry.Entry<F> e, JsonNode body) {
        try { return json.treeToValue(body, e.resource().table().type()); }
        catch (com.fasterxml.jackson.core.JsonProcessingException | IllegalArgumentException x) {
            throw new DomainException.RuleViolated("bad-request", "The record is not valid: " + x.getMessage());
        }
    }
    /** {id, shortId, version, createdAt, updatedAt, ...fields} */
    public JsonNode flat(Item<?> it) { return Items.flat(json, it); }
}
