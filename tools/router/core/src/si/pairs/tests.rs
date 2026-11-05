use super::*;
use crate::kicad::board::{RoutedCopper, Via, ZoneFill};
use crate::kicad::pad::{Pad, PadShape};

const STACKUP_TEXT: &str = r#"
  (stackup
   (layer "F.Mask" (type "Top Solder Mask") (thickness 0.01) (material "LPI") (epsilon_r 3.8))
   (layer "F.Cu" (type "copper") (thickness 0.035))
   (layer "dielectric 1" (type "prepreg") (thickness 0.2104) (material "7628") (epsilon_r 4.4) (loss_tangent 0.02))
   (layer "In1.Cu" (type "copper") (thickness 0.0152))
   (copper_finish "HAL lead-free")
  )
"#;

const DRU_TEXT: &str = r#"
# comment (rule "not a rule")
(rule "USB 90R diff pair"
  (condition "A.inDiffPair('/USB_D')")
  (constraint track_width (min 0.22mm) (opt 0.22mm) (max 0.22mm))
  (constraint diff_pair_gap (min 0.12mm) (opt 0.13mm)))

(rule "Other"
  (constraint clearance (min 0.5mm)))
"#;

const LAYERS: &str = r#""stackup": {"layers": {"F.Cu": {"model": "microstrip", "t_mm": 0.035, "h_mm": 0.2104, "er": 4.4, "ref_layer": "In1.Cu", "mask_factor_diff": 0.884}}}"#;

fn f_cu() -> Layer {
    Layer { name: "F.Cu".to_string(), model: "microstrip".to_string(), t_mm: Some(0.035), h_mm: Some(0.2104), er: Some(4.4), ref_layer: "In1.Cu".to_string(), mask_factor_diff: 0.884, ..Layer::default() }
}

fn seg(x1: f64, y1: f64, x2: f64, y2: f64) -> Seg {
    Seg { layer: "F.Cu".to_string(), a: (x1, y1), b: (x2, y2) }
}

fn board<'a>(ref_at: impl Fn(&str, f64, f64, &[String]) -> bool + 'a, vias: &[(&str, Antipad)]) -> PairBoard<'a> {
    let nets = BTreeMap::from([("/DP".to_string(), vec![seg(0.0, 0.0, 10.0, 0.0)]), ("/DN".to_string(), vec![seg(0.0, 0.35, 10.0, 0.35)])]);
    let mut by_net: BTreeMap<String, Vec<Antipad>> = BTreeMap::new();
    for (net, via) in vias {
        by_net.entry(net.to_string()).or_default().push(*via);
    }
    PairBoard { stackup: parse_stackup(STACKUP_TEXT).unwrap().unwrap(), nets, ref_at: Box::new(ref_at), dru: DRU_TEXT.to_string(), vias: by_net }
}

fn all_ground(_: &str, _: f64, _: f64, refs: &[String]) -> bool {
    refs.iter().any(|r| r == "GND")
}

/// A 2 mm gap in the reference plane between x 4 and 6, the rest covered.
fn with_gap(_: &str, x: f64, _: f64, refs: &[String]) -> bool {
    !(4.0..=6.0).contains(&x) && refs.iter().any(|r| r == "GND")
}

fn pair(extra: &str) -> String {
    format!(r#""name": "USB", "p": "/DP", "n": "/DN", "tol_pct": 10, "dru_rule": "USB 90R diff pair", "reference": "GND"{extra}"#)
}

fn spec(extra: &str) -> PairSpec {
    let z = if extra.contains("z_diff") { "" } else { r#", "z_diff": 90"# };
    spec_text(&format!(r#"{{{LAYERS}, "pairs": [{{{}{z}}}]}}"#, pair(extra)))
}

fn spec_text(text: &str) -> PairSpec {
    PairSpec::read(&Json::parse(text).unwrap()).unwrap()
}

fn status(rows: &[Row], check: &str) -> &'static str {
    rows.iter().find(|r| r.check == check).unwrap_or_else(|| panic!("no {check} in {rows:?}")).status
}

const GAP_AREA: &str = r#"{"layer": "F.Cu", "rect": [4, -1, 6, 1], "reason": "via keepout, see ECO-12"}"#;

#[test]
fn a_good_pair_passes() {
    let rows = evaluate(&spec(""), &board(all_ground, &[])).unwrap();
    let checks: Vec<(&str, &str)> = rows.iter().map(|r| (r.check.as_str(), r.status)).collect();
    assert_eq!(checks, [("zdiff F.Cu", "PASS"), ("reference p", "PASS"), ("reference n", "PASS")]);
}

#[test]
fn a_zdiff_off_target_fails() {
    let rows = evaluate(&spec(r#", "z_diff": 120"#), &board(all_ground, &[])).unwrap();
    assert_eq!(status(&rows, "zdiff F.Cu"), "FAIL");
}

#[test]
fn a_reference_gap_under_one_leg_fails() {
    let rows = evaluate(&spec(""), &board(|_, x, y, _| !(y > 0.1 && x > 5.0), &[])).unwrap();
    assert_eq!((status(&rows, "reference p"), status(&rows, "reference n")), ("PASS", "FAIL"));
}

#[test]
fn a_reference_may_list_nets() {
    let by_side = |_: &str, x: f64, _: f64, refs: &[String]| refs.iter().any(|r| r == if x < 5.0 { "GND" } else { "VDD" });
    let rows = evaluate(&spec(r#", "reference": ["GND", "VDD"]"#), &board(by_side, &[])).unwrap();
    assert_eq!(status(&rows, "reference p"), "PASS");
    assert!(rows.iter().any(|r| r.detail.contains("over ['GND', 'VDD'] (min 100 %)")));
}

#[test]
fn a_missing_net_stops() {
    let text = format!(r#"{{{LAYERS}, "pairs": [{{"name": "USB", "p": "/NOPE", "n": "/DN", "z_diff": 90, "tol_pct": 10, "dru_rule": "USB 90R diff pair", "reference": "GND"}}]}}"#);
    assert!(evaluate(&spec_text(&text), &board(all_ground, &[])).unwrap_err().contains("net /NOPE has no tracks"));
}

#[test]
fn a_layer_with_no_model_stops() {
    let mut b = board(all_ground, &[]);
    b.nets.get_mut("/DP").unwrap().push(Seg { layer: "B.Cu".to_string(), a: (0.0, 0.0), b: (1.0, 1.0) });
    assert!(evaluate(&spec(""), &b).unwrap_err().contains("track on B.Cu"));
}

#[test]
fn a_single_ended_net_gets_a_reference_row() {
    let s = spec_text(&format!(r#"{{{LAYERS}, "pairs": [], "nets": [{{"name": "SCK", "net": "/DN", "reference": "GND"}}]}}"#));
    let rows = evaluate(&s, &board(all_ground, &[])).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(status(&rows, "reference"), "PASS");
}

#[test]
fn stackup_mismatch_stops() {
    let st = parse_stackup(STACKUP_TEXT).unwrap().unwrap();
    assert!(check_stackup(&[f_cu()], &st).is_ok());
    let bad = Layer { h_mm: Some(0.0994), ..f_cu() };
    assert!(check_stackup(&[bad], &st).unwrap_err().contains("F.Cu h_mm: spec 0.0994 board 0.2104"));
}

#[test]
fn a_dru_rule_gives_its_constraints() {
    let r = parse_dru_rule(DRU_TEXT, "USB 90R diff pair").unwrap();
    assert_eq!(r["track_width"].repr(), "{'min': 0.22, 'opt': 0.22, 'max': 0.22}");
    assert_eq!(r["diff_pair_gap"].repr(), "{'min': 0.12, 'opt': 0.13}");
}

#[test]
fn a_missing_rule_stops() {
    assert!(parse_dru_rule(DRU_TEXT, "Nope").is_err());
}

fn limits(items: &[(&str, f64)]) -> Limits {
    Limits(items.iter().map(|(k, v)| (k.to_string(), *v)).collect())
}

#[test]
fn the_zdiff_window_uses_the_corners() {
    // Z falls with width and rises with gap: low corner (w max, gap min), high corner (w min, gap max).
    let rule = DruRule::from([("track_width".to_string(), limits(&[("min", 0.2), ("opt", 0.22), ("max", 0.24)])), ("diff_pair_gap".to_string(), limits(&[("min", 0.12), ("opt", 0.13)]))]);
    let layer = f_cu();
    let (lo, nom, hi) = zdiff_window(&layer, &rule).unwrap();
    assert_eq!(lo, zdiff(&layer, 0.24, 0.12).unwrap());
    assert_eq!(nom, zdiff(&layer, 0.22, 0.13).unwrap());
    assert_eq!(hi, zdiff(&layer, 0.2, 0.13).unwrap());
}

#[test]
fn a_rule_with_no_gap_stops() {
    let rule = DruRule::from([("track_width".to_string(), limits(&[("opt", 0.2)]))]);
    assert!(zdiff_window(&f_cu(), &rule).is_err());
}

#[test]
fn the_radius_is_half_the_width_plus_the_largest_clearance() {
    assert!((via_antipad_radius(0.6, &[0.3, 0.2]) - 0.6).abs() < 1e-12);
    assert!((via_antipad_radius(0.6, &[]) - 0.3).abs() < 1e-12);
}

#[test]
fn a_gap_fails_with_no_exemption() {
    let rows = evaluate(&spec(""), &board(with_gap, &[])).unwrap();
    assert_eq!((status(&rows, "reference p"), status(&rows, "reference n")), ("FAIL", "FAIL"));
}

#[test]
fn an_exempt_area_takes_the_gap_out_and_reports_its_length() {
    let rows = evaluate(&spec(&format!(r#", "exempt_areas": [{GAP_AREA}]"#)), &board(with_gap, &[])).unwrap();
    assert_eq!((status(&rows, "reference p"), status(&rows, "reference n")), ("PASS", "PASS"));
    assert!(rows.iter().find(|r| r.check == "exempt area").unwrap().detail.contains("4.0")); // 2 mm on each of p and n
}

#[test]
fn an_exempt_area_needs_a_reason() {
    let json = Json::parse(&format!(r#"{{{LAYERS}, "pairs": [{{{}, "z_diff": 90, "exempt_areas": [{{"layer": "F.Cu", "rect": [4, -1, 6, 1], "reason": ""}}]}}]}}"#, pair(""))).unwrap();
    assert!(PairSpec::read(&json).unwrap_err().contains("a written reason is required"));
}

#[test]
fn an_area_that_removes_nothing_is_stale() {
    let area = r#"{"layer": "F.Cu", "rect": [100, 100, 110, 110], "reason": "unused"}"#;
    let error = evaluate(&spec(&format!(r#", "exempt_areas": [{area}]"#)), &board(with_gap, &[])).unwrap_err();
    assert!(error.contains("STALE exempt_area F.Cu [100, 100, 110, 110] (unused)"), "{error}");
}

#[test]
fn top_level_areas_apply_to_every_pair() {
    let s = spec_text(&format!(r#"{{{LAYERS}, "exempt_areas": [{GAP_AREA}], "pairs": [{{{}, "z_diff": 90}}]}}"#, pair("")));
    assert_eq!(status(&evaluate(&s, &board(with_gap, &[])).unwrap(), "reference p"), "PASS");
}

#[test]
fn a_pair_list_overrides_the_top_level() {
    // The pair opts out with an empty list, so the top-level area does not apply and is stale.
    let s = spec_text(&format!(r#"{{{LAYERS}, "exempt_areas": [{GAP_AREA}], "pairs": [{{{}, "z_diff": 90, "exempt_areas": []}}]}}"#, pair("")));
    assert!(evaluate(&s, &board(with_gap, &[])).unwrap_err().contains("STALE exempt_area"));
}

const VIAS: [(&str, Antipad); 2] = [("/DP", Antipad { x: 5.0, y: 0.0, r: 1.5 }), ("/DN", Antipad { x: 5.0, y: 0.35, r: 1.5 })];

#[test]
fn a_gap_near_a_same_net_via_is_allowed_and_reported() {
    let rows = evaluate(&spec(r#", "via_antipad_allowance": true"#), &board(with_gap, &VIAS)).unwrap();
    assert_eq!((status(&rows, "reference p"), status(&rows, "reference n")), ("PASS", "PASS"));
    let note: Vec<&Row> = rows.iter().filter(|r| r.check == "via antipad" && r.status == "INFO").collect();
    assert_eq!(note.len(), 1);
    assert!(note[0].detail.contains("4.0")); // 2 mm gap x 2 legs
    assert!(rows.iter().any(|r| r.status == "WARN"));
}

#[test]
fn the_allowance_is_off_by_default() {
    assert_eq!(status(&evaluate(&spec(""), &board(with_gap, &VIAS)).unwrap(), "reference p"), "FAIL");
}

#[test]
fn a_small_allowance_does_not_warn() {
    // A 0.5 mm gap next to the via stays under the 1.5 mm-per-via bound.
    let small = |_: &str, x: f64, _: f64, _: &[String]| !(4.75..=5.25).contains(&x);
    let rows = evaluate(&spec(r#", "via_antipad_allowance": true"#), &board(small, &VIAS)).unwrap();
    assert!(!rows.iter().any(|r| r.status == "WARN"));
}

#[test]
fn a_quarter_circle_comes_as_short_chords() {
    let m = 0.5f64.sqrt();
    let points = arc_points((1.0, 0.0), (m, m), (0.0, 1.0), 0.05);
    assert_eq!((points[0], *points.last().unwrap()), ((1.0, 0.0), (0.0, 1.0)));
    let length: f64 = points.windows(2).map(|w| dist(w[0], w[1])).sum();
    assert!((length - std::f64::consts::FRAC_PI_2).abs() < 0.002);
}

#[test]
fn full_coverage_is_exactly_100_percent() {
    // POE-ETHERNET ETH_RXP (2026-09-26): hit == tot, but 100 * hit / tot gave 99.99999999999999.
    let segs = [seg(135.788, 113.7, 133.475, 113.7), seg(135.838, 113.75, 135.788, 113.7), seg(133.475, 113.7, 133.05, 114.05)];
    let cov = coverage_detail(&segs, &[f_cu()], &["GND".to_string()], &all_ground, &[], &[]);
    assert_eq!(cov.pct, 100.0);
}

#[test]
fn the_report_prints_a_table_and_a_summary() {
    let rows = [row("USB", "zdiff F.Cu", "FAIL", "x".to_string()), row("USB", "reference p", "PASS", "y".to_string())];
    let (lines, code) = report(&rows, false);
    assert_eq!(lines, ["FAIL USB          zdiff F.Cu     x", "si_pairs: 1 PASS, 1 FAIL"]);
    assert_eq!(code, 1);
    assert_eq!(report(&rows[1..], true).1, 0);
}

fn empty_board() -> Board {
    Board {
        path: String::new(),
        copper_layers: vec!["F.Cu".to_string(), "In1.Cu".to_string(), "B.Cu".to_string()],
        stackup: Vec::new(),
        texts: Vec::new(),
        groups: Vec::new(),
        constraints: Default::default(),
        nets: BTreeMap::new(),
        footprints: Vec::new(),
        copper: Vec::new(),
        zones: Vec::new(),
        graphics: Vec::new(),
        edges_bbox: crate::kicad::geom::Rect::around(Pt::default()),
        outlines: Vec::new(),
    }
}

fn zone(net: &str, layer: &str, clearance: i64) -> Zone {
    let fill = ZoneFill { clearance, min_thickness: 0, thermal_gap: 0, spoke_width: 0, pad_connection: None, island_removal_mode: 0, min_island_area: 0, corner_smoothing: 0, corner_radius: 0, priority: 0 };
    Zone { id: String::new(), name: String::new(), net: net.to_string(), layers: vec![layer.to_string()], outline: Vec::new(), filled: Vec::new(), rule_area: None, fill: Some(fill) }
}

fn via(net: &str, x: i64, y: i64, size: i64) -> RoutedCopper {
    RoutedCopper::Via(Via { id: String::new(), at: Pt::new(x, y), size, drill: 0, net: net.to_string(), locked: false, layers: Vec::new() })
}

#[test]
fn a_via_takes_half_its_width_plus_the_zone_clearance() {
    // A 0.6 mm via on SIG under a GND zone with a 0.3 mm clearance: 0.3 + 0.3 = 0.6 mm.
    let mut b = empty_board();
    b.zones.push(zone("GND", "F.Cu", 300_000));
    b.copper.push(via("SIG", 5_000_000, 7_000_000, 600_000));
    let vias = collect_vias(&b);
    assert_eq!(vias.keys().collect::<Vec<_>>(), ["SIG"]);
    let v = vias["SIG"][0];
    assert_eq!((v.x, v.y), (5.0, 7.0));
    assert!((v.r - 0.6).abs() < 1e-9);
}

#[test]
fn with_no_zone_the_allowance_is_half_the_via() {
    let mut b = empty_board();
    b.copper.push(via("SIG", 1_000_000, 1_000_000, 500_000));
    assert!((collect_vias(&b)["SIG"][0].r - 0.25).abs() < 1e-9);
}

fn pad(kind: PadKind, size: i64, at: Pt, layers: &[&str]) -> Pad {
    Pad {
        id: String::new(), number: "1".to_string(), kind, shape: PadShape::Circle, net: "SIG".to_string(), position: at, orientation: 0.0,
        size: Pt::new(size, size), drill: Pt::default(), layers: layers.iter().map(|l| l.to_string()).collect(), bbox: crate::kicad::geom::Rect::around(at),
        zone_connection: None, thermal_spoke_angle: 0.0, spoke_templates: 0, copper: Vec::new(), polygons: BTreeMap::new(), solder_mask_expansion: 0, solder_mask_expansion_by_layer: Default::default(), clearance_override: None,
    }
}

#[test]
fn a_through_hole_pad_counts_as_a_via_and_an_smd_pad_does_not() {
    // An RJ45 pin: 1.6 mm pad under a GND zone with 0.25 mm clearance: 0.8 + 0.25 = 1.05 mm. An SMD pad cuts no plane.
    let mut b = empty_board();
    b.zones.push(zone("GND", "In1.Cu", 250_000));
    b.footprints.push(crate::kicad::board::Footprint {
        pads: vec![pad(PadKind::ThroughHole, 1_600_000, Pt::new(10_000_000, 20_000_000), &["F.Cu", "In1.Cu", "B.Cu"]), pad(PadKind::Smd, 1_000_000, Pt::new(30_000_000, 40_000_000), &["F.Cu"])],
        ..Default::default()
    });
    let vias = &collect_vias(&b)["SIG"];
    assert_eq!(vias.len(), 1);
    assert_eq!((vias[0].x, vias[0].y), (10.0, 20.0));
    assert!((vias[0].r - 1.05).abs() < 1e-9);
}
