package com.communityos.api.shared.resource;

/** A resource = how it is stored + its rules. Registered once; the service, the controller and the SQL check all use the same pair. */
public record Resource<F extends Record>(ResourceTable<F> table, ResourceRules<F> rules) {}
