package com.communityos.adapter.channel;

import com.communityos.domain.OutboundMessage;
import com.communityos.port.OutboundChannel;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;

/**
 * E-mail over SMTP. Works with ANY provider that offers SMTP: Amazon SES, SendGrid, Mailgun, Postmark, Gmail/Workspace,
 * Office 365, your own server. Only the spring.mail.* settings differ (see docs/INTEGRATIONS.md).
 */
public class SmtpEmailChannel implements OutboundChannel {
    private final JavaMailSender mail;
    private final String from;

    public SmtpEmailChannel(JavaMailSender mail, String from) { this.mail = mail; this.from = from; }

    @Override public String channel() { return "Email"; }
    @Override public String provider() { return "smtp"; }

    @Override public void send(OutboundMessage m) {
        SimpleMailMessage msg = new SimpleMailMessage();
        msg.setFrom(from);
        msg.setTo(m.to());
        msg.setSubject(m.subject() == null ? "" : m.subject());
        msg.setText(m.body());
        mail.send(msg);
    }
}
