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
                    if f(&self.shapes[id as usize]) {
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
    /// A track of `net` with half width hw may have its centre at (x, y) on copper layer l.
    fn track_ok(&self, net: usize, l: usize, x: f64, y: f64, hw: f64, plane_clr: f64) -> bool {
        if !self.inside(x, y, hw) {
            return false;
        }
        let n = &self.nets[net];
        let (clr, fast) = (n.clr, n.fast);
        let r = hw + self.maxc + EPS;
        !self.near(l, x, y, r, &mut |s| {
            if s.net == net as i32 {
                return false;
            }
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
                if ((x - cx).powi(2) + (y - cy).powi(2)).sqrt() - s.drill / 2.0 < hw + HOLE_CLR + EPS {
                    return true;
                }
            }
            s.geo.dist(x, y) < need + EPS
        })
    }
    /// A through via of `net` (diameter d, drill) may stand at (x, y).
    fn via_ok(&self, net: usize, x: f64, y: f64, d: f64, drill: f64, hth: f64) -> bool {
        let vr = d / 2.0;
        if !self.inside(x, y, vr) {
            return false;
        }
        let clr = self.nets[net].clr;
        let r = vr + self.maxc.max(hth) + 1.0;
        for l in 0..self.layer_names.len() {
            let hit = self.near(l, x, y, r, &mut |s| {
                if s.drill > 0.0 {
                    let (cx, cy) = match s.geo {
                        Geo::Circ(cx, cy, _) => (cx, cy),
                        Geo::Rect(a, b, c, d) => ((a + c) / 2.0, (b + d) / 2.0),
                        Geo::Seg(..) => (x + 99.0, y),
                    };
                    let cd = ((x - cx).powi(2) + (y - cy).powi(2)).sqrt();
                    if cd - s.drill / 2.0 - drill / 2.0 < hth {
                        return true; // hole to hole, any net
                    }
                }
                if s.net == net as i32 {
                    // never a via in an own SMD pad (tools/pcbtool.py viapads)
                    return s.kind == Kind::Pad && s.drill == 0.0 && s.geo.dist(x, y) < vr + 0.05;
                }
                s.geo.dist(x, y) < vr + clr.max(s.clr) + EPS
            });
            if hit {
                return false;
            }
        }
        true
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
    cache: Vec<u8>,
    vcache: Vec<u8>,
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

impl<'a> Ctx<'a> {
    fn free(&mut self, net: usize, i: usize, hw: f64) -> bool {
        let c = self.gr.cache[i];
        if c != 0 {
            return c == 1;
        }
        let (r, iy, ix) = self.gr.cell(i);
        let (x, y) = self.gr.xy(ix, iy);
        let ok = self.bd.track_ok(net, self.bd.routable[r], x, y, hw, self.o.plane_clr);
        self.gr.cache[i] = if ok { 1 } else { 2 };
        ok
    }
    fn vfree(&mut self, net: usize, ix: usize, iy: usize) -> bool {
        let k = iy * self.gr.nx + ix;
        let c = self.gr.vcache[k];
        if c != 0 {
            return c == 1;
        }
        let (x, y) = self.gr.xy(ix, iy);
        let n = &self.bd.nets[net];
        let ok = self.bd.via_ok(net, x, y, n.via_d, n.via_drill, self.o.hth);
        self.gr.vcache[k] = if ok { 1 } else { 2 };
        ok
    }

    /// Mark the cells an item covers on the routable layers (as source or target).
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
                    let inside = match s.geo {
                        Geo::Rect(..) => s.geo.dist(x, y) <= 0.0,
                        _ => s.geo.dist(x, y) <= -0.0 + 1e-9,
                    };
                    if inside {
                        v.push(r * n + j * self.gr.nx + i);
                    }
                }
            }
        }
        v
    }

    /// Multi-source A* from `src` cells to any cell marked in tgt (generation tgen). Returns the cell path.
    fn search(&mut self, net: usize, hw: f64, src: &[usize], anchors: &[(f64, f64)], allow_via: bool) -> Option<Vec<usize>> {
        let gr = &mut self.gr;
        gr.sgen += 1;
        let sgen = gr.sgen;
        let (nx, ny, nr, p) = (gr.nx, gr.ny, gr.nr, gr.p);
        let n = nx * ny;
        let lmask = self.bd.nets[net].layers;
        let lcost: Vec<f64> = self.bd.routable.iter().map(|&l| {
            let name = &self.bd.layer_names[l];
            if lmask & (1 << l) == 0 { f64::INFINITY } else if name == "F.Cu" { 1.0 } else if name == "B.Cu" { 1.05 } else { 1.15 }
        }).collect();
        let via_cost = 3.0 + if self.bd.nets[net].max_vias.is_some() { 6.0 } else { 0.0 };
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
            if !self.free(net, s, hw) {
                continue;
            }
            let gr = &mut self.gr;
            if gr.seen[s] == sgen {
                continue;
            }
            gr.seen[s] = sgen;
            gr.g[s] = 0.0;
            gr.from[s] = u32::MAX;
            let (_, iy, ix) = gr.cell(s);
            heap.push(Node { f: h(ix, iy), i: s as u32 });
        }
        let mut pops = 0usize;
        while let Some(Node { f: _, i }) = heap.pop() {
            let i = i as usize;
            pops += 1;
            if pops > 6_000_000 {
                return None;
            }
            if self.gr.tgt[i] == self.gr.tgen {
                let mut path = vec![i];
                let mut c = i;
                while self.gr.from[c] != u32::MAX {
                    c = self.gr.from[c] as usize;
                    path.push(c);
                }
                path.reverse();
                return Some(path);
            }
            let gi = self.gr.g[i];
            let (r, iy, ix) = self.gr.cell(i);
            let mut nb: Vec<(usize, f64)> = Vec::with_capacity(10);
            for (dx, dy) in [(-1i32, 0i32), (1, 0), (0, -1), (0, 1), (-1, -1), (1, -1), (-1, 1), (1, 1)] {
                let (jx, jy) = (ix as i32 + dx, iy as i32 + dy);
                if jx < 0 || jy < 0 || jx >= nx as i32 || jy >= ny as i32 {
                    continue;
                }
                let step = if dx != 0 && dy != 0 { SQ2 } else { 1.0 } * p * lcost[r];
                nb.push((r * n + jy as usize * nx + jx as usize, step));
            }
            if allow_via && nr > 1 && self.vfree(net, ix, iy) {
                for r2 in 0..nr {
                    if r2 != r && lcost[r2].is_finite() {
                        nb.push((r2 * n + iy * nx + ix, via_cost));
                    }
                }
            }
            for (j, c) in nb {
                let gj = gi + c as f32;
                if self.gr.seen[j] == sgen && self.gr.g[j] <= gj {
                    continue;
                }
                if !self.free(net, j, hw) {
                    continue;
                }
                let gr = &mut self.gr;
                gr.seen[j] = sgen;
                gr.g[j] = gj;
                gr.from[j] = i as u32;
                let (_, jy, jx) = gr.cell(j);
                heap.push(Node { f: gj + h(jx, jy), i: j as u32 });
            }
        }
        None
    }

    fn seg_clear(&self, net: usize, l: usize, a: (f64, f64), b: (f64, f64), hw: f64) -> bool {
        let len = ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt();
        let k = (len / (self.gr.p * 0.5)).ceil().max(1.0) as usize;
        (0..=k).all(|t| {
            let f = t as f64 / k as f64;
            self.bd.track_ok(net, l, a.0 + (b.0 - a.0) * f, a.1 + (b.1 - a.1) * f, hw, self.o.plane_clr)
        })
    }

    /// Cell path -> (tracks, vias) with greedy string pulling per layer run.
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
            let s = Shape { net: -1, geo: Geo::Circ(f(&p["x"]), f(&p["y"]), drill / 2.0), clr: 0.28, layers: (1u8 << cu.len()) - 1, drill, kind: Kind::Pad };
            bd.add(s);
            continue;
        }
        let s = Shape { net, geo: Geo::Rect(f(&bb[0]), f(&bb[1]), f(&bb[2]), f(&bb[3])), clr: clr_of(&bd, net), layers, drill, kind: Kind::Pad };
        bd.add(s);
    }
    for c in model["copper"].as_array().unwrap() {
        let net = net_of(c["net"].as_str().unwrap_or(""));
        let clr = clr_of(&bd, net);
        if c["kind"] == "via" {
            let s = Shape { net, geo: Geo::Circ(f(&c["x"]), f(&c["y"]), f(&c["d"]) / 2.0), clr, layers: (1u8 << cu.len()) - 1, drill: f(&c["drill"]), kind: Kind::Via };
            bd.add(s);
        } else {
            let (a, b) = (c["a"].as_array().unwrap(), c["b"].as_array().unwrap());
            let l = lid(c["layer"].as_str().unwrap()).unwrap();
            let s = Shape { net, geo: Geo::Seg(f(&a[0]), f(&a[1]), f(&b[0]), f(&b[1]), f(&c["w"]) / 2.0), clr, layers: 1 << l, drill: 0.0, kind: Kind::Track };
            bd.add(s);
        }
    }
    bd
}

struct Result {
    tracks: Vec<OutTrack>,
    vias: Vec<OutVia>,
    failed: Vec<Fail>,
    notes: Vec<String>,
}

fn route_all(ctx: &mut Ctx, order: &[usize]) -> Result {
    let mut res = Result { tracks: vec![], vias: vec![], failed: vec![], notes: vec![] };
    let nl = ctx.bd.layer_names.len();
    let all = (1u8 << nl) - 1;
    // 1. plane fan-out
    for net in 0..ctx.bd.nets.len() {
        if !ctx.bd.nets[net].plane {
            continue;
        }
        let pads: Vec<Shape> = ctx.bd.shapes.iter().filter(|s| s.net == net as i32 && s.kind == Kind::Pad && s.drill == 0.0).cloned().collect();
        for pad in pads {
            let (cx, cy) = match pad.geo { Geo::Rect(a, b, c, d) => ((a + c) / 2.0, (b + d) / 2.0), _ => continue };
            let has = ctx.bd.shapes.iter().any(|s| s.net == net as i32 && s.kind == Kind::Via && s.geo.dist(cx, cy) < 1.0);
            if has {
                continue;
            }
            let (pw, ph) = match pad.geo { Geo::Rect(a, b, c, d) => (c - a, d - b), _ => (0.3, 0.3) };
            let mut done = false;
            for w in [ctx.bd.nets[net].width.min(0.4).min(pw.min(ph)), 0.25, 0.15] {
                let hw = w / 2.0;
                ctx.gr.reset_cache();
                let src = ctx.cells_of(&pad, pad.layers);
                // targets: free via sites within 2 mm on the pad layer
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
                        if pad.geo.dist(x, y) < 0.35 { continue; }
                        if ctx.vfree(net, i, j) && ctx.free(net, r * n + j * ctx.gr.nx + i, hw) {
                            ctx.gr.tgt[r * n + j * ctx.gr.nx + i] = tg;
                            cands.push((x, y));
                        }
                    }
                }
                if cands.is_empty() {
                    continue;
                }
                cands.sort_by(|a, b| pad.geo.dist(a.0, a.1).partial_cmp(&pad.geo.dist(b.0, b.1)).unwrap());
                let anchors = vec![cands[0]];
                if let Some(path) = ctx.search(net, hw, &src, &anchors, false) {
                    let (ix, iy) = { let (_, iy, ix) = ctx.gr.cell(*path.last().unwrap()); (ix, iy) };
                    let (vx, vy) = ctx.gr.xy(ix, iy);
                    let (tr, _) = ctx.geometry(net, &path, hw);
                    commit(ctx, net, &tr, &[], hw, &mut res);
                    let n_ = &ctx.bd.nets[net];
                    let (d, dr, clr) = (n_.via_d, n_.via_drill, n_.clr);
                    ctx.bd.add(Shape { net: net as i32, geo: Geo::Circ(vx, vy, d / 2.0), clr, layers: all, drill: dr, kind: Kind::Via });
                    res.vias.push(OutVia { net: ctx.bd.nets[net].name.clone(), x: vx, y: vy, d, drill: dr, role: "plane".into() });
                    done = true;
                    break;
                }
            }
            if !done {
                res.failed.push(Fail { net: ctx.bd.nets[net].name.clone(), stage: "plane".into(), reason: format!("no via site within 2 mm of pad at ({cx:.2}, {cy:.2})") });
            }
        }
    }
    // 2. routed nets
    for &net in order {
        route_net(ctx, net, &mut res);
    }
    res
}

fn commit(ctx: &mut Ctx, net: usize, tracks: &[(usize, (f64, f64), (f64, f64))], vias: &[(f64, f64)], hw: f64, res: &mut Result) {
    let clr = ctx.bd.nets[net].clr;
    let name = ctx.bd.nets[net].name.clone();
    for &(l, a, b) in tracks {
        if (a.0 - b.0).abs() < 1e-9 && (a.1 - b.1).abs() < 1e-9 {
            continue;
        }
        ctx.bd.add(Shape { net: net as i32, geo: Geo::Seg(a.0, a.1, b.0, b.1, hw), clr, layers: 1 << l, drill: 0.0, kind: Kind::Track });
        res.tracks.push(OutTrack { net: name.clone(), layer: ctx.bd.layer_names[l].clone(), a: [a.0, a.1], b: [b.0, b.1], w: hw * 2.0 });
    }
    let all = (1u8 << ctx.bd.layer_names.len()) - 1;
    for &(x, y) in vias {
        let (d, dr) = (ctx.bd.nets[net].via_d, ctx.bd.nets[net].via_drill);
        ctx.bd.add(Shape { net: net as i32, geo: Geo::Circ(x, y, d / 2.0), clr, layers: all, drill: dr, kind: Kind::Via });
        res.vias.push(OutVia { net: name.clone(), x, y, d, drill: dr, role: "signal".into() });
    }
}

fn return_via(ctx: &mut Ctx, x: f64, y: f64, res: &mut Result) -> bool {
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
            ctx.bd.add(Shape { net: g, geo: Geo::Circ(px, py, d / 2.0), clr, layers: all, drill: dr, kind: Kind::Via });
            res.vias.push(OutVia { net: "GND".into(), x: px, y: py, d, drill: dr, role: "return".into() });
            return true;
        }
    }
    false
}

fn route_net(ctx: &mut Ctx, net: usize, res: &mut Result) {
    let items: Vec<usize> = (0..ctx.bd.shapes.len()).filter(|&i| ctx.bd.shapes[i].net == net as i32).collect();
    if items.len() < 2 {
        return;
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
    // pads only count: a component without a pad of the net is a dangling piece and is joined like the others
    let nmask = ctx.bd.nets[net].layers;
    let name = ctx.bd.nets[net].name.clone();
    let base_w = ctx.bd.nets[net].width;
    let widths: Vec<f64> = if ctx.bd.nets[net].power { vec![base_w, 0.3, 0.2, 0.15] } else { vec![base_w] };
    let mut tree = comps.remove(0);
    let mut new_vias = Vec::new();
    while !comps.is_empty() {
        let mut ok = false;
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
            if let Some(path) = ctx.search(net, hw, &src, &anchors, true) {
                let last = *path.last().unwrap();
                let (_, iy, ix) = ctx.gr.cell(last);
                let (gx, gy) = ctx.gr.xy(ix, iy);
                let (tr, vs) = ctx.geometry(net, &path, hw);
                let first_new = ctx.bd.shapes.len();
                commit(ctx, net, &tr, &vs, hw, res);
                new_vias.extend(vs.iter().cloned());
                if w < base_w {
                    res.notes.push(format!("{name}: neck {w:.2} mm (class {base_w:.2})"));
                }
                // which component did we reach
                let ci = comps.iter().position(|comp| comp.iter().any(|&s| ctx.bd.shapes[s].geo.dist(gx, gy) <= 1e-6 + match ctx.bd.shapes[s].geo { Geo::Seg(..) | Geo::Circ(..) => 0.0, _ => 0.0 })).unwrap_or(0);
                let reached = comps.remove(ci);
                tree.extend(reached);
                tree.extend(first_new..ctx.bd.shapes.len());
                ok = true;
                break;
            }
        }
        if !ok {
            res.failed.push(Fail { net: name.clone(), stage: "route".into(), reason: format!("{} component(s) not reached", comps.len()) });
            break;
        }
    }
    let n = ctx.bd.nets[net].clone();
    if let Some(mv) = n.max_vias {
        let total = ctx.bd.shapes.iter().filter(|s| s.net == net as i32 && s.kind == Kind::Via).count();
        if total as f64 > mv {
            res.notes.push(format!("{name}: {total} vias over the DRU via_count max {mv}"));
        }
    }
    let _ = n.max_len;
    for (x, y) in new_vias {
        if !return_via(ctx, x, y, res) {
            res.notes.push(format!("{name}: no GND return via within {} mm of ({x:.2}, {y:.2})", ctx.o.return_r));
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: iotroute MODEL.json OUT.json [--pitch 0.05] [--passes 4] [--plane-clr 0.25] [--hole-to-hole 0.45] [--return-r 2.0] [--return-via 0.45,0.2]");
        std::process::exit(2);
    }
    let mut o = Opts { pitch: 0.05, passes: 4, plane_clr: 0.25, hth: 0.45, return_r: 2.0, ret_d: 0.45, ret_drill: 0.2 };
    let mut i = 3;
    while i + 1 < args.len() {
        let v = &args[i + 1];
        match args[i].as_str() {
            "--pitch" => o.pitch = v.parse().unwrap(),
            "--passes" => o.passes = v.parse().unwrap(),
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
    let model: Value = serde_json::from_str(&std::fs::read_to_string(&args[1]).expect("model")).expect("json");
    let mut bd = load(&model);
    let base = bd.shapes.len();
    let (e0, e1, e2, e3) = bd.edge;
    let nx = ((e2 - e0) / o.pitch).ceil() as usize + 1;
    let ny = ((e3 - e1) / o.pitch).ceil() as usize + 1;
    let nr = bd.routable.len();
    let tot = nx * ny * nr;
    let gr = Grid { x0: e0, y0: e1, p: o.pitch, nx, ny, nr, cache: vec![0; tot], vcache: vec![0; nx * ny], g: vec![0.0; tot], from: vec![0; tot], seen: vec![0; tot], tgt: vec![0; tot], sgen: 0, tgen: 0 };
    // order: power, fast, slow; inside a group the smallest pin bounding box first
    let mut order: Vec<usize> = (0..bd.nets.len()).filter(|&n| !bd.nets[n].plane).collect();
    let spread = |bd: &Board, n: usize| -> f64 {
        let (mut a, mut b, mut c, mut d) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for s in bd.shapes.iter().filter(|s| s.net == n as i32 && s.kind == Kind::Pad) {
            let (x0, y0, x1, y1) = s.geo.bbox();
            a = a.min(x0); b = b.min(y0); c = c.max(x1); d = d.max(y1);
        }
        if a == f64::MAX { 0.0 } else { (c - a) + (d - b) }
    };
    let group = |bd: &Board, n: usize| if bd.nets[n].power { 0 } else if bd.nets[n].fast { 1 } else { 2 };
    order.sort_by(|&a, &b| group(&bd, a).cmp(&group(&bd, b)).then(spread(&bd, a).partial_cmp(&spread(&bd, b)).unwrap()));
    let mut ctx = Ctx { bd: &mut bd, gr, o: &o };
    let mut best: Option<Result> = None;
    let mut passes = 0;
    for pass in 0..o.passes {
        passes = pass + 1;
        ctx.bd.truncate(base);
        let res = route_all(&mut ctx, &order);
        let nf = res.failed.len();
        eprintln!("pass {}: {} tracks, {} vias, {} failed: {}", pass + 1, res.tracks.len(), res.vias.len(), nf,
                  res.failed.iter().map(|f| f.net.as_str()).collect::<Vec<_>>().join(" "));
        let failed: Vec<String> = res.failed.iter().map(|f| f.net.clone()).collect();
        let better = best.as_ref().map(|b| nf < b.failed.len()).unwrap_or(true);
        if better {
            best = Some(res);
        }
        if nf == 0 {
            break;
        }
        // failed nets go first in the next pass
        let (mut first, rest): (Vec<usize>, Vec<usize>) = order.iter().partition(|&&n| failed.contains(&ctx.bd.nets[n].name));
        first.extend(rest);
        order = first;
    }
    let r = best.unwrap();
    let out = Out { schema: "iot-lab.route-result.v0".into(), tracks: r.tracks, vias: r.vias, failed: r.failed.clone(), notes: r.notes, passes };
    std::fs::write(&args[2], serde_json::to_string_pretty(&out).unwrap()).expect("write");
    let status = if out.failed.is_empty() { "PASS" } else { "FAIL" };
    println!("ROUTE {status} tracks {} vias {} failed {} notes {} passes {} -> {}", out.tracks.len(), out.vias.len(), out.failed.len(), out.notes.len(), passes, args[2]);
}
