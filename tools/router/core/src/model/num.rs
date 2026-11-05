//! A number as a JSON file wrote it. Project and spec values go through the model as they are, so 0 stays an integer and a
//! float is the nearest double to its text. serde_json's default float parse can miss that by a bit, so the text is read here.
use serde::de::Error;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::value::RawValue;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Num {
    Int(i64),
    Float(f64),
}

impl Num {
    pub fn get(self) -> f64 {
        match self {
            Num::Int(i) => i as f64,
            Num::Float(f) => f,
        }
    }

    fn parse(text: &str) -> Option<Num> {
        text.parse().map(Num::Int).ok().or_else(|| text.parse().map(Num::Float).ok())
    }

    /// The larger of the two; on a tie, self.
    pub fn max(self, other: Num) -> Num {
        if other.get() > self.get() { other } else { self }
    }

    /// As the file wrote it: an integer stays one, a float keeps its point.
    pub fn text(self) -> String {
        match self {
            Num::Int(i) => i.to_string(),
            Num::Float(f) => format!("{f:?}"),
        }
    }

    /// As C's %g: six significant digits, no trailing zeros.
    pub fn short(self) -> String {
        short_float(self.get())
    }
}

impl From<f64> for Num {
    fn from(v: f64) -> Num {
        Num::Float(v)
    }
}

/// C's %g for a value in the range of board numbers.
pub fn short_float(v: f64) -> String {
    if v == 0.0 {
        return "0".to_string();
    }
    let exponent = v.abs().log10().floor() as i32;
    if !(-4..6).contains(&exponent) {
        let text = format!("{v:.5e}");
        let (mantissa, exp) = text.split_once('e').expect("e format");
        let exp: i32 = exp.parse().expect("an exponent");
        return format!("{}e{}{:02}", trim_zeros(mantissa), if exp < 0 { '-' } else { '+' }, exp.abs());
    }
    let decimals = (5 - exponent).max(0) as usize;
    trim_zeros(&format!("{v:.decimals$}")).to_string()
}

fn trim_zeros(text: &str) -> &str {
    if text.contains('.') { text.trim_end_matches('0').trim_end_matches('.') } else { text }
}

impl<'de> Deserialize<'de> for Num {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Num, D::Error> {
        let raw = <&RawValue>::deserialize(d)?;
        Num::parse(raw.get()).ok_or_else(|| D::Error::custom(format!("not a number: {}", raw.get())))
    }
}

impl Serialize for Num {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Num::Int(i) => s.serialize_i64(*i),
            Num::Float(f) => s.serialize_f64(*f),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integers_stay_integers_through_json() {
        let v: Vec<Num> = serde_json::from_str("[0, 0.0, 2.1, 1e-3]").unwrap();
        assert_eq!(v, [Num::Int(0), Num::Float(0.0), Num::Float(2.1), Num::Float(0.001)]);
        assert_eq!(serde_json::to_string(&v).unwrap(), "[0,0.0,2.1,0.001]");
    }

    #[test]
    fn a_float_is_the_nearest_double_to_its_text() {
        // serde_json's default parse gives another double for this text.
        let text = "113.60000000000001";
        let n: Num = serde_json::from_str(text).unwrap();
        assert_eq!(n.get(), text.parse::<f64>().unwrap());
    }

    #[test]
    fn a_missing_or_null_value_is_none_in_an_option() {
        let v: Vec<Option<Num>> = serde_json::from_str("[null, 1]").unwrap();
        assert_eq!(v, [None, Some(Num::Int(1))]);
    }

    #[test]
    fn a_tie_keeps_the_first() {
        assert_eq!(Num::Int(1).max(Num::Float(1.0)), Num::Int(1));
        assert_eq!(Num::Int(1).max(Num::Float(1.5)), Num::Float(1.5));
    }

    #[test]
    fn short_form_is_percent_g() {
        for (v, text) in [(0.0, "0"), (122.5, "122.5"), (3.0, "3"), (0.45, "0.45"), (1234567.0, "1.23457e+06"), (0.00001, "1e-05"), (100.123456, "100.123")] {
            assert_eq!(short_float(v), text);
        }
    }
}
