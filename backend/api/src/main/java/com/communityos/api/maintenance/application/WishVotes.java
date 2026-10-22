package com.communityos.api.maintenance.application;

import com.communityos.api.maintenance.MaintenanceResources;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.resource.Items;
import com.communityos.api.shared.resource.ResourceRegistry;
import com.communityos.api.shared.resource.ResourceService;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** One vote per member on an open wish (Submitted / Under review / Planned); a vote can be taken back. */
public final class WishVotes {
    public static final String VOTE = """
        UPDATE maintenance.wish SET votes = CASE WHEN :on THEN array_append(array_remove(votes, :me), :me) ELSE array_remove(votes, :me) END
        WHERE id = CAST(:id AS uuid) AND status IN ('Submitted', 'Under review', 'Planned')""";
    private final NamedParameterJdbcTemplate jdbc; private final ResourceService resources; private final ResourceRegistry registry; private final ObjectMapper json;
    public WishVotes(NamedParameterJdbcTemplate jdbc, ResourceService resources, ResourceRegistry registry, ObjectMapper json) {
        this.jdbc = jdbc; this.resources = resources; this.registry = registry; this.json = json;
    }

    @SuppressWarnings("unchecked")
    public JsonNode vote(Caller c, UUID id, boolean on) {
        if (c.membership() == null || !(c.isSuperAdmin() || c.category() == Caller.Category.EC)) throw new AccessDenied("The wishlist is the committee's");
        var e = (ResourceRegistry.Entry<MaintenanceResources.WishFields>) registry.byPath(MaintenanceResources.WISHES.table().path()).orElseThrow();
        resources.get(c, e.resource(), e.repository(), id);                                       // visible to this caller
        if (jdbc.update(VOTE, Map.of("on", on, "me", c.membership().toString(), "id", id.toString())) == 0)
            throw new DomainException.RuleViolated("closed", "This wish is no longer open for votes");
        return Items.flat(json, resources.get(c, e.resource(), e.repository(), id));
    }
}
