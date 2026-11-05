//! Mains path check: the class gaps, the pad joins and the fault records of a pose.

mod common;

use common::{near, parse, within};
use iotplace::dru::{Rules, parse as parse_dru};
use iotplace::mains::{ClassGaps, Fault, Item, Obstacle, Shape, domain_nets, faults, route_net};
use iotplace::problem::{Place, Pose, Problem};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// The track width of the route tests.
const WIDTH: f64 = 2.0;

fn pad(x: f64, y: f64, net: &str, class: &str, w: f64, h: f64, reference: &str) -> Item {
    Item { reference: reference.into(), net: net.into(), class: class.into(), shape: Shape::Pad { c: (x, y), w, h } }
}

fn mains(x: f64, y: f64) -> Item {
    pad(x, y, "N", "MAINS_K1", 2.0, 3.0, "X")
}

fn selv(x: f64, y: f64, w: f64, h: f64, reference: &str) -> Item {
    pad(x, y, "OTHER", "SELV", w, h, reference)
}

/// The RELAY-4 rules: 8 mm mains to other, 3 mm between two mains classes and two mains nets.
fn relay_dru() -> Rules {
    Rules { domains: vec![("MAINS_K*".into(), 8.0, 3.0)], ..Rules::default() }
}

fn relay_gaps(dru: &Rules) -> ClassGaps<'_> {
    ClassGaps { dru, clearance: BTreeMap::from([("MAINS_K1", 3.0), ("MAINS_K2", 3.0), ("SELV", 0.2)]), edge: 0.5 }
}

fn obstacle<'a>(item: &'a Item, gaps: &ClassGaps) -> Obstacle<'a> {
    Obstacle { item, half_track: WIDTH / 2.0, need: gaps.gap("MAINS_K1", &item.class) }
}

fn route(pads: &[Item], others: &[Item]) -> Option<Fault> {
    let dru = relay_dru();
    let gaps = relay_gaps(&dru);
    let obstacles: Vec<Obstacle> = others.iter().map(|item| obstacle(item, &gaps)).collect();
    route_net("N", &pads.iter().collect::<Vec<_>>(), &obstacles)
}

#[test]
fn segment_to_rect_distance() {
    let r = Shape::Pad { c: (10.0, 0.0), w: 2.0, h: 2.0 };
    near(r.distance_to((0.0, 5.0), (20.0, 5.0)), 4.0);
    near(r.distance_to((0.0, 0.0), (20.0, 0.0)), 0.0);
    near(r.distance_to((0.0, 0.0), (5.0, 0.0)), 4.0);
    let corner = Shape::Pad { c: (4.0, 4.0), w: 2.0, h: 2.0 };
    within(corner.distance_to((0.0, 4.0), (4.0, 0.0)), 2.0_f64.sqrt(), 5e-7);
}

#[test]
fn a_blocked_straight_line_has_a_way_around() {
    // on the straight line and near both 45-degree paths
    assert!(route(&[mains(0.0, 0.0), mains(30.0, 40.0)], &[selv(15.0, 20.0, 1.0, 1.0, "S")]).is_none());
}

#[test]
fn a_blocked_aligned_pair_has_a_way_around() {
    assert!(route(&[mains(0.0, 0.0), mains(0.0, 40.0)], &[selv(0.0, 20.0, 1.0, 1.0, "S")]).is_none());
}

#[test]
fn no_legal_path_names_the_blocker() {
    let wall: Vec<Item> = (-40..=40).step_by(4).map(|x| selv(x as f64, 10.0, 4.0, 4.0, "U9")).collect();
    let f = route(&[mains(0.0, 0.0), mains(0.0, 20.0)], &wall).expect("the wall blocks the net");
    assert!(f.blockers.iter().any(|b| b.reference == "U9"));
}

#[test]
fn no_legal_path_gives_a_fault_record_for_the_placer() {
    let wall: Vec<Item> = (-40..=40).step_by(4).map(|x| selv(x as f64, 10.0, 4.0, 4.0, &format!("U{}", x + 40))).collect();
    let f = route(&[mains(0.0, 0.0), mains(0.0, 20.0)], &wall).expect("the wall blocks the net");
    assert_eq!(f.net, "N");
    assert_eq!(f.least_bad.unwrap()[0], (0.0, 0.0));
    assert!(!f.blockers.is_empty());
    assert!(f.blockers.iter().all(|b| b.shortfall_mm > 0.0));
    assert!(f.blockers.windows(2).all(|w| w[0].shortfall_mm >= w[1].shortfall_mm)); // worst first
}

#[test]
fn a_routed_net_has_no_fault() {
    assert!(route(&[mains(0.0, 0.0), mains(0.0, 20.0)], &[]).is_none());
}

#[test]
fn the_gap_follows_the_class_rules() {
    let (dru, straight) = (relay_dru(), [(0.0, 0.0), (0.0, 20.0)]);
    let gaps = relay_gaps(&dru);
    let near_track = selv(6.0, 10.0, 1.0, 1.0, "S"); // 5.5 mm from the track centre, 4.5 mm from its edge
    let other_mains = pad(6.0, 10.0, "M", "MAINS_K2", 1.0, 1.0, "M");
    assert!(obstacle(&other_mains, &gaps).margin(&straight) >= 0.0);
    assert!(obstacle(&near_track, &gaps).margin(&straight) < 0.0);
}

#[test]
fn a_single_pad_needs_no_route() {
    assert!(route(&[mains(0.0, 0.0)], &[]).is_none());
}

#[test]
fn a_path_outside_the_z_window() {
    // The only way around the wall is 24.5 mm to the left of both pads, outside the 12 mm Z window.
    let walls = [selv(0.0, 15.0, 30.0, 1.0, "WALL"), selv(15.5, 30.0, 1.0, 40.0, "RIGHT")];
    assert!(route(&[mains(0.0, 0.0), mains(0.0, 30.0)], &walls).is_none());
}

#[test]
fn a_closed_pocket_has_no_path() {
    let walls = [
        selv(0.0, 18.0, 40.0, 1.0, "WALL"),
        selv(0.0, 42.0, 40.0, 1.0, "TOP"),
        selv(-20.0, 30.0, 1.0, 25.0, "LEFT"),
        selv(20.0, 30.0, 1.0, 25.0, "RIGHT"),
    ];
    assert!(route(&[mains(0.0, 0.0), mains(0.0, 30.0)], &walls).is_some());
}

/// The rules of the RELAY-4 .kicad_dru that set a mains gap.
const RELAY_RULES: &str = r#"
(rule "Mains to SELV and 24 V" (condition "A.NetClass == 'MAINS_K*' && B.NetClass != 'MAINS_K*'")
  (constraint clearance (min 8mm)) (constraint creepage (min 7.5mm)))
(rule "Relay circuit to relay circuit" (condition "A.NetClass == 'MAINS_K*' && B.NetClass == 'MAINS_K*' && A.NetClass != B.NetClass")
  (constraint clearance (min 3mm)) (constraint creepage (min 3mm)))
(rule "Mains to screw hole" (condition "A.NetClass == 'MAINS_K*' && B.Type == 'Pad' && B.Pad_Type == 'NPTH, mechanical' && (B.Reference == 'H1' || B.Reference == 'H2')")
  (constraint hole_clearance (min 9.65mm)))
"#;

#[test]
fn relay_4_rules() {
    let dru = parse_dru(RELAY_RULES).unwrap();
    let g = relay_gaps(&dru);
    assert_eq!(g.gap("MAINS_K1", "SELV"), 8.0);
    assert_eq!(g.gap("MAINS_K1", "MAINS_K2"), 3.0);
    assert_eq!(g.gap("MAINS_K1", "MAINS_K1"), 3.0);
    assert_eq!(g.gap("MAINS_K1", "HOLE:H1"), 9.65);
    assert_eq!(g.gap("MAINS_K1", "HOLE:H7"), 3.0);
    assert_eq!(g.gap("MAINS_K1", "EDGE"), 0.5);
}

#[test]
fn each_dru_gap_comes_from_its_own_rule() {
    // Class clearances 0.2 everywhere, so each gap above 0.2 must come from the .kicad_dru rule it tests.
    let dru = parse_dru(RELAY_RULES).unwrap();
    let g = ClassGaps { dru: &dru, clearance: BTreeMap::from([("MAINS_K1", 0.2), ("MAINS_K2", 0.2), ("SELV", 0.2)]), edge: 0.5 };
    assert_eq!(g.gap("MAINS_K1", "MAINS_K2"), 3.0); // rule "Relay circuit to relay circuit"
    assert_eq!(g.gap("MAINS_K1", "SELV"), 8.0); // rule "Mains to SELV and 24 V"
    assert_eq!(g.gap("MAINS_K1", "MAINS_K1"), 0.2); // same class: the class clearance only
    assert_eq!(g.gap("MAINS_K1", "HOLE:H2"), 9.65); // rule "Mains to screw hole"
}

#[test]
fn a_compound_class_takes_the_strictest_member_gap() {
    // Audit #826: KiCad multi-netclass 'FIELD,POWER' is in the FIELD domain.
    let dru = Rules { domains: vec![("FIELD".into(), 4.0, 0.0)], ..Rules::default() };
    let g = ClassGaps { dru: &dru, clearance: BTreeMap::from([("FIELD", 0.2), ("POWER", 0.2), ("HOST", 0.2)]), edge: 0.5 };
    assert_eq!(g.gap("FIELD", "HOST"), 4.0);
    assert_eq!(g.gap("FIELD,POWER", "HOST"), 4.0);
    assert_eq!(g.gap("HOST", "FIELD,POWER"), 4.0);
    assert_eq!(g.gap("FIELD,POWER", "FIELD"), 0.2);
    assert_eq!(g.gap("FIELD,POWER", "FIELD,POWER"), 0.2);
}

#[test]
fn domain_nets_include_compound_classes() {
    let pr = parse(json!({
        "units": [], "nets": [], "board": {"outline": [[0, 0], [1, 0], [1, 1]]},
        "route_rules": {"dru": {"domains": [["FIELD", 4.0, 0.0]]}, "classes": {}},
        "cu_nets": {"1": ["/A", "FIELD,POWER"], "2": ["/B", "HOST"], "3": ["/C", "FIELD"]},
    }));
    assert_eq!(domain_nets(&pr), vec!["/A", "/C"]);
}

/// RELAY-4 tier 1.
const MAINS: [&str; 12] = [
    "/MAINS_COM1", "/MAINS_COM2", "/MAINS_COM3", "/MAINS_COM4", "/MAINS_NO1", "/MAINS_NO2", "/MAINS_NO3", "/MAINS_NO4",
    "/RELAY-CH1/NC", "/RELAY-CH2/NC", "/RELAY-CH3/NC", "/RELAY-CH4/NC",
];

fn mains_nets() -> Vec<String> {
    MAINS.iter().map(|n| n.to_string()).collect()
}

/// The RELAY-4 problem (units with cu/cu_pads, outline, cu_nets, route_rules) of bench pose O or s67.
fn relay4(name: &str) -> Problem {
    let path = format!("{}/../testdata/relay4-mains-O-s67.json", env!("CARGO_MANIFEST_DIR"));
    let all: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut v = all[name].clone();
    v["nets"] = json!([]);
    for u in v["units"].as_array_mut().unwrap() {
        u["fixed"] = json!(false);
        u["rects"] = json!([]);
    }
    parse(v)
}

#[test]
fn s67_com2_and_com3_have_no_legal_mains_path() {
    // Hetzner mains router on s67 (2026-09-28): COM2 blocked by K2/K1/J3, COM3 by K4/J4/K3.
    let pr = relay4("s67");
    let fs = faults(&pr, &pr.initial_pose(), &mains_nets());
    let mut nets: Vec<&str> = fs.iter().map(|f| f.net.as_str()).collect();
    nets.sort();
    assert_eq!(nets, vec!["/MAINS_COM2", "/MAINS_COM3"]);
    let refs = |net: &str| -> BTreeSet<&str> {
        fs.iter().filter(|f| f.net == net).flat_map(|f| f.blockers.iter().map(|b| b.reference.as_str())).collect()
    };
    assert!(refs("/MAINS_COM2").contains("K2"));
    assert!(refs("/MAINS_COM3").contains("K4"));
}

#[test]
fn o_has_a_legal_path_for_every_mains_net() {
    let pr = relay4("O");
    assert!(faults(&pr, &pr.initial_pose(), &mains_nets()).is_empty());
}

#[test]
fn the_domain_nets_of_relay_4_are_the_tier_1_mains_nets() {
    let mut want = mains_nets();
    want.sort();
    assert_eq!(domain_nets(&relay4("O")), want);
}

#[test]
fn the_check_uses_the_pose_not_the_read_positions() {
    let (pr, o) = (relay4("s67"), relay4("O"));
    // the unit names differ per read
    let at: BTreeMap<&Vec<String>, Place> = o.units.iter().map(|u| (&u.refs, u.place())).collect();
    let pose: Pose = pr.units.iter().map(|u| at[&u.refs]).collect();
    assert!(faults(&pr, &pose, &mains_nets()).is_empty());
}

/// PS1 with pads 1 and 2 on the domain net and pad 3, no net, between them (BACKUP-POWER).
fn ps1(members: Value, cu_pads: Value) -> Problem {
    parse(json!({
        "units": [{"name": "PS1", "refs": ["PS1"], "fixed": false, "x": 0, "y": 0, "rects": [],
                   "cu": [[-0.5, -0.5, 0.5, 0.5, 1], [2.0, -0.5, 3.0, 0.5, 0], [4.5, -0.5, 5.5, 0.5, 1]], "cu_pads": cu_pads}],
        "nets": [], "cu_nets": {"1": ["FGND", "FIELD"]},
        "route_rules": {"dru": {"domains": [["FIELD", 4.0, 0.0]], "holes": [], "pairs": [], "members": members},
                        "classes": {"Default": [0.2, 0.2], "FIELD": [0.2, 0.5]}},
        "board": {"outline": [[-10, -10], [15, -10], [15, 10], [-10, 10]], "edge_clearance": 0.3},
    }))
}

fn pth_pads() -> Value {
    json!([["PS1", "pth", "1"], ["PS1", "pth", "3"], ["PS1", "pth", "2"]])
}

fn fgnd_faults(pr: &Problem) -> Vec<String> {
    faults(pr, &[(0.0, 0.0, 0)], &["FGND".to_string()]).into_iter().map(|f| f.net).collect()
}

#[test]
fn a_no_net_pad_between_two_domain_pads_blocks_them() {
    assert_eq!(fgnd_faults(&ps1(json!([]), pth_pads())), vec!["FGND"]);
}

#[test]
fn the_same_pad_as_a_domain_member_does_not() {
    assert!(fgnd_faults(&ps1(json!([["FIELD", "PS1", "3"]]), pth_pads())).is_empty());
}

#[test]
fn old_two_field_cu_pads_still_read() {
    assert_eq!(fgnd_faults(&ps1(json!([]), json!([["PS1", "pth"], ["PS1", "pth"], ["PS1", "pth"]]))), vec!["FGND"]);
}

#[test]
fn same_net_copper_is_not_an_obstacle() {
    let pr = parse(json!({
        "units": [{"name": "A", "refs": ["A"], "fixed": false, "x": 0, "y": 0, "rects": [],
                   "cu": [[-1, -1.5, 1, 1.5, 1], [-1, 8.5, 1, 11.5, 1], [-1, 18.5, 1, 21.5, 1]],
                   "cu_pads": [["A", "pth", "1"], ["A", "pth", "2"], ["A", "pth", "3"]]}],
        "nets": [], "cu_nets": {"1": ["N", "MAINS_K1"]},
        "route_rules": {"dru": {"domains": [["MAINS_K*", 8.0, 3.0]]}, "classes": {"Default": [0.2, 0.2], "MAINS_K1": [3.0, 2.0]}},
        "board": {"outline": [[-30, -30], [30, -30], [30, 30], [-30, 30]], "edge_clearance": 0.5},
    }));
    assert!(faults(&pr, &[(0.0, 0.0, 0)], &["N".to_string()]).is_empty());
}
