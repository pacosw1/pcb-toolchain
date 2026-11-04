//! Where a new via may stand: the clearances of step 2 of the tool, as data built once from the board.
use super::Options;
use crate::kicad::board::Board;
use crate::kicad::geom::collide::{beyond, bbox_of, graphic_near_point, near_point, near_segment};
use crate::kicad::geom::{Iu, Polygon, Pt, Rect, from_mm};
use crate::kicad::pad::{Copper, Pad, PadKind};
use crate::kicad::rules::DesignRules;
use crate::kicad::shape::Graphic;

/// The copper layers the tool looks at. Copper on deeper layers is not an obstacle to it.
const CHECKED_LAYERS: [&str; 6] = ["F.Cu", "B.Cu", "In1.Cu", "In2.Cu", "In3.Cu", "In4.Cu"];
const FRONT: &str = "F.Cu";
/// D-040: copper to the board edge.
const EDGE_GAP_MM: f64 = 0.5;
/// The hole-to-hole floor of the boards, below any board setup.
const HOLE_FLOOR_MM: f64 = 0.25;

/// Copper of another net, with the clearance it asks for.
struct Obstacle {
    shapes: Vec<Copper>,
    bbox: Rect,
    on_front: bool,
    clearance: Iu,
}

impl Obstacle {
    fn new(shapes: Vec<Copper>, layers: &[String], clearance: Iu) -> Option<Obstacle> {
        let checked = layers.iter().any(|l| CHECKED_LAYERS.contains(&l.as_str()));
        let bbox = bbox_of(&shapes)?;
        checked.then(|| Obstacle { shapes, bbox, on_front: layers.iter().any(|l| l == FRONT), clearance })
    }

    fn near_point(&self, p: Pt, radius: Iu) -> bool {
        let reach = radius + self.clearance;
        !beyond(&self.bbox, p, p, reach) && self.shapes.iter().any(|s| near_point(s, p, reach))
    }

    /// On F.Cu only: the stubs and links are F.Cu tracks.
    fn near_stub(&self, a: Pt, b: Pt, half_width: Iu) -> bool {
        let reach = half_width + self.clearance;
        self.on_front && !beyond(&self.bbox, a, b, reach) && self.shapes.iter().any(|s| near_segment(s, a, b, reach))
    }
}

struct Hole {
    at: Pt,
    radius: Iu,
    gap: Iu,
}

struct OwnPad {
    id: String,
    at: Pt,
    shapes: Vec<Copper>,
}

/// A stub from the pad to the place, at this width.
#[derive(Clone, Copy)]
pub struct Stub {
    pub from: Pt,
    pub width: Iu,
}

pub struct Room<'a> {
    outlines: &'a [Polygon],
    edges: Vec<&'a Graphic>,
    no_via: Vec<&'a Polygon>,
    obstacles: Vec<Obstacle>,
    own: Vec<OwnPad>,
    holes: Vec<Hole>,
    /// (centre, copper radius) of every via, any net: same-net via copper must not touch either.
    vias: Vec<(Pt, Iu)>,
    pub net_vias: Vec<Pt>,
    clearance: Iu,
    edge_gap: Iu,
    hole_min: Iu,
    drill: Iu,
}

fn distance(a: Pt, b: Pt) -> f64 {
    ((a.x - b.x) as f64).hypot((a.y - b.y) as f64)
}

/// A pad of the tool's kind: SMD or edge connector.
pub fn is_surface(pad: &Pad) -> bool {
    matches!(pad.kind, PadKind::Smd | PadKind::EdgeConnector)
}

/// The clearance of the new copper: the option, the board minimum and the class of its own net (+3V3 in POWER: 0.2 mm).
fn net_clearance(board: &Board, rules: &DesignRules, o: &Options) -> Result<Iu, String> {
    let floor = from_mm(o.clearance).max(rules.minimums.clearance);
    match board.pads().find(|(_, p)| p.net == o.net) {
        Some((f, p)) => Ok(floor.max(rules.pad_clearance(board, f, p, FRONT)?)),
        None => Ok(floor),
    }
}

impl<'a> Room<'a> {
    pub fn new(board: &'a Board, rules: &DesignRules, o: &Options) -> Result<Room<'a>, String> {
        let clearance = net_clearance(board, rules, o)?;
        let hole_min = from_mm(HOLE_FLOOR_MM).max(rules.minimums.hole_to_hole);
        let pth_hole = from_mm(o.pth_hole);
        let mut room = Room {
            outlines: &board.outlines,
            edges: board.graphics.iter().filter(|g| g.layer == "Edge.Cuts").collect(),
            no_via: no_via_areas(board),
            obstacles: Vec::new(),
            own: Vec::new(),
            holes: Vec::new(),
            vias: Vec::new(),
            net_vias: Vec::new(),
            clearance,
            edge_gap: from_mm(EDGE_GAP_MM),
            hole_min,
            drill: from_mm(o.via.1),
        };
        for (footprint, pad) in board.pads() {
            if pad.drill.x != 0 {
                let gap = if pad.kind == PadKind::ThroughHole { pth_hole } else { hole_min };
                room.holes.push(Hole { at: pad.position, radius: pad.drill.x / 2, gap });
            }
            if pad.net != o.net {
                let own = rules.pad_clearance(board, footprint, pad, FRONT)?;
                room.obstacles.extend(Obstacle::new(pad.copper.clone(), &pad.layers, clearance.max(own)));
            } else if is_surface(pad) {
                room.own.push(OwnPad { id: pad.id.clone(), at: pad.position, shapes: pad.copper.clone() });
            }
        }
        for via in board.vias() {
            room.holes.push(Hole { at: via.at, radius: via.drill / 2, gap: hole_min });
            room.vias.push((via.at, via.size / 2));
            if via.net == o.net {
                room.net_vias.push(via.at);
            } else {
                let own = rules.via_clearance(board, &via.net, FRONT)?;
                room.obstacles.extend(Obstacle::new(vec![via.copper()], &board.copper_layers, clearance.max(own)));
            }
        }
        for track in board.tracks().filter(|t| t.net != o.net) {
            let own = rules.track_clearance(board, &track.net, &track.layer)?;
            room.obstacles.extend(Obstacle::new(track.copper(), std::slice::from_ref(&track.layer), clearance.max(own)));
        }
        Ok(room)
    }

    /// A via fits at `at`. `stub` adds the F.Cu track to it; `in_pad` is the one pad it may stand in.
    pub fn free(&self, at: Pt, radius: Iu, stub: Option<Stub>, in_pad: Option<&Pad>) -> bool {
        self.inside_board(at, radius)
            && !self.no_via.iter().any(|z| z.contains(at) || z.near(at, radius))
            && !self.obstacles.iter().any(|o| o.near_point(at, radius) || stub.is_some_and(|s| o.near_stub(s.from, at, s.width / 2)))
            && !self.own.iter().any(|p| in_pad.is_none_or(|q| q.id != p.id) && p.shapes.iter().any(|s| near_point(s, at, radius)))
            && !self.holes.iter().any(|h| distance(h.at, at) < (h.radius + self.drill / 2 + h.gap) as f64)
            && !self.vias.iter().any(|(v, r)| distance(*v, at) < (r + radius + self.clearance) as f64)
    }

    fn inside_board(&self, at: Pt, radius: Iu) -> bool {
        self.outlines.iter().any(|o| o.contains(at)) && !self.edges.iter().any(|g| graphic_near_point(g, at, radius + self.edge_gap))
    }

    /// A short F.Cu track from `a` to `b` of this width clears the other nets.
    pub fn clear_link(&self, a: Pt, b: Pt, width: Iu) -> bool {
        !self.obstacles.iter().any(|o| o.near_stub(a, b, width / 2))
    }

    pub fn add_via(&mut self, at: Pt, radius: Iu) {
        self.holes.push(Hole { at, radius: self.drill / 2, gap: self.hole_min });
        self.vias.push((at, radius));
        self.net_vias.push(at);
    }

    /// Link targets of the pad at `at`: the vias of the net first (one 0.8 mm away with the pour between cut), then its pads,
    /// nearest first.
    pub fn link_targets(&self, pad: &Pad) -> Vec<(Pt, f64)> {
        let own = self.own.iter().filter(|q| q.id != pad.id).map(|q| q.at);
        let mut targets: Vec<(Pt, f64)> = self.net_vias.iter().copied().chain(own).map(|t| (t, distance(t, pad.position))).collect();
        targets.sort_by(|a, b| a.1.total_cmp(&b.1));
        targets
    }
}

fn no_via_areas(board: &Board) -> Vec<&Polygon> {
    let zones = board.zones.iter().chain(board.footprints.iter().flat_map(|f| &f.zones));
    zones.filter(|z| z.rule_area.is_some_and(|r| r.vias)).flat_map(|z| &z.outline).collect()
}
