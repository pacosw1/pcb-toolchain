//! Proof benchmarks: seeded scrambled placements, Spearman rank correlation.

use crate::numeric::PyRandom;
use crate::problem::{Pose, Problem, Unit};

fn unit_radius(u: &Unit) -> f64 {
    let corner = |r: &crate::geom::TaggedRect| [r.rect.x0, r.rect.y0, r.rect.x1, r.rect.y1].map(f64::abs).into_iter().fold(0.0, f64::max);
    u.rects.iter().map(corner).fold(0.0, f64::max)
}

/// Seeded pose: fixed units stay; movable units move by a normal step of `sigma` mm from their place (no sigma: uniform
/// over the board with a random turn), clipped so the unit stays inside the edge clearance. The result is not legal.
pub fn scramble(pr: &Problem, seed: u64, sigma: Option<f64>) -> Pose {
    let mut rng = PyRandom::new(seed);
    let outline = pr.board.outline_box();
    let e = pr.board.edge_clearance;
    let area = pr.move_box.unwrap_or(outline);
    let place = |u: &Unit, rng: &mut PyRandom| {
        if u.fixed {
            return u.place();
        }
        let rad = unit_radius(u);
        let (lo_x, hi_x) = (area.x0.max(outline.x0 + e + rad), area.x1.min(outline.x1 - e - rad));
        let (lo_y, hi_y) = (area.y0.max(outline.y0 + e + rad), area.y1.min(outline.y1 - e - rad));
        let (x, y, r) = match sigma {
            None => (rng.uniform(lo_x, hi_x), rng.uniform(lo_y, hi_y), rng.below(4) as u8),
            Some(s) => (u.x + rng.gauss(0.0, s), u.y + rng.gauss(0.0, s), 0),
        };
        (x.max(lo_x).min(hi_x), y.max(lo_y).min(hi_y), r)
    };
    pr.units.iter().map(|u| place(u, &mut rng)).collect()
}

fn ranks(v: &[f64]) -> Vec<f64> {
    let mut order: Vec<usize> = (0..v.len()).collect();
    order.sort_by(|&a, &b| v[a].total_cmp(&v[b]));
    let mut r = vec![0.0; v.len()];
    let mut i = 0;
    while i < order.len() {
        let same = order[i..].iter().take_while(|&&k| v[k] == v[order[i]]).count();
        let j = i + same - 1;
        order[i..=j].iter().for_each(|&k| r[k] = (i + j) as f64 / 2.0 + 1.0);
        i = j + 1;
    }
    r
}

/// Pearson correlation of the ranks (ties get the average rank).
pub fn spearman(xs: &[f64], ys: &[f64]) -> f64 {
    let (a, b) = (ranks(xs), ranks(ys));
    let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
    let (ma, mb) = (mean(&a), mean(&b));
    let cov: f64 = a.iter().zip(&b).map(|(x, y)| (x - ma) * (y - mb)).sum();
    let spread = |v: &[f64], m: f64| v.iter().map(|x| (x - m) * (x - m)).sum::<f64>().sqrt();
    cov / (spread(&a, ma) * spread(&b, mb))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spearman_of_order_and_reverse() {
        assert!((spearman(&[1.0, 2.0, 3.0], &[10.0, 20.0, 30.0]) - 1.0).abs() < 1e-12);
        assert!((spearman(&[1.0, 2.0, 3.0], &[3.0, 2.0, 1.0]) + 1.0).abs() < 1e-12);
    }

    #[test]
    fn ties_share_the_average_rank() {
        assert_eq!(ranks(&[1.0, 1.0, 2.0]), vec![1.5, 1.5, 3.0]);
    }
}
