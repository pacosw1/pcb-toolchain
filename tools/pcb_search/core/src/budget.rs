//! A time limit on a search, with a clock that tests can script.

use std::time::Instant;

pub struct Budget<'a> {
    clock: &'a dyn Fn() -> f64,
    start: f64,
    limit_s: f64,
}

impl<'a> Budget<'a> {
    pub fn new(limit_s: f64, clock: &'a dyn Fn() -> f64) -> Self {
        Budget { clock, start: clock(), limit_s }
    }

    pub fn expired(&self) -> bool {
        self.elapsed_s() >= self.limit_s
    }

    pub fn elapsed_s(&self) -> f64 {
        (self.clock)() - self.start
    }
}

/// Seconds on the monotonic clock since this call.
pub fn monotonic() -> impl Fn() -> f64 {
    let origin = Instant::now();
    move || origin.elapsed().as_secs_f64()
}
