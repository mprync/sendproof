//! [`Cassandra`] as an Axum extractor.

use axum::{
    extract::{FromRef, FromRequestParts},
    http::{StatusCode, request::Parts},
    response::{IntoResponse, Response},
};
use sendproof_core::{Enrollment, NotEnrolled, PreviewRequired};

use crate::{Cassandra, CassandraStore};

impl<S> FromRequestParts<S> for Cassandra
where
    CassandraStore: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = NotEnrolledResponse;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        CassandraStore::from_ref(state)
            .from_enrollment(parts.extensions.get::<Enrollment>(), parts.extensions.get::<PreviewRequired>().is_some())
            .map_err(NotEnrolledResponse)
    }
}

/// The rejection of the [`Cassandra`] extractor: a preview reached a route the gate did not enroll.
/// Nothing was sent to Cassandra. Answers 409.
#[derive(Debug)]
pub struct NotEnrolledResponse(pub NotEnrolled);

impl IntoResponse for NotEnrolledResponse {
    fn into_response(self) -> Response {
        (StatusCode::CONFLICT, self.0.to_string()).into_response()
    }
}
