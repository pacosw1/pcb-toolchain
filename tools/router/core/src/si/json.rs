//! JSON as Python's json module reads it: an object keeps its file order, a number keeps its int or float kind and a float is
//! the nearest double to its text. Spec order decides which rule applies, so serde_json's sorted map does not do here.
use super::py::float_repr;

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub fn parse(text: &str) -> Result<Json, String> {
        let mut reader = Reader { text: text.as_bytes(), at: 0 };
        let value = reader.value()?;
        reader.space();
        if reader.at != text.len() {
            return Err(format!("extra data at byte {}", reader.at));
        }
        Ok(value)
    }

    pub fn read(path: &std::path::Path) -> Result<Json, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        Json::parse(&text).map_err(|e| format!("{}: {e}", path.display()))
    }

    /// json.dumps(value, sort_keys=True, separators=(",", ":")): the text a reviewed record is hashed by.
    pub fn dumps_sorted(&self) -> String {
        fn quoted(text: &str, out: &mut String) {
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
                    _ => c.encode_utf16(&mut [0; 2]).iter().for_each(|unit| out.push_str(&format!("\\u{unit:04x}"))),
                }
            }
            out.push('"');
        }
        fn write(value: &Json, out: &mut String) {
            match value {
                Json::Null => out.push_str("null"),
                Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
                Json::Int(i) => out.push_str(&i.to_string()),
                Json::Float(f) => out.push_str(&float_repr(*f)),
                Json::Str(s) => quoted(s, out),
                Json::Arr(items) => {
                    out.push('[');
                    for (i, item) in items.iter().enumerate() {
                        if i > 0 {
                            out.push(',');
                        }
                        write(item, out);
                    }
                    out.push(']');
                }
                Json::Obj(pairs) => {
                    let mut sorted: Vec<&(String, Json)> = pairs.iter().collect();
                    sorted.sort_by(|a, b| a.0.chars().cmp(b.0.chars()));
                    out.push('{');
                    for (i, (key, item)) in sorted.into_iter().enumerate() {
                        if i > 0 {
                            out.push(',');
                        }
                        quoted(key, out);
                        out.push(':');
                        write(item, out);
                    }
                    out.push('}');
                }
            }
        }
        let mut out = String::new();
        write(self, &mut out);
        out
    }

    pub fn get(&self, key: &str) -> Option<&Json> {
        self.as_obj()?.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn as_str(&self) -> Option<&str> {
        if let Json::Str(s) = self { Some(s) } else { None }
    }

    /// A number; true and false are not numbers here.
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Json::Int(i) => Some(*i as f64),
            Json::Float(f) => Some(*f),
            _ => None,
        }
    }

    pub fn as_arr(&self) -> Option<&[Json]> {
        if let Json::Arr(a) = self { Some(a) } else { None }
    }

    pub fn as_obj(&self) -> Option<&[(String, Json)]> {
        if let Json::Obj(o) = self { Some(o) } else { None }
    }

    /// Python's truth value.
    pub fn truthy(&self) -> bool {
        match self {
            Json::Null => false,
            Json::Bool(b) => *b,
            Json::Int(i) => *i != 0,
            Json::Float(f) => *f != 0.0,
            Json::Str(s) => !s.is_empty(),
            Json::Arr(a) => !a.is_empty(),
            Json::Obj(o) => !o.is_empty(),
        }
    }

    /// Python's str() of a value inside a message: text as it is, everything else as repr.
    pub fn text(&self) -> String {
        self.as_str().map_or_else(|| self.repr(), str::to_string)
    }

    /// Python's repr.
    pub fn repr(&self) -> String {
        match self {
            Json::Null => "None".to_string(),
            Json::Bool(b) => if *b { "True" } else { "False" }.to_string(),
            Json::Int(i) => i.to_string(),
            Json::Float(f) => float_repr(*f),
            Json::Str(s) => super::py::str_repr(s),
            Json::Arr(a) => format!("[{}]", a.iter().map(Json::repr).collect::<Vec<_>>().join(", ")),
            Json::Obj(o) => format!("{{{}}}", o.iter().map(|(k, v)| format!("{}: {}", super::py::str_repr(k), v.repr())).collect::<Vec<_>>().join(", ")),
        }
    }

    /// A list of text, else None.
    pub fn strings(&self) -> Option<Vec<String>> {
        self.as_arr()?.iter().map(|v| v.as_str().map(str::to_string)).collect()
    }
}

struct Reader<'a> {
    text: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn space(&mut self) {
        while matches!(self.text.get(self.at), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn error<T>(&self, what: &str) -> Result<T, String> {
        Err(format!("{what} at byte {}", self.at))
    }

    fn word(&mut self, word: &str, value: Json) -> Result<Json, String> {
        if self.text[self.at..].starts_with(word.as_bytes()) {
            self.at += word.len();
            return Ok(value);
        }
        self.error("expecting a value")
    }

    fn value(&mut self) -> Result<Json, String> {
        self.space();
        match self.text.get(self.at) {
            Some(b'{') => self.object(),
            Some(b'[') => self.array(),
            Some(b'"') => self.string().map(Json::Str),
            Some(b't') => self.word("true", Json::Bool(true)),
            Some(b'f') => self.word("false", Json::Bool(false)),
            Some(b'n') => self.word("null", Json::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => self.error("expecting a value"),
        }
    }

    fn object(&mut self) -> Result<Json, String> {
        self.at += 1;
        let mut items: Vec<(String, Json)> = Vec::new();
        self.space();
        if self.text.get(self.at) == Some(&b'}') {
            self.at += 1;
            return Ok(Json::Obj(items));
        }
        loop {
            self.space();
            if self.text.get(self.at) != Some(&b'"') {
                return self.error("expecting a property name");
            }
            let key = self.string()?;
            self.space();
            if self.text.get(self.at) != Some(&b':') {
                return self.error("expecting ':'");
            }
            self.at += 1;
            let value = self.value()?;
            // A repeated key keeps its first place and its last value, as a Python dict does.
            match items.iter_mut().find(|(k, _)| *k == key) {
                Some(item) => item.1 = value,
                None => items.push((key, value)),
            }
            self.space();
            match self.text.get(self.at) {
                Some(b',') => self.at += 1,
                Some(b'}') => {
                    self.at += 1;
                    return Ok(Json::Obj(items));
                }
                _ => return self.error("expecting ',' or '}'"),
            }
        }
    }

    fn array(&mut self) -> Result<Json, String> {
        self.at += 1;
        let mut items = Vec::new();
        self.space();
        if self.text.get(self.at) == Some(&b']') {
            self.at += 1;
            return Ok(Json::Arr(items));
        }
        loop {
            items.push(self.value()?);
            self.space();
            match self.text.get(self.at) {
                Some(b',') => self.at += 1,
                Some(b']') => {
                    self.at += 1;
                    return Ok(Json::Arr(items));
                }
                _ => return self.error("expecting ',' or ']'"),
            }
        }
    }

    fn number(&mut self) -> Result<Json, String> {
        let start = self.at;
        while matches!(self.text.get(self.at), Some(b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9')) {
            self.at += 1;
        }
        let text = std::str::from_utf8(&self.text[start..self.at]).expect("ascii");
        if let Ok(i) = text.parse::<i64>() {
            return Ok(Json::Int(i));
        }
        text.parse::<f64>().map(Json::Float).map_err(|_| format!("not a number: {text}"))
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let digits = self.text.get(self.at..self.at + 4).and_then(|d| std::str::from_utf8(d).ok()).ok_or("short \\u escape")?;
        self.at += 4;
        u32::from_str_radix(digits, 16).map_err(|_| format!("bad \\u escape {digits}"))
    }

    fn escape(&mut self, out: &mut Vec<u8>) -> Result<(), String> {
        let code = *self.text.get(self.at).ok_or("unterminated string")?;
        self.at += 1;
        let plain = match code {
            b'"' | b'\\' | b'/' => code,
            b'b' => 8,
            b'f' => 12,
            b'n' => b'\n',
            b'r' => b'\r',
            b't' => b'\t',
            b'u' => {
                let mut c = self.hex4()?;
                if (0xd800..0xdc00).contains(&c) && self.text[self.at..].starts_with(b"\\u") {
                    self.at += 2;
                    c = 0x10000 + ((c - 0xd800) << 10) + (self.hex4()?.wrapping_sub(0xdc00) & 0x3ff);
                }
                let ch = char::from_u32(c).unwrap_or(char::REPLACEMENT_CHARACTER);
                out.extend_from_slice(ch.encode_utf8(&mut [0; 4]).as_bytes());
                return Ok(());
            }
            _ => return self.error("bad escape"),
        };
        out.push(plain);
        Ok(())
    }

    fn string(&mut self) -> Result<String, String> {
        self.at += 1;
        let mut out = Vec::new();
        loop {
            let byte = *self.text.get(self.at).ok_or("unterminated string")?;
            self.at += 1;
            match byte {
                b'"' => return String::from_utf8(out).map_err(|e| e.to_string()),
                b'\\' => self.escape(&mut out)?,
                _ => out.push(byte),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_object_keeps_its_file_order() {
        let v = Json::parse(r#"{"b": 1, "a": 2.5, "b": 3}"#).unwrap();
        assert_eq!(v.as_obj().unwrap().iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), ["b", "a"]);
        assert_eq!(v.get("b"), Some(&Json::Int(3)));
    }

    #[test]
    fn numbers_keep_their_kind_and_print_as_python() {
        assert_eq!(Json::parse("90").unwrap().repr(), "90");
        assert_eq!(Json::parse("90.0").unwrap().repr(), "90.0");
        assert_eq!(Json::parse("1e-5").unwrap().repr(), "1e-05");
    }

    #[test]
    fn repr_follows_python() {
        let v = Json::parse(r#"{"a": ["x", null, true], "b": {"c": 0.22}}"#).unwrap();
        assert_eq!(v.repr(), "{'a': ['x', None, True], 'b': {'c': 0.22}}");
    }

    #[test]
    fn escapes_read_back() {
        assert_eq!(Json::parse(r#""a\né😀""#).unwrap(), Json::Str("a\né😀".to_string()));
    }

    #[test]
    fn bad_text_is_an_error() {
        assert!(Json::parse("{").is_err());
        assert!(Json::parse("[1,]").is_err());
        assert!(Json::parse("1 2").is_err());
    }

    #[test]
    fn dumps_sorted_is_python_json_dumps() {
        let value = Json::parse(r#"{"b": [1, 2.5, null, true], "a": {"é": "q\"\n\u0001"}, "C": 1e3}"#).unwrap();
        assert_eq!(value.dumps_sorted(), r#"{"C":1000.0,"a":{"\u00e9":"q\"\n\u0001"},"b":[1,2.5,null,true]}"#);
    }
}
