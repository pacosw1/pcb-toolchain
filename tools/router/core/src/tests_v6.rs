//! Unit checks of the v6 rules (cargo test --release): octilinear geometry, shared return vias, via economy, power
//! width end to end.
use super::*;

fn n(name: &str, plane: bool, layers: u8) -> Net {
    Net { name: name.into(), width: 0.15, clr: 0.15, fast: false, plane, power: false, layers, via_d: 0.6, via_drill: 0.3, max_vias: None,
          max_len: None, pref: false, min_w: 0.0, in_vias: 0 }
}

pub(crate) fn opts() -> Opts {
    Opts { pitch: 0.05, passes: 1, plane_clr: 0.25, hth: 0.45, return_r: 2.0, ret_d: 0.45, ret_drill: 0.2, pres_mult: 1.5, pres_max: 1000.0,
           hist: 0.3, max_time: 0.0, door_hist: 2.0, via_cost: DEF_VIA_COST, ret_cost: DEF_RET_COST, web_cost: DEF_WEB_COST }
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
            circ: std::collections::HashMap::new(), vip: Vec::new(), web: 0.0, web_hard: false }
}

fn ctx_of<'a>(bd: &'a mut Board, o: &'a Opts) -> Ctx<'a> {
    let nn = bd.nets.len();
    let memo_w = bd.nets.iter().flat_map(|n| net_widths(n)).collect();
    Ctx { bd, gr: grid(), o, strict: false, dead: vec![(Vec::new(), String::new()); nn], memo: Vec::new(), memo_w, rcache: vec![0; 201 * 201],
          ban: Vec::new(), neck: Vec::new() }
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

/// v6 fix 4: a power net keeps its class width end to end and necks only at a pad entry where the pad is narrower,
/// for at most hw + clearance (+ one pitch) from the pad edge. Net P (power, 0.5 mm, current width 0.2 mm) joins
/// P.1 (0.3 mm wide pad at (1.5, 5)) to P.2 (1 mm pad at (8.5, 5)). Routed copper of net B walls x = 5 except a gap
/// of 0.9 mm between track centres: 0.3 mm passes with no conflict, 0.5 mm only with a conflict. v5 took 0.3 mm (fewer
/// conflicts); v6 keeps 0.5 mm and leaves the conflict to the negotiation.
#[test]
fn power_net_keeps_its_width_and_necks_only_at_the_pad() {
    let o = opts();
    let p = Net { power: true, width: 0.5, min_w: 0.2, ..n("P", false, 0b101) };
    let mut bd = empty_board(vec![p, n("B", false, 0b101), Net { via_d: 0.45, via_drill: 0.2, ..n("GND", true, 0b101) }]);
    bd.add(Shape { net: 0, geo: Geo::Rect(1.35, 4.5, 1.65, 5.5), clr: 0.15, layers: 1, drill: 0.0, kind: Kind::Pad, owner: -1, alive: true });
    bd.add(Shape { net: 0, geo: Geo::Rect(8.0, 4.5, 9.0, 5.5), clr: 0.15, layers: 1, drill: 0.0, kind: Kind::Pad, owner: -1, alive: true });
    for (y0, y1) in [(0.3, 4.55), (5.45, 9.7)] {
        bd.add(Shape { net: 1, geo: Geo::Seg(5.0, y0, 5.0, y1, 0.075), clr: 0.15, layers: 0b101, drill: 0.0, kind: Kind::Track, owner: 1, alive: true });
    }
    let mut ctx = ctx_of(&mut bd, &o);
    ctx.bd.nets[0].layers = 0b001; // one layer: no way around by a via
    let r = route_net(&mut ctx, 0);
    assert!(r.hard_fail.is_none(), "{:?}", r.hard_fail);
    let pad1 = Geo::Rect(1.35, 4.5, 1.65, 5.5);
    let zone = 0.25 + 0.15 + 0.05;
    let segs: Vec<(f64, f64, f64, f64, f64)> = ctx.bd.shapes.iter().filter(|s| s.alive && s.owner == 0 && s.kind == Kind::Track)
        .filter_map(|s| if let Geo::Seg(ax, ay, bx, by, hw) = s.geo { Some((ax, ay, bx, by, hw)) } else { None }).collect();
    let mut neck_len = 0.0;
    for &(ax, ay, bx, by, hw) in &segs {
        if (hw - 0.25).abs() < 1e-9 {
            continue;
        }
        // a narrow piece lies in the neck zone of P.1 (its end may be the first full-width sample, half a pitch out)
        assert!((hw - 0.15).abs() < 1e-9, "neck width = the pad's narrower side: {segs:?}");
        assert!(pad1.dist(ax, ay) <= zone + 0.026 && pad1.dist(bx, by) <= zone + 0.026, "neck outside the pad entry: {segs:?}");
        neck_len += ((bx - ax).powi(2) + (by - ay).powi(2)).sqrt();
    }
    assert!(neck_len > 0.0 && neck_len <= zone + 0.75 + 0.026, "neck length {neck_len}: {segs:?}");
    assert!(segs.iter().any(|s| (s.4 - 0.25).abs() < 1e-9 && s.0.min(s.2) < 5.0 && s.0.max(s.2) > 5.0), "full width through the wall gap: {segs:?}");
}

/// Board of the via tests: a fixed 0.5 mm track of net W cuts F.Cu at x = 5 from y = -1 to y_end. Nets A and C have
/// pads on F.Cu left and right of it; GND is index 2.
fn wall(y_end: f64) -> Board {
    let mut bd = empty_board(vec![n("A", false, 0b101), n("C", false, 0b101), Net { via_d: 0.45, via_drill: 0.2, ..n("GND", true, 0b101) },
                                  n("W", false, 0b101)]);
    bd.add(Shape { net: 3, geo: Geo::Seg(5.0, -1.0, 5.0, y_end, 0.25), clr: 0.15, layers: 1, drill: 0.0, kind: Kind::Track, owner: -1, alive: true });
    bd
}

fn vias(ctx: &Ctx, net: i32, owner: Option<i32>) -> Vec<(f64, f64)> {
    ctx.bd.shapes.iter().filter(|s| s.alive && s.kind == Kind::Via && s.net == net && owner.map_or(true, |o| s.owner == o))
        .filter_map(|s| if let Geo::Circ(x, y, _) = s.geo { Some((x, y)) } else { None }).collect()
}

/// v6 fix 3a: a return via serves the signal vias of several nets, and it stays when the net that placed it is
/// ripped up (v5 removed it with that net; the other net then had a via with no return). A and C cross the wall side
/// by side (pads 0.8 mm apart): C uses the returns of A; A is routed again; every signal via keeps a return and the
/// returns are fewer than the signal vias.
#[test]
fn return_vias_are_shared_and_survive_a_rip_up() {
    let mut o = opts();
    o.return_r = 1.0;
    o.ret_cost = 3.0; // a new return costs more: C changes layer next to the returns of A
    let mut bd = wall(11.0);
    for (net, y) in [(0, 3.0), (1, 3.8)] {
        bd.add(pad(net, 2.0, y, 1));
        bd.add(pad(net, 8.0, y, 1));
    }
    let mut ctx = ctx_of(&mut bd, &o);
    for net in [0, 1] {
        let r = route_net(&mut ctx, net);
        assert!(r.hard_fail.is_none(), "{:?}", r.hard_fail);
    }
    assert!(vias(&ctx, 2, Some(1)).is_empty() && !vias(&ctx, 2, Some(0)).is_empty(), "C uses the returns that A placed: {:?} {:?} {:?}",
            vias(&ctx, 0, None), vias(&ctx, 1, None), vias(&ctx, 2, None));
    // rip-up of A as the negotiation does it (route_net kills the copper the net owns)
    release_returns(&mut ctx, 0);
    for s in ctx.bd.shapes.iter_mut().filter(|s| s.owner == 0) {
        s.alive = false;
    }
    assert!(ctx.ret_missing().is_empty(), "C keeps its returns after A is ripped up: {:?}", ctx.ret_missing());
    let r = route_net(&mut ctx, 0);
    assert!(r.hard_fail.is_none(), "{:?}", r.hard_fail);
    assert!(ctx.ret_missing().is_empty(), "every signal via keeps a return: {:?}", ctx.ret_missing());
    let sig = vias(&ctx, 0, None).len() + vias(&ctx, 1, None).len();
    let pruned = prune_returns(&mut ctx);
    let ret = vias(&ctx, 2, None).len();
    assert!(ctx.ret_missing().is_empty(), "prune keeps a return for every via");
    assert_eq!(sig, 4);
    assert!(ret < sig, "shared: {ret} returns for {sig} signal vias (pruned {pruned})");
}

/// v6 fix 3b: the via cost is a parameter: a net takes a one-layer detour when two layer changes cost more. Wall to
/// y = 7.5 (end cap 7.75; the join box ends 5 mm past the pads, y = 8.2): the detour from (2, 3) to (8, 3) round the
/// wall end is about 12.5 mm, the route with 2 vias about 5.5 mm + 2 vias.
#[test]
fn via_cost_sets_when_a_layer_change_pays_off() {
    for (cost, want) in [(3.0, 2usize), (6.0, 0)] {
        let mut o = opts();
        o.via_cost = cost;
        let mut bd = wall(7.5);
        bd.add(pad(0, 2.0, 3.0, 1));
        bd.add(pad(0, 8.0, 3.0, 1));
        let mut ctx = ctx_of(&mut bd, &o);
        assert!(route_net(&mut ctx, 0).hard_fail.is_none());
        let segs: Vec<String> = ctx.bd.shapes.iter().filter(|s| s.alive && s.owner >= 0).map(|s| format!("{} {:?}", s.net, s.geo)).collect();
        assert_eq!(vias(&ctx, 0, Some(0)).len(), want, "via cost {cost}: {segs:?}");
    }
}

/// v6 fix 3c: two drilled items of different signal nets keep the antipad web (Board::web = 2 x plane zone clearance
/// + zone min_thickness) between their copper; a GND (plane net) via is not limited by it. --web-hard: a rule;
/// default: each foreign item inside the web prices the layer change (web_items).
#[test]
fn signal_vias_keep_the_plane_antipad_web() {
    let mut bd = wall(-0.5);
    bd.web = 2.0 * 0.2 + 0.2;
    bd.web_hard = true;
    bd.add(Shape { net: 1, geo: Geo::Circ(5.0, 5.0, 0.3), clr: 0.15, layers: 0b111, drill: 0.3, kind: Kind::Via, owner: -1, alive: true });
    // copper edge gap 0.25 mm at x = 5.85: legal for clearance and hole-to-hole, not for the web (0.6)
    assert_eq!(bd.via_cost(0, 5.85, 5.0, 0.6, 0.3, 0.45, None), -1, "signal via inside the web");
    assert_eq!(bd.via_cost(0, 6.25, 5.0, 0.6, 0.3, 0.45, None), 0, "edge gap 0.65 mm: outside the web");
    assert_eq!(bd.via_cost(2, 5.85, 5.0, 0.6, 0.3, 0.45, None), 0, "a GND via is not limited by the web");
    bd.web_hard = false;
    assert_eq!(bd.via_cost(0, 5.85, 5.0, 0.6, 0.3, 0.45, None), 0, "priced web: no rule hit");
    let o = opts();
    let ctx = ctx_of(&mut bd, &o);
    assert_eq!(ctx.web_items(0, 5.85, 5.0), 1, "one foreign signal via inside the web");
    assert_eq!(ctx.web_items(0, 6.25, 5.0), 0);
    assert_eq!(ctx.web_items(1, 5.85, 5.0), 0, "own net");
}
