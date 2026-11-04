//! The binary against real KiCad on a tiny board: what no unit test can show. A test returns early, saying so, on a host without
//! kicad-cli, or without the pinned API server for the tests that read a board. CI's job image has both.
//!
//! Board 40 x 35 mm, F.Cu / B.Cu. ISO1 (class ISO) joins two pads past an OTH1 pad (class OTH) that sits 0.1 mm from the straight
//! line; ISO2 joins two pads past a DEF1 pad (class Default). DRU: 'G' ISO-OTH clearance 1.5 mm, 'C' ISO-Default creepage 2.0 mm,
//! class clearance 0.2 mm. With the model's pair table the route is DRC-clean; with the table taken out, KiCad reports rule G and
//! rule C on the route. So the distances the router keeps are the ones KiCad checks.
use iotroute::kicad::kicad_cli;
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU32, Ordering};

const EXE: &str = env!("CARGO_BIN_EXE_iotroute");
const DRU: &str = r#"(version 1)
(rule "G" (condition "A.NetClass == 'ISO' && B.NetClass == 'OTH'") (constraint clearance (min 1.5mm)))
(rule "C" (condition "A.NetClass == 'ISO' && B.NetClass == 'Default'") (constraint creepage (min 2.0mm)))
"#;
const PADS: [(&str, &str, f64, f64); 6] = [("P1", "ISO1", 5.0, 10.0), ("P2", "ISO1", 25.0, 10.0), ("Q1", "OTH1", 15.0, 10.6), ("P3", "ISO2", 5.0, 25.0), ("P4", "ISO2", 25.0, 25.0), ("R1", "DEF1", 15.0, 25.6)];
const LAYERS: &str = r#"(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (13 "F.Paste" user) (15 "B.Paste" user) (5 "F.SilkS" user "f.silkscreen") (7 "B.SilkS" user "b.silkscreen") (1 "F.Mask" user) (3 "B.Mask" user) (25 "Edge.Cuts" user) (27 "Margin" user) (31 "F.CrtYd" user "F.Courtyard") (29 "B.CrtYd" user "B.Courtyard") (35 "F.Fab" user) (33 "B.Fab" user))"#;

static NEXT: AtomicU32 = AtomicU32::new(0);

struct Folder(PathBuf);

impl Folder {
    fn new() -> Folder {
        let path = std::env::temp_dir().join(format!("iotroute-flow-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&path).unwrap();
        Folder(path)
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn on_path(program: &str) -> bool {
    Command::new(program).arg("version").output().is_ok()
}

/// A numbered uuid: the same text every time, so the board is the same input.
fn uuid(n: &mut u32) -> String {
    *n += 1;
    format!("00000000-0000-4000-8000-{:012x}", *n)
}

fn board_text(tracks: &str) -> String {
    let mut n = 0;
    let mut text = format!("(kicad_pcb\n(version 20260206)\n(generator \"pcbnew\")\n(generator_version \"10.0\")\n(general (thickness 1.6) (legacy_teardrops no))\n(paper \"A4\")\n{LAYERS}\n(setup (pad_to_mask_clearance 0))\n");
    for (reference, net, x, y) in PADS {
        let (a, b, c, d, e) = (uuid(&mut n), uuid(&mut n), uuid(&mut n), uuid(&mut n), uuid(&mut n));
        text += &format!("(footprint \"t:{reference}\" (layer \"F.Cu\") (uuid \"{a}\") (at {x} {y})\n(property \"Reference\" \"{reference}\" (at 0 0 0) (layer \"F.Fab\") (uuid \"{b}\") (effects (font (size 1 1) (thickness 0.15))))\n(property \"Value\" \"{reference}\" (at 0 0 0) (layer \"F.Fab\") (hide yes) (uuid \"{c}\") (effects (font (size 1 1) (thickness 0.15))))\n(attr smd)\n(fp_rect (start -0.8 -0.8) (end 0.8 0.8) (stroke (width 0.05) (type solid)) (fill no) (layer \"F.CrtYd\") (uuid \"{d}\"))\n(pad \"1\" smd rect (at 0 0) (size 1 1) (layers \"F.Cu\" \"F.Mask\") (net \"{net}\") (uuid \"{e}\")))\n");
    }
    text += &format!("(gr_rect (start 0 0) (end 40 35) (stroke (width 0.05) (type default)) (fill no) (layer \"Edge.Cuts\") (uuid \"{}\"))\n{tracks})\n", uuid(&mut n));
    text
}

fn class(name: &str) -> Value {
    json!({"name": name, "clearance": 0.2, "track_width": 0.2, "via_diameter": 0.6, "via_drill": 0.3, "priority": if name == "Default" { 2147483647 } else { 1 }, "bus_width": 12, "diff_pair_gap": 0.25, "diff_pair_via_gap": 0.25, "diff_pair_width": 0.2, "line_style": 0, "microvia_diameter": 0.3, "microvia_drill": 0.1, "pcb_color": "rgba(0, 0, 0, 0.000)", "schematic_color": "rgba(0, 0, 0, 0.000)", "wire_width": 6})
}

/// The board folder: board, project, rules, gate, and the tools the model reads.
fn make_board(dir: &Path, tracks: &str) -> PathBuf {
    let pcb = dir.join("iso.kicad_pcb");
    fs::write(&pcb, board_text(tracks)).unwrap();
    let project = json!({
        "board": {"design_settings": {"rules": {"min_clearance": 0.0, "min_copper_edge_clearance": 0.3, "min_track_width": 0.15, "min_hole_clearance": 0.25, "min_hole_to_hole": 0.25, "min_via_diameter": 0.5, "min_through_hole_diameter": 0.3, "min_via_annular_width": 0.1}}},
        "meta": {"filename": "iso.kicad_pro", "version": 3},
        "net_settings": {"classes": [class("Default"), class("ISO"), class("OTH")], "meta": {"version": 4}, "netclass_patterns": [{"netclass": "ISO", "pattern": "ISO*"}, {"netclass": "OTH", "pattern": "OTH*"}]},
    });
    fs::write(dir.join("iso.kicad_pro"), serde_json::to_string_pretty(&project).unwrap()).unwrap();
    fs::write(dir.join("iso.kicad_dru"), DRU).unwrap();
    fs::write(dir.join("gate.pending.json"), r#"{"project": "iso"}"#).unwrap();
    fs::create_dir_all(dir.join("tools")).unwrap();
    fs::write(dir.join("tools/pin-ratings.json"), r#"{"parts": {}}"#).unwrap();
    pcb
}

fn iotroute(args: &[&str], cwd: &Path) -> Output {
    Command::new(EXE).args(args).current_dir(cwd).output().unwrap()
}

fn text(out: &Output) -> String {
    format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr))
}

/// Clearance and creepage violations, and unconnected items, of a board.
fn drc(pcb: &Path, report: &Path) -> (Vec<(String, String)>, usize) {
    let status = Command::new(kicad_cli()).args(["pcb", "drc", "--format", "json", "--severity-all", "-o"]).arg(report).arg(pcb).output().unwrap();
    assert!(report.is_file(), "{}", text(&status));
    let d: Value = serde_json::from_str(&fs::read_to_string(report).unwrap()).unwrap();
    let violations = d["violations"].as_array().unwrap().iter().filter(|v| matches!(v["type"].as_str(), Some("clearance" | "creepage"))).map(|v| (v["type"].as_str().unwrap().to_string(), v["description"].as_str().unwrap().to_string())).collect();
    (violations, d["unconnected_items"].as_array().map_or(0, Vec::len))
}

#[test]
fn route_and_drc_agree_on_a_pair_clearance_and_a_creepage_case() {
    if !on_path("kicad-cli-nightly") || !on_path(&kicad_cli()) {
        eprintln!("skipped: needs kicad-cli and kicad-cli-nightly");
        return;
    }
    let f = Folder::new();
    let pcb = make_board(&f.0, "");
    let model = f.0.join("model.json");
    let out = iotroute(&["model", f.0.to_str().unwrap(), "--out", model.to_str().unwrap(), "--tools", "tools"], &f.0);
    assert!(text(&out).contains("MODEL ok"), "{}", text(&out));
    let parsed: Value = serde_json::from_str(&fs::read_to_string(&model).unwrap()).unwrap();
    let states: Vec<(&str, &str, &str)> = parsed["rules"].as_array().unwrap().iter().map(|r| (r["rule"].as_str().unwrap(), r["constraint"].as_str().unwrap(), r["state"].as_str().unwrap())).collect();
    assert_eq!(states, [("G", "clearance", "applied"), ("C", "creepage", "applied")]);
    assert!(parsed.get("iso").is_some());

    let mut bare = parsed.clone();
    bare.as_object_mut().unwrap().remove("iso");
    let bare_path = f.0.join("bare.json");
    fs::write(&bare_path, bare.to_string()).unwrap();
    let mut results = Vec::new();
    for (tag, input) in [("iso", &model), ("bare", &bare_path)] {
        let route = f.0.join(format!("route-{tag}.json"));
        let done = iotroute(&[input.to_str().unwrap(), route.to_str().unwrap(), "--iters", "20"], &f.0);
        assert!(route.is_file(), "{}", text(&done));
        let written = f.0.join(format!("w-{tag}"));
        iotroute(&["write", pcb.to_str().unwrap(), route.to_str().unwrap(), written.to_str().unwrap()], &f.0);
        results.push(drc(&written.join("iso.kicad_pcb"), &f.0.join(format!("drc-{tag}.json"))));
    }
    assert_eq!(results[0], (Vec::new(), 0));
    let (violations, unconnected) = &results[1];
    assert_eq!(*unconnected, 0);
    assert!(violations.iter().any(|(t, d)| t == "clearance" && d.contains("rule 'G'")), "{violations:?}");
    assert!(violations.iter().any(|(t, d)| t == "creepage" && d.contains("rule 'C'")), "{violations:?}");
}

#[test]
fn a_locked_input_is_byte_identical_and_keeps_the_source_uuids() {
    if !on_path("kicad-cli-nightly") || !on_path(&kicad_cli()) {
        eprintln!("skipped: needs kicad-cli and kicad-cli-nightly");
        return;
    }
    let f = Folder::new();
    let tracks = "(segment (start 5 10) (end 25 10) (width 0.2) (layer \"F.Cu\") (net \"ISO1\") (uuid \"10000000-0000-4000-8000-000000000001\"))\n(segment (start 5 25) (end 25 25) (width 0.2) (layer \"B.Cu\") (net \"ISO2\") (uuid \"10000000-0000-4000-8000-000000000002\"))\n";
    let pcb = make_board(&f.0, tracks);
    let mut copies = Vec::new();
    for name in ["a", "b"] {
        let out = f.0.join(name).join("iso.kicad_pcb");
        let done = iotroute(&["lock-input", f.0.to_str().unwrap(), pcb.to_str().unwrap(), out.to_str().unwrap(), "--tools", "tools", "--nets", "ISO1"], &f.0);
        assert!(done.status.success(), "{}", text(&done));
        copies.push(fs::read(&out).unwrap());
    }
    assert_eq!(copies[0], copies[1]);
    let copy = String::from_utf8_lossy(&copies[0]);
    assert!(copy.contains("10000000-0000-4000-8000-000000000001"));
    assert!(!copy.contains("10000000-0000-4000-8000-000000000002"));
    assert!(copy.contains("(locked yes)"));
}

#[test]
fn write_gives_a_byte_identical_board() {
    if !on_path(&kicad_cli()) {
        eprintln!("skipped: needs kicad-cli");
        return;
    }
    let f = Folder::new();
    let pcb = make_board(&f.0, "");
    let tracks: Vec<Value> = (0..12).map(|i| json!({"net": "", "layer": "F.Cu", "a": [10 + i, 10], "b": [10 + i, 20], "w": 0.2})).collect();
    let vias: Vec<Value> = (0..6).map(|i| json!({"net": "", "x": 30 + i, "y": 30, "d": 0.6, "drill": 0.3})).collect();
    let result = f.0.join("r.json");
    fs::write(&result, json!({"tracks": tracks, "vias": vias}).to_string()).unwrap();
    let mut boards = Vec::new();
    for name in ["a", "b"] {
        let folder = f.0.join(name);
        iotroute(&["write", pcb.to_str().unwrap(), result.to_str().unwrap(), folder.to_str().unwrap()], &f.0);
        boards.push(fs::read(folder.join("iso.kicad_pcb")).unwrap());
    }
    assert_eq!(boards[0], boards[1]);
}

#[test]
fn an_existing_out_gives_an_error_line_and_a_record() {
    let f = Folder::new();
    let out = f.0.join("X.kicad_pcb");
    fs::write(&out, "keep").unwrap();
    let done = iotroute(&["run", "NET-CORE", out.to_str().unwrap(), "--json"], &f.0);
    assert_eq!(done.status.code(), Some(2));
    let stdout = String::from_utf8_lossy(&done.stdout).into_owned();
    let lines: Vec<&str> = stdout.lines().collect();
    assert!(lines[0].starts_with("ERROR "), "{stdout}");
    let record: Value = serde_json::from_str(lines[1]).unwrap();
    assert_eq!(record["status"], "ERROR");
    assert_eq!(fs::read_to_string(&out).unwrap(), "keep");
    assert_eq!(fs::read_dir(&f.0).unwrap().count(), 1);
}
