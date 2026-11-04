//! A plane via next to each SMD pad of a net (CLAUDE.md section 4, standard stackup).
//!
//! For each SMD pad of the net on F.Cu with no connected via of the net within `radius` of its centre:
//! 1. try via places around the pad: 4 sides, then 4 corners, at growing distances;
//! 2. keep the first place with class clearance to every other-net pad, track and via, class clearance to every via of the board
//!    (same net too, the vias of this run included; D-126), the hole-to-hole minimum to every hole, 0.45 mm hole to hole to a PTH
//!    pad (JLCPCB, D-124 A8), 0.5 mm copper to the board edge (D-040), and outside rule areas that forbid vias;
//! 3. add the via at the class size and a short F.Cu track from the pad centre.
//!
//! A pad with no free place is listed. Nearby-via skips are proved before repairs; when copper changes, one final fill rechecks
//! them and the repairs, and what is not connected is listed as unresolved. At most two fills, no repair/refill loop. The result is
//! a proposal: DRC with parity decides.
mod native;
pub mod place;
pub mod proof;
#[cfg(test)]
mod tests;

use crate::kicad::api::{Server, read_board, read_rules};
use crate::kicad::board::Board;
use crate::kicad::edit::{Edit, NewTrack, NewVia};
use crate::kicad::geom::{Iu, Pt, from_mm};
use crate::kicad::pad::Pad;
use crate::kicad::rules::DesignRules;
use place::{Room, Stub, is_surface};
use proof::{DirectCopper, Links, NearbyViaProof};
use std::collections::BTreeSet;
use std::path::Path;

pub use native::KicadBoard;

/// The tool's arguments, in millimetres.
#[derive(Debug, Clone, PartialEq)]
pub struct Options {
    pub net: String,
    /// Refs or REF.PAD to skip: pads with their own thermal vias.
    pub skip: BTreeSet<String>,
    pub radius: f64,
    pub width: f64,
    /// Diameter and drill.
    pub via: (f64, f64),
    pub clearance: f64,
    pub pth_hole: f64,
    /// REF.PAD: only these pads, also when a via of the net is within `radius` (repair after routing: the pour between can be cut).
    pub only: BTreeSet<String>,
    /// Last choice: a via in the pad, when the pad is at least as large as the via.
    pub in_pad: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options { net: "GND".to_string(), skip: BTreeSet::new(), radius: 1.0, width: 0.4, via: (0.6, 0.3), clearance: 0.2, pth_hole: 0.45, only: BTreeSet::new(), in_pad: false }
    }
}

/// What the tool did. The pad names are REF.PAD.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Plan {
    pub edit: Edit,
    pub added: usize,
    pub links: Vec<String>,
    pub in_pad: Vec<String>,
    pub failed: Vec<String>,
    pub unresolved: Vec<String>,
}

/// The fresh fill behind a proof: the board with `edit` done, refilled.
pub trait Native {
    type Links: Links;
    fn links(&mut self, edit: &Edit) -> Result<Self::Links, String>;
}

const EXTRA_MM: [f64; 4] = [0.2, 0.5, 0.9, 1.4];
const SIDES: [(Iu, Iu); 8] = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, 1), (1, -1), (-1, -1)];
const LINK_REACH_MM: f64 = 2.0;

/// The pads of the net the tool works on, with their names, in board order.
fn target_pads<'a>(board: &'a Board, o: &'a Options) -> impl Iterator<Item = (String, &'a Pad)> {
    let footprints = board.footprints.iter().filter(|f| !o.skip.contains(&f.reference));
    footprints.flat_map(|f| f.pads.iter().map(move |p| (format!("{}.{}", f.reference, p.number), p))).filter(|(name, p)| {
        !o.skip.contains(name) && p.net == o.net && is_surface(p) && p.layers.iter().any(|l| l == "F.Cu")
    })
}

struct Planner<'a> {
    board: &'a Board,
    o: &'a Options,
    room: Room<'a>,
    plan: Plan,
    via_size: Iu,
    drill: Iu,
    direct: NearbyViaProof<DirectCopper>,
}

impl Planner<'_> {
    fn track(&mut self, start: Pt, end: Pt, width: Iu) {
        self.plan.edit.tracks.push(NewTrack { start, end, width, layer: "F.Cu".to_string(), net: self.o.net.clone(), locked: false });
    }

    fn via(&mut self, at: Pt) {
        self.plan.edit.vias.push(NewVia { at, size: self.via_size, drill: self.drill, net: self.o.net.clone(), locked: false });
        self.room.add_via(at, self.via_size / 2);
    }

    /// Step 1 to 3: a via beside the pad.
    fn beside(&mut self, c: Pt, half: Pt, width: Iu) -> bool {
        let radius = self.via_size / 2;
        for extra in EXTRA_MM.map(from_mm) {
            for (dx, dy) in SIDES {
                let at = Pt::new(c.x + dx * (half.x + radius + extra), c.y + dy * (half.y + radius + extra));
                if self.room.free(at, radius, Some(Stub { from: c, width }), None) {
                    self.via(at);
                    self.track(c, at, width);
                    self.plan.added += 1;
                    return true;
                }
            }
        }
        false
    }

    /// Repair: a short F.Cu link to a via or pad of the net at most 2 mm away. A straight link, or an L with the corner on the pad
    /// axis (out of a fine-pitch pin row first).
    fn link(&mut self, pad: &Pad, width: Iu) -> bool {
        let c = pad.position;
        for (target, dist) in self.room.link_targets(pad) {
            if dist < 1.0 {
                continue;
            }
            if dist > from_mm(LINK_REACH_MM) as f64 {
                break;
            }
            let paths = [vec![c, target], vec![c, Pt::new(c.x, target.y), target], vec![c, Pt::new(target.x, c.y), target]];
            if let Some(path) = paths.iter().find(|p| p.windows(2).all(|w| self.room.clear_link(w[0], w[1], width))) {
                for w in path.windows(2) {
                    self.track(w[0], w[1], width);
                }
                return true;
            }
        }
        false
    }

    /// Places in the pad: the centre first, then a 5 x 5 grid (a track on another layer can be below the centre).
    fn in_pad(&mut self, pad: &Pad, half: Pt) -> bool {
        let radius = self.via_size / 2;
        if 2 * half.x.min(half.y) < self.via_size {
            return false;
        }
        let (rx, ry) = (half.x - radius, half.y - radius);
        let mut grid: Vec<(Iu, Iu)> = (-2..3).flat_map(|i| (-2..3).map(move |j| (i, j))).collect();
        grid.sort_by_key(|(i, j)| i * i + j * j);
        let c = pad.position;
        let places = grid.iter().map(|(i, j)| Pt::new(c.x + (i * rx).div_euclid(2), c.y + (j * ry).div_euclid(2)));
        let Some(at) = places.into_iter().find(|at| self.room.free(*at, radius, None, Some(pad))) else { return false };
        self.via(at);
        true
    }

    /// The copper of the net joins this pad to a via near it: an earlier stub may have done so.
    fn directly_connected(&mut self, pad: &Pad, radius: f64) -> Result<bool, String> {
        let (board, net, edit) = (self.board, &self.o.net, &self.plan.edit);
        self.direct.connected(pad, &self.room.net_vias, radius, || Ok(DirectCopper::of(board, net, edit)))
    }

    /// Repairs one pad. True when something was added.
    fn repair(&mut self, name: &str, pad: &Pad) -> bool {
        let (bbox, only) = (pad.bbox, !self.o.only.is_empty());
        let half = Pt::new((bbox.right - bbox.left) / 2, (bbox.bottom - bbox.top) / 2);
        // The stub is not wider than the pad (a 0.4 mm stub from a 0.28 mm pad at 0.5 mm pitch meets the next pads).
        let width = from_mm(self.o.width).min(2 * half.x.min(half.y));
        if self.beside(pad.position, half, width) {
            return true;
        }
        if only && self.link(pad, width) {
            self.plan.links.push(name.to_string());
            return true;
        }
        if self.o.in_pad && self.in_pad(pad, half) {
            self.plan.in_pad.push(name.to_string());
            return true;
        }
        false
    }
}

/// Decides every pad, proving through `native`. Python's order of the checks and of the board items is kept: each new via is an
/// obstacle for the next pad.
pub fn plan<N: Native>(board: &Board, rules: &DesignRules, o: &Options, native: &mut N) -> Result<Plan, String> {
    if !board.nets.contains_key(&o.net) {
        return Err(format!("net {} is not on the board", o.net));
    }
    let radius = from_mm(o.radius) as f64;
    let room = Room::new(board, rules, o)?;
    let only = !o.only.is_empty();
    let mut filled: NearbyViaProof<N::Links> = NearbyViaProof::new();

    // Decisions before the first change: plane-only connections must not cause repeated fills or duplicate vias after a repair.
    let mut initial = BTreeSet::new();
    if !only {
        for (_, pad) in target_pads(board, o) {
            if filled.connected(pad, &room.net_vias, radius, || native.links(&Edit::default()))? {
                initial.insert(pad.id.clone());
            }
        }
    }
    let mut planner = Planner { board, o, room, plan: Plan::default(), via_size: from_mm(o.via.0), drill: from_mm(o.via.1), direct: NearbyViaProof::new() };
    let mut verify: Vec<(String, &Pad, f64)> = Vec::new();
    for (name, pad) in target_pads(board, o).filter(|(name, _)| !only || o.only.contains(name)) {
        if !only && (initial.contains(&pad.id) || planner.directly_connected(pad, radius)?) {
            verify.push((name, pad, radius));
        } else if planner.repair(&name, pad) {
            planner.direct.invalidate();
            verify.push((name, pad, f64::INFINITY));
        } else {
            planner.plan.failed.push(name);
        }
    }
    let Planner { mut plan, room, .. } = planner;
    if !plan.edit.is_empty() {
        // One fresh fill proves the final connectivity: a severed plane connection is unresolved, never a skip reported as
        // connected. The repair loop does not restart.
        filled.invalidate();
        for (name, pad, radius) in verify {
            if !filled.connected(pad, &room.net_vias, radius, || native.links(&plan.edit))? {
                if !plan.failed.contains(&name) {
                    plan.failed.push(name.clone());
                }
                plan.unresolved.push(name);
            }
        }
    }
    Ok(plan)
}

/// The tool's last two output lines.
pub fn summary(plan: &Plan, net: &str) -> [String; 2] {
    let list = |names: &[String]| names.join(" ");
    [
        format!("{net} vias added: {}; pad links: {} {}; in pad: {} {}; no free place: {} {}", plan.added, plan.links.len(), list(&plan.links), plan.in_pad.len(), list(&plan.in_pad), plan.failed.len(), list(&plan.failed)),
        format!("final connectivity unresolved: {} {}", plan.unresolved.len(), list(&plan.unresolved)),
    ]
}

/// The whole tool: reads `board`, plans, saves `out` through KiCad 10.
pub fn run(board_path: &Path, out: &Path, o: &Options) -> Result<Plan, String> {
    let (board, rules) = {
        let (_server, mut client) = Server::start(board_path)?;
        (read_board(&mut client, board_path).map_err(|e| e.to_string())?, read_rules(&mut client, board_path).map_err(|e| e.to_string())?)
    };
    let mut native = KicadBoard::new(board_path, out, &board, &format!("{o:?}"))?;
    let result = plan(&board, &rules, o, &mut native)?;
    native.finish(&result.edit)?;
    Ok(result)
}
