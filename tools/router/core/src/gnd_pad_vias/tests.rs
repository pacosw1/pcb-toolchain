//! The skip policy and the placement rules, on boards built in memory. tools/test_gnd_pad_vias.py and test-gnd-pad-vias.py moved here.
use super::proof::{DirectCopper, Links, NearbyViaProof};
use super::*;
use crate::kicad::board::{Footprint, RoutedCopper, Track, Via};
use crate::kicad::geom::{Polygon, Rect};
use crate::kicad::pad::{Copper, PadForm, PadKind, PadShape};
use crate::kicad::rules::{ClassValues, Minimums};
use std::cell::Cell;
use std::collections::BTreeMap;

fn mm(v: f64) -> Iu {
    from_mm(v)
}

fn at(x: f64, y: f64) -> Pt {
    Pt::new(mm(x), mm(y))
}

fn pad(number: &str, net: &str, x: f64, y: f64, w: f64, h: f64) -> Pad {
    let (position, size) = (at(x, y), at(w, h));
    let copper = PadForm { shape: PadShape::Rect, center: position, orientation: 0.0, size, corner_ratio: 0.0 }.copper();
    let bbox = copper.iter().map(Copper::bbox).reduce(Rect::merged).unwrap();
    Pad {
        id: format!("{net}-{number}-{x}"),
        number: number.to_string(),
        kind: PadKind::Smd,
        shape: PadShape::Rect,
        net: net.to_string(),
        position,
        orientation: 0.0,
        size,
        drill: Pt::default(),
        layers: vec!["F.Cu".to_string()],
        bbox,
        zone_connection: None,
        thermal_spoke_angle: 0.0,
        spoke_templates: 0,
        copper,
        polygons: BTreeMap::new(),
        solder_mask_expansion: 0,
        clearance_override: None,
    }
}

fn pth(number: &str, net: &str, x: f64, y: f64, size: f64, drill: f64) -> Pad {
    let layers = vec!["F.Cu".to_string(), "B.Cu".to_string()];
    Pad { kind: PadKind::ThroughHole, drill: at(drill, drill), layers, ..pad(number, net, x, y, size, size) }
}

fn footprint(reference: &str, pads: Vec<Pad>) -> Footprint {
    Footprint { reference: reference.to_string(), pads, ..Footprint::default() }
}

fn via(net: &str, x: f64, y: f64) -> RoutedCopper {
    RoutedCopper::Via(Via { id: format!("via-{x}-{y}"), at: at(x, y), size: mm(0.6), drill: mm(0.3), net: net.to_string(), locked: false, layers: Vec::new() })
}

fn track(net: &str, a: Pt, b: Pt) -> RoutedCopper {
    RoutedCopper::Track(Track { id: format!("t-{}-{}", a.x, b.x), start: a, end: b, mid: None, width: mm(0.4), layer: "F.Cu".to_string(), net: net.to_string(), locked: false })
}

/// A 20 x 20 mm board, as the fixtures of the Python tests.
fn board(footprints: Vec<Footprint>, copper: Vec<RoutedCopper>) -> Board {
    let square = vec![at(0.0, 0.0), at(20.0, 0.0), at(20.0, 20.0), at(0.0, 20.0)];
    let nets = footprints.iter().flat_map(|f| &f.pads).map(|p| (p.net.clone(), "Default".to_string())).collect();
    Board { path: String::new(), copper_layers: vec!["F.Cu".to_string(), "B.Cu".to_string()], stackup: Vec::new(), nets, footprints, copper, zones: Vec::new(), graphics: Vec::new(), texts: Vec::new(), groups: Vec::new(), constraints: Default::default(), edges_bbox: Rect { left: 0, top: 0, right: mm(20.0), bottom: mm(20.0) }, outlines: vec![Polygon::of_ring(square)] }
}

fn rules() -> DesignRules {
    let class = ClassValues { clearance: Some(mm(0.2)), via_diameter: Some(mm(0.6)) };
    DesignRules { minimums: Minimums { clearance: mm(0.1), hole_to_hole: mm(0.25), ..Minimums::default() }, classes: [("".to_string(), class)].into_iter().collect(), clearance_rules: Vec::new() }
}

/// A fill that joins exactly the pads named, to the vias given: stands in for KiCad.
struct Fill {
    joined: BTreeMap<String, Vec<Pt>>,
    calls: Cell<usize>,
}

impl Fill {
    fn new() -> Fill {
        Fill { joined: BTreeMap::new(), calls: Cell::new(0) }
    }
}

struct Joined(BTreeMap<String, Vec<Pt>>);

impl Links for Joined {
    fn vias_of(&mut self, pad: &Pad) -> Result<Vec<Pt>, String> {
        Ok(self.0.get(&pad.id).cloned().unwrap_or_default())
    }
}

impl Native for Fill {
    type Links = Joined;
    fn links(&mut self, _: &Edit) -> Result<Joined, String> {
        self.calls.set(self.calls.get() + 1);
        Ok(Joined(self.joined.clone()))
    }
}

fn proof_pad() -> Pad {
    pad("1", "GND", 0.0, 0.0, 0.8, 0.9)
}

const NEAR: Pt = Pt { x: 600_000, y: 700_000 };

#[test]
fn a_disconnected_nearby_via_does_not_skip() {
    let mut p: NearbyViaProof<Joined> = NearbyViaProof::new();
    let mut fills = 0;
    let answer = p.connected(&proof_pad(), &[NEAR], 1e6, || {
        fills += 1;
        Ok(Joined(BTreeMap::new()))
    });
    assert_eq!((answer, fills), (Ok(false), 1));
}

#[test]
fn a_connected_nearby_via_skips() {
    let joined = [(proof_pad().id, vec![NEAR])].into_iter().collect();
    let mut p = NearbyViaProof::new();
    assert_eq!(p.connected(&proof_pad(), &[NEAR], 1e6, || Ok(Joined(joined))), Ok(true));
}

#[test]
fn a_far_via_does_not_refresh() {
    let mut p: NearbyViaProof<Joined> = NearbyViaProof::new();
    assert_eq!(p.connected(&proof_pad(), &[NEAR], 5e5, || Err("no fill wanted".to_string())), Ok(false));
}

#[test]
fn a_via_joined_but_beyond_the_radius_does_not_skip() {
    let joined = [(proof_pad().id, vec![Pt::new(0, 2_000_000)])].into_iter().collect();
    let mut p = NearbyViaProof::new();
    assert_eq!(p.connected(&proof_pad(), &[NEAR], 1e6, || Ok(Joined(joined))), Ok(false));
}

#[test]
fn the_radius_boundary_is_inclusive() {
    let edge = Pt::new(600_000, 800_000);
    let joined = [(proof_pad().id, vec![edge])].into_iter().collect();
    let mut p = NearbyViaProof::new();
    assert_eq!(p.connected(&proof_pad(), &[edge], 1e6, || Ok(Joined(joined))), Ok(true));
}

#[test]
fn a_change_needs_a_fresh_proof() {
    let joined: BTreeMap<String, Vec<Pt>> = [(proof_pad().id, vec![NEAR])].into_iter().collect();
    let mut p = NearbyViaProof::new();
    let fills = Cell::new(0);
    let fill = |j: BTreeMap<String, Vec<Pt>>| {
        fills.set(fills.get() + 1);
        Ok(Joined(j))
    };
    assert_eq!(p.connected(&proof_pad(), &[NEAR], 1e6, || fill(joined.clone())), Ok(true));
    assert_eq!(p.connected(&proof_pad(), &[NEAR], 1e6, || fill(joined.clone())), Ok(true));
    assert_eq!(fills.get(), 1);
    p.invalidate();
    assert_eq!(p.connected(&proof_pad(), &[NEAR], 1e6, || fill(BTreeMap::new())), Ok(false));
    assert_eq!(fills.get(), 2);
}

#[test]
fn a_failed_refresh_is_visible() {
    let mut p: NearbyViaProof<Joined> = NearbyViaProof::new();
    assert_eq!(p.connected(&proof_pad(), &[NEAR], 1e6, || Err("unproved fill".to_string())), Err("unproved fill".to_string()));
}

fn one_pad_board(copper: Vec<RoutedCopper>) -> Board {
    board(vec![footprint("C1", vec![pad("2", "GND", 10.0, 10.0, 0.8, 0.9)])], copper)
}

#[test]
fn a_disconnected_nearby_via_gets_a_repair() {
    let b = one_pad_board(vec![via("GND", 10.62, 10.76)]);
    let p = plan(&b, &rules(), &Options::default(), &mut Fill::new()).unwrap();
    assert_eq!((p.added, p.edit.vias.len(), p.edit.tracks.len()), (1, 1, 1));
}

#[test]
fn a_track_to_the_nearby_via_needs_no_repair() {
    let b = one_pad_board(vec![via("GND", 10.62, 10.76), track("GND", at(10.0, 10.0), at(10.62, 10.76))]);
    let mut fill = Fill::new();
    fill.joined.insert(b.footprints[0].pads[0].id.clone(), vec![at(10.62, 10.76)]);
    let p = plan(&b, &rules(), &Options::default(), &mut fill).unwrap();
    assert_eq!(p.added, 0);
    assert!(p.edit.is_empty());
}

#[test]
fn a_plane_joined_pad_is_skipped_and_a_later_repair_costs_one_more_fill_only() {
    let early = footprint("C1", vec![pad("2", "GND", 5.0, 5.0, 0.8, 0.9)]);
    let later = footprint("C2", vec![pad("2", "GND", 15.0, 15.0, 0.8, 0.9)]);
    let b = board(vec![early, later], vec![via("GND", 5.62, 5.76), via("GND", 15.62, 15.76)]);
    let mut fill = Fill::new();
    fill.joined.insert(b.footprints[1].pads[0].id.clone(), vec![at(15.62, 15.76)]);
    let p = plan(&b, &rules(), &Options::default(), &mut fill).unwrap();
    assert_eq!((p.added, p.unresolved.len(), fill.calls.get()), (1, 1, 2), "{p:?}");
    // C1's repair stands; the stand-in fill does not know the new via, so it shows up as unresolved.
    assert_eq!(p.unresolved, ["C1.2"]);
}

#[test]
fn a_lost_plane_connection_is_unresolved_and_listed_as_failed() {
    struct Lost(usize);
    impl Native for Lost {
        type Links = Joined;
        fn links(&mut self, _: &Edit) -> Result<Joined, String> {
            self.0 += 1;
            let later = pad("2", "GND", 15.0, 15.0, 0.8, 0.9);
            Ok(Joined(if self.0 == 1 { [(later.id, vec![at(15.62, 15.76)])].into_iter().collect() } else { BTreeMap::new() }))
        }
    }
    let early = footprint("C1", vec![pad("2", "GND", 5.0, 5.0, 0.8, 0.9)]);
    let later = footprint("C2", vec![pad("2", "GND", 15.0, 15.0, 0.8, 0.9)]);
    let b = board(vec![early, later], vec![via("GND", 15.62, 15.76)]);
    let mut native = Lost(0);
    let p = plan(&b, &rules(), &Options::default(), &mut native).unwrap();
    assert_eq!(native.0, 2);
    assert!(p.failed.contains(&"C2.2".to_string()) && p.unresolved.contains(&"C2.2".to_string()), "{p:?}");
    assert!(summary(&p, "GND")[1].contains("C2.2"));
}

#[test]
fn a_first_repair_joins_a_shared_track_without_a_duplicate_via() {
    let first = pad("2", "GND", 10.0, 10.0, 0.8, 0.9);
    let second = pad("2", "GND", 11.8, 10.0, 0.8, 0.9);
    let shared = track("GND", first.position, second.position);
    let b = board(vec![footprint("C1", vec![first]), footprint("C2", vec![second])], vec![shared]);
    let p = plan(&b, &rules(), &Options::default(), &mut Fill::new()).unwrap();
    assert_eq!(p.added, 1, "{p:?}");
}

#[test]
fn direct_copper_follows_tracks_and_stops_at_a_gap() {
    let (a, b, c) = (pad("1", "GND", 5.0, 5.0, 0.8, 0.9), pad("2", "GND", 7.0, 5.0, 0.8, 0.9), pad("3", "GND", 12.0, 5.0, 0.8, 0.9));
    let (ida, idc) = (a.clone(), c.clone());
    let joined = board(vec![footprint("U1", vec![a, b, c])], vec![track("GND", at(5.0, 5.0), at(7.0, 5.0)), via("GND", 7.0, 5.0)]);
    let mut graph = DirectCopper::of(&joined, "GND", &Edit::default());
    assert_eq!(graph.vias_of(&ida), Ok(vec![at(7.0, 5.0)]));
    assert_eq!(graph.vias_of(&idc), Ok(Vec::new()));
}

#[test]
fn direct_copper_sees_what_this_run_added() {
    let b = one_pad_board(vec![via("GND", 10.62, 10.76)]);
    let edit = Edit { tracks: vec![NewTrack { start: at(10.0, 10.0), end: at(10.62, 10.76), width: mm(0.4), layer: "F.Cu".to_string(), net: "GND".to_string(), locked: false }], ..Edit::default() };
    assert_eq!(DirectCopper::of(&b, "GND", &edit).vias_of(&b.footprints[0].pads[0]), Ok(vec![at(10.62, 10.76)]));
}

fn distance(a: Pt, b: Pt) -> f64 {
    ((a.x - b.x) as f64).hypot((a.y - b.y) as f64)
}

/// The U19 TPS2121 pads of BASE-PWR-B (D-126, 2026-10-11 triage F5): GND pads 4 and 5 got vias 0.583 mm apart with the old tool,
/// and a PTH pad of another net is within 0.45 mm of pad 12's first candidates.
#[test]
fn u19_vias_keep_class_clearance_and_the_pth_hole_gap() {
    let rows = [("1", "PRIMARY_5V_RAW", 150.415, 101.525, 1.05, 0.4), ("2", "PRIMARY_5V_POE", 150.415, 100.825, 1.05, 0.4), ("3", "MUX_CP2", 150.495, 100.025, 0.2, 0.6), ("4", "GND", 149.995, 100.025, 0.2, 0.6),
                ("5", "GND", 149.495, 100.025, 0.2, 0.6), ("6", "MUX_PR1", 148.995, 100.025, 0.2, 0.6), ("7", "5V_24V", 149.065, 100.825, 1.05, 0.4), ("8", "PRIMARY_5V_RAW", 149.065, 101.525, 1.05, 0.4),
                ("9", "MUX_ST", 148.995, 102.325, 0.2, 0.6), ("10", "MUX_ILM", 149.495, 102.325, 0.2, 0.6), ("11", "MUX_SS", 149.995, 102.325, 0.2, 0.6), ("12", "GND", 150.495, 102.325, 0.2, 0.6)];
    let mut pads: Vec<Pad> = rows.iter().map(|(n, net, x, y, w, h)| pad(n, net, x - 140.0, y - 90.0, *w, *h)).collect();
    let hole = pth("13", "SIG", 150.495 - 140.0 + 1.1, 102.325 - 90.0 - 0.9, 0.8, 0.5);
    let hole_at = hole.position;
    pads.push(hole);
    let b = board(vec![footprint("U19", pads)], Vec::new());
    let p = plan(&b, &rules(), &Options::default(), &mut Fill::new()).unwrap();
    assert_eq!(p.edit.vias.len(), 3, "{p:?}");
    for (i, v) in p.edit.vias.iter().enumerate() {
        for w in &p.edit.vias[i + 1..] {
            assert!(distance(v.at, w.at) - mm(0.6) as f64 >= mm(0.2) as f64 - 1.0, "{v:?} {w:?}");
        }
        assert!(distance(v.at, hole_at) - (mm(0.3) / 2 + mm(0.5) / 2) as f64 >= mm(0.45) as f64 - 1.0, "{v:?}");
    }
}

#[test]
fn a_blocked_pad_is_listed_and_in_pad_is_the_last_choice() {
    let walled = |n: &str, x: f64, y: f64| pad(n, "SIG", x, y, 1.0, 1.0);
    let mut pads = vec![pad("1", "GND", 10.0, 10.0, 1.0, 1.0)];
    for (i, (x, y)) in [(8.5, 8.5), (10.0, 8.5), (11.5, 8.5), (8.5, 10.0), (11.5, 10.0), (8.5, 11.5), (10.0, 11.5), (11.5, 11.5)].iter().enumerate() {
        pads.push(walled(&format!("w{i}"), *x, *y));
        pads.push(walled(&format!("v{i}"), 10.0 + (x - 10.0) * 2.0, 10.0 + (y - 10.0) * 2.0));
        pads.push(walled(&format!("u{i}"), 10.0 + (x - 10.0) * 3.0, 10.0 + (y - 10.0) * 3.0));
    }
    let b = board(vec![footprint("U1", pads)], Vec::new());
    let p = plan(&b, &rules(), &Options::default(), &mut Fill::new()).unwrap();
    assert_eq!(p.failed, ["U1.1"]);
    let p = plan(&b, &rules(), &Options { in_pad: true, ..Options::default() }, &mut Fill::new()).unwrap();
    assert_eq!((p.in_pad.len(), p.edit.vias[0].at, p.edit.tracks.len()), (1, at(10.0, 10.0), 0));
}

#[test]
fn only_repairs_a_pad_with_a_near_via_and_links_when_no_place_is_free() {
    let b = one_pad_board(vec![via("GND", 10.62, 10.76)]);
    let o = Options { only: ["C1.2".to_string()].into_iter().collect(), ..Options::default() };
    let mut fill = Fill::new();
    let p = plan(&b, &rules(), &o, &mut fill).unwrap();
    assert_eq!(p.added, 1);
    assert_eq!(fill.calls.get(), 1);
}

#[test]
fn skip_takes_refs_and_pads() {
    let b = one_pad_board(Vec::new());
    for name in ["C1", "C1.2"] {
        let o = Options { skip: [name.to_string()].into_iter().collect(), ..Options::default() };
        assert_eq!(plan(&b, &rules(), &o, &mut Fill::new()).unwrap().added, 0);
    }
}

#[test]
fn an_unknown_net_stops() {
    assert!(plan(&one_pad_board(Vec::new()), &rules(), &Options { net: "NOPE".to_string(), ..Options::default() }, &mut Fill::new()).is_err());
}

#[test]
fn the_summary_lines_are_the_tools() {
    let plan = Plan { added: 2, links: vec!["U1.1".to_string()], failed: vec!["U2.3".to_string()], ..Plan::default() };
    assert_eq!(summary(&plan, "GND"), ["GND vias added: 2; pad links: 1 U1.1; in pad: 0 ; no free place: 1 U2.3".to_string(), "final connectivity unresolved: 0 ".to_string()]);
}
