package com.communityos.api.docs.domain;

import com.communityos.api.shared.domain.DomainException;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/** A document of the repository: a file with a title, a group of readers, an optional unit and expiry, in a folder. */
public final class Document {
    public static final String VILLA_GROUP = "Villa owner / resident";
    public static final List<String> GROUPS = List.of("Everyone", "All owners", "Executive Committee", "EC + Finance", "Staff", VILLA_GROUP);
    public UUID id; public String shortId; public String title; public String category; public String edition; public String access = "Everyone"; public UUID unitId;
    public String unitNo; public LocalDate expiry; public UUID folderId; public UUID fileId; public String fileName; public Long fileSize; public String mimeType; public String scanStatus;
    public UUID uploadedById; public String uploadedBy; public Instant createdAt; public Instant updatedAt; public long version;

    public void check() {
        rule(title != null && !title.isBlank(), "title-required", "The document needs a title");
        title = title.strip();
        rule(title.length() <= 200, "title-too-long", "Keep the title to 200 characters");
        rule(access != null && access.length() >= 2 && access.length() <= 60, "group-required", "Choose who may read the document");
        rule(!VILLA_GROUP.equals(access) || unitId != null, "unit-required", "A villa owner / resident document needs its unit");
        if (!VILLA_GROUP.equals(access)) unitId = null;
        rule(category == null || category.length() <= 60, "category-too-long", "Keep the category short");
        rule(edition == null || edition.length() <= 40, "edition-too-long", "Keep the version label short");
    }
    static void rule(boolean ok, String code, String message) { if (!ok) throw new DomainException.RuleViolated(code, message); }
}
