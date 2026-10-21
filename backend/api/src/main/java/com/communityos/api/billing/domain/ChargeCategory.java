package com.communityos.api.billing.domain;

import java.math.BigDecimal;
import java.util.UUID;

/** What a bill is for (Maintenance, Water ...), its tax rate and the income account it is credited to. */
public record ChargeCategory(UUID id, String code, String name, boolean utility, BigDecimal taxRate, UUID incomeAccountId, boolean active) {}
