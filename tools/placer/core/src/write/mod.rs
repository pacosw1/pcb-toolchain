//! A pose as a board copy. Each moved unit turns by r * 90 degrees about its origin, then moves to the new origin. Its footprints,
//! its block border and label, its rule areas, slots and the tracks inside its block border move rigidly. Other tracks and vias:
//! each cluster that touches a pad of a moved unit goes, and so does each cluster that now collides (own clearance rules) with a
//! moved pad or moved block copper of another net. With `retain_copper` every track and via stays: a proposal for native checks.
//! Zones stay; the save refills them. The result goes to a new file only.

pub mod cli;
pub mod strip;
pub mod text;

use crate::geom::Rect;
use crate::kicad::clusters::{Clusters, contains};
use crate::kicad::doc::{Board, Copper, CopperItem, Footprint, Nm, Pad, PadCopper, Polygon, Pt, PtMm};
use crate::kicad::hit::{collides_with_copper, collides_with_piece, collides_with_polygon, copper_box};
use crate::read::parts::fp_rect;
use crate::problem::Place;
use iotroute::kicad::edit::Edit;
use iotroute::kicad::geom::Rect as NmRect;
use iotroute::kicad::item_text::{item_uuid, nm_text};
use iotroute::kicad::raw::{Form, parse_first};
use iotroute::kicad::rules::DesignRules;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};
use text::{Changes, Transform, items_by_uuid, move_board_item, move_footprint};

/// How far a moved item reaches when the quick box test looks for clashes: above any clearance on these boards.
const CLASH_REACH: Nm = 500_000;
/// A zone this share of the board wide and high is a pour: it grows to the virtual outline.
const POUR_SHARE: f64 = 0.9;
const OUTLINE_WIDTH: &str = "0.1";

/// The part of a problem the writer reads.
#[derive(Debug, Deserialize)]
pub struct WriteUnit {
    pub name: String,
    pub refs: Vec<String>,
    pub fixed: bool,
    pub x: f64,
    pub y: f64,
    #[serde(rename = "box", default)]
    pub boxed: Option<[f64; 4]>,
    #[serde(default)]
    pub borders: Vec<String>,
    #[serde(default)]
    pub zones: Vec<String>,
    #[serde(default)]
    pub cuts: Vec<String>,
    #[serde(default)]
    pub locked_cu: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct WriteBoard {
    pub outline: Vec<(f64, f64)>,
}

#[derive(Debug, Deserialize)]
pub struct WriteProblem {
    pub units: Vec<WriteUnit>,
    pub board: WriteBoard,
    #[serde(default)]
    pub engineering: Option<serde_json::Value>,
}

impl WriteProblem {
    /// A reviewed board keeps its source copper and outline. tools/placer/board-io.ts screens the pose before it gets here.
    pub fn check_reviewed(&self, options: &WriteOptions) -> crate::Result<()> {
        let reviewed = self.engineering.as_ref().is_some_and(|contract| !contract.is_null());
        if reviewed && (!options.retain_copper || options.outline_scale != 1.0) {
            return Err("a reviewed problem keeps its copper and real outline: --retain-copper, no --outline-scale".into());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug)]
pub struct WriteOptions {
    pub outline_scale: f64,
    pub retain_copper: bool,
}

impl Default for WriteOptions {
    fn default() -> Self {
        Self { outline_scale: 1.0, retain_copper: false }
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Report {
    pub moved_units: usize,
    pub removed_tracks: usize,
    pub removed_collisions: usize,
    pub moved_block_tracks: usize,
}

/// `v` in whole nanometres, as the writer has always rounded a pose.
fn nm(v: f64) -> Nm {
    (v * 1e6).round_ties_even() as Nm
}

struct Moved<'a> {
    index: usize,
    unit: &'a WriteUnit,
    transform: Transform,
}

fn moved_units<'a>(pr: &'a WriteProblem, pose: &[Place]) -> crate::Result<Vec<Moved<'a>>> {
    let mut out = Vec::new();
    for (index, (u, &(x, y, r))) in pr.units.iter().zip(pose).enumerate() {
        if (x - u.x).abs() <= 1e-6 && (y - u.y).abs() <= 1e-6 && r % 4 == 0 {
            continue;
        }
        if u.fixed {
            return Err(format!("fixed unit {} moved", u.name).into());
        }
        let transform = Transform { origin: Pt::new(nm(u.x), nm(u.y)), quarter: r % 4, shift: Pt::new(nm(x - u.x), nm(y - u.y)) };
        out.push(Moved { index, unit: u, transform });
    }
    Ok(out)
}

/// Block copper: a track inside the block box, not locked, on a net of a pad of the block; and the block's private locked copper.
/// A locked pair through a block is fixed copper: it never moves.
fn block_copper<'b>(board: &'b Board, moved: &[Moved], by_ref: &HashMap<&str, &Footprint>) -> HashMap<&'b str, usize> {
    let mut internal = HashMap::new();
    for m in moved {
        let Some(b) = m.unit.boxed else { continue };
        let area = Rect::new(b[0], b[1], b[2], b[3]);
        let own: HashSet<&str> = m.unit.refs.iter().flat_map(|r| &by_ref[r.as_str()].pads).map(|p| p.net.as_str()).filter(|n| !n.is_empty()).collect();
        for t in &board.copper {
            let inside = || t.ends().iter().all(|p| contains(area, p.mm().0, p.mm().1));
            if m.unit.locked_cu.iter().any(|id| id == t.id()) || (!t.locked() && own.contains(t.net()) && inside()) {
                internal.insert(t.id(), m.index);
            }
        }
    }
    internal
}

/// A pad after the move: its shape per layer and its box.
struct MovedPad<'a> {
    fp: &'a Footprint,
    pad: &'a Pad,
    transform: Transform,
}

impl MovedPad<'_> {
    fn polygon(&self, layer: &str) -> Option<Polygon> {
        let map = |ring: &Vec<Pt>| ring.iter().map(|p| self.transform.point(*p)).collect::<Vec<_>>();
        self.pad.polygons.get(layer).map(|g| Polygon { outline: map(&g.outline), holes: g.holes.iter().map(map).collect() })
    }

    /// A pad that shares its uuid has no polygons: then its layers and copper tell.
    fn on(&self, layer: &str) -> bool {
        if self.pad.polygons.is_empty() { self.pad.layers.iter().any(|l| l == layer) } else { self.pad.polygons.contains_key(layer) }
    }

    fn collides(&self, item: &Copper, layer: &str, clearance: Nm) -> bool {
        match self.polygon(layer) {
            Some(g) => collides_with_polygon(item, &g, clearance),
            None => self.pad.copper.iter().any(|c| collides_with_piece(item, &self.moved_piece(c), clearance)),
        }
    }

    fn moved_piece(&self, piece: &PadCopper) -> PadCopper {
        let t = &self.transform;
        match piece {
            PadCopper::Circle { center, radius } => PadCopper::Circle { center: t.point(*center), radius: *radius },
            PadCopper::Segment { a, b, width } => PadCopper::Segment { a: t.point(*a), b: t.point(*b), width: *width },
            PadCopper::Polygon(ring) => PadCopper::Polygon(ring.iter().map(|p| t.point(*p)).collect()),
        }
    }

    fn bbox(&self) -> NmRect {
        let b = self.pad.bbox;
        let (a, c) = (self.transform.point(Pt::new(b.left, b.top)), self.transform.point(Pt::new(b.right, b.bottom)));
        NmRect { left: a.x.min(c.x), top: a.y.min(c.y), right: a.x.max(c.x), bottom: a.y.max(c.y) }
    }
}

/// A track or via after the move.
fn moved_copper(item: &Copper, t: &Transform) -> Copper {
    let mut out = item.clone();
    match &mut out {
        Copper::Track(k) => {
            k.start = t.point(k.start);
            k.end = t.point(k.end);
            k.mid = k.mid.map(|m| t.point(m));
        }
        Copper::Via(v) => v.at = t.point(v.at),
    }
    out
}

fn meet(a: NmRect, b: NmRect, grow: Nm) -> bool {
    a.left <= b.right + grow && b.left - grow <= a.right && a.top <= b.bottom + grow && b.top - grow <= a.bottom
}

/// GetOwnClearance of a track or via on a layer.
fn item_clearance(design: &DesignRules, board: &Board, item: &Copper, layer: &str) -> crate::Result<Nm> {
    Ok(match item {
        Copper::Track(t) => design.track_clearance(board, &t.net, layer)?,
        Copper::Via(v) => design.via_clearance(board, &v.net, layer)?,
    })
}

struct Clash<'a> {
    board: &'a Board,
    design: &'a DesignRules,
    pads: Vec<MovedPad<'a>>,
    copper: Vec<Copper>,
}

impl Clash<'_> {
    fn on(item: &Copper, layer: &str) -> bool {
        item.layers().contains(&layer)
    }

    fn with_pad(&self, t: &Copper, moved: &MovedPad) -> crate::Result<bool> {
        for layer in self.board.copper_layers.iter().filter(|l| Self::on(t, l) && moved.on(l)) {
            let clearance = item_clearance(self.design, self.board, t, layer)?.max(self.design.pad_clearance(self.board, moved.fp, moved.pad, layer)?);
            if moved.collides(t, layer, clearance) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn with_copper(&self, t: &Copper, other: &Copper) -> crate::Result<bool> {
        for layer in self.board.copper_layers.iter().filter(|l| Self::on(t, l) && Self::on(other, l)) {
            let clearance = item_clearance(self.design, self.board, t, layer)?.max(item_clearance(self.design, self.board, other, layer)?);
            if collides_with_copper(t, other, clearance) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Does a kept track or via touch moved copper of another net?
    fn hits(&self, t: &Copper) -> crate::Result<bool> {
        let bbox = copper_box(t);
        for moved in self.pads.iter().filter(|m| m.pad.net != t.net() && meet(bbox, m.bbox(), CLASH_REACH)) {
            if self.with_pad(t, moved)? {
                return Ok(true);
            }
        }
        for other in self.copper.iter().filter(|o| o.net() != t.net() && meet(bbox, copper_box(o), CLASH_REACH)) {
            if self.with_copper(t, other)? {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

/// What a write takes out: the ids, and how many of them collided.
struct Rip {
    removed: HashSet<String>,
    collisions: usize,
}

fn rip(board: &Board, design: &DesignRules, moved: &[Moved], by_ref: &HashMap<&str, &Footprint>, internal: &HashMap<&str, usize>, retain: bool) -> crate::Result<Rip> {
    let free: Vec<&Copper> = if retain { Vec::new() } else { board.copper.iter().filter(|t| !internal.contains_key(t.id()) && !t.locked()).collect() };
    let clusters = Clusters::new(free);
    let mut pads_by_net: HashMap<&str, Vec<&Pad>> = HashMap::new();
    let mut pads = Vec::new();
    let mut rects = Vec::new();
    for m in moved {
        for fp in m.unit.refs.iter().map(|r| by_ref[r.as_str()]) {
            rects.push(fp_rect(fp));
            for pad in &fp.pads {
                pads.push(MovedPad { fp, pad, transform: m.transform });
                if !pad.net.is_empty() {
                    pads_by_net.entry(&pad.net).or_default().push(pad);
                }
            }
        }
    }
    let mut hit = clusters.on_pads(&pads_by_net);
    hit.extend(clusters.lone_vias(Some(&rects)));
    let by_index: HashMap<usize, &Moved> = moved.iter().map(|m| (m.index, m)).collect();
    let copper = board.copper.iter().filter_map(|t| internal.get(t.id()).map(|i| moved_copper(t, &by_index[i].transform))).collect();
    let clash = Clash { board, design, pads, copper };
    let mut collided: BTreeSet<usize> = BTreeSet::new();
    for (k, t) in clusters.items.iter().enumerate() {
        let c = clusters.find(k);
        if !hit.contains(&c) && !collided.contains(&c) && clash.hits(t)? {
            collided.insert(c);
        }
    }
    let of = |set: &BTreeSet<usize>| clusters.items.iter().enumerate().filter(|(k, _)| set.contains(&clusters.find(*k))).map(|(_, t)| t.id().to_string()).collect::<Vec<_>>();
    let gone = of(&collided);
    let collisions = gone.len();
    Ok(Rip { removed: of(&hit).into_iter().chain(gone).collect(), collisions })
}

fn scaled_box(outline: &[(f64, f64)], k: f64) -> ((f64, f64), (f64, f64), f64, f64) {
    let bounds = |v: Vec<f64>| (v.iter().copied().fold(f64::INFINITY, f64::min), v.iter().copied().fold(f64::NEG_INFINITY, f64::max));
    let ((x0, x1), (y0, y1)) = (bounds(outline.iter().map(|p| p.0).collect()), bounds(outline.iter().map(|p| p.1).collect()));
    let (cx, cy, hw, hh) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0, (x1 - x0) * k / 2.0, (y1 - y0) * k / 2.0);
    ((cx - hw, cy - hh), (cx + hw, cy + hh), x1 - x0, y1 - y0)
}

fn xy_text(p: (f64, f64)) -> String {
    format!("{} {}", nm_text(nm(p.0)), nm_text(nm(p.1)))
}

/// Replaces the Edge.Cuts shapes (not the block slots) by the box of the outline scaled by k. A zone over the whole outline (a
/// ground pour) grows with it, so the refill reaches parts placed outside the real outline.
fn virtual_outline(text: &str, board: &Board, pr: &WriteProblem, k: f64) -> crate::Result<String> {
    let ((x0, y0), (x1, y1), w0, h0) = scaled_box(&pr.board.outline, k);
    let root = parse_first(text)?;
    let keep: HashSet<&str> = pr.units.iter().flat_map(|u| u.cuts.iter().map(String::as_str)).collect();
    let items = items_by_uuid(&root);
    let mut changes = Changes::default();
    for g in board.graphics.iter().filter(|g| g.layer == "Edge.Cuts" && !keep.contains(g.id.as_str())) {
        if let Some(item) = items.get(g.id.as_str()) {
            changes.put(item.span.clone(), String::new());
        }
    }
    for zone in &board.zones {
        let (Some(b), Some(item)) = (crate::kicad::doc::zone_box(zone), items.get(zone.id.as_str())) else { continue };
        if b.width() >= POUR_SHARE * w0 && b.height() >= POUR_SHARE * h0 {
            let corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)].map(|p| format!("(xy {})", xy_text(p))).join(" ");
            pour_outline(item, &corners, &mut changes);
        }
    }
    let shape = format!(
        "\t(gr_rect\n\t\t(start {})\n\t\t(end {})\n\t\t(stroke\n\t\t\t(width {OUTLINE_WIDTH})\n\t\t\t(type default)\n\t\t)\n\t\t(fill no)\n\t\t(layer \"Edge.Cuts\")\n\t\t(uuid \"{}\")\n\t)\n",
        xy_text((x0, y0)),
        xy_text((x1, y1)),
        item_uuid("virtual-outline", 0)
    );
    let close = root.span.end - 1;
    changes.put(close..close, shape);
    Ok(changes.apply(text))
}

/// The points of a zone's outline; its old fill is dropped, the save refills it.
fn pour_outline(zone: &Form, corners: &str, changes: &mut Changes) {
    if let Some(pts) = zone.children("polygon").next().and_then(|p| p.children("pts").next()) {
        changes.put(pts.span.clone(), format!("(pts {corners})"));
    }
    for fill in zone.children("filled_polygon") {
        changes.put(fill.span.clone(), String::new());
    }
}

/// Moves the items of the moved units in the text.
fn moved_text(text: &str, board: &Board, moved: &[Moved], by_ref: &HashMap<&str, &Footprint>, internal: &HashMap<&str, usize>) -> crate::Result<String> {
    let root = parse_first(text)?;
    let items = items_by_uuid(&root);
    let mut changes = Changes::default();
    for m in moved {
        for r in &m.unit.refs {
            let id = by_ref[r.as_str()].id.as_str();
            let fp = items.get(id).ok_or_else(|| format!("no footprint {r} in the board text"))?;
            move_footprint(fp, &m.transform, &mut changes);
        }
        let owned = m.unit.borders.iter().chain(&m.unit.zones).chain(&m.unit.cuts);
        for item in owned.filter_map(|id| items.get(id.as_str())) {
            move_board_item(item, &m.transform, &mut changes);
        }
        let tracks = board.copper.iter().filter(|t| internal.get(t.id()) == Some(&m.index));
        for item in tracks.filter_map(|t| items.get(t.id())) {
            move_board_item(item, &m.transform, &mut changes);
        }
    }
    Ok(changes.apply(text))
}

/// The edited board text and what was done. Saving it is the caller's: `iotroute::kicad::save`.
pub fn write_board(text: &str, board: &Board, design: &DesignRules, pr: &WriteProblem, pose: &[Place], options: WriteOptions) -> crate::Result<(String, Report)> {
    if pose.len() != pr.units.len() {
        return Err(format!("{} places for {} units", pose.len(), pr.units.len()).into());
    }
    let by_ref: HashMap<&str, &Footprint> = board.footprints.iter().map(|f| (f.reference.as_str(), f)).collect();
    let moved = moved_units(pr, pose)?;
    let internal = if options.retain_copper { HashMap::new() } else { block_copper(board, &moved, &by_ref) };
    let ripped = rip(board, design, &moved, &by_ref, &internal, options.retain_copper)?;
    let kept = Edit { removed: ripped.removed.clone(), ..Edit::default() }.apply(text, "placer-write")?;
    let mut out = moved_text(&kept, board, &moved, &by_ref, &internal)?;
    if options.outline_scale != 1.0 {
        out = virtual_outline(&out, board, pr, options.outline_scale)?;
    }
    let report = Report { moved_units: moved.len(), removed_tracks: ripped.removed.len(), removed_collisions: ripped.collisions, moved_block_tracks: internal.len() };
    Ok((out, report))
}
