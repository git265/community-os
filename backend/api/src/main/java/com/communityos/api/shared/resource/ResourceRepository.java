package com.communityos.api.shared.resource;

import com.communityos.api.shared.access.Spec;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Port: rows of one resource in the caller's community. */
public interface ResourceRepository<F extends Record> {
    List<Item<F>> list(Spec<F> scope);
    /** Narrowed by equality on the table's filter fields (values as text). */
    default List<Item<F>> list(Spec<F> scope, java.util.Map<String, String> filters) { return list(scope); }
    Optional<Item<F>> get(UUID id, Spec<F> scope);
    UUID insert(F f);
    /** The new version, or -1 when the version no longer matches. */
    long update(UUID id, long version, F f);
    boolean delete(UUID id, long version);
}
