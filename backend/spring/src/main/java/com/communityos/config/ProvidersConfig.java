package com.communityos.config;

import com.communityos.adapter.channel.HttpChannel;
import com.communityos.adapter.channel.LoggingChannel;
import com.communityos.adapter.channel.SmtpEmailChannel;
import com.communityos.adapter.files.LocalDiskFileStorage;
import com.communityos.adapter.files.S3FileStorage;
import com.communityos.adapter.gst.SimulatedGstProvider;
import com.communityos.adapter.payment.SimulatedPaymentProvider;
import com.communityos.adapter.persistence.InMemoryDocumentRepository;
import com.communityos.adapter.persistence.JdbcDocumentRepository;
import com.communityos.adapter.persistence.ShortIdCounters;
import com.communityos.adapter.persistence.typed.RoutingDocumentRepository;
import com.communityos.adapter.persistence.typed.TypedDocumentRepository;
import com.communityos.port.DocumentRepository;
import com.communityos.port.FileStorage;
import com.communityos.port.GstProvider;
import com.communityos.port.OutboundChannel;
import com.communityos.port.PaymentProvider;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mail.javamail.JavaMailSender;

/**
 * THE composition root: the one file that knows which vendor class backs each port. Everything else depends on the ports.
 * To add a vendor: write one adapter class, add one `case` here, set the matching `provider:` in application.yml.
 */
@Configuration
public class ProvidersConfig {

    /** Personal numbers (ID, bank account ...) encrypted in the database: DATA_ENCRYPTION_KEY (+ _OLD for rotation, ENCRYPT_FIELDS). Off without a key. */
    @Bean
    com.communityos.crypto.FieldCrypto fieldCrypto(ObjectMapper json, org.springframework.core.env.Environment env) {
        return new com.communityos.crypto.FieldCrypto(json, env.getProperty("DATA_ENCRYPTION_KEY"), env.getProperty("DATA_ENCRYPTION_KEY_OLD"), env.getProperty("ENCRYPT_FIELDS"));
    }

    @Bean
    DocumentRepository documentRepository(AppProperties p, ObjectProvider<JdbcTemplate> jdbc, ObjectMapper json, com.communityos.crypto.FieldCrypto crypto) {
        DocumentRepository repo = rawDocumentRepository(p, jdbc, json);
        return crypto.enabled() ? new com.communityos.adapter.persistence.EncryptingDocumentRepository(repo, crypto) : repo;
    }

    private DocumentRepository rawDocumentRepository(AppProperties p, ObjectProvider<JdbcTemplate> jdbc, ObjectMapper json) {
        return switch (p.storage().provider()) {
            case "postgres" -> {
                DocumentRepository generic = new JdbcDocumentRepository(jdbc.getObject(), json);
                // typed tables (units, users, dues, bookings, tickets, ledger, audit) when enabled; everything else stays JSONB
                yield p.storage().typedTables()
                        ? new RoutingDocumentRepository(generic, new TypedDocumentRepository(jdbc.getObject(), json), new ShortIdCounters(jdbc.getObject()))
                        : generic;
            }
            case "memory" -> new InMemoryDocumentRepository();
            // case "mongo" -> new MongoDocumentRepository(...);
            default -> throw new IllegalStateException("Unknown app.storage.provider '" + p.storage().provider() + "' (postgres | memory)");
        };
    }

    @Bean
    FileStorage fileStorage(AppProperties p) {
        return switch (p.files().provider()) {
            case "local" -> new LocalDiskFileStorage(p.files().localDir());
            case "s3" -> new S3FileStorage(p.files().s3());
            // case "azure" -> new AzureBlobFileStorage(...);
            default -> throw new IllegalStateException("Unknown app.files.provider '" + p.files().provider() + "' (local | s3)");
        };
    }

    @Bean
    OutboundChannel emailChannel(AppProperties p, ObjectProvider<JavaMailSender> mail) {
        return switch (p.channels().email().provider()) {
            case "log" -> new LoggingChannel("Email");
            case "smtp" -> new SmtpEmailChannel(mail.getObject(), p.channels().email().from());
            default -> throw new IllegalStateException("Unknown app.channels.email.provider (log | smtp)");
        };
    }

    @Bean
    OutboundChannel smsChannel(AppProperties p) { return http("SMS", p.channels().sms()); }

    @Bean
    OutboundChannel whatsappChannel(AppProperties p) { return http("WhatsApp", p.channels().whatsapp()); }

    private static OutboundChannel http(String name, AppProperties.Channels.Http c) {
        return switch (c.provider()) {
            case "log" -> new LoggingChannel(name);
            case "http" -> new HttpChannel(name, c.http());
            default -> throw new IllegalStateException("Unknown provider for " + name + " (log | http)");
        };
    }

    @Bean
    PaymentProvider paymentProvider(AppProperties p) {
        return switch (p.payments().provider()) {
            case "simulated" -> new SimulatedPaymentProvider(p.payments().webhookSecret());
            // case "razorpay" -> new RazorpayPaymentProvider(...);   case "stripe" -> ...
            default -> throw new IllegalStateException("Unknown app.payments.provider '" + p.payments().provider() + "' (simulated)");
        };
    }

    @Bean
    GstProvider gstProvider(AppProperties p) {
        return switch (p.gst().provider()) {
            case "simulated" -> new SimulatedGstProvider();
            // case "cleartax" -> new ClearTaxGstProvider(...);
            default -> throw new IllegalStateException("Unknown app.gst.provider '" + p.gst().provider() + "' (simulated)");
        };
    }
}
