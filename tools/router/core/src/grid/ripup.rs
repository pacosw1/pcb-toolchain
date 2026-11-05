//! Rip-up and re-route for the last open connections of a routed board (2026-10-16, H7-CORE). For the first open connection of a net:
//! a path on the grid with the unlocked copper of the other nets left out, rip the copper of other nets the path needs, lay the path
//! locked, then re-route what the rip opened. The board keeps the result only when the open count (KiCad DRC, signal nets) goes down.
use super::astar::{DEFAULT_WEIGHT, PathItem, Search, astar, exact_hypot, to_items};
use super::finish::{self, DEFAULT_VIA_MM, Options as FinishOptions, route_grids, routing_grid, write_items};
use super::item::{Point, seg_dist};
use super::opens::{Open, item_for, pads_by_uuid, run_drc, signal_opens};
use crate::kicad::board::{Board, RoutedCopper, Track, Via};
use crate::kicad::geom::to_mm;
use crate::kicad::save::WorkDir;
use crate::kicad::session::Session;
use crate::model::text::glob_match;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

const SKIP: [&str; 2] = ["GND", "VDD_3V3"];
const TURN_COST_MM: f64 = 0.3;
/// The clearance a rip keeps from the new path. Radius of the path's via: its 0.6 mm default.
const RIP_CLEARANCE_MM: f64 = 0.2;
const PATH_VIA_RADIUS_MM: f64 = 0.3;
const VIA_DRILL_MM: f64 = 0.3;
/// A track end farther than this from a path via never hits it.
const FAR_MM: f64 = 9.0;

#[derive(Debug, Clone, PartialEq)]
pub struct Options {
    pub net: String,
    pub layers: Vec<String>,
    pub margin: f64,
    pub via_cost: f64,
    pub grid: f64,
    pub width: f64,
    pub via_halo: f64,
    /// Keep a result with the same open count when this net has fewer: a step of a chain.
    pub accept_equal: bool,
    /// Nets whose copper is never ripped. Empty: locked copper is what stays.
    pub protect: Vec<String>,
}

impl Default for Options {
    fn default() -> Self {
        Options { net: String::new(), layers: vec!["F.Cu".to_string(), "B.Cu".to_string()], margin: 30.0, via_cost: 3.0, grid: 0.05, width: 0.15, via_halo: 0.0, accept_equal: false, protect: Vec::new() }
    }
}

pub struct Outcome {
    pub line: String,
    pub passed: bool,
}

fn opens(board: &Path) -> Result<Vec<Open>, String> {
    let work = WorkDir::beside(board, "ripup")?;
    Ok(signal_opens(&run_drc(board, &work.0.join("drc.json"))?, &SKIP))
}

fn fixed(o: &Options, net: &str, locked: bool) -> bool {
    if o.protect.is_empty() { locked } else { o.protect.iter().any(|pattern| glob_match(net, pattern)) }
}

fn point(p: crate::kicad::geom::Pt) -> Point {
    (to_mm(p.x), to_mm(p.y))
}

fn point_to_segment(p: Point, a: Point, b: Point) -> f64 {
    seg_dist(p.0, p.1, [a.0, a.1, b.0, b.1])
}

/// The distance of two segments. Crossing segments are at 0: the endpoint distances miss a crossing (2026-10-16, DRC tracks_crossing).
pub fn segments_distance(a1: Point, a2: Point, b1: Point, b2: Point) -> f64 {
    let cross = |o: Point, p: Point, q: Point| (p.0 - o.0) * (q.1 - o.1) - (p.1 - o.1) * (q.0 - o.0);
    let (d1, d2, d3, d4) = (cross(b1, b2, a1), cross(b1, b2, a2), cross(a1, a2, b1), cross(a1, a2, b2));
    if (d1 > 0.0) != (d2 > 0.0) && (d3 > 0.0) != (d4 > 0.0) {
        return 0.0;
    }
    point_to_segment(a1, b1, b2).min(point_to_segment(a2, b1, b2)).min(point_to_segment(b1, a1, a2)).min(point_to_segment(b2, a1, a2))
}

fn via_hit(via: &Via, items: &[PathItem], clearance: f64) -> bool {
    let (q, r) = (point(via.at), to_mm(via.size) / 2.0);
    items.iter().any(|item| match *item {
        PathItem::Segment { a, b, .. } => point_to_segment(q, a, b) < r + clearance,
        PathItem::Via(at) => exact_hypot(q.0 - at.0, q.1 - at.1) < r + PATH_VIA_RADIUS_MM + RIP_CLEARANCE_MM,
    })
}

fn track_hit(track: &Track, items: &[PathItem], layers: &[String], clearance: f64) -> bool {
    let (p1, p2, half) = (point(track.start), point(track.end), to_mm(track.width) / 2.0);
    items.iter().any(|item| match *item {
        PathItem::Segment { layer, a, b } => layers[layer] == track.layer && segments_distance(p1, p2, a, b) < half + clearance,
        PathItem::Via(at) => point_to_segment(at, p1, p2).min(FAR_MM) < half + PATH_VIA_RADIUS_MM + RIP_CLEARANCE_MM,
    })
}

/// The ids and nets of the copper the path needs gone.
pub fn to_rip(board: &Board, o: &Options, items: &[PathItem]) -> (Vec<String>, BTreeSet<String>) {
    let clearance = RIP_CLEARANCE_MM + o.width / 2.0;
    let (mut ids, mut nets) = (Vec::new(), BTreeSet::new());
    for copper in &board.copper {
        let (id, net, locked, hit) = match copper {
            RoutedCopper::Via(v) => (&v.id, &v.net, v.locked, via_hit(v, items, clearance)),
            RoutedCopper::Track(t) => (&t.id, &t.net, t.locked, track_hit(t, items, &o.layers, clearance)),
        };
        if hit && !fixed(o, net, locked) && net != &o.net && !SKIP.contains(&net.as_str()) {
            ids.push(id.clone());
            nets.insert(net.clone());
        }
    }
    (ids, nets)
}

/// The board without the copper a rip may take: a path that needs nothing else exists on it.
fn without_rippable(board: &Board, o: &Options) -> Board {
    let mut open = board.clone();
    open.copper.retain(|copper| {
        let (net, locked) = match copper {
            RoutedCopper::Via(v) => (&v.net, v.locked),
            RoutedCopper::Track(t) => (&t.net, t.locked),
        };
        fixed(o, net, locked) || net == &o.net || SKIP.contains(&net.as_str())
    });
    open
}

/// The path of `open` and the via size of its net, or why there is none.
fn find_path(session: &Session, o: &Options, open: &Open) -> Result<Result<(Vec<PathItem>, f64), String>, String> {
    let board = without_rippable(&session.board, o);
    let mut bd = routing_grid(&board, &session.rules, &o.layers, o.grid, Some(o.width), &[])?;
    let by_uuid = pads_by_uuid(&bd);
    let (Some(a), Some(b)) = (item_for(&bd, &open.a, &by_uuid), item_for(&bd, &open.b, &by_uuid)) else {
        return Ok(Err(format!("RIPUP FAIL {}: end item not found", open.net)));
    };
    let (xs, ys) = ([open.a.x(), open.b.x()], [open.a.y(), open.b.y()]);
    let window = bd.window(xs[0].min(xs[1]) - o.margin, ys[0].min(ys[1]) - o.margin, xs[0].max(xs[1]) + o.margin, ys[0].max(ys[1]) + o.margin);
    let grids = route_grids(&mut bd, &open.net, window, o.via_halo);
    let (seeds, target) = (bd.item_seed(a, window), bd.item_seed(b, window));
    let search = Search { seeds: &seeds, target: &target, via_cost: o.via_cost / o.grid, turn_cost: TURN_COST_MM / o.grid, layer_cost: &[], goal: None, weight: DEFAULT_WEIGHT };
    let Some(path) = astar(&grids, &search) else {
        return Ok(Err(format!("RIPUP FAIL {}: no path even with the other unlocked copper removed", open.net)));
    };
    Ok(Ok((to_items(&bd, &window, &path), bd.net_via.get(&open.net).copied().unwrap_or(DEFAULT_VIA_MM))))
}

fn reroute(path: &Path, o: &Options, ripped: &BTreeSet<String>) -> Result<(), String> {
    let again = FinishOptions { nets: ripped.clone(), margin: o.margin, via_cost: o.via_cost, via_halo: o.via_halo, ..FinishOptions::default() };
    let mut session = Session::open(path, &format!("ripup {}", o.net))?;
    finish::run(&mut session, &again, &mut |_| {})
}

fn backup_of(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".ripup-backup");
    PathBuf::from(name)
}

/// The tool on one board. The file changes only on a pass; on a failed repair it goes back to what it was.
pub fn run(path: &Path, o: &Options) -> Result<Outcome, String> {
    let before = opens(path)?;
    let mine: Vec<&Open> = before.iter().filter(|open| open.net == o.net).collect();
    let Some(open) = mine.first() else {
        return Ok(Outcome { line: format!("RIPUP PASS {} not open", o.net), passed: true });
    };
    let mut session = Session::open(path, &format!("ripup {}", o.net))?;
    let (items, via_size) = match find_path(&session, o, open)? {
        Ok(found) => found,
        Err(line) => return Ok(Outcome { line, passed: false }),
    };
    let (rip, ripped) = to_rip(&session.board, o, &items);
    let backup = backup_of(path);
    fs::copy(path, &backup).map_err(|e| format!("{}: {e}", backup.display()))?;
    session.remove(rip);
    write_items(&mut session, &o.net, &items, o.width, &o.layers, via_size, VIA_DRILL_MM);
    session.save_to(path)?;
    if !ripped.is_empty() {
        // A failed repair is not a tool error: the count below decides.
        if let Err(error) = reroute(path, o, &ripped) {
            eprintln!("ripup: {error}");
        }
    }
    let after = opens(path)?;
    let names = ripped.iter().cloned().collect::<Vec<_>>().join(",");
    let fewer_of_net = after.iter().filter(|open| open.net == o.net).count() < mine.len();
    if after.len() < before.len() || (o.accept_equal && after.len() == before.len() && fewer_of_net) {
        fs::remove_file(&backup).map_err(|e| format!("{}: {e}", backup.display()))?;
        let shown = if names.is_empty() { "-" } else { names.as_str() };
        return Ok(Outcome { line: format!("RIPUP PASS {} opens {} -> {} ripped {shown}", o.net, before.len(), after.len()), passed: true });
    }
    fs::rename(&backup, path).map_err(|e| format!("{}: {e}", path.display()))?;
    let left: BTreeSet<&str> = after.iter().map(|open| open.net.as_str()).collect();
    let left = left.into_iter().collect::<Vec<_>>().join(",");
    Ok(Outcome { line: format!("RIPUP FAIL {} opens {} -> {} (board restored) ripped {names}; open after: {left}", o.net, before.len(), after.len()), passed: false })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kicad::geom::{Pt, from_mm};

    fn track(id: &str, net: &str, a: (f64, f64), b: (f64, f64), layer: &str, locked: bool) -> RoutedCopper {
        let at = |p: (f64, f64)| Pt::new(from_mm(p.0), from_mm(p.1));
        RoutedCopper::Track(Track { id: id.to_string(), start: at(a), end: at(b), mid: None, width: from_mm(0.2), layer: layer.to_string(), net: net.to_string(), locked })
    }

    fn via(id: &str, net: &str, at: (f64, f64), locked: bool) -> RoutedCopper {
        RoutedCopper::Via(Via { id: id.to_string(), at: Pt::new(from_mm(at.0), from_mm(at.1)), size: from_mm(0.6), drill: from_mm(0.3), net: net.to_string(), locked, layers: Vec::new() })
    }

    fn board(copper: Vec<RoutedCopper>) -> Board {
        crate::grid::tests::board(Vec::new(), copper)
    }

    fn path() -> Vec<PathItem> {
        vec![PathItem::Segment { layer: 0, a: (0.0, 0.0), b: (10.0, 0.0) }]
    }

    fn options() -> Options {
        Options { net: "A".to_string(), ..Options::default() }
    }

    #[test]
    fn crossing_segments_are_at_zero() {
        assert_eq!(segments_distance((0.0, -1.0), (0.0, 1.0), (-1.0, 0.0), (1.0, 0.0)), 0.0);
        assert!((segments_distance((0.0, 1.0), (1.0, 1.0), (0.0, 0.0), (1.0, 0.0)) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn only_near_unlocked_copper_of_other_nets_is_ripped() {
        let b = board(vec![
            track("near", "B", (1.0, 0.1), (2.0, 0.1), "F.Cu", false),
            track("far", "C", (1.0, 5.0), (2.0, 5.0), "F.Cu", false),
            track("back", "D", (1.0, 0.1), (2.0, 0.1), "B.Cu", false),
            track("locked", "E", (1.0, 0.1), (2.0, 0.1), "F.Cu", true),
            track("own", "A", (1.0, 0.1), (2.0, 0.1), "F.Cu", false),
            track("plane", "GND", (1.0, 0.1), (2.0, 0.1), "F.Cu", false),
            via("via", "F", (5.0, 0.2), false),
        ]);
        let (ids, nets) = to_rip(&b, &options(), &path());
        assert_eq!(ids, vec!["near".to_string(), "via".to_string()]);
        assert_eq!(nets.into_iter().collect::<Vec<_>>(), vec!["B".to_string(), "F".to_string()]);
    }

    #[test]
    fn protect_replaces_the_lock() {
        let b = board(vec![track("locked", "E", (1.0, 0.1), (2.0, 0.1), "F.Cu", true), track("kept", "P1", (1.0, 0.1), (2.0, 0.1), "F.Cu", false)]);
        let o = Options { protect: vec!["P*".to_string()], ..options() };
        assert_eq!(to_rip(&b, &o, &path()).0, vec!["locked".to_string()]);
    }

    #[test]
    fn the_search_board_keeps_what_a_rip_may_not_take() {
        let b = board(vec![track("gone", "B", (1.0, 0.1), (2.0, 0.1), "F.Cu", false), track("locked", "E", (1.0, 0.1), (2.0, 0.1), "F.Cu", true), via("own", "A", (0.0, 0.0), false), via("plane", "GND", (0.0, 0.0), false)]);
        let kept: Vec<_> = without_rippable(&b, &options()).copper.iter().map(|c| match c {
            RoutedCopper::Track(t) => t.id.clone(),
            RoutedCopper::Via(v) => v.id.clone(),
        }).collect();
        assert_eq!(kept, vec!["locked".to_string(), "own".to_string(), "plane".to_string()]);
    }
}
