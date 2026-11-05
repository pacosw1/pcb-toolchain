//! The grid on small boards built in memory.
use super::board::GridBoard;
use super::flood::flood;
use crate::kicad::board::{Board, Footprint, RoutedCopper, Track, Via, Zone};
use crate::kicad::board::RuleArea;
use crate::kicad::geom::{Polygon, Pt, Rect, from_mm};
use crate::kicad::pad::{Copper, Pad, PadForm, PadKind, PadShape};
use crate::kicad::rules::{ClassValues, DesignRules, Minimums};
use std::collections::BTreeMap;

pub fn at(x: f64, y: f64) -> Pt {
    Pt::new(from_mm(x), from_mm(y))
}

pub fn square(x0: f64, y0: f64, x1: f64, y1: f64) -> Polygon {
    Polygon::of_ring(vec![at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1)])
}

pub fn pad(number: &str, net: &str, x: f64, y: f64, side: f64) -> Pad {
    let (position, size) = (at(x, y), at(side, side));
    let copper = PadForm { shape: PadShape::Rect, center: position, orientation: 0.0, size, corner_ratio: 0.0 }.copper();
    let bbox = copper.iter().map(Copper::bbox).reduce(Rect::merged).unwrap();
    let polygons = [("F.Cu".to_string(), square(x - side / 2.0, y - side / 2.0, x + side / 2.0, y + side / 2.0))].into_iter().collect();
    Pad { id: format!("{net}-{number}-{x}-{y}"), number: number.to_string(), kind: PadKind::Smd, shape: PadShape::Rect, net: net.to_string(), position, orientation: 0.0, size, drill: Pt::default(), layers: vec!["F.Cu".to_string()], bbox, zone_connection: None, thermal_spoke_angle: 0.0, spoke_templates: 0, copper, polygons, solder_mask_expansion: 0, clearance_override: None }
}

pub fn footprint(reference: &str, pads: Vec<Pad>) -> Footprint {
    Footprint { reference: reference.to_string(), pads, ..Footprint::default() }
}

pub fn track(net: &str, a: Pt, b: Pt, layer: &str) -> RoutedCopper {
    RoutedCopper::Track(Track { id: format!("t-{net}-{}-{}", a.x, b.y), start: a, end: b, mid: None, width: from_mm(0.2), layer: layer.to_string(), net: net.to_string(), locked: false })
}

pub fn via(net: &str, p: Pt) -> RoutedCopper {
    RoutedCopper::Via(Via { id: format!("v-{}-{}", p.x, p.y), at: p, size: from_mm(0.6), drill: from_mm(0.3), net: net.to_string(), locked: false, layers: vec!["F.Cu".to_string(), "B.Cu".to_string()] })
}

/// A 20 x 20 mm board.
pub fn board(footprints: Vec<Footprint>, copper: Vec<RoutedCopper>) -> Board {
    let nets = footprints.iter().flat_map(|f| &f.pads).map(|p| (p.net.clone(), "Default".to_string())).collect();
    Board { path: String::new(), copper_layers: vec!["F.Cu".to_string(), "B.Cu".to_string()], stackup: Vec::new(), nets, footprints, copper, zones: Vec::new(), graphics: Vec::new(), texts: Vec::new(), groups: Vec::new(), constraints: Default::default(), edges_bbox: Rect { left: 0, top: 0, right: from_mm(20.0), bottom: from_mm(20.0) }, outlines: vec![square(0.0, 0.0, 20.0, 20.0)] }
}

pub fn rules() -> DesignRules {
    let m = Minimums { clearance: from_mm(0.15), track_width: from_mm(0.15), via_size: from_mm(0.45), copper_edge_clearance: from_mm(0.3), hole_clearance: from_mm(0.25), hole_to_hole: from_mm(0.25) };
    let class = ClassValues { clearance: Some(from_mm(0.2)), via_diameter: Some(from_mm(0.6)) };
    let classes: BTreeMap<String, ClassValues> = ["", "A", "B", "GND"].iter().map(|n| (n.to_string(), class)).collect();
    DesignRules { minimums: m, classes, clearance_rules: Vec::new() }
}

pub fn layers() -> Vec<String> {
    vec!["F.Cu".to_string(), "B.Cu".to_string()]
}

#[test]
fn cells_are_counted_from_the_edge_box() {
    let b = board(Vec::new(), Vec::new());
    let g = GridBoard::new(&b, &rules(), &layers(), 0.1).unwrap();
    assert_eq!((g.nx, g.ny), (201, 201));
    let w = g.window(1.0, 1.0, 2.0, 2.0);
    assert_eq!((w.i0, w.i1), (10, 22));
    assert_eq!(g.centre(&w, 0, 0).0, 1.05);
}

#[test]
fn the_edge_blocks_but_the_middle_does_not() {
    let b = board(Vec::new(), Vec::new());
    let mut g = GridBoard::new(&b, &rules(), &layers(), 0.1).unwrap();
    let w = g.full_window();
    let (blocked, _) = g.blocked("A", 0, w, false, false);
    assert!(blocked.at(0, 0) && !blocked.at(100, 100));
}

#[test]
fn another_net_blocks_and_its_own_does_not() {
    let b = board(Vec::new(), vec![track("B", at(5.0, 10.0), at(15.0, 10.0), "F.Cu")]);
    let mut g = GridBoard::new(&b, &rules(), &layers(), 0.1).unwrap();
    let w = g.full_window();
    assert!(g.blocked("A", 0, w, false, false).0.at(100, 100));
    assert!(!g.blocked("A", 1, w, false, false).0.at(100, 100));
    assert!(!g.blocked("B", 0, w, false, false).0.at(100, 100));
}

#[test]
fn a_rule_area_stops_tracks_or_vias_as_it_says() {
    let mut b = board(Vec::new(), Vec::new());
    let zone = |tracks, vias| Zone { id: String::new(), name: "K".to_string(), net: String::new(), layers: layers(), outline: vec![square(8.0, 8.0, 12.0, 12.0)], filled: Vec::new(), rule_area: Some(RuleArea { tracks, vias, pour: false, pads: false, footprints: false }), fill: None };
    b.zones.push(zone(false, true));
    let mut g = GridBoard::new(&b, &rules(), &layers(), 0.1).unwrap();
    let w = g.full_window();
    assert!(!g.blocked("A", 0, w, false, false).0.at(100, 100));
    assert!(g.blocked("A", 0, w, true, false).0.at(100, 100));
}

#[test]
fn a_wall_of_copper_is_passed_only_through_a_via() {
    let a = footprint("U1", vec![pad("1", "A", 5.0, 10.0, 1.0)]);
    let c = footprint("U2", vec![pad("1", "A", 15.0, 10.0, 1.0)]);
    let wall = track("B", at(10.0, 0.0), at(10.0, 20.0), "F.Cu");
    let b = board(vec![a, c], vec![wall]);
    let mut g = GridBoard::new(&b, &rules(), &layers(), 0.1).unwrap();
    let w = g.full_window();
    let grids = g.net_grids("A", w, false);
    let (first, second) = (g.pads_of("A")[0].item, g.pads_of("A")[1].item);
    let (from, to) = (g.item_seed(first, w), g.item_seed(second, w));
    assert!(flood(&grids, &from, Some(&to)).0);
    let mut one = GridBoard::new(&b, &rules(), &layers()[..1], 0.1).unwrap();
    let w = one.full_window();
    let grids = one.net_grids("A", w, false);
    let (from, to) = (one.item_seed(first, w), one.item_seed(second, w));
    assert!(!flood(&grids, &from, Some(&to)).0);
}

#[test]
fn routing_adds_a_cell_to_every_clearance() {
    let b = board(vec![footprint("U1", vec![pad("1", "A", 5.0, 5.0, 1.0)])], vec![via("B", at(10.0, 10.0))]);
    let mut g = GridBoard::new(&b, &rules(), &layers(), 0.05).unwrap();
    let (before, edge) = (g.items[0].clearance, g.edge_clearance);
    g.for_routing();
    assert_eq!((g.items[0].clearance, g.edge_clearance), (before + 0.05, edge + 0.05));
}
