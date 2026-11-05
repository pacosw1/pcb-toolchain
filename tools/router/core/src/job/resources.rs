//! Cooperating board jobs: declared CPU and memory reservations, not OS quotas. Tickets are the files of tools/lib/lean-resources.ts, so
//! Rust, Python and TypeScript jobs share one queue. A locked ticket is a live job; a dead owner's lock is gone with it.
use super::clock::{self, Env};
use super::files::append_line;
use super::stop::Stop;
use serde_json::{Value, json};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::Duration;

const NATIVE_KEYS: [&str; 6] = ["OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "NUMEXPR_NUM_THREADS", "BLIS_NUM_THREADS"];
const CLOCK_PROTOCOL: &str = "clock-monotonic-v1:";
const GUARD_WAIT_S: f64 = 5.0;

/// One native worker per process: nested pools would oversubscribe.
pub fn native_env(env: &Env) -> Env {
    let mut out = env.clone();
    out.extend(NATIVE_KEYS.iter().map(|key| (key.to_string(), "1".to_string())));
    out
}

fn try_lock(file: &File) -> bool {
    unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) == 0 }
}

/// The queue's capacity: (cpu, memory GiB).
pub fn limits(env: &Env) -> Result<(u32, f64), String> {
    let cores = std::thread::available_parallelism().map_or(1, |count| count.get() as u32);
    let cpu = match env.get("IOT_CPU_BUDGET") {
        Some(text) => text.parse().map_err(|_| "IOT_CPU_BUDGET must be a whole number".to_string())?,
        None => cores.min(12),
    };
    let memory: f64 = env.get("IOT_MEMORY_BUDGET_GIB").map_or("16", String::as_str).parse().map_err(|_| "IOT_MEMORY_BUDGET_GIB must be a number".to_string())?;
    if cpu < 1 || !memory.is_finite() || memory <= 0.0 {
        return Err("resource capacities must be finite and positive".to_string());
    }
    Ok((cpu, memory))
}

pub fn default_cpu(env: &Env) -> Result<u32, String> {
    match env.get("IOT_RESOURCE_CPU") {
        Some(text) => text.parse().map_err(|_| "IOT_RESOURCE_CPU must be a whole number".to_string()),
        None => Ok(limits(env)?.0),
    }
}

fn root_directory(env: &Env) -> PathBuf {
    env.get("IOT_RESOURCE_DIRECTORY").map_or_else(|| Path::new(env.get("HOME").map_or("", String::as_str)).join(".cache/iot-lab/resources"), PathBuf::from)
}

fn event(path: Option<&Path>, values: Value) {
    let Some(path) = path else { return };
    let mut row = values;
    row["time_monotonic"] = json!(clock::now());
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = append_line(path, &row.to_string());
}

/// The ledger lock, held while claims are read or changed.
fn guard(root: &Path, deadline: f64) -> Result<File, Stop> {
    fs::create_dir_all(root).map_err(|e| Stop::failed(format!("{}: {e}", root.display())))?;
    let path = root.join("guard");
    let file = OpenOptions::new().create(true).append(true).open(&path).map_err(|e| Stop::failed(format!("{}: {e}", path.display())))?;
    loop {
        if try_lock(&file) {
            return Ok(file);
        }
        if clock::now() >= deadline {
            return Err(Stop::admission_timeout("resource ledger busy; admission deadline reached"));
        }
        sleep(Duration::from_millis(10));
    }
}

/// Must hold the guard. A ticket no one holds locked belongs to a dead owner and goes.
fn live_claims(root: &Path) -> Result<Vec<Value>, Stop> {
    let mut claims = Vec::new();
    let read = fs::read_dir(root).map_err(|e| Stop::failed(format!("{}: {e}", root.display())))?;
    for entry in read.filter_map(Result::ok) {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("ticket") {
            continue;
        }
        let Ok(mut file) = OpenOptions::new().read(true).write(true).open(&path) else { continue };
        if try_lock(&file) {
            let _ = fs::remove_file(&path);
        } else {
            let mut text = String::new();
            let _ = file.read_to_string(&mut text);
            claims.push(serde_json::from_str(&text).map_err(|e| Stop::failed(format!("{}: {e}", path.display())))?);
        }
    }
    Ok(claims)
}

/// True when the environment carries a live reservation that covers the request.
pub fn inherited(cpu: u32, memory_gib: f64, env: &Env) -> Result<bool, String> {
    let Some(path) = env.get("IOT_RESOURCE_TICKET").filter(|path| !path.is_empty()) else { return Ok(false) };
    let mut file = OpenOptions::new().read(true).write(true).open(path).map_err(|e| format!("{path}: {e}"))?;
    if try_lock(&file) {
        return Err("inherited resource reservation is no longer live".to_string());
    }
    let mut text = String::new();
    file.read_to_string(&mut text).map_err(|e| format!("{path}: {e}"))?;
    let claim: Value = serde_json::from_str(&text).map_err(|e| format!("{path}: {e}"))?;
    if claim["status"] != "admitted" || f64::from(cpu) > claim["cpu"].as_f64().unwrap_or(0.0) || memory_gib > claim["memory_gib"].as_f64().unwrap_or(0.0) {
        return Err("child request exceeds inherited reservation".to_string());
    }
    Ok(true)
}

/// The environment of the router: its global Rayon pool capped within a live reservation.
pub fn router_env(cpu: u32, env: &Env) -> Result<Env, String> {
    if cpu < 1 {
        return Err("router CPU request must be a positive integer".to_string());
    }
    if !inherited(cpu, 0.0, env)? {
        return Err("router environment requires a live resource reservation".to_string());
    }
    let mut out = native_env(env);
    out.insert("RAYON_NUM_THREADS".to_string(), cpu.to_string());
    Ok(out)
}

/// An admitted claim; dropping it gives the capacity back.
pub struct Reservation {
    ticket: Option<(File, PathBuf)>,
    root: PathBuf,
    events: Option<PathBuf>,
    claim: Value,
    /// The environment of the work under this reservation.
    pub env: Env,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        let Some((file, path)) = self.ticket.take() else { return };
        if let Ok(guard) = guard(&self.root, clock::now() + GUARD_WAIT_S) {
            let _ = fs::remove_file(&path);
            drop(guard);
        }
        drop(file);
        self.claim["action"] = json!("released");
        event(self.events.as_deref(), self.claim.clone());
    }
}

fn write_claim(file: &mut File, claim: &Value) -> Result<(), Stop> {
    let fail = |e: std::io::Error| Stop::failed(e.to_string());
    file.seek(SeekFrom::Start(0)).map_err(fail)?;
    file.set_len(0).map_err(fail)?;
    file.write_all(claim.to_string().as_bytes()).map_err(fail)?;
    file.flush().map_err(fail)
}

fn random_id() -> Result<String, Stop> {
    let mut bytes = [0u8; 16];
    File::open("/dev/urandom").and_then(|mut file| file.read_exact(&mut bytes)).map_err(|e| Stop::failed(e.to_string()))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

struct Request {
    cpu: u32,
    memory_gib: f64,
    capacity: u32,
    memory_capacity: f64,
}

/// True once this claim is first in the queue and fits.
fn admit(root: &Path, id: &str, request: &Request, deadline: f64) -> Result<bool, Stop> {
    let _guard = guard(root, deadline)?;
    let active = live_claims(root)?;
    if active.iter().any(|claim| claim["clock_protocol"] != CLOCK_PROTOCOL) {
        return Err(Stop::failed("cooperating jobs use incompatible queue clock protocols"));
    }
    if active.iter().any(|claim| claim["cpu_capacity"].as_f64() != Some(f64::from(request.capacity)) || claim["memory_capacity_gib"].as_f64() != Some(request.memory_capacity)) {
        return Err(Stop::failed("cooperating jobs disagree on resource capacities"));
    }
    let queued = |claim: &Value| (claim["queued_at"].as_f64().unwrap_or(0.0), claim["id"].as_str().unwrap_or("").to_string());
    let first = active.iter().filter(|claim| claim["status"] == "waiting").min_by(|a, b| queued(a).partial_cmp(&queued(b)).unwrap_or(std::cmp::Ordering::Equal));
    let admitted = active.iter().filter(|claim| claim["status"] == "admitted");
    let (cpu, memory) = admitted.fold((0.0, 0.0), |(cpu, memory), claim| (cpu + claim["cpu"].as_f64().unwrap_or(0.0), memory + claim["memory_gib"].as_f64().unwrap_or(0.0)));
    Ok(first.is_some_and(|claim| claim["id"] == id) && cpu + f64::from(request.cpu) <= f64::from(request.capacity) && memory + request.memory_gib <= request.memory_capacity)
}

/// Polls the queue until this claim is admitted, a stop signal comes or a deadline passes.
fn wait_for_slot(root: &Path, id: &str, request: &Request, deadline: f64, job_deadline: Option<f64>) -> Result<(), Stop> {
    loop {
        super::stop::check_cancelled()?;
        if job_deadline.is_some_and(|job| clock::now() >= job) {
            return Err(Stop::admission_timeout("end-to-end deadline reached during admission"));
        }
        if admit(root, id, request, deadline)? {
            return Ok(());
        }
        if clock::now() >= deadline {
            return Err(Stop::admission_timeout("cooperating resource admission deadline reached"));
        }
        sleep(Duration::from_millis(100));
    }
}

/// Waits for a slot, at most `wait_s`. Inside a reservation that covers the request there is nothing to wait for.
pub fn reserve(cpu: u32, memory_gib: f64, wait_s: f64, events: Option<&Path>, label: &str, env: &Env) -> Result<Reservation, Stop> {
    let (capacity, memory_capacity) = limits(env).map_err(Stop::failed)?;
    if cpu < 1 || cpu > capacity || !memory_gib.is_finite() || memory_gib <= 0.0 || memory_gib > memory_capacity {
        return Err(Stop::failed("request exceeds cooperating resource capacity"));
    }
    if !wait_s.is_finite() || wait_s < 0.0 {
        return Err(Stop::failed("admission wait must be finite and nonnegative"));
    }
    let job_deadline = clock::inherited(env).map_err(Stop::failed)?;
    if clock::remaining(job_deadline) == Some(0.0) {
        return Err(Stop::admission_timeout("end-to-end deadline reached before admission"));
    }
    let root = root_directory(env);
    if inherited(cpu, memory_gib, env).map_err(Stop::failed)? {
        return Ok(Reservation { ticket: None, root, events: None, claim: Value::Null, env: native_env(env) });
    }
    let started = clock::now();
    let deadline = job_deadline.map_or(started + wait_s, |job| job.min(started + wait_s));
    let id = random_id()?;
    let path = root.join(format!("{id}.ticket"));
    let mut claim = json!({"id": id, "pid": std::process::id(), "queued_at": started, "status": "waiting", "clock_protocol": CLOCK_PROTOCOL,
                           "label": label, "cpu": cpu, "memory_gib": memory_gib, "cpu_capacity": capacity, "memory_capacity_gib": memory_capacity});
    let file = {
        let _guard = guard(&root, deadline)?;
        let mut file = OpenOptions::new().create(true).write(true).read(true).truncate(true).open(&path).map_err(|e| Stop::failed(format!("{}: {e}", path.display())))?;
        if !try_lock(&file) {
            return Err(Stop::failed("a new ticket is locked"));
        }
        write_claim(&mut file, &claim)?;
        file
    };
    let mut queued = claim.clone();
    queued["action"] = json!("queued");
    event(events, queued);
    let request = Request { cpu, memory_gib, capacity, memory_capacity };
    // From here on the reservation owns the ticket: however admission ends, dropping it gives the ticket back and says so.
    let mut reservation = Reservation { ticket: Some((file, path.clone())), root: root.clone(), events: events.map(Path::to_path_buf), claim: claim.clone(), env: Env::new() };
    let slot = wait_for_slot(&root, &id, &request, deadline, job_deadline).and_then(|()| {
        claim["status"] = json!("admitted");
        let (file, _) = reservation.ticket.as_mut().expect("the ticket is held until drop");
        write_claim(file, &claim)
    });
    if let Err(stop) = slot {
        fail_event(events, &claim, &stop, started);
        return Err(stop);
    }
    let mut admitted = claim.clone();
    admitted["action"] = json!("admitted");
    admitted["queue_s"] = json!(clock::now() - started);
    event(events, admitted);
    let mut work = native_env(env);
    work.insert("IOT_RESOURCE_TICKET".to_string(), path.display().to_string());
    work.insert("IOT_RESOURCE_CPU".to_string(), cpu.to_string());
    work.insert("IOT_JOB_MEMORY_GIB".to_string(), memory_gib.to_string());
    reservation.claim = claim;
    reservation.env = work;
    Ok(reservation)
}

fn fail_event(events: Option<&Path>, claim: &Value, stop: &Stop, started: f64) {
    let mut row = claim.clone();
    row["action"] = json!(if matches!(stop, Stop::Cancelled { .. }) { "cancelled" } else { "failed" });
    row["reason"] = json!(stop.reason());
    row["signal"] = json!(match stop {
        Stop::Cancelled { signal, .. } => *signal,
        _ => None,
    });
    row["queue_s"] = json!(clock::now() - started);
    event(events, row);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(name: &str, cpu: u32) -> Env {
        let root = std::env::temp_dir().join(format!("job-res-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        Env::from([
            ("IOT_RESOURCE_DIRECTORY".to_string(), root.display().to_string()),
            ("IOT_CPU_BUDGET".to_string(), cpu.to_string()),
            ("IOT_MEMORY_BUDGET_GIB".to_string(), "4".to_string()),
        ])
    }

    #[test]
    fn a_reservation_gives_a_live_ticket_and_router_env_checks_it() {
        let env = env("live", 4);
        let held = reserve(2, 1.0, 1.0, None, "test", &env).unwrap();
        assert_eq!(held.env["IOT_RESOURCE_CPU"], "2");
        assert_eq!(held.env["OMP_NUM_THREADS"], "1");
        assert!(inherited(2, 0.5, &held.env).unwrap());
        assert!(inherited(3, 0.5, &held.env).is_err());
        assert_eq!(router_env(2, &held.env).unwrap()["RAYON_NUM_THREADS"], "2");
        let ticket = held.env["IOT_RESOURCE_TICKET"].clone();
        drop(held);
        assert!(!Path::new(&ticket).exists());
    }

    #[test]
    fn a_full_queue_times_out_and_a_nested_reservation_needs_no_slot() {
        let env = env("full", 2);
        let held = reserve(2, 1.0, 1.0, None, "test", &env).unwrap();
        let refused = reserve(1, 1.0, 0.2, None, "test", &env).err().unwrap();
        assert!(matches!(refused, Stop::AdmissionTimeout(_)));
        let nested = reserve(1, 0.5, 0.2, None, "child", &held.env).unwrap();
        assert!(nested.env.contains_key("IOT_RESOURCE_TICKET"));
    }

    fn expired(env: &Env) -> Env {
        let mut env = env.clone();
        env.insert(clock::DEADLINE_ENV.to_string(), clock::encode(clock::now() - 1.0));
        env
    }

    #[test]
    fn an_expired_deadline_is_refused_before_any_ticket() {
        let env = expired(&env("expired", 4));
        assert!(matches!(reserve(1, 1.0, 1.0, None, "test", &env).err().unwrap(), Stop::AdmissionTimeout(_)));
        assert!(!root_directory(&env).exists());
    }

    #[test]
    fn an_expired_parent_budget_beats_an_inherited_reservation() {
        let held = reserve(2, 1.0, 1.0, None, "test", &env("expiredparent", 4)).unwrap();
        assert!(matches!(reserve(1, 0.5, 1.0, None, "child", &expired(&held.env)).err().unwrap(), Stop::AdmissionTimeout(_)));
    }

    #[test]
    fn a_request_above_capacity_is_refused() {
        assert!(reserve(9, 1.0, 0.0, None, "test", &env("cap", 4)).is_err());
        assert!(router_env(1, &env("none", 4)).is_err());
    }
}
