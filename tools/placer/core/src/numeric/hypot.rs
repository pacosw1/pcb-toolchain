//! `math.hypot` of CPython 3.10 and later. It is more exact than the C library `hypot`, so the two differ in the last
//! bit now and then; the libm one stays `f64::hypot`, which is what `numpy.hypot` calls.

/// The exact product x * y as a rounded value and its error.
fn product(x: f64, y: f64) -> (f64, f64) {
    let z = x * y;
    (z, x.mul_add(y, -z))
}

/// The exact sum a + b for |a| >= |b| as a rounded value and its error.
fn fast_sum(a: f64, b: f64) -> (f64, f64) {
    let x = a + b;
    let z = x - a;
    (x, (a - (x - z)) + (b - z))
}

/// frexp exponent of a positive normal number: value = m * 2^e, m in [0.5, 1).
fn exponent(value: f64) -> i32 {
    ((value.to_bits() >> 52) & 0x7ff) as i32 - 1022
}

/// sqrt(x^2 + y^2), differentially corrected as in CPython `vector_norm`.
pub fn hypot(x: f64, y: f64) -> f64 {
    let (x, y) = (x.abs(), y.abs());
    let max = x.max(y);
    if max == 0.0 || max.is_infinite() || x.is_nan() || y.is_nan() {
        return if x.is_nan() || y.is_nan() { f64::NAN } else { max };
    }
    if max < f64::MIN_POSITIVE {
        return f64::MIN_POSITIVE * hypot(x / f64::MIN_POSITIVE, y / f64::MIN_POSITIVE);
    }
    let scale = 2.0_f64.powi(-exponent(max));
    let (mut sum, mut low1, mut low2) = (1.0, 0.0, 0.0);
    for v in [x, y] {
        let v = v * scale;
        let (square, square_low) = product(v, v);
        let (next, next_low) = fast_sum(sum, square);
        sum = next;
        low1 += square_low;
        low2 += next_low;
    }
    let h = (sum - 1.0 + (low1 + low2)).sqrt();
    let (square, square_low) = product(-h, h);
    let (next, next_low) = fast_sum(sum, square);
    let rest = next - 1.0 + ((low1 + square_low) + (low2 + next_low));
    (h + rest / (2.0 * h)) / scale
}

#[cfg(test)]
mod tests {
    use super::hypot;

    #[test]
    fn exact_triangles_and_edges() {
        assert_eq!(hypot(3.0, 4.0), 5.0);
        assert_eq!(hypot(-5.0, 12.0), 13.0);
        assert_eq!(hypot(0.0, 0.0), 0.0);
        assert_eq!(hypot(0.0, -7.5), 7.5);
        assert_eq!(hypot(f64::INFINITY, 1.0), f64::INFINITY);
        assert!(hypot(f64::NAN, 1.0).is_nan());
    }

    #[test]
    fn stays_within_one_bit_of_libm() {
        for k in 1..2000 {
            let (x, y) = (k as f64 * 0.137, 300.0 - k as f64 * 0.211);
            let (a, b) = (hypot(x, y), x.hypot(y));
            assert!((a - b).abs() <= a * f64::EPSILON, "{x} {y}: {a} vs {b}");
        }
    }
}
