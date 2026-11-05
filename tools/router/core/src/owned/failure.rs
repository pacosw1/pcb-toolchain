//! The one error of the broker. `kind` is the name clients match on the wire.

use serde::{Deserialize, Serialize};
use std::io;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Failure {
    #[serde(rename = "type")]
    pub kind: String,
    pub message: String,
}

impl Failure {
    pub fn new(kind: &str, message: impl Into<String>) -> Failure {
        Failure { kind: kind.to_string(), message: message.into() }
    }

    pub fn value(message: impl Into<String>) -> Failure {
        Failure::new("ValueError", message)
    }

    pub fn runtime(message: impl Into<String>) -> Failure {
        Failure::new("RuntimeError", message)
    }

    pub fn timeout(message: impl Into<String>) -> Failure {
        Failure::new("TimeoutError", message)
    }

    pub fn is_gone(&self) -> bool {
        self.kind == "ProcessLookupError"
    }
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}

impl From<io::Error> for Failure {
    fn from(error: io::Error) -> Failure {
        let kind = match error.raw_os_error() {
            Some(libc::ENOENT) => "FileNotFoundError",
            Some(libc::ESRCH) => "ProcessLookupError",
            Some(libc::EPERM) | Some(libc::EACCES) => "PermissionError",
            Some(libc::ECHILD) => "ChildProcessError",
            Some(libc::EAGAIN) | Some(libc::ETIMEDOUT) => "TimeoutError",
            _ => "OSError",
        };
        Failure::new(kind, error.to_string())
    }
}

impl From<serde_json::Error> for Failure {
    fn from(error: serde_json::Error) -> Failure {
        Failure::value(error.to_string())
    }
}
