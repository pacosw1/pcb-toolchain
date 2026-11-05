//! Reviewed placement rule geometry. Admission remains disabled until all rule kinds,
//! source verification and incremental dependency invalidation are implemented.
use crate::geom::turn_point;
use crate::problem::Pose;
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Debug, Deserialize)]
struct Selector {
    r#ref: String,
    pad: serde_json::Value,
}
#[derive(Debug, Deserialize)]
struct Pad {
    center: (f64, f64),
    #[serde(default)]
    size: Option<(f64, f64)>,
    #[serde(default)]
    shape: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    axis_aligned: Option<bool>,
    #[serde(default)]
    layers: Option<Vec<String>>,
}
#[derive(Debug, Deserialize)]
struct Part {
    #[serde(default)]
    origin: Option<(f64, f64)>,
    #[serde(default)]
    quarter: Option<f64>,
    #[serde(default)]
    locked: bool,
    #[serde(default)]
    courtyard: Option<(f64, f64, f64, f64)>,
    #[serde(default)]
    pads: BTreeMap<String, Vec<Pad>>,
}
#[derive(Debug, Deserialize)]
struct Geometry {
    refs: BTreeMap<String, Part>,
    #[serde(default)]
    bounds: Option<(f64, f64, f64, f64)>,
}
#[derive(Debug, Deserialize)]
struct Rule {
    id: String,
    kind: String,
    a: Option<Selector>,
    b: Option<Selector>,
    metric: Option<String>,
    min_mm: Option<f64>,
    max_mm: Option<f64>,
    #[serde(default)]
    refs: Vec<String>,
    #[serde(default)]
    retained_internal_copper: bool,
    #[serde(default)]
    r#ref: Option<String>,
    #[serde(default)]
    corridor_mm: Option<(f64, f64, f64, f64)>,
    #[serde(default)]
    exit_side: Option<String>,
}
#[derive(Debug, Deserialize)]
struct Contract {
    where_: BTreeMap<String, usize>,
    geometry: Geometry,
    rules: Vec<Rule>,
}

/// A compiled pin-distance rule. Values come from the producer-verified reviewed contract,
/// not from footprint-name heuristics. The original unit origin establishes its local coordinates.
#[derive(Debug)]
pub struct PinDistance {
    pub id: String,
    a: Endpoint,
    b: Endpoint,
    min: f64,
    max: f64,
}
#[derive(Debug)]
struct Endpoint {
    unit: usize,
    local: (f64, f64),
}

#[derive(Debug)]
struct CopperEndpoint {
    position: Endpoint,
    size: (f64, f64),
    circle: bool,
    layers: Vec<String>,
}
#[derive(Debug)]
pub struct Clearance {
    pub id: String,
    a: CopperEndpoint,
    b: CopperEndpoint,
    minimum: f64,
}

impl CopperEndpoint {
    fn parse(
        selector: &Selector,
        contract: &Contract,
        origins: &[(f64, f64)],
    ) -> crate::Result<Self> {
        let position = PinDistance::endpoint(selector, contract, origins)?;
        let pad = match &selector.pad {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Number(n) if n.is_i64() || n.is_u64() => n.to_string(),
            _ => return Err("invalid reviewed pin pad identifier".into()),
        };
        let p = &contract.geometry.refs[&selector.r#ref].pads[&pad][0];
        let size = p.size.ok_or("reviewed copper size missing")?;
        if !size.0.is_finite()
            || !size.1.is_finite()
            || size.0 <= 0.0
            || size.1 <= 0.0
            || p.kind.as_deref() == Some("np_thru_hole")
            || p.axis_aligned != Some(true)
        {
            return Err("unsupported reviewed copper geometry".into());
        }
        let circle = match p.shape.as_deref() {
            Some("circle") if size.0 == size.1 => true,
            Some("rect") => false,
            _ => return Err("unsupported reviewed copper shape".into()),
        };
        let layers = p.layers.clone().ok_or("reviewed copper layers missing")?;
        Ok(Self {
            position,
            size,
            circle,
            layers,
        })
    }
    fn size_at(&self, pose: &Pose) -> (f64, f64) {
        if pose[self.position.unit].2 % 2 == 0 {
            self.size
        } else {
            (self.size.1, self.size.0)
        }
    }
}

impl Clearance {
    pub fn affects(&self, unit: usize) -> bool {
        self.a.position.unit == unit || self.b.position.unit == unit
    }
    pub fn miss(&self, pose: &Pose) -> crate::Result<f64> {
        let a = &self.a;
        let b = &self.b;
        let (ax, ay) = PinDistance::point(&a.position, pose)?;
        let (bx, by) = PinDistance::point(&b.position, pose)?;
        let (aw, ah) = a.size_at(pose);
        let (bw, bh) = b.size_at(pose);
        let dx = (ax - bx).abs();
        let dy = (ay - by).abs();
        let gap = if a.circle && b.circle {
            crate::numeric::hypot(dx, dy) - (aw + bw) / 2.0
        } else if a.circle {
            crate::numeric::hypot((dx - bw / 2.0).max(0.0), (dy - bh / 2.0).max(0.0)) - aw / 2.0
        } else if b.circle {
            crate::numeric::hypot((dx - aw / 2.0).max(0.0), (dy - ah / 2.0).max(0.0)) - bw / 2.0
        } else {
            crate::numeric::hypot(
                (dx - aw / 2.0 - bw / 2.0).max(0.0),
                (dy - ah / 2.0 - bh / 2.0).max(0.0),
            )
        };
        Ok((self.minimum - gap).max(0.0))
    }
}

impl PinDistance {
    fn endpoint(
        selector: &Selector,
        contract: &Contract,
        origins: &[(f64, f64)],
    ) -> crate::Result<Endpoint> {
        let unit = *contract
            .where_
            .get(&selector.r#ref)
            .ok_or("reviewed pin reference is not mapped")?;
        let &(x, y) = origins.get(unit).ok_or("reviewed pin unit is not mapped")?;
        let part = contract
            .geometry
            .refs
            .get(&selector.r#ref)
            .ok_or("reviewed pin part missing")?;
        let pad = match &selector.pad {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Number(n) if n.is_i64() || n.is_u64() => n.to_string(),
            _ => return Err("invalid reviewed pin pad identifier".into()),
        };
        let pads = part.pads.get(&pad).ok_or("reviewed pin pad missing")?;
        if pads.len() != 1 {
            return Err("reviewed pin pad ambiguous".into());
        }
        let (px, py) = pads[0].center;
        if ![x, y, px, py].iter().all(|n| n.is_finite()) {
            return Err("reviewed pin coordinates must be finite".into());
        }
        Ok(Endpoint {
            unit,
            local: (px - x, py - y),
        })
    }
    fn point(endpoint: &Endpoint, pose: &Pose) -> crate::Result<(f64, f64)> {
        let &(x, y, turn) = pose.get(endpoint.unit).ok_or("reviewed pin pose missing")?;
        if !x.is_finite() || !y.is_finite() || turn > 3 {
            return Err("invalid reviewed pin pose".into());
        }
        let (px, py) = turn_point(endpoint.local, turn);
        Ok((x + px, y + py))
    }
    /// Miss in mm. A zero result is geometrically legal for this rule only.
    pub fn miss(&self, pose: &Pose) -> crate::Result<f64> {
        let (ax, ay) = Self::point(&self.a, pose)?;
        let (bx, by) = Self::point(&self.b, pose)?;
        let distance = crate::numeric::hypot(ax - bx, ay - by);
        Ok((self.min - distance).max(0.0).max(distance - self.max))
    }
    pub fn affects(&self, unit: usize) -> bool {
        self.a.unit == unit || self.b.unit == unit
    }
}

/// Parse pin-distance-only fixtures. Other kinds fail closed until their implementation is complete.
/// This does not establish source authenticity and must not be used to admit a search.
pub fn pin_distance_rules(
    value: &serde_json::Value,
    origins: &[(f64, f64)],
) -> crate::Result<Vec<PinDistance>> {
    let mut value = value.clone();
    let object = value
        .as_object_mut()
        .ok_or("reviewed contract must be an object")?;
    let where_ = object.remove("where").ok_or("reviewed mapping missing")?;
    object.insert("where_".into(), where_);
    let contract: Contract = serde_json::from_value(value)?;
    contract
        .rules
        .iter()
        .map(|rule| {
            if rule.kind != "pin_distance" || rule.metric.as_deref() != Some("pad_center_euclidean")
            {
                return Err("unsupported reviewed engineering rule".into());
            }
            if rule.min_mm.is_none() && rule.max_mm.is_none() {
                return Err("reviewed pin distance requires a bound".into());
            }
            let min = rule.min_mm.unwrap_or(0.0);
            let max = rule.max_mm.unwrap_or(f64::INFINITY);
            if !min.is_finite()
                || min < 0.0
                || rule.max_mm.is_some_and(|n| !n.is_finite())
                || max < min
            {
                return Err("invalid reviewed pin distance bounds".into());
            }
            Ok(PinDistance {
                id: rule.id.clone(),
                a: PinDistance::endpoint(
                    rule.a.as_ref().ok_or("missing endpoint")?,
                    &contract,
                    origins,
                )?,
                b: PinDistance::endpoint(
                    rule.b.as_ref().ok_or("missing endpoint")?,
                    &contract,
                    origins,
                )?,
                min,
                max,
            })
        })
        .collect()
}

/// Parse clearance-only fixtures. Other kinds fail closed; source authenticity is not established here.
pub fn clearance_rules(
    value: &serde_json::Value,
    origins: &[(f64, f64)],
) -> crate::Result<Vec<Clearance>> {
    let mut value = value.clone();
    let object = value
        .as_object_mut()
        .ok_or("reviewed contract must be an object")?;
    let where_ = object.remove("where").ok_or("reviewed mapping missing")?;
    object.insert("where_".into(), where_);
    let contract: Contract = serde_json::from_value(value)?;
    contract
        .rules
        .iter()
        .map(|rule| {
            if rule.kind != "clearance"
                || rule.metric.as_deref() != Some("copper_edge_2d")
                || rule.max_mm.is_some()
            {
                return Err("unsupported reviewed engineering rule".into());
            }
            let minimum = rule.min_mm.ok_or("reviewed clearance requires a minimum")?;
            if !minimum.is_finite() || minimum < 0.0 {
                return Err("invalid reviewed clearance bound".into());
            }
            let a = CopperEndpoint::parse(
                rule.a.as_ref().ok_or("missing endpoint")?,
                &contract,
                origins,
            )?;
            let b = CopperEndpoint::parse(
                rule.b.as_ref().ok_or("missing endpoint")?,
                &contract,
                origins,
            )?;
            if !a.layers.iter().any(|l| b.layers.contains(l))
                && !a.layers.iter().any(|l| l == "*.Cu")
                && !b.layers.iter().any(|l| l == "*.Cu")
            {
                return Err("reviewed copper endpoints have no common layer".into());
            }
            Ok(Clearance {
                id: rule.id.clone(),
                a,
                b,
                minimum,
            })
        })
        .collect()
}

#[derive(Debug)]
pub struct RigidGroup {
    pub id: String,
    members: Vec<(Endpoint, (f64, f64))>,
    fixed: bool,
}
impl RigidGroup {
    pub fn affects(&self, unit: usize) -> bool {
        self.members.iter().any(|(part, _)| part.unit == unit)
    }
    pub fn miss(&self, pose: &Pose) -> crate::Result<f64> {
        let mut first = None;
        for (member, original) in &self.members {
            let after = PinDistance::point(member, pose)?;
            let turn = pose[member.unit].2;
            let rotated = turn_point(*original, turn);
            let transform = (
                turn,
                crate::numeric::round_to(after.0 - rotated.0, 6),
                crate::numeric::round_to(after.1 - rotated.1, 6),
            );
            if self.fixed && transform != (0, 0.0, 0.0) {
                return Ok(1.0);
            }
            if first.is_some_and(|value| value != transform) {
                return Ok(1.0);
            }
            first = Some(transform);
        }
        Ok(0.0)
    }
}

/// Compile fixed and rigid group rules; caller must separately establish source authenticity.
pub fn rigid_rules(
    value: &serde_json::Value,
    origins: &[(f64, f64)],
) -> crate::Result<Vec<RigidGroup>> {
    let mut value = value.clone();
    let object = value
        .as_object_mut()
        .ok_or("reviewed contract must be an object")?;
    let where_ = object.remove("where").ok_or("reviewed mapping missing")?;
    object.insert("where_".into(), where_);
    let contract: Contract = serde_json::from_value(value)?;
    contract
        .rules
        .iter()
        .map(|rule| {
            if rule.kind != "fixed" && rule.kind != "rigid_group" {
                return Err("unsupported reviewed engineering rule".into());
            }
            let unique: std::collections::BTreeSet<_> = rule.refs.iter().collect();
            if unique.len() != rule.refs.len()
                || rule.refs.is_empty()
                || (rule.kind == "rigid_group" && rule.refs.len() < 2)
            {
                return Err("reviewed group needs distinct references".into());
            }
            let mut members = Vec::new();
            for reference in &rule.refs {
                let unit = *contract
                    .where_
                    .get(reference)
                    .ok_or("reviewed group reference not mapped")?;
                let &(x, y) = origins.get(unit).ok_or("reviewed group unit not mapped")?;
                let original = contract
                    .geometry
                    .refs
                    .get(reference)
                    .and_then(|p| p.origin)
                    .ok_or("reviewed group origin missing")?;
                if ![x, y, original.0, original.1].iter().all(|v| v.is_finite()) {
                    return Err("reviewed group coordinates must be finite".into());
                }
                members.push((
                    Endpoint {
                        unit,
                        local: (original.0 - x, original.1 - y),
                    },
                    original,
                ));
            }
            if rule.kind == "rigid_group"
                && members
                    .iter()
                    .any(|(member, _)| member.unit != members[0].0.unit)
            {
                return Err("reviewed rigid group was split before search".into());
            }
            Ok(RigidGroup {
                id: rule.id.clone(),
                members,
                fixed: rule.kind == "fixed" || rule.retained_internal_copper,
            })
        })
        .collect()
}

/// Compiled reviewed rules supported by this incremental port. Compilation is not admission:
/// a caller must also verify source provenance, locked parts, escape evidence and all other rule kinds.
#[derive(Debug)]
pub enum ReviewedRule {
    Pin(PinDistance),
    Clearance(Clearance),
    Rigid(RigidGroup),
    Connector(ConnectorAccess),
}
impl ReviewedRule {
    pub fn id(&self) -> &str {
        match self { Self::Pin(r) => &r.id, Self::Clearance(r) => &r.id,
            Self::Rigid(r) => &r.id, Self::Connector(r) => &r.id }
    }
    pub fn affects(&self, unit: usize) -> bool {
        match self {
            Self::Pin(r) => r.affects(unit),
            Self::Clearance(r) => r.affects(unit),
            Self::Rigid(r) => r.affects(unit),
            Self::Connector(r) => r.affects(unit),
        }
    }
    pub fn miss(&self, pose: &Pose) -> crate::Result<f64> {
        match self {
            Self::Pin(r) => r.miss(pose),
            Self::Clearance(r) => r.miss(pose),
            Self::Rigid(r) => r.miss(pose),
            Self::Connector(r) => r.miss(pose),
        }
    }
}
pub fn compile_supported_rules(
    value: &serde_json::Value,
    origins: &[(f64, f64)],
) -> crate::Result<Vec<ReviewedRule>> {
    let rows = value
        .get("rules")
        .and_then(|v| v.as_array())
        .ok_or("reviewed rules missing")?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let mut one = value.clone();
        one["rules"] = serde_json::Value::Array(vec![row.clone()]);
        match row.get("kind").and_then(|v| v.as_str()) {
            Some("pin_distance") => out.push(ReviewedRule::Pin(
                pin_distance_rules(&one, origins)?.remove(0),
            )),
            Some("clearance") => out.push(ReviewedRule::Clearance(
                clearance_rules(&one, origins)?.remove(0),
            )),
            Some("fixed" | "rigid_group") => {
                out.push(ReviewedRule::Rigid(rigid_rules(&one, origins)?.remove(0)))
            }
            Some("connector_access") => out.push(ReviewedRule::Connector(
                connector_rules(&one, origins)?.remove(0),
            )),
            _ => return Err("unsupported reviewed engineering rule".into()),
        }
    }
    Ok(out)
}

#[derive(Debug)]
struct Courtyard {
    reference: String,
    unit: usize,
    origin: Endpoint,
    quarter: u8,
    local_box: crate::geom::Rect,
}
#[derive(Debug)]
pub struct ConnectorAccess {
    pub id: String,
    connector: String,
    corridor: crate::geom::Rect,
    side: String,
    bounds: crate::geom::Rect,
    parts: Vec<Courtyard>,
}
impl ConnectorAccess {
    // Every unit may obstruct a connector corridor, including one with no connector rule of its own.
    pub fn affects(&self, _unit: usize) -> bool {
        true
    }
    pub fn miss(&self, pose: &Pose) -> crate::Result<f64> {
        let connector = self
            .parts
            .iter()
            .find(|p| p.reference == self.connector)
            .ok_or("reviewed connector missing")?;
        let (x, y) = PinDistance::point(&connector.origin, pose)?;
        let turn = (connector.quarter + pose[connector.unit].2) % 4;
        let box_ = self.corridor.turned(turn).shifted(x, y);
        let exits = match self.side.as_str() {
            "L" => box_.x0 <= self.bounds.x0,
            "R" => box_.x1 >= self.bounds.x1,
            "T" => box_.y0 <= self.bounds.y0,
            "B" => box_.y1 >= self.bounds.y1,
            _ => return Err("invalid connector exit".into()),
        };
        if !exits {
            return Ok(1.0);
        }
        for part in &self.parts {
            if part.reference == self.connector {
                continue;
            }
            let &(x, y, turn) = pose
                .get(part.unit)
                .ok_or("reviewed courtyard pose missing")?;
            if !x.is_finite() || !y.is_finite() || turn > 3 {
                return Err("invalid reviewed courtyard pose".into());
            }
            let other = part.local_box.turned(turn).shifted(x, y);
            if box_.x1.min(other.x1) > box_.x0.max(other.x0)
                && box_.y1.min(other.y1) > box_.y0.max(other.y0)
            {
                return Ok(1.0);
            }
        }
        Ok(0.0)
    }
}
pub fn connector_rules(
    value: &serde_json::Value,
    origins: &[(f64, f64)],
) -> crate::Result<Vec<ConnectorAccess>> {
    let mut value = value.clone();
    let object = value
        .as_object_mut()
        .ok_or("reviewed contract must be an object")?;
    let where_ = object.remove("where").ok_or("reviewed mapping missing")?;
    object.insert("where_".into(), where_);
    let contract: Contract = serde_json::from_value(value)?;
    let (x0, y0, x1, y1) = contract
        .geometry
        .bounds
        .ok_or("reviewed board bounds missing")?;
    if ![x0, y0, x1, y1].iter().all(|v| v.is_finite()) || x0 >= x1 || y0 >= y1 {
        return Err("invalid reviewed board bounds".into());
    }
    let bounds = crate::geom::Rect::new(x0, y0, x1, y1);
    let mut parts = Vec::new();
    for (reference, part) in &contract.geometry.refs {
        let unit = *contract
            .where_
            .get(reference)
            .ok_or("reviewed courtyard reference not mapped")?;
        let &(x, y) = origins.get(unit).ok_or("reviewed courtyard unit missing")?;
        let (px, py) = part.origin.ok_or("reviewed courtyard origin missing")?;
        let quarter = part
            .quarter
            .filter(|q| q.is_finite() && [0.0, 1.0, 2.0, 3.0].contains(q))
            .ok_or("invalid reviewed courtyard orientation")? as u8;
        let (a, b, c, d) = part.courtyard.ok_or("reviewed courtyard missing")?;
        if ![x, y, px, py, a, b, c, d].iter().all(|v| v.is_finite()) || a > c || b > d {
            return Err("invalid reviewed courtyard".into());
        }
        parts.push(Courtyard {
            reference: reference.clone(),
            unit,
            origin: Endpoint {
                unit,
                local: (px - x, py - y),
            },
            quarter,
            local_box: crate::geom::Rect::new(a - x, b - y, c - x, d - y),
        });
    }
    contract
        .rules
        .iter()
        .map(|rule| {
            if rule.kind != "connector_access"
                || rule.metric.as_deref() != Some("courtyard_corridor_2d")
            {
                return Err("unsupported reviewed engineering rule".into());
            }
            let connector = rule
                .r#ref
                .clone()
                .ok_or("reviewed connector reference missing")?;
            if !contract.geometry.refs.contains_key(&connector) {
                return Err("reviewed connector missing".into());
            }
            let (a, b, c, d) = rule
                .corridor_mm
                .ok_or("reviewed connector corridor missing")?;
            if ![a, b, c, d].iter().all(|v| v.is_finite())
                || a >= c
                || b >= d
                || a > 0.0
                || c < 0.0
                || b > 0.0
                || d < 0.0
            {
                return Err("invalid reviewed connector corridor".into());
            }
            let side = rule
                .exit_side
                .clone()
                .filter(|s| ["L", "R", "T", "B"].contains(&s.as_str()))
                .ok_or("invalid reviewed connector exit")?;
            // Clone immutable modeled geometry; every rule is independent of later callers.
            let parts = parts
                .iter()
                .map(|p| Courtyard {
                    reference: p.reference.clone(),
                    unit: p.unit,
                    origin: Endpoint {
                        unit: p.origin.unit,
                        local: p.origin.local,
                    },
                    quarter: p.quarter,
                    local_box: p.local_box,
                })
                .collect();
            Ok(ConnectorAccess {
                id: rule.id.clone(),
                connector,
                corridor: crate::geom::Rect::new(a, b, c, d),
                side,
                bounds,
                parts,
            })
        })
        .collect()
}

/// A native locked footprint must not move even when no manifest rule names it.
#[derive(Debug)]
pub struct NativeLock {
    pub reference: String,
    origin: Endpoint,
    original: (f64, f64),
}
impl NativeLock {
    pub fn affects(&self, unit: usize) -> bool {
        self.origin.unit == unit
    }
    pub fn miss(&self, pose: &Pose) -> crate::Result<f64> {
        let after = PinDistance::point(&self.origin, pose)?;
        Ok(if pose[self.origin.unit].2 != 0 || after != self.original {
            1.0
        } else {
            0.0
        })
    }
}
pub fn native_locks(
    value: &serde_json::Value,
    origins: &[(f64, f64)],
) -> crate::Result<Vec<NativeLock>> {
    let mut value = value.clone();
    let object = value
        .as_object_mut()
        .ok_or("reviewed contract must be an object")?;
    let where_ = object.remove("where").ok_or("reviewed mapping missing")?;
    object.insert("where_".into(), where_);
    let contract: Contract = serde_json::from_value(value)?;
    contract
        .geometry
        .refs
        .iter()
        .filter(|(_, part)| part.locked)
        .map(|(reference, part)| {
            let unit = *contract
                .where_
                .get(reference)
                .ok_or("native locked reference not mapped")?;
            let &(x, y) = origins.get(unit).ok_or("native locked unit missing")?;
            let original = part.origin.ok_or("native locked origin missing")?;
            if ![x, y, original.0, original.1].iter().all(|v| v.is_finite()) {
                return Err("invalid native locked origin".into());
            }
            Ok(NativeLock {
                reference: reference.clone(),
                origin: Endpoint {
                    unit,
                    local: (original.0 - x, original.1 - y),
                },
                original,
            })
        })
        .collect()
}

/// Geometric rules compiled for a producer-verified model. Not an admission or source-verification API.
/// Recompute all unit misses after a move: two-pin rules and connector corridors can depend on other units.
/// A geometric candidate blocker. This result is not source-review authorization.
#[derive(Debug, serde::Serialize, PartialEq)]
pub struct PoseBlocker {
    pub code: &'static str,
    pub id: String,
    pub refs: Vec<String>,
    pub miss: f64,
}

#[derive(Debug)]
pub struct ReviewedGeometry {
    rules: Vec<(ReviewedRule, std::collections::BTreeSet<String>, bool)>,
    locks: Vec<NativeLock>,
    unit_refs: Vec<std::collections::BTreeSet<String>>,
}
impl ReviewedGeometry {
    pub fn compile(
        value: &serde_json::Value,
        unit_refs: &[Vec<String>],
        origins: &[(f64, f64)],
    ) -> crate::Result<Self> {
        if unit_refs.len() != origins.len() {
            return Err("reviewed model origin cardinality differs".into());
        }
        let rows = value
            .get("rules")
            .and_then(|v| v.as_array())
            .ok_or("reviewed rules missing")?;
        let compiled = compile_supported_rules(value, origins)?;
        let mut mapping = BTreeMap::new();
        for (i, refs) in unit_refs.iter().enumerate() {
            for r in refs {
                if mapping.insert(r.clone(), i).is_some() {
                    return Err("reviewed model contains duplicate reference".into());
                }
            }
        }
        let reviewed_mapping: BTreeMap<String, usize> = serde_json::from_value(
            value
                .get("where")
                .ok_or("reviewed mapping missing")?
                .clone(),
        )?;
        if mapping != reviewed_mapping {
            return Err("reviewed model reference mapping changed".into());
        }
        let geometry_refs = value.get("geometry").and_then(|v| v.get("refs"))
            .and_then(|v| v.as_object()).ok_or("reviewed geometry references missing")?;
        if geometry_refs.len() != mapping.len() || geometry_refs.keys().any(|r| !mapping.contains_key(r)) {
            return Err("reviewed geometry population differs from model".into());
        }
        let mut rules = Vec::new();
        for (row, rule) in rows.iter().zip(compiled) {
            let kind = row
                .get("kind")
                .and_then(|v| v.as_str())
                .ok_or("reviewed kind missing")?;
            let mut refs = std::collections::BTreeSet::new();
            match kind {
                "fixed" | "rigid_group" => {
                    for reference in row
                        .get("refs")
                        .and_then(|v| v.as_array())
                        .ok_or("reviewed references missing")?
                    {
                        refs.insert(
                            reference
                                .as_str()
                                .ok_or("invalid reviewed reference")?
                                .to_owned(),
                        );
                    }
                }
                "connector_access" => {
                    refs.insert(
                        row.get("ref")
                            .and_then(|v| v.as_str())
                            .ok_or("reviewed connector missing")?
                            .to_owned(),
                    );
                }
                "pin_distance" | "clearance" => {
                    for endpoint in ["a", "b"] {
                        refs.insert(
                            row.get(endpoint)
                                .and_then(|e| e.get("ref"))
                                .and_then(|v| v.as_str())
                                .ok_or("reviewed endpoint missing")?
                                .to_owned(),
                        );
                    }
                }
                _ => return Err("unsupported reviewed engineering rule".into()),
            }
            rules.push((rule, refs, kind == "connector_access"));
        }
        Ok(Self {
            rules,
            locks: native_locks(value, origins)?,
            unit_refs: unit_refs
                .iter()
                .map(|r| r.iter().cloned().collect())
                .collect(),
        })
    }
    /// Equivalent to the reviewed pose miss for one unit, including the locks of referenced parts.
    pub fn miss_for_unit(&self, unit: usize, pose: &Pose) -> crate::Result<f64> {
        let mine = self.unit_refs.get(unit).ok_or("reviewed unit missing")?;
        if pose.len() != self.unit_refs.len() {
            return Err("reviewed pose cardinality differs".into());
        }
        let mut refs = std::collections::BTreeSet::new();
        let mut all = false;
        let mut sum = 0.0;
        for (rule, targets, connector) in &self.rules {
            if *connector || !targets.is_disjoint(mine) {
                all |= connector;
                refs.extend(targets.iter().cloned());
                sum += rule.miss(pose)?;
            }
        }
        for lock in &self.locks {
            if all || refs.contains(&lock.reference) {
                sum += lock.miss(pose)?;
            }
        }
        Ok(sum)
    }
    /// Final screen checks every native lock, even when no rule references that part.
    pub fn native_lock_miss_for_unit(&self, unit: usize, pose: &Pose) -> crate::Result<f64> {
        let mine = self.unit_refs.get(unit).ok_or("reviewed unit missing")?;
        if pose.len() != self.unit_refs.len() { return Err("reviewed pose cardinality differs".into()); }
        let mut sum = 0.0;
        for lock in &self.locks {
            if mine.contains(&lock.reference) { sum += lock.miss(pose)?; }
        }
        Ok(sum)
    }
    /// Evaluate every supported rule once, plus every native lock, at the final pose.
    /// The caller must independently verify source review and the actual written board.
    pub fn check_pose(&self, pose: &Pose) -> crate::Result<Vec<PoseBlocker>> {
        if pose.len() != self.unit_refs.len() || pose.iter().any(|(x,y,r)| !x.is_finite() || !y.is_finite() || *r > 3) {
            return Err("invalid reviewed placement pose".into());
        }
        let mut blockers=Vec::new();
        for (rule,refs,_) in &self.rules {
            let miss=rule.miss(pose)?;
            if !miss.is_finite() {return Err("invalid reviewed rule miss".into());}
            if miss > 0.0 {blockers.push(PoseBlocker {code:"constraint_violation",id:rule.id().to_owned(),
                refs:refs.iter().cloned().collect(),miss});}
        }
        for lock in &self.locks {
            let miss=lock.miss(pose)?;
            if miss > 0.0 {blockers.push(PoseBlocker {code:"native_locked_part_moved",id:format!("native-lock:{}",lock.reference),
                refs:vec![lock.reference.clone()],miss});}
        }
        Ok(blockers)
    }
    pub fn all_unit_misses(&self, pose: &Pose) -> crate::Result<Vec<f64>> {
        (0..self.unit_refs.len())
            .map(|i| self.miss_for_unit(i, pose))
            .collect()
    }
}
