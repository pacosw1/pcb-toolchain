//! Native continuous projection (D-124d, report-only): whole tracks against the exact boundaries of the reference, so a hole
//! narrower than the sample step cannot hide.
use super::sample::{Anchor, NetResult, P, RefAt, Run, Terminal, join, sets};
use super::spec::{Caps, ExemptArea, Spec};
use crate::si::pairs::Circle;
use crate::si::py::{TAU, count, dist, modulo};
use std::collections::HashMap;

/// A boundary edge.
pub type Edge = (P, P);
/// A circle: centre and radius.
pub type Round = (P, f64);

const LEAF: usize = 16;

fn overlaps(a: &[f64; 4], b: &[f64; 4]) -> bool {
    a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]
}

enum Node {
    Leaf([f64; 4], Vec<usize>),
    Split([f64; 4], Box<Node>, Box<Node>),
}

fn bounds(ids: &[usize], boxes: &[[f64; 4]]) -> [f64; 4] {
    ids.iter().fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |b, &i| {
        let q = boxes[i];
        [b[0].min(q[0]), b[1].min(q[1]), b[2].max(q[2]), b[3].max(q[3])]
    })
}

fn build(mut ids: Vec<usize>, boxes: &[[f64; 4]]) -> Node {
    let bbox = bounds(&ids, boxes);
    if ids.len() <= LEAF {
        return Node::Leaf(bbox, ids);
    }
    let axis = usize::from(bbox[2] - bbox[0] < bbox[3] - bbox[1]);
    ids.sort_by(|&a, &b| (boxes[a][axis] + boxes[a][axis + 2]).total_cmp(&(boxes[b][axis] + boxes[b][axis + 2])));
    let right = ids.split_off(ids.len() / 2);
    Node::Split(bbox, Box::new(build(ids, boxes)), Box::new(build(right, boxes)))
}

/// An immutable AABB tree over the edges of a reference; a query gives the edges whose inclusive box overlaps.
pub struct EdgeIndex {
    edges: Vec<Edge>,
    boxes: Vec<[f64; 4]>,
    tree: Option<Node>,
}

impl EdgeIndex {
    pub fn new(edges: Vec<Edge>) -> EdgeIndex {
        let boxes: Vec<[f64; 4]> = edges.iter().map(|(a, b)| [a.0.min(b.0), a.1.min(b.1), a.0.max(b.0), a.1.max(b.1)]).collect();
        let tree = (!edges.is_empty()).then(|| build((0..edges.len()).collect(), &boxes));
        EdgeIndex { edges, boxes, tree }
    }

    fn visit(&self, node: &Node, query: &[f64; 4], out: &mut Vec<usize>) {
        match node {
            Node::Leaf(bbox, ids) => {
                if overlaps(bbox, query) {
                    out.extend(ids.iter().copied().filter(|&i| overlaps(&self.boxes[i], query)));
                }
            }
            Node::Split(bbox, left, right) => {
                if overlaps(bbox, query) {
                    self.visit(left, query, out);
                    self.visit(right, query, out);
                }
            }
        }
    }

    /// The edges that can meet the segment a-b. A sub-nanometre segment gets every edge; the margin covers native 1 nm rounding and
    /// near-collinear tolerance.
    fn near(&self, a: P, b: P) -> Vec<Edge> {
        if dist(a, b) < 1e-6 {
            return self.edges.clone();
        }
        let margin = [a.0, a.1, b.0, b.1].iter().map(|v| ulp(*v) * 64.0).fold(1e-6, f64::max);
        let query = [a.0.min(b.0) - margin, a.1.min(b.1) - margin, a.0.max(b.0) + margin, a.1.max(b.1) + margin];
        let mut ids = Vec::new();
        if let Some(tree) = &self.tree {
            self.visit(tree, &query, &mut ids);
        }
        ids.sort_unstable();
        ids.iter().map(|&i| self.edges[i]).collect()
    }
}

fn ulp(v: f64) -> f64 {
    let v = v.abs();
    f64::from_bits(v.to_bits() + 1) - v
}

/// Reference boundaries: an index built once per layer, and the few per-net edges, always tested.
#[derive(Default)]
pub struct Boundaries<'a> {
    pub index: Option<&'a EdgeIndex>,
    pub extra: Vec<Edge>,
}

impl Boundaries<'_> {
    fn near(&self, a: P, b: P) -> Vec<Edge> {
        let mut edges = self.index.map_or(Vec::new(), |index| index.near(a, b));
        edges.extend(&self.extra);
        edges
    }

    fn all(&self) -> impl Iterator<Item = &Edge> {
        self.index.map_or(&[][..], |i| i.edges.as_slice()).iter().chain(&self.extra)
    }
}

fn sorted_unique(mut values: Vec<f64>) -> Vec<f64> {
    values.sort_by(f64::total_cmp);
    values.dedup_by(|a, b| a == b);
    values
}

/// Every point of the segment where the reference can change: polygon or cap boundary crossings. Point-only grid membership is not
/// enough, two free nodes can straddle a hole narrower than the cell. Boundaries include outer rings AND holes.
pub fn reference_breaks(boundaries: &Boundaries, a: P, b: P, circles: &[Round]) -> Vec<f64> {
    let (ax, ay) = a;
    let (dx, dy) = (b.0 - ax, b.1 - ay);
    let norm = dx * dx + dy * dy;
    let mut ts = vec![0.0, 1.0];
    for (c, d) in boundaries.near(a, b) {
        let (ex, ey) = (d.0 - c.0, d.1 - c.1);
        let den = dx * ey - dy * ex;
        let (cx, cy) = (c.0 - ax, c.1 - ay);
        if den.abs() > 1e-15 {
            let (t, u) = ((cx * ey - cy * ex) / den, (cx * dy - cy * dx) / den);
            if (0.0..=1.0).contains(&t) && (0.0..=1.0).contains(&u) {
                ts.push(t);
            }
        } else if (cx * dy - cy * dx).abs() <= 1e-15 && norm != 0.0 {
            ts.extend([c, d].iter().map(|q| ((q.0 - ax) * dx + (q.1 - ay) * dy) / norm).filter(|t| (0.0..=1.0).contains(t)));
        }
    }
    if norm != 0.0 {
        for &((cx, cy), r) in circles {
            let (qx, qy) = (ax - cx, ay - cy);
            let linear = 2.0 * (qx * dx + qy * dy);
            let disc = linear * linear - 4.0 * norm * (qx * qx + qy * qy - r * r);
            if disc >= 0.0 {
                ts.extend([(-linear - disc.sqrt()) / (2.0 * norm), (-linear + disc.sqrt()) / (2.0 * norm)].into_iter().filter(|t| (0.0..=1.0).contains(t)));
            }
        }
    }
    sorted_unique(ts)
}

/// Is the whole segment on reference copper? The ends, then the middle of each stretch between breaks.
pub fn continuous_reference(ok: &dyn Fn(f64, f64) -> bool, boundaries: &Boundaries, a: P, b: P, circles: &[Round]) -> bool {
    let cuts = reference_breaks(boundaries, a, b, circles);
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let middles = cuts.windows(2).map(|w| (w[0] + w[1]) / 2.0);
    [0.0, 1.0].into_iter().chain(middles).all(|t| ok(a.0 + t * dx, a.1 + t * dy))
}

/// A stretch of a native path: start, midpoint, end and length.
pub type Record = (P, P, P, f64);

/// The parameters along an arc where it meets the boundaries and circles.
fn arc_cuts(circle: &Circle, angle: f64, sweep: f64, boundaries: &Boundaries, circles: &[Round]) -> Vec<f64> {
    let (ux, uy, radius) = (circle.x, circle.y, circle.r);
    let mut cuts = vec![0.0, 1.0];
    let mut add = |q: P| {
        let theta = (q.1 - uy).atan2(q.0 - ux);
        let delta = if sweep > 0.0 { modulo(theta - angle, TAU) } else { -modulo(angle - theta, TAU) };
        let t = delta / sweep;
        if (-1e-12..=1.0 + 1e-12).contains(&t) {
            cuts.push(t.clamp(0.0, 1.0));
        }
    };
    for &(c, d) in boundaries.all() {
        let (dx, dy) = (d.0 - c.0, d.1 - c.1);
        let (qx, qy) = (c.0 - ux, c.1 - uy);
        let norm = dx * dx + dy * dy;
        if norm == 0.0 {
            continue;
        }
        let linear = 2.0 * (qx * dx + qy * dy);
        let disc = linear * linear - 4.0 * norm * (qx * qx + qy * qy - radius * radius);
        if disc >= 0.0 {
            for u in [(-linear - disc.sqrt()) / (2.0 * norm), (-linear + disc.sqrt()) / (2.0 * norm)] {
                if (0.0..=1.0).contains(&u) {
                    add((c.0 + u * dx, c.1 + u * dy));
                }
            }
        }
    }
    for &((cx, cy), r) in circles {
        let gap = dist((ux, uy), (cx, cy));
        if gap == 0.0 || gap > radius + r || gap < (radius - r).abs() {
            continue;
        }
        let along = (radius * radius - r * r + gap * gap) / (2.0 * gap);
        let height = (radius * radius - along * along).max(0.0).sqrt();
        let (vx, vy) = ((cx - ux) / gap, (cy - uy) / gap);
        for sign in [-1.0, 1.0] {
            add((ux + along * vx - sign * height * vy, uy + along * vy + sign * height * vx));
        }
    }
    sorted_unique(cuts)
}

/// Exact boundary partition of a native straight segment or circular arc. Classification is constant on each open interval: polygon,
/// anchor, exemption and cap boundaries are all supplied. Step only subdivides those intervals for diagnostics; it never establishes
/// coverage.
pub fn partition_signal_path(path: &[P], boundaries: &Boundaries, circles: &[Round], step: f64) -> Vec<Record> {
    let (a, e) = (path[0], path[path.len() - 1]);
    let arc = (path.len() == 3).then(|| Circle::through(path[0], path[1], path[2])).flatten();
    let (length, cuts, point): (f64, Vec<f64>, Box<dyn Fn(f64) -> P>) = match arc {
        None => (dist(a, e), reference_breaks(boundaries, a, e, circles), Box::new(move |t| (a.0 + t * (e.0 - a.0), a.1 + t * (e.1 - a.1)))),
        Some(circle) => {
            let angles = [circle.angle(path[0]), circle.angle(path[1]), circle.angle(path[2])];
            let mut sweep = modulo(angles[2] - angles[0], TAU);
            if modulo(angles[1] - angles[0], TAU) > sweep {
                sweep -= TAU;
            }
            let start = angles[0];
            let cuts = arc_cuts(&circle, start, sweep, boundaries, circles);
            (circle.r * sweep.abs(), cuts, Box::new(move |t| circle.at(start + t * sweep)))
        }
    };
    if length == 0.0 {
        return Vec::new();
    }
    let mut records = Vec::new();
    for w in cuts.windows(2) {
        let (lo, hi) = (w[0], w[1]);
        let n = ((length * (hi - lo) / step).ceil() as usize).max(1);
        for i in 0..n {
            let (u, v) = (lo + (hi - lo) * i as f64 / n as f64, lo + (hi - lo) * (i + 1) as f64 / n as f64);
            if v > u {
                records.push((point(u), point((u + v) / 2.0), point(v), length * (v - u)));
            }
        }
    }
    records
}

#[derive(Clone, Copy, PartialEq)]
enum State {
    Good,
    Exempt,
    Bad,
}

struct Interval {
    start: P,
    mid: P,
    end: P,
    weight: f64,
    state: State,
    radius: f64,
}

/// KiCad's native coordinate unit is one nanometre. This key is only for native endpoint identity, not an enlargement of copper.
fn key(q: P) -> (i64, i64) {
    ((q.0 * 1e6).round_ties_even() as i64, (q.1 * 1e6).round_ties_even() as i64)
}

/// What the projection of a net needs.
pub struct PathInputs<'a, 'b> {
    pub boundaries: Option<&'b EdgeIndex>,
    pub ref_at: &'b RefAt<'a>,
    pub domain: Option<&'b str>,
    pub anchors: &'b [Anchor],
    pub spec: &'b Spec,
    pub net: &'b str,
    pub caps: &'b Caps,
}

fn box_ring(rect: [f64; 4]) -> Vec<Edge> {
    let [x0, y0, x1, y1] = rect;
    let ring = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)];
    (0..4).map(|i| (ring[i], ring[(i + 1) % 4])).collect()
}

/// The partition edges and circles of a net: its anchors, caps, exempt areas and same-net centreline junctions. A branch endpoint may
/// lie inside an unsplit track, so the partition stops at junctions whatever the step. Full supporting circles may add harmless cuts
/// outside an arc's sweep; zero-radius endpoint circles also split overlapping arcs.
fn partition_set<'a, 'b>(paths: &[Vec<P>], areas: &[&ExemptArea], inputs: &PathInputs<'a, 'b>) -> (Boundaries<'b>, Vec<Round>) {
    let spec = inputs.spec;
    let mut circles: Vec<Round> = inputs.anchors.iter().map(|a| ((a.0, a.1), a.2 + spec.via_allow_mm)).collect();
    for (net, alt) in &spec.alt_refs {
        if let Some(cap) = alt.cap_mm {
            circles.extend(inputs.caps.get(net).map_or(&[][..], Vec::as_slice).iter().map(|c| (*c, cap)));
        }
    }
    let mut extra: Vec<Edge> = areas.iter().flat_map(|a| box_ring(a.rect)).collect();
    for path in paths {
        match (path.len() == 3).then(|| Circle::through(path[0], path[1], path[2])).flatten() {
            Some(c) => circles.push(((c.x, c.y), c.r)),
            None => extra.push((path[0], path[path.len() - 1])),
        }
        circles.push((path[0], 0.0));
        circles.push((path[path.len() - 1], 0.0));
    }
    (Boundaries { index: inputs.boundaries, extra }, circles)
}

/// Projects whole native paths, preserving distinct sides of narrow voids. Bad intervals join only at actual path endpoints: close
/// opposite sides of a gap do not collapse into one terminal merely because the step is large.
pub fn evaluate_paths(paths: &[Vec<P>], inputs: &PathInputs) -> NetResult {
    let PathInputs { ref_at, domain, anchors, spec, net, caps, .. } = *inputs;
    let areas: Vec<&ExemptArea> = spec.exempt_areas.iter().filter(|a| a.nets.iter().any(|n| n == net)).collect();
    let (edges, circles) = partition_set(paths, &areas, inputs);
    let fast = spec.is_fast(net);
    let mut result = NetResult::default();
    let mut cross_nets: Vec<(String, f64)> = Vec::new();
    let mut bad: Vec<(P, P, P, f64)> = Vec::new();
    let mut terminals: HashMap<(i64, i64), Vec<Terminal>> = HashMap::new();
    for path in paths {
        let mut states: Vec<Interval> = Vec::new();
        for (start, q, end, weight) in partition_signal_path(path, &edges, &circles, spec.step_mm) {
            result.length += weight;
            let reference = ref_at(q.0, q.1);
            let rd = spec.ref_domain(reference, fast, q, caps);
            let good = domain.is_some() && rd == domain;
            if !good {
                result.unref += weight;
            }
            let near: Vec<&Anchor> = anchors.iter().filter(|a| dist(q, (a.0, a.1)) <= a.2 + spec.via_allow_mm).collect();
            let state = if good || !near.is_empty() {
                State::Good
            } else if areas.iter().any(|a| a.holds(q.0, q.1)) {
                State::Exempt
            } else {
                State::Bad
            };
            let radius = if good { spec.step_mm } else { near.iter().map(|a| a.2 + spec.via_allow_mm + spec.step_mm).fold(0.0, f64::max) };
            states.push(Interval { start, mid: q, end, weight, state, radius });
            if state == State::Bad && domain.is_some() && rd.is_some() {
                result.cross += weight;
                count(&mut cross_nets, reference.expect("a domain has a reference").to_string(), weight);
            }
        }
        for (i, row) in states.iter().enumerate() {
            if row.state == State::Bad {
                bad.push((row.start, row.mid, row.end, row.weight));
            } else if row.state == State::Good {
                let terminal = Terminal { x: row.mid.0, y: row.mid.1, snap: row.radius };
                let before_bad = i > 0 && states[i - 1].state == State::Bad;
                let after_bad = i + 1 < states.len() && states[i + 1].state == State::Bad;
                // Reference at a track junction also attaches a bad interval on another segment; only shared endpoints are joined.
                for (hit, end) in [(before_bad, row.start), (after_bad, row.end), (i == 0, row.start), (i == states.len() - 1, row.end)] {
                    if hit {
                        terminals.entry(key(end)).or_default().push(terminal);
                    }
                }
            }
        }
    }
    let mut parent: Vec<usize> = (0..bad.len()).collect();
    let mut touching: HashMap<(i64, i64), usize> = HashMap::new();
    for (i, (start, _, end, _)) in bad.iter().enumerate() {
        for endpoint in [start, end] {
            match touching.get(&key(*endpoint)) {
                Some(&other) => join(&mut parent, i, other),
                None => {
                    touching.insert(key(*endpoint), i);
                }
            }
        }
    }
    for ids in sets(&mut parent) {
        result.runs.push(run_of(&ids, &bad, &terminals, net));
    }
    result.bad = result.runs.iter().map(|r| r.length).sum();
    result.finish(&cross_nets);
    result
}

fn run_of(ids: &[usize], bad: &[(P, P, P, f64)], terminals: &HashMap<(i64, i64), Vec<Terminal>>, net: &str) -> Run {
    let weight: f64 = ids.iter().map(|&i| bad[i].3).sum();
    let at = (ids.iter().map(|&i| bad[i].1.0 * bad[i].3).sum::<f64>() / weight, ids.iter().map(|&i| bad[i].1.1 * bad[i].3).sum::<f64>() / weight);
    let mut terms: Vec<Terminal> = ids.iter().flat_map(|&i| [bad[i].0, bad[i].2]).flat_map(|q| terminals.get(&key(q)).map_or(&[][..], Vec::as_slice).iter().copied()).collect();
    terms.sort_by(|a, b| a.x.total_cmp(&b.x).then(a.y.total_cmp(&b.y)).then(a.snap.total_cmp(&b.snap)));
    terms.dedup();
    Run { length: weight, at, terminals: terms, bad_points: ids.iter().map(|&i| bad[i].1).collect(), net: net.to_string(), ..Run::default() }
}
