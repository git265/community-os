package com.communityos.config;

import com.communityos.evoting.EVotingState;
import com.communityos.evoting.InMemoryEVotingState;
import com.communityos.evoting.JdbcEVotingState;
import com.communityos.evoting.OtpService;
import com.communityos.evoting.RandomSource;
import com.communityos.port.DocumentRepository;
import com.communityos.port.OutboundChannel;
import com.communityos.service.Tx;
import java.time.Clock;
import java.util.List;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;

/** The e-voting beans: where the second-factor state is kept (same database as the records), where random numbers come from, and the code service. */
@Configuration
public class EVotingConfig {

    @Bean
    EVotingState eVotingState(AppProperties p, ObjectProvider<JdbcTemplate> jdbc, Tx tx) {
        return "memory".equals(p.storage().provider()) ? new InMemoryEVotingState() : new JdbcEVotingState(jdbc.getObject(), tx);
    }

    @Bean
    RandomSource randomSource() { return RandomSource.secure(); }

    @Bean
    OtpService otpService(AppProperties p, EVotingState state, DocumentRepository repo, Tx tx, Clock clock, RandomSource random, List<OutboundChannel> channels) {
        String delivery = p.evoting().delivery();
        if (!List.of("sms", "log", "echo").contains(delivery)) throw new IllegalStateException("app.evoting.delivery must be sms, log or echo.");
        if ("echo".equals(delivery) && !p.payments().allowSimulated()) throw new IllegalStateException("app.evoting.delivery=echo returns the voting code to the screen; not allowed when app.payments.allow-simulated=false.");
        OutboundChannel sms = channels.stream().filter((c) -> "SMS".equals(c.channel())).findFirst().orElse(null);
        if ("sms".equals(delivery) && sms == null) throw new IllegalStateException("app.evoting.delivery=sms needs an SMS channel (app.channels.sms).");
        return new OtpService(state, repo, tx, clock, random, sms, delivery);
    }
}
