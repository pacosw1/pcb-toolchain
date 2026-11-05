//! What closes a cell to a centreline: a P or N track there (pitch / 2 to each side, at the width) must clear
//!   - every pad, track and via of another net by the board clearance (0.15 mm), other-net tracks and vias of another net class by
//!     --space (.kicad_dru "MDI USB spacing to other signals"; GND and items touching a --space-exempt courtyard: 0.15 mm);
//!   - the pad / track / via copper of the pair's own nets (except the last stub segments into the tips) by 0.15 mm;
//!   - copper of nets that start with a --barrier prefix by its distance (PoE 3 mm);
//!   - every rule area named --keepout (no copper of this pair in it), and the board edge by 0.5 mm.
use super::Point;
use super::lattice::Lattice;
use super::route::{End, Options};
use crate::kicad::board::{Board, Footprint, RoutedCopper, Track};
use crate::kicad::geom::outline::arc_points;
use crate::kicad::geom::{Polygon, Pt, Rect, from_mm, to_mm};
use crate::kicad::pad::Pad;
use crate::kicad::shape::{Geometry, Graphic, radius};

pub const CLEAR: f64 = 0.15;
const CORNER_PAD: f64 = 0.05;
const EDGE: f64 = 0.5;
/// mm round each end midpoint where the pair's own copper does not block.
const OWN_FREE: f64 = 1.2;
/// A channel opens this far behind an end.
const CHANNEL_BACK_MM: f64 = 0.5;
/// FOOTPRINT::GetBoundingBox starts from the position with this margin, a minimum size for a part with nothing drawn.
const FOOTPRINT_MIN_MM: f64 = 0.25;

/// Distance from points to the segment `seg`, in the order of operations of the numpy code: a cell at the limit stays on its side.
fn segment_distance(p: Point, seg: [f64; 4]) -> f64 {
    let [ax, ay, bx, by] = seg;
    let (dx, dy) = (bx - ax, by - ay);
    let ll = dx * dx + dy * dy;
    let t = if ll == 0.0 { 0.0 } else { (((p.0 - ax) * dx + (p.1 - ay) * dy) / ll).clamp(0.0, 1.0) };
    (p.0 - ax - t * dx).hypot(p.1 - ay - t * dy)
}

fn box_distance(p: Point, b: [f64; 4]) -> f64 {
    let dx = (b[0] - p.0).max(0.0).max(p.0 - b[2]);
    let dy = (b[1] - p.1).max(0.0).max(p.1 - b[3]);
    dx.hypot(dy)
}

fn box_mm(r: Rect) -> [f64; 4] {
    [to_mm(r.left), to_mm(r.top), to_mm(r.right), to_mm(r.bottom)]
}

fn touch(a: [f64; 4], b: [f64; 4]) -> bool {
    !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3])
}

fn graphic_box(g: &Graphic) -> Option<Rect> {
    let line = match &g.geometry {
        Geometry::Segment { start, end } => Rect::of_points([*start, *end]),
        Geometry::Rect { top_left, bottom_right } => Rect::of_points([*top_left, *bottom_right]),
        Geometry::Circle { center, radius_point } => Some(Rect::around(*center).inflated(radius(*center, *radius_point))),
        Geometry::Arc(arc) => Rect::of_points(arc_points(arc, g.width)),
        Geometry::Poly { rings } => Rect::of_points(rings.iter().flatten().copied()),
        Geometry::Other => None,
    };
    line.map(|b| b.inflated(g.width / 2))
}

/// FOOTPRINT::GetBoundingBox with no text: the position, the drawings, the pads and the zones.
fn footprint_box(f: &Footprint) -> Rect {
    let start = Rect::around(f.position).inflated(from_mm(FOOTPRINT_MIN_MM));
    let graphics = f.graphics.iter().filter_map(graphic_box);
    let pads = f.pads.iter().map(|p| p.bbox);
    let zones = f.zones.iter().flat_map(|z| &z.outline).filter_map(Polygon::bbox);
    graphics.chain(pads).chain(zones).fold(start, Rect::merged)
}

fn merged(polygons: &[Polygon]) -> Option<Rect> {
    polygons.iter().filter_map(Polygon::bbox).reduce(Rect::merged)
}

/// Boxes where the spacing rules give way to the board clearance: the --space-exempt courtyards and the --space-exempt-area rule areas
/// (U102_FANOUT, PAIR_BREAKOUT).
fn exempt_boxes(board: &Board, o: &Options) -> Result<Vec<[f64; 4]>, String> {
    let mut boxes = Vec::new();
    for reference in &o.space_exempt {
        let footprint = footprint_of(board, reference)?;
        boxes.push(box_mm(footprint.courtyard_box("F.CrtYd").unwrap_or_else(|| footprint_box(footprint))));
    }
    for zone in board.zones.iter().filter(|z| z.rule_area.is_some() && o.space_exempt_area.contains(&z.name)) {
        boxes.extend(merged(&zone.outline).map(box_mm));
    }
    Ok(boxes)
}

pub fn footprint_of<'b>(board: &'b Board, reference: &str) -> Result<&'b Footprint, String> {
    board.footprints.iter().find(|f| f.reference == reference).ok_or(format!("{reference}: not on the board"))
}

/// One route's view of the board.
pub struct Field<'f> {
    pub board: &'f Board,
    pub options: &'f Options,
    pub p_net: &'f str,
    pub n_net: &'f str,
    pub single: bool,
    pub layer: &'f str,
    /// Centreline to the outer track edge.
    pub half: f64,
}

impl Field<'_> {
    fn own(&self, net: &str) -> bool {
        net == self.p_net || net == self.n_net
    }

    /// The distance to keep from an item of `net`.
    fn need(&self, net: &str, is_track: bool, barrier: &[(String, f64)]) -> f64 {
        if let Some((_, distance)) = barrier.iter().find(|(prefix, _)| net.starts_with(prefix.as_str())) {
            return *distance;
        }
        let o = self.options;
        let class = self.board.net_class(net);
        let same_class = class == self.board.net_class(self.p_net);
        if self.single {
            // One track: same-class tracks by --same-class-space (.kicad_dru FSPI spacing), guarded classes (the routed MDI / USB pairs)
            // by --space; everything else and every pad by the board clearance.
            if is_track && net != self.p_net && same_class {
                return o.same_class_space;
            }
            return if is_track && o.guard_class.iter().any(|c| c == class) { o.space } else { CLEAR };
        }
        if !is_track && !self.own(net) && net != "GND" && !same_class {
            return o.pad_room; // other-class pads: room for their own track beside the pair guard
        }
        // The spacing rule holds between net classes (B.NetClass != A.NetClass).
        if self.own(net) || net == "GND" || !is_track || same_class { CLEAR } else { o.space }
    }

    fn mark_pad(&self, grid: &mut Lattice, own: &mut Lattice, pad: &Pad, exempt: &[[f64; 4]], barrier: &[(String, f64)]) {
        let bbox = box_mm(pad.bbox);
        let mut keep = self.need(&pad.net, false, barrier);
        if keep == self.options.pad_room && exempt.iter().any(|e| touch(bbox, *e)) {
            keep = CLEAR; // pin fields (exempt courtyards): the board clearance
        }
        let target = if self.own(&pad.net) { own } else { grid };
        target.mark(bbox, self.half + keep, |p| box_distance(p, bbox));
    }

    /// A track or a via, which is a track of no length. An arc counts as its chord.
    fn mark_copper(&self, grid: &mut Lattice, seg: [f64; 4], half_width: f64, net: &str, exempt: &[[f64; 4]], barrier: &[(String, f64)]) {
        let [ax, ay, bx, by] = seg;
        let bbox = [ax.min(bx), ay.min(by), ax.max(bx), ay.max(by)];
        let o = self.options;
        let mut keep = self.need(net, true, barrier);
        if (keep == o.space || keep == o.same_class_space) && keep != CLEAR && exempt.iter().any(|e| touch(bbox, *e)) {
            keep = CLEAR;
        }
        // CORNER_PAD: a mitred corner puts the offset leg d / cos(22.5 deg) from the centreline vertex, and a diagonal run between
        // 0.05 mm cell centres passes closer than the cells show (NET-NODE TXN-RXN 0.106 mm).
        let corner = if self.own(net) { 0.0 } else { CORNER_PAD };
        grid.mark(bbox, self.half + half_width + keep + corner, |p| segment_distance(p, seg));
    }

    fn mark_keepouts(&self, grid: &mut Lattice) {
        for zone in self.board.zones.iter().filter(|z| z.rule_area.is_some() && self.options.keepout.contains(&z.name)) {
            let Some(bbox) = merged(&zone.outline).map(box_mm) else { continue };
            let (i0, j0) = grid.cell((bbox[0] - self.half, bbox[1] - self.half));
            let (i1, j1) = grid.cell((bbox[2] + self.half, bbox[3] + self.half));
            let reach = from_mm(self.half);
            for j in j0.max(0)..=j1.min(grid.ny - 1) {
                for i in i0.max(0)..=i1.min(grid.nx - 1) {
                    let (x, y) = grid.xy((i, j));
                    let at = Pt::new(from_mm(x), from_mm(y));
                    if zone.outline.iter().any(|polygon| polygon.near(at, reach)) {
                        grid.set((i, j), true);
                    }
                }
            }
        }
    }

    /// Radial channel (--channel REF:HALF:LATERAL): inside the square of half-size HALF round REF's centre, an end of this route that
    /// starts there may only run straight out along its heading, within LATERAL of that line. The pins beside the pair reach their ring
    /// parts through the same ring (NET-NODE 2026-10-26: SOC_ETH_EXTR / AVDD3V3 next to the MDI TX pins were cut off by the pair turning
    /// inside the SoC ring).
    fn mark_channels(&self, grid: &mut Lattice, ends: &[End]) -> Result<(), String> {
        for spec in &self.options.channel {
            let [reference, half, lateral] = spec.split(':').collect::<Vec<_>>()[..] else { return Err(format!("--channel: want REF:HALF:LATERAL, got {spec}")) };
            let number = |text: &str| text.parse::<f64>().map_err(|_| format!("--channel: not a number: {text}"));
            let (half, lateral) = (number(half)?, number(lateral)?);
            let centre = footprint_of(self.board, reference)?.position;
            let (cx, cy) = (to_mm(centre.x), to_mm(centre.y));
            let local: Vec<&End> = ends.iter().filter(|e| (e.mid.0 - cx).abs() < half && (e.mid.1 - cy).abs() < half).collect();
            let allowed = |(x, y): Point| local.iter().any(|e| {
                let (ux, uy) = e.heading;
                let along = (x - e.mid.0) * ux + (y - e.mid.1) * uy;
                let side = (-(x - e.mid.0) * uy + (y - e.mid.1) * ux).abs();
                along > -CHANNEL_BACK_MM && side <= lateral
            });
            grid.close_where(|p| (p.0 - cx).abs() < half && (p.1 - cy).abs() < half && !allowed(p));
        }
        Ok(())
    }

    fn mark_edge(&self, grid: &mut Lattice) {
        let [x0, y0, x1, y1] = box_mm(self.board.edges_bbox);
        let half = self.half;
        grid.close_where(|(x, y)| x < x0 + EDGE + half || x > x1 - EDGE - half || y < y0 + EDGE + half || y > y1 - EDGE - half);
    }

    /// Closes every cell of `grid`. `last` holds the uuids of the stub segments into the tips: they do not block.
    pub fn close(&self, grid: &mut Lattice, ends: &[End], last: &[&str]) -> Result<(), String> {
        let exempt = exempt_boxes(self.board, self.options)?;
        let barrier = self.options.barriers()?;
        // The pair's own pads block like other copper, except near the two ends: there the centreline starts between them (OWN_FREE).
        let mut own = grid.empty_like();
        for (_, pad) in self.board.pads().filter(|(_, pad)| pad.layers.iter().any(|l| l == self.layer)) {
            self.mark_pad(grid, &mut own, pad, &exempt, &barrier);
        }
        for copper in &self.board.copper {
            match copper {
                RoutedCopper::Via(via) if !last.contains(&via.id.as_str()) => {
                    let (x, y) = (to_mm(via.at.x), to_mm(via.at.y));
                    self.mark_copper(grid, [x, y, x, y], to_mm(via.size) / 2.0, &via.net, &exempt, &barrier);
                }
                RoutedCopper::Track(track) if track.layer == self.layer && !last.contains(&track.id.as_str()) => self.mark_track(grid, track, &exempt, &barrier),
                _ => {}
            }
        }
        self.mark_keepouts(grid);
        self.mark_channels(grid, ends)?;
        for end in ends {
            let mid = end.mid;
            own.open_where(|p| (p.0 - mid.0).hypot(p.1 - mid.1) <= OWN_FREE);
        }
        grid.merge(&own);
        self.mark_edge(grid);
        Ok(())
    }

    fn mark_track(&self, grid: &mut Lattice, track: &Track, exempt: &[[f64; 4]], barrier: &[(String, f64)]) {
        let seg = [to_mm(track.start.x), to_mm(track.start.y), to_mm(track.end.x), to_mm(track.end.y)];
        self.mark_copper(grid, seg, to_mm(track.width) / 2.0, &track.net, exempt, barrier);
    }
}
