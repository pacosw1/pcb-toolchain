//! si-planes: reference-plane gate for a 4-layer board. It fails when a signal track on an outer layer has no filled ground plane of
//! its own domain on the adjacent layer, when a track crosses over the ground of another domain, and when a track cuts an inner plane
//! layer. It only reads the board.
//!
//! Spec (one per board, hardware-design/boards/<board>/reference-planes.json):
//!   {"about": "text",
//!    "adjacent": {"F.Cu": "In1.Cu", "B.Cu": "In2.Cu"},      outer layer -> its reference layer
//!    "plane_layers": ["In1.Cu", "In2.Cu"],                   a track on these layers is a FAIL
//!    "mixed_layers": {"In2.Cu": {"allow": "slow", "fast_file": "rp001-fast-nets.json", "power": ["GND", "VBUS"], "reason": "..."}},
//!                     optional: a plane layer that may also carry tracks of slow nets (not fast, not power, not a ground). fast_file
//!                     is relative to the spec ({"fast": [patterns]}; no file = error). A fast net over it (on the outer layer that
//!                     it references) fails on any gap; each fill piece of a ground on it must hold a via or a through-hole pad of
//!                     that ground (no island).
//!    "grounds": ["GND", "ISO_0V"],                           one ground net per domain
//!    "alt_refs": {"VDD_3V3": {"domain": "GND", "reason": "..."}},   other plane nets that are a reference ("slow_only": true: for
//!                     slow nets only, not fast nets)
//!    "domains": {"ISO_0V": ["/AI*"]},                        optional: net patterns -> domain (else the ground zone outline that
//!                     holds most pads)
//!    "exempt": {"nets": {"VIN": "reason"}, "areas": [{"box": [x0, y0, x1, y1], "nets": ["/A"], "reason": "..."}]},
//!    "fast_file": "rp001-fast-nets.json",   optional, for a stackup with no mixed layer: fast net patterns
//!    "power": ["VBUS", "/MAINS_*"],   optional: power and DC nets (no edge): no reference rule (D-124); the "power" lists of
//!                     mixed_layers count too. A track on a plane layer still fails.
//!    "edge_classes": {"i2c": ["/SDA"]},   optional: net patterns -> an interface class of tools/edge-rates.json
//!    "receivers": {"/ALMn": {"refs": ["U1"], "reason": "..."}},   optional: parts whose pin on that net is an input, so no driver
//!    "offboard": {"/ENC_A*": {"class": "rs485", "reason": "..."}},   optional: a net driven only from off-board (a connector) gets
//!                     the edge of this interface class
//!    "schematic": "cad/X/X.kicad_sch",   optional, relative to the spec: default the board file with .kicad_sch
//!    "via_allow_mm": 0.6,          a run this near (plus the pad/via radius) the net's own via/pad is OK
//!    "step_mm": 0.25}              sample step along each track
//! Coordinates: KiCad mm, Y down.
//!
//! Rules (D-124, hardware-design/reports/2026-10-09-design-rules-sources.md A1 and C3):
//!   fast net: no crossing of a gap, void, hole or slot in its reference, outside via_allow_mm at its own vias and pads ("Net crossing
//!     gap / hole or slot": HyperLynx DRC rule list, https://signalintegrityjournal.com/articles/577-design-rule-checks-for-high-speed-pcb-design [P]).
//!   power / DC net: no reference rule.
//!   other nets: each unreferenced run is a crossing; the return detour (the shortest path in the reference copper of the net's domain
//!     between the two crossing points, the whole path counted) must be <= tr[ns] x 10 nH/ns / 1.5 nH/mm = 6.7 mm per ns
//!     (tools/edge-rates.json). When that budget is larger than the board (outline bounding-box perimeter), the net has no reference
//!     rule. An unreachable reference fails. tr: an "edge_classes" interface class, else the net's actual driver. There is no default:
//!     a net with a crossing whose driver or edge time is not known fails as "unknown driver" (a stub passes at any edge).
//!   every net except a ground: domain crossing (a track over the ground of another domain) fails.
//!
//! screen.rs says which findings are enforced and which are report-only.
pub mod detour;
pub mod native;
pub mod projection;
pub mod sample;
pub mod screen;
pub mod spec;
pub mod trace;

#[cfg(test)]
mod tests;

use crate::kicad::board::{Board, RoutedCopper, Track, Via};
use crate::kicad::geom::boolean::union;
use crate::kicad::geom::{FillIndex, Polygon, Pt, from_mm, to_mm};
use crate::kicad::pad::PadKind;
use crate::si::drivers::netlist::{Netlist, export_netlist};
use crate::si::drivers::table::Table;
use crate::si::drivers::{Edge, Geometry, Lookup, net_edge};
use crate::si::impedance::{Stackup, parse_stackup};
use crate::si::py::g;
use detour::{Plane, d124c_detour_mm, detour_mm};
use native::{Reference, fill_edges, ground_portals, prove_native_stub};
use projection::{EdgeIndex, PathInputs, evaluate_paths};
use sample::{Anchor, NetInputs, P, RefAt, Run, Sample, evaluate_net, sample_arc, sample_segment};
use screen::{Domains, Edges, Piece, Results, d124c_reference_failures, island_failures, max_min_distance, net_edge_of, plane_cut_failures, planes_outcome, reference_assessment};
use spec::{Caps, Spec};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use trace::{TraceRecord, d124c_trace_geometry, trace_geometry};

/// The fill of one zone on one layer, in board order.
pub struct Fill<'a> {
    pub net: &'a str,
    pub polygons: &'a [Polygon],
    pub index: FillIndex,
}

type Fills<'a> = BTreeMap<&'a str, Vec<Fill<'a>>>;

fn filled_copper(board: &Board) -> Fills<'_> {
    let mut fills = Fills::new();
    for zone in board.zones.iter().filter(|z| z.rule_area.is_none()) {
        for layer in &zone.layers {
            let polygons = zone.filled.iter().find(|f| f.layer == *layer).map_or(&[][..], |f| f.polygons.as_slice());
            fills.entry(layer.as_str()).or_default().push(Fill { net: &zone.net, polygons, index: FillIndex::new(polygons) });
        }
    }
    fills
}

fn reference_at<'a>(fills: &'a Fills<'a>, layer: &str) -> impl Fn(f64, f64) -> Option<&'a str> + 'a {
    let on_layer = fills.get(layer).map_or(&[][..], Vec::as_slice);
    move |x, y| {
        let at = Pt::new(from_mm(x), from_mm(y));
        on_layer.iter().find(|f| f.index.contains(at)).map(|f| f.net)
    }
}

fn mm(p: Pt) -> P {
    (to_mm(p.x), to_mm(p.y))
}

/// Rows by key, in first-seen order: the findings follow the board's order.
struct Keyed<V> {
    at: HashMap<(String, String), usize>,
    rows: Vec<((String, String), V)>,
}

impl<V: Default> Keyed<V> {
    fn new() -> Keyed<V> {
        Keyed { at: HashMap::new(), rows: Vec::new() }
    }

    fn entry(&mut self, layer: &str, net: &str) -> &mut V {
        let key = (layer.to_string(), net.to_string());
        let rows = &mut self.rows;
        let at = *self.at.entry(key.clone()).or_insert_with(|| {
            rows.push((key, V::default()));
            rows.len() - 1
        });
        &mut self.rows[at].1
    }
}

/// What the copper of a board gives the checks.
struct Copper {
    pad_refs: BTreeMap<String, Vec<Option<String>>>,
    anchors: BTreeMap<String, Vec<Anchor>>,
    /// Per net: x, y, radius of its through-hole pads.
    through_pads: BTreeMap<String, Vec<Anchor>>,
    vias: BTreeMap<String, Vec<Anchor>>,
    paths: Keyed<Vec<Vec<P>>>,
    cuts: Keyed<f64>,
    samples: Keyed<Vec<Sample>>,
    routed: BTreeMap<String, f64>,
    width: BTreeMap<String, f64>,
    records: Vec<TraceRecord>,
}

fn read_pads(board: &Board, spec: &Spec, copper: &mut Copper) {
    let outlines: Vec<(&str, &[Polygon])> = board.zones.iter().filter(|z| z.rule_area.is_none() && (spec.grounds.contains(&z.net) || spec.alt_refs.iter().any(|(n, _)| *n == z.net))).map(|z| (z.net.as_str(), z.outline.as_slice())).collect();
    for (_, pad) in board.pads() {
        let (x, y) = mm(pad.position);
        let radius = to_mm(pad.size.x.max(pad.size.y)) / 2.0;
        if pad.kind == PadKind::ThroughHole {
            copper.through_pads.entry(pad.net.clone()).or_default().push((x, y, radius));
        }
        let reference = outlines.iter().find(|(_, o)| o.iter().any(|p| p.contains(pad.position))).map(|(n, _)| n.to_string());
        copper.pad_refs.entry(pad.net.clone()).or_default().push(reference);
        copper.anchors.entry(pad.net.clone()).or_default().push((x, y, radius));
    }
}

fn read_via(v: &Via, copper: &mut Copper) {
    let (x, y) = mm(v.at);
    let anchor = (x, y, to_mm(v.size) / 2.0);
    copper.anchors.entry(v.net.clone()).or_default().push(anchor);
    copper.vias.entry(v.net.clone()).or_default().push(anchor);
}

fn read_track(t: &Track, spec: &Spec, copper: &mut Copper) {
    let (a, e) = (mm(t.start), mm(t.end));
    let path: Vec<P> = t.mid.map_or(vec![a, e], |m| vec![a, mm(m), e]);
    let width = to_mm(t.width);
    let points = t.mid.map_or(vec![t.start, t.end], |m| vec![t.start, m, t.end]);
    copper.records.push(TraceRecord { net: t.net.clone(), layer: t.layer.clone(), path: points, width_mm: width });
    let pts = if path.len() == 3 { sample_arc(path[0], path[1], path[2], spec.step_mm) } else { sample_segment(a, e, spec.step_mm) };
    let length: f64 = pts.iter().map(|s| s.w).sum();
    *copper.routed.entry(t.net.clone()).or_default() += length;
    let narrowest = copper.width.entry(t.net.clone()).or_insert(f64::INFINITY);
    *narrowest = narrowest.min(width);
    if spec.adjacent_of(&t.layer).is_some() {
        copper.paths.entry(&t.layer, &t.net).push(path);
        copper.samples.entry(&t.layer, &t.net).extend(pts);
    } else {
        *copper.cuts.entry(&t.layer, &t.net) += length;
    }
}

fn read_copper(board: &Board, spec: &Spec) -> Copper {
    let mut copper = Copper {
        pad_refs: BTreeMap::new(), anchors: BTreeMap::new(), through_pads: BTreeMap::new(), vias: BTreeMap::new(),
        paths: Keyed::new(), cuts: Keyed::new(), samples: Keyed::new(), routed: BTreeMap::new(), width: BTreeMap::new(), records: Vec::new(),
    };
    read_pads(board, spec, &mut copper);
    for item in &board.copper {
        match item {
            RoutedCopper::Via(v) => read_via(v, &mut copper),
            RoutedCopper::Track(t) => read_track(t, spec, &mut copper),
        }
    }
    copper
}

/// Alt-ref net -> centres of its decoupling caps (a C part from it to a ground).
fn decoupling_caps(board: &Board, spec: &Spec) -> Caps {
    let mut caps = Caps::new();
    for fp in board.footprints.iter().filter(|f| f.reference.starts_with('C')) {
        let nets: BTreeSet<&str> = fp.pads.iter().map(|p| p.net.as_str()).collect();
        if spec.grounds.iter().any(|g| nets.contains(g.as_str())) {
            for (net, _) in spec.alt_refs.iter().filter(|(n, _)| nets.contains(n.as_str())) {
                caps.entry(net.clone()).or_default().push(mm(fp.position));
            }
        }
    }
    caps
}

fn fill_percent(area: f64, board_area: f64) -> f64 {
    area / 1e12 / board_area * 100.0
}

fn plane_info(fills: &Fills, spec: &Spec, board_area: f64) -> Vec<String> {
    spec.plane_layers.iter().map(|layer| {
        let on_layer = fills.get(layer.as_str()).map_or(&[][..], Vec::as_slice);
        let area = |f: &Fill| f.polygons.iter().map(Polygon::area).sum::<f64>();
        let filled = on_layer.iter().map(area).sum::<f64>() / 1e12;
        let per: Vec<String> = on_layer.iter().map(|f| format!("{} {:.0}%", f.net, fill_percent(area(f), board_area))).collect();
        format!("INFO plane {layer}: fill {:.0}% of board ({})", 100.0 * filled / board_area, per.join(", "))
    }).collect()
}

fn stitch_info(board: &Board, fills: &Fills, spec: &Spec, vias: &BTreeMap<String, Vec<Anchor>>) -> Vec<String> {
    let bb = board.edges_bbox;
    let (left, top) = (to_mm(bb.left), to_mm(bb.top));
    let (columns, rows) = (to_mm(bb.right - bb.left) as i64 + 1, to_mm(bb.bottom - bb.top) as i64 + 1);
    spec.grounds.iter().map(|ground| {
        let pours: Vec<&Fill> = fills.values().flatten().filter(|f| f.net == ground).collect();
        let mut points = Vec::new();
        for i in 0..columns {
            for j in 0..rows {
                let (x, y) = (left + i as f64, top + j as f64);
                let at = Pt::new(from_mm(x), from_mm(y));
                if pours.iter().any(|f| f.index.contains(at)) {
                    points.push((x, y));
                }
            }
        }
        let own: Vec<P> = vias.get(ground).map_or(Vec::new(), |v| v.iter().map(|a| (a.0, a.1)).collect());
        let far = max_min_distance(&points, &own).map_or("n/a (no via)".to_string(), |d| format!("{d:.1} mm"));
        format!("INFO stitch {ground}: {} vias, farthest pour point {far} from a via", own.len())
    }).collect()
}

/// The copper pieces of one ground on one layer: fills of two zones of the same net that touch are one piece.
fn ground_pieces(fills: &[&Fill]) -> Result<Vec<Polygon>, String> {
    fills.iter().try_fold(Vec::new(), |acc, f| union(&acc, f.polygons))
}

fn island_pieces(fills: &Fills, spec: &Spec, copper: &Copper) -> Result<(Vec<Piece>, Vec<String>), String> {
    let (mut pieces, mut info): (Vec<Piece>, Vec<String>) = (Vec::new(), Vec::new());
    for (layer, _) in &spec.mixed_layers {
        for ground in &spec.grounds {
            let touch = |list: Option<&Vec<Anchor>>| list.map_or(Vec::new(), |l| l.clone());
            let points: Vec<Anchor> = touch(copper.vias.get(ground)).into_iter().chain(touch(copper.through_pads.get(ground))).collect();
            let of_ground: Vec<&Fill> = fills.get(layer.as_str()).map_or(&[][..], Vec::as_slice).iter().filter(|f| f.net == ground).collect();
            for piece in ground_pieces(&of_ground)? {
                let shape = Polygon::of_ring(piece.outline.clone());
                // a via or pad touches the piece (a thermal pad centre sits outside the fill)
                let n = points.iter().filter(|(x, y, r)| shape.near(Pt::new(from_mm(*x), from_mm(*y)), from_mm(*r) + 1000)).count();
                pieces.push((layer.clone(), ground.clone(), n, mm(piece.outline[0])));
            }
        }
        let mut tracks: Vec<(&str, f64)> = copper.cuts.rows.iter().filter(|((l, _), _)| l == layer).map(|((_, n), v)| (n.as_str(), *v)).collect();
        tracks.sort_by(|a, b| a.0.cmp(b.0));
        let listed: Vec<String> = tracks.iter().map(|(n, v)| format!("{n} {v:.1} mm")).collect();
        info.push(format!("INFO mixed {layer}: {} ground fill pieces; tracks: {}", pieces.iter().filter(|q| q.0 == *layer).count(), if listed.is_empty() { "none".to_string() } else { listed.join(", ") }));
    }
    Ok((pieces, info))
}

/// The driver edges of nets in `nets`, the D-124d way (`by_class`: a class counts through its interface) or the D-124c way.
fn driver_edges(nets: &BTreeSet<&str>, spec: &Spec, netlist: &Netlist, table: &Table, geom: &Geometry, by_class: bool) -> Edges {
    let power = spec.power_patterns();
    let lookup = Lookup { netlist, table, receivers: &spec.receivers, offboard: &spec.offboard, rates: &spec.rates, power: &power, geom };
    let wanted = nets.iter().filter(|n| spec.checked(n) && !spec.is_power(n) && !spec.is_fast(n) && (by_class || spec.edge_class(n).is_none()));
    wanted.map(|n| (n.to_string(), net_edge(n, &lookup, if by_class { spec.edge_class(n) } else { None }))).collect()
}

/// The findings of a board: the counted FAIL lines, the report lines and the --verbose detail.
pub struct Outcome {
    pub fails: Vec<String>,
    pub info: Vec<String>,
    pub detail: Vec<String>,
}

fn grid_cell(budget: f64) -> f64 {
    // 0.1 mm, coarser for a long budget (at most 200 cells per budget; a coarser grid only makes the path longer, so it never hides
    // a failure).
    (budget / 200.0).max(0.1).min(0.5)
}

struct Check<'a> {
    board: &'a Board,
    spec: &'a Spec,
    caps: &'a Caps,
    fills: &'a Fills<'a>,
    copper: &'a Copper,
}

impl<'a> Check<'a> {
    fn plane_of(&self, layer: &str) -> &'a str {
        self.spec.adjacent_of(layer).expect("a checked outer layer")
    }

    fn d124c_detour(&self, layer: &str, domain: &str, run: &Run, budget: f64) -> Option<f64> {
        let ref_at = reference_at(self.fills, self.plane_of(layer));
        let ok = |x: f64, y: f64| self.spec.ref_domain(ref_at(x, y), false, (x, y), self.caps) == Some(domain);
        let touch = |list: Option<&Vec<Anchor>>| list.map_or(Vec::new(), |l| l.iter().map(|a| (a.0, a.1)).collect::<Vec<P>>());
        let ports: Vec<P> = touch(self.copper.vias.get(domain)).into_iter().chain(touch(self.copper.through_pads.get(domain))).collect();
        d124c_detour_mm(&ok, &run.terminals, budget, grid_cell(budget), &ports)
    }

    fn reference(&self, cache: &mut HashMap<(String, String), std::rc::Rc<Reference<'a>>>, layer: &str, domain: &str) -> std::rc::Rc<Reference<'a>> {
        let on_layer: &'a [Fill<'a>] = self.fills.get(layer).map_or(&[][..], Vec::as_slice);
        cache.entry((layer.to_string(), domain.to_string())).or_insert_with(|| std::rc::Rc::new(Reference::new(self.board, on_layer, layer, domain, self.spec, self.caps))).clone()
    }

    fn native_detour(&self, cache: &mut HashMap<(String, String), std::rc::Rc<Reference<'a>>>, layer: &str, domain: &str, run: &Run, budget: f64) -> Option<f64> {
        if run.proven_stub.get() {
            return Some(0.0);
        }
        if budget == 0.0 && run.terminals.len() != 1 {
            return None;
        }
        let plane_layer = self.plane_of(layer);
        let reference = self.reference(cache, plane_layer, domain);
        if run.terminals.len() < 2 && prove_native_stub(self.board, layer, &run.net, run, &reference) {
            run.proven_stub.set(true);
            return Some(0.0);
        }
        if budget == 0.0 {
            return None;
        }
        let ok = |x: f64, y: f64| reference.ok(x, y);
        let edge = |a: P, b: P| reference.edge(a, b);
        let plane = Plane { ok: &ok, edge: &edge };
        let cell = grid_cell(budget);
        let alternate_layer = self.board.copper_layers.iter().find(|l| *l == "In1.Cu" && *l != plane_layer);
        let Some(alternate_layer) = alternate_layer else { return detour_mm(plane, None, &run.terminals, budget, cell, &[]) };
        let other = self.reference(cache, alternate_layer, domain);
        let alt_ok = |x: f64, y: f64| other.ok(x, y);
        let alt_edge = |a: P, b: P| other.edge(a, b);
        // A blind or buried via that does not span both planes is no portal.
        let ports = ground_portals(self.board, plane_layer, alternate_layer, domain);
        detour_mm(plane, Some(Plane { ok: &alt_ok, edge: &alt_edge }), &run.terminals, budget, cell, &ports)
    }
}

fn verbose_detail(results: &Results, domains: &Domains, spec: &Spec, edges: &Edges) -> Vec<String> {
    let mut rows: Vec<&((String, String), sample::NetResult)> = results.iter().collect();
    rows.sort_by(|a, b| b.1.worst.total_cmp(&a.1.worst));
    let mut detail: Vec<String> = rows.iter().map(|((layer, net), r)| {
        let pct = if r.length != 0.0 { 100.0 * r.unref / r.length } else { 0.0 };
        let kind = if spec.is_power(net) {
            "power".to_string()
        } else if spec.is_fast(net) {
            "fast".to_string()
        } else {
            spec.edge_class(net).map(str::to_string).unwrap_or_else(|| net_edge_of(net, spec, edges).0.map_or("unknown driver".to_string(), |tr| format!("{} ns", g(tr))))
        };
        let domain = domains.get(net).and_then(|d| d.as_deref()).unwrap_or("None");
        format!("  {layer} {net} [{domain}, {kind}]: {:.1} mm, unref {:.1} mm ({pct:.0}%), worst {:.1} mm, {} runs, cross {:.1} mm", r.length, r.unref, r.worst, r.runs.len(), r.cross)
    }).collect();
    detail.extend(spec.exempt_nets.iter().map(|(net, why)| format!("  exempt {net}: {why}")));
    detail
}

fn budget_info(spec: &Spec, board_mm: f64) -> Result<String, String> {
    let classes = spec.rates.classes.iter().map(|(k, v)| Ok(format!("{k} {} ns -> {:.1} mm{}", g(v.tr_ns), spec.rates.budget_mm(v.tr_ns)?, if v.assumption { " (assumption)" } else { "" }))).collect::<Result<Vec<_>, String>>()?;
    Ok(format!("INFO detour budget: no rule above {board_mm:.0} mm (board bounding-box perimeter); {}; other nets: the edge of their driver (tools/driver-edges.json)", classes.join(", ")))
}

/// Where the driver data and stackup come from.
pub struct Sources<'a> {
    pub board_text: &'a str,
    pub netlist: &'a Netlist,
    pub table: &'a Table,
}

/// Checks a board against a spec.
pub fn analyse(board: &Board, spec: &Spec, sources: &Sources, verbose: bool) -> Result<Outcome, String> {
    spec.check_against_board(board)?;
    let fills = filled_copper(board);
    let copper = read_copper(board, spec);
    let caps = decoupling_caps(board, spec);
    let domains: Domains = copper.paths.rows.iter().map(|((_, net), _)| (net.clone(), spec.net_domain(net, copper.pad_refs.get(net).map_or(&[][..], Vec::as_slice)))).collect();
    let boundaries: BTreeMap<&str, EdgeIndex> = spec.adjacent.iter().map(|(_, plane)| (plane.as_str(), EdgeIndex::new(fill_edges(fills.get(plane.as_str()).map_or(&[][..], Vec::as_slice))))).collect();
    let no_anchors: Vec<Anchor> = Vec::new();

    let mut results: Results = Vec::new();
    for ((layer, net), paths) in copper.paths.rows.iter().filter(|((_, n), _)| spec.checked(n)) {
        let plane = spec.adjacent_of(layer).expect("a path on an outer layer");
        let ref_at = reference_at(&fills, plane);
        let ref_at: &RefAt = &ref_at;
        let inputs = PathInputs { boundaries: boundaries.get(plane), ref_at, domain: domains[net].as_deref(), anchors: copper.anchors.get(net).unwrap_or(&no_anchors), spec, net, caps: &caps };
        results.push(((layer.clone(), net.clone()), evaluate_paths(paths, &inputs)));
    }
    let mut d124c: Results = Vec::new();
    for ((layer, net), samples) in copper.samples.rows.iter().filter(|((_, n), _)| spec.checked(n)) {
        let ref_at = reference_at(&fills, spec.adjacent_of(layer).expect("a sample on an outer layer"));
        let ref_at: &RefAt = &ref_at;
        let inputs = NetInputs { ref_at, domain: domains[net].as_deref(), anchors: copper.anchors.get(net).unwrap_or(&no_anchors), spec, net, caps: &caps };
        d124c.push(((layer.clone(), net.clone()), evaluate_net(samples, &inputs)));
    }

    let stackup: Option<Stackup> = parse_stackup(sources.board_text)?;
    let edges = driver_edges(&results.iter().map(|((_, n), _)| n.as_str()).collect(), spec, sources.netlist, sources.table, &trace_geometry(stackup.as_ref(), spec, &copper.records)?, true);
    let d124c_geom = d124c_trace_geometry(stackup.as_ref(), spec, copper.routed.clone(), &copper.width);
    let d124c_edges = driver_edges(&d124c.iter().map(|((_, n), _)| n.as_str()).collect(), spec, sources.netlist, sources.table, &d124c_geom, false);

    let board_area = board.outlines.iter().map(Polygon::area).sum::<f64>() / 1e12;
    let mut info = plane_info(&fills, spec, board_area);
    info.extend(stitch_info(board, &fills, spec, &copper.vias));
    let (pieces, mixed) = island_pieces(&fills, spec, &copper)?;
    info.extend(mixed);

    let bb = board.edges_bbox;
    let board_mm = 2.0 * (to_mm(bb.right - bb.left) + to_mm(bb.bottom - bb.top));
    let check = Check { board, spec, caps: &caps, fills: &fills, copper: &copper };
    let enforced = d124c_reference_failures(&d124c, &domains, spec, &d124c_edges, &mut |layer, domain, run, budget| check.d124c_detour(layer, domain, run, budget), board_mm)?;
    let mut cache = HashMap::new();
    let assessment = reference_assessment(&results, &domains, spec, &edges, &mut |layer, domain, run, budget| check.native_detour(&mut cache, layer, domain, run, budget), board_mm)?;
    let mut geometry = plane_cut_failures(&copper.cuts.rows, spec);
    geometry.extend(island_failures(&pieces));
    let (fails, report) = planes_outcome(geometry, &enforced, &assessment);
    info.extend(report);
    info.push(format!("SI_TIMING_EVIDENCE mode=report-only decision=D-124d-proposed unresolved={} timing_evidence_complete={}; geometry/model/physical_board_qualification separate", assessment.evidence.len(), assessment.evidence.is_empty()));
    info.push(budget_info(spec, board_mm)?);
    let unknown = edges.values().filter(|e| matches!(e, Edge::Unknown(_))).count();
    info.push(format!("INFO drivers: {} nets with a driver edge, {unknown} unknown (a failure only with a crossing)", edges.len() - unknown));
    let detail = if verbose { verbose_detail(&results, &domains, spec, &edges) } else { Vec::new() };
    Ok(Outcome { fails, info, detail })
}

/// The schematic of a board: the spec's, relative to the spec, else the board file with .kicad_sch.
pub fn schematic_of(spec: &Spec, spec_dir: &Path, board: &Path) -> PathBuf {
    spec.schematic.as_ref().map_or_else(|| board.with_extension("kicad_sch"), |s| spec_dir.join(s))
}

/// The netlist and table of a run.
pub fn load_drivers(spec: &Spec, spec_dir: &Path, board: &Path, tools: &Path) -> Result<(Netlist, Table), String> {
    Ok((export_netlist(&schematic_of(spec, spec_dir, board))?, Table::load(tools)?))
}
