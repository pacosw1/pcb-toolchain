//! The broker's socket: nested controllers ask it for stages, one request per connection.
//!
//! Authority is the kernel's peer identity, the caller's registered group and an opaque capability.

use super::failure::Failure;
use super::native::{self, locked, poll_input};
use super::options::from_wire;
use super::scope::{MAX_CONNECTIONS, Scope};
use super::stage::{CleanupError, Stage};
use super::wire;
use serde_json::{Value, json};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;

const ACCEPT_POLL: Duration = Duration::from_millis(200);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
const REPLY_TIMEOUT: Duration = Duration::from_millis(500);
const MAX_WAIT_S: f64 = 86400.0;

fn wait_timeout(request: &Value) -> Result<Option<Duration>, Failure> {
    let invalid = || Failure::value("invalid owned-stage wait");
    match request.get("timeout") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let seconds = value.as_f64().filter(|seconds| (0.0..=MAX_WAIT_S).contains(seconds)).ok_or_else(invalid)?;
            Ok(Some(Duration::from_secs_f64(seconds)))
        }
    }
}

impl Scope {
    pub fn accept_loop(self: Arc<Self>, listener: UnixListener) {
        if listener.set_nonblocking(true).is_err() {
            locked(&self.failures).push(CleanupError::new("listener", "cannot poll the broker socket"));
            return;
        }
        while !self.stopped.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((connection, _)) => self.admit(connection),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    let mut waiting = [libc::pollfd { fd: listener.as_raw_fd(), events: libc::POLLIN, revents: 0 }];
                    let _ = poll_input(&mut waiting, ACCEPT_POLL);
                }
                Err(_) => break,
            }
        }
    }

    /// Over the bound a connection is closed unanswered, as in lean_owned.
    fn admit(self: &Arc<Self>, connection: UnixStream) {
        if self.connections.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            self.connections.fetch_sub(1, Ordering::SeqCst);
            return;
        }
        let scope = Arc::clone(self);
        let handler = move || {
            if let Err(failure) = scope.serve(&connection) {
                let _ = wire::send(&connection, &json!({"error": failure}), &[]);
            }
            scope.connections.fetch_sub(1, Ordering::SeqCst);
        };
        let mut registry = self.registry();
        registry.threads.retain(|thread| !thread.is_finished());
        match thread::Builder::new().name("owned-stage-request".to_string()).spawn(handler) {
            Ok(thread) => registry.threads.push(thread),
            Err(error) => {
                self.connections.fetch_sub(1, Ordering::SeqCst);
                locked(&self.failures).push(CleanupError::new("request-thread", error));
            }
        }
    }

    fn authorize(&self, request: &Value, peer_pid: i32, peer_uid: u32) -> Result<Arc<Stage>, Failure> {
        let stale = || Failure::value("invalid/stale owned-stage lineage");
        let cap = request.get("cap").and_then(Value::as_str).ok_or_else(stale)?;
        let registry = self.registry();
        let parent = registry.stages.iter().find(|stage| stage.handle == cap).ok_or_else(stale)?;
        let (pid, reaped) = {
            let data = parent.data();
            (data.pid, data.reaped)
        };
        let leader = pid.filter(|_| !reaped).ok_or_else(stale)?;
        if peer_uid != unsafe { libc::getuid() } || native::getpgid(peer_pid)? != leader {
            return Err(stale());
        }
        Ok(Arc::clone(parent))
    }

    fn spawn_child(self: &Arc<Self>, request: &Value, fds: Vec<OwnedFd>, parent: &Arc<Stage>) -> Result<Value, Failure> {
        let options = from_wire(request.get("options").unwrap_or(&Value::Null), fds.len())?;
        let command: Option<Vec<String>> = request.get("command").and_then(Value::as_array)
            .and_then(|items| items.iter().map(|item| item.as_str().map(str::to_string)).collect());
        let command = command.ok_or_else(|| Failure::value("invalid owned-stage command/depth"))?;
        let child = self.prepare(command, options, fds, Some(parent), parent.depth + 1)?;
        self.start(&child)?;
        Ok(json!({"handle": child.handle}))
    }

    fn own_child(&self, request: &Value, fds: &[OwnedFd], parent: &Stage) -> Result<Arc<Stage>, Failure> {
        let foreign = || Failure::value("foreign owned-stage handle");
        let handle = request.get("handle").and_then(Value::as_str).ok_or_else(foreign)?;
        let registry = self.registry();
        let target = registry.stages.iter().find(|stage| stage.handle == handle).ok_or_else(foreign)?;
        if !fds.is_empty() || target.parent.as_deref() != Some(parent.handle.as_str()) {
            return Err(foreign());
        }
        Ok(Arc::clone(target))
    }

    fn wait_reply(&self, target: &Stage, request: &Value, connection: &UnixStream) -> Result<Value, Failure> {
        let settled = target.wait_done(wait_timeout(request)?);
        connection.set_write_timeout(Some(REPLY_TIMEOUT))?;
        let data = target.data();
        Ok(json!({"result": data.result, "error": data.error, "pending": !settled, "child_cpu_s": data.child_cpu_s}))
    }

    fn serve(self: &Arc<Self>, connection: &UnixStream) -> Result<(), Failure> {
        connection.set_nonblocking(false)?;
        connection.set_read_timeout(Some(REQUEST_TIMEOUT))?;
        connection.set_write_timeout(Some(REQUEST_TIMEOUT))?;
        let (pid, uid) = native::peer(connection)?;
        let (request, fds) = wire::receive(connection)?;
        let parent = self.authorize(&request, pid, uid)?;
        let op = request.get("op").and_then(Value::as_str).unwrap_or("");
        let reply = if op == "spawn" {
            self.spawn_child(&request, fds, &parent)?
        } else {
            let target = self.own_child(&request, &fds, &parent)?;
            match op {
                "wait" => self.wait_reply(&target, &request, connection)?,
                "cancel" => {
                    connection.set_write_timeout(Some(REPLY_TIMEOUT))?;
                    json!({"cleanup": self.cancel(&target.handle, true, false, None)})
                }
                "activate" => {
                    self.activate(&target)?;
                    json!({"activated": true})
                }
                "interrupt" => {
                    connection.set_write_timeout(Some(REPLY_TIMEOUT))?;
                    self.interrupt(&target)?;
                    json!({"interrupted": true})
                }
                _ => return Err(Failure::value("unknown owned-stage request")),
            }
        };
        wire::send(connection, &reply, &[])
    }
}
