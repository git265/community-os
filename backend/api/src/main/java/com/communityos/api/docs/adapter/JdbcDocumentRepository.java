package com.communityos.api.docs.adapter;

import com.communityos.api.docs.application.port.DocumentRepository;
import com.communityos.api.docs.domain.Document;
import com.communityos.api.shared.access.Spec;
import com.communityos.api.shared.jdbc.Rows;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** Documents on the tenant connection, with their file's name, size, type and scan result, and their unit's number. */
public final class JdbcDocumentRepository implements DocumentRepository {
    static final String COLUMNS = """
        SELECT d.id, d.short_id, d.title, d.category, d.edition, d.access, d.unit_id, u.unit_no, d.expiry, d.folder_id, d.file_id, f.file_name, f.size_bytes, f.mime_type,
               f.scan_status, d.uploaded_by_id, m.display_name AS uploaded_by, d.created_at, d.updated_at, d.version
        FROM docs.document d
        LEFT JOIN docs.file_object f ON f.community_id = d.community_id AND f.id = d.file_id
        LEFT JOIN property.unit u ON u.community_id = d.community_id AND u.id = d.unit_id
        LEFT JOIN identity.membership m ON m.community_id = d.community_id AND m.id = d.uploaded_by_id""";
    static final String FILTER = """
          AND (CAST(:folder AS uuid) IS NULL OR d.folder_id = CAST(:folder AS uuid)) AND (CAST(:unit AS uuid) IS NULL OR d.unit_id = CAST(:unit AS uuid))
          AND (CAST(:access AS text) IS NULL OR d.access = :access)""";
    public static String listSql(String scope) { return COLUMNS + "\nWHERE (" + scope + ")" + FILTER + "\nORDER BY d.title LIMIT 2000"; }
    public static String getSql(String scope) { return COLUMNS + "\nWHERE d.id = CAST(:id AS uuid) AND (" + scope + ")"; }
    static final String INSERT = """
        INSERT INTO docs.document (community_id, id, title, category, edition, access, unit_id, expiry, folder_id, file_id, file_name, file_size, scan_status, uploaded_by_id)
        SELECT platform.current_community(), CAST(:id AS uuid), :title, :category, :edition, :access, CAST(:unit AS uuid), CAST(:expiry AS date), CAST(:folder AS uuid),
               f.id, f.file_name, ceil(f.size_bytes / 1024.0), f.scan_status, platform.current_actor()
        FROM docs.file_object f WHERE f.id = CAST(:file AS uuid)
        RETURNING short_id, version, created_at""";
    static final String UPDATE = """
        UPDATE docs.document SET title = :title, category = :category, edition = :edition, access = :access, unit_id = CAST(:unit AS uuid), expiry = CAST(:expiry AS date),
               folder_id = CAST(:folder AS uuid)
        WHERE id = CAST(:id AS uuid) AND version = :version RETURNING version""";
    static final String DELETE = "DELETE FROM docs.document WHERE id = CAST(:id AS uuid) AND version = :version";

    private final NamedParameterJdbcTemplate jdbc;
    public JdbcDocumentRepository(NamedParameterJdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Override public List<Document> list(Spec<Document> scope, Filter f) {
        Map<String, Object> p = new HashMap<>(scope.params());
        p.put("folder", f.folderId() == null ? null : f.folderId().toString()); p.put("unit", f.unitId() == null ? null : f.unitId().toString()); p.put("access", f.access());
        return jdbc.query(listSql(scope.sql()), p, (rs, i) -> row(rs));
    }
    @Override public Optional<Document> get(UUID id, Spec<Document> scope) {
        Map<String, Object> p = new HashMap<>(scope.params()); p.put("id", id.toString());
        return jdbc.query(getSql(scope.sql()), p, (rs, i) -> row(rs)).stream().findFirst();
    }
    @Override public void insert(Document d) {
        if (d.id == null) d.id = UUID.randomUUID();
        Map<String, Object> p = params(d); p.put("file", d.fileId.toString());
        List<Object> out = jdbc.query(INSERT, p, (rs, i) -> { d.shortId = rs.getString("short_id"); d.version = rs.getLong("version"); d.createdAt = Rows.instant(rs, "created_at"); return null; });
        if (out.isEmpty()) throw new IllegalStateException("the document's file is gone");
    }
    @Override public boolean update(Document d) {
        List<Long> v = jdbc.query(UPDATE, params(d), (rs, i) -> rs.getLong("version"));
        if (v.isEmpty()) return false;
        d.version = v.get(0); return true;
    }
    @Override public boolean delete(UUID id, long version) { return jdbc.update(DELETE, Map.of("id", id.toString(), "version", version)) == 1; }

    static Map<String, Object> params(Document d) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", d.id.toString()); p.put("title", d.title); p.put("category", d.category); p.put("edition", d.edition); p.put("access", d.access);
        p.put("unit", d.unitId == null ? null : d.unitId.toString()); p.put("expiry", d.expiry == null ? null : d.expiry.toString()); p.put("folder", d.folderId == null ? null : d.folderId.toString());
        p.put("version", d.version);
        return p;
    }
    static Document row(ResultSet rs) throws SQLException {
        Document d = new Document();
        d.id = Rows.uuid(rs, "id"); d.shortId = rs.getString("short_id"); d.title = rs.getString("title"); d.category = rs.getString("category"); d.edition = rs.getString("edition");
        d.access = rs.getString("access"); d.unitId = Rows.uuid(rs, "unit_id"); d.unitNo = rs.getString("unit_no"); d.expiry = Rows.date(rs, "expiry"); d.folderId = Rows.uuid(rs, "folder_id");
        d.fileId = Rows.uuid(rs, "file_id"); d.fileName = rs.getString("file_name"); long size = rs.getLong("size_bytes"); d.fileSize = rs.wasNull() ? null : size;
        d.mimeType = rs.getString("mime_type"); d.scanStatus = rs.getString("scan_status"); d.uploadedById = Rows.uuid(rs, "uploaded_by_id"); d.uploadedBy = rs.getString("uploaded_by");
        d.createdAt = Rows.instant(rs, "created_at"); d.updatedAt = Rows.instant(rs, "updated_at"); d.version = rs.getLong("version");
        return d;
    }
}
