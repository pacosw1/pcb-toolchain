//! Unit checks of the v9 length recovery (cargo test --release).
use super::*;
use super::tests_v6::{opts, pad};

fn n(name: &str) -> Net {
    Net { name: name.into(), width: 0.15, clr: 0.15, fast: false, plane: false, power: false, layers: 0b001, via_d: 0.6, via_drill: 0.3, max_vias: None,
          max_len: None, pref: false, min_w: 0.0, min_wl: Vec::new(), in_vias: 0 }
}

/// 20 x 10 mm, F.Cu / In1.Cu / B.Cu; signal nets A, B on F.Cu only (no vias, no returns), GND index 2.
fn board() -> Board {
    let nets = vec![n("A"), n("B"), Net { plane: true, layers: 0b101, via_d: 0.45, via_drill: 0.2, ..n("GND") }];
    Board { layer_names: vec!["F.Cu".into(), "In1.Cu".into(), "B.Cu".into()], routable: vec![0, 2], nets, shapes: Vec::new(),
            idx: Index::new(-1.0, -1.0, 21.0, 11.0, 3), sidx: Index::new(-1.0, -1.0, 21.0, 11.0, 3), maxc: 0.15,
            edge: (0.0, 0.0, 20.0, 10.0), edge_clr: 0.3, gnd: 2, plane_clr: 0.25, eps: EPS, hole_clr: 0.28,
            spoke_notes: Vec::new(), attach: Vec::new(), spoke_sites: std::collections::HashSet::new(), adj: 0b101, pad_need: Vec::new(), gnd_fixed: Vec::new(), pours: Vec::new(),
            circ: std::collections::HashMap::new(), vip: Vec::new(), web: 0.0, web_hard: false, via_len: DEF_VIA_LEN, keep: Vec::new(), esc: Vec::new(), edges: Vec::new(), fvia: Vec::new() }
}

fn ctx_of<'a>(bd: &'a mut Board, o: &'a Opts) -> Ctx<'a> {
    let nn = bd.nets.len();
    let memo_w = bd.nets.iter().flat_map(|n| net_widths(n)).collect();
    let (nx, ny, nr) = (401, 201, 2);
    let tot = nx * ny * nr;
    let g = Grid { x0: 0.0, y0: 0.0, p: 0.05, nx, ny, nr, cache: vec![0; tot], vcache: vec![0; nx * ny], dcache: vec![0; tot], hist: vec![0.0; tot],
                   vhist: vec![0.0; nx * ny], pres: 0.5, g: vec![0.0; tot], from: vec![0; tot], seen: vec![0; tot], closed: vec![0; tot], tgt: vec![0; tot], sgen: 0, tgen: 0, glen: Vec::new() };
    Ctx { bd, gr: g, o, strict: false, dead: vec![(Vec::new(), String::new()); nn], memo: Vec::new(), memo_w, rcache: vec![0; nx * ny],
          ban: Vec::new(), neck: Vec::new(), len_cap: None, len_boxes: Vec::new(), len_mode: false, ret_soft: true, lfloor: Vec::new(), leaf_necks: false,
          stubs: std::collections::HashMap::new(), stub_cost: Default::default(), recover: false }
}

fn routed_len(ctx: &Ctx, net: usize) -> f64 {
    ctx.bd.shapes.iter().filter(|s| s.alive && s.owner == net as i32 && s.kind == Kind::Track)
        .map(|s| match s.geo { Geo::Seg(ax, ay, bx, by, _) => (bx - ax).hypot(by - ay), _ => 0.0 }).sum()
}

/// v9 cause: a net routed around the copper of another net keeps that detour after the other net has moved away (a
/// net with no conflict is not routed again; v8 hand NET-CORE: /ETH_TXD0 40.7 mm, v4 19.5 mm on the same placement).
/// A's pads at (2, 5) and (18, 5); routed B copper across the middle when A is routed (strict: A goes around it); then
/// B moves to the top edge. The length recovery (strict, history off) routes A straight and keeps it.
#[test]
fn length_recovery_removes_a_detour_left_by_a_moved_net() {
    let o = opts();
    let mut bd = board();
    bd.add(pad(0, 2.0, 5.0, 1));
    bd.add(pad(0, 18.0, 5.0, 1));
    bd.add(pad(1, 10.0, 0.6, 1));
    bd.add(pad(1, 10.0, 9.4, 1));
    let tr = |a: (f64, f64), b: (f64, f64)| Shape { net: 1, geo: Geo::Seg(a.0, a.1, b.0, b.1, 0.075), clr: 0.15, layers: 1, drill: 0.0, kind: Kind::Track, owner: 1, alive: true };
    // B: from its bottom pad up to y 8.6, then right and back: the wall leaves A only the way over y ~ 9
    for (a, b) in [((10.0, 9.4), (10.0, 1.2)), ((10.0, 1.2), (10.0, 0.6))] {
        bd.add(tr(a, b));
    }
    let mut ctx = ctx_of(&mut bd, &o);
    ctx.strict = true;
    let r = route_net(&mut ctx, 0);
    ctx.strict = false;
    assert!(r.hard_fail.is_some(), "B's wall from pad to pad closes the board for A on F.Cu");
    // B goes around the right side instead (the negotiation moved it), A was routed while B stood in the middle at
    // x = 10 for y in [3, 9.4] only: rebuild that state directly
    for s in ctx.bd.shapes.iter_mut() {
        if s.owner == 1 {
            s.alive = false;
        }
    }
    ctx.bd.add(tr((10.0, 9.4), (10.0, 3.0)));
    ctx.gr.reset_cache();
    ctx.strict = true;
    assert!(route_net(&mut ctx, 0).hard_fail.is_none());
    ctx.strict = false;
    let l0 = routed_len(&ctx, 0);
    assert!(l0 > 17.0, "A goes below B's copper: {l0:.2} mm");
    // B moves: its copper now runs along the right of the board from pad to pad
    for s in ctx.bd.shapes.iter_mut() {
        if s.owner == 1 {
            s.alive = false;
        }
    }
    for (a, b) in [((10.0, 9.4), (19.5, 9.4)), ((19.5, 9.4), (19.5, 0.6)), ((19.5, 0.6), (10.0, 0.6))] {
        ctx.bd.add(tr(a, b));
    }
    ctx.gr.reset_cache();
    assert_eq!(ctx.audit(0.0).pairs, 0);
    let state = vec![(None, 0u32); 3];
    let (kept, saved) = recover_length(&mut ctx, &[0], &state);
    let l1 = routed_len(&ctx, 0);
    assert_eq!(kept, 1);
    assert!(saved > 0.0);
    assert!(l1 < 16.0 + 0.05, "straight after the recovery: {l1:.2} mm (before {l0:.2})");
    assert_eq!(ctx.audit(0.0).pairs, 0);
}

/// v9: a recovery re-route that is not better by more than one grid pitch is not kept: the old copper comes back
/// unchanged (A is already straight).
#[test]
fn length_recovery_keeps_the_old_route_when_it_is_not_better() {
    let o = opts();
    let mut bd = board();
    bd.add(pad(0, 2.0, 5.0, 1));
    bd.add(pad(0, 18.0, 5.0, 1));
    let mut ctx = ctx_of(&mut bd, &o);
    assert!(route_net(&mut ctx, 0).hard_fail.is_none());
    let before: Vec<(i32, Geo)> = ctx.bd.shapes.iter().filter(|s| s.alive).map(|s| (s.owner, s.geo)).collect();
    let state = vec![(None, 0u32); 3];
    let (kept, saved) = recover_length(&mut ctx, &[0, 1], &state);
    let after: Vec<(i32, Geo)> = ctx.bd.shapes.iter().filter(|s| s.alive).map(|s| (s.owner, s.geo)).collect();
    assert_eq!((kept, saved), (0, 0.0));
    assert_eq!(format!("{before:?}"), format!("{after:?}"));
}
