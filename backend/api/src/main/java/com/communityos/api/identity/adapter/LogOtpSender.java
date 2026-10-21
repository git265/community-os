package com.communityos.api.identity.adapter;

import com.communityos.api.identity.application.port.OtpSender;
import com.communityos.api.identity.domain.Phone;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Development only (auth.otp-sender=log): writes the code to the log. Refused at start-up in the prod profile (see AuthConfig). */
public final class LogOtpSender implements OtpSender {
    private static final Logger log = LoggerFactory.getLogger(LogOtpSender.class);
    @Override public void send(Phone to, String code) { log.info("DEV sign-in code for {}: {}", to.masked(), code); }
}
