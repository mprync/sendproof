//! [`Mongo`] as an Actix Web extractor. Register the store with `app_data(web::Data::new(store))`.

use std::{
    fmt,
    future::{Ready, ready},
};

use actix_web::{FromRequest, HttpMessage, HttpRequest, HttpResponse, ResponseError, dev::Payload, http::StatusCode, web};
use sendproof_core::{Enrollment, PreviewRequired};

use crate::{Mongo, MongoStore};

/// The rejection of the [`Mongo`] extractor.
#[derive(Debug)]
pub enum MongoRejection {
    /// A preview reached a route the gate did not enroll. Nothing was sent to MongoDB. Answers 409.
    NotEnrolled,
    /// The store was not registered with `app_data`.
    Missing,
}

impl fmt::Display for MongoRejection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotEnrolled => f.write_str("this preview request was not enrolled by the Sendproof gate"),
            Self::Missing => f.write_str("register the store with `app_data(web::Data::new(store))`"),
        }
    }
}

impl ResponseError for MongoRejection {
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

impl FromRequest for Mongo {
    type Error = MongoRejection;
    type Future = Ready<Result<Self, Self::Error>>;

    fn from_request(request: &HttpRequest, _: &mut Payload) -> Self::Future {
        let Some(store) = request.app_data::<web::Data<MongoStore>>() else {
            return ready(Err(MongoRejection::Missing));
        };
        let extensions = request.extensions();
        ready(
            store
                .from_enrollment(extensions.get::<Enrollment>(), extensions.get::<PreviewRequired>().is_some())
                .map_err(|_| MongoRejection::NotEnrolled),
        )
    }
}
