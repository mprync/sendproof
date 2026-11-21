package dev.testbench.jpa;

import jakarta.persistence.EntityManagerFactory;
import org.hibernate.engine.spi.SessionFactoryImplementor;
import org.hibernate.event.service.spi.EventListenerRegistry;
import org.hibernate.event.spi.EventType;
import org.springframework.beans.factory.InitializingBean;

/** Registers {@link HibernateChangeListener} on the application's Hibernate session factory. */
final class HibernateChangeRegistrar implements InitializingBean {
    private final EntityManagerFactory entityManagerFactory;

    HibernateChangeRegistrar(EntityManagerFactory entityManagerFactory) {
        this.entityManagerFactory = entityManagerFactory;
    }

    @Override
    public void afterPropertiesSet() {
        var registry = entityManagerFactory.unwrap(SessionFactoryImplementor.class).getServiceRegistry()
                .requireService(EventListenerRegistry.class);
        var listener = new HibernateChangeListener();
        registry.appendListeners(EventType.POST_INSERT, listener);
        registry.appendListeners(EventType.POST_UPDATE, listener);
        registry.appendListeners(EventType.POST_DELETE, listener);
    }
}
