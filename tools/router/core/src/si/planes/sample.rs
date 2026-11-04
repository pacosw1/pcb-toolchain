//! The sampled crossing screen (D-124c): samples of each track against the reference under them.
use super::spec::{Caps, Spec};
use crate::si::pairs::Circle;
use crate::si::py::{TAU, count, dist, first_max, modulo, most_common};
use std::cell::Cell;
use std::collections::HashMap;

/// A point in mm.
pub type P = (f64, f64);

/// A sample point and the length it stands for.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sample {
    pub x: f64,
    pub y: f64,
    pub w: f64,
}

/// Where the return current leaves or joins the reference: a terminal is reached at copper within `snap` of it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Terminal {
    pub x: f64,
    pub y: f64,
    pub snap: f64,
}

impl Terminal {
    pub fn at(&self) -> P {
        (self.x, self.y)
    }
}

/// One unreferenced run of a net.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Run {
    pub length: f64,
    pub at: P,
    pub terminals: Vec<Terminal>,
    pub bad_points: Vec<P>,
    pub net: String,
    /// Proved an unloaded native leaf (native.rs); only that proof sets it.
    pub proven_stub: Cell<bool>,
}

/// The check of one net on one outer layer.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct NetResult {
    pub length: f64,
    pub unref: f64,
    pub bad: f64,
    pub worst: f64,
    pub worst_at: Option<P>,
    pub cross: f64,
    pub runs: Vec<Run>,
    pub cross_net: Option<String>,
}

impl NetResult {
    pub fn finish(&mut self, cross_nets: &[(String, f64)]) {
        if let Some(worst) = first_max(self.runs.iter(), |r| r.length) {
            (self.worst, self.worst_at) = (worst.length, Some(worst.at));
        }
        self.cross_net = most_common(cross_nets).first().map(|(n, _)| n.clone());
    }
}

/// Is copper of a filled zone under this point of the adjacent layer, and of which net?
pub type RefAt<'a> = dyn Fn(f64, f64) -> Option<&'a str> + 'a;

/// A net's own via or pad: x, y and radius.
pub type Anchor = (f64, f64, f64);

/// Samples at the centres of equal parts no longer than step.
pub fn sample_segment(a: P, b: P, step: f64) -> Vec<Sample> {
    let length = dist(a, b);
    if length == 0.0 {
        return Vec::new();
    }
    let n = ((length / step - 1e-9).ceil() as usize).max(1);
    let w = length / n as f64;
    (0..n).map(|i| {
        let t = i as f64 + 0.5;
        Sample { x: a.0 + (b.0 - a.0) * t / n as f64, y: a.1 + (b.1 - a.1) * t / n as f64, w }
    }).collect()
}

/// Samples an arc from a through m to e, like sample_segment.
pub fn sample_arc(a: P, m: P, e: P, step: f64) -> Vec<Sample> {
    let Some(circle) = Circle::through(a, m, e) else { return sample_segment(a, e, step) };
    let (t0, tm, t1) = (circle.angle(a), circle.angle(m), circle.angle(e));
    let mut sweep = modulo(t1 - t0, TAU);
    if modulo(tm - t0, TAU) > sweep {
        sweep -= TAU; // the arc goes the other way round
    }
    let length = sweep.abs() * circle.r;
    let n = ((length / step - 1e-9).ceil() as usize).max(1);
    (0..n).map(|i| {
        let (x, y) = circle.at(t0 + sweep * (i as f64 + 0.5) / n as f64);
        Sample { x, y, w: length / n as f64 }
    }).collect()
}

fn cell_of(x: f64, y: f64, link: f64) -> (i64, i64) {
    ((x / link).floor() as i64, (y / link).floor() as i64)
}

fn find(parent: &mut [usize], mut i: usize) -> usize {
    while parent[i] != i {
        parent[i] = parent[parent[i]];
        i = parent[i];
    }
    i
}

/// The sets of a union-find, each in index order, the sets in order of their first member.
pub fn sets(parent: &mut [usize]) -> Vec<Vec<usize>> {
    let mut order: Vec<Vec<usize>> = Vec::new();
    let mut slot: HashMap<usize, usize> = HashMap::new();
    for i in 0..parent.len() {
        let root = find(parent, i);
        let at = *slot.entry(root).or_insert_with(|| {
            order.push(Vec::new());
            order.len() - 1
        });
        order[at].push(i);
    }
    order
}

pub fn join(parent: &mut [usize], a: usize, b: usize) {
    let (ra, rb) = (find(parent, a), find(parent, b));
    parent[ra] = rb;
}

/// Groups points that touch (distance <= link). Returns lists of indices.
fn groups(points: &[P], link: f64) -> Vec<Vec<usize>> {
    let mut parent: Vec<usize> = (0..points.len()).collect();
    let mut grid: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (i, q) in points.iter().enumerate() {
        grid.entry(cell_of(q.0, q.1, link)).or_default().push(i);
    }
    for (&(gx, gy), ids) in &grid {
        for dx in -1..=1 {
            for dy in -1..=1 {
                for &j in grid.get(&(gx + dx, gy + dy)).map_or(&[][..], Vec::as_slice) {
                    for &i in ids {
                        if i < j && dist(points[i], points[j]) <= link {
                            join(&mut parent, i, j);
                        }
                    }
                }
            }
        }
    }
    sets(&mut parent)
}

/// What the sample check of a net needs.
pub struct NetInputs<'a, 'b> {
    pub ref_at: &'b RefAt<'a>,
    pub domain: Option<&'b str>,
    pub anchors: &'b [Anchor],
    pub spec: &'b Spec,
    pub net: &'b str,
    pub caps: &'b Caps,
}

/// One terminal per side: of the good samples touching a run, those that touch each other count once, as the widest.
fn run_terminals(run: &[usize], bad: &[Sample], good: &[Terminal], index: &HashMap<(i64, i64), Vec<usize>>, link: f64) -> Vec<Terminal> {
    let mut near: Vec<usize> = Vec::new();
    for &i in run {
        let (bx, by) = (bad[i].x, bad[i].y);
        let (cx, cy) = cell_of(bx, by, link);
        for dx in -1..=1 {
            for dy in -1..=1 {
                near.extend(index.get(&(cx + dx, cy + dy)).map_or(&[][..], Vec::as_slice).iter().copied().filter(|&j| dist((bx, by), good[j].at()) <= link));
            }
        }
    }
    near.sort_unstable();
    near.dedup();
    let list: Vec<Terminal> = near.iter().map(|&j| good[j]).collect();
    let points: Vec<P> = list.iter().map(Terminal::at).collect();
    groups(&points, link).iter().filter_map(|g| first_max(g.iter().map(|&k| list[k]), |q| q.snap)).collect()
}

/// Checks the samples of one net on one outer layer. A bad sample near a net's own via or pad, or in an exempt area of this net,
/// does not count in the worst run or in the crossing length. Each run gets its terminals: the good samples next to it, where the
/// return current leaves and joins the reference; at an own via or pad the snap radius is the anchor radius + via_allow_mm.
pub fn evaluate_net(samples: &[Sample], inputs: &NetInputs) -> NetResult {
    let NetInputs { ref_at, domain, anchors, spec, net, caps } = *inputs;
    let (allow, step) = (spec.via_allow_mm, spec.step_mm);
    let areas: Vec<_> = spec.exempt_areas.iter().filter(|a| a.nets.iter().any(|n| n == net)).collect();
    let fast = spec.is_fast(net);
    let mut result = NetResult::default();
    let (mut bad, mut good, mut cross_nets): (Vec<Sample>, Vec<Terminal>, Vec<(String, f64)>) = (Vec::new(), Vec::new(), Vec::new());
    for &s in samples {
        result.length += s.w;
        let reference = ref_at(s.x, s.y);
        let rd = spec.ref_domain(reference, fast, (s.x, s.y), caps);
        if domain.is_some() && rd == domain {
            good.push(Terminal { x: s.x, y: s.y, snap: step });
            continue;
        }
        result.unref += s.w;
        let near = anchors.iter().filter(|a| dist((s.x, s.y), (a.0, a.1)) <= a.2 + allow).map(|a| a.2).fold(None::<f64>, |m, r| Some(m.map_or(r, |m| m.max(r))));
        if let Some(radius) = near {
            good.push(Terminal { x: s.x, y: s.y, snap: radius + allow + step });
            continue;
        }
        if areas.iter().any(|a| a.holds(s.x, s.y)) {
            continue;
        }
        bad.push(s);
        if domain.is_some() && rd.is_some() {
            result.cross += s.w;
            count(&mut cross_nets, reference.expect("a domain has a reference").to_string(), s.w);
        }
    }
    let link = 1.2 * step;
    let mut index: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (i, q) in good.iter().enumerate() {
        index.entry(cell_of(q.x, q.y, link)).or_default().push(i);
    }
    let points: Vec<P> = bad.iter().map(|s| (s.x, s.y)).collect();
    for g in groups(&points, link) {
        let w: f64 = g.iter().map(|&i| bad[i].w).sum();
        let at = (g.iter().map(|&i| bad[i].x * bad[i].w).sum::<f64>() / w, g.iter().map(|&i| bad[i].y * bad[i].w).sum::<f64>() / w);
        let terminals = run_terminals(&g, &bad, &good, &index, link);
        result.runs.push(Run { length: w, at, terminals, bad_points: g.iter().map(|&i| points[i]).collect(), net: net.to_string(), ..Run::default() });
    }
    result.bad = bad.iter().map(|s| s.w).sum();
    result.finish(&cross_nets);
    result
}
