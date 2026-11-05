use super::board_edit::*;
use super::report::Json;
use super::*;
use crate::kicad::board::{RoutedCopper, Track, Via};
use crate::kicad::geom::{Polygon, Pt, Rect};
use crate::kicad::raw::parse;
use crate::plan::{Keepout, KeepoutMode, Pour, PourConnection, PourShape, WidthRule};
use serde_json::json;
use std::collections::BTreeMap;
use std::os::unix::fs::PermissionsExt;

fn args(text: &[&str]) -> Vec<String> {
    text.iter().map(|s| s.to_string()).collect()
}

fn folder(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("route-run-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn stage() -> Stage {
    let config = json!({"schema": plan::SCHEMA, "backend": "fastroute", "layers": ["F.Cu", "B.Cu"], "stages": [{"name": "main"}]});
    plan::load(&config, &["F.Cu".to_string(), "B.Cu".to_string()], None).unwrap().stages.remove(0)
}

fn square(x: i64, y: i64, side: i64) -> Polygon {
    Polygon::of_ring(vec![Pt::new(x, y), Pt::new(x + side, y), Pt::new(x + side, y + side), Pt::new(x, y + side)])
}

fn board(copper: Vec<RoutedCopper>) -> Board {
    Board {
        path: String::new(),
        copper_layers: vec!["F.Cu".to_string(), "B.Cu".to_string()],
        stackup: Vec::new(),
        nets: BTreeMap::from([("GND".to_string(), "Default".to_string())]),
        footprints: Vec::new(),
        copper,
        zones: Vec::new(),
        graphics: Vec::new(),
        texts: Vec::new(),
        groups: Vec::new(),
        constraints: Default::default(),
        edges_bbox: Rect { left: 0, top: 0, right: 30_000_000, bottom: 30_000_000 },
        outlines: vec![square(0, 0, 30_000_000)],
    }
}

fn track(id: &str, from: (i64, i64), to: (i64, i64), width: i64, layer: &str) -> RoutedCopper {
    RoutedCopper::Track(Track { id: id.to_string(), start: Pt::new(from.0, from.1), end: Pt::new(to.0, to.1), mid: None, width, layer: layer.to_string(), net: "GND".to_string(), locked: false })
}

fn via(id: &str, at: (i64, i64)) -> RoutedCopper {
    RoutedCopper::Via(Via { id: id.to_string(), at: Pt::new(at.0, at.1), size: 600_000, drill: 300_000, net: "GND".to_string(), locked: false, layers: Vec::new() })
}

fn pour(shape: PourShape) -> Pour {
    Pour {
        name: "P".to_string(),
        net: "GND".to_string(),
        layer: "B.Cu".to_string(),
        shape,
        grow_mm: (shape == PourShape::Around).then_some(1.0),
        priority: 0,
        connection: PourConnection::Thermal,
        minus: Vec::new(),
        clearance_mm: 0.25,
        thermal_gap_mm: 0.3,
        spoke_mm: 0.4,
    }
}

fn keepout(mode: KeepoutMode, bounds: [f64; 4], layers: &[&str]) -> Keepout {
    Keepout { name: "K".to_string(), mode, bounds, layers: layers.iter().map(|l| l.to_string()).collect() }
}

#[test]
fn the_command_line_reads_as_argparse_does() {
    let parsed = Options::parse(&args(&["B", "out", "--input=p.kicad_pcb", "--config", "c.json", "--backend", "tracemaker"])).unwrap().unwrap();
    assert_eq!(parsed, Options { board: "B".into(), outdir: "out".into(), input: Some("p.kicad_pcb".into()), config: "c.json".into(), backend: Some(Backend::Tracemaker) });
    assert_eq!(Options::parse(&args(&["B", "out"])).unwrap().unwrap().config, "route.json");
    assert_eq!(Options::parse(&args(&["--help"])).unwrap(), None);
    for bad in [&["B"][..], &["B", "o", "x"], &["B", "o", "--backend", "nope"], &["B", "o", "--what"]] {
        assert!(Options::parse(&args(bad)).is_err(), "{bad:?}");
    }
}

#[test]
fn a_bad_command_line_exits_two() {
    assert_eq!(cli(&args(&["B"])), 2);
}

#[test]
fn a_board_config_is_gate_json_under_the_registry() {
    let root = folder("config");
    let board = root.join("hardware-design/boards/AB-1");
    fs::create_dir_all(board.join("cad")).unwrap();
    fs::write(board.join("gate.json"), r#"{"project": "cad/AB-1"}"#).unwrap();
    let (found, project) = board_config(&root, "AB-1").unwrap();
    assert_eq!(found, board);
    assert_eq!(project, fs::canonicalize(board.join("cad")).unwrap().join("AB-1"));
    assert_eq!(board_config(&root, "ab").unwrap_err(), "invalid board ID");
    assert_eq!(board_config(&root, "../X").unwrap_err(), "invalid board ID");
    assert_eq!(board_config(&root, "-A").unwrap_err(), "invalid board ID");
    fs::write(board.join("gate.json"), r#"{"project": "../../../AB-1"}"#).unwrap();
    assert_eq!(board_config(&root, "AB-1").unwrap_err(), "project escapes the board registry tree");
    fs::write(board.join("gate.json"), r#"{"project": ""}"#).unwrap();
    assert_eq!(board_config(&root, "AB-1").unwrap_err(), "gate configuration requires a project");
    fs::remove_file(board.join("gate.json")).unwrap();
    fs::write(board.join("gate.pending.json"), r#"{"project": "cad/AB-1"}"#).unwrap();
    assert!(board_config(&root, "AB-1").is_err(), "a route reads gate.json only");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_project_copy_takes_the_sidecars_it_is_told_to() {
    let dir = folder("copy");
    for name in ["a.kicad_pcb", "a.kicad_pro", "b.kicad_pcb", "b.kicad_dru"] {
        fs::write(dir.join(name), name).unwrap();
    }
    let dst = dir.join("deep/down/c.kicad_pcb");
    copy_project(&dir.join("a.kicad_pcb"), &dst, Some(&dir.join("b.kicad_pcb"))).unwrap();
    assert_eq!(fs::read_to_string(&dst).unwrap(), "a.kicad_pcb");
    assert_eq!(fs::read_to_string(dst.with_extension("kicad_dru")).unwrap(), "b.kicad_dru");
    assert!(!dst.with_extension("kicad_pro").exists());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_project_lock_leaves_with_its_board_name_only() {
    let dir = folder("lock");
    let (mine, other) = (dir.join("~a.kicad_pro.lck"), dir.join("~b.kicad_pro.lck"));
    fs::write(&mine, "").unwrap();
    fs::write(&other, "").unwrap();
    remove_project_lock(&dir.join("a.kicad_pcb"));
    assert!(!mine.exists() && other.exists());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn only_an_empty_folder_takes_a_run() {
    let dir = folder("outdir");
    let path = dir.display().to_string();
    assert_eq!(empty_outdir(&path).unwrap(), fs::canonicalize(&dir).unwrap());
    let new = dir.join("a/b").display().to_string();
    assert!(empty_outdir(&new).unwrap().is_dir());
    let error = empty_outdir(&path).unwrap_err();
    assert!(error.starts_with("route: ") && error.ends_with(" is not empty"), "{error}");
    fs::remove_dir_all(dir).unwrap();
}

/// A router script: writes the board when asked, then exits with the code.
fn fake_router(dir: &Path, code: i32, writes: bool) -> String {
    let path = dir.join(format!("router-{code}-{writes}.sh"));
    let write = if writes { "mkdir -p \"$2\"; : > \"$2/routed.kicad_pcb\"" } else { ":" };
    fs::write(&path, format!("#!/bin/sh\necho \"$ROUTE_BOARD|$ROUTE_FEATURES|$3|$4\"\n{write}\nexit {code}\n")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path.display().to_string()
}

#[test]
fn a_router_exit_of_zero_or_three_with_a_board_goes_to_the_check() {
    let dir = folder("exit");
    let work = dir.join("1-main/router");
    fs::create_dir_all(dir.join("1-main")).unwrap();
    let cases = [(0, true, true), (3, true, true), (3, false, false), (0, false, false), (1, true, false), (4, true, false)];
    for (code, writes, passes) in cases {
        let _ = fs::remove_dir_all(&work);
        let line = fake_router(&dir, code, writes);
        // SAFETY: no other test of this binary reads this variable.
        unsafe { std::env::set_var(FASTROUTE_COMMAND, &line) };
        let got = route_fastroute(&stage(), Path::new("in.kicad_pcb"), &work, "AB-1", "a=1");
        assert_eq!(got.is_ok(), passes, "{code} {writes}: {got:?}");
        if !passes {
            let error = got.unwrap_err();
            assert!(error.starts_with(&format!("route: stage main: fastroute_job exit {code}, see ")) && error.ends_with("/1-main/router.log"), "{error}");
        }
    }
    let log = fs::read_to_string(dir.join("1-main/router.log")).unwrap();
    assert!(log.starts_with(&format!("{} in.kicad_pcb {} --layers F.Cu,B.Cu --passes 60", dir.join("router-4-true.sh").display(), work.display())), "{log}");
    assert!(log.contains("AB-1|a=1|--layers|F.Cu,B.Cu\n"), "{log}");
    unsafe { std::env::remove_var(FASTROUTE_COMMAND) };
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn the_tracemaker_needs_its_binary() {
    // SAFETY: no other test of this binary reads this variable.
    unsafe { std::env::set_var("TRACEMAKER_BIN", "/no/such/tracemaker") };
    let error = route_tracemaker(&stage(), Path::new("in"), Path::new("/no/work"), &[]).unwrap_err();
    assert_eq!(error, "route: TraceMaker binary not found: /no/such/tracemaker (set TRACEMAKER_BIN)");
    unsafe { std::env::remove_var("TRACEMAKER_BIN") };
}

#[test]
fn json_is_as_python_writes_it() {
    let record = Json::object([
        ("stage", Json::text("mäin")),
        ("new", Json::number(-2i64)),
        ("failures", Json::texts::<&str>(&[])),
        ("widths", Json::Object(Vec::new())),
        ("list", Json::texts(&["a", "b"])),
        ("nested", Json::List(vec![Json::object([("k", Json::Plain(Value::Null))])])),
    ]);
    assert_eq!(record.line(), "{\"stage\": \"m\\u00e4in\", \"new\": -2, \"failures\": [], \"widths\": {}, \"list\": [\"a\", \"b\"], \"nested\": [{\"k\": null}]}");
    assert_eq!(record.indented(), "{\n \"stage\": \"m\\u00e4in\",\n \"new\": -2,\n \"failures\": [],\n \"widths\": {},\n \"list\": [\n  \"a\",\n  \"b\"\n ],\n \"nested\": [\n  {\n   \"k\": null\n  }\n ]\n}");
    assert_eq!(record.get("missing"), Json::Plain(Value::Null));
    assert_eq!(record.get("new").line(), "-2");
}

#[test]
fn an_inside_keepout_is_its_box() {
    let area = keepout_area(Rect { left: 0, top: 0, right: 1, bottom: 1 }, &keepout(KeepoutMode::Inside, [1.0, 2.0, 3.0, 4.0], &["F.Cu"])).unwrap();
    assert_eq!(area, [Polygon::of_ring(vec![Pt::new(1_000_000, 2_000_000), Pt::new(3_000_000, 2_000_000), Pt::new(3_000_000, 4_000_000), Pt::new(1_000_000, 4_000_000)])]);
}

#[test]
fn an_outside_keepout_is_the_grown_board_box_with_a_hole() {
    // ENV-SENSE: edges 100..130 with a 0.05 mm line. pcbnew saved 94.975 and 135.025 with a hole 99..131.
    let edges = Rect { left: 99_975_000, top: 99_975_000, right: 130_025_000, bottom: 130_025_000 };
    let area = keepout_area(edges, &keepout(KeepoutMode::Outside, [99.0, 99.0, 131.0, 131.0], &["F.Cu"])).unwrap();
    assert_eq!((area.len(), area[0].holes.len()), (1, 1));
    let outer = area[0].bbox().unwrap();
    assert_eq!((outer.left, outer.top, outer.right, outer.bottom), (94_975_000, 94_975_000, 135_025_000, 135_025_000));
    let text = keepout_zone(&stage(), &keepout(KeepoutMode::Outside, [99.0, 99.0, 131.0, 131.0], &["F.Cu", "B.Cu"]), &area, "seed", 0);
    assert_eq!(text.matches("(polygon").count(), 2, "{text}");
    assert!(text.contains("(xy 94.975 94.975)") && text.contains("(xy 99 99)"), "{text}");
}

#[test]
fn a_keepout_zone_allows_pads_and_footprints_only() {
    let text = keepout_zone(&stage(), &keepout(KeepoutMode::Inside, [0.0, 0.0, 1.0, 1.0], &["B.Cu"]), &[square(0, 0, 1_000_000)], "seed", 0);
    let forms = parse(&text).unwrap();
    let zone = &forms[0];
    assert_eq!(zone.children("name").next().unwrap().text(1), Some("TMP_ROUTE_main_K"));
    assert_eq!(zone.children("layer").next().unwrap().text(1), Some("B.Cu"));
    let rule = zone.children("keepout").next().unwrap();
    let say = |what: &str| rule.children(what).next().unwrap().text(1).unwrap().to_string();
    assert_eq!((say("tracks"), say("vias"), say("copperpour")), ("not_allowed".to_string(), "not_allowed".to_string(), "not_allowed".to_string()));
    assert_eq!((say("pads"), say("footprints")), ("allowed".to_string(), "allowed".to_string()));
    assert_eq!(text.matches("(net").count(), 0);
}

#[test]
fn a_pour_zone_carries_every_setting() {
    let mut p = pour(PourShape::Board);
    let thermal = pour_zone(&p, &[square(0, 0, 1_000_000)], "seed", 0);
    let forms = parse(&thermal).unwrap();
    let zone = &forms[0];
    let value = |head: &str| zone.children(head).next().unwrap().text(1).unwrap().to_string();
    assert_eq!((value("net"), value("layer"), value("name"), value("min_thickness")), ("GND".to_string(), "B.Cu".to_string(), "P".to_string(), "0.25".to_string()));
    assert!(zone.children("priority").next().is_none());
    let connect = zone.children("connect_pads").next().unwrap();
    assert_eq!(connect.text(1), None, "thermal is the default: no keyword");
    assert_eq!(connect.children("clearance").next().unwrap().text(1), Some("0.25"));
    let fill = zone.children("fill").next().unwrap();
    assert_eq!(fill.children("thermal_gap").next().unwrap().text(1), Some("0.3"));
    assert_eq!(fill.children("thermal_bridge_width").next().unwrap().text(1), Some("0.4"));
    assert_eq!(fill.children("island_removal_mode").next().unwrap().text(1), Some("0"));
    (p.connection, p.priority) = (PourConnection::Full, 2);
    let full = pour_zone(&p, &[square(0, 0, 1_000_000)], "seed", 0);
    assert!(full.contains("(priority 2)\n\t\t(connect_pads yes\n"), "{full}");
}

#[test]
fn a_pour_with_no_net_stops_the_run() {
    let p = Pour { net: "NOPE".to_string(), ..pour(PourShape::Board) };
    assert_eq!(pour_area(&board(Vec::new()), &p).unwrap_err(), "route: pour P: no net NOPE");
}

#[test]
fn a_board_pour_needs_a_closed_outline() {
    let open = Board { outlines: Vec::new(), ..board(Vec::new()) };
    assert_eq!(pour_area(&open, &pour(PourShape::Board)).unwrap_err(), "route: the board outline (Edge.Cuts) is not closed");
}

#[test]
fn a_board_pour_is_the_outline_minus_its_boxes() {
    let p = Pour { minus: vec![[10.0, 10.0, 20.0, 20.0]], ..pour(PourShape::Board) };
    let area = pour_area(&board(Vec::new()), &p).unwrap().unwrap();
    assert_eq!((area.len(), area[0].holes.len()), (1, 1));
}

#[test]
fn an_around_pour_with_no_copper_on_its_layer_is_skipped() {
    let front = board(vec![track("t", (1_000_000, 1_000_000), (2_000_000, 1_000_000), 200_000, "F.Cu")]);
    assert_eq!(pour_area(&front, &pour(PourShape::Around)).unwrap(), None);
}

#[test]
fn an_around_pour_grows_the_copper_and_stays_on_the_board() {
    let b = board(vec![track("t", (5_000_000, 100_000), (10_000_000, 100_000), 200_000, "B.Cu")]);
    let area = pour_area(&b, &pour(PourShape::Around)).unwrap().unwrap();
    let bbox = area[0].bbox().unwrap();
    // Track ends at 4.9 and 10.1 mm, grown 1 mm, within the arc errors 0.01 + 0.05 mm of a pour; the outline cuts the top.
    assert!((3_900_000..=3_960_000).contains(&bbox.left), "{bbox:?}");
    assert!((11_040_000..=11_100_000).contains(&bbox.right), "{bbox:?}");
    assert_eq!((bbox.top, bbox.bottom), (0, 1_200_000));
}

#[test]
fn an_around_pour_counts_every_via_on_any_layer() {
    let b = board(vec![via("v", (15_000_000, 15_000_000))]);
    let area = pour_area(&b, &pour(PourShape::Around)).unwrap().unwrap();
    let bbox = area[0].bbox().unwrap();
    assert!((13_700_000..=13_760_000).contains(&bbox.left), "{bbox:?}"); // 15 - 0.3 - 1 mm, within the same errors
}

#[test]
fn an_around_pour_keeps_every_shape_whatever_its_winding() {
    let items = || [track("t", (5_000_000, 5_000_000), (10_000_000, 5_000_000), 200_000, "B.Cu"), via("v", (20_000_000, 20_000_000))];
    let [t, v] = items();
    let [t2, v2] = items();
    for copper in [vec![t, v], vec![v2, t2]] {
        assert_eq!(pour_area(&board(copper), &pour(PourShape::Around)).unwrap().unwrap().len(), 2);
    }
}

#[test]
fn a_zone_file_keeps_the_first_polygon_of_a_set() {
    let (first, second) = (square(0, 0, 10), square(100, 0, 10));
    assert_eq!(saved_polygon(&[first.clone(), second]), Some(&first));
    assert_eq!(saved_polygon(&[]), None);
    let mut ring = square(0, 0, 100);
    ring.holes.push(square(20, 20, 60).outline);
    let island = square(40, 40, 10);
    assert_eq!(saved_polygon(&[ring, island.clone()]), Some(&island), "SHAPE_POLY_SET stores the island first");
}

const TRACKS: &str = "(kicad_pcb\n\t(segment\n\t\t(start 1 1)\n\t\t(end 3 1)\n\t\t(width 0.2)\n\t\t(layer \"F.Cu\")\n\t\t(uuid \"in\")\n\t)\n\t(segment\n\t\t(start 50 1)\n\t\t(end 53 1)\n\t\t(width 0.2)\n\t\t(layer \"F.Cu\")\n\t\t(uuid \"out\")\n\t)\n\t(arc\n\t\t(start 1 2)\n\t\t(mid 2 3)\n\t\t(end 3 2)\n\t\t(width 0.2)\n\t\t(layer \"F.Cu\")\n\t\t(uuid \"bow\")\n\t)\n)\n";

fn rule(name: &str, width_mm: f64) -> WidthRule {
    WidthRule { name: name.to_string(), bounds: [0.0, 0.0, 10.0, 10.0], layers: vec!["F.Cu".to_string()], width_mm }
}

fn width_board() -> Board {
    let mut bow = track("bow", (1_000_000, 2_000_000), (3_000_000, 2_000_000), 200_000, "F.Cu");
    if let RoutedCopper::Track(t) = &mut bow {
        t.mid = Some(Pt::new(2_000_000, 3_000_000));
    }
    board(vec![track("in", (1_000_000, 1_000_000), (3_000_000, 1_000_000), 200_000, "F.Cu"), track("out", (50_000_000, 1_000_000), (53_000_000, 1_000_000), 200_000, "F.Cu"), bow, via("v", (2_000_000, 2_000_000))])
}

#[test]
fn a_width_rule_narrows_tracks_and_arcs_by_their_midpoint() {
    let mut b = width_board();
    let (text, counts) = set_widths(TRACKS, &mut b, &[rule("R", 0.15)]).unwrap();
    assert_eq!(counts, [("R".to_string(), 2)]);
    assert_eq!(text.matches("(width 0.15)").count(), 2);
    assert_eq!(text.matches("(width 0.2)").count(), 1);
    assert!(text.contains("(end 53 1)\n\t\t(width 0.2)"), "{text}");
    assert_eq!(b.tracks().map(|t| t.width).collect::<Vec<_>>(), [150_000, 200_000, 150_000]);
}

#[test]
fn a_width_rule_never_widens_and_a_later_rule_sees_the_earlier_one() {
    let mut b = width_board();
    let (_, counts) = set_widths(TRACKS, &mut b, &[rule("WIDE", 0.3), rule("A", 0.15), rule("B", 0.18), rule("A", 0.1)]).unwrap();
    assert_eq!(counts, [("WIDE".to_string(), 0), ("A".to_string(), 4), ("B".to_string(), 0)]);
}

#[test]
fn a_board_and_text_that_disagree_stop_the_width_edit() {
    let mut b = board(vec![track("elsewhere", (1_000_000, 1_000_000), (3_000_000, 1_000_000), 200_000, "F.Cu")]);
    assert_eq!(set_widths(TRACKS, &mut b, &[rule("R", 0.15)]).unwrap_err(), "route: the width rules change 1 tracks of the board and 2 of its text");
}

#[test]
fn a_repeated_uuid_does_not_move_a_width_edit() {
    // Two stages of the Fastroute job gave tracks the same uuid (ENV-SENSE, 2026-11-04): only the track in the box narrows.
    let text = TRACKS.replace("\"out\"", "\"in\"");
    let mut b = board(vec![track("in", (1_000_000, 1_000_000), (3_000_000, 1_000_000), 200_000, "F.Cu"), track("in", (50_000_000, 1_000_000), (53_000_000, 1_000_000), 200_000, "F.Cu")]);
    let rules = [WidthRule { bounds: [0.0, 0.0, 10.0, 1.5], ..rule("R", 0.15) }];
    let (out, counts) = set_widths(&text, &mut b, &rules).unwrap();
    assert_eq!(counts, [("R".to_string(), 1)]);
    assert!(out.contains("(end 3 1)\n\t\t(width 0.15)") && out.contains("(end 53 1)\n\t\t(width 0.2)"), "{out}");
}

const ROUTED: &str = "(kicad_pcb\n\t(layers\n\t\t(0 \"F.Cu\" signal)\n\t)\n\t(segment\n\t\t(start 0 0)\n\t\t(end 1 0)\n\t\t(uuid \"old\")\n\t)\n\t(segment\n\t\t(start 1 0)\n\t\t(end 2 0)\n\t\t(uuid \"new-other\")\n\t)\n\t(via\n\t\t(at 2 0)\n\t\t(uuid \"new-kept\")\n\t)\n\t(zone\n\t\t(uuid \"z1\")\n\t\t(name \"TMP_ROUTE_main_A\")\n\t)\n\t(zone\n\t\t(uuid \"z2\")\n\t\t(name \"KEEP\")\n\t)\n)\n";

fn zone(name: &str) -> crate::kicad::board::Zone {
    crate::kicad::board::Zone { id: String::new(), name: name.to_string(), net: String::new(), layers: Vec::new(), outline: Vec::new(), filled: Vec::new(), rule_area: None, fill: None }
}

#[test]
fn only_the_stage_keepouts_leave_the_routed_board() {
    let routed = Board { zones: vec![zone("TMP_ROUTE_main_A"), zone("KEEP")], ..board(Vec::new()) };
    let text = without_keepouts(ROUTED, &routed).unwrap();
    assert!(!text.contains("TMP_ROUTE_") && text.contains("\"KEEP\"") && parse(&text).is_ok(), "{text}");
    assert_eq!(without_keepouts(ROUTED, &board(Vec::new())).unwrap(), ROUTED);
}

#[test]
fn tracemaker_copper_of_other_nets_is_dropped_new_items_only() {
    let mut other = track("new-other", (1, 0), (2, 0), 1, "F.Cu");
    if let RoutedCopper::Track(t) = &mut other {
        t.net = "OTHER".to_string();
    }
    let mut old = track("old", (0, 0), (1, 0), 1, "F.Cu");
    if let RoutedCopper::Track(t) = &mut old {
        t.net = "OTHER".to_string();
    }
    let routed = board(vec![old, other, via("new-kept", (2, 0))]);
    let before = HashSet::from(["old"]);
    let kept = BTreeSet::from(["GND"]);
    let (text, dropped) = drop_other_nets(ROUTED.to_string(), &routed, &before, &kept, "seed").unwrap();
    assert_eq!(dropped, 1);
    assert!(!text.contains("new-other") && text.contains("\"old\"") && text.contains("new-kept"), "{text}");
}

#[test]
fn an_item_the_text_does_not_hold_stops_the_drop() {
    let routed = board(vec![via("made-up-by-reader", (2, 0))]);
    let error = drop_other_nets(ROUTED.to_string(), &routed, &HashSet::new(), &BTreeSet::new(), "seed").unwrap_err();
    assert!(error.contains("made-up-by-reader"), "{error}");
}

#[test]
fn a_stage_counts_its_vias_by_kept_net() {
    let b = board(vec![via("a", (0, 0)), via("b", (1, 0))]);
    assert_eq!(vias_on(&b, &BTreeSet::from(["GND"])), 2);
    assert_eq!(vias_on(&b, &BTreeSet::from(["OTHER"])), 0);
    assert_eq!(copper_ids(&b).len(), 2);
}

fn report(errors: usize, opens: usize, parity: usize) -> Value {
    let violation = json!({"severity": "error", "type": "clearance"});
    let open = json!({"items": [{"description": "Pad [GND]"}, {"description": "Track [GND]"}]});
    json!({
        "violations": (0..errors).map(|_| violation.clone()).chain([json!({"severity": "warning", "type": "silk"})]).collect::<Vec<_>>(),
        "unconnected_items": (0..opens).map(|_| open.clone()).collect::<Vec<_>>(),
        "schematic_parity": (0..parity).map(|_| json!({})).collect::<Vec<_>>(),
    })
}

#[test]
fn a_clean_final_drc_has_no_failure_and_warnings_do_not_count() {
    let (fields, failure) = final_fields(&report(0, 0, 0), Path::new("/o/B.kicad_pcb"), vec![("R".to_string(), 3)], 3, &["S".to_string()]).unwrap();
    assert_eq!(failure, None);
    let result = Json::object(fields);
    assert_eq!(result.line(), r#"{"widths": {"R": 3}, "board_file": "/o/B.kicad_pcb", "pours": 2, "skipped_pours": ["S"], "drc_errors": 0, "unconnected": 0, "parity": 0, "error_types": []}"#);
}

#[test]
fn any_error_open_or_parity_item_fails_the_run() {
    for (errors, opens, parity) in [(1, 0, 0), (0, 1, 0), (0, 0, 1)] {
        let (fields, failure) = final_fields(&report(errors, opens, parity), Path::new("b"), Vec::new(), 0, &[]).unwrap();
        assert_eq!(failure.unwrap(), format!("final DRC: {errors} errors, {opens} unconnected, {parity} parity"));
        assert_eq!(Json::object(fields).get("error_types"), Json::texts(&if errors > 0 { vec!["clearance"] } else { vec![] }));
    }
}

#[test]
fn a_full_open_list_is_no_count() {
    assert!(final_fields(&report(0, plan::DRC_UNCONNECTED_CAP, 0), Path::new("b"), Vec::new(), 0, &[]).unwrap_err().contains("count unknown"));
}
