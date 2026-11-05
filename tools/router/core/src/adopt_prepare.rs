//! Private preparation primitive for a future adoption protocol.
//!
//! This module NEVER replaces, restores, or otherwise writes the target. A
//! prepared journal is not adoption authorization. Integration still needs
//! owned verification, alias coordination with older clients, xattr replay and file-flag policy,
//! durable commit/receipt recovery and tests at every crash boundary.
use crate::sha256::sha256;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, FileExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, TryLockError};

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

/// Caller supplies a pre-existing private directory owned by this process.
fn private_dir(path: &Path) -> io::Result<PathBuf> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_dir()
        || meta.file_type().is_symlink()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
    {
        return Err(invalid(
            "directory must be private, owned, and not a symlink",
        ));
    }
    fs::canonicalize(path)
}

fn open_regular(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.nlink() != 1 {
        return Err(invalid("target must be a regular, single-link file"));
    }
    Ok(file)
}

// Snapshot reads must not themselves change the source atime. A caller that
// cannot request O_NOATIME cannot safely prepare a Linux commit.
#[cfg(target_os = "linux")]
fn open_target(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NOATIME)
        .open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.nlink() != 1 {
        return Err(invalid("target must be a regular, single-link file"));
    }
    Ok(file)
}

#[cfg(not(target_os = "linux"))]
fn open_target(path: &Path) -> io::Result<File> {
    open_regular(path)
}

fn same_identity(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.nlink() == 1
        && b.nlink() == 1
        && a.mode() == b.mode()
        && a.uid() == b.uid()
        && a.gid() == b.gid()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}

#[cfg(target_os = "linux")]
unsafe fn list_xattrs(fd: libc::c_int, buffer: *mut libc::c_char, length: usize) -> libc::ssize_t {
    unsafe { libc::flistxattr(fd, buffer, length) }
}

#[cfg(target_os = "macos")]
unsafe fn list_xattrs(fd: libc::c_int, buffer: *mut libc::c_char, length: usize) -> libc::ssize_t {
    unsafe { libc::flistxattr(fd, buffer, length, 0) }
}

#[cfg(target_os = "linux")]
unsafe fn get_xattr(
    fd: libc::c_int,
    name: *const libc::c_char,
    buffer: *mut libc::c_void,
    length: usize,
) -> libc::ssize_t {
    unsafe { libc::fgetxattr(fd, name, buffer, length) }
}

#[cfg(target_os = "macos")]
unsafe fn get_xattr(
    fd: libc::c_int,
    name: *const libc::c_char,
    buffer: *mut libc::c_void,
    length: usize,
) -> libc::ssize_t {
    unsafe { libc::fgetxattr(fd, name, buffer, length, 0, 0) }
}

/// Capture all readable xattrs, including ACL xattrs on Linux. Unsupported,
/// unreadable, malformed or concurrently changing attributes fail closed.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn extended_attributes(file: &File) -> io::Result<BTreeMap<String, Vec<u8>>> {
    let fd = file.as_raw_fd();
    let size = unsafe { list_xattrs(fd, std::ptr::null_mut(), 0) };
    if size < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut names = vec![0u8; size as usize];
    if size > 0 {
        let count = unsafe { list_xattrs(fd, names.as_mut_ptr().cast(), names.len()) };
        if count < 0 {
            return Err(io::Error::last_os_error());
        }
        if count as usize != names.len() || names.last() != Some(&0) {
            return Err(invalid("extended attribute list changed"));
        }
    }
    let mut values = BTreeMap::new();
    for raw in names.split(|b| *b == 0).filter(|name| !name.is_empty()) {
        let name =
            std::str::from_utf8(raw).map_err(|_| invalid("unsupported extended attribute name"))?;
        let c_name = CString::new(raw).map_err(|_| invalid("invalid extended attribute name"))?;
        let length = unsafe { get_xattr(fd, c_name.as_ptr(), std::ptr::null_mut(), 0) };
        if length < 0 {
            return Err(io::Error::last_os_error());
        }
        let mut value = vec![0u8; length as usize];
        if length > 0 {
            let count =
                unsafe { get_xattr(fd, c_name.as_ptr(), value.as_mut_ptr().cast(), value.len()) };
            if count < 0 {
                return Err(io::Error::last_os_error());
            }
            if count as usize != value.len() {
                return Err(invalid("extended attribute changed"));
            }
        }
        if values.insert(name.to_owned(), value).is_some() {
            return Err(invalid("duplicate extended attribute"));
        }
    }
    Ok(values)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn extended_attributes(_file: &File) -> io::Result<BTreeMap<String, Vec<u8>>> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "extended attribute inspection unsupported",
    ))
}

/// The disconnected commit experiment currently handles only Linux files
/// without xattrs/ACL xattrs or user-visible inode flags. Unsupported
/// platforms and filesystems fail closed rather than discarding metadata.
#[cfg(target_os = "linux")]
fn require_plain_commit_metadata(file: &File) -> io::Result<()> {
    if !extended_attributes(file)?.is_empty() {
        return Err(invalid(
            "commit does not yet preserve extended attributes or ACLs",
        ));
    }
    let mut flags: libc::c_long = 0;
    if unsafe { libc::ioctl(file.as_raw_fd(), libc::FS_IOC_GETFLAGS, &mut flags) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // EXTENT is an internal ext4 allocation-format bit, not a user policy.
    const FS_EXTENT_FL: libc::c_long = 0x0008_0000;
    if flags & !FS_EXTENT_FL != 0 {
        return Err(invalid("commit does not yet preserve inode flags"));
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn require_plain_commit_metadata(_file: &File) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "commit metadata policy is not implemented on this platform",
    ))
}

#[cfg(target_os = "linux")]
fn open_stage_without_atime(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NOATIME)
        .open(path)
}

#[cfg(not(target_os = "linux"))]
fn open_stage_without_atime(_path: &Path) -> io::Result<File> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "commit metadata policy is not implemented on this platform",
    ))
}

/// Exclusive flock is retained on a file owned by this process until Drop.
/// Canonical directory aliases using the SAME lock directory select the same
/// path-derived lock. Hardlinks and final symlinks are refused; writers using
/// another lock directory or not cooperating with this protocol are not fenced.
pub struct LockedTarget {
    target: PathBuf,
    target_file: File,
    lock_file: File,
    key: String,
    commit_gate: Mutex<()>,
}

impl LockedTarget {
    pub fn acquire(lock_dir: &Path, target: &Path) -> io::Result<Self> {
        let lock_dir = private_dir(lock_dir)?;
        if fs::symlink_metadata(target)?.file_type().is_symlink() {
            return Err(invalid("target symlink is not supported"));
        }
        let canonical = fs::canonicalize(target)?;
        let target_file = open_target(&canonical)?;
        let before = target_file.metadata()?;
        let key = sha256(canonical.as_os_str().as_bytes());
        let lock_path = lock_dir.join(format!("{key}.lock"));
        let lock_file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(lock_path)?;
        let lock_meta = lock_file.metadata()?;
        if !lock_meta.is_file()
            || lock_meta.nlink() != 1
            || lock_meta.uid() != unsafe { libc::geteuid() }
            || lock_meta.mode() & 0o022 != 0
        {
            return Err(invalid("lock file must be private, owned, and single-link"));
        }
        if unsafe { libc::flock(lock_file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(io::Error::last_os_error());
        }
        if !same_identity(&before, &fs::symlink_metadata(&canonical)?) {
            return Err(invalid("target changed during lock admission"));
        }
        Ok(Self {
            target: canonical,
            target_file,
            lock_file,
            key,
            commit_gate: Mutex::new(()),
        })
    }

    pub fn canonical_target(&self) -> &Path {
        &self.target
    }
    pub fn lock_key(&self) -> &str {
        &self.key
    }

    /// Read through the admitted descriptor and reject detected changes or replacement.
    fn snapshot(&self) -> io::Result<(Vec<u8>, fs::Metadata, BTreeMap<String, Vec<u8>>)> {
        let before = self.target_file.metadata()?;
        let attributes = extended_attributes(&self.target_file)?;
        let mut bytes = Vec::new();
        let mut offset = 0;
        let mut chunk = [0; 64 * 1024];
        while offset < before.len() {
            let length = (before.len() - offset).min(chunk.len() as u64) as usize;
            let count = self.target_file.read_at(&mut chunk[..length], offset)?;
            if count == 0 {
                return Err(invalid("target shortened during snapshot"));
            }
            bytes.extend_from_slice(&chunk[..count]);
            offset += count as u64;
        }
        if self.target_file.read_at(&mut chunk[..1], offset)? != 0 {
            return Err(invalid("target grew during snapshot"));
        }
        let after = self.target_file.metadata()?;
        if extended_attributes(&self.target_file)? != attributes {
            return Err(invalid("extended attributes changed during snapshot"));
        }
        let path = fs::symlink_metadata(&self.target)?;
        if !same_identity(&before, &after)
            || !same_identity(&after, &path)
            || bytes.len() as u64 != after.len()
        {
            return Err(invalid("target changed during snapshot"));
        }
        // Keep the lock live through every snapshot and journal operation.
        let _ = self.lock_file.metadata()?;
        Ok((bytes, after, attributes))
    }
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PreparedIntent {
    pub schema: String,
    pub target: PathBuf,
    pub lock_key: String,
    pub original_sha256: String,
    pub candidate_sha256: String,
    pub original_size: u64,
    pub device: u64,
    pub inode: u64,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub xattrs: BTreeMap<String, Vec<u8>>,
    pub atime_seconds: i64,
    pub atime_nanos: i64,
    pub mtime_seconds: i64,
    pub mtime_nanos: i64,
    pub ctime_seconds: i64,
    pub ctime_nanos: i64,
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn create_synced(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

const STAGED_MARKER: &[u8] = b"iot-lab.adopt.staged.v1\n";

fn prepared_marker(intent: &[u8]) -> Vec<u8> {
    format!("iot-lab.adopt.prepared.v1:{}\n", sha256(intent)).into_bytes()
}

fn require_marker(path: &Path, expected: &[u8]) -> io::Result<()> {
    let mut data = Vec::new();
    open_regular(path)?.read_to_end(&mut data)?;
    if data != expected {
        return Err(invalid("incomplete or invalid journal marker"));
    }
    Ok(())
}

/// Create a durable original-byte backup and intent; never writes the target.
/// Incomplete directories remain as evidence and are never silently reused.
pub fn prepare(
    journal_root: &Path,
    id: &str,
    locked: &LockedTarget,
    expected_original_sha256: &str,
    candidate_sha256: &str,
) -> io::Result<PathBuf> {
    prepare_inner(
        journal_root,
        id,
        locked,
        expected_original_sha256,
        candidate_sha256,
        || Ok(()),
    )
}

fn prepare_inner(
    journal_root: &Path,
    id: &str,
    locked: &LockedTarget,
    expected_original_sha256: &str,
    candidate_sha256: &str,
    before_marker: impl FnOnce() -> io::Result<()>,
) -> io::Result<PathBuf> {
    let root = private_dir(journal_root)?;
    if !valid_id(id) || !is_sha256(expected_original_sha256) || !is_sha256(candidate_sha256) {
        return Err(invalid("invalid journal id or digest"));
    }
    let (bytes, metadata, xattrs) = locked.snapshot()?;
    if sha256(&bytes) != expected_original_sha256 {
        return Err(invalid("target does not match the expected source digest"));
    }
    let intent = PreparedIntent {
        schema: "iot-lab.adopt.prepare.v1".into(),
        target: locked.target.clone(),
        lock_key: locked.key.clone(),
        original_sha256: sha256(&bytes),
        candidate_sha256: candidate_sha256.into(),
        original_size: bytes.len() as u64,
        device: metadata.dev(),
        inode: metadata.ino(),
        mode: metadata.mode(),
        uid: metadata.uid(),
        gid: metadata.gid(),
        xattrs,
        atime_seconds: metadata.atime(),
        atime_nanos: metadata.atime_nsec(),
        mtime_seconds: metadata.mtime(),
        mtime_nanos: metadata.mtime_nsec(),
        ctime_seconds: metadata.ctime(),
        ctime_nanos: metadata.ctime_nsec(),
    };
    let dir = root.join(id);
    fs::DirBuilder::new().mode(0o700).create(&dir)?;
    File::open(&root)?.sync_all()?;
    create_synced(&dir.join("original.bin"), &bytes)?;
    let encoded = serde_json::to_vec(&intent).map_err(io::Error::other)?;
    create_synced(&dir.join("intent.json"), &encoded)?;
    File::open(&dir)?.sync_all()?;
    before_marker()?;
    // Payloads and their directory entries were synced before this marker can
    // appear. A crash before that point leaves an explicitly incomplete run.
    create_synced(&dir.join("prepared.ok"), &prepared_marker(&encoded))?;
    File::open(&dir)?.sync_all()?;
    Ok(dir)
}

/// Validate the prepared evidence only; no recovery, rename or target writes.
pub fn inspect_prepared(path: &Path) -> io::Result<PreparedIntent> {
    let dir = private_dir(path)?;
    let mut intent_bytes = Vec::new();
    open_regular(&dir.join("intent.json"))?.read_to_end(&mut intent_bytes)?;
    require_marker(&dir.join("prepared.ok"), &prepared_marker(&intent_bytes))?;
    let intent: PreparedIntent = serde_json::from_slice(&intent_bytes)
        .map_err(|_| invalid("invalid or incomplete intent"))?;
    if intent.schema != "iot-lab.adopt.prepare.v1"
        || !intent.target.is_absolute()
        || !is_sha256(&intent.lock_key)
        || !is_sha256(&intent.original_sha256)
        || !is_sha256(&intent.candidate_sha256)
        || sha256(intent.target.as_os_str().as_bytes()) != intent.lock_key
    {
        return Err(invalid("invalid intent fields"));
    }
    let mut backup = Vec::new();
    open_regular(&dir.join("original.bin"))?.read_to_end(&mut backup)?;
    if backup.len() as u64 != intent.original_size || sha256(&backup) != intent.original_sha256 {
        return Err(invalid("backup does not match intent"));
    }
    Ok(intent)
}

/// Byte observations only. None of these variants authorizes a restore or
/// completion: a future recovery owner must also validate its durable phase,
/// external-writer exclusion and full metadata, including platform file flags.
#[derive(Debug, PartialEq, Eq)]
pub enum RecoveryObservation {
    OriginalBytes,
    CandidateBytes,
    AmbiguousEqualBytes,
    Conflict,
}

/// Inspect while holding the same cooperative target lock; never changes the
/// target or journal. Missing/replaced targets fail instead of being restored.
pub fn observe_recovery(path: &Path, locked: &LockedTarget) -> io::Result<RecoveryObservation> {
    let intent = inspect_prepared(path)?;
    if intent.target != locked.target || intent.lock_key != locked.key {
        return Err(invalid("journal belongs to a different target"));
    }
    let (bytes, meta, xattrs) = locked.snapshot()?;
    if meta.mode() != intent.mode
        || meta.uid() != intent.uid
        || meta.gid() != intent.gid
        || xattrs != intent.xattrs
    {
        return Ok(RecoveryObservation::Conflict);
    }
    let actual = sha256(&bytes);
    Ok(
        match (
            actual == intent.original_sha256,
            actual == intent.candidate_sha256,
        ) {
            (true, true) => RecoveryObservation::AmbiguousEqualBytes,
            (true, false) => RecoveryObservation::OriginalBytes,
            (false, true) => RecoveryObservation::CandidateBytes,
            (false, false) => RecoveryObservation::Conflict,
        },
    )
}

fn validate_prepared_original(locked: &LockedTarget, intent: &PreparedIntent) -> io::Result<()> {
    if locked.target != intent.target || locked.key != intent.lock_key {
        return Err(invalid("journal belongs to a different target"));
    }
    let (bytes, meta, attrs) = locked.snapshot()?;
    #[cfg(target_os = "linux")]
    let atime_matches =
        meta.atime() == intent.atime_seconds && meta.atime_nsec() == intent.atime_nanos;
    #[cfg(not(target_os = "linux"))]
    let atime_matches = true; // Staging is read-only; commit is unsupported on these platforms.
    if sha256(&bytes) != intent.original_sha256
        || meta.dev() != intent.device
        || meta.ino() != intent.inode
        || meta.mode() != intent.mode
        || meta.uid() != intent.uid
        || meta.gid() != intent.gid
        || attrs != intent.xattrs
        || meta.mtime() != intent.mtime_seconds
        || meta.mtime_nsec() != intent.mtime_nanos
        || meta.ctime() != intent.ctime_seconds
        || meta.ctime_nsec() != intent.ctime_nanos
        || !atime_matches
    {
        return Err(invalid("source changed since preparation"));
    }
    Ok(())
}

/// Store only the supplied candidate bytes in the private journal. This does
/// not create a target-side temporary file or authorize a rename. Re-observe
/// the source after syncing: concurrent external edits leave this step failed.
pub fn stage_candidate(path: &Path, locked: &LockedTarget, candidate: &[u8]) -> io::Result<()> {
    stage_candidate_inner(path, locked, candidate, || Ok(()))
}

fn stage_candidate_inner(
    path: &Path,
    locked: &LockedTarget,
    candidate: &[u8],
    before_marker: impl FnOnce() -> io::Result<()>,
) -> io::Result<()> {
    let dir = private_dir(path)?;
    let intent = inspect_prepared(&dir)?;
    if intent.original_sha256 == intent.candidate_sha256 {
        return Err(invalid(
            "equal original and candidate digests are ambiguous",
        ));
    }
    if sha256(candidate) != intent.candidate_sha256 {
        return Err(invalid("candidate does not match the intended digest"));
    }
    validate_prepared_original(locked, &intent)?;
    create_synced(&dir.join("candidate.bin"), candidate)?;
    File::open(&dir)?.sync_all()?;
    before_marker()?;
    create_synced(&dir.join("staged.ok"), STAGED_MARKER)?;
    File::open(&dir)?.sync_all()?;
    validate_prepared_original(locked, &intent)?;
    Ok(())
}

/// Validate staged bytes only. A valid staged candidate is not a commit receipt.
pub fn inspect_staged(path: &Path) -> io::Result<PreparedIntent> {
    let dir = private_dir(path)?;
    let intent = inspect_prepared(&dir)?;
    require_marker(&dir.join("staged.ok"), STAGED_MARKER)?;
    if intent.original_sha256 == intent.candidate_sha256 {
        return Err(invalid(
            "equal original and candidate digests are ambiguous",
        ));
    }
    let mut candidate = Vec::new();
    open_regular(&dir.join("candidate.bin"))?.read_to_end(&mut candidate)?;
    if sha256(&candidate) != intent.candidate_sha256 {
        return Err(invalid("staged candidate does not match intent"));
    }
    Ok(intent)
}

// Experimental cooperative commit machinery. This is intentionally private
// and is NOT wired to a command: advisory flock cannot fence legacy board-key
// clients or arbitrary writers, the verifier is not owned here, and metadata
// support is intentionally incomplete. Do not treat it as adoption authority.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct CommitIntent {
    schema: String,
    prepared_sha256: String,
    candidate_sha256: String,
    stage_name: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct CommitReceipt {
    schema: String,
    commit_sha256: String,
    original_sha256: String,
    candidate_sha256: String,
}

fn marker(prefix: &str, bytes: &[u8]) -> Vec<u8> {
    format!("{prefix}:{}\n", sha256(bytes)).into_bytes()
}

fn unchanged_intent_bytes(dir: &Path, intent: &PreparedIntent) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    open_regular(&dir.join("intent.json"))?.read_to_end(&mut bytes)?;
    if bytes != serde_json::to_vec(intent).map_err(io::Error::other)? {
        return Err(invalid("prepared intent changed"));
    }
    require_marker(&dir.join("prepared.ok"), &prepared_marker(&bytes))?;
    Ok(bytes)
}

fn stage_name(dir: &Path, key: &str) -> io::Result<String> {
    let id = dir
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| invalid("invalid journal id"))?;
    if !valid_id(id) || !is_sha256(key) {
        return Err(invalid("invalid journal id or lock key"));
    }
    Ok(format!(".pcb-adopt-{}-{id}", &key[..16]))
}

fn validate_original(locked: &LockedTarget, intent: &PreparedIntent) -> io::Result<()> {
    validate_prepared_original(locked, intent)?;
    require_plain_commit_metadata(&locked.target_file)
}

/// Under a live cooperative lock, stage and atomically replace only after the
/// caller-supplied verifier and a second source check. Error after rename is an
/// unknown outcome requiring recovery inspection; it never auto-rolls back.
fn commit_experiment(
    journal: &Path,
    locked: &LockedTarget,
    verify: impl FnOnce() -> io::Result<()>,
    mut boundary: impl FnMut(&str) -> io::Result<()>,
) -> io::Result<()> {
    // The flock excludes other descriptors/processes. This gate also prevents
    // two threads sharing this same LockedTarget from committing concurrently.
    let _commit = locked.commit_gate.try_lock().map_err(|error| match error {
        TryLockError::WouldBlock => io::Error::new(
            io::ErrorKind::WouldBlock,
            "target already has a commit in progress",
        ),
        TryLockError::Poisoned(_) => invalid("target commit owner is poisoned"),
    })?;
    let dir = private_dir(journal)?;
    let intent = inspect_staged(&dir)?;
    validate_original(locked, &intent)?;
    let mut candidate = Vec::new();
    open_regular(&dir.join("candidate.bin"))?.read_to_end(&mut candidate)?;
    if sha256(&candidate) != intent.candidate_sha256 {
        return Err(invalid("candidate changed before commit"));
    }
    let parent = locked
        .target
        .parent()
        .ok_or_else(|| invalid("target has no parent"))?;
    let name = stage_name(&dir, &locked.key)?;
    let stage_path = parent.join(&name);
    let commit = CommitIntent {
        schema: "iot-lab.adopt.commit.v1".into(),
        prepared_sha256: sha256(&unchanged_intent_bytes(&dir, &intent)?),
        candidate_sha256: intent.candidate_sha256.clone(),
        stage_name: name,
    };
    let commit_bytes = serde_json::to_vec(&commit).map_err(io::Error::other)?;
    create_synced(&dir.join("commit-intent.json"), &commit_bytes)?;
    File::open(&dir)?.sync_all()?;
    let mut stage = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&stage_path)?;
    stage.write_all(&candidate)?;
    let created = stage.metadata()?;
    if created.uid() != intent.uid || created.gid() != intent.gid {
        if unsafe { libc::fchown(stage.as_raw_fd(), intent.uid, intent.gid) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    if unsafe { libc::fchmod(stage.as_raw_fd(), intent.mode & 0o7777) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let times = [
        libc::timespec {
            tv_sec: intent.atime_seconds as libc::time_t,
            tv_nsec: intent.atime_nanos as libc::c_long,
        },
        libc::timespec {
            tv_sec: intent.mtime_seconds as libc::time_t,
            tv_nsec: intent.mtime_nanos as libc::c_long,
        },
    ];
    if unsafe { libc::futimens(stage.as_raw_fd(), times.as_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    require_plain_commit_metadata(&stage)?;
    stage.sync_all()?;
    File::open(parent)?.sync_all()?;
    create_synced(
        &dir.join("commit.ready"),
        &marker("iot-lab.adopt.commit-ready.v1", &commit_bytes),
    )?;
    File::open(&dir)?.sync_all()?;
    boundary("before-verifier")?;
    verify()?;
    boundary("before-rename")?;
    validate_original(locked, &intent)?;
    let staged = stage.metadata()?;
    if !same_identity(&staged, &fs::symlink_metadata(&stage_path)?)
        || staged.mode() != intent.mode
        || staged.uid() != intent.uid
        || staged.gid() != intent.gid
        || staged.len() != candidate.len() as u64
        || staged.atime() != intent.atime_seconds
        || staged.atime_nsec() != intent.atime_nanos
        || staged.mtime() != intent.mtime_seconds
        || staged.mtime_nsec() != intent.mtime_nanos
    {
        return Err(invalid("staged candidate metadata changed"));
    }
    require_plain_commit_metadata(&stage)?;
    let mut stage_check = open_stage_without_atime(&stage_path)?;
    if !same_identity(&staged, &stage_check.metadata()?) {
        return Err(invalid("staged candidate changed"));
    }
    let mut staged_bytes = Vec::new();
    stage_check.read_to_end(&mut staged_bytes)?;
    if sha256(&staged_bytes) != intent.candidate_sha256
        || !same_identity(&staged, &stage_check.metadata()?)
    {
        return Err(invalid("staged candidate changed before rename"));
    }
    if let Err(error) = fs::rename(&stage_path, &locked.target) {
        return Err(io::Error::new(
            error.kind(),
            format!("rename attempted; recovery inspection required: {error}"),
        ));
    }
    let after_rename = (|| -> io::Result<()> {
        File::open(parent)?.sync_all()?;
        boundary("after-rename")?;
        let target_meta = fs::symlink_metadata(&locked.target)?;
        if target_meta.dev() != staged.dev()
            || target_meta.ino() != staged.ino()
            || target_meta.mode() != intent.mode
            || target_meta.uid() != intent.uid
            || target_meta.gid() != intent.gid
            || target_meta.len() != candidate.len() as u64
        {
            return Err(invalid("target changed after rename"));
        }
        let receipt = CommitReceipt {
            schema: "iot-lab.adopt.receipt.v1".into(),
            commit_sha256: sha256(&commit_bytes),
            original_sha256: intent.original_sha256,
            candidate_sha256: intent.candidate_sha256,
        };
        let receipt_bytes = serde_json::to_vec(&receipt).map_err(io::Error::other)?;
        create_synced(&dir.join("receipt.json"), &receipt_bytes)?;
        File::open(&dir)?.sync_all()?;
        create_synced(
            &dir.join("receipt.ok"),
            &marker("iot-lab.adopt.receipt-ready.v1", &receipt_bytes),
        )?;
        File::open(&dir)?.sync_all()?;
        boundary("after-receipt")?;
        Ok(())
    })();
    after_rename.map_err(|error| {
        io::Error::new(
            error.kind(),
            format!("target renamed; recovery inspection required: {error}"),
        )
    })
}

/// Read-only evidence classification; it is not authority to adopt, retry or
/// restore. In particular CandidateUnconfirmed requires human/integrator
/// reconciliation, and external writers remain outside this advisory lock.
#[derive(Debug, PartialEq, Eq)]
pub enum CommitObservation {
    Incomplete,
    OriginalWithReadyRecord,
    CandidateUnconfirmed,
    ReceiptPresent,
    Conflict,
}

pub fn observe_commit(journal: &Path, locked: &LockedTarget) -> io::Result<CommitObservation> {
    let dir = private_dir(journal)?;
    let prepared = inspect_staged(&dir)?;
    let state = observe_recovery(&dir, locked)?;
    let commit_path = dir.join("commit-intent.json");
    let ready_path = dir.join("commit.ready");
    if !commit_path.exists() || !ready_path.exists() {
        return Ok(if state == RecoveryObservation::OriginalBytes {
            CommitObservation::Incomplete
        } else {
            CommitObservation::Conflict
        });
    }
    let mut commit_bytes = Vec::new();
    open_regular(&commit_path)?.read_to_end(&mut commit_bytes)?;
    require_marker(
        &ready_path,
        &marker("iot-lab.adopt.commit-ready.v1", &commit_bytes),
    )?;
    let commit: CommitIntent =
        serde_json::from_slice(&commit_bytes).map_err(|_| invalid("invalid commit intent"))?;
    if commit.schema != "iot-lab.adopt.commit.v1"
        || commit.prepared_sha256 != sha256(&unchanged_intent_bytes(&dir, &prepared)?)
        || commit.candidate_sha256 != prepared.candidate_sha256
        || commit.stage_name != stage_name(&dir, &prepared.lock_key)?
    {
        return Err(invalid("commit intent does not match prepared evidence"));
    }
    match state {
        RecoveryObservation::OriginalBytes => Ok(CommitObservation::OriginalWithReadyRecord),
        RecoveryObservation::CandidateBytes => {
            let receipt_path = dir.join("receipt.json");
            let marker_path = dir.join("receipt.ok");
            if !receipt_path.exists() || !marker_path.exists() {
                return Ok(CommitObservation::CandidateUnconfirmed);
            }
            let mut bytes = Vec::new();
            open_regular(&receipt_path)?.read_to_end(&mut bytes)?;
            require_marker(
                &marker_path,
                &marker("iot-lab.adopt.receipt-ready.v1", &bytes),
            )?;
            let receipt: CommitReceipt =
                serde_json::from_slice(&bytes).map_err(|_| invalid("invalid commit receipt"))?;
            if receipt.schema != "iot-lab.adopt.receipt.v1"
                || receipt.commit_sha256 != sha256(&commit_bytes)
                || receipt.original_sha256 != prepared.original_sha256
                || receipt.candidate_sha256 != prepared.candidate_sha256
            {
                return Err(invalid("receipt does not match commit evidence"));
            }
            Ok(CommitObservation::ReceiptPresent)
        }
        _ => Ok(CommitObservation::Conflict),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);
    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "adopt-prepare-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            Self(path)
        }
        fn dir(&self, name: &str) -> PathBuf {
            let path = self.0.join(name);
            fs::create_dir(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            path
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    struct ChildGuard(Child);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn subprocess_lock_holder() {
        let Some(locks) = std::env::var_os("ADOPT_TEST_LOCK_DIR") else {
            return;
        };
        let target = std::env::var_os("ADOPT_TEST_TARGET").unwrap();
        let _lock = LockedTarget::acquire(Path::new(&locks), Path::new(&target)).unwrap();
        println!("ADOPT_TEST_LOCK_HELD");
        io::stdout().flush().unwrap();
        std::thread::sleep(std::time::Duration::from_secs(30));
    }

    #[test]
    fn subprocess_journal_holder() {
        let Some(phase) = std::env::var_os("ADOPT_TEST_JOURNAL_PHASE") else {
            return;
        };
        let locks = PathBuf::from(std::env::var_os("ADOPT_TEST_LOCK_DIR").unwrap());
        let target = PathBuf::from(std::env::var_os("ADOPT_TEST_TARGET").unwrap());
        let journals = PathBuf::from(std::env::var_os("ADOPT_TEST_JOURNALS").unwrap());
        let locked = LockedTarget::acquire(&locks, &target).unwrap();
        let pause = || {
            println!("ADOPT_TEST_JOURNAL_BOUNDARY");
            io::stdout().flush().unwrap();
            std::thread::sleep(std::time::Duration::from_secs(30));
            Ok(())
        };
        if phase == "prepare" {
            prepare_inner(
                &journals,
                "run",
                &locked,
                &sha256(b"original"),
                &sha256(b"candidate"),
                pause,
            )
            .unwrap();
        } else if phase == "stage" {
            stage_candidate_inner(&journals.join("run"), &locked, b"candidate", pause).unwrap();
        } else {
            let wanted = phase.to_string_lossy();
            commit_experiment(
                &journals.join("run"),
                &locked,
                || Ok(()),
                |boundary| {
                    if wanted == boundary {
                        pause()?;
                    }
                    Ok(())
                },
            )
            .unwrap();
        }
    }

    fn crash_at_journal_boundary(phase: &str, locks: &Path, journals: &Path, target: &Path) {
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "adopt_prepare::tests::subprocess_journal_holder",
                "--nocapture",
            ])
            .env("ADOPT_TEST_JOURNAL_PHASE", phase)
            .env("ADOPT_TEST_LOCK_DIR", locks)
            .env("ADOPT_TEST_JOURNALS", journals)
            .env("ADOPT_TEST_TARGET", target)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut child = ChildGuard(child);
        let stream = child.0.stdout.take().unwrap();
        let mut ready = false;
        for line in BufReader::new(stream).lines() {
            if line.unwrap().contains("ADOPT_TEST_JOURNAL_BOUNDARY") {
                ready = true;
                break;
            }
        }
        assert!(ready, "subprocess did not reach journal boundary");
        child.0.kill().unwrap();
        child.0.wait().unwrap();
    }

    #[test]
    fn killed_before_prepare_marker_leaves_incomplete_journal() {
        let temp = Scratch::new();
        let locks = temp.dir("locks");
        let journals = temp.dir("journals");
        let target = temp.0.join("board");
        fs::write(&target, b"original").unwrap();
        crash_at_journal_boundary("prepare", &locks, &journals, &target);
        assert!(inspect_prepared(&journals.join("run")).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"original");
        assert!(LockedTarget::acquire(&locks, &target).is_ok());
    }

    #[test]
    fn killed_before_staged_marker_leaves_only_prepared_evidence() {
        let temp = Scratch::new();
        let locks = temp.dir("locks");
        let journals = temp.dir("journals");
        let target = temp.0.join("board");
        fs::write(&target, b"original").unwrap();
        let locked = LockedTarget::acquire(&locks, &target).unwrap();
        let dir = prepare(
            &journals,
            "run",
            &locked,
            &sha256(b"original"),
            &sha256(b"candidate"),
        )
        .unwrap();
        drop(locked);
        crash_at_journal_boundary("stage", &locks, &journals, &target);
        assert!(inspect_prepared(&dir).is_ok());
        assert!(inspect_staged(&dir).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"original");
        assert!(LockedTarget::acquire(&locks, &target).is_ok());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn killed_commit_never_silently_rolls_back_or_claims_a_missing_receipt() {
        for (phase, expected, bytes) in [
            (
                "before-rename",
                CommitObservation::OriginalWithReadyRecord,
                b"original".as_slice(),
            ),
            (
                "after-rename",
                CommitObservation::CandidateUnconfirmed,
                b"candidate".as_slice(),
            ),
            (
                "after-receipt",
                CommitObservation::ReceiptPresent,
                b"candidate".as_slice(),
            ),
        ] {
            let temp = Scratch::new();
            let locks = temp.dir("locks");
            let journals = temp.dir("journals");
            let target = temp.0.join("board");
            fs::write(&target, b"original").unwrap();
            let lock = LockedTarget::acquire(&locks, &target).unwrap();
            let dir = prepare(
                &journals,
                "run",
                &lock,
                &sha256(b"original"),
                &sha256(b"candidate"),
            )
            .unwrap();
            stage_candidate(&dir, &lock, b"candidate").unwrap();
            drop(lock);
            crash_at_journal_boundary(phase, &locks, &journals, &target);
            assert_eq!(fs::read(&target).unwrap(), bytes);
            let recovery_lock = LockedTarget::acquire(&locks, &target).unwrap();
            assert_eq!(observe_commit(&dir, &recovery_lock).unwrap(), expected);
            assert_eq!(fs::read(&target).unwrap(), bytes);
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn cooperative_commit_preserves_supported_metadata_and_records_receipt() {
        let temp = Scratch::new();
        let locks = temp.dir("locks");
        let journals = temp.dir("journals");
        let target = temp.0.join("board");
        fs::write(&target, b"original").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o640)).unwrap();
        let lock = LockedTarget::acquire(&locks, &target).unwrap();
        let dir = prepare(
            &journals,
            "run",
            &lock,
            &sha256(b"original"),
            &sha256(b"candidate"),
        )
        .unwrap();
        let intent = inspect_prepared(&dir).unwrap();
        stage_candidate(&dir, &lock, b"candidate").unwrap();
        let mut verified = false;
        commit_experiment(
            &dir,
            &lock,
            || {
                verified = true;
                Ok(())
            },
            |_| Ok(()),
        )
        .unwrap();
        assert!(verified);
        let meta = fs::metadata(&target).unwrap();
        assert_eq!(
            (meta.mode(), meta.uid(), meta.gid()),
            (intent.mode, intent.uid, intent.gid)
        );
        assert_eq!(
            (meta.mtime(), meta.mtime_nsec()),
            (intent.mtime_seconds, intent.mtime_nanos)
        );
        drop(lock);
        let recovered = LockedTarget::acquire(&locks, &target).unwrap();
        assert_eq!(
            observe_commit(&dir, &recovered).unwrap(),
            CommitObservation::ReceiptPresent
        );
        fs::write(dir.join("receipt.json"), b"{}").unwrap();
        assert!(observe_commit(&dir, &recovered).is_err());
        assert_eq!(fs::read(target).unwrap(), b"candidate");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn concurrent_commits_sharing_one_owner_cannot_both_enter() {
        let temp = Scratch::new();
        let locks = temp.dir("locks");
        let journals = temp.dir("journals");
        let target = temp.0.join("board");
        fs::write(&target, b"original").unwrap();
        let lock = LockedTarget::acquire(&locks, &target).unwrap();
        let left = prepare(
            &journals,
            "left",
            &lock,
            &sha256(b"original"),
            &sha256(b"candidate"),
        )
        .unwrap();
        let right = prepare(
            &journals,
            "right",
            &lock,
            &sha256(b"original"),
            &sha256(b"candidate"),
        )
        .unwrap();
        stage_candidate(&left, &lock, b"candidate").unwrap();
        stage_candidate(&right, &lock, b"candidate").unwrap();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (resume_tx, resume_rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            let left_ref = &left;
            let lock_ref = &lock;
            let first = scope.spawn(move || {
                commit_experiment(
                    left_ref,
                    lock_ref,
                    || Ok(()),
                    |point| {
                        if point == "before-rename" {
                            ready_tx.send(()).unwrap();
                            resume_rx.recv().unwrap();
                        }
                        Ok(())
                    },
                )
            });
            ready_rx.recv().unwrap();
            let second = commit_experiment(&right, &lock, || Ok(()), |_| Ok(()));
            let second_started = right.join("commit-intent.json").exists();
            resume_tx.send(()).unwrap();
            first.join().unwrap().unwrap();
            assert_eq!(second.unwrap_err().kind(), io::ErrorKind::WouldBlock);
            assert!(!second_started);
        });
        assert_eq!(fs::read(target).unwrap(), b"candidate");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn failed_verification_or_changed_source_never_replaces_the_target() {
        for change_source in [false, true] {
            let temp = Scratch::new();
            let locks = temp.dir("locks");
            let journals = temp.dir("journals");
            let target = temp.0.join("board");
            fs::write(&target, b"original").unwrap();
            let lock = LockedTarget::acquire(&locks, &target).unwrap();
            let dir = prepare(
                &journals,
                "run",
                &lock,
                &sha256(b"original"),
                &sha256(b"candidate"),
            )
            .unwrap();
            stage_candidate(&dir, &lock, b"candidate").unwrap();
            let result = commit_experiment(
                &dir,
                &lock,
                || {
                    if change_source {
                        Ok(())
                    } else {
                        Err(invalid("verification failed"))
                    }
                },
                |point| {
                    if change_source && point == "before-rename" {
                        fs::write(&target, b"concurrent")?;
                    }
                    Ok(())
                },
            );
            assert!(result.is_err());
            assert_eq!(
                fs::read(&target).unwrap(),
                if change_source {
                    b"concurrent".as_slice()
                } else {
                    b"original".as_slice()
                }
            );
            assert!(!dir.join("receipt.ok").exists());
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn error_after_rename_reports_uncertain_outcome_without_restoring() {
        let temp = Scratch::new();
        let locks = temp.dir("locks");
        let journals = temp.dir("journals");
        let target = temp.0.join("board");
        fs::write(&target, b"original").unwrap();
        let lock = LockedTarget::acquire(&locks, &target).unwrap();
        let dir = prepare(
            &journals,
            "run",
            &lock,
            &sha256(b"original"),
            &sha256(b"candidate"),
        )
        .unwrap();
        stage_candidate(&dir, &lock, b"candidate").unwrap();
        let error = commit_experiment(
            &dir,
            &lock,
            || Ok(()),
            |point| {
                if point == "after-rename" {
                    Err(invalid("injected receipt failure"))
                } else {
                    Ok(())
                }
            },
        )
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("target renamed; recovery inspection required")
        );
        drop(lock);
        let recovered = LockedTarget::acquire(&locks, &target).unwrap();
        assert_eq!(
            observe_commit(&dir, &recovered).unwrap(),
            CommitObservation::CandidateUnconfirmed
        );
        assert_eq!(fs::read(target).unwrap(), b"candidate");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn changed_source_timestamp_blocks_rename_even_when_bytes_match() {
        let temp = Scratch::new();
        let locks = temp.dir("locks");
        let journals = temp.dir("journals");
        let target = temp.0.join("board");
        fs::write(&target, b"original").unwrap();
        let lock = LockedTarget::acquire(&locks, &target).unwrap();
        let dir = prepare(
            &journals,
            "run",
            &lock,
            &sha256(b"original"),
            &sha256(b"candidate"),
        )
        .unwrap();
        let intent = inspect_prepared(&dir).unwrap();
        stage_candidate(&dir, &lock, b"candidate").unwrap();
        let result = commit_experiment(
            &dir,
            &lock,
            || Ok(()),
            |point| {
                if point == "before-rename" {
                    let f = OpenOptions::new().write(true).open(&target)?;
                    let times = [
                        libc::timespec {
                            tv_sec: intent.atime_seconds as libc::time_t,
                            tv_nsec: intent.atime_nanos as libc::c_long,
                        },
                        libc::timespec {
                            tv_sec: (intent.mtime_seconds + 1) as libc::time_t,
                            tv_nsec: intent.mtime_nanos as libc::c_long,
                        },
                    ];
                    if unsafe { libc::futimens(f.as_raw_fd(), times.as_ptr()) } != 0 {
                        return Err(io::Error::last_os_error());
                    }
                }
                Ok(())
            },
        );
        assert!(result.is_err());
        assert_eq!(fs::read(target).unwrap(), b"original");
        assert!(!dir.join("receipt.ok").exists());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn replaced_staging_file_cannot_be_promoted() {
        let temp = Scratch::new();
        let locks = temp.dir("locks");
        let journals = temp.dir("journals");
        let target = temp.0.join("board");
        fs::write(&target, b"original").unwrap();
        let lock = LockedTarget::acquire(&locks, &target).unwrap();
        let dir = prepare(
            &journals,
            "run",
            &lock,
            &sha256(b"original"),
            &sha256(b"candidate"),
        )
        .unwrap();
        stage_candidate(&dir, &lock, b"candidate").unwrap();
        let stage = target
            .parent()
            .unwrap()
            .join(stage_name(&dir, lock.lock_key()).unwrap());
        let result = commit_experiment(
            &dir,
            &lock,
            || Ok(()),
            |point| {
                if point == "before-rename" {
                    fs::write(&stage, b"tampered!")?;
                }
                Ok(())
            },
        );
        assert!(result.is_err());
        assert_eq!(fs::read(target).unwrap(), b"original");
        assert!(!dir.join("receipt.ok").exists());
    }

    #[test]
    fn process_death_releases_exclusive_lock_for_a_competitor() {
        let temp = Scratch::new();
        let locks = temp.dir("locks");
        let target = temp.0.join("board");
        fs::write(&target, b"original").unwrap();
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "adopt_prepare::tests::subprocess_lock_holder",
                "--nocapture",
            ])
            .env("ADOPT_TEST_LOCK_DIR", &locks)
            .env("ADOPT_TEST_TARGET", &target)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut child = ChildGuard(child);
        let stream = child.0.stdout.take().unwrap();
        let mut ready = false;
        for line in BufReader::new(stream).lines() {
            if line.unwrap().contains("ADOPT_TEST_LOCK_HELD") {
                ready = true;
                break;
            }
        }
        assert!(ready, "subprocess failed to acquire lock");
        assert_eq!(
            LockedTarget::acquire(&locks, &target).err().unwrap().kind(),
            io::ErrorKind::WouldBlock
        );
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        assert!(LockedTarget::acquire(&locks, &target).is_ok());
        assert_eq!(fs::read(&target).unwrap(), b"original");
    }

    #[test]
    fn aliases_contend_and_dropping_owner_releases_lock() {
        let temp = Scratch::new();
        let lock_dir = temp.dir("locks");
        let board_dir = temp.dir("boards");
        let board = board_dir.join("board.kicad_pcb");
        fs::write(&board, b"original").unwrap();
        symlink(&board_dir, temp.0.join("alias")).unwrap();
        let first = LockedTarget::acquire(&lock_dir, &board).unwrap();
        let alias = temp.0.join("alias/board.kicad_pcb");
        assert_eq!(first.canonical_target(), fs::canonicalize(&board).unwrap());
        assert_eq!(
            LockedTarget::acquire(&lock_dir, &alias)
                .err()
                .unwrap()
                .kind(),
            io::ErrorKind::WouldBlock
        );
        drop(first);
        assert!(LockedTarget::acquire(&lock_dir, &alias).is_ok());
    }

    #[test]
    fn final_symlinks_and_hardlinks_are_rejected() {
        let temp = Scratch::new();
        let locks = temp.dir("locks");
        let board = temp.0.join("board");
        fs::write(&board, b"source").unwrap();
        symlink(&board, temp.0.join("symlink")).unwrap();
        assert!(LockedTarget::acquire(&locks, &temp.0.join("symlink")).is_err());
        fs::hard_link(&board, temp.0.join("hardlink")).unwrap();
        assert!(LockedTarget::acquire(&locks, &board).is_err());
    }

    #[test]
    fn prepare_records_original_and_never_changes_target() {
        let temp = Scratch::new();
        let locks = temp.dir("locks");
        let journals = temp.dir("journals");
        let target = temp.0.join("board");
        fs::write(&target, b"original board").unwrap();
        let lock = LockedTarget::acquire(&locks, &target).unwrap();
        let candidate = sha256(b"candidate");
        let expected = sha256(b"original board");
        let first = prepare(&journals, "run-1", &lock, &expected, &candidate).unwrap();
        let intent = inspect_prepared(&first).unwrap();
        assert_eq!(intent.original_sha256, sha256(b"original board"));
        assert_eq!(intent.candidate_sha256, candidate);
        assert_eq!(fs::read(&target).unwrap(), b"original board");
        assert_eq!(
            fs::read(first.join("original.bin")).unwrap(),
            b"original board"
        );
        assert!(prepare(&journals, "run-1", &lock, &expected, &candidate).is_err());
        let second = prepare(&journals, "run-2", &lock, &expected, &candidate).unwrap();
        assert_eq!(
            inspect_prepared(&second).unwrap().original_sha256,
            intent.original_sha256
        );
        fs::remove_file(first.join("prepared.ok")).unwrap();
        assert!(inspect_prepared(&first).is_err());
    }

    #[test]
    fn concurrent_preparations_read_independent_offsets() {
        let temp = Scratch::new();
        let locks = temp.dir("locks");
        let journals = temp.dir("journals");
        let target = temp.0.join("board");
        let bytes = vec![b'x'; 200_000];
        fs::write(&target, &bytes).unwrap();
        let lock = LockedTarget::acquire(&locks, &target).unwrap();
        std::thread::scope(|scope| {
            let left =
                scope.spawn(|| prepare(&journals, "left", &lock, &sha256(&bytes), &sha256(b"new")));
            let right = scope
                .spawn(|| prepare(&journals, "right", &lock, &sha256(&bytes), &sha256(b"new")));
            assert!(left.join().unwrap().is_ok());
            assert!(right.join().unwrap().is_ok());
        });
        assert_eq!(fs::read(target).unwrap(), bytes);
    }

    #[test]
    fn partial_or_tampered_journal_is_never_accepted() {
        let temp = Scratch::new();
        let locks = temp.dir("locks");
        let journals = temp.dir("journals");
        let target = temp.0.join("board");
        fs::write(&target, b"original").unwrap();
        let lock = LockedTarget::acquire(&locks, &target).unwrap();
        let dir = prepare(
            &journals,
            "run",
            &lock,
            &sha256(b"original"),
            &sha256(b"new"),
        )
        .unwrap();
        fs::write(dir.join("original.bin"), b"corrupt").unwrap();
        assert!(inspect_prepared(&dir).is_err());
        fs::remove_file(dir.join("intent.json")).unwrap();
        assert!(inspect_prepared(&dir).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"original");
    }

    #[test]
    fn prepared_marker_binds_exact_intent_bytes() {
        let temp = Scratch::new();
        let locks = temp.dir("locks");
        let journals = temp.dir("journals");
        let target = temp.0.join("board");
        fs::write(&target, b"original").unwrap();
        let lock = LockedTarget::acquire(&locks, &target).unwrap();
        let dir = prepare(
            &journals,
            "run",
            &lock,
            &sha256(b"original"),
            &sha256(b"candidate"),
        )
        .unwrap();
        let mut intent = inspect_prepared(&dir).unwrap();
        intent.candidate_sha256 = sha256(b"different");
        fs::write(
            dir.join("intent.json"),
            serde_json::to_vec(&intent).unwrap(),
        )
        .unwrap();
        assert!(inspect_prepared(&dir).is_err());
        assert_eq!(fs::read(target).unwrap(), b"original");
    }

    #[test]
    fn crash_boundary_shapes_without_complete_intent_fail_closed() {
        let temp = Scratch::new();
        let journals = temp.dir("journals");
        let dir = temp.dir("incomplete");
        assert!(inspect_prepared(&dir).is_err());
        create_synced(&dir.join("original.bin"), b"original").unwrap();
        assert!(inspect_prepared(&dir).is_err());
        create_synced(&dir.join("intent.json"), b"{\"schema\":").unwrap();
        assert!(inspect_prepared(&dir).is_err());
        assert!(!journals.join("../escape").exists());
    }

    #[test]
    fn unsafe_lock_directory_and_ids_are_rejected() {
        let temp = Scratch::new();
        let locks = temp.dir("locks");
        let journals = temp.dir("journals");
        let board = temp.0.join("board");
        fs::write(&board, b"original").unwrap();
        fs::set_permissions(&locks, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(LockedTarget::acquire(&locks, &board).is_err());
        fs::set_permissions(&locks, fs::Permissions::from_mode(0o700)).unwrap();
        let lock = LockedTarget::acquire(&locks, &board).unwrap();
        assert!(
            prepare(
                &journals,
                "../escape",
                &lock,
                &sha256(b"original"),
                &sha256(b"new")
            )
            .is_err()
        );
        assert!(prepare(&journals, "run", &lock, &sha256(b"original"), "bad").is_err());
        assert!(!journals.join("run").exists());
    }

    #[test]
    fn target_replacement_invalidates_the_admitted_snapshot() {
        let temp = Scratch::new();
        let locks = temp.dir("locks");
        let journals = temp.dir("journals");
        let target = temp.0.join("board");
        fs::write(&target, b"original").unwrap();
        let lock = LockedTarget::acquire(&locks, &target).unwrap();
        let replacement = temp.0.join("replacement");
        fs::write(&replacement, b"changed").unwrap();
        fs::rename(replacement, &target).unwrap();
        assert!(
            prepare(
                &journals,
                "run",
                &lock,
                &sha256(b"original"),
                &sha256(b"new")
            )
            .is_err()
        );
        assert_eq!(fs::read(&target).unwrap(), b"changed");
    }

    #[test]
    fn changed_source_digest_is_rejected_without_a_journal() {
        let temp = Scratch::new();
        let locks = temp.dir("locks");
        let journals = temp.dir("journals");
        let target = temp.0.join("board");
        fs::write(&target, b"current").unwrap();
        let lock = LockedTarget::acquire(&locks, &target).unwrap();
        assert!(prepare(&journals, "run", &lock, &sha256(b"stale"), &sha256(b"new")).is_err());
        assert!(!journals.join("run").exists());
        assert_eq!(fs::read(&target).unwrap(), b"current");
    }

    #[test]
    fn recovery_observes_bytes_without_changing_or_authorizing_them() {
        let temp = Scratch::new();
        let locks = temp.dir("locks");
        let journals = temp.dir("journals");
        let target = temp.0.join("board");
        fs::write(&target, b"original").unwrap();
        let lock = LockedTarget::acquire(&locks, &target).unwrap();
        let journal = prepare(
            &journals,
            "run",
            &lock,
            &sha256(b"original"),
            &sha256(b"candidate"),
        )
        .unwrap();
        assert_eq!(
            observe_recovery(&journal, &lock).unwrap(),
            RecoveryObservation::OriginalBytes
        );
        let stage = temp.0.join("stage");
        fs::write(&stage, b"candidate").unwrap();
        fs::set_permissions(&stage, fs::metadata(&target).unwrap().permissions()).unwrap();
        fs::rename(stage, &target).unwrap();
        // A recovery process opens the new inode after the original owner exits.
        drop(lock);
        let lock = LockedTarget::acquire(&locks, &target).unwrap();
        assert_eq!(
            observe_recovery(&journal, &lock).unwrap(),
            RecoveryObservation::CandidateBytes
        );
        fs::write(&target, b"other").unwrap();
        assert_eq!(
            observe_recovery(&journal, &lock).unwrap(),
            RecoveryObservation::Conflict
        );
        assert_eq!(fs::read(&target).unwrap(), b"other");
    }

    #[test]
    fn recovery_rejects_wrong_target_and_marks_equal_digests_ambiguous() {
        let temp = Scratch::new();
        let locks = temp.dir("locks");
        let journals = temp.dir("journals");
        let first = temp.0.join("first");
        let second = temp.0.join("second");
        fs::write(&first, b"same").unwrap();
        fs::write(&second, b"same").unwrap();
        fs::set_permissions(&first, fs::Permissions::from_mode(0o644)).unwrap();
        let lock1 = LockedTarget::acquire(&locks, &first).unwrap();
        let lock2 = LockedTarget::acquire(&locks, &second).unwrap();
        let journal =
            prepare(&journals, "run", &lock1, &sha256(b"same"), &sha256(b"same")).unwrap();
        assert_eq!(
            observe_recovery(&journal, &lock1).unwrap(),
            RecoveryObservation::AmbiguousEqualBytes
        );
        assert!(observe_recovery(&journal, &lock2).is_err());
        fs::set_permissions(&first, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            observe_recovery(&journal, &lock1).unwrap(),
            RecoveryObservation::Conflict
        );
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn recovery_detects_changed_extended_attributes() {
        let temp = Scratch::new();
        let locks = temp.dir("locks");
        let journals = temp.dir("journals");
        let target = temp.0.join("board");
        fs::write(&target, b"original").unwrap();
        let file = open_regular(&target).unwrap();
        #[cfg(target_os = "linux")]
        let name = CString::new("user.iot-lab-test").unwrap();
        #[cfg(target_os = "macos")]
        let name = CString::new("com.iot-lab-test").unwrap();
        let set = |value: &[u8]| {
            #[cfg(target_os = "linux")]
            let result = unsafe {
                libc::fsetxattr(
                    file.as_raw_fd(),
                    name.as_ptr(),
                    value.as_ptr().cast(),
                    value.len(),
                    0,
                )
            };
            #[cfg(target_os = "macos")]
            let result = unsafe {
                libc::fsetxattr(
                    file.as_raw_fd(),
                    name.as_ptr(),
                    value.as_ptr().cast(),
                    value.len(),
                    0,
                    0,
                )
            };
            if result != 0 {
                panic!(
                    "setting test attribute failed: {}",
                    io::Error::last_os_error()
                );
            }
        };
        set(b"before");
        let lock = LockedTarget::acquire(&locks, &target).unwrap();
        let dir = prepare(
            &journals,
            "run",
            &lock,
            &sha256(b"original"),
            &sha256(b"candidate"),
        )
        .unwrap();
        assert_eq!(
            inspect_prepared(&dir)
                .unwrap()
                .xattrs
                .get(name.to_str().unwrap())
                .unwrap(),
            b"before"
        );
        set(b"after");
        assert_eq!(
            observe_recovery(&dir, &lock).unwrap(),
            RecoveryObservation::Conflict
        );
        assert_eq!(fs::read(target).unwrap(), b"original");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn commit_metadata_policy_refuses_attributes_instead_of_dropping_them() {
        let temp = Scratch::new();
        let target = temp.0.join("board");
        fs::write(&target, b"original").unwrap();
        let file = open_regular(&target).unwrap();
        require_plain_commit_metadata(&file).unwrap();
        let name = CString::new("user.iot-lab-test").unwrap();
        let value = b"keep";
        let result = unsafe {
            libc::fsetxattr(
                file.as_raw_fd(),
                name.as_ptr(),
                value.as_ptr().cast(),
                value.len(),
                0,
            )
        };
        if result != 0 {
            panic!(
                "setting test attribute failed: {}",
                io::Error::last_os_error()
            );
        }
        assert!(require_plain_commit_metadata(&file).is_err());
        assert_eq!(fs::read(target).unwrap(), b"original");
    }

    #[test]
    fn staging_checks_digest_and_never_writes_the_target() {
        let temp = Scratch::new();
        let locks = temp.dir("locks");
        let journals = temp.dir("journals");
        let target = temp.0.join("board");
        fs::write(&target, b"original").unwrap();
        let lock = LockedTarget::acquire(&locks, &target).unwrap();
        let dir = prepare(
            &journals,
            "run",
            &lock,
            &sha256(b"original"),
            &sha256(b"candidate"),
        )
        .unwrap();
        assert!(stage_candidate(&dir, &lock, b"wrong").is_err());
        assert!(!dir.join("candidate.bin").exists());
        stage_candidate(&dir, &lock, b"candidate").unwrap();
        assert_eq!(
            inspect_staged(&dir).unwrap().candidate_sha256,
            sha256(b"candidate")
        );
        assert!(stage_candidate(&dir, &lock, b"candidate").is_err());
        assert_eq!(fs::read(&target).unwrap(), b"original");
        fs::remove_file(dir.join("staged.ok")).unwrap();
        assert!(inspect_staged(&dir).is_err());
        fs::write(dir.join("staged.ok"), b"bad").unwrap();
        assert!(inspect_staged(&dir).is_err());
        fs::write(dir.join("staged.ok"), STAGED_MARKER).unwrap();
        fs::write(dir.join("candidate.bin"), b"tampered").unwrap();
        assert!(inspect_staged(&dir).is_err());
    }

    #[test]
    fn staging_rejects_equal_bytes_and_changed_source() {
        let temp = Scratch::new();
        let locks = temp.dir("locks");
        let journals = temp.dir("journals");
        let target = temp.0.join("board");
        fs::write(&target, b"original").unwrap();
        let lock = LockedTarget::acquire(&locks, &target).unwrap();
        let same = prepare(
            &journals,
            "same",
            &lock,
            &sha256(b"original"),
            &sha256(b"original"),
        )
        .unwrap();
        assert!(stage_candidate(&same, &lock, b"original").is_err());
        let other = prepare(
            &journals,
            "other",
            &lock,
            &sha256(b"original"),
            &sha256(b"candidate"),
        )
        .unwrap();
        fs::write(&target, b"changed").unwrap();
        assert!(stage_candidate(&other, &lock, b"candidate").is_err());
        assert!(!other.join("candidate.bin").exists());
        assert_eq!(fs::read(&target).unwrap(), b"changed");
    }
}
