//! `route_grid escape`: can a track leave each SMD pad of a routed net with more than one pad? It must reach the pad box of the
//! footprint + 0.3 mm, or a via site, within `reach_mm`. Pads that cannot are boxed in. A grid diagnosis, no routability proof.
use super::board::{GridBoard, NetGrids, NetPad};
use super::flood::flood;
use super::mask::{Mask, Window};
use super::sources::{BoundSources, bound_sources};
use crate::kicad::board::Board;
use crate::kicad::pad::PadKind;
use crate::kicad::rules::DesignRules;
use crate::kicad::sexpr::parse;
use crate::model::text::glob_match;
use crate::sha256::sha256;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::Path;

const PAD_BOX_HALO_MM: f64 = 0.3;

/// `pin_escape_check` of the route features. `raw` is reported as it stands.
#[derive(Debug, Clone, PartialEq)]
pub struct EscapeConfig {
    pub grid_mm: f64,
    pub reach_mm: f64,
    pub halo_hint_mm: f64,
    pub raw: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EscapeScope {
    pub layers: Vec<String>,
    pub skip: Vec<String>,
    pub nets: Option<BTreeSet<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScreenedPad {
    pub r#ref: String,
    pub pad: String,
    pub net: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NotApplicable {
    pub r#ref: String,
    pub pad: String,
    pub net: String,
    pub reason: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BoxedIn {
    pub pad: String,
    pub net: String,
    pub r#ref: String,
    pub free_cells_at_pad: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Parameters {
    pub grid_mm: f64,
    pub reach_mm: f64,
    pub halo_hint_mm: f64,
    pub pad_box_halo_mm: f64,
    pub layers: Vec<String>,
    pub skip_nets: Vec<String>,
    pub net_filter: Option<Vec<String>>,
    pub width_model: &'static str,
    pub clearance_model: &'static str,
}

/// The program that made a report and the KiCad that read the board.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Runtime {
    pub kicad_version: String,
    pub program: BTreeMap<String, String>,
}

/// iot-lab.pin-escape-evidence.v1
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EscapeReport {
    pub schema: &'static str,
    pub source_inputs: BoundSources,
    pub board: String,
    pub layers: Vec<String>,
    pub grid_mm: f64,
    pub pads_checked: usize,
    pub generator_inputs: BTreeMap<String, String>,
    pub runtime: Runtime,
    pub feature_config: Value,
    pub model_parameters: Parameters,
    pub native_minimum_track_width_mm: f64,
    pub screened_pads: Vec<ScreenedPad>,
    pub not_applicable: Vec<NotApplicable>,
    pub unsupported_constraints: Vec<String>,
    pub not_checked: usize,
    pub scope: &'static str,
    pub boxed_in: Vec<BoxedIn>,
    pub halo_hint: BTreeMap<String, f64>,
}

impl EscapeReport {
    pub fn line(&self) -> String {
        let refs: BTreeSet<&str> = self.boxed_in.iter().map(|b| b.r#ref.as_str()).collect();
        let parts = if refs.is_empty() { String::new() } else { format!(" parts {}", refs.iter().take(12).copied().collect::<Vec<_>>().join(",")) };
        format!("ESCAPE pads {} boxed_in {}{parts}", self.pads_checked, self.boxed_in.len())
    }
}

/// The running binary and the feature file: what generated the evidence.
pub fn generator_inputs(features: &Path) -> Result<BTreeMap<String, String>, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut out = BTreeMap::new();
    for path in [exe.as_path(), features] {
        let bytes = fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
        out.insert(path.display().to_string(), sha256(&bytes));
    }
    Ok(out)
}

/// The rule names of the .kicad_dru beside a board: the grid applies none of them.
fn unsupported_constraints(board: &Path) -> Result<Vec<String>, String> {
    let Ok(text) = fs::read_to_string(board.with_extension("kicad_dru")) else { return Ok(Vec::new()) };
    let forms = parse(&text)?;
    Ok(forms.iter().filter(|f| !f.is("version")).filter_map(|f| f.text(1).or(f.head()).map(str::to_string)).collect())
}

struct Screen {
    /// Reference to the pads to check, sorted by reference.
    by_part: BTreeMap<String, Vec<(String, NetPad)>>,
    not_applicable: Vec<NotApplicable>,
}

fn pick_pads(grid: &GridBoard, scope: &EscapeScope) -> Screen {
    let (mut by_part, mut not_applicable): (BTreeMap<String, Vec<(String, NetPad)>>, Vec<NotApplicable>) = (BTreeMap::new(), Vec::new());
    let left = |at: &NetPad, net: &str, reason| {
        let (f, p) = grid.pad(at);
        NotApplicable { r#ref: f.reference.clone(), pad: p.number.clone(), net: net.to_string(), reason }
    };
    for (net, pads) in &grid.net_pads {
        if pads.len() < 2 {
            not_applicable.extend(pads.iter().map(|at| left(at, net, "native_single_pad_net")));
            continue;
        }
        if scope.skip.iter().any(|s| glob_match(net, s)) || scope.nets.as_ref().is_some_and(|n| !n.contains(net)) {
            continue;
        }
        let one_part = pads.iter().all(|at| grid.pad(at).0.reference == grid.pad(&pads[0]).0.reference);
        for at in pads {
            let (footprint, pad) = grid.pad(at);
            if pad.drill.x != 0 || pad.kind == PadKind::NpThroughHole {
                continue; // A through-hole pad is on every layer.
            }
            if one_part {
                not_applicable.push(left(at, net, "native_single_part_net"));
                continue;
            }
            by_part.entry(footprint.reference.clone()).or_default().push((net.clone(), *at));
        }
    }
    Screen { by_part, not_applicable }
}

/// The pad box of a part, as the boxes of its pads.
fn part_box(grid: &GridBoard, reference: &str) -> [f64; 4] {
    let pads = grid.items.iter().filter(|x| x.kind == super::item::ItemKind::Pad && x.reference() == reference);
    pads.fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |b, x| [b[0].min(x.bbox[0]), b[1].min(x.bbox[1]), b[2].max(x.bbox[2]), b[3].max(x.bbox[3])])
}

/// The cells of a window outside a box grown by the halo.
fn outside(grid: &GridBoard, window: Window, bx: [f64; 4]) -> Mask {
    let mut out = Mask::filled(window, false);
    for j in 0..out.ny() {
        for i in 0..out.nx() {
            let (x, y) = grid.centre(&window, j, i);
            out.set(j, i, !(x >= bx[0] - PAD_BOX_HALO_MM && x <= bx[2] + PAD_BOX_HALO_MM && y >= bx[1] - PAD_BOX_HALO_MM && y <= bx[3] + PAD_BOX_HALO_MM));
        }
    }
    out
}

fn check_part(grid: &mut GridBoard, reference: &str, pads: &[(String, NetPad)], reach: f64, screened: &mut Vec<ScreenedPad>, boxed: &mut Vec<BoxedIn>) {
    let bx = part_box(grid, reference);
    let window = grid.window(bx[0] - reach, bx[1] - reach, bx[2] + reach, bx[3] + reach);
    let outside = outside(grid, window, bx);
    let mut by_net: HashMap<&str, NetGrids> = HashMap::new();
    for (net, at) in pads {
        let number = grid.pad(at).1.number.clone();
        screened.push(ScreenedPad { r#ref: reference.to_string(), pad: number, net: net.clone() });
        if !by_net.contains_key(net.as_str()) {
            by_net.insert(net, grid.net_grids(net, window, false));
        }
        let grids = &by_net[net.as_str()];
        let seeds = grid.item_seed(at.item, window);
        let target = vec![outside.or(&grids.via_ok); grid.layers.len()];
        if !flood(grids, &seeds, Some(&target)).0 {
            let free_cells_at_pad = seeds.iter().zip(&grids.free).map(|(s, f)| s.and(f).count()).sum();
            boxed.push(BoxedIn { pad: grid.items[at.item].owner.clone(), net: net.clone(), r#ref: reference.to_string(), free_cells_at_pad });
        }
    }
}

/// Screens a board. `generator` and `runtime` are recorded as given.
pub fn escape(board: &Board, rules: &DesignRules, path: &Path, config: &EscapeConfig, scope: &EscapeScope, generator: BTreeMap<String, String>, runtime: Runtime) -> Result<EscapeReport, String> {
    let sources = bound_sources(path)?;
    let mut grid = GridBoard::new(board, rules, &scope.layers, config.grid_mm)?;
    if !grid.min_width.is_finite() || grid.min_width <= 0.0 {
        return Err("escape minimum native track width is missing/nonpositive".to_string());
    }
    let Screen { by_part, not_applicable } = pick_pads(&grid, scope);
    let (mut screened, mut boxed) = (Vec::new(), Vec::new());
    for (reference, pads) in &by_part {
        check_part(&mut grid, reference, pads, config.reach_mm, &mut screened, &mut boxed);
    }
    let unsupported_constraints = unsupported_constraints(path)?;
    if sources != bound_sources(path)? {
        return Err("native sources changed during escape diagnosis".to_string());
    }
    let halo_hint = boxed.iter().map(|b| (b.r#ref.clone(), config.halo_hint_mm)).collect();
    let net_filter = scope.nets.as_ref().map(|n| n.iter().cloned().collect());
    let model_parameters = Parameters {
        grid_mm: config.grid_mm,
        reach_mm: config.reach_mm,
        halo_hint_mm: config.halo_hint_mm,
        pad_box_halo_mm: PAD_BOX_HALO_MM,
        layers: scope.layers.clone(),
        skip_nets: scope.skip.clone(),
        net_filter,
        width_model: "native_design_minimum",
        clearance_model: "native_item_and_net_maximum",
    };
    Ok(EscapeReport {
        schema: "iot-lab.pin-escape-evidence.v1",
        source_inputs: sources,
        board: std::path::absolute(path).map_err(|e| e.to_string())?.display().to_string(),
        layers: scope.layers.clone(),
        grid_mm: config.grid_mm,
        pads_checked: screened.len(),
        generator_inputs: generator,
        runtime,
        feature_config: config.raw.clone(),
        model_parameters,
        native_minimum_track_width_mm: grid.min_width,
        screened_pads: screened,
        not_applicable,
        unsupported_constraints,
        not_checked: 0,
        scope: "native polygon/minimum-width grid diagnostic; no physical routability proof",
        boxed_in: boxed,
        halo_hint,
    })
}
