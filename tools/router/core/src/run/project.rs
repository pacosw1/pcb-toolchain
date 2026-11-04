//! A board's project on disk: which folder and project a board ID names, and the files that go with a board copy.
use crate::sha256::sha256;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

const SIDECARS: [&str; 3] = ["kicad_pro", "kicad_dru", "kicad_sch"];
const TABLES: [&str; 2] = ["sym-lib-table", "fp-lib-table"];

pub fn sha_file(path: &Path) -> Result<String, String> {
    fs::read(path).map(|b| sha256(&b)).map_err(|e| format!("{}: {e}", path.display()))
}

#[derive(Deserialize)]
struct GateProject {
    project: String,
}

/// The gate file of a board folder.
pub fn gate_path(board_dir: &Path) -> Option<PathBuf> {
    ["gate.json", "gate.pending.json"].iter().map(|n| board_dir.join(n)).find(|p| p.is_file())
}

/// A board ID or board folder -> (board folder, project path without extension).
pub fn board_project(board: &str, root: &Path) -> Result<(PathBuf, PathBuf), String> {
    let given = Path::new(board);
    let folder = if given.is_dir() { given.to_path_buf() } else { root.join("hardware-design/boards").join(board) };
    let folder = std::path::absolute(&folder).map_err(|e| e.to_string())?;
    let gate = gate_path(&folder).ok_or_else(|| format!("no gate.json / gate.pending.json in {}", folder.display()))?;
    let text = fs::read_to_string(&gate).map_err(|e| format!("{}: {e}", gate.display()))?;
    let parsed: GateProject = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", gate.display()))?;
    Ok((folder.clone(), folder.join(parsed.project)))
}

fn file_names(dir: &Path) -> Result<Vec<String>, String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let mut names: Vec<String> = entries.filter_map(|e| e.ok()?.file_name().into_string().ok()).collect();
    names.sort();
    Ok(names)
}

/// The project name next to a board: the board's own, else the only one.
fn project_name(pcb: &Path, names: &[String]) -> Result<String, String> {
    let projects: Vec<&str> = names.iter().filter_map(|n| n.strip_suffix(".kicad_pro")).collect();
    let stem = pcb.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    match projects[..] {
        _ if projects.contains(&stem) => Ok(stem.to_string()),
        [only] => Ok(only.to_string()),
        _ => Err(format!("no unique .kicad_pro next to {}", pcb.display())),
    }
}

/// The name of the project a board copy belongs to, which names what `iotroute write` writes.
pub fn project_of(pcb: &Path) -> Result<String, String> {
    project_name(pcb, &file_names(pcb.parent().unwrap_or(Path::new(".")))?)
}

/// The files next to a board: a `.ext` key for a project file, else its path relative to the board folder. The .kicad_pro is
/// required. Sub-sheets come along, or the parity check of a copy reads a partial netlist: those beside the root sheet
/// (BASE-PWR-C) and every sheet the root names, in a subfolder too (INPUT-4D2A, RELAY-4).
pub fn project_files(pcb: &Path) -> Result<BTreeMap<String, PathBuf>, String> {
    let pcb = std::path::absolute(pcb).map_err(|e| e.to_string())?;
    let dir = pcb.parent().ok_or("a board file has a folder")?;
    let names = file_names(dir)?;
    let project = project_name(&pcb, &names)?;
    let mut out = BTreeMap::new();
    for extension in SIDECARS {
        let path = dir.join(format!("{project}.{extension}"));
        if path.is_file() {
            out.insert(format!(".{extension}"), path);
        }
    }
    for name in TABLES.iter().map(|t| t.to_string()).chain(names.iter().filter(|n| n.ends_with(".kicad_sch") && **n != format!("{project}.kicad_sch")).cloned()) {
        if dir.join(&name).is_file() {
            out.insert(name.clone(), dir.join(&name));
        }
    }
    for relative in referenced_sheets(&dir.join(format!("{project}.kicad_sch")), dir) {
        let path = dir.join(&relative);
        out.entry(relative).or_insert(path);
    }
    Ok(out)
}

/// `(property "Sheetfile" "name")` of a schematic text.
fn sheet_names(text: &str) -> Vec<String> {
    let mut names = Vec::new();
    for (at, _) in text.match_indices("(property") {
        let rest = text[at + "(property".len()..].trim_start();
        if let Some(rest) = rest.strip_prefix("\"Sheetfile\"")
            && let Some(rest) = rest.trim_start().strip_prefix('"')
            && let Some(end) = rest.find('"')
        {
            names.push(rest[..end].to_string());
        }
    }
    names
}

/// A path with `.` and `..` worked out, with no look at the disk.
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// Relative paths of the sheets a root sheet names, recursively. A path counts relative to the sheet that names it, else to
/// `base`; a missing file, or one outside `base`, is skipped.
pub fn referenced_sheets(root: &Path, base: &Path) -> Vec<String> {
    let base = lexical(base);
    let (mut found, mut todo, mut seen): (Vec<String>, Vec<PathBuf>, Vec<PathBuf>) = (Vec::new(), vec![root.to_path_buf()], Vec::new());
    while let Some(current) = todo.pop() {
        if seen.contains(&current) || !current.is_file() {
            continue;
        }
        seen.push(current.clone());
        let text = String::from_utf8_lossy(&fs::read(&current).unwrap_or_default()).into_owned();
        for name in sheet_names(&text) {
            let starts = [current.parent().unwrap_or(&base).to_path_buf(), base.clone()];
            let hit = starts.iter().map(|s| lexical(&s.join(&name))).find(|p| p.is_file() && p.starts_with(&base));
            if let Some(path) = hit {
                let relative = path.strip_prefix(&base).expect("inside base").to_string_lossy().replace('\\', "/");
                if !found.contains(&relative) {
                    found.push(relative);
                }
                todo.push(path);
            }
        }
    }
    found.sort();
    found
}

fn target(key: &str, out_pcb: &Path) -> PathBuf {
    match key.strip_prefix('.') {
        Some(extension) => out_pcb.with_extension(extension),
        None => out_pcb.parent().unwrap_or(Path::new(".")).join(key),
    }
}

/// Copies the project files of a board next to `out_pcb`, named after it. An existing different file stops.
pub fn place_sidecars(src_pcb: &Path, out_pcb: &Path) -> Result<(), String> {
    let out_pcb = std::path::absolute(out_pcb).map_err(|e| e.to_string())?;
    for (key, source) in project_files(src_pcb)? {
        let dest = target(&key, &out_pcb);
        if dest.exists() {
            if sha_file(&dest)? != sha_file(&source)? {
                return Err(format!("{} exists and differs from {}", dest.display(), source.display()));
            }
            continue;
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        fs::copy(&source, &dest).map_err(|e| format!("{}: {e}", source.display()))?;
    }
    Ok(())
}

/// A save rewrites the .kicad_pro with defaults: puts the input's bytes back. True when it differed.
pub fn restore_pro(src_pcb: &Path, out_pcb: &Path) -> Result<bool, String> {
    let files = project_files(src_pcb)?;
    let source = files.get(".kicad_pro").ok_or_else(|| format!("no .kicad_pro next to {}", src_pcb.display()))?;
    let dest = std::path::absolute(out_pcb).map_err(|e| e.to_string())?.with_extension("kicad_pro");
    if dest.exists() && sha_file(&dest)? == sha_file(source)? {
        return Ok(false);
    }
    fs::copy(source, &dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Folder(PathBuf);

    impl Folder {
        fn new(name: &str) -> Folder {
            let path = std::env::temp_dir().join(format!("iotroute-project-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Folder(path)
        }

        fn write(&self, name: &str, text: &str) -> PathBuf {
            let path = self.0.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, text).unwrap();
            path
        }
    }

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_board_id_names_a_folder_under_the_root() {
        let f = Folder::new("id");
        f.write("hardware-design/boards/DEMO/gate.json", r#"{"project": "cad/DEMO/DEMO"}"#);
        let (folder, project) = board_project("DEMO", &f.0).unwrap();
        assert!(folder.ends_with("boards/DEMO"));
        assert!(project.ends_with("cad/DEMO/DEMO"));
        assert!(board_project("NONE", &f.0).unwrap_err().contains("no gate.json"));
    }

    #[test]
    fn the_project_is_the_boards_own_else_the_only_one() {
        let f = Folder::new("name");
        let b = f.write("B.kicad_pcb", "");
        f.write("B.kicad_pro", "");
        f.write("A.kicad_pro", "");
        assert_eq!(project_of(&b).unwrap(), "B");
        let g = Folder::new("only");
        let copy = g.write("X.kicad_pcb", "");
        g.write("A.kicad_pro", "");
        assert_eq!(project_of(&copy).unwrap(), "A");
        let h = Folder::new("two");
        let none = h.write("X.kicad_pcb", "");
        h.write("A.kicad_pro", "");
        h.write("B.kicad_pro", "");
        assert!(project_of(&none).is_err());
    }

    #[test]
    fn sub_sheets_come_with_their_path_and_tables_by_name() {
        let f = Folder::new("sheets");
        let b = f.write("B.kicad_pcb", "");
        f.write("B.kicad_pro", "pro");
        f.write("B.kicad_dru", "");
        f.write("B.kicad_sch", r#"(sheet (property "Sheetfile" "blocks/X.kicad_sch"))"#);
        f.write("sub.kicad_sch", "");
        f.write("blocks/X.kicad_sch", r#"(sheet (property "Sheetfile" "deep/Y.kicad_sch"))"#);
        f.write("blocks/deep/Y.kicad_sch", "y");
        f.write("fp-lib-table", "");
        let files = project_files(&b).unwrap();
        let keys: Vec<&str> = files.keys().map(String::as_str).collect();
        assert_eq!(keys, [".kicad_dru", ".kicad_pro", ".kicad_sch", "blocks/X.kicad_sch", "blocks/deep/Y.kicad_sch", "fp-lib-table", "sub.kicad_sch"]);
    }

    #[test]
    fn a_sheet_no_one_names_stays_behind_but_sheets_beside_the_root_come() {
        let f = Folder::new("unused");
        let b = f.write("in/B.kicad_pcb", "");
        f.write("in/B.kicad_pro", "pro");
        f.write("in/ETH.kicad_sch", "");
        f.write("in/blocks/unused.kicad_sch", "");
        let keys: Vec<String> = project_files(&b).unwrap().into_keys().collect();
        assert_eq!(keys, [".kicad_pro", "ETH.kicad_sch"]);
    }

    #[test]
    fn a_sheet_outside_the_folder_stays_out() {
        let f = Folder::new("outside");
        f.write("in/B.kicad_sch", r#"(property "Sheetfile" "../other.kicad_sch")"#);
        f.write("other.kicad_sch", "");
        assert!(referenced_sheets(&f.0.join("in/B.kicad_sch"), &f.0.join("in")).is_empty());
    }

    #[test]
    fn sidecars_take_the_name_of_the_copy_and_a_different_file_stops() {
        let f = Folder::new("place");
        let b = f.write("in/B.kicad_pcb", "");
        f.write("in/B.kicad_pro", "pro");
        f.write("in/B.kicad_sch", r#"(property "Sheetfile" "blocks/deep/Y.kicad_sch")"#);
        f.write("in/blocks/deep/Y.kicad_sch", "y");
        let out = f.0.join("out/R.kicad_pcb");
        fs::create_dir_all(out.parent().unwrap()).unwrap();
        place_sidecars(&b, &out).unwrap();
        assert_eq!(fs::read_to_string(out.with_extension("kicad_pro")).unwrap(), "pro");
        assert_eq!(fs::read_to_string(out.parent().unwrap().join("blocks/deep/Y.kicad_sch")).unwrap(), "y");
        fs::write(out.with_extension("kicad_pro"), "other").unwrap();
        assert!(place_sidecars(&b, &out).unwrap_err().contains("differs"));
    }

    #[test]
    fn a_rewritten_project_goes_back() {
        let f = Folder::new("restore");
        let b = f.write("in/B.kicad_pcb", "");
        f.write("in/B.kicad_pro", "keep");
        let out = f.write("out/R.kicad_pcb", "");
        f.write("out/R.kicad_pro", "rewritten");
        assert!(restore_pro(&b, &out).unwrap());
        assert_eq!(fs::read_to_string(out.with_extension("kicad_pro")).unwrap(), "keep");
        assert!(!restore_pro(&b, &out).unwrap());
    }
}
