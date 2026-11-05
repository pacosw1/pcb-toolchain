//! The passes of a job. Without the `routing_rules` feature that is one pass over all nets. With it, critical nets go first in
//! stages, each stage's copper locked for the next, and a last pass takes the nets no stage routed and those a stage left open.
use super::Job;
use crate::job::stop::Stop;
use crate::kicad::board::Board;
use crate::kicad::geom::{Rect as IuRect, to_mm};
use crate::kicad::pad::PadKind;
use crate::routing_rules::geometry::{grow, outside_rects};
use crate::routing_rules::stages::{self as rules, BoardInfo, Config, HotLoop, PlanOptions, Stage};
use crate::routing_rules::{Keepouts, Point, Rect};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// What one pass adds to the plain one.
#[derive(Debug, Clone, Default)]
pub struct Extra {
    pub name: String,
    pub flags: Vec<String>,
    pub max_time: Option<i64>,
    pub keepouts: Keepouts,
    pub masks: BTreeMap<String, Vec<String>>,
    pub via_costs: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct Pass {
    pub tag: String,
    pub nets: BTreeSet<String>,
    pub keep: bool,
    pub extra: Option<Extra>,
}

/// One hot loop in the stage plan and the report.
#[derive(Debug, Clone)]
pub struct Hot {
    pub found: HotLoop,
    pub layer: Option<String>,
    pub loop_pads: Vec<String>,
}

/// The routing-rules side of a job; None without the feature.
pub struct Rules {
    pub info: BoardInfo,
    pub plan: Vec<Stage>,
    pub classes: BTreeMap<String, String>,
    pub escape: Value,
    pub courtyards: Vec<Rect>,
    pub hot: BTreeMap<String, Hot>,
}

fn rect_mm(rect: &IuRect) -> Rect {
    [to_mm(rect.left), to_mm(rect.top), to_mm(rect.right), to_mm(rect.bottom)]
}

/// The net classes of the project, and those of them wider than Default.
pub fn project_classes(stem_pro: &std::path::Path) -> (Vec<Value>, BTreeSet<String>) {
    let classes = std::fs::read_to_string(stem_pro).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok()).and_then(|pro| pro["net_settings"]["classes"].as_array().cloned()).unwrap_or_default();
    let width = |class: &Value| class["track_width"].as_f64().unwrap_or(0.0);
    let default = classes.iter().find(|class| class["name"] == "Default").map_or(0.0, width);
    let wide = classes.iter().filter(|class| width(class) > default).filter_map(|class| class["name"].as_str().map(str::to_string)).collect();
    (classes, wide)
}

fn default_sizes(classes: &[Value]) -> (f64, f64, f64) {
    let default = classes.iter().find(|class| class["name"] == "Default");
    let value = |key: &str, fallback: f64| default.and_then(|class| class[key].as_f64()).unwrap_or(fallback);
    (value("track_width", 0.2), value("clearance", 0.2), value("via_diameter", 0.6))
}

fn courtyard_box(board_ref: &str, footprint: &crate::kicad::board::Footprint) -> Result<Rect, String> {
    let polygons = if footprint.layer == "B.Cu" { &footprint.courtyard_back } else { &footprint.courtyard_front };
    let boxes = polygons.iter().filter_map(|polygon| polygon.bbox());
    let merged = boxes.reduce(|a, b| a.merged(b)).ok_or_else(|| format!("fine-pitch part {board_ref} has no courtyard: its escape belt has no source"))?;
    Ok(rect_mm(&merged))
}

fn feature_f64(job: &Job, key: &str, fallback: f64) -> f64 {
    job.feat.setting("routing_rules", key).and_then(Value::as_f64).unwrap_or(fallback)
}

fn feature_i64(job: &Job, key: &str, fallback: i64) -> i64 {
    job.feat.setting("routing_rules", key).and_then(Value::as_i64).unwrap_or(fallback)
}

struct Escape {
    extra: Extra,
    info: Value,
    nets: BTreeSet<String>,
    fine: BTreeMap<String, f64>,
    courtyards: Vec<Rect>,
    belt: f64,
    pads: usize,
    pitch: f64,
}

/// The fan-out stage: the SMD pads of fine-pitch parts (IPC-7351B: pitch <= fine_pitch_mm) escape before any wide copper, bounded
/// by a keepout outside a belt round each courtyard: one clearance, a via and a track with its clearance of the Default class.
fn escape(job: &Job, board: &Board, info: &BoardInfo, classes: &BTreeMap<String, String>, wide: &BTreeSet<String>, sizes: (f64, f64, f64), edges: Rect) -> Result<Escape, String> {
    let layers = job.a.layer_list();
    let mut pads_by_ref: BTreeMap<String, Vec<Point>> = BTreeMap::new();
    let mut pad_rows = Vec::new();
    for footprint in &board.footprints {
        for pad in &footprint.pads {
            pads_by_ref.entry(footprint.reference.clone()).or_default().push([to_mm(pad.position.x), to_mm(pad.position.y)]);
            pad_rows.push((footprint.reference.clone(), pad.net.clone(), pad.kind == PadKind::Smd && layers.iter().any(|layer| pad.layers.contains(layer))));
        }
    }
    let pitch = feature_f64(job, "fine_pitch_mm", rules::FINE_PITCH_MM);
    let fine = rules::fine_pitch_refs(&pads_by_ref, pitch);
    let before: BTreeSet<String> = job.nets.iter().filter(|net| matches!(rules::stage_of(net, info, classes, wide), "pairs_clocks" | "fast")).cloned().collect();
    let exclude: BTreeSet<String> = before.union(&job.plane_names).cloned().collect();
    let nets: BTreeSet<String> = rules::escape_nets(&pad_rows, &fine, &job.nets, &exclude).into_iter().collect();
    let belt = rules::belt_margin(sizes.0, sizes.1, sizes.2);
    let mut refs = serde_json::Map::new();
    let mut courtyards = Vec::new();
    let mut belts = Vec::new();
    for (reference, pitch_mm) in &fine {
        let footprint = board.footprints.iter().find(|footprint| &footprint.reference == reference).ok_or("a fine-pitch part is gone")?;
        let area = courtyard_box(reference, footprint)?;
        courtyards.push(area);
        belts.push(grow(area, belt));
        refs.insert(reference.clone(), json!({"pitch_mm": pitch_mm, "courtyard": area, "belt": grow(area, belt)}));
    }
    let keepouts = layers.iter().map(|layer| (layer.clone(), outside_rects(edges, &belts))).collect();
    let extra = Extra { name: "iot_belt".into(), flags: vec!["--router.fanout.enabled=true".into()], max_time: Some(feature_i64(job, "escape_max_time_s", 120)), keepouts, ..Extra::default() };
    let pads = pad_rows.iter().filter(|(reference, net, smd)| *smd && fine.contains_key(reference) && nets.contains(net)).count();
    let info = json!({"fine_pitch_mm": pitch, "refs": refs, "belt_mm": belt, "pads": pads, "nets": nets});
    Ok(Escape { extra, info, nets, fine, courtyards, belt, pads, pitch })
}

/// Hot loops: each switch node of the wide stage gets a corridor keepout round its pads, one layer when its SMD pads share one, via
/// cost x hot_loop_via_factor, and the bound max_mm = hot_loop_factor x the straight pad distance, checked after.
fn hot_loops(job: &Job, board: &Board, info: &BoardInfo, sizes: (f64, f64, f64), edges: Rect) -> (BTreeMap<String, Hot>, BTreeMap<String, Extra>) {
    let layers = job.a.layer_list();
    let (mut found, mut extras) = (BTreeMap::new(), BTreeMap::new());
    for (net, loop_pads) in &info.switch {
        if !job.nets.contains(net) {
            continue;
        }
        let (mut xy, mut pad_layers) = (BTreeMap::new(), BTreeSet::new());
        for (footprint, pad) in board.pads().filter(|(_, pad)| &pad.net == net) {
            xy.insert(format!("{}.{}", footprint.reference, pad.number), [to_mm(pad.position.x), to_mm(pad.position.y)]);
            pad_layers.insert(if pad.kind == PadKind::Smd { pad.layers.first().cloned().unwrap_or_default() } else { "*".to_string() });
        }
        let Some(hot) = rules::hot_loop(&xy, loop_pads, feature_f64(job, "hot_loop_factor", 1.5), sizes.0 + sizes.1) else { continue };
        let one: Vec<String> = if !pad_layers.contains("*") && pad_layers.len() == 1 { pad_layers.iter().filter(|layer| layers.contains(*layer)).cloned().collect() } else { Vec::new() };
        let keepouts = layers.iter().map(|layer| (layer.clone(), outside_rects(edges, &[hot.r#box]))).collect();
        let masks = if one.is_empty() { BTreeMap::new() } else { BTreeMap::from([(net.clone(), one.clone())]) };
        let via_costs = feature_i64(job, "via_costs", 300) * feature_i64(job, "hot_loop_via_factor", 10);
        extras.insert(net.clone(), Extra { name: "iot_hot_loop".into(), keepouts, masks, via_costs: Some(via_costs), ..Extra::default() });
        found.insert(net.clone(), Hot { found: hot, layer: one.first().cloned(), loop_pads: loop_pads.clone() });
    }
    (found, extras)
}

fn number(value: f64) -> String {
    crate::model::num::short_float(value)
}

/// The passes of a job with the feature on, with the lines and run records that say why.
fn staged(job: &Job, board: &Board) -> Result<(Rules, Vec<Pass>), Stop> {
    let cfg: Config = serde_json::from_value(Value::Object(job.feat.get("routing_rules").cloned().unwrap_or_default())).map_err(|e| Stop::failed(format!("routing_rules: {e}")))?;
    let info = rules::board_info(job.feat.board_dir.as_deref(), &cfg)?;
    let (classes_json, wide) = project_classes(&job.stem.with_extension("kicad_pro"));
    let classes: BTreeMap<String, String> = board.nets.clone();
    let sizes = default_sizes(&classes_json);
    let edges = rect_mm(&board.edges_bbox);
    let esc = escape(job, board, &info, &classes, &wide, sizes, edges)?;
    let (hot, hot_extra) = hot_loops(job, board, &info, sizes, edges);
    let nets: Vec<String> = job.nets.iter().cloned().collect();
    let options = PlanOptions { net_class: classes.clone(), wide_classes: wide, planes: job.plane_names.clone(), escape: esc.nets.clone(), hot: hot.keys().cloned().collect() };
    let mut plan = rules::stage_plan(&nets, &info, &options);
    let keepouts_on = job.feat.setting("routing_rules", "keepouts").and_then(Value::as_bool).unwrap_or(true);
    if !keepouts_on || info.spec.adjacent.is_empty() {
        plan.iter_mut().for_each(|stage| stage.2 = false);
    }
    let kept_stages: Vec<String> = match job.feat.setting("routing_rules", "keepout_stages").and_then(Value::as_array) {
        Some(list) => list.iter().filter_map(|stage| stage.as_str().map(str::to_string)).collect(),
        None => rules::STAGES.iter().map(|stage| stage.to_string()).collect(),
    };
    for stage in &mut plan {
        let head = stage.0.split('_').next().unwrap_or_default();
        stage.2 = stage.2 && (kept_stages.contains(&stage.0) || kept_stages.iter().any(|name| name == head));
    }
    let mut passes = Vec::new();
    if plan.len() > 1 || plan.first().is_some_and(|stage| stage.2) {
        for (name, nets, keep) in &plan {
            if name.starts_with("wide_hot") {
                // One corridor and mask per net: a hot stage of several nets is split per net.
                for net in nets {
                    passes.push(Pass { tag: format!("{name}:{net}"), nets: BTreeSet::from([net.clone()]), keep: *keep, extra: hot_extra.get(net).cloned() });
                }
                continue;
            }
            let extra = (name == "escape").then(|| esc.extra.clone());
            passes.push(Pass { tag: name.clone(), nets: nets.iter().cloned().collect(), keep: *keep, extra });
        }
        passes.push(Pass { tag: "final".into(), nets: job.nets.clone(), keep: false, extra: None });
    } else {
        passes.push(Pass { tag: "all".into(), nets: job.nets.clone(), keep: false, extra: None });
    }
    let counts: Vec<String> = plan.iter().map(|(name, nets, keep)| format!("{name}={}{}", nets.len(), if *keep { "K" } else { "" })).collect();
    println!("STAGES {} final=rest (K = reference-plane keepouts)", counts.join(" "));
    if esc.fine.is_empty() {
        println!("ESCAPE no fine-pitch footprint: no escape stage");
    } else {
        let list: Vec<String> = esc.fine.iter().map(|(reference, pitch)| format!("{reference} {}mm", number(*pitch))).collect();
        println!("ESCAPE fine-pitch {} refs ({}) pads {} nets {} belt {} mm (IPC-7351B fine pitch <= {} mm)", esc.fine.len(), list.join(", "), esc.pads, esc.nets.len(), number(esc.belt), number(esc.pitch));
    }
    for (net, loop_) in &hot {
        println!("HOT_LOOP {net} straight {} mm max {} mm layer {}", number(loop_.found.straight_mm), number(loop_.found.max_mm), loop_.layer.as_deref().unwrap_or("any"));
    }
    job.plan_records(&plan, &esc.fine, esc.nets.len(), esc.belt, esc.pitch, &hot)?;
    Ok((Rules { info, plan, classes, escape: esc.info, courtyards: esc.courtyards, hot }, passes))
}

/// The passes of this job.
pub fn plan(job: &Job, board: &Board) -> Result<(Option<Rules>, Vec<Pass>), Stop> {
    if job.rules_on {
        let (rules, passes) = staged(job, board)?;
        return Ok((Some(rules), passes));
    }
    Ok((None, vec![Pass { tag: "all".into(), nets: job.nets.clone(), keep: false, extra: None }]))
}
