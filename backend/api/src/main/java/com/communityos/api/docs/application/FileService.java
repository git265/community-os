package com.communityos.api.docs.application;

import com.communityos.api.docs.application.port.FileRepository;
import com.communityos.api.docs.application.port.FileStorage;
import com.communityos.api.docs.application.port.VirusScanner;
import com.communityos.api.docs.domain.FileRules;
import com.communityos.api.docs.domain.StoredFile;
import com.communityos.api.shared.audit.AuditWriter;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tx.Tx;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.BiPredicate;

/**
 * Files: upload (checked from the bytes, scanned when a scanner is configured, stored under a key the server makes), then attach to one thing.
 * Who may open a file follows from that thing - the module that owns it answers (an OwnerKind per kind of thing); before it is attached only
 * its uploader (or, by its visibility, the community / staff / committee) may. Deleting is the uploader's while unattached, else a manager's.
 */
public final class FileService {
    /** A kind of thing files are attached to, and the module's answer to "may this caller read / attach to that one". */
    public record OwnerKind(String type, BiPredicate<Caller, UUID> mayRead, BiPredicate<Caller, UUID> mayAttach) {}
    public record Upload(String fileName, byte[] bytes, String visibility) {}
    public record Content(StoredFile file, byte[] bytes) {}

    private final FileRepository files; private final FileStorage storage; private final VirusScanner scanner; private final AuditWriter audit; private final Tx tx; private final Clock clock;
    private final Map<String, OwnerKind> kinds = new HashMap<>();
    public FileService(FileRepository files, FileStorage storage, VirusScanner scanner, AuditWriter audit, Tx tx, Clock clock) {
        this.files = files; this.storage = storage; this.scanner = scanner; this.audit = audit; this.tx = tx; this.clock = clock;
    }
    public FileService register(OwnerKind k) { kinds.put(k.type(), k); return this; }

    public StoredFile upload(Caller c, Upload u) {
        if (c.membership() == null || c.category() == Caller.Category.System) throw new AccessDenied("Sign in to upload");
        FileRules.Checked ok = FileRules.check(u.fileName(), u.bytes());
        String visibility = u.visibility() == null ? "Owner" : u.visibility();
        if (!List.of("Owner", "Community", "Staff", "Committee").contains(visibility)) throw new DomainException.RuleViolated("bad-visibility", "Visibility is Owner, Community, Staff or Committee");
        VirusScanner.Verdict v = scanner.scan(u.bytes());
        if (v.result() == VirusScanner.Result.INFECTED) {
            audit.write(c, AuditWriter.Action.Denied, "docs.file_object", null, null, null, "Upload blocked: " + (v.signature() == null ? "virus" : v.signature()), List.of());
            throw new DomainException.RuleViolated("infected", "The virus scanner found " + (v.signature() == null ? "a virus" : v.signature()) + " - the file was not stored");
        }
        UUID id = UUID.randomUUID();
        var now = clock.instant().atOffset(ZoneOffset.UTC);
        String key = "communities/" + c.community().value() + "/" + now.getYear() + "/" + String.format("%02d", now.getMonthValue()) + "/" + id;
        storage.put(key, u.bytes());                                   // the bytes first: a row never points at nothing
        try {
            return tx.inTx(() -> {
                StoredFile f = files.insert(new FileRepository.NewFile(id, ok.fileName(), ok.mime(), u.bytes().length, sha256(u.bytes()), key,
                    v.result() == VirusScanner.Result.CLEAN ? "Clean" : "Pending", visibility));
                audit.write(c, AuditWriter.Action.Create, "docs.file_object", f.id(), f.shortId(), null, f.fileName() + " (" + f.sizeBytes() + " bytes)", List.of());
                return f;
            });
        } catch (RuntimeException e) { storage.delete(key); throw e; }
    }

    public StoredFile get(Caller c, UUID id) { StoredFile f = files.get(id).orElseThrow(AccessDenied.NotVisible::new); if (!mayRead(c, f)) throw new AccessDenied.NotVisible(); return f; }
    public Content content(Caller c, UUID id) {
        StoredFile f = get(c, id);
        if ("Infected".equals(f.scanStatus())) throw new DomainException.RuleViolated("infected", "This file is blocked");
        // not scanned yet: only the person who uploaded it opens it (to check their own upload); everyone else waits for the scanner
        if (!"Clean".equals(f.scanStatus()) && !mine(c, f)) throw new DomainException.RuleViolated("not-scanned", f.fileName() + " is still being checked for viruses - try again in a few minutes");
        return new Content(f, storage.get(f.storageKey()));
    }
    /** Files that came in while the scanner was down: scanned now (the job). An infected one is blocked and its uploader can no longer open it. */
    public int rescan(Caller system, int batch) {
        int n = 0;
        for (StoredFile f : files.unscanned(batch)) {
            VirusScanner.Verdict v = scanner.scan(storage.get(f.storageKey()));
            if (v.result() == VirusScanner.Result.UNAVAILABLE) break;                     // still down: try again next time
            String status = v.result() == VirusScanner.Result.INFECTED ? "Infected" : "Clean";
            tx.run(() -> {
                files.scanned(f.id(), status);
                if ("Infected".equals(status)) audit.write(system, AuditWriter.Action.Denied, "docs.file_object", f.id(), f.shortId(), null,
                    "Blocked after upload: " + (v.signature() == null ? "virus" : v.signature()) + " in " + f.fileName(), List.of());
            });
            io.micrometer.core.instrument.Metrics.counter("cos.files.scanned", "result", status).increment();
            n++;
        }
        return n;
    }
    /** The files on things of one kind that the caller may open (on one thing when ownerId is given). */
    public List<StoredFile> list(Caller c, String ownerType, UUID ownerId) {
        if (StoredFile.UNATTACHED.equals(ownerType)) return files.byOwner(ownerType, null).stream().filter((f) -> mine(c, f)).toList();
        OwnerKind k = kind(ownerType);
        if (ownerId != null) return k.mayRead().test(c, ownerId) ? files.byOwner(ownerType, ownerId) : List.of();
        Map<UUID, Boolean> seen = new HashMap<>(); List<StoredFile> out = new ArrayList<>();
        for (StoredFile f : files.byOwner(ownerType, null)) if (mine(c, f) || seen.computeIfAbsent(f.ownerId(), (o) -> safe(k.mayRead(), c, o))) out.add(f);
        return out;
    }
    /** Attach an uploaded file to one thing. Only its uploader attaches it, once, to something they may change. */
    public StoredFile attach(Caller c, UUID id, String ownerType, UUID ownerId) {
        OwnerKind k = kind(ownerType);
        return tx.inTx(() -> {
            StoredFile f = files.get(id).orElseThrow(AccessDenied.NotVisible::new);
            // already on this record: nothing to do (saving a record again sends its files again, whoever uploaded them)
            if (f.attached() && f.ownerType().equals(ownerType) && ownerId.equals(f.ownerId())) return f;
            if (!mine(c, f)) throw new AccessDenied("Attach only files you uploaded");
            if (f.attached()) throw new DomainException.RuleViolated("already-attached", f.fileName() + " is already attached elsewhere");
            if (!safe(k.mayAttach(), c, ownerId)) throw new AccessDenied("You cannot add files there");
            if (!files.attach(id, f.version(), ownerType, ownerId)) throw new DomainException.Conflict("File " + f.shortId());
            audit.write(c, AuditWriter.Action.Update, "docs.file_object", f.id(), f.shortId(), null, "Attached to " + ownerType, List.of());
            return files.get(id).orElseThrow();
        });
    }
    public void delete(Caller c, UUID id) {
        StoredFile gone = tx.inTx(() -> {
            StoredFile f = files.get(id).orElseThrow(AccessDenied.NotVisible::new);
            // the uploader, before it is used; someone who may change the record it is on (a photo taken off a ticket); a document manager
            boolean onMine = f.attached() && kinds.containsKey(f.ownerType()) && safe(kinds.get(f.ownerType()).mayAttach(), c, f.ownerId());
            if (!(mine(c, f) && !f.attached()) && !onMine && !DocsPolicy.manager(c))
                throw new AccessDenied("Only the uploader removes a file before it is used; after that, someone who may change the record it is on, or a document manager");
            if (!files.delete(id, f.version())) throw new DomainException.Conflict("File " + f.shortId());
            audit.write(c, AuditWriter.Action.Delete, "docs.file_object", f.id(), f.shortId(), null, f.fileName(), List.of());
            return f;
        });
        storage.delete(gone.storageKey());
    }

    boolean mayRead(Caller c, StoredFile f) {
        if (mine(c, f)) return true;
        if (f.attached()) { OwnerKind k = kinds.get(f.ownerType()); return k != null && safe(k.mayRead(), c, f.ownerId()); }
        return switch (f.visibility()) {
            case "Community" -> c.membership() != null && c.category() != Caller.Category.Vendor;
            case "Staff" -> c.isCommittee() || c.category() == Caller.Category.Staff || c.isSuperAdmin();
            case "Committee" -> c.isCommittee() || c.isSuperAdmin();
            default -> false;
        };
    }
    static boolean mine(Caller c, StoredFile f) { return c.membership() != null && c.membership().value().equals(f.uploadedById()); }
    /** A module saying "not visible" by throwing means no. */
    static boolean safe(BiPredicate<Caller, UUID> p, Caller c, UUID id) {
        try { return p.test(c, id); } catch (AccessDenied | DomainException e) { return false; }
    }
    private OwnerKind kind(String type) {
        OwnerKind k = kinds.get(type);
        if (k == null) throw new DomainException.RuleViolated("bad-owner", "Files can be attached to: " + String.join(", ", kinds.keySet()));
        return k;
    }
    static byte[] sha256(byte[] b) { try { return MessageDigest.getInstance("SHA-256").digest(b); } catch (java.security.NoSuchAlgorithmException e) { throw new IllegalStateException(e); } }
}
