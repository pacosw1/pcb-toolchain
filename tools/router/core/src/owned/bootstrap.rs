//! The private first program of a stage: no work runs before the broker's release byte.
//!
//!   iotroute owned exec RELEASE_FD ERROR_FD MAPPINGS_JSON COMMAND...
//!
//! This is a fresh single-threaded process, so it can do what a fork in the threaded broker could not: close every
//! descriptor that leaked between pipe() and FD_CLOEXEC on Darwin, or arrived from another stage's window.

use super::failure::Failure;
use super::native::set_cloexec;
use serde_json::json;
use std::collections::BTreeSet;
use std::ffi::OsString;
use std::io;
use std::os::unix::process::CommandExt;
use std::process::Command;

const NOT_APPROVED: i32 = 125;
const EXEC_FAILED: i32 = 127;
const USAGE: i32 = 2;
/// Copies start above this.
const LOW_DESCRIPTORS: i32 = 63;
const RELEASE_BYTE: u8 = b'G';
const MAX_REPORT: usize = 4096;

#[cfg(target_os = "linux")]
const OPEN_DESCRIPTORS: &str = "/proc/self/fd";
#[cfg(not(target_os = "linux"))]
const OPEN_DESCRIPTORS: &str = "/dev/fd";

struct Request<'a> {
    release: i32,
    errors: i32,
    mappings: Vec<[i32; 2]>,
    command: &'a [OsString],
}

fn parse(args: &[OsString]) -> Option<Request<'_>> {
    let [release, errors, mappings, command @ ..] = args else { return None };
    if command.is_empty() {
        return None;
    }
    Some(Request {
        release: release.to_str()?.parse().ok()?,
        errors: errors.to_str()?.parse().ok()?,
        mappings: serde_json::from_str(mappings.to_str()?).ok()?,
        command,
    })
}

fn close_all_but(keep: &BTreeSet<i32>) -> io::Result<()> {
    // Listed first: the listing's own descriptor is in the list, and is gone by the time it is closed.
    let open: Vec<i32> = std::fs::read_dir(OPEN_DESCRIPTORS)?.filter_map(|entry| entry.ok()?.file_name().to_str()?.parse().ok()).collect();
    for fd in open.into_iter().filter(|fd| *fd > 2 && !keep.contains(fd)) {
        unsafe { libc::close(fd) };
    }
    Ok(())
}

fn duplicate_above(fd: i32, lower: i32) -> io::Result<i32> {
    match unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, lower) } {
        -1 => Err(io::Error::last_os_error()),
        copy => Ok(copy),
    }
}

fn released(fd: i32) -> bool {
    let mut byte = 0u8;
    let count = unsafe { libc::read(fd, (&raw mut byte).cast(), 1) };
    unsafe { libc::close(fd) };
    count == 1 && byte == RELEASE_BYTE
}

/// Moves the error pipe above every number in play, so that no mapping target can overwrite it.
fn protect_errors(request: &Request) -> io::Result<i32> {
    let highest = request.mappings.iter().flatten().copied().chain([LOW_DESCRIPTORS, request.release, request.errors]).max();
    let protected = duplicate_above(request.errors, highest.unwrap_or(LOW_DESCRIPTORS) + 1)?;
    unsafe { libc::close(request.errors) };
    Ok(protected)
}

/// SCM_RIGHTS changes descriptor numbers. Restores the caller's numbers without overwriting another source in a cycle.
fn apply_mappings(request: &Request, protected: i32) -> io::Result<()> {
    let mut copies = Vec::new();
    for [target, source] in &request.mappings {
        copies.push((*target, duplicate_above(*source, protected + 1)?));
    }
    for (target, copy) in &copies {
        if unsafe { libc::dup2(*copy, *target) } < 0 {
            return Err(io::Error::last_os_error());
        }
        unsafe { libc::close(*copy) };
    }
    let targets: BTreeSet<i32> = copies.iter().map(|(target, _)| *target).collect();
    for [_, source] in request.mappings.iter().filter(|[_, source]| !targets.contains(source)) {
        unsafe { libc::close(*source) };
    }
    Ok(())
}

fn report(errors: i32, error: io::Error, program: &OsString) -> i32 {
    let failure = Failure::from(error);
    let detail = json!({"type": failure.kind, "message": format!("{}: {:?}", failure.message, program)}).to_string();
    let bytes = &detail.as_bytes()[..detail.len().min(MAX_REPORT)];
    unsafe { libc::write(errors, bytes.as_ptr().cast(), bytes.len()) };
    EXEC_FAILED
}

pub fn main(args: &[OsString]) -> i32 {
    let Some(request) = parse(args) else {
        eprintln!("usage: iotroute owned exec RELEASE_FD ERROR_FD MAPPINGS_JSON COMMAND...");
        return USAGE;
    };
    let program = &request.command[0];
    let keep: BTreeSet<i32> = request.mappings.iter().map(|[_, source]| *source).chain([request.release, request.errors]).collect();
    if let Err(error) = set_cloexec(request.errors, true).and_then(|_| close_all_but(&keep)) {
        return report(request.errors, error, program);
    }
    if !released(request.release) {
        return NOT_APPROVED;
    }
    let errors = match protect_errors(&request) {
        Ok(errors) => errors,
        Err(error) => return report(request.errors, error, program),
    };
    if let Err(error) = apply_mappings(&request, errors) {
        return report(errors, error, program);
    }
    let error = Command::new(program).args(&request.command[1..]).exec();
    report(errors, error, program)
}
