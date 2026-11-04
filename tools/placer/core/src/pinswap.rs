//! Pin swap proposal for one IC. A swappable net is a plain GPIO or an EXTI input; it may move to another swappable pin
//! or to a free usable pin. Peripheral pins stay fixed. Rules for a move (`allowed`):
//!   an EXTI net keeps a line number that no other EXTI net uses (line = pin number in the port);
//!   an output never goes to the low-drive RTC pins PC13-PC15;
//!   a net on a 5 V tolerant (FT) pin goes only to an FT pin;
//!   analog-only pins and pins with 'not usable' or 'reserved' in the pin map note are not used.
//! Cost = HPWL of the swappable nets + w_x * crossings of the rat lines (pin to nearest other end), against each other
//! and the fixed rat lines of the IC, + w_c per net off its present pin. Search = steepest descent over moves and swaps,
//! with seeded random restarts. The result is a proposal (a pin-map diff); it never edits a schematic.

use crate::geom::Point;
use crate::numeric::{PyRandom, compensated, hypot, round_to};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const LOW_DRIVE: [&str; 3] = ["PC13", "PC14", "PC15"];
const KICKS: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Out,
    Exti,
    #[serde(other)]
    Plain,
}

#[derive(Clone, Debug, Deserialize)]
pub struct SwapNet {
    pub pin: String,
    pub kind: Kind,
    pub ft: bool,
    pub ends: Vec<Point>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Slot {
    pub name: String,
    #[serde(rename = "type")]
    pub pin_type: String,
    #[serde(default)]
    pub note: String,
    pub x: f64,
    pub y: f64,
}

pub type Nets = BTreeMap<String, SwapNet>;
pub type Slots = BTreeMap<String, Slot>;
pub type Assign = BTreeMap<String, String>;
/// A rat line: x0, y0, x1, y1.
pub type Segment = [f64; 4];

/// The cost weights of a search.
#[derive(Clone, Copy, Debug)]
pub struct Weights {
    pub crossing: f64,
    pub change: f64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Measure {
    pub hpwl: f64,
    pub crossings: usize,
    pub changes: usize,
    pub cost: f64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Change {
    pub net: String,
    pub from_pin: String,
    pub from_name: String,
    pub to_pin: String,
    pub to_name: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Proposal {
    pub assign: Assign,
    pub before: Measure,
    pub after: Measure,
    pub diff: Vec<Change>,
}

/// The number of a port pin name: PA12 -> 12.
pub fn port_line(name: &str) -> Option<u32> {
    let rest = name.strip_prefix('P')?;
    let mut chars = rest.chars();
    if !matches!(chars.next(), Some('A'..='K')) {
        return None;
    }
    let digits: String = chars.take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

fn base_name(name: &str) -> &str {
    name.split(['-', '_']).next().unwrap_or(name)
}

pub fn usable(s: &Slot) -> bool {
    let note = s.note.to_lowercase();
    !s.pin_type.contains("ANA") && !note.contains("not usable") && !note.contains("reserved")
}

/// The pins and nets of the IC, with the fixed rat lines.
pub struct Chip<'a> {
    pub nets: &'a Nets,
    pub slots: &'a Slots,
    pub fixed: &'a [Segment],
}

impl Chip<'_> {
    pub fn allowed(&self, n: &str, pin: &str, assign: &Assign) -> bool {
        let (net, s) = (&self.nets[n], &self.slots[pin]);
        if pin != net.pin && !usable(s) {
            return false;
        }
        if net.kind == Kind::Out && LOW_DRIVE.contains(&base_name(&s.name)) {
            return false;
        }
        if net.ft && !s.pin_type.starts_with("FT") {
            return false;
        }
        net.kind != Kind::Exti || self.exti_line_free(n, port_line(&s.name), assign)
    }

    fn exti_line_free(&self, n: &str, line: Option<u32>, assign: &Assign) -> bool {
        let taken = |(m, p): (&String, &String)| {
            m != n && self.nets[m].kind == Kind::Exti && port_line(&self.slots[p].name) == line
        };
        line.is_some() && !assign.iter().any(taken)
    }

    fn rat_line(&self, n: &str, pin: &str) -> Segment {
        let s = &self.slots[pin];
        let dist = |q: &Point| hypot(q.0 - s.x, q.1 - s.y);
        let ends = &self.nets[n].ends;
        let e = ends.iter().skip(1).fold(ends[0], |best, q| if dist(q) < dist(&best) { *q } else { best });
        [s.x, s.y, e.0, e.1]
    }

    fn hpwl(&self, n: &str, pin: &str) -> f64 {
        let s = &self.slots[pin];
        let ends = &self.nets[n].ends;
        let span = |first: f64, axis: fn(&Point) -> f64| {
            let (lo, hi) = ends.iter().map(axis).fold((first, first), |(lo, hi), v| (lo.min(v), hi.max(v)));
            hi - lo
        };
        span(s.x, |p| p.0) + span(s.y, |p| p.1)
    }

    pub fn measure(&self, assign: &Assign, w: Weights) -> Measure {
        let segs: Vec<Segment> = assign.iter().map(|(n, p)| self.rat_line(n, p)).collect();
        let hpwl = compensated(assign.iter().map(|(n, p)| self.hpwl(n, p)));
        let own = (0..segs.len()).flat_map(|i| (i + 1..segs.len()).map(move |j| (i, j)));
        let inner = own.filter(|&(i, j)| crosses(&segs[i], &segs[j])).count();
        let outer = segs.iter().flat_map(|a| self.fixed.iter().map(move |b| (a, b))).filter(|(a, b)| crosses(a, b)).count();
        let crossings = inner + outer;
        let changes = assign.iter().filter(|(n, p)| **p != self.nets[*n].pin).count();
        let cost = hpwl + w.crossing * crossings as f64 + w.change * changes as f64;
        Measure { hpwl: round_to(hpwl, 6), crossings, changes, cost: round_to(cost, 6) }
    }

    /// All legal single moves (to a free pin) and swaps, in a fixed order.
    fn moves(&self, assign: &Assign) -> Vec<Assign> {
        let held: BTreeMap<&String, &String> = assign.iter().map(|(n, p)| (p, n)).collect();
        let mut out = Vec::new();
        for (n, current) in assign {
            for pin in self.slots.keys().filter(|p| *p != current) {
                let other = held.get(pin).copied();
                if other.is_some_and(|m| m < n) {
                    continue; // each swap once
                }
                let mut next = assign.clone();
                next.insert(n.clone(), pin.clone());
                if let Some(m) = other {
                    next.insert(m.clone(), current.clone());
                }
                let partner_ok = other.is_none_or(|m| self.allowed(m, current, &next));
                if self.allowed(n, pin, &next) && partner_ok {
                    out.push(next);
                }
            }
        }
        out
    }

    fn descend(&self, mut assign: Assign, w: Weights) -> (Assign, f64) {
        let mut cost = self.measure(&assign, w).cost;
        loop {
            let scored = self.moves(&assign).into_iter().map(|next| (self.measure(&next, w).cost, next));
            let best = scored.filter(|(c, _)| *c < cost - 1e-9).reduce(|a, b| if b.0 < a.0 { b } else { a });
            match best {
                Some((c, next)) => (cost, assign) = (c, next),
                None => return (assign, cost),
            }
        }
    }

    pub fn search(&self, seed: u64, restarts: usize, w: Weights) -> Proposal {
        let start: Assign = self.nets.iter().map(|(n, v)| (n.clone(), v.pin.clone())).collect();
        let (mut best, mut cost) = self.descend(start.clone(), w);
        let mut rng = PyRandom::new(seed);
        for _ in 0..restarts {
            let mut a = best.clone();
            for _ in 0..KICKS {
                let moves = self.moves(&a);
                if !moves.is_empty() {
                    a = moves[rng.below(moves.len())].clone();
                }
            }
            let (next, c) = self.descend(a, w);
            if c < cost - 1e-9 {
                (best, cost) = (next, c);
            }
        }
        let diff = best.iter().filter(|(n, p)| **p != self.nets[*n].pin).map(|(n, p)| self.change(n, p)).collect();
        Proposal { before: self.measure(&start, w), after: self.measure(&best, w), assign: best, diff }
    }

    fn change(&self, n: &str, to: &str) -> Change {
        let from = &self.nets[n].pin;
        Change {
            net: n.to_string(),
            from_pin: from.clone(),
            from_name: self.slots[from].name.clone(),
            to_pin: to.to_string(),
            to_name: self.slots[to].name.clone(),
        }
    }
}

/// True when the two segments cross properly (a shared end point is not a crossing).
fn crosses(a: &Segment, b: &Segment) -> bool {
    let orient = |p: Point, q: Point, r: Point| {
        let v = (q.0 - p.0) * (r.1 - p.1) - (q.1 - p.1) * (r.0 - p.0);
        (v > 1e-12) as i32 - (v < -1e-12) as i32
    };
    let (p1, p2, p3, p4) = ((a[0], a[1]), (a[2], a[3]), (b[0], b[1]), (b[2], b[3]));
    orient(p3, p4, p1) * orient(p3, p4, p2) < 0 && orient(p1, p2, p3) * orient(p1, p2, p4) < 0
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: Weights = Weights { crossing: 10.0, change: 0.0 };

    fn slot(name: &str, x: f64, y: f64) -> Slot {
        Slot { name: name.into(), pin_type: "FT".into(), note: String::new(), x, y }
    }

    fn net(pin: &str, kind: Kind, end: Point) -> SwapNet {
        SwapNet { pin: pin.into(), kind, ft: false, ends: vec![end] }
    }

    fn two_pins() -> Slots {
        Slots::from([("1".into(), slot("PA1", 0.0, 0.0)), ("2".into(), slot("PA2", 0.0, 10.0))])
    }

    #[test]
    fn crossed_nets_swap() {
        let nets = Nets::from([("A".into(), net("1", Kind::Plain, (10.0, 10.0))), ("B".into(), net("2", Kind::Plain, (10.0, 0.0)))]);
        let slots = two_pins();
        let chip = Chip { nets: &nets, slots: &slots, fixed: &[] };
        let r = chip.search(0, 5, W);
        assert_eq!(r.before.crossings, 1);
        assert_eq!(r.after.crossings, 0);
        assert_eq!(r.diff.len(), 2);
    }

    #[test]
    fn exti_lines_stay_unique() {
        let nets = Nets::from([("A".into(), net("1", Kind::Exti, (0.0, 0.0))), ("B".into(), net("2", Kind::Exti, (0.0, 0.0)))]);
        let slots = Slots::from([
            ("1".into(), slot("PA1", 0.0, 0.0)),
            ("2".into(), slot("PB3", 1.0, 0.0)),
            ("3".into(), slot("PC3", 2.0, 0.0)),
            ("4".into(), slot("PC4", 3.0, 0.0)),
            ("5".into(), slot("VDD", 4.0, 0.0)),
        ]);
        let chip = Chip { nets: &nets, slots: &slots, fixed: &[] };
        let now = Assign::from([("A".to_string(), "1".to_string()), ("B".to_string(), "2".to_string())]);
        assert!(!chip.allowed("A", "3", &now), "line 3 is held by B");
        assert!(chip.allowed("A", "4", &now));
        assert!(!chip.allowed("A", "5", &now), "a pin with no line");
    }

    #[test]
    fn rules_of_a_pin() {
        assert_eq!(port_line("PB12-x"), Some(12));
        assert_eq!(port_line("VDD"), None);
        assert_eq!(base_name("PC13-TAMPER"), "PC13");
        let mut s = slot("PA1", 0.0, 0.0);
        s.note = "Reserved for boot".into();
        assert!(!usable(&s));
        s.note.clear();
        s.pin_type = "ANA".into();
        assert!(!usable(&s));
    }

    #[test]
    fn a_shared_end_is_no_crossing() {
        assert!(!crosses(&[0.0, 0.0, 2.0, 2.0], &[2.0, 2.0, 4.0, 0.0]));
        assert!(crosses(&[0.0, 0.0, 2.0, 2.0], &[0.0, 2.0, 2.0, 0.0]));
    }
}
