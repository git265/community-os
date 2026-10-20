package com.communityos.config;

import com.communityos.platform.PlatformProperties;
import com.communityos.platform.PlatformService;
import com.communityos.port.DocumentRepository;
import com.communityos.service.Tx;
import com.communityos.service.audit.AuditTrail;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** The platform console's server side: creating, listing and suspending communities (docs/BACKEND.md section 10.10). */
@Configuration
public class PlatformConfig {
    @Bean
    PlatformService platformService(DocumentRepository repo, AuditTrail audit, ObjectMapper json, Clock clock, Tx tx, PlatformProperties p) {
        return new PlatformService(repo, audit, json, clock, tx, p.adminKey());
    }
}
