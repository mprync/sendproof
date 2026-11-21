package dev.testbench.core;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.Test;

class ProtocolTest {

    @Test
    void exactPreferenceAcceptsOnlyOneRollbackValue() {
        assertThat(Protocol.hasExactPreference(List.of("tx=rollback"))).isTrue();
        assertThat(Protocol.hasExactPreference(List.of(" TX=Rollback "))).isTrue();
        assertThat(Protocol.hasExactPreference(List.of())).isFalse();
        assertThat(Protocol.hasExactPreference(List.of("tx=\"rollback\""))).isFalse();
        assertThat(Protocol.hasExactPreference(List.of("trace, tx=rollback"))).isFalse();
        assertThat(Protocol.hasExactPreference(List.of("tx=rollback", "tx=rollback"))).isFalse();
    }

    @Test
    void anySpellingOfRollbackIsRecognizedOnOrdinaryUrls() {
        assertThat(Protocol.requestsRollback(List.of("tx=rollback"))).isTrue();
        assertThat(Protocol.requestsRollback(List.of("respond-async, tx=\"rollback\""))).isTrue();
        assertThat(Protocol.requestsRollback(List.of("trace;x=1, TX=ROLLBACK"))).isTrue();
        assertThat(Protocol.requestsRollback(List.of("tx=commit", "trace"))).isFalse();
    }

    @Test
    void traceIsRecognizedBeforeParameters() {
        assertThat(Protocol.observedRequested(List.of("trace"))).isTrue();
        assertThat(Protocol.observedRequested(List.of("return=minimal, Trace; foo=bar"))).isTrue();
        assertThat(Protocol.observedRequested(List.of("tracer"))).isFalse();
    }

    @Test
    void sameOriginComparesSchemeHostAndPort() {
        assertThat(Protocol.isSameOrigin(null, List.of(), "http", "localhost:8080")).isTrue();
        assertThat(Protocol.isSameOrigin("same-origin", List.of("http://localhost:8080"), "http", "localhost:8080")).isTrue();
        assertThat(Protocol.isSameOrigin(null, List.of("https://localhost:443"), "https", "localhost")).isTrue();
        assertThat(Protocol.isSameOrigin("cross-site", List.of(), "http", "localhost")).isFalse();
        assertThat(Protocol.isSameOrigin(null, List.of("https://elsewhere.example.test"), "http", "localhost")).isFalse();
        assertThat(Protocol.isSameOrigin(null, List.of("http://localhost:9"), "http", "localhost:8080")).isFalse();
        assertThat(Protocol.isSameOrigin(null, List.of("http://localhost:8080/path"), "http", "localhost:8080")).isFalse();
        assertThat(Protocol.isSameOrigin(null, List.of("null"), "http", "localhost")).isFalse();
        assertThat(Protocol.isSameOrigin(null, List.of("http://a", "http://b"), "http", "a")).isFalse();
    }

    @Test
    void previewPrefixMustEndAtASegment() {
        assertThat(Protocol.previewPrefixIndex("/bench/_preview/items")).isZero();
        assertThat(Protocol.previewPrefixIndex("/Bench/_Preview")).isZero();
        assertThat(Protocol.previewPrefixIndex("/tenant/bench/_preview/items")).isEqualTo(7);
        assertThat(Protocol.previewPrefixIndex("/bench/_previews")).isEqualTo(-1);
        assertThat(Protocol.previewPrefixIndex("/items")).isEqualTo(-1);
    }

    @Test
    void targetsCannotEscapeTheApplicationOrReachTheWorkbench() {
        assertThat(Protocol.isValidTarget("/items/12")).isTrue();
        assertThat(Protocol.isValidTarget("/items/a%20b")).isTrue();
        for (String bad : List.of("", "items", "//items", "//items/..", "/a/../b", "/a/%2e%2e/b",
                "/a\\b", "/a%5Cb", "/bench", "/BENCH/_api/capabilities", "/a%00b", "/a;b", "/a%zz")) {
            assertThat(Protocol.isValidTarget(bad)).as(bad).isFalse();
        }
    }

    @Test
    void localUrlsMustBeApplicationRelative() {
        assertThat(LocalUrl.isLocal("/auth/sign-in")).isTrue();
        assertThat(LocalUrl.isLocal("/a?x=1")).isTrue();
        for (String bad : List.of("http://x/y", "//x", "/a/../b", "/a#x", "/a b", "/a\\b", "relative")) {
            assertThat(LocalUrl.isLocal(bad)).as(bad).isFalse();
        }
    }
}
