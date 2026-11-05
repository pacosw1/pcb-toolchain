//! Binds an explicitly selected quality backend to reviewed build and native evidence.
use super::files::digest;
use serde_json::{Value, json};
use std::fs;
use std::path::Path;

const UPSTREAM: &str = "e5d52c4544795422b8b28077acc0605fdf11265a";
const LOCK: &str = "4761175c5d8df0ed4c2c69036df2686dc7e3a186cd085d2ae766936134cab9a6";
const PATCH: &str = "backend-patches/fastroute-quality-773/quality-first.patch";

fn is_sha256(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn check_evidence(item: &Value) -> Result<(), String> {
    let (Some(sha256), Some(path)) = (item["sha256"].as_str(), item["path"].as_str()) else {
        return Err("quality backend evidence schema invalid".to_string());
    };
    if !is_sha256(sha256) {
        return Err("quality backend evidence schema invalid".to_string());
    }
    let target = Path::new(path);
    if !target.is_absolute() || !target.is_file() || digest(target)? != sha256 {
        return Err("quality backend native evidence hash mismatch".to_string());
    }
    Ok(())
}

/// The backend policy of a job: `legacy-unverified` with no manifest, else proved `quality-first`. `tools` holds the patch.
pub fn bind(binary: &Path, manifest: Option<&Path>, tools: &Path) -> Result<Value, String> {
    let Some(manifest) = manifest else { return Ok(json!({"mode": "legacy-unverified", "qualified": false})) };
    let text = fs::read_to_string(manifest).map_err(|e| format!("{}: {e}", manifest.display()))?;
    let data: Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", manifest.display()))?;
    if !data.is_object() {
        return Err("quality backend provenance schema invalid".to_string());
    }
    let patch = digest(tools.join(PATCH))?;
    if data["schema"] != 1 || data["upstream_commit"] != UPSTREAM || data["cargo_lock_sha256"] != LOCK || data["patch_sha256"] != patch.as_str() {
        return Err("quality backend source/patch/lock provenance mismatch".to_string());
    }
    if data["binary_sha256"] != digest(binary)?.as_str() {
        return Err("quality backend binary hash mismatch".to_string());
    }
    let validation = data.get("native_validation").unwrap_or(&Value::Null);
    if !validation.is_object() && !validation.is_null() {
        return Err("quality backend native validation schema invalid".to_string());
    }
    let evidence = validation["evidence"].as_array().filter(|list| !list.is_empty() && validation["status"] == "passed");
    let evidence = evidence.ok_or("quality backend native validation evidence unavailable")?;
    evidence.iter().try_for_each(check_evidence)?;
    let path = fs::canonicalize(manifest).map_err(|e| format!("{}: {e}", manifest.display()))?;
    Ok(json!({"mode": "quality-first", "manifest": path.display().to_string(), "manifest_sha256": digest(manifest)?,
              "binary_sha256": data["binary_sha256"], "patch_sha256": data["patch_sha256"], "upstream_commit": UPSTREAM, "qualified": false}))
}

pub fn require_capability(help: &str) -> Result<(), String> {
    if help.contains("--quality-first") { Ok(()) } else { Err("quality backend lacks required --quality-first capability".to_string()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sha256::sha256;

    struct Setup {
        tools: std::path::PathBuf,
        binary: std::path::PathBuf,
        manifest: std::path::PathBuf,
        data: Value,
    }

    fn setup(name: &str) -> Setup {
        let root = std::env::temp_dir().join(format!("job-backend-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let patch = root.join(PATCH);
        fs::create_dir_all(patch.parent().unwrap()).unwrap();
        fs::write(&patch, "patch").unwrap();
        let (binary, proof) = (root.join("fastroute"), root.join("proof.json"));
        fs::write(&binary, "binary").unwrap();
        fs::write(&proof, "proof").unwrap();
        let data = json!({"schema": 1, "upstream_commit": UPSTREAM, "cargo_lock_sha256": LOCK, "patch_sha256": sha256(b"patch"), "binary_sha256": sha256(b"binary"),
                          "native_validation": {"status": "passed", "evidence": [{"path": proof.display().to_string(), "sha256": sha256(b"proof")}]}});
        let manifest = root.join("manifest.json");
        fs::write(&manifest, data.to_string()).unwrap();
        Setup { tools: root, binary, manifest, data }
    }

    #[test]
    fn no_manifest_is_the_legacy_backend() {
        assert_eq!(bind(Path::new("x"), None, Path::new("."),).unwrap()["mode"], "legacy-unverified");
    }

    #[test]
    fn a_proved_manifest_binds_and_a_changed_binary_does_not() {
        let setup = setup("bind");
        let bound = bind(&setup.binary, Some(&setup.manifest), &setup.tools).unwrap();
        assert_eq!(bound["mode"], "quality-first");
        fs::write(&setup.binary, "other").unwrap();
        assert!(bind(&setup.binary, Some(&setup.manifest), &setup.tools).unwrap_err().contains("binary hash"));
    }

    #[test]
    fn evidence_must_be_there_and_match() {
        let setup = setup("evidence");
        let mut data = setup.data.clone();
        data["native_validation"]["evidence"][0]["sha256"] = json!("0".repeat(64));
        fs::write(&setup.manifest, data.to_string()).unwrap();
        assert!(bind(&setup.binary, Some(&setup.manifest), &setup.tools).unwrap_err().contains("hash mismatch"));
        data["native_validation"]["evidence"] = json!([]);
        fs::write(&setup.manifest, data.to_string()).unwrap();
        assert!(bind(&setup.binary, Some(&setup.manifest), &setup.tools).unwrap_err().contains("unavailable"));
    }

    #[test]
    fn the_flag_must_be_in_the_help() {
        assert!(require_capability("  --quality-first  ").is_ok());
        assert!(require_capability("  --other  ").is_err());
    }
}
