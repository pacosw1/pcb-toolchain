//! One subprocess of the job as an owned stage: bounded by the deadline, its whole process group cleaned up, one row in
//! stages.jsonl and one in run.jsonl. The broker is this same executable: `<self> owned run --result FILE -- COMMAND`.
use super::clock::{self, DEADLINE_ENV, Env};
use super::files::{append_line, read_lossy, rounded};
use super::record::{Record, RunRecord};
use super::stop::{self, Stop};
use serde_json::{Value, json};
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread::sleep;
use std::time::Duration;

const POLL: Duration = Duration::from_millis(50);
const EXIT_NOT_FOUND: i32 = 127;
const NO_LEADER: &str = "unavailable; no owned leader reaped";
static NEXT_RESULT: AtomicU64 = AtomicU64::new(0);

/// Where a stream of the stage goes.
#[derive(Debug, Clone)]
pub enum Out {
    Null,
    /// Read back into `Finished`.
    Capture,
    /// Stdout and stderr of the stage in this file: the router log.
    Log(PathBuf),
}

pub struct Spec<'a> {
    pub command: Vec<String>,
    pub stage: String,
    pub stdout: Out,
    pub stderr: Out,
    pub deadline: Option<f64>,
    pub env: Option<&'a Env>,
}

impl<'a> Spec<'a> {
    pub fn new(stage: impl Into<String>, command: Vec<String>) -> Spec<'a> {
        Spec { command, stage: stage.into(), stdout: Out::Capture, stderr: Out::Capture, deadline: None, env: None }
    }

    pub fn deadline(mut self, deadline: Option<f64>) -> Spec<'a> {
        self.deadline = deadline;
        self
    }

    pub fn logged(mut self, log: &Path) -> Spec<'a> {
        self.stdout = Out::Log(log.to_path_buf());
        self.stderr = Out::Log(log.to_path_buf());
        self
    }

    pub fn quiet_stdout(mut self) -> Spec<'a> {
        self.stdout = Out::Null;
        self
    }

    pub fn quiet_stderr(mut self) -> Spec<'a> {
        self.stderr = Out::Null;
        self
    }

    pub fn env(mut self, env: &'a Env) -> Spec<'a> {
        self.env = Some(env);
        self
    }
}

#[derive(Debug)]
pub struct Finished {
    pub returncode: i32,
    pub stdout: String,
    pub stderr: String,
}

/// The stage while it runs: what the watcher thread needs to stop it gracefully.
#[derive(Debug, Clone, Copy)]
pub struct Running {
    broker: i32,
}

impl Running {
    /// One graceful TERM to the stage's group, through the broker. Fastroute writes its best board and exits 0.
    pub fn interrupt(&self) -> bool {
        unsafe { libc::kill(self.broker, libc::SIGUSR1) == 0 }
    }
}

/// Runs the job's stages; `events` is stages.jsonl.
pub struct Runner {
    exe: PathBuf,
    env: Env,
    events: PathBuf,
    record: Option<RunRecord>,
    scratch: PathBuf,
}

/// What `owned run` wrote.
struct Report {
    returncode: Option<i32>,
    child_cpu_s: Value,
    adopted_child_cpu_s: Value,
    cpu_scope: Value,
    cleanup: Value,
    error: Option<(String, String)>,
}

fn read_report(path: &Path) -> Option<Report> {
    let data: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    let error = data["error"].as_object().map(|error| (error["type"].as_str().unwrap_or("").to_string(), error["message"].as_str().unwrap_or("").to_string()));
    Some(Report {
        returncode: data["returncode"].as_i64().map(|code| code as i32),
        child_cpu_s: data["child_cpu_s"].clone(),
        adopted_child_cpu_s: data["adopted_child_cpu_s"].clone(),
        cpu_scope: data["cpu_scope"].clone(),
        cleanup: data["cleanup"].clone(),
        error,
    })
}

fn open_log(path: &Path) -> Result<File, String> {
    File::create(path).map_err(|e| format!("{}: {e}", path.display()))
}

/// A file for a captured stream, removed after reading.
struct Streams {
    stdout: Option<PathBuf>,
    stderr: Option<PathBuf>,
}

impl Streams {
    fn wire(&mut self, command: &mut Command, spec: &Spec, base: &Path) -> Result<(), String> {
        match (&spec.stdout, &spec.stderr) {
            (Out::Log(a), Out::Log(b)) if a == b => {
                let file = open_log(a)?;
                command.stdout(file.try_clone().map_err(|e| e.to_string())?).stderr(file);
                return Ok(());
            }
            _ => {}
        }
        let wire = |out: &Out, name: &str, kept: &mut Option<PathBuf>| -> Result<Stdio, String> {
            Ok(match out {
                Out::Null => Stdio::null(),
                Out::Capture => {
                    let path = base.with_extension(name);
                    let file = open_log(&path)?;
                    *kept = Some(path);
                    file.into()
                }
                Out::Log(path) => open_log(path)?.into(),
            })
        };
        command.stdout(wire(&spec.stdout, "out", &mut self.stdout)?);
        command.stderr(wire(&spec.stderr, "err", &mut self.stderr)?);
        Ok(())
    }

    fn take(path: &Option<PathBuf>) -> String {
        let Some(path) = path else { return String::new() };
        let text = read_lossy(path).unwrap_or_default();
        let _ = fs::remove_file(path);
        text
    }
}

enum Wait {
    Done,
    Deadline,
    Cancelled,
}

fn wait_child(child: &mut Child, deadline: Option<f64>) -> Result<Wait, String> {
    let mut asked = false;
    let mut outcome = Wait::Done;
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            return Ok(outcome);
        }
        if !asked {
            if stop::stop_signal().is_some() {
                asked = true;
                outcome = Wait::Cancelled;
            } else if deadline.is_some_and(|deadline| clock::now() >= deadline) {
                asked = true;
                outcome = Wait::Deadline;
                unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
            }
        }
        sleep(POLL);
    }
}

impl Runner {
    pub fn new(outdir: &Path, env: Env, record: Option<RunRecord>) -> Result<Runner, String> {
        let exe = std::env::current_exe().map_err(|e| format!("this executable: {e}"))?;
        Ok(Runner { exe, env, events: outdir.join("stages.jsonl"), record, scratch: outdir.join(".stage") })
    }

    /// Another executable as broker: a test has no `owned` of its own.
    pub fn with_broker(mut self, exe: PathBuf) -> Runner {
        self.exe = exe;
        self
    }

    pub fn env(&self) -> &Env {
        &self.env
    }

    pub fn set_env(&mut self, env: Env) {
        self.env = env;
    }

    pub fn set_record(&mut self, record: RunRecord) {
        self.record = Some(record);
    }

    /// The child's deadline: the tightest of the spec, its env and this job.
    fn child_deadline(&self, spec: &Spec) -> Result<(Env, Option<f64>), String> {
        let mut env = spec.env.unwrap_or(&self.env).clone();
        let mut deadline = clock::inherited(&env)?;
        let tighter = |left: Option<f64>, right: Option<f64>| match (left, right) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        deadline = tighter(deadline, clock::inherited(&self.env)?);
        deadline = tighter(deadline, spec.deadline);
        if let Some(deadline) = deadline {
            env.insert(DEADLINE_ENV.to_string(), clock::encode(deadline));
        }
        Ok((env, deadline))
    }

    fn event(&self, spec: &Spec, status: &str, returncode: Option<i32>, wall_s: f64, cause: &Value, report: Option<&Report>) {
        let field = |pick: fn(&Report) -> Value| report.map_or(Value::Null, pick);
        let cpu_scope = report.map_or_else(|| json!(NO_LEADER), |report| report.cpu_scope.clone());
        let row = json!({"stage": spec.stage, "command": spec.command, "status": status, "returncode": returncode, "wall_s": wall_s, "cause": cause,
                         "cleanup": field(|r| r.cleanup.clone()), "child_cpu_s": field(|r| r.child_cpu_s.clone()),
                         "adopted_child_cpu_s": field(|r| r.adopted_child_cpu_s.clone()), "cpu_scope": cpu_scope});
        if let Err(error) = append_line(&self.events, &row.to_string()) {
            eprintln!("fastroute_job: stage event: {error}");
        }
        if let Some(record) = &self.record {
            let why = if status == "complete" { "owned subprocess stage of the job".to_string() } else { format!("stage {status}: {cause}") };
            let line = Record::new(&spec.stage, format!("stage {status}"), why).inputs(json!({"command": spec.command})).evidence("stages.jsonl")
                .result(json!({"returncode": returncode, "wall_s": rounded(wall_s, 3), "cause": cause}));
            let _ = record.append(line);
        }
    }

    /// Runs a stage to its end. `started` gets the running stage, for a watcher.
    pub fn run(&self, spec: Spec, started: impl FnOnce(Running)) -> Result<Finished, Stop> {
        let begun = clock::now();
        let (env, deadline) = self.child_deadline(&spec)?;
        let fail = |status: &str, cause: Value, report: Option<&Report>| self.event(&spec, status, None, clock::now() - begun, &cause, report);
        if clock::remaining(deadline) == Some(0.0) {
            fail("timeout", json!({"type": "TimeoutExpired", "signal": null}), None);
            return Err(Stop::Timeout { cause: "TimeoutExpired".to_string(), cleanup: Value::Null });
        }
        stop::check_cancelled()?;
        fs::create_dir_all(&self.scratch).map_err(|e| format!("{}: {e}", self.scratch.display()))?;
        let base = self.scratch.join(format!("{}-{}", std::process::id(), NEXT_RESULT.fetch_add(1, Ordering::Relaxed)));
        let result = base.with_extension("json");
        let mut command = Command::new(&self.exe);
        command.args(["owned", "run", "--result"]).arg(&result).arg("--").args(&spec.command).env_clear().envs(&env).stdin(Stdio::null());
        let mut streams = Streams { stdout: None, stderr: None };
        streams.wire(&mut command, &spec, &base)?;
        let mut child = command.spawn().map_err(|e| format!("owned broker {}: {e}", self.exe.display()))?;
        stop::set_current_broker(Some(child.id() as i32));
        started(Running { broker: child.id() as i32 });
        let waited = wait_child(&mut child, deadline);
        stop::set_current_broker(None);
        let waited = waited.map_err(Stop::failed)?;
        let report = read_report(&result);
        let _ = fs::remove_file(&result);
        let (stdout, stderr) = (Streams::take(&streams.stdout), Streams::take(&streams.stderr));
        self.settle(&spec, begun, waited, report, stdout, stderr)
    }

    fn settle(&self, spec: &Spec, begun: f64, waited: Wait, report: Option<Report>, stdout: String, stderr: String) -> Result<Finished, Stop> {
        let wall = clock::now() - begun;
        let cleanup = report.as_ref().map_or(Value::Null, |report| report.cleanup.clone());
        match waited {
            Wait::Deadline => {
                self.event(spec, "timeout", None, wall, &json!({"type": "TimeoutExpired", "signal": null}), report.as_ref());
                return Err(Stop::Timeout { cause: "TimeoutExpired".to_string(), cleanup });
            }
            Wait::Cancelled => {
                let signal = stop::stop_signal();
                self.event(spec, "cancelled", None, wall, &json!({"type": "StageCancelled", "signal": signal}), report.as_ref());
                return Err(Stop::Cancelled { signal, cleanup });
            }
            Wait::Done => {}
        }
        let Some(report) = report else {
            let cause = json!({"type": "RuntimeError", "signal": null});
            self.event(spec, "failed", None, wall, &cause, None);
            return Err(Stop::failed(format!("owned stage {} left no result", spec.stage)));
        };
        if let Some((kind, message)) = &report.error {
            self.event(spec, "failed", None, wall, &json!({"type": kind, "signal": null}), Some(&report));
            if kind == "FileNotFoundError" {
                return Err(Stop::Exit { code: EXIT_NOT_FOUND, message: Some(format!("{}: {message}", spec.stage)) });
            }
            return Err(Stop::failed(format!("{}: {kind}: {message}", spec.stage)));
        }
        let code = report.returncode.ok_or_else(|| Stop::failed(format!("{}: no return code", spec.stage)))?;
        if report.cleanup["complete"] != true {
            self.event(spec, "failed", Some(code), wall, &json!({"type": "RuntimeError", "signal": null}), Some(&report));
            return Err(Stop::failed("owned-stage cleanup could not be confirmed"));
        }
        let status = if code == 0 { "complete" } else { "failed" };
        self.event(spec, status, Some(code), wall, &Value::Null, Some(&report));
        Ok(Finished { returncode: code, stdout, stderr })
    }
}
