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
