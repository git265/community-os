package com.communityos.api.shared.integration;

/**
 * Port: turns a secret reference stored in the database (webhook_subscription.secret_ref) into the secret. Production reads a secret manager
 * (AWS Secrets Manager / Vault / Azure Key Vault); the database never holds the secret itself.
 */
@FunctionalInterface
public interface SecretResolver {
    String resolve(String secretRef);
}
