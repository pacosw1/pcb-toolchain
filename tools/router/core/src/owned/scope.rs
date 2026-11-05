//! The root broker: the one process that creates, signals and reaps owned stages.
//!
//! Lock order is registry, then stage data. `identity` is taken alone or before stage data.

use super::capture::Capture;
use super::failure::Failure;
use super::group::{adopted_zombies, live_members};
use super::native::{self, Reaped, Subreaper, locked};
use super::options::{Role, SpawnOptions, remaining_s};
use super::stage::{CPU_SCOPE, Cleanup, CleanupError, FAMILY_CLEANUP, Stage, StageResult, base64};
use serde::Deserialize;
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, BorrowedFd, OwnedFd, RawFd};
use std::os::unix::net::UnixListener;
use std::os::unix::process::CommandExt;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

pub const SOCKET_ENV: &str = "IOT_LEAN_BROKER_SOCKET";
pub const HANDLE_ENV: &str = "IOT_LEAN_STAGE_HANDLE";
pub const DEPTH_ENV: &str = "IOT_LEAN_STAGE_DEPTH";
pub const MAX_CONNECTIONS: usize = 32;
const MAX_STAGES: usize = 256;
const MAX_DEPTH: u8 = 2;
/// TERM gets five seconds for checkpoints, then KILL and reaping get two.
const CLEANUP: Duration = Duration::from_secs(7);
const KILL_PHASE: Duration = Duration::from_secs(2);
/// Broker thread and descriptor draining, separate from the stage budget.
const DRAIN: Duration = Duration::from_secs(2);
const SIGNAL_BUDGET: Duration = Duration::from_secs(1);
const PUMP: Duration = Duration::from_millis(50);
const SETTLE_POLL: Duration = Duration::from_millis(10);
const GROUP_GONE_BUDGET: Duration = Duration::from_millis(500);
const DENIED_SIGNAL_BUDGET: Duration = Duration::from_millis(100);
const DENIED_SIGNAL_POLL: Duration = Duration::from_millis(5);
const RELEASE: &[u8] = b"G";

pub struct Registry {
    pub stages: Vec<Arc<Stage>>,
    closing: bool,
    pub threads: Vec<JoinHandle<()>>,
}

pub struct Scope {
    pub path: PathBuf,
    directory: PathBuf,
    exe: PathBuf,
    registry: Mutex<Registry>,
    pub stopped: AtomicBool,
    pub connections: AtomicUsize,
    pub failures: Mutex<Vec<CleanupError>>,
    server: Mutex<Option<JoinHandle<()>>>,
    subreaper: Mutex<Option<Subreaper>>,
}

fn find<'a>(stages: &'a [Arc<Stage>], handle: &str) -> Option<&'a Arc<Stage>> {
    stages.iter().find(|stage| stage.handle == handle)
}

fn parent_closing(stages: &[Arc<Stage>], stage: &Stage) -> bool {
    stage.parent.as_deref().and_then(|handle| find(stages, handle)).is_some_and(|parent| parent.data().closing)
}

/// Ownership of `handle` covers its whole registered subtree.
fn descends_from(stages: &[Arc<Stage>], stage: &Arc<Stage>, handle: &str) -> bool {
    let mut ancestor = Some(stage);
    while let Some(current) = ancestor {
        if current.handle == handle {
            return true;
        }
        ancestor = current.parent.as_deref().and_then(|parent| find(stages, parent));
    }
    false
}

fn expired(stage: &Stage) -> Failure {
    Failure::new("TimeoutExpired", format!("Command {:?} timed out after 0 seconds", stage.command))
}

fn check_deadline(stage: &Stage) -> Result<(), Failure> {
    match remaining_s(&stage.options.env)? {
        Some(left) if left <= 0.0 => Err(expired(stage)),
        _ => Ok(()),
    }
}

/// Where one child stream goes. Pipe ends are made here so that stderr can share stdout's target.
enum Target {
    Inherit,
    Null,
    Fd(OwnedFd),
}

impl Target {
    fn into_stdio(self) -> Stdio {
        match self {
            Target::Inherit => Stdio::inherit(),
            Target::Null => Stdio::null(),
            Target::Fd(fd) => Stdio::from(fd),
        }
    }

    fn same_as_stdout(&self) -> io::Result<Target> {
        match self {
            Target::Inherit => Ok(Target::Fd(unsafe { BorrowedFd::borrow_raw(libc::STDOUT_FILENO) }.try_clone_to_owned()?)),
            Target::Null => Ok(Target::Null),
            Target::Fd(fd) => Ok(Target::Fd(fd.try_clone()?)),
        }
    }
}

/// The stage's pipes that the broker reads, by index in its Capture.
#[derive(Default)]
struct Streams {
    capture: Capture,
    stdout: Option<usize>,
    stderr: Option<usize>,
}

impl Streams {
    fn encoded(&mut self, index: Option<usize>) -> Option<String> {
        index.map(|index| base64(&self.capture.take(index)))
    }
}

fn take_fd(fds: &mut [Option<OwnedFd>], index: usize) -> Result<OwnedFd, Failure> {
    fds.get_mut(index).and_then(Option::take).ok_or_else(|| Failure::value("owned-stage descriptor role mismatch"))
}

fn target_of(role: Role, fds: &mut [Option<OwnedFd>], capture: &mut Capture) -> Result<(Target, Option<usize>), Failure> {
    Ok(match role {
        Role::Inherit | Role::Stdout => (Target::Inherit, None),
        Role::Null => (Target::Null, None),
        Role::Descriptor(index) => (Target::Fd(take_fd(fds, index)?), None),
        Role::Pipe => {
            let (read, write) = native::pipe()?;
            (Target::Fd(write), Some(capture.add(read)?))
        }
    })
}

/// A stdin pipe is closed at once, as lean_owned closes proc.stdin before collecting.
fn stdin_of(role: Role, fds: &mut [Option<OwnedFd>]) -> Result<Stdio, Failure> {
    Ok(match role {
        Role::Inherit | Role::Stdout => Stdio::inherit(),
        Role::Null => Stdio::null(),
        Role::Descriptor(index) => Stdio::from(take_fd(fds, index)?),
        Role::Pipe => Stdio::from(native::pipe()?.0),
    })
}

/// The bootstrap's report: exec failed before the command ran.
#[derive(Deserialize)]
struct BootstrapError {
    #[serde(rename = "type")]
    kind: String,
    message: String,
}

fn exec_failure(report: &[u8]) -> Failure {
    match serde_json::from_slice::<BootstrapError>(report) {
        Ok(detail) if detail.kind == "FileNotFoundError" => Failure::new("FileNotFoundError", detail.message),
        Ok(detail) => Failure::new("OSError", detail.message),
        Err(_) => Failure::new("OSError", String::from_utf8_lossy(report)),
    }
}

impl Scope {
    pub fn open() -> Result<Arc<Scope>, Failure> {
        native::probe_runtime()?;
        let exe = std::env::current_exe()?;
        let directory = native::private_folder()?;
        let path = directory.join("socket");
        let listener = UnixListener::bind(&path).and_then(|listener| Subreaper::acquire().map(|subreaper| (listener, subreaper)));
        let (listener, subreaper) = match listener {
            Ok(parts) => parts,
            Err(error) => {
                let _ = fs::remove_dir_all(&directory);
                return Err(error.into());
            }
        };
        let scope = Arc::new(Scope {
            path, directory, exe,
            registry: Mutex::new(Registry { stages: Vec::new(), closing: false, threads: Vec::new() }),
            stopped: AtomicBool::new(false),
            connections: AtomicUsize::new(0),
            failures: Mutex::new(Vec::new()),
            server: Mutex::new(None),
            subreaper: Mutex::new(Some(subreaper)),
        });
        let serving = Arc::clone(&scope);
        let server = thread::Builder::new().name("owned-stage-broker".to_string()).spawn(move || serving.accept_loop(listener))?;
        *locked(&scope.server) = Some(server);
        Ok(scope)
    }

    pub fn registry(&self) -> MutexGuard<'_, Registry> {
        locked(&self.registry)
    }

    pub fn prepare(&self, command: Vec<String>, options: SpawnOptions, fds: Vec<OwnedFd>, parent: Option<&Arc<Stage>>, depth: u8) -> Result<Arc<Stage>, Failure> {
        if command.is_empty() || depth > MAX_DEPTH {
            return Err(Failure::value("invalid owned-stage command/depth"));
        }
        let mut registry = self.registry();
        if registry.closing || parent.is_some_and(|parent| parent.data().closing) {
            return Err(Failure::value("owned-stage admission is closed"));
        }
        if registry.stages.len() >= MAX_STAGES {
            return Err(Failure::value("owned-stage registry bound exceeded"));
        }
        let stage = Arc::new(Stage::new(command, options, fds, parent.map(|parent| parent.handle.clone()), depth)?);
        registry.stages.push(Arc::clone(&stage));
        Ok(stage)
    }

    pub fn start(self: &Arc<Self>, stage: &Arc<Stage>) -> Result<(), Failure> {
        let mut registry = self.registry();
        {
            let mut data = stage.data();
            if data.done || data.started {
                return Err(Failure::value("owned stage already settled/started"));
            }
            data.started = true;
        }
        let (scope, owned) = (Arc::clone(self), Arc::clone(stage));
        match thread::Builder::new().name("owned-stage-spawn".to_string()).spawn(move || scope.drive(&owned)) {
            Ok(thread) => registry.threads.push(thread),
            Err(error) => {
                stage.data().started = false;
                return Err(error.into());
            }
        }
        Ok(())
    }

    pub fn activate(&self, stage: &Stage) -> Result<(), Failure> {
        let registry = self.registry();
        if registry.closing || stage.data().closing || parent_closing(&registry.stages, stage) {
            return Err(Failure::value("owned-stage admission is closed"));
        }
        check_deadline(stage)?;
        stage.data().admitted = true;
        stage.notify();
        Ok(())
    }

    /// One graceful TERM of a registered group, never a process found by name.
    pub fn interrupt(&self, stage: &Stage) -> Result<(), Failure> {
        self.signal(stage, libc::SIGTERM, Instant::now() + SIGNAL_BUDGET)
    }

    fn group_finished(&self, pid: i32, deadline: Instant) -> Result<bool, Failure> {
        Ok(native::peek_exit(pid)? && live_members(pid, pid, deadline, false)?.is_empty())
    }

    /// Signals the stage's own group, once per signal, and never after the reap. Darwin denies a signal to a
    /// zombie-only group, and may deny killpg during the exit transition before waitid publishes terminal status.
    /// A denial on a group that stays live stops the direct child and remains an error.
    fn signal(&self, stage: &Stage, signal: i32, deadline: Instant) -> Result<(), Failure> {
        let _identity = lock_until(&stage.identity, deadline)?;
        let (pid, reaped, sent) = {
            let data = stage.data();
            (data.pid, data.reaped, data.signals_sent.contains(&signal))
        };
        let Some(pid) = pid.filter(|_| !reaped && !sent) else { return Ok(()) };
        if self.group_finished(pid, deadline)? {
            return Ok(());
        }
        match native::killpg(pid, signal) {
            Ok(()) => {
                stage.data().signals_sent.push(signal);
                Ok(())
            }
            Err(error) if error.raw_os_error() == Some(libc::EPERM) => {
                let until = deadline.min(Instant::now() + DENIED_SIGNAL_BUDGET);
                loop {
                    if self.group_finished(pid, deadline)? {
                        return Ok(());
                    }
                    if Instant::now() >= until {
                        break;
                    }
                    thread::sleep(DENIED_SIGNAL_POLL);
                }
                native::kill(pid, signal)?;
                Err(error.into())
            }
            Err(error) => Err(error.into()),
        }
    }

    /// The whole life of a stage on its own thread. A panic must still settle the stage and clean its group.
    fn drive(&self, stage: &Arc<Stage>) {
        let outcome = catch_unwind(AssertUnwindSafe(|| self.launch_and_collect(stage)));
        let failure = match outcome {
            Ok(Ok(())) => None,
            Ok(Err(failure)) => Some(failure),
            Err(_) => Some(Failure::runtime("owned stage thread panicked")),
        };
        if let Some(failure) = failure {
            self.fail(stage, failure);
        }
        stage.data().fds.clear();
    }

    fn bootstrap_command(&self, stage: &Stage, release: RawFd, errors: RawFd, mappings: &[[RawFd; 2]]) -> Result<Command, Failure> {
        let mut env = stage.options.env.clone();
        env.insert(SOCKET_ENV.into(), self.path.clone().into_os_string());
        env.insert(HANDLE_ENV.into(), OsString::from(&stage.handle));
        env.insert(DEPTH_ENV.into(), OsString::from((stage.depth + 1).to_string()));
        let mut command = Command::new(&self.exe);
        command.args(["owned", "exec", &release.to_string(), &errors.to_string(), &serde_json::to_string(mappings)?]);
        command.args(&stage.command).env_clear().envs(env).current_dir(&stage.options.cwd);
        Ok(command)
    }

    /// Starts the gated bootstrap in its own session. Returns its PID and the streams to collect.
    fn spawn_leader(&self, stage: &Stage, release: RawFd, errors: RawFd) -> Result<(i32, Streams), Failure> {
        let mut fds = std::mem::take(&mut stage.data().fds);
        let options = &stage.options;
        let mut streams = Streams::default();
        let stdin = stdin_of(options.stdin, &mut fds)?;
        let (stdout, stdout_capture) = target_of(options.stdout, &mut fds, &mut streams.capture)?;
        let (stderr, stderr_capture) = match options.stderr {
            Role::Stdout => (stdout.same_as_stdout()?, None),
            role => target_of(role, &mut fds, &mut streams.capture)?,
        };
        (streams.stdout, streams.stderr) = (stdout_capture, stderr_capture);
        let mut sources = Vec::new();
        for (target, index) in &options.passed {
            sources.push((*target, take_fd(&mut fds, *index)?));
        }
        let mappings: Vec<[RawFd; 2]> = sources.iter().map(|(target, fd)| [*target, fd.as_raw_fd()]).collect();
        let inherited: Vec<RawFd> = mappings.iter().map(|[_, source]| *source).chain([release, errors]).collect();
        let mut command = self.bootstrap_command(stage, release, errors, &mappings)?;
        command.stdin(stdin).stdout(stdout.into_stdio()).stderr(stderr.into_stdio());
        // Between fork and exec: only async-signal-safe calls, and nothing allocates.
        unsafe {
            command.pre_exec(move || {
                if libc::setsid() < 0 {
                    return Err(io::Error::last_os_error());
                }
                native::unblock_stop_signals()?;
                for fd in &inherited {
                    if libc::fcntl(*fd, libc::F_SETFD, 0) < 0 {
                        return Err(io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }
        let child = command.spawn()?;
        Ok((child.id() as i32, streams))
    }

    fn launch_and_collect(&self, stage: &Arc<Stage>) -> Result<(), Failure> {
        let (release_read, release_write) = native::pipe()?;
        let (error_read, error_write) = native::pipe()?;
        let (pid, streams) = self.spawn_leader(stage, release_read.as_raw_fd(), error_write.as_raw_fd())?;
        stage.data().pid = Some(pid);
        drop(error_write);
        drop(release_read);
        if native::getpgid(pid)? != pid {
            return Err(Failure::value("owned stage did not create its own process group"));
        }
        if stage.wait_admission() {
            check_deadline(stage)?;
            File::from(release_write).write_all(RELEASE)?;
        } else {
            drop(release_write);
        }
        let mut report = Vec::new();
        File::from(error_read).read_to_end(&mut report)?;
        if !report.is_empty() {
            return Err(exec_failure(&report));
        }
        self.collect(stage, pid, streams)
    }

    fn begin_cleanup(&self, stage: &Stage) -> Instant {
        let mut data = stage.data();
        data.closing = true;
        *data.cleanup_until.get_or_insert_with(|| Instant::now() + CLEANUP)
    }

    fn term_until(&self, stage: &Stage, until: Instant) -> Instant {
        let mut data = stage.data();
        *data.term_until.get_or_insert(until - KILL_PHASE)
    }

    fn members_alive(&self, pid: i32, until: Instant) -> Result<bool, Failure> {
        Ok(!live_members(pid, pid, until, false)?.is_empty())
    }

    /// A finished leader must leave no helpers: TERM, then KILL, all inside the stage's cleanup budget.
    fn clear_group(&self, stage: &Stage, pid: i32, until: Instant, streams: &mut Streams, errors: &mut Vec<CleanupError>) -> Result<(), Failure> {
        if !self.members_alive(pid, until)? {
            return Ok(());
        }
        if !stage.data().cancelled {
            self.signal(stage, libc::SIGTERM, until)?;
        }
        while Instant::now() < self.term_until(stage, until) && self.members_alive(pid, until)? {
            streams.capture.pump(PUMP)?;
        }
        if self.members_alive(pid, until)? {
            self.signal(stage, libc::SIGKILL, until)?;
            while Instant::now() < until && self.members_alive(pid, until)? {
                streams.capture.pump(PUMP)?;
            }
        }
        if Instant::now() >= until || self.members_alive(pid, until)? {
            errors.push(CleanupError::new("verify", "owned group still has live members"));
        }
        Ok(())
    }

    fn reap_adopted(&self, stage: &Stage, pid: i32, deadline: Instant) -> Result<(), Failure> {
        for zombie in adopted_zombies(pid, deadline)? {
            match native::wait4(zombie, libc::WNOHANG) {
                Ok(Some(reaped)) => {
                    let mut data = stage.data();
                    data.adopted_child_cpu_s += reaped.cpu_s;
                    data.adopted_children += 1;
                }
                Ok(None) => {}
                Err(failure) if failure.kind == "ChildProcessError" => {}
                Err(failure) => return Err(failure),
            }
        }
        Ok(())
    }

    /// The only reap. The tombstone goes first: no later signal can use this PID.
    fn reap(&self, stage: &Stage, pid: i32) -> Result<Reaped, Failure> {
        let _identity = locked(&stage.identity);
        if !native::peek_exit(pid)? {
            return Err(Failure::runtime("cannot reap a live owned leader"));
        }
        stage.data().reaped = true;
        let reaped = native::wait4(pid, 0)?.ok_or_else(|| Failure::runtime("owned leader wait returned nothing"))?;
        stage.data().child_cpu_s = Some(reaped.cpu_s);
        Ok(reaped)
    }

    /// Verification only: after the reap the group number proves nothing, so this signal 0 is never a real signal.
    fn verify_group_gone(&self, pid: i32, until: Instant, errors: &mut Vec<CleanupError>) {
        let until = until.min(Instant::now() + GROUP_GONE_BUDGET);
        loop {
            match native::killpg(pid, 0) {
                Err(error) if error.raw_os_error() == Some(libc::ESRCH) => return,
                Err(error) => return errors.push(CleanupError::new("verify", error)),
                Ok(()) if Instant::now() >= until => return errors.push(CleanupError::new("verify", "group disappearance unconfirmed")),
                Ok(()) => thread::sleep(SETTLE_POLL),
            }
        }
    }

    fn collect(&self, stage: &Arc<Stage>, pid: i32, mut streams: Streams) -> Result<(), Failure> {
        while !native::peek_exit(pid)? {
            streams.capture.pump(PUMP)?;
        }
        let until = self.begin_cleanup(stage);
        let mut errors = Vec::new();
        if !stage.data().cancelled {
            errors.extend(self.cancel(&stage.handle, false, false, Some(until)).errors);
        }
        self.clear_group(stage, pid, until, &mut streams, &mut errors)?;
        self.reap_adopted(stage, pid, until)?;
        let reaped = self.reap(stage, pid)?;
        while streams.capture.is_open() && Instant::now() < until {
            streams.capture.pump(PUMP)?;
        }
        if streams.capture.is_open() {
            errors.push(CleanupError::new("pipes", "owned captured streams remain open"));
        }
        self.verify_group_gone(pid, until, &mut errors);
        let (stdout, stderr) = (streams.encoded(streams.stdout), streams.encoded(streams.stderr));
        stage.settle(|data| {
            let gone = errors.is_empty();
            data.result = Some(StageResult {
                returncode: reaped.code, stdout, stderr, child_cpu_s: Some(reaped.cpu_s),
                adopted_child_cpu_s: Some(data.adopted_child_cpu_s), adopted_children: Some(data.adopted_children),
                cpu_scope: CPU_SCOPE.to_string(),
                cleanup: Cleanup { complete: gone, errors, child_reaped: true, family_cleanup: Some(FAMILY_CLEANUP.to_string()),
                                   owned_group_gone: Some(gone), leader_spawned: None },
            });
        });
        Ok(())
    }

    fn kill_failed_group(&self, stage: &Stage, pid: i32, until: Instant) -> Result<(), Failure> {
        let drain_until = (until + DRAIN).min(Instant::now() + DRAIN);
        while !native::peek_exit(pid)? && Instant::now() < drain_until {
            thread::sleep(SETTLE_POLL);
        }
        if !native::peek_exit(pid)? {
            return Err(Failure::runtime("owned leader remains alive after KILL"));
        }
        self.reap_adopted(stage, pid, drain_until)?;
        self.reap(stage, pid)?;
        if !live_members(pid, pid, drain_until, false)?.is_empty() {
            return Err(Failure::runtime("owned group still has live members after KILL"));
        }
        Ok(())
    }

    /// Any stage failure: keep the first cause, kill the subtree at once, and settle with what could be confirmed.
    fn fail(&self, stage: &Arc<Stage>, failure: Failure) {
        let until = {
            let mut data = stage.data();
            data.closing = true;
            data.error = Some(failure);
            data.cleanup_until.unwrap_or_else(|| Instant::now() + DRAIN)
        };
        stage.notify();
        let mut errors = self.cancel(&stage.handle, false, true, Some(until)).errors;
        let (pid, reaped) = {
            let data = stage.data();
            (data.pid, data.reaped)
        };
        if let Some(pid) = pid.filter(|_| !reaped) {
            if let Err(error) = self.signal(stage, libc::SIGKILL, until) {
                errors.push(CleanupError::new("owned-group-signal", error));
            }
            if let Err(error) = self.kill_failed_group(stage, pid, until) {
                errors.push(CleanupError::new("owned-group", error));
            }
        }
        stage.settle(|data| data.cleanup_errors.extend(errors));
    }

    fn select_for_cancel(&self, handle: &str, include_self: bool, immediate: bool, deadline: Instant) -> Vec<Arc<Stage>> {
        let registry = self.registry();
        let selected: Vec<Arc<Stage>> = registry.stages.iter()
            .filter(|stage| descends_from(&registry.stages, stage, handle) && (include_self || stage.handle != handle))
            .cloned().collect();
        for stage in &selected {
            let mut data = stage.data();
            data.closing = true;
            data.cancelled = true;
            if !data.done {
                let until = data.cleanup_until.map_or(deadline, |current| current.min(deadline));
                data.cleanup_until = Some(until);
                data.term_until = Some(if immediate { until } else { until - KILL_PHASE });
            }
            if !data.started && !data.done {
                data.fds.clear();
                data.result = Some(StageResult::never_spawned());
                data.done = true;
            }
            drop(data);
            stage.notify();
        }
        selected
    }

    fn signal_all(&self, selected: &[Arc<Stage>], signal: i32, until: Instant, errors: &mut Vec<CleanupError>) {
        for stage in selected {
            match self.signal(stage, signal, until) {
                Err(failure) if failure.is_gone() => {}
                Err(failure) => errors.push(CleanupError { operation: "killpg".to_string(), signal: Some(signal), error: failure.message }),
                Ok(()) => {}
            }
        }
    }

    /// TERM then KILL for a stage and its registered subtree, or KILL at once when `immediate`.
    pub fn cancel(&self, handle: &str, include_self: bool, immediate: bool, deadline: Option<Instant>) -> Cleanup {
        let budget = if immediate { KILL_PHASE } else { CLEANUP };
        let deadline = deadline.unwrap_or_else(|| Instant::now() + budget);
        let selected = self.select_for_cancel(handle, include_self, immediate, deadline);
        let mut errors = Vec::new();
        let phases = if immediate { vec![(libc::SIGKILL, deadline)] } else { vec![(libc::SIGTERM, deadline - KILL_PHASE), (libc::SIGKILL, deadline)] };
        for (signal, until) in phases {
            self.signal_all(&selected, signal, until, &mut errors);
            while Instant::now() < until && selected.iter().any(|stage| !stage.is_done()) {
                thread::sleep(SETTLE_POLL);
            }
            if selected.iter().all(|stage| stage.is_done()) {
                break;
            }
        }
        for stage in &selected {
            let data = stage.data();
            if !data.done {
                errors.push(CleanupError::new("pending", "owned stage has not settled"));
            } else if data.error.is_some() {
                errors.extend(data.cleanup_errors.iter().cloned());
            } else if let Some(result) = &data.result {
                errors.extend(result.cleanup.errors.iter().cloned());
            }
        }
        let child_reaped = selected.iter().all(|stage| {
            let data = stage.data();
            data.reaped || !data.started
        });
        Cleanup { complete: errors.is_empty(), errors, child_reaped, family_cleanup: Some(FAMILY_CLEANUP.to_string()),
                  owned_group_gone: None, leader_spawned: None }
    }

    fn join_workers(&self) -> bool {
        self.stopped.store(true, Ordering::SeqCst);
        let until = Instant::now() + DRAIN;
        let finished = |worker: &JoinHandle<()>| {
            while Instant::now() < until && !worker.is_finished() {
                thread::sleep(SETTLE_POLL);
            }
            worker.is_finished()
        };
        // The accept thread first: only it adds request threads.
        let server_stopped = locked(&self.server).take().is_none_or(|server| finished(&server));
        let workers = std::mem::take(&mut self.registry().threads);
        server_stopped && workers.iter().all(finished)
    }

    fn stages_settled(&self) -> bool {
        self.registry().stages.iter().all(|stage| {
            let data = stage.data();
            data.done && (data.pid.is_none() || data.reaped)
        })
    }

    /// Adoption ends only when no group member is left, zombies included.
    fn restore_adoption(&self) -> bool {
        if !cfg!(target_os = "linux") {
            return true;
        }
        let pids: Vec<i32> = self.registry().stages.iter().filter_map(|stage| stage.pid()).collect();
        let until = Instant::now() + SIGNAL_BUDGET;
        let empty = pids.iter().all(|pid| live_members(*pid, -1, until, true).is_ok_and(|members| members.is_empty()));
        empty && locked(&self.subreaper).take().is_none_or(|subreaper| subreaper.restore().is_ok())
    }

    /// True when ownership is fully settled. Anything else keeps the private folder as evidence.
    pub fn close(&self) -> bool {
        let roots: Vec<Arc<Stage>> = {
            let mut registry = self.registry();
            registry.closing = true;
            registry.stages.iter().filter(|stage| {
                let data = stage.data();
                stage.parent.is_none() && !data.done && !data.cancelled
            }).cloned().collect()
        };
        for stage in roots {
            self.cancel(&stage.handle, true, false, None);
        }
        let settled = self.join_workers() && self.stages_settled() && self.restore_adoption();
        let complete = settled && locked(&self.failures).is_empty();
        if complete {
            let _ = fs::remove_dir_all(&self.directory);
        }
        complete
    }
}

/// std has no timed lock; a signal must not wait longer than its budget behind a slow observation.
fn lock_until(mutex: &Mutex<()>, deadline: Instant) -> Result<MutexGuard<'_, ()>, Failure> {
    loop {
        match mutex.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(std::sync::TryLockError::Poisoned(poison)) => return Ok(poison.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) if Instant::now() >= deadline => {
                return Err(Failure::timeout("owned signal-lock budget exhausted"));
            }
            Err(std::sync::TryLockError::WouldBlock) => thread::sleep(Duration::from_millis(1)),
        }
    }
}
