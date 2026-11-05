//! Whole boards through the native geometry: the cases of tools/test_si_detour_native.py, test_si_projection_native.py,
//! test_si_junction_native.py and test_si_spatial_native.py. Python built them with pcbnew and its zone filler; here the fill is
//! drawn by hand with the shape the filler leaves (a 0.3 mm thermal relief with four diagonal spokes), and the expected values stay.
use super::super::detour::{Plane, detour_mm};
use super::super::native::{Reference, fill_edges, ground_portals, prove_native_stub};
use super::super::projection::{EdgeIndex, PathInputs, evaluate_paths};
use super::super::sample::{NetResult, P, RefAt, Run, sample_arc, sample_segment};
use super::super::screen::{Assessment, Edges, reference_assessment};
use super::super::spec::{Caps, Spec};
use super::super::{Check, Fill, Sources, analyse, filled_copper, read_copper, reference_at};
use super::{board_with, domain_of, edges_of, evaluate, known, one, square, terminal};
use crate::kicad::board::{Board, FilledLayer, Footprint, RoutedCopper, Track, Via, Zone};
use crate::kicad::geom::boolean::{difference, union};
use crate::kicad::geom::{FillIndex, Polygon, Pt, Rect, from_mm, to_mm};
use crate::kicad::pad::{Copper, Pad, PadKind, PadShape};
use crate::si::drivers::Edge;
use crate::si::drivers::netlist::Netlist;
use crate::si::drivers::table::Table;
use crate::si::fixture::{netlist, part, spec, table_of};
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};

const COPPER: [&str; 4] = ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"];

fn pt(p: P) -> Pt {
    Pt::new(from_mm(p.0), from_mm(p.1))
}

fn blank(nets: &[&str]) -> Board {
    let mut board = board_with(&COPPER, nets);
    board.edges_bbox = Rect::of_points([pt((0.0, 0.0)), pt((10.0, 10.0))]).unwrap();
    board.outlines = vec![square(0.0, 0.0, 10.0, 10.0)];
    board
}

fn pour(net: &str, layer: &str, polygons: Vec<Polygon>) -> Zone {
    Zone { id: String::new(), name: String::new(), net: net.to_string(), layers: vec![layer.to_string()], outline: polygons.clone(), filled: vec![FilledLayer { layer: layer.to_string(), polygons }], rule_area: None, fill: None }
}

fn wire(board: &mut Board, net: &str, layer: &str, path: &[P], width: f64) {
    let (start, end) = (pt(path[0]), pt(path[path.len() - 1]));
    let mid = (path.len() == 3).then(|| pt(path[1]));
    let id = format!("track-{}", board.copper.len());
    board.copper.push(RoutedCopper::Track(Track { id, start, end, mid, width: from_mm(width), layer: layer.to_string(), net: net.to_string(), locked: false }));
}

fn via(board: &mut Board, net: &str, at: P) {
    let id = format!("via-{}", board.copper.len());
    board.copper.push(RoutedCopper::Via(Via { id, at: pt(at), size: from_mm(0.8), drill: from_mm(0.4), net: net.to_string(), locked: false, layers: COPPER.iter().map(|l| l.to_string()).collect() }));
}

fn ring(center: P, radius: f64) -> Polygon {
    Polygon::of_ring((0..64).map(|i| {
        let t = i as f64 * std::f64::consts::TAU / 64.0;
        pt((center.0 + radius * t.cos(), center.1 + radius * t.sin()))
    }).collect())
}

fn pad(net: &str, kind: PadKind, at: P, size: f64, layers: &[&str], shape: Polygon, copper: Copper) -> Pad {
    Pad {
        id: format!("pad-{net}-{}", at.0), number: "1".to_string(), kind, shape: PadShape::Circle, net: net.to_string(), position: pt(at), orientation: 0.0,
        size: Pt::new(from_mm(size), from_mm(size)), drill: Pt::default(), layers: layers.iter().map(|l| l.to_string()).collect(), bbox: Rect::around(pt(at)),
        zone_connection: None, thermal_spoke_angle: 0.0, spoke_templates: 0, copper: vec![copper],
        polygons: layers.iter().map(|l| (l.to_string(), shape.clone())).collect::<BTreeMap<_, _>>(), solder_mask_expansion: 0, clearance_override: None,
    }
}

/// A 1 mm through-hole pad.
fn through_pad(net: &str, at: P) -> Pad {
    pad(net, PadKind::ThroughHole, at, 1.0, &COPPER, ring(at, 0.5), Copper::Circle { center: pt(at), radius: from_mm(0.5) })
}

fn mount(board: &mut Board, reference: &str, pads: Vec<Pad>) {
    board.footprints.push(Footprint { reference: reference.to_string(), pads, ..Default::default() });
}

/// `plate` less a thermal relief round each pad on it, with four diagonal spokes from the pad out into the copper.
fn with_thermals(plate: Vec<Polygon>, pads: &[P]) -> Vec<Polygon> {
    let reliefs: Vec<Polygon> = pads.iter().map(|p| ring(*p, 0.8)).collect();
    let spokes: Vec<Polygon> = pads.iter().flat_map(|c| [(1.0, 1.0), (1.0, -1.0), (-1.0, 1.0), (-1.0, -1.0)].map(|(sx, sy): (f64, f64)| {
        let (ux, uy) = (sx * std::f64::consts::FRAC_1_SQRT_2, sy * std::f64::consts::FRAC_1_SQRT_2);
        let (nx, ny) = (-uy * 0.15, ux * 0.15);
        let at = |r: f64, side: f64| pt((c.0 + ux * r + side * nx, c.1 + uy * r + side * ny));
        Polygon::of_ring(vec![at(0.45, 1.0), at(1.0, 1.0), at(1.0, -1.0), at(0.45, -1.0)])
    })).collect();
    union(&difference(&plate, &reliefs).unwrap(), &spokes).unwrap()
}

// Portals through real copper

const PADS: [P; 2] = [(3.0, 5.0), (7.0, 5.0)];

#[derive(Clone, Copy, PartialEq)]
enum Alternate {
    Solid,
    Hole,
    Split,
}

#[derive(Clone, Copy, PartialEq)]
enum Bridge {
    None,
    Ground,
    Wrong,
}

fn split_fills(layer: &str) -> Vec<Zone> {
    vec![pour("GND", layer, with_thermals(vec![square(1.0, 1.0, 4.8, 9.0)], &PADS[..1])), pour("GND", layer, with_thermals(vec![square(5.2, 1.0, 9.0, 9.0)], &PADS[1..]))]
}

fn portal_board(alternate: Alternate, bridge: Bridge) -> Board {
    let mut b = blank(&["GND", "ISO_0V"]);
    mount(&mut b, "J1", PADS.iter().map(|p| through_pad("GND", *p)).collect());
    match bridge {
        Bridge::None => {}
        Bridge::Ground => wire(&mut b, "GND", "In2.Cu", &[(3.0, 5.0), (7.0, 5.0)], 0.4),
        Bridge::Wrong => wire(&mut b, "ISO_0V", "In2.Cu", &[(4.6, 5.0), (5.4, 5.0)], 0.4), // away from the ground pad lands
    }
    b.zones.extend(split_fills("In2.Cu"));
    match alternate {
        Alternate::Split => b.zones.extend(split_fills("In1.Cu")),
        Alternate::Solid => b.zones.push(pour("GND", "In1.Cu", with_thermals(vec![square(1.0, 1.0, 9.0, 9.0)], &PADS))),
        Alternate::Hole => {
            let plate = difference(&[square(1.0, 1.0, 9.0, 9.0)], &[square(4.0, 4.0, 6.0, 6.0)]).unwrap();
            b.zones.push(pour("GND", "In1.Cu", with_thermals(plate, &PADS)));
        }
    }
    b
}

fn ground_spec() -> Spec {
    spec(&[("grounds", r#"["GND"]"#)])
}

fn portal_detour(alternate: Alternate, bridge: Bridge) -> Option<f64> {
    let (board, s, caps) = (portal_board(alternate, bridge), ground_spec(), Caps::new());
    let fills = filled_copper(&board);
    let (primary, alt) = (Reference::new(&board, &fills["In2.Cu"], "In2.Cu", "GND", &s, &caps), Reference::new(&board, &fills["In1.Cu"], "In1.Cu", "GND", &s, &caps));
    assert!(fills["In1.Cu"].iter().all(|f| PADS.iter().all(|p| !f.index.contains(pt(*p))))); // the bare fill has no copper at a pad centre
    assert!(PADS.iter().all(|p| primary.ok(p.0, p.1) && alt.ok(p.0, p.1)));
    if alternate == Alternate::Hole {
        assert!(!alt.ok(5.0, 5.0));
    }
    let portals = ground_portals(&board, "In2.Cu", "In1.Cu", "GND");
    assert_eq!(portals, PADS);
    let (ok, edge, alt_ok, alt_edge) = (|x: f64, y: f64| primary.ok(x, y), |a: P, b: P| primary.edge(a, b), |x: f64, y: f64| alt.ok(x, y), |a: P, b: P| alt.edge(a, b));
    detour_mm(Plane { ok: &ok, edge: &edge }, Some(Plane { ok: &alt_ok, edge: &alt_edge }), &[terminal(3.0, 5.0, 0.1), terminal(7.0, 5.0, 0.1)], 20.0, 0.1, &portals)
}

#[test]
fn thermal_lands_transfer_on_a_solid_alternate() {
    // The thermal spokes are diagonal, so the real return is longer than the 4 mm terminal separation even on the solid plane.
    let d = portal_detour(Alternate::Solid, Bridge::None).unwrap();
    assert!(4.0 < d && d < 5.0, "{d}");
}

#[test]
fn a_hole_makes_the_path_longer() {
    let d = portal_detour(Alternate::Hole, Bridge::None).unwrap();
    assert!(d > 4.5, "{d}");
}

#[test]
fn a_domain_break_cannot_transfer() {
    assert_eq!(portal_detour(Alternate::Split, Bridge::None), None);
}

#[test]
fn an_actual_ground_track_completes_the_return() {
    let d = portal_detour(Alternate::Split, Bridge::Ground).unwrap();
    assert!((d - 4.0).abs() <= 0.01, "{d}");
}

#[test]
fn a_wrong_domain_track_cannot_complete_the_return() {
    assert_eq!(portal_detour(Alternate::Split, Bridge::Wrong), None);
}

#[test]
fn a_portal_must_be_of_the_domain_and_a_pad_must_span_both_planes() {
    let mut b = blank(&["GND", "ISO_0V"]);
    via(&mut b, "GND", (1.0, 5.0));
    via(&mut b, "ISO_0V", (2.0, 5.0));
    let top_only = ring((4.0, 5.0), 0.5);
    mount(&mut b, "J1", vec![through_pad("ISO_0V", (3.0, 5.0)), pad("GND", PadKind::ThroughHole, (4.0, 5.0), 1.0, &["F.Cu", "In1.Cu"], top_only, Copper::Circle { center: pt((4.0, 5.0)), radius: from_mm(0.5) })]);
    assert_eq!(ground_portals(&b, "In2.Cu", "In1.Cu", "GND"), [(1.0, 5.0)]);
}

// Stub proofs on real copper

#[derive(Clone, Copy, PartialEq)]
enum Load {
    Leaf,
    Via,
    Pad,
}

fn stub_board(load: Load, reference: bool) -> Board {
    let mut b = blank(&["GND", "/A", "/B"]);
    wire(&mut b, "/A", "F.Cu", &[(2.0, 5.0), (3.0, 5.0)], 0.2);
    wire(&mut b, "/A", "F.Cu", &[(3.0, 5.0), (8.0, 5.0)], 0.2);
    match load {
        Load::Leaf => {}
        Load::Via => via(&mut b, "/A", (8.0, 5.0)),
        Load::Pad => {
            let at = pt((8.0, 5.0));
            let corners = vec![pt((7.6, 4.6)), pt((8.4, 4.6)), pt((8.4, 5.4)), pt((7.6, 5.4))];
            mount(&mut b, "U1", vec![pad("/A", PadKind::Smd, (8.0, 5.0), 0.8, &["F.Cu"], square(7.6, 4.6, 8.4, 5.4), Copper::Polygon(corners))]);
            assert_eq!(b.footprints[0].pads[0].position, at);
        }
    }
    if reference {
        mount(&mut b, "J1", vec![through_pad("GND", (2.0, 2.0))]);
        b.zones.push(pour("GND", "In1.Cu", vec![square(1.0, 1.0, 5.0, 9.0)]));
    }
    b
}

/// The sampled run of the leaf with no pad or via allowance: even if a caller misses a land, the proof must reject it.
fn leaf_result(board: &Board, s: &Spec) -> NetResult {
    let (fills, caps) = (filled_copper(board), Caps::new());
    let on_plane = fills.get("In1.Cu").map_or(&[][..], Vec::as_slice);
    let reference = Reference::new(board, on_plane, "In1.Cu", "GND", s, &caps);
    let samples = sample_segment((3.0, 5.0), (8.0, 5.0), 0.25);
    evaluate(&samples, |x, y| reference.ok(x, y).then_some("GND"), Some("GND"), &[], s, "/A", &caps)
}

/// The native callback of the gate, recording the budgets it is asked for.
fn assess_stub(board: &Board, s: &Spec, r: NetResult, edges: &Edges) -> (Assessment, Vec<f64>, bool) {
    let (fills, copper, caps) = (filled_copper(board), read_copper(board, s), Caps::new());
    let check = Check { board, spec: s, caps: &caps, fills: &fills, copper: &copper };
    let (results, domains) = (one("F.Cu", "/A", r), domain_of("/A", Some("GND")));
    let (mut cache, calls) = (HashMap::new(), RefCell::new(Vec::new()));
    let mut detour = |layer: &str, domain: &str, run: &Run, budget: f64| {
        calls.borrow_mut().push(budget);
        check.native_detour(&mut cache, layer, domain, run, budget)
    };
    let assessed = reference_assessment(&results, &domains, s, edges, &mut detour, 40.0).unwrap();
    let proved = results[0].1.runs[0].proven_stub.get();
    (assessed, calls.into_inner(), proved)
}

fn unknown_a() -> Edges {
    edges_of(&[("/A", Edge::Unknown("fixture unknown driver".to_string()))])
}

fn proof(board: &Board, s: &Spec) -> bool {
    let r = leaf_result(board, s);
    assert_eq!(r.runs.len(), 1);
    let (fills, caps) = (filled_copper(board), Caps::new());
    let reference = Reference::new(board, fills.get("In1.Cu").map_or(&[][..], Vec::as_slice), "In1.Cu", "GND", s, &caps);
    prove_native_stub(board, "F.Cu", "/A", &r.runs[0], &reference)
}

#[test]
fn an_unloaded_leaf_passes_with_an_unknown_driver() {
    let (board, s) = (stub_board(Load::Leaf, true), ground_spec());
    assert!(proof(&board, &s));
    let (assessed, _, proved) = assess_stub(&board, &s, leaf_result(&board, &s), &unknown_a());
    assert!(proved);
    assert_eq!(assessed.screen, [""; 0]);
    assert_eq!(assessed.evidence, [""; 0]);
}

#[test]
fn a_loaded_tip_is_no_stub() {
    for load in [Load::Pad, Load::Via] {
        let (board, s) = (stub_board(load, true), ground_spec());
        let r = leaf_result(&board, &s);
        assert_eq!(r.runs[0].terminals.len(), 1);
        assert!(!proof(&board, &s));
        let (assessed, _, proved) = assess_stub(&board, &s, r, &unknown_a());
        assert!(!proved);
        assert!(assessed.screen[0].contains("unknown-driver"), "{:?}", assessed.screen);
    }
}

#[test]
fn a_net_with_no_terminal_is_no_stub() {
    let (board, s) = (stub_board(Load::Leaf, false), ground_spec());
    let r = leaf_result(&board, &s);
    assert_eq!(r.runs[0].terminals.len(), 0);
    assert!(!proof(&board, &s));
    assert!(assess_stub(&board, &s, r, &unknown_a()).0.screen[0].contains("unknown-driver"));
}

#[test]
fn a_known_typical_leaf_past_the_perimeter_gets_the_producer_proof() {
    let (board, s) = (stub_board(Load::Leaf, true), ground_spec());
    let (assessed, calls, proved) = assess_stub(&board, &s, leaf_result(&board, &s), &edges_of(&[("/A", known(460.0, "fixture THVD1410 typ"))]));
    assert_eq!(assessed.screen, [""; 0]);
    assert_eq!(calls, [0.0]);
    assert!(proved);
    assert_eq!(assessed.evidence, [""; 0]);
}

#[test]
fn a_known_typical_loaded_pad_stays_timing_incomplete() {
    let (board, s) = (stub_board(Load::Pad, true), ground_spec());
    let (assessed, calls, proved) = assess_stub(&board, &s, leaf_result(&board, &s), &edges_of(&[("/A", known(460.0, "fixture THVD1410 typ"))]));
    assert_eq!(assessed.screen, [""; 0]);
    assert_eq!(calls, [0.0]);
    assert!(!proved);
    assert_eq!(assessed.evidence.len(), 1);
}

#[test]
fn a_zero_budget_never_enters_the_grid() {
    // Solid copper on the line: a search would return a positive detour.
    let (board, s, caps) = (stub_board(Load::Leaf, true), ground_spec(), Caps::new());
    let (fills, copper) = (filled_copper(&board), read_copper(&board, &s));
    let check = Check { board: &board, spec: &s, caps: &caps, fills: &fills, copper: &copper };
    for count in [0, 1, 2, 3] {
        let run = Run { terminals: (0..count).map(|i| terminal(2.0 + i as f64, 5.0, 0.1)).collect(), net: "/A".to_string(), ..Run::default() };
        assert_eq!(check.native_detour(&mut HashMap::new(), "F.Cu", "GND", &run, 0.0), None, "{count}");
        assert!(!run.proven_stub.get());
    }
}

// Whole gate on a saved-like board

fn gate_spec(grounds: &str) -> Spec {
    spec(&[("adjacent", r#"{"F.Cu": "In1.Cu"}"#), ("plane_layers", r#"["In1.Cu"]"#), ("grounds", grounds), ("domains", r#"{"GND": ["SIG"]}"#), ("via_allow_mm", "0.001")])
}

/// The counted failures, and the report-only proposal as FAIL lines.
fn gate(board: &Board, s: &Spec, nl: &Netlist, table: &Table) -> (Vec<String>, Vec<String>) {
    let outcome = analyse(board, s, &Sources { board_text: "", netlist: nl, table }, true).unwrap();
    (outcome.fails, outcome.info.iter().filter_map(|l| l.strip_prefix("WARN D-124d-proposed ").map(|rest| format!("FAIL {rest}"))).collect())
}

/// A netlist and table that give SIG one driver of this edge.
fn driven(edge_ns: f64) -> (Netlist, Table) {
    let text = format!(r#"{{"mpn": ["FIX"], "pins": [{{"match": "OUT", "role": "push_pull", "tr_ns": {edge_ns}, "tf_ns": {edge_ns}, "source": "synthetic fixture"}}]}}"#);
    (netlist(&[("U1", "FIX")], &[("SIG", &[("U1", "1", "OUT")])]), table_of(vec![part("fix", &text, &[])]))
}

const SEGMENT: [P; 2] = [(4.0, 5.0), (5.0, 5.0)];
const LOOP: [P; 3] = [(5.0, 5.0), (4.0, 6.0), (3.0, 5.0)];

fn projection_board(arc: bool, domain: bool, solid: bool) -> Board {
    let mut b = blank(&["GND", "ISO", "SIG"]);
    // A ground through-hole pad gives the plane real connectivity without a signal anchor near the gap.
    mount(&mut b, "J1", vec![through_pad("GND", (2.0, 2.0))]);
    let hole = if domain { square(3.7, 4.0, 4.3, 7.0) } else { square(4.11, 4.0, 4.12, 7.0) };
    let plate = if solid { vec![square(1.0, 1.0, 9.0, 9.0)] } else { difference(&[square(1.0, 1.0, 9.0, 9.0)], &[hole]).unwrap() };
    b.zones.push(pour("GND", "In1.Cu", plate));
    if domain {
        // A real isolated conductor under part of the path: the projection may not substitute the surrounding ground.
        b.zones.push(pour("ISO", "In1.Cu", vec![square(3.75, 4.1, 4.25, 6.9)]));
    }
    wire(&mut b, "SIG", "F.Cu", if arc { &LOOP } else { &SEGMENT }, 0.1);
    b
}

fn projection_case(arc: bool, domain: bool, fast: bool, solid: bool, finite: bool, expected: &str) {
    let board = projection_board(arc, domain, solid);
    let mut s = gate_spec(if domain { r#"["GND", "ISO"]"# } else { r#"["GND"]"# });
    if fast {
        s.fast_top = vec!["SIG".to_string()];
    }
    let fills = filled_copper(&board);
    let at = reference_at(&fills, "In1.Cu");
    if domain {
        assert_eq!(at(4.115, if arc { 5.5 } else { 5.0 }), Some("ISO"));
    } else if !solid {
        assert_eq!(at(4.115, if arc { 5.5 } else { 5.0 }), None);
        // The midpoints alone miss this narrow feature.
        let samples = if arc { sample_arc(LOOP[0], LOOP[1], LOOP[2], 0.25) } else { sample_segment(SEGMENT[0], SEGMENT[1], 0.25) };
        assert!(samples.iter().all(|q| at(q.x, q.y) == Some("GND")));
    }
    let (nl, table) = if finite { driven(0.1) } else { (Netlist::default(), table_of(Vec::new())) };
    let (fails, proposed) = gate(&board, &s, &nl, &table);
    if solid {
        assert_eq!((fails, proposed), (Vec::new(), Vec::new()));
    } else {
        assert!(fails.iter().chain(&proposed).any(|l| l.contains(expected)), "{expected}: {fails:?} {proposed:?}");
    }
}

#[test]
fn a_segment_over_a_narrow_void() {
    projection_case(false, false, true, false, false, "fast-crossing");
    projection_case(false, false, false, false, false, "unknown-driver");
    projection_case(false, false, false, false, true, "detour");
}

#[test]
fn an_arc_over_a_narrow_void() {
    projection_case(true, false, true, false, false, "fast-crossing");
    projection_case(true, false, false, false, false, "unknown-driver");
    projection_case(true, false, false, false, true, "detour");
}

#[test]
fn a_track_over_the_wrong_domain() {
    projection_case(false, true, false, false, false, "domain-cross");
    projection_case(true, true, false, false, false, "domain-cross");
}

#[test]
fn a_track_over_solid_copper_passes() {
    projection_case(false, false, false, true, false, "none");
    projection_case(true, false, false, true, false, "none");
}

fn junction_board(arc: bool, split: bool, disconnected: bool) -> Board {
    let mut b = blank(&["GND", "SIG"]);
    mount(&mut b, "J1", vec![through_pad("GND", (2.0, 6.0))]);
    let boundary = if arc { 4.9 } else { 4.1 };
    b.zones.push(pour("GND", "In1.Cu", vec![square(1.0, boundary, 9.0, 9.0)]));
    if arc {
        wire(&mut b, "SIG", "F.Cu", &[(5.0, 4.0), (4.0, 5.0), (3.0, 4.0)], 0.05);
        let start = if disconnected { 4.7 } else { 4.6 };
        for x in [3.2, 4.8] {
            wire(&mut b, "SIG", "F.Cu", &[(x, start), (x, 5.5)], 0.05);
        }
    } else {
        if split {
            for (a, e) in [(3.0, 3.43), (3.43, 4.57), (4.57, 5.0)] {
                wire(&mut b, "SIG", "F.Cu", &[(a, 4.0), (e, 4.0)], 0.05);
            }
        } else {
            wire(&mut b, "SIG", "F.Cu", &[(3.0, 4.0), (5.0, 4.0)], 0.05);
        }
        for x in [3.43, 4.57] {
            wire(&mut b, "SIG", "F.Cu", &[(x, 4.0), (x, 5.0)], 0.05);
        }
    }
    b
}

/// The projection of SIG, the way the gate makes it.
fn projected(board: &Board, s: &Spec) -> NetResult {
    let (fills, copper, caps) = (filled_copper(board), read_copper(board, s), Caps::new());
    let index = EdgeIndex::new(fill_edges(&fills["In1.Cu"]));
    let at = reference_at(&fills, "In1.Cu");
    let ref_at: &RefAt = &at;
    let (_, paths) = &copper.paths.rows[0];
    evaluate_paths(paths, &PathInputs { boundaries: Some(&index), ref_at, domain: Some("GND"), anchors: &[], spec: s, net: "SIG", caps: &caps })
}

fn junction(board: &Board) -> (Vec<String>, Vec<String>, NetResult) {
    let s = gate_spec(r#"["GND"]"#);
    let (nl, table) = driven(1.0); // a sufficient edge budget isolates the topology
    let (fails, proposed) = gate(board, &s, &nl, &table);
    (fails, proposed, projected(board, &s))
}

#[test]
fn unsplit_and_split_lines_are_the_same() {
    let (a, b) = (junction(&junction_board(false, false, false)), junction(&junction_board(false, true, false)));
    for (fails, proposed, r) in [&a, &b] {
        assert_eq!(fails, &[""; 0]);
        assert_eq!(proposed, &[""; 0]);
        assert_eq!(r.runs.len(), 1);
        assert_eq!(r.runs[0].terminals.len(), 2);
    }
    assert!((a.2.bad - b.2.bad).abs() < 5e-8);
}

#[test]
fn an_endpoint_on_an_arc_joins_it() {
    let (fails, proposed, r) = junction(&junction_board(true, false, false));
    assert_eq!(fails, [""; 0]);
    assert_eq!(proposed, [""; 0]);
    assert_eq!(r.runs.iter().map(|run| run.terminals.len()).collect::<Vec<_>>(), [2, 2]);
}

#[test]
fn a_near_arc_is_disconnected() {
    let (fails, proposed, r) = junction(&junction_board(true, false, true));
    assert!(fails.iter().chain(&proposed).any(|l| l.contains("detour")), "{fails:?} {proposed:?}");
    assert_eq!(r.runs.iter().map(|run| run.terminals.len()).collect::<Vec<_>>(), [1, 1, 1, 1]);
}

// The reference of a domain

fn unit_fill(x: f64) -> Vec<Polygon> {
    vec![square(x, 0.0, x + 1.0, 1.0)]
}

fn fills<'a>(rows: &'a [(&'a str, Vec<Polygon>)]) -> Vec<Fill<'a>> {
    rows.iter().map(|(net, polygons)| Fill { net, polygons, index: FillIndex::new(polygons) }).collect()
}

#[test]
fn the_first_containing_domain_decides_and_rounding_stays_on_the_edge() {
    let (board, caps) = (blank(&[]), Caps::new());
    let s = spec(&[("grounds", r#"["GND", "OTHER"]"#)]);
    let (wrong, right, distant) = (unit_fill(0.0), unit_fill(0.0), unit_fill(100.0));
    let rows = [("OTHER", wrong), ("GND", right.clone()), ("GND", distant)];
    let filled = fills(&rows);
    assert!(!Reference::new(&board, &filled, "In1.Cu", "GND", &s, &caps).ok(0.5, 0.5)); // the first containing domain stays decisive
    let rows = [("GND", right.clone())];
    let filled = fills(&rows);
    let fresh = Reference::new(&board, &filled, "In1.Cu", "GND", &s, &caps);
    assert!(fresh.ok(-0.0000004, 0.5)); // the rounded point is exactly on the edge
    // Native Contains is half open: x = 0 is in, x = 1 is out (the Python mock held both).
    assert!(fresh.edge((0.0, 0.5), (0.9, 0.5)));
    assert!(fresh.edge((0.9, 0.5), (0.0, 0.5)));
    let rows = [("OTHER", right)];
    let filled = fills(&rows);
    assert!(!Reference::new(&board, &filled, "In1.Cu", "GND", &s, &caps).ok(0.5, 0.5));
}

#[test]
fn a_cap_is_read_at_the_unrounded_point() {
    let board = blank(&[]);
    let s = spec(&[("grounds", r#"["GND"]"#), ("alt_refs", r#"{"VDD": {"domain": "GND", "cap_mm": 0.5, "reason": "fixture"}}"#)]);
    let caps = Caps::from([("VDD".to_string(), vec![(0.0, 0.5)])]);
    let rows = [("VDD", unit_fill(0.0))];
    let filled = fills(&rows);
    let capped = Reference::new(&board, &filled, "In1.Cu", "GND", &s, &caps);
    // These round to the same native point but have different capacitor applicability.
    assert!(capped.ok(0.4999999, 0.5));
    assert!(!capped.ok(0.5000001, 0.5));
    assert!(!capped.edge((0.4, 0.5), (0.6, 0.5)));
}

#[test]
fn holes_and_lands_read_as_a_full_scan() {
    let (board, s, caps) = (portal_board(Alternate::Hole, Bridge::None), ground_spec(), Caps::new());
    let fills = filled_copper(&board);
    let lands: Vec<&Polygon> = board.pads().map(|(_, p)| &p.polygons["In1.Cu"]).collect();
    let reference = Reference::new(&board, &fills["In1.Cu"], "In1.Cu", "GND", &s, &caps);
    let mut points: Vec<P> = (0..=100).flat_map(|i| (0..=100).map(move |j| (i as f64 * 0.1, j as f64 * 0.1))).collect();
    for polygon in fills["In1.Cu"].iter().flat_map(|f| f.polygons) {
        points.extend(polygon.outline.iter().take(30).flat_map(|v| [-0.0000004, 0.0, 0.0000004].map(|d| (to_mm(v.x) + d, to_mm(v.y)))));
    }
    for (x, y) in points {
        let at = pt((x, y));
        let scan = lands.iter().any(|l| l.contains(at)) || fills["In1.Cu"].iter().flat_map(|f| f.polygons).any(|p| p.contains(at));
        assert_eq!(reference.ok(x, y), scan, "({x}, {y})");
    }
    assert!(!reference.ok(5.0, 5.0));
    assert!(reference.ok(3.0, 5.0)); // the thermal barrel land is real copper
}
