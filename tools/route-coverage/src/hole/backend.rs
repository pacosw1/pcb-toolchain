//! The reviewed upstream integer-grid contract and independently bound quality-backend artifact.
use crate::{
    Result,
    decimal::D,
    dsn::{Dsn, num, one},
    evidence,
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
const PATCH_SHA: &str = "abc1c6fc3b49f446ce0f28fb2c861abb02255822a5fb58fced5eaa2ea53eb1a8";
const UPSTREAM: &str = "e5d52c4544795422b8b28077acc0605fdf11265a";
const LOCK: &str = "4761175c5d8df0ed4c2c69036df2686dc7e3a186cd085d2ae766936134cab9a6";
pub fn grid_mm(model: &Dsn, value: &D) -> Result<()> {
    let scaled = value / &model.scale * D::from(10);
    // fr-geom/limits.rs CRIT_INT, fr-io/structure.rs 397–413: no rescale below this bound.
    if scaled != scaled.with_scale(0) || scaled.abs() * D::from(5) >= D::from(33_554_432) {
        return Err("drilled model coordinate/radius/clearance is not exactly representable on the verified backend grid".into());
    }
    Ok(())
}
pub fn verified_grid(
    model: &Dsn,
    command: &[String],
    policy: &Value,
    inputs: &mut Value,
) -> Result<Value> {
    if command.is_empty()
        || !command.iter().any(|s| s == "--quality-first")
        || !Path::new(&command[0]).is_absolute()
        || policy["mode"] != "quality-first"
    {
        return Err("drilled model needs an attributable quality-first backend policy; legacy/unknown geometry is unsupported".into());
    }
    if policy["patch_sha256"] != PATCH_SHA {
        return Err("backend patch geometry transform has not been reviewed".into());
    }
    let manifest = Path::new(
        policy["manifest"]
            .as_str()
            .ok_or("actual backend manifest path is required")?,
    );
    if !manifest.is_absolute() {
        return Err("actual backend manifest path is required".into());
    }
    let patch = std::env::var_os("FASTROUTE_QUALITY_PATCH")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../backend-patches/fastroute-quality-773/quality-first.patch")
        });
    let (data, desc) = evidence::read(manifest)?;
    if data["schema"] != 1
        || data["upstream_commit"] != UPSTREAM
        || data["cargo_lock_sha256"] != LOCK
        || data["patch_sha256"] != evidence::hash(&patch)?
    {
        return Err("quality backend source/patch/lock provenance mismatch".into());
    }
    let binary = evidence::descriptor(Path::new(&command[0]))?;
    if data["binary_sha256"] != binary["sha256"] {
        return Err("quality backend binary hash mismatch".into());
    }
    let validation = &data["native_validation"];
    let native = validation["evidence"]
        .as_array()
        .filter(|a| !a.is_empty())
        .ok_or("quality backend native validation evidence unavailable")?;
    if validation["status"] != "passed" {
        return Err("quality backend native validation evidence unavailable".into());
    }
    let bound = json!({"mode":"quality-first","manifest":desc["path"],"manifest_sha256":desc["sha256"],"binary_sha256":binary["sha256"],"patch_sha256":data["patch_sha256"],"upstream_commit":UPSTREAM,"qualified":false});
    if bound != *policy {
        return Err(
            "actual backend policy differs from its binary/manifest/evidence bindings".into(),
        );
    }
    let mut paths = vec![
        desc,
        binary,
        evidence::descriptor(&patch)?,
        evidence::descriptor(&std::env::current_exe().map_err(|e| e.to_string())?)?,
    ];
    for item in native {
        paths.push(evidence::check_descriptor(item)?);
    }
    for d in paths {
        inputs[d["path"].as_str().unwrap()] = d["sha256"].clone();
    }
    evidence::check_inputs(inputs)?;
    if model.unit != "um" || one(&model.root, "resolution")?.text(2) != Some("10") {
        return Err("only the source-verified um/resolution10 backend grid is supported".into());
    }
    let b = one(one(&model.root, "structure")?, "boundary")?;
    let p = b
        .items()
        .get(1)
        .ok_or("backend coordinate scale requires one exact closed zero-width PCB boundary")?;
    if b.items().len() != 2
        || !p.is("path")
        || p.text(1) != Some("pcb")
        || p.text(2) != Some("0")
        || p.items().len() < 11
        || !(p.items().len() - 3).is_multiple_of(2)
    {
        return Err(
            "backend coordinate scale requires one exact closed zero-width PCB boundary".into(),
        );
    }
    let values = (3..p.items().len())
        .map(|i| num(p, i))
        .collect::<Result<Vec<_>>>()?;
    if values[..2] != values[values.len() - 2..]
        || values
            .iter()
            .any(|v| v.abs() * D::from(50) >= D::from(33_554_432))
    {
        return Err(
            "backend board boundary does not establish unchanged resolution10 coordinate scale"
                .into(),
        );
    }
    Ok(
        json!({"source":format!("https://github.com/parisxmas/fastroute/tree/{UPSTREAM}"),"coordinate_scale":10,"unit":"um","policy":"quality-first","binary_sha256":policy["binary_sha256"],"manifest_sha256":policy["manifest_sha256"]}),
    )
}
