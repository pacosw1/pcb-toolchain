//! Pour model (v5): the KiCad fill of the outer-layer pours (model `zones` on routable layers) on a fine grid, and the
//! KiCad starved-thermal rule evaluated on it.
//!
//! Fill (KiCad ZONE_FILLER): zone outline and board edge (copper-to-edge clearance), minus every foreign item grown by
//! its clearance to the zone (max of zone clearance, both net clearances and the DRU rules that name a zone, model
//! `net_clearance`; a drilled item also keeps the hole clearance from its hole edge), minus the thermal relief of each
//! same-net pad (pad grown by the relief gap), plus its spokes (spoke width, in the directions orientation + thermal
//! spoke angle + k x 90 degrees; a spoke is added only when its test point at pad extent + gap + max error +
//! min_thickness / 2 lies in the fill, KiCad zone_filler.cpp). The min-thickness opening (deflate then inflate by half the min width) is modelled
//! by its erosion: a grid point is fill when it keeps clearance + min_thickness / 2 from every foreign item. Pieces =
//! 4-connected components of the fill points (4-connected: a diagonal touch is never taken as a connection).
//!
//! Rule (pcbnew/drc/drc_test_provider_zone_connections.cpp): a pad with a thermal connection counts one spoke per
//! crossing of its spokes with the ring at half the relief gap. A spoke into a fill piece with exactly one connected
//! item (m_SingleConnectionOutlines: the piece touches only this pad) is ignored. Connected items of a piece: same-net
//! pads (by their spokes, or their copper for a full connection), vias (inside the via copper) and track ends. Below
//! min_spokes, each track of the net from inside the ring to the fill adds one spoke; with no other spoke the ignored
//! ones count again; still below = starved_thermal. A custom pad needs as many spokes as it has proxy segments (model
//! `proxy_spokes`; 0 = never starved). island_removal_mode only removes pieces with no item: it does not change this
//! rule, and is reported only.
//!
//! v6 (KiCad 10 zone_filler.cpp fillCopperZone, read 2026-11-01): the spokes are added to the fill before the
//! min-width deflate, so the model erodes the union (a cell is fill when its min_thickness / 2 disk has no point in the
//! raw relief outside the raw spokes), and the drill hole of each thermal pad is cut after the re-inflation
//! (addHoleKnockout( pad, 0 )), which splits the spoke cross at the pad centre.
//!
//! Checked against KiCad 10 DRC (iotroute --check): NET-CORE v4 failing board: only C46.2 (1 spoke, 2 to an island, as
//! the KiCad message); v4 board of 1faf8ad8, both v5 boards and the M2 NET-CORE regression (KiCad DRC 0): no fault.
//! H7-CORE M2 run 1: only J2.16 (1 + 1 ignored), run 6: only J2.18 (1 + 2 ignored), runs 2 and 4 (DRC 0): no fault.
use crate::*;
use std::collections::{HashMap, HashSet, VecDeque};

/// grid pitch of the pour model (mm): a channel is seen as fill when it is at least min_thickness + this wide
pub(crate) const POUR_PITCH: f64 = 0.025;
const FIX: u8 = 1; // fixed foreign copper + clearance
const ROUT: u8 = 2; // routed foreign copper + clearance
const RELIEF: u8 = 4; // thermal relief gap of a same-net pad
const SPOKE: u8 = 8; // spoke strip of a same-net pad
const OUT: u8 = 16; // outside the zone or the board edge clearance
/// KiCad board max error (m_MaxError, default 0.005 mm): the spoke test point lies this far beyond the relief gap
const MAX_ERROR: f64 = 0.005;
/// largest door search (cells) before the fault is treated as not fixable by moving routed copper
const DOOR_MAX: usize = 3_000_000;

#[derive(Clone)]
pub(crate) struct PourPad {
    pub geo: Geo,
    /// 0 thermal, 1 full, 2 none
    pub conn: u8,
    /// unit vectors of the spokes
    pub dirs: Vec<(f64, f64)>,
    pub name: String,
    /// custom pad: its number of proxy spoke segments (KiCad: the spokes it needs; 0 = never starved)
    pub proxy: Option<usize>,
    /// drilled pad: hole centre and radius (KiCad cuts the hole out of the fill after the spokes)
    pub hole: Option<(f64, f64, f64)>,
}

#[derive(Clone)]
pub(crate) struct Pour {
    pub net: i32,
    pub layer: usize,
    pub clr: f64,
    pub gap: f64,
    pub sw: f64,
    pub mt: f64,
    pub bbox: [f64; 4],
    pub min_spokes: usize,
    pub pads: Vec<PourPad>,
    /// DRU clearance of a net's items to the zone: (track, via, pad)
    pub net_clr: HashMap<i32, (f64, f64, f64)>,
    pub island_mode: i64,
}

/// A thermal pad whose pour spokes do not reach a piece with another connection (KiCad starved_thermal).
#[derive(Clone, Debug)]
pub(crate) struct Fault {
    pub pour: usize,
    pub layer: usize,
    pub pad: String,
    pub good: usize,
    pub ignored: usize,
    /// door: the cells (x, y) of the cheapest way from the pad's spokes to a connected piece that only routed copper
    /// blocks; path: the whole way (spoke ring to the connected piece)
    pub door: Vec<(f64, f64)>,
    pub path: Vec<(f64, f64)>,
    /// owner nets of the routed copper on the door
    pub walls: Vec<usize>,
    /// no door: fixed copper (input) alone makes the island
    pub fixed: bool,
}

struct Raster {
    x0: f64,
    y0: f64,
    p: f64,
    nx: usize,
    ny: usize,
    m: Vec<u8>,
    lab: Vec<u32>,
}

impl Raster {
    fn cell(&self, x: f64, y: f64) -> Option<usize> {
        let i = ((x - self.x0) / self.p).round();
        let j = ((y - self.y0) / self.p).round();
        if i < 0.0 || j < 0.0 || i >= self.nx as f64 || j >= self.ny as f64 {
            return None;
        }
        Some(j as usize * self.nx + i as usize)
    }
    fn xy(&self, k: usize) -> (f64, f64) {
        (self.x0 + (k % self.nx) as f64 * self.p, self.y0 + (k / self.nx) as f64 * self.p)
    }
    fn range(&self, bb: (f64, f64, f64, f64)) -> Option<(usize, usize, usize, usize)> {
        let i0 = ((bb.0 - self.x0) / self.p).floor().max(0.0);
        let j0 = ((bb.1 - self.y0) / self.p).floor().max(0.0);
        let i1 = ((bb.2 - self.x0) / self.p).ceil().min(self.nx as f64 - 1.0);
        let j1 = ((bb.3 - self.y0) / self.p).ceil().min(self.ny as f64 - 1.0);
        if i1 < i0 || j1 < j0 {
            return None;
        }
        Some((i0 as usize, j0 as usize, i1 as usize, j1 as usize))
    }
    fn stamp(&mut self, bb: (f64, f64, f64, f64), bit: u8, test: &dyn Fn(f64, f64) -> bool) {
        let Some((i0, j0, i1, j1)) = self.range(bb) else { return };
        for j in j0..=j1 {
            for i in i0..=i1 {
                let k = j * self.nx + i;
                if self.m[k] & bit == 0 && test(self.x0 + i as f64 * self.p, self.y0 + j as f64 * self.p) {
                    self.m[k] |= bit;
                }
            }
        }
    }
    fn open(&self, k: usize) -> bool {
        let m = self.m[k];
        m & (FIX | ROUT | OUT) == 0 && (m & RELIEF == 0 || m & SPOKE != 0)
    }
    /// labels of the fill cells inside bb that pass test
    fn labels_in(&self, bb: (f64, f64, f64, f64), test: &dyn Fn(f64, f64) -> bool) -> Vec<u32> {
        let mut v = Vec::new();
        let Some((i0, j0, i1, j1)) = self.range(bb) else { return v };
        for j in j0..=j1 {
            for i in i0..=i1 {
                let k = j * self.nx + i;
                if self.lab[k] > 0 && !v.contains(&self.lab[k]) && test(self.x0 + i as f64 * self.p, self.y0 + j as f64 * self.p) {
                    v.push(self.lab[k]);
                }
            }
        }
        v
    }
}

fn centre(g: &Geo) -> (f64, f64) {
    match *g {
        Geo::Rect(a, b, c, d) => ((a + c) / 2.0, (b + d) / 2.0),
        Geo::Circ(x, y, _) => (x, y),
        Geo::Seg(ax, ay, bx, by, _) => ((ax + bx) / 2.0, (ay + by) / 2.0),
    }
}

/// distance from the pad centre to its edge along the unit vector d
fn extent(g: &Geo, d: (f64, f64)) -> f64 {
    match *g {
        Geo::Circ(_, _, r) => r,
        Geo::Rect(a, b, c, e) => {
            let (hx, hy) = ((c - a) / 2.0, (e - b) / 2.0);
            let tx = if d.0.abs() > 1e-9 { hx / d.0.abs() } else { f64::INFINITY };
            let ty = if d.1.abs() > 1e-9 { hy / d.1.abs() } else { f64::INFINITY };
            tx.min(ty)
        }
        Geo::Seg(..) => 0.0,
    }
}

impl Pour {
    /// clearance of a foreign item to this pour (before the min-thickness erosion)
    fn item_clr(&self, bd: &Board, s: &Shape) -> f64 {
        let mut r = self.clr.max(bd.nets[self.net as usize].clr).max(s.clr);
        if let Some(&(t, v, p)) = self.net_clr.get(&s.net) {
            r = r.max(match s.kind {
                Kind::Track => t,
                Kind::Via => v,
                _ => p,
            });
        }
        r
    }
}

/// Exact copper geometry of a board item for the pour (round pads are kept in the board as their bounding box).
fn copper(bd: &Board, s: &Shape) -> Geo {
    if let (Kind::Pad, Geo::Rect(a, b, c, d)) = (s.kind, s.geo) {
        let key = (((a + c) / 2.0 * 1e4).round() as i64, ((b + d) / 2.0 * 1e4).round() as i64);
        if let Some(&r) = bd.circ.get(&key) {
            return Geo::Circ((a + c) / 2.0, (b + d) / 2.0, r);
        }
    }
    s.geo
}

/// The foreign item s blocks the fill of pour at (x, y) (clearance + half the min width, hole clearance).
fn blocks_fill(bd: &Board, pr: &Pour, s: &Shape, x: f64, y: f64) -> bool {
    let g = copper(bd, s);
    let h = pr.mt / 2.0;
    if g.dist(x, y) < pr.item_clr(bd, s) + h {
        return true;
    }
    if s.drill > 0.0 {
        let (cx, cy) = centre(&s.geo);
        return ((x - cx).powi(2) + (y - cy).powi(2)).sqrt() - s.drill / 2.0 < bd.hole_clr + h;
    }
    false
}

fn reach(bd: &Board, pr: &Pour, s: &Shape) -> f64 {
    pr.item_clr(bd, s).max(bd.hole_clr) + pr.mt / 2.0 + POUR_PITCH
}

struct Filled {
    r: Raster,
    /// connected items per piece label
    count: HashMap<u32, u32>,
    /// per thermal pad: the label (0 = no fill) at each spoke's ring point
    ring: Vec<Vec<u32>>,
    /// cells of the net's vias and track ends: the targets of a door (a piece that joins one of them has 2 items)
    item: HashSet<usize>,
}

fn fill(bd: &Board, pr: &Pour) -> Filled {
    let (e0, e1, e2, e3) = bd.edge;
    let h = pr.mt / 2.0;
    let x0 = pr.bbox[0].max(e0);
    let y0 = pr.bbox[1].max(e1);
    let x1 = pr.bbox[2].min(e2);
    let y1 = pr.bbox[3].min(e3);
    let p = POUR_PITCH;
    let nx = ((x1 - x0) / p).ceil() as usize + 1;
    let ny = ((y1 - y0) / p).ceil() as usize + 1;
    let mut r = Raster { x0, y0, p, nx, ny, m: vec![0; nx * ny], lab: vec![0; nx * ny] };
    // zone outline (its bounding box, as the router's board model) and the board edge clearance
    let m = bd.edge_clr + h;
    r.stamp((x0, y0, x1, y1), OUT, &|x, y| x < e0 + m || x > e2 - m || y < e1 + m || y > e3 - m || x < pr.bbox[0] + h || x > pr.bbox[2] - h
        || y < pr.bbox[1] + h || y > pr.bbox[3] - h);
    let lbit = 1u8 << pr.layer;
    for s in bd.shapes.iter().filter(|s| s.alive && s.layers & lbit != 0 && s.kind != Kind::Spoke && s.net != pr.net) {
        let bit = if s.owner < 0 { FIX } else { ROUT };
        let g = s.geo.bbox();
        let e = reach(bd, pr, s);
        r.stamp((g.0 - e, g.1 - e, g.2 + e, g.3 + e), bit, &|x, y| blocks_fill(bd, pr, s, x, y));
    }
    for pd in &pr.pads {
        let g = pd.geo.bbox();
        match pd.conn {
            0 => {
                let e = pr.gap + h + p;
                r.stamp((g.0 - e, g.1 - e, g.2 + e, g.3 + e), RELIEF, &|x, y| pd.geo.dist(x, y) < pr.gap + h);
            }
            2 => {
                let e = pr.clr + h + p;
                r.stamp((g.0 - e, g.1 - e, g.2 + e, g.3 + e), FIX, &|x, y| pd.geo.dist(x, y) < pr.clr + h);
            }
            _ => {}
        }
    }
    // spokes (KiCad buildThermalSpokes + the spoke test of fillCopperZone): width = spoke width clamped to the pad's
    // smaller side (none below min_thickness); a spoke runs from the pad centre to its test point at pad extent + gap +
    // max error + min_thickness / 2, and is added only when the test point lies in the opened fill before the spokes
    // (an eroded fill cell within min_thickness / 2). Then the clearance holes and the erosion cut it like any fill.
    let mut tips: Vec<(usize, (f64, f64), f64, f64, (f64, f64))> = Vec::new(); // (pad, dir, len, half width, centre)
    for (k, pd) in pr.pads.iter().enumerate() {
        if pd.conn != 0 {
            continue;
        }
        let g = pd.geo.bbox();
        let sw = pr.sw.min((g.2 - g.0).min(g.3 - g.1));
        if sw < pr.mt {
            continue;
        }
        let (cx, cy) = centre(&pd.geo);
        for &d in &pd.dirs {
            let len = extent(&pd.geo, d) + pr.gap + MAX_ERROR + h;
            let (tx, ty) = (cx + d.0 * len, cy + d.1 * len);
            let mut hit = false;
            if let Some((i0, j0, i1, j1)) = r.range((tx - h, ty - h, tx + h, ty + h)) {
                'f: for j in j0..=j1 {
                    for i in i0..=i1 {
                        let (x, y) = (r.x0 + i as f64 * p, r.y0 + j as f64 * p);
                        if r.m[j * nx + i] & (FIX | ROUT | OUT | RELIEF) == 0 && (x - tx).powi(2) + (y - ty).powi(2) <= (h + p / 2.0).powi(2) {
                            hit = true;
                            break 'f;
                        }
                    }
                }
            }
            if hit {
                tips.push((k, d, len, sw / 2.0, (cx, cy)));
            }
        }
    }
    // spokes in the eroded model. KiCad adds the spokes to the fill and then deflates the union (fillCopperZone), so
    // the eroded set near a pad is: the cells whose min_thickness / 2 disk has no point in the raw relief (pad grown by
    // the gap) outside the raw spokes of that pad. Eroding the spoke and the fill each alone (v5) lost the junction where
    // the fill beyond the relief meets the spoke tip at a slant (M2 run 6, J2.18 NE spoke: one cell short).
    let disk: Vec<(f64, f64)> = {
        let st = p / 2.0;
        let n = (h / st).ceil() as i32;
        let mut v = Vec::new();
        for a in -n..=n {
            for b in -n..=n {
                let (dx, dy) = (a as f64 * st, b as f64 * st);
                if dx * dx + dy * dy <= h * h {
                    v.push((dx, dy));
                }
            }
        }
        for k in 0..32 {
            let t = k as f64 * std::f64::consts::PI / 16.0;
            v.push((h * t.cos(), h * t.sin()));
        }
        v
    };
    for (k, pd) in pr.pads.iter().enumerate() {
        let mine: Vec<&(usize, (f64, f64), f64, f64, (f64, f64))> = tips.iter().filter(|t| t.0 == k).collect();
        if mine.is_empty() {
            continue;
        }
        // raw spoke strip: from the pad centre to the test point, half width hw
        let in_strip = |x: f64, y: f64| {
            mine.iter().any(|&&(_, d, len, hw, (cx, cy))| {
                let (ux, uy) = (x - cx, y - cy);
                let t = ux * d.0 + uy * d.1;
                t >= 0.0 && t <= len && (-ux * d.1 + uy * d.0).abs() <= hw + 1e-9
            })
        };
        for &&(_, d, len, hw, (cx, cy)) in &mine {
            let (ex, ey) = (cx + d.0 * len, cy + d.1 * len);
            let e = hw + h + p;
            let bb = (cx.min(ex) - e, cy.min(ey) - e, cx.max(ex) + e, cy.max(ey) + e);
            r.stamp(bb, SPOKE, &|x, y| {
                let (ux, uy) = (x - cx, y - cy);
                let t = ux * d.0 + uy * d.1;
                t >= -h && t <= len + h && (-ux * d.1 + uy * d.0).abs() <= hw + h
                    && disk.iter().all(|&(dx, dy)| pd.geo.dist(x + dx, y + dy) >= pr.gap || in_strip(x + dx, y + dy))
            });
        }
    }
    // drill holes of the thermal pads (KiCad fillCopperZone: addHoleKnockout( pad, 0 ) after the re-inflation). The spokes
    // start at the pad centre and join through it unless the hole cuts them. In the eroded model a re-inflated cross of
    // half width hw is cut where the hole radius reaches its inner corner (hw * sqrt 2); its eroded corner is at
    // (hw - h) * sqrt 2, so the hole blocks the eroded cells within radius - h * sqrt 2 (exact for the 4-spoke cross).
    for pd in pr.pads.iter().filter(|pd| pd.conn == 0) {
        if let Some((hx, hy, hr)) = pd.hole {
            let rb = hr - h * std::f64::consts::SQRT_2;
            if rb > 0.0 {
                r.stamp((hx - rb, hy - rb, hx + rb, hy + rb), FIX, &|x, y| (x - hx).powi(2) + (y - hy).powi(2) < rb * rb);
            }
        }
    }
    // pieces: 4-connected components of the fill cells
    let mut next = 0u32;
    let mut stack: Vec<usize> = Vec::new();
    for k0 in 0..nx * ny {
        if r.lab[k0] != 0 || !r.open(k0) {
            continue;
        }
        next += 1;
        r.lab[k0] = next;
        stack.push(k0);
        while let Some(k) = stack.pop() {
            let (i, j) = (k % nx, k / nx);
            let mut nb = [usize::MAX; 4];
            if i > 0 { nb[0] = k - 1; }
            if i + 1 < nx { nb[1] = k + 1; }
            if j > 0 { nb[2] = k - nx; }
            if j + 1 < ny { nb[3] = k + nx; }
            for q in nb {
                if q != usize::MAX && r.lab[q] == 0 && r.open(q) {
                    r.lab[q] = next;
                    stack.push(q);
                }
            }
        }
    }
    // connected items of each piece
    let mut count: HashMap<u32, u32> = HashMap::new();
    let add = |labs: Vec<u32>, count: &mut HashMap<u32, u32>| {
        for l in labs {
            *count.entry(l).or_insert(0) += 1;
        }
    };
    let mut item = HashSet::new();
    for s in bd.shapes.iter().filter(|s| s.alive && s.layers & lbit != 0 && s.net == pr.net && s.kind != Kind::Spoke && s.kind != Kind::Pad) {
        let disks: Vec<(f64, f64, f64)> = match s.geo {
            Geo::Circ(x, y, rr) => vec![(x, y, rr)],
            Geo::Seg(ax, ay, bx, by, hw) => vec![(ax, ay, hw), (bx, by, hw)],
            _ => vec![],
        };
        for (x, y, rr) in disks {
            if let Some((i0, j0, i1, j1)) = r.range((x - rr, y - rr, x + rr, y + rr)) {
                for j in j0..=j1 {
                    for i in i0..=i1 {
                        if (r.x0 + i as f64 * p - x).powi(2) + (r.y0 + j as f64 * p - y).powi(2) <= rr * rr {
                            item.insert(j * nx + i);
                        }
                    }
                }
            }
        }
        match s.geo {
            Geo::Circ(..) => add(r.labels_in(s.geo.bbox(), &|x, y| s.geo.dist(x, y) <= 0.0), &mut count),
            Geo::Seg(ax, ay, bx, by, hw) => {
                let mut l = r.labels_in((ax - hw, ay - hw, ax + hw, ay + hw), &|x, y| (x - ax).powi(2) + (y - ay).powi(2) <= hw * hw);
                for q in r.labels_in((bx - hw, by - hw, bx + hw, by + hw), &|x, y| (x - bx).powi(2) + (y - by).powi(2) <= hw * hw) {
                    if !l.contains(&q) {
                        l.push(q);
                    }
                }
                add(l, &mut count);
            }
            _ => {}
        }
    }
    let mut ring = Vec::new();
    for pd in &pr.pads {
        let mut rl = Vec::new();
        match pd.conn {
            0 => {
                let (cx, cy) = centre(&pd.geo);
                for &d in &pd.dirs {
                    let t = extent(&pd.geo, d) + pr.gap / 2.0;
                    let mut lab = 0;
                    for off in [0.0, -pr.sw / 4.0, pr.sw / 4.0] {
                        let (x, y) = (cx + d.0 * t - d.1 * off, cy + d.1 * t + d.0 * off);
                        if let Some(k) = r.cell(x, y) {
                            if r.lab[k] > 0 {
                                lab = r.lab[k];
                                break;
                            }
                        }
                    }
                    rl.push(lab);
                }
                let mut l: Vec<u32> = rl.iter().cloned().filter(|&q| q > 0).collect();
                l.sort();
                l.dedup();
                add(l, &mut count);
            }
            1 => {
                let g = pd.geo.bbox();
                let e = h + p;
                add(r.labels_in((g.0 - e, g.1 - e, g.2 + e, g.3 + e), &|x, y| pd.geo.dist(x, y) <= e), &mut count);
            }
            _ => {}
        }
        ring.push(rl);
    }
    Filled { r, count, ring, item }
}

/// KiCad starved_thermal on the pours of the board; every fault carries its cheapest door (see Fault).
pub(crate) fn check(bd: &Board) -> Vec<Fault> {
    let mut out = Vec::new();
    for (pi, pr) in bd.pours.iter().enumerate() {
        let f = fill(bd, pr);
        let lbit = 1u8 << pr.layer;
        if let Ok(v) = std::env::var("IOTROUTE_POUR_DUMP") {
            // debug: "layer,x0,y0,x1,y1,file": the piece label of each cell in the box (one row per line)
            let a: Vec<&str> = v.split(',').collect();
            if a.len() == 6 && a[0].parse::<usize>().ok() == Some(pr.layer) {
                let b: Vec<f64> = a[1..5].iter().map(|s| s.parse().unwrap()).collect();
                if let Some((i0, j0, i1, j1)) = f.r.range((b[0], b[1], b[2], b[3])) {
                    let mut s = format!("{} {} {} {} {}\n", f.r.x0 + i0 as f64 * f.r.p, f.r.y0 + j0 as f64 * f.r.p, f.r.p, i1 - i0 + 1, j1 - j0 + 1);
                    for j in j0..=j1 {
                        let row: Vec<String> = (i0..=i1).map(|i| f.r.lab[j * f.r.nx + i].to_string()).collect();
                        s.push_str(&row.join(" "));
                        s.push('\n');
                    }
                    std::fs::write(a[5], s).unwrap();
                }
            }
        }
        for (k, pd) in pr.pads.iter().enumerate() {
            if pd.conn != 0 {
                continue;
            }
            let mut good = 0;
            let mut ignored = 0;
            for &l in &f.ring[k] {
                if l == 0 {
                    continue;
                }
                if f.count.get(&l).copied().unwrap_or(0) >= 2 { good += 1 } else { ignored += 1 }
            }
            if std::env::var("IOTROUTE_POUR_PAD").map(|v| v == pd.name).unwrap_or(false) {
                let cells = |l: u32| f.r.lab.iter().filter(|&&q| q == l).count();
                eprintln!("pour pad {}: dirs {:?} ring labels {:?} items {:?} cells {:?}", pd.name, pd.dirs, f.ring[k],
                          f.ring[k].iter().map(|l| f.count.get(l).copied().unwrap_or(0)).collect::<Vec<_>>(),
                          f.ring[k].iter().map(|&l| if l > 0 { cells(l) } else { 0 }).collect::<Vec<_>>());
            }
            if good == 0 && ignored == 0 {
                continue; // KiCad: the pad is not connected to the zone (no starved_thermal)
            }
            if let Some(px) = pd.proxy {
                // KiCad custom pad: it needs as many spokes as it has proxy segments (none: never starved); no track
                // spokes, no island fallback
                if good < px {
                    let mut fl = Fault { pour: pi, layer: pr.layer, pad: pd.name.clone(), good, ignored, door: Vec::new(), path: Vec::new(), walls: Vec::new(), fixed: true };
                    door(bd, pr, pd, &f, &f.ring[k], &mut fl);
                    out.push(fl);
                }
                continue;
            }
            if good >= pr.min_spokes {
                continue;
            }
            // tracks of the net from inside the ring (pad grown by half the gap) to the fill count as spokes
            let ringd = pr.gap / 2.0;
            let (h, p) = (pr.mt / 2.0, f.r.p);
            for s in bd.shapes.iter().filter(|s| s.alive && s.layers & lbit != 0 && s.net == pr.net && s.kind == Kind::Track) {
                if let Geo::Seg(ax, ay, bx, by, _) = s.geo {
                    for ((px, py), (qx, qy)) in [((ax, ay), (bx, by)), ((bx, by), (ax, ay))] {
                        // the far end point lies in the (opened) fill: an eroded fill cell within min_thickness / 2
                        let rr = h + p / 2.0;
                        if pd.geo.dist(px, py) <= ringd
                            && !f.r.labels_in((qx - rr, qy - rr, qx + rr, qy + rr), &|x, y| (x - qx).powi(2) + (y - qy).powi(2) <= rr * rr).is_empty() {
                            good += 1;
                            break;
                        }
                    }
                }
            }
            if good == 0 {
                good = ignored;
                ignored = 0;
            }
            if good >= pr.min_spokes {
                continue;
            }
            let mut fl = Fault { pour: pi, layer: pr.layer, pad: pd.name.clone(), good, ignored, door: Vec::new(), path: Vec::new(), walls: Vec::new(), fixed: true };
            door(bd, pr, pd, &f, &f.ring[k], &mut fl);
            out.push(fl);
        }
    }
    out
}

/// 0-1 search from the pad's spokes to a fill cell on a via or track end of the net: a fill cell costs 0, a cell blocked
/// only by routed copper costs 1, fixed copper / edge / a relief gap cannot be crossed. Each spoke enters the search at
/// its KiCad test point (pad extent + gap + max error + min_thickness / 2) with the cost of the routed cells on its axis
/// from the ring to the test point (a spoke that routed copper removed can come back: KiCad adds a spoke only when its
/// test point lies in the fill, so the door must clear the test point, not only some cells of the strip).
/// ring: the piece label at each spoke's ring point; a spoke already in a connected piece (2 or more items) is no seed
/// (v6: with one good pour spoke the search ended at once on that piece and reported no door).
fn door(bd: &Board, pr: &Pour, pd: &PourPad, f: &Filled, ring: &[u32], fl: &mut Fault) {
    let r = &f.r;
    let (cx, cy) = centre(&pd.geo);
    let enter = |k: usize| -> Option<u32> {
        let m = r.m[k];
        if m & (FIX | OUT) != 0 || (m & RELIEF != 0 && m & SPOKE == 0) {
            None
        } else if m & ROUT != 0 {
            Some(1)
        } else {
            Some(0)
        }
    };
    let mut dist: HashMap<usize, (u32, usize)> = HashMap::new();
    let mut dq: VecDeque<usize> = VecDeque::new();
    // seed (test point cell) -> its axis cells, ring first
    let mut axis: HashMap<usize, Vec<usize>> = HashMap::new();
    'd: for (si, &d) in pd.dirs.iter().enumerate() {
        if ring.get(si).map(|&l| l > 0 && f.count.get(&l).copied().unwrap_or(0) >= 2).unwrap_or(false) {
            continue;
        }
        let (t0, t1) = (extent(&pd.geo, d) + pr.gap / 2.0, extent(&pd.geo, d) + pr.gap + MAX_ERROR + pr.mt / 2.0);
        let mut cells: Vec<usize> = Vec::new();
        let mut t = t0;
        loop {
            let Some(k) = r.cell(cx + d.0 * t, cy + d.1 * t) else { continue 'd };
            if r.m[k] & (FIX | OUT) != 0 {
                continue 'd; // fixed copper cuts this spoke: no door through it
            }
            if !cells.contains(&k) {
                cells.push(k);
            }
            if t >= t1 {
                break;
            }
            t = (t + r.p / 2.0).min(t1);
        }
        let seed = *cells.last().unwrap();
        if r.m[seed] & RELIEF != 0 && r.m[seed] & SPOKE == 0 && r.m[seed] & ROUT == 0 {
            continue; // the test point is in another pad's relief
        }
        let c = cells.iter().filter(|&&k| r.m[k] & ROUT != 0).count() as u32;
        if dist.get(&seed).map(|e| c < e.0).unwrap_or(true) {
            dist.insert(seed, (c, usize::MAX));
            axis.insert(seed, cells[..cells.len() - 1].to_vec());
            if c == 0 { dq.push_front(seed) } else { dq.push_back(seed) }
        }
    }
    // target: a fill cell on a via or track end of the net. Joined to it, the island has 2 items, and a wall net that
    // routes around the end of a hard door cannot cut the door from its item (a door to the nearest cell of a big piece
    // can be walled in again at its far end)
    let target = |k: usize| r.lab[k] > 0 && f.item.contains(&k);
    let mut done = HashSet::new();
    let mut hit = None;
    while let Some(k) = dq.pop_front() {
        if !done.insert(k) {
            continue;
        }
        if target(k) {
            hit = Some(k);
            break;
        }
        if done.len() > DOOR_MAX {
            break;
        }
        let dk = dist[&k].0;
        let (i, j) = (k % r.nx, k / r.nx);
        let mut nb = [usize::MAX; 4];
        if i > 0 { nb[0] = k - 1; }
        if i + 1 < r.nx { nb[1] = k + 1; }
        if j > 0 { nb[2] = k - r.nx; }
        if j + 1 < r.ny { nb[3] = k + r.nx; }
        for q in nb {
            if q == usize::MAX || done.contains(&q) {
                continue;
            }
            let Some(c) = enter(q) else { continue };
            let nd = dk + c;
            if dist.get(&q).map(|e| nd < e.0).unwrap_or(true) {
                dist.insert(q, (nd, k));
                if c == 0 { dq.push_front(q) } else { dq.push_back(q) }
            }
        }
    }
    let Some(mut k) = hit else { return };
    // cells from the target back to the seed, then the seed's axis back to the ring
    let mut cells = Vec::new();
    loop {
        cells.push(k);
        let prev = dist[&k].1;
        if prev == usize::MAX {
            cells.extend(axis[&k].iter().rev());
            break;
        }
        k = prev;
    }
    cells.reverse();
    let lbit = 1u8 << pr.layer;
    for k in cells {
        let (x, y) = r.xy(k);
        fl.path.push((x, y));
        if r.m[k] & ROUT != 0 {
            fl.door.push((x, y));
            let rr = bd.maxc.max(pr.clr).max(bd.hole_clr) + pr.mt / 2.0 + 0.6;
            bd.near_in(&bd.sidx, pr.layer, x, y, rr, &mut |_, s| {
                if s.owner >= 0 && s.net != pr.net && s.kind != Kind::Spoke && s.layers & lbit != 0 && blocks_fill(bd, pr, s, x, y)
                    && !fl.walls.contains(&(s.owner as usize)) {
                    fl.walls.push(s.owner as usize);
                }
                false
            });
        }
    }
    fl.fixed = fl.walls.is_empty();
}

/// Pours of the model: zones on routable layers with a thermal pad connection (the starved_thermal rule applies).
pub(crate) fn load_pours(bd: &mut Board, model: &Value, lid: &dyn Fn(&str) -> Option<usize>, net_of: &dyn Fn(&str) -> i32) {
    let min_sp = model["setup"]["min_spokes"].as_u64().unwrap_or(2) as usize;
    let Some(zones) = model["zones"].as_array() else { return };
    for z in zones {
        let conn = z["pad_connection"].as_str().unwrap_or("");
        let Some(l) = lid(z["layer"].as_str().unwrap_or("")) else { continue };
        let net = net_of(z["net"].as_str().unwrap_or(""));
        if net < 0 || !bd.routable.contains(&l) || !(conn == "thermal" || conn == "tht_thermal") {
            continue;
        }
        let bb = &z["bbox"];
        let bbox = [f(&bb[0]), f(&bb[1]), f(&bb[2]), f(&bb[3])];
        let mut net_clr = HashMap::new();
        if let Some(o) = z["net_clearance"].as_object() {
            for (name, v) in o {
                let n = net_of(name);
                if n >= 0 {
                    net_clr.insert(n, (v["track"].as_f64().unwrap_or(0.0), v["via"].as_f64().unwrap_or(0.0), v["pad"].as_f64().unwrap_or(0.0)));
                }
            }
        }
        let mut pads = Vec::new();
        for p in model["pads"].as_array().unwrap() {
            if net_of(p["net"].as_str().unwrap_or("")) != net || !p["layers"].as_array().map(|a| a.iter().any(|v| lid(v.as_str().unwrap_or("")) == Some(l))).unwrap_or(false) {
                continue;
            }
            let b = p["bbox"].as_array().unwrap();
            let (x0, y0, x1, y1) = (f(&b[0]), f(&b[1]), f(&b[2]), f(&b[3]));
            let (cx, cy) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0);
            if cx < bbox[0] || cx > bbox[2] || cy < bbox[1] || cy > bbox[3] {
                continue;
            }
            let drill = f(&p["drill"]);
            let pc = match p["zone_conn"].as_str() {
                Some("none") => 2,
                Some("full") => 1,
                Some("thermal") => 0,
                Some("tht_thermal") => if drill > 0.0 { 0 } else { 1 },
                _ => if conn == "tht_thermal" && drill == 0.0 { 1 } else { 0 },
            };
            let geo = if p["shape"].as_str() == Some("circle") { Geo::Circ(cx, cy, (x1 - x0) / 2.0) } else { Geo::Rect(x0, y0, x1, y1) };
            let a0 = p["spoke_deg"].as_f64().unwrap_or(90.0);
            let dirs = (0..4).map(|k| {
                let a = (a0 + 90.0 * k as f64).to_radians();
                let (dx, dy) = (a.cos(), -a.sin()); // KiCad angles are counterclockwise on screen (y down)
                ((dx * 1e9).round() / 1e9, (dy * 1e9).round() / 1e9)
            }).collect();
            pads.push(PourPad { geo, conn: pc, dirs, proxy: if p["shape"].as_str() == Some("custom") { Some(p["proxy_spokes"].as_u64().unwrap_or(0) as usize) } else { None },
                                  hole: if drill > 0.0 { Some((p["x"].as_f64().unwrap_or(cx), p["y"].as_f64().unwrap_or(cy), drill / 2.0)) } else { None }, name: format!("{}.{}", p["ref"].as_str().unwrap_or("?"), p["num"].as_str().unwrap_or("?")) });
        }
        bd.pours.push(Pour { net, layer: l, clr: f(&z["clearance"]), gap: f(&z["thermal_gap"]), sw: f(&z["spoke_width"]), mt: f(&z["min_thickness"]), bbox,
                             min_spokes: min_sp, pads, net_clr, island_mode: z["island_removal_mode"].as_i64().unwrap_or(0) });
    }
}
