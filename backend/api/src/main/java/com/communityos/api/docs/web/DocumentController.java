package com.communityos.api.docs.web;

import com.communityos.api.docs.application.DocumentService;
import com.communityos.api.docs.application.FileService;
import com.communityos.api.docs.application.port.DocumentRepository;
import com.communityos.api.docs.domain.Document;
import com.communityos.api.docs.domain.StoredFile;
import com.communityos.api.shared.tenancy.CallerHolder;
import com.communityos.api.shared.web.ETags;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Files and the document repository. An upload is the file's bytes as the request body (its name in ?name=); the server decides its type from
 * the bytes. A file is then attached to one thing; reading it follows that thing's rules.
 */
@RestController
@Tag(name = "Documents and files")
public class DocumentController {
    public record AttachRequest(@NotNull @Pattern(regexp = "maintenance\\.ticket|maintenance\\.comment|maintenance\\.quotation|amenity\\.booking|docs\\.document|cultural\\.photo|cultural\\.brochure") String ownerType,
                                @NotNull UUID ownerId) {}
    /** A document as a manager files it; its file was uploaded first. */
    public record DocumentRequest(@NotNull UUID fileId, @NotBlank @Size(max = 200) String title, @Size(max = 60) String category, @Size(max = 40) String edition,
                                  @NotBlank @Size(max = 60) String access, UUID unitId, LocalDate expiry, UUID folderId) {}
    public record DocumentChange(@NotBlank @Size(max = 200) String title, @Size(max = 60) String category, @Size(max = 40) String edition, @NotBlank @Size(max = 60) String access,
                                 UUID unitId, LocalDate expiry, UUID folderId) {}

    public record FileResponse(UUID id, String shortId, String fileName, String mimeType, long sizeBytes, String sha256, String ownerType, UUID ownerId, String scanStatus,
                               String visibility, UUID uploadedById, String uploadedBy, Instant createdAt, long version) {
        static FileResponse of(StoredFile f) {
            return new FileResponse(f.id(), f.shortId(), f.fileName(), f.mimeType(), f.sizeBytes(), f.sha256(), f.ownerType(), f.ownerId(), f.scanStatus(), f.visibility(), f.uploadedById(),
                f.uploadedBy(), f.createdAt(), f.version());
        }
    }
    public record DocumentResponse(UUID id, String shortId, String title, String category, String edition, String access, UUID unitId, String unitNo, LocalDate expiry, UUID folderId,
                                   UUID fileId, String fileName, Long fileSize, String mimeType, String scanStatus, String uploadedBy, Instant createdAt, Instant updatedAt, long version) {
        static DocumentResponse of(Document d) {
            return new DocumentResponse(d.id, d.shortId, d.title, d.category, d.edition, d.access, d.unitId, d.unitNo, d.expiry, d.folderId, d.fileId, d.fileName, d.fileSize, d.mimeType,
                d.scanStatus, d.uploadedBy, d.createdAt, d.updatedAt, d.version);
        }
    }

    private final FileService files; private final DocumentService documents;
    public DocumentController(FileService files, DocumentService documents) { this.files = files; this.documents = documents; }

    // ---- files -------------------------------------------------------------------------------------------------------------------------------------
    @PostMapping("/api/v1/files")
    public ResponseEntity<FileResponse> upload(@RequestParam @Size(max = 255) String name, @RequestParam(required = false) @Pattern(regexp = "Owner|Community|Staff|Committee") String visibility,
                                               @RequestBody byte[] body) {
        return ResponseEntity.status(201).body(FileResponse.of(files.upload(CallerHolder.require(), new FileService.Upload(name, body, visibility))));
    }
    @GetMapping("/api/v1/files")
    public List<FileResponse> list(@RequestParam String ownerType, @RequestParam(required = false) UUID ownerId) {
        return files.list(CallerHolder.require(), ownerType, ownerId).stream().map(FileResponse::of).toList();
    }
    @GetMapping("/api/v1/files/{id}")
    public FileResponse file(@PathVariable UUID id) { return FileResponse.of(files.get(CallerHolder.require(), id)); }
    /** The bytes, as a download: the stored type, never sniffed, never run in the page. */
    @GetMapping("/api/v1/files/{id}/content")
    public ResponseEntity<byte[]> content(@PathVariable UUID id) {
        FileService.Content c = files.content(CallerHolder.require(), id);
        String ascii = c.file().fileName().replaceAll("[^A-Za-z0-9._ -]", "_");
        return ResponseEntity.ok().contentType(MediaType.parseMediaType(c.file().mimeType())).header("X-Content-Type-Options", "nosniff")
            .header("Content-Security-Policy", "default-src 'none'; sandbox").header("Cache-Control", "private, max-age=300")
            .header("Content-Disposition", "attachment; filename=\"" + ascii + "\"; filename*=UTF-8''" + java.net.URLEncoder.encode(c.file().fileName(), java.nio.charset.StandardCharsets.UTF_8).replace("+", "%20"))
            .body(c.bytes());
    }
    @PostMapping("/api/v1/files/{id}/attach")
    public FileResponse attach(@PathVariable UUID id, @Valid @RequestBody AttachRequest b) { return FileResponse.of(files.attach(CallerHolder.require(), id, b.ownerType(), b.ownerId())); }
    @DeleteMapping("/api/v1/files/{id}")
    public ResponseEntity<Void> delete(@PathVariable UUID id) { files.delete(CallerHolder.require(), id); return ResponseEntity.noContent().build(); }

    // ---- documents ---------------------------------------------------------------------------------------------------------------------------------
    @GetMapping("/api/v1/documents")
    public List<DocumentResponse> documents(@RequestParam(required = false) UUID folderId, @RequestParam(required = false) UUID unitId, @RequestParam(required = false) String access) {
        return documents.list(CallerHolder.require(), new DocumentRepository.Filter(folderId, unitId, access)).stream().map(DocumentResponse::of).toList();
    }
    @GetMapping("/api/v1/documents/{id}")
    public ResponseEntity<DocumentResponse> document(@PathVariable UUID id) { return tagged(documents.get(CallerHolder.require(), id)); }
    @PostMapping("/api/v1/documents")
    public ResponseEntity<DocumentResponse> file(@Valid @RequestBody DocumentRequest b) {
        Document d = documents.file(CallerHolder.require(), b.fileId(), new DocumentService.Fields(b.title(), b.category(), b.edition(), b.access(), b.unitId(), b.expiry(), b.folderId()));
        return ResponseEntity.status(201).header("ETag", ETags.of(d.version)).body(DocumentResponse.of(d));
    }
    @PutMapping("/api/v1/documents/{id}")
    public ResponseEntity<DocumentResponse> change(@PathVariable UUID id, @Valid @RequestBody DocumentChange b, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        return tagged(documents.change(CallerHolder.require(), id, ETags.require(ifMatch), new DocumentService.Fields(b.title(), b.category(), b.edition(), b.access(), b.unitId(), b.expiry(), b.folderId())));
    }
    @DeleteMapping("/api/v1/documents/{id}")
    public ResponseEntity<Void> remove(@PathVariable UUID id, @RequestHeader(name = "If-Match", required = false) String ifMatch) {
        documents.remove(CallerHolder.require(), id, ETags.require(ifMatch));
        return ResponseEntity.noContent().build();
    }
    private static ResponseEntity<DocumentResponse> tagged(Document d) { return ResponseEntity.ok().header("ETag", ETags.of(d.version)).body(DocumentResponse.of(d)); }
}
