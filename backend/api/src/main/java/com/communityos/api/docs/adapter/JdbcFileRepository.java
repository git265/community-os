package com.communityos.api.docs.adapter;

import com.communityos.api.docs.application.port.FileRepository;
import com.communityos.api.docs.domain.StoredFile;
import com.communityos.api.shared.jdbc.Rows;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.HexFormat;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** File metadata on the tenant connection. The uploader is the current actor; the storage key is written once and only ever read here. */
public final class JdbcFileRepository implements FileRepository {
    static final String COLUMNS = """
        SELECT f.id, f.short_id, f.file_name, f.mime_type, f.size_bytes, encode(f.sha256, 'hex') AS sha256, f.owner_type, f.owner_id, f.scan_status, f.visibility,
               f.uploaded_by_id, m.display_name AS uploaded_by, f.storage_key, f.created_at, f.version
        FROM docs.file_object f LEFT JOIN identity.membership m ON m.community_id = f.community_id AND m.id = f.uploaded_by_id""";
    static final String INSERT = """
        INSERT INTO docs.file_object (community_id, id, owner_type, file_name, mime_type, size_bytes, sha256, storage_key, scan_status, visibility, uploaded_by_id)
        VALUES (platform.current_community(), CAST(:id AS uuid), 'upload', :name, :mime, :size, decode(:sha, 'hex'), :key, :scan, :visibility, platform.current_actor())""";
    static final String GET = COLUMNS + "\nWHERE f.id = CAST(:id AS uuid)";
    static final String BY_OWNER = COLUMNS + "\nWHERE f.owner_type = :type AND (CAST(:owner AS uuid) IS NULL OR f.owner_id = CAST(:owner AS uuid))\nORDER BY f.created_at DESC LIMIT 2000";
    static final String ATTACH = """
        UPDATE docs.file_object SET owner_type = :type, owner_id = CAST(:owner AS uuid), attached_at = now()
        WHERE id = CAST(:id AS uuid) AND version = :version AND owner_type = 'upload'""";
    static final String UNSCANNED = COLUMNS + "\nWHERE f.scan_status IN ('Pending', 'Error') ORDER BY f.created_at LIMIT :limit";
    static final String SCANNED = "UPDATE docs.file_object SET scan_status = :status WHERE id = CAST(:id AS uuid) AND scan_status IN ('Pending', 'Error')";
    static final String DELETE = "DELETE FROM docs.file_object WHERE id = CAST(:id AS uuid) AND version = :version";
    static final String COMMENT = "SELECT c.ticket_id, c.visibility, c.author_id FROM maintenance.ticket_comment c WHERE c.id = CAST(:id AS uuid)";

    private final NamedParameterJdbcTemplate jdbc;
    public JdbcFileRepository(NamedParameterJdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Override public StoredFile insert(NewFile f) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", f.id().toString()); p.put("name", f.fileName()); p.put("mime", f.mimeType()); p.put("size", f.sizeBytes()); p.put("sha", HexFormat.of().formatHex(f.sha256()));
        p.put("key", f.storageKey()); p.put("scan", f.scanStatus()); p.put("visibility", f.visibility());
        jdbc.update(INSERT, p);
        return get(f.id()).orElseThrow();
    }
    @Override public Optional<StoredFile> get(UUID id) { return jdbc.query(GET, Map.of("id", id.toString()), (rs, i) -> row(rs)).stream().findFirst(); }
    @Override public List<StoredFile> byOwner(String ownerType, UUID ownerId) {
        Map<String, Object> p = new HashMap<>(); p.put("type", ownerType); p.put("owner", ownerId == null ? null : ownerId.toString());
        return jdbc.query(BY_OWNER, p, (rs, i) -> row(rs));
    }
    @Override public boolean attach(UUID id, long version, String ownerType, UUID ownerId) {
        return jdbc.update(ATTACH, Map.of("id", id.toString(), "version", version, "type", ownerType, "owner", ownerId.toString())) == 1;
    }
    @Override public boolean delete(UUID id, long version) { return jdbc.update(DELETE, Map.of("id", id.toString(), "version", version)) == 1; }
    @Override public List<StoredFile> unscanned(int limit) { return jdbc.query(UNSCANNED, Map.of("limit", limit), (rs, i) -> row(rs)); }
    @Override public void scanned(UUID id, String status) { jdbc.update(SCANNED, Map.of("id", id.toString(), "status", status)); }
    @Override public Optional<CommentFacts> comment(UUID commentId) {
        return jdbc.query(COMMENT, Map.of("id", commentId.toString()), (rs, i) -> new CommentFacts(Rows.uuid(rs, "ticket_id"), rs.getString("visibility"), Rows.uuid(rs, "author_id"))).stream().findFirst();
    }
    static StoredFile row(ResultSet rs) throws SQLException {
        return new StoredFile(Rows.uuid(rs, "id"), rs.getString("short_id"), rs.getString("file_name"), rs.getString("mime_type"), rs.getLong("size_bytes"), rs.getString("sha256"),
            rs.getString("owner_type"), Rows.uuid(rs, "owner_id"), rs.getString("scan_status"), rs.getString("visibility"), Rows.uuid(rs, "uploaded_by_id"), rs.getString("uploaded_by"),
            rs.getString("storage_key"), Rows.instant(rs, "created_at"), rs.getLong("version"));
    }
}
