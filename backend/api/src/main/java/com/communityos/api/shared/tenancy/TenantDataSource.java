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
 * Decorator over the connection pool: every connection handed to the application first gets the request's community and member
 * (set_config('app.community_id' / 'app.user_id')), which the database's row-level security policies read; on return to the pool the settings
 * are cleared, so a pooled connection never carries one community's identity into another request. No caller = no community = no rows.
 */
public final class TenantDataSource implements DataSource {
    private static final String SET = "SELECT set_config('app.community_id', ?, false), set_config('app.user_id', ?, false)";
    private static final String CLEAR = "SELECT set_config('app.community_id', '', false), set_config('app.user_id', '', false)";
    private final DataSource target;

    public TenantDataSource(DataSource target) { this.target = target; }

    @Override public Connection getConnection() throws SQLException { return wrap(target.getConnection()); }
    @Override public Connection getConnection(String u, String p) throws SQLException { return wrap(target.getConnection(u, p)); }

    private Connection wrap(Connection c) throws SQLException {
        Caller caller = CallerHolder.current().orElse(null);
        try (PreparedStatement ps = c.prepareStatement(SET)) {
            ps.setString(1, caller == null ? "" : caller.community().toString());
            ps.setString(2, caller == null || caller.membership() == null ? "" : caller.membership().toString());
            ps.execute();
        } catch (SQLException e) { c.close(); throw e; }
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
