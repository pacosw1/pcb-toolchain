//! Unit checks of the partial re-route (reuse.rs, `--reuse`; cargo test --release).
use super::*;
use super::tests_v6::{opts, pad};
use serde_json::json;

fn n(name: &str) -> Net {
    Net { name: name.into(), width: 0.15, clr: 0.15, fast: false, plane: false, power: false, layers: 0b101, via_d: 0.6, via_drill: 0.3, max_vias: None,
          max_len: None, pref: false, min_w: 0.0, min_wl: Vec::new(), in_vias: 0 }
}

/// 20 x 10 mm, F.Cu / In1.Cu / B.Cu; signal nets A (0), B (1), plane net GND (2).
fn board() -> Board {
    let nets = vec![n("A"), n("B"), Net { plane: true, via_d: 0.45, via_drill: 0.2, ..n("GND") }];
    Board { layer_names: vec!["F.Cu".into(), "In1.Cu".into(), "B.Cu".into()], routable: vec![0, 2], nets, shapes: Vec::new(),
            idx: Index::new(-1.0, -1.0, 21.0, 11.0, 3), sidx: Index::new(-1.0, -1.0, 21.0, 11.0, 3), maxc: 0.15,
            edge: (0.0, 0.0, 20.0, 10.0), edge_clr: 0.3, gnd: 2, plane_clr: 0.25, eps: EPS, hole_clr: 0.28,
            spoke_notes: Vec::new(), attach: Vec::new(), spoke_sites: std::collections::HashSet::new(), adj: 0b101, pad_need: Vec::new(), gnd_fixed: Vec::new(), pours: Vec::new(),
            circ: std::collections::HashMap::new(), vip: Vec::new(), web: 0.0, web_hard: false, via_len: DEF_VIA_LEN, keep: Vec::new(), esc: Vec::new(), edges: Vec::new(), fvia: Vec::new(), iso: None, niv: Vec::new(), ppoly: Vec::new(), twin: Vec::new(), gnds: Vec::new(), pidx: Vec::new(), prad: Vec::new(), noret: Vec::new(), rgn: Vec::new(), rfill: Default::default() }
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
          stubs: std::collections::HashMap::new(), stub_cost: Default::default(), recover: false, fan_keep: false }
}

/// model pad record (ref, bbox) of a pad shape made by tests_v6::pad
fn mpad(rf: &str, x: f64, y: f64) -> Value {
    json!({"ref": rf, "bbox": [x - 0.3, y - 0.2, x + 0.3, y + 0.2]})
}

fn trk(net: &str, a: (f64, f64), b: (f64, f64)) -> Value {
    json!({"net": net, "layer": "F.Cu", "a": [a.0, a.1], "b": [b.0, b.1], "w": 0.15})
}

fn alive_of(bd: &Board, net: i32) -> Vec<(i32, String)> {
    bd.shapes.iter().filter(|s| s.alive && s.owner >= 0 && s.net == net).map(|s| (s.owner, format!("{:?}", s.geo))).collect()
}

/// A: pads R1.1 (2, 2) and R2.1 (18, 2); B: pads R3.1 (2, 8) and R4.1 (18, 8); seed copper: one straight track each.
fn two_nets(bd: &mut Board) -> (Value, Vec<Value>) {
    bd.add(pad(0, 2.0, 2.0, 1));
    bd.add(pad(0, 18.0, 2.0, 1));
    bd.add(pad(1, 2.0, 8.0, 1));
    bd.add(pad(1, 18.0, 8.0, 1));
    let model = json!({"pads": [mpad("R1", 2.0, 2.0), mpad("R2", 18.0, 2.0), mpad("R3", 2.0, 8.0), mpad("R4", 18.0, 8.0)]});
    (model, vec![trk("A", (2.0, 2.0), (18.0, 2.0)), trk("B", (2.0, 8.0), (18.0, 8.0))])
}

/// Kept vs ripped selection: a net with a pad on a moved part and a net that the earlier route reported failed are
/// ripped (no seed copper); the other net keeps its seed copper as routed copper (owner = net).
#[test]
fn reuse_keeps_untouched_nets_and_rips_moved_and_failed_ones() {
    let o = opts();
    let mut bd = board();
    let (model, tracks) = two_nets(&mut bd);
    let seed = json!({"moved_refs": ["R2"], "failed_nets": [], "tracks": tracks, "vias": []});
    let plan = reuse::load_seed(&mut bd, &o, &model, &seed);
    assert_eq!(plan.rip, vec![0]);
    assert_eq!(plan.why, vec![(0, "pad on a moved part")]);
    assert_eq!(plan.kept_nets, 1);
    assert!(alive_of(&bd, 0).is_empty(), "A's seed copper is not loaded");
    assert_eq!(alive_of(&bd, 1).len(), 1);
    assert_eq!(alive_of(&bd, 1)[0].0, 1, "B's copper is routed copper of B (soft, the negotiation may rip it)");

    let mut bd = board();
    let (model, tracks) = two_nets(&mut bd);
    let seed = json!({"moved_refs": [], "failed_nets": ["B"], "tracks": tracks, "vias": []});
    let plan = reuse::load_seed(&mut bd, &o, &model, &seed);
    assert_eq!(plan.rip, vec![1]);
    assert_eq!(plan.why, vec![(1, "failed in the earlier route")]);
    assert_eq!(alive_of(&bd, 0).len(), 1);

    // nothing moved, nothing failed: everything stays, nothing to route
    let mut bd = board();
    let (model, tracks) = two_nets(&mut bd);
    let seed = json!({"moved_refs": [], "failed_nets": [], "tracks": tracks, "vias": []});
    let plan = reuse::load_seed(&mut bd, &o, &model, &seed);
    assert!(plan.rip.is_empty() && plan.fan.is_empty());
    assert_eq!(plan.items_kept, 2);
}

/// Conflict detection: B's seed track now crosses a pad of A that moved onto it (fixed copper), so B is ripped too,
/// although no pad of B moved; a seed track that leaves its net open (it ends short of a pad) rips the net.
#[test]
fn reuse_rips_a_kept_net_whose_seed_copper_breaks_a_fixed_rule_or_leaves_it_open() {
    let o = opts();
    let mut bd = board();
    bd.add(pad(0, 2.0, 2.0, 1));
    bd.add(pad(0, 10.0, 8.0, 1)); // R2 moved from (18, 2) onto B's track
    bd.add(pad(1, 2.0, 8.0, 1));
    bd.add(pad(1, 18.0, 8.0, 1));
    let model = json!({"pads": [mpad("R1", 2.0, 2.0), mpad("R2", 10.0, 8.0), mpad("R3", 2.0, 8.0), mpad("R4", 18.0, 8.0)]});
    let seed = json!({"moved_refs": ["R2"], "failed_nets": [], "tracks": [trk("A", (2.0, 2.0), (18.0, 2.0)), trk("B", (2.0, 8.0), (18.0, 8.0))], "vias": []});
    let plan = reuse::load_seed(&mut bd, &o, &model, &seed);
    assert_eq!(plan.why, vec![(0, "pad on a moved part"), (1, "seed copper breaks a fixed rule")]);
    assert!(alive_of(&bd, 1).is_empty());
    assert_eq!(bd.eps, EPS, "the plain-rule check restores the routing margin");

    let mut bd = board();
    let (model, _) = two_nets(&mut bd);
    let seed = json!({"moved_refs": [], "failed_nets": [], "tracks": [trk("A", (2.0, 2.0), (18.0, 2.0)), trk("B", (2.0, 8.0), (12.0, 8.0))], "vias": []});
    let plan = reuse::load_seed(&mut bd, &o, &model, &seed);
    assert_eq!(plan.why, vec![(1, "seed copper leaves the net open")]);
}

/// Plane net: the fan-out cluster of an unmoved pad is kept, the one of a moved pad is dropped; fanout_net in keep mode
/// (Ctx::fan_keep, iteration 1 of a reuse route) fans out only the pad with no fan-out and leaves the kept one as it was.
#[test]
fn reuse_plane_net_refans_only_the_moved_pad() {
    let o = opts();
    let mut bd = board();
    bd.add(pad(2, 5.0, 5.0, 1));
    bd.add(pad(2, 15.0, 5.5, 1)); // R6 moved from (15, 5)
    let model = json!({"pads": [mpad("R5", 5.0, 5.0), mpad("R6", 15.0, 5.5)]});
    let via = |x: f64, y: f64| json!({"net": "GND", "x": x, "y": y, "d": 0.45, "drill": 0.2, "role": "plane"});
    let seed = json!({"moved_refs": ["R6"], "failed_nets": [], "vias": [via(5.0, 6.2), via(15.0, 6.2)],
                      "tracks": [json!({"net": "GND", "layer": "F.Cu", "a": [5.0, 5.0], "b": [5.0, 6.2], "w": 0.15}),
                                 json!({"net": "GND", "layer": "F.Cu", "a": [15.0, 5.0], "b": [15.0, 6.2], "w": 0.15})]});
    let plan = reuse::load_seed(&mut bd, &o, &model, &seed);
    assert!(plan.rip.is_empty());
    assert_eq!(plan.fan, vec![2]);
    assert_eq!(plan.fan_dropped, 1);
    let kept = alive_of(&bd, 2);
    assert_eq!(kept.len(), 2, "track + via of R5 stay");
    let mut ctx = ctx_of(&mut bd, &o);
    ctx.fan_keep = true;
    let r = fanout_net(&mut ctx, 2);
    assert!(r.hard_fail.is_none());
    let after = alive_of(ctx.bd, 2);
    assert!(kept.iter().all(|k| after.contains(k)), "the kept fan-out is not routed again");
    let moved = ctx.bd.shapes.iter().find(|s| s.kind == Kind::Pad && s.net == 2 && matches!(s.geo, Geo::Rect(a, ..) if a > 14.0)).unwrap().clone();
    assert!(ctx.bd.shapes.iter().any(|s| s.alive && s.owner == 2 && touch(s, &moved)), "the moved pad has a new fan-out");
    assert!(after.len() > kept.len());
    // keep mode off (any later iteration): the whole net fans out again
    ctx.fan_keep = false;
    let before = ctx.bd.shapes.len();
    fanout_net(&mut ctx, 2);
    assert!(ctx.bd.shapes.len() > before, "full fan-out routes every pad again");
}

/// Return vias: a seed return via goes to the nearest kept signal via within the RP-001 radius; with none (its owner
/// was ripped) it is dropped.
#[test]
fn reuse_return_via_follows_a_kept_signal_via_or_is_dropped() {
    let o = opts();
    let mut bd = board();
    let (model, _) = two_nets(&mut bd);
    let sv = |net: &str, x: f64, y: f64| json!({"net": net, "x": x, "y": y, "d": 0.6, "drill": 0.3, "role": "signal"});
    let rv = |x: f64, y: f64| json!({"net": "GND", "x": x, "y": y, "d": 0.45, "drill": 0.2, "role": "return"});
    let b = |a: (f64, f64), c: (f64, f64), l: &str| json!({"net": "B", "layer": l, "a": [a.0, a.1], "b": [c.0, c.1], "w": 0.15});
    let a = |p: (f64, f64), c: (f64, f64), l: &str| json!({"net": "A", "layer": l, "a": [p.0, p.1], "b": [c.0, c.1], "w": 0.15});
    let seed = json!({"moved_refs": ["R1"], "failed_nets": [],
        "tracks": [a((2.0, 2.0), (6.0, 2.0), "F.Cu"), a((6.0, 2.0), (18.0, 2.0), "B.Cu"), b((2.0, 8.0), (10.0, 8.0), "F.Cu"), b((10.0, 8.0), (18.0, 8.0), "F.Cu")],
        "vias": [sv("A", 6.0, 2.0), rv(6.0, 3.2), sv("B", 10.0, 8.0), rv(11.2, 8.0)]});
    let plan = reuse::load_seed(&mut bd, &o, &model, &seed);
    assert_eq!(plan.rip, vec![0]);
    let rets: Vec<(i32, f64)> = bd.shapes.iter().filter(|s| s.alive && s.net == 2 && s.kind == Kind::Via).map(|s| (s.owner, match s.geo { Geo::Circ(x, _, _) => x, _ => 0.0 })).collect();
    assert_eq!(rets, vec![(1, 11.2)], "B's return stays (owner B); A's return is dropped with A");
}

/// The length recovery scope: nets routed in this run and nets with copper within `near` of a change; a far net is
/// not visited.
#[test]
fn reuse_recover_scope_is_the_changed_region() {
    let o = opts();
    let mut bd = board();
    let (model, tracks) = two_nets(&mut bd);
    let seed = json!({"moved_refs": ["R2"], "failed_nets": [], "tracks": tracks, "vias": []});
    let plan = reuse::load_seed(&mut bd, &o, &model, &seed);
    let moves = vec![1u32, 0, 0];
    assert_eq!(reuse::recover_scope(&bd, &plan, &moves, 1.0), vec![true, false, false], "B is 6 mm from A's copper");
    assert_eq!(reuse::recover_scope(&bd, &plan, &moves, 7.0), vec![true, true, false]);
}
