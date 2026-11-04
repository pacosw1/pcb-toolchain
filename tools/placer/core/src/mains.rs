//! Mains path check of a pose: each net of a .kicad_dru domain class needs a legal straight, L, 45-degree, Z or grid A*
//! path between its pads, with the .kicad_dru class gaps. A net with none is a placement fault: the record names the
//! least bad path and what blocks it.
//!
//! Obstacles: the pads of all units (SMD pads on F.Cu only; NPTH pads are holes on every layer) and the board outline.
//! Not modelled: board keepouts (the problem does not tell no-footprint rule areas, which allow tracks, from outline
//! cutouts) and locked tracks (no net in the problem).

use crate::dru::{Rules, fnmatch};
use crate::geom::{Point, Rect};
use crate::numeric::{compensated, hypot, round_to};
use crate::problem::{Place, Problem};
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::{BTreeMap, BinaryHeap, HashMap, HashSet};

const LAYERS: [&str; 2] = ["F.Cu", "B.Cu"];

fn distance(a: Point, b: Point) -> f64 {
    hypot(a.0 - b.0, a.1 - b.1)
}

fn point6(p: Point) -> Point {
    (round_to(p.0, 6), round_to(p.1, 6))
}

#[derive(Clone, Copy, Debug)]
pub enum Shape {
    /// Centre, width, height.
    Pad { c: Point, w: f64, h: f64 },
    Segment { a: Point, b: Point },
}

fn point_segment(p: Point, a: Point, b: Point) -> f64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len2 = dx * dx + dy * dy;
    let t = if len2 == 0.0 { 0.0 } else { (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / len2).clamp(0.0, 1.0) };
    hypot(p.0 - a.0 - t * dx, p.1 - a.1 - t * dy)
}

fn cross(a: Point, b: Point, c: Point, d: Point) -> bool {
    let side = |p: Point, q: Point, r: Point| (q.0 - p.0) * (r.1 - p.1) - (q.1 - p.1) * (r.0 - p.0);
    side(a, b, c) * side(a, b, d) < 0.0 && side(c, d, a) * side(c, d, b) < 0.0
}

fn point_pad(p: Point, c: Point, w: f64, h: f64) -> f64 {
    hypot(((p.0 - c.0).abs() - w / 2.0).max(0.0), ((p.1 - c.1).abs() - h / 2.0).max(0.0))
}

impl Shape {
    /// Distance from a track centre line to the shape (0 when they touch).
    pub fn distance_to(&self, a: Point, b: Point) -> f64 {
        match *self {
            Self::Segment { a: c, b: d } => {
                if cross(a, b, c, d) {
                    return 0.0;
                }
                point_segment(a, c, d).min(point_segment(b, c, d)).min(point_segment(c, a, b)).min(point_segment(d, a, b))
            }
            Self::Pad { c, w, h } => {
                let (da, db) = (point_pad(a, c, w, h), point_pad(b, c, w, h));
                let corners = Rect::new(c.0 - w / 2.0, c.1 - h / 2.0, c.0 + w / 2.0, c.1 + h / 2.0).corners();
                if da == 0.0 || db == 0.0 || (0..4).any(|i| cross(a, b, corners[i], corners[(i + 1) % 4])) {
                    return 0.0;
                }
                corners.iter().map(|&q| point_segment(q, a, b)).fold(da.min(db), f64::min)
            }
        }
    }

    /// The box of the shape grown by `need`.
    fn grown_box(&self, need: f64) -> Rect {
        match *self {
            Self::Pad { c, w, h } => {
                Rect::new(c.0 - w / 2.0 - need, c.1 - h / 2.0 - need, c.0 + w / 2.0 + need, c.1 + h / 2.0 + need)
            }
            Self::Segment { a, b } => Rect::new(a.0.min(b.0) - need, a.1.min(b.1) - need, a.0.max(b.0) + need, a.1.max(b.1) + need),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Item {
    pub reference: String,
    pub net: String,
    pub class: String,
    pub shape: Shape,
}

impl Item {
    fn centre(&self) -> Point {
        match self.shape {
            Shape::Pad { c, .. } => c,
            Shape::Segment { a, b } => ((a.0 + b.0) / 2.0, (a.1 + b.1) / 2.0),
        }
    }
}

/// The class of a board edge segment and of a hole of a ref.
const EDGE_CLASS: &str = "EDGE";
const HOLE_CLASS: &str = "HOLE:";

/// Gap between two classes from the parsed .kicad_dru and the net class clearances.
pub struct ClassGaps<'a> {
    pub dru: &'a Rules,
    pub clearance: BTreeMap<&'a str, f64>,
    pub edge: f64,
}

fn members(class: &str) -> Vec<&str> {
    let parts: Vec<&str> = class.split(',').map(str::trim).filter(|m| !m.is_empty()).collect();
    if parts.is_empty() { vec![class] } else { parts }
}

impl ClassGaps<'_> {
    fn base(&self, classes: &[&str]) -> f64 {
        classes.iter().map(|m| self.clearance.get(m).copied().unwrap_or(0.0)).fold(f64::NEG_INFINITY, f64::max)
    }

    fn hole_gap(&self, ma: &[&str], reference: &str) -> f64 {
        let applies = |pat: &str, refs: &[String]| ma.iter().any(|m| fnmatch(m, pat)) && refs.iter().any(|r| r == reference);
        let rules = self.dru.holes.iter().filter(|(pat, refs, _)| applies(pat, refs)).map(|h| h.2);
        rules.fold(self.base(ma), f64::max)
    }

    /// A compound class ('A,B', KiCad multi-netclass) is in a domain when any member is.
    fn domain_gap(&self, ma: &[&str], mb: &[&str], mut base: f64) -> f64 {
        for (pat, other, between) in &self.dru.domains {
            let hits = |ms: &[&str]| ms.iter().filter(|m| fnmatch(m, pat)).map(|m| m.to_string()).collect::<HashSet<_>>();
            let (ia, ib) = (hits(ma), hits(mb));
            if ia.is_empty() != ib.is_empty() {
                base = base.max(*other);
            } else if !ia.is_empty() && ia != ib {
                base = base.max(*between);
            }
        }
        base
    }

    fn pair_gap(&self, ma: &[&str], mb: &[&str], mut base: f64) -> f64 {
        let any = |ms: &[&str], ps: &[String]| ms.iter().any(|m| ps.iter().any(|p| fnmatch(m, p)));
        for (ap, bp, g) in &self.dru.pairs {
            if (any(ma, ap) && any(mb, bp)) || (any(mb, ap) && any(ma, bp)) {
                base = base.max(*g);
            }
        }
        base
    }

    pub fn gap(&self, a: &str, b: &str) -> f64 {
        if b == EDGE_CLASS {
            return self.edge;
        }
        let ma = members(a);
        if let Some(reference) = b.strip_prefix(HOLE_CLASS) {
            return self.hole_gap(&ma, reference);
        }
        let mb = members(b);
        let all: Vec<&str> = ma.iter().chain(&mb).copied().collect();
        self.pair_gap(&ma, &mb, self.domain_gap(&ma, &mb, self.base(&all)))
    }
}

/// An obstacle of another net with the distance a track centre line must keep.
pub struct Obstacle<'a> {
    pub item: &'a Item,
    pub half_track: f64,
    pub need: f64,
}

impl Obstacle<'_> {
    /// Margin of a path to the obstacle; below 0 is a violation.
    pub fn margin(&self, path: &[Point]) -> f64 {
        let d = path.windows(2).map(|s| self.item.shape.distance_to(s[0], s[1])).fold(f64::INFINITY, f64::min);
        d - self.half_track - self.need
    }
}

fn is_violation(margin: f64) -> bool {
    margin < -1e-9
}

/// Straight, or the two L and the two 45-degree paths.
fn simple_paths(a: Point, b: Point) -> Vec<Vec<Point>> {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    if dx.abs() < 1e-9 || dy.abs() < 1e-9 || (dx.abs() - dy.abs()).abs() < 1e-9 {
        return vec![vec![a, b]];
    }
    let m = dx.abs().min(dy.abs());
    let (sx, sy) = (1.0_f64.copysign(dx), 1.0_f64.copysign(dy));
    let (d1, d2) = ((a.0 + sx * m, a.1 + sy * m), (b.0 - sx * m, b.1 - sy * m));
    vec![vec![a, (b.0, a.1), b], vec![a, (a.0, b.1), b], vec![a, d1, b], vec![a, d2, b]]
}

fn length(path: &[Point]) -> f64 {
    compensated(path.windows(2).map(|s| distance(s[0], s[1])))
}

/// Two-bend paths through one channel coordinate, on a grid out to `SPAN` beyond the pads, the shortest first.
fn z_paths(a: Point, b: Point) -> Vec<Vec<Point>> {
    const STEP: f64 = 0.25;
    const SPAN: f64 = 12.0;
    let channels = |lo: f64, hi: f64| {
        let n = ((hi - lo + 2.0 * SPAN) / STEP).round_ties_even() as i64;
        (0..=n).map(move |i| lo - SPAN + i as f64 * STEP)
    };
    let vertical = channels(a.0.min(b.0), a.0.max(b.0)).map(|c| vec![a, (c, a.1), (c, b.1), b]);
    let horizontal = channels(a.1.min(b.1), a.1.max(b.1)).map(|c| vec![a, (a.0, c), (b.0, c), b]);
    let mut paths: Vec<_> = vertical.chain(horizontal).map(|p| (length(&p), p)).collect();
    paths.sort_by(|x, y| x.0.total_cmp(&y.0));
    paths.into_iter().map(|p| p.1).collect()
}

fn simplify(path: &[Point]) -> Vec<Point> {
    let mut out = vec![path[0]];
    for i in 1..path.len() - 1 {
        let (a, b, c) = (out[out.len() - 1], path[i], path[i + 1]);
        if ((b.0 - a.0) * (c.1 - b.1) - (b.1 - a.1) * (c.0 - b.0)).abs() > 1e-9 {
            out.push(b);
        }
    }
    out.push(path[path.len() - 1]);
    out
}

type Cell = (i64, i64);

/// An open node of the grid search.
#[derive(Clone, Copy)]
struct Open {
    estimate: f64,
    cost: f64,
    cell: Cell,
    from: Option<Cell>,
}

impl PartialEq for Open {
    fn eq(&self, o: &Self) -> bool {
        self.cmp(o) == Ordering::Equal
    }
}

impl Eq for Open {}

impl PartialOrd for Open {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}

/// Reversed: the heap gives the smallest first.
impl Ord for Open {
    fn cmp(&self, o: &Self) -> Ordering {
        let key = |n: &Self| (n.cell, n.from);
        o.estimate.total_cmp(&self.estimate).then(o.cost.total_cmp(&self.cost)).then_with(|| key(o).cmp(&key(self)))
    }
}

/// Obstacles by 5 mm bucket, for the grid search.
struct Buckets<'a> {
    cells: HashMap<Cell, Vec<usize>>,
    obstacles: &'a [Obstacle<'a>],
}

const BUCKET: f64 = 5.0;

fn bucket_range(lo: f64, hi: f64) -> std::ops::RangeInclusive<i64> {
    (lo / BUCKET).floor() as i64..=(hi / BUCKET).floor() as i64
}

impl<'a> Buckets<'a> {
    fn new(obstacles: &'a [Obstacle<'a>]) -> Self {
        let mut cells: HashMap<Cell, Vec<usize>> = HashMap::new();
        for (k, o) in obstacles.iter().enumerate() {
            let b = o.item.shape.grown_box(o.need + o.half_track);
            for i in bucket_range(b.x0, b.x1) {
                for j in bucket_range(b.y0, b.y1) {
                    cells.entry((i, j)).or_default().push(k);
                }
            }
        }
        Self { cells, obstacles }
    }

    fn legal(&self, path: &[Point]) -> bool {
        let mut seen = HashSet::new();
        for s in path.windows(2) {
            for i in bucket_range(s[0].0.min(s[1].0), s[0].0.max(s[1].0)) {
                for j in bucket_range(s[0].1.min(s[1].1), s[0].1.max(s[1].1)) {
                    seen.extend(self.cells.get(&(i, j)).into_iter().flatten().copied());
                }
            }
        }
        seen.iter().all(|&k| !is_violation(self.obstacles[k].margin(path)))
    }
}

/// Grid A* (8 directions, grid anchored at a) from a to any grid point with a legal straight, L or 45 finish to a
/// target. Each move is checked exactly against the obstacles near it.
fn maze(a: Point, targets: &[Point], obstacles: &[Obstacle]) -> Option<Vec<Point>> {
    const STEP: f64 = 0.5;
    const MARGIN: f64 = 30.0;
    const MAX_NODES: usize = 400_000;
    const DIRS: [Cell; 8] = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)];
    let buckets = Buckets::new(obstacles);
    let fold = |f: fn(f64, f64) -> f64, g: fn(&Point) -> f64| targets.iter().map(g).fold(g(&a), f);
    let lo = (fold(f64::min, |p| p.0) - MARGIN, fold(f64::min, |p| p.1) - MARGIN);
    let hi = (fold(f64::max, |p| p.0) + MARGIN, fold(f64::max, |p| p.1) + MARGIN);
    let at = |k: Cell| point6((a.0 + k.0 as f64 * STEP, a.1 + k.1 as f64 * STEP));
    let estimate = |k: Cell| targets.iter().map(|&t| distance(at(k), t)).fold(f64::INFINITY, f64::min);
    let mut best = HashMap::from([((0, 0), 0.0)]);
    let mut previous: HashMap<Cell, Cell> = HashMap::new();
    let mut heap = BinaryHeap::from([Open { estimate: estimate((0, 0)), cost: 0.0, cell: (0, 0), from: None }]);
    let mut seen = 0;
    while let Some(node) = heap.pop() {
        if seen >= MAX_NODES {
            break;
        }
        if node.cost > best.get(&node.cell).copied().unwrap_or(1e18) + 1e-12 {
            continue;
        }
        seen += 1;
        let p = at(node.cell);
        for t in targets {
            if let Some(finish) = simple_paths(p, *t).into_iter().find(|c| buckets.legal(c)) {
                let mut path = vec![p];
                let mut k = node.cell;
                while let Some(&back) = previous.get(&k) {
                    k = back;
                    path.push(at(k));
                }
                path.reverse();
                path.extend_from_slice(&finish[1..]);
                return Some(simplify(&path));
            }
        }
        for d in DIRS {
            let next = (node.cell.0 + d.0, node.cell.1 + d.1);
            let q = at(next);
            if !(lo.0 <= q.0 && q.0 <= hi.0 && lo.1 <= q.1 && q.1 <= hi.1) {
                continue;
            }
            let turn = if node.from.is_some_and(|f| f != d) { 0.5 } else { 0.0 };
            let cost = node.cost + STEP * hypot(d.0 as f64, d.1 as f64) + turn;
            if cost < best.get(&next).copied().unwrap_or(1e18) - 1e-12 && buckets.legal(&[p, q]) {
                best.insert(next, cost);
                previous.insert(next, node.cell);
                heap.push(Open { estimate: cost + estimate(next), cost, cell: next, from: Some(d) });
            }
        }
    }
    None
}

#[derive(Clone, Debug, Serialize)]
pub struct Blocker {
    #[serde(rename = "ref")]
    pub reference: String,
    pub net: String,
    pub shortfall_mm: f64,
}

/// A net with no legal path: the least bad candidate and its blockers, the worst first.
#[derive(Clone, Debug, Serialize)]
pub struct Fault {
    pub net: String,
    pub least_bad: Option<Vec<Point>>,
    pub blockers: Vec<Blocker>,
}

/// The least bad candidate so far.
struct LeastBad<'a> {
    worst: f64,
    path: Vec<Point>,
    blocked: Vec<(f64, &'a Item)>,
}

/// The first legal path between two pads, keeping the least bad illegal one.
fn first_legal<'a>(a: Point, b: Point, obstacles: &'a [Obstacle<'a>], least: &mut Option<LeastBad<'a>>) -> bool {
    let candidates = simple_paths(a, b).into_iter().chain(z_paths(a, b));
    for path in candidates {
        let path: Vec<Point> = path.into_iter().map(point6).collect();
        let blocked: Vec<(f64, &Item)> =
            obstacles.iter().map(|o| (o.margin(&path), o.item)).filter(|(m, _)| is_violation(*m)).collect();
        if blocked.is_empty() {
            return true;
        }
        let worst = blocked.iter().map(|b| b.0).fold(f64::INFINITY, f64::min);
        if least.as_ref().is_none_or(|l| worst > l.worst) {
            *least = Some(LeastBad { worst, path, blocked });
        }
    }
    false
}

fn fault_of(net: &str, least: LeastBad) -> Fault {
    let mut worst: BTreeMap<(String, String), f64> = BTreeMap::new();
    for (margin, o) in &least.blocked {
        let label = if o.net.is_empty() { &o.class } else { &o.net };
        let short = round_to(-margin, 3);
        let slot = worst.entry((o.reference.clone(), label.clone())).or_insert(0.0);
        *slot = f64::max(*slot, short);
    }
    let mut rows: Vec<_> = worst.into_iter().collect();
    rows.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let blockers = rows.into_iter().map(|((reference, net), shortfall_mm)| Blocker { reference, net, shortfall_mm });
    Fault { net: net.to_string(), least_bad: Some(least.path), blockers: blockers.collect() }
}

/// Which of the open pads joins first: the first with a legal path to a joined pad, else the shortest grid path.
fn next_join<'a>(done: &[&Item], todo: &[&Item], obstacles: &'a [Obstacle<'a>], least: &mut Option<LeastBad<'a>>) -> Option<usize> {
    for (i, pad) in todo.iter().enumerate() {
        if done.iter().any(|p| first_legal(p.centre(), pad.centre(), obstacles, least)) {
            return Some(i);
        }
    }
    let mut best: Option<(f64, usize)> = None;
    for (i, pad) in todo.iter().enumerate() {
        let mut from: Vec<&&Item> = done.iter().collect();
        from.sort_by(|a, b| distance(a.centre(), pad.centre()).total_cmp(&distance(b.centre(), pad.centre())));
        for p in from {
            if let Some(path) = maze(p.centre(), &[pad.centre()], obstacles) {
                if best.is_none_or(|b| length(&path) < b.0) {
                    best = Some((length(&path), i));
                }
            }
            if best.is_some() {
                break;
            }
        }
    }
    best.map(|b| b.1)
}

/// Join the pads of a net, nearest legal first. The joins do not depend on each other (own-net copper is no obstacle).
pub fn route_net<'a>(net: &str, pads: &[&'a Item], obstacles: &'a [Obstacle<'a>]) -> Option<Fault> {
    let (mut done, mut todo) = (vec![*pads.first()?], pads[1..].to_vec());
    while !todo.is_empty() {
        let mut least = None;
        match next_join(&done, &todo, obstacles, &mut least) {
            Some(i) => done.push(todo.remove(i)),
            None => return least.map(|l| fault_of(net, l)),
        }
    }
    None
}

struct PadItem {
    item: Item,
    smd: bool,
}

fn pad_items(pr: &Problem, pose: &[Place], members: &BTreeMap<(&str, &str), &str>) -> Vec<PadItem> {
    let mut pads = Vec::new();
    for (u, &(x, y, r)) in pr.units.iter().zip(pose) {
        for (q, meta) in u.cu.iter().zip(&u.cu_pads) {
            let b = q.rect.turned(r);
            let (cx, cy) = b.centre();
            let shape = Shape::Pad { c: (x + cx, y + cy), w: b.width(), h: b.height() };
            let reference = meta.reference.clone();
            let (net, class) = if meta.kind == "npth" {
                (String::new(), format!("{HOLE_CLASS}{reference}"))
            } else {
                net_and_class(pr, q.value, meta, members)
            };
            pads.push(PadItem { item: Item { reference, net, class, shape }, smd: meta.kind == "smd" });
        }
    }
    pads
}

fn net_and_class(pr: &Problem, code: f64, meta: &crate::problem::CuPad, members: &BTreeMap<(&str, &str), &str>) -> (String, String) {
    let named = pr.cu_nets.get(&(code as i64).to_string());
    let (name, class) = named.cloned().unwrap_or_else(|| (String::new(), "Default".to_string()));
    let member = meta.number.as_deref().and_then(|n| members.get(&(meta.reference.as_str(), n)));
    match member {
        Some(class) if name.is_empty() => (name, class.to_string()),
        _ => (name, class),
    }
}

fn edge_items(pr: &Problem) -> Vec<Item> {
    let ol = &pr.board.outline;
    let edge = |k: usize| Item {
        reference: "edge".to_string(),
        net: String::new(),
        class: EDGE_CLASS.to_string(),
        shape: Shape::Segment { a: ol[k], b: ol[(k + 1) % ol.len()] },
    };
    (0..ol.len()).map(edge).collect()
}

/// One net on one layer. None = no route is possible here (the layer lacks pads of the net).
fn net_on_layer<'a>(net: &str, class: &str, width: f64, gaps: &ClassGaps, items: &'a [&'a Item], all_pads: usize) -> Option<Option<Fault>> {
    let mine: Vec<&Item> = items.iter().copied().filter(|i| i.net == net).collect();
    if mine.len() < all_pads {
        return None;
    }
    let obstacle = |item: &'a &'a Item| Obstacle { item, half_track: width / 2.0, need: gaps.gap(class, &item.class) };
    let obstacles: Vec<Obstacle> = items.iter().filter(|i| i.net != net).map(obstacle).collect();
    Some(route_net(net, &mine, &obstacles))
}

/// Fault records of the nets with no legal path on any layer that holds all their pads. The record is the one of the
/// last layer tried.
pub fn faults(pr: &Problem, pose: &[Place], nets: &[String]) -> Vec<Fault> {
    let rules = pr.route_rules.as_ref().expect("checked before the search");
    let gaps = ClassGaps {
        dru: &rules.dru,
        clearance: rules.classes.iter().map(|(c, v)| (c.as_str(), v.0)).collect(),
        edge: pr.board.edge_clearance,
    };
    let member_of = rules.dru.members.iter().map(|(p, r, n)| ((r.as_str(), n.as_str()), p.as_str())).collect();
    let pads = pad_items(pr, pose, &member_of);
    let edges = edge_items(pr);
    let mut out = Vec::new();
    for net in nets {
        let mine: Vec<&Item> = pads.iter().map(|p| &p.item).filter(|i| &i.net == net).collect();
        let Some(first) = mine.first() else { continue };
        let width = |c: &str| rules.classes.get(c).or_else(|| rules.classes.get("Default")).map_or(0.2, |v| v.1);
        let mut outcome = None;
        for layer in LAYERS {
            let on_layer = pads.iter().filter(|p| layer == "F.Cu" || !p.smd).map(|p| &p.item);
            let items: Vec<&Item> = on_layer.chain(&edges).collect();
            if let Some(result) = net_on_layer(net, &first.class, width(&first.class), &gaps, &items, mine.len()) {
                let clear = result.is_none();
                outcome = Some(result);
                if clear {
                    break;
                }
            }
        }
        match outcome {
            None => out.push(Fault { net: net.clone(), least_bad: None, blockers: Vec::new() }),
            Some(Some(fault)) => out.push(fault),
            Some(None) => {}
        }
    }
    out
}

/// The nets of the .kicad_dru domain classes, sorted. A compound class belongs when any member does.
pub fn domain_nets(pr: &Problem) -> Vec<String> {
    let Some(rules) = &pr.route_rules else { return Vec::new() };
    let in_domain = |class: &str| {
        class.split(',').any(|m| rules.dru.domains.iter().any(|d| fnmatch(m.trim(), &d.0)))
    };
    let mut nets: Vec<String> = pr.cu_nets.values().filter(|(_, c)| in_domain(c)).map(|(n, _)| n.clone()).collect();
    nets.sort();
    nets
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pad(reference: &str, net: &str, c: Point) -> Item {
        Item { reference: reference.into(), net: net.into(), class: "Default".into(), shape: Shape::Pad { c, w: 1.0, h: 1.0 } }
    }

    fn obstacle(item: &Item) -> Obstacle<'_> {
        Obstacle { item, half_track: 0.1, need: 0.5 }
    }

    #[test]
    fn a_track_through_a_pad_has_no_distance() {
        let s = Shape::Pad { c: (5.0, 0.0), w: 1.0, h: 1.0 };
        assert_eq!(s.distance_to((0.0, 0.0), (10.0, 0.0)), 0.0);
        assert_eq!(s.distance_to((0.0, 2.0), (10.0, 2.0)), 1.5);
    }

    #[test]
    fn a_blocked_straight_path_takes_a_bend() {
        let wall = pad("W", "OTHER", (5.0, 0.0));
        let (a, b) = (pad("A", "N", (0.0, 0.0)), pad("B", "N", (10.0, 0.0)));
        let obstacles = [obstacle(&wall)];
        let mut least = None;
        assert!(first_legal(a.centre(), b.centre(), &obstacles, &mut least));
        assert!(route_net("N", &[&a, &b], &obstacles).is_none());
    }

    #[test]
    fn a_ring_around_a_pad_is_a_fault_with_its_blockers() {
        let walls: Vec<Item> = (0..16)
            .map(|k| {
                let a = k as f64 * std::f64::consts::TAU / 16.0;
                Item { shape: Shape::Pad { c: (4.0 * a.cos(), 4.0 * a.sin()), w: 2.0, h: 2.0 }, ..pad("W", "OTHER", (0.0, 0.0)) }
            })
            .collect();
        let (a, b) = (pad("A", "N", (0.0, 0.0)), pad("B", "N", (20.0, 0.0)));
        let obstacles: Vec<Obstacle> = walls.iter().map(obstacle).collect();
        let f = route_net("N", &[&a, &b], &obstacles).expect("the ring blocks every path");
        assert_eq!(f.net, "N");
        assert_eq!(f.blockers[0].reference, "W");
        assert!(f.blockers[0].shortfall_mm > 0.0);
    }

    #[test]
    fn hole_and_domain_gaps() {
        let dru = Rules {
            domains: vec![("MAINS*".into(), 8.0, 3.0)],
            holes: vec![("MAINS*".into(), vec!["H1".into()], 9.65)],
            ..Rules::default()
        };
        let gaps = ClassGaps { dru: &dru, clearance: BTreeMap::from([("Default", 0.2), ("MAINS_K1", 3.0)]), edge: 0.5 };
        assert_eq!(gaps.gap("MAINS_K1", "Default"), 8.0);
        assert_eq!(gaps.gap("MAINS_K1", "MAINS_K2"), 3.0);
        assert_eq!(gaps.gap("MAINS_K1", "HOLE:H1"), 9.65);
        assert_eq!(gaps.gap("MAINS_K1", "EDGE"), 0.5);
        assert_eq!(gaps.gap("Default,MAINS_K1", "Default"), 8.0);
    }
}
