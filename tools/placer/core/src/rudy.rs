//! Net length and RUDY congestion (Spindler, DATE 2007): each net spreads its HPWL evenly over the cells of its box,
//! times its track factor. Capacity per cell = cell area * layers / pitch; overflow = the demand above limit * capacity.

use crate::geom::{Point, Rect};
use crate::layout::Layout;
use crate::mask::cell_range;
use crate::model::Model;
use crate::numeric::{compensated, hypot, pairwise};
use crate::params::Params;
use crate::problem::{Net, Problem};

/// The routing layers; copper on other layers uses no RUDY capacity.
const ROUTE_LAYERS: [&str; 2] = ["F.Cu", "B.Cu"];

/// RUDY grid over the outline box.
pub struct Grid {
    pub x0: f64,
    pub y0: f64,
    pub cell: f64,
    pub nx: usize,
    pub ny: usize,
}

/// A clipped cell slice, rows j0..j1 and columns i0..i1.
#[derive(Clone, Copy, Debug)]
pub struct Span {
    pub j0: usize,
    pub j1: usize,
    pub i0: usize,
    pub i1: usize,
}

impl Span {
    fn cells(self) -> usize {
        (self.j1 - self.j0) * (self.i1 - self.i0)
    }

    fn union(self, o: Self) -> Self {
        Self { j0: self.j0.min(o.j0), j1: self.j1.max(o.j1), i0: self.i0.min(o.i0), i1: self.i1.max(o.i1) }
    }
}

impl Grid {
    pub fn new(b: Rect, cell: f64) -> Self {
        let n = |len: f64| ((len / cell - crate::geom::EPS).ceil() as i64).max(1) as usize;
        Self { x0: b.x0, y0: b.y0, cell, nx: n(b.x1 - b.x0), ny: n(b.y1 - b.y0) }
    }

    fn span(&self, b: Rect) -> Option<Span> {
        let (_, _, i0, i1) = cell_range(b.x0, b.x1, self.x0, self.cell, self.nx);
        let (_, _, j0, j1) = cell_range(b.y0, b.y1, self.y0, self.cell, self.ny);
        (i1 > i0 && j1 > j0).then_some(Span { j0: j0 as usize, j1: j1 as usize, i0: i0 as usize, i1: i1 as usize })
    }

    /// Flat index of the cell of a point, None off the grid.
    fn index(&self, (x, y): Point) -> Option<usize> {
        let i = ((x - self.x0) / self.cell).floor();
        let j = ((y - self.y0) / self.cell).floor();
        let on = i >= 0.0 && j >= 0.0 && (i as usize) < self.nx && (j as usize) < self.ny;
        on.then(|| j as usize * self.nx + i as usize)
    }

    fn all(&self) -> Span {
        Span { j0: 0, j1: self.ny, i0: 0, i1: self.nx }
    }

    /// RUDY demand of the kept copper (mm of wire per cell). A track on a routing layer uses its length *
    /// (width + gap) / pitch; a via uses (diameter + gap)^2 / pitch on each routing layer.
    pub fn kept_copper_demand(&self, pr: &Problem, p: &Params) -> Vec<f64> {
        let mut g = vec![0.0; self.nx * self.ny];
        let mut add = |at: Point, v: f64| {
            if let Some(c) = self.index(at) {
                g[c] += v;
            }
        };
        for row in &pr.board.copper {
            let (a0, b0, a1, b1, w) = (row.1, row.2, row.3, row.4, row.5);
            if row.0 == "via" {
                add((a0, b0), (w + p.gap).powf(2.0) / p.pitch * p.layers);
            } else if ROUTE_LAYERS.contains(&row.0.as_str()) {
                let length = hypot(a1 - a0, b1 - b0);
                let n = ((length / (self.cell / 4.0)).ceil() as i64).max(1);
                for k in 0..n {
                    let f = (k as f64 + 0.5) / n as f64;
                    add((a0 + f * (a1 - a0), b0 + f * (b1 - b0)), length / n as f64 * (w + p.gap) / p.pitch);
                }
            }
        }
        g
    }

    /// Cell weights of the region box; None without a region.
    pub fn cell_weights(&self, pr: &Problem) -> Option<Vec<f64>> {
        let region = pr.region.as_ref()?;
        let area = region.area?;
        let centre = |origin: f64, n: usize| origin + (n as f64 + 0.5) * self.cell;
        let mut w = vec![1.0; self.nx * self.ny];
        for j in (0..self.ny).filter(|&j| (area.y0..=area.y1).contains(&centre(self.y0, j))) {
            for i in (0..self.nx).filter(|&i| (area.x0..=area.x1).contains(&centre(self.x0, i))) {
                w[j * self.nx + i] = region.weight;
            }
        }
        Some(w)
    }
}

/// RUDY demand factor of a net: its track over the routing pitch with params tracks = 1, else 1.
pub fn track_factor(net: &Net, p: &Params) -> f64 {
    if net.cohesion {
        return 0.0;
    }
    match net.track {
        Some(track) if p.tracks != 0.0 => track / p.pitch,
        _ => 1.0,
    }
}

/// The pin boxes of a net for the 4 turns.
pub struct NetShape {
    pub pins: Vec<(usize, [Rect; 4])>,
    pub weight: f64,
    pub factor: f64,
}

impl NetShape {
    pub fn new(net: &Net, p: &Params) -> Self {
        let pins = net.pins.iter().map(|q| (q.unit, q.rect.turns())).collect();
        Self { pins, weight: net.weight, factor: track_factor(net, p) }
    }

    fn bounds(&self, at: &Layout) -> Rect {
        let world = self.pins.iter().map(|(u, turns)| turns[at.r[*u] as usize].shifted(at.x[*u], at.y[*u]));
        Rect::bounding(world).expect("a net has pins")
    }
}

/// A net's spread on the grid.
#[derive(Clone, Copy)]
struct Stamp {
    span: Span,
    value: f64,
}

#[derive(Clone, Copy)]
struct NetRecord {
    length: f64,
    stamp: Option<Stamp>,
}

struct Undo {
    nets: Vec<(usize, NetRecord)>,
    saved: Option<(Span, Vec<f64>)>,
}

/// HPWL and congestion of the current layout.
pub struct NetState {
    pub demand: Vec<f64>,
    records: Vec<NetRecord>,
    /// Pad cells of the moved units before the move.
    pad_cells_before: Vec<Vec<usize>>,
    undo: Option<Undo>,
}

impl NetState {
    pub fn new(model: &Model, at: &Layout) -> Self {
        let mut s = Self { demand: model.kept_demand.clone(), records: Vec::new(), pad_cells_before: Vec::new(), undo: None };
        for i in 0..model.units.len() {
            for c in pad_cells(model, at, i) {
                s.demand[c] += model.params.pin_demand;
            }
        }
        for net in &model.nets {
            let record = record(model, net, at);
            if let Some(st) = record.stamp {
                s.add(model, st.span, st.value);
            }
            s.records.push(record);
        }
        s
    }

    fn add(&mut self, model: &Model, span: Span, v: f64) {
        for j in span.j0..span.j1 {
            let row = j * model.grid.nx;
            self.demand[row + span.i0..row + span.i1].iter_mut().for_each(|c| *c += v);
        }
    }

    pub fn wirelength(&self, model: &Model) -> f64 {
        compensated(model.nets.iter().zip(&self.records).map(|(n, r)| n.weight * r.length))
    }

    /// Demand above the limit over a span.
    fn excess(&self, model: &Model, s: Span) -> f64 {
        let nx = model.grid.nx;
        let mut cells = Vec::with_capacity(s.cells());
        for j in s.j0..s.j1 {
            for c in j * nx + s.i0..j * nx + s.i1 {
                let over = (self.demand[c] - model.threshold).max(0.0);
                cells.push(model.cell_weights.as_ref().map_or(over, |w| over * w[c]));
            }
        }
        pairwise(&cells)
    }

    pub fn overflow(&self, model: &Model) -> f64 {
        self.excess(model, model.grid.all())
    }

    /// Largest requested fraction of routing capacity, before overflow clipping.
    /// Unlike overflow this distinguishes sparse poses below the existing limit.
    pub fn peak_utilization(&self, model: &Model) -> f64 {
        let capacity = model.params.rudy_cell.powi(2) * model.params.layers / model.params.pitch;
        self.demand.iter().enumerate().map(|(i, demand)| {
            demand * model.cell_weights.as_ref().map_or(1.0, |w| w[i]) / capacity
        }).fold(0.0, f64::max)
    }

    /// Call before the units move: pin demand needs the old pad cells.
    pub fn before_move(&mut self, model: &Model, at: &Layout, moved: &[usize]) {
        self.pad_cells_before.clear();
        if model.params.pin_demand != 0.0 {
            self.pad_cells_before.extend(moved.iter().map(|&i| pad_cells(model, at, i)));
        }
    }

    /// Update the given nets (sorted) after a move. Returns (HPWL delta, congestion delta).
    pub fn after_move(&mut self, model: &Model, at: &Layout, moved: &[usize], nets: &[usize]) -> (f64, f64) {
        let mut dwl = 0.0;
        let mut old = Vec::with_capacity(nets.len());
        let mut new = Vec::with_capacity(nets.len());
        for &k in nets {
            let net = &model.nets[k];
            let next = record(model, net, at);
            dwl += net.weight * (next.length - self.records[k].length);
            old.push((k, self.records[k]));
            new.push(next);
            self.records[k].length = next.length;
        }
        let pad_after: Vec<Vec<usize>> = if model.params.pin_demand != 0.0 {
            moved.iter().map(|&i| pad_cells(model, at, i)).collect()
        } else {
            Vec::new()
        };
        let touched = old.iter().filter_map(|(_, r)| r.stamp).chain(new.iter().filter_map(|r| r.stamp)).map(|s| s.span);
        let pads = self.pad_cells_before.iter().chain(&pad_after).filter_map(|c| cells_span(model, c));
        let Some(region) = touched.chain(pads).reduce(Span::union) else {
            self.undo = Some(Undo { nets: old, saved: None });
            return (dwl, 0.0);
        };
        let before = self.excess(model, region);
        let saved = (region, self.copy_of(model, region));
        for (&(k, rec), next) in old.iter().zip(&new) {
            if let Some(s) = rec.stamp {
                self.add(model, s.span, -s.value);
            }
            if let Some(s) = next.stamp {
                self.add(model, s.span, s.value);
            }
            self.records[k].stamp = next.stamp;
        }
        for (a, b) in self.pad_cells_before.iter().zip(&pad_after) {
            a.iter().for_each(|&c| self.demand[c] -= model.params.pin_demand);
            b.iter().for_each(|&c| self.demand[c] += model.params.pin_demand);
        }
        let dcong = self.excess(model, region) - before;
        self.undo = Some(Undo { nets: old, saved: Some(saved) });
        (dwl, dcong)
    }

    fn copy_of(&self, model: &Model, s: Span) -> Vec<f64> {
        let nx = model.grid.nx;
        (s.j0..s.j1).flat_map(|j| self.demand[j * nx + s.i0..j * nx + s.i1].iter().copied()).collect()
    }

    pub fn commit(&mut self) {
        self.undo = None;
    }

    pub fn revert(&mut self, model: &Model) {
        let Some(undo) = self.undo.take() else { return };
        for (k, rec) in undo.nets {
            self.records[k] = rec;
        }
        if let Some((s, cells)) = undo.saved {
            let (nx, w) = (model.grid.nx, s.i1 - s.i0);
            for (row, j) in cells.chunks_exact(w).zip(s.j0..s.j1) {
                self.demand[j * nx + s.i0..j * nx + s.i1].copy_from_slice(row);
            }
        }
    }
}

fn record(model: &Model, net: &NetShape, at: &Layout) -> NetRecord {
    let b = net.bounds(at);
    let length = b.width() + b.height();
    let stamp = model.grid.span(b).filter(|_| length > 0.0).map(|span| Stamp {
        span,
        value: net.factor * length / span.cells() as f64,
    });
    NetRecord { length, stamp }
}

/// Grid cells of the pads of unit i, with pin demand on.
fn pad_cells(model: &Model, at: &Layout, i: usize) -> Vec<usize> {
    let local = &model.units[i].pad_points[at.r[i] as usize];
    local.iter().filter_map(|p| model.grid.index((p.0 + at.x[i], p.1 + at.y[i]))).collect()
}

/// The span around flat cells.
fn cells_span(model: &Model, cells: &[usize]) -> Option<Span> {
    let nx = model.grid.nx;
    cells.iter().map(|&c| Span { j0: c / nx, j1: c / nx + 1, i0: c % nx, i1: c % nx + 1 }).reduce(Span::union)
}
