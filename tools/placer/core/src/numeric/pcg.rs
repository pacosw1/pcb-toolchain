//! `numpy.random.default_rng(seed)`: SeedSequence and PCG64, for the jitter of the analytic placement.

const POOL: usize = 4;
const INIT_A: u32 = 0x43b0_d7e5;
const MULT_A: u32 = 0x931e_8875;
const INIT_B: u32 = 0x8b51_f9dd;
const MULT_B: u32 = 0x58f3_8ded;
const MIX_L: u32 = 0xca01_f9dd;
const MIX_R: u32 = 0x4973_f715;
const SHIFT: u32 = 16;
const PCG_MULTIPLIER: u128 = 0x2360_ed05_1fc6_5da4_4385_df64_9fcc_f645;

fn hash_mix(value: u32, hash: &mut u32) -> u32 {
    let mut v = value ^ *hash;
    *hash = hash.wrapping_mul(MULT_A);
    v = v.wrapping_mul(*hash);
    v ^ (v >> SHIFT)
}

fn mix(x: u32, y: u32) -> u32 {
    let r = MIX_L.wrapping_mul(x).wrapping_sub(MIX_R.wrapping_mul(y));
    r ^ (r >> SHIFT)
}

/// SeedSequence pool of a seed that fits in 32 bits.
fn seed_pool(seed: u32) -> [u32; POOL] {
    let mut hash = INIT_A;
    let mut pool = [seed, 0, 0, 0].map(|v| hash_mix(v, &mut hash));
    for src in 0..POOL {
        for dst in (0..POOL).filter(|&d| d != src) {
            pool[dst] = mix(pool[dst], hash_mix(pool[src], &mut hash));
        }
    }
    pool
}

/// `generate_state(4, uint64)`.
fn seed_words(seed: u32) -> [u64; 4] {
    let pool = seed_pool(seed);
    let mut hash = INIT_B;
    let word = |i: usize, hash: &mut u32| {
        let mut v = pool[i % POOL] ^ *hash;
        *hash = hash.wrapping_mul(MULT_B);
        v = v.wrapping_mul(*hash);
        (v ^ (v >> SHIFT)) as u64
    };
    let mut out = [0; 4];
    for (n, slot) in out.iter_mut().enumerate() {
        let low = word(2 * n, &mut hash);
        *slot = low | word(2 * n + 1, &mut hash) << 32;
    }
    out
}

pub struct Pcg64 {
    state: u128,
    increment: u128,
}

impl Pcg64 {
    pub fn new(seed: u32) -> Self {
        let w = seed_words(seed);
        let (start, stream) = ((w[0] as u128) << 64 | w[1] as u128, (w[2] as u128) << 64 | w[3] as u128);
        let mut rng = Self { state: 0, increment: stream << 1 | 1 };
        rng.step();
        rng.state = rng.state.wrapping_add(start);
        rng.step();
        rng
    }

    fn step(&mut self) {
        self.state = self.state.wrapping_mul(PCG_MULTIPLIER).wrapping_add(self.increment);
    }

    fn next_u64(&mut self) -> u64 {
        self.step();
        ((self.state >> 64) as u64 ^ self.state as u64).rotate_right((self.state >> 122) as u32)
    }

    /// `random()`.
    pub fn random(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 * (1.0 / 9_007_199_254_740_992.0)
    }

    /// `uniform(lo, hi)`.
    pub fn uniform(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.random()
    }
}

#[cfg(test)]
mod tests {
    use super::Pcg64;

    // numpy: default_rng(1).random(4)
    #[test]
    fn matches_numpy_for_seed_1() {
        let mut r = Pcg64::new(1);
        for want in [0.5118216247148916, 0.9504636963259353, 0.14415961271963373, 0.9486494471372439] {
            assert!((r.random() - want).abs() < 1e-9);
        }
    }
}
