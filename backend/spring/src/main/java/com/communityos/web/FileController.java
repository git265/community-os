package com.communityos.web;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import com.communityos.domain.StoredFile;
import com.communityos.port.FileStorage;
import com.communityos.service.SecureRecordService;
import com.communityos.service.TenantGuard;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/**
 * File bytes: PUT/GET/DELETE /api/files/{id}/content. The metadata row is an ordinary `files` record, so WHO may open a file is decided by
 * the same rules as every other record: the bytes are served only if the caller can see the row.
 */
@Tag(name = "Files")
@RestController
public class FileController {
    private final FileStorage files;
    private final TenantGuard guard;
    private final SecureRecordService records;

    public FileController(FileStorage files, TenantGuard guard, SecureRecordService records) { this.files = files; this.guard = guard; this.records = records; }

    @Operation(summary = "Upload file bytes", description = "New bytes go to a new file id only; a saved file's bytes are replaced only by document managers. The type must be on the allow-list and match the content.")
    @PutMapping("/api/files/{id}/content")
    public ResponseEntity<Void> put(@PathVariable String id, @RequestBody byte[] bytes, @RequestHeader("X-Community-Id") String c,
                                    @RequestHeader(value = "Content-Type", required = false) String mime, Authentication who) {
        String t = guard.resolve(c, who);
        boolean known;
        try { records.get(t, who, "files", Names.id(id)); known = true; } catch (NotFoundException e) { known = false; }
        boolean manager = records.mayManageFiles(t, who);
        if (known && !manager) throw new AccessDeniedException("Uploaded files cannot be replaced.");
        if (!known && files.get(t, Names.id(id)).isPresent() && !manager) throw new AccessDeniedException("Uploaded files cannot be replaced.");
        if (!known && !records.canWrite(t, who, "files")) throw new AccessDeniedException("You cannot add files here.");
        FileBytes.Check chk = FileBytes.check(bytes, mime);
        if (chk.error() != null) throw new BadRequestException(chk.error());
        files.put(t, Names.id(id), bytes, chk.type());
        return ResponseEntity.noContent().build();
    }

    @Operation(summary = "Download file bytes", description = "Only if you can see the file's record.")
    @GetMapping("/api/files/{id}/content")
    public ResponseEntity<byte[]> get(@PathVariable String id, @RequestHeader("X-Community-Id") String c, Authentication who) {
        String t = guard.resolve(c, who);
        records.get(t, who, "files", Names.id(id));   // 404 when the record is missing or hidden from this caller
        StoredFile f = files.get(t, Names.id(id)).orElseThrow(() -> new NotFoundException("No such file."));
        FileBytes.Served h = FileBytes.served(f.mime());   // only allow-listed types are named; anything else is a download, never rendered
        return ResponseEntity.ok().contentType(MediaType.parseMediaType(h.type())).header("Content-Disposition", h.disposition())
                .header("Content-Security-Policy", "default-src 'none'; sandbox").header("X-Content-Type-Options", "nosniff").body(f.bytes());
    }

    @Operation(summary = "Delete a file", description = "Removes the record (if the rules allow) and then the bytes.")
    @DeleteMapping("/api/files/{id}/content")
    public ResponseEntity<Void> delete(@PathVariable String id, @RequestHeader("X-Community-Id") String c, Authentication who) {
        String t = guard.resolve(c, who);
        records.get(t, who, "files", Names.id(id));
        records.delete(t, who, "files", id);
        files.delete(t, Names.id(id));
        return ResponseEntity.noContent().build();
    }
}
