//! Via room: a pad on a via net (pr.via_nets) needs one free site of the 16 that `gnd_pad_vias` tries.
//! A site is blocked by pad copper of another net, by the board edge, or by a no-via rule area.

use crate::geom::{EPS, Point, TaggedRect, point_in_poly, poly_edge_d2};
use crate::layout::Layout;
use crate::model::Model;
use crate::params::Params;
use crate::problem::Board;
use std::collections::BTreeSet;

/// Via site distance beyond the pad edge + via radius.
const EXTRA: [f64; 2] = [0.2, 0.5];
const DIRS: [(f64, f64); 8] =
    [(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0), (1.0, 1.0), (-1.0, 1.0), (1.0, -1.0), (-1.0, -1.0)];
/// Site grid pitch.
const CELL: f64 = 0.1;
/// Net code of a no-via rule area that moves with a unit: it blocks within the via radius only.
const RULE_AREA: f64 = -1.0;

/// Via centres the board allows, on a 0.1 mm grid.
pub struct ViaSites {
    x0: f64,
    y0: f64,
    nx: usize,
    ny: usize,
    ok: Vec<bool>,
}

impl ViaSites {
    pub fn new(board: &Board, via_radius: f64) -> Self {
        let b = board.outline_box();
        let nx = ((b.x1 - b.x0) / CELL).ceil() as usize + 1;
        let ny = ((b.y1 - b.y0) / CELL).ceil() as usize + 1;
        let edge = board.edge_clearance + via_radius;
        let free = |p: Point| {
            point_in_poly(p, &board.outline)
                && poly_edge_d2(p, &board.outline) >= edge * edge - EPS
                && board.via_keepouts.iter().all(|k| {
                    !point_in_poly(p, k) && poly_edge_d2(p, k) >= via_radius * via_radius - EPS
                })
        };
        let at = |n: usize, origin: f64| origin + n as f64 * CELL;
        let ok = (0..ny).flat_map(|j| (0..nx).map(move |i| (i, j))).map(|(i, j)| free((at(i, b.x0), at(j, b.y0)))).collect();
        Self { x0: b.x0, y0: b.y0, nx, ny, ok }
    }

    fn allows(&self, (x, y): Point) -> bool {
        let i = ((x - self.x0) / CELL).round_ties_even();
        let j = ((y - self.y0) / CELL).round_ties_even();
        let on = i >= 0.0 && j >= 0.0 && (i as usize) < self.nx && (j as usize) < self.ny;
        on && self.ok[j as usize * self.nx + i as usize]
    }
}

/// Distance beyond a pad box within which copper can block its via sites.
pub fn reach(p: &Params) -> f64 {
    EXTRA[1] + p.via_d + p.via_clr
}

fn site_free(site: Point, pad_net: f64, obstacles: &[TaggedRect], p: &Params) -> bool {
    let radius = p.via_d / 2.0;
    let keep = radius + p.via_clr;
    obstacles.iter().filter(|o| o.value != pad_net).all(|o| {
        let g = if o.value == RULE_AREA { radius } else { keep };
        let (dx, dy) = o.rect.axis_gaps(site);
        dx * dx + dy * dy >= g * g - EPS
    })
}

fn pad_has_site(pad: &TaggedRect, obstacles: &[TaggedRect], sites: &ViaSites, p: &Params) -> bool {
    let rv = p.via_d / 2.0;
    let (cx, cy) = pad.rect.centre();
    let (hx, hy) = (pad.rect.width() / 2.0, pad.rect.height() / 2.0);
    EXTRA.iter().flat_map(|e| DIRS.iter().map(move |d| (d, e))).any(|(&(dx, dy), e)| {
        let site = (cx + dx * (hx + rv + e), cy + dy * (hy + rv + e));
        sites.allows(site) && site_free(site, pad.value, obstacles, p)
    })
}

/// Via pads of unit i with no free site.
fn blocked(model: &Model, at: &Layout, i: usize) -> i64 {
    let (Some(sites), shape) = (&model.via_sites, &model.units[i]) else { return 0 };
    if !shape.via_pad.iter().any(|v| *v) {
        return 0;
    }
    let near = at.copper_near(at.copper_box[i], model.via_reach);
    let obstacles: Vec<TaggedRect> = near.flat_map(|k| at.copper(model, k)).collect();
    let pads = at.copper(model, i);
    let via_pads = pads.iter().zip(&shape.via_pad).filter(|(_, v)| **v).map(|(pad, _)| pad);
    via_pads.filter(|pad| !pad_has_site(pad, &obstacles, sites, &model.params)).count() as i64
}

/// Blocked via pads per unit of the current layout.
pub struct ViaState {
    counts: Vec<i64>,
    /// Units whose count may change with the moved units, gathered before the move.
    affected: BTreeSet<usize>,
    undo: Vec<(usize, i64)>,
}

impl ViaState {
    pub fn new(model: &Model, at: &Layout) -> Self {
        let counts = (0..model.units.len()).map(|i| blocked(model, at, i)).collect();
        Self { counts, affected: BTreeSet::new(), undo: Vec::new() }
    }

    pub fn total(&self) -> f64 {
        self.counts.iter().sum::<i64>() as f64
    }

    fn gather(&mut self, model: &Model, at: &Layout, moved: &[usize]) {
        for &i in moved {
            let near = at.copper_near(at.copper_box[i], model.via_reach);
            self.affected.extend(near.filter(|&j| model.units[j].via_pad.iter().any(|v| *v)));
        }
    }

    pub fn before_move(&mut self, model: &Model, at: &Layout, moved: &[usize]) {
        self.affected.clear();
        if model.via_sites.is_some() {
            self.gather(model, at, moved);
        }
    }

    /// Recount after the move. Returns the change of the total.
    pub fn after_move(&mut self, model: &Model, at: &Layout, moved: &[usize]) -> f64 {
        self.undo.clear();
        if model.via_sites.is_none() {
            return 0.0;
        }
        self.gather(model, at, moved);
        let mut delta = 0;
        for &j in &self.affected {
            let count = blocked(model, at, j);
            self.undo.push((j, self.counts[j]));
            delta += count - self.counts[j];
            self.counts[j] = count;
        }
        delta as f64
    }

    pub fn revert(&mut self) {
        for &(j, count) in &self.undo {
            self.counts[j] = count;
        }
    }
}
