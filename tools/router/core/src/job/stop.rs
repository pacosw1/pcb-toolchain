//! How a job ends early, and the stop signals it reacts to.
use serde_json::Value;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI32, Ordering};

/// Why the job did not reach its normal end.
#[derive(Debug)]
pub enum Stop {
    /// Exit with this code; a message goes to stderr first.
    Exit { code: i32, message: Option<String> },
    /// The deadline hit an owned stage.
    Timeout { cause: String, cleanup: Value },
    /// No slot in the resource queue, or a deadline before it.
    AdmissionTimeout(String),
    Cancelled { signal: Option<i32>, cleanup: Value },
}

impl Stop {
    /// `sys.exit("message")`.
    pub fn failed(message: impl Into<String>) -> Stop {
        Stop::Exit { code: 1, message: Some(message.into()) }
    }

    pub fn code(code: i32) -> Stop {
        Stop::Exit { code, message: None }
    }

    pub fn admission_timeout(message: &str) -> Stop {
        Stop::AdmissionTimeout(message.to_string())
    }

    pub fn reason(&self) -> String {
        match self {
            Stop::Exit { message, code } => message.clone().unwrap_or_else(|| format!("exit {code}")),
            Stop::Timeout { cause, .. } => cause.clone(),
            Stop::AdmissionTimeout(message) => message.clone(),
            Stop::Cancelled { .. } => "StageCancelled".to_string(),
        }
    }
}

impl From<String> for Stop {
    fn from(message: String) -> Stop {
        Stop::failed(message)
    }
}

static SIGNAL: AtomicI32 = AtomicI32::new(0);
/// The broker of the stage now running: the first stop signal goes to it.
static CURRENT_BROKER: Mutex<Option<i32>> = Mutex::new(None);

pub fn set_current_broker(pid: Option<i32>) {
    *CURRENT_BROKER.lock().unwrap_or_else(|poison| poison.into_inner()) = pid;
}

/// Blocks the stop signals in every thread to come and turns them into a flag and a TERM to the running stage's broker. Call it
/// before any thread starts.
pub fn catch_stop_signals() {
    let mut set: libc::sigset_t = unsafe { std::mem::zeroed() };
    unsafe {
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGTERM);
        libc::sigaddset(&mut set, libc::SIGINT);
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
    }
    std::thread::spawn(move || {
        loop {
            let mut signal = 0;
            if unsafe { libc::sigwait(&set, &mut signal) } != 0 {
                continue;
            }
            SIGNAL.store(signal, Ordering::SeqCst);
            if let Some(pid) = *CURRENT_BROKER.lock().unwrap_or_else(|poison| poison.into_inner()) {
                unsafe { libc::kill(pid, libc::SIGTERM) };
            }
        }
    });
}

pub fn stop_signal() -> Option<i32> {
    match SIGNAL.load(Ordering::SeqCst) {
        0 => None,
        signal => Some(signal),
    }
}

pub fn check_cancelled() -> Result<(), Stop> {
    match stop_signal() {
        Some(signal) => Err(Stop::Cancelled { signal: Some(signal), cleanup: Value::Null }),
        None => Ok(()),
    }
}
