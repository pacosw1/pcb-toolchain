//! Row term: repeated blocks out of a common row or column, or at an unequal pitch.

use crate::geom::Point;
use crate::layout::Layout;
use crate::numeric::{compensated, median};
use crate::problem::{Problem, Unit};
use std::collections::BTreeMap;

/// mm: rect sizes of one block kind may differ by this much (footprint rounding).
const SIZE_TOLERANCE: f64 = 0.2;

struct Signature {
    parts: usize,
    pads: usize,
    sizes: Vec<Point>,
}

impl Signature {
    fn new(u: &Unit) -> Self {
        let mut sizes: Vec<Point> = u.rects.iter().map(|r| (r.rect.width(), r.rect.height())).collect();
        sizes.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
        Self { parts: u.refs.len(), pads: u.pads.len(), sizes }
    }

    fn same_kind(&self, o: &Self) -> bool {
        let close = |a: &Point, b: &Point| (a.0 - b.0).abs() <= SIZE_TOLERANCE && (a.1 - b.1).abs() <= SIZE_TOLERANCE;
        self.parts == o.parts
            && self.pads == o.pads
            && self.sizes.len() == o.sizes.len()
            && self.sizes.iter().zip(&o.sizes).all(|(a, b)| close(a, b))
    }
}

/// Repeated blocks: movable units of 2 or more parts of one kind; groups of 2 or more (unit indices).
pub fn row_groups(pr: &Problem) -> Vec<Vec<usize>> {
    let mut groups: Vec<(Signature, Vec<usize>)> = Vec::new();
    for (i, u) in pr.units.iter().enumerate().filter(|(_, u)| !u.fixed && u.refs.len() >= 2) {
        let sig = Signature::new(u);
        match groups.iter_mut().find(|(s, _)| s.same_kind(&sig)) {
            Some((_, members)) => members.push(i),
            None => groups.push((sig, vec![i])),
        }
    }
    groups.into_iter().map(|(_, g)| g).filter(|g| g.len() >= 2).collect()
}

fn deviation(values: &[f64]) -> f64 {
    let m = median(values);
    compensated(values.iter().map(|a| (a - m).abs()))
}

/// Row term of one group: sum |minor coordinate - median| on the axis with the smaller spread, + pitch * sum
/// |gap - mean gap| along the other axis.
pub fn row_cost(points: &[Point], pitch: f64) -> f64 {
    let xs: Vec<f64> = points.iter().map(|p| p.0).collect();
    let ys: Vec<f64> = points.iter().map(|p| p.1).collect();
    let (dx, dy) = (deviation(&xs), deviation(&ys));
    let (minor, mut major) = if dy <= dx { (dy, xs) } else { (dx, ys) };
    major.sort_by(f64::total_cmp);
    let gaps: Vec<f64> = major.windows(2).map(|w| w[1] - w[0]).collect();
    let mean = compensated(gaps.iter().copied()) / gaps.len() as f64;
    minor + pitch * compensated(gaps.iter().map(|g| (g - mean).abs()))
}

/// Row cost per group of the current layout.
pub struct RowState {
    groups: Vec<Vec<usize>>,
    group_of: BTreeMap<usize, usize>,
    values: Vec<f64>,
    pitch: f64,
    undo: Vec<(usize, f64)>,
}

impl RowState {
    /// `groups`: empty when the term has weight 0.
    pub fn new(groups: Vec<Vec<usize>>, pitch: f64, at: &Layout) -> Self {
        let group_of = groups.iter().enumerate().flat_map(|(k, g)| g.iter().map(move |&i| (i, k))).collect();
        let mut s = Self { groups, group_of, values: Vec::new(), pitch, undo: Vec::new() };
        s.values = (0..s.groups.len()).map(|k| s.cost(k, at)).collect();
        s
    }

    fn cost(&self, k: usize, at: &Layout) -> f64 {
        let points: Vec<Point> = self.groups[k].iter().map(|&i| (at.x[i], at.y[i])).collect();
        row_cost(&points, self.pitch)
    }

    pub fn total(&self) -> f64 {
        compensated(self.values.iter().copied())
    }

    /// Update the groups of the moved units. Returns the change of the total.
    pub fn after_move(&mut self, at: &Layout, moved: &[usize]) -> f64 {
        self.undo.clear();
        let mut touched: Vec<usize> = moved.iter().filter_map(|i| self.group_of.get(i).copied()).collect();
        touched.sort_unstable();
        touched.dedup();
        let mut delta = 0.0;
        for k in touched {
            let v = self.cost(k, at);
            self.undo.push((k, self.values[k]));
            delta += v - self.values[k];
            self.values[k] = v;
        }
        delta
    }

    pub fn revert(&mut self) {
        for &(k, v) in &self.undo {
            self.values[k] = v;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::row_cost;

    #[test]
    fn a_block_out_of_its_row_costs_its_offset() {
        let row = [(0.0, 0.0), (10.0, 0.0), (20.0, 8.0), (30.0, 0.0)];
        assert_eq!(row_cost(&row, 1.0), 8.0);
    }

    #[test]
    fn unequal_pitch_costs_the_gap_spread() {
        assert_eq!(row_cost(&[(0.0, 0.0), (10.0, 0.0), (30.0, 0.0)], 1.0), 10.0);
        assert_eq!(row_cost(&[(0.0, 0.0), (10.0, 0.0), (30.0, 0.0)], 0.0), 0.0);
    }
}
