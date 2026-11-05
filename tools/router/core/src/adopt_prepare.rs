//! Private preparation primitive for a future adoption protocol.
//!
//! This module NEVER replaces, restores, or otherwise writes the target. A
//! prepared journal is not adoption authorization. Integration still needs
//! owned verification, alias coordination with older clients, xattr policy,
//! durable commit/receipt recovery and tests at every crash boundary.
use crate::sha256::sha256;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

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

/// Exclusive flock is retained on a file owned by this process until Drop.
/// Canonical directory aliases select the same path-derived lock. Hardlinks and
/// final symlinks are refused; existing noncooperating writers are not fenced.
pub struct LockedTarget {
    target: PathBuf,
    target_file: File,
    lock_file: File,
    key: String,
}

impl LockedTarget {
    pub fn acquire(lock_dir: &Path, target: &Path) -> io::Result<Self> {
        let lock_dir = private_dir(lock_dir)?;
        if fs::symlink_metadata(target)?.file_type().is_symlink() {
            return Err(invalid("target symlink is not supported"));
        }
        let canonical = fs::canonicalize(target)?;
        let target_file = open_regular(&canonical)?;
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
        })
    }

    pub fn canonical_target(&self) -> &Path {
        &self.target
    }
    pub fn lock_key(&self) -> &str {
        &self.key
    }

    /// Read through the admitted descriptor and reject detected changes or replacement.
    fn snapshot(&self) -> io::Result<(Vec<u8>, fs::Metadata)> {
        let before = self.target_file.metadata()?;
        let mut reader = self.target_file.try_clone()?;
        reader.seek(SeekFrom::Start(0))?;
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes)?;
        let after = self.target_file.metadata()?;
        let path = fs::symlink_metadata(&self.target)?;
        if !same_identity(&before, &after)
            || !same_identity(&after, &path)
            || bytes.len() as u64 != after.len()
        {
            return Err(invalid("target changed during snapshot"));
        }
        // Keep the lock live through every snapshot and journal operation.
        let _ = self.lock_file.metadata()?;
        Ok((bytes, after))
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

/// Create a durable original-byte backup and intent; never writes the target.
/// Incomplete directories remain as evidence and are never silently reused.
pub fn prepare(
    journal_root: &Path,
    id: &str,
    locked: &LockedTarget,
    candidate_sha256: &str,
) -> io::Result<PathBuf> {
    let root = private_dir(journal_root)?;
    if !valid_id(id) || !is_sha256(candidate_sha256) {
        return Err(invalid("invalid journal id or candidate digest"));
    }
    let (bytes, metadata) = locked.snapshot()?;
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
    };
    let dir = root.join(id);
    fs::DirBuilder::new().mode(0o700).create(&dir)?;
    File::open(&root)?.sync_all()?;
    create_synced(&dir.join("original.bin"), &bytes)?;
    let encoded = serde_json::to_vec(&intent).map_err(io::Error::other)?;
    create_synced(&dir.join("intent.json"), &encoded)?;
    File::open(&dir)?.sync_all()?;
    Ok(dir)
}

/// Validate the prepared evidence only; no recovery, rename or target writes.
pub fn inspect_prepared(path: &Path) -> io::Result<PreparedIntent> {
    let dir = private_dir(path)?;
    let mut intent_bytes = Vec::new();
    open_regular(&dir.join("intent.json"))?.read_to_end(&mut intent_bytes)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};
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
        let first = prepare(&journals, "run-1", &lock, &candidate).unwrap();
        let intent = inspect_prepared(&first).unwrap();
        assert_eq!(intent.original_sha256, sha256(b"original board"));
        assert_eq!(intent.candidate_sha256, candidate);
        assert_eq!(fs::read(&target).unwrap(), b"original board");
        assert_eq!(
            fs::read(first.join("original.bin")).unwrap(),
            b"original board"
        );
        assert!(prepare(&journals, "run-1", &lock, &candidate).is_err());
        let second = prepare(&journals, "run-2", &lock, &candidate).unwrap();
        assert_eq!(
            inspect_prepared(&second).unwrap().original_sha256,
            intent.original_sha256
        );
    }

    #[test]
    fn partial_or_tampered_journal_is_never_accepted() {
        let temp = Scratch::new();
        let locks = temp.dir("locks");
        let journals = temp.dir("journals");
        let target = temp.0.join("board");
        fs::write(&target, b"original").unwrap();
        let lock = LockedTarget::acquire(&locks, &target).unwrap();
        let dir = prepare(&journals, "run", &lock, &sha256(b"new")).unwrap();
        fs::write(dir.join("original.bin"), b"corrupt").unwrap();
        assert!(inspect_prepared(&dir).is_err());
        fs::remove_file(dir.join("intent.json")).unwrap();
        assert!(inspect_prepared(&dir).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"original");
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
        assert!(prepare(&journals, "run", &lock, &sha256(b"new")).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"changed");
    }
}
