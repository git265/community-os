package com.communityos.api.assets.adapter;

import com.communityos.api.assets.application.port.AssetStore;
import com.communityos.api.shared.jdbc.Rows;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** Stock movements and the condition log on the tenant connection. */
public final class JdbcAssetStore implements AssetStore {
    static final String STOCK = "SELECT i.id, i.short_id, i.item, i.uom, i.quantity, i.min_stock, i.last_restocked, i.version FROM assets.inventory_item i WHERE i.id = CAST(:id AS uuid)";
    static final String STOCK_LOCK = STOCK + " FOR UPDATE OF i";
    static final String MOVE = """
        INSERT INTO assets.inventory_movement (community_id, id, item_id, kind, quantity, balance, on_date, ticket_id, vendor, note)
        VALUES (platform.current_community(), CAST(:id AS uuid), CAST(:item AS uuid), :kind, :quantity, :balance, CAST(:on AS date), CAST(:ticket AS uuid), :vendor, :note)
        RETURNING short_id, created_by, created_at""";
    static final String SET_QUANTITY = """
        UPDATE assets.inventory_item SET quantity = :balance,
               last_restocked = CASE WHEN :kind = 'Received' THEN greatest(coalesce(last_restocked, CAST(:on AS date)), CAST(:on AS date)) ELSE last_restocked END,
               vendor = CASE WHEN :kind = 'Received' AND CAST(:vendor AS text) IS NOT NULL THEN CAST(:vendor AS text) ELSE vendor END
        WHERE id = CAST(:item AS uuid) AND version = :version RETURNING version""";
    static final String MOVEMENTS = """
        SELECT m.id, m.short_id, m.item_id, m.kind, m.quantity, m.balance, m.on_date, m.ticket_id, m.vendor, m.note, m.created_by, b.display_name AS by_name, m.created_at
        FROM assets.inventory_movement m LEFT JOIN identity.membership b ON b.community_id = m.community_id AND b.id = m.created_by
        WHERE m.item_id = CAST(:item AS uuid) ORDER BY m.created_at DESC LIMIT 500""";
    static final String ASSET = "SELECT e.id, e.name, e.status, e.last_inspected FROM assets.equipment e WHERE e.id = CAST(:id AS uuid)";
    static final String ASSET_LOCK = ASSET + " FOR UPDATE OF e";
    static final String CONDITION_INSERT = """
        INSERT INTO assets.condition_log (community_id, id, asset_id, asset_name, date, condition, source, note, ticket_id, by_id)
        VALUES (platform.current_community(), CAST(:id AS uuid), CAST(:asset AS uuid), :name, CAST(:date AS date), :condition, :source, :note, CAST(:ticket AS uuid), platform.current_actor())
        RETURNING short_id, by_id, created_at""";
    static final String ASSET_CONDITION = "UPDATE assets.equipment SET status = :condition, last_inspected = CAST(:date AS date) WHERE id = CAST(:asset AS uuid)";
    static final String TICKET = "SELECT EXISTS (SELECT 1 FROM maintenance.ticket t WHERE t.id = CAST(:id AS uuid)) AS ok";
    static final String SERVICED = """
        UPDATE assets.equipment SET last_service = CAST(:day AS date),
               next_service = CASE WHEN CAST(:next AS date) IS NOT NULL THEN CAST(:next AS date) WHEN next_service < CAST(:day AS date) THEN NULL ELSE next_service END
        WHERE id = CAST(:asset AS uuid) AND (last_service IS NULL OR last_service <= CAST(:day AS date))""";

    private final NamedParameterJdbcTemplate jdbc;
    public JdbcAssetStore(NamedParameterJdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Override public Optional<Stock> stock(UUID itemId, boolean lock) {
        return jdbc.query(lock ? STOCK_LOCK : STOCK, Map.of("id", itemId.toString()), (rs, i) -> new Stock(Rows.uuid(rs, "id"), rs.getString("short_id"), rs.getString("item"), rs.getString("uom"),
            rs.getBigDecimal("quantity"), rs.getBigDecimal("min_stock"), Rows.date(rs, "last_restocked"), rs.getLong("version"))).stream().findFirst();
    }
    @Override public Movement move(Stock item, String kind, BigDecimal quantity, BigDecimal balance, LocalDate on, UUID ticketId, String vendor, String note) {
        UUID id = UUID.randomUUID();
        Map<String, Object> p = new HashMap<>();
        p.put("id", id.toString()); p.put("item", item.id().toString()); p.put("kind", kind); p.put("quantity", quantity); p.put("balance", balance); p.put("on", on.toString());
        p.put("ticket", s(ticketId)); p.put("vendor", vendor); p.put("note", note); p.put("version", item.version());
        Movement m = jdbc.query(MOVE, p, (rs, i) -> new Movement(id, rs.getString("short_id"), item.id(), kind, quantity, balance, on, ticketId, vendor, note, Rows.uuid(rs, "created_by"), null,
            Rows.instant(rs, "created_at"))).get(0);
        if (jdbc.query(SET_QUANTITY, p, (rs, i) -> rs.getLong("version")).isEmpty()) throw new com.communityos.api.shared.domain.DomainException.Conflict(item.item());
        return m;
    }
    @Override public List<Movement> movements(UUID itemId) {
        return jdbc.query(MOVEMENTS, Map.of("item", itemId.toString()), (rs, i) -> new Movement(Rows.uuid(rs, "id"), rs.getString("short_id"), Rows.uuid(rs, "item_id"), rs.getString("kind"),
            rs.getBigDecimal("quantity"), rs.getBigDecimal("balance"), Rows.date(rs, "on_date"), Rows.uuid(rs, "ticket_id"), rs.getString("vendor"), rs.getString("note"),
            Rows.uuid(rs, "created_by"), rs.getString("by_name"), Rows.instant(rs, "created_at")));
    }
    @Override public Optional<Asset> asset(UUID id, boolean lock) {
        return jdbc.query(lock ? ASSET_LOCK : ASSET, Map.of("id", id.toString()), (rs, i) -> new Asset(Rows.uuid(rs, "id"), rs.getString("name"), rs.getString("status"), Rows.date(rs, "last_inspected")))
            .stream().findFirst();
    }
    @Override public ConditionEntry recordCondition(Asset a, LocalDate date, String condition, String source, String note, UUID ticketId, boolean latest) {
        UUID id = UUID.randomUUID();
        Map<String, Object> p = new HashMap<>();
        p.put("id", id.toString()); p.put("asset", a.id().toString()); p.put("name", a.name()); p.put("date", date.toString()); p.put("condition", condition); p.put("source", source);
        p.put("note", note); p.put("ticket", s(ticketId));
        ConditionEntry e = jdbc.query(CONDITION_INSERT, p, (rs, i) -> new ConditionEntry(id, rs.getString("short_id"), a.id(), a.name(), date, condition, source, note, ticketId,
            Rows.uuid(rs, "by_id"), Rows.instant(rs, "created_at"))).get(0);
        if (latest) jdbc.update(ASSET_CONDITION, p);
        return e;
    }
    @Override public void serviced(UUID assetId, LocalDate day, LocalDate next) {
        Map<String, Object> p = new HashMap<>(); p.put("asset", assetId.toString()); p.put("day", day.toString()); p.put("next", next == null ? null : next.toString());
        jdbc.update(SERVICED, p);
    }
    @Override public boolean ticketExists(UUID ticketId) { return Boolean.TRUE.equals(jdbc.query(TICKET, Map.of("id", ticketId.toString()), (rs, i) -> rs.getBoolean("ok")).get(0)); }
    static String s(Object o) { return o == null ? null : o.toString(); }
}
