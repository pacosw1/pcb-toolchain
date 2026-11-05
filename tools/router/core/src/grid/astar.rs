//! A* over (layer, row, column) on the grid, and the path as tracks and vias.
use super::board::{GridBoard, NetGrids};
use super::item::Point;
use super::mask::{Mask, Window};
use std::cmp::Ordering;
use std::collections::BinaryHeap;

const SQ2: f64 = std::f64::consts::SQRT_2;
/// (column step, row step, length).
const MOVES: [(i64, i64, f64); 8] = [(1, 0, 1.0), (-1, 0, 1.0), (0, 1, 1.0), (0, -1, 1.0), (1, 1, SQ2), (1, -1, SQ2), (-1, 1, SQ2), (-1, -1, SQ2)];
const NO_MOVE: i8 = -1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Cell {
    pub layer: usize,
    pub j: usize,
    pub i: usize,
}

/// The costs of one search. Lengths are in cells.
pub struct Search<'a> {
    pub seeds: &'a [Mask],
    pub target: &'a [Mask],
    pub via_cost: f64,
    pub turn_cost: f64,
    /// Move cost factor per layer; 1 when empty.
    pub layer_cost: &'a [f64],
    /// (row, column) the heuristic aims at; the mean of the target cells when None.
    pub goal: Option<(f64, f64)>,
    /// Weight of the heuristic.
    pub weight: f64,
}

pub const DEFAULT_WEIGHT: f64 = 0.95;

/// sqrt(x^2 + y^2), correctly rounded as Python's math.hypot: the heap order must not depend on the last bit of a libm.
pub fn exact_hypot(x: f64, y: f64) -> f64 {
    let (xx, yy) = (x * x, y * y);
    let (x_low, y_low) = (x.mul_add(x, -xx), y.mul_add(y, -yy));
    let sum = xx + yy;
    let carry = (xx - sum) + yy;
    let low = x_low + y_low + carry;
    let h = (sum + low).sqrt();
    if h == 0.0 {
        return 0.0;
    }
    let rest = (-h).mul_add(h, sum) + low;
    h + rest / (2.0 * h)
}

struct Open {
    f: f64,
    g: f64,
    cell: Cell,
}

impl Ord for Open {
    /// Least first, in the order of the tuples of the Python heap.
    fn cmp(&self, o: &Open) -> Ordering {
        o.f.total_cmp(&self.f).then(o.g.total_cmp(&self.g)).then(o.cell.cmp(&self.cell))
    }
}

impl PartialOrd for Open {
    fn partial_cmp(&self, o: &Open) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}

impl PartialEq for Open {
    fn eq(&self, o: &Open) -> bool {
        self.cmp(o) == Ordering::Equal
    }
}

impl Eq for Open {}

/// The mean row and column of the cells any layer targets.
fn target_mean(target: &[Mask]) -> Option<(f64, f64)> {
    let (nx, ny) = (target[0].nx(), target[0].ny());
    let (mut rows, mut cols, mut n) = (0.0, 0.0, 0.0);
    for j in 0..ny {
        for i in 0..nx {
            if target.iter().any(|t| t.at(j, i)) {
                rows += j as f64;
                cols += i as f64;
                n += 1.0;
            }
        }
    }
    (n > 0.0).then(|| (rows / n, cols / n))
}

/// The search state in dense arrays, one slot per cell of every layer.
struct State {
    nx: usize,
    ny: usize,
    best: Vec<f64>,
    came: Vec<u32>,
    last_move: Vec<i8>,
    done: Vec<bool>,
}

impl State {
    fn new(layers: usize, ny: usize, nx: usize) -> State {
        let n = layers * ny * nx;
        State { nx, ny, best: vec![f64::INFINITY; n], came: vec![u32::MAX; n], last_move: vec![NO_MOVE; n], done: vec![false; n] }
    }

    fn index(&self, c: Cell) -> usize {
        (c.layer * self.ny + c.j) * self.nx + c.i
    }

    fn cell(&self, index: usize) -> Cell {
        Cell { layer: index / (self.ny * self.nx), j: index / self.nx % self.ny, i: index % self.nx }
    }

    fn path(&self, end: Cell) -> Vec<Cell> {
        let mut at = self.index(end);
        let mut path = vec![end];
        while self.came[at] != u32::MAX {
            at = self.came[at] as usize;
            path.push(self.cell(at));
        }
        path.reverse();
        path
    }
}

/// The turn cost uses the move that reached a cell, not part of the state: near-optimal with 8x less memory.
pub fn astar(grids: &NetGrids, s: &Search) -> Option<Vec<Cell>> {
    let free = &grids.free;
    let (nl, nx, ny) = (free.len(), free[0].nx(), free[0].ny());
    let any_target = target_mean(s.target)?;
    let (tj, ti) = s.goal.unwrap_or(any_target);
    let cost = |l: usize| s.layer_cost.get(l).copied().unwrap_or(1.0);
    let heuristic = |j: usize, i: usize| exact_hypot(j as f64 - tj, i as f64 - ti) * s.weight;
    let mut state = State::new(nl, ny, nx);
    let mut heap = BinaryHeap::new();
    for l in 0..nl {
        for j in 0..ny {
            for i in 0..nx {
                if s.seeds[l].at(j, i) && free[l].at(j, i) {
                    let cell = Cell { layer: l, j, i };
                    let at = state.index(cell);
                    state.best[at] = 0.0;
                    heap.push(Open { f: heuristic(j, i), g: 0.0, cell });
                }
            }
        }
    }
    while let Some(Open { g, cell, .. }) = heap.pop() {
        let at = state.index(cell);
        if state.done[at] {
            continue;
        }
        state.done[at] = true;
        let Cell { layer: l, j, i } = cell;
        if s.target[l].at(j, i) {
            return Some(state.path(cell));
        }
        let last = state.last_move[at];
        let mut relax = |state: &mut State, next: Cell, ng: f64, step: i8| {
            let to = state.index(next);
            if ng < state.best[to] {
                state.best[to] = ng;
                state.came[to] = at as u32;
                state.last_move[to] = step;
                heap.push(Open { f: ng + heuristic(next.j, next.i), g: ng, cell: next });
            }
        };
        for (k, (di, dj, length)) in MOVES.iter().enumerate() {
            let (ii, jj) = (i as i64 + di, j as i64 + dj);
            if ii < 0 || jj < 0 || ii >= nx as i64 || jj >= ny as i64 {
                continue;
            }
            let (ii, jj) = (ii as usize, jj as usize);
            let row = &free[l];
            if !row.at(jj, ii) || (*di != 0 && *dj != 0 && !(row.at(j, ii) && row.at(jj, i))) {
                continue;
            }
            let next = Cell { layer: l, j: jj, i: ii };
            if state.done[state.index(next)] {
                continue;
            }
            let turn = if last != NO_MOVE && last != k as i8 { s.turn_cost } else { 0.0 };
            relax(&mut state, next, g + length * cost(l) + turn, k as i8);
        }
        if grids.via_ok.at(j, i) {
            for m in 0..nl {
                let next = Cell { layer: m, j, i };
                if m != l && free[m].at(j, i) && !state.done[state.index(next)] {
                    relax(&mut state, next, g + s.via_cost, NO_MOVE);
                }
            }
        }
    }
    None
}

/// One piece of a path: a straight run on a layer of the job, or a via.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PathItem {
    Segment { layer: usize, a: Point, b: Point },
    Via(Point),
}

/// The length of a path's tracks, mm.
pub fn track_length(items: &[PathItem]) -> f64 {
    items.iter().map(|it| if let PathItem::Segment { a, b, .. } = it { (a.0 - b.0).hypot(a.1 - b.1) } else { 0.0 }).sum()
}

/// (tracks, vias) of a path.
pub fn counts(items: &[PathItem]) -> (usize, usize) {
    let vias = items.iter().filter(|it| matches!(it, PathItem::Via(_))).count();
    (items.len() - vias, vias)
}

/// Cells as tracks and vias, collinear runs merged.
pub fn to_items(grid: &GridBoard, window: &Window, path: &[Cell]) -> Vec<PathItem> {
    let points: Vec<(usize, f64, f64)> = path.iter().map(|c| {
        let (x, y) = grid.centre(window, c.j, c.i);
        (c.layer, x, y)
    }).collect();
    let mut out = Vec::new();
    let mut run = vec![points[0]];
    let close = |run: &[(usize, f64, f64)], out: &mut Vec<PathItem>| {
        if let (Some(first), Some(last), true) = (run.first(), run.last(), run.len() > 1) {
            out.push(PathItem::Segment { layer: first.0, a: (first.1, first.2), b: (last.1, last.2) });
        }
    };
    for &p in &points[1..] {
        let last = run[run.len() - 1];
        if p.0 != last.0 {
            close(&run, &mut out);
            out.push(PathItem::Via((p.1, p.2)));
            run = vec![p];
        } else if run.len() >= 2 {
            let before = run[run.len() - 2];
            if ((last.1 - before.1) * (p.2 - last.2) - (last.2 - before.2) * (p.1 - last.1)).abs() < 1e-9 {
                *run.last_mut().expect("a run has points") = p;
            } else {
                close(&run, &mut out);
                run = vec![last, p];
            }
        } else {
            run.push(p);
        }
    }
    close(&run, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(nx: i64, ny: i64) -> Window {
        Window { i0: 0, i1: nx, j0: 0, j1: ny }
    }

    fn grids(layers: usize, nx: i64, ny: i64) -> NetGrids {
        NetGrids { free: vec![Mask::filled(window(nx, ny), true); layers], via_ok: Mask::filled(window(nx, ny), true), owners: Vec::new() }
    }

    fn at(layers: usize, nx: i64, ny: i64, layer: usize, j: usize, i: usize) -> Vec<Mask> {
        let mut m = vec![Mask::filled(window(nx, ny), false); layers];
        m[layer].set(j, i, true);
        m
    }

    fn search<'a>(seeds: &'a [Mask], target: &'a [Mask]) -> Search<'a> {
        Search { seeds, target, via_cost: 8.0, turn_cost: 1.0, layer_cost: &[], goal: None, weight: DEFAULT_WEIGHT }
    }

    #[test]
    fn hypot_is_exact_on_a_pythagorean_triple_and_keeps_sign_free() {
        assert_eq!(exact_hypot(3.0, 4.0), 5.0);
        assert_eq!(exact_hypot(-3.0, 4.0), 5.0);
        assert_eq!(exact_hypot(0.0, 0.0), 0.0);
        assert_eq!(exact_hypot(1.0, 1.0), std::f64::consts::SQRT_2);
    }

    #[test]
    fn a_straight_run_is_one_path_of_cells() {
        let g = grids(1, 6, 1);
        let (s, t) = (at(1, 6, 1, 0, 0, 0), at(1, 6, 1, 0, 0, 5));
        let path = astar(&g, &search(&s, &t)).unwrap();
        assert_eq!((path.len(), path[5].i), (6, 5));
    }

    #[test]
    fn a_diagonal_needs_both_corners_free() {
        let mut g = grids(1, 2, 2);
        g.free[0].set(0, 1, false);
        g.free[0].set(1, 0, false);
        let (s, t) = (at(1, 2, 2, 0, 0, 0), at(1, 2, 2, 0, 1, 1));
        assert!(astar(&g, &search(&s, &t)).is_none());
    }

    #[test]
    fn a_wall_is_crossed_by_a_via() {
        let mut g = grids(2, 5, 1);
        g.free[0].set(0, 2, false);
        let (s, t) = (at(2, 5, 1, 0, 0, 0), at(2, 5, 1, 0, 0, 4));
        let path = astar(&g, &search(&s, &t)).unwrap();
        assert!(path.iter().any(|c| c.layer == 1), "{path:?}");
    }

    #[test]
    fn no_target_is_no_path() {
        let g = grids(1, 3, 1);
        let none = vec![Mask::filled(window(3, 1), false)];
        assert!(astar(&g, &search(&at(1, 3, 1, 0, 0, 0), &none)).is_none());
    }

    #[test]
    fn a_dear_layer_is_left_for_a_cheap_one() {
        let g = grids(2, 40, 1);
        let (s, t) = (at(2, 40, 1, 0, 0, 0), at(2, 40, 1, 0, 0, 39));
        let dear = [3.0, 1.0];
        let path = astar(&g, &Search { layer_cost: &dear, ..search(&s, &t) });
        assert!(path.is_none() || path.unwrap().iter().any(|c| c.layer == 1));
    }
}
