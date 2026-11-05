//! Failure-driven repair: the failure term, the candidate units, legal improving moves, escape and decap moves, the order.

mod common;

use common::{model, near, parse, square_board};
use iotplace::congest::HistoryMap;
use iotplace::escape::EscapeModel;
use iotplace::evaluator::Evaluator;
use iotplace::numeric::hypot;
use iotplace::params::Params;
use iotplace::problem::{Place, Problem};
use iotplace::repair::corridor::{self, corridor_blockers, failed_pins};
use iotplace::repair::decap::{escapes, slides, tied_decaps};
use iotplace::repair::failure::{Failure, Term, candidates, failure_term, movable};
use iotplace::repair::rank::{Move, Proposal, Tag, alternate, hot_order};
use iotplace::repair::search::{Scope, anywhere, proposals};
use iotplace::repair::{Request, cli, repair_proposals};
use serde_json::{Value, json};
use std::path::PathBuf;

const RADIUS: f64 = 5.0;

/// A 2-pad part 2 x 1 mm with pads on the x axis at -0.5 and 0.5.
fn part(name: &str, x: f64, y: f64, fixed: bool) -> Value {
    json!({"name": name, "refs": [name], "fixed": fixed, "x": x, "y": y, "rects": [[-1, -0.5, 1, 0.5, 0.5]],
           "cu": [[-0.7, -0.2, -0.3, 0.2, 1], [0.3, -0.2, 0.7, 0.2, 1]],
           "cu_pads": [[name, "smd", "1"], [name, "smd", "2"]]})
}

fn board_json() -> Value {
    let units = [part("U1", 10.0, 10.0, true), part("C1", 16.0, 10.0, false), part("C2", 10.0, 12.5, false),
                 part("J1", 12.0, 7.5, false), part("C9", 25.0, 25.0, false)];
    json!({"units": units, "nets": [], "board": square_board(30.0, 0.5)})
}

/// U1 fixed at (10, 10); C1 6 mm east (its pad 1 is the open end); C2 next to U1; J1 a connector; C9 far.
fn board_problem() -> Problem {
    parse(board_json())
}

fn pad(reference: &str, number: &str, x: f64, y: f64) -> Value {
    json!({"point": [x, y], "ref": reference, "pad": number})
}

fn fails(rows: Value) -> Vec<Failure> {
    serde_json::from_value(rows).expect("test failures parse")
}

fn open() -> Value {
    json!({"kind": "unconnected", "items": [pad("U1", "2", 10.5, 10.0), pad("C1", "1", 15.5, 10.0)]})
}

/// A zone has no location; the pad does.
fn thermal() -> Value {
    json!({"kind": "drc", "items": [{"point": null, "ref": null, "pad": null}, pad("U1", "1", 9.5, 10.0)]})
}

fn both() -> Vec<Failure> {
    fails(json!([thermal(), open()]))
}

#[test]
fn an_open_distance_moves_with_the_pad() {
    let pr = board_problem();
    let f = fails(json!([open()]));
    let mut pose = pr.initial_pose();
    near(failure_term(&pr, &pose, &f, 0.0), 5.0);   // cap 0: no room part
    pose[1] = (14.0, 10.0, 0);
    near(failure_term(&pr, &pose, &f, 0.0), 3.0);
    pose[1] = (14.0, 10.0, 2);                      // turned 180: pad 1 is now on the east side
    near(failure_term(&pr, &pose, &f, 0.0), 4.0);
}

#[test]
fn a_cached_trial_equals_the_full_term() {
    let pr = board_problem();
    let f = both();
    let pose = pr.initial_pose();
    let mut term = Term::new(&pr, &pose, &f, RADIUS);
    let trials: [(usize, Place); 4] = [(1, (14.0, 10.0, 1)), (2, (10.0, 14.0, 0)), (2, (8.0, 13.0, 3)), (1, (17.0, 11.0, 2))];
    for (i, q) in trials {
        let mut trial = pose.clone();
        trial[i] = q;
        near(term.value(Some((i, q))), failure_term(&pr, &trial, &f, RADIUS));
    }
}

#[test]
fn room_grows_when_a_neighbour_moves_away() {
    let pr = board_problem();
    let f = fails(json!([thermal()]));
    let mut pose = pr.initial_pose();
    let start = failure_term(&pr, &pose, &f, RADIUS);   // nearest other unit to U1.1: C2 (y 12..13)
    pose[2] = (10.0, 13.5, 0);
    assert!(failure_term(&pr, &pose, &f, RADIUS) < start);
}

#[test]
fn fixed_units_and_connectors_do_not_move() {
    let pr = board_problem();
    assert_eq!((0..5).map(|i| movable(&pr, i)).collect::<Vec<_>>(), [false, true, true, false, true]);
}

#[test]
fn candidates_are_near_and_movable_owners_first() {
    let pr = board_problem();
    let names: Vec<&str> = candidates(&pr, &pr.initial_pose(), &both(), RADIUS).into_iter().map(|i| pr.units[i].name.as_str()).collect();
    assert_eq!(names, ["C1", "C2"]);   // owner first; U1 fixed, J1 connector, C9 far
}

#[test]
fn a_block_is_one_unit() {
    let mut v = board_json();
    v["units"][2]["name"] = json!("BLK");
    v["units"][2]["refs"] = json!(["C2", "R2"]);
    v["units"][2]["rects"] = json!([[-1, -0.5, 1, 0.5, 0.5], [1.5, -0.5, 3, 0.5, 0.5]]);
    let pr = parse(v);
    let f = fails(json!([thermal()]));
    let pose = pr.initial_pose();
    let props = proposals(&Scope::new(&pr, &pose, &f, true, Tag::Main), None, &anywhere).unwrap();
    assert!(!props.is_empty());
    assert!(props.iter().all(|p| p.name == "BLK"));
}

fn main_proposals(pr: &Problem, pose: &[Place], f: &[Failure], rotate: bool) -> Vec<Proposal> {
    proposals(&Scope::new(pr, pose, f, rotate, Tag::Main), None, &anywhere).unwrap()
}

#[test]
fn proposals_are_legal_improving_and_bounded() {
    let pr = board_problem();
    let (f, pose) = (both(), pr.initial_pose());
    let props = main_proposals(&pr, &pose, &f, true);
    assert!(!props.is_empty());
    let params = Params::default();
    let shapes = model(&pr, &params);
    let mut ev = Evaluator::new(&shapes, &params, &pose);
    let start = failure_term(&pr, &pose, &f, RADIUS);
    for p in &props {
        let i = p.unit;
        assert!(!pr.units[i].fixed && pr.units[i].name != "J1");
        assert!(ev.legal_penalty_at(i, (p.x, p.y, p.r)) <= 1e-9);
        assert!(hypot(p.x - pose[i].0, p.y - pose[i].1) <= RADIUS + 1e-9);
        let mut trial = pose.clone();
        trial[i] = (p.x, p.y, p.r);
        assert!(failure_term(&pr, &trial, &f, RADIUS) < start);
    }
}

#[test]
fn proposals_are_deterministic_and_round_robin() {
    let pr = board_problem();
    let (f, pose) = (both(), pr.initial_pose());
    let props = main_proposals(&pr, &pose, &f, true);
    assert_eq!(props, main_proposals(&pr, &pose, &f, true));
    let mut first: Vec<&str> = props[..2].iter().map(|p| p.name.as_str()).collect();
    first.sort_unstable();
    assert_eq!(first, ["C1", "C2"]);   // one of each unit before the second of any
}

#[test]
fn no_rotate_keeps_the_turn() {
    let pr = board_problem();
    let (f, pose) = (both(), pr.initial_pose());
    let props = main_proposals(&pr, &pose, &f, false);
    assert!(!props.is_empty());
    assert!(props.iter().all(|p| p.r == 0));
}

fn proposal(name: &str, unit: usize, x: f64, y: f64) -> Proposal {
    Proposal { problem: Tag::Main, kind: Move::Plain, unit, name: name.into(), x, y, r: 0, term: 0.0, term0: 0.0, dcost: 0.0, disp: 0.0, dhot: None }
}

#[test]
fn alternate_merges_without_duplicates() {
    let (a, b) = ([proposal("a", 1, 0.0, 0.0), proposal("b", 2, 0.0, 0.0)], [proposal("a", 1, 0.0, 0.0), proposal("c", 3, 1.0, 0.0)]);
    assert_eq!(alternate(&a, &b).iter().map(|c| c.unit).collect::<Vec<_>>(), [1, 2, 3]);
}

// ---- rank 'hot' ----

fn heat_unit(name: &str, x: f64, y: f64, fixed: bool) -> Value {
    json!({"name": name, "refs": [name], "fixed": fixed, "x": x, "y": y, "rects": [[-1.0, -0.5, 1.0, 0.5, 0.5]]})
}

/// pins: (unit, local x, local y); one pin box per unit.
fn heat_net(name: &str, pins: &[(usize, f64, f64)]) -> Value {
    let mut units: Vec<usize> = pins.iter().map(|p| p.0).collect();
    units.sort_unstable();
    units.dedup();
    let of = |u: usize| pins.iter().filter(move |p| p.0 == u);
    let span = |u: usize, f: fn(f64, f64) -> f64, g: fn(&(usize, f64, f64)) -> f64| of(u).map(g).reduce(f).expect("a unit has pins");
    let boxes: Vec<Value> = units.iter().map(|&u| json!([u, span(u, f64::min, |p| p.1), span(u, f64::min, |p| p.2), span(u, f64::max, |p| p.1), span(u, f64::max, |p| p.2)])).collect();
    let pts: Vec<Value> = units.iter().map(|&u| of(u).map(|p| json!([p.1, p.2])).collect()).collect();
    json!({"name": name, "weight": 1.0, "track": 0.3, "pins": boxes, "pts": pts})
}

fn heat_problem() -> Problem {
    let units = [heat_unit("U1", 10.0, 10.0, true), heat_unit("R1", 14.0, 10.0, false), heat_unit("R2", 10.0, 14.0, false), heat_unit("TP1", 20.0, 20.0, false)];
    let nets = [heat_net("A", &[(0, 0.5, 0.0), (1, -0.5, 0.0)]), heat_net("B", &[(0, -0.5, 0.0), (0, 0.5, 0.3), (2, 0.5, 0.0), (3, 0.0, 0.0)]),
                heat_net("P", &[(1, 0.5, 0.0), (2, -0.5, 0.0)]),   // a plane net
                json!({"name": "~comp:x", "weight": 1.0, "track": 0.0, "cohesion": true, "pins": [[1, -1, -0.5, 1, 0.5], [2, -1, -0.5, 1, 0.5]]})];
    parse(json!({"units": units, "nets": nets, "plane_nets": ["P"], "board": square_board(40.0, 0.5)}))
}

/// History 2.0 in the 1 mm cells x 9..11, y 9..11 (round U1 at (10, 10)); 0 elsewhere.
fn hot_map() -> HistoryMap {
    let size = 40;
    let mut history = vec![0.0; size * size];
    for j in 9..12 {
        history[j * size + 9..j * size + 12].fill(2.0);
    }
    HistoryMap { origin: (0.0, 0.0), cell: 1.0, nx: size, ny: size, history }
}

#[test]
fn hot_order_puts_the_moves_that_free_history_first() {
    let pr = heat_problem();
    // term order: R1 moves into the hot cells first, then R2 stays cold, then U1's pins leave the hot cells
    let props = vec![proposal("R1", 1, 10.5, 10.0), proposal("R2", 2, 20.0, 14.0), proposal("U1", 0, 20.0, 20.0)];
    let out = hot_order(props, &pr, None, &hot_map());
    assert_eq!(out.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["U1", "R2", "R1"]);
    assert_eq!(out.iter().map(|c| c.dhot.unwrap()).collect::<Vec<_>>(), [-6.0, 0.0, 2.0]);
}

/// A folder of this test, removed at the end of its scope.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("iotplace-repair-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn file(&self, name: &str, v: &Value) -> String {
        let path = self.0.join(name);
        std::fs::write(&path, v.to_string()).unwrap();
        path.to_string_lossy().into_owned()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn rank_hot_with_no_map_keeps_the_term_order() {
    let dir = TempDir::new("no-map");
    let (problem, failures) = (dir.file("prob.json", &board_json()), dir.file("fails.json", &json!([open()])));
    let (hot, term) = (dir.0.join("hot.json"), dir.0.join("term.json"));
    let args = |out: &PathBuf, more: &[&str]| -> Vec<String> {
        [problem.as_str(), "--failures", failures.as_str(), "-o", out.to_str().unwrap()].iter().chain(more).map(|s| s.to_string()).collect()
    };
    cli::run(&args(&term, &[])).unwrap();
    cli::run(&args(&hot, &["--rank", "hot", "--congestion", "/nonexistent/congestion.json"])).unwrap();
    let read = |p: &PathBuf| std::fs::read_to_string(p).unwrap();
    assert_eq!(read(&hot), read(&term));
    let answer: Value = serde_json::from_str(&read(&term)).unwrap();
    assert_eq!(answer["candidates"], json!(["C1", "C2"]));
    assert!(answer["proposals"].as_array().is_some_and(|p| !p.is_empty()));
}

// ---- escape ----

/// U1: 3 pads on the south side (0.3 x 0.8 mm, pitch 0.5), 1 pad on each other side (no net) and an exposed pad (net 1).
fn ic_unit(x: f64, y: f64) -> Value {
    let mut cu: Vec<Value> = [11, 12, 13].iter().enumerate().map(|(k, n)| {
        let cx = (k as f64 - 1.0) * 0.5;
        json!([cx - 0.15, 0.2, cx + 0.15, 1.0, n])
    }).collect();
    cu.extend([json!([-1.0, -0.15, -0.2, 0.15, 0]), json!([0.2, -0.15, 1.0, 0.15, 0]), json!([-0.15, -1.0, 0.15, -0.2, 0]), json!([-0.4, -0.4, 0.4, 0.1, 1])]);
    let meta: Vec<Value> = ["1", "2", "3", "4", "5", "6", "EP"].iter().map(|n| json!(["U1", "smd", n])).collect();
    json!({"name": "U1", "refs": ["U1"], "fixed": true, "x": x, "y": y, "rects": [[-1.2, -1.2, 1.2, 1.2, 1.0]], "cu": cu, "cu_pads": meta})
}

/// A 2-pad part (0402-like): pads 0.5 x 0.5 mm, 1.0 mm apart along x.
fn small_part(reference: &str, x: f64, y: f64, nets: (i64, i64)) -> Value {
    json!({"name": reference, "refs": [reference], "fixed": false, "x": x, "y": y, "rects": [[-0.9, -0.45, 0.9, 0.45, 0.5]],
           "cu": [[-0.75, -0.25, -0.25, 0.25, nets.0], [0.25, -0.25, 0.75, 0.25, nets.1]],
           "cu_pads": [[reference, "smd", "1"], [reference, "smd", "2"]]})
}

/// A part with one 4 mm wide pad and a small pad of net 6: it walls in every ray of the U1 south side.
fn wall(reference: &str, x: f64, y: f64) -> Value {
    json!({"name": reference, "refs": [reference], "fixed": false, "x": x, "y": y, "rects": [[-2.2, -0.5, 2.2, 1.3, 0.5]],
           "cu": [[-2.0, -0.3, 2.0, 0.3, 5], [-0.25, 0.7, 0.25, 1.1, 6]], "cu_pads": [[reference, "smd", "1"], [reference, "smd", "2"]]})
}

fn escape_json(mut units: Vec<Value>) -> Value {
    units.insert(0, ic_unit(10.0, 10.0));
    units.extend([small_part("R9", 20.0, 20.0, (11, 12)), small_part("R8", 22.0, 20.0, (13, 99))]);   // the far ends: nets 11-13 leave U1
    json!({"units": units, "nets": [], "board": square_board(30.0, 0.0), "escape_rules": {"track": 0.15, "clearance": 0.15, "via_d": 0.6}})
}

fn escape_problem(units: Vec<Value>) -> Problem {
    parse(escape_json(units))
}

fn failed_u1_pin() -> Vec<Failure> {
    fails(json!([{"kind": "unconnected", "items": [pad("U1", "2", 10.0, 10.6), pad("R9", "2", 20.5, 20.0)]}]))
}

#[test]
fn escape_proposals_move_the_unit_that_walls_in_the_failed_pin() {
    let pr = escape_problem(vec![wall("C1", 10.0, 11.8)]);
    let (f, pose) = (failed_u1_pin(), pr.initial_pose());
    let params = Params { w_esc: 20.0, ..Params::default() };
    let shapes = model(&pr, &params);
    let esc = EscapeModel::new(&pr, &params);
    assert_eq!(failed_pins(&pr, &f, &esc), [(0, 1)]);
    assert!(corridor_blockers(&pr, &pose, &shapes, &esc, &[(0, 1)]).contains(&1));
    let props = corridor::proposals(&Scope::new(&pr, &pose, &f, false, Tag::Main), &anywhere).unwrap();
    assert!(!props.is_empty());
    assert!(props.iter().all(|c| c.kind == Move::Escape && c.term < c.term0));
    assert_eq!(props[0].term, 0.0);
}

#[test]
fn no_failed_pin_no_escape_proposal() {
    let pr = escape_problem(vec![]);
    let f = fails(json!([{"kind": "unconnected", "items": [{"point": null, "ref": "R9", "pad": "1"}]}]));
    let pose = pr.initial_pose();
    assert!(corridor::proposals(&Scope::new(&pr, &pose, &f, true, Tag::Main), &anywhere).unwrap().is_empty());
}

#[test]
fn a_partner_beside_the_toe_frees_the_pin_though_no_corridor_box_reaches_it() {
    // The partner pad of net 12 lies 1.8 mm east of the pin 2 toe, within L = 1.95 mm, on the outer side; a wall fills the corridors.
    let mut partner = small_part("C5", 12.2, 11.0, (12, 0));
    partner["cu"] = json!([[-0.25, -0.25, 0.25, 0.25, 12], [0.8, -0.25, 1.3, 0.25, 0]]);
    let pr = escape_problem(vec![wall("C1", 10.0, 11.8), partner]);
    let params = Params { w_esc: 20.0, ..Params::default() };
    let shapes = model(&pr, &params);
    let esc = shapes.escape.as_ref().unwrap();
    let pins = esc.pins[0].as_ref().unwrap();
    let copper = iotplace::escape::all_copper(&shapes, esc, &pr.initial_pose());
    assert_eq!(pins.blocked(0, 1, pr.units[0].place(), &copper), 0.0);
}

// ---- decap slides ----

/// U1 at (10, 10) with net 12 on pin 2; in the main problem C3 is tied to it, in the loose problem C3 is a unit of its own.
fn decap_problems(tied_x: f64) -> (Problem, Problem) {
    let mut main = escape_json(vec![]);
    main["decaps"] = json!([["C3", "U1", 0.5]]);
    let mut loose = escape_json(vec![small_part("C3", tied_x, 11.8, (12, 2)), wall("C1", 10.0, 14.0)]);
    loose["decaps"] = json!([]);
    (parse(main), parse(loose))
}

fn c3_open() -> Vec<Failure> {
    fails(json!([{"kind": "unconnected", "items": [pad("C3", "2", 10.0, 11.8), pad("R9", "1", 19.5, 20.0)]}]))
}

#[test]
fn a_cap_is_tied_when_it_is_a_unit_of_its_own_in_the_loose_problem() {
    let (main, loose) = decap_problems(10.0);
    assert_eq!(tied_decaps(&main, &loose).into_iter().collect::<Vec<_>>(), [(1, 0)]);
    assert!(tied_decaps(&main, &main).is_empty());   // no unit C3 in the main problem
}

#[test]
fn a_slide_keeps_the_tie() {
    let (main, loose) = decap_problems(10.0);
    let f = c3_open();
    let tie = 1.0;
    let props = slides(&main, &loose, &f, tie, false).unwrap();
    assert!(!props.is_empty());
    assert!(props.iter().all(|c| c.problem == Tag::Loose && c.name == "C3"));
    let wide = slides(&main, &loose, &f, 3.0, false).unwrap();
    assert!(wide.len() > props.len());   // a wider tie allows more places
    assert!(slides(&main, &loose, &f, 0.0, false).unwrap().is_empty());
}

#[test]
fn a_round_merges_the_loose_moves() {
    let (main, loose) = decap_problems(10.0);
    let f = c3_open();
    let answer = repair_proposals(&Request { problem: &main, loose: Some(&loose), fails: &f, tie: 1.0, rotate: false, escape: true, heat: None }).unwrap();
    assert!(answer.proposals.iter().any(|c| c.problem == Tag::Loose));
    assert!(escapes(&main, &loose, &f, 1.0, false).unwrap().is_empty());   // C3 is no escape pin
}
