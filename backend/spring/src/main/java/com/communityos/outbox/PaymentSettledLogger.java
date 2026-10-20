package com.communityos.outbox;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/** Default handler for payment.settled: a log line. Replace or add a handler bean to send the receipt, raise an invoice or export to accounts. */
@Component
public class PaymentSettledLogger implements OutboxTopicHandler {
    private static final Logger log = LoggerFactory.getLogger(PaymentSettledLogger.class);
    @Override public String topic() { return "payment.settled"; }
    @Override public void handle(OutboxEvent e) {
        log.info("payment.settled {} unit={} amount={}", e.payload().path("orderId").asText(), e.payload().path("unit").asText(), e.payload().path("amount").asText());
    }
}
