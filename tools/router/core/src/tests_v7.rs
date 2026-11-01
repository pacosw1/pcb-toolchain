//! Unit checks of the v7 fixes (cargo test --release): standoff history, fair rip-up order, DRU length bound.
use super::*;
use super::tests_v6::{opts, pad};

fn n(name: &str, plane: bool) -> Net {
    Net { name: name.into(), width: 0.15, clr: 0.15, fast: false, plane, power: false, layers: 0b101, via_d: 0.6, via_drill: 0.3, max_vias: None,
          max_len: None, pref: false, min_w: 0.0, in_vias: 0 }
}

fn grid() -> Grid {
    let (nx, ny, nr) = (401, 201, 2);
    let tot = nx * ny * nr;
    Grid { x0: 0.0, y0: 0.0, p: 0.05, nx, ny, nr, cache: vec![0; tot], vcache: vec![0; nx * ny], dcache: vec![0; tot], hist: vec![0.0; tot],
           vhist: vec![0.0; nx * ny], pres: 0.5, g: vec![0.0; tot], from: vec![0; tot], seen: vec![0; tot], closed: vec![0; tot], tgt: vec![0; tot], sgen: 0, tgen: 0, glen: Vec::new() }
}

/// 20 x 10 mm, F.Cu / In1.Cu (plane) / B.Cu; nets A, B, GND (index 2).
fn board() -> Board {
    let nets = vec![n("A", false), n("B", false), Net { via_d: 0.45, via_drill: 0.2, ..n("GND", true) }];
    Board { layer_names: vec!["F.Cu".into(), "In1.Cu".into(), "B.Cu".into()], routable: vec![0, 2], nets, shapes: Vec::new(),
            idx: Index::new(-1.0, -1.0, 21.0, 11.0, 3), sidx: Index::new(-1.0, -1.0, 21.0, 11.0, 3), maxc: 0.15,
            edge: (0.0, 0.0, 20.0, 10.0), edge_clr: 0.3, gnd: 2, plane_clr: 0.25, eps: EPS, hole_clr: 0.28,
            spoke_notes: Vec::new(), attach: Vec::new(), spoke_sites: std::collections::HashSet::new(), adj: 0b101, pad_need: Vec::new(), gnd_fixed: Vec::new(), pours: Vec::new(),
            circ: std::collections::HashMap::new(), vip: Vec::new(), web: 0.0, web_hard: false, via_len: DEF_VIA_LEN }
}

fn ctx_of<'a>(bd: &'a mut Board, o: &'a Opts) -> Ctx<'a> {
    let nn = bd.nets.len();
    let memo_w = bd.nets.iter().flat_map(|n| net_widths(n)).collect();
    let g = grid();
    let k = g.nx * g.ny;
    Ctx { bd, gr: g, o, strict: false, dead: vec![(Vec::new(), String::new()); nn], memo: Vec::new(), memo_w, rcache: vec![0; k],
          ban: Vec::new(), neck: Vec::new(), len_cap: None, len_boxes: Vec::new(), len_mode: false }
}

fn track(net: i32, a: (f64, f64), b: (f64, f64), owner: i32) -> Shape {
    Shape { net, geo: Geo::Seg(a.0, a.1, b.0, b.1, 0.075), clr: 0.15, layers: 1, drill: 0.0, kind: Kind::Track, owner, alive: true }
}

/// v7 fix 1: the audit puts the history on the keep-out of the conflicting copper. Routed A (y = 5.0) and B
/// (y = 5.2) run parallel, 0.05 mm of copper apart (rule 0.15): a centre of A two pitches off (y = 4.9), still in
/// conflict with B, gets history. v6 put it only on the cell under each sample (y = 5.0), so A moved one pitch and
/// met no history (the standoff cause found with IOTROUTE_DIAG).
#[test]
fn history_covers_the_keepout_of_a_conflict() {
    let o = opts();
    let mut bd = board();
    bd.add(track(0, (8.0, 5.0), (12.0, 5.0), 0));
    bd.add(track(1, (8.0, 5.2), (12.0, 5.2), 1));
    let mut ctx = ctx_of(&mut bd, &o);
    let au = ctx.audit(0.3);
    assert!(au.pairs > 0);
    let at = |ctx: &Ctx, x: f64, y: f64| { let (i, j) = ctx.gr.at(x, y); ctx.gr.hist[j * ctx.gr.nx + i] };
    assert!(at(&ctx, 10.0, 5.0) > 0.0, "the centre cell");
    assert!(at(&ctx, 10.0, 4.9) > 0.0, "two pitches off, inside the keep-out (0.075 + 0.15)");
    assert_eq!(at(&ctx, 10.0, 4.6), 0.0, "outside the keep-out");
}

/// v7 fix 1b: a return via in conflict (GND, owned by A) puts history on the keep-out of A's signal via that it
/// serves, so A's search pays for the layer change that needs the return there (spread NET-CORE: /ETH_RXD0 return via
/// on /ETH_CRS_DV, while /ETH_RXD0 had a conflict-free route).
#[test]
fn return_via_conflict_prices_the_owner_layer_change() {
    let o = opts();
    let mut bd = board();
    let all = 0b111;
    bd.add(Shape { net: 0, geo: Geo::Circ(10.0, 5.0, 0.3), clr: 0.15, layers: all, drill: 0.3, kind: Kind::Via, owner: 0, alive: true });
    bd.add(Shape { net: 2, geo: Geo::Circ(11.0, 5.0, 0.225), clr: 0.15, layers: all, drill: 0.2, kind: Kind::Via, owner: 0, alive: true });
    bd.add(track(1, (11.3, 3.0), (11.3, 7.0), 1));
    let mut ctx = ctx_of(&mut bd, &o);
    let au = ctx.audit(0.3);
    assert!(au.pairs > 0, "the return via meets B");
    let (i, j) = ctx.gr.at(10.0, 5.0);
    assert!(ctx.gr.vhist[j * ctx.gr.nx + i] > 0.0, "history on A's signal via site");
}

/// v7 fix 2: the nets in conflict are routed again fewest moves first, then in the base order.
#[test]
fn rip_order_gives_the_turn_to_the_net_that_did_not_move() {
    let order = vec![4, 1, 7, 2];
    let moves = vec![0, 9, 3, 0, 9, 0, 0, 1];
    assert_eq!(rip_order(&order, &[1, 4, 7], &moves), vec![7, 4, 1]);
    assert_eq!(rip_order(&order, &[2, 4], &moves), vec![2, 4]);
}

/// v7 fix 3: the DRU length limit is a hard bound of the search. A joins (2, 5) to (18, 5) on F.Cu only; routed copper
/// of B lies across the straight line at a high present cost, so the congestion-priced path goes round it (about
/// 16 + 2 x 4 mm). With max length 17 mm the path must stay at or under 17 mm (it crosses B; the negotiation moves B).
#[test]
fn length_limit_bounds_the_path() {
    let o = opts();
    for (cap, short) in [(None, false), (Some(17.0), true)] {
        let mut bd = board();
        bd.nets[0].layers = 0b001;
        bd.nets[0].max_len = cap;
        bd.add(pad(0, 2.0, 5.0, 1));
        bd.add(pad(0, 18.0, 5.0, 1));
        bd.add(track(1, (10.0, 1.5), (10.0, 8.5), 1));
        let mut ctx = ctx_of(&mut bd, &o);
        ctx.gr.pres = 1000.0;
        let r = route_net(&mut ctx, 0);
        assert!(r.hard_fail.is_none(), "{:?}", r.hard_fail);
        let len = net_lengths(ctx.bd)[0];
        if short {
            assert!(len <= 17.0, "length {len:.2} over the 17 mm limit");
        } else {
            assert!(len > 17.0, "without the limit the path goes round B: {len:.2}");
        }
    }
}
