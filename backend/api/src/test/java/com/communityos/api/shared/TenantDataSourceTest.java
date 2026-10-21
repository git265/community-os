package com.communityos.api.shared;

import static org.junit.jupiter.api.Assertions.*;

import com.communityos.api.Fixtures;
import com.communityos.api.shared.security.Caller;
import com.communityos.api.shared.tenancy.CallerHolder;
import com.communityos.api.shared.tenancy.TenantDataSource;
import java.io.PrintWriter;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.util.ArrayList;
import java.util.List;
import java.util.logging.Logger;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;

/** The tenant identity on pooled connections: per statement outside a request binding, once per request inside one. */
class TenantDataSourceTest {
    /** A pool of fake connections that records what reaches the database. */
    static final class FakePool implements DataSource {
        final List<String> log = new ArrayList<>(); int taken, returned;
        public Connection getConnection() {
            int n = ++taken; boolean[] auto = {true};
            return (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[]{Connection.class}, (p, m, a) -> switch (m.getName()) {
                case "prepareStatement" -> {
                    String sql = (String) a[0]; List<String> params = new ArrayList<>();
                    yield Proxy.newProxyInstance(PreparedStatement.class.getClassLoader(), new Class<?>[]{PreparedStatement.class}, (p2, m2, a2) -> switch (m2.getName()) {
                        case "setString" -> { params.add((String) a2[1]); yield null; }
                        case "execute" -> { log.add("#" + n + " " + (sql.contains("set_config('app.community_id', ?") ? "SET " + params : sql.contains("set_config('app.community_id', ''") ? "CLEAR" : sql)); yield true; }
                        default -> null;
                    });
                }
                case "close" -> { returned++; yield null; }
                case "getAutoCommit" -> auto[0];
                case "setAutoCommit" -> { auto[0] = (Boolean) a[0]; yield null; }
                case "rollback" -> { log.add("#" + n + " ROLLBACK"); yield null; }
                case "isClosed" -> false;
                default -> null;
            });
        }
        public Connection getConnection(String u, String p) { return getConnection(); }
        public PrintWriter getLogWriter() { return null; } public void setLogWriter(PrintWriter o) {} public void setLoginTimeout(int s) {} public int getLoginTimeout() { return 0; }
        public Logger getParentLogger() { return null; } public <T> T unwrap(Class<T> i) { return null; } public boolean isWrapperFor(Class<?> i) { return false; }
    }
    static void query(DataSource ds) throws Exception {
        try (Connection c = ds.getConnection(); PreparedStatement ps = c.prepareStatement("SELECT 1")) { ps.execute(); }
    }

    @Test void perStatementOutsideARequest() throws Exception {
        FakePool pool = new FakePool(); TenantDataSource ds = new TenantDataSource(pool);
        Caller a = Fixtures.treasurer();
        CallerHolder.runAs(a, () -> { try { query(ds); query(ds); } catch (Exception e) { throw new IllegalStateException(e); } return null; });
        assertEquals(6, pool.log.size(), "set, query, clear - each time: " + pool.log);
        assertEquals(2, pool.taken); assertEquals(2, pool.returned);
    }

    @Test void oneConnectionPerBoundRequest() throws Exception {
        FakePool pool = new FakePool(); TenantDataSource ds = new TenantDataSource(pool);
        Caller a = Fixtures.treasurer(), b = Fixtures.owner(Fixtures.UNIT_A);
        assertTrue(TenantDataSource.bind()); assertFalse(TenantDataSource.bind(), "a nested bind is ignored");
        CallerHolder.runAs(a, () -> {
            try {
                query(ds); query(ds); query(ds);
                CallerHolder.runAs(b, () -> { try { query(ds); } catch (Exception e) { throw new IllegalStateException(e); } return null; });   // someone else mid-request: set again
                query(ds);                                                                                                             // and back
            } catch (Exception e) { throw new IllegalStateException(e); }
            return null;
        });
        assertEquals(0, pool.returned, "held until the request ends");
        TenantDataSource.release();
        List<String> want = List.of(
            "#1 SET [" + a.community() + ", " + a.membership() + "]", "#1 SELECT 1", "#1 SELECT 1", "#1 SELECT 1",
            "#1 SET [" + b.community() + ", " + b.membership() + "]", "#1 SELECT 1",
            "#1 SET [" + a.community() + ", " + a.membership() + "]", "#1 SELECT 1", "#1 CLEAR");
        assertEquals(want, pool.log);
        assertEquals(1, pool.taken); assertEquals(1, pool.returned, "back to the pool, cleared");
        TenantDataSource.release();                                                                // a second release does nothing
        query(ds);
        assertEquals(2, pool.taken, "unbound again: a connection per statement");
    }

    @Test void aBoundRequestThatReadsNothingTakesNoConnection() {
        FakePool pool = new FakePool();
        new TenantDataSource(pool);
        TenantDataSource.bind(); TenantDataSource.release();
        assertEquals(0, pool.taken);
    }

    @Test void anOpenTransactionIsRolledBackAtTheEnd() throws Exception {
        FakePool pool = new FakePool(); TenantDataSource ds = new TenantDataSource(pool);
        TenantDataSource.bind();
        CallerHolder.runAs(Fixtures.treasurer(), () -> { try { ds.getConnection().setAutoCommit(false); } catch (Exception e) { throw new IllegalStateException(e); } return null; });
        TenantDataSource.release();
        assertTrue(pool.log.contains("#1 ROLLBACK"), pool.log.toString());
        assertEquals("#1 CLEAR", pool.log.get(pool.log.size() - 1));
    }
}
