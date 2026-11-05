//! Exact rationals for the clearance floor. A safety rule compares these, so nothing here rounds: an overflow is an error.
use crate::decimal::Decimal;
use std::cmp::Ordering;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Exact {
    numerator: i128,
    /// Positive, and coprime with the numerator.
    denominator: i128,
}

fn gcd(a: i128, b: i128) -> i128 {
    if b == 0 { a.abs() } else { gcd(b, a % b) }
}

impl Exact {
    fn reduced(numerator: i128, denominator: i128) -> Option<Exact> {
        let divisor = gcd(numerator, denominator);
        if divisor == 0 {
            return None;
        }
        let sign = denominator.signum();
        Some(Exact { numerator: numerator / divisor * sign, denominator: denominator / divisor * sign })
    }

    pub fn from_decimal(value: Decimal) -> Option<Exact> {
        let (mantissa, scale) = value.parts();
        Exact::reduced(mantissa, 10i128.checked_pow(scale)?)
    }

    pub fn from_int(value: i128) -> Exact {
        Exact { numerator: value, denominator: 1 }
    }

    pub fn mul(self, other: Exact) -> Option<Exact> {
        // Cross-reduced first, so a value that fits is not lost to an intermediate product.
        let (a, b) = (gcd(self.numerator, other.denominator).max(1), gcd(other.numerator, self.denominator).max(1));
        let numerator = (self.numerator / a).checked_mul(other.numerator / b)?;
        let denominator = (self.denominator / b).checked_mul(other.denominator / a)?;
        Exact::reduced(numerator, denominator)
    }

    pub fn div(self, other: Exact) -> Option<Exact> {
        self.mul(Exact::reduced(other.denominator, other.numerator)?)
    }

    pub fn is_integer(self) -> bool {
        self.denominator == 1
    }

    pub fn compare(self, other: Exact) -> Option<Ordering> {
        Some(self.numerator.checked_mul(other.denominator)?.cmp(&other.numerator.checked_mul(self.denominator)?))
    }

    /// The plain decimal text, when the value has one: no trailing zeros, no rounding.
    pub fn finite_text(self) -> Option<String> {
        let (mut rest, mut twos, mut fives) = (self.denominator, 0u32, 0u32);
        while rest % 2 == 0 {
            rest /= 2;
            twos += 1;
        }
        while rest % 5 == 0 {
            rest /= 5;
            fives += 1;
        }
        if rest != 1 {
            return None;
        }
        let places = twos.max(fives);
        let scaled = self.numerator.checked_mul(2i128.checked_pow(places - twos)?)?.checked_mul(5i128.checked_pow(places - fives)?)?;
        let digits = format!("{scaled:0>width$}", width = places as usize + 1);
        if places == 0 {
            return Some(digits);
        }
        let (whole, fraction) = digits.split_at(digits.len() - places as usize);
        Some(format!("{whole}.{fraction}").trim_end_matches('0').trim_end_matches('.').to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(text: &str) -> Exact {
        Exact::from_decimal(Decimal::parse(text).unwrap()).unwrap()
    }

    #[test]
    fn decimals_stay_exact_through_a_unit_change() {
        let mil = d("0.0254");
        let required = d("0.254").div(mil).unwrap();
        assert_eq!(required, Exact::from_int(10));
        assert!(!d("0.3").div(mil).unwrap().is_integer());
    }

    #[test]
    fn finite_text_has_no_rounding_and_no_trailing_zeros() {
        assert_eq!(d("0.30").finite_text().as_deref(), Some("0.3"));
        assert_eq!(d("300").finite_text().as_deref(), Some("300"));
        assert_eq!(d("0.125").finite_text().as_deref(), Some("0.125"));
        assert_eq!(Exact::from_int(1).div(Exact::from_int(3)).unwrap().finite_text(), None);
    }

    #[test]
    fn comparison_is_exact() {
        assert_eq!(d("0.3").compare(d("0.30")), Some(Ordering::Equal));
        assert_eq!(d("0.299999999999999999").compare(d("0.3")), Some(Ordering::Less));
    }

    #[test]
    fn an_overflow_is_no_answer() {
        let big = Exact::from_int(i128::MAX);
        assert_eq!(big.mul(big), None);
    }
}
