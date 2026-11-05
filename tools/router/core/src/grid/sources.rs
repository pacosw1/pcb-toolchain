//! The native files a grid result was made from, and the JSON its reports are written in.
use crate::sha256::sha256;
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

/// File name to sha256 of a board's four native files; None unless all four exist.
pub type BoundSources = Option<BTreeMap<String, String>>;

pub fn bound_sources(board: &Path) -> Result<BoundSources, String> {
    let paths = ["kicad_pcb", "kicad_pro", "kicad_dru", "kicad_sch"].map(|e| board.with_extension(e));
    if !paths.iter().all(|p| p.is_file()) {
        return Ok(None);
    }
    let mut out = BTreeMap::new();
    for path in paths {
        let bytes = fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        out.insert(path.file_name().unwrap_or_default().to_string_lossy().to_string(), sha256(&bytes));
    }
    Ok(Some(out))
}

/// A report as JSON at one space of indent, as the Python tools wrote it.
pub fn write_json<T: Serialize>(value: &T, path: &Path) -> Result<(), String> {
    let mut out = Vec::new();
    let mut writer = serde_json::Serializer::with_formatter(&mut out, serde_json::ser::PrettyFormatter::with_indent(b" "));
    value.serialize(&mut writer).map_err(|e| e.to_string())?;
    fs::write(path, out).map_err(|e| format!("{}: {e}", path.display()))
}
