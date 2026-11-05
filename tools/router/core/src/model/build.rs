//! The route model from a board and its files.
use super::current::{CurrentContext, apply_paths, plane_fanout_vias, set_fanout_vias, set_pin_escapes, size_power_vias};
use super::files::{BoardFiles, PinRatings};
use super::isolation::{IsoContext, apply_pair_rules};
use super::items::{box4, initial_nets, read_copper, read_edges, read_keepouts, read_pads, read_zones};
use super::num::Num;
use super::output::{BoardMin, Class, HoleRules, Model, Net, PlaneClearance, RuleState, Setup, Zone};
use super::pairs::PairRules;
use super::planes::{plane_reach, reference_fill, set_plane_ref};
use super::returns::{RpScope, copper_thickness, return_rule, set_gate_exemptions, set_return_nets, set_return_scope, via_length};
use super::rules::apply_rules;
use super::thermal::{ThermalRules, apply_thermal_vias};
use crate::kicad::board::{Board, RoutedCopper};
use crate::kicad::pad::Pad as BoardPad;
use std::collections::{BTreeMap, BTreeSet};

const SCHEMA: &str = "iot-lab.route-model.v0";

/// What the model is built from. `filled` is the board after a fresh refill; `rp_scope` is the kicad-happy answer, when the gate
/// has a kicad_happy check with settings.
pub struct Inputs<'a> {
    pub board: &'a Board,
    pub filled: &'a Board,
    pub files: &'a BoardFiles,
    pub ratings: &'a PinRatings,
    pub rp_scope: Option<RpScope>,
    pub return_exempt: bool,
}

fn classes(files: &BoardFiles) -> BTreeMap<String, Class> {
    files.project.net_settings.classes.iter().map(|c| {
        (c.name.clone(), Class { width: c.track_width, clearance: c.clearance, via: c.via_diameter, drill: c.via_drill })
    }).collect()
}

fn set_class_defaults(nets: &mut BTreeMap<String, Net>, classes: &BTreeMap<String, Class>) {
    for net in nets.values_mut() {
        if let Some(class) = classes.get(&net.class).or_else(|| classes.get("Default")) {
            net.width = class.width;
            net.clearance = class.clearance;
        }
    }
}

fn setup(files: &BoardFiles) -> Setup {
    let rules = files.rules_setup();
    Setup {
        min_via: rules.min_via_diameter,
        min_drill: rules.min_through_hole_diameter,
        min_clearance: rules.min_clearance,
        min_track: rules.min_track_width,
        edge_clearance: rules.min_copper_edge_clearance,
        min_spokes: rules.min_resolved_spokes.unwrap_or(Num::Int(2)),
    }
}

fn plane_clearance(zones: &[Zone], plane_layers: &BTreeSet<String>) -> PlaneClearance {
    let min = zones.iter().filter(|z| plane_layers.contains(&z.layer) && !z.net.is_empty()).map(|z| z.clearance).fold(0.0, f64::max);
    PlaneClearance { min, source: format!("max local clearance of the zones on {}", plane_layers.iter().cloned().collect::<Vec<_>>().join(", ")) }
}

/// The locked input vias of a net count in its DRU via_count, as KiCad's too_many_vias.
fn count_input_vias(board: &Board, nets: &mut BTreeMap<String, Net>) {
    for copper in &board.copper {
        if let RoutedCopper::Via(via) = copper
            && let Some(net) = nets.get_mut(&via.net)
        {
            *net.input_vias.get_or_insert(0) += 1;
        }
    }
}

pub fn build(inputs: Inputs) -> Result<Model, String> {
    let Inputs { board, filled, files, ratings, rp_scope, return_exempt } = inputs;
    let planes = &files.planes;
    let plane_layers: BTreeSet<String> = planes.plane_layers.iter().cloned().collect();
    let classes = classes(files);
    let mut nets = initial_nets(board, files);
    let mut pads = read_pads(board, files, &mut nets);
    let copper = read_copper(board);
    set_class_defaults(&mut nets, &classes);

    let pairs: Vec<(String, String)> = files.pairs.iter().map(|p| (p.p.clone(), p.n.clone())).collect();
    let pair_nets: BTreeSet<String> = pairs.iter().flat_map(|(p, n)| [p.clone(), n.clone()]).collect();
    let outcome = apply_rules(&files.rules, &mut nets, &pair_nets, &plane_layers)?;
    let mut report = outcome.report;
    let keepouts = read_keepouts(board);
    let (mut zones, zone_sources) = read_zones(board, &nets, &outcome.zone_rules);
    plane_reach(board, &mut nets, &pads, &zones, &zone_sources, &plane_layers);
    let pair_rules = PairRules::new(&files.rules)?;
    let iso_context = IsoContext { board, rules: &pair_rules, pairs: &pairs, nets: &nets, sources: &zone_sources };
    let iso = apply_pair_rules(&iso_context, &mut pads, &mut zones, &mut report);

    let context = CurrentContext::new(files, copper_thickness(board));
    apply_paths(files, &mut nets, &pads, &context);
    size_power_vias(&mut nets, &classes, &context);
    set_fanout_vias(&mut pads, &plane_fanout_vias(&nets, &classes, &context));
    let sources: Vec<&BoardPad> = board.pads().map(|(_, p)| p).collect();
    let rules = ThermalRules { nets: &nets, classes: &classes, setup: files.rules_setup(), hole_to_hole: &outcome.hole_to_hole, allow: files.gate.checks.via_pad_allow() };
    apply_thermal_vias(&files.thermal.pads, &mut pads, &sources, &rules)?;
    set_pin_escapes(board, &mut pads, &nets, ratings);
    set_plane_ref(&mut nets, planes);
    count_input_vias(board, &mut nets);
    let ref_fill = reference_fill(board, filled, &mut nets, files)?;

    let design = files.rules_setup();
    let mut model = Model {
        schema: SCHEMA,
        board: files.folder.file_name().map_or(String::new(), |n| n.to_string_lossy().into_owned()),
        pcb: board.path.clone(),
        copper_layers: board.copper_layers.clone(),
        plane_layers: plane_layers.iter().cloned().collect(),
        adjacent: planes.adjacent.clone(),
        grounds: planes.grounds.clone(),
        current_dt: context.dt,
        copper_thickness: context.thickness,
        outline_bbox: box4(board.edges_bbox),
        setup: setup(files),
        return_rule: return_rule(board, files)?,
        via_length: via_length(board),
        classes,
        nets,
        pairs: files.pairs.iter().map(|p| p.raw.clone()).collect(),
        hole_rules: HoleRules {
            plane_clearance: plane_clearance(&zones, &plane_layers),
            hole_to_hole: outcome.hole_to_hole,
            hole_clearance: outcome.hole_clearance,
            board_min: BoardMin { hole_clearance: design.min_hole_clearance, hole_to_hole: design.min_hole_to_hole },
        },
        zones,
        keepouts,
        edges: read_edges(board),
        pads,
        copper,
        rules: report,
        iso,
        ref_fill,
        return_net: None,
        return_nets: None,
        return_exempt: None,
        return_scope: None,
    };
    set_return_nets(&mut model, files.gate.checks.happy_settings());
    if return_exempt {
        set_gate_exemptions(&mut model, files)?;
    }
    if let Some(scope) = rp_scope {
        set_return_scope(&mut model, scope);
    }
    Ok(model)
}

/// `MODEL ok|FAIL nets N pads N copper N rules <state> <count> ...`; ok unless a rule is unknown.
pub fn summary(model: &Model) -> (bool, String) {
    let mut states: BTreeMap<&str, usize> = BTreeMap::new();
    for rule in &model.rules {
        *states.entry(rule.state.name()).or_default() += 1;
    }
    let ok = !model.rules.iter().any(|r| r.state == RuleState::Unknown);
    let counts: Vec<String> = states.iter().map(|(k, v)| format!("{k} {v}")).collect();
    (ok, format!("MODEL {} nets {} pads {} copper {} rules {}", if ok { "ok" } else { "FAIL" }, model.nets.len(), model.pads.len(), model.copper.len(), counts.join(" ")))
}
