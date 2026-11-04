//! Board text to a saved board: the project copied into a folder, the text written there, one KiCad 10 `kicad-cli pcb drc
//! --refill-zones --save-board` puts the items in their place and refills every zone. Never the nightly build: a board it saves
//! may not load in KiCad 10.
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const MAC_KICAD_CLI: &str = "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli";

/// Env KICAD_CLI names the binary.
pub fn kicad_cli() -> String {
    std::env::var("KICAD_CLI").unwrap_or_else(|_| if Path::new(MAC_KICAD_CLI).exists() { MAC_KICAD_CLI.to_string() } else { "kicad-cli".to_string() })
}

/// A folder for one run, deleted when dropped.
pub struct WorkDir(pub PathBuf);

impl WorkDir {
    /// Beside `near`, so the result moves into place with a rename.
    pub fn beside(near: &Path, tag: &str) -> Result<WorkDir, String> {
        let name = near.file_name().and_then(|n| n.to_str()).unwrap_or("board");
        let path = near.with_file_name(format!(".{name}.{tag}-{}", std::process::id()));
        fs::create_dir_all(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(WorkDir(path))
    }
}

impl Drop for WorkDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// What the save found.
pub struct Saved {
    /// `<folder>/<name>.kicad_pcb`
    pub path: PathBuf,
    pub report: Value,
}

fn folder_of(pcb: &Path) -> &Path {
    pcb.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."))
}

fn copy_project(pcb: &Path, stem: &str, folder: &Path) -> Result<(), String> {
    let src = folder_of(pcb);
    for extension in ["kicad_pro", "kicad_dru", "kicad_sch"] {
        let from = pcb.with_extension(extension);
        if from.exists() {
            fs::copy(&from, folder.join(format!("{stem}.{extension}"))).map_err(|e| format!("{}: {e}", from.display()))?;
        }
    }
    for table in ["sym-lib-table", "fp-lib-table"] {
        if src.join(table).exists() {
            fs::copy(src.join(table), folder.join(table)).map_err(|e| format!("{table}: {e}"))?;
        }
    }
    Ok(())
}

/// `text` as `<folder>/<stem of pcb>.kicad_pcb`, saved by KiCad 10 with fresh fills. The project next to `pcb` is copied first; a
/// save can rewrite .kicad_pro with defaults, so the original goes back after it. Parity runs when there is a schematic. Findings
/// are not a failure: they are in the report, for the caller.
pub fn save_refilled(pcb: &Path, text: &str, folder: &Path) -> Result<Saved, String> {
    let stem = pcb.file_stem().and_then(|s| s.to_str()).ok_or("a board file has a name")?;
    copy_project(pcb, stem, folder)?;
    let path = folder.join(format!("{stem}.kicad_pcb"));
    fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))?;
    let written = fs::metadata(&path).and_then(|m| m.modified()).ok();
    let report_path = folder.join("save-drc.json");
    let _ = fs::remove_file(&report_path);
    let cli = kicad_cli();
    let mut command = Command::new(&cli);
    command.args(["pcb", "drc", "--refill-zones", "--save-board", "--format", "json", "--units", "mm", "--severity-error"]);
    if pcb.with_extension("kicad_sch").exists() {
        command.arg("--schematic-parity");
    }
    let run = command.arg("--output").arg(&report_path).arg(&path).stdin(Stdio::null()).output().map_err(|e| format!("{cli}: {e}"))?;
    let pro = pcb.with_extension("kicad_pro");
    if pro.exists() {
        fs::copy(&pro, folder.join(format!("{stem}.kicad_pro"))).map_err(|e| format!("restoring .kicad_pro: {e}"))?;
    }
    let tail = || String::from_utf8_lossy(&run.stderr).trim().to_string();
    let raw = fs::read(&report_path).map_err(|e| format!("{cli} wrote no report (exit {:?}): {e}: {}", run.status.code(), tail()))?;
    if fs::metadata(&path).and_then(|m| m.modified()).ok() == written {
        return Err(format!("{cli} did not save the board (exit {:?}): {}", run.status.code(), tail()));
    }
    let report = serde_json::from_slice(&raw).map_err(|e| format!("{}: {e}", report_path.display()))?;
    Ok(Saved { path, report })
}

/// Moves a saved board over `out`; across file systems a copy does it.
pub fn put_in_place(saved: &Path, out: &Path) -> Result<(), String> {
    fs::rename(saved, out).or_else(|_| fs::copy(saved, out).map(|_| ())).map_err(|e| format!("{}: {e}", out.display()))
}
