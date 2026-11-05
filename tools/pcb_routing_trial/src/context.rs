use super::*;
use std::ffi::CStr;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExecutionContext {
    pub path: Option<PathBuf>,
    pub raw: Vec<u8>,
    pub image_id: Option<String>,
    pub container_id: Option<String>,
    pub cpus: f64,
    pub memory_bytes: u64,
    pub observed_cgroup: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Limits {
    pub cpu: Option<Option<(u64, u64)>>,
    pub memory: Option<Option<u64>>,
    pub affinity: Option<usize>,
}
impl Limits {
    fn observe() -> Result<Self> {
        let mut result = Self::default();
        let cpu = Path::new("/sys/fs/cgroup/cpu.max");
        if cpu.is_file() {
            let value = fs::read_to_string(cpu).map_err(|e| e.to_string())?;
            let parts: Vec<_> = value.split_whitespace().collect();
            ensure(parts.len() == 2, "invalid cgroup cpu.max")?;
            let period = number(parts[1], "invalid cgroup CPU period")?;
            result.cpu = Some(if parts[0] == "max" {
                None
            } else {
                Some((number(parts[0], "invalid cgroup CPU quota")?, period))
            });
        } else {
            let quota = Path::new("/sys/fs/cgroup/cpu/cpu.cfs_quota_us");
            let period = Path::new("/sys/fs/cgroup/cpu/cpu.cfs_period_us");
            if quota.is_file() && period.is_file() {
                let amount: i64 = fs::read_to_string(quota)
                    .map_err(|e| e.to_string())?
                    .trim()
                    .parse()
                    .map_err(|_| "invalid cgroup CPU quota")?;
                let period = number(
                    &fs::read_to_string(period).map_err(|e| e.to_string())?,
                    "invalid cgroup CPU period",
                )?;
                result.cpu = Some(if amount > 0 {
                    Some((amount as u64, period))
                } else {
                    None
                });
            }
        }
        for path in [
            "/sys/fs/cgroup/memory.max",
            "/sys/fs/cgroup/memory/memory.limit_in_bytes",
        ] {
            if Path::new(path).is_file() {
                let value = fs::read_to_string(path).map_err(|e| e.to_string())?;
                result.memory = Some(if value.trim() == "max" {
                    None
                } else {
                    Some(number(&value, "invalid cgroup memory limit")?)
                });
                break;
            }
        }
        #[cfg(target_os = "linux")]
        unsafe {
            let mut mask: libc::cpu_set_t = std::mem::zeroed();
            if libc::sched_getaffinity(0, std::mem::size_of_val(&mask), &mut mask) != 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            result.affinity = Some(libc::CPU_COUNT(&mask) as usize);
        }
        Ok(result)
    }
    fn document(&self) -> Value {
        let mut value = json!({});
        if let Some(cpu) = self.cpu {
            value["cpus"] = cpu.map_or(Value::Null, |(q, p)| json!(q as f64 / p as f64));
        }
        if let Some(memory) = self.memory {
            value["memory_bytes"] = json!(memory);
        }
        if let Some(affinity) = self.affinity {
            value["affinity_cpus"] = json!(affinity);
        }
        value
    }
}
fn number(value: &str, cause: &str) -> Result<u64> {
    value
        .trim()
        .parse::<u64>()
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(|| cause.into())
}
fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn execution_context(env: &Environment) -> Result<ExecutionContext> {
    let name = env
        .get("PCB_EXECUTION_CONTEXT")
        .ok_or("controlled routing needs the host-recorded Docker inspect context")?;
    let path = if Path::new(name).is_absolute() {
        PathBuf::from(name)
    } else {
        std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join(name)
    };
    ensure(
        regular_original(&path),
        "execution context must be an original regular inspect receipt",
    )?;
    let mut hostname = [0u8; 256];
    ensure(
        unsafe { libc::gethostname(hostname.as_mut_ptr().cast(), hostname.len()) } == 0,
        "cannot observe running hostname",
    )?;
    let hostname = std::str::from_utf8(hostname.split(|b| *b == 0).next().unwrap_or(&[]))
        .map_err(|e| e.to_string())?;
    validate_context(
        path.clone(),
        fs::read(&path).map_err(|e| e.to_string())?,
        hostname,
        Limits::observe()?,
    )
}

pub(crate) fn validate_context(
    path: PathBuf,
    raw: Vec<u8>,
    hostname: &str,
    observed: Limits,
) -> Result<ExecutionContext> {
    let mut value: Value = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    if let Some(list) = value.as_array() {
        ensure(
            list.len() == 1,
            "execution context must identify exactly one running container",
        )?;
        value = list[0].clone();
    }
    let id = value["Id"].as_str().unwrap_or("");
    ensure(
        hex(id, 64),
        "execution context is not an original container inspect response",
    )?;
    let image = value["Image"].as_str().unwrap_or("");
    ensure(
        image.strip_prefix("sha256:").is_some_and(|s| hex(s, 64)),
        "execution context lacks the immutable actual image identity",
    )?;
    ensure(
        value["Config"]["Hostname"].as_str() == Some(hostname),
        "execution context belongs to another container hostname",
    )?;
    let mount = value["Mounts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|mount| {
            let target = Path::new(mount["Destination"].as_str().unwrap_or("/__missing__"));
            path.starts_with(target)
                .then_some((target.components().count(), mount))
        })
        .max_by_key(|(depth, _)| *depth);
    ensure(
        mount.is_some_and(|(_, mount)| mount["RW"] == false),
        "original execution context must be mounted read-only",
    )?;
    let host = &value["HostConfig"];
    ensure(
        host["NetworkMode"] == "none",
        "controlled routing requires the recorded network-none runner",
    )?;
    let nano = host["NanoCpus"]
        .as_u64()
        .filter(|n| *n > 0)
        .ok_or("actual runner must enforce explicit CPU and memory limits")?;
    let memory = host["Memory"]
        .as_u64()
        .filter(|n| *n > 0)
        .ok_or("actual runner must enforce explicit CPU and memory limits")?;
    let cpus = nano as f64 / 1_000_000_000.0;
    if let Some(cpu) = observed.cpu {
        ensure(
            cpu.is_some_and(|(q, p)| q as u128 * 1_000_000_000 == nano as u128 * p as u128),
            "actual cgroup limits differ from the host inspect receipt",
        )?;
    }
    if let Some(limit) = observed.memory {
        ensure(
            limit == Some(memory),
            "actual cgroup limits differ from the host inspect receipt",
        )?;
    }
    ensure(
        observed.affinity.is_none_or(|n| n as f64 >= cpus),
        "actual CPU affinity is narrower than the recorded quota",
    )?;
    Ok(ExecutionContext {
        path: Some(path),
        raw,
        image_id: Some(image.into()),
        container_id: Some(id.into()),
        cpus,
        memory_bytes: memory,
        observed_cgroup: observed.document(),
        kind: None,
        identity: None,
    })
}

pub fn native_execution_context(env: &Environment) -> Result<ExecutionContext> {
    // os.cpu_count() in the existing receipt is the online logical count, independent of this process's affinity.
    let physical = (unsafe { libc::sysconf(libc::_SC_NPROCESSORS_ONLN) }).max(1) as usize;
    let cpus = env
        .get("IOT_CPU_BUDGET")
        .map_or(Ok(physical.min(12) as u64), |s| {
            number(s, "resource capacities must be finite and positive")
        })?;
    let memory: f64 = env
        .get("IOT_MEMORY_BUDGET_GIB")
        .map_or("16", String::as_str)
        .parse()
        .map_err(|_| "resource capacities must be finite and positive")?;
    ensure(
        memory.is_finite() && memory > 0.0 && memory * 1_073_741_824.0 < u64::MAX as f64,
        "resource capacities must be finite and positive",
    )?;
    ensure(
        cpus <= physical as u64,
        "native CPU budget exceeds available logical processors",
    )?;
    let mut uname: libc::utsname = unsafe { std::mem::zeroed() };
    ensure(
        unsafe { libc::uname(&mut uname) } == 0,
        "cannot observe native OS identity",
    )?;
    let string = |value: &[libc::c_char]| {
        unsafe { CStr::from_ptr(value.as_ptr()) }
            .to_string_lossy()
            .into_owned()
    };
    let value = json!({ "schema": "iot-lab.native-execution-context.v1", "system": string(&uname.sysname), "release": string(&uname.release),
        "machine": string(&uname.machine), "logical_cpus": physical, "cpus": cpus, "memory_bytes": (memory * 1_073_741_824.0) as u64,
        "enforcement": "cooperative-reservation-and-backend-worker-caps", "memory_is_hard_limit": false, "network_isolated": false });
    let raw = (ascii_json(&value) + "\n").into_bytes();
    Ok(ExecutionContext {
        path: None,
        identity: Some(sha256::sha256(&raw)),
        raw,
        image_id: None,
        container_id: None,
        cpus: cpus as f64,
        memory_bytes: value["memory_bytes"].as_u64().unwrap(),
        observed_cgroup: json!({}),
        kind: Some("native".into()),
    })
}
