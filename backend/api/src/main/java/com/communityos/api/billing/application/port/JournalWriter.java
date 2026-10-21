package com.communityos.api.billing.application.port;

import com.communityos.api.billing.domain.Journal;

/** Posts a balanced entry: writes it as Draft with its lines, then marks it Posted (the database re-checks the balance at commit). */
public interface JournalWriter { void post(Journal.Entry entry); }
