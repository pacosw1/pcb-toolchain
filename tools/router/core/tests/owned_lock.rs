//! Black-box checks of `iotroute lock` and `iotroute clock` on the built binary.

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Output, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_iotroute");
const HELD: i32 = 0;
const FREE: i32 = 1;
const BUSY: i32 = 75;

fn scratch(name: &str) -> PathBuf {
    let folder = std::env::temp_dir().join(format!("owned-lock-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&folder);
    fs::create_dir_all(&folder).unwrap();
    folder
}

fn run(args: &[&str]) -> Output {
    Command::new(BIN).args(args).stdin(Stdio::null()).output().unwrap()
}

fn probe(path: &Path) -> i32 {
    run(&["lock", "held", path.to_str().unwrap()]).status.code().unwrap()
}

/// A holder after its `held` line; dropping the stdin returned with it asks for release.
fn hold(path: &Path) -> (Child, ChildStdin) {
    let mut child = Command::new(BIN).args(["lock", "hold", path.to_str().unwrap()])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
    assert_eq!(line, "held\n");
    let stdin = child.stdin.take().unwrap();
    (child, stdin)
}

#[test]
fn closing_stdin_releases_the_lock() {
    let path = scratch("release").join("deep/er/slot");
    assert_eq!(probe(&path), FREE);
    assert!(!path.exists(), "the probe must not create the file");
    let (mut child, stdin) = hold(&path);
    assert_eq!(probe(&path), HELD);
    drop(stdin);
    assert_eq!(child.wait().unwrap().code(), Some(0));
    assert_eq!(probe(&path), FREE);
}

#[test]
fn append_waits_for_the_existing_lock_and_writes_a_complete_record() {
    let path = scratch("append").join("journal");
    let (mut holder, holder_stdin) = hold(&path);
    let mut writer = Command::new(BIN).args(["lock", "append", path.to_str().unwrap()])
        .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().unwrap();
    writer.stdin.take().unwrap().write_all(b"record\n").unwrap();
    std::thread::sleep(Duration::from_millis(100));
    assert!(writer.try_wait().unwrap().is_none(), "append must wait for the holder");
    assert_eq!(fs::read(&path).unwrap(), b"");
    drop(holder_stdin);
    assert!(holder.wait().unwrap().success());
    assert!(writer.wait().unwrap().success());
    assert_eq!(fs::read(&path).unwrap(), b"record\n");
}

#[test]
fn a_taken_lock_is_busy_and_a_wait_is_bounded() {
    let path = scratch("busy").join("slot");
    let (mut child, stdin) = hold(&path);
    let path_text = path.to_str().unwrap();
    let keep_open = |extra: &[&str]| {
        let mut second = Command::new(BIN).args(["lock", "hold", path_text]).args(extra)
            .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let _open = second.stdin.take(); // Child::wait would close it, which asks the helper to give up
        second.wait().unwrap().code()
    };
    assert_eq!(keep_open(&[]), Some(BUSY));
    let started = Instant::now();
    assert_eq!(keep_open(&["--wait-s", "0.2"]), Some(BUSY));
    assert!(started.elapsed() >= Duration::from_millis(200));
    drop(stdin);
    child.wait().unwrap();
}

#[test]
fn term_keeps_the_lock_and_kill_frees_it() {
    let path = scratch("signals").join("slot");
    let (mut child, _stdin) = hold(&path);
    unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(probe(&path), HELD);
    child.kill().unwrap();
    child.wait().unwrap();
    assert_eq!(probe(&path), FREE);
}

#[test]
fn a_waiter_gives_up_when_its_owner_goes_away() {
    let path = scratch("giveup").join("slot");
    let (mut first, stdin) = hold(&path);
    let mut waiter = Command::new(BIN).args(["lock", "hold", path.to_str().unwrap(), "--wait-s", "30"])
        .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    std::thread::sleep(Duration::from_millis(50));
    drop(waiter.stdin.take());
    assert_eq!(waiter.wait().unwrap().code(), Some(1));
    drop(stdin);
    first.wait().unwrap();
}

#[test]
fn bad_requests_exit_two() {
    for args in [vec!["lock"], vec!["lock", "hold"], vec!["lock", "hold", "x", "--wait-s", "-1"],
                 vec!["lock", "hold", "x", "--wait-s", "nan"], vec!["lock", "nope", "x"]] {
        assert_eq!(run(&args).status.code(), Some(2), "{args:?}");
    }
    let folder = scratch("folder");
    assert_eq!(run(&["lock", "hold", folder.to_str().unwrap()]).status.code(), Some(2));
}

#[test]
fn clock_prints_one_rising_decimal_line() {
    let read = || {
        let output = run(&["clock"]);
        assert_eq!(output.status.code(), Some(0));
        let text = String::from_utf8(output.stdout).unwrap();
        assert!(text.ends_with('\n') && text.lines().count() == 1, "{text:?}");
        let (seconds, fraction) = text.trim().split_once('.').unwrap();
        assert!(seconds.bytes().all(|b| b.is_ascii_digit()) && fraction.len() == 9, "{text:?}");
        text.trim().parse::<f64>().unwrap()
    };
    let first = read();
    let second = read();
    assert!(second > first && second - first < 5.0, "{first} {second}");
}
