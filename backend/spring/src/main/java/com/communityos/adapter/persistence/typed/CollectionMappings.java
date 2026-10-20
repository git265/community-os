package com.communityos.adapter.persistence.typed;

import java.util.Map;
import java.util.Optional;
import java.util.Set;

/** The registry that decides whether a collection is a typed table or an ordinary JSONB document. The ONLY place that knows. */
public final class CollectionMappings {
    private CollectionMappings() {}

    /** Columns that hold a calendar DATE (not a timestamp): a date range on them compares dates. */
    public static final Set<String> DATE_COLUMNS = Set.of("due_date", "booking_date", "entry_date");

    private static final Map<String, CollectionMapping> TYPED = Map.of(
        "properties", new CollectionMapping("units",
            Map.of("unit", "unit", "zone", "zone", "type", "unit_type", "occupancy", "occupancy"), Map.of(), false),
        "users", new CollectionMapping("users",
            Map.of("name", "full_name", "roleId", "role_id", "status", "status"), Map.of(), false),
        "dues", new CollectionMapping("dues",
            Map.of("unit", "unit", "status", "status", "category", "category", "billedMonth", "billed_month"),
            Map.of("dueDate", "due_date", "amount", "amount"), false),
        "amenities", new CollectionMapping("bookings",
            Map.of("amenity", "amenity", "unit", "unit", "slot", "slot", "status", "status", "paymentStatus", "payment_status", "paymentRef", "payment_ref"),
            Map.of("date", "booking_date", "totalPayable", "total_payable"), false),
        "tickets", new CollectionMapping("tickets",
            Map.of("unit", "unit", "status", "status", "scope", "scope", "taskType", "task_type", "category", "category", "priority", "priority", "assignedTo", "assigned_to"),
            Map.of("createdAt", "opened_at", "slaDueAt", "sla_due_at"), false),
        "ledger", new CollectionMapping("ledger_entries",
            Map.of("type", "entry_type", "account", "account", "category", "category", "unit", "unit", "reconStatus", "recon_status", "sourceType", "source_type", "sourceId", "source_id"),
            Map.of("date", "entry_date", "amount", "amount"), false),
        "audit", new CollectionMapping("audit_log",
            Map.ofEntries(Map.entry("action", "action"), Map.entry("collection", "collection"), Map.entry("unit", "unit"), Map.entry("recordId", "record_id"),
                Map.entry("recordShortId", "record_short_id"), Map.entry("who", "who"), Map.entry("whoName", "who_name"), Map.entry("shortId", "short_id"),
                Map.entry("ip", "ip"), Map.entry("requestId", "request_id")),
            Map.of("when", "at"), true));

    public static Optional<CollectionMapping> of(String collection) { return Optional.ofNullable(TYPED.get(collection)); }
    public static boolean isTyped(String collection) { return TYPED.containsKey(collection); }
}
