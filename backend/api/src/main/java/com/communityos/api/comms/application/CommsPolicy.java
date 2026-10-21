package com.communityos.api.comms.application;

import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;

/** Who may do what with notices, notifications and the forum. */
public final class CommsPolicy {
    private CommsPolicy() {}
    /** A person of this community (not a vendor, not a job). */
    public static boolean member(Caller c) { return c.membership() != null && c.category() != Caller.Category.Vendor && c.category() != Caller.Category.System; }
    /** Writes, sends and removes notices; sees every notice with its receipts. */
    public static boolean publisher(Caller c) { return c.isSuperAdmin() || c.isCommittee() || c.hasAny(Permission.MANAGE_NOTICE_TEMPLATES, Permission.MANAGE_GOVERNANCE); }
    /** Pins, closes, hides and removes in the forum. */
    public static boolean moderator(Caller c) { return c.isSuperAdmin() || c.has(Permission.MODERATE_FORUM); }
    /** Edits the channel settings and the message templates; reads everyone's channel choices. */
    public static boolean notificationsAdmin(Caller c) { return c.isSuperAdmin() || c.has(Permission.MANAGE_NOTIFICATIONS); }
    /** Reads the queue of WhatsApp / SMS / e-mail messages. */
    public static boolean outboxReader(Caller c) { return c.isSuperAdmin() || c.isCommittee() || c.hasAny(Permission.MANAGE_NOTIFICATIONS, Permission.MANAGE_AMENITIES); }
    public static boolean noticeTemplates(Caller c) { return c.isSuperAdmin() || c.has(Permission.MANAGE_NOTICE_TEMPLATES); }
}
