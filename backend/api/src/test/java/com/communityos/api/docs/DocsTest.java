package com.communityos.api.docs;

import static org.junit.jupiter.api.Assertions.*;

import com.communityos.api.Fixtures;
import com.communityos.api.docs.adapter.LocalDiskStorage;
import com.communityos.api.docs.application.DocsPolicy;
import com.communityos.api.docs.application.FileService;
import com.communityos.api.docs.application.port.FileRepository;
import com.communityos.api.docs.application.port.FileStorage;
import com.communityos.api.docs.application.port.VirusScanner;
import com.communityos.api.docs.domain.Document;
import com.communityos.api.docs.domain.FileRules;
import com.communityos.api.docs.domain.StoredFile;
import com.communityos.api.shared.domain.DomainException;
import com.communityos.api.shared.security.AccessDenied;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.security.Permission;
import com.communityos.api.shared.tx.Tx;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** Files are judged by their bytes; who may open one follows the thing it is attached to; documents by their group of readers. */
class DocsTest {
    static final byte[] PDF = "%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF".getBytes(StandardCharsets.ISO_8859_1);
    static final byte[] PNG = {(byte) 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13};

    @Test void rules() {
        assertEquals(new FileRules.Checked("lease.pdf", "application/pdf", false), FileRules.check("lease.pdf", PDF));
        assertEquals("image/png", FileRules.check("IMG_1.PNG", PNG).mime(), "the type comes from the server's table, not the browser");
        assertEquals("not-what-it-says", assertThrows(DomainException.RuleViolated.class, () -> FileRules.check("photo.jpg", PDF)).code());
        assertEquals("type-not-allowed", assertThrows(DomainException.RuleViolated.class, () -> FileRules.check("setup.exe", PDF)).code());
        assertEquals("type-not-allowed", assertThrows(DomainException.RuleViolated.class, () -> FileRules.check("page.html", "<html>".getBytes())).code(), "no active pages");
        assertEquals("infected", assertThrows(DomainException.RuleViolated.class, () -> FileRules.check("a.txt",
            "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*".getBytes())).code());
        assertEquals("active-content", assertThrows(DomainException.RuleViolated.class, () -> FileRules.check("x.pdf", "%PDF-1.4 /OpenAction << /JS (app.alert(1)) >>".getBytes())).code());
        assertEquals("binary-in-text", assertThrows(DomainException.RuleViolated.class, () -> FileRules.check("x.csv", new byte[] {'a', 0, 'b'})).code());
        assertEquals("empty", assertThrows(DomainException.RuleViolated.class, () -> FileRules.check("x.txt", new byte[0])).code());
        assertEquals("passwd.txt", FileRules.cleanName("../../etc/passwd.txt"), "only the last part of a path");
        assertEquals("a b.pdf", FileRules.cleanName("C:\\Users\\x\\a\u0000 b.pdf"));
        assertTrue(FileRules.cleanName("x".repeat(300) + ".pdf").endsWith(".pdf"));
    }

    static Document doc(String access, UUID unit) { Document d = new Document(); d.title = "Bye-laws"; d.access = access; d.unitId = unit; return d; }
    @Test void documentGroups() {
        Caller owner = Fixtures.owner(Fixtures.UNIT_A), tenant = Fixtures.caller(Caller.Category.Resident, Set.of("resident"), Set.of(Fixtures.UNIT_A), Set.of());
        Caller ec = Fixtures.treasurer(), staff = Fixtures.helpdesk();
        var docs = DocsPolicy.documents(owner);
        assertTrue(docs.matches(doc("Everyone", null)));
        assertTrue(docs.matches(doc("All owners", null))); assertFalse(DocsPolicy.documents(tenant).matches(doc("All owners", null)));
        assertFalse(docs.matches(doc("Executive Committee", null))); assertTrue(DocsPolicy.documents(ec).matches(doc("Executive Committee", null)));
        assertTrue(DocsPolicy.documents(ec).matches(doc("EC + Finance", null))); assertFalse(DocsPolicy.documents(staff).matches(doc("EC + Finance", null)));
        assertTrue(DocsPolicy.documents(staff).matches(doc("Staff", null))); assertFalse(docs.matches(doc("Staff", null)));
        assertTrue(docs.matches(doc(Document.VILLA_GROUP, Fixtures.UNIT_A.value()))); assertFalse(docs.matches(doc(Document.VILLA_GROUP, Fixtures.UNIT_B.value())), "another villa's papers");
        assertFalse(DocsPolicy.documents(staff).matches(doc(Document.VILLA_GROUP, Fixtures.UNIT_A.value())));
        assertFalse(docs.matches(doc("Tower A residents", null)), "a group the server does not know is staff-only");
        assertTrue(DocsPolicy.documents(Fixtures.caller(Caller.Category.Staff, Set.of("facility_manager"), Set.of(), Set.of(), Permission.MANAGE_DOCUMENTS)).sql().equals("TRUE"), "a manager reads all");
        Document v = doc(Document.VILLA_GROUP, null);
        assertEquals("unit-required", assertThrows(DomainException.RuleViolated.class, v::check).code());
        Document e = doc("Everyone", Fixtures.UNIT_A.value()); e.check(); assertNull(e.unitId, "only a villa document keeps a unit");
    }

    /** In-memory metadata and bytes. */
    static final class Mem implements FileRepository, FileStorage {
        final Map<UUID, StoredFile> rows = new HashMap<>(); final Map<String, byte[]> bytes = new HashMap<>(); boolean failInsert;
        @Override public StoredFile insert(NewFile f) {
            if (failInsert) throw new IllegalStateException("db down");
            StoredFile s = new StoredFile(f.id(), "FIL-1", f.fileName(), f.mimeType(), f.sizeBytes(), "00", "upload", null, f.scanStatus(), f.visibility(), uploader, "x", f.storageKey(), null, 1);
            rows.put(f.id(), s); return s;
        }
        UUID uploader;
        @Override public Optional<StoredFile> get(UUID id) { return Optional.ofNullable(rows.get(id)); }
        @Override public List<StoredFile> byOwner(String t, UUID o) { return rows.values().stream().filter((x) -> x.ownerType().equals(t) && (o == null || o.equals(x.ownerId()))).toList(); }
        @Override public boolean attach(UUID id, long v, String t, UUID o) {
            StoredFile x = rows.get(id);
            rows.put(id, new StoredFile(x.id(), x.shortId(), x.fileName(), x.mimeType(), x.sizeBytes(), x.sha256(), t, o, x.scanStatus(), x.visibility(), x.uploadedById(), x.uploadedBy(), x.storageKey(), null, v + 1));
            return true;
        }
        @Override public boolean delete(UUID id, long v) { return rows.remove(id) != null; }
        @Override public Optional<CommentFacts> comment(UUID id) { return Optional.empty(); }
        @Override public List<StoredFile> unscanned(int limit) { return rows.values().stream().filter((x) -> "Pending".equals(x.scanStatus())).limit(limit).toList(); }
        @Override public void scanned(UUID id, String st) { StoredFile x = rows.get(id);
            rows.put(id, new StoredFile(x.id(), x.shortId(), x.fileName(), x.mimeType(), x.sizeBytes(), x.sha256(), x.ownerType(), x.ownerId(), st, x.visibility(), x.uploadedById(), x.uploadedBy(), x.storageKey(), null, x.version() + 1)); }
        @Override public void put(String k, byte[] b) { bytes.put(k, b); }
        @Override public byte[] get(String k) { return bytes.get(k); }
        @Override public void delete(String k) { bytes.remove(k); }
    }
    @Test void files() {
        Mem mem = new Mem();
        Caller owner = Fixtures.owner(Fixtures.UNIT_A), other = Fixtures.owner(Fixtures.UNIT_B), ec = Fixtures.treasurer();
        UUID mine = UUID.randomUUID(), theirs = UUID.randomUUID();
        List<String> audit = new ArrayList<>();
        FileService svc = new FileService(mem, mem, VirusScanner.NONE, new Fixtures.Audit(), Tx.direct(), Fixtures.CLOCK)
            .register(new FileService.OwnerKind("maintenance.ticket", (c, id) -> id.equals(mine) ? c.equals(owner) || c.equals(ec) : c.equals(other), (c, id) -> id.equals(mine) && c.equals(owner)));
        mem.uploader = owner.membership().value();
        StoredFile f = svc.upload(owner, new FileService.Upload("leak.png", PNG, null));
        assertEquals("Pending", f.scanStatus(), "no scanner: checked by the rules, not scanned"); assertEquals("Owner", f.visibility());
        assertTrue(f.storageKey().startsWith("communities/" + owner.community().value() + "/2026/10/"), "the server makes the key");
        assertThrows(AccessDenied.NotVisible.class, () -> svc.get(ec, f.id()), "unattached: only its uploader");
        assertThrows(AccessDenied.class, () -> svc.attach(other, f.id(), "maintenance.ticket", theirs), "only the uploader attaches it");
        assertThrows(AccessDenied.class, () -> svc.attach(owner, f.id(), "maintenance.ticket", theirs), "not to something they may not change");
        assertEquals("bad-owner", assertThrows(DomainException.RuleViolated.class, () -> svc.attach(owner, f.id(), "gate.visit", mine)).code());
        StoredFile on = svc.attach(owner, f.id(), "maintenance.ticket", mine);
        assertEquals(mine, on.ownerId());
        assertEquals("not-scanned", assertThrows(DomainException.RuleViolated.class, () -> svc.content(ec, f.id())).code(), "not scanned yet: nobody else opens it");
        assertTrue(java.util.Arrays.equals(PNG, svc.content(owner, f.id()).bytes()), "its uploader does");
        FileService down = new FileService(mem, mem, VirusScanner.NONE, new Fixtures.Audit(), Tx.direct(), Fixtures.CLOCK);
        assertEquals(0, down.rescan(Fixtures.treasurer(), 10), "the scanner still down: nothing changes");
        FileService up = new FileService(mem, mem, (b) -> new VirusScanner.Verdict(VirusScanner.Result.CLEAN, null), new Fixtures.Audit(), Tx.direct(), Fixtures.CLOCK);
        assertEquals(1, up.rescan(Fixtures.treasurer(), 10));
        assertTrue(java.util.Arrays.equals(PNG, svc.content(ec, f.id()).bytes()), "scanned clean: now the ticket's readers open it");
        assertThrows(AccessDenied.NotVisible.class, () -> svc.content(other, f.id()));
        assertEquals(1, svc.list(ec, "maintenance.ticket", null).size()); assertEquals(0, svc.list(other, "maintenance.ticket", null).size());
        assertEquals("already-attached", assertThrows(DomainException.RuleViolated.class, () -> svc.attach(owner, f.id(), "maintenance.ticket", theirs)).code());
        assertThrows(AccessDenied.class, () -> svc.delete(other, f.id()), "attached: not by someone who cannot change the ticket");
        assertEquals(1, svc.list(ec, "maintenance.ticket", null).size(), "still there");
        svc.delete(owner, f.id());   // the ticket's owner takes a photo off their own ticket
        assertTrue(mem.bytes.isEmpty(), "and its bytes go");
        mem.failInsert = true;
        assertThrows(IllegalStateException.class, () -> svc.upload(owner, new FileService.Upload("a.pdf", PDF, null)));
        assertTrue(mem.bytes.isEmpty(), "no bytes left behind when the row could not be written");
        FileService scanned = new FileService(mem, mem, (b) -> new VirusScanner.Verdict(VirusScanner.Result.INFECTED, "Win.Test"), new Fixtures.Audit(), Tx.direct(), Fixtures.CLOCK);
        assertEquals("infected", assertThrows(DomainException.RuleViolated.class, () -> scanned.upload(owner, new FileService.Upload("a.pdf", PDF, null))).code());
    }

    @Test void localDisk() throws Exception {
        var dir = Files.createTempDirectory("cos-files");
        LocalDiskStorage disk = new LocalDiskStorage(dir);
        disk.put("communities/c/2026/10/x", PDF);
        assertTrue(java.util.Arrays.equals(PDF, disk.get("communities/c/2026/10/x")));
        assertThrows(IllegalArgumentException.class, () -> disk.get("../../etc/passwd"), "a key never leaves the root");
        assertThrows(IllegalArgumentException.class, () -> disk.put("/etc/x", PDF));
        disk.delete("communities/c/2026/10/x");
        assertThrows(IllegalStateException.class, () -> disk.get("communities/c/2026/10/x"));
    }
}
