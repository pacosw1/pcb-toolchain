//! Wire-length term: the sum of the Euclidean minimum spanning tree of the pad centres of each net (README
//! "Wire-length term"). Nets: the problem nets without cohesion and plane nets. Points: net.pts, else pin box centres.

use crate::geom::{Point, turn_point};
use crate::layout::Layout;
use crate::numeric::{compensated, hypot};
use crate::problem::{Net, Pin, Problem};
use std::collections::BTreeMap;

/// Euclidean MST length (Prim, O(n^2); nets have tens of pads at most).
pub fn mst_length(pts: &[Point]) -> f64 {
    let n = pts.len();
    if n < 2 {
        return 0.0;
    }
    let dist = |a: Point, b: Point| hypot(b.0 - a.0, b.1 - a.1);
    let mut best: Vec<f64> = pts.iter().map(|&p| dist(pts[0], p)).collect();
    let mut used = vec![false; n];
    used[0] = true;
    let mut total = 0.0;
    for _ in 1..n {
        let (j, d) = (0..n)
            .filter(|&k| !used[k])
            .fold((usize::MAX, f64::INFINITY), |acc, k| if best[k] < acc.1 { (k, best[k]) } else { acc });
        used[j] = true;
        total += d;
        for k in (0..n).filter(|&k| !used[k]) {
            best[k] = best[k].min(dist(pts[j], pts[k]));
        }
    }
    total
}

/// The local points of a pin.
pub fn pin_points(net: &Net, index: usize, pin: &Pin) -> Vec<Point> {
    match &net.pts {
        Some(pts) => pts[index].clone(),
        None => vec![pin.rect.centre()],
    }
}

/// Local points per turn of each pin of a net.
struct NetPoints {
    pins: Vec<(usize, [Vec<Point>; 4])>,
}

impl NetPoints {
    fn value(&self, at: &Layout) -> f64 {
        let world = self.pins.iter().flat_map(|(u, turns)| {
            turns[at.r[*u] as usize].iter().map(|p| (p.0 + at.x[*u], p.1 + at.y[*u]))
        });
        mst_length(&world.collect::<Vec<_>>())
    }
}

/// The nets in the term.
pub struct WirelenModel {
    nets: BTreeMap<usize, NetPoints>,
}

impl WirelenModel {
    pub fn new(pr: &Problem) -> Self {
        let planes = pr.plane_nets.as_deref().unwrap_or(&[]);
        let mut nets = BTreeMap::new();
        for (k, net) in pr.nets.iter().enumerate().filter(|(_, n)| !n.cohesion && !planes.contains(&n.name)) {
            let turned = |i: usize, q: &Pin| {
                let local = pin_points(net, i, q);
                (q.unit, [0, 1, 2, 3].map(|r| local.iter().map(|&p| turn_point(p, r)).collect()))
            };
            let pins: Vec<_> = net.pins.iter().enumerate().map(|(i, q)| turned(i, q)).collect();
            if pins.iter().map(|p: &(usize, [Vec<Point>; 4])| p.1[0].len()).sum::<usize>() >= 2 {
                nets.insert(k, NetPoints { pins });
            }
        }
        Self { nets }
    }
}

/// MST length per net of the current layout.
pub struct WirelenState {
    pub values: BTreeMap<usize, f64>,
    undo: Vec<(usize, f64)>,
}

impl WirelenState {
    pub fn new(model: &WirelenModel, at: &Layout) -> Self {
        Self { values: model.nets.iter().map(|(k, n)| (*k, n.value(at))).collect(), undo: Vec::new() }
    }

    pub fn total(&self) -> f64 {
        compensated(self.values.values().copied())
    }

    /// Update the given nets after a move. Returns the change of the total.
    pub fn after_move(&mut self, model: &WirelenModel, at: &Layout, nets: &[usize]) -> f64 {
        self.undo.clear();
        let mut delta = 0.0;
        for k in nets {
            if let Some(net) = model.nets.get(k) {
                let v = net.value(at);
                let old = self.values.insert(*k, v).expect("a term net has a value");
                self.undo.push((*k, old));
                delta += v - old;
            }
        }
        delta
    }

    pub fn revert(&mut self) {
        for &(k, v) in &self.undo {
            self.values.insert(k, v);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::mst_length;

    #[test]
    fn spanning_tree_of_an_l() {
        assert_eq!(mst_length(&[(0.0, 0.0), (3.0, 0.0), (3.0, 4.0)]), 7.0);
        assert_eq!(mst_length(&[(1.0, 1.0)]), 0.0);
        assert_eq!(mst_length(&[]), 0.0);
    }

    #[test]
    fn a_star_uses_the_centre_point() {
        let pts = [(0.0, 0.0), (2.0, 0.0), (0.0, 2.0), (-2.0, 0.0), (0.0, -2.0)];
        assert_eq!(mst_length(&pts), 8.0);
    }
}
