//! Domain areas (the mains area): the convex hull of the domain pads of a .kicad_dru domain, grown by its gap. A part
//! with no domain pad in it is a hard overlap: its tracks would cross the area. The hulls move with the domain parts.

use crate::geom::{EPS, Point, Rect, hull};
use crate::layout::Layout;
use crate::model::Model;
use crate::numeric::{compensated, pairwise};
use crate::problem::{Problem, Unit};
use std::collections::BTreeSet;

struct Area {
    /// (unit, domain rect indices).
    sources: Vec<(usize, Vec<usize>)>,
    gap: f64,
    all_fixed: bool,
}

/// The static part of the domain areas.
pub struct DomainAreas {
    areas: Vec<Area>,
    /// Per unit the rects that must stay out of the areas. None for a unit with domain pads or with no such rect.
    subjects: Vec<Option<Vec<usize>>>,
    /// The units whose rects shape a hull.
    pub domain_units: BTreeSet<usize>,
}

/// A hull with its gap.
#[derive(Clone)]
pub struct Hull {
    points: Vec<Point>,
    bounds: Rect,
    gap: f64,
    all_fixed: bool,
}

fn subject(u: &Unit) -> Option<Vec<usize>> {
    let skipped = |k: &usize| u.nocu || u.ko.contains(k) || u.border.contains(k);
    let rects: Vec<usize> = (0..u.rects.len()).filter(|k| !skipped(k)).collect();
    (u.dom.is_empty() && !rects.is_empty()).then_some(rects)
}

impl DomainAreas {
    pub fn new(pr: &Problem) -> Self {
        let mut areas = Vec::new();
        for a in pr.domain_areas.iter().flatten() {
            let rects_of = |u: &Unit| -> Vec<usize> {
                u.dom.iter().filter(|d| a.classes.contains(&d.1)).map(|d| d.0).collect()
            };
            let sources: Vec<_> =
                pr.units.iter().enumerate().map(|(i, u)| (i, rects_of(u))).filter(|(_, ks)| !ks.is_empty()).collect();
            if !sources.is_empty() {
                let all_fixed = sources.iter().all(|(i, _)| pr.units[*i].fixed);
                areas.push(Area { sources, gap: a.gap, all_fixed });
            }
        }
        let domain_units = areas.iter().flat_map(|a| a.sources.iter().map(|s| s.0)).collect();
        Self { areas, subjects: pr.units.iter().map(subject).collect(), domain_units }
    }

    pub fn is_empty(&self) -> bool {
        self.areas.is_empty()
    }

    pub fn hulls(&self, at: &Layout) -> Vec<Hull> {
        self.areas.iter().map(|a| Hull::new(a, at)).collect()
    }

    /// Area penalty of one unit against the hulls; a fixed unit against an area of fixed parts counts 0.
    pub fn unit_penalty(&self, i: usize, fixed: bool, at: &Layout, hulls: &[Hull]) -> f64 {
        let Some(idx) = &self.subjects[i] else { return 0.0 };
        let rects: Vec<Rect> = idx.iter().map(|&k| at.world(i)[k]).collect();
        let b = Rect::bounding(rects.iter().copied()).expect("a subject has rects");
        let near = |h: &&Hull| !(fixed && h.all_fixed) && b.meets(h.bounds.grown(h.gap));
        compensated(hulls.iter().filter(near).map(|h| h.penalty(&rects)))
    }
}

impl Hull {
    fn new(area: &Area, at: &Layout) -> Self {
        let corners: Vec<Point> = area
            .sources
            .iter()
            .flat_map(|(i, ks)| ks.iter().flat_map(|&k| at.world(*i)[k].corners()))
            .collect();
        let points = hull(&corners);
        let bounds = Rect::bounding(points.iter().map(|&(x, y)| Rect::new(x, y, x, y))).expect("a source has rects");
        Self { points, bounds, gap: area.gap, all_fixed: area.all_fixed }
    }

    /// Hull edges: start point and vector, without zero-length edges.
    fn edges(&self) -> Vec<(Point, Point)> {
        let h = &self.points;
        (0..h.len())
            .map(|k| (h[k], (h[(k + 1) % h.len()].0 - h[k].0, h[(k + 1) % h.len()].1 - h[k].1)))
            .filter(|(_, e)| e.0.hypot(e.1) > EPS)
            .collect()
    }

    /// Per rect: gap - distance when nearer than the gap, gap + depth when they overlap (separating axes: x, y and
    /// the edge normals of the hull).
    fn penalty(&self, rects: &[Rect]) -> f64 {
        let edges = self.edges();
        let mut axes = vec![(1.0, 0.0), (0.0, 1.0)];
        axes.extend(edges.iter().map(|(_, e)| (-e.1 / e.0.hypot(e.1), e.0 / e.0.hypot(e.1))));
        let rows: Vec<f64> = rects.iter().map(|r| self.rect_penalty(*r, &axes, &edges)).collect();
        pairwise(&rows)
    }

    fn rect_penalty(&self, r: Rect, axes: &[Point], edges: &[(Point, Point)]) -> f64 {
        let separation = axes.iter().map(|a| self.separation(r, *a)).fold(f64::NEG_INFINITY, f64::max);
        if separation < 0.0 {
            return self.gap - separation;
        }
        (self.gap - self.distance(r, edges)).max(0.0)
    }

    /// Gap between the projections of the rect and the hull on an axis.
    fn separation(&self, r: Rect, axis: Point) -> f64 {
        let project = |p: &Point| p.0 * axis.0 + p.1 * axis.1;
        let (c_lo, c_hi) = span(r.corners().iter().map(project));
        let (h_lo, h_hi) = span(self.points.iter().map(project));
        (c_lo - h_hi).max(h_lo - c_hi)
    }

    /// Shortest of: hull vertices to the rect, rect corners to the hull edges.
    fn distance(&self, r: Rect, edges: &[(Point, Point)]) -> f64 {
        let to_vertices = self.points.iter().map(|&p| {
            let (dx, dy) = r.axis_gaps(p);
            dx.hypot(dy)
        });
        let to_edges = r.corners().into_iter().flat_map(|c| {
            edges.iter().map(move |&(a, e)| {
                let t = (((c.0 - a.0) * e.0 + (c.1 - a.1) * e.1) / (e.0 * e.0 + e.1 * e.1)).clamp(0.0, 1.0);
                let (qx, qy) = (a.0 + t * e.0 - c.0, a.1 + t * e.1 - c.1);
                qx.hypot(qy)
            })
        });
        to_vertices.chain(to_edges).fold(f64::INFINITY, f64::min)
    }
}

fn span(values: impl Iterator<Item = f64>) -> (f64, f64) {
    values.fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), v| (lo.min(v), hi.max(v)))
}

/// Area penalty per unit of the current layout.
pub struct AreaState {
    pub hulls: Vec<Hull>,
    pub penalties: Vec<f64>,
    undo: Option<(Vec<Hull>, Vec<f64>)>,
}

impl AreaState {
    pub fn new(model: &Model, at: &Layout) -> Self {
        let hulls = model.areas.hulls(at);
        let penalties = all_penalties(model, at, &hulls);
        Self { hulls, penalties, undo: None }
    }

    pub fn total(&self) -> f64 {
        compensated(self.penalties.iter().copied())
    }

    /// Update after the units moved. Returns the change of the total.
    pub fn after_move(&mut self, model: &Model, at: &Layout, moved: &[usize]) -> f64 {
        if model.areas.is_empty() {
            return 0.0;
        }
        let before = self.total();
        self.undo = Some((self.hulls.clone(), self.penalties.clone()));
        if moved.iter().any(|i| model.areas.domain_units.contains(i)) {
            self.hulls = model.areas.hulls(at);
            self.penalties = all_penalties(model, at, &self.hulls);
        } else {
            for &i in moved {
                self.penalties[i] = model.areas.unit_penalty(i, model.units[i].fixed, at, &self.hulls);
            }
        }
        self.total() - before
    }

    /// The area part of the overlap of unit i at the layout, which may differ from the state (legalizer trials).
    pub fn unit_overlap(&self, model: &Model, at: &Layout, i: usize) -> f64 {
        if model.areas.is_empty() {
            return 0.0;
        }
        if model.areas.domain_units.contains(&i) {
            return compensated(all_penalties(model, at, &model.areas.hulls(at)));
        }
        model.areas.unit_penalty(i, model.units[i].fixed, at, &self.hulls)
    }

    pub fn commit(&mut self) {
        self.undo = None;
    }

    pub fn revert(&mut self) {
        if let Some((hulls, penalties)) = self.undo.take() {
            (self.hulls, self.penalties) = (hulls, penalties);
        }
    }
}

fn all_penalties(model: &Model, at: &Layout, hulls: &[Hull]) -> Vec<f64> {
    if hulls.is_empty() {
        return vec![0.0; model.units.len()];
    }
    (0..model.units.len()).map(|j| model.areas.unit_penalty(j, model.units[j].fixed, at, hulls)).collect()
}
