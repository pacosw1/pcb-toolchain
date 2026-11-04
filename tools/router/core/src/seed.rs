//! Seeded variation between runs (`--seed N`, tools/router/DESIGN.md 5e). Without --seed nothing here runs and the result
//! is the unseeded route, byte for byte.
//!
//! A seed changes two things, both prices or orders, never a rule, so a seeded route obeys every rule of an unseeded one:
//!   net order   inside each group (plane, power, fast, slow) the nets are shuffled; the groups keep their order
//!   search cost a smooth random field moves the A* cost of each routing cell and via site (Grid::jit), so equal or nearly
//!               equal paths fall to a different side of an obstacle; the length recovery and len_mode searches do not see it
//!
//! Integer steps plus IEEE add, multiply and divide only: Mac and Linux give the same field.

/// Lattice pitch of the cost field (mm). A default to tune; 1, 2 and 4 mm gave the same spread (DESIGN.md 5e). 2 mm: the
/// scale at which DESIGN.md 5d still sees hot areas.
const CELL_MM: f64 = 2.0;
/// Width of the field around 0, as a fraction of a step's cost. A default to tune: 0.25, 0.5 and 1.0 gave the same spread
/// (DESIGN.md 5e), so the smallest. Mean 0: a field of only added cost made the 1.15 x octile heuristic look further and
/// slowed the search.
const AMP: f64 = 0.25;

/// SplitMix64 (Steele, Lea, Flood, OOPSLA 2014; java.util.SplittableRandom).
pub(crate) struct Rng(u64);

impl Rng {
    pub(crate) fn new(seed: u64) -> Rng {
        Rng(seed)
    }
    pub(crate) fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// uniform in [0, 1), 53 bits
    pub(crate) fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// Fisher-Yates inside each run of equal group numbers; `order` is sorted by group, and the groups stay where they are.
pub(crate) fn shuffle_groups(order: &mut [usize], group: &dyn Fn(usize) -> u8, rng: &mut Rng) {
    let mut a = 0;
    while a < order.len() {
        let g = group(order[a]);
        let b = a + order[a..].iter().take_while(|&&n| group(n) == g).count();
        for i in (a + 1..b).rev() {
            order.swap(i, a + (rng.next() % (i - a + 1) as u64) as usize);
        }
        a = b;
    }
}

/// Bilinear value noise in [-AMP / 2, AMP / 2] on one nx x ny layer: random values on a lattice of `step` grid cells.
fn layer(rng: &mut Rng, nx: usize, ny: usize, step: usize, out: &mut Vec<f32>) {
    let lx = (nx - 1) / step + 2;
    let ly = (ny - 1) / step + 2;
    let lat: Vec<f64> = (0..lx * ly).map(|_| (rng.unit() - 0.5) * AMP).collect();
    let s = step as f64;
    for j in 0..ny {
        let (gy, ty) = (j / step, (j % step) as f64 / s);
        for i in 0..nx {
            let (gx, tx) = (i / step, (i % step) as f64 / s);
            let (a, b) = (lat[gy * lx + gx], lat[gy * lx + gx + 1]);
            let (c, d) = (lat[(gy + 1) * lx + gx], lat[(gy + 1) * lx + gx + 1]);
            let (top, bot) = (a + (b - a) * tx, c + (d - c) * tx);
            out.push((top + (bot - top) * ty) as f32);
        }
    }
}

/// The seeded cost field: one layer per routable layer (so the layer choice varies too) and one for the via sites. Empty
/// (no seed): both lookups give 0.0 and the search prices stay exactly as they were.
#[derive(Default)]
pub(crate) struct Jitter {
    cell: Vec<f32>,
    via: Vec<f32>,
}

impl Jitter {
    pub(crate) fn new(rng: &mut Rng, nx: usize, ny: usize, nr: usize, pitch: f64) -> Jitter {
        let step = ((CELL_MM / pitch).round() as usize).max(1);
        let (mut cell, mut via) = (Vec::with_capacity(nx * ny * nr), Vec::with_capacity(nx * ny));
        for _ in 0..nr {
            layer(rng, nx, ny, step, &mut cell);
        }
        layer(rng, nx, ny, step, &mut via);
        Jitter { cell, via }
    }
    #[inline]
    pub(crate) fn cell(&self, i: usize) -> f64 {
        if self.cell.is_empty() { 0.0 } else { self.cell[i] as f64 }
    }
    #[inline]
    pub(crate) fn via(&self, i: usize) -> f64 {
        if self.via.is_empty() { 0.0 } else { self.via[i] as f64 }
    }
}
