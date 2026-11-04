//! The real fill and connectivity: KiCad 10 refills and saves a copy, the API server reads connectivity from that saved fill.
use super::Native;
use super::proof::Links;
use crate::kicad::api::proto::kiapi::common::types::DocumentSpecifier;
use crate::kicad::api::{Client, Server, connected_vias};
use crate::kicad::board::Board;
use crate::kicad::edit::Edit;
use crate::kicad::geom::Pt;
use crate::kicad::pad::Pad;
use crate::kicad::save::{WorkDir, put_in_place, save_refilled};
use crate::sha256::sha256;
use std::fs;
use std::path::{Path, PathBuf};

/// Connectivity of a saved board, from a server open on it.
pub struct ApiLinks {
    _server: Server,
    client: Client,
    document: DocumentSpecifier,
}

impl ApiLinks {
    fn open(board: &Path) -> Result<ApiLinks, String> {
        let (server, mut client) = Server::start(board)?;
        let document = client.board_document().map_err(|e| e.to_string())?;
        Ok(ApiLinks { _server: server, client, document })
    }
}

impl Links for ApiLinks {
    fn vias_of(&mut self, pad: &Pad) -> Result<Vec<Pt>, String> {
        let vias = connected_vias(&mut self.client, &self.document, &pad.id).map_err(|e| e.to_string())?;
        Ok(vias.into_iter().filter(|(_, net)| *net == pad.net).map(|(at, _)| at).collect())
    }
}

/// The board on disk and what has been saved of it so far.
pub struct KicadBoard {
    source: PathBuf,
    out: PathBuf,
    text: String,
    seed: String,
    has_pours: bool,
    work: WorkDir,
    /// The saved copy, with the edit it holds.
    saved: Option<(PathBuf, Edit)>,
}

impl KicadBoard {
    /// `options` goes into the seed of the new uuids, beside the board bytes: the same run gives the same file.
    pub fn new(source: &Path, out: &Path, board: &Board, options: &str) -> Result<KicadBoard, String> {
        let bytes = fs::read(source).map_err(|e| format!("{}: {e}", source.display()))?;
        let seed = sha256(&[bytes.as_slice(), b"\0", options.as_bytes()].concat());
        let text = String::from_utf8(bytes).map_err(|e| format!("{}: {e}", source.display()))?;
        let has_pours = board.zones.iter().any(|z| z.rule_area.is_none());
        Ok(KicadBoard { source: source.to_path_buf(), out: out.to_path_buf(), text, seed, has_pours, work: WorkDir::beside(out, "gnd-pad-vias")?, saved: None })
    }

    fn save(&mut self, edit: &Edit) -> Result<PathBuf, String> {
        let saved = save_refilled(&self.source, &edit.apply(&self.text, &self.seed)?, &self.work.0)?;
        self.saved = Some((saved.path.clone(), edit.clone()));
        Ok(saved.path)
    }

    /// `out` holds the board with `edit` done: the proof's save when it has the same edit, one save more when not. A board with
    /// nothing to change and no fill is copied as it is.
    pub fn finish(&mut self, edit: &Edit) -> Result<(), String> {
        match &self.saved {
            Some((path, done)) if done == edit => put_in_place(&path.clone(), &self.out),
            _ if edit.is_empty() => fs::copy(&self.source, &self.out).map(|_| ()).map_err(|e| format!("{}: {e}", self.out.display())),
            _ => {
                let path = self.save(edit)?;
                put_in_place(&path, &self.out)
            }
        }
    }
}

impl Native for KicadBoard {
    type Links = ApiLinks;

    /// With no pour and no change there is nothing to fill: the source itself answers.
    fn links(&mut self, edit: &Edit) -> Result<ApiLinks, String> {
        if edit.is_empty() && !self.has_pours {
            return ApiLinks::open(&self.source);
        }
        let path = self.save(edit)?;
        ApiLinks::open(&path)
    }
}
