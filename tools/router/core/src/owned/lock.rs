//! flock files shared with the Python tools (lean_workflow.job_slot, lean_resources guard and tickets).
//!
//! flock belongs to an open file description, so a caller without flock keeps this process alive as its holder.
//!
//!   iotroute lock hold PATH [--wait-s N]   exit 0 after release, 75 when busy, 1 when given up, 2 on error
//!   iotroute lock held PATH                exit 0 when held, 1 when free or missing, 2 on error
//!   iotroute lock append PATH              append one input line while the caller keeps stdin open

use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

const EXIT_GAVE_UP: i32 = 1;
const EXIT_ERROR: i32 = 2;
/// EX_TEMPFAIL, the code lean_workflow exits with when the job slot is busy.
const EXIT_BUSY: i32 = 75;
/// The retry period of lean_resources.guard.
const RETRY: Duration = Duration::from_millis(10);

pub fn main(args: &[OsString]) -> i32 {
    let Some(request) = parse(args) else {
        eprintln!("usage: iotroute lock hold PATH [--wait-s N] | iotroute lock held PATH | iotroute lock append PATH");
        return EXIT_ERROR;
    };
    let outcome = match request {
        Request::Hold { path, wait } => hold(path, wait),
        Request::Held { path } => report_held(path),
        Request::Append { path } => append_locked(path),
        Request::Supervise { path, result, finalizer, command } => supervise(path, result, finalizer, command),
        Request::VerifyFd { path, fd } => verify_worker_fd(path, fd).map(|_| 0),
    };
    outcome.unwrap_or_else(|error| {
        eprintln!("lock: {error}");
        EXIT_ERROR
    })
}

enum Request<'a> {
    Hold { path: &'a Path, wait: Duration },
    Held { path: &'a Path },
    Append { path: &'a Path },
    Supervise { path: &'a Path, result: &'a Path, finalizer: &'a OsString, command: &'a [OsString] },
    VerifyFd { path: &'a Path, fd: i32 },
}

fn parse(args: &[OsString]) -> Option<Request<'_>> {
    let (verb, rest) = args.split_first()?;
    match (verb.to_str()?, rest) {
        ("held", [path]) => Some(Request::Held { path: Path::new(path) }),
        ("append", [path]) => Some(Request::Append { path: Path::new(path) }),
        ("supervise", [path, flag, result, finalize_flag, finalizer, separator, command @ ..]) if flag == "--result" && finalize_flag == "--finalizer" && separator == "--" && !command.is_empty() =>
            Some(Request::Supervise { path: Path::new(path), result: Path::new(result), finalizer, command }),
        ("verify-fd", [path, fd]) => Some(Request::VerifyFd { path: Path::new(path), fd: fd.to_str()?.parse().ok()? }),
        ("hold", [path]) => Some(Request::Hold { path: Path::new(path), wait: Duration::ZERO }),
        ("hold", [path, flag, seconds]) if flag == "--wait-s" => {
            let wait = Duration::try_from_secs_f64(seconds.to_str()?.parse().ok()?).ok()?;
            Some(Request::Hold { path: Path::new(path), wait })
        }
        _ => None,
    }
}

/// Admit once and transfer the flock to an owned-stage broker. Its bootstrap
/// closes undeclared FDs in the worker and its children; the broker retains
/// the flock until it has settled the entire registered process family.
fn supervise(path: &Path, result: &Path, finalizer: &OsString, command: &[OsString]) -> io::Result<i32> {
    let file = OpenOptions::new().write(true).create_new(true).open(path)?;
    let fd = file.as_raw_fd();
    if fd < 3 { return Err(io::Error::new(io::ErrorKind::InvalidInput, "worker lock fd must be at least 3")); }
    loop {
        if unsafe { libc::flock(fd, libc::LOCK_EX) } == 0 { break; }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted { return Err(error); }
    }
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    let error = Command::new(std::env::current_exe()?).args(["owned", "run-finalized", "--result"])
        .arg(result).arg("--finalizer").arg(finalizer).arg("--").args(command)
        .env("IOT_PCB_WORKER_LOCK", path).env("IOT_PCB_WORKER_FD", fd.to_string()).exec();
    Err(error)
}

/// A forged unlocked descriptor is acceptable only if it points to the right
/// inode and we can take the exclusive flock on its shared open description.
pub(super) fn verify_worker_fd(path: &Path, fd: i32) -> io::Result<()> {
    if fd < 3 { return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid worker lock descriptor")); }
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } != 0 { return Err(io::Error::last_os_error()); }
    let stat = unsafe { stat.assume_init() };
    let path_meta = fs::symlink_metadata(path)?;
    if !path_meta.is_file() || path_meta.file_type().is_symlink() || path_meta.nlink() != 1
        || path_meta.dev() != stat.st_dev as u64 || path_meta.ino() != stat.st_ino as u64 || stat.st_nlink != 1 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "worker lock inode changed"));
    }
    if unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) } != 0 { return Err(io::Error::last_os_error()); }
    Ok(())
}

/// Open once, wait on the same inode, and give up if the caller's pipe closes.
fn append_locked(path: &Path) -> io::Result<i32> {
    let mut data = Vec::new();
    BufReader::new(io::stdin()).read_until(b'\n', &mut data)?;
    if data.last() != Some(&b'\n') { return Err(io::Error::new(io::ErrorKind::InvalidInput, "append needs one complete line")); }
    let file = OpenOptions::new().append(true).create(true).open(path)?;
    append_with_liveness(file, &data, stdin_closed)
}

/// Check the caller both while waiting and immediately after acquiring the lock.
fn append_with_liveness(mut file: File, data: &[u8], mut caller_closed: impl FnMut(Duration) -> io::Result<bool>) -> io::Result<i32> {
    while try_lock(&file)? == Attempt::Busy {
        if caller_closed(RETRY)? { return Ok(EXIT_GAVE_UP); }
    }
    if caller_closed(Duration::ZERO)? { return Ok(EXIT_GAVE_UP); }
    file.write_all(data)?;
    Ok(0)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_checks_caller_after_lock_before_write() {
        let path = std::env::temp_dir().join(format!("owned-lock-boundary-{}", std::process::id()));
        let file = OpenOptions::new().write(true).create_new(true).open(&path).unwrap();
        let mut checks = Vec::new();
        let outcome = append_with_liveness(file, b"must not appear\n", |wait| {
            checks.push(wait);
            Ok(true) // Caller disconnected at the post-acquire boundary.
        }).unwrap();
        assert_eq!(outcome, EXIT_GAVE_UP);
        assert_eq!(checks, [Duration::ZERO]);
        assert_eq!(fs::read(&path).unwrap(), b"");
        fs::remove_file(path).unwrap();
    }
}
