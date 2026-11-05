//! The failures of a route, as the loop parses them from the KiCad report, and the failure term of a pose.
//!
//! Term (lower is better). Unconnected: the endpoint distances, pads moving with their units. Every located item (DRC, parity or
//! unconnected endpoint): minus its free room, the distance to the nearest rect of another unit that does not contain it, capped
//! at the move radius.

use crate::geom::{Point, Rect, turn_point};
use crate::kicad::clusters::contains;
use crate::numeric::{compensated, hypot};
use crate::problem::{Place, Problem, Unit};
use crate::read::parts::is_connector;
use serde::Deserialize;
use std::collections::{BTreeSet, HashMap};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Drc,
    Unconnected,
    Parity,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Item {
    /// None: an item with no useful position (a zone).
    pub point: Option<Point>,
    #[serde(rename = "ref")]
    pub reference: Option<String>,
    pub pad: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Failure {
    pub kind: Kind,
    pub items: Vec<Item>,
}

/// Reference to unit.
pub fn ref_units(pr: &Problem) -> HashMap<&str, usize> {
    pr.units.iter().enumerate().flat_map(|(i, u)| u.refs.iter().map(move |r| (r.as_str(), i))).collect()
}

/// Pad centre relative to the unit origin, unturned.
fn pad_offset(u: &Unit, reference: &str, pad: Option<&str>) -> Option<Point> {
    let row = u.cu.iter().zip(&u.cu_pads).find(|(_, meta)| meta.reference == reference && meta.number.as_deref() == pad);
    row.map(|(cu, _)| cu.rect.centre())
}

/// World point of a failure item: a pad moves with its unit; other items stay where they are.
fn item_point(pr: &Problem, by_ref: &HashMap<&str, usize>, pose: &[Place], item: &Item) -> Option<Point> {
    let pad_point = || {
        let reference = item.reference.as_deref()?;
        let &i = by_ref.get(reference)?;
        let offset = pad_offset(&pr.units[i], reference, item.pad.as_deref())?;
        let (x, y, r) = pose[i];
        let (dx, dy) = turn_point(offset, r);
        Some((x + dx, y + dy))
    };
    pad_point().or(item.point)
}

fn rect_dist(p: Point, rect: Rect) -> f64 {
    let (dx, dy) = rect.axis_gaps(p);
    hypot(dx, dy)
}

fn world_rects(u: &Unit, (x, y, r): Place) -> impl Iterator<Item = Rect> + '_ {
    u.rects.iter().map(move |q| q.rect.turned(r).shifted(x, y))
}

fn unit_dist(u: &Unit, place: Place, p: Point) -> f64 {
    world_rects(u, place).map(|w| rect_dist(p, w)).fold(f64::INFINITY, f64::min)
}

/// Distance from p to the nearest rect of a unit that does not contain it (its own pad, courtyard or block border does), capped.
fn unit_room(u: &Unit, place: Place, p: Point, cap: f64) -> f64 {
    world_rects(u, place).filter(|w| !contains(*w, p.0, p.1)).map(|w| rect_dist(p, w)).fold(cap, f64::min)
}

/// The failure term of one pose and single-unit trial moves from it. The room of the units that do not move is kept per moved unit.
pub struct Term<'a> {
    pr: &'a Problem,
    pose: Vec<Place>,
    fails: &'a [Failure],
    cap: f64,
    by_ref: HashMap<&'a str, usize>,
    /// (moved unit, failure, item) to the room of the item among the other units.
    still: HashMap<(usize, usize, usize), f64>,
}

impl<'a> Term<'a> {
    pub fn new(pr: &'a Problem, pose: &[Place], fails: &'a [Failure], cap: f64) -> Self {
        Self { pr, pose: pose.to_vec(), fails, cap, by_ref: ref_units(pr), still: HashMap::new() }
    }

    fn room(&self, p: Point, pose: &[Place], skip: [Option<usize>; 2]) -> f64 {
        let units = self.pr.units.iter().enumerate().filter(|(j, _)| !skip.contains(&Some(*j)));
        units.map(|(j, u)| unit_room(u, pose[j], p, self.cap)).fold(self.cap, f64::min)
    }

    fn owner(&self, item: &Item) -> Option<usize> {
        item.reference.as_deref().and_then(|r| self.by_ref.get(r).copied())
    }

    /// The term at the pose, with unit i at place q when given.
    pub fn value(&mut self, moved: Option<(usize, Place)>) -> f64 {
        let mut pose = self.pose.clone();
        if let Some((i, q)) = moved {
            pose[i] = q;
        }
        let at = |f: &Failure| f.items.iter().map(|it| item_point(self.pr, &self.by_ref, &pose, it)).collect::<Vec<_>>();
        let points: Vec<Vec<Option<Point>>> = self.fails.iter().map(at).collect();
        let mut total = 0.0;
        for (f, row) in self.fails.iter().zip(&points) {
            if f.kind == Kind::Unconnected {
                let ends: Vec<Point> = row.iter().flatten().copied().collect();
                total += compensated(ends.windows(2).map(|w| hypot(w[0].0 - w[1].0, w[0].1 - w[1].1)));
            }
        }
        for (fi, (f, row)) in self.fails.iter().zip(&points).enumerate() {
            for (k, (item, p)) in f.items.iter().zip(row).enumerate() {
                let Some(p) = *p else { continue };
                let own = self.owner(item);
                total -= match moved {
                    Some((i, _)) if own != Some(i) => {
                        let rest = match self.still.get(&(i, fi, k)) {
                            Some(&room) => room,
                            None => self.room(p, &pose, [Some(i), own]),
                        };
                        self.still.insert((i, fi, k), rest);
                        rest.min(unit_room(&self.pr.units[i], pose[i], p, self.cap))
                    }
                    _ => self.room(p, &pose, [own, None]),
                };
            }
        }
        total
    }
}

pub fn failure_term(pr: &Problem, pose: &[Place], fails: &[Failure], cap: f64) -> f64 {
    Term::new(pr, pose, fails, cap).value(None)
}

/// Not fixed, and no connector: connectors stay at the board edge.
pub fn movable(pr: &Problem, i: usize) -> bool {
    let u = &pr.units[i];
    !u.fixed && !u.refs.iter().any(|r| is_connector(r))
}

/// Movable units that own a failure pad or have a rect within `radius` of a failure point; nearest first.
pub fn candidates(pr: &Problem, pose: &[Place], fails: &[Failure], radius: f64) -> Vec<usize> {
    let by_ref = ref_units(pr);
    let items = || fails.iter().flat_map(|f| &f.items);
    let owners: BTreeSet<usize> = items().filter_map(|it| by_ref.get(it.reference.as_deref()?).copied()).collect();
    let points: Vec<Point> = items().filter_map(|it| item_point(pr, &by_ref, pose, it)).collect();
    let mut near: Vec<(f64, usize)> = Vec::new();
    for i in (0..pr.units.len()).filter(|&i| movable(pr, i)) {
        let d = points.iter().map(|&p| unit_dist(&pr.units[i], pose[i], p)).fold(f64::INFINITY, f64::min);
        if owners.contains(&i) {
            near.push((0.0, i));
        } else if d <= radius {
            near.push((d, i));
        }
    }
    near.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    near.into_iter().map(|(_, i)| i).collect()
}
