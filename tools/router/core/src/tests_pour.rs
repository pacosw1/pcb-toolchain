//! Unit check of the v5 pour rule (cargo test --release): a thermal pad whose pour piece a routed track walls in is
//! found (KiCad starved_thermal), the routed net is named as the wall, and the negotiation steps (door history, then
//! the hard door) move the track until the pad is connected.
use super::*;
use std::collections::HashMap;

fn n(name: &str, plane: bool) -> Net {
    Net { name: name.into(), width: 0.15, clr: 0.15, fast: false, plane, power: false, layers: 0b101, via_d: 0.6, via_drill: 0.3, max_vias: None,
          max_len: None, pref: false, min_w: 0.0, in_vias: 0 }
}

/// 10 x 10 mm, F.Cu / In1.Cu (plane) / B.Cu, a GND pour on F.Cu (clearance 0.25, relief 0.3, spokes 0.4, min width 0.1).
/// GND pad U1.1 at (5, 5) sits in a pocket of fixed copper of net B: a C of 0.2 mm tracks (left x = 3.5, top y = 3.5,
/// bottom y = 6.5 with a 0.5 mm gap at x = 5 that no pour passes), open to the east. A fixed GND track runs from the pad
/// through the gap to (5, 7.5) (one track spoke, as C46.2 on NET-CORE). Net A joins (7, 1.5) to (7, 8.5): its straight
/// route closes the pocket, so the 4 pour spokes reach an island with only the pad. A GND via at (8.5, 5) is the main fill.
fn pocket_board() -> Board {
    let nets = vec![n("A", false), n("B", false), Net { via_d: 0.45, via_drill: 0.2, ..n("GND", true) }];
    let mut bd = Board { layer_names: vec!["F.Cu".into(), "In1.Cu".into(), "B.Cu".into()], routable: vec![0, 2], nets, shapes: Vec::new(),
                         idx: Index::new(-1.0, -1.0, 11.0, 11.0, 3), sidx: Index::new(-1.0, -1.0, 11.0, 11.0, 3), maxc: 0.25,
                         edge: (0.0, 0.0, 10.0, 10.0), edge_clr: 0.3, gnd: 2, plane_clr: 0.25, eps: EPS, hole_clr: 0.28,
                         spoke_notes: Vec::new(), attach: Vec::new(), spoke_sites: std::collections::HashSet::new(), adj: 0, pad_need: Vec::new(), gnd_fixed: vec![(8.5, 5.0)],
                         pours: Vec::new(), circ: HashMap::new(), vip: Vec::new(), web: 0.0, web_hard: false, via_len: DEF_VIA_LEN };
    let fixed = |net: i32, geo: Geo, kind: Kind, layers: u8, drill: f64| Shape { net, geo, clr: 0.15, layers, drill, kind, owner: -1, alive: true };
    bd.add(fixed(0, Geo::Rect(6.8, 1.3, 7.2, 1.7), Kind::Pad, 1, 0.0));
    bd.add(fixed(0, Geo::Rect(6.8, 8.3, 7.2, 8.7), Kind::Pad, 1, 0.0));
    bd.add(fixed(2, Geo::Rect(4.7, 4.7, 5.3, 5.3), Kind::Pad, 1, 0.0));
    for (a, b) in [((3.5, 3.5), (3.5, 6.5)), ((3.5, 3.5), (6.5, 3.5)), ((3.5, 6.5), (4.65, 6.5)), ((5.35, 6.5), (6.5, 6.5))] {
        bd.add(fixed(1, Geo::Seg(a.0, a.1, b.0, b.1, 0.1), Kind::Track, 1, 0.0));
    }
    // the track starts in a pad corner off the spoke axes: an end on a spoke (the spoke polygon covers the pad from its
    // centre) would connect the track to the island
    bd.add(fixed(2, Geo::Seg(4.76, 5.26, 5.0, 7.5, 0.075), Kind::Track, 1, 0.0));
    bd.add(fixed(2, Geo::Circ(8.5, 5.0, 0.225), Kind::Via, 0b111, 0.2));
    let dirs = vec![(1.0, 0.0), (0.0, -1.0), (-1.0, 0.0), (0.0, 1.0)];
    bd.pours.push(pour::Pour { net: 2, layer: 0, clr: 0.25, gap: 0.3, sw: 0.4, mt: 0.1, bbox: [0.0, 0.0, 10.0, 10.0], min_spokes: 2,
                               pads: vec![pour::PourPad { geo: Geo::Rect(4.7, 4.7, 5.3, 5.3), conn: 0, dirs, name: "U1.1".into(), proxy: None, hole: None }],
                               net_clr: HashMap::new(), island_mode: 0 });
    bd
}

fn grid() -> Grid {
    let (nx, ny, nr) = (201, 201, 2);
    let tot = nx * ny * nr;
    Grid { x0: 0.0, y0: 0.0, p: 0.05, nx, ny, nr, cache: vec![0; tot], vcache: vec![0; nx * ny], dcache: vec![0; tot], hist: vec![0.0; tot],
           vhist: vec![0.0; nx * ny], pres: 0.5, g: vec![0.0; tot], from: vec![0; tot], seen: vec![0; tot], closed: vec![0; tot], tgt: vec![0; tot], sgen: 0, tgen: 0, glen: Vec::new() }
}

#[test]
fn walled_in_pour_piece_is_found_and_resolved() {
    let o = Opts { pitch: 0.05, passes: 1, plane_clr: 0.25, hth: 0.45, return_r: 2.0, ret_d: 0.45, ret_drill: 0.2, pres_mult: 1.5, pres_max: 1000.0,
                   hist: 0.3, max_time: 0.0, door_hist: 2.0, via_cost: DEF_VIA_COST, ret_cost: DEF_RET_COST, web_cost: DEF_WEB_COST };
    let mut bd = pocket_board();
    // without net A the pocket is open to the east: no fault
    assert!(pour::check(&bd).is_empty(), "open pocket: no fault");
    let nn = bd.nets.len();
    let memo_w = bd.nets.iter().flat_map(|n| net_widths(n)).collect();
    let mut ctx = Ctx { bd: &mut bd, gr: grid(), o: &o, strict: false, dead: vec![(Vec::new(), String::new()); nn], memo: Vec::new(), memo_w,
                        rcache: vec![0; 201 * 201], ban: Vec::new(), neck: Vec::new(), len_cap: None, len_boxes: Vec::new(), len_mode: false, ret_soft: true };
    assert!(route_net(&mut ctx, 0).hard_fail.is_none());
    // detection: the straight route of A closes the pocket; 1 track spoke, 4 pour spokes into the island (KiCad does
    // not fold the island spokes back in when the pad has another spoke)
    let f0 = pour::check(ctx.bd);
    assert_eq!(f0.len(), 1, "{f0:?}");
    assert_eq!(f0[0].pad, "U1.1");
    assert_eq!((f0[0].good, f0[0].ignored), (1, 4));
    assert_eq!(f0[0].walls, vec![0], "the wall is net A");
    assert!(!f0[0].fixed && !f0[0].door.is_empty());
    // resolution as in the negotiation: door history and re-route of the wall; a hard door after DOOR_STALL rounds
    let (mut seen, mut resolved) = (0, false);
    for _ in 0..3 * DOOR_STALL {
        let (pf, walls, _) = ctx.pour_pass(o.door_hist);
        if pf.is_empty() {
            resolved = true;
            break;
        }
        assert_eq!(walls, vec![0]);
        seen += 1;
        if seen >= DOOR_STALL {
            for fl in &pf {
                ctx.reserve_door(fl);
            }
            seen = 0;
        }
        let r = route_net(&mut ctx, 0);
        assert!(r.hard_fail.is_none(), "{:?}", r.hard_fail);
    }
    assert!(resolved, "the pad must reach the main fill: {:?}", pour::check(ctx.bd));
    assert!(ctx.bd.shapes.iter().any(|s| s.alive && s.owner == 0 && s.kind == Kind::Track), "A stays routed");
    let au = ctx.audit(0.0);
    assert_eq!((au.pairs, au.hard), (0, 0), "the copper stays legal");
}

/// v6 (M2 J2.18): KiCad cuts the drill hole of a thermal pad out of the fill after the spokes are added
/// (zone_filler.cpp fillCopperZone: addHoleKnockout( pad, 0 ) into clearanceHoles, subtracted after the re-inflation).
/// The spokes start at the pad centre, so without the hole they join every spoke into one fill polygon; with a hole
/// wider than the spoke cross (drill / 2 >= spoke width / sqrt 2) each spoke stays in the piece it reaches.
/// Board: THT GND pad J.1 at (5, 5), r 0.85, drill 1.0, spokes 0.35 at 45 degrees. Fixed net-B walls from the relief ring
/// to the board edge (north at x = 5, east at y = 5) cut off the NE quadrant; a GND via at (8, 2) is in it. KiCad: NE
/// spoke good (pad + via), the 3 others go into an island with only the pad: starved_thermal "3 spokes connected to
/// isolated island".
#[test]
fn tht_hole_splits_the_spokes_of_a_thermal_pad() {
    let nets = vec![n("A", false), n("B", false), Net { via_d: 0.45, via_drill: 0.2, ..n("GND", true) }];
    let mut bd = Board { layer_names: vec!["F.Cu".into(), "In1.Cu".into(), "B.Cu".into()], routable: vec![0, 2], nets, shapes: Vec::new(),
                         idx: Index::new(-1.0, -1.0, 11.0, 11.0, 3), sidx: Index::new(-1.0, -1.0, 11.0, 11.0, 3), maxc: 0.25,
                         edge: (0.0, 0.0, 10.0, 10.0), edge_clr: 0.3, gnd: 2, plane_clr: 0.25, eps: EPS, hole_clr: 0.28,
                         spoke_notes: Vec::new(), attach: Vec::new(), spoke_sites: std::collections::HashSet::new(), adj: 0, pad_need: Vec::new(), gnd_fixed: vec![(8.0, 2.0)],
                         pours: Vec::new(), circ: HashMap::new(), vip: Vec::new(), web: 0.0, web_hard: false, via_len: DEF_VIA_LEN };
    let fixed = |net: i32, geo: Geo, kind: Kind, layers: u8, drill: f64| Shape { net, geo, clr: 0.15, layers, drill, kind, owner: -1, alive: true };
    bd.add(fixed(2, Geo::Rect(4.15, 4.15, 5.85, 5.85), Kind::Pad, 0b111, 1.0));
    bd.circ.insert((50000, 50000), 0.85);
    bd.add(fixed(1, Geo::Seg(5.0, 0.0, 5.0, 3.7, 0.1), Kind::Track, 1, 0.0));
    bd.add(fixed(1, Geo::Seg(6.3, 5.0, 10.0, 5.0, 0.1), Kind::Track, 1, 0.0));
    bd.add(fixed(2, Geo::Circ(8.0, 2.0, 0.225), Kind::Via, 0b111, 0.2));
    let s = std::f64::consts::FRAC_1_SQRT_2;
    let dirs = vec![(s, -s), (-s, -s), (-s, s), (s, s)];
    let pad = |hole| pour::PourPad { geo: Geo::Circ(5.0, 5.0, 0.85), conn: 0, dirs: dirs.clone(), name: "J.1".into(), proxy: None, hole };
    let pour = |hole| pour::Pour { net: 2, layer: 0, clr: 0.2, gap: 0.3, sw: 0.35, mt: 0.1, bbox: [0.0, 0.0, 10.0, 10.0], min_spokes: 2,
                                   pads: vec![pad(hole)], net_clr: HashMap::new(), island_mode: 0 };
    // SMD pad (no hole): the spoke cross joins the island to the NE piece: no fault (as KiCad)
    bd.pours.push(pour(None));
    assert!(pour::check(&bd).is_empty(), "{:?}", pour::check(&bd));
    // THT pad: the hole splits the cross
    bd.pours[0] = pour(Some((5.0, 5.0, 0.5)));
    let f = pour::check(&bd);
    assert_eq!(f.len(), 1, "{f:?}");
    assert_eq!((f[0].good, f[0].ignored), (1, 3), "{f:?}");
    assert!(f[0].fixed, "fixed copper alone makes the island");
}

/// Pour check of a cropped M2 board (fixtures/: crop of the RouteModel and the router result around J2, made with the
/// scratch crop.py) -> the faults as (pad, good, ignored, walls).
fn fixture_faults(js: &str) -> Vec<(String, usize, usize, Vec<String>)> {
    fixture_full(js).into_iter().map(|f| (f.0, f.1, f.2, f.3)).collect()
}

/// as fixture_faults, plus the door path (cells) of each fault
fn fixture_full(js: &str) -> Vec<(String, usize, usize, Vec<String>, Vec<(f64, f64)>)> {
    let v: Value = serde_json::from_str(js).unwrap();
    let (hole, _, _) = hole_rules(&v["model"]);
    let mut bd = load(&v["model"], hole.unwrap_or(DEF_HOLE_CLR));
    add_result(&mut bd, &v["result"]);
    pour::check(&bd).into_iter().map(|f| (f.pad, f.good, f.ignored, f.walls.iter().map(|&w| bd.nets[w].name.clone()).collect(), f.path)).collect()
}

/// KiCad 10 DRC on the M2 run 6 board: J2.18 B.Cu "2 spokes connected to isolated island" (1 spoke reaches the piece
/// with the GND via at (134.6, 184.2), 2 reach an island with only the pad). v5 passed it: the NE spoke ends one cell
/// short of the fill because the model eroded the spoke and the fill each alone; KiCad erodes their union
/// (fillCopperZone: spokes added, then Deflate( min_width / 2 )), which keeps the junction.
#[test]
fn m2_run6_j2_18_is_starved_as_kicad() {
    let f = fixture_faults(include_str!("fixtures/m2_j2_18.json"));
    assert_eq!(f, vec![("J2.18".to_string(), 1, 2, vec!["/SPI_SCK".to_string()])], "the door crosses routed copper");
}

/// KiCad 10 DRC on the M2 run 1 board: J2.16 B.Cu "1 spokes connected to isolated island" (1 good spoke). v5 passed it:
/// the spokes joined through the pad centre (no drill hole cut).
#[test]
fn m2_run1_j2_16_is_starved_as_kicad() {
    let f = fixture_faults(include_str!("fixtures/m2_j2_16.json"));
    assert_eq!(f, vec![("J2.16".to_string(), 1, 1, vec!["/UART_RX".to_string()])], "the door crosses routed copper");
}

/// v6: the door path is the shortest way among those that cross the fewest routed cells (v5 0-1 search: any of them;
/// the hard door reserved the whole path as pour, and on the v6 H7-CORE run it was 37068 cells long at J2.18). Each
/// step of a 4-connected path is one pitch: the path is at most the Manhattan distance + 2 x (detour) long; here the
/// bound is 4 x the Manhattan distance of its ends.
#[test]
fn door_path_is_short() {
    for js in [include_str!("fixtures/m2_j2_18.json"), include_str!("fixtures/m2_j2_16.json")] {
        for f in fixture_full(js) {
            let (a, b) = (f.4[0], *f.4.last().unwrap());
            let man = ((b.0 - a.0).abs() + (b.1 - a.1).abs()) / pour::POUR_PITCH;
            eprintln!("{}: path {} cells, manhattan {:.0}", f.0, f.4.len(), man);
            assert!((f.4.len() as f64) <= 4.0 * man + 40.0, "{}: path {} cells, ends {:?} {:?}", f.0, f.4.len(), a, b);
        }
    }
}

/// v6: a hard door reserves the path only up to its last routed-copper cell + min_thickness + zone clearance (v5: the
/// whole path to a via of the net; on the v6 H7-CORE run 1718 cells through existing fill at J2.16 / J2.18).
#[test]
fn hard_door_reserves_only_the_blocked_part() {
    let v: Value = serde_json::from_str(include_str!("fixtures/m2_j2_16.json")).unwrap();
    let (hole, _, _) = hole_rules(&v["model"]);
    let mut bd = load(&v["model"], hole.unwrap_or(DEF_HOLE_CLR));
    add_result(&mut bd, &v["result"]);
    let f = pour::check(&bd);
    assert_eq!(f.len(), 1);
    let fl = f[0].clone();
    let o = super::tests_v6::opts();
    let n0 = bd.shapes.len();
    let nn = bd.nets.len();
    let (e0, e1, e2, e3) = bd.edge;
    let (nx, ny) = (((e2 - e0) / 0.05).ceil() as usize + 1, ((e3 - e1) / 0.05).ceil() as usize + 1);
    let tot = nx * ny * 2;
    let gr = Grid { x0: e0, y0: e1, p: 0.05, nx, ny, nr: 2, cache: vec![0; tot], vcache: vec![0; nx * ny], dcache: vec![0; tot], hist: vec![0.0; tot],
                    vhist: vec![0.0; nx * ny], pres: 0.5, g: vec![0.0; tot], from: vec![0; tot], seen: vec![0; tot], closed: vec![0; tot], tgt: vec![0; tot], sgen: 0, tgen: 0, glen: Vec::new() };
    let mut ctx = Ctx { bd: &mut bd, gr, o: &o, strict: false, dead: vec![(Vec::new(), String::new()); nn], memo: Vec::new(), memo_w: vec![0.15],
                        rcache: vec![0; nx * ny], ban: Vec::new(), neck: Vec::new(), len_cap: None, len_boxes: Vec::new(), len_mode: false, ret_soft: true };
    ctx.reserve_door(&fl);
    let len: f64 = ctx.bd.shapes[n0..].iter().filter_map(|s| if let Geo::Seg(ax, ay, bx, by, _) = s.geo { Some((bx - ax).hypot(by - ay)) } else { None }).sum();
    let last = fl.path.iter().rposition(|p| fl.door.contains(p)).unwrap();
    let bound = (last + 1 + 16) as f64 * pour::POUR_PITCH;
    assert!(len <= bound + 1e-6, "strip {len:.2} mm, bound {bound:.2} mm (path {} cells)", fl.path.len());
    assert!(len < fl.path.len() as f64 * pour::POUR_PITCH * 0.5, "strip {len:.2} mm vs path {} cells", fl.path.len());
}
