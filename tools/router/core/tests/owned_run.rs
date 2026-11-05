//! Black-box checks of `iotroute owned run` on the built binary, the cases of tools/test_lean_owned.py that fit.
//! Process fixtures only: no KiCad, router, daemon or unrelated PID.

use serde_json::{Value, json};
use std::fs;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

/// The real frame code, so that these tests speak what the binary speaks.
#[allow(dead_code)]
#[path = "../src/owned"]
mod proto {
    pub mod failure;
    pub mod native;
    pub mod wire;
}
use proto::wire;

const BIN: &str = env!("CARGO_BIN_EXE_iotroute");
const LINEAGE: [&str; 3] = ["IOT_LEAN_BROKER_SOCKET", "IOT_LEAN_STAGE_HANDLE", "IOT_LEAN_STAGE_DEPTH"];

struct Fixture {
    folder: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Fixture {
        let folder = std::env::temp_dir().join(format!("owned-run-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(&folder).unwrap();
        Fixture { folder: folder.canonicalize().unwrap() }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.folder.join(name)
    }

    fn text(&self, name: &str) -> String {
        self.path(name).to_str().unwrap().to_string()
    }

    fn command(&self, words: &[&str]) -> Command {
        let mut command = Command::new(BIN);
        command.args(["owned", "run", "--result", &self.text("result.json"), "--"]).args(words);
        command.stdin(Stdio::null()).current_dir(&self.folder);
        for key in LINEAGE {
            command.env_remove(key);
        }
        command
    }

    fn run(&self, words: &[&str]) -> (ExitStatus, Value) {
        let status = self.command(words).stdout(Stdio::null()).stderr(Stdio::null()).status().unwrap();
        (status, self.result())
    }

    fn result(&self) -> Value {
        serde_json::from_slice(&fs::read(self.path("result.json")).unwrap()).unwrap()
    }

    fn wait_for(&self, name: &str) -> String {
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            let text = fs::read_to_string(self.path(name)).unwrap_or_default();
            if !text.trim().is_empty() {
                return text.trim().to_string();
            }
            assert!(Instant::now() < until, "{name} never appeared");
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.folder);
    }
}

fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

fn stop(child: &Child, signal: i32) {
    assert_eq!(unsafe { libc::kill(child.id() as i32, signal) }, 0);
}

fn assert_clean(result: &Value) {
    assert_eq!(result["cleanup"]["complete"], true, "{result}");
    assert_eq!(result["cleanup"]["errors"], json!([]), "{result}");
}

/// The test binary itself as a stage: a client inside an owned group, like a Python controller.
fn helper_stage(fixture: &Fixture, mode: &str) -> Value {
    let exe = std::env::current_exe().unwrap();
    let status = fixture.command(&[exe.to_str().unwrap(), "--ignored", "--exact", "stage_helper", "--nocapture"])
        .env("OWNED_HELPER_MODE", mode).env("OWNED_HELPER_FOLDER", &fixture.folder)
        .stdout(Stdio::null()).stderr(Stdio::null()).status().unwrap();
    assert!(status.success(), "helper {mode}: {:?} {}", status, fs::read_to_string(fixture.path("helper.log")).unwrap_or_default());
    serde_json::from_slice(&fs::read(fixture.path("helper.json")).unwrap()).unwrap()
}

#[test]
fn exit_code_and_result_fields() {
    let fixture = Fixture::new("fields");
    let (status, result) = fixture.run(&["/bin/sh", "-c", "exit 3"]);
    assert_eq!(status.code(), Some(3));
    assert_eq!(result["returncode"], 3);
    assert_eq!(result["error"], Value::Null);
    assert_eq!(result["adopted_child_cpu_s"], 0.0);
    assert!(result["child_cpu_s"].is_f64());
    assert!(result["cpu_scope"].as_str().unwrap().contains("wait4"));
    assert_clean(&result);
    assert_eq!(result["cleanup"]["child_reaped"], true);
    assert_eq!(result["cleanup"]["owned_group_gone"], true);
    assert_eq!(result["cleanup"]["family_cleanup"], "registered owned-stage groups");
}

#[test]
fn a_signal_death_is_a_negative_returncode() {
    let fixture = Fixture::new("signal");
    let (status, result) = fixture.run(&["/bin/sh", "-c", "kill -KILL $$"]);
    assert_eq!(result["returncode"], -9);
    assert_eq!(status.code(), Some(137));
}

#[test]
fn stdio_cwd_and_environment_come_from_the_caller() {
    let fixture = Fixture::new("stdio");
    let out = fs::File::create(fixture.path("out.log")).unwrap();
    let mut command = fixture.command(&["/bin/sh", "-c", "pwd; echo \"$ONLY_TEST\"; echo \"${HOME:-unset}\"; echo err >&2; cat"]);
    command.env_clear().env("ONLY_TEST", "exact").env("PATH", "/bin:/usr/bin");
    let status = command.stdout(out.try_clone().unwrap()).stderr(out).status().unwrap();
    assert!(status.success());
    let text = fs::read_to_string(fixture.path("out.log")).unwrap();
    assert_eq!(text, format!("{}\nexact\nunset\nerr\n", fixture.folder.display()));
}

#[test]
fn the_stage_gets_lineage_in_its_own_session() {
    let fixture = Fixture::new("lineage");
    let script = "echo \"$IOT_LEAN_BROKER_SOCKET|$IOT_LEAN_STAGE_HANDLE|$IOT_LEAN_STAGE_DEPTH\" > env; ps -o pid=,pgid=,sess= -p $$ > ids";
    fixture.run(&["/bin/sh", "-c", script]);
    let env = fs::read_to_string(fixture.path("env")).unwrap();
    let fields: Vec<&str> = env.trim().split('|').collect();
    assert!(fields[0].starts_with("/tmp/los-") && fields[0].ends_with("/socket"), "{env}");
    assert_eq!(fields[1].len(), 64);
    assert_eq!(fields[2], "1");
    assert!(!Path::new(fields[0]).parent().unwrap().exists(), "a settled broker removes its private folder");
    let ids = fs::read_to_string(fixture.path("ids")).unwrap();
    let ids: Vec<&str> = ids.split_whitespace().collect();
    assert_eq!(ids[0], ids[1], "the leader leads its group");
}

#[test]
fn a_missing_executable_keeps_the_spawn_error_and_reaps_the_bootstrap() {
    let fixture = Fixture::new("missing");
    let (status, result) = fixture.run(&["/nonexistent/owned-test-executable"]);
    assert_eq!(status.code(), Some(127));
    assert_eq!(result["error"]["type"], "FileNotFoundError");
    assert_eq!(result["cleanup"]["child_reaped"], true);
    assert_clean(&result);
}

#[test]
fn an_expired_deadline_never_releases_work() {
    let fixture = Fixture::new("deadline");
    let marker = fixture.text("work");
    let status = fixture.command(&["/usr/bin/touch", &marker]).env("IOT_LEAN_DEADLINE", "clock-monotonic-v1:1.0").status().unwrap();
    let result = fixture.result();
    assert_eq!(status.code(), Some(124));
    assert_eq!(result["error"]["type"], "TimeoutExpired");
    assert!(!Path::new(&marker).exists());
    assert_clean(&result);
}

#[test]
fn a_malformed_deadline_is_an_error_not_no_deadline() {
    let fixture = Fixture::new("baddeadline");
    let marker = fixture.text("work");
    let status = fixture.command(&["/usr/bin/touch", &marker]).env("IOT_LEAN_DEADLINE", "12.5").status().unwrap();
    assert_eq!(status.code(), Some(1));
    assert!(fixture.result()["error"]["message"].as_str().unwrap().contains("deadline protocol"));
    assert!(!Path::new(&marker).exists());
}

#[test]
fn cpu_comes_from_the_leader_wait4() {
    let fixture = Fixture::new("cpu");
    let (_, result) = fixture.run(&["/bin/sh", "-c", "i=0; while [ $i -lt 200000 ]; do i=$((i+1)); done"]);
    assert!(result["child_cpu_s"].as_f64().unwrap() > 0.02, "{result}");
}

#[test]
fn success_cleans_a_term_ignoring_helper_before_return() {
    let fixture = Fixture::new("helper");
    let script = "( trap '' TERM; exec sleep 30 ) & echo $! > helper";
    let started = Instant::now();
    let (status, result) = fixture.run(&["/bin/sh", "-c", script]);
    let pid: i32 = fixture.wait_for("helper").parse().unwrap();
    assert!(status.success());
    assert!(!alive(pid), "the helper must be gone when the stage settles");
    assert!(started.elapsed() < Duration::from_secs(8), "{:?}", started.elapsed());
    assert_clean(&result);
}

#[test]
fn a_plain_helper_goes_on_the_first_term() {
    let fixture = Fixture::new("plainhelper");
    let started = Instant::now();
    let (_, result) = fixture.run(&["/bin/sh", "-c", "sleep 30 & echo $! > helper"]);
    assert!(!alive(fixture.wait_for("helper").parse().unwrap()));
    assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
    assert_clean(&result);
}

fn cancelled_by(signal: i32, name: &str) {
    let fixture = Fixture::new(name);
    let mut child = fixture.command(&["/bin/sh", "-c", "echo $$ > leader; exec sleep 30"]).spawn().unwrap();
    let leader: i32 = fixture.wait_for("leader").parse().unwrap();
    stop(&child, signal);
    let status = child.wait().unwrap();
    let result = fixture.result();
    assert_eq!(result["returncode"], -libc::SIGTERM, "{result}");
    assert_eq!(status.code(), Some(128 + libc::SIGTERM));
    assert_clean(&result);
    assert!(!alive(leader));
}

#[test]
fn sigterm_cancels_the_stage() {
    cancelled_by(libc::SIGTERM, "term");
}

#[test]
fn sigint_cancels_the_stage() {
    cancelled_by(libc::SIGINT, "int");
}

#[test]
fn a_term_ignoring_leader_gets_kill_after_the_grace() {
    let fixture = Fixture::new("killgrace");
    let mut child = fixture.command(&["/bin/sh", "-c", "trap '' TERM; echo $$ > leader; while :; do sleep 1; done"]).spawn().unwrap();
    fixture.wait_for("leader");
    let started = Instant::now();
    stop(&child, libc::SIGTERM);
    stop(&child, libc::SIGTERM);
    child.wait().unwrap();
    let elapsed = started.elapsed();
    assert_eq!(fixture.result()["returncode"], -libc::SIGKILL);
    assert!(elapsed >= Duration::from_secs(4) && elapsed < Duration::from_secs(8), "{elapsed:?}");
    assert_clean(&fixture.result());
}

#[test]
fn nesting_goes_through_the_root_broker_and_stops_at_the_depth_bound() {
    let fixture = Fixture::new("nested");
    let inner = |name: &str| vec![BIN.to_string(), "owned".into(), "run".into(), "--result".into(), fixture.text(name), "--".into()];
    let mut words = inner("one.json");
    words.extend(inner("two.json"));
    words.extend(["/bin/sh".to_string(), "-c".to_string(), "echo $IOT_LEAN_STAGE_DEPTH > depth; exit 7".to_string()]);
    let words: Vec<&str> = words.iter().map(String::as_str).collect();
    let (status, result) = fixture.run(&words);
    assert_eq!(fixture.wait_for("depth"), "3");
    assert_eq!(status.code(), Some(7));
    assert_eq!(result["returncode"], 7);
    let two: Value = serde_json::from_slice(&fs::read(fixture.path("two.json")).unwrap()).unwrap();
    assert_eq!(two["returncode"], 7);
    assert!(two["child_cpu_s"].is_f64());
    assert_clean(&two);

    let mut too_deep = inner("one.json");
    too_deep.extend(inner("two.json"));
    too_deep.extend(inner("three.json"));
    too_deep.push("/usr/bin/true".to_string());
    let too_deep: Vec<&str> = too_deep.iter().map(String::as_str).collect();
    fixture.run(&too_deep);
    let three: Value = serde_json::from_slice(&fs::read(fixture.path("three.json")).unwrap()).unwrap();
    assert!(three["error"]["message"].as_str().unwrap().contains("command/depth"), "{three}");
}

#[test]
fn a_stopped_controller_cannot_hide_its_stage_from_root_cancel() {
    let fixture = Fixture::new("stopped");
    // $$ survives the exec, so `controller` is the PID of the nested client.
    let script = format!("echo $$ > controller; exec {BIN} owned run --result {} -- /bin/sh -c 'echo $$ > leader; exec sleep 30'", fixture.text("inner.json"));
    let mut root = fixture.command(&["/bin/sh", "-c", &script]).spawn().unwrap();
    let leader: i32 = fixture.wait_for("leader").parse().unwrap();
    let controller: i32 = fixture.wait_for("controller").parse().unwrap();
    assert_eq!(unsafe { libc::kill(controller, libc::SIGSTOP) }, 0);
    stop(&root, libc::SIGTERM);
    root.wait().unwrap();
    assert!(!alive(leader), "the nested stage is registered at the root, so a stopped controller cannot keep it");
    assert_clean(&fixture.result());
}

/// `levels` owned stages down to a helper that ignores TERM, cancelled at the root.
fn cancels_a_nested_helper(levels: usize, captured: bool, paused: bool) {
    let fixture = Fixture::new(&format!("cancel-{levels}-{captured}-{paused}"));
    let owned = |file: &str| vec![BIN.to_string(), "owned".into(), "run".into(), "--result".into(), fixture.text(file), "--".into()];
    let mut words = if levels == 3 { owned("middle.json") } else { Vec::new() };
    words.extend(["/bin/sh", "-c", "echo $$ > controller; exec \"$@\"", "controller"].map(str::to_string));
    words.extend(owned("inner.json"));
    words.extend(["/bin/sh", "-c", "trap '' TERM; echo $$ > helper; exec sleep 30"].map(str::to_string));
    let words: Vec<&str> = words.iter().map(String::as_str).collect();
    let mut command = fixture.command(&words);
    if captured {
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
    } else {
        let log = fs::File::create(fixture.path("output.log")).unwrap();
        command.stdout(log.try_clone().unwrap()).stderr(log);
    }
    let mut root = command.spawn().unwrap();
    let helper: i32 = fixture.wait_for("helper").parse().unwrap();
    let controller: i32 = fixture.wait_for("controller").parse().unwrap();
    if paused {
        assert_eq!(unsafe { libc::kill(controller, libc::SIGSTOP) }, 0);
    }
    stop(&root, libc::SIGTERM);
    let status = root.wait().unwrap();
    let result = fixture.result();
    assert!(!status.success(), "{result}");
    assert_clean(&result);
    assert_eq!(result["cleanup"]["child_reaped"], true, "{result}");
    assert!(!alive(helper), "the helper must go with the root cancel");
    if paused {
        assert!(!alive(controller), "a stopped controller must go too");
    }
    if captured {
        assert!(closed(root.stdout.take().unwrap()) && closed(root.stderr.take().unwrap()), "no process may keep the captured pipes");
    }
}

/// True at end of file: no writer is left. Nonblocking, so a pipe still open fails the test instead of hanging it.
fn closed(mut pipe: impl Read + AsRawFd) -> bool {
    proto::native::set_nonblocking(pipe.as_raw_fd()).unwrap();
    let mut buffer = [0; 4096];
    loop {
        match pipe.read(&mut buffer) {
            Ok(0) => return true,
            Ok(_) => {}
            Err(_) => return false,
        }
    }
}

#[test]
fn two_levels_to_a_file_clean_an_ignoring_helper() {
    cancels_a_nested_helper(2, false, false);
}

#[test]
fn three_levels_to_a_file_clean_an_ignoring_helper() {
    cancels_a_nested_helper(3, false, false);
}

#[test]
fn two_levels_of_captured_pipes_close_after_cancel() {
    cancels_a_nested_helper(2, true, false);
}

#[test]
fn three_levels_of_captured_pipes_close_after_cancel() {
    cancels_a_nested_helper(3, true, false);
}

#[test]
fn a_paused_controller_to_a_file_cleans_its_helper() {
    cancels_a_nested_helper(2, false, true);
}

#[test]
fn a_paused_controller_with_captured_pipes_cleans_its_helper() {
    cancels_a_nested_helper(2, true, true);
}

#[test]
fn a_nested_stage_runs_in_the_directory_of_its_controller() {
    let fixture = Fixture::new("cwd");
    fs::create_dir(fixture.path("subdir")).unwrap();
    let script = format!("cd subdir && exec {BIN} owned run --result {} -- /bin/sh -c 'pwd -P > {}'", fixture.text("inner.json"), fixture.text("seen"));
    let (status, result) = fixture.run(&["/bin/sh", "-c", &script]);
    assert!(status.success(), "{result}");
    assert_eq!(fixture.wait_for("seen"), fixture.text("subdir"));
}

#[test]
fn a_signal_while_the_stage_starts_never_releases_work() {
    let fixture = Fixture::new("startsignal");
    let marker = fixture.text("work");
    let mut command = fixture.command(&["/usr/bin/touch", &marker]);
    // A pending TERM survives exec: the broker's watcher finds it while the stage is being started.
    unsafe {
        command.pre_exec(|| {
            let mut set: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut set);
            libc::sigaddset(&mut set, libc::SIGTERM);
            libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
            libc::kill(libc::getpid(), libc::SIGTERM);
            Ok(())
        });
    }
    let status = command.stdout(Stdio::null()).stderr(Stdio::null()).status().unwrap();
    let result = fixture.result();
    assert!(!status.success(), "{result}");
    assert!(!Path::new(&marker).exists());
    assert_clean(&result);
    assert_eq!(result["cleanup"]["child_reaped"], true, "{result}");
}

/// The helper stage of `mode` with the address space of the root broker capped `headroom` bytes above its use, so that its next
/// thread really fails to start. The stage waits for the cap, tries, and the cap goes before the broker settles.
#[cfg(target_os = "linux")]
fn capped_broker(fixture: &Fixture, mode: &str, headroom: u64) -> (ExitStatus, Value) {
    let exe = std::env::current_exe().unwrap();
    let mut root = fixture.command(&[exe.to_str().unwrap(), "--ignored", "--exact", "stage_helper", "--nocapture"])
        .env("OWNED_HELPER_MODE", mode).env("OWNED_HELPER_FOLDER", &fixture.folder)
        .stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    fixture.wait_for("ready");
    let pid = root.id() as i32;
    let statm = fs::read_to_string(format!("/proc/{pid}/statm")).unwrap();
    let pages: u64 = statm.split_whitespace().next().unwrap().parse().unwrap();
    let used = pages * unsafe { libc::sysconf(libc::_SC_PAGESIZE) } as u64;
    let mut original = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    let capped = libc::rlimit { rlim_cur: used + headroom, rlim_max: libc::RLIM_INFINITY };
    assert_eq!(unsafe { libc::prlimit(pid, libc::RLIMIT_AS, &capped, &mut original) }, 0, "{}", std::io::Error::last_os_error());
    fs::write(fixture.path("capped"), "1").unwrap();
    fixture.wait_for("tried");
    assert_eq!(unsafe { libc::prlimit(pid, libc::RLIMIT_AS, &original, std::ptr::null_mut()) }, 0);
    fs::write(fixture.path("restored"), "1").unwrap();
    let status = root.wait().unwrap();
    (status, serde_json::from_slice(&fs::read(fixture.path("helper.json")).unwrap()).unwrap())
}

#[test]
#[cfg(target_os = "linux")]
fn a_request_thread_that_cannot_start_fails_closed() {
    let fixture = Fixture::new("requestthread");
    let (status, reply) = capped_broker(&fixture, "request-thread", 0);
    assert_eq!(reply["closed"], true, "the broker must close the connection it cannot serve: {reply}");
    let result = fixture.result();
    assert_eq!(status.code(), Some(70), "{result}");
    assert_eq!(result["cleanup"]["complete"], false, "{result}");
    assert!(result["cleanup"]["errors"].to_string().contains("broker-close"), "{result}");
    let socket = reply["socket"].as_str().unwrap();
    fs::remove_dir_all(Path::new(socket).parent().unwrap()).unwrap();   // kept as evidence by an unconfirmed broker
}

#[test]
#[cfg(target_os = "linux")]
fn a_spawn_thread_that_cannot_start_closes_the_stage() {
    const ONE_THREAD_STACK_NOT_TWO: u64 = 3 * 1024 * 1024;
    let fixture = Fixture::new("spawnthread");
    let (status, reply) = capped_broker(&fixture, "spawn-thread", ONE_THREAD_STACK_NOT_TWO);
    assert!(reply["error"]["message"].is_string() && reply["handle"].is_null(), "{reply}");
    let result = fixture.result();
    assert!(status.success(), "{result}");
    assert_clean(&result);
    assert!(!fixture.path("work").exists());
}

#[test]
fn a_foreign_process_cannot_use_a_real_capability() {
    let fixture = Fixture::new("foreign");
    let mut root = fixture.command(&["/bin/sh", "-c", "echo \"$IOT_LEAN_BROKER_SOCKET $IOT_LEAN_STAGE_HANDLE\" > lineage; sleep 30"]).spawn().unwrap();
    let lineage = fixture.wait_for("lineage");
    let (socket, cap) = lineage.split_once(' ').unwrap();
    let connection = UnixStream::connect(socket).unwrap();
    wire::send(&connection, &json!({"op": "spawn", "cap": cap, "command": ["false"], "options": {}}), &[]).unwrap();
    let (reply, _) = wire::receive(&connection).unwrap();
    assert!(reply["error"]["message"].as_str().unwrap().contains("lineage"), "{reply}");
    stop(&root, libc::SIGTERM);
    root.wait().unwrap();
}

#[test]
fn bad_requests_exit_two_and_run_nothing() {
    let fixture = Fixture::new("usage");
    let run = |args: &[&str]| Command::new(BIN).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().unwrap().code();
    assert_eq!(run(&["owned"]), Some(2));
    assert_eq!(run(&["owned", "run", "--", "true"]), Some(2));
    assert_eq!(run(&["owned", "run", "--result", &fixture.text("r"), "--"]), Some(2));
    assert_eq!(run(&["owned", "exec", "x"]), Some(2));
}

#[test]
fn half_a_lineage_is_refused() {
    let fixture = Fixture::new("halflineage");
    let marker = fixture.text("work");
    let status = fixture.command(&["/usr/bin/touch", &marker]).env("IOT_LEAN_STAGE_HANDLE", "x").status().unwrap();
    assert_eq!(status.code(), Some(1));
    assert!(fixture.result()["error"]["message"].as_str().unwrap().contains("broker metadata"));
    assert!(!Path::new(&marker).exists());
    let status = fixture.command(&["/usr/bin/touch", &marker]).env("IOT_LEAN_STAGE_DEPTH", "1").status().unwrap();
    assert_eq!(status.code(), Some(1));
    assert!(fixture.result()["error"]["message"].as_str().unwrap().contains("authenticated"));
    assert!(!Path::new(&marker).exists());
}

#[test]
fn bootstrap_handles_cyclic_mappings_and_an_error_target_collision() {
    for collision in [false, true] {
        let fixture = Fixture::new(if collision { "collide" } else { "cycle" });
        fs::write(fixture.path("a"), "one").unwrap();
        fs::write(fixture.path("b"), "two").unwrap();
        let high = |name: &str| {
            let file = fs::File::open(fixture.path(name)).unwrap();
            let fd = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 64) };
            unsafe { OwnedFd::from_raw_fd(fd) }
        };
        let (first, second) = (high("a"), high("b"));
        let (a, b) = (first.as_raw_fd(), second.as_raw_fd());
        let (release_read, release_write) = proto::native::pipe().unwrap();
        let (error_read, error_write) = proto::native::pipe().unwrap();
        let (release, errors) = (release_read.as_raw_fd(), error_write.as_raw_fd());
        let mut mappings = vec![[a, b], [b, a]];
        if collision {
            mappings.push([errors, a]);
        }
        let script = format!("read x <&{a}; read y <&{b}; printf %s \"$x$y\"");
        // bash: dash, the /bin/sh of Debian, takes only single-digit descriptors in a redirection.
        let program = if collision { "/nonexistent/owned-collision" } else { "/bin/bash" };
        let mut command = Command::new(BIN);
        command.args(["owned", "exec", &release.to_string(), &errors.to_string(), &json!(mappings).to_string(), program]);
        if !collision {
            command.args(["-c", &script]);
        }
        unsafe {
            command.pre_exec(move || {
                for fd in [a, b, release, errors] {
                    libc::fcntl(fd, libc::F_SETFD, 0);
                }
                Ok(())
            });
        }
        let child = command.stdout(Stdio::piped()).spawn().unwrap();
        fs::File::from(release_write).write_all(b"G").unwrap();
        drop(error_write);
        let output = child.wait_with_output().unwrap();
        let detail = read_all(error_read);
        if collision {
            assert_eq!(output.status.code(), Some(127));
            assert_eq!(serde_json::from_slice::<Value>(&detail).unwrap()["type"], "FileNotFoundError");
        } else {
            assert_eq!(output.status.code(), Some(0));
            assert_eq!(output.stdout, b"twoone", "the two sources swap numbers");
            assert!(detail.is_empty());
        }
    }
}

fn read_all(fd: OwnedFd) -> Vec<u8> {
    let mut bytes = Vec::new();
    fs::File::from(fd).read_to_end(&mut bytes).unwrap();
    bytes
}

#[test]
fn a_closed_gate_never_runs_the_command() {
    let fixture = Fixture::new("gate");
    let (release_read, release_write) = proto::native::pipe().unwrap();
    let (_error_read, error_write) = proto::native::pipe().unwrap();
    let (release, errors) = (release_read.as_raw_fd(), error_write.as_raw_fd());
    let marker = fixture.text("work");
    let mut command = Command::new(BIN);
    command.args(["owned", "exec", &release.to_string(), &errors.to_string(), "[]", "/usr/bin/touch", &marker]);
    unsafe {
        command.pre_exec(move || {
            libc::fcntl(release, libc::F_SETFD, 0);
            libc::fcntl(errors, libc::F_SETFD, 0);
            Ok(())
        });
    }
    let mut child = command.spawn().unwrap();
    drop(release_write);
    assert_eq!(child.wait().unwrap().code(), Some(125));
    assert!(!Path::new(&marker).exists());
}

#[test]
fn pipes_are_captured_and_returned_as_base64() {
    let fixture = Fixture::new("capture");
    let reply = helper_stage(&fixture, "capture");
    assert_eq!(reply["separate"]["result"]["stdout"], "b3V0Cg==");
    assert_eq!(reply["separate"]["result"]["stderr"], "ZXJyCg==");
    assert_eq!(reply["merged"]["result"]["stdout"], "b3V0CmVycgo=");
    assert_eq!(reply["merged"]["result"]["stderr"], Value::Null);
    assert_eq!(reply["closed_stdin"]["result"]["returncode"], 0);
}

#[test]
fn passed_descriptors_keep_their_caller_numbers() {
    let fixture = Fixture::new("passed");
    let reply = helper_stage(&fixture, "passed");
    assert_eq!(reply["result"]["stdout"], "dHdvb25l", "{reply}");
}

#[test]
fn wait_can_time_out_and_interrupt_is_one_term() {
    let fixture = Fixture::new("interrupt");
    let reply = helper_stage(&fixture, "interrupt");
    assert_eq!(reply["pending"]["pending"], true);
    assert_eq!(reply["interrupted"]["interrupted"], true);
    assert_eq!(reply["settled"]["result"]["returncode"], -libc::SIGTERM);
}

#[test]
fn a_never_activated_stage_is_cancelled_without_running() {
    let fixture = Fixture::new("pending");
    let reply = helper_stage(&fixture, "pending");
    assert_eq!(reply["cancel"]["cleanup"]["complete"], true, "{reply}");
    // The gate closes as the TERM goes out: the bootstrap ends on whichever it meets first.
    let code = reply["settled"]["result"]["returncode"].as_i64();
    assert!(code == Some(125) || code == Some(-i64::from(libc::SIGTERM)), "{reply}");
    assert!(!fixture.path("work").exists());
}

#[test]
fn expired_nested_activation_keeps_the_timeout_type() {
    let fixture = Fixture::new("nesteddeadline");
    let reply = helper_stage(&fixture, "expired");
    assert_eq!(reply["activate"]["error"]["type"], "TimeoutExpired", "{reply}");
    assert!(!fixture.path("work").exists());
}

#[test]
fn an_admission_delay_cannot_extend_the_deadline() {
    let fixture = Fixture::new("admissiondelay");
    let reply = helper_stage(&fixture, "delayed");
    assert_eq!(reply["activate"]["error"]["type"], "TimeoutExpired", "{reply}");
    assert_eq!(reply["cancel"]["cleanup"]["complete"], true, "{reply}");
    assert!(!fixture.path("work").exists());
}

#[test]
fn a_cancelled_admission_closes_the_descriptors_and_runs_nothing() {
    let fixture = Fixture::new("descriptors");
    let reply = helper_stage(&fixture, "descriptors");
    assert_eq!(reply["cancel"]["cleanup"]["complete"], true, "{reply}");
    assert_eq!(reply["closed"], true, "no copy of a prepared descriptor may stay open: {reply}");
    assert!(!fixture.path("work").exists());
}

#[test]
fn foreign_handles_and_bad_requests_are_refused() {
    let fixture = Fixture::new("refused");
    let reply = helper_stage(&fixture, "refused");
    assert!(reply["foreign"]["error"]["message"].as_str().unwrap().contains("foreign"), "{reply}");
    assert!(reply["unknown"]["error"]["message"].as_str().unwrap().contains("unknown"), "{reply}");
    assert!(reply["roles"]["error"]["message"].as_str().unwrap().contains("role mismatch"), "{reply}");
    assert!(reply["wait"]["error"]["message"].as_str().unwrap().contains("invalid owned-stage wait"), "{reply}");
}

#[test]
fn a_collector_failure_kills_the_stage_and_keeps_the_cause() {
    let fixture = Fixture::new("bound");
    let reply = helper_stage(&fixture, "bound");
    assert!(reply["error"]["message"].as_str().unwrap().contains("output bound"), "{reply}");
    assert_eq!(reply["result"], Value::Null);
}

#[test]
fn a_collector_failure_cleans_a_registered_descendant() {
    let fixture = Fixture::new("descendant");
    let reply = helper_stage(&fixture, "descendant");
    assert!(reply["error"]["message"].as_str().unwrap().contains("output bound"), "{reply}");
    assert!(!alive(fixture.wait_for("helper").parse().unwrap()), "the failed stage's registered subtree must go with it");
}

// ---------- the client that runs inside a stage ----------

struct Client {
    socket: String,
    cap: String,
    folder: PathBuf,
}

impl Client {
    fn from_env() -> Client {
        Client { socket: std::env::var("IOT_LEAN_BROKER_SOCKET").unwrap(), cap: std::env::var("IOT_LEAN_STAGE_HANDLE").unwrap(),
                 folder: std::env::var("OWNED_HELPER_FOLDER").unwrap().into() }
    }

    fn rpc_fds(&self, mut request: Value, fds: &[i32]) -> Value {
        request["cap"] = json!(self.cap);
        let connection = UnixStream::connect(&self.socket).unwrap();
        connection.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
        wire::send(&connection, &request, fds).unwrap();
        wire::receive(&connection).unwrap().0
    }

    fn rpc(&self, request: Value) -> Value {
        self.rpc_fds(request, &[])
    }

    fn options(&self, extra: Value) -> Value {
        let mut options = json!({"cwd": self.folder.to_str().unwrap(), "env": {"PATH": "/bin:/usr/bin"}, "passed": [],
                                 "stdin": -3, "stdout": -3, "stderr": -3});
        for (key, value) in extra.as_object().unwrap() {
            options[key] = value.clone();
        }
        options
    }

    fn spawn(&self, script: &str, extra: Value) -> String {
        let reply = self.rpc(json!({"op": "spawn", "command": ["/bin/sh", "-c", script], "options": self.options(extra)}));
        reply["handle"].as_str().unwrap_or_else(|| panic!("{reply}")).to_string()
    }

    fn op(&self, op: &str, handle: &str) -> Value {
        self.rpc(json!({"op": op, "handle": handle}))
    }

    fn run(&self, script: &str, extra: Value) -> Value {
        let handle = self.spawn(script, extra);
        self.op("activate", &handle);
        self.rpc(json!({"op": "wait", "handle": handle, "timeout": 15}))
    }

    fn wait_for(&self, name: &str) {
        let until = Instant::now() + Duration::from_secs(10);
        while !self.folder.join(name).exists() {
            assert!(Instant::now() < until, "{name} never appeared");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// The handshake of `capped_broker`: `attempt` runs while the broker is capped.
    fn while_capped(&self, attempt: impl FnOnce() -> Value) -> Value {
        fs::write(self.folder.join("ready"), "1").unwrap();
        self.wait_for("capped");
        let reply = attempt();
        fs::write(self.folder.join("tried"), "1").unwrap();
        self.wait_for("restored");
        reply
    }
}

fn capture_mode(client: &Client) -> Value {
    let script = "echo out; echo err >&2";
    json!({"separate": client.run(script, json!({"stdout": -1, "stderr": -1})),
           "merged": client.run(script, json!({"stdout": -1, "stderr": -2})),
           "closed_stdin": client.run("cat", json!({"stdin": -1, "stdout": -1}))})
}

fn passed_mode(client: &Client) -> Value {
    let open = |name: &str, content: &str| {
        let path = client.folder.join(name);
        fs::write(&path, content).unwrap();
        let file = fs::File::open(path).unwrap();
        unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 64) }
    };
    let (a, b) = (open("a", "one\n"), open("b", "two\n"));
    let script = format!("read x <&{a}; read y <&{b}; printf %s \"$x$y\"");
    let options = client.options(json!({"stdout": -1, "passed": [[a, 1], [b, 0]]}));
    let reply = client.rpc_fds(json!({"op": "spawn", "command": ["/bin/bash", "-c", script], "options": options}), &[a, b]);
    let handle = reply["handle"].as_str().unwrap_or_else(|| panic!("{reply}")).to_string();
    client.op("activate", &handle);
    client.rpc(json!({"op": "wait", "handle": handle, "timeout": 15}))
}

fn interrupt_mode(client: &Client) -> Value {
    let handle = client.spawn("exec sleep 30", json!({}));
    client.op("activate", &handle);
    let pending = client.rpc(json!({"op": "wait", "handle": handle, "timeout": 0.05}));
    let interrupted = client.op("interrupt", &handle);
    let settled = client.rpc(json!({"op": "wait", "handle": handle, "timeout": 15}));
    json!({"pending": pending, "interrupted": interrupted, "settled": settled})
}

fn pending_mode(client: &Client) -> Value {
    let handle = client.spawn("touch work", json!({}));
    let cancel = client.op("cancel", &handle);
    let settled = client.rpc(json!({"op": "wait", "handle": handle, "timeout": 15}));
    json!({"cancel": cancel, "settled": settled})
}

fn expired_mode(client: &Client) -> Value {
    let env = json!({"PATH": "/bin:/usr/bin", "IOT_LEAN_DEADLINE": "clock-monotonic-v1:1.0"});
    let handle = client.spawn("touch work", json!({"env": env}));
    let activate = client.op("activate", &handle);
    client.op("cancel", &handle);
    json!({"activate": activate})
}

/// The deadline is good at spawn and gone at activation.
fn delayed_mode(client: &Client) -> Value {
    let deadline = proto::native::monotonic_s() + 0.05;
    let env = json!({"PATH": "/bin:/usr/bin", "IOT_LEAN_DEADLINE": format!("clock-monotonic-v1:{deadline:?}")});
    let handle = client.spawn("touch work", json!({"env": env}));
    std::thread::sleep(Duration::from_millis(100));
    let activate = client.op("activate", &handle);
    let cancel = client.op("cancel", &handle);
    json!({"activate": activate, "cancel": cancel})
}

/// The stage's stdout is the only other copy of this pipe, so end of file proves that broker and bootstrap closed theirs.
fn descriptors_mode(client: &Client) -> Value {
    let (read, write) = proto::native::pipe().unwrap();
    let options = client.options(json!({"stdout": {"fd": 0}}));
    let request = json!({"op": "spawn", "command": ["/bin/sh", "-c", "touch work"], "options": options});
    let reply = client.rpc_fds(request, &[write.as_raw_fd()]);
    let handle = reply["handle"].as_str().unwrap_or_else(|| panic!("{reply}")).to_string();
    drop(write);
    let cancel = client.op("cancel", &handle);
    json!({"cancel": cancel, "closed": closed(fs::File::from(read))})
}

/// A controller stage with a registered helper that ignores TERM, then more output than the collector takes.
fn descendant_mode(client: &Client) -> Value {
    let helper = "trap '' TERM; echo $$ > helper; exec sleep 30";
    let script = format!("{BIN} owned run --result nested.json -- /bin/sh -c \"{}\" </dev/null >/dev/null 2>&1 &
                          until [ -s helper ]; do sleep 0.01; done; head -c 70000000 /dev/zero; sleep 30", helper.replace('$', "\\$"));
    client.run(&script, json!({"stdout": -1}))
}

fn request_thread_mode(client: &Client) -> Value {
    client.while_capped(|| {
        let mut connection = UnixStream::connect(&client.socket).unwrap();
        connection.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let _ = wire::send(&connection, &json!({"op": "spawn", "cap": client.cap, "command": ["true"], "options": client.options(json!({}))}), &[]);
        let answer = connection.read(&mut [0; 1]);
        let closed = match answer {
            Ok(bytes) => bytes == 0,
            Err(error) => error.kind() == std::io::ErrorKind::ConnectionReset,
        };
        json!({"closed": closed, "socket": client.socket})
    })
}

fn spawn_thread_mode(client: &Client) -> Value {
    client.while_capped(|| client.rpc(json!({"op": "spawn", "command": ["/bin/sh", "-c", "touch work"], "options": client.options(json!({}))})))
}

fn refused_mode(client: &Client) -> Value {
    let handle = client.spawn("exit 0", json!({}));
    let mut roles = client.options(json!({}));
    roles["stdout"] = json!({"fd": 0});
    let reply = json!({
        "foreign": client.op("wait", &"0".repeat(64)),
        "unknown": client.op("explode", &handle),
        "roles": client.rpc(json!({"op": "spawn", "command": ["true"], "options": roles})),
        "wait": client.rpc(json!({"op": "wait", "handle": handle, "timeout": -1})),
    });
    client.op("cancel", &handle);
    reply
}

fn bound_mode(client: &Client) -> Value {
    client.run("head -c 70000000 /dev/zero; sleep 30", json!({"stdout": -1}))
}

/// Not a test of its own: the body of the helper stages above, started by `helper_stage`.
#[test]
#[ignore]
fn stage_helper() {
    let mode = std::env::var("OWNED_HELPER_MODE").unwrap();
    let client = Client::from_env();
    let reply = match mode.as_str() {
        "capture" => capture_mode(&client),
        "passed" => passed_mode(&client),
        "interrupt" => interrupt_mode(&client),
        "pending" => pending_mode(&client),
        "expired" => expired_mode(&client),
        "delayed" => delayed_mode(&client),
        "descriptors" => descriptors_mode(&client),
        "descendant" => descendant_mode(&client),
        "request-thread" => request_thread_mode(&client),
        "spawn-thread" => spawn_thread_mode(&client),
        "refused" => refused_mode(&client),
        "bound" => bound_mode(&client),
        other => panic!("unknown mode {other}"),
    };
    fs::write(client.folder.join("helper.json"), reply.to_string()).unwrap();
}
