//! iotroute: rule-native grid router core (tools/router/DESIGN.md, M1).
//!
//!   iotroute MODEL.json OUT.json [--pitch 0.05] [--passes 4] [--plane-clr 0.25] [--hole-to-hole 0.45]
//!            [--return-r 2.0] [--return-via 0.45,0.2]
//!
//! MODEL.json comes from tools/router/model.py (schema iot-lab.route-model.v0). Every clearance is checked against
//! exact geometry (pads as their bounding rectangle, tracks as capsules, vias as circles) with the per-net width and
//! clearance of the model; the grid only decides where the search may step. Stages, in this order:
//!   1. plane fan-out: every SMD pad of a plane net (reference-planes.json) gets a via to its plane, unless an own via
//!      is already within 1 mm (CLAUDE.md: a ground via next to each ground pad).
//!   2. routed nets: power class first, then fast nets, then slow nets; shortest first inside a group. A net is a set
//!      of components (pads + existing copper that touch); the search joins them one by one (multi-source A*).
//!   3. return vias: each new signal via gets a GND via within --return-r (kicad-happy RP-001).
//! NET-CORE lessons (2026-10-31) built in: a fast net keeps --plane-clr from every foreign drilled item, so it never
//! runs over a plane antipad (si_planes fast-crossing); a GND via may go through a foreign plane (antipad), it is
//! checked only against copper items.
//! The output is a proposal: KiCad DRC with parity and tools/gate.mjs decide. Last line: ROUTE PASS|FAIL ... summary.
use serde::Serialize;
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::BinaryHeap;

const EPS: f64 = 0.002;
const HOLE_CLR: f64 = 0.28; // .kicad_dru "JLC PTH hole to copper"; TODO read it from the model rules
const SQ2: f64 = std::f64::consts::SQRT_2;

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
    fn remove_from(&mut self, first: usize) {
        for l in self.cells.iter_mut() {
            for c in l.iter_mut() {
                c.retain(|&id| (id as usize) < first);
            }
        }
    }
}

struct Board {
    layer_names: Vec<String>,
    routable: Vec<usize>, // copper layer index of each routable layer
    nets: Vec<Net>,
    shapes: Vec<Shape>,
    idx: Index,
    maxc: f64,
    edge: (f64, f64, f64, f64),
    edge_clr: f64,
    gnd: i32,
}

impl Board {
    fn add(&mut self, s: Shape) -> usize {
        let id = self.shapes.len();
        self.idx.insert(id as u32, &s);
        self.shapes.push(s);
        id
    }
    fn truncate(&mut self, n: usize) {
        self.idx.remove_from(n);
        self.shapes.truncate(n);
    }
    fn near(&self, l: usize, x: f64, y: f64, r: f64, f: &mut dyn FnMut(&Shape) -> bool) -> bool {
        let ix = &self.idx;
        let (i0, i1) = (ix.range(x - r, ix.x0, ix.nx), ix.range(x + r, ix.x0, ix.nx));
        let (j0, j1) = (ix.range(y - r, ix.y0, ix.ny), ix.range(y + r, ix.y0, ix.ny));
        for j in j0..=j1 {
            for i in i0..=i1 {
                for &id in &ix.cells[l][j * ix.nx + i] {
                    let s = &self.shapes[id as usize];
                    if s.alive && f(s) {
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
    /// Track centre of `net` (half width hw) at (x, y) on copper layer l: -1 = blocked by fixed copper or the edge,
    /// k >= 0 = number of routed items of other nets it conflicts with. `owners` collects their owner nets.
    fn track_cost(&self, net: usize, l: usize, x: f64, y: f64, hw: f64, plane_clr: f64, owners: Option<&mut Vec<i32>>) -> i32 {
        if !self.inside(x, y, hw) {
            return -1;
        }
        let n = &self.nets[net];
        let (clr, fast) = (n.clr, n.fast);
        let r = hw + self.maxc.max(plane_clr).max(HOLE_CLR) + 0.6;
        let mut k = 0;
        let mut own = owners;
        let hard = self.near(l, x, y, r, &mut |s| {
            if s.net == net as i32 {
                return false;
            }
            let mut need = hw + clr.max(s.clr);
            let mut hit = false;
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
                hit = ((x - cx).powi(2) + (y - cy).powi(2)).sqrt() - s.drill / 2.0 < hw + HOLE_CLR + EPS;
            }
            hit = hit || s.geo.dist(x, y) < need + EPS;
            if !hit {
                return false;
            }
            if s.owner < 0 {
                return true;
            }
            k += 1;
            if let Some(o) = own.as_deref_mut() {
                if !o.contains(&s.owner) {
                    o.push(s.owner);
                }
            }
            false
        });
        if hard { -1 } else { k }
    }
    fn track_ok(&self, net: usize, l: usize, x: f64, y: f64, hw: f64, plane_clr: f64) -> bool {
        self.track_cost(net, l, x, y, hw, plane_clr, None) == 0
    }
    /// Through via of `net` (diameter d, drill) at (x, y): -1 blocked, k >= 0 soft conflicts (as track_cost).
    fn via_cost(&self, net: usize, x: f64, y: f64, d: f64, drill: f64, hth: f64, owners: Option<&mut Vec<i32>>) -> i32 {
        let vr = d / 2.0;
        if !self.inside(x, y, vr) {
            return -1;
        }
        let clr = self.nets[net].clr;
        let r = vr + self.maxc.max(hth) + 1.0;
        let mut k = 0;
        let mut own = owners;
        for l in 0..self.layer_names.len() {
            let hard = self.near(l, x, y, r, &mut |s| {
                let mut hit = false;
                if s.drill > 0.0 {
                    let (cx, cy) = match s.geo {
                        Geo::Circ(cx, cy, _) => (cx, cy),
                        Geo::Rect(a, b, c, d) => ((a + c) / 2.0, (b + d) / 2.0),
                        Geo::Seg(..) => (x + 99.0, y),
                    };
                    let cd = ((x - cx).powi(2) + (y - cy).powi(2)).sqrt();
                    hit = cd - s.drill / 2.0 - drill / 2.0 < hth; // hole to hole, any net
                }
                if !hit {
                    if s.net == net as i32 {
                        // never a via in an own SMD pad (tools/pcbtool.py viapads)
                        if s.kind == Kind::Pad && s.drill == 0.0 && s.geo.dist(x, y) < vr + 0.05 {
                            return true;
                        }
                        return false;
                    }
                    hit = s.geo.dist(x, y) < vr + clr.max(s.clr) + EPS;
                }
                if !hit {
                    return false;
                }
                if s.owner < 0 {
                    return true;
                }
                k += 1;
                if let Some(o) = own.as_deref_mut() {
                    if !o.contains(&s.owner) {
                        o.push(s.owner);
                    }
                }
                false
            });
            if hard {
                return -1;
            }
        }
        k
    }
    fn via_ok(&self, net: usize, x: f64, y: f64, d: f64, drill: f64, hth: f64) -> bool {
        self.via_cost(net, x, y, d, drill, hth, None) == 0
    }
    /// Rebuild the spatial index without the dead (ripped-up) items.
    fn compact(&mut self) {
        let shapes: Vec<Shape> = self.shapes.drain(..).filter(|s| s.alive).collect();
        for l in self.idx.cells.iter_mut() {
            for c in l.iter_mut() {
                c.clear();
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
    }
}

struct Ctx<'a> {
    bd: &'a mut Board,
    gr: Grid,
    o: &'a Opts,
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
            c = code(self.bd.track_cost(net, self.bd.routable[r], x, y, hw, self.o.plane_clr, None));
            self.gr.cache[i] = c;
        }
        if c == 1 { None } else { Some((c - 2) as u32) }
    }
    fn free(&mut self, net: usize, i: usize, hw: f64) -> bool {
        self.cost(net, i, hw) == Some(0)
    }
    fn vcost(&mut self, net: usize, ix: usize, iy: usize) -> Option<u32> {
        let k = iy * self.gr.nx + ix;
        let mut c = self.gr.vcache[k];
        if c == 0 {
            let (x, y) = self.gr.xy(ix, iy);
            let n = &self.bd.nets[net];
            c = code(self.bd.via_cost(net, x, y, n.via_d, n.via_drill, self.o.hth, None));
            self.gr.vcache[k] = c;
        }
        if c == 1 { None } else { Some((c - 2) as u32) }
    }
    fn vfree(&mut self, net: usize, ix: usize, iy: usize) -> bool {
        self.vcost(net, ix, iy) == Some(0)
    }

    /// The cells an item covers on the routable layers (as source or target).
    fn cells_of(&self, s: &Shape, net_layers: u8) -> Vec<usize> {
        let mut v = Vec::new();
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
                    if s.geo.dist(x, y) <= 1e-9 {
                        v.push(r * n + j * self.gr.nx + i);
                    }
                }
            }
        }
        v
    }

    /// Multi-source A* from `src` cells to any cell marked in tgt (generation tgen). Step cost = length x layer
    /// factor x (1 + history) x (1 + pres x soft conflicts). With strict, soft conflicts block (fan-out stage).
    fn search(&mut self, net: usize, hw: f64, src: &[usize], anchors: &[(f64, f64)], allow_via: bool, strict: bool) -> Result<Vec<usize>, bool> {
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
            heap.push(Node { f: h(ix, iy), i: s as u32 });
        }
        let mut pops = 0usize;
        while let Some(Node { f: _, i }) = heap.pop() {
            let i = i as usize;
            pops += 1;
            if pops > 8_000_000 {
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
            let mut nb: Vec<(usize, f64, bool)> = Vec::with_capacity(10);
            for (dx, dy) in [(-1i32, 0i32), (1, 0), (0, -1), (0, 1), (-1, -1), (1, -1), (-1, 1), (1, 1)] {
                let (jx, jy) = (ix as i32 + dx, iy as i32 + dy);
                if jx < 0 || jy < 0 || jx >= nx as i32 || jy >= ny as i32 {
                    continue;
                }
                let step = if dx != 0 && dy != 0 { SQ2 } else { 1.0 } * p * lcost[r];
                nb.push((r * n + jy as usize * nx + jx as usize, step, false));
            }
            if allow_via && nr > 1 {
                if let Some(kv) = self.vcost(net, ix, iy) {
                    if !(strict && kv > 0) {
                        let vc = (via_base + self.gr.vhist[iy * nx + ix] as f64) * (1.0 + pres * kv as f64);
                        for r2 in 0..nr {
                            if r2 != r && lcost[r2].is_finite() {
                                nb.push((r2 * n + iy * nx + ix, vc, true));
                            }
                        }
                    }
                }
            }
            for (j, c, is_via) in nb {
                let k = match self.cost(net, j, hw) {
                    None => continue,
                    Some(k) => k,
                };
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
                heap.push(Node { f: gj + h(jx, jy), i: j as u32 });
            }
        }
        Err(false)
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
    let mut bd = Board { layer_names: cu.clone(), routable, nets, shapes: Vec::new(), idx, maxc, edge, edge_clr, gnd };
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
    let mut out = NetResult { hard_fail: None, limit: false, conflicts: 0, owners: vec![], cells: vec![], vias: vec![] };
    let all = (1u8 << ctx.bd.layer_names.len()) - 1;
    let pads: Vec<Shape> = ctx.bd.shapes.iter().filter(|s| s.alive && s.net == net as i32 && s.kind == Kind::Pad && s.drill == 0.0).cloned().collect();
    let mut misses = Vec::new();
    let pres = ctx.gr.pres as f64;
    for pad in pads {
        let (cx, cy) = match pad.geo { Geo::Rect(a, b, c, d) => ((a + c) / 2.0, (b + d) / 2.0), _ => continue };
        let has = ctx.bd.shapes.iter().any(|s| s.alive && s.net == net as i32 && s.kind == Kind::Via && s.geo.dist(cx, cy) < 1.0);
        if has {
            continue;
        }
        let (pw, ph) = match pad.geo { Geo::Rect(a, b, c, d) => (c - a, d - b), _ => (0.3, 0.3) };
        let mut done = false;
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
                    ctx.gr.tgt[r * n + j * ctx.gr.nx + i] = tg;
                    cands.push((pad.geo.dist(x, y) * (1.0 + pres * (kv + kt) as f64), x, y));
                }
            }
            if cands.is_empty() {
                continue;
            }
            cands.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
            let anchors = vec![(cands[0].1, cands[0].2)];
            if let Ok(path) = ctx.search(net, hw, &src, &anchors, false, false) {
                let last = *path.last().unwrap();
                let (_, iy, ix) = ctx.gr.cell(last);
                let (vx, vy) = ctx.gr.xy(ix, iy);
                let mut k: u32 = 0;
                for &c in &path {
                    let (rr, iy2, ix2) = ctx.gr.cell(c);
                    let (x, y) = ctx.gr.xy(ix2, iy2);
                    let mut own = Vec::new();
                    let kc = ctx.bd.track_cost(net, ctx.bd.routable[rr], x, y, hw, ctx.o.plane_clr, Some(&mut own));
                    if kc > 0 {
                        k += kc as u32;
                        out.cells.push(c);
                        for o in own { if !out.owners.contains(&o) { out.owners.push(o); } }
                    }
                }
                let n_ = ctx.bd.nets[net].clone();
                let mut own = Vec::new();
                let kv = ctx.bd.via_cost(net, vx, vy, n_.via_d, n_.via_drill, ctx.o.hth, Some(&mut own));
                if kv > 0 {
                    k += kv as u32;
                    ctx.gr.vhist[iy * ctx.gr.nx + ix] += 0.3;
                    for o in own { if !out.owners.contains(&o) { out.owners.push(o); } }
                }
                out.conflicts += k;
                let (tr, _) = ctx.geometry(net, &path, hw);
                add_copper(ctx, net, net as i32, &tr, &[], hw);
                ctx.bd.add(Shape { net: net as i32, geo: Geo::Circ(vx, vy, n_.via_d / 2.0), clr: n_.clr, layers: all, drill: n_.via_drill, kind: Kind::Via, owner: net as i32, alive: true });
                done = true;
                break;
            }
        }
        if !done {
            misses.push(format!("({cx:.2}, {cy:.2})"));
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
    owners: Vec<i32>,
    cells: Vec<usize>,
    vias: Vec<(f64, f64)>,
}

/// Rip up the copper this net routed before, then join its components again against the present congestion.
fn route_net(ctx: &mut Ctx, net: usize) -> NetResult {
    for s in ctx.bd.shapes.iter_mut() {
        if s.owner == net as i32 {
            s.alive = false;
        }
    }
    let mut out = NetResult { hard_fail: None, limit: false, conflicts: 0, owners: vec![], cells: vec![], vias: vec![] };
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
            for comp in &comps {
                for &s in comp {
                    let sh = ctx.bd.shapes[s].clone();
                    for c in ctx.cells_of(&sh, nmask) {
                        ctx.gr.tgt[c] = tg;
                    }
                    for (x, y, _) in sh.geo.probes() {
                        anchors.push((x, y));
                    }
                }
            }
            let found = ctx.search(net, hw, &src, &anchors, true, false);
            if let Err(true) = found {
                limit = true;
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
            } else if tree_pads(ctx, &tree).len() > 0 && !comps.is_empty() && trapped.len() < 4 {
                // the start component is walled in by fixed copper: record it, start again from the next component
                trapped.push(tree_pads(ctx, &tree).join(","));
                tree = comps.remove(0);
                continue;
            } else {
                out.hard_fail = Some(format!("{} component(s) not reachable past fixed copper", comps.len()));
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
        if k > 0 {
            let n = ctx.gr.nx * ctx.gr.ny;
            for &c in &path {
                let (r, iy, ix) = ctx.gr.cell(c);
                let (x, y) = ctx.gr.xy(ix, iy);
                let mut own = Vec::new();
                if ctx.bd.track_cost(net, ctx.bd.routable[r], x, y, hw, ctx.o.plane_clr, Some(&mut own)) > 0 {
                    out.cells.push(c);
                    for o in own {
                        if !out.owners.contains(&o) {
                            out.owners.push(o);
                        }
                    }
                }
                let _ = n;
            }
        }
        out.conflicts += k;
        let (tr, vs) = ctx.geometry(net, &path, hw);
        let first_new = ctx.bd.shapes.len();
        add_copper(ctx, net, net as i32, &tr, &vs, hw);
        out.vias.extend(vs.iter().cloned());
        let ci = comps.iter().position(|comp| comp.iter().any(|&s| ctx.bd.shapes[s].geo.dist(gx, gy) <= 1e-6)).unwrap_or(0);
        let reached = comps.remove(ci);
        tree.extend(reached);
        tree.extend(first_new..ctx.bd.shapes.len());
    }
    if !trapped.is_empty() && out.hard_fail.is_none() {
        out.hard_fail = Some(format!("walled in by fixed copper (input placement / locked routes): pad(s) at {}", trapped.join("; ")));
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
        eprintln!("usage: iotroute MODEL.json OUT.json [--pitch 0.05] [--iters 40] [--plane-clr 0.25] [--hole-to-hole 0.45] [--return-r 2.0] [--return-via 0.45,0.2]");
        std::process::exit(2);
    }
    let mut o = Opts { pitch: 0.05, passes: 40, plane_clr: 0.25, hth: 0.45, return_r: 2.0, ret_d: 0.45, ret_drill: 0.2 };
    let mut i = 3;
    while i + 1 < args.len() {
        let v = &args[i + 1];
        match args[i].as_str() {
            "--pitch" => o.pitch = v.parse().unwrap(),
            "--iters" | "--passes" => o.passes = v.parse().unwrap(),
            "--plane-clr" => o.plane_clr = v.parse().unwrap(),
            "--hole-to-hole" => o.hth = v.parse().unwrap(),
            "--return-r" => o.return_r = v.parse().unwrap(),
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
    let base0 = bd.shapes.len();
    let (e0, e1, e2, e3) = bd.edge;
    let nx = ((e2 - e0) / o.pitch).ceil() as usize + 1;
    let ny = ((e3 - e1) / o.pitch).ceil() as usize + 1;
    let nr = bd.routable.len();
    let tot = nx * ny * nr;
    let gr = Grid { x0: e0, y0: e1, p: o.pitch, nx, ny, nr, cache: vec![0; tot], vcache: vec![0; nx * ny], hist: vec![0.0; tot], vhist: vec![0.0; nx * ny], pres: 0.5,
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
    let mut ctx = Ctx { bd: &mut bd, gr, o: &o };
    let fan_fail: Vec<Fail> = Vec::new();
    let nn = ctx.bd.nets.len();
    let mut todo: Vec<usize> = order.clone();
    let mut state: Vec<(Option<String>, u32)> = vec![(None, 0); nn];
    let mut iters = 0;
    let mut converged = false;
    for it in 0..o.passes {
        iters = it + 1;
        ctx.bd.compact();
        let mut involved: Vec<usize> = Vec::new();
        let mut total = 0u32;
        let mut hard = 0;
        for &net in &todo {
            let r = if ctx.bd.nets[net].plane { fanout_net(&mut ctx, net) } else { route_net(&mut ctx, net) };
            for &c in &r.cells {
                ctx.gr.hist[c] += 0.3;
            }
            if r.conflicts > 0 {
                involved.push(net);
                for &ow in &r.owners {
                    if ow >= 0 && !involved.contains(&(ow as usize)) {
                        involved.push(ow as usize);
                    }
                }
            }
            if r.hard_fail.is_some() {
                hard += 1;
            }
            total += r.conflicts;
            state[net] = (r.hard_fail.clone(), r.conflicts);
            let _ = r.vias;
        }
        // nets whose own conflicts were counted earlier but are now involved again are re-routed next iteration
        let hard_nets: Vec<usize> = order.iter().cloned().filter(|&n| state[n].0.is_some()).collect();
        eprintln!("iter {:2}: routed {:3}, conflicts {:5}, involved {:3}, hard fails {:2}, pres {:.2}, {:.1} s  hard: {}  involved: {}",
                  it + 1, todo.len(), total, involved.len(), hard, ctx.gr.pres, t0.elapsed().as_secs_f64(),
                  hard_nets.iter().map(|&n| ctx.bd.nets[n].name.as_str()).collect::<Vec<_>>().join(" "),
                  if involved.len() <= 12 { involved.iter().map(|&n| ctx.bd.nets[n].name.as_str()).collect::<Vec<_>>().join(" ") } else { String::from("...") });
        if involved.is_empty() {
            converged = true;
            break;
        }
        ctx.gr.pres = (ctx.gr.pres * 1.5).min(8.0);
        todo = order.iter().cloned().filter(|n| involved.contains(n) || hard_nets.contains(n)).collect();
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
