package com.communityos;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * CommunityOS back end. Hexagonal layout:
 *   web/      HTTP in  (controllers) - thin, no business rules
 *   service/  use cases (DocumentService, PaymentService, OutboxDispatcher)
 *   port/     interfaces the core needs from the outside world (DocumentRepository, FileStorage, OutboundChannel, ...)
 *   adapter/  one package per kind of outside system; one class per vendor, chosen by config/ProvidersConfig
 */
@SpringBootApplication
@ConfigurationPropertiesScan
@EnableScheduling
public class CommunityOsApplication {
    public static void main(String[] args) {
        SpringApplication.run(CommunityOsApplication.class, args);
    }
}
