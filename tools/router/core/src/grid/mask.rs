//! Boolean rasters over a window of the grid cells.

/// Cells `i0..i1` by `j0..j1`. A window can be empty.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Window {
    pub i0: i64,
    pub i1: i64,
    pub j0: i64,
    pub j1: i64,
}

impl Window {
    pub fn is_empty(&self) -> bool {
        self.i1 <= self.i0 || self.j1 <= self.j0
    }

    pub fn width(&self) -> usize {
        (self.i1 - self.i0).max(0) as usize
    }

    pub fn height(&self) -> usize {
        (self.j1 - self.j0).max(0) as usize
    }

    fn overlap(&self, o: &Window) -> Window {
        Window { i0: self.i0.max(o.i0), i1: self.i1.min(o.i1), j0: self.j0.max(o.j0), j1: self.j1.min(o.j1) }
    }
}

/// One bool per cell of a window, row by row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mask {
    pub window: Window,
    pub cells: Vec<bool>,
}

impl Mask {
    pub fn filled(window: Window, value: bool) -> Mask {
        Mask { window, cells: vec![value; window.width() * window.height()] }
    }

    pub fn nx(&self) -> usize {
        self.window.width()
    }

    pub fn ny(&self) -> usize {
        self.window.height()
    }

    pub fn at(&self, j: usize, i: usize) -> bool {
        self.cells[j * self.nx() + i]
    }

    pub fn set(&mut self, j: usize, i: usize, value: bool) {
        let nx = self.nx();
        self.cells[j * nx + i] = value;
    }

    pub fn count(&self) -> usize {
        self.cells.iter().filter(|c| **c).count()
    }

    pub fn any(&self) -> bool {
        self.cells.contains(&true)
    }

    pub fn inverted(&self) -> Mask {
        Mask { window: self.window, cells: self.cells.iter().map(|c| !c).collect() }
    }

    /// Both masks cover the same window.
    pub fn and(&self, o: &Mask) -> Mask {
        Mask { window: self.window, cells: self.cells.iter().zip(&o.cells).map(|(a, b)| *a && *b).collect() }
    }

    pub fn or(&self, o: &Mask) -> Mask {
        Mask { window: self.window, cells: self.cells.iter().zip(&o.cells).map(|(a, b)| *a || *b).collect() }
    }

    /// Calls `f(index in self, index in other)` for each cell the two windows share.
    pub fn for_shared(&self, other: &Mask, mut f: impl FnMut(usize, usize)) {
        let shared = self.window.overlap(&other.window);
        if shared.is_empty() {
            return;
        }
        for j in shared.j0..shared.j1 {
            for i in shared.i0..shared.i1 {
                let at = |m: &Mask| (j - m.window.j0) as usize * m.nx() + (i - m.window.i0) as usize;
                f(at(self), at(other));
            }
        }
    }

    /// The cells set in `other` set here too.
    pub fn merge(&mut self, other: &Mask) {
        let mut hits = Vec::new();
        self.for_shared(other, |mine, theirs| {
            if other.cells[theirs] {
                hits.push(mine);
            }
        });
        hits.into_iter().for_each(|k| self.cells[k] = true);
    }

    /// The cells set in `other` cleared here.
    pub fn clear_where(&mut self, other: &Mask) {
        let mut hits = Vec::new();
        self.for_shared(other, |mine, theirs| {
            if other.cells[theirs] {
                hits.push(mine);
            }
        });
        hits.into_iter().for_each(|k| self.cells[k] = false);
    }

    /// Each cell and its four neighbours.
    pub fn dilated(&self) -> Mask {
        let (nx, ny) = (self.nx(), self.ny());
        let mut out = self.clone();
        for j in 0..ny {
            for i in 0..nx {
                if self.at(j, i) {
                    if j > 0 {
                        out.set(j - 1, i, true);
                    }
                    if j + 1 < ny {
                        out.set(j + 1, i, true);
                    }
                    if i > 0 {
                        out.set(j, i - 1, true);
                    }
                    if i + 1 < nx {
                        out.set(j, i + 1, true);
                    }
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(i0: i64, i1: i64, j0: i64, j1: i64) -> Window {
        Window { i0, i1, j0, j1 }
    }

    #[test]
    fn a_merge_lands_on_the_shared_cells() {
        let mut a = Mask::filled(window(0, 4, 0, 4), false);
        let b = Mask::filled(window(2, 6, 3, 5), true);
        a.merge(&b);
        assert_eq!(a.count(), 2);
        assert!(a.at(3, 2) && a.at(3, 3));
    }

    #[test]
    fn windows_that_do_not_meet_change_nothing() {
        let mut a = Mask::filled(window(0, 2, 0, 2), true);
        a.clear_where(&Mask::filled(window(5, 6, 5, 6), true));
        assert_eq!(a.count(), 4);
    }

    #[test]
    fn dilation_grows_by_the_four_neighbours() {
        let mut a = Mask::filled(window(0, 3, 0, 3), false);
        a.set(1, 1, true);
        assert_eq!(a.dilated().count(), 5);
    }
}
