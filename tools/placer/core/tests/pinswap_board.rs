//! The board side of a pin swap on a small board: U1 with pads 3 (/EN), 4 (/RT), 5 (/FB) and 6 (unused), each signal with a part
//! 10 mm below it. Pads 3 and 4 are plain GPIO inputs in the test pin map; pad 5 is a fixed AF pin.

use iotplace::kicad::doc::Board;
use iotplace::pinswap::board::{Applied, MapPin, PinMap, Role, apply_swap, kind_of, read_pins};
use iotplace::pinswap::{Change, Kind, Pin};
use iotroute::kicad::sexpr::parse;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::process::Command;

const MM: i64 = 1_000_000;

fn pt(x: i64, y: i64) -> Value {
    json!({"x": x * MM, "y": y * MM})
}

fn square(x: i64, y: i64) -> Value {
    let half = MM / 2;
    let (cx, cy) = (x * MM, y * MM);
    let corner = |dx: i64, dy: i64| json!({"x": cx + dx, "y": cy + dy});
    json!({"outline": [corner(-half, -half), corner(half, -half), corner(half, half), corner(-half, half)], "holes": []})
}

fn pad(number: &str, net: &str, x: i64, y: i64) -> Value {
    json!({"id": format!("pad-{number}-{x}"), "number": number, "kind": "Smd", "shape": "Rect", "net": net, "position": pt(x, y), "orientation": 0.0,
        "size": pt(1, 1), "drill": pt(0, 0), "layers": ["F.Cu"], "bbox": {"left": 0, "top": 0, "right": 0, "bottom": 0}, "zone_connection": null,
        "thermal_spoke_angle": 90.0, "spoke_templates": 0, "copper": [], "polygons": {"F.Cu": square(x, y)}, "solder_mask_expansion": 0})
}

fn footprint(reference: &str, pads: Vec<Value>) -> Value {
    json!({"id": format!("fp-{reference}"), "reference": reference, "value": "", "lib_id": "", "layer": "F.Cu", "position": pt(0, 0), "orientation": 0.0, "locked": false,
        "fields": [], "pads": pads, "graphics": [], "zones": [], "courtyard_front": [], "courtyard_back": []})
}

fn track(id: &str, net: &str, a: (i64, i64), b: (i64, i64)) -> Value {
    json!({"Track": {"id": id, "start": pt(a.0, a.1), "end": pt(b.0, b.1), "mid": null, "width": MM / 5, "layer": "F.Cu", "net": net, "locked": false}})
}

fn document() -> Value {
    // Pad 4 is as board JSON gives a pad that shares its uuid: no polygons, its copper only.
    let mut rt = pad("4", "/RT", 12, 0);
    rt["polygons"] = json!({});
    rt["copper"] = json!([{"Circle": {"center": pt(12, 0), "radius": MM / 2}}]);
    let u1 = footprint("U1", vec![pad("3", "/EN", 10, 0), rt, pad("5", "/FB", 14, 0), pad("6", "unconnected-(U1-Pad6)", 16, 0), pad("7", "GND", 18, 0)]);
    let parts = [("R1", "/EN", 10), ("R2", "/RT", 12), ("R3", "/FB", 14), ("R4", "GND", 18)].map(|(r, net, x)| footprint(r, vec![pad("1", net, x, 10)]));
    let copper = vec![track("en-a", "/EN", (10, 0), (10, 5)), track("en-b", "/EN", (10, 5), (10, 10)), track("rt", "/RT", (12, 0), (12, 10)), track("gnd", "GND", (18, 0), (18, 10))];
    let footprints: Vec<Value> = [u1].into_iter().chain(parts).collect();
    json!({"board": {"path": "", "copper_layers": ["F.Cu"], "stackup": [], "nets": {}, "footprints": footprints, "copper": copper, "zones": [], "graphics": [],
        "edges_bbox": {"left": 0, "top": 0, "right": 0, "bottom": 0}, "outlines": []}})
}

fn board() -> Board {
    serde_json::from_value(document()["board"].clone()).unwrap()
}

fn pin(number: u32, name: &str, net: &str, function: &str, af: Value) -> Value {
    json!({"number": number, "name": name, "net": net, "function": function, "af": af, "pin_type": "FT_h", "exti": null, "note": ""})
}

fn map_json() -> Value {
    json!({"ref": "U1", "pins": [pin(3, "PD3", "EN", "GPIO in", Value::Null), pin(4, "PD4", "RT", "GPIO in", Value::Null), pin(5, "PA0", "FB", "ADC1_INP16", json!("ADC"))]})
}

fn map() -> PinMap {
    serde_json::from_value(map_json()).unwrap()
}

fn map_pin(function: &str, af: Value, exti: Value) -> MapPin {
    let mut row = pin(1, "PA1", "X", function, af);
    row["exti"] = exti;
    serde_json::from_value(row).unwrap()
}

#[test]
fn a_pin_map_row_says_what_may_move() {
    assert_eq!(kind_of(&map_pin("unused", Value::Null, Value::Null)), Some(Role::Free));
    assert_eq!(kind_of(&map_pin("GPIO in / EXTI2", Value::Null, json!(2))), Some(Role::Swappable(Kind::Exti)));
    assert_eq!(kind_of(&map_pin("GPIO in / EXTI2", Value::Null, json!(0))), Some(Role::Swappable(Kind::Exti)));
    assert_eq!(kind_of(&map_pin("GPIO in / EXTI2", Value::Null, Value::Null)), Some(Role::Swappable(Kind::Plain)));
    assert_eq!(kind_of(&map_pin("GPIO out (TIM4_CH1)", Value::Null, Value::Null)), Some(Role::Swappable(Kind::Out)));
    assert_eq!(kind_of(&map_pin("GPIO in", json!(7), Value::Null)), None);
    assert_eq!(kind_of(&map_pin("VDD", Value::Null, Value::Null)), None);
}

#[test]
fn read_pins_takes_slots_and_other_ends_from_the_board() {
    let p = read_pins(&board(), &map(), "U1").unwrap();
    assert_eq!(p.nets.keys().map(String::as_str).collect::<Vec<_>>(), ["/EN", "/RT"]);
    let en = &p.nets["/EN"];
    assert_eq!((&en.pin, en.kind, en.ft), (&Pin::Number(3), Kind::Plain, true));
    assert_eq!(en.ends, vec![(10.0, 10.0)]);
    let slot = &p.slots[&Pin::Number(3)];
    assert_eq!((slot.x, slot.y, slot.name.as_str()), (10.0, 0.0, "PD3"));
    assert_eq!(p.fixed, vec![[14.0, 0.0, 14.0, 10.0]]);
}

#[test]
fn an_unused_pin_is_a_slot_with_no_net_and_power_draws_no_rat_line() {
    let rows = vec![pin(6, "PD6", "NC", "unused", Value::Null), pin(7, "VSS", "GND", "VSS", Value::Null)];
    let map: PinMap = serde_json::from_value(json!({"pins": rows})).unwrap();
    let p = read_pins(&board(), &map, "U1").unwrap();
    assert!(p.slots.contains_key(&Pin::Number(6)));
    assert!(p.nets.is_empty() && p.fixed.is_empty());
}

#[test]
fn read_pins_fails_closed_when_the_pin_map_does_not_match_the_board() {
    let with = |number: u32, net: &str| serde_json::from_value::<PinMap>(json!({"pins": [pin(number, "PD3", net, "GPIO in", Value::Null)]})).unwrap();
    let error = |m: &PinMap, reference: &str| read_pins(&board(), m, reference).unwrap_err().to_string();
    assert_eq!(error(&with(3, "XX"), "U1"), "U1 pin 3 (PD3): pin map net XX, board net /EN");
    assert_eq!(error(&with(3, "NC"), "U1"), "U1 pin 3 (PD3): pin map net NC, board net /EN");
    assert!(error(&with(6, "EN"), "U1").contains("board net unconnected-"), "a pin the board leaves open has no net in the map");
    assert_eq!(error(&with(99, "EN"), "U1"), "U1 pin 99 not on the board");
    assert_eq!(error(&with(3, "EN"), "U9"), "U9 not on the board");
}

const TEXT: &str = r#"(kicad_pcb
	(layers (0 "F.Cu" signal))
	(footprint "x"
		(layer "F.Cu")
		(uuid "fp-U1")
		(pad "3" smd rect (layers "F.Cu") (net "/EN") (uuid "same"))
		(pad "4" smd rect (layers "F.Cu") (net "/RT") (uuid "same"))
		(pad "5" smd rect (layers "F.Cu") (net "/FB") (uuid "c"))
		(pad "6" smd rect (layers "F.Cu") (net "unconnected-(U1-Pad6)") (uuid "d"))
	)
	(segment (start 10 0) (end 10 5) (width 0.2) (layer "F.Cu") (net "/EN") (uuid "en-a"))
	(segment (start 10 5) (end 10 10) (width 0.2) (layer "F.Cu") (net "/EN") (uuid "en-b"))
	(segment (start 12 0) (end 12 10) (width 0.2) (layer "F.Cu") (net "/RT") (uuid "rt"))
	(segment (start 18 0) (end 18 10) (width 0.2) (layer "F.Cu") (net "GND") (uuid "gnd"))
)
"#;

fn change(net: &str, from: u32, to: u32) -> Change {
    Change { net: net.to_string(), from_pin: Pin::Number(from), from_name: String::new(), to_pin: Pin::Number(to), to_name: String::new() }
}

fn pad_nets(text: &str) -> Vec<(String, Option<String>)> {
    let forms = parse(text).unwrap();
    let fp = forms[0].child("footprint").unwrap();
    fp.children("pad").map(|p| (p.text(1).unwrap().to_string(), p.value("net").map(String::from))).collect()
}

fn tracks(text: &str) -> Vec<String> {
    parse(text).unwrap()[0].children("segment").map(|s| s.value("uuid").unwrap().to_string()).collect()
}

fn named(rows: &[(&str, Option<&str>)]) -> Vec<(String, Option<String>)> {
    rows.iter().map(|(n, net)| (n.to_string(), net.map(String::from))).collect()
}

#[test]
fn apply_swaps_pad_nets_and_removes_their_old_copper_only() {
    let (out, applied) = apply_swap(TEXT, &board(), &[change("/EN", 3, 4), change("/RT", 4, 3)], "U1").unwrap();
    assert_eq!(applied, Applied { changed_pads: 2, removed_tracks: 3 });
    assert_eq!(tracks(&out), ["gnd"], "the whole cluster goes, also a track that does not touch the pad itself");
    let nets = [("3", Some("/RT")), ("4", Some("/EN")), ("5", Some("/FB")), ("6", Some("unconnected-(U1-Pad6)"))];
    assert_eq!(pad_nets(&out), named(&nets));
}

#[test]
fn a_move_to_an_unused_pin_leaves_the_old_pad_with_no_net() {
    let (out, applied) = apply_swap(TEXT, &board(), &[change("/EN", 3, 6)], "U1").unwrap();
    assert_eq!(applied, Applied { changed_pads: 2, removed_tracks: 2 });
    assert_eq!(tracks(&out), ["rt", "gnd"]);
    assert_eq!(pad_nets(&out), named(&[("3", None), ("4", Some("/RT")), ("5", Some("/FB")), ("6", Some("/EN"))]));
}

#[test]
fn apply_stops_on_a_pin_the_footprint_does_not_have() {
    let error = apply_swap(TEXT, &board(), &[change("/EN", 3, 99)], "U1").unwrap_err();
    assert_eq!(error.to_string(), "U1 pin 99 not on the board");
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("iotplace-pinswap-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn the_command_takes_the_ref_from_the_pin_map_and_prints_the_summary() {
    let dir = scratch("cli");
    let (doc, pinmap, out) = (dir.join("doc.json"), dir.join("map.json"), dir.join("proposal.json"));
    std::fs::write(&doc, document().to_string()).unwrap();
    std::fs::write(&pinmap, map_json().to_string()).unwrap();
    let run = Command::new(env!("CARGO_BIN_EXE_iotplace")).args(["pinswap", "BOARD.kicad_pcb", "--board-json"]).arg(&doc).arg(&pinmap).arg("-o").arg(&out).output().unwrap();
    assert!(run.status.success(), "{}", String::from_utf8_lossy(&run.stderr));
    let printed = String::from_utf8(run.stdout).unwrap();
    assert_eq!(printed, "swappable nets 2, slots 2, fixed rat lines 1\nbefore HPWL 20.0 mm, crossings 0\nafter  HPWL 20.0 mm, crossings 0\n");
    let proposal: Value = serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
    assert_eq!(proposal["assign"], json!({"/EN": 3, "/RT": 4}));
    assert_eq!(proposal["diff"], json!([]));
    std::fs::remove_dir_all(dir).unwrap();
}
