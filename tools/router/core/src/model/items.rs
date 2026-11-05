//! Board items as model entries: nets, pads, fixed copper, keepouts, zones and the board edge. Lengths go from nanometres to mm.
use super::files::{BoardFiles, RuleCompiler};
use super::output::{Box4, Copper, Keepout, Net, Pad, Point, Zone};
use super::rules::ZoneRule;
use super::selector::{Item, Scope};
use super::text::round_to;
use crate::kicad::board::{Board, RoutedCopper, Zone as BoardZone};
use crate::kicad::geom::{Polygon, Pt, Rect, to_mm};
use crate::kicad::pad::{PadShape, ZoneConnection};
use crate::kicad::shape::{Geometry, Graphic, radius};
use std::collections::{BTreeMap, BTreeSet};

pub fn point(p: Pt) -> Point {
    [to_mm(p.x), to_mm(p.y)]
}

/// A point rounded to 0.1 um, the grid of the model's polygons.
pub fn fine_point(p: Pt) -> Point {
    [round_to(to_mm(p.x), 4), round_to(to_mm(p.y), 4)]
}

pub fn box4(r: Rect) -> Box4 {
    [to_mm(r.left), to_mm(r.top), to_mm(r.right), to_mm(r.bottom)]
}

/// Every net but the unconnected ones, with the layers it may use.
pub fn initial_nets(board: &Board, files: &BoardFiles) -> BTreeMap<String, Net> {
    let planes = &files.planes;
    let plane_nets: BTreeSet<&String> = planes.grounds.iter().chain(planes.alt_refs.keys()).collect();
    let free_layers: Vec<String> = board.copper_layers.iter().filter(|l| !planes.plane_layers.contains(l)).cloned().collect();
    let mut nets: BTreeMap<String, Net> = board.nets.iter().filter(|(name, _)| !name.starts_with("unconnected-(")).map(|(name, class)| {
        (name.clone(), Net { class: class.clone(), fast: files.fast.contains(name), plane: plane_nets.contains(name), layers: free_layers.clone(), ..Net::default() })
    }).collect();
    if let Some(RuleCompiler::Settings { extra }) = &files.gate.route_features.rule_compiler {
        for deny in extra {
            for (_, net) in nets.iter_mut().filter(|(name, net)| deny.nets.contains(name) || deny.classes.contains(&net.class)) {
                net.layers.retain(|l| !deny.deny_layers.contains(l));
            }
        }
    }
    nets
}

fn shape_name(shape: PadShape) -> &'static str {
    match shape {
        PadShape::Circle => "circle",
        PadShape::Rect => "rect",
        PadShape::Oval => "oval",
        PadShape::RoundRect => "roundrect",
        PadShape::Custom => "custom",
        PadShape::Other => "other",
    }
}

pub fn connection_name(c: Option<ZoneConnection>) -> &'static str {
    match c {
        Some(ZoneConnection::None) => "none",
        Some(ZoneConnection::Thermal) => "thermal",
        Some(ZoneConnection::Full) => "full",
        Some(ZoneConnection::ThtThermal) => "tht_thermal",
        None => "inherited",
    }
}

/// The model's pads, board order, and each net's pins.
pub fn read_pads(board: &Board, files: &BoardFiles, nets: &mut BTreeMap<String, Net>) -> Vec<Pad> {
    let allow = files.gate.checks.via_pad_allow();
    let mut pads = Vec::new();
    for (footprint, p) in board.pads() {
        let name = format!("{}.{}", footprint.reference, p.number);
        pads.push(Pad {
            reference: footprint.reference.clone(),
            num: p.number.clone(),
            net: p.net.clone(),
            x: to_mm(p.position.x),
            y: to_mm(p.position.y),
            bbox: box4(p.bbox),
            layers: board.copper_layers.iter().filter(|l| p.layers.contains(l)).cloned().collect(),
            drill: to_mm(p.drill.x),
            shape: shape_name(p.shape),
            // KiCad spoke directions: pad orientation + thermal spoke angle + k x 90 degrees.
            spoke_deg: round_to((p.orientation + p.thermal_spoke_angle) % 360.0, 3),
            via_in_pad: allow.contains(&name).then_some(true),
            zone_conn: p.zone_connection.map(|c| connection_name(Some(c))),
            proxy_spokes: (p.shape == PadShape::Custom).then_some(p.spoke_templates),
            ..Pad::default()
        });
        if let Some(net) = nets.get_mut(&p.net) {
            net.pins.push(name);
        }
    }
    pads
}

pub fn read_copper(board: &Board) -> Vec<Copper> {
    board.copper.iter().map(|c| match c {
        RoutedCopper::Via(v) => Copper::Via { net: v.net.clone(), x: to_mm(v.at.x), y: to_mm(v.at.y), d: to_mm(v.size), drill: to_mm(v.drill) },
        RoutedCopper::Track(t) => Copper::Track { net: t.net.clone(), layer: t.layer.clone(), a: point(t.start), b: point(t.end), w: to_mm(t.width) },
    }).collect()
}

fn outline_box(zone: &BoardZone) -> Rect {
    zone.outline.iter().filter_map(Polygon::bbox).reduce(Rect::merged).unwrap_or(Rect::around(Pt::default()))
}

/// True when the outline is one axis-parallel rectangle: the core then uses it exactly, else its box, which is conservative.
fn is_rectangle(outline: &[Polygon]) -> bool {
    let [only] = outline else { return false };
    let distinct = |axis: fn(&Point) -> f64| only.outline.iter().map(|p| axis(&fine_point(*p)).to_bits()).collect::<BTreeSet<_>>().len();
    only.holes.is_empty() && only.outline.len() == 4 && distinct(|p| p[0]) == 2 && distinct(|p| p[1]) == 2
}

/// Every rule area, board and footprint, that keeps router items out.
pub fn read_keepouts(board: &Board) -> Vec<Keepout> {
    let own = board.zones.iter().map(|z| (z, ""));
    let in_footprints = board.footprints.iter().flat_map(|f| f.zones.iter().map(move |z| (z, f.reference.as_str())));
    own.chain(in_footprints).filter_map(|(z, reference)| {
        let area = z.rule_area.filter(|a| a.tracks || a.vias || a.pour)?;
        let ring = |r: &Vec<Pt>| r.iter().copied().map(point).collect::<Vec<Point>>();
        Some(Keepout {
            name: z.name.clone(),
            footprint: reference.to_string(),
            layers: z.layers.clone(),
            tracks: area.tracks,
            vias: area.vias,
            pour: area.pour,
            rect: is_rectangle(&z.outline),
            bbox: box4(outline_box(z)),
            pts: z.outline.iter().map(|p| ring(&p.outline)).collect(),
            holes: z.outline.iter().flat_map(|p| p.holes.iter().map(ring)).collect(),
        })
    }).collect()
}

/// The copper zones, one entry per layer, with the board zone of each entry.
pub fn read_zones(board: &Board, nets: &BTreeMap<String, Net>, zone_rules: &[ZoneRule]) -> (Vec<Zone>, Vec<usize>) {
    let (mut zones, mut sources) = (Vec::new(), Vec::new());
    for (index, z) in board.zones.iter().enumerate() {
        let Some(fill) = z.fill.as_ref() else { continue };
        for layer in &z.layers {
            zones.push(Zone {
                net: z.net.clone(),
                layer: layer.clone(),
                clearance: to_mm(fill.clearance),
                thermal_gap: to_mm(fill.thermal_gap),
                spoke_width: to_mm(fill.spoke_width),
                pad_connection: connection_name(fill.pad_connection),
                min_thickness: to_mm(fill.min_thickness),
                island_removal_mode: fill.island_removal_mode,
                min_island_area_mm2: fill.min_island_area as f64 / 1e12,
                bbox: box4(outline_box(z)),
                net_clearance: net_clearance(&z.net, nets, zone_rules),
            });
            sources.push(index);
        }
    }
    (zones, sources)
}

/// DRU clearance of an item to this zone, both rule orders, per net and item type, only where a rule is true: an unknown
/// selector is left to KiCad DRC, as in the rule report.
fn net_clearance(zone_net: &str, nets: &BTreeMap<String, Net>, rules: &[ZoneRule]) -> BTreeMap<String, super::output::ItemClearance> {
    let zone = Item::plain(zone_net, "Default", "Zone");
    let mut out: BTreeMap<String, super::output::ItemClearance> = BTreeMap::new();
    for rule in rules {
        for (name, net) in nets {
            for item_type in ["Track", "Via", "Pad"] {
                let item = Item::plain(name, &net.class, item_type);
                let holds = |a, b| rule.condition.eval(Scope { a, b, pair: false }) == Some(true);
                if holds(&item, &zone) || holds(&zone, &item) {
                    let entry = out.entry(name.clone()).or_default();
                    let field = match item_type {
                        "Track" => &mut entry.track,
                        "Via" => &mut entry.via,
                        _ => &mut entry.pad,
                    };
                    *field = Some(field.unwrap_or(0.0).max(rule.min));
                }
            }
        }
    }
    out
}

fn segment(a: Point, b: Point) -> Box4 {
    [round_to(a[0], 4), round_to(a[1], 4), round_to(b[0], 4), round_to(b[1], 4)]
}

/// Chords of at most 10 degrees: a chord lies inside the arc, so the segments are a slightly smaller outline at the curves,
/// within 0.4 % of the radius.
fn chords(center: Point, r: f64, start_deg: f64, sweep: f64) -> Vec<Box4> {
    let n = ((sweep.abs() / 10.0).ceil() as usize).max(2);
    let at = |i: usize| {
        let t = (start_deg + sweep * i as f64 / n as f64).to_radians();
        [center[0] + r * t.cos(), center[1] + r * t.sin()]
    };
    (0..n).map(|i| segment(at(i), at(i + 1))).collect()
}

fn edge_of(g: &Graphic) -> Vec<Box4> {
    let closed = |ring: &[Pt]| (0..ring.len()).map(|i| segment(point(ring[i]), point(ring[(i + 1) % ring.len()]))).collect::<Vec<_>>();
    match &g.geometry {
        Geometry::Segment { start, end } => vec![segment(point(*start), point(*end))],
        Geometry::Rect { top_left: a, bottom_right: b } => closed(&[*a, Pt::new(b.x, a.y), *b, Pt::new(a.x, b.y)]),
        Geometry::Poly { rings } => rings.iter().flat_map(|r| closed(r)).collect(),
        Geometry::Circle { center, radius_point } => chords(point(*center), to_mm(radius(*center, *radius_point)), 0.0, 360.0),
        Geometry::Arc(a) => {
            let (c, s) = (point(a.center), point(a.start));
            chords(c, to_mm(a.radius()), (s[1] - c[1]).atan2(s[0] - c[0]).to_degrees(), a.sweep())
        }
        Geometry::Other => Vec::new(),
    }
}

/// Edge.Cuts as line segments: the core keeps the board edge clearance from them. The outline box alone missed a notch
/// (BASE-PWR-C).
pub fn read_edges(board: &Board) -> Vec<Box4> {
    board.graphics_on("Edge.Cuts").flat_map(edge_of).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kicad::shape::Arc;

    fn graphic(geometry: Geometry) -> Graphic {
        Graphic { id: String::new(), geometry, layer: "Edge.Cuts".to_string(), width: 50_000, filled: false }
    }

    #[test]
    fn a_rectangle_is_four_edges_and_a_circle_36_chords() {
        assert_eq!(edge_of(&graphic(Geometry::Rect { top_left: Pt::new(0, 0), bottom_right: Pt::new(1_000_000, 2_000_000) })).len(), 4);
        let circle = edge_of(&graphic(Geometry::Circle { center: Pt::new(0, 0), radius_point: Pt::new(1_000_000, 0) }));
        assert_eq!(circle.len(), 36);
        assert_eq!(circle[0][..2], [1.0, 0.0]);
    }

    #[test]
    fn an_arc_is_chords_of_at_most_ten_degrees_from_its_start() {
        let a = Arc::through(Pt::new(10_000_000, 0), Pt::new(7_071_068, 7_071_068), Pt::new(0, 10_000_000));
        let e = edge_of(&graphic(Geometry::Arc(a)));
        assert_eq!(e.len(), 9);
        assert_eq!(e[0][..2], [10.0, 0.0]);
        assert_eq!(e[8][2..], [0.0, 10.0]);
    }

    #[test]
    fn a_rule_area_is_a_rectangle_only_with_four_axis_corners_and_no_hole() {
        let ring = vec![Pt::new(0, 0), Pt::new(2_000_000, 0), Pt::new(2_000_000, 1_000_000), Pt::new(0, 1_000_000)];
        assert!(is_rectangle(&[Polygon::of_ring(ring.clone())]));
        assert!(!is_rectangle(&[Polygon { outline: ring.clone(), holes: vec![ring.clone()] }]));
        assert!(!is_rectangle(&[Polygon::of_ring(vec![Pt::new(0, 0), Pt::new(2_000_000, 0), Pt::new(2_000_000, 1_000_000), Pt::new(500_000, 1_000_000)])]));
    }

    #[test]
    fn a_zone_rule_reaches_items_in_either_order() {
        let rules = [ZoneRule { condition: crate::model::selector::Selector::new("A.NetClass == 'ISO' && B.Type == 'Zone'"), min: 0.5 }];
        let nets = BTreeMap::from([("I".to_string(), Net { class: "ISO".to_string(), ..Net::default() }), ("X".to_string(), Net { class: "Default".to_string(), ..Net::default() })]);
        let out = net_clearance("GND", &nets, &rules);
        assert_eq!(out["I"].track, Some(0.5));
        assert_eq!(out["I"].pad, Some(0.5));
        assert!(!out.contains_key("X"));
    }
}
