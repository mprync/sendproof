package dev.testbench.fixture;

import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.Map;
import org.springframework.stereotype.Component;

/** The fixture's accounts and their sessions (opaque tokens held in memory). */
@Component
public class FixtureUsers {

    public record Account(String email, String name, String role) {
    }

    public static final Account ADMIN = new Account("admin@example.test", "Fixture Admin", "admin");
    public static final Account VIEWER = new Account("viewer@example.test", "Fixture Viewer", "viewer");
    private static final String PASSWORD = "bench-fixture";

    private final Map<String, Account> sessions = new ConcurrentHashMap<>();

    public List<Account> all() {
        return List.of(ADMIN, VIEWER);
    }

    public Optional<Account> byEmail(String email) {
        return all().stream().filter(account -> account.email().equalsIgnoreCase(email)).findFirst();
    }

    public Optional<Account> verify(String email, String password) {
        return PASSWORD.equals(password) ? byEmail(email) : Optional.empty();
    }

    /** Starts a new session for the account and returns its token. Earlier sessions stay valid. */
    public String open(Account account) {
        String token = UUID.randomUUID().toString();
        sessions.put(token, account);
        return token;
    }

    public Optional<Account> session(String token) {
        return token == null ? Optional.empty() : Optional.ofNullable(sessions.get(token));
    }
}
