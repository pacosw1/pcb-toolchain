//! One registered stage and the shapes of its result, field for field those of lean_owned.py.

use super::failure::Failure;
use super::native::locked;
use super::options::SpawnOptions;
use serde::Serialize;
use std::fs::File;
use std::io::Read;
use std::os::fd::OwnedFd;
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub const CPU_SCOPE: &str = "owned leader wait4; includes children it reaped; nested intervals non-additive";
pub const FAMILY_CLEANUP: &str = "registered owned-stage groups";
const HANDLE_BYTES: usize = 32;

#[derive(Clone, Debug, Serialize)]
pub struct CleanupError {
    pub operation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<i32>,
    pub error: String,
}

impl CleanupError {
    pub fn new(operation: &str, error: impl ToString) -> CleanupError {
        CleanupError { operation: operation.to_string(), signal: None, error: error.to_string() }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Cleanup {
    pub complete: bool,
    pub errors: Vec<CleanupError>,
    pub child_reaped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family_cleanup: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owned_group_gone: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leader_spawned: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
pub struct StageResult {
    pub returncode: i32,
    pub stdout: Option<String>,
    pub stderr: Option<String>,
    pub child_cpu_s: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adopted_child_cpu_s: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adopted_children: Option<u32>,
    pub cpu_scope: String,
    pub cleanup: Cleanup,
}

impl StageResult {
    /// A stage cancelled before its leader existed.
    pub fn never_spawned() -> StageResult {
        StageResult {
            returncode: 125, stdout: None, stderr: None, child_cpu_s: None, adopted_child_cpu_s: None, adopted_children: None,
            cpu_scope: "unavailable; cancelled before leader spawn".to_string(),
            cleanup: Cleanup { complete: true, errors: Vec::new(), child_reaped: true, family_cleanup: None,
                               owned_group_gone: None, leader_spawned: Some(false) },
        }
    }
}

/// The mutable part of a stage. Held only briefly; slow work happens outside.
#[derive(Default)]
pub struct Data {
    pub fds: Vec<Option<OwnedFd>>,
    pub pid: Option<i32>,
    pub closing: bool,
    pub cancelled: bool,
    pub started: bool,
    pub admitted: bool,
    pub reaped: bool,
    pub done: bool,
    pub signals_sent: Vec<i32>,
    pub result: Option<StageResult>,
    pub error: Option<Failure>,
    pub child_cpu_s: Option<f64>,
    pub cleanup_errors: Vec<CleanupError>,
    pub cleanup_until: Option<Instant>,
    pub term_until: Option<Instant>,
    pub adopted_child_cpu_s: f64,
    pub adopted_children: u32,
}

pub struct Stage {
    pub handle: String,
    pub command: Vec<String>,
    pub options: SpawnOptions,
    pub parent: Option<String>,
    pub depth: u8,
    data: Mutex<Data>,
    changed: Condvar,
    /// Held across every signal and the reap: the leader's PID is proof of ownership only until it is reaped.
    pub identity: Mutex<()>,
}

/// An unguessable capability, 64 hex characters as the Python clients require.
fn new_handle() -> Result<String, Failure> {
    let mut bytes = [0u8; HANDLE_BYTES];
    File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

impl Stage {
    pub fn new(command: Vec<String>, options: SpawnOptions, fds: Vec<OwnedFd>, parent: Option<String>, depth: u8) -> Result<Stage, Failure> {
        let data = Data { fds: fds.into_iter().map(Some).collect(), ..Data::default() };
        Ok(Stage { handle: new_handle()?, command, options, parent, depth, data: Mutex::new(data), changed: Condvar::new(), identity: Mutex::new(()) })
    }

    pub fn data(&self) -> MutexGuard<'_, Data> {
        locked(&self.data)
    }

    pub fn is_done(&self) -> bool {
        self.data().done
    }

    pub fn pid(&self) -> Option<i32> {
        self.data().pid
    }

    /// Wakes the spawn thread and every waiter after a change of admission or settlement.
    pub fn notify(&self) {
        self.changed.notify_all();
    }

    pub fn settle(&self, apply: impl FnOnce(&mut Data)) {
        let mut data = self.data();
        apply(&mut data);
        data.done = true;
        drop(data);
        self.notify();
    }

    /// True once settled; False when `timeout` passed first. None waits without limit.
    pub fn wait_done(&self, timeout: Option<Duration>) -> bool {
        let until = timeout.map(|timeout| Instant::now() + timeout);
        let mut data = self.data();
        while !data.done {
            let left = until.map_or(Duration::from_secs(3600), |until| until.saturating_duration_since(Instant::now()));
            if left.is_zero() {
                return false;
            }
            data = self.changed.wait_timeout(data, left).unwrap_or_else(|poison| poison.into_inner()).0;
        }
        true
    }

    /// True once admitted, False once closing. The broker's release byte depends on this.
    pub fn wait_admission(&self) -> bool {
        let mut data = self.data();
        while !data.admitted && !data.closing {
            data = self.changed.wait_timeout(data, Duration::from_millis(100)).unwrap_or_else(|poison| poison.into_inner()).0;
        }
        !data.closing
    }
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let word = u32::from(chunk[0]) << 16 | u32::from(*chunk.get(1).unwrap_or(&0)) << 8 | u32::from(*chunk.get(2).unwrap_or(&0));
        for position in 0..4 {
            if position <= chunk.len() {
                text.push(BASE64[(word >> (18 - 6 * position) & 63) as usize] as char);
            } else {
                text.push('=');
            }
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_rfc_vectors() {
        for (plain, coded) in [("", ""), ("f", "Zg=="), ("fo", "Zm8="), ("foo", "Zm9v"), ("foob", "Zm9vYg=="), ("fooba", "Zm9vYmE="), ("foobar", "Zm9vYmFy")] {
            assert_eq!(base64(plain.as_bytes()), coded);
        }
    }

    #[test]
    fn a_handle_is_64_hex_characters() {
        let handle = new_handle().unwrap();
        assert_eq!(handle.len(), 64);
        assert!(handle.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn a_never_spawned_result_keeps_the_python_fields() {
        let value = serde_json::to_value(StageResult::never_spawned()).unwrap();
        assert_eq!(value["returncode"], 125);
        assert_eq!(value["cleanup"]["leader_spawned"], false);
        assert!(value.get("adopted_child_cpu_s").is_none());
    }
}
