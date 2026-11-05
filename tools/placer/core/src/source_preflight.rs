//! File integrity checks for reviewed source inputs. This is a necessary preflight,
//! not verification that the manifest, evidence, or native board constitutes a review.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

fn owned(root: &Path, name: &str) -> crate::Result<PathBuf> {
    let p = Path::new(name);
    if p.components().any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::CurDir)) {
        return Err("unsafe reviewed input path".into());
    }
    let path = if p.is_absolute() { p.to_path_buf() } else { root.join(p) };
    if !path.starts_with(root) { return Err("reviewed input outside source root".into()); }
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
        let root = root.canonicalize().unwrap();
        let manifest = root.join("review.json");
        let native = root.join("board.kicad_pcb");
        std::fs::write(&manifest, b"review").unwrap();
        std::fs::write(&native, b"board").unwrap();
        std::fs::create_dir_all(root.join("hardware-design/boards/A")).unwrap();
        std::fs::write(root.join("hardware-design/boards/A/spec.md"), b"spec").unwrap();
        std::fs::write(root.join("review.md"), b"review").unwrap();
        std::fs::write(root.join("doc.pdf"), b"synthetic").unwrap();
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

fn timestamp_with_zone(s: &str) -> bool {
    if !s.is_ascii() { return false; }
    let bytes = s.as_bytes();
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' || bytes[13] != b':' || bytes[16] != b':' { return false; }
    let parse = |start: usize, end: usize| -> Option<u32> { s.get(start..end)?.parse().ok() };
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) =
        (parse(0,4),parse(5,7),parse(8,10),parse(11,13),parse(14,16),parse(17,19)) else { return false };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {1|3|5|7|8|10|12=>31,4|6|9|11=>30,2 if leap=>29,2=>28,_=>return false};
    if year == 0 || day == 0 || day > days || hour > 23 || minute > 59 || second > 59 { return false; }
    let mut rest = &s[19..];
    if rest.starts_with('.') {
        let n = rest[1..].bytes().take_while(u8::is_ascii_digit).count();
        if n == 0 { return false; }
        rest = &rest[n+1..];
    }
    if rest == "Z" { return true; }
    let b = rest.as_bytes();
    b.len()==6 && matches!(b[0],b'+'|b'-') && b[3]==b':' &&
        rest[1..3].parse::<u32>().is_ok_and(|v| v<=23) && rest[4..6].parse::<u32>().is_ok_and(|v| v<=59)
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
        review.get("reviewed_at_utc").and_then(Value::as_str).is_none_or(|s| !timestamp_with_zone(s)) {
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
        let root = root.canonicalize().unwrap();
        let path = root.join("manifest.json");
        let mut manifest = json!({"schema":"iot-lab.part-use.v1", "board":"A", "revision":"1",
            "project":"board.kicad_pro", "parts":[{"reference":"U1"}]});
        let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&manifest).unwrap()));
        manifest["review"] = json!({"verdict":"passed","reviewer":"R", "reviewed_at_utc":"2026-01-01T00:00:00Z", "facts_sha256":digest});
        std::fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        let contract = json!({"root":root,"manifest":path,"board":"A"});
        assert!(check_manifest_identity(&contract).is_ok());
        manifest["review"]["reviewed_at_utc"] = json!("not-a-time");
        std::fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(check_manifest_identity(&contract).is_err());
        manifest["review"]["reviewed_at_utc"] = json!("2026-01-01T00:00:00Z");
        manifest["parts"][0]["reference"] = json!("U2");
        std::fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(check_manifest_identity(&contract).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}

/// Validate rating and applicability envelopes. Source attribution, native asset
/// identity and budget coverage remain separate, mandatory verification steps.
fn check_rating_ranges(manifest: &Value) -> crate::Result<()> {
    fn interval(v: &Value) -> crate::Result<(&str, f64, f64)> {
        let unit = v.get("unit").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or("rating unit missing")?;
        let min = v.get("min").and_then(Value::as_f64).ok_or("rating minimum missing")?;
        let max = v.get("max").and_then(Value::as_f64).ok_or("rating maximum missing")?;
        if !min.is_finite() || !max.is_finite() || min > max || !v.get("source").is_some_and(Value::is_object) {
            return Err("invalid sourced rating interval".into());
        }
        Ok((unit, min, max))
    }
    fn contains(limit: &Value, required: &Value) -> crate::Result<()> {
        let (a, lo, hi) = interval(limit)?;
        let (b, need_lo, need_hi) = interval(required)?;
        if a != b || need_lo < lo || need_hi > hi { return Err("required interval exceeds rating".into()); }
        Ok(())
    }
    let parts = manifest.get("parts").and_then(Value::as_array).filter(|a| !a.is_empty()).ok_or("reviewed parts missing")?;
    for part in parts {
        if part.get("profile").is_some() { return Err("profile expansion not yet supported".into()); }
        let ratings = part.get("ratings").and_then(Value::as_array).filter(|a| !a.is_empty()).ok_or("reviewed ratings missing")?;
        let mut ids = std::collections::BTreeSet::new();
        for rating in ratings {
            let id = rating.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or("rating ID missing")?;
            if !ids.insert(id) || rating.get("quantity").and_then(Value::as_str).is_none_or(|s| s.is_empty()) {
                return Err("duplicate rating or missing quantity".into());
            }
            contains(&rating["limit"], &rating["required"])?;
            let conditions = rating.get("conditions").and_then(Value::as_array).ok_or("rating conditions missing")?;
            for condition in conditions {
                if condition.get("quantity").and_then(Value::as_str).is_none_or(|s| s.is_empty()) {
                    return Err("rating condition quantity missing".into());
                }
                contains(&condition["valid"], &condition["required"])?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod rating_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn sourced_rating_and_conditions_cover_use() {
        let interval = |min, max, unit| json!({"min":min,"max":max,"unit":unit,"source":{}});
        let mut m = json!({"parts":[{"ratings":[{"id":"voltage","quantity":"V",
            "limit":interval(0, 12, "V"),"required":interval(4, 5, "V"),
            "conditions":[{"quantity":"temperature","valid":interval(-40,85,"C"),"required":interval(0,60,"C")}]}]}]});
        assert!(check_rating_ranges(&m).is_ok());
        m["parts"][0]["ratings"][0]["conditions"][0]["required"]["max"] = json!(90);
        assert!(check_rating_ranges(&m).is_err());
        m["parts"][0]["ratings"][0]["conditions"][0]["required"]["max"] = json!(60);
        m["parts"][0]["ratings"][0]["required"]["unit"] = json!("A");
        assert!(check_rating_ranges(&m).is_err());
    }
}

/// Run the available checks without granting reviewed-model admission.
/// The caller must treat success as partial evidence only.
pub fn preflight(problem: &Value) -> crate::Result<()> {
    check_payload_bindings(problem)?;
    preflight_relocated(problem, None)
}

fn preflight_relocated(problem: &Value, inspector: Option<(&Path, &str)>) -> crate::Result<()> {
    let contract = problem.get("engineering").ok_or("reviewed contract missing")?;
    if contract.get("schema").and_then(Value::as_str) != Some("iot-lab.engineering-constraints.v1") {
        return Err("unsupported reviewed contract schema".into());
    }
    let root = Path::new(contract.get("root").and_then(Value::as_str).ok_or("reviewed root missing")?).canonicalize()?;
    let native = owned(&root, contract.get("native").and_then(Value::as_str).ok_or("reviewed native board missing")?)?;
    let board_file = owned(&root, problem.get("board_file").and_then(Value::as_str).ok_or("placement source board missing")?)?;
    if native != board_file { return Err("placement source board differs from reviewed board".into()); }
    check_inputs(contract)?;
    check_manifest_identity(contract)?;
    let root = Path::new(contract["root"].as_str().ok_or("reviewed root missing")?).canonicalize()?;
    let path = owned(&root, contract["manifest"].as_str().ok_or("reviewed manifest missing")?)?;
    let manifest: Value = serde_json::from_slice(&std::fs::read(path)?)?;
    check_part_metadata(&manifest)?;
    check_rating_ranges(&manifest)?;
    check_manifest_sources(contract, &manifest, inspector)?;
    check_rule_sources(contract, &manifest)?;
    // Recheck after evaluation to catch changed source files.
    check_inputs(contract)?;
    Ok(())
}

#[cfg(test)]
mod preflight_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn runs_partial_source_preflight_and_detects_changed_board() {
        let root = std::env::temp_dir().join(format!("iotplace-preflight-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let native = root.join("board.kicad_pcb");
        let manifest_path = root.join("manifest.json");
        std::fs::write(&native, b"board").unwrap();
        std::fs::create_dir_all(root.join("hardware-design/boards/A")).unwrap();
        std::fs::write(root.join("hardware-design/boards/A/spec.md"), b"spec").unwrap();
        std::fs::write(root.join("review.md"), b"review").unwrap();
        std::fs::write(root.join("doc.pdf"), b"synthetic").unwrap();
        let digest = |v: &[u8]| format!("{:x}", Sha256::digest(v));
        let spec = json!({"path":"hardware-design/boards/A/spec.md","sha256":digest(b"spec"),"section":"use"});
        let doc = json!({"path":"doc.pdf","sha256":digest(b"synthetic"),"page":1,"document_id":"D","revision":"A"});
        let evidence = json!({"path":"review.md","sha256":digest(b"review"),"section":"review"});
        let mut manifest = json!({"schema":"iot-lab.part-use.v1","board":"A","revision":"1","project":"board.kicad_pro","spec":spec,
            "parts":[{"reference":"U1","mpn":"P","lcsc":"C123","manufacturer":"M","package":{"name":"QFN","variant":"A"},"unresolved":[],"layout_constraints":[],"datasheets":[doc],"assembly_dependencies":[],"ratings":[{"id":"r","quantity":"voltage",
                "limit":{"min":0,"max":10,"unit":"V","source":doc},
                "required":{"min":0,"max":5,"unit":"V","source":spec},"conditions":[]}]}],
            "budgets":[{"net":"VCC","limit":{"min":0,"max":2,"unit":"A","source":spec},
                "loads":[{"reference":"U1","required":{"min":0,"max":1,"unit":"A","source":spec}}]}]});
        let facts = digest(&serde_json::to_vec(&manifest).unwrap());
        manifest["review"] = json!({"verdict":"passed","reviewer":"R","reviewed_at_utc":"2026-01-01T00:00:00Z","facts_sha256":facts,"evidence":evidence});
        let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
        std::fs::write(&manifest_path, &manifest_bytes).unwrap();
        let mut problem = json!({"units":[{"name":"U1","refs":["U1"],"x":1,"y":2,"fixed":false}],
            "board":{"outline":[[0,0],[10,0],[10,10]]},"board_file":native,
            "engineering":{"schema":"iot-lab.engineering-constraints.v1","root":root,"board":"A","manifest":manifest_path,"native":native,
                "inputs":{"board.kicad_pcb":digest(b"board"),"manifest.json":digest(&manifest_bytes),
                    "hardware-design/boards/A/spec.md":digest(b"spec"),"review.md":digest(b"review"),"doc.pdf":digest(b"synthetic")},
                "rules":[],"geometry":{},"bindings":[]}});
        let review = digest(&serde_json::to_vec(&problem["engineering"]).unwrap());
        let anchor = digest(&serde_json::to_vec(&json!({"units":problem["units"],"outline":problem["board"]["outline"]})).unwrap());
        problem["engineering"]["review_sha256"] = json!(review);
        problem["engineering"]["model_anchor_sha256"] = json!(anchor);
        assert!(preflight(&problem).is_ok());
        let population = json!({"parts":{"U1":{"required":true,"pad_net_map":{"1":"VCC"}}}});
        assert!(preflight_with_native(&problem, &population).is_ok());
        let incomplete = json!({"parts":{"U1":{"required":true,"pad_net_map":{"1":"OTHER"}}}});
        assert!(preflight_with_native(&problem, &incomplete).is_err());
        let mut remote = problem.clone();
        remote["board_file"] = json!("/offline/source/board.kicad_pcb");
        remote["engineering"]["root"] = json!("/offline/source");
        remote["engineering"]["native"] = json!("/offline/source/board.kicad_pcb");
        remote["engineering"]["manifest"] = json!("/offline/source/manifest.json");
        let mut core = remote["engineering"].clone();
        core.as_object_mut().unwrap().remove("review_sha256");
        core.as_object_mut().unwrap().remove("model_anchor_sha256");
        remote["engineering"]["review_sha256"] = json!(digest(&serde_json::to_vec(&core).unwrap()));
        assert!(preflight_snapshot(&remote, &root, Some(&population)).is_ok());
        remote["board_file"] = json!("/outside/board.kicad_pcb");
        assert!(preflight_snapshot(&remote, &root, None).is_err());
        std::fs::write(native, b"changed").unwrap();
        assert!(preflight(&problem).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}

/// Check that the normalized rule list exactly matches unprofiled manifest rules and
/// that each rule cites an unchanged owned document. PDF page existence, profiles,
/// native geometry and bound blocks still need independent verification.
fn check_rule_sources(contract: &Value, manifest: &Value) -> crate::Result<()> {
    let root = Path::new(contract["root"].as_str().ok_or("reviewed root missing")?).canonicalize()?;
    let inputs = contract["inputs"].as_object().ok_or("reviewed inputs missing")?;
    let mut verified_inputs = std::collections::BTreeMap::new();
    for (name, digest) in inputs {
        verified_inputs.insert(owned(&root, name)?, digest.as_str().ok_or("invalid input hash")?);
    }
    let mut source_rules = std::collections::BTreeMap::new();
    for part in manifest["parts"].as_array().ok_or("reviewed parts missing")? {
        if part.get("profile").is_some() { return Err("profile expansion not yet supported".into()); }
        for rule in part["layout_constraints"].as_array().ok_or("layout constraint list missing")? {
            let id = rule["id"].as_str().filter(|s| !s.is_empty()).ok_or("reviewed rule ID missing")?;
            if source_rules.insert(id, rule).is_some() { return Err("duplicate reviewed rule ID".into()); }
        }
    }
    let rules = contract["rules"].as_array().ok_or("reviewed rules missing")?;
    if rules.len() != source_rules.len() { return Err("reviewed rule coverage differs from manifest".into()); }
    let mut seen = std::collections::BTreeSet::new();
    for rule in rules {
        let id = rule["id"].as_str().filter(|s| !s.is_empty()).ok_or("reviewed rule ID missing")?;
        if !seen.insert(id) || source_rules.get(id) != Some(&rule) || rule.get("binding").is_some() {
            return Err("reviewed rule differs from manifest or requires unsupported binding".into());
        }
        match rule["kind"].as_str() {
            Some("fixed" | "rigid_group" | "pin_distance" | "clearance" | "connector_access") => (),
            _ => return Err("unsupported reviewed rule kind".into()),
        }
        let source = &rule["source"];
        if source["page"].as_u64().is_none_or(|v| v == 0) { return Err("reviewed rule source page missing".into()); }
        let path = owned(&root, source["path"].as_str().ok_or("reviewed rule source path missing")?)?;
        let expected = source["sha256"].as_str().ok_or("reviewed rule source hash missing")?;
        if verified_inputs.get(&path).copied() != Some(expected) ||
            format!("{:x}", Sha256::digest(std::fs::read(path)?)) != expected {
            return Err("reviewed rule source changed or absent from inputs".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod rule_source_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn rule_sources_must_match_manifest_and_owned_input() {
        let root = std::env::temp_dir().join(format!("iotplace-rule-source-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let doc = root.join("doc.pdf");
        std::fs::write(&doc, b"doc").unwrap();
        let hash = format!("{:x}", Sha256::digest(b"doc"));
        let rule = json!({"id":"r","kind":"fixed","refs":["U1"],"source":{"path":"doc.pdf","sha256":hash,"page":1}});
        let manifest = json!({"parts":[{"layout_constraints":[rule.clone()]}]});
        let mut contract = json!({"root":root,"inputs":{"doc.pdf":hash},"rules":[rule]});
        assert!(check_rule_sources(&contract, &manifest).is_ok());
        contract["rules"][0]["refs"] = json!(["U2"]);
        assert!(check_rule_sources(&contract, &manifest).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}

/// Validate worst-case net budgets against an independently reconstructed native
/// population. Source locators still need the review's document verification.
fn check_budget_coverage(manifest: &Value, native_parts: &Value) -> crate::Result<()> {
    use std::collections::BTreeSet;
    fn required(v: &Value) -> crate::Result<(&str, f64, f64)> {
        let unit = v["unit"].as_str().filter(|s| !s.is_empty()).ok_or("budget unit missing")?;
        let min = v["min"].as_f64().ok_or("budget minimum missing")?;
        let max = v["max"].as_f64().ok_or("budget maximum missing")?;
        if !min.is_finite() || !max.is_finite() || min > max || !v["source"].is_object() {
            return Err("invalid sourced budget interval".into());
        }
        Ok((unit,min,max))
    }
    let parts = native_parts.as_object().ok_or("native part population missing")?;
    let budgets = manifest.get("budgets").map_or(Some(&[][..]), |v| v.as_array().map(Vec::as_slice))
        .ok_or("budget list invalid")?;
    for budget in budgets {
        let net = budget["net"].as_str().filter(|s| !s.is_empty()).ok_or("budget net missing")?;
        let (unit, _, limit) = required(&budget["limit"])?;
        if !matches!(unit, "A" | "W") { return Err("unsupported budget unit".into()); }
        let mut connected = BTreeSet::new();
        for (reference, part) in parts {
            if part["required"].as_bool().ok_or("native required flag missing")? {
                let nets = part["pad_net_map"].as_object().ok_or("native pad net map missing")?;
                if nets.values().any(|n| n.as_str() == Some(net)) { connected.insert(reference.as_str()); }
            }
        }
        if connected.is_empty() { return Err("budget net has no connected required parts".into()); }
        let mut loads = BTreeSet::new();
        let mut excluded = BTreeSet::new();
        let mut total = 0.0;
        for load in budget["loads"].as_array().ok_or("budget loads missing")? {
            let reference = load["reference"].as_str().ok_or("budget load reference missing")?;
            let (load_unit, lo, hi) = required(&load["required"])?;
            if !connected.contains(reference) || !loads.insert(reference) || load_unit != unit || lo < 0.0 {
                return Err("invalid budget load".into());
            }
            total += hi;
        }
        if !total.is_finite() || total > limit { return Err("budget exceeded".into()); }
        let exclusions = budget.get("exclusions").map_or(Some(&[][..]), |v| v.as_array().map(Vec::as_slice))
            .ok_or("budget exclusions invalid")?;
        for exclusion in exclusions {
            let reference = exclusion["reference"].as_str().ok_or("budget exclusion reference missing")?;
            if !connected.contains(reference) || !excluded.insert(reference) || loads.contains(reference) ||
                exclusion["reason"].as_str().is_none_or(|s| s.is_empty()) || !exclusion["source"].is_object() {
                return Err("invalid budget exclusion".into());
            }
        }
        if loads.union(&excluded).copied().collect::<BTreeSet<_>>() != connected {
            return Err("budget net coverage incomplete".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod budget_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn budgets_cover_native_net_and_worst_case() {
        let interval = |max| json!({"min":0,"max":max,"unit":"A","source":{}});
        let native = json!({"U1":{"required":true,"pad_net_map":{"1":"VCC"}},
            "U2":{"required":true,"pad_net_map":{"2":"VCC"}}});
        let mut manifest = json!({"budgets":[{"net":"VCC","limit":interval(2),"loads":[
            {"reference":"U1","required":interval(1)}, {"reference":"U2","required":interval(1)}]}]});
        assert!(check_budget_coverage(&manifest, &native).is_ok());
        manifest["budgets"][0]["loads"][1]["required"]["max"] = json!(2);
        assert!(check_budget_coverage(&manifest, &native).is_err());
        manifest["budgets"][0]["loads"] = json!([{"reference":"U1","required":interval(1)}]);
        assert!(check_budget_coverage(&manifest, &native).is_err());
        manifest["budgets"][0]["exclusions"] = json!([{"reference":"U2","reason":"no load","source":{}}]);
        assert!(check_budget_coverage(&manifest, &native).is_ok());
    }
}

/// Additional partial budget checks against a caller-supplied native snapshot population.
/// The caller must establish snapshot authenticity separately; success grants no admission.
pub fn preflight_with_native(problem: &Value, population: &Value) -> crate::Result<()> {
    preflight(problem)?;
    let contract = &problem["engineering"];
    let root = Path::new(contract["root"].as_str().ok_or("reviewed root missing")?).canonicalize()?;
    let manifest = owned(&root, contract["manifest"].as_str().ok_or("reviewed manifest missing")?)?;
    let value: Value = serde_json::from_slice(&std::fs::read(manifest)?)?;
    check_budget_coverage(&value, &population["parts"])?;
    check_inputs(contract)?;
    Ok(())
}

/// Check a relocated immutable snapshot while retaining fingerprint validation against
/// the original model bytes. Snapshot source authenticity remains the caller's responsibility.
pub fn preflight_snapshot(problem: &Value, snapshot_root: &Path, population: Option<&Value>) -> crate::Result<()> {
    preflight_snapshot_with_pdf(problem, snapshot_root, population, None)
}

/// Like `preflight_snapshot`, additionally checks actual pages with a pinned inspector.
pub fn preflight_snapshot_with_pdf(problem: &Value, snapshot_root: &Path, population: Option<&Value>,
    inspector: Option<(&Path, &str)>) -> crate::Result<()> {
    use std::path::Component;
    check_payload_bindings(problem)?;
    let root = problem["engineering"]["root"].as_str().ok_or("reviewed root missing")?;
    let original = Path::new(root);
    if !original.is_absolute() || original.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
        return Err("invalid original source root".into());
    }
    let snapshot = snapshot_root.canonicalize()?;
    let map_path = |name: &str| -> crate::Result<String> {
        let path = Path::new(name);
        if path.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
            return Err("unsafe reviewed snapshot path".into());
        }
        let relative = if path.is_absolute() { path.strip_prefix(original).map_err(|_| "reviewed source outside original root")? } else { path };
        if relative.as_os_str().is_empty() { return Err("empty reviewed snapshot path".into()); }
        Ok(snapshot.join(relative).to_str().ok_or("non-UTF8 snapshot path")?.to_owned())
    };
    let mut relocated = problem.clone();
    let board_file = map_path(problem["board_file"].as_str().ok_or("placement source board missing")?)?;
    let native = map_path(problem["engineering"]["native"].as_str().ok_or("reviewed native missing")?)?;
    let manifest = map_path(problem["engineering"]["manifest"].as_str().ok_or("reviewed manifest missing")?)?;
    let mut inputs = serde_json::Map::new();
    for (name, hash) in problem["engineering"]["inputs"].as_object().ok_or("reviewed inputs missing")? {
        if inputs.insert(map_path(name)?, hash.clone()).is_some() { return Err("duplicate snapshot input".into()); }
    }
    relocated["board_file"] = board_file.into();
    relocated["engineering"]["root"] = snapshot.to_str().ok_or("non-UTF8 snapshot path")?.into();
    relocated["engineering"]["native"] = native.into();
    relocated["engineering"]["manifest"] = manifest.into();
    relocated["engineering"]["inputs"] = Value::Object(inputs);
    preflight_relocated(&relocated, inspector)?;
    if let Some(population) = population {
        let contract = &relocated["engineering"];
        let manifest_path = owned(&snapshot, contract["manifest"].as_str().ok_or("manifest missing")?)?;
        let manifest: Value = serde_json::from_slice(&std::fs::read(manifest_path)?)?;
        check_budget_coverage(&manifest, &population["parts"])?;
        check_inputs(contract)?;
    }
    Ok(())
}

/// Verify manifest evidence references are owned, present in the bound input set,
/// and unchanged. PDF page existence and native facts still require separate checks.
fn check_manifest_sources(contract: &Value, manifest: &Value, inspector: Option<(&Path, &str)>) -> crate::Result<()> {
    let root = Path::new(contract["root"].as_str().ok_or("reviewed root missing")?).canonicalize()?;
    let inputs = contract["inputs"].as_object().ok_or("reviewed inputs missing")?;
    let mut sources = std::collections::BTreeMap::new();
    for (name, hash) in inputs { sources.insert(owned(&root,name)?, hash.as_str().ok_or("invalid input hash")?); }
    let source = |v: &Value, pdf: bool| -> crate::Result<std::path::PathBuf> {
        let name = v["path"].as_str().ok_or("source path missing")?;
        if Path::new(name).is_absolute() || name.contains('\\') || name.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
            return Err("evidence path must be repository-relative".into());
        }
        let expected = v["sha256"].as_str().ok_or("source hash missing")?;
        let path = owned(&root,name)?;
        if sources.get(&path).copied() != Some(expected) || format!("{:x}", Sha256::digest(std::fs::read(&path)?)) != expected {
            return Err("evidence source changed or absent".into());
        }
        let is_pdf = pdf || path.extension().and_then(|s| s.to_str()).is_some_and(|s| s.eq_ignore_ascii_case("pdf"));
        if is_pdf {
            let page = v["page"].as_u64().filter(|p| *p != 0).ok_or("PDF page locator missing")?;
            if let Some((tool,hash)) = inspector { verify_pdf_page(&path, page, tool, hash)?; }
        } else if v["section"].as_str().is_none_or(|s| s.trim().is_empty()) {
            return Err("evidence section locator missing".into());
        }
        Ok(path)
    };
    let board = contract["board"].as_str().ok_or("board identity missing")?;
    if board.is_empty() || !board.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'-') {
        return Err("invalid board identity".into());
    }
    let prefix = format!("hardware-design/boards/{board}/");
    let check_board_source = |v: &Value| -> crate::Result<()> {
        let name = v["path"].as_str().ok_or("board source missing")?;
        if !name.starts_with(&prefix) { return Err("source belongs to another board".into()); }
        source(v,false)?; Ok(())
    };
    check_board_source(&manifest["spec"])?;
    source(&manifest["review"]["evidence"], false)?;
    let parts = manifest["parts"].as_array().ok_or("reviewed parts missing")?;
    for part in parts {
        if part.get("profile").is_some() { return Err("profile sources unsupported".into()); }
        let docs = part["datasheets"].as_array().filter(|v| !v.is_empty()).ok_or("datasheets missing")?;
        let mut doc_ids = std::collections::BTreeSet::new();
        for doc in docs {
            if doc["document_id"].as_str().is_none_or(|s| s.is_empty()) || doc["revision"].as_str().is_none_or(|s| s.is_empty()) {
                return Err("datasheet identity missing".into());
            }
            let path = source(doc,true)?;
            doc_ids.insert((path, doc["sha256"].as_str().ok_or("datasheet hash missing")?.to_owned()));
        }
        let check_interval = |limit: &Value, required: &Value| -> crate::Result<()> {
            let doc = source(&limit["source"],false)?;
            let hash = limit["source"]["sha256"].as_str().ok_or("rating source hash missing")?;
            if !doc_ids.contains(&(doc,hash.to_owned())) { return Err("rating source is not the exact datasheet".into()); }
            check_board_source(&required["source"])?;
            Ok(())
        };
        for rating in part["ratings"].as_array().ok_or("ratings missing")? {
            check_interval(&rating["limit"], &rating["required"])?;
            for condition in rating["conditions"].as_array().ok_or("rating conditions missing")? {
                check_interval(&condition["valid"], &condition["required"])?;
            }
        }
        for dep in part["assembly_dependencies"].as_array().ok_or("assembly dependencies missing")? {source(&dep["source"],false)?;}
    }
    for budget in manifest.get("budgets").map_or(Some(&[][..]), |v| v.as_array().map(Vec::as_slice)).ok_or("budget list invalid")? {
        source(&budget["limit"]["source"],false)?;
        for load in budget["loads"].as_array().ok_or("budget loads missing")? { source(&load["required"]["source"],false)?; }
        for exclusion in budget.get("exclusions").map_or(Some(&[][..]), |v| v.as_array().map(Vec::as_slice)).ok_or("budget exclusions invalid")? {
            source(&exclusion["source"],false)?;
        }
    }
    if let Some((tool,hash)) = inspector {
        for rule in contract["rules"].as_array().ok_or("reviewed rules missing")? {
            let source = &rule["source"];
            let path = owned(&root, source["path"].as_str().ok_or("rule source missing")?)?;
            if path.extension().and_then(|s| s.to_str()).is_some_and(|s| s.eq_ignore_ascii_case("pdf")) {
                verify_pdf_page(&path, source["page"].as_u64().ok_or("rule page missing")?, tool, hash)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod evidence_source_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn evidence_sources_bind_exact_datasheet_and_board_use() {
        let root = std::env::temp_dir().join(format!("iotplace-evidence-{}",std::process::id()));
        let board_dir = root.join("hardware-design/boards/X");
        std::fs::create_dir_all(&board_dir).unwrap();
        let root = root.canonicalize().unwrap();
        for (path, bytes) in [("hardware-design/boards/X/spec.md",&b"spec"[..]),("review.md",&b"review"[..]),("doc.pdf",&b"pdf"[..])] {
            std::fs::write(root.join(path),bytes).unwrap();
        }
        let h = |bytes:&[u8]| format!("{:x}",Sha256::digest(bytes));
        let spec = json!({"path":"hardware-design/boards/X/spec.md","sha256":h(b"spec"),"section":"load"});
        let review = json!({"path":"review.md","sha256":h(b"review"),"section":"review"});
        let doc = json!({"path":"doc.pdf","sha256":h(b"pdf"),"page":1,"document_id":"D","revision":"A"});
        let manifest = json!({"spec":spec,"review":{"evidence":review},"parts":[{"datasheets":[doc.clone()],
            "ratings":[{"limit":{"source":doc},"required":{"source":spec},"conditions":[]}],"assembly_dependencies":[]}]});
        let contract = json!({"root":root,"board":"X","inputs":{"hardware-design/boards/X/spec.md":h(b"spec"),"review.md":h(b"review"),"doc.pdf":h(b"pdf")}});
        assert!(check_manifest_sources(&contract,&manifest,None).is_ok());
        if let Ok(tool) = std::env::var("IOTPLACE_TEST_PDFINFO") {
            let tool = Path::new(&tool).canonicalize().unwrap();
            let hash = format!("{:x}",Sha256::digest(std::fs::read(&tool).unwrap()));
            assert!(check_manifest_sources(&contract,&manifest,Some((&tool,&hash))).is_err());
        }
        std::fs::write(root.join("doc.pdf"),b"changed").unwrap();
        assert!(check_manifest_sources(&contract,&manifest,None).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}

/// Verify a PDF page with an independently pinned `pdfinfo` executable. This
/// checks the page exists; it does not interpret the content as an engineering fact.
pub fn verify_pdf_page(document: &Path, page: u64, tool: &Path, tool_sha256: &str) -> crate::Result<()> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    if page == 0 || !tool.is_absolute() || tool_sha256.len() != 64 ||
        !tool_sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("invalid PDF inspection arguments".into());
    }
    let hash = |path:&Path| -> crate::Result<String> { Ok(format!("{:x}",Sha256::digest(std::fs::read(path)?))) };
    if hash(tool)? != tool_sha256 { return Err("PDF inspection tool identity changed".into()); }
    let before = hash(document)?;
    let mut child = Command::new(tool).arg(document).env("LC_ALL","C").stdout(Stdio::piped()).stderr(Stdio::null()).spawn()?;
    let stdout = child.stdout.take().ok_or("PDF inspector output missing")?;
    let reader = std::thread::spawn(move || {
        let mut bytes=Vec::new();
        stdout.take(65537).read_to_end(&mut bytes).map(|_|bytes)
    });
    let end=Instant::now()+Duration::from_secs(30);
    let status = loop {
        if let Some(status)=child.try_wait()? {break status;}
        if Instant::now()>=end {let _=child.kill(); let _=child.wait(); return Err("PDF inspection timed out".into());}
        std::thread::sleep(Duration::from_millis(10));
    };
    let output=reader.join().map_err(|_| "PDF inspector output failed")??;
    if !status.success() || output.len()>65536 || hash(tool)? != tool_sha256 || hash(document)? != before {
        return Err("PDF inspection failed or source changed".into());
    }
    let text=std::str::from_utf8(&output)?;
    let lines = text.lines().filter_map(|line| line.strip_prefix("Pages:")).collect::<Vec<_>>();
    if lines.len()!=1 {return Err("PDF page count missing or ambiguous".into());}
    let count: u64=lines[0].trim().parse()?;
    if count==0 || page>count {return Err("PDF source page does not exist".into());}
    Ok(())
}

#[cfg(test)]
mod pdf_page_tests {
    use super::*;
    #[test]
    fn pinned_pdf_inspector_checks_actual_pages() {
        let Ok(tool) = std::env::var("IOTPLACE_TEST_PDFINFO") else { return };
        let tool = Path::new(&tool).canonicalize().unwrap();
        let tool_hash = format!("{:x}",Sha256::digest(std::fs::read(&tool).unwrap()));
        let path=std::env::temp_dir().join(format!("iotplace-page-{}.pdf",std::process::id()));
        let objects=["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>"];
        let mut pdf=String::from("%PDF-1.4\n");
        let mut offsets=vec![0];
        for (i,object) in objects.iter().enumerate() {offsets.push(pdf.len());pdf.push_str(&format!("{} 0 obj\n{}\nendobj\n",i+1,object));}
        let xref=pdf.len();pdf.push_str("xref\n0 4\n0000000000 65535 f \n");
        for offset in offsets.iter().skip(1) {pdf.push_str(&format!("{offset:010} 00000 n \n"));}
        pdf.push_str(&format!("trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"));
        std::fs::write(&path,pdf).unwrap();
        assert!(verify_pdf_page(&path,1,&tool,&tool_hash).is_ok());
        assert!(verify_pdf_page(&path,2,&tool,&tool_hash).is_err());
        assert!(verify_pdf_page(&path,1,&tool,&"0".repeat(64)).is_err());
        std::fs::remove_file(path).unwrap();
    }
}

/// Validate unprofiled part-review metadata and reject unmodeled declarations.
/// This is one review gate, not a complete authorization decision.
fn check_part_metadata(manifest: &Value) -> crate::Result<()> {
    let parts = manifest["parts"].as_array().filter(|a| !a.is_empty()).ok_or("reviewed parts missing")?;
    let mut refs = std::collections::BTreeSet::new();
    for part in parts {
        let object = part.as_object().ok_or("invalid reviewed part")?;
        let allowed = ["reference","mpn","lcsc","manufacturer","package","datasheets","native","ratings","layout_constraints","assembly_dependencies","unresolved"];
        if object.keys().any(|key| !allowed.contains(&key.as_str())) { return Err("unsupported reviewed part fields or profile".into()); }
        let reference = part["reference"].as_str().filter(|v| !v.trim().is_empty()).ok_or("part reference missing")?;
        if !refs.insert(reference) { return Err("duplicate reviewed part reference".into()); }
        let mpn = part["mpn"].as_str().filter(|s| !s.is_empty() && s.trim() == *s).ok_or("part MPN missing")?;
        let lcsc = part["lcsc"].as_str().ok_or("part LCSC missing")?;
        if mpn.is_empty() || lcsc.len()<2 || !lcsc.starts_with('C') || !lcsc.as_bytes()[1..].iter().all(u8::is_ascii_digit) {
            return Err("part identity invalid".into());
        }
        if part["manufacturer"].as_str().is_none_or(|s| s.trim().is_empty()) ||
            part["package"]["name"].as_str().is_none_or(|s| s.trim().is_empty()) ||
            part["package"]["variant"].as_str().is_none_or(|s| s.trim().is_empty()) {
            return Err("part manufacturer or package missing".into());
        }
        if part["unresolved"].as_array().is_none_or(|a| !a.is_empty()) {return Err("unresolved reviewed part items".into());}
        for dep in part["assembly_dependencies"].as_array().ok_or("assembly dependencies missing")? {
            if !matches!(dep["kind"].as_str(),Some("mate"|"contact"|"harness"|"battery"|"other")) ||
                dep["reference"].as_str().is_none_or(|s| s.is_empty()) || dep["mpn"].as_str().is_none_or(|s| s.is_empty()) ||
                dep["quantity"].as_u64().is_none_or(|n| n==0) { return Err("invalid assembly dependency".into()); }
        }
    }
    Ok(())
}

#[cfg(test)]
mod metadata_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn rejects_incomplete_or_unresolved_part_review() {
        let mut manifest=json!({"parts":[{"reference":"U1","mpn":"P","lcsc":"C123","manufacturer":"M",
            "package":{"name":"QFN","variant":"A"},"unresolved":[],"assembly_dependencies":[]}]});
        assert!(check_part_metadata(&manifest).is_ok());
        manifest["parts"][0]["unresolved"]=json!(["needs review"]);
        assert!(check_part_metadata(&manifest).is_err());
        manifest["parts"][0]["unresolved"]=json!([]);
        manifest["parts"][0]["lcsc"]=json!("unknown");
        assert!(check_part_metadata(&manifest).is_err());
    }
}
