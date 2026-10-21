package com.communityos.api.identity.application.port;

import com.communityos.api.identity.domain.Phone;

/** Strategy: how a sign-in code reaches the phone (SMS provider, WhatsApp template, the log in development). */
public interface OtpSender {
    void send(Phone to, String code);
}
