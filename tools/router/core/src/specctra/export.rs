//! A DSN from a board file, by the KiCad API's Specctra job: what pcbnew.ExportSpecctraDSN wrote, with no board saved.
//!
//! The export takes the board from a file, so locks go in as text on a throwaway copy: a locked item goes out as a `fix` wire or via.
use crate::kicad::api::proto::kiapi::board::jobs::RunBoardJobExportSpecctraDsn;
use crate::kicad::api::proto::kiapi::common::types::{JobStatus, RunJobResponse, RunJobSettings};
use crate::kicad::api::{Client, Server, read_board};
use crate::kicad::board::Board;
use crate::kicad::raw::{self, Form};
use crate::kicad::save::WorkDir;
use crate::specctra::kicad10::{Unchained, kicad10_form, zone_starts};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

fn is_copper(form: &Form) -> bool {
    form.is("segment") || form.is("via") || form.is("arc")
}

/// The text of a copper item with `(locked ...)` set as wanted. KiCad writes it before the net, or before the uuid on a net-less item.
fn set_lock(form: &Form, text: &str, locked: bool, out: &mut String, at: &mut usize) -> Result<(), String> {
    match form.children("locked").next() {
        Some(flag) if !locked => {
            let start = text[..flag.span.start].rfind('\n').map_or(flag.span.start, |line| line + 1);
            let end = text[flag.span.end..].find('\n').map_or(flag.span.end, |line| flag.span.end + line + 1);
            out.push_str(&text[*at..start]);
            *at = end;
        }
        Some(flag) => {
            out.push_str(&text[*at..flag.span.start]);
            out.push_str("(locked yes)");
            *at = flag.span.end;
        }
        None if locked => {
            let next = form.children("net").next().or_else(|| form.children("uuid").next()).ok_or("a copper item has no uuid")?;
            let line = text[..next.span.start].rfind('\n').map_or(next.span.start, |newline| newline + 1);
            out.push_str(&text[*at..line]);
            out.push_str("\t\t(locked yes)\n");
            *at = line;
        }
        None => {}
    }
    Ok(())
}

/// The board text with exactly `locked` of its tracks, arcs and vias locked, by uuid.
pub fn with_locks(text: &str, locked: &BTreeSet<String>) -> Result<String, String> {
    let root = raw::parse_first(text).map_err(|error| format!("board text: {error}"))?;
    let (mut out, mut at) = (String::with_capacity(text.len()), 0);
    for form in root.items().iter().filter(|form| is_copper(form)) {
        let id = form.children("uuid").next().and_then(|uuid| uuid.text(1)).ok_or("a copper item has no uuid")?;
        set_lock(form, text, locked.contains(id), &mut out, &mut at)?;
    }
    out.push_str(&text[at..]);
    Ok(out)
}

/// Runs the DSN export on the board this client has open.
pub fn export(client: &mut Client, dsn: &Path) -> Result<(), String> {
    let document = client.board_document().map_err(|e| e.to_string())?;
    let job_settings = Some(RunJobSettings { document: Some(document), output_path: dsn.display().to_string() });
    let reply: RunJobResponse = client.call(&RunBoardJobExportSpecctraDsn { job_settings }).map_err(|e| e.to_string())?;
    if reply.status() != JobStatus::JsSuccess || !dsn.is_file() {
        return Err(format!("DSN export failed: {:?} {}", reply.status(), reply.message));
    }
    Ok(())
}

/// A folder for the throwaway board of one export, with the project beside it: net classes and rules come from there.
pub struct Throwaway {
    work: WorkDir,
    board: PathBuf,
}

impl Throwaway {
    /// `project` is the board whose .kicad_pro and .kicad_dru go along.
    pub fn new(project: &Path, near: &Path) -> Result<Throwaway, String> {
        let work = WorkDir::beside(near, "export")?;
        let stem = project.file_stem().and_then(|stem| stem.to_str()).ok_or("a board file has a name")?;
        for extension in ["kicad_pro", "kicad_dru"] {
            let from = project.with_extension(extension);
            if from.is_file() {
                fs::copy(&from, work.0.join(format!("{stem}.{extension}"))).map_err(|e| format!("{}: {e}", from.display()))?;
            }
        }
        let board = work.0.join(format!("{stem}.kicad_pcb"));
        Ok(Throwaway { work, board })
    }

    pub fn folder(&self) -> &Path {
        &self.work.0
    }

    /// Writes `text` here and reads it back as the API sees it, with the DSN of it in `dsn`, in KiCad 10's form, when one is asked for.
    /// `own`: the copper the job imported, which stays one wire per track.
    pub fn read(&self, text: &str, dsn: Option<&Path>, own: &[Unchained]) -> Result<Board, String> {
        fs::write(&self.board, text).map_err(|e| format!("{}: {e}", self.board.display()))?;
        let (_server, mut client) = Server::start(&self.board)?;
        if let Some(dsn) = dsn {
            export(&mut client, dsn)?;
            let exported = fs::read_to_string(dsn).map_err(|e| format!("{}: {e}", dsn.display()))?;
            let form = kicad10_form(&exported, &zone_starts(text)?, own)?;
            fs::write(dsn, form).map_err(|e| format!("{}: {e}", dsn.display()))?;
        }
        read_board(&mut client, &self.board).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOARD: &str = "(kicad_pcb\n\t(segment\n\t\t(start 0 0)\n\t\t(end 1 0)\n\t\t(width 0.2)\n\t\t(layer \"F.Cu\")\n\t\t(net \"A\")\n\t\t(uuid \"a\")\n\t)\n\t(segment\n\t\t(start 0 0)\n\t\t(end 1 0)\n\t\t(width 0.2)\n\t\t(layer \"F.Cu\")\n\t\t(locked yes)\n\t\t(net \"B\")\n\t\t(uuid \"b\")\n\t)\n\t(via\n\t\t(at 1 0)\n\t\t(size 0.6)\n\t\t(drill 0.3)\n\t\t(layers \"F.Cu\" \"B.Cu\")\n\t\t(uuid \"c\")\n\t)\n)\n";

    fn ids(names: &[&str]) -> BTreeSet<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    #[test]
    fn a_lock_is_added_before_the_net_or_the_uuid() {
        let text = with_locks(BOARD, &ids(&["a", "b", "c"])).unwrap();
        assert!(text.contains("(layer \"F.Cu\")\n\t\t(locked yes)\n\t\t(net \"A\")"), "{text}");
        assert!(text.contains("(layers \"F.Cu\" \"B.Cu\")\n\t\t(locked yes)\n\t\t(uuid \"c\")"), "{text}");
        assert_eq!(text.matches("(locked yes)").count(), 3);
    }

    #[test]
    fn a_lock_not_wanted_goes_with_its_line() {
        let text = with_locks(BOARD, &ids(&[])).unwrap();
        assert!(!text.contains("locked"));
        assert!(text.contains("(layer \"F.Cu\")\n\t\t(net \"B\")"), "{text}");
        assert!(raw::parse_first(&text).is_ok());
    }

    #[test]
    fn the_same_locks_change_nothing() {
        assert_eq!(with_locks(BOARD, &ids(&["b"])).unwrap(), BOARD);
    }
}
