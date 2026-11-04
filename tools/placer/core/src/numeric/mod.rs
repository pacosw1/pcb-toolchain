//! Floating point that gives the same bits as the numbers the search was tuned on.
//!
//! A seeded search takes a branch on `delta <= 0`, so two sums of the same terms in a different order can send it down
//! another path. These helpers reproduce the arithmetic of the reference runs (CPython 3.13, numpy 2): see each module.

mod hypot;
mod pcg;
mod rng;
mod sum;

pub use hypot::hypot;
pub use pcg::Pcg64;
pub use rng::PyRandom;
pub use sum::{compensated, pairwise};

/// The middle of the values; the mean of the two middle values for an even count. Empty gives NaN.
pub fn median(values: &[f64]) -> f64 {
    let mut v = values.to_vec();
    v.sort_by(f64::total_cmp);
    match v.len() {
        0 => f64::NAN,
        n if n % 2 == 1 => v[n / 2],
        n => (v[n / 2 - 1] + v[n / 2]) / 2.0,
    }
}
