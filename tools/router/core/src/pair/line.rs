//! Polylines: cleaning a grid path and offsetting it into the two tracks of a pair.
use super::Point;
use super::lattice::Cell;
use crate::grid::astar::exact_hypot;

fn cross(a: Point, b: Point, c: Point) -> f64 {
    (b.0 - a.0) * (c.1 - b.1) - (b.1 - a.1) * (c.0 - b.0)
}

fn distance(a: Point, b: Point) -> f64 {
    exact_hypot(b.0 - a.0, b.1 - a.1)
}

/// Keeps the cells where the path turns, and both ends.
pub fn turns(path: &[Cell]) -> Vec<Cell> {
    let mut out = vec![path[0]];
    for k in 1..path.len().saturating_sub(1) {
        let (a, b, c) = (out[out.len() - 1], path[k], path[k + 1]);
        if (b.0 - a.0) * (c.1 - b.1) - (b.1 - a.1) * (c.0 - b.0) != 0 {
            out.push(b);
        }
    }
    out.push(path[path.len() - 1]);
    out
}

/// Drops collinear points.
pub fn without_collinear(line: &[Point]) -> Vec<Point> {
    let mut out = vec![line[0]];
    for k in 1..line.len().saturating_sub(1) {
        if cross(out[out.len() - 1], line[k], line[k + 1]).abs() > 1e-6 {
            out.push(line[k]);
        }
    }
    out.push(line[line.len() - 1]);
    out
}

/// Drops points that make a segment shorter than `least` (the grid snap next to a lead-in): their mitred offsets pinch P and N (ETH_TX
/// at J201, 2026-10-26: gap 0.134 mm). The ends stay.
pub fn without_short(line: &[Point], least: f64) -> Vec<Point> {
    let mut kept = vec![line[0]];
    for (k, &point) in line.iter().enumerate().skip(1) {
        let short = distance(kept[kept.len() - 1], point) < least;
        let last = k == line.len() - 1;
        if short && !last {
            continue;
        }
        if short && last && kept.len() > 1 {
            kept.pop();
        }
        kept.push(point);
    }
    kept
}

/// The unit normal to the left of a segment.
fn normal(a: Point, b: Point) -> Point {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let n = exact_hypot(dx, dy);
    (-dy / n, dx / n)
}

/// The polyline offset by `d` to the left, with mitred corners.
pub fn offset(line: &[Point], d: f64) -> Vec<Point> {
    let last = line.len() - 1;
    line.iter().enumerate().map(|(k, &(x, y))| {
        if k == 0 || k == last {
            let n = if k == 0 { normal(line[0], line[1]) } else { normal(line[last - 1], line[last]) };
            return (x + n.0 * d, y + n.1 * d);
        }
        let (a, b) = (normal(line[k - 1], line[k]), normal(line[k], line[k + 1]));
        let (bx, by) = (a.0 + b.0, a.1 + b.1);
        let length = exact_hypot(bx, by);
        let (bx, by) = (bx / length, by / length);
        let cos_half = bx * a.0 + by * a.1;
        (x + bx * d / cos_half, y + by * d / cos_half)
    }).collect()
}

pub fn length(line: &[Point]) -> f64 {
    line.windows(2).map(|w| distance(w[0], w[1])).sum()
}
