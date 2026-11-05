//! The client side of the broker protocol, for a caller already inside an owned stage. It works with either broker.

use super::failure::Failure;
use super::wire;
use serde_json::Value;
use std::fs;
use std::os::fd::RawFd;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

const PRIVATE_MODE: u32 = 0o700;
const MODE_BITS: u32 = 0o7777;

/// The endpoint must be our own socket in our own private folder, as lean_owned._rpc checks.
fn check_endpoint(path: &Path) -> Result<(), Failure> {
    let invalid = || Failure::value("invalid private broker endpoint");
    let folder = fs::symlink_metadata(path.parent().ok_or_else(invalid)?)?;
    let endpoint = fs::symlink_metadata(path)?;
    let uid = unsafe { libc::getuid() };
    let private = folder.is_dir() && folder.uid() == uid && folder.permissions().mode() & MODE_BITS == PRIVATE_MODE;
    if !private || !endpoint.file_type().is_socket() || endpoint.uid() != uid {
        return Err(invalid());
    }
    Ok(())
}

/// One request on its own connection. `timeout` None waits without limit; a wait reply carries its own error field.
pub fn rpc(path: &Path, request: &Value, fds: &[RawFd], timeout: Option<Duration>) -> Result<Value, Failure> {
    check_endpoint(path)?;
    let connection = UnixStream::connect(path)?;
    connection.set_read_timeout(timeout)?;
    connection.set_write_timeout(timeout)?;
    wire::send(&connection, request, fds)?;
    let (response, received) = wire::receive(&connection)?;
    if !received.is_empty() {
        return Err(Failure::value("unexpected broker response descriptors"));
    }
    let is_wait = request.get("op").and_then(Value::as_str) == Some("wait");
    match response.get("error").filter(|error| !error.is_null() && !is_wait) {
        Some(error) => {
            let failure: Failure = serde_json::from_value(error.clone())?;
            let message = format!("owned-stage broker rejected request: {}", failure.message);
            Err(Failure::new(&failure.kind, message))
        }
        None => Ok(response),
    }
}
