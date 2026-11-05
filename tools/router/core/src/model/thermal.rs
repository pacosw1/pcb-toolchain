//! thermal-vias.json: an array of vias in an exposed pad, each number from a datasheet. long / short are the vias along the pad's
//! long / short side, the array centred on the pad. Nothing is guessed: a missing key or source, a pad that is not an SMD pad of a
//! plane net, a pad not on the gate viapads allow list, a turned or offset pad, a via below a board minimum, vias closer than the
//! hole-to-hole rule, or a via outside the pad copper is refused.
use super::current::last_pad_of_each_name;
use super::files::{DesignRules, ThermalSpec};
use super::num::{Num, short_float};
use super::output::{Class, HoleRule, Net, Pad, Point, ThermalVias};
use super::text::round_to;
use crate::kicad::geom::polygon::copper_contains;
use crate::kicad::geom::{Pt, from_mm};
use crate::kicad::pad::Pad as BoardPad;
use std::collections::BTreeMap;
use std::f64::consts::PI;

const RIM_POINTS: usize = 32;

/// What the rules of the board ask of a thermal via.
pub struct ThermalRules<'a> {
    pub nets: &'a BTreeMap<String, Net>,
    pub classes: &'a BTreeMap<String, Class>,
    pub setup: &'a DesignRules,
    pub hole_to_hole: &'a [HoleRule],
    pub allow: &'a [String],
}

struct Array {
    long: i64,
    short: i64,
    pitch_long: f64,
    pitch_short: f64,
    drill: f64,
    diameter: f64,
    source: String,
}

fn read_array(s: &ThermalSpec) -> Result<Array, String> {
    let keys = [("diameter", s.diameter), ("drill", s.drill), ("long", s.long), ("pitch_long", s.pitch_long), ("pitch_short", s.pitch_short), ("short", s.short)];
    let mut missing: Vec<&str> = keys.iter().filter(|(_, v)| v.is_none()).map(|(k, _)| *k).collect();
    if s.source.is_none() {
        missing.push("source");
    }
    if !missing.is_empty() {
        missing.sort();
        return Err(format!("missing {}", missing.join(", ")));
    }
    let source = s.source.clone().unwrap_or_default();
    if source.trim().is_empty() {
        return Err("empty source (every number needs its datasheet source)".to_string());
    }
    let value = |n: Option<Num>| n.map_or(0.0, Num::get);
    let array = Array { long: value(s.long) as i64, short: value(s.short) as i64, pitch_long: value(s.pitch_long), pitch_short: value(s.pitch_short), drill: value(s.drill), diameter: value(s.diameter), source };
    if array.long < 1 || array.short < 1 || (array.long > 1 && array.pitch_long <= 0.0) || (array.short > 1 && array.pitch_short <= 0.0) {
        return Err("counts must be >= 1 and pitches > 0".to_string());
    }
    Ok(array)
}

/// Board setup, the net class via and the DRU via rules of the net.
fn check_minimums(array: &Array, net: &Net, rules: &ThermalRules) -> Result<(), String> {
    let class = rules.classes.get(&net.class).or_else(|| rules.classes.get("Default"));
    let via = net.via.clone().unwrap_or_default();
    let (dr, dia) = (array.drill, array.diameter);
    let annular = (dia - dr) / 2.0;
    let class_drill = format!("net class {} via drill", net.class);
    let class_via = format!("net class {} via diameter", net.class);
    let number = |n: Option<Num>| n.map(Num::get);
    let mins = [
        ("drill", dr, number(rules.setup.min_through_hole_diameter), "board min drill"),
        ("diameter", dia, number(rules.setup.min_via_diameter), "board min via"),
        ("annular", annular, number(rules.setup.min_via_annular_width), "board min annular ring"),
        ("drill", dr, class.and_then(|c| number(c.drill)), &class_drill),
        ("diameter", dia, class.and_then(|c| number(c.via)), &class_via),
        ("drill", dr, via.hole_size, "DRU hole_size"),
        ("diameter", dia, via.via_diameter, "DRU via_diameter"),
        ("annular", annular, via.annular_width, "DRU annular_width"),
    ];
    for (what, value, min, source) in mins {
        if let Some(min) = min.filter(|m| value < m - 1e-9) {
            return Err(format!("{what} {} mm < {source} {} mm", short_float(value), short_float(min)));
        }
    }
    Ok(())
}

fn check_spacing(array: &Array, rules: &ThermalRules) -> Result<(), String> {
    let board = rules.setup.min_hole_to_hole.map_or(0.0, Num::get);
    let hole_to_hole = rules.hole_to_hole.iter().filter(|r| r.scope == "all").map(|r| r.min).fold(board, f64::max);
    for (count, pitch, side) in [(array.long, array.pitch_long, "long"), (array.short, array.pitch_short, "short")] {
        if count > 1 && pitch - array.drill < hole_to_hole - 1e-9 {
            return Err(format!("pitch_{side} {} - drill {} < hole-to-hole {} mm", short_float(pitch), short_float(array.drill), short_float(hole_to_hole)));
        }
    }
    Ok(())
}

fn offsets(count: i64, pitch: f64) -> Vec<f64> {
    (0..count).map(|i| (i as f64 - (count - 1) as f64 / 2.0) * pitch).collect()
}

/// The via centres of the array on a pad at a multiple of 90 degrees: the pad's x size lies along board x at 0 and 180.
fn array_points(array: &Array, pad: &Pad, source: &BoardPad) -> Result<Vec<Point>, String> {
    let o = source.orientation;
    if (o - 90.0 * (o / 90.0).round()).abs() > 1e-6 {
        return Err(format!("pad orientation {} is not a multiple of 90 degrees", short_float(o)));
    }
    let [left, top, right, bottom] = pad.bbox;
    if ((left + right) / 2.0 - pad.x).abs() > 1e-3 || ((top + bottom) / 2.0 - pad.y).abs() > 1e-3 {
        return Err("pad with an offset (centre is not the bbox centre): not modelled".to_string());
    }
    let upright = (90.0 * (o / 90.0).round()) as i64 % 180 == 0;
    let long_along_x = (source.size.x >= source.size.y) == upright;
    let mut vias = Vec::new();
    for u in offsets(array.long, array.pitch_long) {
        for w in offsets(array.short, array.pitch_short) {
            let (x, y) = if long_along_x { (pad.x + u, pad.y + w) } else { (pad.x + w, pad.y + u) };
            vias.push([round_to(x, 4), round_to(y, 4)]);
        }
    }
    Ok(vias)
}

/// Each via disc inside the pad copper, by points on its rim.
fn check_inside(vias: &[Point], diameter: f64, source: &BoardPad) -> Result<(), String> {
    for [x, y] in vias {
        for k in 0..RIM_POINTS {
            let t = 2.0 * PI * k as f64 / RIM_POINTS as f64;
            let q = Pt::new(from_mm(x + diameter / 2.0 * t.cos()), from_mm(y + diameter / 2.0 * t.sin()));
            if !source.copper.iter().any(|c| copper_contains(c, q)) {
                return Err(format!("via ({x:.3}, {y:.3}) d {} mm is not inside the pad copper", short_float(diameter)));
            }
        }
    }
    Ok(())
}

fn one_pad(key: &str, spec: &ThermalSpec, pad: &Pad, source: &BoardPad, rules: &ThermalRules) -> Result<ThermalVias, String> {
    let array = read_array(spec)?;
    let net = rules.nets.get(&pad.net).filter(|n| pad.drill == 0.0 && n.plane).ok_or_else(|| {
        format!("not an SMD pad of a plane net (net {})", if pad.net.is_empty() { "-" } else { &pad.net })
    })?;
    if !rules.allow.iter().any(|a| a == key) {
        return Err("not on gate.json checks.viapads.allow (the viapads gate would fail every via in it)".to_string());
    }
    check_minimums(&array, net, rules)?;
    check_spacing(&array, rules)?;
    let vias = array_points(&array, pad, source)?;
    check_inside(&vias, array.diameter, source)?;
    Ok(ThermalVias { vias, d: array.diameter, drill: array.drill, long: array.long, short: array.short, pitch: [array.pitch_long, array.pitch_short], source: array.source })
}

/// Sets pad `thermal_vias` from the spec; the core places exactly these vias as fixed copper of the pad's net.
pub fn apply_thermal_vias(specs: &BTreeMap<String, ThermalSpec>, pads: &mut [Pad], sources: &[&BoardPad], rules: &ThermalRules) -> Result<(), String> {
    let by_name = last_pad_of_each_name(pads);
    for (key, spec) in specs {
        let fail = |why: String| format!("thermal-vias.json {key}: {why}");
        let index = *by_name.get(key).ok_or_else(|| fail("no such pad on the board".to_string()))?;
        pads[index].thermal_vias = Some(one_pad(key, spec, &pads[index], sources[index], rules).map_err(fail)?);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kicad::geom::Rect;
    use crate::kicad::pad::{Copper, PadForm, PadKind, PadShape};
    use crate::model::num::Num::Float;

    fn nm(mm: f64) -> i64 {
        (mm * 1e6).round() as i64
    }

    /// FW-IO U4.9: LM5164 EP, 3.2 x 2.5 mm at 90 degrees, the long side along board y.
    fn source() -> BoardPad {
        let form = PadForm { shape: PadShape::Rect, center: Pt::new(nm(100.0), nm(50.0)), orientation: 90.0, size: Pt::new(nm(3.2), nm(2.5)), corner_ratio: 0.0 };
        BoardPad {
            id: String::new(), number: "9".to_string(), kind: PadKind::Smd, shape: PadShape::Rect, net: "GND".to_string(), position: form.center, orientation: 90.0, size: form.size,
            drill: Pt::default(), layers: vec!["F.Cu".to_string()], bbox: Rect::around(form.center), zone_connection: None, thermal_spoke_angle: 90.0, spoke_templates: 0,
            copper: form.copper(), polygons: BTreeMap::new(), solder_mask_expansion: 0, clearance_override: None,
        }
    }

    fn pad() -> Pad {
        Pad { reference: "U4".to_string(), num: "9".to_string(), net: "GND".to_string(), x: 100.0, y: 50.0, bbox: [98.75, 48.4, 101.25, 51.6], ..Pad::default() }
    }

    fn spec() -> ThermalSpec {
        ThermalSpec { long: Some(Num::Int(2)), short: Some(Num::Int(2)), pitch_long: Some(Float(1.27)), pitch_short: Some(Float(1.10)), drill: Some(Float(0.3)), diameter: Some(Float(0.6)), source: Some("LM5164 Fig. 28".to_string()) }
    }

    fn run(spec: ThermalSpec, allow: &[String]) -> Result<ThermalVias, String> {
        let nets = BTreeMap::from([("GND".to_string(), Net { plane: true, class: "PWR".to_string(), ..Net::default() })]);
        let classes = BTreeMap::from([("PWR".to_string(), Class { width: None, clearance: None, via: Some(Float(0.6)), drill: Some(Float(0.3)) })]);
        let holes = [HoleRule { rule: String::new(), min: 0.45, scope: "all" }];
        let setup = DesignRules::default();
        let rules = ThermalRules { nets: &nets, classes: &classes, setup: &setup, hole_to_hole: &holes, allow };
        let mut pads = [pad()];
        let specs = BTreeMap::from([("U4.9".to_string(), spec)]);
        let s = source();
        apply_thermal_vias(&specs, &mut pads, &[&s], &rules)?;
        Ok(pads[0].thermal_vias.clone().expect("set"))
    }

    fn allow() -> Vec<String> {
        vec!["U4.9".to_string()]
    }

    #[test]
    fn an_array_is_centred_with_the_long_side_along_y() {
        let tv = run(spec(), &allow()).unwrap();
        assert_eq!((tv.d, tv.drill, tv.source.as_str()), (0.6, 0.3, "LM5164 Fig. 28"));
        assert_eq!(tv.vias.len(), 4);
        let xs: Vec<f64> = tv.vias.iter().map(|v| v[0]).collect();
        let ys: Vec<f64> = tv.vias.iter().map(|v| v[1]).collect();
        assert!((xs.iter().cloned().fold(0.0, f64::max) - xs.iter().cloned().fold(1e9, f64::min) - 1.10).abs() < 1e-4);
        assert!((ys.iter().cloned().fold(0.0, f64::max) - ys.iter().cloned().fold(1e9, f64::min) - 1.27).abs() < 1e-4);
    }

    #[test]
    fn what_is_not_sourced_or_does_not_fit_is_refused() {
        let cases: [(fn(&mut ThermalSpec), &str); 5] = [
            (|s| s.source = Some(" ".to_string()), "empty source"),
            (|s| { s.drill = Some(Float(0.25)); s.diameter = Some(Float(0.55)); }, "net class PWR via drill"),
            (|s| s.pitch_short = Some(Float(0.7)), "hole-to-hole"),
            (|s| s.pitch_long = Some(Float(3.0)), "not inside the pad copper"),
            (|s| s.short = Some(Num::Int(3)), "not inside the pad copper"),
        ];
        for (change, why) in cases {
            let mut s = spec();
            change(&mut s);
            let e = run(s, &allow()).unwrap_err();
            assert!(e.contains(why), "{e}");
        }
    }

    #[test]
    fn a_missing_key_and_a_pad_off_the_allow_list_are_refused() {
        let mut s = spec();
        s.source = None;
        assert!(run(s, &allow()).unwrap_err().contains("missing source"));
        assert!(run(spec(), &[]).unwrap_err().contains("viapads.allow"));
    }

    #[test]
    fn copper_of_the_test_pad_is_one_polygon() {
        assert!(matches!(source().copper[..], [Copper::Polygon(_)]));
    }
}
