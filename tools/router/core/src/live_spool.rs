//! Job-local observation transport. No network, credentials, or search decisions.
use crate::{kicad::sexpr, sha256::sha256};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub struct Spool {
    pub base: PathBuf,
    pub raw: PathBuf,
    pub preview: PathBuf,
    pub board_sha: String,
    pub model_sha: String,
    pub id: String,
    pub source: String,
    result: PathBuf,
    done: PathBuf,
    operation: String,
}
/// The file appears under its final name whole or not at all, and never replaces a file or link already there.
/// The reader polls this folder: a half-written manifest or done record must not be visible, and a crash must not
/// leave one behind. The bytes go to `<name>.tmp`, which no reader pattern matches, then a rename makes the name.
/// A rename, not a hard link: the reader refuses a file with more than one link.
fn create(path: &Path, bytes: &[u8]) -> Result<(), String> {
    create_with(path, bytes, |f, b| f.write_all(b))
}
fn create_with(
    path: &Path,
    bytes: &[u8],
    write: impl FnOnce(&mut fs::File, &[u8]) -> std::io::Result<()>,
) -> Result<(), String> {
    // Not atomic against another writer, and none exists: the name holds a random id and this process owns it.
    if path.symlink_metadata().is_ok() {
        return Err(format!("{} exists", path.display()));
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|e| e.to_string())?;
    let done = write(&mut f, bytes)
        .and_then(|_| f.sync_all())
        .and_then(|_| fs::rename(&tmp, path));
    if done.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    done.map_err(|e| e.to_string())
}
impl Spool {
    pub fn from_environment(
        model: &Path,
        bytes: &[u8],
        operation: &str,
        result: PathBuf,
    ) -> Option<Self> {
        Self::prepare(model, bytes, operation, result).ok()
    }
    fn prepare(
        _model: &Path,
        bytes: &[u8],
        operation: &str,
        result: PathBuf,
    ) -> Result<Self, String> {
        let root = PathBuf::from(std::env::var("PCB_LIVE_DIR").map_err(|e| e.to_string())?)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        if std::env::var("PCB_LIVE").is_ok_and(|v| v == "0") {
            return Err("observation disabled".into());
        }
        let model: Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
        let source = model[if operation == "placement" {
            "board_file"
        } else {
            "pcb"
        }]
        .as_str()
        .ok_or("model has no source board")?
        .to_owned();
        let model_sha = sha256(bytes);
        let board = if Path::new(&source).is_file() {
            PathBuf::from(&source)
        } else {
            let map: Value = serde_json::from_slice(
                &fs::read(".pcb-live-sources.json").map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            let row = &map[&model_sha];
            if row["source"] != source {
                return Err("source map mismatch".into());
            }
            let rel = row["file"].as_str().ok_or("source map missing")?;
            if !rel.starts_with("in/pcb-live-")
                || rel.contains("..")
                || Path::new(rel).is_absolute()
            {
                return Err("invalid source map".into());
            }
            let b = fs::read(rel).map_err(|e| e.to_string())?;
            if row["sha256"] != sha256(&b) {
                return Err("mapped board digest mismatch".into());
            }
            PathBuf::from(rel)
        };
        if fs::metadata(&board).map_err(|e| e.to_string())?.len() > 128 * 1024 * 1024 {
            return Err("board exceeds limit".into());
        }
        let content = fs::read(&board).map_err(|e| e.to_string())?;
        let board_sha = sha256(&content);
        let tree = sexpr::parse(std::str::from_utf8(&content).map_err(|e| e.to_string())?)?;
        let board_tree = tree
            .iter()
            .find(|n| n.is("kicad_pcb"))
            .ok_or("not a board")?;
        let mut footprints = vec![];
        for fp in board_tree.children("footprint") {
            let reference = fp
                .children("property")
                .find(|p| p.text(1) == Some("Reference"))
                .and_then(|p| p.text(2))
                .or_else(|| {
                    fp.children("fp_text")
                        .find(|p| p.text(1) == Some("reference"))
                        .and_then(|p| p.text(2))
                })
                .unwrap_or("");
            let at = fp.child("at").ok_or("footprint position missing")?;
            let num = |i| {
                at.text(i)
                    .unwrap_or("0")
                    .parse::<f64>()
                    .map_err(|e| e.to_string())
            };
            footprints.push(json!({"ref":reference,"x":num(1)?,"y":num(2)?,"rotation":num(3)?,"locked":fp.flag("locked")}));
        }
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let id = sha256(format!("{}:{nonce}:{model_sha}", std::process::id()).as_bytes())[..24]
            .to_string();
        let stem = format!("pcb-live-{id}");
        let base = root.join(format!("{stem}.kicad_pcb"));
        let raw = root.join(format!("{stem}.ndjson"));
        let done = root.join(format!("{stem}.done.json"));
        let preview = root.join(format!("{stem}.preview.json"));
        create(&base, &content)?;
        let manifest = json!({"schema":"pcb-job-live.v1","id":id,"operation":operation,"source":source,"baseSha256":board_sha,"modelSha256":model_sha,"startedMs":now_ms(),"footprints":footprints});
        let payload = serde_json::to_vec(&manifest).map_err(|e| e.to_string())?;
        if payload.len() > 4 * 1024 * 1024 {
            return Err("manifest exceeds limit".into());
        }
        create(&root.join(format!("{stem}.manifest.json")), &payload)?;
        Ok(Self {
            base,
            raw,
            preview,
            board_sha,
            model_sha,
            id,
            source,
            result,
            done,
            operation: operation.to_owned(),
        })
    }
}
impl Drop for Spool {
    fn drop(&mut self) {
        let outcome = fs::metadata(&self.result)
            .ok()
            .filter(|m| m.len() <= 16 * 1024 * 1024)
            .and_then(|_| fs::read(&self.result).ok())
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .map(|v| {
                let ok = if self.operation == "routing" {
                    v["failed"].as_array().is_some_and(|v| v.is_empty())
                } else {
                    v["candidates"][0]["illegal"]
                        .as_array()
                        .is_some_and(|v| v.is_empty())
                };
                if ok { "passed" } else { "failed" }
            })
            .unwrap_or("failed");
        let _=create(&self.done,json!({"timeMs":now_ms(),"outcome":outcome,"message":"Native search ended; candidate is not independently verified"}).to_string().as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("live-spool-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_failed_write_leaves_nothing_under_the_final_name_or_the_temp_name() {
        let d = folder("fail");
        let p = d.join("pcb-live-x.done.json");
        let r = create_with(&p, b"{\"a\":1}", |f, b| {
            f.write_all(&b[..3])?;
            Err(std::io::Error::other("disk full"))
        });
        assert!(r.is_err());
        assert_eq!(fs::read_dir(&d).unwrap().count(), 0);
    }

    #[test]
    fn a_good_write_appears_whole_and_leaves_no_temp_file() {
        let d = folder("good");
        let p = d.join("pcb-live-x.manifest.json");
        create(&p, b"{\"a\":1}").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"{\"a\":1}");
        assert_eq!(fs::read_dir(&d).unwrap().count(), 1);
    }

    #[test]
    fn an_existing_file_is_never_replaced() {
        let d = folder("exists");
        let p = d.join("pcb-live-x.done.json");
        create(&p, b"first").unwrap();
        assert!(create(&p, b"second").is_err());
        assert_eq!(fs::read(&p).unwrap(), b"first");
        assert_eq!(fs::read_dir(&d).unwrap().count(), 1);
    }
}
