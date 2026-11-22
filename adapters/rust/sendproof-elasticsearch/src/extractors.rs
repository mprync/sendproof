//! The engine handles as Axum and Actix Web extractors. The rejections are shared by both engines; the
//! `FromRequest` impls are generated per handle by the macros below.

#[cfg(feature = "axum")]
mod axum_support {
    use axum::{
        http::StatusCode,
        response::{IntoResponse, Response},
    };
    use sendproof_core::NotEnrolled;

    /// The rejection of the handle extractors: a preview reached a route the gate did not enroll.
    /// Nothing was sent to the cluster. Answers 409.
    #[derive(Debug)]
    pub struct NotEnrolledResponse(pub NotEnrolled);

    impl IntoResponse for NotEnrolledResponse {
        fn into_response(self) -> Response {
            (StatusCode::CONFLICT, self.0.to_string()).into_response()
        }
    }
}

#[cfg(feature = "axum")]
pub use axum_support::NotEnrolledResponse;

/// `impl FromRequestParts<S> for $Handle` where `$Store: FromRef<S>`.
#[cfg(feature = "axum")]
macro_rules! axum_extractor {
    ($Handle:ident, $Store:ident) => {
        impl<S> axum::extract::FromRequestParts<S> for $Handle
        where
            $Store: axum::extract::FromRef<S>,
            S: Send + Sync,
        {
            type Rejection = crate::NotEnrolledResponse;

            async fn from_request_parts(parts: &mut axum::http::request::Parts, state: &S) -> Result<Self, Self::Rejection> {
                <$Store as axum::extract::FromRef<S>>::from_ref(state)
                    .from_enrollment(
                        parts.extensions.get::<sendproof_core::Enrollment>(),
                        parts.extensions.get::<sendproof_core::PreviewRequired>().is_some(),
                    )
                    .map_err(crate::NotEnrolledResponse)
            }
        }
    };
}
#[cfg(feature = "axum")]
pub(crate) use axum_extractor;

#[cfg(feature = "actix")]
mod actix_support {
    use std::fmt;

    use actix_web::{HttpResponse, ResponseError, http::StatusCode};

    /// The rejection of the handle extractors.
    #[derive(Debug)]
    pub enum SearchRejection {
        /// A preview reached a route the gate did not enroll. Nothing was sent to the cluster. Answers 409.
        NotEnrolled,
        /// The store was not registered with `app_data`.
        Missing,
    }

    impl fmt::Display for SearchRejection {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            match self {
                Self::NotEnrolled => f.write_str("this preview request was not enrolled by the Sendproof gate"),
                Self::Missing => f.write_str("register the store with `app_data(web::Data::new(store))`"),
            }
        }
    }

    impl ResponseError for SearchRejection {
        fn status_code(&self) -> StatusCode {
            match self {
                Self::NotEnrolled => StatusCode::CONFLICT,
                Self::Missing => StatusCode::INTERNAL_SERVER_ERROR,
            }
        }

        fn error_response(&self) -> HttpResponse {
            HttpResponse::build(self.status_code()).body(self.to_string())
        }
    }
}

#[cfg(feature = "actix")]
pub use actix_support::SearchRejection;

/// `impl FromRequest for $Handle`, reading `web::Data<$Store>` from `app_data`.
#[cfg(feature = "actix")]
macro_rules! actix_extractor {
    ($Handle:ident, $Store:ident) => {
        impl actix_web::FromRequest for $Handle {
            type Error = crate::SearchRejection;
            type Future = std::future::Ready<Result<Self, Self::Error>>;

            fn from_request(request: &actix_web::HttpRequest, _: &mut actix_web::dev::Payload) -> Self::Future {
                use actix_web::HttpMessage;
                let Some(store) = request.app_data::<actix_web::web::Data<$Store>>() else {
                    return std::future::ready(Err(crate::SearchRejection::Missing));
                };
                let extensions = request.extensions();
                std::future::ready(
                    store
                        .from_enrollment(
                            extensions.get::<sendproof_core::Enrollment>(),
                            extensions.get::<sendproof_core::PreviewRequired>().is_some(),
                        )
                        .map_err(|_| crate::SearchRejection::NotEnrolled),
                )
            }
        }
    };
}
#[cfg(feature = "actix")]
pub(crate) use actix_extractor;
