//! Spacing overlap of two units. Each rect pair gets a gap; the penalty is the area where the rects grown by half the
//! gap meet, scaled down in a corner by the true distance as DRC measures it.
//!
//! Hard overlap (illegal) = what KiCad DRC enforces: courtyard over courtyard, the gap of a pad rect, domain gaps and
//! keepouts. Soft spacing = the D-040 halo beyond the hard overlap.

use crate::geom::Rect;
use crate::numeric::pairwise;
use crate::problem::{Problem, Unit};

/// Class gap table of the .kicad_dru pair rules: gaps[i][j] between two domain classes.
pub type ClassTable = Vec<Vec<f64>>;

/// The static rect data of a unit, by rect index.
pub struct RectSet {
    /// The D-040 gap of each rect.
    pub full_gap: Vec<f64>,
    /// The hard gap of each rect: its gap when it is a pad or domain rect, else 0.
    pub hard_gap: Vec<f64>,
    /// Keepout rects; keepout over keepout is legal.
    pub keepout: Vec<bool>,
    /// Soft-only rects (block borders).
    pub soft_only: Vec<bool>,
    pub radius: Vec<f64>,
    /// Domain data; None when the unit has no domain, mech or keepout rect.
    pub domain: Option<DomainSet>,
}

pub struct DomainSet {
    /// Domain class per rect: > 0 a domain pad, < 0 a hole rule, 0 none.
    pub class: Vec<i64>,
    /// Gap to another class of the domain.
    pub class_gap: Vec<f64>,
    pub net_clearance: Vec<f64>,
    /// Rects with no pad of their own.
    pub mech: Vec<bool>,
}

fn flags(n: usize, indices: &[usize]) -> Vec<bool> {
    let mut f = vec![false; n];
    indices.iter().for_each(|&i| f[i] = true);
    f
}

impl RectSet {
    pub fn new(u: &Unit) -> Self {
        let n = u.rects.len();
        let mut hard_gap = vec![0.0; n];
        for i in u.hard.iter().copied().chain(u.dom.iter().map(|d| d.0)) {
            hard_gap[i] = u.rects[i].value;
        }
        let mut radius = vec![0.0; n];
        u.rho.iter().for_each(|&(i, r)| radius[i] = r);
        Self {
            full_gap: u.rects.iter().map(|r| r.value).collect(),
            hard_gap,
            keepout: if u.nocu { vec![true; n] } else { flags(n, &u.ko) },
            soft_only: flags(n, &u.border),
            radius,
            domain: DomainSet::new(u),
        }
    }

    pub fn len(&self) -> usize {
        self.full_gap.len()
    }

    pub fn is_empty(&self) -> bool {
        self.full_gap.is_empty()
    }
}

impl DomainSet {
    fn new(u: &Unit) -> Option<Self> {
        if u.dom.is_empty() && u.mech.is_empty() && u.ko.is_empty() {
            return None;
        }
        let n = u.rects.len();
        let mut s = Self { class: vec![0; n], class_gap: vec![0.0; n], net_clearance: vec![0.0; n], mech: flags(n, &u.mech) };
        for d in &u.dom {
            (s.class[d.0], s.class_gap[d.0], s.net_clearance[d.0]) = (d.1, d.2, d.3);
        }
        Some(s)
    }
}

pub fn class_table(pr: &Problem) -> Option<ClassTable> {
    pr.class_gaps.as_ref().filter(|c| !c.gaps.is_empty()).map(|c| c.gaps.clone())
}

/// One side of a pair: static data and rects at their world place.
#[derive(Clone, Copy)]
pub struct Side<'a> {
    pub set: &'a RectSet,
    pub rects: &'a [Rect],
}

/// (hard overlap, soft spacing) of two units.
pub fn penalty(a: Side, b: Side, table: Option<&ClassTable>) -> (f64, f64) {
    let hard = overlap(a, b, table, Gaps::Hard);
    (hard, overlap(a, b, table, Gaps::Full) - hard)
}

#[derive(Clone, Copy, PartialEq)]
enum Gaps {
    Hard,
    Full,
}

fn overlap(a: Side, b: Side, table: Option<&ClassTable>, which: Gaps) -> f64 {
    let (ga, gb) = match which {
        Gaps::Hard => (&a.set.hard_gap, &b.set.hard_gap),
        Gaps::Full => (&a.set.full_gap, &b.set.full_gap),
    };
    let mut cells = Vec::with_capacity(a.rects.len() * b.rects.len());
    for i in 0..a.rects.len() {
        for j in 0..b.rects.len() {
            let keep = !(a.set.keepout[i] && b.set.keepout[j])
                && !(which == Gaps::Hard && (a.set.soft_only[i] || b.set.soft_only[j]));
            let v = if keep {
                let gap = pair_gap(a.set, i, ga[i], b.set, j, gb[j], table);
                rect_penalty(a.rects[i], a.set.radius[i], b.rects[j], b.set.radius[j], gap)
            } else {
                0.0
            };
            cells.push(v);
        }
    }
    pairwise(&cells)
}

/// The gap of rects i and j: the larger of their gaps, unless a domain rule applies.
fn pair_gap(a: &RectSet, i: usize, ga: f64, b: &RectSet, j: usize, gb: f64, table: Option<&ClassTable>) -> f64 {
    let plain = ga.max(gb);
    let (Some(da), Some(db)) = (&a.domain, &b.domain) else { return plain };
    let (ca, cb) = (da.class[i], db.class[j]);
    if ca > 0 && cb < 0 {
        return db.class_gap[j]; // a hole rule: its gap
    }
    if ca < 0 && cb > 0 {
        return da.class_gap[i];
    }
    if (da.mech[i] || a.keepout[i]) && cb > 0 {
        return ga; // no pad, no net: its own class
    }
    if ca > 0 && (db.mech[j] || b.keepout[j]) {
        return gb;
    }
    if ca > 0 && cb > 0 {
        let clearance = da.net_clearance[i].max(db.net_clearance[j]);
        return match (ca == cb, table) {
            (true, _) => clearance,
            (false, Some(t)) => t[ca as usize][cb as usize].max(clearance),
            (false, None) => da.class_gap[i].max(db.class_gap[j]),
        };
    }
    plain
}

/// Penalty of one rect pair at a gap. Rounded corners: the inner box, gap + both radii.
fn rect_penalty(a: Rect, ra: f64, b: Rect, rb: f64, gap: f64) -> f64 {
    let inner = |r: Rect, q: f64| Rect::new(r.x0 + q, r.y0 + q, r.x1 - q, r.y1 - q);
    let (a, b, g) = (inner(a, ra), inner(b, rb), gap + ra + rb);
    let dx = a.x1.min(b.x1) - a.x0.max(b.x0) + g;
    let dy = a.y1.min(b.y1) - a.y0.max(b.y0) + g;
    let area = dx.max(0.0) * dy.max(0.0);
    let (sx, sy) = (g - dx, g - dy); // the free distance on each axis
    if sx > 0.0 && sy > 0.0 && area > 0.0 {
        // a corner: DRC measures the true distance; scale down to 0 at distance = gap
        let d = sx.hypot(sy);
        return area * ((g - d) / (g - sx.max(sy)).max(1e-9)).clamp(0.0, 1.0);
    }
    area
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(gap: f64) -> RectSet {
        RectSet {
            full_gap: vec![gap],
            hard_gap: vec![0.0],
            keepout: vec![false],
            soft_only: vec![false],
            radius: vec![0.0],
            domain: None,
        }
    }

    #[test]
    fn side_gap_is_area_of_grown_boxes() {
        // gap 0.5 between boxes 0.25 apart: grown overlap 0.25 wide, 1.5 tall on the free y axis
        let (a, b) = (set(0.5), set(0.5));
        let (ra, rb) = ([Rect::new(0.0, 0.0, 1.0, 1.0)], [Rect::new(1.25, 0.0, 2.25, 1.0)]);
        let (hard, soft) = penalty(Side { set: &a, rects: &ra }, Side { set: &b, rects: &rb }, None);
        assert_eq!(hard, 0.0);
        assert!((soft - 0.25 * 1.5).abs() < 1e-12);
    }

    #[test]
    fn keepout_over_keepout_is_free() {
        let (mut a, mut b) = (set(0.5), set(0.5));
        a.keepout[0] = true;
        b.keepout[0] = true;
        let r = [Rect::new(0.0, 0.0, 1.0, 1.0)];
        assert_eq!(penalty(Side { set: &a, rects: &r }, Side { set: &b, rects: &r }, None), (0.0, 0.0));
    }

    #[test]
    fn corner_at_the_gap_distance_costs_nothing() {
        // boxes corner to corner, 0.3 and 0.4 apart on the axes: true distance 0.5 = gap
        let p = rect_penalty(Rect::new(0.0, 0.0, 1.0, 1.0), 0.0, Rect::new(1.3, 1.4, 2.0, 2.0), 0.0, 0.5);
        assert!(p.abs() < 1e-12);
    }
}
