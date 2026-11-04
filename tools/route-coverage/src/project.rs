//! Authored project minima against the actual DSN and final backend argv.
use crate::{
    Result,
    decimal::{self as dec, D},
    dsn::{self, Rules, atom, num, one},
    evidence, hole,
};
use iotroute::kicad::sexpr::Node;
use regex::Regex;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub const REQUIRED: &[&str] = &[
    "min_clearance",
    "min_copper_edge_clearance",
    "min_hole_clearance",
    "min_hole_to_hole",
    "min_track_width",
    "min_microvia_diameter",
    "min_microvia_drill",
    "min_through_hole_diameter",
    "min_via_annular_width",
    "min_via_diameter",
    "min_connection",
    "min_resolved_spokes",
    "min_groove_width",
    "min_silk_clearance",
    "min_text_height",
    "min_text_thickness",
    "solder_mask_to_copper_clearance",
];
const HOLES: &[&str] = &[
    "min_hole_to_hole",
    "min_microvia_diameter",
    "min_microvia_drill",
    "min_through_hole_diameter",
    "min_via_annular_width",
    "min_via_diameter",
];
const FIXED: &[&str] = &[
    "min_groove_width",
    "min_silk_clearance",
    "min_text_height",
    "min_text_thickness",
];
const TEXT: &[&str] = &["min_text_height", "min_text_thickness"];
pub fn drc_types(name: &str) -> Option<&'static [&'static str]> {
    match name {
        "min_hole_to_hole" | "hole_to_hole" => Some(&["hole_to_hole", "holes_co_located"]),
        "min_hole_clearance" | "hole_clearance" => Some(&["hole_clearance"]),
        "min_silk_clearance" | "silk_clearance" => Some(&["silk_overlap", "silk_over_copper"]),
        _ => None,
    }
}
pub fn native_drc(name: &str, extra: Value) -> Result<Value> {
    let mut obligation = extra.as_object().cloned().unwrap_or_default();
    obligation.extend(json!({"constraint":name,"enforcement":"native-drc","drc_types":drc_types(name).ok_or("unknown native DRC constraint")?}).as_object().unwrap().clone());
    Ok(
        json!({"disposition":"native_postcondition","native_obligation":obligation,"reason":"new vias are possible; the final native DRC of the saved candidate must show zero findings of these types"}),
    )
}
pub fn command_floor(command: &[String], name: &str) -> Result<D> {
    if command.is_empty() {
        return Err("final backend argv is missing or malformed".into());
    }
    let prefix = format!("--router.{name}");
    let equals = format!("{prefix}=");
    let values: Vec<_> = command
        .iter()
        .filter(|v| *v == &prefix || v.starts_with(&equals))
        .collect();
    if values.len() != 1 {
        return Err(format!(
            "exactly one {prefix} is required; missing/duplicate override is unknown"
        ));
    }
    let text = values[0].strip_prefix(&equals).unwrap_or("");
    if text.is_empty() || !text.bytes().all(|c| c.is_ascii_digit()) {
        return Err(format!(
            "backend control must be an explicit nonnegative integer micrometre value: {prefix}"
        ));
    }
    Ok(dec::decimal(text)? / D::from(1000))
}
pub struct Project {
    pub rules: BTreeMap<String, Value>,
    pub classes: BTreeMap<String, (usize, Value)>,
}
pub fn load(text: Option<&str>) -> Result<Project> {
    let project = evidence::parse(
        text.ok_or("native project file is missing; resolved project requirements are unknown")?,
    )?;
    let rules = project
        .pointer("/board/design_settings/rules")
        .and_then(Value::as_object)
        .ok_or("project rules/netclass requirements are unresolved")?;
    let classes = project
        .pointer("/net_settings/classes")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
        .ok_or("project rules and nonempty netclass list are required")?;
    let mut names = BTreeMap::new();
    for (index, c) in classes.iter().enumerate() {
        let name = c["name"]
            .as_str()
            .filter(|n| !n.is_empty())
            .ok_or("project netclasses have missing/duplicate names")?;
        if names.insert(name.into(), (index, c.clone())).is_some() {
            return Err("project netclasses have missing/duplicate names".into());
        }
    }
    if !names.contains_key("Default") {
        return Err("explicit Default netclass is required".into());
    }
    Ok(Project {
        rules: rules.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        classes: names,
    })
}
#[derive(Clone)]
struct Via {
    source: String,
    diameter: D,
    drill: D,
    through: bool,
}
impl Via {
    fn annular(&self) -> D {
        dec::half(&(&self.diameter - &self.drill))
    }
}
fn via_sizes(req: &Request, model: &Rules, project: &Project) -> Result<Vec<Via>> {
    let structure = one(&model.root, "structure")?;
    let network = one(&model.root, "network")?;
    let stacks = dsn::index(one(&model.root, "library")?, "padstack")?;
    let copper: Vec<_> = structure
        .children("layer")
        .map(|n| atom(n, 1).map(str::to_string))
        .collect::<Result<_>>()?;
    let mut names = BTreeSet::new();
    for form in structure.children("via") {
        for n in form.items().iter().skip(1).filter_map(Node::atom) {
            names.insert(n.to_string());
        }
    }
    let classes = dsn::index(network, "class")?;
    for net in &req.active_nets {
        let name = model.membership.get(net).ok_or("missing DSN net class")?;
        for circuit in classes[name].children("circuit") {
            for use_via in circuit.children("use_via") {
                for n in use_via.items().iter().skip(1).filter_map(Node::atom) {
                    names.insert(n.into());
                }
            }
        }
    }
    if names.is_empty() {
        return Err(
            "active nets may change layer, but the actual DSN declares no via padstack".into(),
        );
    }
    let pattern = Regex::new(r"^Via\[(\d+)-(\d+)\]_(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)_um$").unwrap();
    let mut result = Vec::new();
    for name in names {
        let c = pattern.captures(&name).ok_or(format!(
            "via padstack is missing or not the exact KiCad DSN via encoding: {name}"
        ))?;
        let stack = stacks.get(&name).ok_or(format!(
            "via padstack is missing or not the exact KiCad DSN via encoding: {name}"
        ))?;
        let top: usize = c[1].parse().map_err(|_| "invalid via top layer")?;
        let bottom: usize = c[2].parse().map_err(|_| "invalid via bottom layer")?;
        let diameter = dec::decimal(&c[3])?;
        let mut shape_layers = Vec::new();
        if top > bottom || bottom >= copper.len() {
            return Err(format!(
                "via padstack copper differs from its exact name encoding: {name}"
            ));
        }
        for s in stack.children("shape") {
            let form = s.items().get(1).ok_or("missing via shape")?;
            if s.items().len() != 2
                || !form.is("circle")
                || form.items().len() != 3
                || num(form, 2)? != diameter
            {
                return Err(format!(
                    "via padstack copper differs from its exact name encoding: {name}"
                ));
            }
            shape_layers.push(atom(form, 1)?.to_string());
        }
        shape_layers.sort();
        let mut expected = copper[top..=bottom].to_vec();
        expected.sort();
        if shape_layers != expected {
            return Err(format!(
                "via padstack copper differs from its exact name encoding: {name}"
            ));
        }
        result.push(Via {
            source: format!("dsn padstack {name}"),
            diameter: diameter * &model.scale,
            drill: dec::decimal(&c[4])? / D::from(1000),
            through: top == 0 && bottom == copper.len() - 1,
        });
    }
    let used = req
        .active_nets
        .iter()
        .map(|n| req.net_classes.get(n).ok_or("unresolved native netclass"))
        .collect::<std::result::Result<BTreeSet<_>, _>>()?;
    for name in used {
        let item = &project
            .classes
            .get(name)
            .ok_or("unresolved native netclass")?
            .1;
        result.push(Via {
            source: format!("netclass {name}"),
            diameter: dec::number(&item["via_diameter"])?,
            drill: dec::number(&item["via_drill"])?,
            through: true,
        });
    }
    for h in req.added_vias.as_deref().unwrap_or_default() {
        result.push(Via {
            source: format!(
                "base via {}",
                h["identity"].as_str().ok_or("missing base via identity")?
            ),
            diameter: dec::value(&h["size_mm"][0])?,
            drill: dec::value(&h["drill_mm"][0])?,
            through: true,
        });
    }
    Ok(result)
}
#[derive(Deserialize)]
pub struct Request {
    pub text: Option<String>,
    pub source: String,
    pub dsn_text: String,
    pub active_nets: Vec<String>,
    pub net_classes: BTreeMap<String, String>,
    pub obstacles: Vec<Value>,
    pub holes: Option<Vec<Value>>,
    pub holes_preserved: bool,
    pub immutable_geometry_preserved: bool,
    pub backend_command: Vec<String>,
    #[serde(default)]
    pub thermal: Value,
    #[serde(default)]
    pub backend_policy: Value,
    #[serde(default)]
    pub native_thermal_capability: Value,
    #[serde(default)]
    pub added_vias: Option<Vec<Value>>,
}
fn update(row: &mut Value, disposition: &str, reason: &str) {
    row["disposition"] = disposition.into();
    row["reason"] = reason.into();
}
fn extend(row: &mut Value, more: Value) {
    row.as_object_mut()
        .unwrap()
        .extend(more.as_object().unwrap().clone());
}
pub fn evaluate(req: &Request) -> Vec<Value> {
    let project = match load(req.text.as_deref()) {
        Ok(p) => p,
        Err(e) => {
            return vec![
                json!({"rule":"native project","constraint":"project_document","disposition":"unsupported","source":{"path":req.source,"pointer":""},"reason":e}),
            ];
        }
    };
    let model = match Rules::new(&req.dsn_text) {
        Ok(m) => m,
        Err(e) => {
            return vec![
                json!({"rule":"native project","constraint":"router_model","disposition":"unsupported","source":{"path":req.source,"pointer":""},"reason":e}),
            ];
        }
    };
    match evaluate_model(req, &project, &model) {
        Ok(rows) => rows,
        Err(e) => vec![
            json!({"rule":"native project","constraint":"router_model","disposition":"unsupported","source":{"path":req.source,"pointer":""},"reason":e}),
        ],
    }
}
fn evaluate_model(req: &Request, project: &Project, model: &Rules) -> Result<Vec<Value>> {
    let moving = req
        .active_nets
        .iter()
        .map(|n| model.allowed(n).map(|l| l.len() != 1))
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .any(|v| v);
    let vias = if moving {
        via_sizes(req, model, project)
    } else {
        Ok(Vec::new())
    };
    let mut counterparts: BTreeSet<String> = req.active_nets.iter().cloned().collect();
    for obj in &req.obstacles {
        counterparts.insert(
            obj["NetName"]
                .as_str()
                .ok_or("unresolved native obstacle net")?
                .into(),
        );
    }
    let active: BTreeSet<_> = req.active_nets.iter().cloned().collect();
    let pairs: Vec<_> = active
        .iter()
        .flat_map(|a| {
            counterparts
                .iter()
                .filter(move |b| *b != a)
                .map(move |b| (a, b))
        })
        .collect();
    let class_of = |net: &str| {
        req.net_classes
            .get(net)
            .ok_or(format!("actual native netclass is unresolved: {net}"))
    };
    let used = counterparts
        .iter()
        .map(|net| class_of(net).cloned())
        .collect::<Result<BTreeSet<_>>>()?;
    let mut rows = Vec::new();
    for name in used {
        let item = project.classes.get(&name);
        let pointer = item.map_or("/net_settings/classes".into(), |(i, _)| {
            format!("/net_settings/classes/{i}/clearance")
        });
        let mut row = json!({"rule":"native project","constraint":"netclass_clearance","disposition":"unsupported","source":{"path":req.source,"pointer":pointer},"netclass":name});
        let result = (|| -> Result<()> {
            let item = &item
                .ok_or(format!(
                    "actual native netclass clearance is unresolved: {name}"
                ))?
                .1;
            let value = dec::number(&item["clearance"])?;
            row["required_mm"] = value.to_string().into();
            let mut relevant = Vec::new();
            for &(a, b) in &pairs {
                if class_of(a)? == &name || class_of(b)? == &name {
                    relevant.push((a, b));
                }
            }
            if relevant.is_empty() {
                update(
                    &mut row,
                    "not_applicable",
                    "no different-net active/retained pair uses this class",
                );
            } else if value == dec::zero() {
                update(
                    &mut row,
                    "not_applicable",
                    "explicit authored zero adds no positive clearance floor",
                );
            } else {
                let floor = relevant
                    .iter()
                    .map(|(a, b)| model.floor(a, Some(b)))
                    .collect::<Result<Vec<_>>>()?
                    .into_iter()
                    .min()
                    .unwrap();
                row["model_floor_mm"] = floor.to_string().into();
                row["witness"] = json!({"active":relevant[0].0,"obstacle":relevant[0].1});
                update(
                    &mut row,
                    if floor >= value {
                        "covered"
                    } else {
                        "weaker_than_native"
                    },
                    "conservative actual final DSN clearance floor; no unproved precedence override",
                );
            }
            Ok(())
        })();
        if let Err(e) = result {
            row["reason"] = e.into();
        }
        rows.push(row);
    }
    let names: BTreeSet<_> = project
        .rules
        .keys()
        .map(String::as_str)
        .chain(REQUIRED.iter().copied())
        .collect();
    for name in names {
        let pointer = format!(
            "/board/design_settings/rules/{}",
            name.replace('~', "~0").replace('/', "~1")
        );
        let mut row = json!({"rule":"native project","constraint":name,"disposition":"unsupported","source":{"path":req.source,"pointer":pointer}});
        if let Err(e) = evaluate_rule(req, project, model, &pairs, moving, &vias, name, &mut row) {
            row["reason"] = e.into();
        }
        rows.push(row);
    }
    Ok(rows)
}
fn evaluate_rule(
    req: &Request,
    p: &Project,
    model: &Rules,
    pairs: &[(&String, &String)],
    moving: bool,
    vias: &Result<Vec<Via>>,
    name: &str,
    row: &mut Value,
) -> Result<()> {
    let known =
        REQUIRED.contains(&name) || matches!(name, "max_error" | "use_height_for_length_calcs");
    if !known {
        return Err("unknown project requirement; routing applicability is unproved".into());
    }
    let no_thermal =
        req.thermal["thermal_connections_possible"] == false && req.immutable_geometry_preserved;
    let Some(raw) = p.rules.get(name) else {
        row["source"]["exists"] = false.into();
        if name == "min_resolved_spokes" && no_thermal {
            update(
                row,
                "not_applicable",
                "undeclared threshold is not invented; exact native scope has no possible thermal connections",
            );
            row["thermal_applicability"] = req.thermal.clone();
            return Ok(());
        }
        if (FIXED.contains(&name) || HOLES.contains(&name))
            && (!moving || TEXT.contains(&name))
            && if FIXED.contains(&name) {
                req.immutable_geometry_preserved
            } else {
                req.holes_preserved
            }
        {
            update(
                row,
                "immutable_unchanged",
                "undeclared threshold is unknown but its exact native geometry cannot change under this scope",
            );
            return Ok(());
        }
        return Err("native project minimum is absent; resolved value is unknown".into());
    };
    row["source"]["exists"] = true.into();
    if name == "use_height_for_length_calcs" {
        if !raw.is_boolean() {
            return Err("project length-calculation selector must be boolean".into());
        }
        update(
            row,
            "not_applicable",
            "length measurement convention adds no routing limit",
        );
        return Ok(());
    }
    let value = dec::number(raw)?;
    row[if name == "min_resolved_spokes" {
        "required_count"
    } else {
        "required_mm"
    }] = value.to_string().into();
    if name == "min_resolved_spokes" && value != value.with_scale(0) {
        return Err("resolved thermal-spoke count must be an authored integer".into());
    }
    if name == "max_error" {
        update(
            row,
            "not_applicable",
            "native polygon approximation parameter adds no authored new-track minimum; exact supported geometry proofs still required",
        );
    } else if value == dec::zero() {
        update(
            row,
            "not_applicable",
            "explicit authored zero adds no positive requirement",
        );
    } else if name == "min_clearance" {
        if pairs.is_empty() {
            update(
                row,
                "not_applicable",
                "no different-net counterpart can receive new-copper clearance",
            );
        } else {
            let floor = pairs
                .iter()
                .map(|(a, b)| model.floor(a, Some(b)))
                .collect::<Result<Vec<_>>>()?
                .into_iter()
                .min()
                .unwrap();
            row["model_floor_mm"] = floor.to_string().into();
            update(
                row,
                if floor >= value {
                    "covered"
                } else {
                    "weaker_than_native"
                },
                "all potentially applicable final DSN clearances meet the project minimum",
            );
        }
    } else if matches!(name, "min_track_width" | "min_copper_edge_clearance") {
        let control = if name == "min_track_width" {
            "min_trace_width_um"
        } else {
            "copper_to_edge_clearance_um"
        };
        let mut floor = command_floor(&req.backend_command, control)?;
        if name == "min_track_width"
            && req
                .backend_command
                .iter()
                .any(|v| v == "--router.neck_width_um" || v.starts_with("--router.neck_width_um="))
        {
            let neck = command_floor(&req.backend_command, "neck_width_um")?;
            if neck > dec::zero() {
                floor = floor.min(neck);
            }
        }
        row["backend_control"] = control.into();
        row["model_floor_mm"] = floor.to_string().into();
        update(
            row,
            if floor >= value {
                "covered"
            } else {
                "weaker_than_native"
            },
            "exact final backend command control compared to authored project minimum",
        );
    } else if name == "min_hole_clearance" {
        if moving {
            extend(
                row,
                native_drc(name, json!({"required_mm":value.to_string()}))?,
            );
            return Ok(());
        }
        let holes = req
            .holes
            .as_ref()
            .filter(|_| req.holes_preserved)
            .ok_or("complete unchanged original/base drilled geometry is required")?;
        let mut proofs = Vec::new();
        let mut failures = Vec::new();
        let active: BTreeSet<_> = req.active_nets.iter().collect();
        for net in active {
            let floor = holes
                .iter()
                .filter(|h| h["net"] != *net || h["supported"] != true)
                .map(|h| model.floor(net, h["net"].as_str().filter(|s| !s.is_empty())))
                .collect::<Result<Vec<_>>>()?
                .into_iter()
                .min()
                .unwrap_or(dec::zero());
            let proof = hole::inspect_drilled(&hole::DrilledRequest {
                dsn_text: req.dsn_text.clone(),
                holes: holes.clone(),
                scope: hole::Scope {
                    active_nets: vec![net.clone()],
                    layers: model.allowed(net)?.to_vec(),
                    required_mm: Value::String(value.to_string()),
                    clearance_floor_mm: Value::String(floor.to_string()),
                },
                applicability: "kicad10_project_track".into(),
                backend_command: req.backend_command.clone(),
                backend_policy: req.backend_policy.clone(),
            });
            if proof["status"] != "covered" {
                failures.push(
                    proof["cause"]
                        .as_str()
                        .unwrap_or("drilled containment unknown")
                        .to_string(),
                );
            }
            proofs.push(json!({"active_net":net,"proof":proof}));
        }
        row["hole_geometry"] = json!(proofs);
        if !failures.is_empty() {
            return Err(failures.join("; "));
        }
        update(
            row,
            if proofs.is_empty() {
                "not_applicable"
            } else {
                "covered"
            },
            if proofs.is_empty() {
                "complete native inventory has no different-net drilled item"
            } else {
                "all applicable original drilled items have exact final DSN containment"
            },
        );
    } else if HOLES.contains(&name) && !moving {
        if !req.holes_preserved {
            return Err("hole-only dimensions require verified no-new-via masks and unchanged original/base holes".into());
        }
        update(
            row,
            "immutable_unchanged",
            "actual active-net masks forbid new holes; exact source/base drilled geometry remains fixed",
        );
    } else if HOLES.contains(&name) {
        if !req.holes_preserved && req.added_vias.is_none() {
            return Err("new vias are possible; source drilled geometry must be unchanged in the base, with only added through vias".into());
        }
        if name == "min_hole_to_hole" {
            extend(
                row,
                native_drc(name, json!({"required_mm":value.to_string()}))?,
            );
            return Ok(());
        }
        let vias = vias.as_ref().map_err(Clone::clone)?;
        if name.starts_with("min_microvia_") {
            if vias.iter().any(|v| !v.through) {
                return Err(
                    "a blind/buried/micro via padstack can be placed; microvia minimum is unproved"
                        .into(),
                );
            }
            update(
                row,
                "not_applicable",
                "every via the active nets can get is a through via; original holes unchanged",
            );
            return Ok(());
        }
        let key = match name {
            "min_via_diameter" => "diameter",
            "min_through_hole_diameter" => "drill",
            _ => "annular",
        };
        let get = |v: &Via| match key {
            "diameter" => v.diameter.clone(),
            "drill" => v.drill.clone(),
            _ => v.annular(),
        };
        let low = vias
            .iter()
            .min_by_key(|v| get(v))
            .ok_or("missing possible via inventory")?;
        let floor = get(low);
        row["model_floor_mm"] = dec::normalized(&floor).into();
        row["via_padstacks"]=json!(vias.iter().map(|v|json!({"source":v.source,"diameter_mm":dec::normalized(&v.diameter),"drill_mm":dec::normalized(&v.drill),"annular_mm":dec::normalized(&v.annular()),"through":v.through})).collect::<Vec<_>>());
        if floor >= value {
            update(
                row,
                "covered",
                "every via the active nets can get meets the minimum: exact DSN padstacks and netclass via sizes; original holes unchanged",
            );
        } else {
            update(
                row,
                "weaker_than_native",
                &format!(
                    "{} {key} {} mm is below the project minimum",
                    low.source,
                    dec::normalized(&floor)
                ),
            );
        }
    } else if name == "min_silk_clearance" && moving && req.immutable_geometry_preserved {
        extend(
            row,
            native_drc(name, json!({"required_mm":value.to_string()}))?,
        );
    } else if FIXED.contains(&name) {
        if moving && !TEXT.contains(&name) || !req.immutable_geometry_preserved {
            return Err(
                "fixed text/mask/outline rule needs unchanged geometry and no new holes".into(),
            );
        }
        update(
            row,
            "immutable_unchanged",
            if TEXT.contains(&name) {
                "router adds only tracks and vias, never text; source/base text preserved"
            } else {
                "source/base fixed text, mask, outline and footprint geometry preserved; model introduces tracks only"
            },
        );
    } else if name == "min_resolved_spokes" && no_thermal {
        update(
            row,
            "not_applicable",
            req.thermal["reason"]
                .as_str()
                .unwrap_or("unknown thermal scope"),
        );
        row["thermal_applicability"] = req.thermal.clone();
    } else if name == "min_resolved_spokes" && !req.native_thermal_capability.is_null() {
        let c = &req.native_thermal_capability;
        if c["schema"] != "iot-lab.native-thermal-capability.v1"
            || c["status"] != "pending_native"
            || c["required_count"].as_u64().is_none()
            || dec::number(&c["required_count"])? != value
            || !req.immutable_geometry_preserved
        {
            return Err(
                "native thermal capability differs from the authored count or immutable scope"
                    .into(),
            );
        }
        extend(
            row,
            json!({"disposition":"native_postcondition","native_obligation":{"constraint":name,"required_count":value.to_string(),"capability_sha256":c["content_sha256"]},"reason":"explicit native input capability; resolved spokes remain pending until exact final native verification"}),
        );
    } else {
        return Err("applicable project constraint has no proven router-model enforcement".into());
    }
    Ok(())
}
pub fn thermal_scope(native_roots: &[Node], custom_rules: &[Node]) -> Value {
    let sources = [
        "pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr_parser.cpp",
        "pcbnew/zones.h",
        "pcbnew/drc/drc_test_provider_zone_connections.cpp",
    ]
    .map(|p| format!("https://raw.githubusercontent.com/KiCad/kicad-source-mirror/10.0.6/{p}"));
    let mut out = json!({"thermal_connections_possible":true,"zones":0,"overrides":0,"primary_sources":sources});
    fn walk(n: &Node, out: &mut Vec<Node>) {
        if n.atom().is_none() {
            out.push(n.clone());
            for c in n.items() {
                walk(c, out);
            }
        }
    }
    let run = (|| -> Result<()> {
        let mut custom = Vec::new();
        for r in custom_rules {
            walk(r, &mut custom);
        }
        if custom
            .iter()
            .any(|n| n.is("constraint") && n.text(1) == Some("zone_connection"))
        {
            return Err("custom zone-connection rules need native applicability resolution".into());
        }
        for root in native_roots {
            let mut forms = Vec::new();
            walk(root, &mut forms);
            for f in forms {
                if f.is("zone") {
                    if f.child("keepout").is_some() {
                        continue;
                    }
                    out["zones"] = json!(out["zones"].as_u64().unwrap() + 1);
                    let modes: Vec<_> = f.children("connect_pads").collect();
                    if modes.len() != 1 {
                        return Err("zone thermal mode is missing or ambiguous".into());
                    }
                    let atoms: Vec<_> = modes[0]
                        .items()
                        .iter()
                        .skip(1)
                        .filter_map(Node::atom)
                        .collect();
                    if atoms != ["yes"] && atoms != ["no"] {
                        return Err("native zone mode is thermal/default/unknown".into());
                    }
                } else if f.is("zone_connect") {
                    out["overrides"] = json!(out["overrides"].as_u64().unwrap() + 1);
                    if f.items().len() != 2 || !matches!(f.text(1), Some("-1" | "0" | "2")) {
                        return Err("footprint/pad zone mode can require thermal reliefs".into());
                    }
                }
            }
        }
        Ok(())
    })();
    match run {
        Ok(()) => {
            out["thermal_connections_possible"] = false.into();
            out["reason"]="complete native scope has no zones or only explicit solid/none zones, with no thermal footprint/pad/custom-rule override".into();
        }
        Err(e) => out["reason"] = e.into(),
    };
    out
}
