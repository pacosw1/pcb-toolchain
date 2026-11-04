//! Hashes that bind a proposal to the exact native project it came from.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use super::board::{Board, form_value, uuid};
use crate::error::{Result, invalid};
use crate::pyjson::{fingerprint, sha256_hex};

/// The project files that travel with a board, the board itself first.
pub const PROJECT_EXTENSIONS: [&str; 4] = ["kicad_pcb", "kicad_pro", "kicad_dru", "kicad_sch"];

pub fn file_sha256(path: &Path) -> Result<String> {
    Ok(sha256_hex(&fs::read(path)?))
}

/// SHA-256 of the board and its three sidecars, by file name.
pub fn source_set(board: &Path) -> Result<Value> {
    let files: Vec<PathBuf> = PROJECT_EXTENSIONS.iter().map(|extension| board.with_extension(extension)).collect();
    if !files.iter().all(|file| file.is_file()) {
        return invalid("complete native project sidecars required");
    }
    let mut set = Map::new();
    for file in files {
        let name = file.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        set.insert(name, file_sha256(&file)?.into());
    }
    Ok(Value::Object(set))
}

/// Copy the sidecars of `board` next to `target`.
pub fn copy_sidecars(board: &Path, target: &Path) -> Result<()> {
    for extension in &PROJECT_EXTENSIONS[1..] {
        fs::copy(board.with_extension(extension), target.with_extension(extension))?;
    }
    Ok(())
}

/// Hash every form of the board except the routing items named in `omit`.
///
/// Only writer identity is ignored. Placements, pads, nets, rules, zones, drawings, copper and setup stay protected.
pub fn geometry_digest(board: &Board, omit: &BTreeSet<String>) -> Result<String> {
    let mut seen = BTreeSet::new();
    let mut hashes = Vec::new();
    for form in board.forms() {
        match uuid(form).filter(|id| omit.contains(*id)) {
            Some(id) => {
                let routing = form.is("segment") || form.is("arc") || form.is("via");
                if !routing || !seen.insert(id.to_string()) {
                    return invalid("only uniquely identified routing items may change");
                }
            }
            None if form.is("generator") || form.is("generator_version") => {}
            None => hashes.push(fingerprint(&form_value(form))?),
        }
    }
    if &seen != omit {
        return invalid("specified routing item absent from native board");
    }
    hashes.sort();
    fingerprint(&Value::Array(hashes.into_iter().map(Value::String).collect()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn board(text: &str) -> Board {
        Board::from_text(text.to_string()).unwrap()
    }

    fn omit(ids: &[&str]) -> BTreeSet<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    const BASE: &str = "(kicad_pcb (generator \"a\") (net 1 \"N\") (segment (start 0 0) (uuid \"s1\")))";

    #[test]
    fn writer_identity_is_ignored_and_everything_else_counts() {
        let digest = geometry_digest(&board(BASE), &omit(&[])).unwrap();
        let rewritten = BASE.replace("(generator \"a\")", "(generator \"b\")");
        assert_eq!(geometry_digest(&board(&rewritten), &omit(&[])).unwrap(), digest);
        let renamed = BASE.replace("\"N\"", "\"M\"");
        assert_ne!(geometry_digest(&board(&renamed), &omit(&[])).unwrap(), digest);
    }

    #[test]
    fn an_omitted_item_leaves_the_rest_comparable() {
        let extra = BASE.replace("(segment", "(via (uuid \"v1\")) (segment");
        let digest = geometry_digest(&board(BASE), &omit(&[])).unwrap();
        assert_eq!(geometry_digest(&board(&extra), &omit(&["v1"])).unwrap(), digest);
    }

    #[test]
    fn only_present_routing_items_may_be_omitted() {
        assert!(geometry_digest(&board(BASE), &omit(&["absent"])).is_err());
        let zone = "(kicad_pcb (zone (uuid \"z1\")))";
        assert!(geometry_digest(&board(zone), &omit(&["z1"])).is_err());
    }
}
