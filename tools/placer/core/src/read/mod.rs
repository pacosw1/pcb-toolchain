//! A board as a placement problem. Input: the board JSON of `iotroute board-json` and the project files beside the board. See
//! tools/placer/README.md for what each field means to the search.
//!
//! Units: a PCB group with footprints; else a block (a closed User.1 rectangle and the footprints inside it, or the parts of an
//! explicit membership); else one footprint. Fixed: locked footprints, mounting holes, connectors at the outline, parts not on
//! F.Cu, refs in `fix`, units outside `free_box`; a unit with one fixed part is fixed. Copper: tracks and vias that stay whatever
//! the movable units do count as used room; locked copper is fixed copper.

pub mod cli;
pub mod clusters;
pub mod extras;
pub mod grouping;
pub mod options;
pub mod out;
pub mod parts;
pub mod project;
pub mod units;

use crate::dru::fnmatch;
use crate::geom::Rect;
use crate::kicad::clusters::{Clusters, contains};
use crate::kicad::doc::{Board, Copper, CopperItem, Footprint, Pad, PtMm, board_outline, mm};
use extras::{Index, block_cuts, edges_and_zones, in_boxes, matching_codes, near_rules, net_codes};
use grouping::{group_parts, shape_polygon};
use options::{Members, Options};
use out::{BoardOut, CopperRow, Net, ProblemOut, Region, RouteRules, Unit, Xy};
use parts::{fp_rect, is_test_point, round6};
use project::{DomainClasses, Project, class_gaps, domain_areas, escape_rules, keepout_gaps};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;
use units::Reader;

fn xy_ring(ring: &[(f64, f64)]) -> Vec<Xy> {
    ring.iter().map(|&(x, y)| [x, y]).collect()
}

fn zone_ring(z: &crate::kicad::doc::Zone) -> Option<Vec<Xy>> {
    z.outline.first().map(|p| p.outline.iter().map(|q| [mm(q.x), mm(q.y)]).collect())
}

/// Board holes, rule areas that keep parts out, and closed shapes on the keepout layers.
fn keepouts(board: &Board, holes: &[Vec<(f64, f64)>], options: &Options) -> Vec<Vec<Xy>> {
    let mut out: Vec<Vec<Xy>> = holes.iter().map(|h| xy_ring(h)).collect();
    let keeps_parts = |z: &&crate::kicad::doc::Zone| {
        let area = z.rule_area.is_some_and(|a| a.footprints) && z.layers.iter().any(|l| l == "F.Cu");
        z.rule_area.is_some() && (area || options.keepout_zones.iter().any(|p| fnmatch(&z.name, p)))
    };
    out.extend(board.zones.iter().filter(keeps_parts).filter_map(zone_ring));
    let on_layer = board.graphics.iter().filter(|g| options.keepout_layers.contains(&g.layer));
    out.extend(on_layer.filter_map(shape_polygon).map(|p| xy_ring(&p)));
    out
}

fn via_keepouts(board: &Board, options: &Options) -> Vec<Vec<Xy>> {
    let keeps_vias = |z: &&crate::kicad::doc::Zone| z.rule_area.is_some_and(|a| a.vias) && !options.zone_refs.contains_key(&z.name);
    board.zones.iter().filter(keeps_vias).filter_map(zone_ring).collect()
}

fn copper_row(item: &Copper) -> CopperRow {
    match item {
        Copper::Via(v) => {
            let (x, y) = v.at.mm();
            CopperRow("via".to_string(), x, y, x, y, mm(v.size))
        }
        Copper::Track(t) => CopperRow(t.layer.clone(), mm(t.start.x), mm(t.start.y), mm(t.end.x), mm(t.end.y), mm(t.width)),
    }
}

/// A row per copper layer of a track or via.
fn layer_rows(board: &Board, item: &Copper) -> Vec<CopperRow> {
    let row = copper_row(item);
    let on = item.layers();
    let layers = board.copper_layers.iter().filter(|l| on.contains(&l.as_str()));
    layers.map(|l| CopperRow(l.clone(), row.1, row.2, row.3, row.4, row.5)).collect()
}

/// Copper that stays whatever the movable units do: clusters with no end on a pad of a movable unit, not inside the border of a
/// movable block, and not a lone stitching via (the writer removes those a moved part lands on).
fn kept_copper(board: &Board, units: &[Unit], by_ref: &HashMap<&str, &Footprint>) -> Vec<CopperRow> {
    let mut pads: HashMap<&str, Vec<&Pad>> = HashMap::new();
    let mut boxes = Vec::new();
    for u in units.iter().filter(|u| !u.fixed) {
        boxes.extend(u.boxed.map(|b| Rect::new(b[0], b[1], b[2], b[3])));
        for p in u.refs.iter().flat_map(|r| &by_ref[r.as_str()].pads).filter(|p| !p.net.is_empty()) {
            pads.entry(&p.net).or_default().push(p);
        }
    }
    let inside_a_block = |t: &&Copper| boxes.iter().any(|b| t.ends().iter().all(|p| contains(*b, p.mm().0, p.mm().1)));
    let free: Vec<&Copper> = board.copper.iter().filter(|t| !t.locked()).filter(|t| !inside_a_block(t)).collect();
    let clusters = Clusters::new(free);
    let mut gone = clusters.on_pads(&pads);
    gone.extend(clusters.lone_vias(None));
    let kept = clusters.items.iter().enumerate().filter(|(k, _)| !gone.contains(&clusters.find(*k)));
    kept.map(|(_, t)| copper_row(t)).collect()
}

/// A virtual net that keeps a group together: the courtyard box of each unit is its pin.
fn cohesion_pins(units: &[Unit], unit_of: &HashMap<String, usize>, refs: &[String]) -> Option<Vec<(usize, f64, f64, f64, f64)>> {
    let ids: BTreeSet<usize> = refs.iter().filter_map(|r| unit_of.get(r).copied()).collect();
    if ids.len() < 2 || ids.iter().all(|i| units[*i].fixed) {
        return None;
    }
    let row = |i: &usize| {
        let u = &units[*i];
        let core: Vec<&[f64; 5]> = u.rects.iter().enumerate().filter(|(k, _)| !u.border.contains(k) && !u.ko.contains(k)).map(|(_, r)| r).collect();
        let rects = if core.is_empty() { u.rects.iter().collect() } else { core };
        let min = |k: usize| rects.iter().map(|r| r[k]).fold(f64::INFINITY, f64::min);
        let max = |k: usize| rects.iter().map(|r| r[k]).fold(f64::NEG_INFINITY, f64::max);
        (*i, min(0), min(1), max(2), max(3))
    };
    Some(ids.iter().map(row).collect())
}

fn cohesion_nets(units: &[Unit], unit_of: &HashMap<String, usize>, members: &Members, options: &Options) -> Vec<Net> {
    let net = |name: String, weight: f64, pins| Net { name, weight, pins, pts: None, track: 0.0, cohesion: true };
    let mut out = Vec::new();
    if options.w_block > 0.0 {
        for (name, refs) in &members.blocks {
            let pins = cohesion_pins(units, unit_of, refs).filter(|p: &Vec<_>| p.iter().any(|q| units[q.0].name != *name));
            out.extend(pins.map(|p| net(format!("~block:{name}"), options.w_block, p)));
        }
    }
    if options.w_comp > 0.0 {
        for (name, items) in &members.components {
            let refs: Vec<String> = items.iter().flat_map(|x| members.blocks.get(x).cloned().unwrap_or_else(|| vec![x.clone()])).collect();
            out.extend(cohesion_pins(units, unit_of, &refs).map(|p| net(format!("~comp:{name}"), options.w_comp, p)));
        }
    }
    out
}

#[derive(Default)]
struct NetPins {
    /// Unit to pin box and pad centres.
    units: BTreeMap<usize, ([f64; 4], Vec<Xy>)>,
    class: String,
    in_region: bool,
}

fn collect_pins(board: &Board, units: &[Unit], unit_of: &HashMap<String, usize>, options: &Options) -> BTreeMap<String, NetPins> {
    let mut nets: BTreeMap<String, NetPins> = BTreeMap::new();
    for fp in board.footprints.iter().filter(|f| options.tp_pins || !is_test_point(&f.reference)) {
        let ui = unit_of[&fp.reference];
        let u = &units[ui];
        for p in &fp.pads {
            let n = &p.net;
            if n.is_empty() || n.starts_with("unconnected-") || options.skip.iter().any(|s| fnmatch(n, s)) {
                continue;
            }
            let (x, y) = (mm(p.position.x) - u.x, mm(p.position.y) - u.y);
            let net = nets.entry(n.clone()).or_default();
            net.class = board.net_class(n).to_string();
            let (b, points) = net.units.entry(ui).or_insert(([x, y, x, y], Vec::new()));
            *b = [b[0].min(x), b[1].min(y), b[2].max(x), b[3].max(y)];
            points.push([round6(x), round6(y)]);
            net.in_region |= options.region_refs.contains(&fp.reference);
        }
    }
    nets
}

fn real_nets(pins: BTreeMap<String, NetPins>, units: &[Unit], tracks: &BTreeMap<&str, f64>, options: &Options) -> Vec<Net> {
    let default = tracks.get("Default").copied().unwrap_or(0.0);
    let mut out = Vec::new();
    for (name, net) in pins {
        if net.units.len() < 2 || net.units.keys().all(|i| units[*i].fixed) {
            continue;
        }
        let track = net.class.split(',').map(|c| tracks.get(c).copied().unwrap_or(default)).fold(f64::MIN, f64::max);
        let weight = if net.in_region { options.region_weight } else { 1.0 };
        let rows = net.units.iter().map(|(i, (b, _))| (*i, round6(b[0]), round6(b[1]), round6(b[2]), round6(b[3]))).collect();
        let pts = net.units.values().map(|(_, p)| p.clone()).collect();
        out.push(Net { name, weight, pins: rows, pts: Some(pts), track, cohesion: false });
    }
    out
}

fn region(by_ref: &HashMap<&str, &Footprint>, options: &Options) -> Option<Region> {
    if options.region_refs.is_empty() {
        return None;
    }
    let around = || {
        let rects = options.region_refs.iter().filter_map(|r| by_ref.get(r.as_str())).map(|f| fp_rect(f));
        Rect::bounding(rects).map(|r| r.grown(15.0))
    };
    let b = options.region_box.or_else(around)?;
    let mut refs = options.region_refs.clone();
    refs.sort();
    refs.dedup();
    Some(Region { boxed: [b.x0, b.y0, b.x1, b.y1], weight: options.region_weight, refs })
}

fn cu_nets(units: &[Unit], codes: &HashMap<String, i64>, board: &Board) -> BTreeMap<String, (String, String)> {
    let used: BTreeSet<i64> = units.iter().flat_map(|u| u.cu.iter().map(|c| c.4)).filter(|c| *c > 0).collect();
    let named = codes.iter().filter(|(_, c)| used.contains(c));
    named.map(|(n, c)| (c.to_string(), (n.clone(), board.net_class(n).to_string()))).collect()
}

/// The problem of a board. `path` is the board file: its project files sit beside it.
pub fn read_problem(path: &Path, board: &Board, options: &Options) -> crate::Result<ProblemOut> {
    let project = Project::load(path, board, options.domains.as_deref())?;
    let (outline, holes) = board_outline(board)?;
    let locked: Vec<&Copper> = board.copper.iter().filter(|t| t.locked()).collect();
    let by_ref: HashMap<&str, &Footprint> = board.footprints.iter().map(|f| (f.reference.as_str(), f)).collect();
    let grouping = group_parts(board, options, &outline, &locked, &by_ref)?;
    let codes = net_codes(board);
    let reader = Reader { board, by_ref: &by_ref, options, project: &project, outline: &outline, locked: &locked, net_codes: &codes };
    let mut classes = DomainClasses::default();
    let drafts: Vec<_> = grouping.units.iter().filter(|d| !d.refs.is_empty()).collect();
    let mut units: Vec<Unit> = drafts.iter().map(|d| reader.unit(d, &mut classes)).collect::<crate::Result<_>>()?;
    let unit_of: HashMap<String, usize> = drafts.iter().enumerate().flat_map(|(i, d)| d.refs.iter().map(move |r| (r.clone(), i))).collect();

    let index = Index { by_ref: &by_ref, unit_of: &unit_of };
    edges_and_zones(board, &mut units, &index, options)?;
    in_boxes(&mut units, &options.in_boxes)?;
    near_rules(&mut units, &index, &options.near)?;
    let kept_keepouts = block_cuts(board, &mut units, keepouts(board, &holes, options));

    let tracks = project.class_tracks();
    let mut nets = real_nets(collect_pins(board, &units, &unit_of, options), &units, &tracks, options);
    if let Some(members) = &options.blocks {
        nets.extend(cohesion_nets(&units, &unit_of, members, options));
    }
    let proposal = options.auto_clusters.map(|weight| clusters::propose(board, &units, &unit_of, &nets, weight));
    let (proposed, ties) = proposal.map_or((Vec::new(), Vec::new()), |p| (p.clusters, p.nets));
    nets.extend(ties);
    let moving: BTreeSet<&str> = units.iter().flat_map(|u| u.locked_cu.iter().map(String::as_str)).collect();
    let fixed: Vec<&&Copper> = locked.iter().filter(|t| !moving.contains(t.id())).collect();
    let rules = &project.rules;
    let plane_nets: BTreeSet<String> = board.zones.iter().filter(|z| z.rule_area.is_none() && !z.net.is_empty()).map(|z| z.net.clone()).collect();
    Ok(ProblemOut {
        board_file: std::path::absolute(path)?.display().to_string(),
        nets,
        board: BoardOut {
            outline: xy_ring(&outline),
            keepouts: kept_keepouts,
            edge_clearance: mm(board.constraints.copper_edge_clearance),
            copper: kept_copper(board, &units, &by_ref),
            fixed_copper: fixed.iter().map(|t| copper_row(t)).collect(),
            fixed_copper_layers: fixed.iter().flat_map(|t| layer_rows(board, t)).collect(),
            via_keepouts: via_keepouts(board, options),
            keepout_gaps: keepout_gaps(&classes, &rules.nonet),
        },
        region: region(&by_ref, options),
        move_box: options.free_box.map(|b| [b.x0, b.y0, b.x1, b.y1]),
        decaps: grouping.decaps,
        dru_ignored: rules.ignored.clone(),
        class_gaps: class_gaps(&classes, rules),
        domain_areas: domain_areas(&classes, &rules.domains),
        route_rules: RouteRules { dru: rules.into(), classes: project.class_rules() },
        escape_rules: escape_rules(board, &project),
        cu_nets: cu_nets(&units, &codes, board),
        via_nets: matching_codes(&codes, &options.via_nets),
        plane_nets: plane_nets.into_iter().collect(),
        clusters: proposed,
        units,
        engineering: None,
    })
}
