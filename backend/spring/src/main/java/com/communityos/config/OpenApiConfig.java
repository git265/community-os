package com.communityos.config;

import io.swagger.v3.oas.models.Components;
import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Info;
import io.swagger.v3.oas.models.parameters.Parameter;
import io.swagger.v3.oas.models.security.SecurityRequirement;
import io.swagger.v3.oas.models.security.SecurityScheme;
import io.swagger.v3.oas.models.tags.Tag;
import org.springdoc.core.customizers.GlobalOpenApiCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Swagger / OpenAPI (springdoc). UI: /swagger-ui.html, document: /v3/api-docs.
 * The "Authorize" button takes the bearer token (the shared API key, or a JWT from your identity provider).
 */
@Configuration
public class OpenApiConfig {
    public static final String BEARER = "bearer";

    @Bean
    OpenAPI communityOsApi() {
        return new OpenAPI()
            .info(new Info().title("CommunityOS API").version("1.0.0")
                .description("""
                    Generic, schema-driven REST API behind the CommunityOS app. Every collection (dues, tickets, forum ...) uses the same routes.
                    Collections that need joins and constraints (properties, users, dues, amenities, tickets, ledger, audit) live in real tables;
                    configurable ones (forum, notices, settings, custom fields) are JSONB documents. The routes do not change either way.
                    Send `X-Community-Id` (the community slug) on every call. Send `X-Request-Id` to trace a call through the logs."""))
            .components(new Components().addSecuritySchemes(BEARER,
                new SecurityScheme().type(SecurityScheme.Type.HTTP).scheme("bearer").bearerFormat("API key or JWT")))
            .addSecurityItem(new SecurityRequirement().addList(BEARER))
            .addTagsItem(new Tag().name("Records").description("Read and write the records of any collection."))
            .addTagsItem(new Tag().name("Payments").description("Orders, the signed webhook and reconciliation."))
            .addTagsItem(new Tag().name("Files").description("Photos and PDFs (bytes live in file storage, not the database)."))
            .addTagsItem(new Tag().name("GST").description("GSTIN lookup and e-invoice."))
            .addTagsItem(new Tag().name("Admin").description("Reset and maintenance (admin key)."))
            .addTagsItem(new Tag().name("Health").description("Liveness and which providers are wired."));
    }

    /** Adds the community header to every operation that does not already have it, so "Try it out" works. */
    @Bean
    GlobalOpenApiCustomizer communityHeader() {
        return api -> api.getPaths().values().forEach(item -> item.readOperations().forEach(op -> {
            boolean has = op.getParameters() != null && op.getParameters().stream().anyMatch(p -> "X-Community-Id".equalsIgnoreCase(p.getName()));
            if (!has) op.addParametersItem(new Parameter().in("header").name("X-Community-Id").required(false)
                .description("Community slug, e.g. la-paloma").schema(new io.swagger.v3.oas.models.media.StringSchema()));
        }));
    }
}
