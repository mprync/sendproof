//! The fixture scenarios selected by `BENCH_SCENARIO`.

use testbench_core::{BoxError, BoxFuture, Changes, PreviewProvider, PreviewSession};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scenario {
    /// The full fixture.
    Standard,
    /// Runs outside the configured environments: no workbench, no preview.
    Disabled,
    /// No preview provider is registered.
    NoProvider,
    /// The provider rolls back for real, then reports a failure.
    RollbackFailure,
}

impl Scenario {
    pub fn parse(name: &str) -> Result<Self, String> {
        Ok(match name {
            "standard" => Self::Standard,
            "disabled" => Self::Disabled,
            "no-provider" => Self::NoProvider,
            "rollback-failure" => Self::RollbackFailure,
            other => return Err(format!("unknown BENCH_SCENARIO `{other}`")),
        })
    }
}

/// Wraps a provider so that its rollback happens and then fails, the way a broken
/// connection can: the data is unchanged but the transport cannot confirm it.
pub struct FailingRollback<P>(pub P);

impl<P: PreviewProvider> PreviewProvider for FailingRollback<P> {
    fn database(&self) -> Option<String> {
        self.0.database()
    }

    fn begin_preview<'a>(
        &'a self,
        extensions: &'a mut http::Extensions,
    ) -> BoxFuture<'a, Result<Box<dyn PreviewSession>, BoxError>> {
        Box::pin(async move {
            Ok(Box::new(Failing(self.0.begin_preview(extensions).await?))
                as Box<dyn PreviewSession>)
        })
    }
}

struct Failing(Box<dyn PreviewSession>);

impl PreviewSession for Failing {
    fn rollback(&mut self) -> BoxFuture<'_, Result<(), BoxError>> {
        Box::pin(async move {
            self.0.rollback().await?;
            Err("injected rollback failure".into())
        })
    }

    fn changes(&mut self) -> Changes {
        self.0.changes()
    }

    fn close(self: Box<Self>) -> BoxFuture<'static, Result<(), BoxError>> {
        self.0.close()
    }
}
