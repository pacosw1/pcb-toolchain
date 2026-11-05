//! Native reference geometry of the D-124d proposal (report-only): fresh filled copper plus the physical ground lands of a layer, and
//! the proof of an unloaded straight stub.
use super::Fill;
use super::projection::{Boundaries, Edge, EdgeIndex, Round, continuous_reference, reference_breaks};
use super::sample::{P, Run};
use super::spec::{Caps, Spec};
use crate::kicad::board::{Board, RoutedCopper, Track};
use crate::kicad::geom::boolean::circle_segments;
use crate::kicad::geom::polygon::segment_touches;
use crate::kicad::geom::{FillIndex, Iu, Polygon, Pt, from_mm, ki_round, to_mm};
use crate::kicad::pad::{Copper, PadKind};
use crate::si::pairs::arc_points;
use crate::si::py::dist;

/// FromMM(.001): the error of a land outline.
const LAND_ERROR: Iu = 1000;
const ARC_CHORD_MM: f64 = 0.05;

fn mm(p: Pt) -> P {
    (to_mm(p.x), to_mm(p.y))
}

fn nm(p: P) -> Pt {
    Pt::new(from_mm(p.0), from_mm(p.1))
}

/// The even segment count of a circle at the land error.
fn segments(radius: Iu) -> i64 {
    let n = circle_segments(radius, LAND_ERROR).max(8);
    n + n % 2
}

/// TransformCircleToPolygon with ERROR_INSIDE.
fn circle_ring(center: Pt, radius: Iu) -> Polygon {
    let n = segments(radius);
    Polygon::of_ring((0..n).map(|i| Pt::new(radius, 0).rotated(i as f64 * 360.0 / n as f64) + center).collect())
}

/// The outline of a straight track: two half circles, inside the true copper.
fn stadium(a: Pt, b: Pt, width: Iu) -> Polygon {
    if a == b {
        return circle_ring(a, width / 2);
    }
    let (dx, dy) = ((b.x - a.x) as f64, (b.y - a.y) as f64);
    let base = dy.atan2(dx);
    let (r, half) = (width as f64 / 2.0, segments(width / 2) / 2);
    let cap = |center: Pt, from: f64| (0..=half).map(move |i| {
        let t = from + std::f64::consts::PI * i as f64 / half as f64;
        Pt::new(center.x + ki_round(r * t.cos()), center.y + ki_round(r * t.sin()))
    });
    Polygon::of_ring(cap(b, base - std::f64::consts::FRAC_PI_2).chain(cap(a, base + std::f64::consts::FRAC_PI_2)).collect())
}

/// The straight pieces of a track.
fn track_pieces(t: &Track) -> Vec<(Pt, Pt)> {
    match t.mid {
        None => vec![(t.start, t.end)],
        Some(m) => arc_points(mm(t.start), mm(m), mm(t.end), ARC_CHORD_MM).windows(2).map(|w| (nm(w[0]), nm(w[1]))).collect(),
    }
}

/// The copper of a net on a layer, as polygons: the lands that connect a ground barrel to the fill through real copper.
fn lands(board: &Board, layer: &str, domain: &str) -> Vec<Polygon> {
    let mut out = Vec::new();
    for copper in &board.copper {
        match copper {
            RoutedCopper::Via(v) if v.net == domain => out.push(circle_ring(v.at, v.size / 2)),
            RoutedCopper::Track(t) if t.net == domain && t.layer == layer => out.extend(track_pieces(t).into_iter().map(|(a, b)| stadium(a, b, t.width))),
            _ => {}
        }
    }
    out.extend(board.pads().map(|(_, p)| p).filter(|p| p.net == domain).filter_map(|p| p.polygons.get(layer).cloned()));
    out
}

fn ring_edges(polygon: &Polygon, edges: &mut Vec<Edge>) {
    for ring in polygon.rings() {
        let points: Vec<P> = ring.iter().map(|p| mm(*p)).collect();
        edges.extend((0..points.len()).map(|i| (points[i], points[(i + 1) % points.len()])));
    }
}

/// The edges of every polygon of the fills of a layer.
pub fn fill_edges(fills: &[Fill]) -> Vec<Edge> {
    let mut edges = Vec::new();
    for polygon in fills.iter().flat_map(|f| f.polygons) {
        ring_edges(polygon, &mut edges);
    }
    edges
}

/// The reference copper of one domain on one layer.
pub struct Reference<'a> {
    fills: &'a [Fill<'a>],
    lands: Vec<FillIndex>,
    boundaries: EdgeIndex,
    circles: Vec<Round>,
    domain: String,
    spec: &'a Spec,
    caps: &'a Caps,
}

impl<'a> Reference<'a> {
    pub fn new(board: &Board, fills: &'a [Fill<'a>], layer: &str, domain: &str, spec: &'a Spec, caps: &'a Caps) -> Reference<'a> {
        let lands = lands(board, layer, domain);
        let mut edges = fill_edges(fills);
        for land in &lands {
            ring_edges(land, &mut edges);
        }
        let circles = spec.alt_refs.iter().filter_map(|(n, a)| a.cap_mm.map(|cap| (n, cap)))
            .flat_map(|(n, cap)| caps.get(n).map_or(&[][..], Vec::as_slice).iter().map(move |c| (*c, cap))).collect();
        let lands = lands.iter().map(|l| FillIndex::new(std::slice::from_ref(l))).collect();
        Reference { fills, lands, boundaries: EdgeIndex::new(edges), circles, domain: domain.to_string(), spec, caps }
    }

    pub fn ok(&self, x: f64, y: f64) -> bool {
        let at = Pt::new(from_mm(x), from_mm(y));
        if self.lands.iter().any(|l| l.contains(at)) {
            return true;
        }
        let reference = self.fills.iter().find(|f| f.index.contains(at)).map(|f| f.net);
        self.spec.ref_domain(reference, false, (x, y), self.caps) == Some(self.domain.as_str())
    }

    fn boundaries(&self) -> Boundaries<'_> {
        Boundaries { index: Some(&self.boundaries), extra: Vec::new() }
    }

    pub fn edge(&self, a: P, b: P) -> bool {
        continuous_reference(&|x, y| self.ok(x, y), &self.boundaries(), a, b, &self.circles)
    }

    pub(crate) fn breaks(&self, a: P, b: P) -> Vec<f64> {
        reference_breaks(&self.boundaries(), a, b, &self.circles)
    }
}

/// Only the domain's conductive barrels spanning both planes. The board JSON gives no via span: every via is a through via.
pub fn ground_portals(board: &Board, layer: &str, alternate: &str, domain: &str) -> Vec<P> {
    let vias = board.copper.iter().filter_map(|c| if let RoutedCopper::Via(v) = c { Some(v) } else { None }).filter(|v| v.net == domain).map(|v| mm(v.at));
    let on_both = |layers: &[String]| layers.iter().any(|l| l == layer) && layers.iter().any(|l| l == alternate);
    let pads = board.pads().map(|(_, p)| p).filter(|p| p.net == domain && p.kind == PadKind::ThroughHole && on_both(&p.layers)).map(|p| mm(p.position));
    vias.chain(pads).collect()
}

/// A conservative straight-leaf contract; this alone is no stub proof. One genuine reference attachment, a contiguous referenced
/// prefix then an unreferenced tip, and every measured bad point on this same segment. Gives start, exit and end.
pub fn single_leaf_candidate(start: P, end: P, run: &Run, ref_ok: &dyn Fn(f64, f64) -> bool, breaks: &dyn Fn(P, P) -> Vec<f64>) -> Option<(P, P, P)> {
    if run.terminals.len() != 1 || run.bad_points.is_empty() {
        return None;
    }
    let (start, end) = if !ref_ok(start.0, start.1) && ref_ok(end.0, end.1) { (end, start) } else { (start, end) };
    if !ref_ok(start.0, start.1) || ref_ok(end.0, end.1) {
        return None;
    }
    let (dx, dy) = (end.0 - start.0, end.1 - start.1);
    let norm = dx * dx + dy * dy;
    if norm == 0.0 {
        return None;
    }
    let cuts = breaks(start, end);
    let states: Vec<bool> = cuts.windows(2).map(|w| (w[0] + w[1]) / 2.0).map(|t| ref_ok(start.0 + t * dx, start.1 + t * dy)).collect();
    if states.first() != Some(&true) || states.last() != Some(&false) {
        return None;
    }
    let first = states.iter().position(|s| !s).expect("the last is false");
    if states[first..].iter().any(|s| *s) {
        return None;
    }
    let exit_t = cuts[first];
    let on_segment = |q: P, low: f64, high: f64| {
        let t = ((q.0 - start.0) * dx + (q.1 - start.1) * dy) / norm;
        low - 1e-9 <= t && t <= high + 1e-9 && dist(q, (start.0 + t * dx, start.1 + t * dy)) <= 1e-6
    };
    let terminal = run.terminals[0].at();
    if !ref_ok(terminal.0, terminal.1) || !on_segment(terminal, 0.0, exit_t) {
        return None;
    }
    if !run.bad_points.iter().all(|q| on_segment(*q, exit_t, 1.0) && !ref_ok(q.0, q.1)) {
        return None;
    }
    Some((start, (start.0 + exit_t * dx, start.1 + exit_t * dy), end))
}

/// A copper item of a layer, as the primitives of its effective shape.
struct Item<'a> {
    net: &'a str,
    id: &'a str,
    shape: Vec<Copper>,
}

fn items_on<'a>(board: &'a Board, layer: &str) -> Vec<Item<'a>> {
    let mut out = Vec::new();
    for copper in &board.copper {
        match copper {
            RoutedCopper::Via(v) => out.push(Item { net: &v.net, id: &v.id, shape: vec![Copper::Circle { center: v.at, radius: v.size / 2 }] }),
            RoutedCopper::Track(t) if t.layer == layer => {
                out.push(Item { net: &t.net, id: &t.id, shape: track_pieces(t).into_iter().map(|(a, b)| Copper::Segment { a, b, width: t.width }).collect() });
            }
            _ => {}
        }
    }
    out.extend(board.pads().map(|(_, p)| p).filter(|p| p.layers.iter().any(|l| l == layer)).map(|p| Item { net: &p.net, id: &p.id, shape: p.copper.clone() }));
    out
}

/// Proves an unloaded straight copper leaf, not a pad or via escape. Multi-segment, arc and branch stubs remain unproven. No pad, via
/// or other conductor may touch the unreferenced tip, and the referenced prefix must attach to another same-net conductor.
pub fn prove_native_stub(board: &Board, layer: &str, net: &str, run: &Run, reference: &Reference) -> bool {
    let tracks = board.copper.iter().filter_map(|c| if let RoutedCopper::Track(t) = c { Some(t) } else { None }).filter(|t| t.mid.is_none() && t.net == net && t.layer == layer);
    let ok = |x: f64, y: f64| reference.ok(x, y);
    let breaks = |a: P, b: P| reference.breaks(a, b);
    let candidates: Vec<(&Track, (P, P, P))> = tracks.filter_map(|t| Some((t, single_leaf_candidate(mm(t.start), mm(t.end), run, &ok, &breaks)?))).collect();
    let [(track, (_, exit, end))] = candidates[..] else { return false };
    let (tip_a, tip_b) = (nm(exit), nm(end));
    let mut attached = false;
    for item in items_on(board, layer).iter().filter(|i| i.id != track.id) {
        if item.shape.iter().any(|c| segment_touches(c, tip_a, tip_b, track.width)) {
            return false;
        }
        attached |= item.net == net && item.shape.iter().any(|c| segment_touches(c, track.start, track.end, track.width));
    }
    attached
}
