package com.communityos.api.shared.tenancy;

import com.communityos.api.shared.security.Caller;
import java.io.PrintWriter;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.util.logging.Logger;
import javax.sql.DataSource;

/**
 * Decorator over the connection pool: every connection handed to the application first gets the caller's community and member
 * (set_config('app.community_id' / 'app.user_id')), which the database's row-level security policies read; on return to the pool the settings
 * are cleared, so a pooled connection never carries one community's identity into another request. No caller = no community = no rows.
 *
 * Reads outside a transaction take a connection per statement, so a page's few queries used to cost three round trips each (set, query,
 * clear). Inside a request bound with {@link #bind()} (RequestConnectionFilter: GET requests) all statements share ONE pooled connection:
 * the identity is set once, set again only if the caller changes mid-request (runAs), and cleared once when the request ends.
 */
public final class TenantDataSource implements DataSource {
    private static final String SET = "SELECT set_config('app.community_id', ?, false), set_config('app.user_id', ?, false)";
    private static final String CLEAR = "SELECT set_config('app.community_id', '', false), set_config('app.user_id', '', false)";

    /** One request's shared connection, taken from the pool on the first statement (a request that reads nothing takes none). */
    static final class Bound { Connection real; String identity; }
    private static final ThreadLocal<Bound> BOUND = new ThreadLocal<>();

    private final DataSource target;
    public TenantDataSource(DataSource target) { this.target = target; }

    /** From now until {@link #release()}, this thread's statements share one connection. Nested binds are ignored. Returns false if already bound. */
    public static boolean bind() { if (BOUND.get() != null) return false; BOUND.set(new Bound()); return true; }
    /** Ends the binding: the identity is cleared and the connection goes back to the pool. */
    public static void release() {
        Bound b = BOUND.get(); BOUND.remove();
        if (b == null || b.real == null) return;
        try {
            if (!b.real.getAutoCommit()) b.real.rollback();                  // never leave a transaction open on a pooled connection
            try (PreparedStatement ps = b.real.prepareStatement(CLEAR)) { ps.execute(); }
        } catch (SQLException ignored) { /* the pool validates and discards broken connections */ }
        finally { try { b.real.close(); } catch (SQLException ignored) { /* already gone */ } }
    }

    @Override public Connection getConnection() throws SQLException {
        Bound b = BOUND.get();
        if (b == null) return wrap(target.getConnection());
        if (b.real == null) b.real = target.getConnection();
        String[] who = identity();
        String key = who[0] + "|" + who[1];
        if (!key.equals(b.identity) && b.real.getAutoCommit()) {         // in a transaction the connection keeps what it had (as before)
            try { set(b.real, who); } catch (SQLException e) { BOUND.remove(); b.real.close(); throw e; }
            b.identity = key;
        }
        Connection real = b.real;
        InvocationHandler h = (proxy, m, args) -> {
            switch (m.getName()) {
                case "close": return null;                                  // the request's connection stays open until release()
                case "isClosed": return real.isClosed();
                case "unwrap": if (((Class<?>) args[0]).isInstance(proxy)) return proxy; break;
                default: break;
            }
            try { return m.invoke(real, args); } catch (InvocationTargetException e) { throw e.getCause(); }
        };
        return (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[]{Connection.class}, h);
    }
    @Override public Connection getConnection(String u, String p) throws SQLException { return wrap(target.getConnection(u, p)); }

    private static String[] identity() {
        Caller caller = CallerHolder.current().orElse(null);
        return new String[]{caller == null ? "" : caller.community().toString(), caller == null || caller.membership() == null ? "" : caller.membership().toString()};
    }
    private static void set(Connection c, String[] who) throws SQLException {
        try (PreparedStatement ps = c.prepareStatement(SET)) { ps.setString(1, who[0]); ps.setString(2, who[1]); ps.execute(); }
    }

    private Connection wrap(Connection c) throws SQLException {
        try { set(c, identity()); } catch (SQLException e) { c.close(); throw e; }
        InvocationHandler h = (proxy, m, args) -> {
            if (m.getName().equals("close")) {
                try (PreparedStatement ps = c.prepareStatement(CLEAR)) { ps.execute(); } catch (SQLException ignored) { /* the pool validates and discards broken connections */ }
            }
            try { return m.invoke(c, args); } catch (InvocationTargetException e) { throw e.getCause(); }
        };
        return (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[]{Connection.class}, h);
    }

    @Override public PrintWriter getLogWriter() throws SQLException { return target.getLogWriter(); }
    @Override public void setLogWriter(PrintWriter out) throws SQLException { target.setLogWriter(out); }
    @Override public void setLoginTimeout(int seconds) throws SQLException { target.setLoginTimeout(seconds); }
    @Override public int getLoginTimeout() throws SQLException { return target.getLoginTimeout(); }
    @Override public Logger getParentLogger() throws SQLFeatureNotSupportedException { return target.getParentLogger(); }
    @Override public <T> T unwrap(Class<T> iface) throws SQLException { return iface.isInstance(this) ? iface.cast(this) : target.unwrap(iface); }
    @Override public boolean isWrapperFor(Class<?> iface) throws SQLException { return iface.isInstance(this) || target.isWrapperFor(iface); }
}
