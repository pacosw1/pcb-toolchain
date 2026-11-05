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
    pads: BTreeMap<String, Vec<Pad>>,
}
#[derive(Debug, Deserialize)]
struct Geometry {
    refs: BTreeMap<String, Part>,
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
            dx.hypot(dy) - (aw + bw) / 2.0
        } else if a.circle {
            (dx - bw / 2.0).max(0.0).hypot((dy - bh / 2.0).max(0.0)) - aw / 2.0
        } else if b.circle {
            (dx - aw / 2.0).max(0.0).hypot((dy - ah / 2.0).max(0.0)) - bw / 2.0
        } else {
            (dx - (aw + bw) / 2.0)
                .max(0.0)
                .hypot((dy - (ah + bh) / 2.0).max(0.0))
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
        let distance = (ax - bx).hypot(ay - by);
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
