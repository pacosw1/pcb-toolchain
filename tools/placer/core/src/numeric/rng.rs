//! `random.Random` of CPython: MT19937 with the same seeding and the same draws, so a seed gives the same placement.

const N: usize = 624;
const M: usize = 397;
const UPPER: u32 = 0x8000_0000;
const LOWER: u32 = 0x7fff_ffff;

pub struct PyRandom {
    state: [u32; N],
    index: usize,
    spare_gauss: Option<f64>,
}

impl PyRandom {
    /// `random.Random(seed)`: the key is the seed as 32-bit words, low word first.
    pub fn new(seed: u64) -> Self {
        let low = seed as u32;
        let high = (seed >> 32) as u32;
        let key: &[u32] = if high == 0 { &[low] } else { &[low, high] };
        let mut rng = Self { state: [0; N], index: N, spare_gauss: None };
        rng.init_by_array(key);
        rng
    }

    fn init_genrand(&mut self, seed: u32) {
        self.state[0] = seed;
        for i in 1..N {
            let prev = self.state[i - 1];
            self.state[i] = 1_812_433_253_u32.wrapping_mul(prev ^ (prev >> 30)).wrapping_add(i as u32);
        }
    }

    fn init_by_array(&mut self, key: &[u32]) {
        self.init_genrand(19_650_218);
        let s = &mut self.state;
        let (mut i, mut j) = (1, 0);
        for _ in 0..N.max(key.len()) {
            let prev = s[i - 1];
            s[i] = (s[i] ^ (prev ^ (prev >> 30)).wrapping_mul(1_664_525)).wrapping_add(key[j]).wrapping_add(j as u32);
            i += 1;
            j = (j + 1) % key.len();
            if i >= N {
                s[0] = s[N - 1];
                i = 1;
            }
        }
        for _ in 0..N - 1 {
            let prev = s[i - 1];
            s[i] = (s[i] ^ (prev ^ (prev >> 30)).wrapping_mul(1_566_083_941)).wrapping_sub(i as u32);
            i += 1;
            if i >= N {
                s[0] = s[N - 1];
                i = 1;
            }
        }
        s[0] = UPPER;
    }

    fn refill(&mut self) {
        let s = &mut self.state;
        for k in 0..N {
            let y = (s[k] & UPPER) | (s[(k + 1) % N] & LOWER);
            let twist = if y & 1 == 1 { 0x9908_b0df } else { 0 };
            s[k] = s[(k + M) % N] ^ (y >> 1) ^ twist;
        }
        self.index = 0;
    }

    fn next_u32(&mut self) -> u32 {
        if self.index >= N {
            self.refill();
        }
        let mut y = self.state[self.index];
        self.index += 1;
        y ^= y >> 11;
        y ^= (y << 7) & 0x9d2c_5680;
        y ^= (y << 15) & 0xefc6_0000;
        y ^ (y >> 18)
    }

    /// `random()`: a double in [0, 1) from 53 bits.
    pub fn random(&mut self) -> f64 {
        let a = (self.next_u32() >> 5) as f64;
        let b = (self.next_u32() >> 6) as f64;
        (a * 67_108_864.0 + b) * (1.0 / 9_007_199_254_740_992.0)
    }

    /// `uniform(a, b)`.
    pub fn uniform(&mut self, a: f64, b: f64) -> f64 {
        a + (b - a) * self.random()
    }

    /// `randrange(n)`: rejection on the bit length of n. n fits in 32 bits here.
    pub fn below(&mut self, n: usize) -> usize {
        let bits = usize::BITS - n.leading_zeros();
        loop {
            let r = (self.next_u32() >> (32 - bits)) as usize;
            if r < n {
                return r;
            }
        }
    }

    /// `choice(items)`.
    pub fn choice<T: Copy>(&mut self, items: &[T]) -> T {
        items[self.below(items.len())]
    }

    /// `gauss(mu, sigma)`: the pair of the Box-Muller step is kept for the next draw.
    pub fn gauss(&mut self, mu: f64, sigma: f64) -> f64 {
        let z = self.spare_gauss.take().unwrap_or_else(|| {
            let angle = self.random() * std::f64::consts::TAU;
            let radius = (-2.0 * (1.0 - self.random()).ln()).sqrt();
            self.spare_gauss = Some(angle.sin() * radius);
            angle.cos() * radius
        });
        mu + z * sigma
    }
}

#[cfg(test)]
mod tests {
    use super::PyRandom;

    // Reference values: CPython 3.13 random.Random(seed), documented sequences of MT19937 init_by_array.
    #[test]
    fn matches_cpython_for_seed_1() {
        let mut r = PyRandom::new(1);
        assert_eq!(r.random(), 0.13436424411240122);
        assert_eq!(r.random(), 0.8474337369372327);
        assert_eq!(r.random(), 0.763774618976614);
    }

    #[test]
    fn matches_cpython_for_seed_0() {
        let mut r = PyRandom::new(0);
        assert_eq!(r.random(), 0.8444218515250481);
        assert_eq!(r.random(), 0.7579544029403025);
    }

    #[test]
    fn below_stays_in_range_and_rejects() {
        let mut r = PyRandom::new(7);
        assert!((0..1000).all(|_| r.below(5) < 5));
        assert_eq!(r.below(1), 0);
    }
}
