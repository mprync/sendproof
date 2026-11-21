package dev.testbench.jpa;

import dev.testbench.spring.TestBenchEnabledCondition;
import jakarta.persistence.EntityManagerFactory;
import java.util.Locale;
import java.util.Set;
import javax.sql.DataSource;
import net.ttddyy.dsproxy.support.ProxyDataSourceBuilder;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.config.BeanDefinition;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnSingleCandidate;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration;
import org.springframework.boot.autoconfigure.orm.jpa.HibernateJpaAutoConfiguration;
import org.springframework.boot.autoconfigure.transaction.TransactionAutoConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Role;
import org.springframework.core.env.Environment;
import org.springframework.transaction.PlatformTransactionManager;

/**
 * Wires the JPA/Hibernate and Spring JDBC integration when Test Bench is enabled: SQL capture around the
 * {@link DataSource}, Hibernate change capture, and the {@link JpaPreviewProvider}. Set
 * {@code testbench.jpa.enabled=false} to opt out, for example when supplying another provider.
 */
@AutoConfiguration(after = {DataSourceAutoConfiguration.class, HibernateJpaAutoConfiguration.class,
        TransactionAutoConfiguration.class})
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
@Conditional(TestBenchEnabledCondition.class)
@ConditionalOnClass({PlatformTransactionManager.class, ProxyDataSourceBuilder.class})
@ConditionalOnProperty(prefix = "testbench.jpa", name = "enabled", havingValue = "true", matchIfMissing = true)
public class TestBenchJpaAutoConfiguration {
    private static final Set<String> DEVELOPMENT_ENVIRONMENTS = Set.of("development", "dev", "local");

    /** Must be static: post-processors are created before the beans they wrap. */
    @Bean
    static DataSourceCapturePostProcessor testBenchDataSourceCapturePostProcessor(Environment environment) {
        return new DataSourceCapturePostProcessor(new SqlCaptureListener(() -> showValues(environment)));
    }

    /** Static and infrastructure-role: advisors are created while auto-proxying is being set up. */
    @Bean
    @Role(BeanDefinition.ROLE_INFRASTRUCTURE)
    static PreviewFlushAdvisor testBenchPreviewFlushAdvisor() {
        return new PreviewFlushAdvisor();
    }

    @Bean
    @ConditionalOnSingleCandidate(PlatformTransactionManager.class)
    @ConditionalOnMissingBean(JpaPreviewProvider.class)
    JpaPreviewProvider testBenchJpaPreviewProvider(PlatformTransactionManager transactions,
                                                   ObjectProvider<EntityManagerFactory> entityManagerFactory,
                                                   ObjectProvider<DataSource> dataSource) {
        return new JpaPreviewProvider(transactions, entityManagerFactory.getIfUnique(),
                DatabaseLabel.lazy(dataSource.getIfUnique()));
    }

    /** Whether bound SQL values may be shown (secrets are always redacted regardless). */
    static boolean showValues(Environment environment) {
        Boolean configured = environment.getProperty("testbench.sql.include-parameter-values", Boolean.class);
        if (configured != null) {
            return configured;
        }
        String name = environment.getProperty("testbench.environment");
        if (name == null && environment.getActiveProfiles().length > 0) {
            name = environment.getActiveProfiles()[0];
        }
        return name != null && DEVELOPMENT_ENVIRONMENTS.contains(name.toLowerCase(Locale.ROOT));
    }

    /** Hibernate change capture when Hibernate is the JPA provider. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass(name = "org.hibernate.event.service.spi.EventListenerRegistry")
    @ConditionalOnBean(EntityManagerFactory.class)
    static class HibernateConfiguration {
        @Bean
        HibernateChangeRegistrar testBenchHibernateChangeRegistrar(EntityManagerFactory entityManagerFactory) {
            return new HibernateChangeRegistrar(entityManagerFactory);
        }
    }
}
