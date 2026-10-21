package com.communityos.api.config;

import com.communityos.api.finance.FinanceResources;
import com.communityos.api.maintenance.MaintenanceResources;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.events.DomainEvents;
import com.communityos.api.shared.resource.Resource;
import com.communityos.api.shared.resource.ResourceRegistry;
import com.communityos.api.shared.resource.ResourceService;
import com.communityos.api.shared.tx.Tx;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** The registers of every module served by the resource kit (/api/v1/{module}/{resource}). A module adds its list here. */
@Configuration
public class ResourcesConfig {
    /** Every registered resource, in one place (the SQL check reads the same list). */
    public static List<Resource<?>> all() {
        List<Resource<?>> out = new ArrayList<>();
        out.addAll(MaintenanceResources.all());
        out.addAll(FinanceResources.all());
        out.addAll(com.communityos.api.amenity.AmenityResources.all());
        out.addAll(com.communityos.api.gate.GateResources.all());
        out.addAll(com.communityos.api.comms.CommsResources.all());
        out.addAll(com.communityos.api.docs.DocsResources.all());
        out.addAll(com.communityos.api.cultural.CulturalResources.all());
        out.addAll(com.communityos.api.vendor.VendorResources.all());
        out.addAll(com.communityos.api.assets.AssetResources.all());
        out.addAll(com.communityos.api.workforce.WorkforceResources.all());
        return out;
    }

    @Bean ResourceRegistry resourceRegistry(NamedParameterJdbcTemplate jdbc, ObjectMapper json) {
        ResourceRegistry r = new ResourceRegistry(jdbc, json);
        for (Resource<?> x : all()) r.add(x);
        return r;
    }
    @Bean ResourceService resourceService(DomainEvents events, AuditWriter audit, Tx tx, Clock clock) { return new ResourceService(events, audit, tx, clock); }
}
