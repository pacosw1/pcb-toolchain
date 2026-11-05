//! The run's JSON as `json.dumps` writes it: keys in the order given, ASCII only. stdout takes one line, result.json `indent=1`.
use crate::pytext::{Separators, dumps};
use serde_json::Value;

/// A value whose objects keep their key order, which serde_json's map does not.
#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Plain(Value),
    List(Vec<Json>),
    Object(Vec<(String, Json)>),
}

impl Json {
    pub fn object(pairs: impl IntoIterator<Item = (&'static str, Json)>) -> Json {
        Json::Object(pairs.into_iter().map(|(key, value)| (key.to_string(), value)).collect())
    }

    pub fn text(text: &str) -> Json {
        Json::Plain(Value::from(text))
    }

    pub fn number(number: impl Into<serde_json::Number>) -> Json {
        Json::Plain(Value::Number(number.into()))
    }

    pub fn texts<S: AsRef<str>>(items: &[S]) -> Json {
        Json::List(items.iter().map(|item| Json::text(item.as_ref())).collect())
    }

    /// `json.dumps(value)`.
    pub fn line(&self) -> String {
        match self {
            Json::Plain(value) => dumps(value, Separators::Spaced),
            Json::List(items) => format!("[{}]", items.iter().map(Json::line).collect::<Vec<_>>().join(", ")),
            Json::Object(pairs) => {
                let pairs = pairs.iter().map(|(key, value)| format!("{}: {}", key_text(key), value.line()));
                format!("{{{}}}", pairs.collect::<Vec<_>>().join(", "))
            }
        }
    }

    /// `json.dumps(value, indent=1)`.
    pub fn indented(&self) -> String {
        self.at_depth(1)
    }

    fn at_depth(&self, depth: usize) -> String {
        let (open, close, items): (char, char, Vec<String>) = match self {
            Json::Plain(value) => return dumps(value, Separators::Spaced),
            Json::List(items) => ('[', ']', items.iter().map(|item| item.at_depth(depth + 1)).collect()),
            Json::Object(pairs) => ('{', '}', pairs.iter().map(|(key, value)| format!("{}: {}", key_text(key), value.at_depth(depth + 1))).collect()),
        };
        if items.is_empty() {
            return format!("{open}{close}");
        }
        let pad = " ".repeat(depth);
        format!("{open}\n{pad}{}\n{}{close}", items.join(&format!(",\n{pad}")), " ".repeat(depth - 1))
    }

    /// The value under `key`, or null as `dict.get`.
    pub fn get(&self, key: &str) -> Json {
        let Json::Object(pairs) = self else { return Json::Plain(Value::Null) };
        pairs.iter().find(|(name, _)| name == key).map_or(Json::Plain(Value::Null), |(_, value)| value.clone())
    }
}

fn key_text(key: &str) -> String {
    dumps(&Value::from(key), Separators::Spaced)
}
