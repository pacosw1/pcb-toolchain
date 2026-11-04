//! Analytic global placement (ePlace / RePlAce style) before the annealer.
//!
//! Objective: WA wirelength (weighted-average smooth HPWL, pin centres) + lambda * electrostatic density energy.
//!   Density: each unit is its courtyard box grown by half its clearance, spread over a bins x bins grid on the outline
//!   box. Fixed units, the area outside the outline and the keepouts are fixed charge. The potential solves the Poisson
//!   equation with a cosine (DCT) basis; the density gradient of a unit is minus its charge times the field.
//!   Nesterov descent with a Lipschitz step estimate (a unit moves at most max_move bin widths per step), a diagonal
//!   preconditioner (pins + lambda * area) and a growing lambda (x mu per iteration) until the overflow is below
//!   stop_overflow.
//!   Routability (RePlAce): each time the overflow falls below route_overflow (route_rounds times), the units in bins
//!   with RUDY above the routing capacity grow in area (inflate, at most max_infl in total).
//!   Start: all movable units at the outline box centre with a small jitter (init centre), or at their places (init
//!   pose). Fixed units do not move; each unit stays inside the outline box; an edge-anchored unit goes back to its
//!   nearest allowed side. The result is not legal: the annealer runs after it, at a low temperature.

use crate::geom::{Point, Rect, point_in_poly, turn_point};
use crate::numeric::{Pcg64, pairwise};
use crate::params::Params;
use crate::problem::{Pose, Problem};
use crate::rudy::track_factor;
use crate::search::GlobalStage;

/// Oversampling per bin axis of the fixed charge of outline and keepouts.
const SAMPLES: usize = 4;

/// A dense row-major matrix.
#[derive(Clone)]
struct Matrix {
    rows: usize,
    cols: usize,
    data: Vec<f64>,
}

impl Matrix {
    fn zeros(rows: usize, cols: usize) -> Self {
        Self { rows, cols, data: vec![0.0; rows * cols] }
    }

    fn from_fn(rows: usize, cols: usize, f: impl Fn(usize, usize) -> f64) -> Self {
        let data = (0..rows).flat_map(|i| (0..cols).map(move |j| (i, j))).map(|(i, j)| f(i, j)).collect();
        Self { rows, cols, data }
    }

    fn at(&self, i: usize, j: usize) -> f64 {
        self.data[i * self.cols + j]
    }

    fn transposed(&self) -> Self {
        Self::from_fn(self.cols, self.rows, |i, j| self.at(j, i))
    }

    fn times(&self, o: &Self) -> Self {
        let mut out = Self::zeros(self.rows, o.cols);
        for i in 0..self.rows {
            for k in 0..self.cols {
                let a = self.at(i, k);
                let row = &o.data[k * o.cols..(k + 1) * o.cols];
                out.data[i * o.cols..(i + 1) * o.cols].iter_mut().zip(row).for_each(|(c, b)| *c += a * b);
            }
        }
        out
    }

    fn map(&self, f: impl Fn(usize, usize, f64) -> f64) -> Self {
        Self::from_fn(self.rows, self.cols, |i, j| f(i, j, self.at(i, j)))
    }
}

/// a[i, :] M b[i, :] for each row i.
fn sandwiched(a: &Matrix, m: &Matrix, b: &Matrix) -> Vec<f64> {
    let am = a.times(m);
    (0..a.rows).map(|i| (0..b.cols).map(|l| am.at(i, l) * b.at(i, l)).sum()).collect()
}

fn linspace(a: f64, b: f64, n: usize) -> Vec<f64> {
    let step = (b - a) / n as f64;
    let mut v: Vec<f64> = (0..=n).map(|i| i as f64 * step + a).collect();
    v[n] = b;
    v
}

/// A unit in the model.
struct Body {
    /// Rect box grown by half the clearance, at turn 0.
    grown: Rect,
    bare: Rect,
    inflation: f64,
    /// Offsets of the density box from the origin.
    offsets: Rect,
    area: f64,
}

impl Body {
    fn scale(&mut self, infl: f64) {
        let b = self.grown;
        let (cx, cy) = b.centre();
        let f = infl * self.inflation.sqrt();
        self.offsets = Rect::new(cx - (cx - b.x0) * f, cy - (cy - b.y0) * f, cx + (b.x1 - cx) * f, cy + (b.y1 - cy) * f);
        self.area = self.offsets.width() * self.offsets.height();
    }
}

struct PinRow {
    unit: usize,
    net: usize,
    dx: f64,
    dy: f64,
}

struct Model<'a> {
    pr: &'a Problem,
    p: &'a Params,
    bodies: Vec<Body>,
    x0: Vec<f64>,
    y0: Vec<f64>,
    movable: Vec<usize>,
    fixed: Vec<usize>,
    pins: Vec<PinRow>,
    net_weight: Vec<f64>,
    net_factor: Vec<f64>,
    unit_pins: Vec<f64>,
    bounds: Rect,
    bins: usize,
    ex: Vec<f64>,
    ey: Vec<f64>,
    bin_w: f64,
    bin_h: f64,
    bin_area: f64,
    wu: Vec<f64>,
    wv: Vec<f64>,
    cx: Matrix,
    sx: Matrix,
    cy: Matrix,
    sy: Matrix,
    inverse: Matrix,
    charge: Matrix,
}

fn body(u: &crate::problem::Unit) -> Body {
    let grown = |q: &crate::geom::TaggedRect| q.rect.grown(q.value / 2.0);
    Body {
        grown: Rect::bounding(u.rects.iter().map(grown)).expect("a unit has rects"),
        bare: Rect::bounding(u.rects.iter().map(|q| q.rect)).expect("a unit has rects"),
        inflation: 1.0,
        offsets: Rect::new(0.0, 0.0, 0.0, 0.0),
        area: 0.0,
    }
}

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    v.max(lo).min(hi)
}

/// Overlap of a span with each bin.
fn bin_overlap(lo: f64, hi: f64, edges: &[f64], out: &mut [f64]) {
    for (k, slot) in out.iter_mut().enumerate() {
        *slot = (hi.min(edges[k + 1]) - lo.max(edges[k])).max(0.0);
    }
}

impl<'a> Model<'a> {
    fn new(pr: &'a Problem, p: &'a Params) -> Self {
        let bins = p.bins as usize;
        let b = pr.board.outline_box();
        let (bin_w, bin_h) = ((b.x1 - b.x0) / bins as f64, (b.y1 - b.y0) / bins as f64);
        let ex = linspace(b.x0, b.x1, bins);
        let ey = linspace(b.y0, b.y1, bins);
        let centres = |e: &[f64], o: f64| -> Vec<f64> { e.windows(2).map(|w| (w[0] + w[1]) / 2.0 - o).collect() };
        let (xc, yc) = (centres(&ex, b.x0), centres(&ey, b.y0));
        let wu: Vec<f64> = (0..bins).map(|i| std::f64::consts::PI * i as f64 / (b.x1 - b.x0)).collect();
        let wv: Vec<f64> = (0..bins).map(|i| std::f64::consts::PI * i as f64 / (b.y1 - b.y0)).collect();
        let trig = |c: &[f64], w: &[f64], f: fn(f64) -> f64| Matrix::from_fn(bins, bins, |i, j| f(c[i] * w[j]));
        let inverse = Matrix::from_fn(bins, bins, |i, j| {
            if i + j == 0 { 0.0 } else { 1.0 / (wu[i].powf(2.0) + wv[j].powf(2.0)) }
        });
        let mut pins = Vec::new();
        for (k, net) in pr.nets.iter().enumerate() {
            pins.extend(net.pins.iter().map(|q| {
                let (dx, dy) = q.rect.centre();
                PinRow { unit: q.unit, net: k, dx, dy }
            }));
        }
        let mut unit_pins = vec![0.0; pr.units.len()];
        pins.iter().for_each(|q| unit_pins[q.unit] += 1.0);
        let mut bodies: Vec<Body> = pr.units.iter().map(body).collect();
        bodies.iter_mut().for_each(|u| u.scale(p.infl));
        let mut m = Self {
            pr,
            p,
            bodies,
            x0: pr.units.iter().map(|u| u.x).collect(),
            y0: pr.units.iter().map(|u| u.y).collect(),
            movable: (0..pr.units.len()).filter(|&i| !pr.units[i].fixed).collect(),
            fixed: (0..pr.units.len()).filter(|&i| pr.units[i].fixed).collect(),
            pins,
            net_weight: pr.nets.iter().map(|n| n.weight).collect(),
            net_factor: pr.nets.iter().map(|n| track_factor(n, p)).collect(),
            unit_pins,
            bounds: b,
            bins,
            cx: trig(&xc, &wu, f64::cos),
            sx: trig(&xc, &wu, f64::sin),
            cy: trig(&yc, &wv, f64::cos),
            sy: trig(&yc, &wv, f64::sin),
            ex,
            ey,
            bin_w,
            bin_h,
            bin_area: bin_w * bin_h,
            wu,
            wv,
            inverse,
            charge: Matrix::zeros(bins, bins),
        };
        m.charge = m.fixed_charge();
        m
    }

    /// Per-unit bin overlaps on x and y of the given units.
    fn overlaps(&self, x: &[f64], y: &[f64], units: &[usize]) -> (Matrix, Matrix) {
        let (mut ax, mut ay) = (Matrix::zeros(units.len(), self.bins), Matrix::zeros(units.len(), self.bins));
        for (row, &i) in units.iter().enumerate() {
            let o = self.bodies[i].offsets;
            let span = row * self.bins..(row + 1) * self.bins;
            bin_overlap(x[i] + o.x0, x[i] + o.x1, &self.ex, &mut ax.data[span.clone()]);
            bin_overlap(y[i] + o.y0, y[i] + o.y1, &self.ey, &mut ay.data[span]);
        }
        (ax, ay)
    }

    /// Fixed charge per bin (area): fixed units, outside the outline, keepouts.
    fn fixed_charge(&self) -> Matrix {
        let (ax, ay) = self.overlaps(&self.x0, &self.y0, &self.fixed);
        let mut f = ax.transposed().times(&ay);
        let n = self.bins * SAMPLES;
        let at = |origin: f64, k: usize, bin: f64| origin + (k as f64 + 0.5) * bin / SAMPLES as f64;
        let board = &self.pr.board;
        let blocked = |p: Point| !point_in_poly(p, &board.outline) || board.keepouts.iter().any(|k| point_in_poly(p, k));
        let mut counts = vec![0.0; self.bins * self.bins];
        for i in 0..n {
            for j in 0..n {
                if blocked((at(self.bounds.x0, i, self.bin_w), at(self.bounds.y0, j, self.bin_h))) {
                    counts[(i / SAMPLES) * self.bins + j / SAMPLES] += 1.0;
                }
            }
        }
        let share = self.bin_area / (SAMPLES * SAMPLES) as f64;
        f.data.iter_mut().zip(&counts).for_each(|(c, n)| *c += n * share);
        f
    }

    /// RUDY per bin (mm of track per mm2): each net spreads (w + h) * weight * track factor uniformly over its pin box.
    fn rudy(&self, x: &[f64], y: &[f64]) -> Matrix {
        let nets = self.net_weight.len();
        let mut boxes: Vec<Option<Rect>> = vec![None; nets];
        let mut count = vec![0; nets];
        for q in &self.pins {
            let (px, py) = (x[q.unit] + q.dx, y[q.unit] + q.dy);
            let pin = Rect::new(px, py, px, py);
            boxes[q.net] = Rect::bounding(boxes[q.net].into_iter().chain([pin]));
            count[q.net] += 1;
        }
        let spread: Vec<(Rect, f64)> = (0..nets)
            .filter(|&k| count[k] > 1)
            .filter_map(|k| boxes[k].map(|b| (b, k)))
            .map(|(b, k)| {
                let b = Rect::new(b.x0, b.y0, b.x1.max(b.x0 + self.bin_w), b.y1.max(b.y0 + self.bin_h));
                let w = self.net_weight[k] * self.net_factor[k];
                (b, w * (b.width() + b.height()) / (b.width() * b.height()))
            })
            .collect();
        let (mut ax, mut ay) = (Matrix::zeros(spread.len(), self.bins), Matrix::zeros(spread.len(), self.bins));
        for (row, (b, density)) in spread.iter().enumerate() {
            let span = row * self.bins..(row + 1) * self.bins;
            bin_overlap(b.x0, b.x1, &self.ex, &mut ax.data[span.clone()]);
            bin_overlap(b.y0, b.y1, &self.ey, &mut ay.data[span.clone()]);
            ax.data[span].iter_mut().for_each(|v| *v *= density);
        }
        ax.transposed().times(&ay).map(|_, _, v| v / self.bin_area)
    }

    /// RePlAce cell inflation: each movable unit grows in area by its overlap-weighted RUDY over the routing capacity,
    /// clipped to [1, max_infl] in total.
    fn inflate(&mut self, x: &[f64], y: &[f64]) {
        let capacity = self.p.limit * self.p.layers / self.p.pitch;
        let r = self.rudy(x, y);
        let (ax, ay) = self.overlaps(x, y, &self.movable);
        let weighted = sandwiched(&ax, &r, &ay);
        for (row, &i) in self.movable.clone().iter().enumerate() {
            let row_sum = |m: &Matrix| (0..m.cols).map(|k| m.at(row, k)).sum::<f64>();
            let a = row_sum(&ax) * row_sum(&ay);
            let f = (weighted[row] / a.max(1e-12) / capacity).max(1.0);
            let u = &mut self.bodies[i];
            u.inflation *= (u.inflation * f).min(self.p.max_infl) / u.inflation;
        }
        self.bodies.iter_mut().for_each(|u| u.scale(self.p.infl));
    }

    /// Weighted-average wirelength and its gradient on one axis (fixed units get 0).
    fn wa_axis(&self, pos: &[f64], offset: impl Fn(&PinRow) -> f64, gamma: f64) -> (f64, Vec<f64>) {
        let q: Vec<f64> = self.pins.iter().map(|r| pos[r.unit] + offset(r)).collect();
        let nets = self.net_weight.len();
        let mut total = 0.0;
        let mut dq = vec![0.0; q.len()];
        for s in [1.0, -1.0] {
            let a: Vec<f64> = q.iter().map(|v| s * v / gamma).collect();
            let mut top = vec![f64::NEG_INFINITY; nets];
            self.pins.iter().zip(&a).for_each(|(r, v)| top[r.net] = top[r.net].max(*v));
            let e: Vec<f64> = self.pins.iter().zip(&a).map(|(r, v)| (v - top[r.net]).exp()).collect();
            let (mut sum, mut moment) = (vec![0.0; nets], vec![0.0; nets]);
            for (k, r) in self.pins.iter().enumerate() {
                sum[r.net] += e[k];
                moment[r.net] += q[k] * e[k];
            }
            let w: Vec<f64> = (0..nets).map(|k| if sum[k] > 0.0 { moment[k] / sum[k] } else { 0.0 }).collect();
            let weighted: Vec<f64> = self.net_weight.iter().zip(&w).map(|(a, b)| a * b).collect();
            total += s * pairwise(&weighted);
            for (k, r) in self.pins.iter().enumerate() {
                dq[k] += s * self.net_weight[r.net] * e[k] / sum[r.net] * (1.0 + s * (q[k] - w[r.net]) / gamma);
            }
        }
        let mut grad = vec![0.0; pos.len()];
        self.pins.iter().zip(&dq).for_each(|(r, d)| grad[r.unit] += d);
        self.fixed.iter().for_each(|&i| grad[i] = 0.0);
        (total, grad)
    }

    /// (WA length, gradient) of the point.
    fn wa(&self, z: &State, gamma: f64) -> (f64, Vec<f64>) {
        let (tx, gx) = self.wa_axis(&z.x, |r| r.dx, gamma);
        let (ty, gy) = self.wa_axis(&z.y, |r| r.dy, gamma);
        (tx + ty, [gx, gy].concat())
    }

    /// (field x, field y) on the bin centres: Poisson with a cosine (DCT-II) basis.
    fn field(&self, rho: &Matrix) -> (Matrix, Matrix) {
        let scale = 4.0 / (self.bins * self.bins) as f64;
        let a = self.cx.transposed().times(rho).times(&self.cy).map(|i, j, v| {
            // the u = 0 and v = 0 modes have half weight in the inverse DCT-II (DREAMPlace)
            let half = |k: usize| if k == 0 { 0.5 } else { 1.0 };
            v * scale * half(i) * half(j)
        });
        let coef = a.map(|i, j, v| v * self.inverse.at(i, j));
        let cy_t = self.cy.transposed();
        let ex = self.sx.times(&coef.map(|i, _, v| v * self.wu[i])).times(&cy_t);
        let ey = self.cx.times(&coef.map(|_, j, v| v * self.wv[j])).times(&self.sy.transposed());
        (ex, ey)
    }

    /// (gradient, overflow) of the movable units in the fixed charge.
    fn density(&self, z: &State) -> (Vec<f64>, f64) {
        let (ax, ay) = self.overlaps(&z.x, &z.y, &self.movable);
        let d = ax.transposed().times(&ay);
        let rho = d.map(|i, j, v| (v + self.charge.at(i, j)) / self.bin_area);
        let (ex, ey) = self.field(&rho);
        let n = self.x0.len();
        let mut grad = vec![0.0; 2 * n];
        let (fx, fy) = (sandwiched(&ax, &ex, &ay), sandwiched(&ax, &ey, &ay));
        for (row, &i) in self.movable.iter().enumerate() {
            (grad[i], grad[n + i]) = (-fx[row], -fy[row]);
        }
        let excess: Vec<f64> =
            d.data.iter().zip(&self.charge.data).map(|(v, f)| (v - (self.p.target * self.bin_area - f).max(0.0)).max(0.0)).collect();
        let area: Vec<f64> = self.movable.iter().map(|&i| self.bodies[i].area).collect();
        (grad, pairwise(&excess) / pairwise(&area).max(1e-9))
    }

    /// ePlace smoothing: 8 bin widths x 10^(20/9 overflow - 11/9); a fixed gamma wins.
    fn gamma_for(&self, overflow: f64) -> f64 {
        let width = self.bin_w.max(self.bin_h);
        self.p.gamma.filter(|g| *g != 0.0).unwrap_or_else(|| 8.0 * width * 10.0_f64.powf(20.0 / 9.0 * overflow.min(1.0) - 11.0 / 9.0))
    }

    /// Fixed units back at their place, each unit box inside the outline box, edge anchors on a side.
    fn project(&self, z: &mut State) {
        for &i in &self.fixed {
            (z.x[i], z.y[i]) = (self.x0[i], self.y0[i]);
        }
        let b = self.bounds;
        for &i in &self.movable {
            let bare = self.bodies[i].bare;
            z.x[i] = clamp(z.x[i], b.x0 - bare.x0, (b.x1 - bare.x1).max(b.x0 - bare.x0));
            z.y[i] = clamp(z.y[i], b.y0 - bare.y0, (b.y1 - bare.y1).max(b.y0 - bare.y0));
            if let Some(e) = &self.pr.units[i].edge {
                let (dx, dy) = self.edge_step(e, (z.x[i], z.y[i]));
                z.x[i] += dx;
                z.y[i] += dy;
            }
        }
    }

    /// The shortest step of an anchor point to one of its sides.
    fn edge_step(&self, e: &crate::problem::EdgeAnchor, at: Point) -> Point {
        let b = self.bounds;
        let c = e.inset.unwrap_or(self.pr.board.edge_clearance);
        let (ax, ay) = turn_point(e.at, 0);
        let (px, py) = (at.0 + ax, at.1 + ay);
        let step = |side: char| match side {
            'L' => (b.x0 + c - px, 0.0),
            'R' => (b.x1 - c - px, 0.0),
            'T' => (0.0, b.y0 + c - py),
            _ => (0.0, b.y1 - c - py),
        };
        let length = |d: &Point| d.0.abs() + d.1.abs();
        e.sides.chars().map(step).reduce(|a, b| if length(&b) < length(&a) { b } else { a }).unwrap_or((0.0, 0.0))
    }
}

/// A point of the descent: all unit origins.
#[derive(Clone)]
struct State {
    x: Vec<f64>,
    y: Vec<f64>,
}

impl State {
    fn flat(&self) -> Vec<f64> {
        [self.x.as_slice(), self.y.as_slice()].concat()
    }

    fn from_flat(v: &[f64]) -> Self {
        let (x, y) = v.split_at(v.len() / 2);
        Self { x: x.to_vec(), y: y.to_vec() }
    }
}

fn norm(v: impl Iterator<Item = f64>) -> f64 {
    v.map(|a| a * a).sum::<f64>().sqrt()
}

fn abs_sum(v: &[f64]) -> f64 {
    pairwise(&v.iter().map(|a| a.abs()).collect::<Vec<_>>())
}

/// Start point: the board centre (init centre) or the current places, with a jitter that breaks the symmetry of stacked
/// units.
fn start(m: &Model) -> State {
    let mut rng = Pcg64::new(m.p.seed as u32);
    let mut z = State { x: m.x0.clone(), y: m.y0.clone() };
    if m.p.init == "centre" {
        let (cx, cy) = ((m.bounds.x0 + m.bounds.x1) / 2.0, (m.bounds.y0 + m.bounds.y1) / 2.0);
        m.movable.iter().for_each(|&i| (z.x[i], z.y[i]) = (cx, cy));
    }
    m.movable.iter().for_each(|&i| z.x[i] += rng.uniform(-0.5, 0.5) * m.bin_w);
    m.movable.iter().for_each(|&i| z.y[i] += rng.uniform(-0.5, 0.5) * m.bin_h);
    m.project(&mut z);
    z
}

/// One record of the descent.
#[derive(Clone, Copy, Debug)]
pub struct Iteration {
    pub wa: f64,
    pub overflow: f64,
    pub lambda: f64,
}

/// Nesterov state between iterations.
struct Descent {
    u: Vec<f64>,
    v: Vec<f64>,
    previous: Option<(Vec<f64>, Vec<f64>)>,
    a: f64,
    step: f64,
}

impl Descent {
    /// One preconditioned Nesterov step from v along g.
    fn advance(&mut self, m: &Model, g: Vec<f64>) {
        if let Some((v_prev, g_prev)) = &self.previous {
            let dg = norm(g.iter().zip(g_prev).map(|(a, b)| a - b));
            if dg > 0.0 {
                self.step = norm(self.v.iter().zip(v_prev).map(|(a, b)| a - b)) / dg;
            }
        }
        let limit = m.p.max_move * m.bin_w.max(m.bin_h);
        let moved = |(v, g): (&f64, &f64)| {
            let d = self.step * g;
            v - d / (d.abs() / limit).max(1.0)
        };
        let mut next = State::from_flat(&self.v.iter().zip(&g).map(moved).collect::<Vec<_>>());
        m.project(&mut next);
        let u_new = next.flat();
        let a_new = (1.0 + (4.0 * self.a * self.a + 1.0).sqrt()) / 2.0;
        let lookahead: Vec<f64> = u_new.iter().zip(&self.u).map(|(n, o)| n + (self.a - 1.0) / a_new * (n - o)).collect();
        let mut v = State::from_flat(&lookahead);
        m.project(&mut v);
        self.previous = Some((std::mem::replace(&mut self.v, v.flat()), g));
        self.u = u_new;
        self.a = a_new;
    }
}

fn preconditioned(m: &Model, gw: &[f64], gd: &[f64], lam: f64) -> Vec<f64> {
    let n = m.x0.len();
    let mut g: Vec<f64> = (0..2 * n)
        .map(|k| {
            let i = k % n;
            (gw[k] + lam * gd[k]) / (m.unit_pins[i] + lam * m.bodies[i].area).max(1e-9)
        })
        .collect();
    for &i in &m.fixed {
        (g[i], g[n + i]) = (0.0, 0.0);
    }
    g
}

/// The descent. Returns the final point and the iterations.
fn descend(m: &mut Model, log: &dyn Fn(&str)) -> (State, Vec<Iteration>) {
    let z0 = start(m);
    let eval = |m: &Model, z: &State, gamma: f64| {
        let (w, gw) = m.wa(z, gamma);
        let (gd, overflow) = m.density(z);
        (w, overflow, gw, gd)
    };
    let (_, mut overflow, gw, gd) = eval(m, &z0, m.gamma_for(1.0));
    let pins: f64 = pairwise(&m.unit_pins);
    let spread = abs_sum(&gd);
    let mut lam = if spread > 0.0 { abs_sum(&gw).max(1e-3 * pins) / spread } else { 1.0 };
    let mut d = Descent { u: z0.flat(), v: z0.flat(), previous: None, a: 1.0, step: 0.1 * m.bin_w.max(m.bin_h) };
    let mut history = Vec::new();
    let mut rounds = 0.0;
    for k in 0..m.p.iters as usize {
        let gamma = m.gamma_for(overflow);
        let z = State::from_flat(&d.v);
        let (w, next, mut gw, mut gd) = eval(m, &z, gamma);
        overflow = next;
        history.push(Iteration { wa: w, overflow, lambda: lam });
        if k % 50 == 0 {
            log(&format!("gplace {k} wa {w:.1} overflow {overflow:.3} lambda {lam:.3e}"));
        }
        if overflow < m.p.route_overflow && rounds < m.p.route_rounds {
            m.inflate(&z.x, &z.y); // routability: grow the units under congestion, then spread again
            rounds += 1.0;
            (_, overflow, gw, gd) = eval(m, &z, gamma);
        } else if overflow < m.p.stop_overflow && k > 0 {
            d.u = d.v.clone(); // the measured point
            break;
        }
        d.advance(m, preconditioned(m, &gw, &gd, lam));
        lam *= m.p.mu;
    }
    (State::from_flat(&d.u), history)
}

/// The analytic placement. Returns the pose and the iterations.
pub fn place(pr: &Problem, p: &Params, log: &dyn Fn(&str)) -> (Pose, Vec<Iteration>) {
    let mut m = Model::new(pr, p);
    let (z, history) = descend(&mut m, log);
    ((0..z.x.len()).map(|i| (z.x[i], z.y[i], 0)).collect(), history)
}

/// With params global = 1: move the units of the problem to the analytic places; the annealer starts there.
pub fn apply(pr: &mut Problem, p: &Params, log: &dyn Fn(&str)) -> Option<GlobalStage> {
    if p.global == 0.0 {
        return None;
    }
    let (pose, history) = place(pr, p, log);
    for (u, (x, y, _)) in pr.units.iter_mut().zip(pose) {
        (u.x, u.y) = (x, y);
    }
    Some(GlobalStage { iters: history.len(), overflow: history.last().map(|h| h.overflow) })
}
