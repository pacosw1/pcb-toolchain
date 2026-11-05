//! Thin wrappers of the system calls the broker needs and Node and std do not expose.

use super::failure::Failure;
use std::ffi::CString;
use std::io;
use std::mem::{size_of, zeroed};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

// si_code of a terminal child state. Darwin reports CLD_STOPPED even with only WEXITED requested, and a stop
// notification must never authorize a blocking reap.
const CLD_EXITED: i32 = 1;
const CLD_KILLED: i32 = 2;
const CLD_DUMPED: i32 = 3;

/// A poisoned lock only means a stage thread panicked; its failure path still has to run.
pub fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// The clock of the IOT_LEAN_DEADLINE protocol.
pub fn monotonic_s() -> f64 {
    let mut now = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut now) };
    now.tv_sec as f64 + now.tv_nsec as f64 / 1e9
}

/// True when our direct child has a terminal state. WNOWAIT keeps its PID reserved until the final reap.
pub fn peek_exit(pid: i32) -> Result<bool, Failure> {
    let mut info: libc::siginfo_t = unsafe { zeroed() };
    let flags = libc::WEXITED | libc::WNOHANG | libc::WNOWAIT;
    if unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, flags) } != 0 {
        return Err(io::Error::last_os_error().into());
    }
    Ok(matches!(info.si_code, CLD_EXITED | CLD_KILLED | CLD_DUMPED))
}

#[derive(Clone, Copy)]
pub struct Reaped {
    /// The exit code, or minus the signal number.
    pub code: i32,
    pub cpu_s: f64,
}

fn seconds(time: libc::timeval) -> f64 {
    time.tv_sec as f64 + time.tv_usec as f64 / 1e6
}

fn exit_code(status: i32) -> i32 {
    if libc::WIFSIGNALED(status) { -libc::WTERMSIG(status) } else { libc::WEXITSTATUS(status) }
}

/// wait4 of one exact PID; None when WNOHANG found nothing to reap.
pub fn wait4(pid: i32, options: i32) -> Result<Option<Reaped>, Failure> {
    let mut status = 0;
    let mut usage: libc::rusage = unsafe { zeroed() };
    loop {
        match unsafe { libc::wait4(pid, &mut status, options, &mut usage) } {
            0 => return Ok(None),
            -1 if io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) => continue,
            -1 => return Err(io::Error::last_os_error().into()),
            _ => return Ok(Some(Reaped { code: exit_code(status), cpu_s: seconds(usage.ru_utime) + seconds(usage.ru_stime) })),
        }
    }
}

fn checked(result: i32) -> io::Result<()> {
    if result == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

pub fn killpg(group: i32, signal: i32) -> io::Result<()> {
    checked(unsafe { libc::killpg(group, signal) })
}

pub fn kill(pid: i32, signal: i32) -> io::Result<()> {
    checked(unsafe { libc::kill(pid, signal) })
}

pub fn getpgid(pid: i32) -> io::Result<i32> {
    match unsafe { libc::getpgid(pid) } {
        -1 => Err(io::Error::last_os_error()),
        group => Ok(group),
    }
}

/// The kernel's view of the other end of a local socket: (pid, uid).
#[cfg(target_os = "linux")]
pub fn peer(socket: &UnixStream) -> io::Result<(i32, u32)> {
    let mut credentials: libc::ucred = unsafe { zeroed() };
    let mut size = size_of::<libc::ucred>() as libc::socklen_t;
    let pointer = (&raw mut credentials).cast();
    checked(unsafe { libc::getsockopt(socket.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED, pointer, &mut size) })?;
    Ok((credentials.pid, credentials.uid))
}

#[cfg(target_os = "macos")]
pub fn peer(socket: &UnixStream) -> io::Result<(i32, u32)> {
    let mut pid: libc::pid_t = 0;
    let mut size = size_of::<libc::pid_t>() as libc::socklen_t;
    let pointer = (&raw mut pid).cast();
    checked(unsafe { libc::getsockopt(socket.as_raw_fd(), libc::SOL_LOCAL, libc::LOCAL_PEERPID, pointer, &mut size) })?;
    let (mut uid, mut gid) = (0, 0);
    checked(unsafe { libc::getpeereid(socket.as_raw_fd(), &mut uid, &mut gid) })?;
    Ok((pid, uid))
}

/// Linux child adoption: orphans of an owned group come to this process, so it can reap them in containers with
/// no init. Restored after settled ownership. Other systems have no such setting.
pub struct Subreaper {
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    prior: i32,
}

impl Subreaper {
    #[cfg(target_os = "linux")]
    pub fn acquire() -> io::Result<Subreaper> {
        let mut prior: libc::c_int = 0;
        checked(unsafe { libc::prctl(libc::PR_GET_CHILD_SUBREAPER, &raw mut prior, 0, 0, 0) })?;
        checked(unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) })?;
        Ok(Subreaper { prior })
    }

    #[cfg(not(target_os = "linux"))]
    pub fn acquire() -> io::Result<Subreaper> {
        Ok(Subreaper { prior: 0 })
    }

    #[cfg(target_os = "linux")]
    pub fn restore(self) -> io::Result<()> {
        checked(unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, self.prior, 0, 0, 0) })
    }

    #[cfg(not(target_os = "linux"))]
    pub fn restore(self) -> io::Result<()> {
        Ok(())
    }
}

/// A new private folder under /tmp: socket paths have a short length limit, so never under TMPDIR.
pub fn private_folder() -> io::Result<PathBuf> {
    let template = CString::new("/tmp/los-XXXXXXXX").expect("no NUL in a literal");
    let raw = template.into_raw();
    let made = unsafe { libc::mkdtemp(raw) };
    let path = unsafe { CString::from_raw(raw) };
    if made.is_null() {
        return Err(io::Error::last_os_error());
    }
    Ok(PathBuf::from(path.into_string().expect("the template is ASCII")))
}

pub fn set_cloexec(fd: RawFd, on: bool) -> io::Result<()> {
    checked(unsafe { libc::fcntl(fd, libc::F_SETFD, if on { libc::FD_CLOEXEC } else { 0 }) })
}

pub fn set_nonblocking(fd: RawFd) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    checked(unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) })
}

/// Waits for input on the given descriptors; a signal counts as nothing ready.
pub fn poll_input(fds: &mut [libc::pollfd], timeout: Duration) -> io::Result<()> {
    let millis = timeout.as_millis().min(i32::MAX as u128) as i32;
    if unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, millis) } < 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EINTR) {
            return Err(error);
        }
    }
    Ok(())
}

pub fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut ends = [0; 2];
    checked(unsafe { libc::pipe(ends.as_mut_ptr()) })?;
    let pair = unsafe { (OwnedFd::from_raw_fd(ends[0]), OwnedFd::from_raw_fd(ends[1])) };
    set_cloexec(pair.0.as_raw_fd(), true)?;
    set_cloexec(pair.1.as_raw_fd(), true)?;
    Ok(pair)
}

/// The three signals that cancel a stage, as a set for sigprocmask and sigwait.
fn stop_signals() -> libc::sigset_t {
    signal_set(&[libc::SIGHUP, libc::SIGINT, libc::SIGTERM])
}

fn signal_set(signals: &[i32]) -> libc::sigset_t {
    let mut set: libc::sigset_t = unsafe { zeroed() };
    unsafe {
        libc::sigemptyset(&mut set);
        for signal in signals {
            libc::sigaddset(&mut set, *signal);
        }
    }
    set
}

/// The stop signals and the graceful stop of `owned run`.
fn handled_signals() -> libc::sigset_t {
    signal_set(&[libc::SIGHUP, libc::SIGINT, libc::SIGTERM, libc::SIGUSR1])
}

/// Must run before any thread starts, so that only wait_stop_signal and wait_interrupt_signal see them.
pub fn block_stop_signals() {
    let set = handled_signals();
    unsafe { libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut()) };
}

/// For a child between fork and exec, so async-signal-safe. std's Command inherits the signal mask, and a stage
/// that kept these blocked could not be cancelled by TERM: it would only ever die on the KILL phase.
pub fn unblock_stop_signals() -> io::Result<()> {
    let set = handled_signals();
    match unsafe { libc::pthread_sigmask(libc::SIG_UNBLOCK, &set, std::ptr::null_mut()) } {
        0 => Ok(()),
        code => Err(io::Error::from_raw_os_error(code)),
    }
}

pub fn wait_stop_signal() {
    let set = stop_signals();
    let mut signal = 0;
    while unsafe { libc::sigwait(&set, &mut signal) } != 0 {}
}

/// SIGUSR1: `owned run` asks its stage to stop by itself.
pub fn wait_interrupt_signal() {
    let set = signal_set(&[libc::SIGUSR1]);
    let mut signal = 0;
    while unsafe { libc::sigwait(&set, &mut signal) } != 0 {}
}

/// Refuses to start on a system where peer identity would not work: the same probe as lean_owned._runtime.
pub fn probe_runtime() -> Result<(), Failure> {
    let (left, _right) = UnixStream::pair()?;
    let (pid, uid) = peer(&left)?;
    if pid != std::process::id() as i32 || uid != unsafe { libc::getuid() } {
        return Err(Failure::value("local peer identity probe failed"));
    }
    Ok(())
}
