package com.communityos.api.shared.resource;

import com.communityos.api.shared.domain.DomainException;
import java.math.BigDecimal;
import java.util.Collection;
import java.util.Map;
import java.util.Set;

/**
 * Every field of every register has a size, so nothing can fill the database however the request is made: text by what the field holds
 * (a name or code 1 000 characters, a note or message 20 000, structured content 200 000, an image kept inline 13 MB), lists up to 1 000
 * items of up to 2 000 characters, objects up to 200 keys, numbers up to 10^12 with at most 6 decimals. A register's own validate() keeps
 * its tighter rules; this is the floor under all of them. Checked on every create and change through the resource kit.
 */
public final class FieldLimits {
    private FieldLimits() {}
    public static final int SHORT = 1_000, LONG = 20_000, STRUCTURED = 200_000, INLINE_IMAGE = 13_000_000, LIST = 1_000, LIST_ITEM = 2_000, KEYS = 200;
    static final BigDecimal MAX_NUMBER = new BigDecimal("1000000000000");
    static final Set<String> IMAGES = Set.of("imageUrl", "photo", "logo", "thumb", "billFile");
    static final Set<String> STRUCTURED_TEXT = Set.of("boundary", "geometry", "geoRef", "shape", "layout", "history", "fields", "rules", "lateFeeRules", "values", "parameters",
        "extra", "effects", "actions", "heads", "breaks", "findings", "workers", "adminRecipients", "reportRecipients", "sentTo", "trash", "specs");
    static final Set<String> LONG_TEXT = Set.of("body", "description", "details", "notes", "note", "message", "intro", "footer", "headerText", "offeringsIntro", "passMessage",
        "remarks", "reason", "decisionNote", "reviewNote", "statusReason", "summary", "summaryReport", "warrantyTerms", "error", "address", "caption", "purpose");

    public static int maxText(String field) {
        if (IMAGES.contains(field)) return INLINE_IMAGE;
        if (STRUCTURED_TEXT.contains(field)) return STRUCTURED;
        if (LONG_TEXT.contains(field)) return LONG;
        return SHORT;
    }

    /** Refuses the first field over its size, naming it. */
    public static void check(Record r) {
        for (var comp : r.getClass().getRecordComponents()) {
            Object v;
            try { v = comp.getAccessor().invoke(r); } catch (ReflectiveOperationException e) { continue; }
            check(comp.getName(), v, 0);
        }
    }
    static void check(String field, Object v, int depth) {
        switch (v) {
            case null -> { }
            case String s -> { int max = depth == 0 ? maxText(field) : Math.max(LIST_ITEM, maxText(field)); if (s.length() > max) tooBig(field, "at most " + max + " characters"); }
            case BigDecimal b -> { if (b.abs().compareTo(MAX_NUMBER) > 0 || b.scale() > 6) tooBig(field, "a number up to 10^12 with at most 6 decimals"); }
            case Integer i -> { if (Math.abs((long) i) > 1_000_000_000L) tooBig(field, "a number up to 10^9"); }
            case Long l -> { if (Math.abs(l) > 1_000_000_000_000L) tooBig(field, "a number up to 10^12"); }
            case Collection<?> c -> {
                if (c.size() > LIST) tooBig(field, "at most " + LIST + " items");
                if (depth < 4) for (Object o : c) check(field, o, depth + 1);
            }
            case Map<?, ?> m -> {
                if (m.size() > KEYS) tooBig(field, "at most " + KEYS + " entries");
                if (depth < 4) for (var e : m.entrySet()) { check(field, e.getKey(), depth + 1); check(field, e.getValue(), depth + 1); }
            }
            default -> { }
        }
    }
    private static void tooBig(String field, String what) { throw new DomainException.RuleViolated("too-large", "\"" + field + "\" is too large: " + what); }
}
