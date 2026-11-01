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
                         spoke_notes: Vec::new(), attach: Vec::new(), adj: 0, pad_need: Vec::new(), gnd_fixed: vec![(8.5, 5.0)],
                         pours: Vec::new(), circ: HashMap::new(), vip: Vec::new() };
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
                               pads: vec![pour::PourPad { geo: Geo::Rect(4.7, 4.7, 5.3, 5.3), conn: 0, dirs, name: "U1.1".into(), proxy: None }],
                               net_clr: HashMap::new(), island_mode: 0 });
    bd
}

fn grid() -> Grid {
    let (nx, ny, nr) = (201, 201, 2);
    let tot = nx * ny * nr;
    Grid { x0: 0.0, y0: 0.0, p: 0.05, nx, ny, nr, cache: vec![0; tot], vcache: vec![0; nx * ny], dcache: vec![0; tot], hist: vec![0.0; tot],
           vhist: vec![0.0; nx * ny], pres: 0.5, g: vec![0.0; tot], from: vec![0; tot], seen: vec![0; tot], closed: vec![0; tot], tgt: vec![0; tot], sgen: 0, tgen: 0 }
}

#[test]
fn walled_in_pour_piece_is_found_and_resolved() {
    let o = Opts { pitch: 0.05, passes: 1, plane_clr: 0.25, hth: 0.45, return_r: 2.0, ret_d: 0.45, ret_drill: 0.2, pres_mult: 1.5, pres_max: 1000.0,
                   hist: 0.3, max_time: 0.0, door_hist: 2.0 };
    let mut bd = pocket_board();
    // without net A the pocket is open to the east: no fault
    assert!(pour::check(&bd).is_empty(), "open pocket: no fault");
    let nn = bd.nets.len();
    let memo_w = bd.nets.iter().flat_map(|n| net_widths(n)).collect();
    let mut ctx = Ctx { bd: &mut bd, gr: grid(), o: &o, strict: false, dead: vec![(Vec::new(), String::new()); nn], memo: Vec::new(), memo_w,
                        rcache: vec![0; 201 * 201], ban: Vec::new() };
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
