//! File integrity checks for reviewed source inputs. This is a necessary preflight,
//! not verification that the manifest, evidence, or native board constitutes a review.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

fn owned(root: &Path, name: &str) -> crate::Result<PathBuf> {
    let p = Path::new(name);
    let path = if p.is_absolute() { p.to_path_buf() } else { root.join(p) };
    let path = path.canonicalize()?;
    if !path.starts_with(root) || !path.is_file() {
        return Err("reviewed input is not a file owned by the source root".into());
    }
    Ok(path)
}

/// Re-read and hash every declared source. Never use success as authority to admit a model:
/// manifest review, native geometry and binding must also be independently reconstructed.
pub(crate) fn check_inputs(contract: &Value) -> crate::Result<()> {
    let root = contract.get("root").and_then(Value::as_str).ok_or("reviewed root missing")?;
    let root = Path::new(root).canonicalize()?;
    let inputs = contract.get("inputs").and_then(Value::as_object).ok_or("reviewed inputs missing")?;
    if inputs.is_empty() { return Err("reviewed inputs empty".into()); }
    let mut paths = std::collections::BTreeSet::new();
    for (name, expected) in inputs {
        let expected = expected.as_str().ok_or("invalid reviewed input digest")?;
        if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err("invalid reviewed input digest".into());
        }
        let path = owned(&root, name)?;
        if !paths.insert(path.clone()) { return Err("duplicate reviewed source alias".into()); }
        let actual = format!("{:x}", Sha256::digest(std::fs::read(path)?));
        if actual != expected { return Err("reviewed input changed".into()); }
    }
    for key in ["manifest", "native"] {
        let name = contract.get(key).and_then(Value::as_str).ok_or("reviewed source identity missing")?;
        if !paths.contains(&owned(&root, name)?) { return Err("reviewed source identity not in inputs".into()); }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn source_preflight_rechecks_files_and_ownership() {
        let root = std::env::temp_dir().join(format!("iotplace-source-preflight-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let manifest = root.join("review.json");
        let native = root.join("board.kicad_pcb");
        std::fs::write(&manifest, b"review").unwrap();
        std::fs::write(&native, b"board").unwrap();
        let digest = |bytes: &[u8]| format!("{:x}", Sha256::digest(bytes));
        let mut c = json!({"root":root, "manifest":manifest, "native":native,
            "inputs":{"review.json":digest(b"review"),"board.kicad_pcb":digest(b"board")}});
        assert!(check_inputs(&c).is_ok());
        std::fs::write(&manifest, b"changed").unwrap();
        assert!(check_inputs(&c).is_err());
        c["inputs"]["review.json"] = json!(digest(b"changed"));
        let outside = root.with_extension("outside");
        std::fs::write(&outside, b"outside").unwrap();
        #[cfg(unix)] {
            std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
            c["inputs"]["link"] = json!(digest(b"outside"));
            assert!(check_inputs(&c).is_err());
        }
        std::fs::remove_file(outside).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}

/// Check the model and contract's self-declared fingerprints. These detect accidental
/// mutation but cannot establish that a review was performed; input is untrusted.
fn check_payload_bindings(problem: &Value) -> crate::Result<()> {
    use serde_json::{Map, json};
    fn hash(value: &Value) -> crate::Result<String> {
        let bytes = serde_json::to_vec(value)?;
        // Python's fingerprint escapes non-ASCII; reject it until matching canonicalization
        // is implemented. Differences in number formatting also fail closed at comparison.
        if !bytes.is_ascii() { return Err("non-ASCII reviewed fingerprint unsupported".into()); }
        Ok(format!("{:x}", Sha256::digest(bytes)))
    }
    let contract = problem.get("engineering").and_then(Value::as_object).ok_or("reviewed contract missing")?;
    let mut core = Map::new();
    for key in ["schema", "root", "board", "manifest", "native", "inputs", "rules", "geometry", "bindings"] {
        core.insert(key.into(), contract.get(key).ok_or("reviewed contract field missing")?.clone());
    }
    if contract.get("review_sha256").and_then(Value::as_str) != Some(hash(&Value::Object(core))?.as_str()) {
        return Err("reviewed contract fingerprint changed".into());
    }
    let units = problem.get("units").and_then(Value::as_array).ok_or("model units missing")?;
    let mut anchors = Vec::new();
    for u in units {
        let mut item = Map::new();
        for key in ["name", "refs", "x", "y", "fixed"] {
            item.insert(key.into(), u.get(key).cloned().unwrap_or(Value::Null));
        }
        anchors.push(Value::Object(item));
    }
    let outline = problem.get("board").and_then(|b| b.get("outline")).ok_or("model outline missing")?;
    let anchor = json!({"units": anchors, "outline": outline});
    if contract.get("model_anchor_sha256").and_then(Value::as_str) != Some(hash(&anchor)?.as_str()) {
        return Err("reviewed model anchors changed".into());
    }
    Ok(())
}

#[cfg(test)]
mod binding_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn checks_contract_and_anchor_without_claiming_authenticity() {
        let mut p = json!({"units":[{"name":"U1","refs":["U1"],"x":1,"y":2,"fixed":false}],
            "board":{"outline":[[0,0],[10,0],[10,10]]},
            "engineering":{"schema":"x","root":"r","board":"b","manifest":"m","native":"n",
                "inputs":{},"rules":[],"geometry":{},"bindings":[]}});
        let c = &p["engineering"];
        let digest = |v: &Value| format!("{:x}", Sha256::digest(serde_json::to_vec(v).unwrap()));
        let review = digest(c);
        let anchor = digest(&json!({"units":p["units"],"outline":p["board"]["outline"]}));
        p["engineering"]["review_sha256"] = json!(review);
        p["engineering"]["model_anchor_sha256"] = json!(anchor);
        assert!(check_payload_bindings(&p).is_ok());
        let mut edited = p.clone();
        edited["units"][0]["x"] = json!(3);
        assert!(check_payload_bindings(&edited).is_err());
        p["engineering"]["board"] = json!("other");
        assert!(check_payload_bindings(&p).is_err());
    }
}

/// Validate the manifest's review identity and self-binding. The caller must still
/// reconstruct the native part population, bindings, ratings, budgets and rule sources.
fn check_manifest_identity(contract: &Value) -> crate::Result<()> {
    let root = Path::new(contract.get("root").and_then(Value::as_str).ok_or("reviewed root missing")?).canonicalize()?;
    let manifest_name = contract.get("manifest").and_then(Value::as_str).ok_or("reviewed manifest missing")?;
    let manifest_path = owned(&root, manifest_name)?;
    let bytes = std::fs::read(manifest_path)?;
    let mut manifest: Value = serde_json::from_slice(&bytes)?;
    let object = manifest.as_object_mut().ok_or("manifest must be an object")?;
    let allowed = ["schema", "board", "revision", "project", "spec", "review", "parts", "budgets"];
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("unsupported reviewed manifest fields".into());
    }
    if object.get("schema").and_then(Value::as_str) != Some("iot-lab.part-use.v1") ||
        object.get("board") != contract.get("board") ||
        object.get("revision").and_then(Value::as_str).is_none_or(|s| s.is_empty()) ||
        object.get("project").and_then(Value::as_str).is_none_or(|s| s.is_empty()) ||
        object.get("parts").and_then(Value::as_array).is_none_or(|a| a.is_empty()) {
        return Err("reviewed manifest identity or population missing".into());
    }
    let review = object.remove("review").ok_or("manifest review missing")?;
    if review.get("verdict").and_then(Value::as_str) != Some("passed") ||
        review.get("reviewer").and_then(Value::as_str).is_none_or(|s| s.trim().is_empty()) ||
        review.get("reviewed_at_utc").and_then(Value::as_str).is_none_or(|s| s.trim().is_empty()) {
        return Err("attributable reviewed manifest required".into());
    }
    let encoded = serde_json::to_vec(&manifest)?;
    let digest = format!("{:x}", Sha256::digest(encoded));
    if review.get("facts_sha256").and_then(Value::as_str) != Some(&digest) {
        return Err("reviewed manifest facts changed".into());
    }
    Ok(())
}

#[cfg(test)]
mod manifest_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn manifest_review_binds_its_actual_facts() {
        let root = std::env::temp_dir().join(format!("iotplace-review-header-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("manifest.json");
        let mut manifest = json!({"schema":"iot-lab.part-use.v1", "board":"A", "revision":"1",
            "project":"board.kicad_pro", "parts":[{"reference":"U1"}]});
        let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&manifest).unwrap()));
        manifest["review"] = json!({"verdict":"passed","reviewer":"R", "reviewed_at_utc":"2026-01-01T00:00:00Z", "facts_sha256":digest});
        std::fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        let contract = json!({"root":root,"manifest":path,"board":"A"});
        assert!(check_manifest_identity(&contract).is_ok());
        manifest["parts"][0]["reference"] = json!("U2");
        std::fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(check_manifest_identity(&contract).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
