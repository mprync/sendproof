//! The framework-neutral parts of the Rust conformance fixtures (`spec/conformance/fixture.md`).
//!
//! The Axum and Actix fixtures differ only in routing and request plumbing. Everything that decides
//! what the fixture *does*, such as sessions, authorization, SQL and effects, lives here.

pub mod auth;
pub mod items;
mod journeys;
pub mod openapi;
pub mod scenario;
pub mod setup;
pub mod stores;
