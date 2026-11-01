//! Unit checks of the v6 rules (cargo test --release): octilinear geometry, shared return vias, via economy, power
//! width end to end.
use super::*;

fn n(name: &str, plane: bool, layers: u8) -> Net {
    Net { name: name.into(), width: 0.15, clr: 0.15, fast: false, plane, power: false, layers, via_d: 0.6, via_drill: 0.3, max_vias: None,
          max_len: None, pref: false, min_w: 0.0, in_vias: 0 }
}

pub(crate) fn opts() -> Opts {
    Opts { pitch: 0.05, passes: 1, plane_clr: 0.25, hth: 0.45, return_r: 2.0, ret_d: 0.45, ret_drill: 0.2, pres_mult: 1.5, pres_max: 1000.0,
           hist: 0.3, max_time: 0.0, door_hist: 2.0 }
}

fn grid() -> Grid {
    let (nx, ny, nr) = (201, 201, 2);
    let tot = nx * ny * nr;
    Grid { x0: 0.0, y0: 0.0, p: 0.05, nx, ny, nr, cache: vec![0; tot], vcache: vec![0; nx * ny], dcache: vec![0; tot], hist: vec![0.0; tot],
           vhist: vec![0.0; nx * ny], pres: 0.5, g: vec![0.0; tot], from: vec![0; tot], seen: vec![0; tot], closed: vec![0; tot], tgt: vec![0; tot], sgen: 0, tgen: 0 }
}

/// 10 x 10 mm, F.Cu / In1.Cu (plane) / B.Cu; nets A, B, GND (index 2), no fixed copper.
fn empty_board(nets: Vec<Net>) -> Board {
    Board { layer_names: vec!["F.Cu".into(), "In1.Cu".into(), "B.Cu".into()], routable: vec![0, 2], nets, shapes: Vec::new(),
            idx: Index::new(-1.0, -1.0, 11.0, 11.0, 3), sidx: Index::new(-1.0, -1.0, 11.0, 11.0, 3), maxc: 0.15,
            edge: (0.0, 0.0, 10.0, 10.0), edge_clr: 0.3, gnd: 2, plane_clr: 0.25, eps: EPS, hole_clr: 0.28,
            spoke_notes: Vec::new(), attach: Vec::new(), adj: 0b101, pad_need: Vec::new(), gnd_fixed: Vec::new(), pours: Vec::new(),
            circ: std::collections::HashMap::new(), vip: Vec::new() }
}

fn ctx_of<'a>(bd: &'a mut Board, o: &'a Opts) -> Ctx<'a> {
    let nn = bd.nets.len();
    let memo_w = bd.nets.iter().flat_map(|n| net_widths(n)).collect();
    Ctx { bd, gr: grid(), o, strict: false, dead: vec![(Vec::new(), String::new()); nn], memo: Vec::new(), memo_w, rcache: vec![0; 201 * 201],
          ban: Vec::new() }
}

pub(crate) fn pad(net: i32, x: f64, y: f64, layers: u8) -> Shape {
    Shape { net, geo: Geo::Rect(x - 0.3, y - 0.2, x + 0.3, y + 0.2), clr: 0.15, layers, drill: 0.0, kind: Kind::Pad, owner: -1, alive: true }
}

/// angle of a segment off the nearest multiple of 45 degrees
pub(crate) fn off_octilinear(ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let a = (by - ay).atan2(bx - ax).to_degrees().rem_euclid(45.0);
    a.min(45.0 - a)
}

/// v6 fix 2: every emitted segment is at 0, 45 or 90 degrees (v5 pulled the grid path into any-angle lines: M2 run 6
/// had 1546 of 2465 segments off 0/45/90). Net A joins (1, 1) to (6.0, 3.35) (not on one octilinear line) around a
/// fixed net-B track; the copper stays legal.
#[test]
fn every_segment_is_octilinear() {
    let o = opts();
    let mut bd = empty_board(vec![n("A", false, 0b101), n("B", false, 0b101), Net { via_d: 0.45, via_drill: 0.2, ..n("GND", true, 0b101) }]);
    bd.add(pad(0, 1.0, 1.0, 1));
    bd.add(pad(0, 6.0, 3.35, 1));
    bd.add(pad(0, 2.2, 8.15, 1));
    bd.add(Shape { net: 1, geo: Geo::Seg(3.5, 0.0, 3.5, 2.6, 0.1), clr: 0.15, layers: 1, drill: 0.0, kind: Kind::Track, owner: -1, alive: true });
    let mut ctx = ctx_of(&mut bd, &o);
    let r = route_net(&mut ctx, 0);
    assert!(r.hard_fail.is_none(), "{:?}", r.hard_fail);
    let segs: Vec<(f64, f64, f64, f64)> = ctx.bd.shapes.iter().filter(|s| s.alive && s.owner == 0 && s.kind == Kind::Track)
        .filter_map(|s| if let Geo::Seg(ax, ay, bx, by, _) = s.geo { Some((ax, ay, bx, by)) } else { None }).collect();
    assert!(!segs.is_empty());
    for &(ax, ay, bx, by) in &segs {
        assert!(off_octilinear(ax, ay, bx, by) < 1e-6, "segment ({ax:.3}, {ay:.3}) -> ({bx:.3}, {by:.3}) is not at 0/45/90: {segs:?}");
    }
    let au = ctx.audit(0.0);
    assert_eq!((au.pairs, au.hard), (0, 0), "the copper stays legal");
}
