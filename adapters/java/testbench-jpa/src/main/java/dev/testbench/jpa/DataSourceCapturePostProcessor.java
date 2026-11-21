package dev.testbench.jpa;

import javax.sql.DataSource;
import net.ttddyy.dsproxy.listener.QueryExecutionListener;
import org.springframework.aop.scope.ScopedProxyUtils;
import org.springframework.beans.factory.config.BeanPostProcessor;

/** Wraps every {@link DataSource} bean in a {@link CaptureDataSource} so SQL capture covers all data access. */
final class DataSourceCapturePostProcessor implements BeanPostProcessor {
    private final QueryExecutionListener listener;

    DataSourceCapturePostProcessor(QueryExecutionListener listener) {
        this.listener = listener;
    }

    @Override
    public Object postProcessAfterInitialization(Object bean, String beanName) {
        if (bean instanceof DataSource dataSource && !(bean instanceof CaptureDataSource)
                && !ScopedProxyUtils.isScopedTarget(beanName)) {
            return new CaptureDataSource(dataSource, listener);
        }
        return bean;
    }
}
