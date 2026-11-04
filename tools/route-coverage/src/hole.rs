//! Analytic containment of each physical drill in its source-bound DSN obstacle.
use crate::{
    Result,
    board::NmPoint,
    decimal::{self as dec, D, Point},
    dsn::{self, Dsn, num},
    evidence,
};
use iotroute::kicad::sexpr::Node;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
mod backend;

pub const SCHEMA: &str = "iot-lab.route-hole-coverage.v2";
pub const DRILLED_SCHEMA: &str = "iot-lab.route-drilled-coverage.v1";
pub const EXPORTER_SOURCE: &str = "https://gitlab.com/kicad/code/kicad/-/blob/10.0.6/pcbnew/specctra_import_export/specctra_export.cpp";
const APPLICABILITY_SOURCE: &str = "https://gitlab.com/kicad/code/kicad/-/blob/10.0.6/pcbnew/drc/drc_test_provider_copper_clearance.cpp#L582-587";
const PAD_FIELDS: &str = "reference pad net side footprint_position_mm footprint_rotation_deg position_mm size_mm drill_mm drill_offset_mm shape layers";
const PHYSICAL_FIELDS: &str = "identity rotation_deg export_pin";
#[derive(Clone, Deserialize)]
pub struct Scope {
    pub active_nets: Vec<String>,
    pub layers: Vec<String>,
    pub required_mm: Value,
    pub clearance_floor_mm: Value,
}
impl Scope {
    fn validate(&self) -> Result<(D, D)> {
        if self.active_nets.is_empty()
            || self.active_nets.iter().any(String::is_empty)
            || self.active_nets.iter().collect::<BTreeSet<_>>().len() != self.active_nets.len()
        {
            return Err("missing or ambiguous active nets".into());
        }
        if self.layers.len() != 1 || !matches!(self.layers[0].as_str(), "F.Cu" | "B.Cu") {
            return Err("drilled proof requires one exact actual outer routing layer".into());
        }
        let required = dec::value(&self.required_mm)?;
        let floor = dec::value(&self.clearance_floor_mm)?;
        if required < dec::zero() || floor < dec::zero() {
            return Err("negative native requirement or DSN clearance".into());
        }
        Ok((required, floor))
    }
}
#[derive(Deserialize)]
pub struct PthRequest {
    pub dsn_text: String,
    pub pads: Vec<Value>,
    #[serde(flatten)]
    pub scope: Scope,
}
#[derive(Clone, Deserialize)]
pub struct DrilledRequest {
    pub dsn_text: String,
    pub holes: Vec<Value>,
    #[serde(flatten)]
    pub scope: Scope,
    #[serde(default = "default_applicability")]
    pub applicability: String,
    #[serde(default)]
    pub backend_command: Vec<String>,
    #[serde(default)]
    pub backend_policy: Value,
}
fn default_applicability() -> String {
    "reject_same_net".into()
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key]
        .as_str()
        .ok_or(format!("missing native drilled {key}"))
}
fn fields(v: &Value, names: &str) -> bool {
    let Some(o) = v.as_object() else { return false };
    o.keys().map(String::as_str).collect::<BTreeSet<_>>() == names.split_whitespace().collect()
}
fn string_list(v: &Value) -> Result<Vec<String>> {
    v.as_array()
        .ok_or("missing native layer list")?
        .iter()
        .map(|s| {
            s.as_str()
                .map(str::to_string)
                .ok_or("unknown native layer".into())
        })
        .collect()
}
fn validate_layers(v: &Value, layer: &str, actual: &BTreeMap<String, String>) -> Result<()> {
    let l = string_list(v)?;
    if !l.contains(&layer.to_string())
        || l.iter().collect::<BTreeSet<_>>().len() != l.len()
        || l.iter().any(|n| !actual.contains_key(n))
    {
        return Err("native PTH lacks routing-layer copper".into());
    }
    Ok(())
}
fn alias(number: &str, pin: &str) -> bool {
    pin == number
        || pin
            .strip_prefix(number)
            .and_then(|s| s.strip_prefix('@'))
            .is_some_and(|s| {
                !s.is_empty() && !s.starts_with('0') && s.bytes().all(|c| c.is_ascii_digit())
            })
}
fn extend(v: &mut Value, extra: Value) {
    v.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
}
pub fn inspect(req: &PthRequest) -> Value {
    let mut out = json!({"schema":SCHEMA,"status":"blocked","qualified":false,"covered_pads":[],
        "scope":"other-net circular PTH drills in circle/rectangle copper versus new tracks; preserved native source and final fresh gate required"});
    match inspect_pth(req, &mut out) {
        Ok(extra) => extend(&mut out, extra),
        Err(e) => out["cause"] = e.into(),
    }
    out
}
fn inspect_pth(req: &PthRequest, out: &mut Value) -> Result<Value> {
    if req.pads.is_empty() {
        return Err("missing native PTH geometry".into());
    }
    let (required, floor) = req.scope.validate()?;
    let model = Dsn::new(&req.dsn_text, &req.scope.layers)?;
    let layer = &req.scope.layers[0];
    if !req.scope.active_nets.iter().all(|n| model.nets.contains(n)) {
        return Err("active net missing from actual DSN".into());
    }
    let mut counts = BTreeMap::new();
    for p in &req.pads {
        *counts
            .entry((p["reference"].to_string(), p["pad"].to_string()))
            .or_insert(0usize) += 1;
    }
    let mut seen = BTreeSet::new();
    let mut ids = BTreeSet::new();
    let mut exports = BTreeSet::new();
    for p in &req.pads {
        let physical = fields(p, &format!("{PAD_FIELDS} {PHYSICAL_FIELDS}"));
        if !physical && !fields(p, PAD_FIELDS) {
            return Err("unknown native PTH geometry fields".into());
        }
        let reference = text(p, "reference")?;
        let number = text(p, "pad")?;
        let net = text(p, "net")?;
        if [reference, number, net].iter().any(|s| s.is_empty()) {
            return Err("ambiguous native PTH reference/pad/net".into());
        }
        let key = (p["reference"].to_string(), p["pad"].to_string());
        let pin = if physical {
            text(p, "export_pin")?
        } else {
            number
        };
        if physical {
            let id = text(p, "identity")?;
            if id.is_empty() || !ids.insert(id) {
                return Err("missing or duplicate physical PTH identity".into());
            }
            if !alias(number, pin) {
                return Err("ambiguous physical exported PTH pin".into());
            }
        } else if seen.contains(&key) || counts[&key] != 1 {
            return Err("repeated PTH requires physical source identity".into());
        }
        if !exports.insert((reference, pin)) {
            return Err("ambiguous physical exported PTH pin".into());
        }
        seen.insert(key.clone());
        if req.scope.active_nets.contains(&net.to_string()) {
            return Err("active same-net PTH requires a different proof".into());
        }
        if p["side"] != "front" || !matches!(p["shape"].as_str(), Some("circle" | "rect")) {
            return Err("mirrored or unsupported native PTH copper".into());
        }
        if p["shape"] == "rect" && !physical {
            return Err("rectangle requires explicit native pad rotation".into());
        }
        let size = dec::pair(&p["size_mm"])?;
        let drill = dec::pair(&p["drill_mm"])?;
        if (p["shape"] == "circle" && size[0] != size[1])
            || drill[0] != drill[1]
            || dec::pair(&p["drill_offset_mm"])? != [dec::zero(), dec::zero()]
            || drill[0] <= dec::zero()
            || size.iter().min().unwrap() <= &drill[0]
        {
            return Err("slot, offset or malformed native PTH".into());
        }
        validate_layers(&p["layers"], layer, &model.layers)?;
        let position = dec::pair(&p["position_mm"])?;
        let fp_rotation = dec::angle(&p["footprint_rotation_deg"])?;
        let native_rotation = if physical {
            dec::angle(&p["rotation_deg"])?
        } else {
            0
        };
        let (image_name, image, place) = model.image(p)?;
        let pins = dsn::pins(image)?;
        let pin = pins
            .get(pin)
            .ok_or("native physical PTH missing from DSN image pins")?;
        let export = if physical {
            text(p, "export_pin")?
        } else {
            number
        };
        if model
            .members
            .get(&format!("{reference}-{export}"))
            .map(String::as_str)
            != Some(net)
        {
            return Err("DSN PTH electrical membership differs from native".into());
        }
        let shape = model.shape(&pin.stack, layer)?;
        if shape.head() != p["shape"].as_str() {
            return Err("missing or ambiguous source-matched PTH obstacle on routing layer".into());
        }
        let center = model.center(place, &pin.xy)?;
        let displacement2 = dec::squared(&center, &position);
        let radius = dec::half(&drill[0]) + &required;
        let mut record = json!({});
        let remaining;
        let covered;
        if shape.is("circle") {
            let obstacle = obstacle(shape, &model.scale, center.clone(), 0)?;
            let Obstacle::Capsule {
                radius: dsn_radius, ..
            } = obstacle
            else {
                unreachable!()
            };
            remaining = &dsn_radius - &radius;
            if counts[&key] > 1 && (&dsn_radius * D::from(2) != size[0] || center != position) {
                return Err(
                    "repeated exported PTH alias does not match exact native copper geometry"
                        .into(),
                );
            }
            let effective = &remaining + &floor;
            covered = effective >= dec::zero() && displacement2 <= &effective * &effective;
            record["dsn_radius_mm"] = dec::plain(&dsn_radius).into();
        } else {
            if shape.items().len() != 6 {
                return Err("malformed DSN PTH rectangle".into());
            }
            let bounds = [
                num(shape, 2)? * &model.scale,
                num(shape, 3)? * &model.scale,
                num(shape, 4)? * &model.scale,
                num(shape, 5)? * &model.scale,
            ];
            let [x0, y0, x1, y1] = &bounds;
            if x0 >= x1 || y0 >= y1 || x0 != &-x1 || y0 != &-y1 {
                return Err("offset or invalid DSN PTH rectangle".into());
            }
            let rotation = (fp_rotation + pin.rotation) % 360;
            let mut dims = [x1 - x0, y1 - y0];
            if (rotation - native_rotation).rem_euclid(180) == 90 {
                dims.swap(0, 1);
            }
            if dims != size || center != position {
                return Err("DSN PTH rectangle differs from native copper geometry".into());
            }
            let [lx, ly] = dec::rotate(
                [&position[0] - &center[0], -(&position[1] - &center[1])],
                -rotation,
            );
            let margin = [&lx - x0, x1 - &lx, &ly - y0, y1 - &ly]
                .into_iter()
                .min()
                .unwrap();
            remaining = &margin - &radius;
            covered = margin >= dec::zero() && &remaining + &floor >= dec::zero();
            record = json!({"dsn_rectangle_mm":bounds.iter().map(dec::plain).collect::<Vec<_>>(),"dsn_rotation_deg":rotation,"inscribed_radius_mm":dec::plain(&margin)});
        }
        if !covered {
            return Err(format!(
                "actual exported PTH copper plus verified clearance does not contain the expanded native drill: {reference}.{number}"
            ));
        }
        let mut row = json!({"reference":reference,"pad":number,"net":net,"identity":p.get("identity").unwrap_or(&Value::Null),"dsn_pin":export,"dsn_shape":shape.head(),
            "layer":layer,"dsn_image":image_name,"dsn_padstack":pin.stack,"dsn_center_mm":dec::strings(&center),"native_center_mm":dec::strings(&position),
            "native_drill_radius_mm":dec::plain(&dec::half(&drill[0])),"required_mm":dec::plain(&required),"center_displacement_squared_mm2":dec::plain(&displacement2),
            "containment_slack_radius_mm":dec::plain(&remaining),"credited_clearance_mm":dec::plain(&floor),"effective_containment_slack_mm":dec::plain(&(&remaining+&floor))});
        extend(&mut row, record);
        out["covered_pads"].as_array_mut().unwrap().push(row);
    }
    Ok(
        json!({"status":"covered","cause":"every physical other-net PTH expanded drill is contained in its actual DSN copper obstacle plus verified wire-to-pin clearance",
        "required_mm":dec::plain(&required),"clearance_floor_mm":dec::plain(&floor)}),
    )
}
#[derive(Clone, Debug, PartialEq)]
pub enum Obstacle {
    Capsule { ends: [Point; 2], radius: D },
    Rect([D; 4]),
}
pub fn capsule(center: Point, size: Point, rotation: i32) -> Obstacle {
    let radius = dec::half(size.iter().min().unwrap());
    let half = dec::half(&(size.iter().max().unwrap() - size.iter().min().unwrap()));
    let axis = if size[0] >= size[1] {
        [half, dec::zero()]
    } else {
        [dec::zero(), half]
    };
    let [dx, dy] = dec::rotate([axis[0].clone(), -axis[1].clone()], rotation);
    let mut ends = [
        [&center[0] - &dx, &center[1] + &dy],
        [&center[0] + &dx, &center[1] - &dy],
    ];
    ends.sort();
    Obstacle::Capsule { ends, radius }
}
pub fn rectangle(center: Point, size: Point, rotation: i32) -> Obstacle {
    let mut points = Vec::new();
    let w = dec::half(&size[0]);
    let h = dec::half(&size[1]);
    for x in [-w.clone(), w] {
        for y in [-h.clone(), h.clone()] {
            let [dx, dy] = dec::rotate([x.clone(), -y], rotation);
            points.push([&center[0] + dx, &center[1] - dy]);
        }
    }
    Obstacle::Rect([
        points.iter().map(|p| p[0].clone()).min().unwrap(),
        points.iter().map(|p| p[1].clone()).min().unwrap(),
        points.iter().map(|p| p[0].clone()).max().unwrap(),
        points.iter().map(|p| p[1].clone()).max().unwrap(),
    ])
}
pub fn api_obstacle(v: &Value) -> Result<Obstacle> {
    if let Some(c) = v.get("Circle") {
        let center: NmPoint =
            serde_json::from_value(c["center"].clone()).map_err(|e| e.to_string())?;
        let r = c["radius"].as_i64().ok_or("missing API circle radius")?;
        let center = center.mm();
        return Ok(Obstacle::Capsule {
            ends: [center.clone(), center],
            radius: dec::nanometres(r),
        });
    }
    if let Some(s) = v.get("Segment") {
        let a: NmPoint = serde_json::from_value(s["a"].clone()).map_err(|e| e.to_string())?;
        let b: NmPoint = serde_json::from_value(s["b"].clone()).map_err(|e| e.to_string())?;
        let width = s["width"].as_i64().ok_or("missing API segment width")?;
        let mut ends = [a.mm(), b.mm()];
        ends.sort();
        return Ok(Obstacle::Capsule {
            ends,
            radius: dec::half(&dec::nanometres(width)),
        });
    }
    Err("unsupported API copper primitive".into())
}
fn obstacle(shape: &Node, scale: &D, center: Point, rotation: i32) -> Result<Obstacle> {
    match shape.head() {
        Some("circle") => {
            if !matches!(shape.items().len(), 3 | 5)
                || shape.items().len() == 5
                    && (num(shape, 3)? != dec::zero() || num(shape, 4)? != dec::zero())
            {
                return Err("offset/nonpositive drilled DSN circle".into());
            }
            let radius = dec::half(&(num(shape, 2)? * scale));
            if radius <= dec::zero() {
                return Err("offset/nonpositive drilled DSN circle".into());
            }
            Ok(Obstacle::Capsule {
                ends: [center.clone(), center],
                radius,
            })
        }
        Some("rect") => {
            if shape.items().len() != 6 {
                return Err("malformed drilled DSN rectangle".into());
            }
            let (x0, y0, x1, y1) = (
                num(shape, 2)? * scale,
                num(shape, 3)? * scale,
                num(shape, 4)? * scale,
                num(shape, 5)? * scale,
            );
            if x0 >= x1 || y0 >= y1 || x0 != -x1.clone() || y0 != -y1.clone() {
                return Err("offset drilled DSN rectangle".into());
            }
            Ok(rectangle(center, [x1 - x0, y1 - y0], rotation))
        }
        Some("path") => {
            if shape.items().len() != 7 {
                return Err("only one straight round drilled DSN path is supported".into());
            }
            let radius = dec::half(&(num(shape, 2)? * scale));
            if radius <= dec::zero() {
                return Err("nonpositive drilled DSN path".into());
            }
            let mut ends = [
                [num(shape, 3)? * scale, num(shape, 4)? * scale],
                [num(shape, 5)? * scale, num(shape, 6)? * scale],
            ]
            .map(|p| {
                let [dx, dy] = dec::rotate(p, rotation);
                [&center[0] + dx, &center[1] - dy]
            });
            ends.sort();
            Ok(Obstacle::Capsule { ends, radius })
        }
        _ => Err("unsupported actual DSN drilled obstacle".into()),
    }
}
pub fn contains(obstacle: &Obstacle, drill: &Obstacle, required: &D, floor: &D) -> Result<bool> {
    let Obstacle::Capsule { ends, radius } = drill else {
        return Err("a drill must be a capsule".into());
    };
    let radius = radius + required;
    match obstacle {
        Obstacle::Capsule {
            ends: [a, b],
            radius: outer,
        } => {
            let slack = outer + floor - &radius;
            if slack < dec::zero() {
                return Ok(false);
            }
            if a[0] != b[0] && a[1] != b[1] {
                return Err("non-axis obstacle capsule".into());
            }
            for p in ends {
                let dx = [
                    a[0].clone().min(b[0].clone()) - &p[0],
                    dec::zero(),
                    &p[0] - a[0].clone().max(b[0].clone()),
                ]
                .into_iter()
                .max()
                .unwrap();
                let dy = [
                    a[1].clone().min(b[1].clone()) - &p[1],
                    dec::zero(),
                    &p[1] - a[1].clone().max(b[1].clone()),
                ]
                .into_iter()
                .max()
                .unwrap();
                if &dx * &dx + &dy * &dy > &slack * &slack {
                    return Ok(false);
                }
            }
        }
        Obstacle::Rect([x0, y0, x1, y1]) => {
            for [x, y] in ends {
                let margin = [x - x0, x1 - x, y - y0, y1 - y].into_iter().min().unwrap();
                if margin < dec::zero() || margin + floor < radius {
                    return Ok(false);
                }
            }
        }
    }
    Ok(true)
}
pub fn inspect_drilled(req: &DrilledRequest) -> Value {
    let mut out = json!({"schema":DRILLED_SCHEMA,"status":"blocked","qualified":false,"covered_holes":[],
        "scope":"all retained physical drilled geometry versus new other-net tracks; final native gate required","exporter_source":EXPORTER_SOURCE,"inputs":{}});
    match drilled(req, &mut out) {
        Ok(extra) => extend(&mut out, extra),
        Err(e) => out["cause"] = e.into(),
    };
    out
}
fn drilled(req: &DrilledRequest, out: &mut Value) -> Result<Value> {
    let (required, floor) = req.scope.validate()?;
    if !matches!(
        req.applicability.as_str(),
        "reject_same_net" | "kicad10_project_track" | "custom_pth_track"
    ) {
        return Err("unknown native drilled applicability".into());
    }
    if req.applicability == "kicad10_project_track" && req.scope.active_nets.len() != 1 {
        return Err("native project hole applicability requires one exact active net".into());
    }
    let model = Dsn::new(&req.dsn_text, &req.scope.layers)?;
    let layer = &req.scope.layers[0];
    if !req.scope.active_nets.iter().all(|n| model.nets.contains(n)) {
        return Err("active drilled net missing from actual DSN".into());
    }
    let mut identities = BTreeSet::new();
    let mut pins = BTreeSet::new();
    let mut keepouts = BTreeSet::new();
    let mut vias = BTreeSet::new();
    let mut grid = Value::Null;
    for hole in &req.holes {
        if hole["supported"] != true {
            return Err(format!(
                "unsupported retained drilled geometry: {}",
                hole["cause"]
            ));
        }
        let kind = text(hole, "kind")?;
        let common = "kind identity net supported cause native_form_sha256 position_mm size_mm drill_mm drill_shape drill_offset_mm shape layers hole_layers rotation_deg";
        let names = if kind == "via" {
            common.to_string()
        } else {
            format!(
                "{common} reference pad side footprint_position_mm footprint_rotation_deg export_pin"
            )
        };
        if !matches!(kind, "pth" | "npth" | "via") || !fields(hole, &names) {
            return Err("unknown native drilled fields".into());
        }
        let identity = text(hole, "identity")?;
        if identity.is_empty()
            || !identities.insert(identity)
            || !evidence::hex(&hole["native_form_sha256"])
            || !hole["cause"].is_null()
        {
            return Err("missing or duplicate native physical drill identity".into());
        }
        let net = text(hole, "net")?;
        if kind != "npth" && net.is_empty() {
            return Err("unassigned plated drill lacks a bound exported obstacle".into());
        }
        let custom_na = req.applicability == "custom_pth_track" && kind != "pth";
        let same = kind != "npth" && req.scope.active_nets.contains(&net.to_string());
        if same && req.applicability != "kicad10_project_track" && !custom_na {
            return Err("active same-net plated drill requires native applicability proof".into());
        }
        let hole_layers = string_list(&hole["hole_layers"])?;
        if !hole_layers.contains(layer)
            || hole_layers.iter().collect::<BTreeSet<_>>().len() != hole_layers.len()
            || hole_layers.iter().collect::<BTreeSet<_>>() != model.layers.keys().collect()
        {
            return Err("unknown physical drill layer extent".into());
        }
        let size = dec::pair(&hole["size_mm"])?;
        let drill_size = dec::pair(&hole["drill_mm"])?;
        let position = dec::pair(&hole["position_mm"])?;
        let rotation = dec::angle(&hole["rotation_deg"])?;
        if size
            .iter()
            .chain(drill_size.iter())
            .any(|v| v <= &dec::zero())
            || dec::pair(&hole["drill_offset_mm"])? != [dec::zero(), dec::zero()]
            || !matches!(hole["drill_shape"].as_str(), Some("circle" | "oval"))
            || hole["drill_shape"] == "circle" && drill_size[0] != drill_size[1]
        {
            return Err("invalid/offset physical drill".into());
        }
        let applied = if custom_na {
            dec::zero()
        } else {
            required.clone()
        };
        let drill = capsule(position.clone(), drill_size, rotation);
        let mut credited = if custom_na {
            dec::zero()
        } else {
            floor.clone()
        };
        let mut record = json!({});
        let obs;
        let mut extra_grid = Vec::new();
        if kind == "npth" {
            if !net.is_empty()
                || hole["shape"] != "circle"
                || hole["drill_shape"] != "circle"
                || size[0] != size[1]
            {
                return Err("unsupported NPTH circle contract".into());
            }
            let (name, image, place) = model.image(hole)?;
            let mut matches = Vec::new();
            for (ki, k) in image
                .children("keepout")
                .chain(image.children("wire_keepout"))
                .enumerate()
            {
                if k.items().len() != 3 || k.text(1) != Some("") {
                    continue;
                }
                let s = &k.items()[2];
                if s.head() != Some("circle") || s.text(1) != Some(layer) {
                    continue;
                }
                if !matches!(s.items().len(), 3 | 5) {
                    return Err("malformed NPTH circle keepout".into());
                }
                let xy = if s.items().len() == 3 {
                    [dec::zero(), dec::zero()]
                } else {
                    [num(s, 3)?, num(s, 4)?]
                };
                let center = model.center(place, &xy)?;
                let radius = dec::half(&(num(s, 2)? * &model.scale));
                let o = Obstacle::Capsule {
                    ends: [center.clone(), center.clone()],
                    radius: radius.clone(),
                };
                if center == position
                    && radius > dec::zero()
                    && !keepouts.contains(&(text(hole, "reference")?.to_string(), ki))
                    && contains(&o, &drill, &applied, &dec::zero())?
                {
                    matches.push((ki, o, xy));
                }
            }
            if matches.len() != 1 {
                return Err("missing or ambiguous source-bound NPTH wire keepout".into());
            }
            let (ki, o, xy) = matches.remove(0);
            obs = o;
            credited = dec::zero();
            keepouts.insert((text(hole, "reference")?.to_string(), ki));
            extra_grid.extend(xy.into_iter().map(|v| v * &model.scale));
            record = json!({"dsn_image":name,"dsn_keepout_index":ki});
        } else {
            validate_layers(&hole["layers"], layer, &model.layers)?;
            let expected;
            let shape;
            if kind == "via" {
                if hole["shape"] != "circle"
                    || size[0] != size[1]
                    || hole["drill_shape"] != "circle"
                {
                    return Err("unsupported retained via geometry".into());
                }
                let text = [
                    six_g(&dec::divide(&position[0], &model.scale)?)?,
                    six_g(&dec::divide(&(-&position[1]), &model.scale)?)?,
                ];
                let matches: Vec<_> = model
                    .vias
                    .iter()
                    .enumerate()
                    .filter(|(i, v)| !vias.contains(i) && v.text == text && v.net == net)
                    .collect();
                if matches.len() != 1 {
                    return Err("missing or ambiguous fixed exported via instance".into());
                }
                let (vi, v) = matches[0];
                vias.insert(vi);
                shape = model.shape(&v.stack, layer)?;
                obs = obstacle(shape, &model.scale, v.center.clone(), 0)?;
                expected = capsule(v.center.clone(), size, 0);
                record = json!({"dsn_via_index":vi,"dsn_padstack":v.stack});
            } else {
                if hole["side"] != "front"
                    || !matches!(hole["shape"].as_str(), Some("circle" | "rect" | "oval"))
                {
                    return Err("unsupported plated pad copper".into());
                }
                let (name, image, place) = model.image(hole)?;
                let pin_name = text(hole, "export_pin")?;
                if !alias(text(hole, "pad")?, pin_name)
                    || !pins.insert((text(hole, "reference")?.to_string(), pin_name.to_string()))
                {
                    return Err("ambiguous physical plated pin alias".into());
                }
                let ps = dsn::pins(image)?;
                let pin = ps
                    .get(pin_name)
                    .ok_or("actual plated pin/net membership differs from native")?;
                if model
                    .members
                    .get(&format!("{}-{pin_name}", text(hole, "reference")?))
                    .map(String::as_str)
                    != Some(net)
                {
                    return Err("actual plated pin/net membership differs from native".into());
                }
                let center = model.center(place, &pin.xy)?;
                if center != position {
                    return Err("actual physical pin center differs from native".into());
                }
                shape = model.shape(&pin.stack, layer)?;
                obs = obstacle(
                    shape,
                    &model.scale,
                    center,
                    (dsn::angle(place, 5)? + pin.rotation) % 360,
                )?;
                expected = if hole["shape"] == "rect" {
                    rectangle(position.clone(), size, rotation)
                } else {
                    if hole["shape"] == "circle" && size[0] != size[1] {
                        return Err("noncircular native circle copper".into());
                    }
                    capsule(position.clone(), size, rotation)
                };
                record = json!({"dsn_image":name,"dsn_pin":pin_name,"dsn_padstack":pin.stack});
                extra_grid.extend(pin.xy.iter().map(|v| v * &model.scale));
            }
            if obs != expected {
                return Err("actual DSN copper differs from native drilled geometry".into());
            }
            if !same && !custom_na && shape.is("path") {
                return Err("oval/path backend integer-octagon containment is unsupported; ideal capsule is not an actual backend proof".into());
            }
            if !same && !custom_na && !contains(&obs, &drill, &required, &credited)? {
                return Err("actual DSN copper plus verified clearance does not contain expanded native drill".into());
            }
        }
        if !same || custom_na {
            if grid.is_null() {
                grid = backend::verified_grid(
                    &model,
                    &req.backend_command,
                    &req.backend_policy,
                    &mut out["inputs"],
                )?;
            }
            for v in [&floor, &credited]
                .into_iter()
                .chain(position.iter())
                .chain(extra_grid.iter())
            {
                backend::grid_mm(&model, v)?;
            }
            if kind != "via" {
                for v in dec::pair(&hole["footprint_position_mm"])? {
                    backend::grid_mm(&model, &v)?;
                }
            }
            match &obs {
                Obstacle::Capsule { ends, radius } => {
                    backend::grid_mm(&model, radius)?;
                    for v in ends.iter().flatten() {
                        backend::grid_mm(&model, v)?;
                    }
                }
                Obstacle::Rect(bounds) => {
                    for v in bounds {
                        backend::grid_mm(&model, v)?;
                    }
                }
            }
        }
        if custom_na {
            extend(
                &mut record,
                json!({"disposition":"custom_not_applicable","reason":"caller-proved Track/PTH custom scope excludes this bound non-PTH instance; independent project minimum remains required"}),
            );
        } else if same {
            extend(
                &mut record,
                json!({"disposition":"native_not_applicable","reason":"KiCad10 track visitor excludes connected items on the same nonzero net before testing hole clearance","applicability_source":APPLICABILITY_SOURCE}),
            );
            credited = dec::zero();
        } else {
            record["disposition"] = "covered".into();
        }
        let mut row = json!({"kind":kind,"identity":identity,"net":net,"layer":layer,"native_center_mm":hole["position_mm"],"native_drill_mm":hole["drill_mm"],"native_rotation_deg":rotation,
            "required_mm":dec::plain(&applied),"credited_clearance_mm":dec::plain(&credited)});
        extend(&mut row, record);
        out["covered_holes"].as_array_mut().unwrap().push(row);
    }
    if vias.len() != model.vias.len() {
        return Err("unmatched exported retained via inventory".into());
    }
    Ok(
        json!({"status":"covered","cause":"every physical drill is bound; every applicable expanded drill is protected by its actual DSN obstacle","required_mm":dec::plain(&required),
        "clearance_floor_mm":dec::plain(&floor),"native_hole_count":req.holes.len(),"applicability":req.applicability,"backend_geometry":grid}),
    )
}
/// The exporter's %.6g, including its decimal/exponent switch. Formatting rounds ties to even.
fn six_g(d: &D) -> Result<String> {
    let f = d.to_string().parse::<f64>().map_err(|e| e.to_string())?;
    if !f.is_finite() {
        return Err("nonfinite exported via coordinate".into());
    }
    if f == 0.0 {
        return Ok(if f.is_sign_negative() { "-0" } else { "0" }.into());
    }
    let sci = format!("{f:.5e}");
    let (mant, exp) = sci.split_once('e').unwrap();
    let exp: i32 = exp.parse().unwrap();
    if !(-4..6).contains(&exp) {
        let mant = mant.trim_end_matches('0').trim_end_matches('.');
        Ok(format!(
            "{mant}e{}{exp:02}",
            if exp >= 0 { "+" } else { "-" },
            exp = exp.abs()
        ))
    } else {
        let digits = (5 - exp).max(0) as usize;
        let s = format!("{f:.digits$}");
        Ok(if s.contains('.') {
            s.trim_end_matches('0').trim_end_matches('.').into()
        } else {
            s
        })
    }
}
