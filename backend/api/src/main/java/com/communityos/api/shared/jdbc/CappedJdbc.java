package com.communityos.api.shared.jdbc;

import com.communityos.api.shared.web.Truncation;
import java.util.List;
import java.util.Map;
import javax.sql.DataSource;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

/** The tenant JdbcTemplate: as Spring's, and a list that reaches its statement's own `LIMIT n` is noted for the response (Truncation). */
public class CappedJdbc extends NamedParameterJdbcTemplate {
    public CappedJdbc(DataSource ds) { super(ds); }
    @Override public <T> List<T> query(String sql, Map<String, ?> params, RowMapper<T> mapper) {
        List<T> rows = super.query(sql, params, mapper);
        Truncation.check(sql, rows.size());
        return rows;
    }
}
