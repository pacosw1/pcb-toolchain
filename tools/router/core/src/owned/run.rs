//! `iotroute owned run --result FILE -- COMMAND...`: one owned stage from a process with no broker of its own.
//!
//! With no lineage in the environment this process is the root broker. Inside an owned stage it is a client of the
//! broker that owns that stage, so nesting works from any caller. stdio, cwd and environment come from the caller.
//! SIGTERM, SIGINT and SIGHUP cancel the stage: TERM, then KILL after the grace. SIGUSR1 is one graceful TERM of the stage and
//! no more, for a command that writes its best result and exits by itself. On settle it writes FILE atomically and exits.

use super::bootstrap;
use super::client::rpc;
use super::failure::Failure;
use super::lock;
use super::native::{self, locked};
use super::options::SpawnOptions;
use super::scope::{DEPTH_ENV, HANDLE_ENV, SOCKET_ENV, Scope};
use super::stage::{CPU_SCOPE, Stage};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::os::fd::{AsRawFd, BorrowedFd};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

const EXIT_USAGE: i32 = 2;
/// The code of lean_workflow for a reached deadline.
const EXIT_TIMEOUT: i32 = 124;
const EXIT_NOT_FOUND: i32 = 127;
const EXIT_FAILED: i32 = 1;
/// EX_SOFTWARE: the command succeeded, but its cleanup could not be confirmed.
const EXIT_UNCONFIRMED: i32 = 70;
/// EX_IOERR: the stage settled, but its result could not be written.
const EXIT_NO_RESULT: i32 = 74;
const SIGNAL_BASE: i32 = 128;
const HANDLE_CHARS: usize = 64;
const SHORT_RPC: Duration = Duration::from_secs(2);
const CANCEL_RPC: Duration = Duration::from_secs(10);
const NO_LEADER: &str = "unavailable; no owned leader reaped";

/// The content of FILE, with the field shapes of lean_owned.
#[derive(Serialize)]
struct Report {
    returncode: Option<i32>,
    child_cpu_s: Option<f64>,
    adopted_child_cpu_s: Option<f64>,
    cpu_scope: String,
    cleanup: Value,
    error: Option<Failure>,
}

impl Report {
    /// No stage was ever registered, so there is nothing to clean.
    fn never_started(error: Failure) -> Report {
        Report { returncode: None, child_cpu_s: None, adopted_child_cpu_s: None, cpu_scope: NO_LEADER.to_string(),
                 cleanup: json!({"complete": true, "errors": [], "child_reaped": true}), error: Some(error) }
    }

    /// The broker went away with a stage registered: its outcome is unknown, so nothing may be claimed about it.
    fn lost(error: Failure) -> Report {
        let cleanup = json!({"complete": false, "child_reaped": false, "family_cleanup": "unconfirmed",
                             "errors": [{"operation": "wait", "error": error.to_string()}]});
        Report { returncode: None, child_cpu_s: None, adopted_child_cpu_s: None, cpu_scope: NO_LEADER.to_string(), cleanup, error: Some(error) }
    }

    fn exit_code(&self) -> i32 {
        let confirmed = self.cleanup.get("complete") == Some(&Value::Bool(true));
        match (&self.error, self.returncode) {
            (Some(error), _) if error.kind == "FileNotFoundError" => EXIT_NOT_FOUND,
            (Some(error), _) if error.kind == "TimeoutExpired" => EXIT_TIMEOUT,
            (Some(_), _) | (None, None) => EXIT_FAILED,
            (None, Some(0)) if !confirmed => EXIT_UNCONFIRMED,
            (None, Some(code)) if code < 0 => SIGNAL_BASE - code,
            (None, Some(code)) => code,
        }
    }
}

struct Lineage {
    socket: PathBuf,
    cap: String,
}

/// lean_owned.prepare's rule: both values or neither, and a nonroot depth needs an authenticated broker.
fn lineage() -> Result<Option<Lineage>, Failure> {
    let (socket, cap) = (std::env::var_os(SOCKET_ENV), std::env::var_os(HANDLE_ENV));
    if socket.is_none() && cap.is_none() {
        let depth = std::env::var_os(DEPTH_ENV).unwrap_or_else(|| "0".into());
        if depth != "0" {
            return Err(Failure::value("nonroot stage depth requires authenticated broker scope"));
        }
        return Ok(None);
    }
    let invalid = || Failure::value("invalid owned-stage broker metadata");
    let cap = cap.and_then(|cap| cap.into_string().ok()).filter(|cap| cap.len() == HANDLE_CHARS).ok_or_else(invalid)?;
    Ok(Some(Lineage { socket: socket.ok_or_else(invalid)?.into(), cap }))
}

/// Runs `action` on the first stop signal, and lets `finish` collect what it returned.
struct Canceller {
    outcome: Arc<(Mutex<CancelState>, Condvar)>,
}

#[derive(Default)]
struct CancelState {
    triggered: bool,
    cleanup: Option<Value>,
}

impl Canceller {
    fn watch(action: impl FnOnce() -> Value + Send + 'static) -> Canceller {
        let outcome: Arc<(Mutex<CancelState>, Condvar)> = Arc::default();
        let shared = Arc::clone(&outcome);
        std::thread::spawn(move || {
            native::wait_stop_signal();
            locked(&shared.0).triggered = true;
            let cleanup = action();
            locked(&shared.0).cleanup = Some(cleanup);
            shared.1.notify_all();
        });
        Canceller { outcome }
    }

    fn triggered(&self) -> bool {
        locked(&self.outcome.0).triggered
    }

    /// The cancel's own cleanup when a signal came, after that cancel ended.
    fn finish(&self) -> Option<Value> {
        let mut state = locked(&self.outcome.0);
        while state.triggered && state.cleanup.is_none() {
            state = self.outcome.1.wait(state).unwrap_or_else(|poison| poison.into_inner());
        }
        state.cleanup.take()
    }
}

/// Passes each SIGUSR1 on to the stage. The broker sends one TERM however often it is asked.
fn watch_interrupt(action: impl Fn() -> bool + Send + 'static) {
    std::thread::spawn(move || {
        loop {
            native::wait_interrupt_signal();
            action();
        }
    });
}

fn run_root(command: Vec<String>) -> Result<Report, Failure> {
    let options = SpawnOptions::inherited()?;
    let scope = Scope::open()?;
    let stage = scope.prepare(command, options, Vec::new(), None, 0).inspect_err(|_| {
        scope.close();
    })?;
    let (signalled_scope, handle) = (Arc::clone(&scope), stage.handle.clone());
    let canceller = Canceller::watch(move || json!(signalled_scope.cancel(&handle, true, false, None)));
    let (interrupted_scope, interrupted) = (Arc::clone(&scope), Arc::clone(&stage));
    watch_interrupt(move || interrupted_scope.interrupt(&interrupted).is_ok());
    let admission = scope.start(&stage).and_then(|_| scope.activate(&stage));
    let primary = admission.err().filter(|_| !canceller.triggered());
    let refused = primary.as_ref().map(|_| json!(scope.cancel(&stage.handle, true, false, None)));
    stage.wait_done(None);
    let cleanup = canceller.finish().or(refused);
    let mut report = root_report(&stage, primary, cleanup, &scope);
    if !scope.close() {
        unconfirmed(&mut report);
    }
    Ok(report)
}

/// The stage's own failure, or a refused admission. A cancelled or failed stage reports the cancel's cleanup.
fn root_report(stage: &Stage, primary: Option<Failure>, cleanup: Option<Value>, scope: &Scope) -> Report {
    let data = stage.data();
    let error = primary.or_else(|| data.error.clone());
    let result = data.result.as_ref();
    let cpu_scope = result.map_or_else(|| if data.child_cpu_s.is_some() { CPU_SCOPE.to_string() } else { NO_LEADER.to_string() }, |result| result.cpu_scope.clone());
    let (returncode, child_cpu_s, adopted) = (result.map(|result| result.returncode), data.child_cpu_s, result.and_then(|result| result.adopted_child_cpu_s));
    let own = result.map(|result| json!(result.cleanup));
    let failed = data.error.is_some();
    drop(data);
    let cleanup = cleanup.or(own).unwrap_or_else(|| {
        if failed { json!(scope.cancel(&stage.handle, true, false, None)) } else { json!({"complete": false, "errors": [], "child_reaped": false}) }
    });
    Report { returncode, child_cpu_s, adopted_child_cpu_s: adopted, cpu_scope, cleanup, error }
}

fn unconfirmed(report: &mut Report) {
    report.cleanup["complete"] = Value::Bool(false);
    let error = json!({"operation": "broker-close", "error": "owned broker has unsettled workers"});
    match report.cleanup["errors"].as_array_mut() {
        Some(errors) => errors.push(error),
        None => report.cleanup["errors"] = json!([error]),
    }
}

fn environment_json() -> Result<BTreeMap<String, String>, Failure> {
    let text = |value: OsString| value.into_string().map_err(|_| Failure::value("a nested owned stage needs a UTF-8 environment"));
    std::env::vars_os().map(|(key, value)| Ok((text(key)?, text(value)?))).collect()
}

fn nested_spawn(lineage: &Lineage, command: &[String]) -> Result<String, Failure> {
    let cwd = std::env::current_dir()?;
    let cwd = cwd.to_str().ok_or_else(|| Failure::value("a nested owned stage needs a UTF-8 cwd"))?;
    let stdio: Vec<_> = (0..3).map(|fd| unsafe { BorrowedFd::borrow_raw(fd) }.try_clone_to_owned()).collect::<Result<_, _>>()?;
    let raw: Vec<i32> = stdio.iter().map(AsRawFd::as_raw_fd).collect();
    let options = json!({"stdin": {"fd": 0}, "stdout": {"fd": 1}, "stderr": {"fd": 2}, "cwd": cwd, "env": environment_json()?, "passed": []});
    let request = json!({"op": "spawn", "cap": lineage.cap, "command": command, "options": options});
    let response = rpc(&lineage.socket, &request, &raw, Some(SHORT_RPC))?;
    response.get("handle").and_then(Value::as_str).map(str::to_string).ok_or_else(|| Failure::value("owned-stage broker sent no handle"))
}

fn nested_cancel(socket: &Path, cap: &str, handle: &str) -> Value {
    let request = json!({"op": "cancel", "cap": cap, "handle": handle});
    match rpc(socket, &request, &[], Some(CANCEL_RPC)) {
        Ok(response) => response.get("cleanup").cloned().unwrap_or(Value::Null),
        Err(error) => json!({"complete": false, "child_reaped": false, "family_cleanup": "unconfirmed",
                             "errors": [{"operation": "cleanup", "error": error.to_string()}]}),
    }
}

fn run_nested(lineage: Lineage, command: Vec<String>) -> Result<Report, Failure> {
    let handle = nested_spawn(&lineage, &command)?;
    let (socket, cap, target) = (lineage.socket.clone(), lineage.cap.clone(), handle.clone());
    let canceller = Canceller::watch(move || nested_cancel(&socket, &cap, &target));
    let (socket, cap, target) = (lineage.socket.clone(), lineage.cap.clone(), handle.clone());
    watch_interrupt(move || rpc(&socket, &json!({"op": "interrupt", "cap": cap, "handle": target}), &[], Some(CANCEL_RPC)).is_ok());
    let activate = json!({"op": "activate", "cap": lineage.cap, "handle": handle});
    let primary = rpc(&lineage.socket, &activate, &[], Some(SHORT_RPC)).err().filter(|_| !canceller.triggered());
    let refused = primary.as_ref().map(|_| nested_cancel(&lineage.socket, &lineage.cap, &handle));
    let wait = json!({"op": "wait", "cap": lineage.cap, "handle": handle, "timeout": null});
    let reply = match rpc(&lineage.socket, &wait, &[], None) {
        Ok(reply) => reply,
        Err(error) => return Ok(Report::lost(error)),
    };
    let cleanup = canceller.finish().or(refused);
    let stage_error = reply.get("error").filter(|error| !error.is_null()).map(|error| serde_json::from_value::<Failure>(error.clone())).transpose()?;
    let error = primary.or(stage_error);
    let result = reply.get("result").filter(|result| !result.is_null());
    let cleanup = cleanup.or_else(|| result.and_then(|result| result.get("cleanup")).cloned())
        .unwrap_or_else(|| nested_cancel(&lineage.socket, &lineage.cap, &handle));
    let field = |name: &str| result.and_then(|result| result.get(name)).cloned();
    Ok(Report {
        returncode: field("returncode").and_then(|code| code.as_i64()).map(|code| code as i32),
        child_cpu_s: field("child_cpu_s").or_else(|| reply.get("child_cpu_s").cloned()).and_then(|cpu| cpu.as_f64()),
        adopted_child_cpu_s: field("adopted_child_cpu_s").and_then(|cpu| cpu.as_f64()),
        cpu_scope: field("cpu_scope").and_then(|scope| scope.as_str().map(str::to_string)).unwrap_or_else(|| NO_LEADER.to_string()),
        cleanup, error,
    })
}

fn write_atomically(path: &Path, report: &Report) -> std::io::Result<()> {
    let temporary = PathBuf::from(format!("{}.tmp-{}", path.display(), std::process::id()));
    fs::write(&temporary, serde_json::to_vec_pretty(report)?)?;
    fs::rename(&temporary, path).inspect_err(|_| {
        let _ = fs::remove_file(&temporary);
    })
}

/// The arguments after `owned run`: FILE and COMMAND.
fn parse(args: &[OsString]) -> Option<(PathBuf, Vec<String>)> {
    let [flag, file, separator, command @ ..] = args else { return None };
    if flag != "--result" || separator != "--" || command.is_empty() {
        return None;
    }
    let command: Option<Vec<String>> = command.iter().map(|word| word.to_str().map(str::to_string)).collect();
    Some((PathBuf::from(file), command?))
}

fn run(args: &[OsString]) -> i32 {
    native::block_stop_signals();
    let Some((file, command)) = parse(args) else {
        eprintln!("usage: iotroute owned run --result FILE -- COMMAND...   (COMMAND words must be UTF-8)");
        return EXIT_USAGE;
    };
    if let Some(error) = file.parent().filter(|parent| !parent.as_os_str().is_empty()).and_then(|parent| fs::create_dir_all(parent).err()) {
        eprintln!("owned run: cannot create the folder of {}: {error}", file.display());
        return EXIT_USAGE;
    }
    let outcome = lineage().and_then(|lineage| match lineage {
        Some(lineage) => run_nested(lineage, command),
        None => run_root(command),
    });
    let report = outcome.unwrap_or_else(Report::never_started);
    if let Err(error) = write_atomically(&file, &report) {
        eprintln!("owned run: cannot write {}: {error}", file.display());
        return EXIT_NO_RESULT;
    }
    report.exit_code()
}

/// A one-shot worker may be finalized only after its owned broker has written
/// cleanup evidence. The finalizer replaces this lock-owning process, so the
/// worker flock stays held while the receipt and terminal state are written.
fn run_finalized(args: &[OsString]) -> i32 {
    let [result_flag, file, finalizer_flag, finalizer, separator, command @ ..] = args else { return EXIT_USAGE };
    if result_flag != "--result" || finalizer_flag != "--finalizer" || separator != "--" || command.is_empty() { return EXIT_USAGE; }
    let finalizer: Option<Vec<String>> = finalizer.to_str().and_then(|value| serde_json::from_str(value).ok());
    let Some(finalizer) = finalizer.filter(|value| !value.is_empty()) else { return EXIT_USAGE };
    let Some(lock_path) = std::env::var_os("IOT_PCB_WORKER_LOCK") else { return EXIT_USAGE };
    let Some(fd) = std::env::var_os("IOT_PCB_WORKER_FD").and_then(|value| value.to_str()?.parse::<i32>().ok()) else { return EXIT_USAGE };
    if lock::verify_worker_fd(Path::new(&lock_path), fd).is_err() { return EXIT_USAGE; }
    let mut run_args = vec![OsString::from("--result"), file.clone(), OsString::from("--")];
    run_args.extend_from_slice(command);
    let _ = run(&run_args);
    // An absent or failed broker receipt is interpreted as unconfirmed by the
    // finalizer; never replace it with an invented success here.
    if native::unblock_stop_signals().is_err() { return EXIT_FAILED; }
    let error = std::process::Command::new(&finalizer[0]).args(&finalizer[1..]).arg(file).exec();
    eprintln!("owned finalizer could not start: {error}");
    EXIT_FAILED
}

pub fn main(args: &[OsString]) -> i32 {
    match args.first().and_then(|verb| verb.to_str()) {
        Some("run") => run(&args[1..]),
        Some("run-finalized") => run_finalized(&args[1..]),
        Some("exec") => bootstrap::main(&args[1..]),
        _ => {
            eprintln!("usage: iotroute owned run --result FILE -- COMMAND...");
            EXIT_USAGE
        }
    }
}
