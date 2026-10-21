package com.communityos.api.docs.application;

import com.communityos.api.docs.application.port.DocumentRepository;
import com.communityos.api.docs.domain.Document;
import com.communityos.api.docs.domain.StoredFile;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tx.Tx;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * The document repository. A document manager files a document (a file already uploaded, attached to it here), says who may read it (a group,
 * or one unit's owner / resident), its expiry and its folder. Readers see what their group and the folders' role limits allow.
 */
public final class DocumentService {
    /** What a manager writes on a document; the file, its name, size and scan result are the server's. */
    public record Fields(String title, String category, String edition, String access, UUID unitId, LocalDate expiry, UUID folderId) {}

    private final DocumentRepository docs; private final FileService files; private final AuditWriter audit; private final Tx tx;
    public DocumentService(DocumentRepository docs, FileService files, AuditWriter audit, Tx tx) { this.docs = docs; this.files = files; this.audit = audit; this.tx = tx; }

    public List<Document> list(Caller c, DocumentRepository.Filter f) { requireReader(c); return docs.list(DocsPolicy.documents(c), f); }
    public Document get(Caller c, UUID id) { requireReader(c); return docs.get(id, DocsPolicy.documents(c)).orElseThrow(AccessDenied.NotVisible::new); }
    /** For the file module: may this caller open the file of this document? */
    public boolean visible(Caller c, UUID id) { return CommsSafe.member(c) && docs.get(id, DocsPolicy.documents(c)).isPresent(); }

    public Document file(Caller c, UUID fileId, Fields in) {
        requireManager(c);
        return tx.inTx(() -> {
            Document d = apply(new Document(), in);
            d.check();
            StoredFile f = files.get(c, fileId);
            if (f.attached()) throw new DomainException.RuleViolated("already-attached", f.fileName() + " is already used elsewhere");
            d.fileId = fileId;
            docs.insert(d);
            files.attach(c, fileId, "docs.document", d.id);
            audit.write(c, AuditWriter.Action.Create, "docs.document", d.id, d.shortId, d.unitId, d.title + " (" + d.access + ")", List.of());
            return docs.get(d.id, com.communityos.api.shared.access.Spec.all()).orElseThrow();
        });
    }
    public Document change(Caller c, UUID id, long version, Fields in) {
        requireManager(c);
        return tx.inTx(() -> {
            Document d = docs.get(id, com.communityos.api.shared.access.Spec.all()).orElseThrow(AccessDenied.NotVisible::new);
            if (d.version != version) throw new DomainException.Conflict("Document " + d.shortId);
            String before = d.access;
            apply(d, in); d.check();
            if (!docs.update(d)) throw new DomainException.Conflict("Document " + d.shortId);
            audit.write(c, AuditWriter.Action.Update, "docs.document", d.id, d.shortId, d.unitId, d.title,
                before.equals(d.access) ? List.of() : List.of(new AuditWriter.Change("access", before, d.access)));
            return docs.get(id, com.communityos.api.shared.access.Spec.all()).orElseThrow();
        });
    }
    /** Removing a document keeps its file on record (the audit trail can still name it); a manager may delete the file afterwards. */
    public void remove(Caller c, UUID id, long version) {
        requireManager(c);
        tx.run(() -> {
            Document d = docs.get(id, com.communityos.api.shared.access.Spec.all()).orElseThrow(AccessDenied.NotVisible::new);
            if (!docs.delete(id, version)) throw new DomainException.Conflict("Document " + d.shortId);
            audit.write(c, AuditWriter.Action.Delete, "docs.document", d.id, d.shortId, d.unitId, d.title, List.of());
        });
    }

    static Document apply(Document d, Fields in) {
        d.title = in.title(); d.category = blank(in.category()); d.edition = blank(in.edition()); d.access = in.access() == null ? "Everyone" : in.access();
        d.unitId = in.unitId(); d.expiry = in.expiry(); d.folderId = in.folderId();
        return d;
    }
    static String blank(String s) { return s == null || s.isBlank() ? null : s.strip(); }
    static void requireManager(Caller c) { if (!DocsPolicy.manager(c)) throw new AccessDenied("Filing documents needs the document management permission"); }
    static void requireReader(Caller c) { if (!CommsSafe.member(c)) throw new AccessDenied("The document repository is for members of the community"); }
    /** A person of this community (not a vendor, not a job). */
    static final class CommsSafe { static boolean member(Caller c) { return c.membership() != null && c.category() != Caller.Category.Vendor && c.category() != Caller.Category.System; } }
}
