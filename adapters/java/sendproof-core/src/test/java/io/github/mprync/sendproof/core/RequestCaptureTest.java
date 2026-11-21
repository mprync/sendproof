package io.github.mprync.sendproof.core;

import static org.assertj.core.api.Assertions.assertThat;

import io.github.mprync.sendproof.core.CaptureModels.CapturedSql;
import io.github.mprync.sendproof.core.RequestCapture.SqlSnapshot;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class RequestCaptureTest {

    @Test
    void effectsAreSuppressedInPreviewAndMarkedDeliveredInObservedSend() {
        var preview = new RequestCapture();
        assertThat(preview.tryRecordEffect("email", "before begin", null)).isFalse();
        preview.begin(true, System.nanoTime());
        assertThat(preview.tryRecordEffect("email", "Created item", Map.of("to", List.of("a@b")))).isTrue();
        var previewEffect = preview.finish().effects().get(0);
        assertThat(previewEffect.delivered()).isNull();
        assertThat(previewEffect.data().get("to").get(0).asText()).isEqualTo("a@b");

        var observed = new RequestCapture();
        observed.begin(false, System.nanoTime());
        assertThat(observed.tryRecordEffect("email", "Created item", null)).isFalse();
        assertThat(observed.finish().effects().get(0).delivered()).isTrue();
    }

    @Test
    void collectionsStopAtTheirCapsAndSayTheyWereTruncated() {
        var capture = new RequestCapture();
        capture.begin(true, System.nanoTime());
        for (int i = 0; i < CaptureLimits.EFFECTS + 5; i++) {
            assertThat(capture.tryRecordEffect("message", "e" + i, null)).isTrue();
        }
        for (int i = 0; i < CaptureLimits.LOGS + 5; i++) {
            capture.tryRecordLog("Information", "line " + i);
        }
        var snapshot = capture.finish();
        assertThat(snapshot.effects()).hasSize(CaptureLimits.EFFECTS);
        assertThat(snapshot.effectsTruncated()).isTrue();
        assertThat(snapshot.logs()).hasSize(CaptureLimits.LOGS);
        assertThat(snapshot.logsTruncated()).isTrue();
    }

    @Test
    void sqlCountsTowardTimingEvenWhenLogsAreFull() {
        var capture = new RequestCapture();
        capture.begin(true, System.nanoTime());
        for (int i = 0; i < CaptureLimits.LOGS; i++) {
            capture.tryRecordLog("Information", "x");
        }
        capture.recordSql(2.5, "sql", () -> new SqlSnapshot(new CapturedSql("select 1", List.of(), null), false));
        var timing = capture.timing(new CaptureClock(System.nanoTime()), 0);
        assertThat(timing.queryCount()).isEqualTo(1);
        assertThat(timing.db()).isEqualTo(2.5);
        assertThat(timing.toHeader()).contains("db;dur=2.500;desc=\"1 queries\"");
    }

    @Test
    void inactiveCaptureRecordsNothing() {
        var capture = new RequestCapture();
        assertThat(capture.tryRecordLog("Information", "ignored")).isFalse();
        capture.log("cat", "Information", "ignored", null, null, null);
        assertThat(capture.finish().logs()).isEmpty();
    }

    @Test
    void snapshotsRejectCyclesAndOversizedValues() {
        var cyclic = new java.util.HashMap<String, Object>();
        cyclic.put("self", cyclic);
        assertThat(CaptureLimits.snapshot(cyclic)).isNull();
        assertThat(CaptureLimits.snapshot("x".repeat(CaptureLimits.PAYLOAD_BYTES))).isNull();
        assertThat(CaptureLimits.snapshot(Map.of("a", 1))).isNotNull();
    }

    @Test
    void changesAreBoundedAndKeysSurvive() {
        var changes = new java.util.ArrayList<PreviewChange>();
        for (int i = 0; i < CaptureLimits.CHANGES + 3; i++) {
            changes.add(new PreviewChange("insert", "items", Map.of("id", "k" + i), null, Map.of("id", "k" + i)));
        }
        var bounded = CaptureLimits.snapshotChanges(changes);
        assertThat(bounded.changes()).hasSize(CaptureLimits.CHANGES);
        assertThat(bounded.truncated()).isTrue();
        assertThat(bounded.changes().get(0).key().toString()).contains("k0");
    }
}
