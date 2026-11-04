//! JSON text exactly as Python's `json` module writes it.
//!
//! Evidence hashes in records already on disk come from `json.dumps`, so these bytes are a contract: ASCII only, Python
//! float repr, and integers kept apart from floats. Rust's own printer differs on all three.

use std::fmt::Write;

use serde_json::{Number, Value};
use sha2::{Digest, Sha256};

use crate::error::{Result, invalid};

#[derive(Clone, Copy, PartialEq)]
enum Layout {
    /// `sort_keys=True, separators=(',', ':')`: the form that gets hashed.
    Canonical,
    /// `indent=2`, keys in insertion order: the form of a saved record.
    Indented,
    /// Plain `json.dumps`, keys in insertion order: the form inside a status line.
    Inline,
}

/// SHA-256 of the canonical text, as hex.
pub fn fingerprint(value: &Value) -> Result<String> {
    let mut text = String::new();
    write_value(&mut text, value, Layout::Canonical, 0)?;
    Ok(sha256_hex(text.as_bytes()))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hex = String::with_capacity(64);
    for byte in Sha256::digest(bytes) {
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

/// The text of a saved record, without the final newline.
pub fn indented(value: &Value) -> Result<String> {
    let mut text = String::new();
    write_value(&mut text, value, Layout::Indented, 0)?;
    Ok(text)
}

/// The text of a value inside a status line.
pub fn inline(value: &Value) -> Result<String> {
    let mut text = String::new();
    write_value(&mut text, value, Layout::Inline, 0)?;
    Ok(text)
}

fn write_value(out: &mut String, value: &Value, layout: Layout, depth: usize) -> Result<()> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => out.push_str(&number_text(number)?),
        Value::String(text) => write_string(out, text),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                start_item(out, index, layout, depth + 1);
                write_value(out, item, layout, depth + 1)?;
            }
            end_block(out, ']', items.is_empty(), layout, depth);
        }
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            if layout == Layout::Canonical {
                // Byte order of UTF-8 is code point order, which is what Python sorts by.
                entries.sort_by_key(|(key, _)| key.as_str());
            }
            out.push('{');
            for (index, (key, item)) in entries.into_iter().enumerate() {
                start_item(out, index, layout, depth + 1);
                write_string(out, key);
                out.push_str(if layout == Layout::Canonical { ":" } else { ": " });
                write_value(out, item, layout, depth + 1)?;
            }
            end_block(out, '}', map.is_empty(), layout, depth);
        }
    }
    Ok(())
}

fn start_item(out: &mut String, index: usize, layout: Layout, depth: usize) {
    if index > 0 {
        out.push_str(if layout == Layout::Inline { ", " } else { "," });
    }
    newline(out, layout, depth);
}

fn end_block(out: &mut String, close: char, empty: bool, layout: Layout, depth: usize) {
    if !empty {
        newline(out, layout, depth);
    }
    out.push(close);
}

fn newline(out: &mut String, layout: Layout, depth: usize) {
    if layout == Layout::Indented {
        out.push('\n');
        out.push_str(&"  ".repeat(depth));
    }
}

fn write_string(out: &mut String, text: &str) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            ' '..='~' => out.push(c),
            _ => {
                let mut units = [0u16; 2];
                for unit in c.encode_utf16(&mut units) {
                    let _ = write!(out, "\\u{unit:04x}");
                }
            }
        }
    }
    out.push('"');
}

fn number_text(number: &Number) -> Result<String> {
    let text = number.to_string();
    if !text.contains(['.', 'e', 'E']) {
        return Ok(if text == "-0" { "0".into() } else { text });
    }
    match text.parse::<f64>() {
        Ok(value) if value.is_finite() => Ok(float_repr(value)),
        _ => invalid("Out of range float values are not JSON compliant"),
    }
}

/// Python's `repr(float)`: shortest digits that round-trip, positional for exponents from -4 to 15.
fn float_repr(value: f64) -> String {
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific.split_once('e').expect("LowerExp always writes an exponent");
    let exponent: i32 = exponent.parse().expect("LowerExp writes an integer exponent");
    let digits = mantissa.replace('.', "");
    let sign = if value.is_sign_negative() { "-" } else { "" };
    let body = if (-4..16).contains(&exponent) { positional(&digits, exponent) } else { exponential(&digits, exponent) };
    format!("{sign}{body}")
}

fn positional(digits: &str, exponent: i32) -> String {
    if exponent < 0 {
        return format!("0.{}{digits}", "0".repeat(exponent.unsigned_abs() as usize - 1));
    }
    let whole = exponent as usize + 1;
    if digits.len() <= whole {
        format!("{digits}{}.0", "0".repeat(whole - digits.len()))
    } else {
        format!("{}.{}", &digits[..whole], &digits[whole..])
    }
}

fn exponential(digits: &str, exponent: i32) -> String {
    let (first, rest) = digits.split_at(1);
    let fraction = if rest.is_empty() { String::new() } else { format!(".{rest}") };
    let sign = if exponent < 0 { '-' } else { '+' };
    format!("{first}{fraction}e{sign}{:02}", exponent.abs())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn canonical(value: &Value) -> String {
        let mut text = String::new();
        write_value(&mut text, value, Layout::Canonical, 0).unwrap();
        text
    }

    fn parsed(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn float_text_matches_python_repr() {
        let cases = [
            (0.0, "0.0"), (-0.0, "-0.0"), (1.0, "1.0"), (0.1, "0.1"), (1.5, "1.5"), (100.0, "100.0"),
            (0.0001, "0.0001"), (0.00001, "1e-05"), (1e15, "1000000000000000.0"), (1e16, "1e+16"),
            (1.5e16, "1.5e+16"), (1.5e300, "1.5e+300"), (1e-300, "1e-300"), (123456.789, "123456.789"),
            (9999999999999998.0, "9999999999999998.0"), (-2.5e-7, "-2.5e-07"),
        ];
        for (value, text) in cases {
            assert_eq!(float_repr(value), text);
        }
    }

    #[test]
    fn integers_and_floats_stay_apart() {
        assert_eq!(canonical(&parsed("[1, 1.0, 1e2, -0, -0.0, 123456789012345678901234567890]")),
                   "[1,1.0,100.0,0,-0.0,123456789012345678901234567890]");
    }

    #[test]
    fn strings_are_ascii_with_python_escapes() {
        let text = "a\"\\\n\t\u{7f}\u{e9}\u{1f600}";
        assert_eq!(canonical(&json!(text)), "\"a\\\"\\\\\\n\\t\\u007f\\u00e9\\ud83d\\ude00\"");
    }

    #[test]
    fn only_the_canonical_form_sorts_keys() {
        let value = parsed(r#"{"b": 1, "a": [2, {}], "c": []}"#);
        assert_eq!(canonical(&value), r#"{"a":[2,{}],"b":1,"c":[]}"#);
        assert_eq!(indented(&value).unwrap(), "{\n  \"b\": 1,\n  \"a\": [\n    2,\n    {}\n  ],\n  \"c\": []\n}");
    }

    #[test]
    fn out_of_range_float_has_no_fingerprint() {
        assert!(fingerprint(&parsed("[1e999]")).is_err());
    }

    #[test]
    fn fingerprint_hashes_the_sorted_compact_text() {
        let unsorted = parsed(r#"{"b":[1.5,"x"],"a":1}"#);
        assert_eq!(fingerprint(&unsorted).unwrap(), sha256_hex(br#"{"a":1,"b":[1.5,"x"]}"#));
    }
}
