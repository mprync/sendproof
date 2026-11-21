//! Embeds the packed workbench UI.
//!
//! The UI is produced by `tools/pack-ui.mjs` (see `scripts/pack-assets.sh`) and read from
//! `ui-assets/` next to this file, or from the directory named by `SENDPROOF_UI_DIR`.
//! The source of the UI is never part of this crate.

use std::{env, fmt::Write as _, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=SENDPROOF_UI_DIR");
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let dir = env::var("SENDPROOF_UI_DIR").map(PathBuf::from).unwrap_or_else(|_| manifest_dir.join("ui-assets"));
    println!("cargo:rerun-if-changed={}", dir.display());
    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join("ui_assets.rs");

    let manifest_path = dir.join("manifest.json");
    let mut code = String::new();
    let Ok(text) = fs::read_to_string(&manifest_path) else {
        println!(
            "cargo:warning=Sendproof UI assets not found at {}. Run adapters/rust/scripts/pack-assets.sh. \
             The workbench will answer 503 until they are embedded.",
            dir.display()
        );
        code.push_str(
            "pub const VERSION: &str = \"\";\npub const BUNDLE_HASH: &str = \"\";\npub static FILES: &[(&str, &str, &str, &[u8])] = &[];\n",
        );
        fs::write(out, code).unwrap();
        return;
    };

    let manifest: serde_json::Value = serde_json::from_str(&text).expect("manifest.json is not valid JSON");
    let version = manifest["version"].as_str().expect("manifest.version");
    let bundle = manifest["bundleHash"].as_str().expect("manifest.bundleHash");
    writeln!(code, "pub const VERSION: &str = {version:?};").unwrap();
    writeln!(code, "pub const BUNDLE_HASH: &str = {bundle:?};").unwrap();
    code.push_str("pub static FILES: &[(&str, &str, &str, &[u8])] = &[\n");
    let files = manifest["files"].as_object().expect("manifest.files");
    for (name, entry) in files {
        let sha = entry["sha256"].as_str().expect("file.sha256");
        let content_type = entry["contentType"].as_str().expect("file.contentType");
        let path = dir.join(name);
        let bytes = fs::read(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
        assert_eq!(bytes.len() as u64, entry["bytes"].as_u64().unwrap(), "size mismatch for {name}");
        let absolute = fs::canonicalize(&path).unwrap();
        writeln!(code, "    ({name:?}, {content_type:?}, {sha:?}, include_bytes!({:?})),", absolute.display().to_string()).unwrap();
        println!("cargo:rerun-if-changed={}", path.display());
    }
    code.push_str("];\n");
    fs::write(out, code).unwrap();
}
