//! `routing_rules < request.json`: one typed request in, one JSON value out. Available in route images without Node.
//! `op` is the original function name; arguments use its names. No board reads or edits happen here.
#[path = "../routing_rules/mod.rs"]
mod routing_rules;

use routing_rules::{
    Disc, Keepouts, Point, Rect, ReferenceSpec, Rings, geometry as g, report as r, stages as s,
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, Read};

fn grid() -> f64 {
    0.1
}
fn min_mm() -> f64 {
    0.05
}
fn corridor() -> f64 {
    1.0
}
fn max_blockers() -> usize {
    4
}
fn fine_pitch() -> f64 {
    s::FINE_PITCH_MM
}
fn kinds() -> Vec<String> {
    vec!["wire_keepout".into()]
}
fn name() -> String {
    "iot_ref_void".into()
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Request {
    BoardInfo {
        #[serde(default)]
        board_dir: Option<String>,
        #[serde(default)]
        cfg: s::Config,
    },
    StageOf {
        net: String,
        info: s::BoardInfo,
        #[serde(default)]
        net_class: BTreeMap<String, String>,
        #[serde(default)]
        wide_classes: BTreeSet<String>,
    },
    Exempt {
        net: String,
        info: s::BoardInfo,
        #[serde(default)]
        planes: BTreeSet<String>,
    },
    StagePlan {
        nets: Vec<String>,
        info: s::BoardInfo,
        #[serde(flatten)]
        options: s::PlanOptions,
    },
    VoidRects {
        outline: Rings,
        ref_polys: Vec<Rings>,
        #[serde(default)]
        discs: Vec<Disc>,
        #[serde(default = "grid")]
        grid: f64,
        #[serde(default = "min_mm")]
        min_mm: f64,
        #[serde(default)]
        tol: Option<f64>,
    },
    RefNets {
        spec: ReferenceSpec,
        #[serde(default)]
        fast: bool,
    },
    LayerKeepouts {
        spec: ReferenceSpec,
        layers: Vec<String>,
        outline: Rings,
        fills: g::Fills,
        #[serde(default)]
        discs: BTreeMap<String, Vec<Disc>>,
        #[serde(default = "grid")]
        grid: f64,
        #[serde(default)]
        fast: bool,
    },
    AddKeepouts {
        text: String,
        rects_by_layer: Keepouts,
        #[serde(default = "kinds")]
        kinds: Vec<String>,
        #[serde(default = "name")]
        name: String,
    },
    AddWireKeepouts {
        text: String,
        rects_by_layer: Keepouts,
    },
    ViaReport {
        vias: Vec<r::Via>,
        #[serde(flatten)]
        options: r::ReportOptions,
    },
    SummaryLine {
        rep: r::ViaReport,
    },
    FootprintPitch {
        points: Vec<Point>,
    },
    FinePitchRefs {
        pads_by_ref: BTreeMap<String, Vec<Point>>,
        #[serde(default = "fine_pitch")]
        limit: f64,
    },
    EscapeNets {
        pads: Vec<(String, String, bool)>,
        fine: BTreeMap<String, f64>,
        nets: BTreeSet<String>,
        #[serde(default)]
        exclude: BTreeSet<String>,
    },
    BeltMargin {
        width: f64,
        clearance: f64,
        via: f64,
    },
    Grow {
        r#box: Rect,
        m: f64,
    },
    OutsideRects {
        board_box: Rect,
        boxes: Vec<Rect>,
    },
    SwitchNodes {
        current: BTreeMap<String, s::CurrentPath>,
        #[serde(default)]
        names: Vec<String>,
    },
    HotLoop {
        pad_xy: BTreeMap<String, Point>,
        loop_pads: Vec<String>,
        factor: f64,
        margin_min: f64,
    },
    SegmentDistance {
        a0: Point,
        a1: Point,
        b0: Point,
        b1: Point,
    },
    RepairSelection {
        unrouted: Vec<g::Unrouted>,
        copper: Vec<g::Copper>,
        #[serde(default = "corridor")]
        corridor_mm: f64,
        #[serde(default)]
        exclude: BTreeSet<String>,
        #[serde(default = "max_blockers")]
        max_blockers: usize,
    },
}

fn json(value: impl serde::Serialize) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

fn handle(request: Request) -> Result<Value, String> {
    match request {
        Request::BoardInfo { board_dir, cfg } => {
            let dir = board_dir
                .as_deref()
                .filter(|d| !d.is_empty())
                .map(std::path::Path::new);
            let mut info = json(s::board_info(dir, &cfg)?)?;
            // board_info exposed the complete, unmodified reference spec, including keys the rules do not consume.
            info["spec"] =
                match dir.map(|d| std::fs::read_to_string(d.join("reference-planes.json"))) {
                    Some(Ok(text)) => serde_json::from_str(&text).map_err(|e| e.to_string())?,
                    _ => serde_json::json!({}),
                };
            Ok(info)
        }
        Request::StageOf {
            net,
            info,
            net_class,
            wide_classes,
        } => json(s::stage_of(&net, &info, &net_class, &wide_classes)),
        Request::Exempt { net, info, planes } => json(s::exempt(&net, &info, &planes)),
        Request::StagePlan {
            nets,
            info,
            options,
        } => json(s::stage_plan(&nets, &info, &options)),
        Request::VoidRects {
            outline,
            ref_polys,
            discs,
            grid,
            min_mm,
            tol,
        } => json(g::void_rects(
            &outline, &ref_polys, &discs, grid, min_mm, tol,
        )?),
        Request::RefNets { spec, fast } => json(spec.ref_nets(fast)),
        Request::LayerKeepouts {
            spec,
            layers,
            outline,
            fills,
            discs,
            grid,
            fast,
        } => json(g::layer_keepouts(
            &spec, &layers, &outline, &fills, &discs, grid, fast,
        )?),
        Request::AddKeepouts {
            text,
            rects_by_layer,
            kinds,
            name,
        } => json(g::add_keepouts(&text, &rects_by_layer, &kinds, &name)?),
        Request::AddWireKeepouts {
            text,
            rects_by_layer,
        } => json(g::add_keepouts(&text, &rects_by_layer, &kinds(), &name())?),
        Request::ViaReport { vias, options } => json(r::via_report(&vias, &options)),
        Request::SummaryLine { rep } => json(r::summary_line(&rep)),
        Request::FootprintPitch { points } => json(s::footprint_pitch(&points)),
        Request::FinePitchRefs { pads_by_ref, limit } => {
            json(s::fine_pitch_refs(&pads_by_ref, limit))
        }
        Request::EscapeNets {
            pads,
            fine,
            nets,
            exclude,
        } => json(s::escape_nets(&pads, &fine, &nets, &exclude)),
        Request::BeltMargin {
            width,
            clearance,
            via,
        } => json(s::belt_margin(width, clearance, via)),
        Request::Grow { r#box, m } => json(g::grow(r#box, m)),
        Request::OutsideRects { board_box, boxes } => json(g::outside_rects(board_box, &boxes)),
        Request::SwitchNodes { current, names } => json(s::switch_nodes(&current, &names)),
        Request::HotLoop {
            pad_xy,
            loop_pads,
            factor,
            margin_min,
        } => json(s::hot_loop(&pad_xy, &loop_pads, factor, margin_min)),
        Request::SegmentDistance { a0, a1, b0, b1 } => json(g::segment_distance(a0, a1, b0, b1)),
        Request::RepairSelection {
            unrouted,
            copper,
            corridor_mm,
            exclude,
            max_blockers,
        } => json(g::repair_selection(
            &unrouted,
            &copper,
            corridor_mm,
            &exclude,
            max_blockers,
        )),
    }
}

fn main() -> std::process::ExitCode {
    let mut text = String::new();
    let result = io::stdin()
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())
        .and_then(|_| serde_json::from_str(&text).map_err(|e| e.to_string()))
        .and_then(handle);
    match result {
        Ok(value) => {
            println!("{value}");
            std::process::ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("FAIL routing_rules: {error}");
            std::process::ExitCode::from(2)
        }
    }
}

#[cfg(test)]
#[path = "../routing_rules/tests.rs"]
mod tests;
