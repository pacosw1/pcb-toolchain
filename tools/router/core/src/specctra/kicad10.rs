//! The DSN of the KiCad API's export in the form KiCad 10 wrote, which is the form the router was proved on.
//!
//! The pinned nightly differs from `pcbnew.ExportSpecctraDSN` of KiCad 10.0.6 in two ways that matter. A copper zone comes out as a
//! protected `wire` polygon in the wiring, with its fill as windows, where KiCad 10 wrote a `plane` in the structure: on ENV-SENSE
//! Fastroute then counts the plane net as connected and reports 0 unrouted where the KiCad 10 DSN gives 3. And each track is its
//! own wire, where KiCad 10 chained the tracks that follow each other into one path.
//!
//! Left as they are: the `pcb` line (the output path) and `host_version`, which says truthfully who wrote the file.
//! Two wires are chained on their text, so ends less than one DSN unit apart chain here and did not in KiCad 10. Only wires of one
//! type chain: KiCad 10 took the type of the first track of a chain, and a chain of locked and free tracks is not proved here.
use crate::kicad::raw::{self, Form};

/// `PATH::Format` of KiCad's specctra.h: a new line once a line is longer than this.
const RIGHT_MARGIN: usize = 70;
/// `PATH::Format`: continuation lines start here.
const WRAP_INDENT: usize = 12;
/// One DSN unit is 1 um and a point is written to six digits, so a zone point and its DSN point agree to one unit.
const SAME_POINT_UM: f64 = 1.0;

type Point = (String, String);

/// Where a copper zone's outline starts, in DSN units.
#[derive(Debug, Clone, PartialEq)]
pub struct ZoneStart {
    pub net: String,
    pub layer: String,
    pub x: f64,
    pub y: f64,
}

/// The first outline point of each copper zone, one per layer. KiCad 10 started the plane there.
pub fn zone_starts(board: &str) -> Result<Vec<ZoneStart>, String> {
    let root = raw::parse_first(board).map_err(|error| format!("board text: {error}"))?;
    let mut starts = Vec::new();
    for zone in root.children("zone") {
        if zone.children("keepout").next().is_some() {
            continue;
        }
        let net = zone.children("net").next().and_then(|net| net.text(1)).unwrap_or_default();
        let first = zone.children("polygon").next().and_then(|polygon| polygon.children("pts").next()).and_then(|pts| pts.children("xy").next());
        let Some(first) = first else { continue };
        let number = |index| first.text(index).and_then(|value: &str| value.parse::<f64>().ok()).ok_or("a zone point is not a number");
        let (x, y) = (number(1)? * 1000.0, -number(2)? * 1000.0);
        for layer in zone_layers(zone) {
            starts.push(ZoneStart { net: net.trim_matches('"').to_string(), layer, x, y });
        }
    }
    Ok(starts)
}

fn zone_layers(zone: &Form) -> Vec<String> {
    let named = zone.children("layer").chain(zone.children("layers"));
    named.flat_map(|form| form.items().iter().skip(1)).filter_map(|item| item.atom()).map(|layer| layer.trim_matches('"').to_string()).collect()
}

/// A path or polygon as `PATH::Format` writes it.
fn shape_text(kind: &str, layer: &str, width: &str, points: &[Point]) -> String {
    let mut out = format!("({kind} {layer} {width}");
    let mut line = out.len();
    for (x, y) in points {
        if line > RIGHT_MARGIN {
            out.push('\n');
            out.push_str(&" ".repeat(WRAP_INDENT));
            line = WRAP_INDENT;
        } else {
            out.push_str("  ");
            line += 2;
        }
        let point = format!("{x} {y}");
        line += point.len();
        out.push_str(&point);
    }
    out.push(')');
    out
}

/// The index after the form that opens at `start`. Net names may hold parentheses inside their quotes.
fn form_end(text: &str, start: usize) -> Result<usize, String> {
    let (mut depth, mut quoted) = (0usize, false);
    for (offset, c) in text[start..].char_indices() {
        match c {
            '"' => quoted = !quoted,
            '(' if !quoted => depth += 1,
            ')' if !quoted => {
                depth -= 1;
                if depth == 0 {
                    return Ok(start + offset + 1);
                }
            }
            _ => {}
        }
    }
    Err("unbalanced DSN form".into())
}

/// A shape's words: layer, width and its points.
fn shape_words(body: &str) -> Result<(String, String, Vec<Point>), String> {
    let words: Vec<&str> = body.split_whitespace().collect();
    if words.len() < 4 || words.len() % 2 != 0 {
        return Err(format!("a DSN shape has no points: {body}"));
    }
    let points = words[2..].chunks(2).map(|pair| (pair[0].to_string(), pair[1].to_string())).collect();
    Ok((words[0].to_string(), words[1].to_string(), points))
}

struct Plane {
    net: String,
    layer: String,
    width: String,
    ring: Vec<Point>,
}

fn value(point: &Point) -> Result<(f64, f64), String> {
    let number = |word: &str| word.parse::<f64>().map_err(|_| format!("a DSN point is not a number: {word}"));
    Ok((number(&point.0)?, number(&point.1)?))
}

/// The closed ring from the zone's first point. A ring that no zone starts on stops the export: it is no plane we know.
fn from_zone_start(plane: &Plane, starts: &[ZoneStart]) -> Result<Vec<Point>, String> {
    let open = &plane.ring[..plane.ring.len() - 1];
    if plane.ring.first() != plane.ring.last() || open.is_empty() {
        return Err(format!("the zone of {} on {} is not a closed ring", plane.net, plane.layer));
    }
    let net = plane.net.trim_matches('"');
    let mut found = None;
    for start in starts.iter().filter(|start| start.net == net && start.layer == plane.layer.trim_matches('"')) {
        for (index, point) in open.iter().enumerate() {
            let (x, y) = value(point)?;
            if (x - start.x).abs() <= SAME_POINT_UM && (y - start.y).abs() <= SAME_POINT_UM {
                found = Some(index);
            }
        }
    }
    let index = found.ok_or_else(|| format!("no zone of {net} on {} starts on its DSN ring", plane.layer))?;
    let mut ring: Vec<Point> = open[index..].iter().chain(&open[..index]).cloned().collect();
    ring.push(ring[0].clone());
    Ok(ring)
}

/// Takes the protected zone polygons out of the wiring. Their windows are the fill, which KiCad 10 did not export.
fn take_planes(text: &str) -> Result<(String, Vec<Plane>), String> {
    const HEAD: &str = "(wire (polygon ";
    let (mut out, mut planes, mut at) = (String::with_capacity(text.len()), Vec::new(), 0);
    while let Some(found) = text[at..].find(HEAD) {
        let start = at + found;
        let end = form_end(text, start)?;
        let block = &text[start..end];
        let shape_end = HEAD.len() + block[HEAD.len()..].find(')').ok_or("a DSN wire polygon does not close")?;
        let (layer, width, ring) = shape_words(&block[HEAD.len()..shape_end])?;
        let rest = &block[shape_end + 1..];
        let net_start = rest.find("(net ").ok_or("a DSN wire polygon has no net")? + "(net ".len();
        let net_end = net_start + rest[net_start..].find(")(type").ok_or("a DSN wire polygon has no type")?;
        if !rest[net_end..].starts_with(")(type protect)") {
            return Err(format!("a DSN wire polygon is not protected: {}", &rest[net_end..].chars().take(40).collect::<String>()));
        }
        planes.push(Plane { net: rest[net_start..net_end].to_string(), layer, width, ring });
        let line = text[..start].rfind('\n').map_or(0, |newline| newline + 1);
        out.push_str(&text[at..line]);
        at = if text[end..].starts_with('\n') { end + 1 } else { end };
    }
    out.push_str(&text[at..]);
    Ok((out, planes))
}

/// The text with `lines` after the structure's boundary, where KiCad 10 wrote its planes.
fn after_boundary(text: &str, lines: &str) -> Result<String, String> {
    let start = text.rfind("(boundary").ok_or("the DSN has no boundary")?;
    let end = form_end(text, start)?;
    let line = end + text[end..].find('\n').map_or(0, |newline| newline + 1);
    Ok(format!("{}{lines}{}", &text[..line], &text[line..]))
}

struct Wire {
    layer: String,
    width: String,
    points: Vec<Point>,
    tail: String,
}

/// A one-line path wire; any other line is not chained.
fn wire_of(line: &str) -> Option<Wire> {
    let body = line.strip_prefix("    (wire (path ")?;
    let close = body.find(')')?;
    let tail = &body[close + 1..];
    if !tail.starts_with("(net ") || !tail.ends_with(')') {
        return None;
    }
    let (layer, width, points) = shape_words(&body[..close]).ok()?;
    Some(Wire { layer, width, points, tail: tail.to_string() })
}

fn wire_line(wire: &Wire) -> String {
    format!("    (wire {}{}", shape_text("path", &wire.layer, &wire.width, &wire.points), wire.tail)
}

/// Each wire that starts where the one before ends, on the same layer, width, net and type, joins it.
fn chain_wires(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut open: Option<Wire> = None;
    let flush = |open: &mut Option<Wire>, out: &mut String| {
        if let Some(wire) = open.take() {
            out.push_str(&wire_line(&wire));
            out.push('\n');
        }
    };
    for line in text.split_inclusive('\n') {
        let Some(next) = wire_of(line.trim_end_matches('\n')) else {
            flush(&mut open, &mut out);
            out.push_str(line);
            continue;
        };
        match open.as_mut() {
            Some(wire) if wire.layer == next.layer && wire.width == next.width && wire.tail == next.tail && wire.points.last() == next.points.first() => {
                wire.points.extend(next.points.into_iter().skip(1));
            }
            _ => {
                flush(&mut open, &mut out);
                open = Some(next);
            }
        }
    }
    flush(&mut open, &mut out);
    out
}

/// The API's DSN in KiCad 10's form. `starts` comes from the same board: `zone_starts`.
pub fn kicad10_form(dsn: &str, starts: &[ZoneStart]) -> Result<String, String> {
    let (text, planes) = take_planes(dsn)?;
    let mut lines = String::new();
    for plane in &planes {
        let ring = from_zone_start(plane, starts)?;
        lines.push_str(&format!("    (plane {} {})\n", plane.net, shape_text("polygon", &plane.layer, &plane.width, &ring)));
    }
    let text = if lines.is_empty() { text } else { after_boundary(&text, &lines)? };
    Ok(chain_wires(&text))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ENV-SENSE, exported by the nightly and by KiCad 10.0.6 from the same board on 2026-11-05.
    const NIGHTLY: &str = "  (structure\n    (boundary\n      (path pcb 0  1 2  3 4)\n    )\n    (keepout \"\" (polygon F.Cu 0  1 2  3 4))\n  )\n  (wiring\n    (wire (polygon B.Cu 0  110017 -116020  120033 -116020  120033 -100000  130050 -100000\n            130050 -130050  100000 -130050  100000 -100000  110017 -100000\n            110017 -116020)(net GND)(type protect)\n      (window (polygon B.Cu 0  110017 -115097  110005 -115045))\n    )\n    (wire (path F.Cu 250  112700 -124600  112023 -124600)(net +3V3)(type fix))\n    (wire (path F.Cu 250  112023 -124600  112023 -125880)(net +3V3)(type fix))\n    (wire (path F.Cu 250  1 1  2 2)(net +3V3)(type fix))\n  )\n";
    const KICAD10: &str = "  (structure\n    (boundary\n      (path pcb 0  1 2  3 4)\n    )\n    (plane GND (polygon B.Cu 0  130050 -130050  100000 -130050  100000 -100000  110017 -100000\n            110017 -116020  120033 -116020  120033 -100000  130050 -100000\n            130050 -130050))\n    (keepout \"\" (polygon F.Cu 0  1 2  3 4))\n  )\n  (wiring\n    (wire (path F.Cu 250  112700 -124600  112023 -124600  112023 -125880)(net +3V3)(type fix))\n    (wire (path F.Cu 250  1 1  2 2)(net +3V3)(type fix))\n  )\n";

    fn gnd() -> Vec<ZoneStart> {
        vec![ZoneStart { net: "GND".into(), layer: "B.Cu".into(), x: 130050.0, y: -130050.0 }]
    }

    #[test]
    fn the_nightly_text_becomes_the_kicad_10_text() {
        assert_eq!(kicad10_form(NIGHTLY, &gnd()).unwrap(), KICAD10);
    }

    #[test]
    fn a_kicad_10_text_stays_as_it_is() {
        assert_eq!(kicad10_form(KICAD10, &gnd()).unwrap(), KICAD10);
    }

    #[test]
    fn a_plane_no_zone_starts_on_stops_the_export() {
        let far = [ZoneStart { net: "GND".into(), layer: "B.Cu".into(), x: 1.0, y: 1.0 }];
        assert!(kicad10_form(NIGHTLY, &far).unwrap_err().contains("no zone of GND"));
        let other_layer = [ZoneStart { net: "GND".into(), layer: "F.Cu".into(), x: 130050.0, y: -130050.0 }];
        assert!(kicad10_form(NIGHTLY, &other_layer).is_err());
    }

    #[test]
    fn a_zone_polygon_of_another_type_stops_the_export() {
        let text = NIGHTLY.replace("(type protect)", "(type route)");
        assert!(kicad10_form(&text, &gnd()).unwrap_err().contains("not protected"));
    }

    #[test]
    fn wires_of_another_net_layer_width_or_type_do_not_chain() {
        for second in ["(wire (path B.Cu 250  3 3  4 4)(net A)(type fix))", "(wire (path F.Cu 200  3 3  4 4)(net A)(type fix))", "(wire (path F.Cu 250  3 3  4 4)(net B)(type fix))", "(wire (path F.Cu 250  3 3  4 4)(net A)(type route))", "(wire (path F.Cu 250  9 9  4 4)(net A)(type fix))"] {
            let text = format!("    (wire (path F.Cu 250  1 1  3 3)(net A)(type fix))\n    {second}\n");
            assert_eq!(chain_wires(&text), text);
        }
    }

    #[test]
    fn a_long_chain_wraps_as_kicad_does() {
        let line = |a: i32, b: i32| format!("    (wire (path F.Cu 250  {a}00000 -100000  {b}00000 -100000)(net A)(type fix))\n");
        let text: String = (1..6).map(|n| line(n, n + 1)).collect();
        assert_eq!(chain_wires(&text), "    (wire (path F.Cu 250  100000 -100000  200000 -100000  300000 -100000  400000 -100000\n            500000 -100000  600000 -100000)(net A)(type fix))\n");
    }

    #[test]
    fn zone_starts_skip_rule_areas_and_give_each_layer() {
        let board = "(kicad_pcb\n(zone (net \"GND\") (layers \"F.Cu\" \"B.Cu\") (polygon (pts (xy 130.05 130.05) (xy 1 1))))\n(zone (layer \"F.Cu\") (keepout (tracks not_allowed)) (polygon (pts (xy 2 2))))\n)";
        let starts = zone_starts(board).unwrap();
        assert_eq!(starts.iter().map(|start| start.layer.as_str()).collect::<Vec<_>>(), ["F.Cu", "B.Cu"]);
        assert_eq!((starts[0].net.as_str(), starts[0].x.round(), starts[0].y.round()), ("GND", 130050.0, -130050.0));
    }
}
