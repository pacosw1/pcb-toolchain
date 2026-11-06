//! Incremental cost: `propose` applies a move and returns the cost delta; then `commit` or `revert`.
//!
//! Cost = w_wl * HPWL + w_cong * RUDY overflow + w_ov * hard overlap + w_oob * forbidden area + w_sp * soft spacing
//!      + w_via * blocked via pads + w_x * crossings + w_row * rows + w_esc * pin-escape deficit + w_mst * net MST.
//! A term at weight 0 is not computed.

use crate::crossing::CrossState;
use crate::domain::AreaState;
use crate::escape::EscapeState;
use crate::geom::{Rect, turn_point};
use crate::layout::Layout;
use crate::model::{Model, UnitShape};
use crate::numeric::{compensated, hypot};
use crate::params::Params;
use crate::problem::{Board, EdgeAnchor, NearRule, Place, Pose};
use crate::rows::{RowState, row_groups};
use crate::rudy::NetState;
use crate::spacing::{Side, penalty};
use crate::via::ViaState;
use crate::wirelen::WirelenState;
use serde::Serialize;
use std::collections::BTreeSet;

/// One term per cost component.
#[derive(Clone, Copy, Debug, Default, Serialize, serde::Deserialize, PartialEq)]
pub struct Terms {
    pub hpwl: f64,
    pub cong: f64,
    pub overlap: f64,
    pub oob: f64,
    pub spacing: f64,
    pub via: f64,
    pub crossing: f64,
    pub row: f64,
    pub escape: f64,
    pub wirelen: f64,
}

impl Terms {
    fn weighted(&self, p: &Params) -> f64 {
        p.w_wl * self.hpwl
            + p.w_cong * self.cong
            + p.w_ov * self.overlap
            + p.w_oob * self.oob
            + p.w_sp * self.spacing
            + p.w_via * self.via
            + p.w_x * self.crossing
            + p.w_row * self.row
            + p.w_esc * self.escape
            + p.w_mst * self.wirelen
    }

    fn add(&mut self, d: &Self) {
        self.hpwl += d.hpwl;
        self.cong += d.cong;
        self.overlap += d.overlap;
        self.oob += d.oob;
        self.spacing += d.spacing;
        self.via += d.via;
        self.crossing += d.crossing;
        self.row += d.row;
        self.escape += d.escape;
        self.wirelen += d.wirelen;
    }
}

/// A unit and its new place.
pub type Move = (usize, Place);

/// The miss of an edge anchor in mm beyond its tolerance.
fn edge_miss(e: &EdgeAnchor, (x, y, r): Place, board: &Board, outline: Rect) -> f64 {
    let c = e.inset.unwrap_or(board.edge_clearance);
    let (ax, ay) = turn_point(e.at, r);
    let (ax, ay) = (ax + x, ay + y);
    let side = |s: char| match s {
        'L' => (ax - outline.x0 - c).abs(),
        'R' => (outline.x1 - c - ax).abs(),
        'T' => (ay - outline.y0 - c).abs(),
        _ => (outline.y1 - c - ay).abs(),
    };
    (e.sides.chars().map(side).fold(f64::INFINITY, f64::min) - e.tol).max(0.0)
}

/// The miss in mm of the courtyard rects from the region box: the sum of the four overshoots.
fn box_miss(region: Rect, rects: &[Rect], keepouts: &BTreeSet<usize>) -> f64 {
    let courtyards = rects.iter().enumerate().filter(|(k, _)| !keepouts.contains(k)).map(|(_, r)| *r);
    let Some(b) = Rect::bounding(courtyards) else { return 0.0 };
    (region.x0 - b.x0).max(0.0) + (region.y0 - b.y0).max(0.0) + (b.x1 - region.x1).max(0.0) + (b.y1 - region.y1).max(0.0)
}

/// The sum over the near rules of the distance beyond d from the local point to the fixed world point.
fn near_miss(rules: &[NearRule], (x, y, r): Place) -> f64 {
    let miss = |&NearRule(lx, ly, wx, wy, d): &NearRule| {
        let (ax, ay) = turn_point((lx, ly), r);
        (hypot(x + ax - wx, y + ay - wy) - d).max(0.0)
    };
    rules.iter().map(miss).fold(0.0, |sum, m| sum + m)
}

fn world(local: &Option<[Vec<Rect>; 4]>, (x, y, r): Place) -> Option<Vec<Rect>> {
    local.as_ref().map(|turns| turns[r as usize].iter().map(|q| q.shifted(x, y)).collect())
}

struct Undo {
    places: Vec<(usize, Place)>,
    forbidden: Vec<(usize, f64)>,
    terms: Terms,
    cost: f64,
}

pub struct Evaluator<'m> {
    model: &'m Model<'m>,
    params: Params,
    layout: Layout,
    forbidden: Vec<f64>,
    nets: NetState,
    areas: AreaState,
    vias: ViaState,
    crossings: CrossState,
    rows: RowState,
    escape: Option<EscapeState>,
    wirelen: Option<WirelenState>,
    terms: Terms,
    cost: f64,
    undo: Option<Undo>,
    last_places: Vec<(usize, Place)>,
}

impl<'m> Evaluator<'m> {
    /// `params`: the model parameters with the weights of this epoch.
    pub fn new(model: &'m Model<'m>, params: &Params, pose: &[Place]) -> Self {
        let layout = Layout::new(model, pose);
        let p = &model.params;
        let groups = if p.w_row != 0.0 { row_groups(model.problem) } else { Vec::new() };
        let mut ev = Self {
            params: params.clone(),
            forbidden: vec![0.0; model.units.len()],
            nets: NetState::new(model, &layout),
            areas: AreaState::new(model, &layout),
            vias: ViaState::new(model, &layout),
            crossings: CrossState::new(model, &layout),
            rows: RowState::new(groups, p.row_pitch, &layout),
            escape: model.escape.as_ref().map(|e| EscapeState::new(model, e, &layout)),
            wirelen: model.wirelen.as_ref().map(|w| WirelenState::new(w, &layout)),
            layout,
            model,
            terms: Terms::default(),
            cost: 0.0,
            undo: None,
            last_places: Vec::new(),
        };
        for i in (0..model.units.len()).filter(|&i| !model.units[i].fixed) {
            ev.forbidden[i] = ev.forbidden_area(i);
        }
        ev.terms = ev.fresh_terms();
        ev.cost = ev.terms.weighted(&ev.params);
        ev
    }

    fn fresh_terms(&self) -> Terms {
        let (hard, soft) = self.all_pairs();
        Terms {
            hpwl: self.nets.wirelength(self.model),
            cong: self.nets.congestion(self.model),
            overlap: hard + self.areas.total(),
            oob: compensated(self.forbidden.iter().copied()),
            spacing: soft,
            via: self.vias.total(),
            crossing: self.crossings.total(),
            row: self.rows.total(),
            escape: self.escape.as_ref().map_or(0.0, EscapeState::total),
            wirelen: self.wirelen.as_ref().map_or(0.0, WirelenState::total),
        }
    }

    pub fn cost(&self) -> f64 {
        self.cost
    }

    pub fn terms(&self) -> Terms {
        self.terms
    }

    pub fn pose(&self) -> Pose {
        self.layout.pose()
    }

    pub fn place(&self, i: usize) -> Place {
        self.layout.place(i)
    }

    /// The place of unit i in the problem, the origin of its displacement.
    pub fn anchor(&self, i: usize) -> (f64, f64) {
        let u = &self.model.problem.units[i];
        (u.x, u.y)
    }

    pub fn shape(&self, i: usize) -> &UnitShape {
        &self.model.units[i]
    }

    /// Exact edge eligibility at a trial place, without changing any search cost or state.
    pub fn edge_miss_at(&self, i: usize, place: Place) -> bool {
        self.model.edge_miss_at(i, place)
    }

    pub fn unit_count(&self) -> usize {
        self.model.units.len()
    }

    /// (hard, soft) of units i and j.
    fn pair(&self, i: usize, j: usize) -> (f64, f64) {
        let side = |k: usize| Side { set: &self.model.units[k].set, rects: self.layout.world(k) };
        penalty(side(i), side(j), self.model.class_table.as_ref())
    }

    /// (hard, soft) of unit i with the units near it, without the skipped ones.
    fn unit_pairs(&self, i: usize, skip: impl Fn(usize) -> bool) -> (f64, f64) {
        let b = self.layout.reach[i];
        let near = (0..self.unit_count()).filter(|&j| self.layout.reach[j].meets(b));
        near.filter(|&j| j != i && !skip(j)).fold((0.0, 0.0), |(h, s), j| {
            let (a, c) = self.pair(i, j);
            (h + a, s + c)
        })
    }

    /// Movable-movable pairs once, movable-fixed pairs always.
    fn all_pairs(&self) -> (f64, f64) {
        let units = &self.model.units;
        (0..units.len()).filter(|&i| !units[i].fixed).fold((0.0, 0.0), |(h, s), i| {
            let (a, b) = self.unit_pairs(i, |j| j < i && !units[j].fixed);
            (h + a, s + b)
        })
    }

    fn moved_pairs(&self, moved: &[usize]) -> (f64, f64) {
        let (mut h, mut s) = (0.0, 0.0);
        for &i in moved {
            let (a, b) = self.unit_pairs(i, |j| moved.contains(&j));
            (h, s) = (h + a, s + b);
        }
        for (n, &a) in moved.iter().enumerate() {
            for &b in &moved[n + 1..] {
                let (x, y) = self.pair(a, b);
                (h, s) = (h + x, s + y);
            }
        }
        (h, s)
    }

    /// `sum` plus the edge anchor, region box and near rule misses of unit i, in mm.
    fn with_rule_misses(&self, i: usize, sum: f64) -> f64 {
        let u = &self.model.problem.units[i];
        let place = self.layout.place(i);
        let board = &self.model.problem.board;
        let edge = u.edge.as_ref().map_or(0.0, |e| edge_miss(e, place, board, self.model.outline_box));
        let region = u.in_box.map_or(0.0, |b| box_miss(b, self.layout.world(i), &self.model.units[i].keepout_rects));
        sum + edge + region + near_miss(&u.near, place)
    }

    fn locked_and_gap_area(&self, i: usize, edge_pads: Option<&[Rect]>) -> (f64, f64) {
        let mask = &self.model.mask;
        let layers = self.model.problem.units[i].pad_copper_layers.as_deref();
        (mask.locked_area(edge_pads, layers), mask.gap_area(self.layout.world(i), &self.model.units[i].domain_rects))
    }

    pub fn forbidden_area(&self, i: usize) -> f64 {
        let s = &self.model.units[i];
        let place = self.layout.place(i);
        let pads = world(&s.pad_rects, place);
        let edge_pads = world(&s.edge_pads, place);
        let area = self.model.mask.unit_area(self.layout.world(i), pads.as_deref(), &s.keepout_rects, edge_pads.as_deref());
        let (locked, gap) = self.locked_and_gap_area(i, edge_pads.as_deref());
        self.with_rule_misses(i, area + locked + gap)
    }

    /// Spacing overlap + edge/keepout area (0 = legal). Kept copper is a cost only: the writer rips up the copper
    /// that a moved pad lands on.
    pub fn legal_penalty(&self, i: usize) -> f64 {
        let s = &self.model.units[i];
        let edge_pads = world(&s.edge_pads, self.layout.place(i));
        let overlap = self.unit_pairs(i, |_| false).0 + self.areas.unit_overlap(self.model, &self.layout, i);
        let edge = self.model.mask.edge_area(self.layout.world(i), &s.keepout_rects, edge_pads.as_deref());
        let (locked, gap) = self.locked_and_gap_area(i, edge_pads.as_deref());
        self.with_rule_misses(i, overlap + edge + locked + gap) + self.hard_escape(i) + self.engineering_miss(i)
    }

    /// The reviewed contract of the problem counts against legality only: it plays no part in the search cost.
    fn engineering_miss(&self, i: usize) -> f64 {
        self.model.problem.contract.as_ref().map_or(0.0, |contract| contract.miss(i, &self.pose()))
    }

    fn hard_escape(&self, i: usize) -> f64 {
        match (&self.escape, &self.model.escape) {
            (Some(state), Some(esc)) if self.model.params.esc_hard != 0.0 => {
                state.hard_sides(self.model, esc, &self.layout, i) as f64
            }
            _ => 0.0,
        }
    }

    /// `legal_penalty` with unit i at a trial place; the state does not change.
    pub fn legal_penalty_at(&mut self, i: usize, place: Place) -> f64 {
        let old = self.layout.place(i);
        self.layout.set(self.model, i, place);
        let penalty = self.legal_penalty(i);
        self.layout.set(self.model, i, old);
        penalty
    }

    fn moved_nets(&self, moved: &[usize]) -> Vec<usize> {
        let mut nets: Vec<usize> = moved.iter().flat_map(|&i| self.model.unit_nets[i].iter().copied()).collect();
        nets.sort_unstable();
        nets.dedup();
        nets
    }

    /// Apply a move and return the cost delta. Panics on a fixed unit or an open proposal.
    pub fn propose(&mut self, moves: &[Move]) -> f64 {
        assert!(self.undo.is_none(), "propose() before commit()/revert()");
        let model = self.model;
        let moved: Vec<usize> = moves.iter().map(|m| m.0).collect();
        assert!(moved.iter().all(|&i| !model.units[i].fixed), "a fixed unit cannot move");
        let places: Vec<_> = moved.iter().map(|&i| (i, self.layout.place(i))).collect();
        self.last_places.clone_from(&places);
        let (overlap_before, spacing_before) = self.moved_pairs(&moved);
        let forbidden_before = compensated(moved.iter().map(|&i| self.forbidden[i]));
        self.vias.before_move(model, &self.layout, &moved);
        self.nets.before_move(model, &self.layout, &moved);
        if let Some(e) = &mut self.escape {
            e.before_move(&self.layout, &moved);
        }
        for &(i, place) in moves {
            self.layout.set(model, i, place);
        }
        let (overlap_after, spacing_after) = self.moved_pairs(&moved);
        let area_delta = self.areas.after_move(model, &self.layout, &moved);
        let via = self.vias.after_move(model, &self.layout, &moved);
        let old_forbidden = moved.iter().map(|&i| (i, self.forbidden[i])).collect();
        for &i in &moved {
            self.forbidden[i] = self.forbidden_area(i);
        }
        let forbidden_after = compensated(moved.iter().map(|&i| self.forbidden[i]));
        let nets = self.moved_nets(&moved);
        let (hpwl, cong) = self.nets.after_move(model, &self.layout, &moved, &nets);
        let delta = Terms {
            hpwl,
            cong,
            overlap: (overlap_after + area_delta) - overlap_before,
            oob: forbidden_after - forbidden_before,
            spacing: spacing_after - spacing_before,
            via,
            crossing: self.crossings.after_move(model, &self.layout, &nets),
            row: self.rows.after_move(&self.layout, &moved),
            escape: self.escape_delta(&moved),
            wirelen: self.wirelen_delta(&nets),
        };
        let weighted = delta.weighted(&self.params);
        self.undo = Some(Undo { places, forbidden: old_forbidden, terms: self.terms, cost: self.cost });
        self.terms.add(&delta);
        self.cost += weighted;
        weighted
    }

    fn escape_delta(&mut self, moved: &[usize]) -> f64 {
        match (&mut self.escape, &self.model.escape) {
            (Some(state), Some(esc)) => state.after_move(self.model, esc, &self.layout, moved),
            _ => 0.0,
        }
    }

    fn wirelen_delta(&mut self, nets: &[usize]) -> f64 {
        match (&mut self.wirelen, &self.model.wirelen) {
            (Some(state), Some(w)) => state.after_move(w, &self.layout, nets),
            _ => 0.0,
        }
    }

    pub fn commit(&mut self) {
        self.undo = None;
        self.nets.commit();
        self.areas.commit();
    }

    pub fn revert(&mut self) {
        let undo = self.undo.take().expect("revert() needs a proposal");
        for (i, place) in undo.places {
            self.layout.set(self.model, i, place);
        }
        for (i, area) in undo.forbidden {
            self.forbidden[i] = area;
        }
        self.nets.revert(self.model);
        self.areas.revert();
        self.vias.revert();
        self.crossings.revert();
        self.rows.revert();
        if let Some(e) = &mut self.escape {
            e.revert();
        }
        if let Some(w) = &mut self.wirelen {
            w.revert();
        }
        (self.terms, self.cost) = (undo.terms, undo.cost);
    }

    /// The pose before the last proposal: the moved units back at their old places.
    pub fn pose_before_last_move(&self) -> Pose {
        let mut pose = self.pose();
        self.last_places.iter().for_each(|&(i, place)| pose[i] = place);
        pose
    }
}
