//! flock files shared with the Python tools (lean_workflow.job_slot, lean_resources guard and tickets).
//!
//! flock belongs to an open file description, so a caller without flock keeps this process alive as its holder.
//!
//!   iotroute lock hold PATH [--wait-s N]   exit 0 after release, 75 when busy, 1 when given up, 2 on error
//!   iotroute lock held PATH                exit 0 when held, 1 when free or missing, 2 on error

use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::fd::AsRawFd;
use std::path::Path;
use std::time::{Duration, Instant};

const EXIT_GAVE_UP: i32 = 1;
const EXIT_ERROR: i32 = 2;
/// EX_TEMPFAIL, the code lean_workflow exits with when the job slot is busy.
const EXIT_BUSY: i32 = 75;
/// The retry period of lean_resources.guard.
const RETRY: Duration = Duration::from_millis(10);

pub fn main(args: &[OsString]) -> i32 {
    let Some(request) = parse(args) else {
        eprintln!("usage: iotroute lock hold PATH [--wait-s N] | iotroute lock held PATH");
        return EXIT_ERROR;
    };
    let outcome = match request {
        Request::Hold { path, wait } => hold(path, wait),
        Request::Held { path } => report_held(path),
    };
    outcome.unwrap_or_else(|error| {
        eprintln!("lock: {error}");
        EXIT_ERROR
    })
}

enum Request<'a> {
    Hold { path: &'a Path, wait: Duration },
    Held { path: &'a Path },
}

fn parse(args: &[OsString]) -> Option<Request<'_>> {
    let (verb, rest) = args.split_first()?;
    match (verb.to_str()?, rest) {
        ("held", [path]) => Some(Request::Held { path: Path::new(path) }),
        ("hold", [path]) => Some(Request::Hold { path: Path::new(path), wait: Duration::ZERO }),
        ("hold", [path, flag, seconds]) if flag == "--wait-s" => {
            let wait = Duration::try_from_secs_f64(seconds.to_str()?.parse().ok()?).ok()?;
            Some(Request::Hold { path: Path::new(path), wait })
        }
        _ => None,
    }
}

/// The result of one flock attempt that did not fail.
#[derive(PartialEq)]
enum Attempt {
    Locked,
    Busy,
}

fn try_lock(file: &File) -> io::Result<Attempt> {
    loop {
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(Attempt::Locked);
        }
        let error = io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::EWOULDBLOCK) => return Ok(Attempt::Busy),
            Some(libc::EINTR) => continue,
            _ => return Err(error),
        }
    }
}

/// True once the caller closed stdin, the release request; waits at most `timeout` for it.
fn stdin_closed(timeout: Duration) -> io::Result<bool> {
    let mut stdin = libc::pollfd { fd: libc::STDIN_FILENO, events: libc::POLLIN, revents: 0 };
    let millis = timeout.as_millis().min(i32::MAX as u128) as i32;
    match unsafe { libc::poll(&mut stdin, 1, millis) } {
        0 => Ok(false),
        ready if ready > 0 => {
            let mut discard = [0u8; 256];
            let count = unsafe { libc::read(libc::STDIN_FILENO, discard.as_mut_ptr().cast(), discard.len()) };
            Ok(count <= 0)
        }
        _ => {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EINTR) { Ok(false) } else { Err(error) }
        }
    }
}

/// A TERM sent to the owner's whole group must not free the lock while the owner still cleans up: the lock ends
/// with stdin, which also closes when the owner dies, or with KILL.
fn ignore_stop_signals() {
    for signal in [libc::SIGHUP, libc::SIGINT, libc::SIGTERM] {
        unsafe { libc::signal(signal, libc::SIG_IGN) };
    }
}

fn hold(path: &Path, wait: Duration) -> io::Result<i32> {
    ignore_stop_signals();
    if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    let file = OpenOptions::new().read(true).append(true).create(true).open(path)?;
    let deadline = Instant::now() + wait;
    while try_lock(&file)? == Attempt::Busy {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            eprintln!("lock: busy: {}", path.display());
            return Ok(EXIT_BUSY);
        }
        if stdin_closed(left.min(RETRY))? {
            return Ok(EXIT_GAVE_UP);
        }
    }
    let mut stdout = io::stdout();
    writeln!(stdout, "held")?;
    stdout.flush()?;
    while !stdin_closed(Duration::from_secs(3600))? {}
    Ok(0)
}

/// The same test as lean_resources.live_claims: LOCK_EX, so a holder of either lock kind counts.
/// Like that test it holds the lock for an instant, so a concurrent non-blocking taker can see it busy.
fn report_held(path: &Path) -> io::Result<i32> {
    let held = match File::open(path) {
        Ok(file) => try_lock(&file)? == Attempt::Busy,
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => return Err(error),
    };
    println!("{}", if held { "held" } else { "free" });
    Ok(if held { 0 } else { 1 })
}
