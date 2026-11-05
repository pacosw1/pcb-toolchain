//! `route_grid triage`: every open connection of a DRC report is ENCLOSED (no legal path from one end to the other) or ROUTER_MISS
//! (one exists; the router did not find it). For ENCLOSED the obstacles on the edge of the smaller region are named.
use super::board::{GridBoard, NetGrids};
use super::flood::{Tally, blockers, flood};
use super::mask::Mask;
use super::opens::{End, Open, all_opens, item_for, pads_by_uuid};
use super::sources::{BoundSources, bound_sources};
use crate::kicad::board::Board;
use crate::kicad::rules::DesignRules;
use crate::model::text::{glob_match, round_to};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::Path;

/// `triage_opens` of the route features.
#[derive(Debug, Clone, PartialEq)]
pub struct TriageConfig {
    pub grid_mm: f64,
    pub max_opens: usize,
}

/// Which connections count.
#[derive(Debug, Clone, PartialEq)]
pub struct TriageScope {
    pub layers: Vec<String>,
    /// Glob patterns of nets left out.
    pub skip: Vec<String>,
    /// Only these nets, when given: a staged job.
    pub nets: Option<BTreeSet<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Connection {
    pub net: String,
    pub a: String,
    pub b: String,
    pub a_pos: Value,
    pub b_pos: Value,
    pub class: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enclosed_side: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region_mm2: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocking_nets: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocking_parts: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocking_keepouts: Option<Vec<String>>,
}

/// iot-lab.open-triage-evidence.v1
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TriageReport {
    pub schema: &'static str,
    pub source_inputs: BoundSources,
    pub board: String,
    pub layers: Vec<String>,
    pub grid_mm: f64,
    pub open: usize,
    pub enclosed: usize,
    pub router_miss: usize,
    pub unknown: usize,
    pub not_checked: usize,
    pub top_blockers: Vec<String>,
    pub connections: Vec<Connection>,
}

impl TriageReport {
    pub fn line(&self) -> String {
        let blockers = if self.enclosed > 0 { format!(" blockers {}", self.top_blockers.join(",")) } else { String::new() };
        format!("TRIAGE open {} enclosed {} router_miss {} unknown {}{blockers}", self.open, self.enclosed, self.router_miss, self.unknown)
    }
}

fn counted(open: &Open, scope: &TriageScope) -> bool {
    let skipped = scope.skip.iter().any(|s| glob_match(&open.net, s)) || open.a.description.contains("Zone");
    !skipped && scope.nets.as_ref().is_none_or(|n| n.contains(&open.net))
}

fn row(open: &Open, class: &'static str) -> Connection {
    let End { description: a, pos: a_pos, .. } = open.a.clone();
    let End { description: b, pos: b_pos, .. } = open.b.clone();
    Connection { net: open.net.clone(), a, b, a_pos, b_pos, class, enclosed_side: None, region_mm2: None, blocking_nets: None, blocking_parts: None, blocking_keepouts: None }
}

fn area(region: &[Mask], g: f64) -> f64 {
    region.iter().map(Mask::count).sum::<usize>() as f64 * g.powf(2.0)
}

/// One connection with both ends known.
fn classify(grid: &mut GridBoard, grids: &NetGrids, open: &Open, ends: (usize, usize)) -> Connection {
    let full = grid.full_window();
    let (seed_a, seed_b) = (grid.item_seed(ends.0, full), grid.item_seed(ends.1, full));
    let (hit, reached_a) = flood(grids, &seed_a, Some(&seed_b));
    if hit {
        return row(open, "ROUTER_MISS");
    }
    let (_, reached_b) = flood(grids, &seed_b, None);
    let (area_a, area_b) = (area(&reached_a, grid.g), area(&reached_b, grid.g));
    let (side, reach, seeds) = if area_a <= area_b { ("a", reached_a, seed_a) } else { ("b", reached_b, seed_b) };
    // The end itself has no legal cell: name what covers it.
    let region = if reach.iter().any(Mask::any) { reach } else { seeds };
    let found = blockers(grid, &region, &grids.owners, 8);
    let keepouts = Some(found.keepouts).filter(|names| !names.is_empty());
    Connection { enclosed_side: Some(side), region_mm2: Some(round_to(area_a.min(area_b), 2)), blocking_nets: Some(found.nets), blocking_parts: Some(found.parts), blocking_keepouts: keepouts, ..row(open, "ENCLOSED") }
}

/// Classifies the opens of `drc`, a parsed report of this board.
pub fn triage(board: &Board, rules: &DesignRules, path: &Path, drc: &Value, config: &TriageConfig, scope: &TriageScope) -> Result<TriageReport, String> {
    let sources = bound_sources(path)?;
    let mut grid = GridBoard::new(board, rules, &scope.layers, config.grid_mm)?;
    let by_uuid = pads_by_uuid(&grid);
    let opens: Vec<Open> = all_opens(drc).into_iter().filter(|o| counted(o, scope)).collect();
    let full = grid.full_window();
    let mut current: Option<(String, NetGrids)> = None;
    let mut connections = Vec::new();
    for open in opens.iter().take(config.max_opens) {
        let (Some(a), Some(b)) = (item_for(&grid, &open.a, &by_uuid), item_for(&grid, &open.b, &by_uuid)) else {
            connections.push(row(open, "UNKNOWN"));
            continue;
        };
        // One net at a time: memory.
        if current.as_ref().is_none_or(|(net, _)| *net != open.net) {
            current = Some((open.net.clone(), grid.net_grids(&open.net, full, true)));
        }
        let grids = &current.as_ref().expect("just set").1;
        connections.push(classify(&mut grid, grids, open, (a, b)));
    }
    if sources != bound_sources(path)? {
        return Err("native sources changed during grid diagnosis".to_string());
    }
    let count = |class: &str| connections.iter().filter(|c| c.class == class).count();
    let (enclosed, router_miss) = (count("ENCLOSED"), count("ROUTER_MISS"));
    let mut top = Tally::default();
    for names in connections.iter().filter_map(|c| c.blocking_nets.as_ref()) {
        names.iter().take(3).for_each(|n| top.add(n, 1));
    }
    Ok(TriageReport {
        schema: "iot-lab.open-triage-evidence.v1",
        source_inputs: sources,
        board: std::path::absolute(path).map_err(|e| e.to_string())?.display().to_string(),
        layers: scope.layers.clone(),
        grid_mm: grid.g,
        open: opens.len(),
        enclosed,
        router_miss,
        unknown: connections.len() - enclosed - router_miss,
        not_checked: opens.len().saturating_sub(connections.len()),
        top_blockers: top.most_common(5),
        connections,
    })
}
