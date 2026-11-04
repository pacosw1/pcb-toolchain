//! Graphic items and arcs, with the arc arithmetic of KiCad's EDA_SHAPE: KiCad gives an arc by three points and works from a
//! centre it rounds itself, so the same three points must give the same centre here.
use super::geom::{Iu, Pt, ki_round};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Geometry {
    Segment { start: Pt, end: Pt },
    Rect { top_left: Pt, bottom_right: Pt },
    Circle { center: Pt, radius_point: Pt },
    Arc(Arc),
    /// One closed ring per polygon.
    Poly { rings: Vec<Vec<Pt>> },
    /// Beziers and ellipses: no tool reads their points.
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Graphic {
    pub geometry: Geometry,
    pub layer: String,
    pub width: Iu,
    pub filled: bool,
}

/// An arc as KiCad keeps it: `center` is KiCad's rounded centre, and start to end runs in its direction of increasing angle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Arc {
    pub start: Pt,
    pub end: Pt,
    pub center: Pt,
}

/// EDA_SHAPE::GetRadius.
pub fn radius(center: Pt, on_circle: Pt) -> Iu {
    let (dx, dy) = ((on_circle.x - center.x) as f64, (on_circle.y - center.y) as f64);
    ki_round(dx.hypot(dy)).max(1)
}

/// The angle of a vector in degrees, with EDA_ANGLE's exact cases.
fn vector_angle(v: Pt) -> f64 {
    match (v.x, v.y) {
        (0, 0) => 0.0,
        (x, 0) => if x >= 0 { 0.0 } else { -180.0 },
        (0, y) => if y >= 0 { 90.0 } else { -90.0 },
        (x, y) if x == y => if x >= 0 { 45.0 } else { -135.0 },
        (x, y) if x == -y => if x >= 0 { -45.0 } else { 135.0 },
        (x, y) => (y as f64).atan2(x as f64).to_degrees(),
    }
}

impl Arc {
    /// The arc through three points, as EDA_SHAPE::SetArcGeometry: when the winding is against KiCad's, the ends swap.
    pub fn through(start: Pt, mid: Pt, end: Pt) -> Arc {
        let center = arc_center(start, mid, end);
        let arc = Arc { start, end, center };
        let computed_mid = (start - center).rotated(-arc.sweep() / 2.0) + center;
        if norm2(computed_mid - mid) > norm2(computed_mid - center) { Arc { start: end, end: start, center } } else { arc }
    }

    pub fn radius(&self) -> Iu {
        radius(self.center, self.start)
    }

    /// The angle of the start point about the centre, in degrees.
    pub fn start_angle(&self) -> f64 {
        vector_angle(self.start - self.center)
    }

    /// The included angle in degrees, as EDA_SHAPE::GetArcAngle.
    pub fn sweep(&self) -> f64 {
        let start = vector_angle(self.start - self.center);
        let mut end = vector_angle(self.end - self.center);
        if end == start {
            end = start + 360.0;
        }
        while end < start {
            end += 360.0;
        }
        end - start
    }
}

fn norm2(p: Pt) -> f64 {
    let (x, y) = (p.x as f64, p.y as f64);
    x * x + y * y
}

/// KiCad's CalcArcCenter on whole nanometres. It rounds to 100 nm or 10 nm when the propagated rounding error of the inputs
/// allows that.
fn arc_center(start: Pt, mid: Pt, end: Pt) -> Pt {
    let (sx, sy, mx, my, ex, ey) = (start.x as f64, start.y as f64, mid.x as f64, mid.y as f64, end.x as f64, end.y as f64);
    let round = |x: f64, y: f64| Pt::new(ki_round(x), ki_round(y));
    if sx.max(mx).max(ex) - sx.min(mx).min(ex) < 5.0 && sy.max(my).max(ey) - sy.min(my).min(ey) < 5.0 {
        return round((sx + mx + ex) / 3.0, (sy + my + ey) / 3.0);
    }
    let (dy21, mut dx21, dy32, mut dx32) = (my - sy, mx - sx, ey - my, ex - mx);
    if (dx21 == 0.0 && dy32 == 0.0) || (dy21 == 0.0 && dx32 == 0.0) {
        return round((sx + ex) / 2.0, (sy + ey) / 2.0);
    }
    if dx21 == 0.0 {
        dx21 = f64::EPSILON;
    }
    if dx32 == 0.0 {
        dx32 = -f64::EPSILON;
    }
    let (mut a, mut b) = (dy21 / dx21, dy32 / dx32);
    let da = a * (0.5 / dy21).hypot(0.5 / dx21);
    let db = b * (0.5 / dy32).hypot(0.5 / dx32);
    if a == b {
        if start == end {
            return round((sx + mx) / 2.0, (sy + my) / 2.0);
        }
        a += f64::EPSILON;
        b -= f64::EPSILON;
    }
    if a == 0.0 {
        a = 1e-10;
    }
    if b == 0.0 {
        b = 1e-10;
    }
    let (rel_a, rel_b) = (da / a, db / b);
    let sq = |v: f64| v * v;
    let half_sqrt = std::f64::consts::FRAC_1_SQRT_2;

    let ab_y = a * b * (sy - ey);
    let d_ab_y = ab_y * (sq(rel_a) + sq(rel_b) + sq(half_sqrt / (sy - ey))).sqrt();
    let b_x = b * (sx + mx);
    let d_b_x = b_x * (sq(rel_b) + sq(half_sqrt / (sx + mx))).sqrt();
    let a_x = a * (mx + ex);
    let d_a_x = a_x * (sq(rel_a) + sq(half_sqrt / (mx + ex))).sqrt();
    let twice_diff = 2.0 * (b - a);
    let d_twice_diff = 2.0 * (db * db + da * da).sqrt();

    let num_x = ab_y + b_x - a_x;
    let d_num_x = (d_ab_y * d_ab_y + d_b_x * d_b_x + d_a_x * d_a_x).sqrt();
    let cx = (ab_y + b_x - a_x) / twice_diff;
    let d_cx = cx * (sq(d_num_x / num_x) + sq(d_twice_diff / twice_diff)).sqrt();

    let num_y = (sx + mx) / 2.0 - cx;
    let d_num_y = (1.0 / 8.0 + d_cx * d_cx).sqrt();
    let first = num_y / a;
    let d_first = first * (sq(d_num_y / num_y) + sq(rel_a)).sqrt();
    let cy = first + (sy + my) / 2.0;
    let d_cy = (d_first * d_first + 1.0 / 8.0).sqrt();

    for step in [100.0, 10.0] {
        let snap = |v: f64| ((v + step / 2.0) / step).floor() * step;
        let (rx, ry) = (snap(cx), snap(cy));
        if (rx - cx).abs() < d_cx && (ry - cy).abs() < d_cy {
            return round(rx, ry);
        }
    }
    round(cx, cy)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quarter_arc_has_its_centre_radius_and_sweep() {
        // Clockwise on screen from (10, 0) to (0, 10) about the origin: mid at 45 degrees.
        let a = Arc::through(Pt::new(10_000_000, 0), Pt::new(7_071_068, 7_071_068), Pt::new(0, 10_000_000));
        assert_eq!(a.center, Pt::new(0, 0));
        assert_eq!(a.radius(), 10_000_000);
        assert_eq!(a.sweep(), 90.0);
    }

    #[test]
    fn an_arc_against_kicads_winding_swaps_its_ends() {
        let a = Arc::through(Pt::new(0, 10_000_000), Pt::new(7_071_068, 7_071_068), Pt::new(10_000_000, 0));
        assert_eq!((a.start, a.end), (Pt::new(10_000_000, 0), Pt::new(0, 10_000_000)));
    }
}
