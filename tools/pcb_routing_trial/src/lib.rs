//! One controlled Fastroute invocation. A matching effective configuration is never native gate acceptance.
//! Gate admission runs on the Mac through gate-core.mjs; the daemon verifies its exact source bindings.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

mod context;
mod finalize;
mod prepare;
mod process;
#[path = "../../router/core/src/sha256.rs"]
mod sha256;
#[cfg(test)]
mod tests;

pub use context::{ExecutionContext, execution_context, native_execution_context};
pub use finalize::{ThermalVerifier, finalize};
pub use prepare::prepare;
pub type Result<T> = std::result::Result<T, String>;
pub type Environment = BTreeMap<String, String>;
pub const SCHEMA: &str = "iot-lab.routing-policy.v1";
pub const THERMAL_SCHEMA: &str = "iot-lab.routing-policy.v2";
pub const EXECUTION: &str = "iot-lab.placement-outcome-execution.v1";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RoutingPolicy {
    pub schema: String,
    pub layers: Vec<String>,
    pub only_nets: Vec<String>,
    pub passes: u64,
    pub threads: u64,
    pub timeout_s: u64,
    pub optimizer: String,
    pub max_repairs: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thermal_verification: Option<String>,
}

impl RoutingPolicy {
    pub fn thermal(&self) -> bool {
        self.schema == THERMAL_SCHEMA
    }
}

pub fn validate(config: Value, total_timeout_s: f64) -> Result<RoutingPolicy> {
    let object = config
        .as_object()
        .ok_or("controlled routing requires an explicit routing policy")?;
    let thermal = config["schema"] == THERMAL_SCHEMA;
    let mut fields = BTreeSet::from([
        "schema",
        "layers",
        "only_nets",
        "passes",
        "threads",
        "timeout_s",
        "optimizer",
        "max_repairs",
    ]);
    if thermal {
        fields.insert("thermal_verification");
    }
    ensure(
        object.keys().map(String::as_str).collect::<BTreeSet<_>>() == fields
            && [SCHEMA, THERMAL_SCHEMA].contains(&config["schema"].as_str().unwrap_or(""))
            && (!thermal || config["thermal_verification"] == "native-checkback"),
        "controlled routing requires exactly the routing-policy.v1 fields or explicit v2 native-checkback fields",
    )?;
    for name in ["passes", "threads", "timeout_s"] {
        ensure(
            config[name].as_u64().is_some_and(|n| n > 0),
            format!("{name} must be a positive integer"),
        )?;
    }
    ensure(
        total_timeout_s.is_finite()
            && total_timeout_s > 0.0
            && config["timeout_s"].as_u64().unwrap() as f64 <= total_timeout_s,
        "router timeout must fit the complete CLI deadline",
    )?;
    ensure(
        ["off", "if-routed"].contains(&config["optimizer"].as_str().unwrap_or("")),
        "controlled optimizer must be off or if-routed",
    )?;
    ensure(
        config["max_repairs"].as_u64() == Some(0),
        "this policy permits zero separate CLI repair operations",
    )?;
    for name in ["layers", "only_nets"] {
        ensure(
            config[name].as_array().is_some_and(|values| {
                !values.is_empty()
                    && values
                        .iter()
                        .all(|v| v.as_str().is_some_and(|s| !s.is_empty()))
                    && values
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<BTreeSet<_>>()
                        .len()
                        == values.len()
            }),
            format!("{name} requires a nonempty list of distinct exact names"),
        )?;
    }
    let policy: RoutingPolicy = serde_json::from_value(config)
        .map_err(|_| "controlled routing requires exactly the routing-policy.v1 fields or explicit v2 native-checkback fields")?;
    ensure(
        policy.layers.iter().all(|layer| copper_layer(layer)),
        "unsupported copper layer name",
    )?;
    ensure(
        policy
            .only_nets
            .iter()
            .all(|net| !net.chars().any(|c| ",*?[]\r\n\0".contains(c))),
        "only_nets must contain explicit comma-free net names, without macros",
    )?;
    Ok(policy)
}

fn copper_layer(layer: &str) -> bool {
    if ["F.Cu", "B.Cu"].contains(&layer) {
        return true;
    }
    layer
        .strip_prefix("In")
        .and_then(|s| s.strip_suffix(".Cu"))
        .is_some_and(|n| {
            n.parse::<u8>()
                .is_ok_and(|value| (1..=30).contains(&value) && value.to_string() == n)
        })
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Runtime {
    #[default]
    Container,
    Native,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GateAdmission {
    pub stage: String,
    pub inputs: BTreeMap<PathBuf, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BackendAdmission {
    pub policy: Value,
    pub inputs: BTreeMap<PathBuf, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PrepareRequest {
    pub root: PathBuf,
    pub native: PathBuf,
    pub output: PathBuf,
    pub config: Value,
    pub total_timeout_s: f64,
    pub board: Option<String>,
    #[serde(default)]
    pub runtime: Runtime,
    pub gate: GateAdmission,
    #[serde(default)]
    pub backend: Option<BackendAdmission>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Prepared {
    pub command: Vec<String>,
    pub env: Environment,
    pub policy: Value,
    pub policy_path: PathBuf,
    pub output: PathBuf,
    pub native: PathBuf,
    pub config: RoutingPolicy,
    pub context_path: PathBuf,
    pub context_sha256: String,
    pub runtime_kind: Runtime,
}

pub(crate) fn ensure(condition: bool, cause: impl Into<String>) -> Result<()> {
    if condition { Ok(()) } else { Err(cause.into()) }
}
pub(crate) fn read(path: &Path) -> Result<Value> {
    serde_json::from_slice(&fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?)
        .map_err(|e| format!("{}: {e}", path.display()))
}
pub(crate) fn hash(path: &Path) -> Result<String> {
    fs::read(path)
        .map(|bytes| sha256::sha256(&bytes))
        .map_err(|e| format!("{}: {e}", path.display()))
}
pub(crate) fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
pub(crate) fn absolute(path: &Path) -> Result<PathBuf> {
    if path.exists() {
        return fs::canonicalize(path).map_err(|e| e.to_string());
    }
    let path = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join(path)
    };
    let parent = path.parent().ok_or("path has no parent")?;
    Ok(absolute(parent)?.join(path.file_name().ok_or("path has no name")?))
}
pub(crate) fn regular_original(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file() && !meta.is_symlink())
}
pub(crate) fn check_inputs(inputs: &BTreeMap<PathBuf, String>) -> Result<()> {
    for (name, expected) in inputs {
        ensure(
            name.is_file() && hash(name)? == *expected,
            format!("controlled routing input/tool changed: {}", name.display()),
        )?;
    }
    Ok(())
}
pub(crate) fn inputs(value: &Value) -> Result<BTreeMap<PathBuf, String>> {
    serde_json::from_value(value.clone())
        .map_err(|_| "input hash bindings must be an object".into())
}

/// Python json.dumps(..., separators=(',', ':'), ensure_ascii=True), used by existing command receipts.
pub fn ascii_json(value: &Value) -> String {
    let utf8 = serde_json::to_string(value).expect("JSON value");
    let mut result = String::new();
    for c in utf8.chars() {
        if c <= '~' {
            result.push(c);
        } else {
            for unit in c.encode_utf16(&mut [0; 2]) {
                result.push_str(&format!("\\u{unit:04x}"));
            }
        }
    }
    result
}

pub(crate) fn atomic_json(path: &Path, value: &Value) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let parent = path.parent().ok_or("receipt has no parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut attempt = 0;
    let (temporary, mut file) = loop {
        let path = parent.join(format!(".trial-{}-{attempt}.tmp", std::process::id()));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
        {
            Ok(file) => break (path, file),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => attempt += 1,
            Err(error) => return Err(error.to_string()),
        }
    };
    let result = (|| {
        let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.write_all(b"\n"))
            .map_err(|e| e.to_string())?;
        fs::rename(&temporary, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

pub(crate) fn backend_effort(policy: &Value) -> Result<Value> {
    let mode = policy["mode"]
        .as_str()
        .ok_or("actual backend algorithm policy is missing or unknown")?;
    ensure(
        ["legacy-unverified", "quality-first"].contains(&mode),
        "actual backend algorithm policy is missing or unknown",
    )?;
    let mut result = json!({"mode": mode});
    if mode == "quality-first" {
        for name in [
            "binary_sha256",
            "manifest_sha256",
            "patch_sha256",
            "upstream_commit",
        ] {
            let value = policy[name]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or("quality backend algorithm identity is incomplete")?;
            result[name] = json!(value);
        }
    }
    Ok(result)
}
