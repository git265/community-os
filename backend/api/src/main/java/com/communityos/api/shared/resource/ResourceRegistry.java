package com.communityos.api.shared.resource;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** Every registered resource with its repository, by its API path ("amenities/types"). Modules add theirs in their config. */
public final class ResourceRegistry {
    public record Entry<F extends Record>(Resource<F> resource, ResourceRepository<F> repository) {}
    /** For the app: which collection is served where, and which fields a write carries. */
    public record Meta(String collection, String path, List<String> fields, List<String> readOnly, List<String> filters) {}

    private final Map<String, Entry<?>> byPath = new LinkedHashMap<>();
    private final NamedParameterJdbcTemplate jdbc; private final ObjectMapper json;
    public ResourceRegistry(NamedParameterJdbcTemplate jdbc, ObjectMapper json) { this.jdbc = jdbc; this.json = json; }

    public <F extends Record> ResourceRegistry add(Resource<F> r) {
        if (byPath.containsKey(r.table().path())) throw new IllegalStateException("resource path used twice: " + r.table().path());
        byPath.put(r.table().path(), new Entry<>(r, new JdbcResourceRepository<>(r.table(), jdbc, json)));
        return this;
    }
    public <F extends Record> ResourceRegistry add(ResourceTable<F> table, ResourceRules<F> rules) { return add(new Resource<>(table, rules)); }
    public Optional<Entry<?>> byPath(String path) { return Optional.ofNullable(byPath.get(path)); }
    public Collection<Entry<?>> all() { return byPath.values(); }
    public List<Meta> meta() {
        return byPath.values().stream().map((e) -> new Meta(e.resource().table().collection(), e.resource().table().path(),
            e.resource().table().columns().stream().map(ResourceTable.Column::field).toList(),
            e.resource().table().serverColumns().stream().map(ResourceTable.ServerColumn::field).toList(), e.resource().table().filters())).toList();
    }
}
