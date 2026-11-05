//! The grid a centreline runs on: which cell centres are closed to it.
use super::Point;

/// A cell by column and row. Either can fall outside the grid.
pub type Cell = (i64, i64);

#[derive(Debug, Clone, PartialEq)]
pub struct Lattice {
    pub x0: f64,
    pub y0: f64,
    pub g: f64,
    pub nx: i64,
    pub ny: i64,
    blocked: Vec<bool>,
}

impl Lattice {
    pub fn new(x0: f64, y0: f64, x1: f64, y1: f64, g: f64) -> Lattice {
        let (nx, ny) = (((x1 - x0) / g) as i64 + 1, ((y1 - y0) / g) as i64 + 1);
        Lattice { x0, y0, g, nx, ny, blocked: vec![false; (nx * ny) as usize] }
    }

    /// The same cells, all open.
    pub fn empty_like(&self) -> Lattice {
        Lattice { blocked: vec![false; self.blocked.len()], ..*self }
    }

    pub fn cell(&self, p: Point) -> Cell {
        (((p.0 - self.x0) / self.g).round_ties_even() as i64, ((p.1 - self.y0) / self.g).round_ties_even() as i64)
    }

    pub fn xy(&self, (i, j): Cell) -> Point {
        (self.x0 + i as f64 * self.g, self.y0 + j as f64 * self.g)
    }

    pub fn contains(&self, (i, j): Cell) -> bool {
        (0..self.nx).contains(&i) && (0..self.ny).contains(&j)
    }

    fn index(&self, (i, j): Cell) -> usize {
        (j * self.nx + i) as usize
    }

    /// Outside the grid is closed.
    pub fn is_blocked(&self, cell: Cell) -> bool {
        !self.contains(cell) || self.blocked[self.index(cell)]
    }

    pub fn set(&mut self, cell: Cell, blocked: bool) {
        if self.contains(cell) {
            let at = self.index(cell);
            self.blocked[at] = blocked;
        }
    }

    /// Every cell in row order.
    pub fn cells(&self) -> impl Iterator<Item = Cell> + use<> {
        let (nx, ny) = (self.nx, self.ny);
        (0..ny).flat_map(move |j| (0..nx).map(move |i| (i, j)))
    }

    /// Closes the cells where `test` holds.
    pub fn close_where(&mut self, test: impl Fn(Point) -> bool) {
        for cell in self.cells() {
            if test(self.xy(cell)) {
                self.set(cell, true);
            }
        }
    }

    /// Opens the cells where `test` holds.
    pub fn open_where(&mut self, test: impl Fn(Point) -> bool) {
        for cell in self.cells() {
            if test(self.xy(cell)) {
                self.set(cell, false);
            }
        }
    }

    /// Closes every cell the other lattice has closed.
    pub fn merge(&mut self, other: &Lattice) {
        self.blocked.iter_mut().zip(&other.blocked).for_each(|(mine, theirs)| *mine |= *theirs);
    }

    /// Closes the cells whose centre is closer than `r` to an item inside `bbox`, by its `distance`.
    pub fn mark(&mut self, bbox: [f64; 4], r: f64, distance: impl Fn(Point) -> f64) {
        let (i0, j0) = self.cell((bbox[0] - r, bbox[1] - r));
        let (i1, j1) = self.cell((bbox[2] + r, bbox[3] + r));
        let (i0, j0, i1, j1) = (i0.max(0), j0.max(0), i1.min(self.nx - 1), j1.min(self.ny - 1));
        for j in j0..=j1 {
            for i in i0..=i1 {
                if distance(self.xy((i, j))) < r {
                    self.set((i, j), true);
                }
            }
        }
    }
}
