package com.communityos.api.billing.application.port;

import com.communityos.api.billing.domain.ChargeCategory;
import java.util.Optional;

public interface ChargeCategories { Optional<ChargeCategory> byCode(String code); }
