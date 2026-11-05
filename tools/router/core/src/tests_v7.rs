//! Unit checks of the v7 fixes (cargo test --release): standoff history, DRU length bound, third-net repair, strict returns.
use super::*;
use super::tests_v6::{opts, pad};

fn n(name: &str, plane: bool) -> Net {
    Net { name: name.into(), width: 0.15, clr: 0.15, fast: false, plane, power: false, layers: 0b101, via_d: 0.6, via_drill: 0.3, max_vias: None,
          max_len: None, pref: false, min_w: 0.0, min_wl: Vec::new(), in_vias: 0 }
}

fn grid() -> Grid {
    let (nx, ny, nr) = (401, 201, 2);
    let tot = nx * ny * nr;
    Grid { x0: 0.0, y0: 0.0, p: 0.05, nx, ny, nr, cache: vec![0; tot], vcache: vec![0; nx * ny], dcache: vec![0; tot], hist: vec![0.0; tot],
           vhist: vec![0.0; nx * ny], pres: 0.5, g: vec![0.0; tot], from: vec![0; tot], seen: vec![0; tot], closed: vec![0; tot], tgt: vec![0; tot], sgen: 0, tgen: 0, glen: Vec::new(), lhist: Vec::new(), jit: Default::default() }
}

/// 20 x 10 mm, F.Cu / In1.Cu (plane) / B.Cu; nets A, B, GND (index 2).
fn board() -> Board {
    let nets = vec![n("A", false), n("B", false), Net { via_d: 0.45, via_drill: 0.2, ..n("GND", true) }];
    Board { layer_names: vec!["F.Cu".into(), "In1.Cu".into(), "B.Cu".into()], routable: vec![0, 2], nets, shapes: Vec::new(),
            idx: Index::new(-1.0, -1.0, 21.0, 11.0, 3), sidx: Index::new(-1.0, -1.0, 21.0, 11.0, 3), maxc: 0.15,
            edge: (0.0, 0.0, 20.0, 10.0), edge_clr: 0.3, gnd: 2, plane_clr: 0.25, eps: EPS, hole_clr: 0.28,
            spoke_notes: Vec::new(), attach: Vec::new(), spoke_sites: std::collections::HashSet::new(), adj: 0b101, pad_need: Vec::new(), gnd_fixed: Vec::new(), pours: Vec::new(),
            circ: std::collections::HashMap::new(), vip: Vec::new(), tvia: Vec::new(), web: 0.0, web_hard: false, via_len: DEF_VIA_LEN, keep: Vec::new(), esc: Vec::new(), edges: Vec::new(), fvia: Vec::new(), iso: None, niv: Vec::new(), ppoly: Vec::new(), twin: Vec::new(), gnds: Vec::new(), pidx: Vec::new(), prad: Vec::new(), noret: Vec::new(), rgn: Vec::new(), rfill: Default::default() }
}

fn ctx_of<'a>(bd: &'a mut Board, o: &'a Opts) -> Ctx<'a> {
    let nn = bd.nets.len();
    let memo_w = bd.nets.iter().flat_map(|n| net_widths(n)).collect();
    let g = grid();
    let k = g.nx * g.ny;
    Ctx { bd, gr: g, o, strict: false, dead: vec![(Vec::new(), String::new()); nn], memo: Vec::new(), memo_w, rcache: vec![0; k],
          ban: Vec::new(), neck: Vec::new(), len_cap: None, len_boxes: Vec::new(), len_mode: false, ret_soft: true, lfloor: Vec::new(), leaf_necks: false, stubs: std::collections::HashMap::new(), stub_cost: Default::default(), recover: false, fan_keep: false }
}

fn track(net: i32, a: (f64, f64), b: (f64, f64), owner: i32) -> Shape {
    Shape { net, geo: Geo::Seg(a.0, a.1, b.0, b.1, 0.075), clr: 0.15, layers: 1, drill: 0.0, kind: Kind::Track, owner, alive: true, grp: 0 }
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
    bd.add(Shape { net: 0, geo: Geo::Circ(10.0, 5.0, 0.3), clr: 0.15, layers: all, drill: 0.3, kind: Kind::Via, owner: 0, alive: true, grp: 0 });
    bd.add(Shape { net: 2, geo: Geo::Circ(11.0, 5.0, 0.225), clr: 0.15, layers: all, drill: 0.2, kind: Kind::Via, owner: 0, alive: true, grp: 0 });
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

/// v7 fix 4: third-net repair in the end step. A fixed wall (net W) at x = 10 leaves one F.Cu gap at y = 5 (one track
/// fits). Routed B (F.Cu and B.Cu) goes through the gap; A (F.Cu only) has no other way, so A has no strict route.
/// The repair removes B, routes A through the gap, and B goes under the wall on B.Cu.
#[test]
fn third_net_repair_moves_the_net_that_blocks_the_only_way() {
    let o = opts();
    let mut bd = board();
    bd.nets.push(n("W", false));
    bd.nets[0].layers = 0b001;
    for (y0, y1) in [(0.0, 4.6), (5.4, 10.0)] {
        bd.add(Shape { net: 3, geo: Geo::Seg(10.0, y0, 10.0, y1, 0.1), clr: 0.15, layers: 1, drill: 0.0, kind: Kind::Track, owner: -1, alive: true, grp: 0 });
    }
    bd.add(pad(0, 2.0, 5.0, 1));
    bd.add(pad(0, 18.0, 5.0, 1));
    bd.add(pad(1, 8.0, 3.0, 1));
    bd.add(pad(1, 12.0, 3.0, 1));
    for (a, b) in [((8.0, 3.0), (8.0, 5.0)), ((8.0, 5.0), (12.0, 5.0)), ((12.0, 5.0), (12.0, 3.0))] {
        bd.add(track(1, a, b, 1));
    }
    let mut ctx = ctx_of(&mut bd, &o);
    ctx.strict = true;
    assert!(route_net(&mut ctx, 0).hard_fail.is_some(), "A has no strict route while B holds the gap");
    ctx.strict = false;
    let order = vec![0, 1, 2, 3];
    assert_eq!(third_net_repair(&mut ctx, 0, &order), Some(1));
    assert!(ctx.bd.shapes.iter().any(|s| s.alive && s.owner == 0 && s.kind == Kind::Track), "A is routed");
    assert!(ctx.bd.shapes.iter().any(|s| s.alive && s.owner == 1 && s.net == 1 && s.kind == Kind::Via), "B changed layer");
    assert_eq!(ctx.audit(0.0).pairs, 0);
    assert!(ctx.ret_missing().is_empty());
}

/// v7 fix 5: in route_net a return via must be conflict-free (H7-CORE a2 diag: the return vias of /ETH_TXD0 and
/// /LIMIT0_P hole to hole, and a /PHY_LED2 return on the only escape of /PHY_LED1; the owners had conflict-free
/// routes). Signal via of A at (10, 5); routed copper of B covers every GND site within the 2 mm return radius.
/// v6 (and ret_soft) took a conflicting site; v7 rejects the layer change.
#[test]
fn return_via_must_be_conflict_free() {
    let o = opts();
    let mut bd = board();
    bd.add(Shape { net: 1, geo: Geo::Seg(7.0, 5.0, 13.0, 5.0, 2.5), clr: 0.15, layers: 1, drill: 0.0, kind: Kind::Track, owner: 1, alive: true, grp: 0 });
    let mut ctx = ctx_of(&mut bd, &o);
    ctx.ret_soft = false;
    assert!(!ctx.place_return(0, 10.0, 5.0, &[]), "no conflict-free return site: the layer change is rejected");
    ctx.ret_soft = true;
    assert!(ctx.place_return(0, 10.0, 5.0, &[]), "ret_soft (v6 rule): a conflicting site is taken");
}

/// A return via outside the zones of its ground joins nothing (ENV-SENSE: a site in the notch of GND_B stayed unconnected, and KiCad
/// found the open only after the route). Signal via of A at (10, 5), a zone that ends at x = 9.
#[test]
fn return_via_stays_inside_the_zone_of_its_ground() {
    let o = opts();
    let mut bd = board();
    let ground = bd.gnd as usize;
    bd.ppoly.push((ground, vec![(0.0, 0.0), (9.0, 0.0), (9.0, 10.0), (0.0, 10.0)]));
    let mut ctx = ctx_of(&mut bd, &o);
    assert!(ctx.place_return(0, 10.0, 5.0, &[]));
    let Geo::Circ(x, _, _) = ctx.bd.shapes.last().unwrap().geo else { panic!("the return via is the last shape") };
    assert!(x <= 9.0, "site at x = {x} is outside the zone");
    ctx.bd.ppoly[0].1 = vec![(0.0, 0.0), (4.0, 0.0), (4.0, 10.0), (0.0, 10.0)];
    assert!(!ctx.place_return(0, 15.0, 5.0, &[]), "no zone in reach: the layer change is rejected");
}
