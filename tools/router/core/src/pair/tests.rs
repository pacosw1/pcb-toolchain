//! The pair tools on small boards built in memory.
use super::lattice::Lattice;
use super::line::{length, offset, turns, without_collinear, without_short};
use super::route::{Job, Options, route};
use super::search::{astar, flood};
use super::stubs::{Spec, draw};
use super::tips::free_tips;
use crate::grid::ripup::segments_distance;
use crate::grid::tests::{at, footprint, pad, square};
use crate::kicad::board::{Board, RoutedCopper, Track, Via};
use crate::kicad::geom::{Rect, from_mm};
use crate::kicad::rules::DesignRules;
use crate::kicad::session::Session;
use std::fs;

fn board(copper: Vec<RoutedCopper>) -> Board {
    let nets = ["AP", "AN", "X"].map(|net| (net.to_string(), "Default".to_string())).into_iter().collect();
    Board {
        path: "t.kicad_pcb".to_string(),
        copper_layers: vec!["F.Cu".to_string(), "B.Cu".to_string()],
        stackup: Vec::new(),
        nets,
        footprints: Vec::new(),
        copper,
        zones: Vec::new(),
        graphics: Vec::new(),
        texts: Vec::new(),
        groups: Vec::new(),
        constraints: Default::default(),
        edges_bbox: Rect { left: 0, top: 0, right: from_mm(40.0), bottom: from_mm(30.0) },
        outlines: vec![square(0.0, 0.0, 40.0, 30.0)],
    }
}

fn track(id: &str, net: &str, a: (f64, f64), b: (f64, f64)) -> RoutedCopper {
    RoutedCopper::Track(Track { id: id.to_string(), start: at(a.0, a.1), end: at(b.0, b.1), mid: None, width: from_mm(0.2), layer: "F.Cu".to_string(), net: net.to_string(), locked: true })
}

fn session(b: Board, tag: &str) -> Session {
    let path = std::env::temp_dir().join(format!("pair-test-{tag}-{}.kicad_pcb", std::process::id()));
    fs::write(&path, "(kicad_pcb)\n").unwrap();
    let session = Session::of(&path, b, DesignRules::default(), tag).unwrap();
    fs::remove_file(&path).unwrap();
    session
}

/// Stubs of a pair at pitch 0.4, 10 mm apart, the tips facing each other along y = 15.
fn stubs() -> Vec<RoutedCopper> {
    vec![
        track("p1", "AP", (8.0, 14.8), (10.0, 14.8)),
        track("n1", "AN", (8.0, 15.2), (10.0, 15.2)),
        track("p2", "AP", (22.0, 14.8), (20.0, 14.8)),
        track("n2", "AN", (22.0, 15.2), (20.0, 15.2)),
    ]
}

#[test]
fn a_cell_rounds_half_to_even_as_python() {
    let grid = Lattice::new(0.0, 0.0, 10.0, 10.0, 1.0);
    assert_eq!(grid.cell((2.5, 3.5)), (2, 4));
    assert_eq!((grid.nx, grid.ny), (11, 11));
}

#[test]
fn outside_the_grid_is_closed() {
    let grid = Lattice::new(0.0, 0.0, 2.0, 2.0, 1.0);
    assert!(grid.is_blocked((-1, 0)) && grid.is_blocked((0, 3)) && !grid.is_blocked((2, 2)));
}

#[test]
fn a_mark_closes_only_cells_strictly_inside_the_reach() {
    let mut grid = Lattice::new(0.0, 0.0, 10.0, 10.0, 1.0);
    grid.mark([5.0, 5.0, 5.0, 5.0], 2.0, |p| (p.0 - 5.0).hypot(p.1 - 5.0));
    assert!(grid.is_blocked((6, 5)) && !grid.is_blocked((7, 5)));
}

#[test]
fn a_straight_run_is_one_line_of_cells() {
    let grid = Lattice::new(0.0, 0.0, 10.0, 10.0, 1.0);
    let path = astar(&grid, (1, 5), (8, 5), (1.0, 0.0), (-1.0, 0.0)).unwrap();
    assert_eq!(turns(&path), [(1, 5), (8, 5)]);
}

#[test]
fn a_wall_is_walked_round_and_a_closed_one_stops_the_search() {
    let mut grid = Lattice::new(0.0, 0.0, 10.0, 10.0, 1.0);
    (0..9).for_each(|j| grid.set((5, j), true));
    let path = astar(&grid, (1, 2), (8, 2), (1.0, 0.0), (-1.0, 0.0)).unwrap();
    assert!(path.iter().all(|cell| !grid.is_blocked(*cell)));
    grid.set((5, 9), true);
    grid.set((5, 10), true);
    assert_eq!(astar(&grid, (1, 2), (8, 2), (1.0, 0.0), (-1.0, 0.0)), None);
    assert_eq!(flood(&grid, (1, 2)).iter().filter(|c| **c).count(), 55);
}

#[test]
fn the_arrival_keeps_within_90_degrees_of_the_lead_in() {
    let grid = Lattice::new(0.0, 0.0, 10.0, 10.0, 1.0);
    // The goal is behind the start's way out of it: the path has to come round to it, not back in.
    let path = astar(&grid, (5, 5), (8, 5), (1.0, 0.0), (1.0, 0.0)).unwrap();
    let (a, b) = (path[path.len() - 2], path[path.len() - 1]);
    assert!(b.0 - a.0 <= 0, "arrives from the far side: {path:?}");
}

#[test]
fn collinear_points_and_short_steps_go() {
    assert_eq!(without_collinear(&[(0.0, 0.0), (1.0, 0.0), (2.0, 0.0), (2.0, 1.0)]), [(0.0, 0.0), (2.0, 0.0), (2.0, 1.0)]);
    assert_eq!(without_short(&[(0.0, 0.0), (0.1, 0.0), (5.0, 0.0), (5.1, 0.0)], 0.25), [(0.0, 0.0), (5.1, 0.0)]);
}

#[test]
fn an_offset_keeps_the_distance_round_a_corner() {
    let line = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)];
    let left = offset(&line, 1.0);
    assert_eq!(left[0], (0.0, 1.0));
    assert!((left[1].0 - 9.0).abs() < 1e-12 && (left[1].1 - 1.0).abs() < 1e-12);
    assert_eq!(left[2], (9.0, 10.0));
    assert!(length(&offset(&line, -1.0)) > length(&left), "the outer side is the longer");
}

#[test]
fn a_tip_touches_nothing_of_its_net() {
    let mut b = board(vec![track("a", "AP", (1.0, 1.0), (2.0, 1.0)), track("b", "AP", (2.0, 1.0), (3.0, 1.0)), track("c", "AP", (3.0, 1.0), (4.0, 1.0))]);
    b.copper.push(RoutedCopper::Via(Via { id: "v".to_string(), at: at(4.0, 1.0), size: from_mm(0.6), drill: from_mm(0.3), net: "AP".to_string(), locked: false, layers: Vec::new() }));
    b.footprints.push(footprint("U1", vec![pad("1", "AP", 1.0, 1.0, 0.6)]));
    assert!(free_tips(&b, "AP", "F.Cu").is_empty());
    b.footprints.clear();
    let tips = free_tips(&b, "AP", "F.Cu");
    assert_eq!((tips.len(), tips[0].at, tips[0].out, tips[0].track.as_str()), (1, (1.0, 1.0), (-1.0, 0.0), "a"));
    assert!(free_tips(&b, "AP", "B.Cu").is_empty());
}

#[test]
fn a_job_reads_as_its_spec() {
    let job = Job::read("/USB1_D:0.22:0.13:B.Cu", "F.Cu").unwrap();
    assert_eq!((job.base.as_str(), job.width, job.gap, job.layer.as_str(), job.single), ("/USB1_D", 0.22, 0.13, "B.Cu", false));
    let job = Job::read("NET=A:B:0.1", "F.Cu").unwrap();
    assert_eq!((job.base.as_str(), job.width, job.gap, job.layer.as_str(), job.single), ("A:B", 0.1, 0.0, "F.Cu", true));
    assert!(Job::read("A:0.1", "F.Cu").is_err());
    assert!(Job::read("A:x:0.1", "F.Cu").is_err());
}

/// The board with a small pad under the start of each stub, so only the far end of a stub is free. Tracks named x stand alone.
fn anchored(copper: Vec<RoutedCopper>) -> Board {
    let starts: Vec<(String, f64, f64)> = copper.iter().filter_map(|c| match c {
        RoutedCopper::Track(t) if t.id != "x" => Some((t.net.clone(), t.start.x as f64 / 1e6, t.start.y as f64 / 1e6)),
        _ => None,
    }).collect();
    let mut b = board(copper);
    let pads = starts.iter().enumerate().map(|(k, (net, x, y))| pad(&k.to_string(), net, *x, *y, 0.2)).collect();
    b.footprints.push(footprint("U1", pads));
    b
}

fn route_a(b: Board, tag: &str, o: &Options) -> (String, Session) {
    let mut s = session(b, tag);
    let line = route(&mut s, &Job::read("A:0.2:0.2", "F.Cu").unwrap(), o, &mut |_| {}).unwrap();
    (line, s)
}

#[test]
fn a_pair_runs_between_its_tips_with_no_skew() {
    let (line, s) = route_a(anchored(stubs()), "straight", &Options::default());
    assert_eq!(line, "PAIR A routed on F.Cu centreline 10.0 mm P 14.00 N 14.00 skew +0.00 mm");
    let new: Vec<_> = s.edit.tracks.iter().map(|t| (t.net.as_str(), t.start, t.end, t.locked)).collect();
    assert_eq!(new, [("AP", at(10.0, 14.8), at(20.0, 14.8), false), ("AN", at(10.0, 15.2), at(20.0, 15.2), false)]);
}

#[test]
fn another_nets_copper_is_kept_off_and_the_pair_stays_at_its_pitch() {
    let mut copper = stubs();
    copper.push(track("x", "X", (15.0, 13.0), (15.0, 17.0)));
    let mut b = anchored(copper);
    b.nets.insert("X".to_string(), "Other".to_string());
    let (line, s) = route_a(b, "detour", &Options { space: 0.3, ..Options::default() });
    assert!(line.contains(" routed "), "{line}");
    let mm = |p: crate::kicad::geom::Pt| (p.x as f64 / 1e6, p.y as f64 / 1e6);
    for t in &s.edit.tracks {
        // --space, plus half of each 0.2 mm track.
        assert!(segments_distance(mm(t.start), mm(t.end), (15.0, 13.0), (15.0, 17.0)) >= 0.5, "{t:?}");
    }
}

#[test]
fn a_full_wall_fails_with_the_reach_of_each_end() {
    let mut copper = stubs();
    copper.push(track("x", "X", (15.0, 0.0), (15.0, 30.0)));
    let mut printed = Vec::new();
    let mut s = session(anchored(copper), "wall");
    let line = route(&mut s, &Job::read("A:0.2:0.2", "F.Cu").unwrap(), &Options::default(), &mut |text| printed.push(text)).unwrap();
    assert!(line.starts_with("PAIR A FAILED no centreline path on F.Cu (free cells reached from the ends: "), "{line}");
    assert_eq!(printed.len(), 2);
    assert!(printed[0].starts_with("  end 10.00,15.00 heading +1.00,-0.00 0.5:. 1.0:. "), "{}", printed[0]);
    assert!(s.edit.tracks.is_empty());
}

#[test]
fn missing_tips_and_a_wrong_pitch_are_said() {
    let (line, _) = route_a(board(Vec::new()), "none", &Options::default());
    assert_eq!(line, "PAIR A FAILED tips P 0 N 0 on F.Cu");
    let mut copper = stubs();
    copper[1] = track("n1", "AN", (8.0, 16.0), (10.0, 16.0));
    let (line, _) = route_a(anchored(copper), "pitch", &Options::default());
    assert_eq!(line, "PAIR A FAILED tips (10.0, 14.8) / (10.0, 16.0) not at the pitch 0.40");
}

#[test]
fn crossed_polarity_is_refused() {
    let mut copper = stubs();
    copper[2] = track("p2", "AP", (22.0, 15.2), (20.0, 15.2));
    copper[3] = track("n2", "AN", (22.0, 14.8), (20.0, 14.8));
    let (line, s) = route_a(anchored(copper), "polarity", &Options::default());
    assert!(line.contains("FAILED polarity or heading mismatch at the far end"), "{line}");
    assert!(s.edit.tracks.is_empty());
}

#[test]
fn a_single_track_joins_its_two_tips() {
    let copper = vec![track("a", "X", (8.0, 15.0), (10.0, 15.0)), track("b", "X", (22.0, 15.0), (20.0, 15.0))];
    let mut s = session(anchored(copper), "single");
    let line = route(&mut s, &Job::read("NET=X:0.2", "F.Cu").unwrap(), &Options::default(), &mut |_| {}).unwrap();
    assert_eq!(line, "PAIR X routed on F.Cu single track 10.0 mm, net 14.00 mm");
    assert_eq!(s.edit.tracks.len(), 1);
}

fn pads_board() -> Board {
    let mut b = board(Vec::new());
    b.footprints.push(footprint("J1", vec![pad("1", "AP", 10.0, 10.0, 0.6), pad("2", "AN", 10.0, 11.0, 0.6)]));
    b
}

fn spec(text: &str) -> Spec {
    serde_json::from_str(text).unwrap()
}

#[test]
fn a_fan_comes_in_to_the_pitch_and_ends_a_front_past_it() {
    let mut s = session(pads_board(), "fan");
    let report = draw(&mut s, &spec(r#"{"pairs": [{"base": "A", "width": 0.2, "gap": 0.2, "ends": [{"ref": "J1", "p": "1", "n": 2, "dir": [1, 0], "run": 1.0}]}]}"#)).unwrap();
    assert_eq!(report, ["PAIR A w 0.2 gap 0.2 pitch 0.4", "  end J1 1/2 dir +1,+0 run 1.00 P left"]);
    // Pads 1 mm apart, pitch 0.4: 0.3 mm of diagonal on each side.
    let p: Vec<_> = s.edit.tracks.iter().filter(|t| t.net == "AP").map(|t| (t.start, t.end)).collect();
    assert_eq!(p, [(at(10.0, 10.0), at(11.0, 10.0)), (at(11.0, 10.0), at(11.3, 10.3)), (at(11.3, 10.3), at(12.3, 10.3))]);
    assert!(s.edit.tracks.iter().all(|t| t.locked && t.layer == "F.Cu"));
    assert!(s.edit.vias.is_empty());
}

#[test]
fn the_stubs_make_tips_the_route_takes() {
    let mut s = session(pads_board(), "chain");
    draw(&mut s, &spec(r#"{"pairs": [{"base": "A", "width": 0.2, "gap": 0.2, "ends": [{"ref": "J1", "p": "1", "n": "2", "dir": [1, 0], "run": 1.0}]}]}"#)).unwrap();
    let tips = free_tips(&s.board, "AP", "F.Cu");
    assert_eq!(tips.iter().map(|t| t.at).collect::<Vec<_>>(), [(12.3, 10.3)]);
    assert_eq!(tips[0].out, (1.0, 0.0));
}

#[test]
fn p_on_the_same_side_of_both_ends_crosses_at_the_end_that_may() {
    let mut b = pads_board();
    b.footprints.push(footprint("J2", vec![pad("1", "AP", 30.0, 11.0, 0.6), pad("2", "AN", 30.0, 10.0, 0.6)]));
    let text = r#"{"pairs": [{"base": "A", "width": 0.2, "gap": 0.2, "ends": [{"ref": "J1", "p": "1", "n": "2", "dir": [1, 0], "run": 1.0}, {"ref": "J2", "p": "1", "n": "2", "dir": [-1, 0], "run": 1.0, "cross_ok": true}]}]}"#;
    let mut s = session(b, "cross");
    let report = draw(&mut s, &spec(text)).unwrap();
    assert!(report[2].ends_with(" CROSSOVER"), "{report:?}");
    assert_eq!(s.edit.vias.len(), 2);
    assert!(s.edit.vias.iter().all(|v| v.net == "AP" && v.size == from_mm(0.45) && v.drill == from_mm(0.2) && v.locked));
    assert_eq!(s.edit.tracks.iter().filter(|t| t.layer == "B.Cu").map(|t| t.net.as_str()).collect::<Vec<_>>(), ["AP"]);
}

#[test]
fn with_no_end_to_cross_a_warning_is_given() {
    let mut b = pads_board();
    b.footprints.push(footprint("J2", vec![pad("1", "AP", 30.0, 11.0, 0.6), pad("2", "AN", 30.0, 10.0, 0.6)]));
    let mut s = session(b, "warn");
    let report = draw(&mut s, &spec(r#"{"pairs": [{"base": "A", "width": 0.2, "gap": 0.2, "ends": [{"ref": "J1", "p": "1", "n": "2", "dir": [1, 0]}, {"ref": "J2", "p": "1", "n": "2", "dir": [-1, 0]}]}]}"#)).unwrap();
    assert_eq!(report[1], "  WARN P on the same side of both headings and no cross_ok end: pair_route will fail polarity");
}

#[test]
fn a_drop_ends_on_its_layer_with_staggered_vias() {
    let mut s = session(pads_board(), "drop");
    draw(&mut s, &spec(r#"{"pairs": [{"base": "A", "width": 0.2, "gap": 0.2, "layer": "B.Cu", "ends": [{"ref": "J1", "p": "1", "n": "2", "dir": [1, 0], "run": 1.0, "fan_layer": "F.Cu", "drop": "B.Cu"}]}]}"#)).unwrap();
    let vias: Vec<_> = s.edit.vias.iter().map(|v| (v.net.as_str(), v.at)).collect();
    assert_eq!(vias, [("AP", at(11.55, 10.05)), ("AN", at(12.15, 10.95))]);
    assert_eq!(free_tips(&s.board, "AP", "B.Cu").len(), 1);
    assert_eq!(free_tips(&s.board, "AN", "B.Cu").len(), 1);
}

#[test]
fn a_link_joins_the_other_part_first() {
    let mut b = pads_board();
    b.footprints.push(footprint("J2", vec![pad("1", "AP", 6.0, 10.0, 0.6), pad("2", "AN", 6.0, 11.0, 0.6)]));
    let mut s = session(b, "link");
    draw(&mut s, &spec(r#"{"pairs": [{"base": "A", "width": 0.2, "gap": 0.2, "ends": [{"ref": "J1", "p": "1", "n": "2", "dir": [1, 0], "run": 1.0, "link": {"ref": "J2", "p": "1", "n": "2", "run": 1.0}}]}]}"#)).unwrap();
    let first = &s.edit.tracks[0];
    assert_eq!((first.start, first.end), (at(6.0, 10.0), at(7.0, 10.0)));
    assert_eq!((s.edit.tracks[1].start, s.edit.tracks[1].end), (at(7.0, 10.0), at(10.0, 10.0)));
}

#[test]
fn a_link_path_changes_layer_with_a_via() {
    let mut b = pads_board();
    b.footprints.push(footprint("J2", vec![pad("1", "AP", 6.0, 10.0, 0.6), pad("2", "AN", 6.0, 11.0, 0.6)]));
    let mut s = session(b, "path");
    draw(&mut s, &spec(r#"{"pairs": [{"base": "A", "width": 0.2, "gap": 0.2, "ends": [{"ref": "J1", "p": "1", "n": "2", "dir": [1, 0], "run": 1.0, "link": {"ref": "J2", "p": "1", "n": "2", "paths": {"P": [[7, 10], [8, 10, "B.Cu"]], "N": [[7, 11]]}}}]}]}"#)).unwrap();
    assert_eq!(s.edit.vias.iter().map(|v| (v.net.as_str(), v.at)).collect::<Vec<_>>(), [("AP", at(7.0, 10.0))]);
}

#[test]
fn a_part_or_pad_the_board_lacks_is_named() {
    let mut s = session(pads_board(), "missing");
    let none = spec(r#"{"pairs": [{"base": "A", "width": 0.2, "gap": 0.2, "ends": [{"ref": "J9", "p": "1", "n": "2", "dir": [1, 0]}]}]}"#);
    assert_eq!(draw(&mut s, &none).unwrap_err(), "J9: not on the board");
    let pad = spec(r#"{"pairs": [{"base": "A", "width": 0.2, "gap": 0.2, "ends": [{"ref": "J1", "p": "1", "n": "7", "dir": [1, 0]}]}]}"#);
    assert_eq!(draw(&mut s, &pad).unwrap_err(), "J1 pad 7: not found");
}
