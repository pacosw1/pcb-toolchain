//! The check on tiny boards built in memory. Default class: track 0.2 mm + clearance 0.2 mm -> grid pitch 0.4 mm; via 0.6 mm.
use super::check::Options;
use super::cli::{Line, check, read_line};
use super::raster::Rect;
use super::report::{Region, Verdict};
use super::rules::Rules;
use super::items::Kind;
use crate::grid::tests::{at, footprint, square};
use crate::kicad::board::{Board, RoutedCopper, Track, Zone, RuleArea};
use crate::kicad::geom::{Polygon, Pt, Rect as BoardRect, from_mm};
use crate::kicad::pad::{Copper, Pad, PadForm, PadKind, PadShape};
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::time::Instant;

const PROJECT: &str = r#"{"net_settings": {"classes": [{"name": "Default", "track_width": 0.2, "clearance": 0.2, "via_diameter": 0.6}]},
    "board": {"design_settings": {"rules": {"min_copper_edge_clearance": 0.3, "min_hole_clearance": 0.25, "min_track_width": 0.15}}}}"#;

/// The 0.6 x 1.2 mm SMD pad of a row.
fn row_pad(number: usize, net: &str, x: f64) -> Pad {
    let (position, size) = (at(x, 0.0), at(0.6, 1.2));
    let copper = PadForm { shape: PadShape::Rect, center: position, orientation: 0.0, size, corner_ratio: 0.0 }.copper();
    let bbox = copper.iter().map(Copper::bbox).reduce(BoardRect::merged).unwrap();
    let polygons = [("F.Cu".to_string(), square(x - 0.3, -0.6, x + 0.3, 0.6))].into_iter().collect();
    Pad { id: format!("{net}-{number}-{x}"), number: number.to_string(), kind: PadKind::Smd, shape: PadShape::Rect, net: net.to_string(), position, orientation: 0.0, size, drill: Pt::default(), layers: vec!["F.Cu".to_string()], bbox, zone_connection: None, thermal_spoke_angle: 0.0, spoke_templates: 0, copper, polygons, solder_mask_expansion: 0, clearance_override: None }
}

/// A board 36 x 20 mm, as the Python tests built in pcbnew.
fn board() -> Board {
    Board {
        path: "t.kicad_pcb".to_string(),
        copper_layers: vec!["F.Cu".to_string(), "B.Cu".to_string()],
        stackup: Vec::new(),
        nets: Default::default(),
        footprints: Vec::new(),
        copper: Vec::new(),
        zones: Vec::new(),
        graphics: Vec::new(),
        texts: Vec::new(),
        groups: Vec::new(),
        constraints: Default::default(),
        edges_bbox: BoardRect { left: from_mm(-6.0), top: from_mm(-10.0), right: from_mm(30.0), bottom: from_mm(10.0) },
        outlines: vec![square(-6.0, -10.0, 30.0, 10.0)],
    }
}

fn row(b: &mut Board, reference: &str, x0: f64, nets: &[&str]) {
    let pads = nets.iter().enumerate().map(|(i, net)| row_pad(i + 1, net, x0 + i as f64)).collect();
    b.footprints.push(footprint(reference, pads));
}

fn wall(b: &mut Board, points: &[(f64, f64)]) {
    for (k, w) in points.windows(2).enumerate() {
        b.copper.push(RoutedCopper::Track(Track { id: format!("wall-{}-{k}", b.copper.len()), start: at(w[0].0, w[0].1), end: at(w[1].0, w[1].1), mid: None, width: from_mm(0.2), layer: "F.Cu".to_string(), net: "WALL".to_string(), locked: false }));
    }
}

fn line(layers: &str, region: Option<Rect>, extra: &[&str]) -> Line {
    let mut words = vec!["t.kicad_pcb".to_string(), "--layers".to_string(), layers.to_string()];
    if let Some(r) = region {
        words.push(format!("--region={},{},{},{}", r[0], r[1], r[2], r[3]));
    }
    words.extend(extra.iter().map(|w| w.to_string()));
    read_line(words).unwrap()
}

/// The exit code, the first region and the printed lines.
fn run(b: &Board, line: &Line) -> (i32, Region, String) {
    let mut printed = Vec::new();
    let passed = check(b, Rules::of(b, PROJECT, None).unwrap(), line, Instant::now(), &mut |text| printed.push(text)).unwrap();
    let region = regions(b, line).remove(0);
    (i32::from(!passed), region, printed.join("\n"))
}

fn regions(b: &Board, line: &Line) -> Vec<Region> {
    let rules = Rules::of(b, PROJECT, None).unwrap();
    let mut checker = super::check::Checker::new(b, rules, line.options.clone());
    match line.region {
        Some(rect) => vec![checker.run("rect", rect, None)],
        None => checker.footprint_regions(line.escape_mm, Some(&line.parts)).into_iter().map(|(name, rect)| checker.run(&name, rect, Some(&name))).collect(),
    }
}

const N4: [&str; 4] = ["N1", "N2", "N3", "N4"];

#[test]
fn open_row_pass() {
    let mut b = board();
    row(&mut b, "U1", 0.0, &N4);
    row(&mut b, "U2", 20.0, &N4);
    let (rc, r, out) = run(&b, &line("F.Cu", Some([-2.0, -2.0, 5.0, 3.0]), &[]));
    assert_eq!((rc, r.verdict, r.demand, r.flow), (0, Verdict::Pass, 4, 4), "{out}");
    assert_eq!(r.pitch_mm, Some(0.4));
    assert!(out.contains("PIN_ESCAPE PASS"), "{out}");
}

#[test]
fn walled_row_one_gap_two_nets_fail() {
    let mut b = board();
    row(&mut b, "U1", 0.0, &N4[..2]);
    row(&mut b, "U2", 20.0, &N4[..2]);
    // U wall round the 2-pad row, top side closed except one gap that fits exactly one track
    wall(&mut b, &[(0.15, -1.4), (-1.2, -1.4), (-1.2, 1.4), (2.2, 1.4), (2.2, -1.4), (1.05, -1.4)]);
    let (rc, r, out) = run(&b, &line("F.Cu", Some([-2.0, -2.0, 5.0, 3.0]), &[]));
    assert_eq!((rc, r.verdict, r.demand, r.flow), (1, Verdict::Fail, 2, 1), "{out}");
    assert_eq!(r.unescaped.len(), 1);
    assert!(["N1", "N2"].contains(&r.unescaped[0].as_str()));
    let mut contested = r.contested.clone();
    contested.sort();
    assert_eq!(contested, ["N1", "N2"]);
    assert!(r.cut.expect("a cut").near.contains(&"track WALL".to_string()));
}

#[test]
fn closed_wall_second_layer_opens_path() {
    let mut b = board();
    row(&mut b, "U1", 0.0, &N4[..2]);
    row(&mut b, "U2", 20.0, &N4[..2]);
    wall(&mut b, &[(-2.4, -2.4), (3.4, -2.4), (3.4, 2.4), (-2.4, 2.4), (-2.4, -2.4)]);
    let rect = Some([-4.0, -4.0, 7.0, 5.0]);
    let (rc, r, out) = run(&b, &line("F.Cu,B.Cu", rect, &[]));
    assert_eq!((rc, r.verdict, r.flow), (0, Verdict::Pass, 2), "{out}");
    let (rc, r, out) = run(&b, &line("F.Cu", rect, &[]));
    assert_eq!((rc, r.verdict, r.flow), (1, Verdict::Fail, 0), "{out}");
    let mut unescaped = r.unescaped.clone();
    unescaped.sort();
    assert_eq!(unescaped, ["N1", "N2"]);
}

/// One net walled in on F.Cu; the gap (wall end centres 0.39 mm either side of a cell column) clears a 0.15 mm neck (0.39 - 0.1 >=
/// 0.2 + 0.075) but not a 0.2 mm track (< 0.2 + 0.1).
fn walled(top: f64) -> Board {
    let mut b = board();
    row(&mut b, "U1", 0.0, &["N1"]);
    row(&mut b, "U2", 20.0, &["N1"]);
    wall(&mut b, &[(0.2 - 0.39, top), (-1.2, top), (-1.2, 1.4), (1.2, 1.4), (1.2, top), (0.2 + 0.39, top)]);
    b
}

#[test]
fn neck_near_pad_only() {
    let near = walled(-1.4); // gap 0.8 mm from the pad: inside the pad long dimension (1.2 mm)
    let rect = Some([-2.0, -2.0, 4.0, 3.0]);
    let (rc, r, out) = run(&near, &line("F.Cu", rect, &[]));
    assert_eq!((rc, r.verdict, r.neck_mm), (0, Verdict::Pass, Some(0.15)), "{out}");
    let (rc, r, out) = run(&near, &line("F.Cu", rect, &["--neck-mm", "0"]));
    assert_eq!((rc, r.verdict), (1, Verdict::Fail), "{out}");
    let far = walled(-2.2); // gap 1.6 mm from the pad: class width applies
    let (rc, r, out) = run(&far, &line("F.Cu", Some([-2.0, -2.8, 4.0, 3.0]), &[]));
    assert_eq!((rc, r.verdict), (1, Verdict::Fail), "{out}");
}

#[test]
fn parts_mode_uses_part_pads_only() {
    let mut b = board();
    row(&mut b, "U1", 0.0, &N4);
    row(&mut b, "U2", 20.0, &N4);
    let l = line("F.Cu", None, &["--parts", "U1"]);
    let (rc, r, out) = run(&b, &l);
    assert_eq!((rc, regions(&b, &l).iter().map(|r| r.region.clone()).collect::<Vec<_>>(), r.demand), (0, vec!["U1".to_string()], 4), "{out}");
}

#[test]
fn a_missing_part_is_named_and_the_summary_passes() {
    let mut b = board();
    row(&mut b, "U1", 0.0, &N4);
    row(&mut b, "U2", 20.0, &N4);
    let (_, _, out) = run(&b, &line("F.Cu", None, &["--parts", "U1,U9"]));
    assert!(out.starts_with("PIN_ESCAPE parts: checked ['U1'] missing ['U9']\n"), "{out}");
    assert!(out.contains("PIN_ESCAPE_SUMMARY PASS regions 1 fail 0 unescaped [] layers ['F.Cu'] pitch [(0.4, 'Default')] wall "), "{out}");
}

#[test]
fn a_part_region_is_its_courtyard_grown_by_the_line_width_and_the_escape() {
    use crate::kicad::shape::{Geometry, Graphic};
    let mut b = board();
    row(&mut b, "U1", 0.0, &N4);
    b.footprints[0].courtyard_front = vec![square(-1.0, -2.0, 4.0, 2.0)];
    b.footprints[0].graphics.push(Graphic { id: String::new(), geometry: Geometry::Rect { top_left: at(-1.0, -2.0), bottom_right: at(4.0, 2.0) }, layer: "F.CrtYd".to_string(), width: from_mm(0.05), filled: false });
    let l = line("F.Cu", None, &["--parts", "U1", "--escape-mm", "1"]);
    let checker = super::check::Checker::new(&b, Rules::of(&b, PROJECT, None).unwrap(), l.options.clone());
    assert_eq!(checker.footprint_regions(1.0, Some(&l.parts)), [("U1".to_string(), [-2.05, -3.05, 5.05, 3.05])]);
}

#[test]
fn a_keepout_blocks_like_a_wall() {
    let mut b = board();
    row(&mut b, "U1", 0.0, &["N1"]);
    row(&mut b, "U2", 20.0, &["N1"]);
    let ring = vec![at(-2.0, -2.0), at(3.0, -2.0), at(3.0, 2.0), at(-2.0, 2.0)];
    let inner = Polygon { outline: ring, holes: Vec::new() };
    let area = RuleArea { tracks: true, vias: true, pour: false, pads: false, footprints: false };
    b.zones.push(Zone { id: "z".to_string(), name: "KEEP".to_string(), net: String::new(), layers: vec!["F.Cu".to_string(), "B.Cu".to_string()], outline: vec![inner], filled: Vec::new(), rule_area: Some(area), fill: None });
    let (rc, r, out) = run(&b, &line("F.Cu,B.Cu", Some([-4.0, -4.0, 5.0, 4.0]), &[]));
    assert_eq!((rc, r.verdict, r.flow), (1, Verdict::Fail, 0), "{out}");
}

fn rules(project: &str, dru: Option<&str>) -> Rules {
    let mut b = board();
    b.nets.insert("HV1".to_string(), "MAINS,Default".to_string());
    Rules::of(&b, project, dru).unwrap()
}

const CLASSES: &str = r#"{"net_settings": {"classes": [{"name": "Default", "track_width": 0.2, "clearance": 0.2, "via_diameter": 0.6}, {"name": "MAINS", "track_width": 0.5, "clearance": 1.0, "via_diameter": 0.8}, {"name": "USB", "track_width": 0.22, "clearance": 0.15, "via_diameter": 0.6}],
    "netclass_patterns": [{"netclass": "Default", "pattern": "D+"}, {"netclass": "USB", "pattern": "D?"}], "netclass_assignments": {"PIN": ["MAINS"], "ONE": "USB"}}}"#;

#[test]
fn a_net_gets_its_assignment_then_a_pattern_then_kicads_class() {
    let r = rules(CLASSES, None);
    assert_eq!(r.class("PIN").name, "MAINS");
    assert_eq!(r.class("ONE").name, "USB");
    assert_eq!(r.class("D+").name, "USB", "Default among the hits does not stop the first other class");
    assert_eq!(r.class("HV1").name, "MAINS");
    assert_eq!(r.class("OTHER").name, "Default");
    assert_eq!(r.class("").name, "Default");
}

#[test]
fn no_project_is_the_defaults() {
    let r = rules("{}", None);
    assert_eq!((r.edge, r.hole, r.min_track), (0.3, 0.25, 0.0));
    assert_eq!(r.class("X").pitch(), 0.4);
}

#[test]
fn the_larger_class_clearance_counts_and_a_later_rule_wins() {
    let dru = "(version 1)\n(rule a (constraint clearance (min 3mm)) (condition \"A.NetClass == 'MAINS'\"))\n(rule b (constraint clearance (min 2mm)) (condition \"A.NetClass == 'MAINS'\"))\n";
    assert_eq!(rules(CLASSES, None).clearance("OTHER", Kind::Track, "PIN"), 1.0);
    assert_eq!(rules(CLASSES, Some(dru)).clearance("PIN", Kind::Pad, "OTHER"), 2.0);
    assert_eq!(rules(CLASSES, Some(dru)).clearance("OTHER", Kind::Pad, "PIN"), 2.0, "either side of a rule");
}

#[test]
fn an_unknown_positive_term_skips_the_rule() {
    let dru = "(version 1)\n(rule a (constraint clearance (min 3mm)) (condition \"A.intersectsArea('X')\"))\n";
    let mut r = rules(CLASSES, Some(dru));
    assert_eq!(r.clearance("PIN", Kind::Track, "OTHER"), 1.0);
    assert!(r.notes.is_empty());
}

#[test]
fn an_unknown_exemption_is_ignored_with_a_note() {
    let dru = "(version 1)\n(rule a (constraint clearance (min 3mm)) (condition \"A.NetClass == 'MAINS' && !(A.intersectsArea('X'))\"))\n";
    let mut r = rules(CLASSES, Some(dru));
    assert_eq!(r.clearance("PIN", Kind::Track, "OTHER"), 3.0);
    assert_eq!(r.notes.iter().collect::<Vec<_>>(), ["dru exemption ignored (conservative): A.NetClass == 'MAINS' && !(A.intersectsArea('X'))"]);
}

#[test]
fn the_command_line_reads_as_argparse_did() {
    let l = read_line(["b.kicad_pcb", "--region=-2,-2,5,3", "--plane-nets", "GND,,VDD", "--only-nets", "", "--escape-mm=1.5", "--board-json", "b.json"].map(str::to_string).to_vec()).unwrap();
    assert_eq!(l.region, Some([-2.0, -2.0, 5.0, 3.0]));
    assert_eq!(l.options, Options { layers: vec!["F.Cu".to_string(), "B.Cu".to_string()], plane_nets: BTreeSet::from(["GND".to_string(), "VDD".to_string()]), ..Options::default() });
    assert_eq!((l.escape_mm, l.board_json), (1.5, Some(PathBuf::from("b.json"))));
    assert!(read_line(vec!["b".to_string(), "--region".to_string(), "1,2,3".to_string()]).is_err());
    assert!(read_line(vec!["--layers".to_string()]).is_err());
    assert!(read_line(vec!["a".to_string(), "b".to_string()]).is_err());
}
