//! Unit checks of the critical first stage (critical.rs, cargo test --release).
use super::*;

fn n(name: &str, max_vias: Option<f64>) -> Net {
    Net { name: name.into(), width: 0.15, clr: 0.15, fast: false, plane: false, power: false, layers: 0b101, via_d: 0.6, via_drill: 0.3,
          max_vias, max_len: None, pref: false, min_w: 0.0, min_wl: Vec::new(), in_vias: 0, neck_w: 0.0 }
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

/// 10 x 10 mm, F.Cu / In1.Cu / B.Cu, routable F.Cu and B.Cu, no return rule. Nets: OSC_IN, OSC_OUT (via_count 0), C (vias allowed).
fn board() -> Board {
    let nets = vec![n("OSC_IN", Some(0.0)), n("OSC_OUT", Some(0.0)), n("C", None)];
    Board { layer_names: vec!["F.Cu".into(), "In1.Cu".into(), "B.Cu".into()], routable: vec![0, 2], nets, shapes: Vec::new(),
            idx: Index::new(-1.0, -1.0, 11.0, 11.0, 3), sidx: Index::new(-1.0, -1.0, 11.0, 11.0, 3), maxc: 0.15,
            edge: (0.0, 0.0, 10.0, 10.0), edge_clr: 0.3, gnd: -1, plane_clr: 0.25, eps: EPS, hole_clr: 0.28,
            spoke_notes: Vec::new(), attach: Vec::new(), spoke_sites: std::collections::HashSet::new(), adj: 0, pad_need: Vec::new(), gnd_fixed: Vec::new(), pours: Vec::new(), circ: std::collections::HashMap::new(), vip: Vec::new(), tvia: Vec::new(), web: 0.0, web_hard: false, via_len: DEF_VIA_LEN, keep: Vec::new(), esc: Vec::new(), edges: Vec::new(), fvia: Vec::new(), iso: None, niv: Vec::new(), ppoly: Vec::new(), twin: Vec::new(), gnds: Vec::new(), pidx: Vec::new(), prad: Vec::new(), noret: Vec::new(), rgn: Vec::new(), rfill: Default::default() }
}

fn smd(bd: &mut Board, net: i32, r: (f64, f64, f64, f64)) {
    bd.add(Shape { net, geo: Geo::Rect(r.0, r.1, r.2, r.3), clr: 0.15, layers: 0b001, drill: 0.0, kind: Kind::Pad, owner: -1, alive: true, grp: 0 });
}

fn ctx_of<'a>(bd: &'a mut Board, o: &'a Opts) -> Ctx<'a> {
    let nn = bd.nets.len();
    let memo_w = bd.nets.iter().flat_map(|n| net_widths(n)).collect();
    Ctx { bd, gr: grid(), o, strict: false, dead: vec![(Vec::new(), String::new()); nn], memo: Vec::new(), memo_w, rcache: vec![0; 201 * 201],
          ban: Vec::new(), neck: Vec::new(), len_cap: None, len_boxes: Vec::new(), len_mode: false, ret_soft: true, lfloor: Vec::new(), leaf_necks: false, stubs: std::collections::HashMap::new(), stub_cost: Default::default(), recover: false, fan_keep: false }
}

fn model() -> Value {
    serde_json::json!({"critical_nets": ["OSC_IN", "OSC_OUT", "NOT_HERE"], "nets": {
        "OSC_IN": {"pins": ["U1.5", "Y1.1", "C1.1"]}, "OSC_OUT": {"pins": ["U1.6", "Y1.3", "C2.1"]}, "C": {"pins": ["J1.1", "J1.2"]}}})
}

#[test]
fn critical_nets_follow_the_model_and_group_by_shared_footprint() {
    let bd = board();
    assert_eq!(critical::critical_nets(&model(), &bd.nets, &[2, 1, 0]), [1, 0], "base order kept, only listed nets");
    assert!(critical::critical_nets(&serde_json::json!({}), &bd.nets, &[0, 1, 2]).is_empty(), "no list: no stage");
    assert_eq!(critical::groups(&model(), &bd.nets, &[0, 1]), [vec![0, 1]], "both legs share U1 and Y1");
    let apart = serde_json::json!({"nets": {"OSC_IN": {"pins": ["U1.5", "Y1.1"]}, "OSC_OUT": {"pins": ["U5.1", "Y2.1"]}}});
    assert_eq!(critical::groups(&apart, &bd.nets, &[0, 1]), [vec![0], vec![1]]);
}

/// Crystal legs from Y1 (top) to U1 (bottom), C from the left edge to the right edge across them.
fn crystal_board() -> Board {
    let mut bd = board();
    smd(&mut bd, 0, (3.0, 1.5, 3.6, 2.1));
    smd(&mut bd, 1, (6.4, 1.5, 7.0, 2.1));
    smd(&mut bd, 0, (4.4, 7.9, 4.7, 8.2));
    smd(&mut bd, 1, (5.3, 7.9, 5.6, 8.2));
    smd(&mut bd, 2, (0.5, 4.7, 1.1, 5.3));
    smd(&mut bd, 2, (8.9, 4.7, 9.5, 5.3));
    bd
}

#[test]
fn critical_nets_route_first_on_one_layer_frozen_and_the_rest_routes_around() {
    let o = opts();
    let mut bd = crystal_board();
    let mut ctx = ctx_of(&mut bd, &o);
    let stage = critical::route(&mut ctx, &[vec![0, 1]]);
    let mut frozen = stage.frozen.clone();
    frozen.sort();
    assert_eq!(frozen, [0, 1]);
    assert!(stage.notes[0].starts_with("critical stage: 2 routed of 2") && stage.notes[0].contains("imbalance"), "{:?}", stage.notes);
    for net in [0, 1] {
        let copper: Vec<&Shape> = ctx.bd.shapes.iter().filter(|s| s.alive && s.net == net && s.kind != Kind::Pad).collect();
        assert!(!copper.is_empty(), "net {net} routed");
        assert!(copper.iter().all(|s| s.kind == Kind::Track && s.layers == 0b001 && s.owner == -1), "F.Cu tracks only, fixed copper, no via");
    }
    // the mirror image legs come out the same length (the board is symmetric about x = 5)
    let lens = net_lengths(ctx.bd);
    assert!((lens[0] - lens[1]).abs() < 0.2, "legs {:.3} / {:.3}", lens[0], lens[1]);
    // C must cross the crystal legs: it changes layer and never touches them
    let r = route_net(&mut ctx, 2);
    assert!(r.hard_fail.is_none(), "{:?}", r.hard_fail);
    assert_eq!(ctx.audit(0.0).pairs, 0);
    // every point of C's copper keeps the clearance from the frozen crystal tracks on its layer
    let legs: Vec<Shape> = ctx.bd.shapes.iter().filter(|s| s.alive && (s.net == 0 || s.net == 1) && s.kind == Kind::Track).cloned().collect();
    for s in ctx.bd.shapes.iter().filter(|s| s.alive && s.owner == 2 && s.kind == Kind::Track) {
        let Geo::Seg(ax, ay, bx, by, hw) = s.geo else { unreachable!() };
        let k = ((bx - ax).hypot(by - ay) / 0.01).ceil().max(1.0) as usize;
        for i in 0..=k {
            let t = i as f64 / k as f64;
            let (x, y) = (ax + t * (bx - ax), ay + t * (by - ay));
            for leg in legs.iter().filter(|l| l.layers & s.layers != 0) {
                assert!(leg.geo.dist(x, y) >= hw + 0.15 - EPS, "C at ({x:.2}, {y:.2}) too close to a crystal leg");
            }
        }
    }
}

#[test]
fn a_critical_net_the_stage_cannot_route_keeps_no_copper() {
    let o = opts();
    let mut bd = crystal_board();
    // a fixed wall across F.Cu between Y1 and U1: no one-layer path
    bd.add(Shape { net: 2, geo: Geo::Seg(-1.0, 5.0, 11.0, 5.0, 0.2), clr: 0.15, layers: 0b001, drill: 0.0, kind: Kind::Track, owner: -1, alive: true, grp: 0 });
    let mut ctx = ctx_of(&mut bd, &o);
    let stage = critical::route(&mut ctx, &[vec![0, 1]]);
    assert!(stage.frozen.is_empty());
    assert!(stage.notes[0].contains("open, left to the negotiation: OSC_IN OSC_OUT"), "{:?}", stage.notes);
    assert!(!ctx.bd.shapes.iter().any(|s| s.alive && (s.net == 0 || s.net == 1) && s.kind != Kind::Pad));
}

#[test]
fn critical_stage_refuses_core_reuse_instead_of_silently_skipping() {
    assert!(critical::check_reuse(&model(), false).is_ok());
    assert!(critical::check_reuse(&serde_json::json!({}), true).is_ok());
    assert!(critical::check_reuse(&serde_json::json!({"critical_nets": []}), true).is_ok());
    let error = critical::check_reuse(&model(), true).unwrap_err();
    assert!(error.contains("critical_nets") && error.contains("--reuse"), "{error}");
}
