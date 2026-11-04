//! Exact decimal numbers, as Python's `Decimal` treats KiCad coordinates.
//!
//! Board values are compared exactly and their normalized text gets hashed, so floats will not do: `100` normalizes to
//! the text `1E+2`. KiCad numbers have a few digits, so an i128 mantissa holds every product made from them.
//! Only std: tools/pcb_search/core includes this file by path, as it does kicad/raw.rs.

use std::cmp::Ordering;
use std::fmt;
use std::ops::{Add, Mul, Sub};

/// `mantissa * 10^-scale`, with `scale` as written in the source.
#[derive(Debug, Clone, Copy)]
pub struct Decimal {
    mantissa: i128,
    scale: u32,
}

impl Decimal {
    pub const ZERO: Decimal = Decimal { mantissa: 0, scale: 0 };

    pub fn from_int(value: i64) -> Decimal {
        Decimal { mantissa: value.into(), scale: 0 }
    }

    /// Reads `-12.50` or `1.5e-3`. Anything else, `NaN` and `Infinity` included, is None.
    pub fn parse(text: &str) -> Option<Decimal> {
        let (digits, exponent) = match text.split_once(['e', 'E']) {
            Some((digits, exponent)) => (digits, exponent.parse::<i32>().ok()?),
            None => (text, 0),
        };
        let (sign, digits) = match digits.strip_prefix('-') {
            Some(rest) => (-1, rest),
            None => (1, digits.strip_prefix('+').unwrap_or(digits)),
        };
        let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
        if whole.len() + fraction.len() == 0 || !whole.chars().chain(fraction.chars()).all(|c| c.is_ascii_digit()) {
            return None;
        }
        let mantissa: i128 = format!("{whole}{fraction}").parse().ok()?;
        let scale = fraction.len() as i32 - exponent;
        if scale >= 0 {
            Some(Decimal { mantissa: sign * mantissa, scale: scale as u32 })
        } else {
            Some(Decimal { mantissa: sign * mantissa * 10i128.checked_pow(scale.unsigned_abs())?, scale: 0 })
        }
    }

    pub fn is_zero(self) -> bool {
        self.mantissa == 0
    }

    /// The value as `mantissa` over `10^scale`.
    pub fn parts(self) -> (i128, u32) {
        (self.mantissa, self.scale)
    }

    pub fn to_f64(self) -> f64 {
        self.to_string().parse().unwrap_or(f64::NAN)
    }

    /// Both values over one scale.
    fn aligned(self, other: Decimal) -> (i128, i128, u32) {
        let scale = self.scale.max(other.scale);
        (self.mantissa * 10i128.pow(scale - self.scale), other.mantissa * 10i128.pow(scale - other.scale), scale)
    }

    /// Python's `%`: the result takes the sign of the dividend.
    pub fn rem(self, modulus: i64) -> Decimal {
        let (a, b, scale) = self.aligned(Decimal::from_int(modulus));
        Decimal { mantissa: a % b, scale }
    }

    /// The angle in [0, 360).
    pub fn wrapped_degrees(self) -> Decimal {
        (self.rem(360) + Decimal::from_int(360)).rem(360)
    }

    /// The value on a grid of `10^-places`, ties to even.
    pub fn quantized(self, places: u32) -> Decimal {
        if self.scale <= places {
            return Decimal { mantissa: self.mantissa * 10i128.pow(places - self.scale), scale: places };
        }
        let divisor = 10i128.pow(self.scale - places);
        let (quotient, remainder) = (self.mantissa / divisor, (self.mantissa % divisor).abs());
        let step = match (remainder * 2).cmp(&divisor) {
            Ordering::Less => 0,
            Ordering::Greater => 1,
            Ordering::Equal => quotient.abs() % 2,
        };
        Decimal { mantissa: quotient + self.mantissa.signum() * step, scale: places }
    }

    /// The square root of a non-negative value, rounded once. An f64 root of the rounded value can differ in the last digit.
    pub fn sqrt_f64(self) -> f64 {
        let (mut mantissa, mut scale) = (self.mantissa.unsigned_abs(), self.scale);
        if scale % 2 == 1 {
            mantissa *= 10;
            scale += 1;
        }
        while mantissa != 0 && mantissa < 10u128.pow(36) {
            mantissa *= 100;
            scale += 2;
        }
        format!("{}e-{}", mantissa.isqrt(), scale / 2).parse().unwrap_or(f64::NAN)
    }

    /// `format(value, 'f')`: positional, keeping the written scale.
    pub fn plain(self) -> String {
        let digits = self.mantissa.unsigned_abs().to_string();
        let sign = if self.mantissa < 0 { "-" } else { "" };
        let scale = self.scale as usize;
        if scale == 0 {
            return format!("{sign}{digits}");
        }
        let padded = format!("{digits:0>width$}", width = scale + 1);
        let (whole, fraction) = padded.split_at(padded.len() - scale);
        format!("{sign}{whole}.{fraction}")
    }

    /// `str(value)`: the written scale, exponent form as Python writes it.
    pub fn text(self) -> String {
        let digits = self.mantissa.unsigned_abs().to_string();
        let sign = if self.mantissa < 0 { "-" } else { "" };
        format!("{sign}{}", scientific_text(&digits, -(self.scale as i32)))
    }

    /// `str(value.normalize())`: no trailing zeros, exponent form as Python writes it.
    pub fn normalized(self) -> String {
        if self.mantissa == 0 {
            return "0".to_string();
        }
        let mut digits = self.mantissa.unsigned_abs().to_string();
        let mut exponent = -(self.scale as i32);
        while digits.ends_with('0') {
            digits.pop();
            exponent += 1;
        }
        let sign = if self.mantissa < 0 { "-" } else { "" };
        format!("{sign}{}", scientific_text(&digits, exponent))
    }
}

/// Python's rule for `str(Decimal)`: positional unless the exponent is positive or the value is below 1e-6.
fn scientific_text(digits: &str, exponent: i32) -> String {
    let adjusted = exponent + digits.len() as i32 - 1;
    if exponent <= 0 && adjusted >= -6 {
        let scale = exponent.unsigned_abs() as usize;
        if scale == 0 {
            return digits.to_string();
        }
        let padded = format!("{digits:0>width$}", width = scale + 1);
        let (whole, fraction) = padded.split_at(padded.len() - scale);
        return format!("{whole}.{fraction}");
    }
    let (first, rest) = digits.split_at(1);
    let fraction = if rest.is_empty() { String::new() } else { format!(".{rest}") };
    format!("{first}{fraction}E{}{}", if adjusted < 0 { '-' } else { '+' }, adjusted.abs())
}

impl fmt::Display for Decimal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.plain())
    }
}

impl PartialEq for Decimal {
    fn eq(&self, other: &Decimal) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for Decimal {}

impl PartialOrd for Decimal {
    fn partial_cmp(&self, other: &Decimal) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Decimal {
    /// Exact for any two values: magnitudes are compared by leading digit first, so no scaling can overflow.
    fn cmp(&self, other: &Decimal) -> Ordering {
        let sign = self.mantissa.signum();
        match sign.cmp(&other.mantissa.signum()) {
            Ordering::Equal if sign < 0 => magnitude(*other, *self),
            Ordering::Equal => magnitude(*self, *other),
            order => order,
        }
    }
}

/// Compares the absolute values of two non-zero numbers, or of two zeros.
fn magnitude(a: Decimal, b: Decimal) -> Ordering {
    let (x, y) = (a.mantissa.unsigned_abs(), b.mantissa.unsigned_abs());
    if x == 0 || y == 0 {
        return x.cmp(&y);
    }
    let (dx, dy) = (x.ilog10() as i64 + 1, y.ilog10() as i64 + 1);
    let order = (dx - i64::from(a.scale)).cmp(&(dy - i64::from(b.scale)));
    if order != Ordering::Equal {
        return order;
    }
    let width = dx.max(dy) as u32;
    (x * 10u128.pow(width - dx as u32)).cmp(&(y * 10u128.pow(width - dy as u32)))
}

impl Add for Decimal {
    type Output = Decimal;
    fn add(self, other: Decimal) -> Decimal {
        let (a, b, scale) = self.aligned(other);
        Decimal { mantissa: a + b, scale }
    }
}

impl Sub for Decimal {
    type Output = Decimal;
    fn sub(self, other: Decimal) -> Decimal {
        let (a, b, scale) = self.aligned(other);
        Decimal { mantissa: a - b, scale }
    }
}

impl Mul for Decimal {
    type Output = Decimal;
    fn mul(self, other: Decimal) -> Decimal {
        Decimal { mantissa: self.mantissa * other.mantissa, scale: self.scale + other.scale }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(text: &str) -> Decimal {
        Decimal::parse(text).unwrap()
    }

    #[test]
    fn normalized_text_matches_python() {
        let cases = [("100", "1E+2"), ("0", "0"), ("0.000", "0"), ("1.50", "1.5"), ("-90.0", "-9E+1"), ("120", "1.2E+2"),
                     ("0.001", "0.001"), ("0.000001", "0.000001"), ("0.0000001", "1E-7"), ("12.5", "12.5"), ("45", "45"),
                     ("1E+2", "1E+2"), ("270", "2.7E+2")];
        for (text, want) in cases {
            assert_eq!(d(text).normalized(), want, "{text}");
        }
    }

    #[test]
    fn values_compare_across_scales() {
        assert_eq!(d("1.50"), d("1.5"));
        assert!(d("-1") < d("0.5"));
    }

    #[test]
    fn far_apart_scales_compare_without_overflow() {
        assert!(d("0.0000000000000000000000000000000001") < d("99999999999999999999999999999999999"));
        assert!(d("-0.0000000000000000000000000000000001") > d("-99999999999999999999999999999999999"));
        assert_eq!(d("0"), d("0.000"));
        assert!(d("0") < d("0.0001"));
    }

    #[test]
    fn text_keeps_the_scale_as_python_str_does() {
        let cases = [("0.200", "0.200"), ("3", "3"), ("0.0", "0.0"), ("0.000001", "0.000001"), ("0.0000001", "1E-7"), ("-1.50", "-1.50")];
        for (text, want) in cases {
            assert_eq!(d(text).text(), want, "{text}");
        }
        assert_eq!((d("200") * d("0.001")).text(), "0.200");
    }

    #[test]
    fn remainder_takes_the_sign_of_the_dividend() {
        assert_eq!(d("-90").rem(360), d("-90"));
        assert_eq!(d("-90").wrapped_degrees(), d("270"));
        assert_eq!(d("450.5").wrapped_degrees(), d("90.5"));
    }

    #[test]
    fn quantize_rounds_ties_to_even() {
        assert_eq!(d("1.0000005").quantized(6).plain(), "1.000000");
        assert_eq!(d("1.0000015").quantized(6).plain(), "1.000002");
        assert_eq!(d("-1.0000015").quantized(6).plain(), "-1.000002");
        assert_eq!(d("1.5").quantized(6).plain(), "1.500000");
    }

    #[test]
    fn plain_text_keeps_the_written_scale() {
        assert_eq!(d("1.50").plain(), "1.50");
        assert_eq!(d("-0.05").plain(), "-0.05");
        assert_eq!((d("1.5") * d("2")).plain(), "3.0");
    }

    #[test]
    fn not_numbers_are_refused() {
        for text in ["NaN", "Infinity", "", "-", "1.2.3", "abc"] {
            assert!(Decimal::parse(text).is_none(), "{text}");
        }
    }
}
