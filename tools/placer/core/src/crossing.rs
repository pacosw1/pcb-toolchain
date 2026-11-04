//! Smooth count of net crossings: the star model of each net (a segment from each pin centre to the mean of the pin
//! centres), and the Cypress bump of the crossing parameters of two segments of different nets.

use crate::geom::{EPS, Point};
use crate::layout::Layout;
use crate::model::Model;
use crate::numeric::{compensated, pairwise};
use std::ops::Range;

/// 1 - 2x^2 for |x| <= 0.5, 2 (1 - |x|)^2 for |x| <= 1, else 0.
fn bump(x: f64) -> f64 {
    let a = x.abs();
    if a <= 0.5 {
        1.0 - 2.0 * a * a
    } else if a <= 1.0 {
        2.0 * (1.0 - a) * (1.0 - a)
    } else {
        0.0
    }
}

#[derive(Clone, Copy)]
struct Segment {
    from: Point,
    to: Point,
    net: usize,
}

fn crossing(a: &Segment, b: &Segment) -> f64 {
    let r = (a.to.0 - a.from.0, a.to.1 - a.from.1);
    let s = (b.to.0 - b.from.0, b.to.1 - b.from.1);
    let q = (b.from.0 - a.from.0, b.from.1 - a.from.1);
    let den = r.0 * s.1 - r.1 * s.0;
    if den.abs() <= EPS || a.net == b.net {
        return 0.0;
    }
    let t = (q.0 * s.1 - q.1 * s.0) / den;
    let u = (q.0 * r.1 - q.1 * r.0) / den;
    bump(t - 0.5) * bump(u - 0.5)
}

/// Star segments of net k at the layout.
fn star(model: &Model, at: &Layout, k: usize) -> Vec<Segment> {
    let pins = &model.nets[k].pins;
    let centres: Vec<Point> = pins
        .iter()
        .map(|(u, turns)| {
            let (x, y) = turns[at.r[*u] as usize].centre();
            (x + at.x[*u], y + at.y[*u])
        })
        .collect();
    let n = centres.len() as f64;
    let to = (compensated(centres.iter().map(|p| p.0)) / n, compensated(centres.iter().map(|p| p.1)) / n);
    centres.into_iter().map(|from| Segment { from, to, net: k }).collect()
}

/// All star segments, contiguous per net. Empty at weight 0.
pub struct CrossState {
    segments: Vec<Segment>,
    /// Segment range of each net.
    ranges: Vec<Range<usize>>,
    undo: Vec<(usize, Segment)>,
}

impl CrossState {
    pub fn new(model: &Model, at: &Layout) -> Self {
        let mut s = Self { segments: Vec::new(), ranges: Vec::new(), undo: Vec::new() };
        if model.params.w_x != 0.0 {
            for k in 0..model.nets.len() {
                let start = s.segments.len();
                s.segments.extend(star(model, at, k));
                s.ranges.push(start..s.segments.len());
            }
        }
        s
    }

    pub fn total(&self) -> f64 {
        let cells: Vec<f64> = self.segments.iter().flat_map(|a| self.segments.iter().map(move |b| crossing(a, b))).collect();
        pairwise(&cells) / 2.0
    }

    /// Crossings of the segments `part` with all segments, pairs inside `part` counted once.
    fn part(&self, part: &[usize]) -> f64 {
        let row = |&i: &usize| self.segments.iter().map(move |b| crossing(&self.segments[i], b));
        let all: Vec<f64> = part.iter().flat_map(row).collect();
        let inner: Vec<f64> = part
            .iter()
            .flat_map(|&j| part.iter().map(move |&i| crossing(&self.segments[i], &self.segments[j])))
            .collect();
        pairwise(&all) - 0.5 * pairwise(&inner)
    }

    /// Update the stars of the given nets after a move. Returns the change of the total.
    pub fn after_move(&mut self, model: &Model, at: &Layout, nets: &[usize]) -> f64 {
        self.undo.clear();
        if self.segments.is_empty() || nets.is_empty() {
            return 0.0;
        }
        let part: Vec<usize> = nets.iter().flat_map(|&k| self.ranges[k].clone()).collect();
        let before = self.part(&part);
        self.undo.extend(part.iter().map(|&i| (i, self.segments[i])));
        for &k in nets {
            let start = self.ranges[k].start;
            for (n, seg) in star(model, at, k).into_iter().enumerate() {
                self.segments[start + n] = seg;
            }
        }
        self.part(&part) - before
    }

    pub fn revert(&mut self) {
        for &(i, seg) in &self.undo {
            self.segments[i] = seg;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bump_shape() {
        assert_eq!(bump(0.0), 1.0);
        assert_eq!(bump(0.5), 0.5);
        assert_eq!(bump(1.0), 0.0);
        assert_eq!(bump(1.5), 0.0);
    }

    #[test]
    fn two_centre_crossing_segments_count_one() {
        let a = Segment { from: (0.0, 0.0), to: (2.0, 2.0), net: 0 };
        let b = Segment { from: (0.0, 2.0), to: (2.0, 0.0), net: 1 };
        assert_eq!(crossing(&a, &b), 1.0);
        assert_eq!(crossing(&a, &Segment { net: 0, ..b }), 0.0);
    }
}
