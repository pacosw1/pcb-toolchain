//! Moves of the annealer: translate on the grid inside the move box (a unit with in_box also keeps its courtyard in
//! that box), turn by 90/180/270 degrees, swap the places of two units whose courtyard areas differ by at most swap_ratio.
//! With soft clusters (`clustered`) a move can also take a whole group; without any, no move and no random draw changes.

use super::cluster::{Group, groups};
use crate::evaluator::{Evaluator, Move};
use crate::geom::{Rect, turn_point};
use crate::model::Model;
use crate::numeric::{PyRandom, hypot};
use crate::params::Params;
use std::collections::{BTreeMap, BTreeSet};

pub struct Mover {
    grid: f64,
    p_swap: f64,
    p_rot: f64,
    max_displacement: f64,
    area: Rect,
    movable: Vec<usize>,
    turnable: Vec<usize>,
    anchors: Vec<(f64, f64)>,
    /// Origin range per turn that keeps the courtyard rects in the region box.
    region_limits: BTreeMap<usize, [Rect; 4]>,
    partners: Vec<Vec<usize>>,
    swappable: Vec<usize>,
    groups: Vec<Group>,
    p_group: f64,
    /// The largest own step of a unit of a group, when it may move alone.
    local: BTreeMap<usize, f64>,
}

fn region_limits(model: &Model, i: usize, region: Rect) -> [Rect; 4] {
    let shape = &model.units[i];
    [0, 1, 2, 3].map(|r: usize| {
        let courtyards = shape.rects[r].iter().enumerate().filter(|(k, _)| !shape.keepout_rects.contains(k));
        let b = Rect::bounding(courtyards.map(|(_, q)| *q)).expect("a unit with a region box has a courtyard");
        Rect::new(region.x0 - b.x0, region.y0 - b.y0, region.x1 - b.x1, region.y1 - b.y1)
    })
}

fn swap_partners(model: &Model, movable: &[usize], ratio: f64) -> Vec<Vec<usize>> {
    let area = |i: usize| model.units[i].area;
    let close = |i: usize, j: usize| area(i).max(area(j)) <= ratio * area(i).min(area(j)).max(1e-9);
    let mut partners = vec![Vec::new(); model.units.len()];
    for &i in movable {
        partners[i] = movable.iter().copied().filter(|&j| j != i && close(i, j)).collect();
    }
    partners
}

impl Mover {
    pub fn new(model: &Model, p: &Params) -> Self {
        let pr = model.problem;
        let movable: Vec<usize> = (0..model.units.len()).filter(|&i| !model.units[i].fixed).collect();
        let partners = swap_partners(model, &movable, p.swap_ratio);
        let limits = movable.iter().filter_map(|&i| pr.units[i].in_box.map(|b| (i, region_limits(model, i, b))));
        Self {
            grid: p.grid,
            p_swap: p.p_swap,
            p_rot: p.p_rot,
            max_displacement: p.max_displacement,
            area: pr.move_box(),
            turnable: movable.iter().copied().filter(|&i| model.units[i].rotate).collect(),
            anchors: pr.units.iter().map(|u| (u.x, u.y)).collect(),
            region_limits: limits.collect(),
            swappable: movable.iter().copied().filter(|&i| !partners[i].is_empty()).collect(),
            partners,
            movable,
            groups: Vec::new(),
            p_group: 0.0,
            local: BTreeMap::new(),
        }
    }

    /// The moves of a clustered search. Together: a unit of a group moves only with it. Else it also moves alone inside clu_local
    /// mm. It never swaps: a swap would take it far from its pin.
    pub fn clustered(model: &Model, p: &Params, together: bool) -> Self {
        let mut mover = Self::new(model, p);
        mover.groups = groups(model);
        let grouped: BTreeSet<usize> = mover.groups.iter().flat_map(|g| g.units.iter().copied()).collect();
        mover.partners.iter_mut().for_each(|row| row.retain(|i| !grouped.contains(i)));
        let partners = std::mem::take(&mut mover.partners);
        mover.swappable.retain(|i| !grouped.contains(i) && !partners[*i].is_empty());
        mover.partners = partners;
        if together {
            mover.movable.retain(|i| !grouped.contains(i));
            mover.turnable.retain(|i| !grouped.contains(i));
        } else {
            mover.local = grouped.iter().map(|&i| (i, p.clu_local)).collect();
        }
        let (groups, alone) = (mover.groups.len() as f64, mover.movable.len() as f64);
        mover.p_group = groups / (groups + alone).max(1.0);   // Each thing to move is equally likely.
        mover
    }

    pub fn has_movable_units(&self) -> bool {
        !self.movable.is_empty()
    }

    fn snap(&self, v: f64) -> f64 {
        (v / self.grid).round_ties_even() * self.grid
    }

    /// A step snapped to the grid inside lo..hi.
    fn offset(&self, d: f64, lo: f64, hi: f64) -> f64 {
        let g = self.grid;
        self.snap(d).max((lo / g - 1e-9).ceil() * g).min((hi / g + 1e-9).floor() * g)
    }

    /// One group moves or turns as a whole; a turn goes about its first unit. A turn that would leave the box is a translate.
    fn group_move(&self, rng: &mut PyRandom, ev: &Evaluator, window: f64) -> Vec<Move> {
        let g = &self.groups[rng.below(self.groups.len())];
        let b = self.area;
        if g.turn && rng.random() < self.p_rot {
            let q = (rng.below(3) + 1) as u8;
            let (cx, cy, _) = ev.place(g.units[0]);
            let turned = |&i: &usize| {
                let (x, y, r) = ev.place(i);
                let (dx, dy) = turn_point((x - cx, y - cy), q);
                (i, (cx + dx, cy + dy, (r + q) % 4))   // No snap: repeated turns must not deform the group.
            };
            let moves: Vec<Move> = g.units.iter().map(turned).collect();
            if moves.iter().all(|(_, (x, y, _))| (b.x0..=b.x1).contains(x) && (b.y0..=b.y1).contains(y)) {
                return moves;
            }
        }
        let places: Vec<_> = g.units.iter().map(|&i| ev.place(i)).collect();
        let edge = |pick: fn(&(f64, f64, u8)) -> f64, fold: fn(f64, f64) -> f64| places.iter().map(pick).reduce(fold).expect("a group has units");
        let dx = self.offset(rng.uniform(-window, window), b.x0 - edge(|q| q.0, f64::min), b.x1 - edge(|q| q.0, f64::max));
        let dy = self.offset(rng.uniform(-window, window), b.y0 - edge(|q| q.1, f64::min), b.y1 - edge(|q| q.1, f64::max));
        g.units.iter().zip(&places).map(|(&i, &(x, y, r))| (i, (x + dx, y + dy, r))).collect()
    }

    pub fn propose(&self, rng: &mut PyRandom, ev: &Evaluator, window: f64) -> Vec<Move> {
        if !self.groups.is_empty() && rng.random() < self.p_group {
            return self.group_move(rng, ev, window);
        }
        let u = rng.random();
        if u < self.p_swap && !self.swappable.is_empty() {
            return self.swap(rng, ev);
        }
        if u < self.p_swap + self.p_rot && !self.turnable.is_empty() {
            let i = rng.choice(&self.turnable);
            let (x, y, r) = ev.place(i);
            return vec![(i, (x, y, (r as usize + rng.below(3) + 1) as u8 % 4))];
        }
        self.translate(rng, ev, window)
    }

    fn swap(&self, rng: &mut PyRandom, ev: &Evaluator) -> Vec<Move> {
        let a = rng.choice(&self.swappable);
        let b = rng.choice(&self.partners[a]);
        let ((ax, ay, ar), (bx, by, br)) = (ev.place(a), ev.place(b));
        let (dx, dy) = (self.snap(bx - ax), self.snap(by - ay));
        vec![(a, (ax + dx, ay + dy, ar)), (b, (bx - dx, by - dy, br))]
    }

    /// The box the origin of a unit may move in: inside its region box when that leaves room.
    fn allowed_box(&self, i: usize, r: u8) -> Rect {
        let b = self.area;
        let Some(limits) = self.region_limits.get(&i) else { return b };
        let l = limits[r as usize];
        let cut = Rect::new(b.x0.max(l.x0), b.y0.max(l.y0), b.x1.min(l.x1), b.y1.min(l.y1));
        if cut.x0 <= cut.x1 && cut.y0 <= cut.y1 { cut } else { b }
    }

    fn translate(&self, rng: &mut PyRandom, ev: &Evaluator, window: f64) -> Vec<Move> {
        let i = rng.choice(&self.movable);
        let window = self.local.get(&i).map_or(window, |&most| window.min(most));
        let (x, y, r) = ev.place(i);
        let b = self.allowed_box(i, r);
        let dx = self.offset(rng.uniform(-window, window), b.x0 - x, b.x1 - x);
        let dy = self.offset(rng.uniform(-window, window), b.y0 - y, b.y1 - y);
        let (dx, dy) = self.within_displacement(i, x, y, dx, dy);
        vec![(i, (x + dx, y + dy, r))]
    }

    /// A step that would leave the displacement radius, snapped toward the seed so rounding cannot exceed it.
    fn within_displacement(&self, i: usize, x: f64, y: f64, dx: f64, dy: f64) -> (f64, f64) {
        if self.max_displacement <= 0.0 {
            return (dx, dy);
        }
        let (ax, ay) = self.anchors[i];
        let (vx, vy) = (x + dx - ax, y + dy - ay);
        let length = hypot(vx, vy);
        if length <= self.max_displacement {
            return (dx, dy);
        }
        let scale = self.max_displacement / length;
        let g = self.grid;
        let (vx, vy) = ((vx * scale / g).trunc() * g, (vy * scale / g).trunc() * g);
        (ax + vx - x, ay + vy - y)
    }
}
