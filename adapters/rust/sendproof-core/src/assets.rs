//! The embedded workbench UI.

use std::{collections::HashMap, sync::OnceLock};

mod embedded {
    include!(concat!(env!("OUT_DIR"), "/ui_assets.rs"));
}

/// One embedded UI file.
#[derive(Debug, Clone, Copy)]
pub struct Asset {
    pub content_type: &'static str,
    pub sha256: &'static str,
    pub bytes: &'static [u8],
}

fn table() -> &'static HashMap<&'static str, Asset> {
    static TABLE: OnceLock<HashMap<&'static str, Asset>> = OnceLock::new();
    TABLE.get_or_init(|| {
        embedded::FILES.iter().map(|&(path, content_type, sha256, bytes)| (path, Asset { content_type, sha256, bytes })).collect()
    })
}

/// Looks up an asset by its path relative to `/sendproof/`, for example `app.js`.
pub fn get(path: &str) -> Option<Asset> {
    table().get(path).copied()
}

/// Whether a UI bundle was embedded at build time.
pub fn available() -> bool {
    !table().is_empty()
}

/// The version of the embedded UI bundle (empty when none is embedded).
pub fn version() -> &'static str {
    embedded::VERSION
}

/// The content hash of the embedded UI bundle (empty when none is embedded).
pub fn bundle_hash() -> &'static str {
    embedded::BUNDLE_HASH
}
