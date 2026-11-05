//! The centreline search: an 8-direction A* that keeps the direction of arrival in its state, so a path has no sharp turn.
use super::Point;
use super::lattice::{Cell, Lattice};
use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::f64::consts::{FRAC_PI_4, SQRT_2};
use std::fs;
use std::path::Path;

const DIRECTIONS: [Cell; 8] = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)];
/// The cost of a 45 degree turn, in cells; a 90 degree turn costs three of them.
const TURN_COST: f64 = 0.6;
const UNREACHED: f64 = 1e18;
/// Arrive within this many 45 degree steps of the lead-in: 90 degrees.
const ARRIVAL_STEPS: i64 = 2;

fn direction_of(heading: Point) -> i64 {
    ((heading.1.atan2(heading.0) / FRAC_PI_4).round_ties_even() as i64).rem_euclid(8)
}

/// Steps of 45 degrees between two directions, from -4 to 3.
fn turn(from: i64, to: i64) -> i64 {
    (to - from + 4).rem_euclid(8) - 4
}

fn octile(from: Cell, to: Cell) -> f64 {
    let (a, b) = ((from.0 - to.0).abs(), (from.1 - to.1).abs());
    a.max(b) as f64 + (SQRT_2 - 1.0) * a.min(b) as f64
}

/// Lowest cost first; a tie goes to the lower cost so far, then the cell, then the direction, so the path never depends on heap order.
#[derive(PartialEq)]
struct Open {
    f: f64,
    g: f64,
    cell: Cell,
    direction: i64,
}

impl Eq for Open {}

impl Ord for Open {
    fn cmp(&self, other: &Open) -> Ordering {
        let mine = (self.cell.0, self.cell.1, self.direction);
        let theirs = (other.cell.0, other.cell.1, other.direction);
        other.f.total_cmp(&self.f).then(other.g.total_cmp(&self.g)).then(theirs.cmp(&mine))
    }
}

impl PartialOrd for Open {
    fn partial_cmp(&self, other: &Open) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

struct Costs<'l> {
    lattice: &'l Lattice,
    best: Vec<f64>,
    came: Vec<Option<(Cell, i64)>>,
}

impl Costs<'_> {
    fn at(&self, (i, j): Cell, direction: i64) -> usize {
        ((j * self.lattice.nx + i) * 8 + direction) as usize
    }

    fn path_to(&self, cell: Cell, direction: i64) -> Vec<Cell> {
        let mut path = vec![cell];
        let mut key = self.came[self.at(cell, direction)];
        while let Some((before, heading)) = key {
            path.push(before);
            key = self.came[self.at(before, heading)];
        }
        path.reverse();
        path
    }
}

/// The path from cell `start` to cell `goal`. The first move follows `start_heading`, the last arrives along -`goal_heading`.
pub fn astar(lattice: &Lattice, start: Cell, goal: Cell, start_heading: Point, goal_heading: Point) -> Option<Vec<Cell>> {
    let (first, last) = (direction_of(start_heading), (direction_of(goal_heading) + 4).rem_euclid(8));
    let size = (lattice.nx * lattice.ny * 8) as usize;
    let mut costs = Costs { lattice, best: vec![UNREACHED; size], came: vec![None; size] };
    let at = costs.at(start, first);
    costs.best[at] = 0.0;
    let mut heap = BinaryHeap::from([Open { f: octile(start, goal), g: 0.0, cell: start, direction: first }]);
    while let Some(Open { g, cell, direction, .. }) = heap.pop() {
        if cell == goal && turn(last, direction).abs() <= ARRIVAL_STEPS {
            return Some(costs.path_to(cell, direction));
        }
        if g > costs.best[costs.at(cell, direction)] {
            continue;
        }
        for next_direction in [direction, (direction + 1) % 8, (direction + 7) % 8, (direction + 2) % 8, (direction + 6) % 8] {
            let (di, dj) = DIRECTIONS[next_direction as usize];
            let next = (cell.0 + di, cell.1 + dj);
            if lattice.is_blocked(next) {
                continue;
            }
            let step = if di != 0 && dj != 0 { SQRT_2 } else { 1.0 };
            let bend = match turn(direction, next_direction).abs() {
                0 => 0.0,
                1 => TURN_COST,
                _ => 3.0 * TURN_COST,
            };
            let cost = g + step + bend;
            let key = costs.at(next, next_direction);
            if cost < costs.best[key] {
                costs.best[key] = cost;
                costs.came[key] = Some((cell, direction));
                heap.push(Open { f: cost + octile(next, goal), g: cost, cell: next, direction: next_direction });
            }
        }
    }
    None
}

/// The open cells reachable from `from` (8-connected), one flag per cell in row order.
pub fn flood(lattice: &Lattice, from: Cell) -> Vec<bool> {
    let mut seen = vec![false; (lattice.nx * lattice.ny) as usize];
    let mut stack = vec![from];
    while let Some(cell) = stack.pop() {
        let at = (cell.1 * lattice.nx + cell.0) as usize;
        if lattice.is_blocked(cell) || seen[at] {
            continue;
        }
        seen[at] = true;
        stack.extend(DIRECTIONS.iter().map(|d| (cell.0 + d.0, cell.1 + d.1)));
    }
    seen
}

/// A grey image of the grid: blocked black, free grey, reached from end 1 / 2 lighter (debug).
pub fn dump(lattice: &Lattice, reach: &[Vec<bool>; 2], path: &Path) -> Result<(), String> {
    let mut image = format!("P5 {} {} 255\n", lattice.nx, lattice.ny).into_bytes();
    for (at, cell) in lattice.cells().enumerate() {
        image.push(if reach[1][at] {
            255
        } else if reach[0][at] {
            200
        } else if lattice.is_blocked(cell) {
            0
        } else {
            110
        });
    }
    fs::write(path, image).map_err(|e| format!("{}: {e}", path.display()))
}
