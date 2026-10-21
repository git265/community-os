package com.communityos.api;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * CommunityOS API v2. Layout (hexagonal, one package per bounded context):
 *   shared.*         the kernel every module uses: money, ids, caller identity, access specifications, guards, resilience, outbox, audit, web plumbing
 *   identity.*       people, memberships, roles, sign-in (one-time codes, JWT access tokens, rotating refresh tokens)
 *   property.*       blocks and units
 *   billing.*        bills, payment orders, payments, the double-entry ledger posting
 * Inside a module: domain (pure Java, no framework), application (use cases, ports), adapter (JDBC, HTTP providers), web (controllers, DTOs).
 */
@SpringBootApplication
@ConfigurationPropertiesScan
@EnableScheduling
public class CommunityOsApiApplication {
    public static void main(String[] args) { SpringApplication.run(CommunityOsApiApplication.class, args); }
}
