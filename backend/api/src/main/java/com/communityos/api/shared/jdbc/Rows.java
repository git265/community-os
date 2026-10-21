package com.communityos.api.shared.jdbc;

import com.communityos.api.shared.domain.Money;
import java.sql.Array;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;

/** Small, null-safe ResultSet readers shared by the JDBC adapters. */
public final class Rows {
    private Rows() {}
    public static UUID uuid(ResultSet rs, String c) throws SQLException { return rs.getObject(c, UUID.class); }
    public static Money money(ResultSet rs, String c) throws SQLException { java.math.BigDecimal b = rs.getBigDecimal(c); return b == null ? null : new Money(b); }
    public static Instant instant(ResultSet rs, String c) throws SQLException { Timestamp t = rs.getTimestamp(c); return t == null ? null : t.toInstant(); }
    public static LocalDate date(ResultSet rs, String c) throws SQLException { java.sql.Date d = rs.getDate(c); return d == null ? null : d.toLocalDate(); }
    public static <T> Set<T> set(ResultSet rs, String c, Function<Object, T> f) throws SQLException {
        Array a = rs.getArray(c);
        if (a == null) return Set.of();
        return Arrays.stream((Object[]) a.getArray()).filter(java.util.Objects::nonNull).map(f).collect(Collectors.toUnmodifiableSet());
    }
    public static <T> List<T> list(ResultSet rs, String c, Function<Object, T> f) throws SQLException {
        Array a = rs.getArray(c);
        if (a == null) return List.of();
        return Arrays.stream((Object[]) a.getArray()).filter(java.util.Objects::nonNull).map(f).toList();
    }
    public static java.sql.Timestamp ts(Instant i) { return i == null ? null : Timestamp.from(i); }
    public static java.sql.Date sqlDate(LocalDate d) { return d == null ? null : java.sql.Date.valueOf(d); }
    /** Escape a user's search text for LIKE ... ESCAPE '\'. */
    public static String like(String q) { return "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"; }
}
