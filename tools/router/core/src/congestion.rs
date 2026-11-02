//! Congestion map (tools/router/DESIGN.md 5d): where the router had to negotiate, for the placer.
//!
//! `iotroute MODEL OUT --congestion MAP.json [--cong-cell 1.0] [--cong-free 0|1]` writes MAP.json after OUT.json. The
//! map reads the end state of the run only; it never changes the routed result (OUT.json is written before it, and the
//! free routes below put the copper back).
//!
//! Per coarse cell (square, --cong-cell mm, origin = the board outline box corner) and routable layer:
//!   free  fraction of the sample points where a default track (the most common signal width / clearance of the model)
//!         is not blocked by fixed copper (pads, locked copper, keepouts, board edge): the room the placement leaves
//!   occ   fraction of the free sample points where the routed copper (any net, plane fan-out included) blocks that
//!         track: the part of the room the route used (1.0 = full)
//!   len   routed track length in the cell (mm)
//!   cap   track capacity (mm) = free x cell area / (default width + clearance): the length of parallel default tracks
//!         that fit in the free room
//!   hist  mean PathFinder history cost of the routing grid cells in the cell (0 when the run converged in iteration 1):
//!         where the negotiation had conflicts, summed over all iterations
//! Per cell (all layers): routed vias and the mean via history.
//! Per routed net: routed track length, vias, routing objective (net_cost), Euclidean MST of the pad centres and, with
//! --cong-free 1, the objective and length of the net routed alone (fixed copper only, history off, admissible
//! heuristic: the v9 recover search): detour = objective - free objective. That is one strict A* per net.
use super::*;

/// Sample step of the free / occ test: 2 x the router pitch (0.1 mm at the 0.05 mm pitch), finer than the narrowest
/// track (0.15 mm) so that no track-wide gap falls between two samples.
fn sample_step(pitch: f64) -> f64 {
    2.0 * pitch
}

#[derive(Serialize)]
pub(crate) struct CLayer {
    pub name: String,
    pub free: Vec<f64>,
    pub occ: Vec<f64>,
    pub len: Vec<f64>,
    pub cap: Vec<f64>,
    pub hist: Vec<f64>,
}

#[derive(Serialize)]
pub(crate) struct CNet {
    pub name: String,
    pub pads: usize,
    pub bbox: [f64; 4],
    pub len: f64,
    pub vias: usize,
    pub cost: f64,
    pub mst: f64,
    pub free_cost: Option<f64>,
    pub free_len: Option<f64>,
    pub detour: Option<f64>,
    pub failed: bool,
}

#[derive(Serialize)]
pub(crate) struct CMap {
    pub schema: String,
    pub cell: f64,
    pub sample: f64,
    pub origin: [f64; 2],
    pub nx: usize,
    pub ny: usize,
    pub track_w: f64,
    pub track_clr: f64,
    pub layers: Vec<CLayer>,
    pub vias: Vec<u32>,
    pub vhist: Vec<f64>,
    pub nets: Vec<CNet>,
}

fn r3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

/// The most common (width, clearance) of the signal nets (not plane, not power); ties: the smaller width. None of them:
/// the smallest net width and clearance.
pub(crate) fn default_profile(bd: &Board) -> (f64, f64) {
    let mut cnt: Vec<((i64, i64), usize)> = Vec::new();
    for n in bd.nets.iter().filter(|n| !n.plane && !n.power) {
        let k = ((n.width * 1e4).round() as i64, (n.clr * 1e4).round() as i64);
        match cnt.iter_mut().find(|e| e.0 == k) {
            Some(e) => e.1 += 1,
            None => cnt.push((k, 1)),
        }
    }
    cnt.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    match cnt.first() {
        Some(e) => (e.0.0 as f64 / 1e4, e.0.1 as f64 / 1e4),
        None => (bd.nets.iter().map(|n| n.width).fold(0.15, f64::min), bd.nets.iter().map(|n| n.clr).fold(0.15, f64::min)),
    }
}

/// Euclidean MST (Prim) of the points.
pub(crate) fn mst(p: &[(f64, f64)]) -> f64 {
    if p.len() < 2 {
        return 0.0;
    }
    let mut d = vec![f64::MAX; p.len()];
    let mut inn = vec![false; p.len()];
    d[0] = 0.0;
    let mut tot = 0.0;
    for _ in 0..p.len() {
        let k = (0..p.len()).filter(|&i| !inn[i]).min_by(|&a, &b| d[a].partial_cmp(&d[b]).unwrap().then(a.cmp(&b))).unwrap();
        inn[k] = true;
        tot += d[k];
        for i in 0..p.len() {
            if !inn[i] {
                d[i] = d[i].min((p[i].0 - p[k].0).hypot(p[i].1 - p[k].1));
            }
        }
    }
    tot
}

/// Cell arrays of the present copper (see the module text). Returns (nx, ny, layers, vias, vhist).
pub(crate) fn cells(ctx: &Ctx, cell: f64) -> (usize, usize, Vec<CLayer>, Vec<u32>, Vec<f64>) {
    let bd = &*ctx.bd;
    let gr = &ctx.gr;
    let (w, clr) = default_profile(bd);
    let hw = w / 2.0;
    let ext_x = (gr.nx - 1) as f64 * gr.p;
    let ext_y = (gr.ny - 1) as f64 * gr.p;
    let nx = ((ext_x / cell).floor() as usize + 1).max(1);
    let ny = ((ext_y / cell).floor() as usize + 1).max(1);
    let ci = |x: f64, y: f64| -> Option<usize> {
        let (i, j) = (((x - gr.x0) / cell).floor(), ((y - gr.y0) / cell).floor());
        if i < 0.0 || j < 0.0 || i as usize >= nx || j as usize >= ny { None } else { Some(j as usize * nx + i as usize) }
    };
    let sp = sample_step(gr.p);
    let pitch_t = w + clr;
    let mut layers = Vec::new();
    for (r, &l) in bd.routable.iter().enumerate() {
        let (mut ns, mut nf, mut no) = (vec![0u32; nx * ny], vec![0u32; nx * ny], vec![0u32; nx * ny]);
        let mut y = gr.y0;
        while y <= gr.y0 + ext_y + 1e-9 {
            let mut x = gr.x0;
            while x <= gr.x0 + ext_x + 1e-9 {
                if let Some(c) = ci(x, y) {
                    ns[c] += 1;
                    let code = bd.track_fixed_code(l, x, y, hw, clr, 0, bd.plane_clr);
                    if !blocks(code, -1) {
                        nf[c] += 1;
                        if bd.near_in(&bd.sidx, l, x, y, bd.track_r(hw, bd.plane_clr), &mut |_, s| {
                            track_hit(s, x, y, hw, clr, false, bd.plane_clr, bd.hole_clr, 0.0)
                        }) {
                            no[c] += 1;
                        }
                    }
                }
                x += sp;
            }
            y += sp;
        }
        let mut len = vec![0.0f64; nx * ny];
        for s in bd.shapes.iter().filter(|s| s.alive && s.owner >= 0 && s.kind == Kind::Track && s.layers & (1 << l) != 0) {
            if let Geo::Seg(ax, ay, bx, by, _) = s.geo {
                let d = (bx - ax).hypot(by - ay);
                let k = (d / (gr.p / 2.0)).ceil().max(1.0) as usize;
                for t in 0..k {
                    let f = (t as f64 + 0.5) / k as f64;
                    if let Some(c) = ci(ax + f * (bx - ax), ay + f * (by - ay)) {
                        len[c] += d / k as f64;
                    }
                }
            }
        }
        let (mut hs, mut hn) = (vec![0.0f64; nx * ny], vec![0u32; nx * ny]);
        let n = gr.nx * gr.ny;
        for j in 0..gr.ny {
            for i in 0..gr.nx {
                let (x, y) = gr.xy(i, j);
                if let Some(c) = ci(x, y) {
                    hs[c] += gr.hist[r * n + j * gr.nx + i] as f64;
                    hn[c] += 1;
                }
            }
        }
        let area = cell * cell;
        let free: Vec<f64> = (0..nx * ny).map(|c| if ns[c] > 0 { nf[c] as f64 / ns[c] as f64 } else { 0.0 }).collect();
        layers.push(CLayer {
            name: bd.layer_names[l].clone(),
            occ: (0..nx * ny).map(|c| r3(if nf[c] > 0 { no[c] as f64 / nf[c] as f64 } else { 0.0 })).collect(),
            len: len.iter().map(|&v| r3(v)).collect(),
            cap: free.iter().map(|&f| r3(f * area / pitch_t)).collect(),
            hist: (0..nx * ny).map(|c| r3(if hn[c] > 0 { hs[c] / hn[c] as f64 } else { 0.0 })).collect(),
            free: free.iter().map(|&f| r3(f)).collect(),
        });
    }
    let mut vias = vec![0u32; nx * ny];
    for s in bd.shapes.iter().filter(|s| s.alive && s.owner >= 0 && s.kind == Kind::Via) {
        if let Geo::Circ(x, y, _) = s.geo {
            if let Some(c) = ci(x, y) {
                vias[c] += 1;
            }
        }
    }
    let (mut vs, mut vn) = (vec![0.0f64; nx * ny], vec![0u32; nx * ny]);
    for j in 0..gr.ny {
        for i in 0..gr.nx {
            let (x, y) = gr.xy(i, j);
            if let Some(c) = ci(x, y) {
                vs[c] += gr.vhist[j * gr.nx + i] as f64;
                vn[c] += 1;
            }
        }
    }
    let vhist = (0..nx * ny).map(|c| r3(if vn[c] > 0 { vs[c] / vn[c] as f64 } else { 0.0 })).collect();
    (nx, ny, layers, vias, vhist)
}

fn own_len(bd: &Board, net: usize) -> (f64, usize) {
    let (mut l, mut v) = (0.0, 0usize);
    for s in bd.shapes.iter().filter(|s| s.alive && s.owner == net as i32 && s.net == net as i32) {
        match (s.kind, s.geo) {
            (Kind::Track, Geo::Seg(ax, ay, bx, by, _)) => l += (bx - ax).hypot(by - ay),
            (Kind::Via, _) => v += 1,
            _ => {}
        }
    }
    (l, v)
}

/// Per-net rows: every non-plane net with 2 or more fixed items (pads, locked copper), in net index order. `free`: route
/// each net that has routed copper alone (other routed copper off), then put the copper back.
pub(crate) fn net_rows(ctx: &mut Ctx, failed: &[bool], free: bool) -> Vec<CNet> {
    let mut rows = Vec::new();
    for net in 0..ctx.bd.nets.len() {
        if ctx.bd.nets[net].plane {
            continue;
        }
        let pads: Vec<(f64, f64, f64, f64)> = ctx.bd.shapes.iter().filter(|s| s.alive && s.net == net as i32 && s.kind == Kind::Pad).map(|s| s.geo.bbox()).collect();
        if pads.len() < 2 {
            continue;
        }
        let pts: Vec<(f64, f64)> = pads.iter().map(|b| ((b.0 + b.2) / 2.0, (b.1 + b.3) / 2.0)).collect();
        let bbox = pads.iter().fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |a, b| [a[0].min(b.0), a[1].min(b.1), a[2].max(b.2), a[3].max(b.3)]);
        let (len, vias) = own_len(ctx.bd, net);
        let routed = len > 0.0 || vias > 0;
        let cost = net_cost(ctx, net);
        let (mut free_cost, mut free_len) = (None, None);
        if free && routed && !failed[net] {
            let snap = ctx.bd.shapes.clone();
            for s in ctx.bd.shapes.iter_mut() {
                if s.owner >= 0 && s.owner != net as i32 {
                    s.alive = false;
                }
            }
            ctx.gr.reset_cache();
            ctx.strict = true;
            ctx.recover = true;
            let r = route_net(ctx, net);
            ctx.recover = false;
            ctx.strict = false;
            if r.hard_fail.is_none() {
                free_cost = Some(r3(net_cost(ctx, net)));
                free_len = Some(r3(own_len(ctx.bd, net).0));
            }
            ctx.bd.shapes = snap;
            ctx.bd.compact();
            ctx.gr.reset_cache();
        }
        rows.push(CNet {
            name: ctx.bd.nets[net].name.clone(),
            pads: pads.len(),
            bbox: [r3(bbox[0]), r3(bbox[1]), r3(bbox[2]), r3(bbox[3])],
            len: r3(len),
            vias,
            cost: r3(cost),
            mst: r3(mst(&pts)),
            detour: free_cost.map(|f| r3(cost - f)),
            free_cost,
            free_len,
            failed: failed[net],
        });
    }
    rows
}

/// Build and write the map (after OUT.json). Returns the seconds of the free routes.
pub(crate) fn write_map(ctx: &mut Ctx, path: &str, cell: f64, failed: &[bool], free: bool) -> f64 {
    ctx.bd.compact();
    let (nx, ny, layers, vias, vhist) = cells(ctx, cell);
    let tf = std::time::Instant::now();
    let nets = net_rows(ctx, failed, free);
    let secs = tf.elapsed().as_secs_f64();
    let (w, clr) = default_profile(ctx.bd);
    let m = CMap { schema: "iot-lab.route-congestion.v0".into(), cell, sample: sample_step(ctx.gr.p), origin: [r3(ctx.gr.x0), r3(ctx.gr.y0)], nx, ny,
                   track_w: w, track_clr: clr, layers, vias, vhist, nets };
    std::fs::write(path, serde_json::to_string(&m).unwrap()).expect("write congestion map");
    secs
}
