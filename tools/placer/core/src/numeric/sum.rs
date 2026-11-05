//! The two float sums of the reference runs.

const BLOCK: usize = 128;
const LANES: usize = 8;

/// Sum of a contiguous array as numpy `a.sum()` adds it: blocks of 128 in 8 lanes, halves added pairwise.
pub fn pairwise(values: &[f64]) -> f64 {
    0.0 + pairwise_block(values)
}

fn pairwise_block(a: &[f64]) -> f64 {
    let n = a.len();
    if n < LANES {
        return a.iter().fold(-0.0, |sum, v| sum + v);
    }
    if n > BLOCK {
        let half = n / 2;
        let half = half - half % LANES;
        return pairwise_block(&a[..half]) + pairwise_block(&a[half..]);
    }
    let whole = n - n % LANES;
    let mut lane = [0.0; LANES];
    lane.copy_from_slice(&a[..LANES]);
    for chunk in a[LANES..whole].chunks_exact(LANES) {
        for (sum, v) in lane.iter_mut().zip(chunk) {
            *sum += v;
        }
    }
    let total = ((lane[0] + lane[1]) + (lane[2] + lane[3])) + ((lane[4] + lane[5]) + (lane[6] + lane[7]));
    a[whole..].iter().fold(total, |sum, v| sum + v)
}

/// Sum as the builtin `sum()` of CPython 3.12 and later adds floats: Neumaier compensated, in order.
pub fn compensated(values: impl IntoIterator<Item = f64>) -> f64 {
    let (mut sum, mut carry) = (0.0_f64, 0.0_f64);
    for x in values {
        let t = sum + x;
        carry += if sum.abs() >= x.abs() { (sum - t) + x } else { (x - t) + sum };
        sum = t;
    }
    if carry != 0.0 && carry.is_finite() { sum + carry } else { sum }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairwise_of_a_short_array_adds_in_order() {
        assert_eq!(pairwise(&[1.0, 2.0, 3.0]), 6.0);
        assert_eq!(pairwise(&[]), 0.0);
    }

    #[test]
    fn pairwise_uses_eight_lanes_from_eight_values() {
        // In order the 1e16 swallows the ones; each lane keeps its own, so the 1s meet only after the cancel.
        let mut a = vec![0.0; 16];
        a[0] = 1e16;
        a[8] = -1e16;
        a[1] = 1.0;
        a[9] = 1.0;
        assert_eq!(pairwise(&a), 2.0);
    }

    #[test]
    fn pairwise_splits_on_a_multiple_of_eight() {
        // 136 values: halves 64 and 72, each summed on its own.
        let a: Vec<f64> = (0..136).map(|i| ((i * 37 % 101) as f64).sin() * 1e3).collect();
        assert_eq!(pairwise(&a), pairwise(&a[..64]) + pairwise(&a[64..]));
    }

    #[test]
    fn compensated_keeps_what_plain_addition_loses() {
        assert_eq!(compensated([1e16, 1.0, -1e16]), 1.0);
        assert_eq!(compensated([0.1; 10]), 1.0);
        assert_eq!(compensated([]), 0.0);
    }
}
