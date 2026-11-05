//! Forbidden cells of the board, as summed-area tables: the area of a rect on a table is four lookups.
//!
//! Tables: outside the outline; that plus keepouts (courtyards and borders); plus the edge_clearance band (pads, DRC
//! copper-to-edge); kept F.Cu copper and vias grown by gap; locked copper per layer; keepouts grown by a class gap.

use crate::geom::{EPS, Point, Rect, point_in_poly, poly_edge_d2, segment_d2};
use crate::numeric::compensated;
use crate::problem::{Board, CopperRow};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, RwLock};

const MARGIN: f64 = 2.0;
/// Kept copper that a top-side part must not cover.
const OBSTACLE_LAYERS: [&str; 2] = ["F.Cu", "via"];

/// Cells [lo, hi) that a span touches: unclipped, then clipped to 0..n. At least one cell before the clip.
pub fn cell_range(a0: f64, a1: f64, origin: f64, cell: f64, n: usize) -> (i64, i64, i64, i64) {
    let lo = ((a0 - origin) / cell + EPS).floor() as i64;
    let hi = ((a1 - origin) / cell - EPS).ceil() as i64;
    let hi = if hi <= lo { lo + 1 } else { hi };
    (lo, hi, lo.max(0), hi.min(n as i64))
}

/// A grid of flags, row major.
#[derive(Clone)]
struct Bitmap {
    nx: usize,
    ny: usize,
    cells: Vec<bool>,
}

impl Bitmap {
    fn empty(nx: usize, ny: usize) -> Self {
        Self { nx, ny, cells: vec![false; nx * ny] }
    }

    fn union(&mut self, other: &Self) {
        self.cells.iter_mut().zip(&other.cells).for_each(|(a, b)| *a |= b);
    }
}

/// Summed-area table of a Bitmap.
pub struct Table {
    width: usize,
    sums: Vec<i64>,
}

impl Table {
    fn new(map: &Bitmap) -> Self {
        let width = map.nx + 1;
        let mut sums = vec![0; width * (map.ny + 1)];
        for j in 0..map.ny {
            for i in 0..map.nx {
                sums[(j + 1) * width + i + 1] = map.cells[j * map.nx + i] as i64 + sums[j * width + i + 1]
                    + sums[(j + 1) * width + i]
                    - sums[j * width + i];
            }
        }
        Self { width, sums }
    }

    fn count(&self, j0: usize, j1: usize, i0: usize, i1: usize) -> i64 {
        let at = |j: usize, i: usize| self.sums[j * self.width + i];
        at(j1, i1) - at(j0, i1) - at(j1, i0) + at(j0, i0)
    }
}

pub struct Mask {
    x0: f64,
    y0: f64,
    cell: f64,
    nx: usize,
    ny: usize,
    outline: Table,
    forbidden: Table,
    edge: Table,
    band: Table,
    copper: Table,
    locked: BTreeMap<String, Bitmap>,
    locked_unions: RwLock<BTreeMap<Vec<String>, Arc<Table>>>,
    class_gaps: BTreeMap<i64, Table>,
}

impl Mask {
    pub fn new(board: &Board, cell: f64, gap: f64) -> crate::Result<Self> {
        let b = board.outline_box();
        let (x0, y0) = (b.x0 - MARGIN, b.y0 - MARGIN);
        let nx = ((b.x1 - b.x0 + 2.0 * MARGIN) / cell).ceil() as usize;
        let ny = ((b.y1 - b.y0 + 2.0 * MARGIN) / cell).ceil() as usize;
        let grid = CellGrid { x0, y0, cell, nx, ny };
        let outside = grid.map(|p| !point_in_poly(p, &board.outline));
        let keepouts = grid.map(|p| board.keepouts.iter().any(|k| point_in_poly(p, k)));
        let mut edge = outside.clone();
        edge.union(&keepouts);
        let mut band = grid_dilated(&outside, (board.edge_clearance / cell - EPS).ceil() as i64);
        band.union(&keepouts);
        let copper = grid.copper(board.copper.iter().filter(|r| OBSTACLE_LAYERS.contains(&r.0.as_str())), gap);
        let mut forbidden = edge.clone();
        forbidden.union(&copper);
        Ok(Self {
            x0,
            y0,
            cell,
            nx,
            ny,
            outline: Table::new(&outside),
            forbidden: Table::new(&forbidden),
            edge: Table::new(&edge),
            band: Table::new(&band),
            copper: Table::new(&copper),
            locked: grid.locked(board.locked_copper(), gap),
            locked_unions: RwLock::default(),
            class_gaps: grid.class_gaps(board)?,
        })
    }

    /// Area of the rect on a table. `outside`: cells beyond the grid count as forbidden.
    fn rect_area(&self, r: Rect, table: &Table, outside: bool) -> f64 {
        let c = self.cell;
        let (a0, a1, i0, i1) = cell_range(r.x0, r.x1, self.x0, c, self.nx);
        let (b0, b1, j0, j1) = cell_range(r.y0, r.y1, self.y0, c, self.ny);
        let total = if outside { (a1 - a0) * (b1 - b0) } else { 0 };
        if i1 <= i0 || j1 <= j0 {
            return total as f64 * c * c;
        }
        let inside = if outside { (i1 - i0) * (j1 - j0) } else { 0 };
        let bad = table.count(j0 as usize, j1 as usize, i0 as usize, i1 as usize);
        (total - inside + bad) as f64 * c * c
    }

    /// Outside-the-outline area of the rects that lies inside a keepout rect of the same unit (an antenna zone over
    /// an outline notch): legal, so it is taken off.
    fn overhang(&self, rects: &[Rect], ko: &BTreeSet<usize>) -> f64 {
        let mut total = 0.0;
        for r in Self::courtyards(rects, ko) {
            for &j in ko {
                let q = rects[j];
                let cut = Rect::new(r.x0.max(q.x0), r.y0.max(q.y0), r.x1.min(q.x1), r.y1.min(q.y1));
                if cut.x1 > cut.x0 && cut.y1 > cut.y0 {
                    total += self.rect_area(cut, &self.outline, true);
                }
            }
        }
        total
    }

    fn courtyards<'r>(rects: &'r [Rect], ko: &'r BTreeSet<usize>) -> impl Iterator<Item = Rect> + 'r {
        rects.iter().enumerate().filter(|(k, _)| !ko.contains(k)).map(|(_, r)| *r)
    }

    /// Area of the rects outside the board or in a keepout, and of the pads in the copper-to-edge band. Kept copper
    /// does not count; keepout rects do not count.
    pub fn edge_area(&self, rects: &[Rect], ko: &BTreeSet<usize>, pads: Option<&[Rect]>) -> f64 {
        compensated(Self::courtyards(rects, ko).map(|r| self.rect_area(r, &self.edge, true)))
            - self.overhang(rects, ko)
            + self.band_area(pads)
    }

    fn band_area(&self, pads: Option<&[Rect]>) -> f64 {
        compensated(pads.unwrap_or(&[]).iter().map(|r| self.rect_area(*r, &self.band, true)))
    }

    fn copper_area(&self, rects: impl Iterator<Item = Rect>) -> f64 {
        compensated(rects.map(|r| self.rect_area(r, &self.copper, false)))
    }

    /// Area of the domain pads within the keepout gap of their class. `dom` = (rect index, class).
    pub fn gap_area(&self, rects: &[Rect], dom: &[(usize, i64)]) -> f64 {
        compensated(dom.iter().filter_map(|(k, class)| {
            self.class_gaps.get(class).map(|table| self.rect_area(rects[*k], table, false))
        }))
    }

    /// Forbidden area of a unit: courtyard rects against all, or (pads given) rects against the edge table and pads
    /// against the copper table; edge pads against the band. Keepout rects count only kept copper.
    pub fn unit_area(&self, rects: &[Rect], pads: Option<&[Rect]>, ko: &BTreeSet<usize>, edge_pads: Option<&[Rect]>) -> f64 {
        let t = self.copper_area(ko.iter().map(|k| rects[*k])) + self.band_area(edge_pads);
        match pads {
            None => {
                t + compensated(Self::courtyards(rects, ko).map(|r| self.rect_area(r, &self.forbidden, true)))
                    - self.overhang(rects, ko)
            }
            Some(pads) => t + self.edge_area(rects, ko, None) + self.copper_area(pads.iter().copied()),
        }
    }

    /// Locked copper under pads on shared layers. An unknown membership (None, or no layer rows) obstructs every
    /// copper layer; an empty membership (NPTH) has no copper.
    pub fn locked_area(&self, pads: Option<&[Rect]>, layers: Option<&[Option<Vec<String>>]>) -> f64 {
        let mut total = 0.0;
        for (i, pad) in pads.unwrap_or(&[]).iter().enumerate() {
            let membership = layers.and_then(|l| l[i].as_deref());
            if membership.is_some_and(<[String]>::is_empty) {
                continue;
            }
            let key = self.locked_key(membership);
            if !key.is_empty() {
                total += self.rect_area(*pad, &*self.locked_table(key), false);
            }
        }
        total
    }

    fn locked_key(&self, membership: Option<&[String]>) -> Vec<String> {
        let shared = |layer: &&String| {
            membership.is_none_or(|m| layer.as_str() == "via" || m.iter().any(|l| &l == layer))
        };
        self.locked.keys().filter(shared).cloned().collect()
    }

    fn locked_table(&self, key: Vec<String>) -> Arc<Table> {
        if let Some(t) = self.locked_unions.read().expect("no writer panics").get(&key) {
            return t.clone();
        }
        let mut union = Bitmap::empty(self.nx, self.ny);
        key.iter().for_each(|layer| union.union(&self.locked[layer]));
        let table = Arc::new(Table::new(&union));
        self.locked_unions.write().expect("no writer panics").insert(key, table.clone());
        table
    }
}

/// Cell centres of the mask.
struct CellGrid {
    x0: f64,
    y0: f64,
    cell: f64,
    nx: usize,
    ny: usize,
}

impl CellGrid {
    fn centre(&self, n: usize, origin: f64) -> f64 {
        origin + (n as f64 + 0.5) * self.cell
    }

    fn map(&self, test: impl Fn(Point) -> bool) -> Bitmap {
        let mut m = Bitmap::empty(self.nx, self.ny);
        for j in 0..self.ny {
            for i in 0..self.nx {
                m.cells[j * self.nx + i] = test((self.centre(i, self.x0), self.centre(j, self.y0)));
            }
        }
        m
    }

    /// Mark the cells whose centre is within r of the segment.
    fn stamp_segment(&self, out: &mut Bitmap, row: &CopperRow, gap: f64) {
        let CopperRow(_, a0, b0, a1, b1, w) = *row;
        let r = w / 2.0 + gap;
        let first = |lo: f64, origin: f64| (((lo - r - origin) / self.cell) as i64).max(0) as usize;
        let last = |hi: f64, origin: f64, n: usize| (((hi + r - origin) / self.cell) as i64 + 2).clamp(0, n as i64) as usize;
        let (i0, i1) = (first(a0.min(a1), self.x0), last(a0.max(a1), self.x0, self.nx));
        let (j0, j1) = (first(b0.min(b1), self.y0), last(b0.max(b1), self.y0, self.ny));
        for j in j0..j1 {
            for i in i0..i1 {
                let p = (self.centre(i, self.x0), self.centre(j, self.y0));
                if segment_d2(p, (a0, b0), (a1, b1)) <= r * r {
                    out.cells[j * self.nx + i] = true;
                }
            }
        }
    }

    fn copper<'r>(&self, rows: impl Iterator<Item = &'r CopperRow>, gap: f64) -> Bitmap {
        let mut m = Bitmap::empty(self.nx, self.ny);
        rows.for_each(|row| self.stamp_segment(&mut m, row, gap));
        m
    }

    fn locked(&self, rows: &[CopperRow], gap: f64) -> BTreeMap<String, Bitmap> {
        let mut out: BTreeMap<String, Bitmap> = BTreeMap::new();
        for row in rows {
            let map = out.entry(row.0.clone()).or_insert_with(|| Bitmap::empty(self.nx, self.ny));
            self.stamp_segment(map, row, gap);
        }
        out
    }

    fn class_gaps(&self, board: &Board) -> crate::Result<BTreeMap<i64, Table>> {
        let polys: Vec<_> = board.keepouts.iter().chain(&board.gap_keepouts).collect();
        let mut out = BTreeMap::new();
        for (class, g) in &board.keepout_gaps {
            let near = self.map(|p| polys.iter().any(|k| point_in_poly(p, k) || poly_edge_d2(p, k) < g * g));
            out.insert(class.parse::<i64>()?, Table::new(&near));
        }
        Ok(out)
    }
}

/// Each cell that has a marked cell within k cells on both axes.
fn grid_dilated(map: &Bitmap, k: i64) -> Bitmap {
    if k <= 0 {
        return map.clone();
    }
    let table = Table::new(map);
    let clip = |v: i64, n: usize| v.clamp(0, n as i64) as usize;
    let mut out = Bitmap::empty(map.nx, map.ny);
    for j in 0..map.ny as i64 {
        for i in 0..map.nx as i64 {
            let (j0, j1) = (clip(j - k, map.ny), clip(j + k + 1, map.ny));
            let (i0, i1) = (clip(i - k, map.nx), clip(i + k + 1, map.nx));
            out.cells[j as usize * map.nx + i as usize] = table.count(j0, j1, i0, i1) > 0;
        }
    }
    out
}
