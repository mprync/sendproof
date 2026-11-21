# sendproof-core

The framework-neutral part of the Java binding. Web adapters (such as `sendproof-spring-boot`) and data integrations (such as `sendproof-jpa`) are built on it. It depends only on Jackson and SLF4J.

## What is in it

| Type | Role |
| --- | --- |
| `PreviewProvider`, `PreviewSession`, `PreviewObservation` | The data-layer SPI: begin a rollback-only unit of work, report changes, roll back, dispose. |
| `PreviewExecution` | Orchestrates one preview: begin, rollback, dispose, and the confirmed-or-rejected decision. |
| `ObservedExecution`, `TraceStore` | Observed Send: capture, reserve a trace, publish it to its owner. Eight traces per owner, 32 per host, five minutes by default, injectable clock. |
| `RequestCapture`, `CaptureContext`, `SendproofCapture` | Per-request effects and logs, the thread-bound current capture, and the facade host code uses to report effects. |
| `CaptureLimits` | The protocol's caps: 500 logs, 100 effects, 200 changes, 32 properties, 64 SQL parameters, 1 MiB response. |
| `SqlCapture`, `SqlParameterNames`, `SqlRedaction` | Builds bounded, redacted SQL entries and infers parameter names. |
| `Protocol`, `LocalUrl` | `Prefer` parsing, same-origin and preview-target rules. |
| `WorkbenchAssets` | Serves only files listed in the UI bundle manifest, verified against their SHA-256. |
| `Capabilities`, `ObservedTrace`, `PreviewEnvelope` | The JSON wire models. |

## Reporting effects from host code

```java
@Service
class Receipts {
    private final SendproofCapture capture;
    Receipts(SendproofCapture capture) { this.capture = capture; }

    void send(Payment payment) {
        if (capture.tryRecordEmail("Send receipt", "pay@example.test", List.of(payment.email()),
                List.of(), "Payment received", "Receipt " + payment.id(), null)) {
            return;                       // preview: recorded, not delivered
        }
        mailer.send(payment);             // ordinary send (recorded as delivered) or no capture
    }
}
```

`tryRecord*` returns `true` when delivery must be suppressed. Outside a preview or observed send it returns `false`, so the bean is safe in production code. Use `tryRecordHttp`, `tryRecordJob`, `tryRecordMessage` for the conventional effect shapes, or `tryRecordEffect` for custom kinds.

## Writing another data integration

Implement `PreviewProvider`. `begin()` must start the unit of work on the connection the handler will use, before the handler runs, and `PreviewSession.rollback()` must throw if rollback cannot be confirmed. Only register a provider for operations whose writes it can fully enroll.
