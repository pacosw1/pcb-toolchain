//! Text as Python prints it. Error messages and hashes in evidence files come from `repr` and `json.dumps`, so these are a
//! contract. Numbers go through as serde_json prints them: the values hashed here hold strings, lists and maps only.
use crate::sha256::sha256;
use serde_json::Value;

/// `repr(text)`.
pub fn repr(text: &str) -> String {
    let quote = if text.contains('\'') && !text.contains('"') { '"' } else { '\'' };
    let mut out = String::from(quote);
    for c in text.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == quote => {
                out.push('\\');
                out.push(c);
            }
            c if (c as u32) < 0x20 || c as u32 == 0x7f => out.push_str(&format!("\\x{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push(quote);
    out
}

/// `repr(list)` of strings.
pub fn repr_list<S: AsRef<str>>(items: &[S]) -> String {
    let texts: Vec<String> = items.iter().map(|item| repr(item.as_ref())).collect();
    format!("[{}]", texts.join(", "))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Separators {
    /// `json.dumps` defaults: `", "` and `": "`.
    Spaced,
    /// `separators=(',', ':')`.
    Compact,
}

/// `json.dumps(value, sort_keys=True)` with the given separators: ASCII only, keys in code point order.
pub fn dumps(value: &Value, separators: Separators) -> String {
    let mut out = String::new();
    write_value(&mut out, value, separators);
    out
}

/// SHA-256 of the compact text: `fingerprint` of tools/pcb_search/contracts.py.
pub fn fingerprint(value: &Value) -> String {
    sha256(dumps(value, Separators::Compact).as_bytes())
}

fn write_value(out: &mut String, value: &Value, separators: Separators) {
    let (comma, colon) = match separators {
        Separators::Spaced => (", ", ": "),
        Separators::Compact => (",", ":"),
    };
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => out.push_str(&number.to_string()),
        Value::String(text) => write_string(out, text),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push_str(comma);
                }
                write_value(out, item, separators);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (index, (key, item)) in map.iter().enumerate() {
                if index > 0 {
                    out.push_str(comma);
                }
                write_string(out, key);
                out.push_str(colon);
                write_value(out, item, separators);
            }
            out.push('}');
        }
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
            c => {
                let mut units = [0u16; 2];
                for unit in c.encode_utf16(&mut units) {
                    out.push_str(&format!("\\u{unit:04x}"));
                }
            }
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn repr_picks_the_quote_python_picks() {
        assert_eq!(repr("a"), "'a'");
        assert_eq!(repr("it's"), "\"it's\"");
        assert_eq!(repr("'\""), "'\\'\"'");
        assert_eq!(repr("a\\b\n"), "'a\\\\b\\n'");
        assert_eq!(repr_list(&["a", "b"]), "['a', 'b']");
    }

    #[test]
    fn dumps_sorts_keys_and_stays_ascii() {
        let value = json!({"b": ["x", "Ω😀"], "a": {"k": "\"q\""}});
        assert_eq!(dumps(&value, Separators::Spaced), r#"{"a": {"k": "\"q\""}, "b": ["x", "\u03a9\ud83d\ude00"]}"#);
        assert_eq!(dumps(&value, Separators::Compact), r#"{"a":{"k":"\"q\""},"b":["x","\u03a9\ud83d\ude00"]}"#);
    }
}
