//! The solver-independent routing problem (`iot-lab.route-problem.v1`), read strictly.
//!
//! Rectangular regions and copper envelopes only. Requirements this model cannot hold stay in `unsupported` and make
//! the search abstain. The input hash binds evidence; it does not show that the model is complete.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};

use crate::error::{Result, invalid};
use crate::pyjson::fingerprint;

pub type Point = [f64; 2];

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}

#[derive(Debug)]
pub struct NetRule {
    pub width: f64,
    pub clearance: f64,
    pub layers: Vec<String>,
}

#[derive(Debug)]
pub struct Obstacle {
    pub name: String,
    pub bounds: Rect,
    pub layers: Vec<String>,
    /// Empty for mechanical and keepout obstacles.
    pub net: String,
    pub clearance: f64,
}

#[derive(Debug)]
pub struct Connection {
    pub name: String,
    pub net: String,
    pub start: Point,
    pub end: Point,
    /// Layers reachable at both ends, not the union of what each end offers.
    pub layers: Vec<String>,
}

type Nets = BTreeMap<String, NetRule>;
type Layers = BTreeSet<String>;

#[derive(Debug)]
pub struct Problem {
    pub bounds: Rect,
    pub edge_clearance: f64,
    pub nets: Nets,
    pub obstacles: Vec<Obstacle>,
    pub connections: Vec<Connection>,
    pub pair_clearances: BTreeMap<(String, String), f64>,
    pub unsupported: Vec<String>,
    pub identity: String,
}

impl Problem {
    pub fn read(raw: &Value) -> Result<Problem> {
        let root = read_root(raw)?;
        let layers = read_layers(&root["layers"])?;
        let nets = read_nets(rows(&root["nets"]), &layers)?;
        let obstacles = rows(&root["obstacles"]).iter().map(|row| read_obstacle(row, &nets, &layers))
            .collect::<Result<Vec<_>>>()?;
        let connections = rows(&root["connections"]).iter().map(|row| read_connection(row, &nets, &layers))
            .collect::<Result<Vec<_>>>()?;
        check_unique(obstacles.iter().map(|row| row.name.as_str()))?;
        check_unique(connections.iter().map(|row| row.name.as_str()))?;
        let pair_clearances = read_pairs(rows(&root["pair_clearances"]), &nets)?;
        let unsupported = read_unsupported(&root["unsupported"])?;
        Ok(Problem {
            bounds: read_box(&root["bounds"])?,
            edge_clearance: number(&root["edge_clearance"], "edge clearance")?,
            nets, obstacles, connections, pair_clearances, unsupported,
            identity: fingerprint(raw)?,
        })
    }

    /// The gap between `net` and `other`: the strictest of both nets, the item and any pair rule. `other` may be empty.
    pub fn gap(&self, net: &str, other: &str, other_clearance: f64) -> f64 {
        let other_rule = self.nets.get(other).map_or(0.0, |rule| rule.clearance);
        let pair = self.pair_clearances.get(&sorted_pair(net, other)).copied().unwrap_or(0.0);
        self.nets[net].clearance.max(other_clearance).max(other_rule).max(pair)
    }
}

/// The top-level object, with its schema, sources and array fields checked.
fn read_root(raw: &Value) -> Result<&Map<String, Value>> {
    const FIELDS: &[&str] = &["schema", "bounds", "edge_clearance", "edge_source", "layers", "nets", "obstacles",
                              "connections", "pair_clearances", "unsupported", "inputs"];
    let root = raw.as_object().filter(|row| has_exactly(row, FIELDS) && row["schema"] == "iot-lab.route-problem.v1");
    let Some(root) = root else { return invalid("unknown/missing route contract fields or schema") };
    if !root["edge_source"].as_str().is_some_and(|source| !source.is_empty()) {
        return invalid("edge clearance requires a source");
    }
    check_inputs(&root["inputs"])?;
    for field in ["layers", "nets", "obstacles", "connections", "pair_clearances"] {
        if !root[field].is_array() {
            return invalid(format!("{field} must be an array"));
        }
    }
    Ok(root)
}

fn rows(value: &Value) -> &[Value] {
    value.as_array().map_or(&[], Vec::as_slice)
}

fn has_exactly(row: &Map<String, Value>, fields: &[&str]) -> bool {
    row.len() == fields.len() && fields.iter().all(|field| row.contains_key(*field))
}

fn item<'a>(row: &'a Value, fields: &[&str]) -> Result<&'a Map<String, Value>> {
    match row.as_object() {
        Some(map) if has_exactly(map, fields) => Ok(map),
        _ => invalid("unknown/missing fields in route item"),
    }
}

fn sorted_pair(a: &str, b: &str) -> (String, String) {
    if a <= b { (a.into(), b.into()) } else { (b.into(), a.into()) }
}

fn check_inputs(inputs: &Value) -> Result<()> {
    let Some(inputs) = inputs.as_object().filter(|map| !map.is_empty()) else {
        return invalid("input fingerprints required");
    };
    let is_sha256 = |value: &Value| value.as_str().is_some_and(|text| {
        text.len() == 64 && text.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
    });
    if inputs.iter().any(|(name, value)| name.is_empty() || !is_sha256(value)) {
        return invalid("invalid input fingerprint");
    }
    Ok(())
}

fn read_layers(raw: &Value) -> Result<Layers> {
    let names: Vec<Option<&str>> = rows(raw).iter().map(Value::as_str).collect();
    let layers: Layers = names.iter().flatten().map(|name| name.to_string()).collect();
    if names.is_empty() || names.iter().any(|name| name.is_none_or(str::is_empty)) || layers.len() != names.len() {
        return invalid("unique nonempty layers required");
    }
    Ok(layers)
}

fn layer_mask(raw: &Value, layers: &Layers) -> Result<Vec<String>> {
    let names: Option<Vec<String>> = raw.as_array()
        .and_then(|rows| rows.iter().map(|row| row.as_str().map(String::from)).collect());
    match names {
        Some(names) if !names.is_empty()
            && names.iter().collect::<BTreeSet<_>>().len() == names.len()
            && names.iter().all(|name| layers.contains(name)) => Ok(names),
        _ => invalid("invalid layer mask"),
    }
}

fn read_nets(raw: &[Value], layers: &Layers) -> Result<Nets> {
    let mut nets = BTreeMap::new();
    for row in raw {
        let row = item(row, &["name", "width", "clearance", "layers", "source"])?;
        let nonempty = |field: &str| row[field].as_str().filter(|text| !text.is_empty());
        let (Some(name), Some(_)) = (nonempty("name"), nonempty("source")) else {
            return invalid("net name and rule source required");
        };
        nets.insert(name.to_string(), NetRule {
            width: positive(&row["width"], "width")?,
            clearance: number(&row["clearance"], "clearance")?,
            layers: layer_mask(&row["layers"], layers)?,
        });
    }
    if nets.len() != raw.len() {
        return invalid("duplicate net");
    }
    Ok(nets)
}

fn read_obstacle(row: &Value, nets: &Nets, layers: &Layers) -> Result<Obstacle> {
    let row = item(row, &["name", "bounds", "layers", "net", "clearance"])?;
    let Some(net) = row["net"].as_str().filter(|net| net.is_empty() || nets.contains_key(*net)) else {
        return invalid("obstacle net lacks a rule");
    };
    Ok(Obstacle {
        bounds: read_box(&row["bounds"])?,
        layers: layer_mask(&row["layers"], layers)?,
        net: net.into(),
        clearance: number(&row["clearance"], "obstacle clearance")?,
        name: item_name(&row["name"])?,
    })
}

fn read_connection(row: &Value, nets: &Nets, layers: &Layers) -> Result<Connection> {
    let row = item(row, &["name", "net", "start", "end", "layers"])?;
    let Some((net, rule)) = row["net"].as_str().and_then(|net| Some((net, nets.get(net)?))) else {
        return invalid("connection net lacks a rule");
    };
    let mask = layer_mask(&row["layers"], layers)?;
    if !mask.iter().all(|layer| rule.layers.contains(layer)) {
        return invalid("connection requests a forbidden net layer");
    }
    Ok(Connection {
        start: read_point(&row["start"])?,
        end: read_point(&row["end"])?,
        net: net.into(),
        layers: mask,
        name: item_name(&row["name"])?,
    })
}

fn item_name(raw: &Value) -> Result<String> {
    match raw.as_str() {
        Some(name) if !name.is_empty() => Ok(name.into()),
        _ => invalid("unique item names required"),
    }
}

fn check_unique<'a>(mut names: impl Iterator<Item = &'a str>) -> Result<()> {
    let mut seen = BTreeSet::new();
    if names.all(|name| seen.insert(name)) { Ok(()) } else { invalid("unique item names required") }
}

fn read_pairs(raw: &[Value], nets: &Nets) -> Result<BTreeMap<(String, String), f64>> {
    let mut pairs = BTreeMap::new();
    for row in raw {
        let row = item(row, &["nets", "clearance", "source"])?;
        let Some(key) = pair_key(row, nets).filter(|key| !pairs.contains_key(key)) else {
            return invalid("invalid net-pair clearance");
        };
        pairs.insert(key, number(&row["clearance"], "pair clearance")?);
    }
    Ok(pairs)
}

/// The sorted names of a sourced pair of two distinct known nets.
fn pair_key(row: &Map<String, Value>, nets: &Nets) -> Option<(String, String)> {
    row["source"].as_str().filter(|source| !source.trim().is_empty())?;
    let [a, b] = row["nets"].as_array()?.as_slice() else { return None };
    let (a, b) = (a.as_str()?, b.as_str()?);
    (a != b && nets.contains_key(a) && nets.contains_key(b)).then(|| sorted_pair(a, b))
}

fn read_unsupported(raw: &Value) -> Result<Vec<String>> {
    let items: Option<Vec<String>> = raw.as_array().and_then(|rows| {
        rows.iter().map(|row| row.as_str().filter(|text| !text.is_empty()).map(String::from)).collect()
    });
    items.map_or_else(|| invalid("unsupported requirements must be explicit strings"), Ok)
}

/// A finite number that is not negative. An overflowing literal such as 1e999 counts as not finite.
pub fn number(raw: &Value, name: &str) -> Result<f64> {
    check_number(raw.as_f64().unwrap_or(f64::NAN), name)
}

/// A finite number above zero.
pub fn positive(raw: &Value, name: &str) -> Result<f64> {
    check_positive(raw.as_f64().unwrap_or(f64::NAN), name)
}

fn check_number(value: f64, name: &str) -> Result<f64> {
    if !value.is_finite() {
        return invalid(format!("{name} must be finite"));
    }
    if value < 0.0 {
        return invalid(format!("{name} out of range"));
    }
    Ok(value)
}

pub fn check_positive(value: f64, name: &str) -> Result<f64> {
    if check_number(value, name)? == 0.0 {
        return invalid(format!("{name} out of range"));
    }
    Ok(value)
}

fn coordinates(values: &[Value]) -> Result<Point> {
    let finite = |raw: &Value| raw.as_f64().filter(|value| value.is_finite());
    if let [x, y] = values {
        if let (Some(x), Some(y)) = (finite(x), finite(y)) {
            return Ok([x, y]);
        }
    }
    invalid("point requires two finite coordinates")
}

pub fn read_point(raw: &Value) -> Result<Point> {
    coordinates(rows(raw))
}

pub fn read_box(raw: &Value) -> Result<Rect> {
    let Some(values) = raw.as_array().filter(|values| values.len() == 4) else {
        return invalid("box requires four coordinates");
    };
    let ([x0, y0], [x1, y1]) = (coordinates(&values[..2])?, coordinates(&values[2..])?);
    if x0 >= x1 || y0 >= y1 {
        return invalid("box must have positive area");
    }
    Ok(Rect { x0, y0, x1, y1 })
}
