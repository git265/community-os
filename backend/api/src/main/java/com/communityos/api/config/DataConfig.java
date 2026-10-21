package com.communityos.api.config;

import com.communityos.api.shared.tenancy.TenantDataSource;
import com.communityos.api.shared.tx.SpringTx;
import com.communityos.api.shared.tx.Tx;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import javax.sql.DataSource;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.PlatformTransactionManager;

/**
 * Two connection pools, two roles:
 *   app       cos_app (NO bypass of row-level security), wrapped in TenantDataSource so every connection carries the caller's community
 *   platform  cos_platform (BYPASSRLS) for sign-in, provider webhooks before the community is known, and the outbox / webhook workers
 * Flyway migrates as the owner role through spring.flyway.* (neither pool can change the schema).
 * Pool sizes: ~20 per instance is plenty for 100 communities (requests are short, the provider calls happen outside transactions).
 */
@Configuration
public class DataConfig {
    @Bean(destroyMethod = "close") HikariDataSource appPool(CosProperties p) { return pool("cos-app", p.db().app()); }
    @Bean(destroyMethod = "close") HikariDataSource platformPool(CosProperties p) { return pool("cos-platform", p.db().platform()); }

    @Bean @Primary DataSource dataSource(@Qualifier("appPool") HikariDataSource appPool) { return new TenantDataSource(appPool); }
    @Bean @Qualifier("platform") DataSource platformDataSource(@Qualifier("platformPool") HikariDataSource platformPool) { return platformPool; }

    @Bean @Primary PlatformTransactionManager transactionManager(DataSource dataSource) { return new DataSourceTransactionManager(dataSource); }
    @Bean @Qualifier("platform") PlatformTransactionManager platformTransactionManager(@Qualifier("platform") DataSource ds) { return new DataSourceTransactionManager(ds); }

    @Bean @Primary NamedParameterJdbcTemplate jdbc(DataSource dataSource) { return new NamedParameterJdbcTemplate(dataSource); }
    @Bean @Qualifier("platform") NamedParameterJdbcTemplate platformJdbc(@Qualifier("platform") DataSource ds) { return new NamedParameterJdbcTemplate(ds); }

    @Bean @Primary Tx tx(PlatformTransactionManager tm) { return new SpringTx(tm, 15); }
    @Bean @Qualifier("platform") Tx platformTx(@Qualifier("platform") PlatformTransactionManager tm) { return new SpringTx(tm, 15); }

    private static HikariDataSource pool(String name, CosProperties.Pool p) {
        HikariConfig c = new HikariConfig();
        c.setPoolName(name); c.setJdbcUrl(p.url()); c.setUsername(p.username()); c.setPassword(p.password());
        c.setMaximumPoolSize(p.maxPoolSize()); c.setMinimumIdle(Math.min(5, p.maxPoolSize()));
        c.setConnectionTimeout(p.connectionTimeout().toMillis());               // fail fast when the pool is exhausted instead of queueing forever
        c.setMaxLifetime(30 * 60_000L);
        c.setAutoCommit(true);
        c.addDataSourceProperty("options", "-c statement_timeout=" + p.statementTimeout().toMillis() + " -c idle_in_transaction_session_timeout=30000");
        c.addDataSourceProperty("ApplicationName", name);
        c.addDataSourceProperty("reWriteBatchedInserts", "true");
        return new HikariDataSource(c);
    }
}
