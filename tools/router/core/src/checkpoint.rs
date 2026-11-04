//! Per-pass progress file (`--checkpoint FILE`, tools/router/DESIGN.md 5e), schema `iot-lab.route-checkpoint.v0`.
//!
//! Written whole to FILE.tmp and renamed over FILE, so a reader sees one complete pass or the one before it. It only reads
//! what the pass already knows (the audit, the net states, the history grid): no extra audit or search runs before OUT.json
//! is written, so the route does not depend on it. elapsed_s is wall clock: the file is not byte-stable between runs.
//!
//! `bind` names what the run is a run of: source, binary, model file, rules and geometry hashes and the flags. With the seed
//! that is what a repeat of the run needs. SIGTERM and SIGINT (only with --checkpoint) stop the negotiation at the end of the
//! pass, as --max-time does: the best pass is restored, the end steps make it legal, OUT.json is written. A second signal kills.
use super::*;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

/// Mean history per square of this size: the placer's congestion cell (DESIGN.md 5d: 1 mm keeps the signal of a failed route).
const HOT_CELL_MM: f64 = 1.0;
/// Lengths of the lists in the file. Display limits, not rules: enough to see where a run is stuck, small enough to read.
const MAX_NETS: usize = 8;
const MAX_HOT: usize = 8;
const MAX_WHY: usize = 160;
/// Model keys that say where copper is; every other key but the `pcb` path is a rule or a setting (rules_sha256).
const GEOMETRY: [&str; 8] = ["copper", "copper_layers", "edges", "keepouts", "outline_bbox", "pads", "ref_fill", "zones"];

pub(crate) use iotroute::sha256::sha256;

#[derive(Serialize, Clone)]
pub(crate) struct Bind {
    /// --source-sha: run.py's sources_sha256 of the core; null when the core was started by hand
    source_sha256: Option<String>,
    binary_sha256: Option<String>,
    model_sha256: String,
    rules_sha256: String,
    geometry_sha256: String,
    args: Vec<String>,
}

impl Bind {
    /// `text` is the model file, `model` its parse. serde_json keeps object keys sorted, so the parts hash the same on every machine.
    pub(crate) fn new(text: &str, model: &Value, source: Option<String>, args: &[String]) -> Bind {
        let part = |geo: bool| {
            let m = model.as_object().map(|o| o.iter().filter(|(k, _)| k.as_str() != "pcb" && GEOMETRY.contains(&k.as_str()) == geo).collect::<std::collections::BTreeMap<_, _>>());
            sha256(serde_json::to_string(&m).unwrap().as_bytes())
        };
        let binary_sha256 = std::env::current_exe().ok().and_then(|p| std::fs::read(p).ok()).map(|b| sha256(&b));
        Bind { source_sha256: source, binary_sha256, model_sha256: sha256(text.as_bytes()), rules_sha256: part(false), geometry_sha256: part(true), args: args.to_vec() }
    }
}

static STOP: AtomicBool = AtomicBool::new(false);

unsafe extern "C" {
    fn signal(signum: i32, handler: usize) -> usize;
}

/// Only an atomic store and signal(), both safe in a handler. The default action comes back, so a second signal kills.
extern "C" fn on_signal(signum: i32) {
    STOP.store(true, AtomicOrdering::Relaxed);
    unsafe { signal(signum, 0) };
}

/// SIGINT 2 and SIGTERM 15, the same numbers on Linux and macOS. Without this call a signal kills the run as it always did.
pub(crate) fn stop_on_signal() {
    for n in [2, 15] {
        unsafe { signal(n, on_signal as *const () as usize) };
    }
}

pub(crate) fn stop_asked() -> bool {
    STOP.load(AtomicOrdering::Relaxed)
}

#[derive(Serialize)]
struct Conflicts {
    /// nets to route again after this pass (in conflict, return lost, search limit, pour wall)
    nets: usize,
    /// distinct pairs of routed items that break a clearance (the audit)
    pairs: usize,
    /// conflict samples, weighted by the items hit (the audit)
    samples: u32,
    pour_faults: usize,
    /// nets whose search ended at its pop limit: not proved blocked, so an open net here may be routable
    search_limited: usize,
}

#[derive(Serialize)]
struct Worst {
    net: String,
    why: String,
}

#[derive(Serialize)]
struct Hot {
    /// centre of the cell, board coordinates (mm)
    x: f64,
    y: f64,
    /// where the history is highest: a copper layer, or "via"
    layer: String,
    /// mean PathFinder history there, summed over the passes so far
    hist: f64,
    /// conflict pairs of this pass in the cell
    pairs: u32,
}

#[derive(Serialize)]
struct Best {
    pass: usize,
    nets: usize,
    pairs: usize,
}

#[derive(Serialize)]
struct File {
    schema: &'static str,
    state: &'static str,
    /// why the negotiation ended (null while it runs): converged, iters, max-time, hard-fails, stall-passes, cancelled
    stop: Option<&'static str>,
    seed: Option<u64>,
    bind: Option<Bind>,
    pass: usize,
    max_passes: usize,
    elapsed_s: f64,
    /// nets whose last search left them open
    unrouted: usize,
    conflicts: Conflicts,
    /// routed vias (signal, return, fan-out) and routed track length
    vias: usize,
    wire_mm: f64,
    best: Option<Best>,
    /// passes since the best one (--stall-passes counts these)
    passes_since_best: usize,
    worst_nets: Vec<Worst>,
    hot_cell_mm: f64,
    hot: Vec<Hot>,
}

/// What a pass knows that is not in Ctx.
pub(crate) struct Pass<'a> {
    pub pass: usize,
    pub au: &'a Audit,
    pub involved: &'a [usize],
    pub state: &'a [(Option<String>, u32)],
    pub pour_faults: usize,
    pub search_limited: usize,
    pub best: Option<(usize, (usize, usize))>,
    pub since_best: usize,
}

pub(crate) struct Writer {
    path: String,
    tmp: String,
    t0: std::time::Instant,
    seed: Option<u64>,
    bind: Option<Bind>,
    max_passes: usize,
    /// seconds spent here and files written, for the overhead line of the run
    spent: f64,
    writes: usize,
    warned: bool,
}

fn r3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

fn clip(s: &str) -> String {
    s.chars().take(MAX_WHY).collect()
}

/// Between two bounding boxes: the centre of their overlap, or of the gap when they do not overlap.
fn between(a: &Shape, b: &Shape) -> (f64, f64) {
    let (a0, a1, a2, a3) = a.geo.bbox();
    let (b0, b1, b2, b3) = b.geo.bbox();
    ((a0.max(b0) + a2.min(b2)) / 2.0, (a1.max(b1) + a3.min(b3)) / 2.0)
}

fn worst_nets(ctx: &Ctx, p: &Pass) -> Vec<Worst> {
    let name = |n: usize| ctx.bd.nets[n].name.as_str();
    // open nets first, then the most conflict samples, then the net index
    let mut v: Vec<usize> = (0..ctx.bd.nets.len()).filter(|&n| p.state[n].0.is_some() || p.involved.contains(&n)).collect();
    v.sort_by_key(|&n| (p.state[n].0.is_none(), std::cmp::Reverse(p.au.per_net[n]), n));
    v.truncate(MAX_NETS);
    v.into_iter().map(|n| {
        let why = match &p.state[n].0 {
            Some(m) => clip(m),
            None if p.au.per_net[n] > 0 => {
                let with: Vec<&str> = p.au.partners[n].iter().take(4).map(|&q| name(q)).collect();
                clip(&format!("{} conflict samples with {}", p.au.per_net[n], with.join(" ")))
            }
            None => "routed again: return via lost, search limit or pour wall".to_string(),
        };
        Worst { net: name(n).to_string(), why }
    }).collect()
}

fn hot_cells(ctx: &Ctx, pair_ids: &[(u32, u32)]) -> (f64, Vec<Hot>) {
    let (gr, bd) = (&ctx.gr, &*ctx.bd);
    let cb = ((HOT_CELL_MM / gr.p).round() as usize).max(1);
    let (cx, cy) = (gr.nx.div_ceil(cb), gr.ny.div_ceil(cb));
    let (plane, n) = (cx * cy, gr.nx * gr.ny);
    // sums per routable layer, then the via sites as one more layer
    let mut sum = vec![0.0f64; (gr.nr + 1) * plane];
    for r in 0..=gr.nr {
        let src = if r < gr.nr { &gr.hist[r * n..(r + 1) * n] } else { &gr.vhist[..] };
        for j in 0..gr.ny {
            let row = r * plane + (j / cb) * cx;
            for (i, &h) in src[j * gr.nx..(j + 1) * gr.nx].iter().enumerate() {
                if h != 0.0 {
                    sum[row + i / cb] += h as f64;
                }
            }
        }
    }
    let mut pairs = vec![0u32; plane];
    for &(a, b) in pair_ids {
        let (x, y) = between(&bd.shapes[a as usize], &bd.shapes[b as usize]);
        let (i, j) = gr.at(x, y);
        pairs[(j / cb) * cx + i / cb] += 1;
    }
    let area = (cb * cb) as f64;
    let top = |c: usize| (0..=gr.nr).map(|r| (sum[r * plane + c] / area, r)).fold((0.0, 0), |m, e| if e.0 > m.0 { e } else { m });
    let mut cells: Vec<(u32, f64, usize, usize)> = (0..plane).filter_map(|c| {
        let (h, r) = top(c);
        (h > 0.0 || pairs[c] > 0).then_some((pairs[c], h, r, c))
    }).collect();
    cells.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.partial_cmp(&a.1).unwrap()).then(a.3.cmp(&b.3)));
    cells.truncate(MAX_HOT);
    let mm = cb as f64 * gr.p;
    (mm, cells.into_iter().map(|(k, h, r, c)| Hot {
        x: r3(gr.x0 + ((c % cx) as f64 + 0.5) * mm),
        y: r3(gr.y0 + ((c / cx) as f64 + 0.5) * mm),
        layer: if r < gr.nr { bd.layer_names[bd.routable[r]].clone() } else { "via".to_string() },
        hist: r3(h),
        pairs: k,
    }).collect())
}

fn copper(bd: &Board) -> (usize, f64) {
    let (mut vias, mut len) = (0usize, 0.0f64);
    for s in bd.shapes.iter().filter(|s| s.alive && s.owner >= 0) {
        match (s.kind, s.geo) {
            (Kind::Via, _) => vias += 1,
            (Kind::Track, Geo::Seg(ax, ay, bx, by, _)) => len += (bx - ax).hypot(by - ay),
            _ => {}
        }
    }
    (vias, len)
}

impl Writer {
    /// A path that cannot be written stops the run here, not minutes into it.
    pub(crate) fn new(path: &str, t0: std::time::Instant, seed: Option<u64>, max_passes: usize) -> Writer {
        let mut w = Writer { path: path.to_string(), tmp: format!("{path}.tmp"), t0, seed, bind: None, max_passes, spent: 0.0, writes: 0, warned: false };
        if let Err(e) = w.start() {
            eprintln!("checkpoint {path}: {e}");
            std::process::exit(2);
        }
        w
    }

    fn start(&mut self) -> std::io::Result<()> {
        let c = Conflicts { nets: 0, pairs: 0, samples: 0, pour_faults: 0, search_limited: 0 };
        let f = self.file(0, "running", None, 0, c, (0, 0.0), None, 0, Vec::new(), (HOT_CELL_MM, Vec::new()));
        self.put(&f)
    }

    /// What the run is a run of, once the model is read.
    pub(crate) fn bind(&mut self, b: Bind) {
        let t = std::time::Instant::now();
        self.bind = Some(b);
        self.start().ok();
        self.spent += t.elapsed().as_secs_f64();
    }

    #[allow(clippy::too_many_arguments)]
    fn file(&self, pass: usize, state: &'static str, stop: Option<&'static str>, unrouted: usize, conflicts: Conflicts, cu: (usize, f64), best: Option<Best>, since: usize,
            worst_nets: Vec<Worst>, hot: (f64, Vec<Hot>)) -> File {
        File { schema: "iot-lab.route-checkpoint.v0", state, stop, seed: self.seed, bind: self.bind.clone(), pass, max_passes: self.max_passes, elapsed_s: r3(self.t0.elapsed().as_secs_f64()), unrouted, conflicts,
               vias: cu.0, wire_mm: r3(cu.1), best, passes_since_best: since, worst_nets, hot_cell_mm: hot.0, hot: hot.1 }
    }

    fn put(&mut self, f: &File) -> std::io::Result<()> {
        std::fs::write(&self.tmp, serde_json::to_string_pretty(f).unwrap())?;
        std::fs::rename(&self.tmp, &self.path)?;
        self.writes += 1;
        Ok(())
    }

    fn write(&mut self, f: File, t: std::time::Instant) {
        // a disk that fills up later must not end a long route: the route is the product, this file only watches it
        if let Err(e) = self.put(&f) {
            if !self.warned {
                eprintln!("checkpoint {}: {e} (the route goes on)", self.path);
                self.warned = true;
            }
        }
        self.spent += t.elapsed().as_secs_f64();
    }

    /// After a pass, from what it already knows.
    pub(crate) fn pass(&mut self, ctx: &Ctx, p: &Pass) {
        let t = std::time::Instant::now();
        let c = Conflicts { nets: p.involved.len(), pairs: p.au.pairs, samples: p.au.samples, pour_faults: p.pour_faults, search_limited: p.search_limited };
        let best = p.best.map(|(pass, s)| Best { pass, nets: s.0, pairs: s.1 });
        let unrouted = p.state.iter().filter(|s| s.0.is_some()).count();
        let f = self.file(p.pass, "running", None, unrouted, c, copper(ctx.bd), best, p.since_best, worst_nets(ctx, p), hot_cells(ctx, &p.au.pair_ids));
        self.write(f, t);
    }

    /// The end state, after OUT.json: `failed` as written there. The history is the end state of the negotiation.
    pub(crate) fn done(&mut self, ctx: &mut Ctx, pass: usize, stop: &'static str, failed: &[Fail], best: Option<(usize, (usize, usize))>, since: usize) {
        let t = std::time::Instant::now();
        let au = ctx.audit(0.0);
        let c = Conflicts { nets: (0..au.per_net.len()).filter(|&n| au.per_net[n] > 0).count(), pairs: au.pairs, samples: au.samples, pour_faults: failed.iter().filter(|m| m.stage == "pour").count(),
                            search_limited: failed.iter().filter(|m| m.reason.contains("search limit")).count() };
        let worst: Vec<Worst> = failed.iter().take(MAX_NETS).map(|m| Worst { net: m.net.clone(), why: clip(&m.reason) }).collect();
        let best = best.map(|(pass, s)| Best { pass, nets: s.0, pairs: s.1 });
        let f = self.file(pass, "done", Some(stop), failed.len(), c, copper(ctx.bd), best, since, worst, hot_cells(ctx, &au.pair_ids));
        self.write(f, t);
        eprintln!("checkpoint: {} writes, {:.3} s, {:.3} % of the run", self.writes, self.spent, 100.0 * self.spent / self.t0.elapsed().as_secs_f64().max(1e-9));
    }
}
