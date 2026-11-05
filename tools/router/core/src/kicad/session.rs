//! A board open for editing: read once through the API, changed in memory, saved once through KiCad 10. New copper shows in `board`
//! at once, so a tool works on the board as it will be.
use super::api::{Server, read_board, read_rules};
use super::board::{Board, RoutedCopper, Track, Via};
use super::edit::{Edit, NewTrack, NewVia};
use super::rules::DesignRules;
use super::save::{Saved, WorkDir, put_in_place, save_refilled};
use crate::sha256::sha256;
use std::fs;
use std::path::{Path, PathBuf};

pub struct Session {
    pub path: PathBuf,
    pub board: Board,
    pub rules: DesignRules,
    pub edit: Edit,
    text: String,
    seed: String,
}

impl Session {
    /// `arguments` goes into the seed of the new uuids, beside the board bytes: the same run gives the same file.
    pub fn open(path: &Path, arguments: &str) -> Result<Session, String> {
        let (_server, mut client) = Server::start(path)?;
        let board = read_board(&mut client, path).map_err(|e| e.to_string())?;
        let rules = read_rules(&mut client, path).map_err(|e| e.to_string())?;
        Session::of(path, board, rules, arguments)
    }

    /// A session on a board already read.
    pub fn of(path: &Path, board: Board, rules: DesignRules, arguments: &str) -> Result<Session, String> {
        let bytes = fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let seed = sha256(&[bytes.as_slice(), b"\0", arguments.as_bytes()].concat());
        let text = String::from_utf8(bytes).map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(Session { path: path.to_path_buf(), board, rules, edit: Edit::default(), text, seed })
    }

    fn next_id(&self) -> String {
        format!("new-{}", self.edit.tracks.len() + self.edit.vias.len())
    }

    pub fn add_track(&mut self, t: NewTrack) {
        let id = self.next_id();
        self.board.copper.push(RoutedCopper::Track(Track { id, start: t.start, end: t.end, mid: None, width: t.width, layer: t.layer.clone(), net: t.net.clone(), locked: t.locked }));
        self.edit.tracks.push(t);
    }

    pub fn add_via(&mut self, v: NewVia) {
        let id = self.next_id();
        self.board.copper.push(RoutedCopper::Via(Via { id, at: v.at, size: v.size, drill: v.drill, net: v.net.clone(), locked: v.locked }));
        self.edit.vias.push(v);
    }

    /// Takes tracks and vias of the board as read out, by uuid.
    pub fn remove(&mut self, ids: impl IntoIterator<Item = String>) {
        self.edit.removed.extend(ids);
        let removed = &self.edit.removed;
        self.board.copper.retain(|c| match c {
            RoutedCopper::Track(t) => !removed.contains(&t.id),
            RoutedCopper::Via(v) => !removed.contains(&v.id),
        });
    }

    /// The board as it stands, saved by KiCad 10 in `folder`. The input file is not touched.
    pub fn save_copy(&self, folder: &Path) -> Result<Saved, String> {
        save_refilled(&self.path, &self.edit.apply(&self.text, &self.seed)?, folder)
    }

    /// The board as it stands, saved by KiCad 10 over `out`.
    pub fn save_to(&self, out: &Path) -> Result<(), String> {
        let work = WorkDir::beside(out, "save")?;
        put_in_place(&self.save_copy(&work.0)?.path, out)
    }
}
