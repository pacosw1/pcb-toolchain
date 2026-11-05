//! The return detour of a run: the shortest path in the reference copper between its terminals, on a grid.
use super::sample::{P, Terminal};
use crate::si::py::{dist, hypot};
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};

const DIAGONAL: f64 = std::f64::consts::SQRT_2;

fn grid(v: f64, cell: f64) -> i64 {
    (v / cell).round_ties_even() as i64
}

/// A heap entry: priority, distance so far and the cell, ordered as a tuple.
#[derive(PartialEq)]
struct Open<C> {
    f: f64,
    d: f64,
    cell: C,
}

impl<C: PartialEq> Eq for Open<C> {}

impl<C: Ord> Ord for Open<C> {
    fn cmp(&self, o: &Self) -> std::cmp::Ordering {
        self.f.total_cmp(&o.f).then(self.d.total_cmp(&o.d)).then_with(|| self.cell.cmp(&o.cell))
    }
}

impl<C: Ord> PartialOrd for Open<C> {
    fn partial_cmp(&self, o: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(o))
    }
}

type Cell2 = (i64, i64);

/// The cells around a terminal it can be reached at, each with its distance in cells.
fn terminal_cells(t: &Terminal, cell: f64) -> Vec<(Cell2, f64)> {
    let r = t.snap.max(cell);
    let n = (r / cell).ceil() as i64;
    let (cx, cy) = (grid(t.x, cell), grid(t.y, cell));
    let mut out = Vec::new();
    for i in -n..=n {
        for j in -n..=n {
            let d = dist(((cx + i) as f64 * cell, (cy + j) as f64 * cell), t.at());
            if d <= r + 1e-9 {
                out.push(((cx + i, cy + j), d));
            }
        }
    }
    out
}

/// D-124c detour of one run (the accepted grid search). `ok` says reference copper. Portals are the domain ground vias and
/// through-hole pads; the path between two of them counts as the straight line. None: over budget or unreachable. Fewer than two
/// terminals is a stub, no crossing: 0.
pub fn d124c_detour_mm(ok: &dyn Fn(f64, f64) -> bool, terminals: &[Terminal], budget: f64, cell: f64, portals: &[P]) -> Option<f64> {
    if terminals.len() < 2 {
        return Some(0.0);
    }
    let mut known: HashMap<Cell2, bool> = HashMap::new();
    let mut free = |c: Cell2| *known.entry(c).or_insert_with(|| ok(c.0 as f64 * cell, c.1 as f64 * cell));
    let src: Vec<Cell2> = terminal_cells(&terminals[0], cell).into_iter().map(|(c, _)| c).filter(|c| free(*c)).collect();
    if src.is_empty() {
        return None;
    }
    let around = |q: Cell2| (-1..=1).flat_map(move |i| (-1..=1).map(move |j| (q.0 + i, q.1 + j)));
    let ports: Vec<Cell2> = portals.iter().map(|p| (grid(p.0, cell), grid(p.1, cell))).filter(|q| free(*q) || around(*q).any(&mut free)).collect();
    let at_port: HashSet<Cell2> = ports.iter().flat_map(|q| around(*q)).collect();
    let mut worst: f64 = 0.0;
    for t in &terminals[1..] {
        let dst: HashSet<Cell2> = terminal_cells(t, cell).into_iter().map(|(c, _)| c).filter(|c| free(*c)).collect();
        if dst.is_empty() {
            return None;
        }
        if src.iter().any(|c| dst.contains(c)) {
            continue;
        }
        let (tx, ty, tr) = (t.x / cell, t.y / cell, t.snap.max(cell) / cell);
        let h = |c: Cell2| (hypot(c.0 as f64 - tx, c.1 as f64 - ty) - tr - 1.0).max(0.0);
        let mut best: HashMap<Cell2, f64> = src.iter().map(|c| (*c, 0.0)).collect();
        let mut heap: BinaryHeap<Reverse<Open<Cell2>>> = src.iter().map(|&c| Reverse(Open { f: h(c), d: 0.0, cell: c })).collect();
        let mut found = None;
        while let Some(Reverse(Open { f, d, cell: c })) = heap.pop() {
            if d > best.get(&c).copied().unwrap_or(f64::INFINITY) + 1e-12 {
                continue;
            }
            if dst.contains(&c) {
                found = Some(d);
                break;
            }
            if f * cell > budget + 1e-9 {
                break;
            }
            for dx in -1..=1 {
                for dy in -1..=1 {
                    if dx == 0 && dy == 0 {
                        continue;
                    }
                    let n = (c.0 + dx, c.1 + dy);
                    let nd = d + if dx != 0 && dy != 0 { DIAGONAL } else { 1.0 };
                    if nd >= best.get(&n).copied().unwrap_or(f64::INFINITY) - 1e-12 {
                        continue; // free() is pure: test the distance first
                    }
                    if !free(n) || (dx != 0 && dy != 0 && !(free((c.0 + dx, c.1)) && free((c.0, c.1 + dy)))) {
                        continue;
                    }
                    best.insert(n, nd);
                    heap.push(Reverse(Open { f: nd + h(n), d: nd, cell: n }));
                }
            }
            if at_port.contains(&c) {
                // down a ground via, along the solid plane, up another
                for q in &ports {
                    for n in around(*q) {
                        let nd = d + hypot((c.0 - n.0) as f64, (c.1 - n.1) as f64);
                        if nd < best.get(&n).copied().unwrap_or(f64::INFINITY) - 1e-12 && nd * cell <= budget + 1e-9 && free(n) {
                            best.insert(n, nd);
                            heap.push(Reverse(Open { f: nd + h(n), d: nd, cell: n }));
                        }
                    }
                }
            }
        }
        match found {
            Some(d) if d * cell <= budget + 1e-9 => worst = worst.max(d * cell),
            _ => return None,
        }
    }
    Some(worst)
}

/// One reference plane: point and continuous-edge tests.
#[derive(Clone, Copy)]
pub struct Plane<'a> {
    pub ok: &'a dyn Fn(f64, f64) -> bool,
    pub edge: &'a dyn Fn(P, P) -> bool,
}

type Cell3 = (u8, i64, i64);

struct Search<'a> {
    planes: [Option<Plane<'a>>; 2],
    cell: f64,
    known: HashMap<Cell3, bool>,
}

impl Search<'_> {
    fn plane(&self, layer: u8) -> Plane<'_> {
        self.planes[layer as usize].expect("a layer of the search has a plane")
    }

    fn free(&mut self, c: Cell3) -> bool {
        if let Some(&v) = self.known.get(&c) {
            return v;
        }
        let v = (self.plane(c.0).ok)(c.1 as f64 * self.cell, c.2 as f64 * self.cell);
        self.known.insert(c, v);
        v
    }

    fn at(&self, c: Cell3) -> P {
        (c.1 as f64 * self.cell, c.2 as f64 * self.cell)
    }

    /// The cells a terminal is reached at, with continuous access, each with its distance in cells.
    fn terminal(&mut self, t: &Terminal) -> HashMap<Cell3, f64> {
        let mut out = HashMap::new();
        for ((x, y), d) in terminal_cells(t, self.cell) {
            let c = (0, x, y);
            if self.free(c) && (self.plane(0).edge)(t.at(), self.at(c)) {
                out.insert(c, d / self.cell);
            }
        }
        out
    }
}

/// D-124d detour (report-only): the shortest path in reference copper from the first terminal to the farthest other terminal, with
/// continuous edges, 8 neighbours. Portals are exact positions of ground vias and through-hole pads spanning both layers; a transfer
/// needs real copper on the alternate plane and continuous edges, and plane-cut checks alone cannot prove the absence of holes or
/// slots. Missing alternate geometry disables transfers, never invents copper. None: unreachable or over budget, or fewer than two
/// terminals: missing terminals are not proof of a stub.
pub fn detour_mm(plane: Plane, alternate: Option<Plane>, terminals: &[Terminal], budget: f64, cell: f64, portals: &[P]) -> Option<f64> {
    if terminals.len() < 2 {
        return None;
    }
    let mut s = Search { planes: [Some(plane), alternate], cell, known: HashMap::new() };
    let src = s.terminal(&terminals[0]);
    if src.is_empty() {
        return None;
    }
    let ports: Vec<P> = alternate.map_or(Vec::new(), |alt| portals.iter().copied().filter(|p| (plane.ok)(p.0, p.1) && (alt.ok)(p.0, p.1)).collect());
    let mut at_port: HashMap<Cell2, Vec<usize>> = HashMap::new();
    for (k, q) in ports.iter().enumerate() {
        let (x, y) = (grid(q.0, cell), grid(q.1, cell));
        for i in -1..=1 {
            for j in -1..=1 {
                at_port.entry((x + i, y + j)).or_default().push(k);
            }
        }
    }
    let mut worst: f64 = 0.0;
    for t in &terminals[1..] {
        let dst = s.terminal(t);
        if dst.is_empty() {
            return None;
        }
        let found = shortest(&mut s, &src, &dst, t, budget, &ports, &at_port);
        match found {
            Some(d) if d * cell <= budget + 1e-9 => worst = worst.max(d * cell),
            _ => return None,
        }
    }
    Some(worst)
}

fn shortest(s: &mut Search, src: &HashMap<Cell3, f64>, dst: &HashMap<Cell3, f64>, t: &Terminal, budget: f64, ports: &[P], at_port: &HashMap<Cell2, Vec<usize>>) -> Option<f64> {
    let cell = s.cell;
    let (tx, ty) = (t.x / cell, t.y / cell);
    let h = |c: Cell3| hypot(c.1 as f64 - tx, c.2 as f64 - ty);
    let mut best = src.clone();
    let mut heap: BinaryHeap<Reverse<Open<Cell3>>> = src.iter().map(|(&c, &d)| Reverse(Open { f: d + h(c), d, cell: c })).collect();
    let mut found: Option<f64> = None;
    while let Some(Reverse(Open { f, d, cell: c })) = heap.pop() {
        if d > best.get(&c).copied().unwrap_or(f64::INFINITY) + 1e-12 {
            continue;
        }
        if found.is_some_and(|v| f >= v - 1e-12) || f * cell > budget + 1e-9 {
            break;
        }
        if let Some(rest) = dst.get(&c) {
            found = Some(found.unwrap_or(f64::INFINITY).min(d + rest));
        }
        for dx in -1..=1 {
            for dy in -1..=1 {
                if dx == 0 && dy == 0 {
                    continue;
                }
                let n = (c.0, c.1 + dx, c.2 + dy);
                let nd = d + if dx != 0 && dy != 0 { DIAGONAL } else { 1.0 };
                if nd >= best.get(&n).copied().unwrap_or(f64::INFINITY) - 1e-12 {
                    continue;
                }
                if !s.free(n) || !(s.plane(c.0).edge)(s.at(c), s.at(n)) {
                    continue;
                }
                best.insert(n, nd);
                heap.push(Reverse(Open { f: nd + h(n), d: nd, cell: n }));
            }
        }
        // One layered graph, not O(portals**2) independent searches.
        for &k in at_port.get(&(c.1, c.2)).map_or(&[][..], Vec::as_slice) {
            let (start, q) = (s.at(c), ports[k]);
            if !(s.plane(c.0).edge)(start, q) {
                continue;
            }
            let other = 1 - c.0;
            let (qx, qy) = (grid(q.0, cell), grid(q.1, cell));
            for i in -1..=1 {
                for j in -1..=1 {
                    let n = (other, qx + i, qy + j);
                    let end = s.at(n);
                    let nd = d + (dist(start, q) + dist(q, end)) / cell;
                    if nd < best.get(&n).copied().unwrap_or(f64::INFINITY) - 1e-12 && nd * cell <= budget + 1e-9 && s.free(n) && (s.plane(other).edge)(q, end) {
                        best.insert(n, nd);
                        heap.push(Reverse(Open { f: nd + h(n), d: nd, cell: n }));
                    }
                }
            }
        }
    }
    found
}
