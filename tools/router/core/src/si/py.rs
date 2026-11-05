//! Numbers and text the way the gate has always printed them: the findings are compared by text, so %g, repr, floor modulo and
//! tie-breaking stay Python's.
use std::f64::consts::PI;

pub const TAU: f64 = 2.0 * PI;

/// `a % b` of two floats: the result takes the sign of b.
pub fn modulo(a: f64, b: f64) -> f64 {
    let r = a % b;
    if r != 0.0 && (r < 0.0) != (b < 0.0) { r + b } else { r }
}

/// sqrt(x*x + y*y) with the error of the two squares put back, as math.hypot: nearly always correctly rounded on any libm.
pub fn hypot(x: f64, y: f64) -> f64 {
    let (x, y) = (x.abs(), y.abs());
    if x == 0.0 || y == 0.0 || !x.is_finite() || !y.is_finite() {
        return x.hypot(y);
    }
    let (xx, yy) = (x * x, y * y);
    let h = (xx + yy).sqrt();
    let (ex, ey) = (x.mul_add(x, -xx), y.mul_add(y, -yy));
    let (hh, eh) = (h * h, h.mul_add(h, -(h * h)));
    let residual = ((xx - hh) + yy) + (ex + ey - eh);
    h + residual / (2.0 * h)
}

/// math.dist of two points.
pub fn dist(a: (f64, f64), b: (f64, f64)) -> f64 {
    hypot(a.0 - b.0, a.1 - b.1)
}

/// Format spec `.{precision}g`.
pub fn g_with(v: f64, precision: usize) -> String {
    if !v.is_finite() {
        return if v.is_nan() { "nan".to_string() } else if v > 0.0 { "inf".to_string() } else { "-inf".to_string() };
    }
    if v == 0.0 {
        return if v.is_sign_negative() { "-0" } else { "0" }.to_string();
    }
    let precision = precision.max(1);
    let sci = format!("{:.*e}", precision - 1, v);
    let (mantissa, exponent) = sci.split_once('e').expect("e format");
    let exponent: i32 = exponent.parse().expect("an exponent");
    if exponent < -4 || exponent >= precision as i32 {
        return format!("{}e{}{:02}", trim(mantissa), if exponent < 0 { '-' } else { '+' }, exponent.abs());
    }
    let decimals = (precision as i32 - 1 - exponent) as usize;
    trim(&format!("{v:.decimals$}")).to_string()
}

/// Format spec `g`.
pub fn g(v: f64) -> String {
    g_with(v, 6)
}

fn trim(text: &str) -> &str {
    if text.contains('.') { text.trim_end_matches('0').trim_end_matches('.') } else { text }
}

/// repr of a float: the shortest text that reads back, in Python's layout.
pub fn float_repr(v: f64) -> String {
    if !v.is_finite() {
        return g(v);
    }
    let sci = format!("{v:e}");
    let (mantissa, exponent) = sci.split_once('e').expect("e format");
    let exponent: i32 = exponent.parse().expect("an exponent");
    if (-4..16).contains(&exponent) {
        let text = format!("{v}");
        return if text.contains('.') { text } else { format!("{text}.0") };
    }
    format!("{mantissa}e{}{:02}", if exponent < 0 { '-' } else { '+' }, exponent.abs())
}

/// repr of a str, for the text a board or spec can hold.
pub fn str_repr(s: &str) -> String {
    let quote = if s.contains('\'') && !s.contains('"') { '"' } else { '\'' };
    let mut out = String::from(quote);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == quote => {
                out.push('\\');
                out.push(c);
            }
            c => out.push(c),
        }
    }
    out.push(quote);
    out
}

/// repr of a list of text.
pub fn list_repr<S: AsRef<str>>(items: &[S]) -> String {
    format!("[{}]", items.iter().map(|s| str_repr(s.as_ref())).collect::<Vec<_>>().join(", "))
}

/// max(items, key=...): the first of the largest.
pub fn first_max<T>(items: impl IntoIterator<Item = T>, key: impl Fn(&T) -> f64) -> Option<T> {
    let mut best: Option<T> = None;
    for item in items {
        if best.as_ref().is_none_or(|b| key(&item) > key(b)) {
            best = Some(item);
        }
    }
    best
}

/// Counter.most_common over (name, count) in first-seen order: largest count first, ties in that order.
pub fn most_common<T: Clone, N: Copy + PartialOrd>(counts: &[(T, N)]) -> Vec<(T, N)> {
    let mut sorted = counts.to_vec();
    sorted.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    sorted
}

/// A running Counter in first-seen order.
pub fn count<T: PartialEq, N: Copy + std::ops::Add<Output = N>>(counts: &mut Vec<(T, N)>, name: T, by: N) {
    match counts.iter_mut().find(|(n, _)| *n == name) {
        Some(row) => row.1 = row.1 + by,
        None => counts.push((name, by)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modulo_takes_the_sign_of_the_divisor() {
        assert_eq!(modulo(-1.0, 3.0), 2.0);
        assert_eq!(modulo(1.0, -3.0), -2.0);
        assert_eq!(modulo(6.0, 3.0), 0.0);
    }

    #[test]
    fn hypot_is_exact_on_exact_cases() {
        assert_eq!(hypot(3.0, 4.0), 5.0);
        assert_eq!(hypot(0.0, -2.5), 2.5);
        assert_eq!(dist((1.0, 1.0), (4.0, 5.0)), 5.0);
    }

    #[test]
    fn g_follows_python() {
        for (v, text) in [(0.0, "0"), (1.0, "1"), (0.25, "0.25"), (1234567.0, "1.23457e+06"), (0.00001, "1e-05"), (100000.0, "100000"), (999999.5, "1e+06"), (0.0001, "0.0001")] {
            assert_eq!(g(v), text);
        }
        assert_eq!(g_with(3.14159, 3), "3.14");
        assert_eq!(g_with(1234.0, 3), "1.23e+03");
        assert_eq!(g_with(0.1 + 0.2, 6), "0.3");
    }

    #[test]
    fn repr_follows_python() {
        for (v, text) in [(1.0, "1.0"), (0.22, "0.22"), (1e-5, "1e-05"), (1e16, "1e+16"), (1234567890123456.0, "1234567890123456.0"), (0.0001, "0.0001")] {
            assert_eq!(float_repr(v), text);
        }
        assert_eq!(str_repr("it's"), "\"it's\"");
        assert_eq!(list_repr(&["a", "b"]), "['a', 'b']");
    }

    #[test]
    fn ties_go_to_the_first() {
        assert_eq!(first_max([(1, 2.0), (2, 2.0), (3, 1.0)], |r| r.1), Some((1, 2.0)));
        let mut c = Vec::new();
        count(&mut c, "a", 1);
        count(&mut c, "b", 2);
        count(&mut c, "a", 1);
        assert_eq!(most_common(&c), [("a", 2), ("b", 2)]);
    }
}
