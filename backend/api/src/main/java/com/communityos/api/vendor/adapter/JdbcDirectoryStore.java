package com.communityos.api.vendor.adapter;

import com.communityos.api.shared.jdbc.Rows;
import com.communityos.api.vendor.application.port.DirectoryStore;
import com.communityos.api.vendor.domain.Directory;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** The service directory on the tenant connection. */
public final class JdbcDirectoryStore implements DirectoryStore {
    static final String CONTACT_COLUMNS = """
        SELECT c.id, c.short_id, c.name, c.category, c.phone, c.area, c.rate, c.notes, c.status, c.hidden_reason, c.hidden_by_id, c.registry_id, c.added_by_id,
               m.display_name AS added_by, c.added_by_unit_id, u.unit_no AS added_by_unit, c.created_at, c.version,
               (SELECT round(avg(r.rating), 1) FROM vendor.contact_review r WHERE r.community_id = c.community_id AND r.contact_id = c.id) AS rating,
               (SELECT count(*) FROM vendor.contact_review r WHERE r.community_id = c.community_id AND r.contact_id = c.id) AS reviews,
               (SELECT count(*) FROM vendor.contact_review r WHERE r.community_id = c.community_id AND r.contact_id = c.id AND r.recommend = 'Yes') AS recommends,
               (SELECT r.id FROM vendor.contact_review r WHERE r.community_id = c.community_id AND r.contact_id = c.id AND r.author_id = CAST(:me AS uuid)) AS my_review_id
        FROM vendor.service_contact c
        LEFT JOIN identity.membership m ON m.community_id = c.community_id AND m.id = c.added_by_id
        LEFT JOIN property.unit u ON u.community_id = c.community_id AND u.id = c.added_by_unit_id""";
    static final String CONTACTS = CONTACT_COLUMNS + "\nWHERE (:hidden OR c.status = 'Active' OR c.added_by_id = CAST(:me AS uuid)) ORDER BY c.category NULLS LAST, lower(c.name) LIMIT 2000";
    static final String CONTACT = CONTACT_COLUMNS + "\nWHERE c.id = CAST(:id AS uuid)";
    static final String CONTACT_LOCK = CONTACT + " FOR UPDATE OF c";
    static final String CONTACT_INSERT = """
        INSERT INTO vendor.service_contact (community_id, id, name, category, phone, area, rate, notes, status, registry_id, added_by_id, added_by_unit_id)
        VALUES (platform.current_community(), CAST(:id AS uuid), :name, :category, :phone, :area, :rate, :notes, 'Active', CAST(:registry AS uuid), CAST(:addedBy AS uuid), CAST(:unit AS uuid))
        RETURNING short_id, version, created_at""";
    static final String CONTACT_UPDATE = """
        UPDATE vendor.service_contact SET name = :name, category = :category, phone = :phone, area = :area, rate = :rate, notes = :notes, status = :status,
               hidden_reason = :reason, hidden_by_id = CAST(:hiddenBy AS uuid), registry_id = CAST(:registry AS uuid)
        WHERE id = CAST(:id AS uuid) AND version = :version RETURNING version""";
    static final String CONTACT_DELETE = "DELETE FROM vendor.service_contact WHERE id = CAST(:id AS uuid) AND version = :version";

    static final String REVIEW_COLUMNS = """
        SELECT r.id, r.short_id, r.contact_id, r.rating, r.comment, r.recommend, r.author_id, m.display_name AS author, r.unit_id, u.unit_no, r.created_at, r.version
        FROM vendor.contact_review r
        LEFT JOIN identity.membership m ON m.community_id = r.community_id AND m.id = r.author_id
        LEFT JOIN property.unit u ON u.community_id = r.community_id AND u.id = r.unit_id""";
    static final String REVIEWS = REVIEW_COLUMNS + "\nWHERE r.contact_id = CAST(:contact AS uuid) ORDER BY r.created_at DESC";
    static final String REVIEW = REVIEW_COLUMNS + "\nWHERE r.id = CAST(:id AS uuid)";
    static final String REVIEW_BY = REVIEW_COLUMNS + "\nWHERE r.contact_id = CAST(:contact AS uuid) AND r.author_id = CAST(:author AS uuid)";
    static final String REVIEW_OF_UNIT = REVIEW_COLUMNS + "\nWHERE r.contact_id = CAST(:contact AS uuid) AND r.unit_id = CAST(:unit AS uuid)";
    static final String REVIEW_INSERT = """
        INSERT INTO vendor.contact_review (community_id, id, contact_id, rating, comment, recommend, author_id, unit_id)
        VALUES (platform.current_community(), CAST(:id AS uuid), CAST(:contact AS uuid), :rating, :comment, :recommend, CAST(:author AS uuid), CAST(:unit AS uuid))
        RETURNING short_id, version, created_at""";
    static final String REVIEW_UPDATE = "UPDATE vendor.contact_review SET rating = :rating, comment = :comment, recommend = :recommend WHERE id = CAST(:id AS uuid) AND version = :version RETURNING version";
    static final String REVIEW_DELETE = "DELETE FROM vendor.contact_review WHERE id = CAST(:id AS uuid)";
    static final String UNIT_NO = "SELECT u.unit_no FROM property.unit u WHERE u.id = CAST(:id AS uuid)";

    private final NamedParameterJdbcTemplate jdbc;
    public JdbcDirectoryStore(NamedParameterJdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Override public List<Directory.Contact> contacts(boolean withHidden, UUID me) {
        Map<String, Object> p = new HashMap<>(); p.put("hidden", withHidden); p.put("me", s(me));
        return jdbc.query(CONTACTS, p, (rs, i) -> contact(rs));
    }
    @Override public Optional<Directory.Contact> contact(UUID id, UUID me, boolean lock) {
        Map<String, Object> p = new HashMap<>(); p.put("id", id.toString()); p.put("me", s(me));
        return jdbc.query(lock ? CONTACT_LOCK : CONTACT, p, (rs, i) -> contact(rs)).stream().findFirst();
    }
    @Override public void insert(Directory.Contact c) {
        if (c.id == null) c.id = UUID.randomUUID();
        Map<String, Object> p = params(c); p.put("addedBy", s(c.addedById)); p.put("unit", s(c.addedByUnitId));
        jdbc.query(CONTACT_INSERT, p, (rs, i) -> { c.shortId = rs.getString("short_id"); c.version = rs.getLong("version"); c.createdAt = Rows.instant(rs, "created_at"); return null; });
    }
    @Override public boolean update(Directory.Contact c) {
        Map<String, Object> p = params(c); p.put("status", c.status); p.put("reason", c.hiddenReason); p.put("hiddenBy", s(c.hiddenById)); p.put("version", c.version);
        List<Long> v = jdbc.query(CONTACT_UPDATE, p, (rs, i) -> rs.getLong("version"));
        if (v.isEmpty()) return false;
        c.version = v.get(0); return true;
    }
    @Override public boolean deleteContact(UUID id, long version) { return jdbc.update(CONTACT_DELETE, Map.of("id", id.toString(), "version", version)) == 1; }
    static Map<String, Object> params(Directory.Contact c) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", c.id.toString()); p.put("name", c.name); p.put("category", c.category); p.put("phone", c.phone); p.put("area", c.area); p.put("rate", c.rate); p.put("notes", c.notes);
        p.put("registry", s(c.registryId));
        return p;
    }
    static Directory.Contact contact(ResultSet rs) throws SQLException {
        Directory.Contact c = new Directory.Contact();
        c.id = Rows.uuid(rs, "id"); c.shortId = rs.getString("short_id"); c.name = rs.getString("name"); c.category = rs.getString("category"); c.phone = rs.getString("phone");
        c.area = rs.getString("area"); c.rate = rs.getString("rate"); c.notes = rs.getString("notes"); c.status = rs.getString("status"); c.hiddenReason = rs.getString("hidden_reason");
        c.hiddenById = Rows.uuid(rs, "hidden_by_id"); c.registryId = Rows.uuid(rs, "registry_id"); c.addedById = Rows.uuid(rs, "added_by_id"); c.addedBy = rs.getString("added_by");
        c.addedByUnitId = Rows.uuid(rs, "added_by_unit_id"); c.addedByUnit = rs.getString("added_by_unit"); c.createdAt = Rows.instant(rs, "created_at"); c.version = rs.getLong("version");
        c.rating = rs.getBigDecimal("rating"); c.reviews = rs.getInt("reviews"); c.recommends = rs.getInt("recommends"); c.myReviewId = Rows.uuid(rs, "my_review_id");
        return c;
    }

    @Override public List<Directory.Review> reviews(UUID contactId) { return jdbc.query(REVIEWS, Map.of("contact", contactId.toString()), (rs, i) -> review(rs)); }
    @Override public Optional<Directory.Review> review(UUID id) { return jdbc.query(REVIEW, Map.of("id", id.toString()), (rs, i) -> review(rs)).stream().findFirst(); }
    @Override public Optional<Directory.Review> reviewBy(UUID contactId, UUID authorId) {
        return jdbc.query(REVIEW_BY, Map.of("contact", contactId.toString(), "author", authorId.toString()), (rs, i) -> review(rs)).stream().findFirst();
    }
    @Override public Optional<Directory.Review> reviewOfUnit(UUID contactId, UUID unitId) {
        return jdbc.query(REVIEW_OF_UNIT, Map.of("contact", contactId.toString(), "unit", unitId.toString()), (rs, i) -> review(rs)).stream().findFirst();
    }
    @Override public void insert(Directory.Review r) {
        if (r.id == null) r.id = UUID.randomUUID();
        Map<String, Object> p = new HashMap<>();
        p.put("id", r.id.toString()); p.put("contact", r.contactId.toString()); p.put("rating", r.rating); p.put("comment", r.comment); p.put("recommend", r.recommend);
        p.put("author", r.authorId.toString()); p.put("unit", s(r.unitId));
        jdbc.query(REVIEW_INSERT, p, (rs, i) -> { r.shortId = rs.getString("short_id"); r.version = rs.getLong("version"); r.createdAt = Rows.instant(rs, "created_at"); return null; });
    }
    @Override public boolean update(Directory.Review r) {
        Map<String, Object> p = new HashMap<>();
        p.put("id", r.id.toString()); p.put("rating", r.rating); p.put("comment", r.comment); p.put("recommend", r.recommend); p.put("version", r.version);
        List<Long> v = jdbc.query(REVIEW_UPDATE, p, (rs, i) -> rs.getLong("version"));
        if (v.isEmpty()) return false;
        r.version = v.get(0); return true;
    }
    @Override public boolean deleteReview(UUID id) { return jdbc.update(REVIEW_DELETE, Map.of("id", id.toString())) == 1; }
    @Override public String unitNo(UUID unitId) { return jdbc.query(UNIT_NO, Map.of("id", unitId.toString()), (rs, i) -> rs.getString("unit_no")).stream().findFirst().orElse("Your unit"); }
    static Directory.Review review(ResultSet rs) throws SQLException {
        Directory.Review r = new Directory.Review();
        r.id = Rows.uuid(rs, "id"); r.shortId = rs.getString("short_id"); r.contactId = Rows.uuid(rs, "contact_id"); r.rating = rs.getInt("rating"); r.comment = rs.getString("comment");
        r.recommend = rs.getString("recommend"); r.authorId = Rows.uuid(rs, "author_id"); r.author = rs.getString("author"); r.unitId = Rows.uuid(rs, "unit_id"); r.unitNo = rs.getString("unit_no");
        r.createdAt = Rows.instant(rs, "created_at"); r.version = rs.getLong("version");
        return r;
    }
    static String s(Object o) { return o == null ? null : o.toString(); }
}
