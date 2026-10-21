package com.communityos.api.vendor.domain;

import com.communityos.api.shared.domain.DomainException;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/** The community's own directory of service people (a plumber, a cook, a driver) and the households' reviews of them. */
public final class Directory {
    private Directory() {}

    public static final class Contact {
        public UUID id; public String shortId; public String name; public String category; public String phone; public String area; public String rate; public String notes;
        public String status = "Active"; public String hiddenReason; public UUID hiddenById; public UUID registryId;
        public UUID addedById; public String addedBy; public UUID addedByUnitId; public String addedByUnit;
        public BigDecimal rating; public int reviews; public int recommends; public UUID myReviewId;
        public Instant createdAt; public long version;
        public boolean hidden() { return "Hidden".equals(status); }
        public void check() {
            name = req(name, "Name", 120);
            category = opt(category, "Category", 80); area = opt(area, "Area", 120); rate = opt(rate, "Rate", 120); notes = opt(notes, "Notes", 4000);
            phone = phone == null || phone.isBlank() ? null : phone.strip();
            if (phone != null && !phone.matches("\\+?[0-9 ()-]{6,20}")) throw rule("bad-phone", "That phone number does not look right");
            if (!"Active".equals(status) && !"Hidden".equals(status)) throw rule("bad-status", "A contact is Active or Hidden");
            hiddenReason = hidden() ? opt(hiddenReason, "Reason", 500) : null;
        }
    }

    public static final class Review {
        public UUID id; public String shortId; public UUID contactId; public int rating; public String comment; public String recommend;
        public UUID authorId; public String author; public UUID unitId; public String unitNo; public Instant createdAt; public long version;
        public void check() {
            if (rating < 1 || rating > 5) throw rule("bad-rating", "Give a rating from 1 to 5");
            comment = opt(comment, "Comment", 4000);
            if (recommend != null && recommend.isBlank()) recommend = null;
            if (recommend != null && !recommend.equals("Yes") && !recommend.equals("No")) throw rule("bad-recommend", "Recommend is Yes or No");
        }
    }

    static String req(String s, String label, int max) {
        if (s == null || s.isBlank()) throw rule("required", label + " is required");
        return opt(s, label, max);
    }
    static String opt(String s, String label, int max) {
        if (s == null) return null;
        String t = s.strip();
        if (t.length() > max) throw rule("too-long", label + " is too long (up to " + max + " characters)");
        return t.isEmpty() ? null : t;
    }
    static DomainException.RuleViolated rule(String code, String message) { return new DomainException.RuleViolated(code, message); }
}
