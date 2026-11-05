//! Strict JSON and immutable file bindings, shared by project and thermal admission.
use crate::Result;
use iotroute::sha256::sha256;
use serde::{
    Deserialize, Deserializer,
    de::{self, MapAccess, Visitor},
};
use serde_json::{Value, json, value::RawValue};
use std::{
    collections::BTreeMap,
    fmt, fs,
    path::{Path, PathBuf},
};

struct Unique(BTreeMap<String, Box<RawValue>>);
impl<'de> Deserialize<'de> for Unique {
    fn deserialize<T: Deserializer<'de>>(d: T) -> std::result::Result<Self, T::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Unique;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                write!(f, "an object without duplicate keys")
            }
            fn visit_map<M: MapAccess<'de>>(
                self,
                mut m: M,
            ) -> std::result::Result<Unique, M::Error> {
                let mut rows = BTreeMap::new();
                while let Some((k, v)) = m.next_entry::<String, Box<RawValue>>()? {
                    if rows.insert(k.clone(), v).is_some() {
                        return Err(de::Error::custom(format!("duplicate JSON key: {k}")));
                    }
                }
                Ok(Unique(rows))
            }
        }
        d.deserialize_map(V)
    }
}
pub fn parse(text: &str) -> Result<Value> {
    let raw: Box<RawValue> = serde_json::from_str(text).map_err(|e| e.to_string())?;
    fn read(raw: &RawValue) -> Result<Value> {
        let text = raw.get();
        match text.as_bytes().first() {
            Some(b'{') => {
                let Unique(rows) = serde_json::from_str(text).map_err(|e| e.to_string())?;
                rows.into_iter()
                    .map(|(k, v)| Ok((k, read(&v)?)))
                    .collect::<Result<serde_json::Map<_, _>>>()
                    .map(Value::Object)
            }
            Some(b'[') => serde_json::from_str::<Vec<Box<RawValue>>>(text)
                .map_err(|e| e.to_string())?
                .iter()
                .map(|v| read(v))
                .collect::<Result<Vec<_>>>()
                .map(Value::Array),
            _ => serde_json::from_str(text).map_err(|e| e.to_string()),
        }
    }
    read(&raw)
}
pub fn path(value: &str) -> Result<PathBuf> {
    let p = Path::new(value);
    if !p.is_absolute() || fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(format!(
            "evidence paths must be absolute and not symlinks: {value}"
        ));
    }
    if p.exists() {
        p.canonicalize().map_err(|e| e.to_string())
    } else {
        Ok(p.to_path_buf())
    }
}
pub fn hash(p: &Path) -> Result<String> {
    let p = path(p.to_str().ok_or("non-UTF8 evidence path")?)?;
    fs::read(&p)
        .map(|b| sha256(&b))
        .map_err(|e| format!("missing evidence file: {}: {e}", p.display()))
}
pub fn descriptor(p: &Path) -> Result<Value> {
    Ok(json!({"path":path(p.to_str().ok_or("invalid path")?)?,"sha256":hash(p)?}))
}
pub fn check_descriptor(v: &Value) -> Result<Value> {
    let o = v
        .as_object()
        .filter(|o| o.len() == 2)
        .ok_or("missing exact file descriptor")?;
    let p = o
        .get("path")
        .and_then(Value::as_str)
        .ok_or("missing evidence path")?;
    let actual = descriptor(Path::new(p))?;
    if actual["sha256"] != v["sha256"] {
        return Err(format!("file descriptor is stale: {p}"));
    }
    Ok(actual)
}
pub fn read(p: &Path) -> Result<(Value, Value)> {
    let before = descriptor(p)?;
    let data = parse(&fs::read_to_string(p).map_err(|e| e.to_string())?)?;
    if !data.is_object() {
        return Err("evidence JSON must be an object".into());
    }
    if descriptor(p)? != before {
        return Err(format!("evidence changed while reading: {}", p.display()));
    }
    Ok((data, before))
}
pub fn check_inputs(v: &Value) -> Result<Value> {
    let rows = v.as_object().ok_or("missing evidence input hashes")?;
    let mut out = serde_json::Map::new();
    for (name, expected) in rows {
        let p = path(name)?;
        if expected.is_null() {
            if fs::symlink_metadata(&p).is_ok() {
                return Err(format!("absent input appeared: {name}"));
            }
        } else if !hex(expected) || hash(&p)? != expected.as_str().unwrap() {
            return Err(format!("evidence input changed: {name}"));
        }
        out.insert(p.to_string_lossy().into_owned(), expected.clone());
    }
    Ok(out.into())
}
pub fn hex(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}
pub fn merge(maps: &[&Value]) -> Result<Value> {
    let mut out = serde_json::Map::new();
    for map in maps {
        for (k, v) in map.as_object().ok_or("missing evidence input hashes")? {
            if out.get(k).is_some_and(|old| old != v) {
                return Err(format!("conflicting evidence input: {k}"));
            }
            out.insert(k.clone(), v.clone());
        }
    }
    Ok(out.into())
}
/// Python's compact sorted JSON, including ensure_ascii=True. Object maps are sorted by serde_json.
pub fn identity(v: &Value) -> String {
    let text = serde_json::to_string(v).expect("a JSON value serializes");
    let mut ascii = String::new();
    for c in text.chars() {
        if c.is_ascii() {
            ascii.push(c);
        } else {
            for unit in c.encode_utf16(&mut [0; 2]) {
                ascii.push_str(&format!("\\u{unit:04x}"));
            }
        }
    }
    sha256(ascii.as_bytes())
}
pub fn seal(mut v: Value) -> Value {
    let h = identity(&v);
    v["content_sha256"] = h.into();
    v
}
pub fn unseal(v: &Value) -> Result<()> {
    let mut body = v.clone();
    let h = body
        .as_object_mut()
        .ok_or("missing sealed evidence")?
        .remove("content_sha256");
    if h != Some(Value::String(identity(&body))) {
        return Err("native thermal capability content changed".into());
    }
    Ok(())
}
