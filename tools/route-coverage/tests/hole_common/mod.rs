//! The fixture of the hole proofs: a native board as `iotroute board-json` gives it, and the KiCad 10 DSN of that board.
use route_coverage::board::{self, NativeBoard};
use serde_json::{Value, json};

pub const MM: i64 = 1_000_000;

/// PadForm::copper for the shapes the proofs accept: the pad's effective copper, in board coordinates.
pub fn copper(pad: &Value) -> Value {
    let n = |v: &Value| v.as_i64().unwrap();
    let (x, y) = (n(&pad["position"]["x"]), n(&pad["position"]["y"]));
    let (mut w, mut h) = (n(&pad["size"]["x"]), n(&pad["size"]["y"]));
    if n(&pad["orientation"]) % 180 == 90 {
        std::mem::swap(&mut w, &mut h);
    }
    let point = |dx: i64, dy: i64| json!({"x": x + dx, "y": y + dy});
    let (hx, hy) = (w / 2, h / 2);
    match pad["shape"].as_str().unwrap() {
        "Rect" => json!({"Polygon": [point(-hx, hy), point(hx, hy), point(hx, -hy), point(-hx, -hy)]}),
        "Oval" if w != h => {
            let round = hx.min(hy);
            let (lx, ly) = (hx - round, hy - round);
            json!({"Segment": {"a": point(-lx, -ly), "b": point(lx, ly), "width": round * 2}})
        }
        _ => json!({"Circle": {"center": point(0, 0), "radius": hx}}),
    }
}
/// Makes a pad's copper follow its changed fields.
pub fn reshape(pad: &mut Value) {
    pad["copper"] = json!([copper(pad)]);
}
pub fn pth(number: &str, net: &str, at: [i64; 2], orientation: i64, shape: &str, size: [i64; 2], drill: [i64; 2]) -> Value {
    let mut pad = json!({"id": "", "number": number, "kind": "ThroughHole", "shape": shape, "net": net,
        "position": {"x": at[0], "y": at[1]}, "orientation": orientation, "size": {"x": size[0], "y": size[1]},
        "drill": {"x": drill[0], "y": drill[1]}, "layers": ["F.Cu", "B.Cu", "F.Mask", "B.Mask"]});
    reshape(&mut pad);
    pad
}
pub fn footprint(reference: &str, at: [i64; 2], orientation: i64, pads: Vec<Value>) -> Value {
    json!({"reference": reference, "layer": "F.Cu", "position": {"x": at[0], "y": at[1]}, "orientation": orientation, "pads": pads})
}
pub fn board(footprints: Vec<Value>) -> Value {
    json!({"copper_layers": ["F.Cu", "B.Cu"], "footprints": footprints, "copper": []})
}
/// J1 and J2 share one image and sit half a turn apart; H1 is a copper-less mounting hole.
pub fn native() -> Value {
    let term = |x, orientation| pth("1", "/POWER", [x, 100 * MM], orientation, "Circle", [2_100_000; 2], [1_399_997; 2]);
    let mut hole = pth("", "", [120 * MM, 100 * MM], 0, "Circle", [3_200_000; 2], [3_200_000; 2]);
    hole["kind"] = "NpThroughHole".into();
    board(vec![
        footprint("J1", [100 * MM, 100 * MM], 0, vec![term(98_250_000, 0)]),
        footprint("J2", [110 * MM, 100 * MM], 180, vec![term(111_750_000, 180)]),
        footprint("H1", [120 * MM, 100 * MM], 0, vec![hole]),
    ])
}
pub fn read(board: &Value) -> NativeBoard {
    serde_json::from_value(board.clone()).unwrap()
}
pub fn inventory(native: &Value) -> Vec<Value> {
    board::native_drilled_geometry(&read(native)).unwrap()
}
/// Actual KiCad 10 export syntax, with only the irrelevant outlines omitted.
pub fn dsn() -> String {
    r#"(pcb "fixture"
      (parser (string_quote ")) (resolution um 10) (unit um)
      (structure (layer F.Cu (type signal)) (layer B.Cu (type power)))
      (placement (component "TERM"
        (place J1 100000 -100000 front 0 (PN connector))
        (place J2 110000 -100000 front 180 (PN connector))))
      (library (image "TERM" (pin Round[A]Pad_2100.000000_um 1 -1750 0))
        (padstack Round[A]Pad_2100.000000_um
          (shape (circle F.Cu 2100)) (shape (circle B.Cu 2100)) (attach off)))
      (network (net /POWER (pins J1-1 J2-1)) (net /LED_A (pins R2-2 D3-1))))"#
        .into()
}
