//! iotroute: rule-native grid router core (tools/router/DESIGN.md, M1).
//!
//!   iotroute MODEL.json OUT.json [--pitch 0.05] [--iters 40] [--plane-clr 0.25] [--hole-to-hole 0.45]
//!            [--return-r 2.0] [--return-via 0.45,0.2] [--pres-mult 1.5] [--pres-max 1000] [--hist 0.3] [--max-time S]
//!
//! MODEL.json comes from tools/router/model.py (schema iot-lab.route-model.v0). Every clearance is checked against
//! exact geometry (pads as their bounding rectangle, tracks as capsules, vias as circles) with the per-net width and
//! clearance of the model; the grid only decides where the search may step. Stages, in this order:
//!   1. plane fan-out: every SMD pad of a plane net (reference-planes.json) gets its own via to its plane, unless a
//!      fixed via of the net is already within 1 mm (CLAUDE.md: a ground via next to each ground pad).
//!   2. routed nets: power class first, then fast nets, then slow nets; shortest first inside a group. A net is a set
//!      of components (pads + existing copper that touch); the search joins them one by one (multi-source A*).
//!   3. return vias: each new signal via gets a GND via within --return-r (kicad-happy RP-001).
//! NET-CORE lessons (2026-10-31) built in: a fast net keeps --plane-clr from every foreign drilled item, so it never
//! runs over a plane antipad (si_planes fast-crossing); a GND via may go through a foreign plane (antipad), it is
//! checked only against copper items.
//! Negotiation (PathFinder): routed copper is soft. Step cost = length x (1 + history) x (1 + pres x distinct items hit).
//! After each iteration an exact audit of all routed copper (plain rule, no margin) gives the overuse: history grows on
//! every conflicting item of both nets, the nets still in conflict (and search-limited ones) are ripped up, pres grows
//! by --pres-mult up to --pres-max. Not converged after --iters / --max-time: the best iteration is restored, the
//! fewest nets are ripped until the copper is legal, they are routed again with soft conflicts blocking, and what
//! stays open is reported as failed (graceful end: the written copper is always clearance-legal).
//! The output is a proposal: KiCad DRC with parity and tools/gate.mjs decide. Last line: ROUTE PASS|FAIL ... summary.
use serde::Serialize;
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::BinaryHeap;

const EPS: f64 = 0.002;
const HOLE_CLR: f64 = 0.28; // .kicad_dru "JLC PTH hole to copper"; TODO read it from the model rules
const SQ2: f64 = std::f64::consts::SQRT_2;
/// a join is searched first inside the bounding box of the net's items grown by this margin (mm)
const JOIN_MARGIN: f64 = 5.0;

#[derive(Clone, Copy, Debug)]
enum Geo {
    Rect(f64, f64, f64, f64),
    Seg(f64, f64, f64, f64, f64),
    Circ(f64, f64, f64),
}

fn seg_dist(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let (dx, dy) = (bx - ax, by - ay);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 0.0 { (((px - ax) * dx + (py - ay) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
    ((px - ax - t * dx).powi(2) + (py - ay - t * dy).powi(2)).sqrt()
}

impl Geo {
    /// Distance from a point to the copper edge (negative inside a track or via).
    fn dist(&self, x: f64, y: f64) -> f64 {
        match *self {
            Geo::Rect(x0, y0, x1, y1) => {
                let dx = (x0 - x).max(0.0).max(x - x1);
                let dy = (y0 - y).max(0.0).max(y - y1);
                (dx * dx + dy * dy).sqrt()
            }
            Geo::Seg(ax, ay, bx, by, hw) => seg_dist(x, y, ax, ay, bx, by) - hw,
            Geo::Circ(cx, cy, r) => ((x - cx).powi(2) + (y - cy).powi(2)).sqrt() - r,
        }
    }
    fn bbox(&self) -> (f64, f64, f64, f64) {
        match *self {
            Geo::Rect(a, b, c, d) => (a, b, c, d),
            Geo::Seg(ax, ay, bx, by, hw) => (ax.min(bx) - hw, ay.min(by) - hw, ax.max(bx) + hw, ay.max(by) + hw),
            Geo::Circ(x, y, r) => (x - r, y - r, x + r, y + r),
        }
    }
    /// Points that touch another item when this item is connected to it.
    fn probes(&self) -> Vec<(f64, f64, f64)> {
        match *self {
            Geo::Rect(a, b, c, d) => vec![((a + c) / 2.0, (b + d) / 2.0, 0.0)],
            Geo::Seg(ax, ay, bx, by, hw) => vec![(ax, ay, hw), (bx, by, hw)],
            Geo::Circ(x, y, r) => vec![(x, y, r)],
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Pad,
    Track,
    Via,
}

#[derive(Clone)]
struct Shape {
    net: i32,
    geo: Geo,
    clr: f64,
    layers: u8,
    drill: f64,
    kind: Kind,
    /// -1: fixed (pads, locked copper, plane fan-out): a hard obstacle. >= 0: routed by that net in this run: other
    /// nets may cross it at the negotiated cost (PathFinder) until the run converges.
    owner: i32,
    alive: bool,
}

#[derive(Clone)]
struct Net {
    name: String,
    width: f64,
    clr: f64,
    fast: bool,
    plane: bool,
    power: bool,
    layers: u8,
    via_d: f64,
    via_drill: f64,
    max_vias: Option<f64>,
    max_len: Option<f64>,
}

#[derive(Serialize, Clone)]
struct OutTrack {
    net: String,
    layer: String,
    a: [f64; 2],
    b: [f64; 2],
    w: f64,
}
#[derive(Serialize, Clone)]
struct OutVia {
    net: String,
    x: f64,
    y: f64,
    d: f64,
    drill: f64,
    role: String,
}
#[derive(Serialize, Clone)]
struct Fail {
    net: String,
    stage: String,
    reason: String,
}
#[derive(Serialize)]
struct Out {
    schema: String,
    tracks: Vec<OutTrack>,
    vias: Vec<OutVia>,
    failed: Vec<Fail>,
    notes: Vec<String>,
    passes: usize,
}

struct Opts {
    pitch: f64,
    passes: usize,
    plane_clr: f64,
    hth: f64,
    return_r: f64,
    ret_d: f64,
    ret_drill: f64,
    pres_mult: f32,
    pres_max: f32,
    hist: f32,
    max_time: f64,
}

struct Index {
    x0: f64,
    y0: f64,
    b: f64,
    nx: usize,
    ny: usize,
    cells: Vec<Vec<Vec<u32>>>, // [layer][bucket] -> shape ids
}

impl Index {
    fn new(x0: f64, y0: f64, x1: f64, y1: f64, nl: usize) -> Index {
        let b = 0.5;
        let nx = ((x1 - x0) / b).ceil() as usize + 2;
        let ny = ((y1 - y0) / b).ceil() as usize + 2;
        Index { x0, y0, b, nx, ny, cells: vec![vec![Vec::new(); nx * ny]; nl] }
    }
    fn range(&self, a: f64, lo: f64, n: usize) -> usize {
        (((a - lo) / self.b).floor().max(0.0) as usize).min(n - 1)
    }
    fn insert(&mut self, id: u32, s: &Shape) {
        let (a, b, c, d) = s.geo.bbox();
        let (i0, i1) = (self.range(a, self.x0, self.nx), self.range(c, self.x0, self.nx));
        let (j0, j1) = (self.range(b, self.y0, self.ny), self.range(d, self.y0, self.ny));
        for l in 0..self.cells.len() {
            if s.layers & (1 << l) == 0 {
                continue;
            }
            for j in j0..=j1 {
                for i in i0..=i1 {
                    self.cells[l][j * self.nx + i].push(id);
                }
            }
        }
    }
}

struct Board {
    layer_names: Vec<String>,
    routable: Vec<usize>, // copper layer index of each routable layer
    nets: Vec<Net>,
    shapes: Vec<Shape>,
    /// fixed items (owner < 0: pads, locked copper); never change during a run
    idx: Index,
    /// routed items (owner >= 0): soft obstacles, negotiated
    sidx: Index,
    maxc: f64,
    edge: (f64, f64, f64, f64),
    edge_clr: f64,
    gnd: i32,
    /// --plane-clr: fast tracks keep it from foreign drilled items (si_planes fast-crossing)
    plane_clr: f64,
    /// margin of every clearance test: EPS while routing (conservative), 0 in the audit (the plain rule)
    eps: f64,
}

/// Fixed-copper verdict of a grid site for one rule profile, shared by all nets: FREE, MULTI (blocked for every net),
/// n >= 0 (blocked for every net except n), ONLY(n) = -(n + 10) (blocked only for net n), COMPUTE (evaluate directly).
const FREE: i32 = -1;
const MULTI: i32 = -2;
const COMPUTE: i32 = -3;
const UNKNOWN: i32 = i32::MIN;

fn blocks(code: i32, net: i32) -> bool {
    code == MULTI || (code >= 0 && code != net) || (code <= -10 && -(code + 10) == net)
}

/// Track centre (half width hw, rule clearance clr, fast net) at (x, y) violates the clearance to item s. The same
/// predicate for fixed and routed items (exact geometry, .kicad_dru values).
fn track_hit(s: &Shape, x: f64, y: f64, hw: f64, clr: f64, fast: bool, plane_clr: f64, eps: f64) -> bool {
    let mut need = hw + clr.max(s.clr);
    if s.drill > 0.0 {
        if fast {
            need = need.max(hw + plane_clr);
        }
        // hole to copper (.kicad_dru "JLC PTH hole to copper" 0.28 mm), measured from the hole edge
        let (cx, cy) = match s.geo {
            Geo::Circ(cx, cy, _) => (cx, cy),
            Geo::Rect(a, b, c, d) => ((a + c) / 2.0, (b + d) / 2.0),
            Geo::Seg(..) => (f64::MAX, f64::MAX),
        };
        if ((x - cx).powi(2) + (y - cy).powi(2)).sqrt() - s.drill / 2.0 < hw + HOLE_CLR + eps {
            return true;
        }
    }
    s.geo.dist(x, y) < need + eps
}

/// Via (radius vr, drill) at (x, y) against item s: 0 no hit, 1 hole-to-hole (any net, own net included),
/// 2 clearance hit (applies to other nets only), 3 own-net SMD pad under the via (applies to the own net only;
/// tools/pcbtool.py viapads), 4 = 2 and 3. The clearance hit mirrors every rule track_hit applies from the other
/// side, so a via that passes here never puts an existing track in violation: the plane clearance of a fast track to
/// a foreign drilled item (s_fast) and the hole-to-copper clearance of the via hole.
fn via_hit(s: &Shape, x: f64, y: f64, vr: f64, drill: f64, clr: f64, hth: f64, s_fast: bool, plane_clr: f64, eps: f64) -> u8 {
    if s.drill > 0.0 {
        let (cx, cy) = match s.geo {
            Geo::Circ(cx, cy, _) => (cx, cy),
            Geo::Rect(a, b, c, d) => ((a + c) / 2.0, (b + d) / 2.0),
            Geo::Seg(..) => (x + 99.0, y),
        };
        let cd = ((x - cx).powi(2) + (y - cy).powi(2)).sqrt();
        if cd - s.drill / 2.0 - drill / 2.0 < hth {
            return 1;
        }
    }
    let dd = s.geo.dist(x, y);
    let mut need = vr + clr.max(s.clr);
    if s_fast {
        need = need.max(vr + plane_clr);
    }
    let other = dd < need + eps || dd < drill / 2.0 + HOLE_CLR + eps;
    let own = s.kind == Kind::Pad && s.drill == 0.0 && dd < vr + 0.05;
    match (other, own) {
        (false, false) => 0,
        (true, false) => 2,
        (false, true) => 3,
        (true, true) => 4,
    }
}

impl Board {
    fn vhit(&self, s: &Shape, x: f64, y: f64, vr: f64, drill: f64, clr: f64, hth: f64) -> u8 {
        let s_fast = s.kind == Kind::Track && s.net >= 0 && self.nets[s.net as usize].fast;
        via_hit(s, x, y, vr, drill, clr, hth, s_fast, self.plane_clr, self.eps)
    }
    fn add(&mut self, s: Shape) -> usize {
        let id = self.shapes.len();
        if s.owner < 0 {
            self.idx.insert(id as u32, &s);
        } else {
            self.sidx.insert(id as u32, &s);
        }
        self.shapes.push(s);
        id
    }
    fn near_in(&self, ix: &Index, l: usize, x: f64, y: f64, r: f64, f: &mut dyn FnMut(u32, &Shape) -> bool) -> bool {
        let (i0, i1) = (ix.range(x - r, ix.x0, ix.nx), ix.range(x + r, ix.x0, ix.nx));
        let (j0, j1) = (ix.range(y - r, ix.y0, ix.ny), ix.range(y + r, ix.y0, ix.ny));
        for j in j0..=j1 {
            for i in i0..=i1 {
                for &id in &ix.cells[l][j * ix.nx + i] {
                    let s = &self.shapes[id as usize];
                    if s.alive && f(id, s) {
                        return true;
                    }
                }
            }
        }
        false
    }
    fn inside(&self, x: f64, y: f64, r: f64) -> bool {
        let (a, b, c, d) = self.edge;
        let m = self.edge_clr + r;
        x - m >= a && x + m <= c && y - m >= b && y + m <= d
    }
    fn track_r(&self, hw: f64, plane_clr: f64) -> f64 {
        hw + self.maxc.max(plane_clr).max(HOLE_CLR) + 0.01
    }
    /// Fixed-copper verdict (FREE / MULTI / n) of a track centre for the profile (hw, clr, fast).
    fn track_fixed_code(&self, l: usize, x: f64, y: f64, hw: f64, clr: f64, fast: bool, plane_clr: f64) -> i32 {
        if !self.inside(x, y, hw) {
            return MULTI;
        }
        let mut code = FREE;
        self.near_in(&self.idx, l, x, y, self.track_r(hw, plane_clr), &mut |_, s| {
            if !track_hit(s, x, y, hw, clr, fast, plane_clr, self.eps) {
                return false;
            }
            if s.net < 0 || (code >= 0 && code != s.net) {
                code = MULTI;
                return true;
            }
            code = s.net;
            false
        });
        code
    }
    /// Number of distinct routed items of other nets that a track centre conflicts with; `hits` collects their ids.
    fn track_soft(&self, net: usize, l: usize, x: f64, y: f64, hw: f64, plane_clr: f64, hits: Option<&mut Vec<u32>>) -> i32 {
        let n = &self.nets[net];
        let (clr, fast) = (n.clr, n.fast);
        let mut seen: Vec<u32> = Vec::new();
        self.near_in(&self.sidx, l, x, y, self.track_r(hw, plane_clr), &mut |id, s| {
            if s.net != net as i32 && !seen.contains(&id) && track_hit(s, x, y, hw, clr, fast, plane_clr, self.eps) {
                seen.push(id);
            }
            false
        });
        if let Some(o) = hits {
            for id in &seen {
                if !o.contains(id) {
                    o.push(*id);
                }
            }
        }
        seen.len() as i32
    }
    /// Track centre of `net` (half width hw) at (x, y) on copper layer l: -1 = blocked by fixed copper or the edge,
    /// k >= 0 = number of distinct routed items of other nets it conflicts with. `hits` collects their shape ids.
    fn track_cost(&self, net: usize, l: usize, x: f64, y: f64, hw: f64, plane_clr: f64, hits: Option<&mut Vec<u32>>) -> i32 {
        let n = &self.nets[net];
        if blocks(self.track_fixed_code(l, x, y, hw, n.clr, n.fast, plane_clr), net as i32) {
            return -1;
        }
        self.track_soft(net, l, x, y, hw, plane_clr, hits)
    }
    fn track_ok(&self, net: usize, l: usize, x: f64, y: f64, hw: f64, plane_clr: f64) -> bool {
        self.track_cost(net, l, x, y, hw, plane_clr, None) == 0
    }
    fn via_r(&self, d: f64, hth: f64) -> f64 {
        d / 2.0 + self.maxc.max(self.plane_clr).max(hth).max(HOLE_CLR) + 0.01
    }
    /// Fixed-copper verdict of a via site for the profile (d, drill, clr): see FREE / MULTI / n / ONLY / COMPUTE.
    fn via_fixed_code(&self, x: f64, y: f64, d: f64, drill: f64, clr: f64, hth: f64) -> i32 {
        let vr = d / 2.0;
        if !self.inside(x, y, vr) {
            return MULTI;
        }
        let (mut a, mut b): (Vec<i32>, Vec<i32>) = (Vec::new(), Vec::new());
        let r = self.via_r(d, hth);
        for l in 0..self.layer_names.len() {
            let multi = self.near_in(&self.idx, l, x, y, r, &mut |_, s| {
                let h = self.vhit(s, x, y, vr, drill, clr, hth);
                if h == 1 {
                    return true;
                }
                if h == 2 || h == 4 {
                    if s.net < 0 {
                        return true;
                    }
                    if !a.contains(&s.net) {
                        a.push(s.net);
                    }
                }
                if (h == 3 || h == 4) && !b.contains(&s.net) {
                    b.push(s.net);
                }
                a.len() > 1
            });
            if multi {
                return MULTI;
            }
        }
        // blocked for net q iff (a without q) is not empty or q is in b
        match (a.len(), b.len()) {
            (0, 0) => FREE,
            (1, _) => if b.contains(&a[0]) { MULTI } else { a[0] },
            (0, 1) => -(b[0] + 10),
            _ => COMPUTE,
        }
    }
    fn via_code_blocks(&self, code: i32, net: usize, x: f64, y: f64, d: f64, drill: f64, hth: f64) -> bool {
        if code == COMPUTE {
            let (vr, clr, r) = (d / 2.0, self.nets[net].clr, self.via_r(d, hth));
            return (0..self.layer_names.len()).any(|l| self.near_in(&self.idx, l, x, y, r, &mut |_, s| {
                match self.vhit(s, x, y, vr, drill, clr, hth) {
                    1 | 4 => true,
                    2 => s.net != net as i32,
                    3 => s.net == net as i32,
                    _ => false,
                }
            }));
        }
        blocks(code, net as i32)
    }
    /// Distinct routed items a via of `net` conflicts with (hole to hole with any net, clearance with other nets).
    fn via_soft(&self, net: usize, x: f64, y: f64, d: f64, drill: f64, hth: f64, hits: Option<&mut Vec<u32>>) -> i32 {
        let vr = d / 2.0;
        let clr = self.nets[net].clr;
        let r = self.via_r(d, hth);
        let mut seen: Vec<u32> = Vec::new();
        // routed items are tracks on routable layers and through vias (all layers): the routable layers see them all
        for &l in &self.routable {
            self.near_in(&self.sidx, l, x, y, r, &mut |id, s| {
                if seen.contains(&id) {
                    return false;
                }
                let h = self.vhit(s, x, y, vr, drill, clr, hth);
                if h == 1 || ((h == 2 || h == 4) && s.net != net as i32) {
                    seen.push(id);
                }
                false
            });
        }
        if let Some(o) = hits {
            for id in &seen {
                if !o.contains(id) {
                    o.push(*id);
                }
            }
        }
        seen.len() as i32
    }
    /// Through via of `net` (diameter d, drill) at (x, y): -1 blocked, k >= 0 soft conflicts (as track_cost).
    fn via_cost(&self, net: usize, x: f64, y: f64, d: f64, drill: f64, hth: f64, hits: Option<&mut Vec<u32>>) -> i32 {
        let code = self.via_fixed_code(x, y, d, drill, self.nets[net].clr, hth);
        if self.via_code_blocks(code, net, x, y, d, drill, hth) {
            return -1;
        }
        self.via_soft(net, x, y, d, drill, hth, hits)
    }
    fn via_ok(&self, net: usize, x: f64, y: f64, d: f64, drill: f64, hth: f64) -> bool {
        self.via_cost(net, x, y, d, drill, hth, None) == 0
    }
    /// Rebuild the spatial indexes without the dead (ripped-up) items.
    fn compact(&mut self) {
        let shapes: Vec<Shape> = self.shapes.drain(..).filter(|s| s.alive).collect();
        for ix in [&mut self.idx, &mut self.sidx] {
            for l in ix.cells.iter_mut() {
                for c in l.iter_mut() {
                    c.clear();
                }
            }
        }
        for s in shapes {
            self.add(s);
        }
    }
}

#[derive(Copy, Clone, PartialEq)]
struct Node {
    f: f32,
    g: f32,
    i: u32,
}
impl Eq for Node {}
impl Ord for Node {
    fn cmp(&self, o: &Self) -> Ordering {
        o.f.partial_cmp(&self.f).unwrap_or(Ordering::Equal)
    }
}
impl PartialOrd for Node {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}

struct Grid {
    x0: f64,
    y0: f64,
    p: f64,
    nx: usize,
    ny: usize,
    nr: usize,
    cache: Vec<u8>,  // 0 unknown, 1 blocked, 2 + k: k soft conflicts (capped)
    vcache: Vec<u8>, // same, for a via at (ix, iy)
    dcache: Vec<u8>, // same, for the midpoint of a diagonal step: centre of the cell square (ix .. ix+1, iy .. iy+1)
    hist: Vec<f32>,  // PathFinder history cost per routable cell
    vhist: Vec<f32>,
    pres: f32,       // PathFinder present-congestion factor
    g: Vec<f32>,
    from: Vec<u32>,
    seen: Vec<u32>,
    tgt: Vec<u32>,
    sgen: u32,
    tgen: u32,
}

impl Grid {
    fn cell(&self, i: usize) -> (usize, usize, usize) {
        let n = self.nx * self.ny;
        (i / n, (i % n) / self.nx, i % self.nx)
    }
    fn xy(&self, ix: usize, iy: usize) -> (f64, f64) {
        (self.x0 + ix as f64 * self.p, self.y0 + iy as f64 * self.p)
    }
    fn at(&self, x: f64, y: f64) -> (usize, usize) {
        let ix = ((x - self.x0) / self.p).round().clamp(0.0, (self.nx - 1) as f64) as usize;
        let iy = ((y - self.y0) / self.p).round().clamp(0.0, (self.ny - 1) as f64) as usize;
        (ix, iy)
    }
    fn reset_cache(&mut self) {
        self.cache.iter_mut().for_each(|c| *c = 0);
        self.vcache.iter_mut().for_each(|c| *c = 0);
        self.dcache.iter_mut().for_each(|c| *c = 0);
    }
}

struct Ctx<'a> {
    bd: &'a mut Board,
    gr: Grid,
    o: &'a Opts,
    /// soft conflicts block (final legal re-route of nets that were ripped up)
    strict: bool,
    /// per net: fixed shape ids (stable: fixed items are never removed) of components proved unreachable past fixed
    /// copper, and the reason. Fixed copper never changes and soft copper never blocks a non-strict search, so the
    /// proof holds for the whole run; later rip-ups skip these components instead of repeating an exhaustive search.
    dead: Vec<(Vec<usize>, String)>,
    memo: Vec<((u8, (u64, u64, u64)), Vec<i32>)>,
    memo_w: Vec<f64>,
}

/// Exact clearance audit of all routed copper at the end of an iteration (the PathFinder "overuse").
#[derive(Default)]
struct Audit {
    /// distinct pairs of routed items that violate the clearance
    pairs: usize,
    /// conflicting samples (0.5 pitch along tracks, one per via), weighted by the items hit
    samples: u32,
    /// samples of routed copper that hit fixed copper (must stay 0: the search never steps there)
    hard: u32,
    per_net: Vec<u32>,
    partners: Vec<Vec<usize>>,
    /// the conflicting item pairs (shape ids)
    pair_ids: Vec<(u32, u32)>,
}

fn code(k: i32) -> u8 {
    if k < 0 { 1 } else { 2 + (k.min(200) as u8) }
}

impl<'a> Ctx<'a> {
    /// None: blocked; Some(k): k soft conflicts.
    fn cost(&mut self, net: usize, i: usize, hw: f64) -> Option<u32> {
        let mut c = self.gr.cache[i];
        if c == 0 {
            let (r, iy, ix) = self.gr.cell(i);
            let (x, y) = self.gr.xy(ix, iy);
            let l = self.bd.routable[r];
            let (clr, fast) = (self.bd.nets[net].clr, self.bd.nets[net].fast);
            let pc = self.o.plane_clr;
            let fixed = match self.memo_slot(0, (hw.to_bits(), clr.to_bits(), fast as u64)) {
                Some(m) => {
                    if self.memo[m].1[i] == UNKNOWN {
                        self.memo[m].1[i] = self.bd.track_fixed_code(l, x, y, hw, clr, fast, pc);
                    }
                    self.memo[m].1[i]
                }
                None => self.bd.track_fixed_code(l, x, y, hw, clr, fast, pc),
            };
            c = if blocks(fixed, net as i32) { 1 } else { code(self.bd.track_soft(net, l, x, y, hw, pc, None)) };
            self.gr.cache[i] = c;
        }
        if c == 1 { None } else { Some((c - 2) as u32) }
    }
    /// Track centre at the midpoint of a diagonal step (index of the lower-left cell of the square). The cell
    /// centres carry the EPS margin, which covers the bulge of a 0.05 mm orthogonal step (0.05^2 / (8 x 0.225) =
    /// 0.0014 mm) but not of a 0.0707 mm diagonal one (0.0028 mm): its midpoint is checked with the same rule.
    fn mcost(&mut self, net: usize, mi: usize, hw: f64) -> Option<u32> {
        let mut c = self.gr.dcache[mi];
        if c == 0 {
            let (r, iy, ix) = self.gr.cell(mi);
            let (x, y) = self.gr.xy(ix, iy);
            let (x, y) = (x + self.gr.p / 2.0, y + self.gr.p / 2.0);
            let l = self.bd.routable[r];
            let (clr, fast) = (self.bd.nets[net].clr, self.bd.nets[net].fast);
            let pc = self.o.plane_clr;
            let fixed = match self.memo_slot(1, (hw.to_bits(), clr.to_bits(), fast as u64)) {
                Some(m) => {
                    if self.memo[m].1[mi] == UNKNOWN {
                        self.memo[m].1[mi] = self.bd.track_fixed_code(l, x, y, hw, clr, fast, pc);
                    }
                    self.memo[m].1[mi]
                }
                None => self.bd.track_fixed_code(l, x, y, hw, clr, fast, pc),
            };
            c = if blocks(fixed, net as i32) { 1 } else { code(self.bd.track_soft(net, l, x, y, hw, pc, None)) };
            self.gr.dcache[mi] = c;
        }
        if c == 1 { None } else { Some((c - 2) as u32) }
    }
    fn vcost(&mut self, net: usize, ix: usize, iy: usize) -> Option<u32> {
        let k = iy * self.gr.nx + ix;
        let mut c = self.gr.vcache[k];
        if c == 0 {
            let (x, y) = self.gr.xy(ix, iy);
            let n = &self.bd.nets[net];
            let (d, dr, clr, hth) = (n.via_d, n.via_drill, n.clr, self.o.hth);
            let fixed = match self.memo_slot(2, (d.to_bits(), dr.to_bits(), clr.to_bits())) {
                Some(m) => {
                    if self.memo[m].1[k] == UNKNOWN {
                        self.memo[m].1[k] = self.bd.via_fixed_code(x, y, d, dr, clr, hth);
                    }
                    self.memo[m].1[k]
                }
                None => self.bd.via_fixed_code(x, y, d, dr, clr, hth),
            };
            c = if self.bd.via_code_blocks(fixed, net, x, y, d, dr, hth) { 1 } else { code(self.bd.via_soft(net, x, y, d, dr, hth, None)) };
            self.gr.vcache[k] = c;
        }
        if c == 1 { None } else { Some((c - 2) as u32) }
    }
    /// Memo of the fixed-copper verdict per rule profile (track: hw, clr, fast; via: d, drill, clr). Fixed copper
    /// does not change during a run, so each grid site is evaluated once per profile instead of once per search.
    /// Only the profiles of the net widths (and the power necks) get a memo; others are evaluated directly.
    fn memo_slot(&mut self, kind: u8, key: (u64, u64, u64)) -> Option<usize> {
        let track = kind < 2;
        let tag = (kind, key);
        if let Some(m) = self.memo.iter().position(|(t, _)| *t == tag) {
            return Some(m);
        }
        if track && !self.memo_w.iter().any(|&w| (f64::from_bits(key.0) * 2.0 - w).abs() < 1e-9) {
            return None;
        }
        if self.memo.len() >= 16 {
            return None;
        }
        let n = if track { self.gr.nx * self.gr.ny * self.gr.nr } else { self.gr.nx * self.gr.ny };
        self.memo.push((tag, vec![UNKNOWN; n]));
        Some(self.memo.len() - 1)
    }

    /// Flood fill with the moves and blocking rules of the search (vias allowed, diagonal midpoints checked, soft
    /// conflicts block only when strict): is any cell marked in tgt reachable from src inside bx?
    fn reachable(&mut self, net: usize, hw: f64, src: &[usize], strict: bool, bx: (usize, usize, usize, usize)) -> bool {
        self.gr.sgen += 1;
        let sgen = self.gr.sgen;
        let (nx, nr) = (self.gr.nx, self.gr.nr);
        let n = nx * self.gr.ny;
        let lmask = self.bd.nets[net].layers;
        let allowed: Vec<bool> = self.bd.routable.iter().map(|&l| lmask & (1 << l) != 0).collect();
        let ok = |k: Option<u32>| matches!(k, Some(k) if !strict || k == 0);
        let mut stack: Vec<usize> = Vec::new();
        for &s in src {
            if self.gr.seen[s] != sgen && ok(self.cost(net, s, hw)) {
                self.gr.seen[s] = sgen;
                stack.push(s);
            }
        }
        while let Some(i) = stack.pop() {
            if self.gr.tgt[i] == self.gr.tgen {
                return true;
            }
            let (r, iy, ix) = self.gr.cell(i);
            for (dx, dy) in [(-1i32, 0i32), (1, 0), (0, -1), (0, 1), (-1, -1), (1, -1), (-1, 1), (1, 1)] {
                let (jx, jy) = (ix as i32 + dx, iy as i32 + dy);
                if jx < bx.0 as i32 || jy < bx.1 as i32 || jx > bx.2 as i32 || jy > bx.3 as i32 {
                    continue;
                }
                let j = r * n + jy as usize * nx + jx as usize;
                if self.gr.seen[j] == sgen || !ok(self.cost(net, j, hw)) {
                    continue;
                }
                if dx != 0 && dy != 0 && !ok(self.mcost(net, r * n + (iy as i32).min(jy) as usize * nx + (ix as i32).min(jx) as usize, hw)) {
                    continue;
                }
                self.gr.seen[j] = sgen;
                stack.push(j);
            }
            if nr > 1 && ok(self.vcost(net, ix, iy)) {
                for r2 in 0..nr {
                    let j = r2 * n + iy * nx + ix;
                    if r2 != r && allowed[r2] && self.gr.seen[j] != sgen && ok(self.cost(net, j, hw)) {
                        self.gr.seen[j] = sgen;
                        stack.push(j);
                    }
                }
            }
        }
        false
    }

    /// The cells an item covers on the routable layers (as source or target).
    fn cells_of(&self, s: &Shape, net_layers: u8) -> Vec<usize> {
        let mut v = Vec::new();
        let mut corner = Vec::new(); // only when the ellipse holds no grid cell (pad narrower than the pitch)
        let (a, b, c, d) = s.geo.bbox();
        let (i0, j0) = self.gr.at(a, b);
        let (i1, j1) = self.gr.at(c, d);
        let n = self.gr.nx * self.gr.ny;
        for (r, &l) in self.bd.routable.iter().enumerate() {
            if s.layers & (1 << l) == 0 || net_layers & (1 << l) == 0 {
                continue;
            }
            for j in j0..=j1 {
                for i in i0..=i1 {
                    let (x, y) = self.gr.xy(i, j);
                    // a pad is known only by its bounding box: a track may end only inside the inscribed ellipse,
                    // which lies inside a rectangular, round, oval or rounded pad (a bbox corner of a round pad is
                    // bare board: KiCad reported such ends as unconnected)
                    let in_pad = match (s.kind, s.geo) {
                        (Kind::Pad, Geo::Rect(..)) => {
                            let (ex, ey) = (((c - a) / 2.0).max(1e-9), ((d - b) / 2.0).max(1e-9));
                            ((x - (a + c) / 2.0) / ex).powi(2) + ((y - (b + d) / 2.0) / ey).powi(2) <= 1.0
                        }
                        _ => true,
                    };
                    if s.geo.dist(x, y) <= 1e-9 {
                        if in_pad {
                            v.push(r * n + j * self.gr.nx + i);
                        } else {
                            corner.push(r * n + j * self.gr.nx + i);
                        }
                    }
                }
            }
        }
        if v.is_empty() { corner } else { v }
    }

    /// Multi-source A* from `src` cells to any cell marked in tgt (generation tgen), inside the grid box bx. Step
    /// cost = length x layer factor x (1 + history) x (1 + pres x soft conflicts); a diagonal step also pays its
    /// midpoint. With strict, soft conflicts block. Err(true): max_pops expansions reached (not a proof);
    /// Err(false): no path inside bx.
    fn search_n(&mut self, net: usize, hw: f64, src: &[usize], anchors: &[(f64, f64)], allow_via: bool, strict: bool, max_pops: usize,
                bx: (usize, usize, usize, usize)) -> Result<Vec<usize>, bool> {
        self.gr.sgen += 1;
        let sgen = self.gr.sgen;
        let (nx, ny, nr, p) = (self.gr.nx, self.gr.ny, self.gr.nr, self.gr.p);
        let n = nx * ny;
        let lmask = self.bd.nets[net].layers;
        let lcost: Vec<f64> = self.bd.routable.iter().map(|&l| {
            let name = &self.bd.layer_names[l];
            if lmask & (1 << l) == 0 { f64::INFINITY } else if name == "F.Cu" { 1.0 } else if name == "B.Cu" { 1.05 } else { 1.15 }
        }).collect();
        let via_base = 3.0 + if self.bd.nets[net].max_vias.is_some() { 6.0 } else { 0.0 };
        let pres = self.gr.pres as f64;
        let (x0, y0) = (self.gr.x0, self.gr.y0);
        let h = |ix: usize, iy: usize| -> f32 {
            let (x, y) = (x0 + ix as f64 * p, y0 + iy as f64 * p);
            let mut m = f64::INFINITY;
            for &(ax, ay) in anchors {
                let (dx, dy) = ((x - ax).abs(), (y - ay).abs());
                let o = dx.max(dy) + (SQ2 - 1.0) * dx.min(dy);
                if o < m {
                    m = o;
                }
            }
            (m * 1.15) as f32
        };
        let mut heap = BinaryHeap::new();
        for &s in src {
            match self.cost(net, s, hw) {
                None => continue,
                Some(k) if strict && k > 0 => continue,
                _ => {}
            }
            if self.gr.seen[s] == sgen {
                continue;
            }
            self.gr.seen[s] = sgen;
            self.gr.g[s] = 0.0;
            self.gr.from[s] = u32::MAX;
            let (_, iy, ix) = self.gr.cell(s);
            heap.push(Node { f: h(ix, iy), g: 0.0, i: s as u32 });
        }
        let mut pops = 0usize;
        while let Some(Node { f: _, g: gpush, i }) = heap.pop() {
            let i = i as usize;
            if gpush > self.gr.g[i] {
                continue; // stale entry: the cell was reached cheaper after this push (expanding it again adds nothing)
            }
            pops += 1;
            if pops > max_pops {
                return Err(true);
            }
            if self.gr.tgt[i] == self.gr.tgen {
                let mut path = vec![i];
                let mut c = i;
                while self.gr.from[c] != u32::MAX {
                    c = self.gr.from[c] as usize;
                    path.push(c);
                }
                path.reverse();
                return Ok(path);
            }
            let gi = self.gr.g[i];
            let (r, iy, ix) = self.gr.cell(i);
            let mut nb: Vec<(usize, f64, bool, usize)> = Vec::with_capacity(10);
            for (dx, dy) in [(-1i32, 0i32), (1, 0), (0, -1), (0, 1), (-1, -1), (1, -1), (-1, 1), (1, 1)] {
                let (jx, jy) = (ix as i32 + dx, iy as i32 + dy);
                if jx < bx.0 as i32 || jy < bx.1 as i32 || jx > bx.2 as i32 || jy > bx.3 as i32 {
                    continue;
                }
                let diag = dx != 0 && dy != 0;
                let step = if diag { SQ2 } else { 1.0 } * p * lcost[r];
                let mid = if diag { r * n + (iy as i32).min(jy) as usize * nx + (ix as i32).min(jx) as usize } else { usize::MAX };
                nb.push((r * n + jy as usize * nx + jx as usize, step, false, mid));
            }
            if allow_via && nr > 1 {
                if let Some(kv) = self.vcost(net, ix, iy) {
                    if !(strict && kv > 0) {
                        let vc = (via_base + self.gr.vhist[iy * nx + ix] as f64) * (1.0 + pres * kv as f64);
                        for r2 in 0..nr {
                            if r2 != r && lcost[r2].is_finite() {
                                nb.push((r2 * n + iy * nx + ix, vc, true, usize::MAX));
                            }
                        }
                    }
                }
            }
            for (j, c, is_via, mid) in nb {
                let mut k = match self.cost(net, j, hw) {
                    None => continue,
                    Some(k) => k,
                };
                if mid != usize::MAX {
                    match self.mcost(net, mid, hw) {
                        None => continue,
                        Some(km) => k = k.max(km),
                    }
                }
                if strict && k > 0 {
                    continue;
                }
                let c = if is_via { c } else { c * (1.0 + self.gr.hist[j] as f64) * (1.0 + pres * k as f64) };
                let gj = gi + c as f32;
                if self.gr.seen[j] == sgen && self.gr.g[j] <= gj {
                    continue;
                }
                self.gr.seen[j] = sgen;
                self.gr.g[j] = gj;
                self.gr.from[j] = i as u32;
                let (_, jy, jx) = self.gr.cell(j);
                heap.push(Node { f: gj + h(jx, jy), g: gj, i: j as u32 });
            }
        }
        Err(false)
    }

    /// Exact audit of every live routed item against the other routed items (both sides of each conflict are seen,
    /// since each item is checked from its own net). hist > 0: add PathFinder history on the grid cells (and via
    /// sites) of the conflicting copper, once per cell and iteration.
    fn audit(&mut self, hist: f32) -> Audit {
        self.audit_of(hist, None)
    }
    /// audit of the routed items of one net only (no history)
    fn net_in_conflict(&mut self, net: usize) -> bool {
        self.audit_of(0.0, Some(net)).pairs > 0
    }
    fn audit_of(&mut self, hist: f32, only: Option<usize>) -> Audit {
        self.bd.eps = 0.0;
        let a = self.audit_inner(hist, only);
        self.bd.eps = EPS;
        a
    }
    fn audit_inner(&mut self, hist: f32, only: Option<usize>) -> Audit {
        let nn = self.bd.nets.len();
        let mut a = Audit { per_net: vec![0; nn], partners: vec![Vec::new(); nn], ..Default::default() };
        let mut pairs = std::collections::HashSet::new();
        let mut cells = std::collections::HashSet::new();
        let mut vcells = std::collections::HashSet::new();
        let n = self.gr.nx * self.gr.ny;
        let ids: Vec<usize> = (0..self.bd.shapes.len())
            .filter(|&i| self.bd.shapes[i].alive && self.bd.shapes[i].owner >= 0 && only.map_or(true, |o| self.bd.shapes[i].owner == o as i32))
            .collect();
        let mut hits: Vec<u32> = Vec::new();
        for id in ids {
            let s = self.bd.shapes[id].clone();
            let net = s.net as usize;
            let own = s.owner as usize;
            let mut samples: Vec<(f64, f64, i32, Option<usize>)> = Vec::new();
            hits.clear();
            match (s.kind, s.geo) {
                (Kind::Track, Geo::Seg(ax, ay, bx, by, hw)) => {
                    let l = (0..self.bd.layer_names.len()).find(|&l| s.layers & (1 << l) != 0).unwrap();
                    let r = self.bd.routable.iter().position(|&q| q == l);
                    let len = ((bx - ax).powi(2) + (by - ay).powi(2)).sqrt();
                    let k = (len / (self.gr.p * 0.5)).ceil().max(1.0) as usize;
                    for t in 0..=k {
                        let f = t as f64 / k as f64;
                        let (x, y) = (ax + (bx - ax) * f, ay + (by - ay) * f);
                        let c = self.bd.track_cost(net, l, x, y, hw, self.o.plane_clr, Some(&mut hits));
                        samples.push((x, y, c, r));
                    }
                }
                (Kind::Via, Geo::Circ(x, y, vr)) => {
                    // hole to hole applies to the own net too: take the via itself out while it is checked
                    self.bd.shapes[id].alive = false;
                    let c = self.bd.via_cost(net, x, y, vr * 2.0, s.drill, self.o.hth, Some(&mut hits));
                    self.bd.shapes[id].alive = true;
                    samples.push((x, y, c, None));
                }
                _ => continue,
            }
            for &(x, y, c, r) in &samples {
                if c < 0 {
                    a.hard += 1;
                    if std::env::var("IOTROUTE_DEBUG").is_ok() {
                        eprintln!("  audit: {} {:?} on fixed copper at ({x:.3}, {y:.3})", self.bd.nets[net].name, s.geo, );
                    }
                    continue;
                }
                if c == 0 {
                    continue;
                }
                a.samples += c as u32;
                a.per_net[own] += c as u32;
                let (ix, iy) = self.gr.at(x, y);
                match r {
                    Some(r) => { cells.insert(r * n + iy * self.gr.nx + ix); }
                    None => { vcells.insert(iy * self.gr.nx + ix); }
                }
            }
            for &h in &hits {
                let o = self.bd.shapes[h as usize].owner;
                if o >= 0 && !a.partners[own].contains(&(o as usize)) {
                    a.partners[own].push(o as usize);
                }
                pairs.insert(((id as u32).min(h), (id as u32).max(h)));
            }
        }
        a.pairs = pairs.len();
        a.pair_ids = pairs.into_iter().collect();
        a.pair_ids.sort();
        if hist > 0.0 {
            for c in cells {
                self.gr.hist[c] += hist;
            }
            for c in vcells {
                self.gr.vhist[c] += hist;
            }
        }
        a
    }

    fn seg_clear(&self, net: usize, l: usize, a: (f64, f64), b: (f64, f64), hw: f64) -> bool {
        let len = ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt();
        let k = (len / (self.gr.p * 0.5)).ceil().max(1.0) as usize;
        (0..=k).all(|t| {
            let f = t as f64 / k as f64;
            self.bd.track_ok(net, l, a.0 + (b.0 - a.0) * f, a.1 + (b.1 - a.1) * f, hw, self.o.plane_clr)
        })
    }

    /// Cell path -> (tracks, vias) with greedy string pulling per layer run (only over conflict-free samples).
    fn geometry(&self, net: usize, path: &[usize], hw: f64) -> (Vec<(usize, (f64, f64), (f64, f64))>, Vec<(f64, f64)>) {
        let mut tracks = Vec::new();
        let mut vias = Vec::new();
        let mut runs: Vec<(usize, Vec<(f64, f64)>)> = Vec::new();
        for &c in path {
            let (r, iy, ix) = self.gr.cell(c);
            let pt = self.gr.xy(ix, iy);
            match runs.last_mut() {
                Some((lr, pts)) if *lr == r => pts.push(pt),
                _ => {
                    if let Some((_, pts)) = runs.last() {
                        vias.push(*pts.last().unwrap());
                    }
                    runs.push((r, vec![pt]));
                }
            }
        }
        for (r, pts) in runs {
            let l = self.bd.routable[r];
            if pts.len() < 2 {
                continue;
            }
            let mut i = 0;
            while i < pts.len() - 1 {
                let mut j = i + 1;
                let mut k = i + 2;
                let mut misses = 0;
                while k < pts.len() {
                    let dl = ((pts[k].0 - pts[i].0).powi(2) + (pts[k].1 - pts[i].1).powi(2)).sqrt();
                    if dl > 12.0 {
                        break;
                    }
                    if self.seg_clear(net, l, pts[i], pts[k], hw) {
                        j = k;
                        misses = 0;
                    } else {
                        misses += 1;
                        if misses > 6 {
                            break;
                        }
                    }
                    k += if pts.len() - k > 40 { 3 } else { 1 };
                }
                tracks.push((l, pts[i], pts[j]));
                i = j;
            }
        }
        (tracks, vias)
    }
}

fn touch(a: &Shape, b: &Shape) -> bool {
    if a.layers & b.layers == 0 {
        return false;
    }
    a.geo.probes().iter().any(|&(x, y, r)| b.geo.dist(x, y) <= r + 1e-3)
        || b.geo.probes().iter().any(|&(x, y, r)| a.geo.dist(x, y) <= r + 1e-3)
}

fn find(p: &mut Vec<usize>, i: usize) -> usize {
    let mut r = i;
    while p[r] != r {
        r = p[r];
    }
    let mut c = i;
    while p[c] != r {
        let n = p[c];
        p[c] = r;
        c = n;
    }
    r
}

fn f(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}

fn load(model: &Value) -> Board {
    let cu: Vec<String> = model["copper_layers"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
    let planes: Vec<String> = model["plane_layers"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
    let lid = |n: &str| cu.iter().position(|c| c == n);
    let mask = |arr: &Value| -> u8 { arr.as_array().unwrap().iter().filter_map(|v| lid(v.as_str().unwrap())).fold(0u8, |m, l| m | (1 << l)) };
    let routable: Vec<usize> = (0..cu.len()).filter(|&l| !planes.contains(&cu[l])).collect();
    let ob = model["outline_bbox"].as_array().unwrap();
    // outline bbox includes the Edge.Cuts line width (0.1 mm): the edge is 0.05 mm inside
    let edge = (f(&ob[0]) + 0.05, f(&ob[1]) + 0.05, f(&ob[2]) - 0.05, f(&ob[3]) - 0.05);
    let edge_clr = model["setup"]["edge_clearance"].as_f64().unwrap_or(0.5);
    let classes = &model["classes"];
    let mut nets = Vec::new();
    let mut names = std::collections::HashMap::new();
    for (name, v) in model["nets"].as_object().unwrap() {
        let cls = &classes[v["class"].as_str().unwrap_or("Default")];
        let via = &v["via"];
        let n = Net {
            name: name.clone(),
            width: v["width"].as_f64().unwrap_or(0.15),
            clr: v["clearance"].as_f64().unwrap_or(0.15),
            fast: v["fast"].as_bool().unwrap_or(false),
            plane: v["plane"].as_bool().unwrap_or(false),
            power: v["class"].as_str() == Some("PWR") || v["limits"]["amps"].as_f64().unwrap_or(0.0) > 0.0,
            layers: mask(&v["layers"]),
            via_d: via["via_diameter"].as_f64().or(cls["via"].as_f64()).unwrap_or(0.6),
            via_drill: via["hole_size"].as_f64().or(cls["drill"].as_f64()).unwrap_or(0.3),
            max_vias: v["limits"]["via_count"].as_f64(),
            max_len: v["limits"]["length"].as_f64(),
        };
        names.insert(name.clone(), nets.len());
        nets.push(n);
    }
    let maxc = nets.iter().map(|n| n.clr).fold(0.15, f64::max);
    let idx = Index::new(edge.0 - 1.0, edge.1 - 1.0, edge.2 + 1.0, edge.3 + 1.0, cu.len());
    let gnd = names.get("GND").map(|&i| i as i32).unwrap_or(-1);
    let sidx = Index::new(edge.0 - 1.0, edge.1 - 1.0, edge.2 + 1.0, edge.3 + 1.0, cu.len());
    let mut bd = Board { layer_names: cu.clone(), routable, nets, shapes: Vec::new(), idx, sidx, maxc, edge, edge_clr, gnd, plane_clr: 0.25, eps: EPS };
    let net_of = |n: &str| names.get(n).map(|&i| i as i32).unwrap_or(-1);
    let clr_of = |bd: &Board, n: i32| if n >= 0 { bd.nets[n as usize].clr } else { 0.15 };
    for p in model["pads"].as_array().unwrap() {
        let bb = p["bbox"].as_array().unwrap();
        let net = net_of(p["net"].as_str().unwrap_or(""));
        let layers = mask(&p["layers"]);
        let drill = f(&p["drill"]);
        if layers == 0 && drill > 0.0 {
            // NPTH: no copper, but the hole keeps the JLC hole-to-copper clearance on every layer (.kicad_dru 0.28 mm)
            let s = Shape { net: -1, geo: Geo::Circ(f(&p["x"]), f(&p["y"]), drill / 2.0), clr: 0.28, layers: (1u8 << cu.len()) - 1, drill, kind: Kind::Pad, owner: -1, alive: true };
            bd.add(s);
            continue;
        }
        let s = Shape { net, geo: Geo::Rect(f(&bb[0]), f(&bb[1]), f(&bb[2]), f(&bb[3])), clr: clr_of(&bd, net), layers, drill, kind: Kind::Pad, owner: -1, alive: true };
        bd.add(s);
    }
    for c in model["copper"].as_array().unwrap() {
        let net = net_of(c["net"].as_str().unwrap_or(""));
        let clr = clr_of(&bd, net);
        if c["kind"] == "via" {
            let s = Shape { net, geo: Geo::Circ(f(&c["x"]), f(&c["y"]), f(&c["d"]) / 2.0), clr, layers: (1u8 << cu.len()) - 1, drill: f(&c["drill"]), kind: Kind::Via, owner: -1, alive: true };
            bd.add(s);
        } else {
            let (a, b) = (c["a"].as_array().unwrap(), c["b"].as_array().unwrap());
            let l = lid(c["layer"].as_str().unwrap()).unwrap();
            let s = Shape { net, geo: Geo::Seg(f(&a[0]), f(&a[1]), f(&b[0]), f(&b[1]), f(&c["w"]) / 2.0), clr, layers: 1 << l, drill: 0.0, kind: Kind::Track, owner: -1, alive: true };
            bd.add(s);
        }
    }
    bd.maxc = bd.shapes.iter().map(|s| s.clr).fold(bd.maxc, f64::max); // query reach: the largest clearance of any item
    bd
}

/// Plane fan-out of one plane net: a via (plus a short track) for every SMD pad of the net, unless a fixed via of the
/// net is already within 1 mm. The fan-out is owned by the plane net, so it takes part in the negotiation: when a
/// signal net conflicts with it, the whole fan-out of that plane net is ripped up and placed again at the present
/// costs (it is not a hard wall that can enclose pins).
fn fanout_net(ctx: &mut Ctx, net: usize) -> NetResult {
    for s in ctx.bd.shapes.iter_mut() {
        if s.owner == net as i32 {
            s.alive = false;
        }
    }
    let mut out = NetResult { hard_fail: None, limit: false, conflicts: 0 };
    let all = (1u8 << ctx.bd.layer_names.len()) - 1;
    let pads: Vec<Shape> = ctx.bd.shapes.iter().filter(|s| s.alive && s.net == net as i32 && s.kind == Kind::Pad && s.drill == 0.0).cloned().collect();
    let mut misses = Vec::new();
    let pres = ctx.gr.pres as f64;
    for pad in pads {
        let (cx, cy) = match pad.geo { Geo::Rect(a, b, c, d) => ((a + c) / 2.0, (b + d) / 2.0), _ => continue };
        // a fixed via within 1 mm counts (input copper); a routed via counts only when it touches this pad: the
        // fan-out via of a neighbour pad has no copper to it (DESIGN 5a: every plane-net SMD pad gets its own via)
        let has = ctx.bd.shapes.iter().any(|s| s.alive && s.net == net as i32 && s.kind == Kind::Via
            && (if s.owner < 0 { s.geo.dist(cx, cy) < 1.0 } else { touch(s, &pad) }));
        if has {
            continue;
        }
        let (pw, ph) = match pad.geo { Geo::Rect(a, b, c, d) => (c - a, d - b), _ => (0.3, 0.3) };
        let mut done = false;
        let mut limited = false;
        for w in [ctx.bd.nets[net].width.min(0.3).min(pw.min(ph)), 0.15] {
            let hw = w / 2.0;
            ctx.gr.reset_cache();
            let src = ctx.cells_of(&pad, pad.layers);
            ctx.gr.tgen += 1;
            let tg = ctx.gr.tgen;
            let (i0, j0) = ctx.gr.at(cx - 2.0, cy - 2.0);
            let (i1, j1) = ctx.gr.at(cx + 2.0, cy + 2.0);
            let r = ctx.bd.routable.iter().position(|&l| pad.layers & (1 << l) != 0).unwrap_or(0);
            let n = ctx.gr.nx * ctx.gr.ny;
            let mut cands = Vec::new();
            for j in j0..=j1 {
                for i in i0..=i1 {
                    let (x, y) = ctx.gr.xy(i, j);
                    if pad.geo.dist(x, y) < 0.35 {
                        continue;
                    }
                    let (Some(kv), Some(kt)) = (ctx.vcost(net, i, j), ctx.cost(net, r * n + j * ctx.gr.nx + i, hw)) else { continue };
                    if ctx.strict && kv + kt > 0 {
                        continue;
                    }
                    // the via site takes part in the negotiation like a path cell: history and present cost
                    let hc = (ctx.gr.hist[r * n + j * ctx.gr.nx + i] + ctx.gr.vhist[j * ctx.gr.nx + i]) as f64;
                    cands.push((pad.geo.dist(x, y) * (1.0 + hc) * (1.0 + pres * (kv + kt) as f64), x, y, kv, r * n + j * ctx.gr.nx + i));
                }
            }
            if cands.is_empty() {
                continue;
            }
            // the search ends at the first target it reaches and does not price the via itself: offer only the via
            // sites with the fewest via conflicts
            let kmin = cands.iter().map(|c| c.3).min().unwrap();
            for c in cands.iter().filter(|c| c.3 == kmin) {
                ctx.gr.tgt[c.4] = tg;
            }
            cands.retain(|c| c.3 == kmin);
            cands.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
            let anchors = vec![(cands[0].1, cands[0].2)];
            // the via sites are within 2 mm: search the pad's box first (a bounded flood even at a high present
            // cost); no path there = whole board; a search stopped by its pop cap is not a proof (limit, not a miss)
            let full = (0, 0, ctx.gr.nx - 1, ctx.gr.ny - 1);
            let (b0, b1) = (ctx.gr.at(cx - 3.0, cy - 3.0), ctx.gr.at(cx + 3.0, cy + 3.0));
            let mut found = ctx.search_n(net, hw, &src, &anchors, false, ctx.strict, 2_000_000, (b0.0, b0.1, b1.0, b1.1));
            if found == Err(false) {
                found = ctx.search_n(net, hw, &src, &anchors, false, ctx.strict, 2_000_000, full);
            }
            if found == Err(true) {
                limited = true;
            }
            if let Ok(path) = found {
                let last = *path.last().unwrap();
                let (_, iy, ix) = ctx.gr.cell(last);
                let (vx, vy) = ctx.gr.xy(ix, iy);
                // conflicts at routing time (log only; the end-of-iteration audit decides rip-up and history)
                let mut k: u32 = path.iter().map(|&c| ctx.cost(net, c, hw).unwrap_or(0)).sum();
                let n_ = ctx.bd.nets[net].clone();
                k += ctx.vcost(net, ix, iy).unwrap_or(0);
                out.conflicts += k;
                let (tr, _) = ctx.geometry(net, &path, hw);
                add_copper(ctx, net, net as i32, &tr, &[], hw);
                ctx.bd.add(Shape { net: net as i32, geo: Geo::Circ(vx, vy, n_.via_d / 2.0), clr: n_.clr, layers: all, drill: n_.via_drill, kind: Kind::Via, owner: net as i32, alive: true });
                done = true;
                break;
            }
        }
        if !done {
            if limited {
                out.limit = true;
                out.conflicts += 1000;
            }
            misses.push(format!("({cx:.2}, {cy:.2}){}", if limited { " (search limit)" } else { "" }));
        }
    }
    if !misses.is_empty() {
        out.hard_fail = Some(format!("no via site within 2 mm of {} pad(s): {}", misses.len(), misses.join(" ")));
    }
    out
}

fn add_copper(ctx: &mut Ctx, net: usize, owner: i32, tracks: &[(usize, (f64, f64), (f64, f64))], vias: &[(f64, f64)], hw: f64) {
    let clr = ctx.bd.nets[net].clr;
    for &(l, a, b) in tracks {
        if (a.0 - b.0).abs() < 1e-9 && (a.1 - b.1).abs() < 1e-9 {
            continue;
        }
        ctx.bd.add(Shape { net: net as i32, geo: Geo::Seg(a.0, a.1, b.0, b.1, hw), clr, layers: 1 << l, drill: 0.0, kind: Kind::Track, owner, alive: true });
    }
    let all = (1u8 << ctx.bd.layer_names.len()) - 1;
    for &(x, y) in vias {
        let (d, dr) = (ctx.bd.nets[net].via_d, ctx.bd.nets[net].via_drill);
        ctx.bd.add(Shape { net: net as i32, geo: Geo::Circ(x, y, d / 2.0), clr, layers: all, drill: dr, kind: Kind::Via, owner, alive: true });
    }
}

/// GND via within --return-r of a new signal via, owned by that signal net; only a conflict-free site counts.
fn return_via(ctx: &mut Ctx, owner: usize, x: f64, y: f64) -> bool {
    let g = ctx.bd.gnd;
    if g < 0 {
        return false;
    }
    let all = (1u8 << ctx.bd.layer_names.len()) - 1;
    let (d, dr) = (ctx.o.ret_d, ctx.o.ret_drill);
    let p = ctx.gr.p;
    let k = (ctx.o.return_r / p) as i32;
    let mut c: Vec<(f64, f64, f64)> = Vec::new();
    for j in -k..=k {
        for i in -k..=k {
            let (px, py) = (x + i as f64 * p, y + j as f64 * p);
            let dd = ((px - x).powi(2) + (py - y).powi(2)).sqrt();
            if dd <= ctx.o.return_r && dd > 0.5 {
                c.push((dd, px, py));
            }
        }
    }
    c.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let clr = ctx.bd.nets[g as usize].clr;
    for (_, px, py) in c {
        if ctx.bd.via_ok(g as usize, px, py, d, dr, ctx.o.hth) {
            ctx.bd.add(Shape { net: g, geo: Geo::Circ(px, py, d / 2.0), clr, layers: all, drill: dr, kind: Kind::Via, owner: owner as i32, alive: true });
            return true;
        }
    }
    false
}

struct NetResult {
    hard_fail: Option<String>,
    limit: bool,
    conflicts: u32,
}

/// Rip up the copper this net routed before, then join its components again against the present congestion.
fn route_net(ctx: &mut Ctx, net: usize) -> NetResult {
    for s in ctx.bd.shapes.iter_mut() {
        if s.owner == net as i32 {
            s.alive = false;
        }
    }
    let mut out = NetResult { hard_fail: None, limit: false, conflicts: 0 };
    let items: Vec<usize> = (0..ctx.bd.shapes.len()).filter(|&i| { let s = &ctx.bd.shapes[i]; s.alive && s.net == net as i32 && s.owner < 0 }).collect();
    if items.len() < 2 {
        return out;
    }
    let mut par: Vec<usize> = (0..items.len()).collect();
    for a in 0..items.len() {
        for b in a + 1..items.len() {
            if touch(&ctx.bd.shapes[items[a]], &ctx.bd.shapes[items[b]]) {
                let (ra, rb) = (find(&mut par, a), find(&mut par, b));
                par[ra] = rb;
            }
        }
    }
    let mut comps: Vec<Vec<usize>> = Vec::new();
    let mut root_of = std::collections::HashMap::new();
    for a in 0..items.len() {
        let r = find(&mut par, a);
        let k = *root_of.entry(r).or_insert_with(|| { comps.push(vec![]); comps.len() - 1 });
        comps[k].push(items[a]);
    }
    let nmask = ctx.bd.nets[net].layers;
    let base_w = ctx.bd.nets[net].width;
    let widths: Vec<f64> = if ctx.bd.nets[net].power { vec![base_w, 0.3, 0.2, 0.15] } else { vec![base_w] };
    if !ctx.dead[net].0.is_empty() {
        let dead = ctx.dead[net].0.clone();
        comps.retain(|c| !c.iter().any(|s| dead.contains(s)));
        out.hard_fail = Some(ctx.dead[net].1.clone());
        if comps.len() < 2 {
            return out;
        }
    }
    let nbox = {
        let (mut a, mut b, mut c, mut d) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for &s in comps.iter().flatten() {
            let (x0, y0, x1, y1) = ctx.bd.shapes[s].geo.bbox();
            a = a.min(x0);
            b = b.min(y0);
            c = c.max(x1);
            d = d.max(y1);
        }
        let (i0, j0) = ctx.gr.at(a - JOIN_MARGIN, b - JOIN_MARGIN);
        let (i1, j1) = ctx.gr.at(c + JOIN_MARGIN, d + JOIN_MARGIN);
        (i0, j0, i1, j1)
    };
    let mut tree = comps.remove(0);
    let mut trapped: Vec<String> = Vec::new();
    while !comps.is_empty() {
        // best width: the widest with the fewest conflicts (power nets neck only when it removes conflicts)
        let mut best: Option<(u32, f64, Vec<usize>)> = None;
        let mut limit = false;
        for (wi, &w) in widths.iter().enumerate() {
            if wi > 0 && w >= base_w {
                continue;
            }
            let hw = w / 2.0;
            ctx.gr.reset_cache();
            let mut src = Vec::new();
            for &s in &tree {
                let sh = ctx.bd.shapes[s].clone();
                src.extend(ctx.cells_of(&sh, nmask));
            }
            ctx.gr.tgen += 1;
            let tg = ctx.gr.tgen;
            let mut anchors = Vec::new();
            let mut open = false;
            for comp in &comps {
                for &s in comp {
                    let sh = ctx.bd.shapes[s].clone();
                    for c in ctx.cells_of(&sh, nmask) {
                        ctx.gr.tgt[c] = tg;
                        open = open || ctx.cost(net, c, hw).is_some();
                    }
                    for (x, y, _) in sh.geo.probes() {
                        anchors.push((x, y));
                    }
                }
            }
            // no target cell open: no path at this width (proved without a search). A wider try is only a
            // preference (the narrowest width is always tried last and the blocked set grows with the width), so its
            // search is bounded
            let last = wi + 1 == widths.len();
            if !open {
                continue;
            }
            let cap = if last && !ctx.strict { 8_000_000 } else if last { 1_000_000 } else { 300_000 };
            // search first inside the net's box + JOIN_MARGIN: once every way to a target crosses congested copper,
            // an unbounded search floods the whole board before it pays that cost. No path in the box (fixed walls,
            // or strict mode) = search the whole board, so a failure is still a proof
            let full = (0, 0, ctx.gr.nx - 1, ctx.gr.ny - 1);
            let mut found = ctx.search_n(net, hw, &src, &anchors, true, ctx.strict, cap, nbox);
            if found.is_err() && last {
                // (a wider try only gives up: the narrowest width follows) a flood fill proves "no path" in one visit per cell; only a reachable target is worth a
                // whole-board A* (which may re-expand cells past its cap)
                found = if !ctx.reachable(net, hw, &src, ctx.strict, full) {
                    Err(false)
                } else if found == Err(false) && nbox != full {
                    ctx.search_n(net, hw, &src, &anchors, true, ctx.strict, cap, full)
                } else {
                    found
                };
            }
            if let Err(true) = found {
                limit = limit || last;
            }
            if let Ok(path) = found {
                let k: u32 = path.iter().map(|&c| ctx.cost(net, c, hw).unwrap_or(0)).sum();
                if best.as_ref().map(|b| k < b.0).unwrap_or(true) {
                    best = Some((k, w, path));
                }
                if k == 0 {
                    break;
                }
            }
        }
        let Some((k, w, path)) = best else {
            if limit {
                out.conflicts += 1000; // search limit: not proven blocked, try again next iteration
                out.limit = true;
                out.hard_fail = Some(format!("A* search limit reached, {} component(s) not joined", comps.len()));
            } else if tree_pads(ctx, &tree).len() > 0 && !comps.is_empty() && trapped.len() < 4
                && tree_pads(ctx, &tree).len() < comps.iter().map(|c| tree_pads(ctx, c).len()).sum::<usize>() {
                // the start side has fewer pads than the rest: it is the walled-in side. Record it, go on from the
                // next component
                trapped.push(tree_pads(ctx, &tree).join(","));
                if !ctx.strict {
                    let ids: Vec<usize> = tree.iter().cloned().filter(|&s| ctx.bd.shapes[s].owner < 0).collect();
                    ctx.dead[net].0.extend(ids);
                }
                tree = comps.remove(0);
                continue;
            } else {
                let pads: Vec<String> = comps.iter().flat_map(|c| tree_pads(ctx, c)).collect();
                out.hard_fail = Some(format!("{} component(s) not reachable past fixed copper: pad(s) at {}", comps.len(), pads.join(",")));
                if !ctx.strict {
                    let ids: Vec<usize> = comps.iter().flatten().cloned().collect();
                    ctx.dead[net].0.extend(ids);
                    ctx.dead[net].1 = out.hard_fail.clone().unwrap();
                }
                if std::env::var("IOTROUTE_DEBUG").is_ok() {
                    let hw = widths.last().unwrap() / 2.0;
                    ctx.gr.reset_cache();
                    for (ci, comp) in std::iter::once(&tree).chain(comps.iter()).enumerate() {
                        for &s in comp {
                            let sh = ctx.bd.shapes[s].clone();
                            let cells = ctx.cells_of(&sh, nmask);
                            let free = cells.iter().filter(|&&c| ctx.cost(net, c, hw).is_some()).count();
                            eprintln!("  {} comp {ci} {:?} {:?}: {} cells, {} not hard-blocked at w {:.2}",
                                      ctx.bd.nets[net].name, sh.kind as u8, sh.geo.bbox(), cells.len(), free, hw * 2.0);
                        }
                    }
                }
            }
            break;
        };
        let hw = w / 2.0;
        let last = *path.last().unwrap();
        let (_, iy, ix) = ctx.gr.cell(last);
        let (gx, gy) = ctx.gr.xy(ix, iy);
        out.conflicts += k;
        let (tr, vs) = ctx.geometry(net, &path, hw);
        let first_new = ctx.bd.shapes.len();
        add_copper(ctx, net, net as i32, &tr, &vs, hw);
        let ci = comps.iter().position(|comp| comp.iter().any(|&s| ctx.bd.shapes[s].geo.dist(gx, gy) <= 1e-6)).unwrap_or(0);
        let reached = comps.remove(ci);
        tree.extend(reached);
        tree.extend(first_new..ctx.bd.shapes.len());
    }
    if !trapped.is_empty() && out.hard_fail.is_none() {
        out.hard_fail = Some(format!("walled in by fixed copper (input placement / locked routes): pad(s) at {}", trapped.join("; ")));
        if !ctx.strict && ctx.dead[net].1.is_empty() {
            ctx.dead[net].1 = out.hard_fail.clone().unwrap();
        }
    }
    out
}

fn tree_pads(ctx: &Ctx, items: &[usize]) -> Vec<String> {
    items.iter().filter_map(|&s| {
        let sh = &ctx.bd.shapes[s];
        match (sh.kind == Kind::Pad, sh.geo) {
            (true, Geo::Rect(a, b, c, d)) => Some(format!("({:.2}, {:.2})", (a + c) / 2.0, (b + d) / 2.0)),
            _ => None,
        }
    }).collect()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: iotroute MODEL.json OUT.json [--pitch 0.05] [--iters 40] [--plane-clr 0.25] [--hole-to-hole 0.45] [--return-r 2.0] [--return-via 0.45,0.2] [--pres-mult 1.5] [--pres-max 1000] [--hist 0.3] [--max-time S]");
        std::process::exit(2);
    }
    let mut o = Opts { pitch: 0.05, passes: 40, plane_clr: 0.25, hth: 0.45, return_r: 2.0, ret_d: 0.45, ret_drill: 0.2,
                       pres_mult: 1.5, pres_max: 1000.0, hist: 0.3, max_time: 0.0 };
    let mut i = 3;
    while i + 1 < args.len() {
        let v = &args[i + 1];
        match args[i].as_str() {
            "--pitch" => o.pitch = v.parse().unwrap(),
            "--iters" | "--passes" => o.passes = v.parse().unwrap(),
            "--plane-clr" => o.plane_clr = v.parse().unwrap(),
            "--hole-to-hole" => o.hth = v.parse().unwrap(),
            "--return-r" => o.return_r = v.parse().unwrap(),
            "--pres-mult" => o.pres_mult = v.parse().unwrap(),
            "--pres-max" => o.pres_max = v.parse().unwrap(),
            "--hist" => o.hist = v.parse().unwrap(),
            "--max-time" => o.max_time = v.parse().unwrap(),
            "--return-via" => {
                let p: Vec<f64> = v.split(',').map(|s| s.parse().unwrap()).collect();
                o.ret_d = p[0];
                o.ret_drill = p[1];
            }
            a => {
                eprintln!("unknown option {a}");
                std::process::exit(2)
            }
        }
        i += 2;
    }
    let t0 = std::time::Instant::now();
    let model: Value = serde_json::from_str(&std::fs::read_to_string(&args[1]).expect("model")).expect("json");
    let mut bd = load(&model);
    bd.plane_clr = o.plane_clr;
    let base0 = bd.shapes.len();
    let (e0, e1, e2, e3) = bd.edge;
    let nx = ((e2 - e0) / o.pitch).ceil() as usize + 1;
    let ny = ((e3 - e1) / o.pitch).ceil() as usize + 1;
    let nr = bd.routable.len();
    let tot = nx * ny * nr;
    let gr = Grid { x0: e0, y0: e1, p: o.pitch, nx, ny, nr, cache: vec![0; tot], vcache: vec![0; nx * ny], dcache: vec![0; tot], hist: vec![0.0; tot], vhist: vec![0.0; nx * ny], pres: 0.5,
                    g: vec![0.0; tot], from: vec![0; tot], seen: vec![0; tot], tgt: vec![0; tot], sgen: 0, tgen: 0 };
    let mut order: Vec<usize> = (0..bd.nets.len()).collect();
    let spread = |bd: &Board, n: usize| -> f64 {
        let (mut a, mut b, mut c, mut d) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for s in bd.shapes.iter().filter(|s| s.net == n as i32 && s.kind == Kind::Pad) {
            let (x0, y0, x1, y1) = s.geo.bbox();
            a = a.min(x0); b = b.min(y0); c = c.max(x1); d = d.max(y1);
        }
        if a == f64::MAX { 0.0 } else { (c - a) + (d - b) }
    };
    let group = |bd: &Board, n: usize| if bd.nets[n].plane { 0 } else if bd.nets[n].power { 1 } else if bd.nets[n].fast { 2 } else { 3 };
    order.sort_by(|&a, &b| group(&bd, a).cmp(&group(&bd, b)).then(spread(&bd, a).partial_cmp(&spread(&bd, b)).unwrap()));
    let nets_n = bd.nets.len();
    let mut memo_w: Vec<f64> = bd.nets.iter().map(|n| n.width).chain([0.3, 0.2, 0.15]).collect();
    memo_w.sort_by(|a, b| a.partial_cmp(b).unwrap());
    memo_w.dedup();
    let mut ctx = Ctx { bd: &mut bd, gr, o: &o, strict: false, dead: vec![(Vec::new(), String::new()); nets_n], memo: Vec::new(), memo_w };
    let fan_fail: Vec<Fail> = Vec::new();
    let nn = ctx.bd.nets.len();
    let mut todo: Vec<usize> = order.clone();
    let mut state: Vec<(Option<String>, u32)> = vec![(None, 0); nn];
    let mut iters = 0;
    let mut converged = false;
    let names = |bd: &Board, v: &[usize]| v.iter().map(|&n| bd.nets[n].name.as_str()).collect::<Vec<_>>().join(" ");
    // best iteration so far: (nets in conflict, conflicting pairs) -> its copper and state, restored when not converged
    let mut best: Option<((usize, usize), usize, Vec<Shape>, Vec<(Option<String>, u32)>)> = None;
    let mut limited_prev: Vec<usize> = Vec::new();
    for it in 0..o.passes {
        iters = it + 1;
        ctx.bd.compact();
        let mut total = 0u32;
        let mut limited: Vec<usize> = Vec::new();
        let prof = std::env::var("IOTROUTE_PROF").is_ok();
        let mut kept = 0;
        for &net in &todo {
            // a net ripped up for a conflict whose partner has already moved away in this iteration keeps its copper
            // (without this, two nets in conflict both move every iteration and swap places forever)
            if it > 0 && !limited_prev.contains(&net) && ctx.bd.shapes.iter().any(|s| s.alive && s.owner == net as i32) && !ctx.net_in_conflict(net) {
                kept += 1;
                continue;
            }
            let tn = std::time::Instant::now();
            let r = if ctx.bd.nets[net].plane { fanout_net(&mut ctx, net) } else { route_net(&mut ctx, net) };
            if prof {
                eprintln!("  {:<14} {:6.2} s conflicts {:5}{}", ctx.bd.nets[net].name, tn.elapsed().as_secs_f64(), r.conflicts, if r.limit { " LIMIT" } else { "" });
            }
            if r.limit {
                limited.push(net);
            }
            total += r.conflicts;
            state[net] = (r.hard_fail.clone(), r.conflicts);
        }
        // PathFinder overuse = exact audit of the final copper of this iteration: history on every conflicting item
        // of both nets, and the rip-up set = every net that is still in conflict (not the stale routing-time count)
        let au = ctx.audit(o.hist);
        let mut involved: Vec<usize> = (0..nn).filter(|&n| au.per_net[n] > 0 || !au.partners[n].is_empty()).collect();
        for &n in &limited {
            if !involved.contains(&n) {
                involved.push(n);
            }
        }
        limited_prev = limited;
        let hard_nets: Vec<usize> = order.iter().cloned().filter(|&n| state[n].0.is_some()).collect();
        eprintln!("iter {:2}: routed {:3}, conflicts {:5}, audit pairs {:4} samples {:5} hard {}, involved {:3}, hard fails {:2}, pres {:.2}, {:.1} s  hard: {}  involved: {}",
                  it + 1, todo.len() - kept, total, au.pairs, au.samples, au.hard, involved.len(), hard_nets.len(), ctx.gr.pres, t0.elapsed().as_secs_f64(),
                  names(ctx.bd, &hard_nets), if involved.len() <= 16 { names(ctx.bd, &involved) } else { String::from("...") });
        if std::env::var("IOTROUTE_DEBUG").is_ok() && involved.len() <= 3 {
            for &(p, q) in au.pair_ids.iter().take(8) {
                let (a, b) = (&ctx.bd.shapes[p as usize], &ctx.bd.shapes[q as usize]);
                eprintln!("  pair: {} {:?} | {} {:?}", ctx.bd.nets[a.net as usize].name, a.geo, ctx.bd.nets[b.net as usize].name, b.geo);
            }
        }
        let score = (involved.len(), au.pairs);
        if best.as_ref().map(|b| score < b.0).unwrap_or(true) {
            best = Some((score, it + 1, ctx.bd.shapes.iter().filter(|s| s.alive).cloned().collect(), state.clone()));
        }
        if involved.is_empty() {
            converged = true;
            break;
        }
        if o.max_time > 0.0 && t0.elapsed().as_secs_f64() > o.max_time {
            eprintln!("time limit {:.0} s reached", o.max_time);
            break;
        }
        ctx.gr.pres = (ctx.gr.pres * o.pres_mult).min(o.pres_max);
        // hard fails are walls of fixed copper: they do not change, so a hard-failed net is routed again only when it
        // is in conflict
        todo = order.iter().cloned().filter(|n| involved.contains(n)).collect();
    }
    if !converged {
        // graceful end: take the best iteration, rip up nets until the copper is legal (most conflicts first), then
        // route the ripped nets again with soft conflicts blocking; what stays open is reported as failed
        let (score, bit, shapes, st) = best.take().unwrap();
        ctx.bd.shapes = shapes;
        ctx.bd.compact();
        state = st;
        let mut ripped: Vec<usize> = Vec::new();
        loop {
            let au = ctx.audit(0.0);
            if au.pairs == 0 {
                break;
            }
            // greedy vertex cover of the net conflict graph: rip the net with the most partners left (then the most
            // conflict samples) until no conflict pair is left; one audit per round, a second round only as a guard
            let mut adj: Vec<Vec<usize>> = au.partners.clone();
            for a in 0..nn {
                for &b in &au.partners[a] {
                    if !adj[b].contains(&a) {
                        adj[b].push(a);
                    }
                }
            }
            let mut cut = vec![false; nn];
            loop {
                let deg = |n: usize| adj[n].iter().filter(|&&m| !cut[m]).count();
                let worst = (0..nn).filter(|&n| !cut[n]).max_by_key(|&n| (deg(n), au.per_net[n])).unwrap();
                if deg(worst) == 0 {
                    break;
                }
                cut[worst] = true;
            }
            // a net in conflict with no routed partner listed (cannot happen: conflicts are only with routed items)
            for n in 0..nn {
                if au.per_net[n] > 0 && adj[n].iter().all(|&m| !cut[m]) {
                    cut[n] = true;
                }
            }
            for s in ctx.bd.shapes.iter_mut() {
                if s.owner >= 0 && cut[s.owner as usize] {
                    s.alive = false;
                }
            }
            ripped.extend((0..nn).filter(|&n| cut[n]));
        }
        ctx.strict = true;
        let mut reopened = Vec::new();
        for &net in order.iter().filter(|n| ripped.contains(n)) {
            let r = if ctx.bd.nets[net].plane { fanout_net(&mut ctx, net) } else { route_net(&mut ctx, net) };
            match r.hard_fail {
                Some(m) => {
                    state[net] = (Some(format!("negotiation did not converge; strict re-route (routed copper blocks): {m}")), 0);
                    reopened.push(net);
                }
                None => state[net] = (None, 0),
            }
        }
        ctx.strict = false;
        let au = ctx.audit(0.0);
        eprintln!("best iteration {bit} (nets in conflict {}, pairs {}); ripped {}: {}; strict re-route open {}: {}; audit pairs {}",
                  score.0, score.1, ripped.len(), names(ctx.bd, &ripped), reopened.len(), names(ctx.bd, &reopened), au.pairs);
        // the output keeps "N conflicts left" only for copper that is still illegal (a guard: should be none)
        for n in 0..nn {
            state[n].1 = au.per_net[n];
        }
    }
    // return vias, once the copper is legal (strict sites; a missing site is a note for the gate to judge)
    let mut notes = Vec::new();
    let sig_vias: Vec<(usize, f64, f64)> = ctx.bd.shapes.iter().filter(|s| s.alive && s.owner >= 0 && s.kind == Kind::Via && s.net == s.owner && !ctx.bd.nets[s.net as usize].plane)
        .filter_map(|s| match s.geo { Geo::Circ(x, y, _) => Some((s.owner as usize, x, y)), _ => None }).collect();
    for (net, x, y) in sig_vias {
        if !return_via(&mut ctx, net, x, y) {
            notes.push(format!("{}: no GND return via within {} mm of ({x:.2}, {y:.2})", ctx.bd.nets[net].name, o.return_r));
        }
    }
    // output: every live routed item plus the plane fan-out (fixed, added after the input copper)
    let mut tracks = Vec::new();
    let mut vias = Vec::new();
    let mut via_count = vec![0usize; nn];
    for (i, s) in ctx.bd.shapes.iter().enumerate() {
        if !s.alive || (s.owner < 0 && i < base0) {
            continue;
        }
        let name = if s.net >= 0 { ctx.bd.nets[s.net as usize].name.clone() } else { continue };
        match s.geo {
            Geo::Seg(ax, ay, bx, by, hw) => {
                let l = (0..ctx.bd.layer_names.len()).find(|&l| s.layers & (1 << l) != 0).unwrap();
                if s.owner >= 0 && ctx.bd.nets[s.net as usize].power && hw * 2.0 < ctx.bd.nets[s.net as usize].width - 1e-6 {
                    notes.push(format!("{name}: neck {:.2} mm (class {:.2})", hw * 2.0, ctx.bd.nets[s.net as usize].width));
                }
                tracks.push(OutTrack { net: name, layer: ctx.bd.layer_names[l].clone(), a: [ax, ay], b: [bx, by], w: hw * 2.0 });
            }
            Geo::Circ(x, y, r) => {
                let role = if s.owner < 0 || ctx.bd.nets[s.net as usize].plane && s.net == s.owner { "plane" } else if s.net == s.owner { "signal" } else { "return" };
                if role == "signal" {
                    via_count[s.net as usize] += 1;
                }
                vias.push(OutVia { net: name, x, y, d: r * 2.0, drill: s.drill, role: role.into() });
            }
            _ => {}
        }
    }
    for n in 0..nn {
        if let Some(mv) = ctx.bd.nets[n].max_vias {
            if via_count[n] as f64 > mv {
                notes.push(format!("{}: {} new vias over the DRU via_count max {mv}", ctx.bd.nets[n].name, via_count[n]));
            }
        }
    }
    notes.sort();
    notes.dedup();
    let mut failed = fan_fail;
    for n in 0..nn {
        if let Some(r) = &state[n].0 {
            failed.push(Fail { net: ctx.bd.nets[n].name.clone(), stage: "route".into(), reason: r.clone() });
        } else if !converged && state[n].1 > 0 {
            failed.push(Fail { net: ctx.bd.nets[n].name.clone(), stage: "route".into(), reason: format!("{} conflicts left", state[n].1) });
        }
    }
    let out = Out { schema: "iot-lab.route-result.v0".into(), tracks, vias, failed, notes, passes: iters };
    std::fs::write(&args[2], serde_json::to_string_pretty(&out).unwrap()).expect("write");
    let status = if out.failed.is_empty() { "PASS" } else { "FAIL" };
    println!("ROUTE {status} converged {converged} iters {iters} tracks {} vias {} failed {} notes {} {:.0} s -> {}",
             out.tracks.len(), out.vias.len(), out.failed.len(), out.notes.len(), t0.elapsed().as_secs_f64(), args[2]);
}

#[cfg(test)]
mod tests {
    //! The split fixed / routed check and the per-profile memo must give the same verdict as the plain rule
    //! (v1 code, brute force over all items): blocked / free / in conflict, at random sites, for every net.
    use super::*;

    fn net(name: &str, clr: f64, fast: bool) -> Net {
        Net { name: name.into(), width: 0.15, clr, fast, plane: false, power: false, layers: 0b101, via_d: 0.6, via_drill: 0.3, max_vias: None, max_len: None }
    }

    fn board() -> Board {
        let nets = vec![net("A", 0.15, false), net("B", 0.2, true), net("C", 0.15, true)];
        let (x0, y0, x1, y1) = (0.0, 0.0, 10.0, 10.0);
        let mut bd = Board { layer_names: vec!["F.Cu".into(), "In1.Cu".into(), "B.Cu".into()], routable: vec![0, 2], nets, shapes: Vec::new(),
                             idx: Index::new(x0 - 1.0, y0 - 1.0, x1 + 1.0, y1 + 1.0, 3), sidx: Index::new(x0 - 1.0, y0 - 1.0, x1 + 1.0, y1 + 1.0, 3),
                             maxc: 0.2, edge: (x0, y0, x1, y1), edge_clr: 0.3, gnd: -1, plane_clr: 0.25, eps: EPS };
        let sh = |net: i32, geo: Geo, clr: f64, layers: u8, drill: f64, kind: Kind, owner: i32| Shape { net, geo, clr, layers, drill, kind, owner, alive: true };
        bd.add(sh(0, Geo::Rect(2.0, 2.0, 2.6, 2.4), 0.15, 1, 0.0, Kind::Pad, -1));
        bd.add(sh(0, Geo::Rect(2.0, 2.9, 2.6, 3.3), 0.15, 1, 0.0, Kind::Pad, -1));
        bd.add(sh(1, Geo::Rect(3.0, 2.0, 3.6, 2.4), 0.2, 1, 0.0, Kind::Pad, -1));
        bd.add(sh(2, Geo::Rect(5.0, 5.0, 6.6, 6.6), 0.15, 0b111, 0.9, Kind::Pad, -1));
        bd.add(sh(-1, Geo::Circ(7.5, 3.0, 0.6), 0.28, 0b111, 1.2, Kind::Pad, -1));
        bd.add(sh(1, Geo::Circ(4.0, 7.0, 0.3), 0.2, 0b111, 0.3, Kind::Via, -1));
        bd.add(sh(0, Geo::Seg(1.0, 8.0, 6.0, 8.5, 0.1), 0.15, 0b100, 0.0, Kind::Track, -1));
        bd.add(sh(2, Geo::Seg(1.0, 5.0, 4.0, 4.0, 0.075), 0.15, 0b001, 0.0, Kind::Track, 2));
        bd.add(sh(0, Geo::Circ(6.0, 2.5, 0.3), 0.15, 0b111, 0.3, Kind::Via, 0));
        bd.add(sh(1, Geo::Seg(6.5, 7.0, 8.5, 9.0, 0.1), 0.2, 0b100, 0.0, Kind::Track, 1));
        bd.maxc = bd.shapes.iter().map(|s| s.clr).fold(bd.maxc, f64::max); // as load()
        bd
    }

    /// v1 track rule, brute force: -1 fixed hit / edge, else number of routed hits (> 0 counts only as "conflict").
    fn ref_track(bd: &Board, net: usize, l: usize, x: f64, y: f64, hw: f64, pc: f64) -> i32 {
        if !bd.inside(x, y, hw) {
            return -1;
        }
        let (clr, fast) = (bd.nets[net].clr, bd.nets[net].fast);
        let mut k = 0;
        for s in bd.shapes.iter().filter(|s| s.alive && s.layers & (1 << l) != 0 && s.net != net as i32) {
            let mut need = hw + clr.max(s.clr);
            let mut hit = false;
            if s.drill > 0.0 {
                if fast {
                    need = need.max(hw + pc);
                }
                let (cx, cy) = match s.geo { Geo::Circ(cx, cy, _) => (cx, cy), Geo::Rect(a, b, c, d) => ((a + c) / 2.0, (b + d) / 2.0), Geo::Seg(..) => (f64::MAX, f64::MAX) };
                hit = ((x - cx).powi(2) + (y - cy).powi(2)).sqrt() - s.drill / 2.0 < hw + HOLE_CLR + EPS;
            }
            if hit || s.geo.dist(x, y) < need + EPS {
                if s.owner < 0 {
                    return -1;
                }
                k += 1;
            }
        }
        k
    }

    /// v1 via rule, brute force.
    fn ref_via(bd: &Board, net: usize, x: f64, y: f64, d: f64, drill: f64, hth: f64) -> i32 {
        let vr = d / 2.0;
        if !bd.inside(x, y, vr) {
            return -1;
        }
        let clr = bd.nets[net].clr;
        let mut k = 0;
        for s in bd.shapes.iter().filter(|s| s.alive) {
            let mut hit = false;
            if s.drill > 0.0 {
                let (cx, cy) = match s.geo { Geo::Circ(cx, cy, _) => (cx, cy), Geo::Rect(a, b, c, d) => ((a + c) / 2.0, (b + d) / 2.0), Geo::Seg(..) => (x + 99.0, y) };
                hit = ((x - cx).powi(2) + (y - cy).powi(2)).sqrt() - s.drill / 2.0 - drill / 2.0 < hth;
            }
            if !hit {
                if s.net == net as i32 {
                    if s.kind == Kind::Pad && s.drill == 0.0 && s.geo.dist(x, y) < vr + 0.05 {
                        return -1;
                    }
                    continue;
                }
                // v1 clearance, plus (since v2) the rules a track checks from its side: fast-track plane clearance to
                // a drilled item and hole to copper
                let dd = s.geo.dist(x, y);
                let fast_track = s.kind == Kind::Track && s.net >= 0 && bd.nets[s.net as usize].fast;
                hit = dd < vr + clr.max(s.clr) + EPS || (fast_track && dd < vr + bd.plane_clr + EPS) || dd < drill / 2.0 + HOLE_CLR + EPS;
            }
            if hit {
                if s.owner < 0 {
                    return -1;
                }
                k += 1;
            }
        }
        k
    }

    #[test]
    fn split_and_memo_match_v1_rule() {
        let bd = board();
        let mut seed: u64 = 12345;
        let mut rnd = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        let (mut n_block, mut n_soft, mut n_free) = (0, 0, 0);
        for _ in 0..20000 {
            let (x, y) = (rnd() * 10.0, rnd() * 10.0);
            for net in 0..3 {
                for &l in &[0usize, 2] {
                    for &hw in &[0.075, 0.25] {
                        let r = ref_track(&bd, net, l, x, y, hw, 0.25);
                        let n = bd.track_cost(net, l, x, y, hw, 0.25, None);
                        assert_eq!(r.signum(), n.signum(), "track net {net} l {l} ({x}, {y}) hw {hw}");
                        let code = bd.track_fixed_code(l, x, y, hw, bd.nets[net].clr, bd.nets[net].fast, 0.25);
                        assert_eq!(r < 0, blocks(code, net as i32), "track memo net {net} ({x}, {y})");
                        match r.signum() {
                            -1 => n_block += 1,
                            0 => n_free += 1,
                            _ => n_soft += 1,
                        }
                    }
                }
                let rv = ref_via(&bd, net, x, y, 0.6, 0.3, 0.45);
                let nv = bd.via_cost(net, x, y, 0.6, 0.3, 0.45, None);
                assert_eq!(rv.signum(), nv.signum(), "via net {net} ({x}, {y})");
            }
        }
        assert!(n_block > 1000 && n_soft > 100 && n_free > 1000, "coverage {n_block} {n_soft} {n_free}");
    }

    #[test]
    fn audit_sees_a_crossing_once_per_pair() {
        let mut bd = board();
        // a routed track of A crossing the routed track of C on F.Cu
        bd.add(Shape { net: 0, geo: Geo::Seg(2.0, 3.8, 2.0, 5.5, 0.075), clr: 0.15, layers: 1, drill: 0.0, kind: Kind::Track, owner: 0, alive: true });
        let o = Opts { pitch: 0.05, passes: 1, plane_clr: 0.25, hth: 0.45, return_r: 2.0, ret_d: 0.45, ret_drill: 0.2, pres_mult: 1.5, pres_max: 1000.0, hist: 0.3, max_time: 0.0 };
        let (nx, ny, nr) = (201, 201, 2);
        let tot = nx * ny * nr;
        let gr = Grid { x0: 0.0, y0: 0.0, p: 0.05, nx, ny, nr, cache: vec![0; tot], vcache: vec![0; nx * ny], dcache: vec![0; tot], hist: vec![0.0; tot], vhist: vec![0.0; nx * ny], pres: 0.5,
                        g: vec![0.0; tot], from: vec![0; tot], seen: vec![0; tot], tgt: vec![0; tot], sgen: 0, tgen: 0 };
        let nn = bd.nets.len();
        let mut ctx = Ctx { bd: &mut bd, gr, o: &o, strict: false, dead: vec![(Vec::new(), String::new()); nn], memo: Vec::new(), memo_w: vec![0.15] };
        let a = ctx.audit(0.3);
        assert_eq!(a.pairs, 1, "one crossing = one pair");
        assert_eq!(a.hard, 0);
        assert!(a.partners[0].contains(&2) && a.partners[2].contains(&0));
        assert_eq!(a.per_net[1], 0);
        assert!(ctx.gr.hist.iter().any(|&h| h > 0.0));
    }

    /// A via or track site that the search sees as free must not create a conflict that the audit sees from the
    /// other item's side (v1 let a via sit 0.15 mm from a fast track that needs 0.25 mm to a foreign drilled item).
    #[test]
    fn free_sites_stay_legal_from_both_sides() {
        let mut bd = board();
        let o = Opts { pitch: 0.05, passes: 1, plane_clr: 0.25, hth: 0.45, return_r: 2.0, ret_d: 0.45, ret_drill: 0.2, pres_mult: 1.5, pres_max: 1000.0, hist: 0.3, max_time: 0.0 };
        let (nx, ny, nr) = (201, 201, 2);
        let tot = nx * ny * nr;
        let gr = Grid { x0: 0.0, y0: 0.0, p: 0.05, nx, ny, nr, cache: vec![0; tot], vcache: vec![0; nx * ny], dcache: vec![0; tot], hist: vec![0.0; tot], vhist: vec![0.0; nx * ny], pres: 0.5,
                        g: vec![0.0; tot], from: vec![0; tot], seen: vec![0; tot], tgt: vec![0; tot], sgen: 0, tgen: 0 };
        let nn = bd.nets.len();
        let mut ctx = Ctx { bd: &mut bd, gr, o: &o, strict: false, dead: vec![(Vec::new(), String::new()); nn], memo: Vec::new(), memo_w: vec![0.15] };
        let base = ctx.audit(0.0).pairs;
        let mut seed: u64 = 777;
        let mut rnd = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        let (mut vias, mut tracks) = (0, 0);
        for t in 0..4000 {
            let (x, y) = (rnd() * 10.0, rnd() * 10.0);
            let net = t % 3;
            let id = ctx.bd.shapes.len();
            if t % 2 == 0 {
                let (d, dr) = if t % 4 == 0 { (0.6, 0.3) } else { (0.45, 0.2) };
                if ctx.bd.via_cost(net, x, y, d, dr, 0.45, None) != 0 {
                    continue;
                }
                ctx.bd.add(Shape { net: net as i32, geo: Geo::Circ(x, y, d / 2.0), clr: ctx.bd.nets[net].clr, layers: 0b111, drill: dr, kind: Kind::Via, owner: net as i32, alive: true });
                vias += 1;
            } else {
                let l = if t % 4 == 1 { 0 } else { 2 };
                if ctx.bd.track_cost(net, l, x, y, 0.075, 0.25, None) != 0 {
                    continue;
                }
                ctx.bd.add(Shape { net: net as i32, geo: Geo::Seg(x, y, x, y, 0.075), clr: ctx.bd.nets[net].clr, layers: 1 << l, drill: 0.0, kind: Kind::Track, owner: net as i32, alive: true });
                tracks += 1;
            }
            let a = ctx.audit(0.0);
            assert_eq!(a.pairs, base, "site ({x}, {y}) net {net} kind {}", t % 4);
            assert_eq!(a.hard, 0);
            ctx.bd.shapes[id].alive = false;
            ctx.bd.compact();
        }
        assert!(vias > 200 && tracks > 200, "coverage {vias} {tracks}");
    }
}
