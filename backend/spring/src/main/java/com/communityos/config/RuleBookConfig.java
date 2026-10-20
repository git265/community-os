package com.communityos.config;

import com.communityos.security.Constants;
import com.communityos.security.WriteRules;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** Beans for the authorization rule book (package com.communityos.security): its fixed data, the write rules and the clock. */
@Configuration
public class RuleBookConfig {
    @Bean
    Constants ruleConstants(ObjectMapper json) { return Constants.load(json); }

    @Bean
    WriteRules writeRules(Constants constants) { return new WriteRules(constants); }

    /** One clock for stamps, audit times and period locks; tests replace it with a fixed one. */
    @Bean
    Clock clock() { return Clock.systemUTC(); }
}
