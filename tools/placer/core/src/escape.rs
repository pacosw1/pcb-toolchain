//! Pin-escape term: room for each IC pin with a net to leave its part.
//!
//! IC = a part with reference prefix U and more than 3 copper pads. A pin is a pad on the outer edge of the pad box of
//! its part; its side is the box edge it touches (a corner pad: the side of its long axis). A corridor per pin and per
//! direction (the outward normal, and that turned by +-45 degrees) runs from the pad toe to one via:
//!   track radius rt = track / 2 + clearance, via radius rv = via_d / 2 + clearance,
//!   length L = clearance + via_d / 2 + n * (via_d + clearance); n = 0 when the side pitch holds a via in line, else
//!   ceil((via_d + clearance) / pitch), the staggered vias of the neighbours.
//! Copper pads of other nets block a corridor (pads of the pin's own part and partner pads of its net do not).
//! blocked(direction) = penetration / rt in [0, 1]; blocked(pin) = the smallest over the directions; a pin with a
//! partner pad within L of its toe, on its outer side, is free.
//! Side cost: deficit = max(0, need - sum of free(pin)), need = the pins whose net leaves the part. Hard: a side with
//! need > 0 and every pin blocked.

use crate::geom::{Point, Rect, TaggedRect, turn_point};
use crate::layout::Layout;
use crate::model::Model;
use crate::numeric::{median, pairwise};
use crate::params::Params;
use crate::problem::{CuPad, Problem, Unit};
use std::collections::{BTreeMap, BTreeSet};

/// mm: a pad touches a side of the pad box within this distance (footprint rounding).
const SIDE_TOLERANCE: f64 = 0.02;
const DIRECTIONS: [f64; 3] = [0.0, 45.0, -45.0];

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum Side {
    West,
    East,
    North,
    South,
}

impl Side {
    const ALL: [Self; 4] = [Self::West, Self::East, Self::North, Self::South];

    fn normal(self) -> Point {
        match self {
            Self::West => (-1.0, 0.0),
            Self::East => (1.0, 0.0),
            Self::North => (0.0, -1.0),
            Self::South => (0.0, 1.0),
        }
    }

    fn is_horizontal(self) -> bool {
        matches!(self, Self::West | Self::East)
    }

    /// The pad toe on this side.
    fn toe(self, b: Rect) -> Point {
        let (cx, cy) = b.centre();
        match self {
            Self::West => (b.x0, cy),
            Self::East => (b.x1, cy),
            Self::North => (cx, b.y0),
            Self::South => (cx, b.y1),
        }
    }
}

pub fn is_ic(reference: &str, pads: usize) -> bool {
    let letters = reference.chars().take_while(|c| c.is_alphabetic()).count();
    reference.chars().take(letters).eq("U".chars()) && pads > 3
}

#[derive(Clone, Copy, Debug)]
struct Rules {
    track: f64,
    clearance: f64,
    via_d: f64,
}

impl Rules {
    fn new(pr: &Problem, p: &Params) -> Self {
        if let Some(r) = &pr.escape_rules {
            return Self { track: r.track, clearance: r.clearance, via_d: r.via_d };
        }
        let class = pr.route_rules.as_ref().and_then(|r| r.classes.get("Default"));
        let (clearance, track) = class.copied().unwrap_or((0.2, 0.2));
        Self { track, clearance, via_d: p.via_d }
    }
}

/// The corridor of one side pitch.
#[derive(Clone)]
struct Corridor {
    rt: f64,
    rv: f64,
    length: f64,
    /// Distance from the toe per sample; the last one is the via.
    samples: Vec<f64>,
}

impl Corridor {
    fn new(rl: Rules, pitch: f64) -> Self {
        let (c, d) = (rl.clearance, rl.via_d);
        let (rt, rv) = (rl.track / 2.0 + c, d / 2.0 + c);
        let n = if pitch >= d + c - 1e-9 { 0.0 } else { ((d + c) / pitch - 1e-9).ceil() };
        let length = c + d / 2.0 + n * (d + c);
        let k = (length / rt).ceil() as usize + 1;
        let step = length / (k - 1) as f64;
        let mut samples: Vec<f64> = (0..k).map(|i| i as f64 * step).collect();
        samples[k - 1] = length;
        Self { rt, rv, length, samples }
    }

    fn radius(&self, sample: usize) -> f64 {
        if sample + 1 == self.samples.len() { self.rv } else { self.rt }
    }
}

/// A pin before its part's sides are complete.
struct RawPin {
    side: Side,
    toe: Point,
    net: i64,
    need: f64,
}

fn touched_side(b: Rect, outer: Rect) -> Option<Side> {
    let hits = [
        (Side::West, (b.x0 - outer.x0).abs()),
        (Side::East, (b.x1 - outer.x1).abs()),
        (Side::North, (b.y0 - outer.y0).abs()),
        (Side::South, (b.y1 - outer.y1).abs()),
    ];
    let touch: Vec<Side> = hits.iter().filter(|h| h.1 < SIDE_TOLERANCE).map(|h| h.0).collect();
    if touch.len() > 1 {
        let wide = b.width() > b.height();
        if let Some(pick) = touch.iter().find(|s| s.is_horizontal() == wide) {
            return Some(*pick);
        }
    }
    touch.first().copied()
}

fn part_pins(rows: &[(usize, TaggedRect)], leaving: &BTreeSet<i64>) -> Vec<RawPin> {
    let Some(outer) = Rect::bounding(rows.iter().map(|(_, b)| b.rect)) else { return Vec::new() };
    let pin = |(_, b): &(usize, TaggedRect)| {
        let side = touched_side(b.rect, outer)?;
        let net = b.value as i64;
        let need = (net > 0 && leaving.contains(&net)) as i64 as f64;
        Some(RawPin { side, toe: side.toe(b.rect), net, need })
    };
    rows.iter().filter_map(pin).collect()
}

/// The median pitch of the pins of a side; infinite with fewer than two pins.
fn side_pitch(pins: &[RawPin], side: Side) -> f64 {
    let mut along: Vec<f64> =
        pins.iter().filter(|p| p.side == side).map(|p| if side.is_horizontal() { p.toe.1 } else { p.toe.0 }).collect();
    along.sort_by(f64::total_cmp);
    let gaps: Vec<f64> = along.windows(2).map(|w| w[1] - w[0]).filter(|g| *g > 1e-6).collect();
    if gaps.is_empty() { f64::INFINITY } else { median(&gaps) }
}

/// The pins of one unit, in pin order.
pub struct UnitPins {
    pub side_of: Vec<usize>,
    sides: usize,
    net: Vec<i64>,
    pub need: Vec<f64>,
    part: Vec<i64>,
    corridors: Vec<Corridor>,
    /// Toe per pin, for the 4 turns.
    toes: [Vec<Point>; 4],
    /// Unit vector per direction and pin, for the 4 turns.
    rays: [Vec<[Point; 3]>; 4],
    radius_max: f64,
    samples: usize,
}

/// Static pin data of a problem.
pub struct EscapeModel {
    /// Per unit: part id of each copper row (index of the ref in u.refs; -1 unknown).
    part_of_row: Vec<Vec<i64>>,
    /// Per unit: None or its pins.
    pub pins: Vec<Option<UnitPins>>,
}

fn row_ref(u: &Unit, k: usize) -> Option<&CuPad> {
    u.cu_pads.get(k)
}

/// Net code to the (unit, ref) that have a pad on it.
fn net_owners(pr: &Problem) -> BTreeMap<i64, BTreeSet<(usize, &str)>> {
    let mut owners: BTreeMap<i64, BTreeSet<(usize, &str)>> = BTreeMap::new();
    for (i, u) in pr.units.iter().enumerate() {
        for (k, b) in u.cu.iter().enumerate() {
            if let (true, Some(pad)) = (b.value > 0.0, row_ref(u, k)) {
                owners.entry(b.value as i64).or_default().insert((i, pad.reference.as_str()));
            }
        }
    }
    owners
}

impl EscapeModel {
    pub fn new(pr: &Problem, p: &Params) -> Self {
        let rl = Rules::new(pr, p);
        let owners = net_owners(pr);
        let part_of_row = pr.units.iter().map(rows_to_parts).collect();
        let pins = pr.units.iter().enumerate().map(|(i, u)| unit_pins(i, u, rl, &owners)).collect();
        Self { part_of_row, pins }
    }

    pub fn units(&self) -> Vec<usize> {
        (0..self.pins.len()).filter(|&i| self.pins[i].is_some()).collect()
    }

    fn unit(&self, i: usize) -> &UnitPins {
        self.pins[i].as_ref().expect("an escape unit has pins")
    }
}

fn rows_to_parts(u: &Unit) -> Vec<i64> {
    let id = |k: usize| {
        let reference = row_ref(u, k).map(|p| p.reference.as_str());
        reference.and_then(|r| u.refs.iter().position(|x| x == r)).map_or(-1, |n| n as i64)
    };
    (0..u.cu.len()).map(id).collect()
}

fn unit_pins(i: usize, u: &Unit, rl: Rules, owners: &BTreeMap<i64, BTreeSet<(usize, &str)>>) -> Option<UnitPins> {
    let mut order: Vec<&str> = Vec::new();
    let mut by_ref: BTreeMap<&str, Vec<(usize, TaggedRect)>> = BTreeMap::new();
    for (k, b) in u.cu.iter().enumerate() {
        if let Some(pad) = row_ref(u, k).filter(|pad| pad.kind != "npth") {
            let r = pad.reference.as_str();
            if !by_ref.contains_key(r) {
                order.push(r);
            }
            by_ref.entry(r).or_default().push((k, *b));
        }
    }
    let mut pins = Vec::new();
    for r in order.into_iter().filter(|r| is_ic(r, by_ref[r].len())) {
        let leaving: BTreeSet<i64> =
            owners.iter().filter(|(_, own)| own.iter().any(|o| *o != (i, r))).map(|(q, _)| *q).collect();
        let part = u.refs.iter().position(|x| x == r).map_or(-1, |n| n as i64);
        let raw = part_pins(&by_ref[r], &leaving);
        let pitch: BTreeMap<Side, f64> = Side::ALL.iter().map(|&s| (s, side_pitch(&raw, s))).collect();
        pins.extend(raw.into_iter().map(|q| {
            let corridor = Corridor::new(rl, pitch[&q.side]);
            (part, q, corridor)
        }));
    }
    (!pins.is_empty()).then(|| build_unit_pins(pins))
}

fn turn_vector(v: Point, degrees: f64) -> Point {
    let a = degrees.to_radians();
    (v.0 * a.cos() - v.1 * a.sin(), v.0 * a.sin() + v.1 * a.cos())
}

fn build_unit_pins(pins: Vec<(i64, RawPin, Corridor)>) -> UnitPins {
    let mut side_ids: Vec<(i64, Side)> = Vec::new();
    let side_of = pins
        .iter()
        .map(|(part, q, _)| {
            let key = (*part, q.side);
            side_ids.iter().position(|s| *s == key).unwrap_or_else(|| {
                side_ids.push(key);
                side_ids.len() - 1
            })
        })
        .collect();
    let rays_r0: Vec<[Point; 3]> = pins.iter().map(|(_, q, _)| DIRECTIONS.map(|d| turn_vector(q.side.normal(), d))).collect();
    let toes_r0: Vec<Point> = pins.iter().map(|(_, q, _)| q.toe).collect();
    let turn_rays = |r| rays_r0.iter().map(|row| row.map(|v| turn_point(v, r))).collect();
    UnitPins {
        side_of,
        sides: side_ids.len(),
        net: pins.iter().map(|(_, q, _)| q.net).collect(),
        need: pins.iter().map(|(_, q, _)| q.need).collect(),
        part: pins.iter().map(|(part, _, _)| *part).collect(),
        radius_max: pins.iter().map(|(_, _, c)| c.rv.max(c.rt)).fold(0.0, f64::max),
        samples: pins.iter().map(|(_, _, c)| c.samples.len()).max().unwrap_or(0),
        corridors: pins.iter().map(|(_, _, c)| c.clone()).collect(),
        toes: [0, 1, 2, 3].map(|r| toes_r0.iter().map(|&t| turn_point(t, r)).collect()),
        rays: [0, 1, 2, 3].map(turn_rays),
    }
}

impl UnitPins {
    pub fn len(&self) -> usize {
        self.net.len()
    }

    /// World sample point of a pin: the corridors of a side with fewer samples end at their via.
    fn sample(&self, pin: usize, direction: usize, k: usize, at: (f64, f64, u8)) -> Point {
        let (x, y, r) = at;
        let c = &self.corridors[pin];
        let t = c.samples[k.min(c.samples.len() - 1)];
        let v = self.rays[r as usize][pin][direction];
        let toe = self.toes[r as usize][pin];
        (t * v.0 + toe.0 + x, t * v.1 + toe.1 + y)
    }

    /// World box of the corridors of each pin (with the via radius).
    pub fn pin_boxes(&self, at: (f64, f64, u8)) -> Vec<Rect> {
        let g = self.radius_max;
        let boxes = |pin: usize| {
            let points = (0..3).flat_map(|d| (0..self.samples).map(move |k| (d, k)));
            let point_box = |(d, k)| {
                let (x, y) = self.sample(pin, d, k, at);
                Rect::new(x, y, x, y)
            };
            Rect::bounding(points.map(point_box)).expect("a corridor has samples").grown(g)
        };
        (0..self.len()).map(boxes).collect()
    }

    /// Smallest room over the samples of one direction (negative = inside copper).
    fn room(&self, pin: usize, direction: usize, at: (f64, f64, u8), copper: &[(&Pad, bool)]) -> f64 {
        let mut least = f64::INFINITY;
        for k in 0..self.samples {
            let p = self.sample(pin, direction, k, at);
            let c = &self.corridors[pin];
            let radius = c.radius(k.min(c.samples.len() - 1));
            for (pad, skip) in copper {
                if !skip {
                    let (dx, dy) = pad.rect.axis_gaps(p);
                    least = least.min((dx * dx + dy * dy).sqrt() - radius);
                }
            }
        }
        least
    }

    /// True when a partner pad lies within L of the toe on the outer side: the pin connects to it directly.
    fn has_near_partner(&self, pin: usize, at: (f64, f64, u8), partners: &[&Pad]) -> bool {
        let c = &self.corridors[pin];
        let toe = self.sample(pin, 0, 0, at);
        let end = self.sample(pin, 0, self.samples - 1, at);
        let normal = ((end.0 - toe.0) / c.length, (end.1 - toe.1) / c.length);
        partners.iter().any(|pad| {
            let (tx, ty) = pad.rect.axis_gaps(toe);
            let (cx, cy) = pad.rect.centre();
            tx.hypot(ty) <= c.length && (cx - toe.0) * normal.0 + (cy - toe.1) * normal.1 >= 0.0
        })
    }

    /// blocked(pin) in [0, 1].
    fn blocked(&self, unit: usize, pin: usize, at: (f64, f64, u8), copper: &[Pad]) -> f64 {
        let net = self.net[pin];
        let is_own = |q: &Pad| q.unit == unit && q.part == self.part[pin];
        let is_partner = |q: &Pad| q.net == net as f64 && net > 0;
        let flagged: Vec<(&Pad, bool)> = copper.iter().map(|q| (q, is_own(q) || is_partner(q))).collect();
        let rt = self.corridors[pin].rt;
        let per_direction = (0..3).map(|d| (-self.room(pin, d, at, &flagged) / rt).clamp(0.0, 1.0));
        let b = per_direction.fold(f64::INFINITY, f64::min);
        let partners: Vec<&Pad> = copper.iter().filter(|q| is_partner(q) && !is_own(q)).collect();
        if self.has_near_partner(pin, at, &partners) { 0.0 } else { b }
    }

    /// (deficit, hard sides) from blocked per pin.
    fn side_cost(&self, blocked: &[f64]) -> (f64, i64) {
        let mut free = vec![0.0; self.sides];
        let mut need = vec![0.0; self.sides];
        let mut full = vec![0; self.sides];
        let mut size = vec![0; self.sides];
        for (pin, &s) in self.side_of.iter().enumerate() {
            free[s] += 1.0 - blocked[pin];
            need[s] += self.need[pin];
            full[s] += (blocked[pin] >= 1.0 - 1e-9) as i32;
            size[s] += 1;
        }
        let short: Vec<f64> = need.iter().zip(&free).map(|(n, f)| (n - f).max(0.0)).collect();
        let hard = (0..self.sides).filter(|&s| need[s] > 0.0 && full[s] >= size[s]).count();
        (pairwise(&short), hard as i64)
    }
}

/// One copper pad near a pin.
struct Pad {
    rect: Rect,
    net: f64,
    unit: usize,
    part: i64,
}

#[derive(Clone)]
pub struct UnitEscape {
    pub blocked: Vec<f64>,
    deficit: f64,
    boxes: Vec<Rect>,
}

/// Blocked pins of the escape units of the current layout.
pub struct EscapeState {
    pub units: BTreeMap<usize, UnitEscape>,
    copper_boxes_before: Vec<Rect>,
    undo: Vec<(usize, UnitEscape)>,
}

/// World copper of the units near a box.
fn copper_near(model: &Model, esc: &EscapeModel, at: &Layout, b: Rect) -> Vec<Pad> {
    let mut pads = Vec::new();
    for j in at.copper_near(b, 0.0) {
        let parts = &esc.part_of_row[j];
        pads.extend(at.copper(model, j).into_iter().zip(parts).map(|(q, part)| Pad {
            rect: q.rect,
            net: q.value,
            unit: j,
            part: *part,
        }));
    }
    pads
}

fn blocked_pins(model: &Model, esc: &EscapeModel, at: &Layout, e: usize, pins: &[usize], boxes: &[Rect]) -> Vec<f64> {
    let Some(around) = Rect::bounding(pins.iter().map(|&k| boxes[k])) else { return Vec::new() };
    let copper = copper_near(model, esc, at, around);
    if copper.is_empty() {
        return vec![0.0; pins.len()];
    }
    let q = esc.unit(e);
    pins.iter().map(|&k| q.blocked(e, k, at.place(e), &copper)).collect()
}

fn hits(boxes: &[Rect], against: &[Rect]) -> Vec<usize> {
    (0..boxes.len()).filter(|&k| against.iter().any(|b| boxes[k].meets(*b))).collect()
}

impl EscapeState {
    pub fn new(model: &Model, esc: &EscapeModel, at: &Layout) -> Self {
        let mut units = BTreeMap::new();
        for e in esc.units() {
            let q = esc.unit(e);
            let boxes = q.pin_boxes(at.place(e));
            let all: Vec<usize> = (0..q.len()).collect();
            let blocked = blocked_pins(model, esc, at, e, &all, &boxes);
            let deficit = q.side_cost(&blocked).0;
            units.insert(e, UnitEscape { blocked, deficit, boxes });
        }
        Self { units, copper_boxes_before: Vec::new(), undo: Vec::new() }
    }

    pub fn total(&self) -> f64 {
        crate::numeric::compensated(self.units.values().map(|u| u.deficit))
    }

    pub fn before_move(&mut self, at: &Layout, moved: &[usize]) {
        self.copper_boxes_before.clear();
        self.copper_boxes_before.extend(moved.iter().map(|&i| at.copper_box[i]));
    }

    fn refresh(&mut self, model: &Model, esc: &EscapeModel, at: &Layout, e: usize, moved: bool, boxes: &[Rect]) -> Option<f64> {
        let q = esc.unit(e);
        let old = self.units.get(&e)?.clone();
        let next = if moved {
            let pin_boxes = q.pin_boxes(at.place(e));
            let all: Vec<usize> = (0..q.len()).collect();
            let blocked = blocked_pins(model, esc, at, e, &all, &pin_boxes);
            UnitEscape { blocked, boxes: pin_boxes, deficit: 0.0 }
        } else {
            let touched = hits(&old.boxes, boxes);
            if touched.is_empty() {
                return None;
            }
            let mut blocked = old.blocked.clone();
            let fresh = blocked_pins(model, esc, at, e, &touched, &old.boxes);
            touched.iter().zip(fresh).for_each(|(&k, v)| blocked[k] = v);
            UnitEscape { blocked, boxes: old.boxes.clone(), deficit: 0.0 }
        };
        let deficit = q.side_cost(&next.blocked).0;
        let change = deficit - old.deficit;
        self.units.insert(e, UnitEscape { deficit, ..next });
        self.undo.push((e, old));
        Some(change)
    }

    /// Update the units the move can reach. Returns the change of the total.
    pub fn after_move(&mut self, model: &Model, esc: &EscapeModel, at: &Layout, moved: &[usize]) -> f64 {
        self.undo.clear();
        let after = moved.iter().map(|&i| at.copper_box[i]);
        let boxes: Vec<Rect> = self.copper_boxes_before.iter().copied().chain(after).filter(|b| b.x0.is_finite()).collect();
        let mut delta = 0.0;
        for e in esc.units() {
            if let Some(change) = self.refresh(model, esc, at, e, moved.contains(&e), &boxes) {
                delta += change;
            }
        }
        delta
    }

    /// Fully blocked sides of the escape units that unit i meets or owns, at the layout (a fresh computation: the
    /// legalizer tries places without updating the state).
    pub fn hard_sides(&self, model: &Model, esc: &EscapeModel, at: &Layout, i: usize) -> i64 {
        let cb = at.copper_box[i];
        let mut sides = 0;
        for e in esc.units() {
            let q = esc.unit(e);
            let boxes = if e == i { q.pin_boxes(at.place(e)) } else { self.units[&e].boxes.clone() };
            if e != i && (!cb.x0.is_finite() || hits(&boxes, &[cb]).is_empty()) {
                continue;
            }
            let all: Vec<usize> = (0..q.len()).collect();
            sides += q.side_cost(&blocked_pins(model, esc, at, e, &all, &boxes)).1;
        }
        sides
    }

    pub fn revert(&mut self) {
        for (e, old) in self.undo.drain(..) {
            self.units.insert(e, old);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ic_rule() {
        assert!(is_ic("U12", 4));
        assert!(!is_ic("U12", 3));
        assert!(!is_ic("UX1", 8));
        assert!(!is_ic("R1", 8));
    }

    #[test]
    fn net_core_corridor_from_the_module_notes() {
        // Default class 0.15 / 0.15 mm, via 0.6 mm, 0.5 mm pitch: rt 0.225, rv 0.45, L 1.95 mm (n 2)
        let c = Corridor::new(Rules { track: 0.15, clearance: 0.15, via_d: 0.6 }, 0.5);
        assert!((c.rt - 0.225).abs() < 1e-12);
        assert!((c.rv - 0.45).abs() < 1e-12);
        assert!((c.length - 1.95).abs() < 1e-12);
    }

    #[test]
    fn a_wide_pitch_has_its_own_via() {
        let c = Corridor::new(Rules { track: 0.2, clearance: 0.2, via_d: 0.6 }, 1.27);
        assert!((c.length - 0.5).abs() < 1e-12);
        let c = Corridor::new(Rules { track: 0.15, clearance: 0.15, via_d: 0.6 }, 1.27);
        assert!((c.length - 0.45).abs() < 1e-12);
    }

    #[test]
    fn corridor_samples_keep_the_track_radius_and_end_at_the_via() {
        let c = Corridor::new(Rules { track: 0.15, clearance: 0.15, via_d: 0.6 }, 0.5);
        assert_eq!(c.radius(c.samples.len() - 1), c.rv);
        assert!(c.samples.windows(2).all(|w| w[1] - w[0] <= c.rt + 1e-9));
    }

    fn rules_of(v: serde_json::Value, p: &Params) -> Rules {
        Rules::new(&serde_json::from_value(v).unwrap(), p)
    }

    #[test]
    fn rules_from_the_problem_or_the_default_class() {
        let base = serde_json::json!({"units": [], "nets": [], "board": {"outline": [[0, 0], [1, 0], [1, 1]]}});
        let mut v = base.clone();
        v["escape_rules"] = serde_json::json!({"track": 0.15, "clearance": 0.15, "via_d": 0.6});
        let r = rules_of(v, &Params::default());
        assert_eq!((r.track, r.clearance, r.via_d), (0.15, 0.15, 0.6));
        let mut v = base;
        v["route_rules"] = serde_json::json!({"classes": {"Default": [0.2, 0.25]}, "dru": {}});
        let r = rules_of(v, &Params::from_args(&["via_d=0.5"]).unwrap());
        assert_eq!((r.track, r.clearance, r.via_d), (0.25, 0.2, 0.5));
    }
}
