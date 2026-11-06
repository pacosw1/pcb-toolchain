//! The board reader on a small routed board: units, rects, copper rows, ties, rule areas and the project files beside the board.

mod common;

use common::board::{ANY_RULE, Fixture, buck, class, default_classes, footprint, is_fixed, label, locked, rect_shape, rounded_row, rule_area, unit_of};
use common::{terms, within};
use iotplace::dru;
use iotplace::evaluator::Evaluator;
use iotplace::kicad::doc::{Board, Copper, Geometry, Graphic, Pad, PadKind};
use iotplace::model::Model;
use iotplace::params::Params;
use iotplace::read::extras::net_codes;
use iotplace::read::options::{DomainRegion, Options};
use iotplace::read::out::ProblemOut;
use iotplace::read::parts::{fp_rect, pad_gap};
use iotplace::read::project::{DomainClasses, keepout_gaps};
use iotroute::kicad::board::RuleArea;
use iotroute::kicad::geom::Pt;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::process::Command;

fn plain() -> Options {
    Options::default()
}

fn set_class(board: &mut Board, net: &str, name: &str) {
    board.nets.insert(net.to_string(), name.to_string());
}

/// The rows of pads on a net of a part.
fn pads_on<'a>(fx: &'a Fixture, reference: &str, net: &str) -> Vec<&'a Pad> {
    fx.fp(reference).pads.iter().filter(|p| p.net == net).collect()
}

fn unit_pads<'a>(fx: &'a Fixture, refs: &[String]) -> Vec<&'a Pad> {
    refs.iter().flat_map(|r| &fx.fp(r).pads).collect()
}

#[test]
fn a_no_net_creepage_rule_gives_its_domain_classes_the_gap_plus_the_margin() {
    let mut classes = DomainClasses::default();
    classes.id("FIELD");
    classes.id("CELL");
    let gaps = keepout_gaps(&classes, &[("FIELD".to_string(), 0.7)]);
    assert_eq!(gaps.keys().collect::<Vec<_>>(), ["1"]);
    within(gaps["1"], 0.75, 1e-9);
}

#[test]
fn no_rule_gives_no_gap() {
    let mut classes = DomainClasses::default();
    classes.id("FIELD");
    assert!(keepout_gaps(&classes, &[]).is_empty());
}

#[test]
fn via_nets_give_each_unit_its_copper_pads_with_the_net_code() {
    let fx = Fixture::new(buck());
    let codes = net_codes(&fx.board);
    let gnd = codes["GND"];
    assert!(fx.read(&plain()).via_nets.is_empty());
    let pr = fx.read(&Options { via_nets: vec!["GND".to_string()], ..plain() });
    assert_eq!(pr.via_nets, [gnd]);
    for u in &pr.units {
        let pads = unit_pads(&fx, &u.refs);
        assert_eq!(u.cu.len(), pads.len());
        let mut got: Vec<i64> = u.cu.iter().map(|q| q.4).collect();
        let mut want: Vec<i64> = pads.iter().map(|p| codes[&p.net]).collect();
        got.sort_unstable();
        want.sort_unstable();
        assert_eq!(got, want);
    }
    assert!(pr.units.iter().any(|u| u.cu.iter().any(|q| q.4 == gnd)));
    let problem = fx.problem(&pr);
    let params = Params::from_args(&["w_via=1"]).unwrap();
    assert_eq!(terms(&problem, &problem.initial_pose(), &params).via, 0.0, "the routed original has via room");
}

#[test]
fn cu_nets_name_the_net_and_class_of_each_copper_net_code() {
    let fx = Fixture::new(buck());
    let pr = fx.read(&plain());
    let codes = net_codes(&fx.board);
    let used: BTreeSet<i64> = pr.units.iter().flat_map(|u| u.cu.iter().map(|q| q.4)).filter(|c| *c > 0).collect();
    assert_eq!(pr.cu_nets.keys().map(|k| k.parse().unwrap()).collect::<BTreeSet<i64>>(), used);
    assert!(pr.cu_nets.values().any(|(name, class)| name == "/VOUT" && class == "POWER"));
    for (code, (name, class)) in &pr.cu_nets {
        assert_eq!(codes[name].to_string(), *code);
        assert_eq!(fx.board.net_class(name), class);
    }
}

#[test]
fn cu_pads_give_the_ref_pad_kind_and_pad_number_of_each_copper_box() {
    let mut board = buck();
    board.footprints.iter_mut().find(|f| f.reference == "J2").unwrap().pads[2].kind = PadKind::EdgeConnector;
    let fx = Fixture::new(board);
    let word = |p: &Pad| match p.kind {
        PadKind::Smd | PadKind::EdgeConnector => "smd",
        PadKind::ThroughHole => "pth",
        PadKind::NpThroughHole => "npth",
    };
    let pr = fx.read(&plain());
    for u in &pr.units {
        let want: Vec<(String, String, String)> = u.refs.iter().flat_map(|r| fx.fp(r).pads.iter().map(|p| (r.clone(), word(p).to_string(), p.number.clone()))).collect();
        assert_eq!(u.cu_pads, want);
        assert_eq!(u.cu_pads.len(), u.cu.iter().filter(|q| q.4 != -1).count(), "no-via rows come after");
    }
    let kinds: BTreeSet<&str> = pr.units.iter().flat_map(|u| u.cu_pads.iter().map(|p| p.1.as_str())).collect();
    assert_eq!(kinds, BTreeSet::from(["npth", "pth", "smd"]));
    assert_eq!(pr.units[unit_of(&pr, "J2")].cu_pads[2].1, "smd", "an edge connector pad counts as smd");
}

#[test]
fn centres_give_each_part_courtyard_centre_relative_to_the_unit_origin() {
    // The board checkers measure part distances from the courtyard box centre, not the footprint origin.
    let fx = Fixture::new(buck());
    let pr = fx.read(&Options { tie: 1.5, ..plain() });
    assert!(pr.units.iter().any(|u| u.refs.len() > 1));
    for u in &pr.units {
        assert_eq!(u.centres.keys().collect::<Vec<_>>(), u.refs.iter().collect::<Vec<_>>());
        for (r, c) in &u.centres {
            let (cx, cy) = fp_rect(fx.fp(r)).centre();
            within(c[0] + u.x, cx, 1e-5);
            within(c[1] + u.y, cy, 1e-5);
        }
    }
}

#[test]
fn route_rules_hold_the_dru_rules_and_the_net_class_clearance_and_width() {
    let text = "(version 1)\n(rule \"M\" (condition \"A.NetClass == 'MAINS_K*' && B.NetClass != 'MAINS_K*'\") (constraint clearance (min 8mm)))\n";
    let classes = default_classes();
    let fx = Fixture::with(buck(), &classes, Some(text));
    let pr = fx.read(&plain());
    let want: BTreeMap<String, [f64; 2]> = [("Default".to_string(), [0.2, 0.25]), ("POWER".to_string(), [0.3, 0.5])].into();
    assert_eq!(pr.route_rules.classes, want);
    let parsed = dru::parse(text).unwrap();
    assert_eq!(parsed.domains.len(), 1);
    let got = serde_json::to_value(&pr.route_rules.dru).unwrap();
    assert_eq!(got.as_object().unwrap().keys().map(String::as_str).collect::<BTreeSet<_>>(), BTreeSet::from(["domains", "holes", "members", "pairs"]));
    assert_eq!(got["domains"], serde_json::to_value(&parsed.domains).unwrap());
    assert_eq!(got["holes"], serde_json::to_value(&parsed.holes).unwrap());
    assert_eq!(got["pairs"], serde_json::to_value(&parsed.pairs).unwrap());
    assert_eq!(got["members"], serde_json::to_value(&parsed.members).unwrap());
}

#[test]
fn no_via_rule_areas_are_board_via_keepouts_or_move_with_their_unit() {
    let mut board = buck();
    let (x, y) = (130.0, 120.0);
    let area = (x - 2.0, y - 1.0, x + 2.0, y + 1.0);
    board.zones.push(rule_area("NOVIA_T", &["F.Cu", "B.Cu"], area, RuleArea { vias: true, ..ANY_RULE }));
    let fx = Fixture::new(board);
    let pr = fx.read(&plain());
    let n = pr.board.via_keepouts.len();
    let want = vec![[area.0, area.1], [area.2, area.1], [area.2, area.3], [area.0, area.3]];
    assert!(pr.board.via_keepouts.contains(&want));
    let pr = fx.read(&Options { zone_refs: [("NOVIA_T".to_string(), "U1".to_string())].into(), ..plain() });
    assert_eq!(pr.board.via_keepouts.len(), n - 1);
    let u = &pr.units[unit_of(&pr, "U1")];
    let rows: Vec<_> = u.cu.iter().filter(|q| q.4 == -1).collect();
    assert_eq!(rows.len(), 1);
    assert_eq!(rounded_row(&[rows[0].0 + u.x, rows[0].1 + u.y, rows[0].2 + u.x, rows[0].3 + u.y], 3), [area.0, area.1, area.2, area.3]);
}

/// Runs `iotplace read` on a fixture; the problem file on success.
fn cli_read(fx: &Fixture, flags: &[&str]) -> Option<Value> {
    let out = fx.folder().join("p.json");
    let status = Command::new(env!("CARGO_BIN_EXE_iotplace")).arg("read").arg(&fx.path).arg("--board-json").arg(fx.document()).arg("-o").arg(&out).args(flags).output().unwrap();
    status.status.success().then(|| serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap())
}

#[test]
fn cli_read_takes_the_via_nets() {
    let fx = Fixture::new(buck());
    let v = cli_read(&fx, &["--via-net", "GND", "NOPE*"]).unwrap();
    assert_eq!(v["via_nets"], json!([net_codes(&fx.board)["GND"]]));
}

#[test]
fn cli_read_in_box_gives_the_matching_movable_units_their_region_box() {
    let fx = Fixture::new(buck());
    let v = cli_read(&fx, &["--in-box", "R2=0,0,500,500"]).unwrap();
    let units = v["units"].as_array().unwrap();
    let boxed: Vec<&Value> = units.iter().filter(|u| u.get("in_box").is_some()).collect();
    assert_eq!(boxed.len(), 1);
    assert_eq!(boxed[0]["refs"], json!(["R2"]));
    assert_eq!(boxed[0]["in_box"], json!([0.0, 0.0, 500.0, 500.0]));
    assert!(fx.read_error(&Options { in_boxes: vec![("NOPE*".to_string(), [0.0, 0.0, 500.0, 500.0])], ..plain() }).contains("no part matches"));
    assert!(fx.read_error(&Options { in_boxes: vec![("R2".to_string(), [0.0, 0.0, 0.1, 500.0])], ..plain() }).contains("does not fit"));
    assert!(cli_read(&fx, &["--in-box", "R2=0,0,1"]).is_none());
}

#[test]
fn a_locked_bottom_track_has_its_layer_row_and_pads_list_their_copper_layers() {
    let mut board = buck();
    let item = board.copper.iter_mut().find(|c| matches!(c, Copper::Track(t) if t.id == "vin-a")).unwrap();
    locked(item);
    if let Copper::Track(t) = item {
        t.layer = "B.Cu".to_string();
    }
    let fx = Fixture::new(board);
    let pr = fx.read(&plain());
    let rows: Vec<Vec<f64>> = pr.board.fixed_copper_layers.iter().filter(|r| r.0 == "B.Cu").map(|r| vec![r.1, r.2, r.3, r.4, r.5]).collect();
    assert_eq!(rows, [vec![105.0, 118.0, 111.0, 118.0, 0.25]]);
    for u in &pr.units {
        let pads = unit_pads(&fx, &u.refs);
        assert_eq!(pads.len(), u.pad_copper_layers.len());
        for (pad, layers) in pads.iter().zip(&u.pad_copper_layers) {
            assert_eq!(layers.iter().any(|l| l == "B.Cu"), pad.layers.iter().any(|l| l == "B.Cu"));
            assert_eq!(layers.iter().any(|l| l == "F.Cu"), pad.layers.iter().any(|l| l == "F.Cu"));
        }
    }
    let of_kind = |kind: &str, layers: Value| {
        let find = pr.units.iter().flat_map(|u| u.cu_pads.iter().zip(&u.pad_copper_layers));
        let (_, found) = find.into_iter().find(|(p, l)| p.1 == kind && serde_json::to_value(l).unwrap() == layers).unwrap();
        found.clone()
    };
    let cases = [(of_kind("pth", json!(["F.Cu", "B.Cu"])), true), (of_kind("smd", json!(["F.Cu"])), false)];
    for (layers, bad) in cases {
        let unit = json!({"name": "fixture", "refs": ["fixture"], "fixed": false, "x": 10.0, "y": 10.0, "rects": [[-1.0, -1.0, 1.0, 1.0, 0.0]], "pad_rects": [[-0.5, -0.5, 0.5, 0.5]], "pad_copper_layers": [layers]});
        let lock = json!({"outline": [[0, 0], [20, 0], [20, 20], [0, 20]], "keepouts": [], "fixed_copper_layers": [["B.Cu", 9.0, 10.0, 11.0, 10.0, 0.2]]});
        let problem = common::problem(json!([unit]), json!([]), lock);
        assert_eq!(common::legal_penalty(&problem, &Params::default(), 0) > 0.0, bad);
    }
}

#[test]
fn locked_via_rows_record_the_actual_layer_span() {
    let mut board = buck();
    board.copper_layers = ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"].map(String::from).to_vec();
    let spans = [("through", (10.0, 10.0), vec!["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"]), ("blind", (12.0, 10.0), vec!["F.Cu", "In1.Cu"])];
    for (id, at, layers) in &spans {
        let mut via = common::board::via(id, "", *at);
        locked(&mut via);
        if let Copper::Via(v) = &mut via {
            v.layers = layers.iter().map(|l| l.to_string()).collect();
        }
        board.copper.push(via);
    }
    let fx = Fixture::new(board);
    let pr = fx.read(&plain());
    for (_, (x, y), layers) in &spans {
        let rows: Vec<&str> = pr.board.fixed_copper_layers.iter().filter(|r| (r.1, r.2, r.3, r.4) == (*x, *y, *x, *y)).map(|r| r.0.as_str()).collect();
        assert_eq!(rows, *layers);
    }
    assert!(pr.board.fixed_copper_layers.iter().all(|r| r.0 != "via"));
}

#[test]
fn a_connector_staged_wholly_outside_the_outline_is_movable() {
    let mut board = buck();
    let j1 = board.footprints.iter_mut().find(|f| f.reference == "J1").unwrap();
    let shift = Pt::new(0, 100_000_000);
    j1.position = j1.position + shift;
    for ring in j1.courtyard_front.iter_mut().map(|c| &mut c.outline) {
        ring.iter_mut().for_each(|p| *p = *p + shift);
    }
    for pad in &mut j1.pads {
        pad.position = pad.position + shift;
        pad.bbox.top += shift.y;
        pad.bbox.bottom += shift.y;
    }
    let pr = Fixture::new(board).read(&plain());
    assert!(!is_fixed(&pr, "J1"));
    assert!(is_fixed(&pr, "J2"), "the other stays at the edge");
}

#[test]
fn a_pad_of_a_net_class_with_a_larger_clearance_gets_its_own_spacing_rect() {
    let mut board = buck();
    set_class(&mut board, "/VIN", "HV");
    let mut classes = default_classes();
    classes.push(class("HV", 2.5, 0.25));
    let fx = Fixture::with(board, &classes, None);
    let pr = fx.read(&plain());
    let u = &pr.units[unit_of(&pr, "U1")];
    assert_eq!(u.rects[0][4], 1.0, "the courtyard keeps the D-040 class");
    let pads = pads_on(&fx, "U1", "/VIN");
    let hv: Vec<Vec<f64>> = u.rects.iter().filter(|r| r[4] == 2.5).map(|r| rounded_row(r, 2)).collect();
    assert_eq!(hv.len(), pads.len(), "the mains rule is pad to copper, not courtyard to courtyard");
    let hard: Vec<usize> = u.rects.iter().enumerate().filter(|(_, r)| r[4] == 2.5).map(|(k, _)| k).collect();
    let mut got = u.hard.clone();
    got.sort_unstable();
    assert_eq!(got, hard, "DRC enforces it");
    let b = iotplace::kicad::doc::RectMm::mm(pads[0].bbox);
    assert!(hv.contains(&rounded_row(&[b.x0 - u.x, b.y0 - u.y, b.x1 - u.x, b.y1 - u.y, 2.5], 2)));
}

#[test]
fn each_net_gets_the_track_of_its_net_class() {
    let mut board = buck();
    set_class(&mut board, "/VIN", "P24");
    let mut classes = default_classes();
    classes.push(class("P24", 0.3, 0.5));
    let fx = Fixture::with(board, &classes, None);
    let pr = fx.read(&plain());
    let mut tracks: BTreeMap<&str, f64> = pr.nets.iter().map(|n| (n.name.as_str(), n.track)).collect();
    within(tracks.remove("/VIN").unwrap(), 0.8, 1e-9);
    assert!(!tracks.is_empty());
    for (net, track) in tracks {
        let want = if fx.board.net_class(net) == "POWER" { 0.8 } else { 0.45 };
        within(track, want, 1e-9);
    }
}

#[test]
fn the_track_clearance_takes_the_larger_dru_class_gap() {
    let classes = [class("Default", 0.2, 0.2), class("MAINS_K1", 1.0, 2.0)];
    let fx = Fixture::with(buck(), &classes, None);
    let domains = [("MAINS_K*".to_string(), 8.0, 3.0)];
    let project = fx.project(Some(&domains));
    let tracks = project.class_tracks();
    within(tracks["MAINS_K1"], 5.0, 1e-9); // the gap between two classes of the domain
    within(tracks["Default"], 0.4, 1e-9);
    within(fx.project(None).class_tracks()["MAINS_K1"], 3.0, 1e-9);
}

#[test]
fn domain_pads_get_domain_rects_and_the_part_courtyard_holds_no_pad() {
    let mut board = buck();
    set_class(&mut board, "/VIN", "MAINS_K1");
    let mut classes = default_classes();
    classes.push(class("MAINS_K1", 0.2, 0.25));
    let fx = Fixture::with(board, &classes, None);
    let pr = fx.read(&Options { domains: Some(vec![("MAINS_K*".to_string(), 8.0, 3.0)]), ..plain() });
    let u = &pr.units[unit_of(&pr, "U1")];
    assert_eq!(u.dom.len(), pads_on(&fx, "U1", "/VIN").len());
    assert_eq!(u.dom.iter().map(|d| (d.1, d.2.to_bits())).collect::<HashSet<_>>(), HashSet::from([(1, 3.0f64.to_bits())]));
    assert!(u.dom.iter().all(|d| u.rects[d.0][4] == 8.0));
    assert!(u.mech.contains(&0), "the courtyard: its pads have their own rects");
    let net_pads = fx.fp("U1").pads.iter().filter(|p| !p.net.is_empty()).count();
    assert_eq!(u.rects.len(), 1 + net_pads);
    let mut indices: Vec<usize> = u.hard.iter().copied().chain(u.dom.iter().map(|d| d.0)).collect();
    indices.sort_unstable();
    assert_eq!(indices, (1..=net_pads).collect::<Vec<_>>());
    assert!(pr.units[unit_of(&pr, "R2")].dom.is_empty());
    assert_eq!(pr.units[unit_of(&pr, "H3")].mech, [0], "a mounting hole: no net pad");
}

#[test]
fn domain_and_hole_rules_come_from_the_board_dru() {
    let mut board = buck();
    // R2 sits between /FB and /VOUT; a net of two classes reads as 'HB,POWER'.
    for (net, name) in [("/VIN", "MAINS_K1"), ("/FB", "FB"), ("/VOUT", "HB,POWER")] {
        set_class(&mut board, net, name);
    }
    let mut classes = default_classes();
    classes.extend(["MAINS_K1", "FB", "HB"].map(|c| class(c, 0.2, 0.25)));
    let dru = "(version 1)\n\
        (rule \"M\" (condition \"A.NetClass == 'MAINS_K*' && B.NetClass != 'MAINS_K*'\") (constraint clearance (min 8mm)))\n\
        (rule \"H\" (condition \"A.NetClass == 'MAINS_K*' && B.Type == 'Pad' && B.Reference == 'H3'\") (constraint hole_clearance (min 9.65mm)))\n\
        (rule \"X\" (condition \"A.NetClass == 'FB' && B.NetClass == 'HB'\") (constraint clearance (min 4mm)))\n\
        (rule \"Odd\" (condition \"A.NetClass == 'FB' || B.Layer == 'F.Cu'\") (constraint clearance (min 1mm)))\n";
    let fx = Fixture::with(board, &classes, Some(dru));
    let pr = fx.read(&plain());
    let gaps = pr.class_gaps.as_ref().unwrap();
    let id: BTreeMap<&str, usize> = gaps.names.iter().enumerate().map(|(k, n)| (n.split(',').next().unwrap(), k)).collect();
    let u = &pr.units[unit_of(&pr, "U1")];
    let mains: Vec<f64> = u.dom.iter().filter(|d| d.1 == id["MAINS_K1"] as i64).map(|d| u.rects[d.0][4]).collect();
    assert!(!mains.is_empty() && mains.iter().all(|g| *g == 8.0));
    let h = &pr.units[unit_of(&pr, "H3")];
    assert_eq!(h.dom.iter().map(|d| (d.1, d.2)).collect::<Vec<_>>(), [(-1, 9.65)]);
    assert_eq!(pr.dru_ignored, ["Odd"]);
    assert_eq!(id.keys().filter(|n| !n.is_empty()).copied().collect::<BTreeSet<_>>(), BTreeSet::from(["FB", "HB", "MAINS_K1"]));
    assert_eq!(gaps.gaps[id["FB"]][id["HB"]], 4.0, "the pair rule (barrier)");
    assert_eq!(gaps.gaps[id["HB"]][id["FB"]], 4.0);
    assert_eq!(gaps.gaps[id["MAINS_K1"]][id["FB"]], 8.0, "mains to every other net");
    let r2 = &pr.units[unit_of(&pr, "R2")];
    assert_eq!(r2.dom.iter().map(|d| d.1).collect::<BTreeSet<_>>(), BTreeSet::from([id["FB"] as i64, id["HB"] as i64]));
    let none = fx.read(&Options { domains: Some(Vec::new()), ..plain() });
    assert!(none.units[unit_of(&none, "U1")].dom.is_empty());
}

#[test]
fn reader_units_fixed_parts_and_nets() {
    let fx = Fixture::new(buck());
    let pr = fx.read(&plain());
    assert_eq!(pr.units.iter().map(|u| u.refs.len()).sum::<usize>(), fx.board.footprints.len());
    for r in ["H3", "H4", "H5", "J1"] {
        assert!(is_fixed(&pr, r), "{r}");
    }
    assert!(!is_fixed(&pr, "U1"));
    assert!(pr.nets.iter().all(|n| n.name != "GND"), "skipped by default");
    for n in &pr.nets {
        assert!(n.pins.iter().map(|p| p.0).collect::<BTreeSet<_>>().len() >= 2);
    }
    let u = &pr.units[unit_of(&pr, "U1")];
    assert_eq!(u.rects[0][4], 1.0, "IC spacing class");
    let pads = &fx.fp("U1").pads;
    assert_eq!(u.pads.len(), pads.len(), "pin RUDY points");
    let (qx, qy) = (pads[0].position.x as f64 / 1e6, pads[0].position.y as f64 / 1e6);
    assert!(u.pads.iter().any(|p| (p[0] + u.x - qx).abs() <= 1e-3 && (p[1] + u.y - qy).abs() <= 1e-3));
    assert_eq!(pr.units[unit_of(&pr, "R2")].rects[0][4], 0.5);
}

#[test]
fn tie_joins_small_parts_next_to_an_ic() {
    let fx = Fixture::new(buck());
    let loose = fx.read(&Options { tie: 0.0, ..plain() });
    assert_eq!(loose.units[unit_of(&loose, "U1")].refs, ["U1"]);
    let pr = fx.read(&Options { tie: 1.5, ..plain() });
    let refs = &pr.units[unit_of(&pr, "U1")].refs;
    assert!(refs.len() > 1);
    let u1 = fx.fp("U1");
    let ic = fp_rect(u1);
    let ic_nets: HashSet<&str> = u1.pads.iter().map(|p| p.net.as_str()).filter(|n| !n.is_empty() && *n != "GND").collect();
    for fp in fx.board.footprints.iter().filter(|f| f.reference != "U1") {
        let c = fp_rect(fp);
        let gap = (ic.x0 - c.x1).max(c.x0 - ic.x1).max(ic.y0 - c.y1).max(c.y0 - ic.y1);
        let shared = fp.pads.iter().any(|p| ic_nets.contains(p.net.as_str()));
        if fp.pads.len() <= 3 && gap <= 1.5 && shared && !is_fixed(&pr, &fp.reference) {
            assert!(refs.contains(&fp.reference), "{}", fp.reference);
        }
    }
    assert!(refs.contains(&"R3".to_string()));
    assert!(!refs.contains(&"R4".to_string()), "R4 shares only GND, a skipped net");
    refs.iter().for_each(|r| assert!(!is_fixed(&loose, r)));
}

#[test]
fn rigid_switch_net_makes_one_hot_loop_unit() {
    let pr = Fixture::new(buck()).read(&Options { rigid_nets: vec!["*SW*".to_string()], ..plain() });
    let refs = &pr.units[unit_of(&pr, "U1")].refs;
    for r in ["L1", "D3", "C4"] {
        assert!(refs.contains(&r.to_string()), "every part on /SW: {r}");
    }
}

#[test]
fn rigid_net_without_an_inductor_is_not_a_switch_node() {
    // /EN matches the pattern but has no inductor pad (as SWDIO/SWCLK match *SW* on MC-MAIN).
    let fx = Fixture::new(buck());
    let pr = fx.read(&Options { rigid_nets: vec!["/EN".to_string()], ..plain() });
    let refs = &pr.units[unit_of(&pr, "U1")].refs;
    let on_en: Vec<&str> = fx.board.pads().filter(|(f, p)| p.net == "/EN" && f.reference != "U1").map(|(f, _)| f.reference.as_str()).collect();
    assert!(!on_en.is_empty());
    assert!(on_en.iter().all(|r| !refs.iter().any(|x| x == r)));
}

#[test]
fn decap_tie_joins_caps_near_an_ic_power_pin_and_reports_distance() {
    let fx = Fixture::new(buck());
    let pr = fx.read(&Options { decap_tie: 3.0, ..plain() });
    let refs = &pr.units[unit_of(&pr, "U1")].refs;
    let seen: BTreeMap<&str, (&str, f64)> = pr.decaps.iter().map(|d| (d.0.as_str(), (d.1.as_str(), d.2))).collect();
    let u1 = fx.fp("U1");
    let mut near_pins = 0;
    for fp in fx.board.footprints.iter().filter(|f| f.reference.starts_with('C') && f.pads.len() == 2) {
        let Some(power) = fp.pads.iter().find(|p| p.net != "GND") else { continue };
        if !fp.pads.iter().any(|p| p.net == "GND") {
            continue;
        }
        let pins: Vec<&Pad> = u1.pads.iter().filter(|p| p.net == power.net).collect();
        let Some(gap) = pins.iter().map(|pin| pad_gap(power, pin)).reduce(f64::min) else { continue };
        if gap <= 3.0 {
            near_pins += 1;
            assert!(refs.contains(&fp.reference));
            assert_eq!(seen[fp.reference.as_str()].0, "U1");
            within(seen[fp.reference.as_str()].1, gap, 5e-4);
        }
    }
    assert_eq!(near_pins, 1);
    assert!(seen.contains_key("C1") && !seen.contains_key("C2"));
}

#[test]
fn test_points_move_freely_and_are_left_out_of_the_cost() {
    // A fixed test point blocked U1 on MC-MAIN; a test point keeps only its courtyard (spacing 0).
    let mut board = buck();
    board.footprints.iter_mut().find(|f| f.reference == "R3").unwrap().reference = "TP1".to_string();
    let fx = Fixture::new(board);
    let tied = fx.read(&Options { tie: 1.5, ..plain() });
    assert_eq!(tied.units[unit_of(&tied, "TP1")].refs, ["TP1"], "no tie takes a test point");
    let pr = fx.read(&plain());
    let i = unit_of(&pr, "TP1");
    let u = &pr.units[i];
    assert!(!u.fixed);
    assert_eq!(u.rects.iter().map(|r| r[4]).collect::<Vec<_>>(), [0.0]);
    assert!(u.pads.is_empty());
    assert!(!pr.nets.iter().any(|n| n.pins.iter().any(|q| q.0 == i)));
}

#[test]
fn units_carry_their_pad_boxes_for_the_copper_obstacle_check() {
    let fx = Fixture::new(buck());
    let pr = fx.read(&plain());
    let u = &pr.units[unit_of(&pr, "U1")];
    let boxes = u.pad_rects.as_ref().unwrap();
    let pads = unit_pads(&fx, &u.refs);
    assert_eq!(boxes.len(), pads.len());
    for p in pads {
        let (x, y) = (p.position.x as f64 / 1e6 - u.x, p.position.y as f64 / 1e6 - u.y);
        assert!(boxes.iter().any(|r| r[0] <= x && x <= r[2] && r[1] <= y && y <= r[3]));
    }
}

#[test]
fn lone_stitching_vias_are_not_kept_copper() {
    // A via-only cluster (a stitching via to a zone) is no obstacle: the writer removes it where a part lands.
    let pr = Fixture::new(buck()).read(&plain());
    assert!(!pr.board.copper.iter().any(|c| c.0 == "via" && (c.1 - 150.0).abs() <= 1e-3 && (c.2 - 110.0).abs() <= 1e-3));
    assert!(pr.board.copper.iter().any(|c| c.0 == "via"), "a via of a routed cluster stays");
}

#[test]
fn named_rule_areas_are_board_keepouts() {
    let mut board = buck();
    board.zones.push(rule_area("ZZ9_KEEPOUT", &["F.Cu"], (100.0, 100.0, 102.0, 102.0), RuleArea { tracks: true, ..ANY_RULE }));
    let fx = Fixture::new(board);
    let named = fx.read(&Options { keepout_zones: vec!["ZZ*".to_string()], ..plain() });
    assert_eq!(named.board.keepouts.len(), fx.read(&plain()).board.keepouts.len() + 1);
}

#[test]
fn the_courtyard_rect_is_the_courtyard_polygon_box() {
    // The points of the polygon: BBox() adds about 0.05 mm per side.
    let mut fp = footprint("R36", "Device:R", (10.0, 10.0), (9.0, 9.5, 11.0, 10.5), Vec::new());
    fp.courtyard_front[0].outline.push(common::board::pt(9.5, 11.25));
    let r = fp_rect(&fp);
    assert_eq!((r.x0, r.y0, r.x1, r.y1), (9.0, 9.5, 11.0, 11.25));
}

#[test]
fn a_round_courtyard_is_a_circle() {
    // POE TP4/TP5: boxes overlap, circles 0.015 mm apart.
    let mut board = buck();
    let tp = board.footprints.iter_mut().find(|f| f.reference == "R7").unwrap();
    tp.reference = "TP5".to_string();
    let (c, edge) = (common::board::pt(119.0, 130.0), common::board::pt(120.75, 130.0));
    tp.graphics.push(Graphic { id: "tp-court".to_string(), geometry: Geometry::Circle { center: c, radius_point: edge }, layer: "F.CrtYd".to_string(), width: 50_000, filled: false });
    let pr = Fixture::new(board).read(&plain());
    let u = &pr.units[unit_of(&pr, "TP5")];
    let &[(i, rho)] = &u.rho[..] else { panic!("one circle: {:?}", u.rho) };
    assert_eq!(rho, 1.75);
    within(u.rects[i][2] - u.rects[i][0], 2.0 * rho, 5e-4);
}

#[test]
fn a_no_footprint_area_on_the_back_only_does_not_hold_top_parts() {
    // BASE-PWR INPUT_J2_KEEPOUT.
    let mut board = buck();
    let holds = RuleArea { footprints: true, ..ANY_RULE };
    board.zones.push(rule_area("BACK", &["B.Cu"], (149.0, 106.0, 158.0, 112.0), holds));
    board.zones.push(rule_area("TOP", &["F.Cu"], (110.0, 134.0, 120.0, 139.0), holds));
    let pr = Fixture::new(board).read(&plain());
    let boxes: Vec<Vec<f64>> = pr.board.keepouts.iter().map(|k| vec![k[0][0], k[0][1]]).collect();
    assert_eq!(boxes, [vec![110.0, 134.0]]);
}

#[test]
fn the_edge_band_is_the_board_copper_to_edge_clearance() {
    let mut board = buck();
    board.graphics.push(rect_shape("block", "User.1", (135.0, 112.0, 146.0, 128.0)));
    board.texts.push(label("block-label", "SW-BLOCK", (136.0, 113.0)));
    let pr = Fixture::new(board).read(&plain());
    assert_eq!(pr.board.edge_clearance, 0.5);
    assert!(pr.units.iter().any(|u| u.pad_rects.is_none()), "the block");
    for u in pr.units.iter().filter(|u| u.pad_rects.is_none()) {
        assert!(u.edge_pads.is_some(), "{}", u.name);
    }
}

fn model_penalty(pr: &ProblemOut, fx: &Fixture, i: usize) -> f64 {
    let problem = fx.problem(pr);
    let params = Params::default();
    let model = Model::new(&problem, &params).unwrap();
    Evaluator::new(&model, &params, &problem.initial_pose()).legal_penalty(i)
}

#[test]
fn the_board_as_read_is_legal_to_the_evaluator() {
    let fx = Fixture::new(buck());
    let pr = fx.read(&plain());
    let bad: Vec<&str> = pr.units.iter().enumerate().filter(|(i, u)| !u.fixed && model_penalty(&pr, &fx, *i) > 0.0).map(|(_, u)| u.name.as_str()).collect();
    assert!(bad.is_empty(), "{bad:?}");
}

fn region(name: &str, classes: &[&str], parts: &[&str], bounds: Option<[f64; 4]>, clearance: Option<f64>) -> DomainRegion {
    DomainRegion { name: name.to_string(), classes: classes.iter().map(|c| c.to_string()).collect(), parts: parts.iter().map(|c| c.to_string()).collect(), bounds, margin: 0.0, clearance }
}

#[test]
fn a_domain_region_boxes_its_members_and_keeps_every_other_part_out_of_the_grown_box() {
    let fx = Fixture::new(buck());
    let off = fx.read(&plain());
    assert!(off.units.iter().all(|u| u.in_box.is_none() && u.out_boxes.is_empty()), "off by default");
    let off_json = serde_json::to_value(&off).unwrap();
    assert!(off_json["units"].as_array().unwrap().iter().all(|u| u.get("out_boxes").is_none()), "the default output has no new fields");
    let r = region("mains", &[], &["L1"], Some([138.0, 116.0, 146.0, 124.0]), Some(1.0));
    let pr = fx.read(&Options { domain_regions: vec![r], ..plain() });
    let l1 = &pr.units[unit_of(&pr, "L1")];
    assert_eq!(l1.in_box, Some([138.0, 116.0, 146.0, 124.0]));
    assert!(l1.out_boxes.is_empty());
    let r2 = &pr.units[unit_of(&pr, "R2")];
    assert!(r2.in_box.is_none());
    assert_eq!(r2.out_boxes, vec![[137.0, 115.0, 147.0, 125.0]]);
}

#[test]
fn members_come_from_the_net_class_of_their_pads_and_the_box_from_the_members_as_read() {
    let fx = Fixture::new(buck());
    let r = region("power", &["POWER"], &[], None, None);
    let pr = fx.read(&Options { domain_regions: vec![r], ..plain() });
    let members: Vec<&str> = pr.units.iter().filter(|u| u.in_box.is_some()).flat_map(|u| u.refs.iter().map(String::as_str)).collect();
    for m in ["L1", "R2"] {
        assert!(members.contains(&m), "{m} has a POWER pad");
    }
    assert!(!members.contains(&"C1"));
    let b = pr.units[unit_of(&pr, "L1")].in_box.unwrap();
    assert!(b[0] <= 127.0 && b[2] >= 144.5 && b[1] <= 118.5 && b[3] >= 129.0, "box {b:?} spans the members");
}

#[test]
fn a_domain_region_without_members_or_with_a_box_that_is_too_small_is_an_error() {
    let fx = Fixture::new(buck());
    let none = region("x", &["NOPE"], &[], Some([0.0, 0.0, 9.0, 9.0]), None);
    assert!(fx.read_error(&Options { domain_regions: vec![none], ..plain() }).contains("no part is a member"));
    let small = region("x", &[], &["L1"], Some([138.0, 116.0, 139.0, 124.0]), None);
    assert!(fx.read_error(&Options { domain_regions: vec![small], ..plain() }).contains("does not fit"));
}

#[test]
fn cli_read_takes_a_domain_regions_file_and_rejects_unknown_keys() {
    let fx = Fixture::new(buck());
    let file = fx.folder().join("regions.json");
    std::fs::write(&file, r#"[{"name":"mains","parts":["U1"],"clearance":0.5}]"#).unwrap();
    let v = cli_read(&fx, &["--domain-regions", file.to_str().unwrap()]).expect("read succeeds");
    assert!(v["units"].as_array().unwrap().iter().any(|u| u.get("out_boxes").is_some()));
    std::fs::write(&file, r#"[{"name":"mains","parts":["L1"],"bogus":1}]"#).unwrap();
    assert!(cli_read(&fx, &["--domain-regions", file.to_str().unwrap()]).is_none());
}

#[test]
fn domain_regions_reject_invalid_distances_and_nonfinite_boxes() {
    let fx = Fixture::new(buck());
    for value in [-1.0, f64::NAN, f64::INFINITY] {
        for field in ["margin", "clearance"] {
            let mut r = region("power", &[], &["L1"], Some([138.0, 116.0, 146.0, 124.0]), Some(0.0));
            if field == "margin" { r.margin = value } else { r.clearance = Some(value) }
            let error = fx.read_error(&Options { domain_regions: vec![r], ..plain() });
            assert!(error.contains(field) && error.contains("finite and non-negative"), "{error}");
        }
    }
    for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let r = region("power", &[], &["L1"], Some([value, 110.0, 150.0, 130.0]), Some(0.0));
        assert!(fx.read_error(&Options { domain_regions: vec![r], ..plain() }).contains("finite"));
    }
    let file = fx.folder().join("regions.json");
    for field in ["margin", "clearance"] {
        std::fs::write(&file, format!(r#"[{{"name":"power","parts":["L1"],"{field}":-1}}]"#)).unwrap();
        assert!(cli_read(&fx, &["--domain-regions", file.to_str().unwrap()]).is_none(), "negative {field}");
    }
}

#[test]
fn a_fixed_domain_member_must_already_be_inside_its_box() {
    let fx = Fixture::new(buck());
    let fixed = vec!["L1".to_string()];
    let r = region("power", &[], &["L1"], Some([110.0, 105.0, 120.0, 115.0]), Some(0.0));
    let error = fx.read_error(&Options { fix: fixed.clone(), domain_regions: vec![r], ..plain() });
    assert!(error.contains("fixed part L1") && error.contains("outside"), "{error}");
    let r = region("power", &[], &["L1"], Some([138.0, 116.0, 146.0, 124.0]), Some(0.0));
    let pr = fx.read(&Options { fix: fixed, domain_regions: vec![r], ..plain() });
    assert!(pr.units[unit_of(&pr, "L1")].fixed);
}

#[test]
fn a_region_infers_clearance_from_classes_matching_both_patterns() {
    let fx = Fixture::new(buck());
    let r = region("power", &["P[O]WER"], &[], None, None);
    let pr = fx.read(&Options { domains: Some(vec![("PO[W]ER".to_string(), 0.5, 0.3)]), domain_regions: vec![r], ..plain() });
    let b = pr.units[unit_of(&pr, "L1")].in_box.unwrap();
    let out = &pr.units[unit_of(&pr, "C1")].out_boxes;
    assert_eq!(out, &vec![[b[0] - 0.5, b[1] - 0.5, b[2] + 0.5, b[3] + 0.5]]);
}

#[test]
fn a_domain_member_can_fit_its_box_after_a_quarter_turn() {
    let fx = Fixture::new(buck());
    let r = region("power", &[], &["L1"], Some([140.0, 117.0, 144.0, 123.0]), Some(0.0));
    let pr = fx.read(&Options { domain_regions: vec![r], ..plain() });
    let i = unit_of(&pr, "L1");
    let problem = fx.problem(&pr);
    let p = Params::default();
    let model = Model::new(&problem, &p).unwrap();
    let mut ev = Evaluator::new(&model, &p, &problem.initial_pose());
    assert!(ev.forbidden_area(i) > 0.0, "the initial 5 x 3 mm courtyard does not fit the 4 x 6 mm box");
    ev.propose(&[(i, (142.0, 120.0, 1))]);
    within(ev.forbidden_area(i), 0.0, 1e-9);
}
