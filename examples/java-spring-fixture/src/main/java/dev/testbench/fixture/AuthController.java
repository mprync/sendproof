package dev.testbench.fixture;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Password JSON sign-in and development personas. Each success starts a new cookie-backed session. */
@RestController
@RequestMapping("/auth")
public class AuthController {
    static final String COOKIE = "fixture_session";

    public record Credentials(String email, String password) {
    }

    private final FixtureUsers users;

    public AuthController(FixtureUsers users) {
        this.users = users;
    }

    @PostMapping("/sign-in")
    public ResponseEntity<FixtureUsers.Account> signIn(@RequestBody Credentials credentials,
                                                       HttpServletRequest request, HttpServletResponse response) {
        return users.verify(credentials.email(), credentials.password())
                .map(account -> start(account, request, response))
                .orElseGet(() -> ResponseEntity.status(HttpStatus.UNAUTHORIZED).build());
    }

    @GetMapping("/personas")
    public List<FixtureUsers.Account> personas() {
        return users.all();
    }

    @PostMapping("/personas/{email}")
    public ResponseEntity<FixtureUsers.Account> persona(@PathVariable String email, HttpServletRequest request,
                                                        HttpServletResponse response) {
        return users.byEmail(email).map(account -> start(account, request, response))
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    private ResponseEntity<FixtureUsers.Account> start(FixtureUsers.Account account, HttpServletRequest request,
                                                      HttpServletResponse response) {
        String path = request.getContextPath().isEmpty() ? "/" : request.getContextPath();
        response.addHeader("Set-Cookie", COOKIE + "=" + users.open(account) + "; Path=" + path
                + "; HttpOnly; SameSite=Lax");
        return ResponseEntity.ok(account);
    }
}
