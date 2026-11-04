//! Unit checks of the layer negotiation of one-layer nets (layers.rs, cargo test --release).
use super::*;

fn n(name: &str, plane: bool) -> Net {
    Net { name: name.into(), width: 0.15, clr: 0.15, fast: false, plane, power: false, layers: 0b101, via_d: 0.6, via_drill: 0.3,
          max_vias: if plane { None } else { Some(0.0) }, max_len: None, pref: false, min_w: 0.0, min_wl: Vec::new(), in_vias: 0 }
}

fn opts() -> Opts {
    Opts { pitch: 0.05, passes: 1, plane_clr: 0.25, hth: 0.45, return_r: 2.0, ret_d: 0.45, ret_drill: 0.2, pres_mult: 1.5, pres_max: 1000.0,
           hist: 0.3, max_time: 0.0, door_hist: 2.0, via_cost: DEF_VIA_COST, ret_cost: DEF_RET_COST, web_cost: DEF_WEB_COST, no_recover: false, stall_passes: 0 }
}

fn grid() -> Grid {
    let (nx, ny, nr) = (201, 201, 2);
    let tot = nx * ny * nr;
    Grid { x0: 0.0, y0: 0.0, p: 0.05, nx, ny, nr, cache: vec![0; tot], vcache: vec![0; nx * ny], dcache: vec![0; tot], hist: vec![0.0; tot],
           vhist: vec![0.0; nx * ny], pres: 0.5, g: vec![0.0; tot], from: vec![0; tot], seen: vec![0; tot], closed: vec![0; tot], tgt: vec![0; tot], sgen: 0, tgen: 0, glen: Vec::new(), lhist: Vec::new(), jit: Default::default() }
}

/// 10 x 10 mm, F.Cu / In1.Cu (plane) / B.Cu, routable F.Cu and B.Cu. Nets A, B (DRU via_count max 0: one layer), C, GND.
fn board() -> Board {
    let nets = vec![n("A", false), n("B", false), Net { max_vias: None, ..n("C", false) }, Net { via_d: 0.45, via_drill: 0.2, ..n("GND", true) }];
    Board { layer_names: vec!["F.Cu".into(), "In1.Cu".into(), "B.Cu".into()], routable: vec![0, 2], nets, shapes: Vec::new(),
            idx: Index::new(-1.0, -1.0, 11.0, 11.0, 3), sidx: Index::new(-1.0, -1.0, 11.0, 11.0, 3), maxc: 0.15,
            edge: (0.0, 0.0, 10.0, 10.0), edge_clr: 0.3, gnd: 3, plane_clr: 0.25, eps: EPS, hole_clr: 0.28,
            spoke_notes: Vec::new(), attach: Vec::new(), spoke_sites: std::collections::HashSet::new(), adj: 0, pad_need: Vec::new(), gnd_fixed: Vec::new(), pours: Vec::new(), circ: std::collections::HashMap::new(), vip: Vec::new(), tvia: Vec::new(), web: 0.0, web_hard: false, via_len: DEF_VIA_LEN, keep: Vec::new(), esc: Vec::new(), edges: Vec::new(), fvia: Vec::new(), iso: None, niv: Vec::new(), ppoly: Vec::new(), twin: Vec::new(), gnds: Vec::new(), pidx: Vec::new(), prad: Vec::new(), noret: Vec::new(), rgn: Vec::new(), rfill: Default::default() }
}

/// a pad of `net` (through-hole: copper on all three layers; SMD: F.Cu only)
fn pad(bd: &mut Board, net: i32, r: (f64, f64, f64, f64), tht: bool) {
    bd.add(Shape { net, geo: Geo::Rect(r.0, r.1, r.2, r.3), clr: 0.15, layers: if tht { 0b111 } else { 0b001 }, drill: if tht { 0.4 } else { 0.0 },
                   kind: Kind::Pad, owner: -1, alive: true, grp: 0 });
}

fn ctx_of<'a>(bd: &'a mut Board, o: &'a Opts) -> Ctx<'a> {
    let nn = bd.nets.len();
    let memo_w = bd.nets.iter().flat_map(|n| net_widths(n)).collect();
    Ctx { bd, gr: grid(), o, strict: false, dead: vec![(Vec::new(), String::new()); nn], memo: Vec::new(), memo_w, rcache: vec![0; 201 * 201],
          ban: Vec::new(), neck: Vec::new(), len_cap: None, len_boxes: Vec::new(), len_mode: false, ret_soft: true, lfloor: Vec::new(), leaf_necks: false, stubs: std::collections::HashMap::new(), stub_cost: Default::default(), recover: false, fan_keep: false }
}

/// copper layer mask of the live routed tracks of `net`
fn on(ctx: &Ctx, net: usize) -> u8 {
    ctx.bd.shapes.iter().filter(|s| s.alive && s.owner == net as i32 && s.kind == Kind::Track).fold(0, |m, s| m | s.layers)
}

/// A: through-hole pads at (2, 5) and (8, 5)
fn net_a(bd: &mut Board, tht: bool) {
    pad(bd, 0, (1.6, 4.6, 2.4, 5.4), tht);
    pad(bd, 0, (7.6, 4.6, 8.4, 5.4), tht);
}

/// Which nets choose a layer as a whole: no layer change possible (via_count budget 0 here) and 2 or more layers where
/// every fixed item of the net has copper.
#[test]
fn one_layer_nets_are_found() {
    let o = opts();
    let mut bd = board();
    net_a(&mut bd, true);
    let ctx = ctx_of(&mut bd, &o);
    assert_eq!(ctx.layer_choice(0), Some(vec![0, 2]), "through-hole pads, via_count 0");
    let mut bd = board();
    net_a(&mut bd, true);
    bd.nets[0].max_vias = None;
    assert_eq!(ctx_of(&mut bd, &o).layer_choice(0), None, "vias allowed: routes as before");
    let mut bd = board();
    net_a(&mut bd, true);
    bd.nets[0].max_vias = Some(2.0);
    bd.nets[0].in_vias = 2;
    assert_eq!(ctx_of(&mut bd, &o).layer_choice(0), Some(vec![0, 2]), "the locked input vias use the whole budget");
    let mut bd = board();
    net_a(&mut bd, false);
    assert_eq!(ctx_of(&mut bd, &o).layer_choice(0), None, "SMD pads: F.Cu is the only layer");
}

/// The layer history moves a one-layer net to the other layer as a whole, and back when the other layer collects more.
#[test]
fn layer_history_moves_the_whole_net() {
    let o = opts();
    let mut bd = board();
    net_a(&mut bd, true);
    let mut ctx = ctx_of(&mut bd, &o);
    assert!(route_net(&mut ctx, 0).hard_fail.is_none());
    assert_eq!(on(&ctx, 0), 0b001, "no history: F.Cu (layer cost 1.0 against 1.05)");
    for _ in 0..3 {
        ctx.layer_hist(&[0], 0.3);
    }
    assert!((ctx.lhist_of(0, 0) - 0.9).abs() < 1e-6 && ctx.lhist_of(0, 1) == 0.0);
    assert!(route_net(&mut ctx, 0).hard_fail.is_none());
    assert_eq!(on(&ctx, 0), 0b100, "F.Cu history 0.9: the whole net moves to B.Cu");
    for _ in 0..4 {
        ctx.layer_hist(&[0], 0.3);
    }
    assert!(route_net(&mut ctx, 0).hard_fail.is_none());
    assert_eq!(on(&ctx, 0), 0b001, "B.Cu history 1.2 > 0.9: back to F.Cu");
    assert_eq!(ctx.bd.shapes.iter().filter(|s| s.alive && s.owner == 0).count(), 1, "one straight track, the tries left no copper");
    // a net that is not one-layer gets no layer history
    ctx.layer_hist(&[2], 0.3);
    assert_eq!(ctx.lhist_of(2, 0), 0.0);
}

/// A wall on one layer is no proof for the net: it routes on the other layer and ctx.dead stays empty.
#[test]
fn wall_on_one_layer_is_no_dead_proof() {
    let o = opts();
    let mut bd = board();
    net_a(&mut bd, true);
    bd.add(Shape { net: 2, geo: Geo::Seg(5.0, -1.0, 5.0, 11.0, 0.25), clr: 0.15, layers: 0b001, drill: 0.0, kind: Kind::Track, owner: -1, alive: true, grp: 0 });
    let mut ctx = ctx_of(&mut bd, &o);
    let r = route_net(&mut ctx, 0);
    assert!(r.hard_fail.is_none(), "{:?}", r.hard_fail);
    assert_eq!(on(&ctx, 0), 0b100);
    assert!(ctx.dead[0].0.is_empty() && ctx.dead[0].1.is_empty(), "the F.Cu wall is not a wall of the net");
    // walls on both layers: no single layer joins it; routed as before, a named fail
    ctx.bd.add(Shape { net: 2, geo: Geo::Seg(5.0, -1.0, 5.0, 11.0, 0.25), clr: 0.15, layers: 0b100, drill: 0.0, kind: Kind::Track, owner: -1, alive: true, grp: 0 });
    ctx.memo.clear();
    let r = route_net(&mut ctx, 0);
    assert!(r.hard_fail.is_some());
    assert_eq!(on(&ctx, 0), 0);
}

/// Two one-layer nets that must cross (their pads touch the board edge region, no way around) end on different layers
/// in the negotiation, each on one layer only.
#[test]
fn crossing_one_layer_nets_negotiate_their_layers() {
    let o = opts();
    let mut bd = board();
    pad(&mut bd, 0, (0.2, 4.4, 1.5, 5.6), true);
    pad(&mut bd, 0, (8.5, 4.4, 9.8, 5.6), true);
    pad(&mut bd, 1, (4.4, 0.2, 5.6, 1.5), true);
    pad(&mut bd, 1, (4.4, 8.5, 5.6, 9.8), true);
    let mut ctx = ctx_of(&mut bd, &o);
    let mut todo = vec![0usize, 1];
    let mut done = false;
    for _ in 0..12 {
        for &net in &todo {
            assert!(route_net(&mut ctx, net).hard_fail.is_none());
        }
        let au = ctx.audit(o.hist);
        let involved: Vec<usize> = (0..ctx.bd.nets.len()).filter(|&n| au.per_net[n] > 0 || !au.partners[n].is_empty()).collect();
        ctx.layer_hist(&involved, o.hist);
        if involved.is_empty() {
            done = true;
            break;
        }
        ctx.gr.pres = (ctx.gr.pres * o.pres_mult).min(o.pres_max);
        todo = involved;
    }
    assert!(done, "converged");
    let (a, b) = (on(&ctx, 0), on(&ctx, 1));
    assert!((a == 0b001 && b == 0b100) || (a == 0b100 && b == 0b001), "A {a:03b} B {b:03b}");
}
