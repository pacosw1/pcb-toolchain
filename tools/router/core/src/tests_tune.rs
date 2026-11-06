//! Unit checks of the opt-in length / skew tuning stage (tune.rs).
use super::*;
use super::tests_v6::{opts, pad};

fn n(name: &str) -> Net {
    Net { name: name.into(), width: 0.15, clr: 0.15, fast: false, plane: false, power: false, layers: 0b101, via_d: 0.6, via_drill: 0.3, max_vias: None,
          max_len: None, pref: false, min_w: 0.0, min_wl: Vec::new(), in_vias: 0, neck_w: 0.0 }
}

fn grid() -> Grid {
    let (nx, ny, nr) = (401, 201, 2);
    let tot = nx * ny * nr;
    Grid { x0: 0.0, y0: 0.0, p: 0.05, nx, ny, nr, cache: vec![0; tot], vcache: vec![0; nx * ny], dcache: vec![0; tot], hist: vec![0.0; tot],
           vhist: vec![0.0; nx * ny], pres: 0.5, g: vec![0.0; tot], from: vec![0; tot], seen: vec![0; tot], closed: vec![0; tot], tgt: vec![0; tot], sgen: 0, tgen: 0, glen: Vec::new(), lhist: Vec::new(), jit: Default::default() }
}

/// 20 x 10 mm, F.Cu / In1.Cu / B.Cu; nets A, B, C.
fn board() -> Board {
    Board { layer_names: vec!["F.Cu".into(), "In1.Cu".into(), "B.Cu".into()], routable: vec![0, 2], nets: vec![n("A"), n("B"), n("C")], shapes: Vec::new(),
            idx: Index::new(-1.0, -1.0, 21.0, 11.0, 3), sidx: Index::new(-1.0, -1.0, 21.0, 11.0, 3), maxc: 0.15,
            edge: (0.0, 0.0, 20.0, 10.0), edge_clr: 0.3, gnd: -1, plane_clr: 0.25, eps: EPS, hole_clr: 0.28,
            spoke_notes: Vec::new(), attach: Vec::new(), spoke_sites: std::collections::HashSet::new(), adj: 0, pad_need: Vec::new(), gnd_fixed: Vec::new(), pours: Vec::new(),
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

/// A from (2, 5) to (12, 5), B from (2, 2) to (18, 2): both routed, one F.Cu track each, pads at the ends.
fn two_nets(a_owner: i32) -> Board {
    let mut bd = board();
    for (net, y, x1) in [(0, 5.0, 12.0), (1, 2.0, 18.0)] {
        bd.add(pad(net, 2.0, y, 1));
        bd.add(pad(net, x1, y, 1));
        bd.add(track(net, (2.0, y), (x1, y), if net == 0 { a_owner } else { 1 }));
    }
    bd
}

fn skew(max: f64) -> Value {
    serde_json::json!({"schema": "iot-lab.route-tune.v0", "skew": [{"rule": "bus", "nets": ["A", "B"], "max": max}], "length": []})
}

fn state(nn: usize) -> Vec<(Option<String>, u32)> {
    vec![(None, 0); nn]
}

/// Every live routed item is legal (exact audit) and A is still one piece from pad to pad.
fn assert_legal_and_joined(ctx: &mut Ctx) {
    let au = ctx.audit(0.0);
    assert_eq!((au.pairs, au.hard), (0, 0), "meander copper breaks a rule");
    let ends: Vec<((f64, f64), (f64, f64))> = ctx.bd.shapes.iter().filter(|s| s.alive && s.net == 0 && s.kind == Kind::Track)
        .map(|s| match s.geo { Geo::Seg(ax, ay, bx, by, _) => ((ax, ay), (bx, by)), _ => unreachable!() }).collect();
    let mut at = (2.0, 5.0);
    for _ in 0..ends.len() {
        let Some(next) = ends.iter().find(|e| (e.0.0 - at.0).abs() < 1e-9 && (e.0.1 - at.1).abs() < 1e-9) else { break };
        at = next.1;
    }
    assert!((at.0 - 12.0).abs() < 1e-9 && (at.1 - 5.0).abs() < 1e-9, "A no longer runs from pad to pad: ends at {at:?}");
}

#[test]
fn the_short_net_of_a_skew_group_gets_a_legal_meander_into_the_window() {
    let o = opts();
    let mut bd = two_nets(0);
    let mut ctx = ctx_of(&mut bd, &o);
    let t = tune::tune(&mut ctx, &skew(1.0), &state(3));
    let len = net_lengths(ctx.bd);
    assert!(len[1] - len[0] <= 0.5 + 1e-6 && len[0] <= len[1], "A {:.2} B {:.2}: skew over half the max", len[0], len[1]);
    assert!((len[1] - 16.0 - 0.0).abs() < 1e-9, "B, the longest, is not touched");
    assert_legal_and_joined(&mut ctx);
    assert_eq!(t.report["nets"][0]["met"], true);
    assert!(t.report["groups"][0]["skew_after"].as_f64().unwrap() <= 0.5 + 1e-6);
}

#[test]
fn a_meander_keeps_clear_of_other_copper() {
    let o = opts();
    let mut bd = two_nets(0);
    // C runs 0.4 mm above A over its whole length (0.25 mm of copper apart): no bump fits above A, so the meander goes below
    bd.add(track(2, (2.6, 5.4), (11.4, 5.4), 2));
    let mut ctx = ctx_of(&mut bd, &o);
    tune::tune(&mut ctx, &skew(1.0), &state(3));
    let len = net_lengths(ctx.bd);
    assert!(len[1] - len[0] <= 0.5 + 1e-6, "A {:.2} B {:.2}", len[0], len[1]);
    let up: Vec<String> = ctx.bd.shapes.iter().filter(|s| s.alive && s.net == 0 && s.kind == Kind::Track && s.geo.bbox().3 > 5.0 + 0.075 + 1e-9).map(|s| format!("{:?}", s.geo)).collect();
    assert!(up.is_empty(), "a bump went up towards C: {up:?}");
    assert_legal_and_joined(&mut ctx);
}

#[test]
fn hand_copper_is_not_tuned() {
    let o = opts();
    let mut bd = two_nets(-1);
    let mut ctx = ctx_of(&mut bd, &o);
    let before: Vec<String> = ctx.bd.shapes.iter().map(|s| format!("{:?} {}", s.geo, s.alive)).collect();
    let t = tune::tune(&mut ctx, &skew(1.0), &state(3));
    let after: Vec<String> = ctx.bd.shapes.iter().map(|s| format!("{:?} {}", s.geo, s.alive)).collect();
    assert_eq!(before, after);
    assert!(t.report["nets"][0]["skipped"].as_str().unwrap().contains("hand"));
    assert_eq!(t.report["nets"][0]["met"], false);
}

#[test]
fn a_branch_on_the_track_is_never_cut_off() {
    let o = opts();
    let mut bd = two_nets(0);
    // a branch of A joins the middle of its track at x = 7: the stretch around it must stay
    bd.add(track(0, (7.0, 5.0), (7.0, 8.0), 0));
    bd.add(pad(0, 7.0, 8.0, 1));
    let mut ctx = ctx_of(&mut bd, &o);
    tune::tune(&mut ctx, &skew(1.0), &state(3));
    let joined = ctx.bd.shapes.iter().any(|s| s.alive && s.net == 0 && s.kind == Kind::Track && match s.geo {
        Geo::Seg(ax, ay, bx, by, _) => (ay - 5.0).abs() < 1e-9 && (by - 5.0).abs() < 1e-9 && ax.min(bx) <= 7.0 && ax.max(bx) >= 7.0,
        _ => false,
    });
    assert!(joined, "the track no longer passes the branch at x = 7");
    assert_legal_and_joined(&mut ctx);
}

#[test]
fn a_length_min_lengthens_a_net_and_a_met_target_changes_nothing() {
    let o = opts();
    let mut bd = two_nets(0);
    let mut ctx = ctx_of(&mut bd, &o);
    let targets = serde_json::json!({"skew": [], "length": [{"rule": "l", "net": "A", "min": 12.0, "max": 13.0}, {"rule": "l", "net": "B", "min": 10.0}]});
    tune::tune(&mut ctx, &targets, &state(3));
    let len = net_lengths(ctx.bd);
    assert!(len[0] >= 12.05 && len[0] <= 12.95, "A {:.2}", len[0]);
    assert!((len[1] - 16.0).abs() < 1e-9, "B already meets its min");
    assert_legal_and_joined(&mut ctx);
}
