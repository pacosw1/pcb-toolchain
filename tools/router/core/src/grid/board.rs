//! The legality grid of a board. Cells of `g` mm over the board outline. For a net on a layer, a cell is free when the centre of a
//! track of the minimum width there clears every copper item of another net (pads, tracks, vias, holes) by the larger clearance of
//! the two, clears the board edge, and is outside a no-track rule area. A via fits where a via of the net's class diameter is free
//! on every job layer and outside a no-via rule area. Filled zones are not obstacles: they refill round new copper. Obstacles are
//! shrunk by half a cell, so a gap the grid cannot resolve counts as open.
use super::item::{Item, ItemKind, Point, Shape, in_poly, poly_dist, seg_dist};
use super::mask::{Mask, Window};
use crate::kicad::board::{Board, Footprint};
use crate::kicad::geom::{Polygon, Pt, to_mm};
use crate::kicad::pad::{Pad, PadKind};
use crate::kicad::rules::DesignRules;
use std::collections::HashMap;
use std::rc::Rc;

/// A pad of a net: its item and where it stands on the board.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NetPad {
    pub item: usize,
    pub footprint: usize,
    pub pad: usize,
}

/// A window's rasters for one net.
pub struct NetGrids {
    pub free: Vec<Mask>,
    pub via_ok: Mask,
    /// Per layer, the item that blocks each cell, -1 for none. Empty when not asked for.
    pub owners: Vec<Vec<i32>>,
}

/// A cell-accurate window of an item's copper, cached by its distance.
type ItemMask = Option<Rc<Mask>>;

pub struct GridBoard<'a> {
    pub board: &'a Board,
    pub layers: Vec<String>,
    pub g: f64,
    pub min_width: f64,
    pub edge_clearance: f64,
    min_clearance: f64,
    pub x0: f64,
    pub y0: f64,
    pub nx: i64,
    pub ny: i64,
    pub items: Vec<Item>,
    pub net_clearance: HashMap<String, f64>,
    pub net_via: HashMap<String, f64>,
    /// In the order the nets first appear on the pads.
    pub net_pads: Vec<(String, Vec<NetPad>)>,
    outline: Vec<Vec<Point>>,
    item_masks: HashMap<(usize, i64), ItemMask>,
    board_masks: HashMap<(Window, i64), Rc<Mask>>,
}

fn mm_point(p: Pt) -> Point {
    (to_mm(p.x), to_mm(p.y))
}

fn ring_mm(ring: &[Pt]) -> Vec<Point> {
    ring.iter().copied().map(mm_point).collect()
}

fn outlines_mm(polygons: &[Polygon]) -> Vec<Vec<Point>> {
    polygons.iter().map(|p| ring_mm(&p.outline)).collect()
}

/// Cached by distance rounded to 1 um, as the Python tool did.
fn distance_key(r: f64) -> i64 {
    crate::model::text::round_to(r * 1000.0, 0) as i64
}

fn mask_of(window: Window, x0: f64, y0: f64, g: f64, test: impl Fn(f64, f64) -> bool) -> Mask {
    let mut mask = Mask::filled(window, false);
    for j in 0..window.height() {
        let y = y0 + ((window.j0 + j as i64) as f64 + 0.5) * g;
        for i in 0..window.width() {
            let x = x0 + ((window.i0 + i as i64) as f64 + 0.5) * g;
            if test(x, y) {
                mask.set(j, i, true);
            }
        }
    }
    mask
}

impl<'a> GridBoard<'a> {
    pub fn new(board: &'a Board, rules: &DesignRules, layers: &[String], g: f64) -> Result<GridBoard<'a>, String> {
        let bb = board.edges_bbox;
        let m = rules.minimums;
        let outline = if board.outlines.is_empty() {
            // GetBoardPolygonOutlines with an inferred outline: the box of the edges.
            vec![ring_mm(&[Pt::new(bb.left, bb.top), Pt::new(bb.right, bb.top), Pt::new(bb.right, bb.bottom), Pt::new(bb.left, bb.bottom)])]
        } else {
            outlines_mm(&board.outlines)
        };
        let mut grid = GridBoard {
            board,
            layers: layers.to_vec(),
            g,
            min_width: to_mm(m.track_width),
            edge_clearance: to_mm(m.copper_edge_clearance),
            min_clearance: to_mm(m.clearance),
            x0: to_mm(bb.left),
            y0: to_mm(bb.top),
            nx: (to_mm(bb.right - bb.left) / g) as i64 + 1,
            ny: (to_mm(bb.bottom - bb.top) / g) as i64 + 1,
            items: Vec::new(),
            net_clearance: HashMap::new(),
            net_via: HashMap::new(),
            net_pads: Vec::new(),
            outline,
            item_masks: HashMap::new(),
            board_masks: HashMap::new(),
        };
        let hole_clearance = to_mm(m.hole_clearance.max(m.clearance));
        grid.collect_pads(rules, hole_clearance)?;
        grid.collect_copper(rules)?;
        grid.collect_rule_areas();
        grid.net_via = board.nets.keys().chain(std::iter::once(&String::new())).map(|n| (n.clone(), to_mm(rules.via_diameter(n)))).collect();
        Ok(grid)
    }

    /// The bit of each job layer of `names`.
    pub fn layer_bits<'n>(&self, names: impl IntoIterator<Item = &'n String>) -> u32 {
        names.into_iter().filter_map(|n| self.layers.iter().position(|l| l == n)).fold(0, |bits, i| bits | 1 << i)
    }

    pub fn all_layers(&self) -> u32 {
        (1 << self.layers.len()) - 1
    }

    fn collect_pads(&mut self, rules: &DesignRules, hole_clearance: f64) -> Result<(), String> {
        let board = self.board;
        let all = self.all_layers();
        for (fi, footprint) in board.footprints.iter().enumerate() {
            for (pi, pad) in footprint.pads.iter().enumerate() {
                let owner = format!("{}.{}", footprint.reference, pad.number);
                if pad.kind == PadKind::NpThroughHole {
                    let (x, y) = mm_point(pad.position);
                    let d = to_mm(pad.drill.x.max(pad.drill.y));
                    self.items.push(Item::segment("", &format!("{owner}(hole)"), all, hole_clearance, [x, y, x, y], d / 2.0));
                }
                let bits = self.layer_bits(&pad.layers);
                if bits == 0 {
                    continue;
                }
                self.add_pad(rules, footprint, pad, owner, bits, (fi, pi))?;
            }
        }
        Ok(())
    }

    fn add_pad(&mut self, rules: &DesignRules, footprint: &Footprint, pad: &Pad, owner: String, bits: u32, at: (usize, usize)) -> Result<(), String> {
        let first = self.layers.iter().find(|l| pad.layers.contains(l)).expect("the pad has a job layer").clone();
        let clearance = to_mm(rules.pad_clearance(self.board, footprint, pad, &first)?);
        let polygon = pad.polygons.get(&first).map_or_else(|| box_ring(pad), |p| ring_mm(&p.outline));
        self.items.push(Item::polygons(&pad.net, &owner, bits, clearance, ItemKind::Pad, vec![polygon]));
        if !pad.net.is_empty() {
            let entry = NetPad { item: self.items.len() - 1, footprint: at.0, pad: at.1 };
            match self.net_pads.iter_mut().find(|(n, _)| *n == pad.net) {
                Some((_, pads)) => pads.push(entry),
                None => self.net_pads.push((pad.net.clone(), vec![entry])),
            }
            let best = self.net_clearance.entry(pad.net.clone()).or_insert(0.0);
            *best = best.max(clearance);
        }
        Ok(())
    }

    fn collect_copper(&mut self, rules: &DesignRules) -> Result<(), String> {
        let board = self.board;
        let all = self.all_layers();
        let first = self.layers[0].clone();
        for copper in &board.copper {
            use crate::kicad::board::RoutedCopper::{Track, Via};
            match copper {
                Via(v) => {
                    let (x, y) = mm_point(v.at);
                    let clearance = to_mm(rules.via_clearance(board, &v.net, &first)?);
                    self.items.push(Item::segment(&v.net, "via", all, clearance, [x, y, x, y], to_mm(v.size) / 2.0));
                }
                Track(t) => {
                    let Some(layer) = self.layers.iter().position(|l| *l == t.layer) else { continue };
                    let clearance = to_mm(rules.track_clearance(board, &t.net, &t.layer)?);
                    let bit = 1 << layer;
                    self.items.push(match t.mid {
                        None => {
                            let ((x1, y1), (x2, y2)) = (mm_point(t.start), mm_point(t.end));
                            Item::segment(&t.net, "track", bit, clearance, [x1, y1, x2, y2], to_mm(t.width) / 2.0)
                        }
                        Some(_) => Item::polygons(&t.net, "track", bit, clearance, ItemKind::Copper, vec![arc_ring(t)]),
                    });
                }
            }
        }
        Ok(())
    }

    fn collect_rule_areas(&mut self) {
        let board = self.board;
        for zone in &board.zones {
            let (Some(area), bits) = (zone.rule_area, self.layer_bits(&zone.layers)) else { continue };
            if bits == 0 {
                continue;
            }
            let owner = format!("keepout:{}", if zone.name.is_empty() { "?" } else { &zone.name });
            let polygons = outlines_mm(&zone.outline);
            if area.tracks {
                self.items.push(Item::polygons("", &owner, bits, 0.0, ItemKind::KeepTrack, polygons.clone()));
            }
            if area.vias {
                self.items.push(Item::polygons("", &owner, bits, 0.0, ItemKind::KeepVia, polygons));
            }
        }
    }

    /// One grid cell more on every clearance: the grid shrinks obstacles by half a cell, right for a diagnosis with no false
    /// enclosure. A router must not, so each kept cell then clears by at least the rule plus half a cell.
    pub fn for_routing(&mut self) {
        let g = self.g;
        self.items.iter_mut().for_each(|it| it.clearance += g);
        self.net_clearance.values_mut().for_each(|c| *c += g);
        self.edge_clearance += g;
        self.clear_caches();
    }

    pub fn clear_caches(&mut self) {
        self.item_masks.clear();
        self.board_masks.clear();
    }

    pub fn window(&self, x1: f64, y1: f64, x2: f64, y2: f64) -> Window {
        let cell = |v: f64, origin: f64| ((v - origin) / self.g) as i64;
        Window { i0: cell(x1, self.x0).max(0), i1: (cell(x2, self.x0) + 2).min(self.nx), j0: cell(y1, self.y0).max(0), j1: (cell(y2, self.y0) + 2).min(self.ny) }
    }

    pub fn full_window(&self) -> Window {
        Window { i0: 0, i1: self.nx, j0: 0, j1: self.ny }
    }

    /// The centre of a cell of a window, by its row and column there.
    pub fn centre(&self, window: &Window, j: usize, i: usize) -> Point {
        (self.x0 + ((window.i0 + i as i64) as f64 + 0.5) * self.g, self.y0 + ((window.j0 + j as i64) as f64 + 0.5) * self.g)
    }

    /// Cells within `r` of item `k`, in the window round it; None when that window is empty.
    pub fn item_mask(&mut self, k: usize, r: f64) -> ItemMask {
        let key = (k, distance_key(r));
        if let Some(mask) = self.item_masks.get(&key) {
            return mask.clone();
        }
        let item = &self.items[k];
        let [x1, y1, x2, y2] = item.bbox;
        let window = self.window(x1 - r, y1 - r, x2 + r, y2 + r);
        let mask = (!window.is_empty()).then(|| {
            let test = |x: f64, y: f64| match &item.shape {
                Shape::Segment(seg, half_width) => seg_dist(x, y, *seg) <= half_width + r,
                Shape::Polygons(polygons) => polygons.iter().any(|p| in_poly(x, y, p) || (r > 0.0 && poly_dist(x, y, p) <= r)),
            };
            Rc::new(mask_of(window, self.x0, self.y0, self.g, test))
        });
        self.item_masks.insert(key, mask.clone());
        mask
    }

    /// Cells inside the outline and at least `margin` from it.
    fn board_mask(&mut self, window: Window, margin: f64) -> Rc<Mask> {
        let key = (window, distance_key(margin));
        if let Some(mask) = self.board_masks.get(&key) {
            return mask.clone();
        }
        let outline = &self.outline;
        let limit = (margin + 1e-6).powi(2);
        let test = |x: f64, y: f64| {
            let inside = outline.iter().fold(false, |ins, p| ins ^ in_poly(x, y, p));
            inside && (margin <= 0.0 || outline.iter().all(|p| clear_of(x, y, p, margin, limit)))
        };
        let mask = Rc::new(mask_of(window, self.x0, self.y0, self.g, test));
        self.board_masks.insert(key, mask.clone());
        mask
    }

    /// Cells where `net` cannot put a track centre (or a via centre) on a layer, with the item behind each when `owners`.
    pub fn blocked(&mut self, net: &str, layer: usize, window: Window, via: bool, owners: bool) -> (Mask, Vec<i32>) {
        let tolerance = self.g / 2.0;
        let net_clearance = self.net_clearance.get(net).copied().unwrap_or(self.min_clearance);
        let half = if via { self.net_via.get(net).copied().unwrap_or(0.45) / 2.0 } else { self.min_width / 2.0 };
        let mut out = self.board_mask(window, self.edge_clearance + half - tolerance).inverted();
        let mut own = if owners { vec![-1; out.cells.len()] } else { Vec::new() };
        for k in 0..self.items.len() {
            let item = &self.items[k];
            if !item.on_layer(layer) || (!item.net.is_empty() && item.net == net) {
                continue;
            }
            let r = match item.kind {
                ItemKind::KeepVia if !via => continue,
                ItemKind::KeepTrack | ItemKind::KeepVia => (half - tolerance).max(0.0),
                _ => net_clearance.max(item.clearance) + half - tolerance,
            };
            let Some(mask) = self.item_mask(k, r) else { continue };
            let mut hits = Vec::new();
            out.for_shared(&mask, |mine, theirs| {
                if mask.cells[theirs] {
                    hits.push(mine);
                }
            });
            for at in hits {
                out.cells[at] = true;
                if owners {
                    own[at] = k as i32;
                }
            }
        }
        (out, own)
    }

    pub fn net_grids(&mut self, net: &str, window: Window, owners: bool) -> NetGrids {
        let (mut free, mut own) = (Vec::new(), Vec::new());
        for layer in 0..self.layers.len() {
            let (blocked, who) = self.blocked(net, layer, window, false, owners);
            free.push(blocked.inverted());
            own.push(who);
        }
        let mut via_ok = Mask::filled(window, self.layers.len() > 1);
        if self.layers.len() > 1 {
            for layer in 0..self.layers.len() {
                via_ok = via_ok.and(&self.blocked(net, layer, window, true, false).0.inverted());
            }
        }
        NetGrids { free, via_ok, owners: own }
    }

    /// The cells of the item's own copper in a window.
    pub fn own_cells(&mut self, k: usize, window: Window) -> Mask {
        let mut out = Mask::filled(window, false);
        if let Some(mask) = self.item_mask(k, 0.0) {
            out.merge(&mask);
        }
        out
    }

    /// The item's copper per layer, as flood and search seeds.
    pub fn item_seed(&mut self, k: usize, window: Window) -> Vec<Mask> {
        let cells = self.own_cells(k, window);
        (0..self.layers.len()).map(|l| if self.items[k].on_layer(l) { cells.clone() } else { Mask::filled(window, false) }).collect()
    }

    /// The pads of a net; none when it has no pad.
    pub fn pads_of(&self, net: &str) -> &[NetPad] {
        self.net_pads.iter().find(|(n, _)| n == net).map_or(&[], |(_, pads)| pads)
    }

    pub fn pad(&self, at: &NetPad) -> (&'a Footprint, &'a Pad) {
        let footprint = &self.board.footprints[at.footprint];
        (footprint, &footprint.pads[at.pad])
    }
}

/// False once a point is closer to the outline than `margin`. The squared test spares the root for far edges; it decides nothing
/// near the limit.
fn clear_of(x: f64, y: f64, points: &[Point], margin: f64, limit: f64) -> bool {
    points.iter().enumerate().all(|(k, &(a, b))| {
        let (c, d) = points[(k + points.len() - 1) % points.len()];
        let (lo_x, hi_x, lo_y, hi_y) = (a.min(c), a.max(c), b.min(d), b.max(d));
        let (dx, dy) = ((lo_x - x).max(x - hi_x).max(0.0), (lo_y - y).max(y - hi_y).max(0.0));
        dx * dx + dy * dy > limit || seg_dist(x, y, [a, b, c, d]) >= margin
    })
}

/// A pad KiCad gave no polygon for, because its uuid repeats: its box.
fn box_ring(pad: &Pad) -> Vec<Point> {
    let b = pad.bbox;
    ring_mm(&[Pt::new(b.left, b.top), Pt::new(b.right, b.top), Pt::new(b.right, b.bottom), Pt::new(b.left, b.bottom)])
}

/// An arc track as a polygon: its chords walked out on one side and back on the other, at half its width.
fn arc_ring(t: &crate::kicad::board::Track) -> Vec<Point> {
    use crate::kicad::geom::outline::arc_points;
    use crate::kicad::shape::Arc;
    let arc = Arc::through(t.start, t.mid.expect("an arc has a mid point"), t.end);
    let r = arc.radius() as f64;
    let half = t.width as f64 / 2.0;
    let scaled = |p: Pt, factor: f64| {
        let d = p - arc.center;
        (to_mm(arc.center.x) + to_mm(d.x) * factor, to_mm(arc.center.y) + to_mm(d.y) * factor)
    };
    let points = arc_points(&arc, t.width);
    let outer = points.iter().map(|p| scaled(*p, (r + half) / r));
    let inner = points.iter().rev().map(|p| scaled(*p, (r - half).max(0.0) / r));
    outer.chain(inner).collect()
}
