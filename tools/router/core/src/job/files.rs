//! The job's files: JSON written atomically, JSON lines read while they grow, digests, the wall clock of its records.
use crate::sha256::sha256;
use serde::Serialize;
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// The value as indented JSON with a final newline, by a rename in the same folder: a reader never sees half a file.
pub fn atomic_json(path: impl AsRef<Path>, value: &impl Serialize) -> Result<(), String> {
    let path = path.as_ref();
    let text = serde_json::to_string_pretty(value).map_err(|e| format!("{}: {e}", path.display()))? + "\n";
    atomic_write(path, text.as_bytes())
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let fail = |e: std::io::Error| format!("{}: {e}", path.display());
    let folder = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    fs::create_dir_all(folder).map_err(fail)?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let temporary = folder.join(format!(".{name}.{}.tmp", std::process::id()));
    fs::write(&temporary, bytes).map_err(fail)?;
    fs::rename(&temporary, path).map_err(fail)
}

/// SHA-256 of a file, as hex.
pub fn digest(path: impl AsRef<Path>) -> Result<String, String> {
    let path = path.as_ref();
    fs::read(path).map(|bytes| sha256(&bytes)).map_err(|e| format!("{}: {e}", path.display()))
}

/// The digest of a file that may not be there.
pub fn digest_if_file(path: impl AsRef<Path>) -> Option<String> {
    let path = path.as_ref();
    path.is_file().then(|| digest(path).ok()).flatten()
}

/// One line at the end of a file, created when missing.
pub fn append_line(path: impl AsRef<Path>, line: &str) -> Result<(), String> {
    let path = path.as_ref();
    let fail = |e: std::io::Error| format!("{}: {e}", path.display());
    let mut file = OpenOptions::new().create(true).append(true).open(path).map_err(fail)?;
    file.write_all(format!("{line}\n").as_bytes()).map_err(fail)
}

/// The rows of a JSONL file; none when it does not exist. An unparsable last line is an append in progress; before it, corruption.
pub fn read_jsonl(path: impl AsRef<Path>) -> Result<Vec<Value>, String> {
    let path = path.as_ref();
    let Ok(bytes) = fs::read(path) else { return Ok(Vec::new()) };
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = text.split('\n').filter(|line| !line.trim().is_empty()).collect();
    let mut rows = Vec::with_capacity(lines.len());
    for (number, line) in lines.iter().enumerate() {
        match serde_json::from_str(line) {
            Ok(row) => rows.push(row),
            Err(_) if number + 1 == lines.len() => break,
            Err(error) => return Err(format!("{}: line {} is not JSON: {error}", path.display(), number + 1)),
        }
    }
    Ok(rows)
}

/// A JSON file, None when it is missing or broken.
pub fn load_json(path: impl AsRef<Path>) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

pub fn read_lossy(path: impl AsRef<Path>) -> Option<String> {
    fs::read(path).ok().map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// Seconds since the epoch.
pub fn unix_time() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |elapsed| elapsed.as_secs_f64())
}

/// A value rounded to `places` decimals, as Python's round for the numbers the job records.
pub fn rounded(value: f64, places: i32) -> f64 {
    let scale = 10f64.powi(places);
    (value * scale).round() / scale
}

/// Local time to the second, no zone: datetime.now().isoformat(timespec='seconds').
pub fn iso_now() -> String {
    let seconds = unix_time() as libc::time_t;
    let mut local: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&seconds, &mut local) };
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}", local.tm_year + 1900, local.tm_mon + 1, local.tm_mday, local.tm_hour, local.tm_min, local.tm_sec)
}

/// `name` with its extension replaced.
pub fn with_suffix(path: &Path, extension: &str) -> PathBuf {
    path.with_extension(extension.trim_start_matches('.'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn folder(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("job-files-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn a_half_written_last_line_is_skipped_and_an_earlier_one_is_not() {
        let dir = folder("jsonl");
        let path = dir.join("rows.jsonl");
        fs::write(&path, "{\"a\":1}\n{\"a\":").unwrap();
        assert_eq!(read_jsonl(&path).unwrap(), vec![json!({"a": 1})]);
        fs::write(&path, "{\"a\":\n{\"a\":1}\n").unwrap();
        assert!(read_jsonl(&path).unwrap_err().contains("line 1"));
        assert!(read_jsonl(dir.join("none")).unwrap().is_empty());
    }

    #[test]
    fn atomic_json_is_indented_and_ends_with_a_newline() {
        let dir = folder("atomic");
        let path = dir.join("deep/value.json");
        atomic_json(&path, &json!({"a": [1]})).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\n  \"a\": [\n    1\n  ]\n}\n");
    }

    #[test]
    fn iso_time_has_the_python_shape() {
        let text = iso_now();
        assert_eq!((text.len(), &text[10..11], &text[13..14]), (19, "T", ":"));
    }
}
