//! What the check sees of a board: every pad, track, via, NPTH hole and rule area, on every copper layer, because a via is
//! through-hole and meets the copper of the layers the flow does not route on.
use crate::grid::board::{arc_ring, box_ring, mm_point, outline_mm, outlines_mm, ring_mm};
use crate::grid::item::{Item, ItemKind, Point};
use crate::kicad::board::{Board, RoutedCopper, Track, Via};
use crate::kicad::geom::to_mm;
use crate::kicad::pad::{Pad, PadKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    Pad,
    Track,
    Via,
    Hole,
    KeepTrack,
    KeepVia,
}

impl Kind {
    /// What a rule condition reads as the item's `Type`.
    pub fn rule_type(self) -> &'static str {
        match self {
            Kind::Pad => "Pad",
            Kind::Track => "Track",
            Kind::Via => "Via",
            Kind::Hole => "Hole",
            Kind::KeepTrack => "KeepTrack",
            Kind::KeepVia => "KeepVia",
        }
    }
}

/// One item. `item.owner` is the name the cut report shows, `item.clearance` the pad's own override, `item.layers` has one bit per
/// copper layer of the board.
pub struct Obstacle {
    pub item: Item,
    pub kind: Kind,
}

/// A pad with its obstacle, its part and its position.
pub struct SitedPad {
    pub obstacle: usize,
    pub reference: String,
    pub at: Point,
}

pub struct BoardItems {
    pub copper_layers: Vec<String>,
    pub obstacles: Vec<Obstacle>,
    pub pads: Vec<SitedPad>,
    pub outline: Vec<Vec<Point>>,
}

impl BoardItems {
    pub fn of(board: &Board) -> BoardItems {
        let mut items = BoardItems { copper_layers: board.copper_layers.clone(), obstacles: Vec::new(), pads: Vec::new(), outline: outline_mm(board) };
        for (footprint, pad) in board.pads() {
            items.add_pad(&footprint.reference, pad);
        }
        for copper in &board.copper {
            match copper {
                RoutedCopper::Via(via) => items.add_via(via),
                RoutedCopper::Track(track) => items.add_track(track),
            }
        }
        items.add_rule_areas(board);
        items
    }

    fn bits<'n>(&self, names: impl IntoIterator<Item = &'n String>) -> u32 {
        names.into_iter().filter_map(|n| self.copper_layers.iter().position(|l| l == n)).fold(0, |bits, i| bits | 1 << i)
    }

    fn all_layers(&self) -> u32 {
        self.bits(&self.copper_layers.clone())
    }

    fn add_pad(&mut self, reference: &str, pad: &Pad) {
        let name = format!("{reference}.{}", pad.number);
        let at = mm_point(pad.position);
        if pad.kind == PadKind::NpThroughHole {
            let radius = to_mm(pad.drill.x.max(pad.drill.y)) / 2.0;
            self.obstacles.push(Obstacle { item: Item::segment("", &format!("{name}(hole)"), self.all_layers(), 0.0, [at.0, at.1, at.0, at.1], radius), kind: Kind::Hole });
        }
        let layers = self.bits(&pad.layers);
        let Some(first) = self.copper_layers.iter().find(|l| pad.layers.contains(l)) else { return };
        let polygon = pad.polygons.get(first).map_or_else(|| box_ring(pad), |p| ring_mm(&p.outline));
        let clearance = pad.clearance_override.map_or(0.0, to_mm);
        self.obstacles.push(Obstacle { item: Item::polygons(&pad.net, &name, layers, clearance, ItemKind::Pad, vec![polygon]), kind: Kind::Pad });
        self.pads.push(SitedPad { obstacle: self.obstacles.len() - 1, reference: reference.to_string(), at });
    }

    fn add_via(&mut self, via: &Via) {
        let (x, y) = mm_point(via.at);
        self.obstacles.push(Obstacle { item: Item::segment(&via.net, &format!("via {}", via.net), self.all_layers(), 0.0, [x, y, x, y], to_mm(via.size) / 2.0), kind: Kind::Via });
    }

    fn add_track(&mut self, track: &Track) {
        let (layers, name) = (self.bits([&track.layer]), format!("track {}", track.net));
        let item = match track.mid {
            None => {
                let ((x1, y1), (x2, y2)) = (mm_point(track.start), mm_point(track.end));
                Item::segment(&track.net, &name, layers, 0.0, [x1, y1, x2, y2], to_mm(track.width) / 2.0)
            }
            Some(_) => Item::polygons(&track.net, &name, layers, 0.0, ItemKind::Copper, vec![arc_ring(track)]),
        };
        self.obstacles.push(Obstacle { item, kind: Kind::Track });
    }

    fn add_rule_areas(&mut self, board: &Board) {
        for zone in &board.zones {
            let (Some(area), layers) = (zone.rule_area, self.bits(&zone.layers)) else { continue };
            if layers == 0 {
                continue;
            }
            let name = format!("keepout:{}", if zone.name.is_empty() { "?" } else { &zone.name });
            let polygons = outlines_mm(&zone.outline);
            if area.tracks {
                self.obstacles.push(Obstacle { item: Item::polygons("", &name, layers, 0.0, ItemKind::KeepTrack, polygons.clone()), kind: Kind::KeepTrack });
            }
            if area.vias {
                self.obstacles.push(Obstacle { item: Item::polygons("", &name, layers, 0.0, ItemKind::KeepVia, polygons), kind: Kind::KeepVia });
            }
        }
    }
}
