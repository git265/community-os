package com.communityos.api.comms;

import com.communityos.api.comms.application.CommsPolicy;
import com.communityos.api.comms.domain.Comms;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.resource.Checks;
import com.communityos.api.shared.resource.Item;
import com.communityos.api.shared.resource.Resource;
import com.communityos.api.shared.resource.ResourceRules;
import com.communityos.api.shared.resource.ResourceTable;
import com.communityos.api.shared.resource.ResourceTable.Kind;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import java.util.List;
import java.util.Map;

/**
 * The communication registers (resource kit): important numbers and their sections, merge fields and notice templates, the channel message
 * templates, each member's own channel choices, the community's channel settings per kind of notification, and the channel queue (read-only).
 * Notices, the inbox and the forum have their own services (BroadcastService, InboxService, ForumService).
 */
public final class CommsResources {
    private CommsResources() {}
    static boolean member(Caller c) { return CommsPolicy.member(c); }

    // ---- important numbers -----------------------------------------------------------------------------------------------------------------------
    public record NumberFields(String name, String phone, String group, String available, String note, Integer sortOrder, boolean active) {}
    public static final Resource<NumberFields> NUMBERS = new Resource<>(
        new ResourceTable<>("importantNumbers", "comms/important-numbers", "comms.important_number", NumberFields.class, "r.sort_order NULLS LAST, r.name", Map.of("group", "group_value")),
        new ResourceRules<>() {
            @Override public Spec<NumberFields> readScope(Caller c) { return ResourceRules.only(CommsResources::member, c); }
            @Override public boolean mayWrite(Caller c) { return ResourceRules.committee(c) || c.hasAny(Permission.MANAGE_FIELD_DUTIES, Permission.MANAGE_SECURITY); }
            @Override public NumberFields validate(Caller c, NumberFields f, NumberFields old) {
                String phone = Checks.required(f.phone(), "Phone");
                Checks.rule(phone.matches("[0-9+ ()-]{3,20}"), "bad-phone", "A phone number has 3 to 20 digits, spaces, +, ( ) or -");
                return new NumberFields(Checks.required(f.name(), "Name"), phone, Checks.text(f.group(), "Section", 100), Checks.text(f.available(), "Available", 100),
                    Checks.text(f.note(), "Note", 500), Checks.nonNegative(f.sortOrder(), "Order"), f.active());
            }
            @Override public String label(NumberFields f) { return f.name(); }
        });
    public record SectionFields(String name, String icon, Integer sortOrder, boolean active) {}
    public static final Resource<SectionFields> SECTIONS = new Resource<>(
        new ResourceTable<>("numberSections", "comms/number-sections", "comms.number_section", SectionFields.class, "r.sort_order NULLS LAST, r.name"),
        new ResourceRules<>() {
            @Override public Spec<SectionFields> readScope(Caller c) { return ResourceRules.only(CommsResources::member, c); }
            @Override public boolean mayWrite(Caller c) { return c.isSuperAdmin(); }
            @Override public SectionFields validate(Caller c, SectionFields f, SectionFields old) {
                return new SectionFields(Checks.required(f.name(), "Name"), Checks.text(f.icon(), "Icon", 16), Checks.nonNegative(f.sortOrder(), "Order"), f.active());
            }
            @Override public String label(SectionFields f) { return f.name(); }
        });

    // ---- notice templates ----------------------------------------------------------------------------------------------------------------------------
    public record MergeFieldFields(String token, String label, String defaultValue) {}
    public static final Resource<MergeFieldFields> MERGE_FIELDS = new Resource<>(
        new ResourceTable<>("mergeFields", "comms/merge-fields", "comms.merge_field", MergeFieldFields.class, "r.token"),
        new ResourceRules<>() {
            @Override public Spec<MergeFieldFields> readScope(Caller c) { return ResourceRules.only(ResourceRules::staffOrCommittee, c); }
            @Override public boolean mayWrite(Caller c) { return CommsPolicy.noticeTemplates(c); }
            @Override public MergeFieldFields validate(Caller c, MergeFieldFields f, MergeFieldFields old) {
                String token = Checks.required(f.token(), "Token");
                Checks.rule(token.matches("\\{[a-zA-Z][a-zA-Z0-9_]{0,40}\\}"), "bad-token", "A merge field looks like {name}: letters, digits and _ in braces");
                return new MergeFieldFields(token, Checks.required(f.label(), "Label"), Checks.text(f.defaultValue(), "Default", 500));
            }
            @Override public String label(MergeFieldFields f) { return f.token(); }
        });
    public record NoticeTemplateFields(String name, String appliesTo, String logo, String headerText, String body) {}
    public static final Resource<NoticeTemplateFields> NOTICE_TEMPLATES = new Resource<>(
        new ResourceTable<>("noticeTemplates", "comms/notice-templates", "comms.notice_template", NoticeTemplateFields.class, "r.name"),
        new ResourceRules<>() {
            @Override public Spec<NoticeTemplateFields> readScope(Caller c) { return ResourceRules.only(ResourceRules::staffOrCommittee, c); }
            @Override public boolean mayWrite(Caller c) { return CommsPolicy.noticeTemplates(c); }
            @Override public NoticeTemplateFields validate(Caller c, NoticeTemplateFields f, NoticeTemplateFields old) {
                Checks.rule(f.logo() == null || f.logo().length() <= 400_000, "logo-too-big", "The logo is too large");
                return new NoticeTemplateFields(Checks.required(f.name(), "Name"),
                    Checks.oneOf(f.appliesTo(), "Applies to", List.of("Any", "DG bill", "Water bill", "Maintenance fee", "Payment reminder", "Announcement")),
                    f.logo(), Checks.text(f.headerText(), "Header", 500), Checks.text(Checks.required(f.body(), "Body"), "Body", 20_000));
            }
            @Override public String label(NoticeTemplateFields f) { return f.name(); }
        });

    // ---- channel templates, choices and settings -------------------------------------------------------------------------------------------------------
    public record TemplateFields(String event, String channel, String audience, boolean enabled, String subject, String body) {}
    public static final Resource<TemplateFields> TEMPLATES = new Resource<>(
        new ResourceTable<>("notificationTemplates", "comms/notification-templates", "comms.notification_template", TemplateFields.class, "r.event, r.channel, r.audience"),
        new ResourceRules<>() {
            @Override public Spec<TemplateFields> readScope(Caller c) { return ResourceRules.only(ResourceRules::staffOrCommittee, c); }
            @Override public boolean mayWrite(Caller c) { return CommsPolicy.notificationsAdmin(c); }
            @Override public TemplateFields validate(Caller c, TemplateFields f, TemplateFields old) {
                String event = Checks.required(f.event(), "Event");
                Checks.rule(event.matches("[a-z][a-z0-9_]{1,40}"), "bad-event", "An event is a short code like booking_confirmed");
                return new TemplateFields(event, Checks.requiredOneOf(f.channel(), "Channel", Comms.CHANNELS), Checks.oneOf(f.audience(), "Audience", List.of("Owner", "Admin")),
                    f.enabled(), Checks.text(f.subject(), "Subject", 200), Checks.text(f.body(), "Message", 4000));
            }
            @Override public String label(TemplateFields f) { return f.event() + " · " + f.channel(); }
        });
    /** A member's own extra channels (the app itself is always on). One row per member; the member is the caller. */
    public record PrefFields(boolean whatsapp, boolean sms, boolean email) {}
    public static final Resource<PrefFields> PREFS = new Resource<>(
        new ResourceTable<>("notificationPrefs", "comms/notification-prefs", "comms.notification_pref", PrefFields.class, "r.created_at").who("userName", "membership_id", true),
        new ResourceRules<>() {
            @Override public Spec<PrefFields> readScope(Caller c) {
                if (CommsPolicy.notificationsAdmin(c) || c.has(Permission.MANAGE_USERS)) return Spec.all();
                if (c.membership() == null) return Spec.none();
                return Spec.eq("r.membership_id", c.membership().value(), (f) -> true);
            }
            @Override public boolean mayWrite(Caller c) { return c.membership() != null; }
            @Override public boolean mayChange(Caller c, Item<PrefFields> it) { return ResourceRules.mine(c, it, "userNameId"); }
            @Override public String label(PrefFields f) { return "channels"; }
        });
    /** Per kind of notification: which extra channels the community offers ({event: {whatsapp, sms, email, alsoRoles: [...]}}). One row per community. */
    public record SettingFields(Map<String, Object> events) {}
    public static final Resource<SettingFields> SETTINGS = new Resource<>(
        new ResourceTable<>("notificationSettings", "comms/notification-settings", "comms.notification_setting", SettingFields.class, "r.created_at"),
        new ResourceRules<>() {
            @Override public Spec<SettingFields> readScope(Caller c) { return ResourceRules.only(CommsResources::member, c); }
            @Override public boolean mayWrite(Caller c) { return CommsPolicy.notificationsAdmin(c); }
            @Override @SuppressWarnings("unchecked") public SettingFields validate(Caller c, SettingFields f, SettingFields old) {
                Checks.rule(old != null, "one-per-community", "The notification settings already exist - change them instead");
                Map<String, Object> events = f.events() == null ? Map.of() : f.events();
                for (var e : events.entrySet()) {
                    Checks.rule(Comms.EVENTS.contains(e.getKey()) || e.getKey().matches("[a-z][a-z0-9_]{1,40}"), "bad-event", "Unknown kind of notification: " + e.getKey());
                    Checks.rule(e.getValue() instanceof Map, "bad-event", "Each kind of notification takes its channel switches");
                    for (var s : ((Map<String, Object>) e.getValue()).entrySet()) {
                        if ("alsoRoles".equals(s.getKey())) Checks.rule(s.getValue() instanceof List<?> l && l.stream().allMatch((x) -> x instanceof String r && r.matches("[a-z_]{2,40}")),
                            "bad-roles", "Also tell: a list of role codes");
                        else Checks.rule(List.of("whatsapp", "sms", "email").contains(s.getKey()) && s.getValue() instanceof Boolean, "bad-switch",
                            "Channel switches are whatsapp, sms and email (true / false)");
                    }
                }
                return new SettingFields(events);
            }
            @Override public boolean deletable(SettingFields f) { return false; }
        });
    /** The queue of WhatsApp / SMS / e-mail messages - written by the server only. */
    public record OutboxFields(String event, String channel, String to, String status, String subject, String body, String error) {}
    public static final Resource<OutboxFields> OUTBOX = new Resource<>(
        new ResourceTable<>("notificationOutbox", "comms/outbox", "comms.outbox_message", OutboxFields.class, "r.created_at DESC", Map.of("to", "to_value"))
            .who("personName", "membership_id", false).filterBy("status", "channel"),
        new ResourceRules<>() {
            @Override public Spec<OutboxFields> readScope(Caller c) { return ResourceRules.only(CommsPolicy::outboxReader, c); }
            @Override public boolean mayWrite(Caller c) { return false; }
            @Override public boolean deletable(OutboxFields f) { return false; }
        });

    public static List<Resource<?>> all() { return List.of(NUMBERS, SECTIONS, MERGE_FIELDS, NOTICE_TEMPLATES, TEMPLATES, PREFS, SETTINGS, OUTBOX); }
}
