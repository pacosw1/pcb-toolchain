//! Host-side process services of the toolchain, in the shipped binary so route images need no other runtime.
//!
//! `iotroute lock ...` holds and probes flock files shared with the Python tools.
//! `iotroute clock` prints the clock of the IOT_LEAN_DEADLINE protocol.

use std::ffi::OsString;

mod lock;

/// Runs a service subcommand and returns its exit code; None leaves the arguments to the router CLI.
pub fn dispatch() -> Option<i32> {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    match args.first()?.to_str()? {
        "clock" if args.len() == 1 => Some(clock()),
        "lock" => Some(lock::main(&args[1..])),
        _ => None,
    }
}

/// CLOCK_MONOTONIC in seconds. Python's time.clock_gettime reads the same clock; Node's hrtime does not on Darwin.
fn clock() -> i32 {
    let mut now = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut now) } != 0 {
        eprintln!("clock: {}", std::io::Error::last_os_error());
        return 1;
    }
    println!("{}.{:09}", now.tv_sec, now.tv_nsec);
    0
}
