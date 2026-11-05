//! Unit checks of the reference-plane fill edge (model `ref_fill`, reffill.rs; cargo test --release). Each test fails
//! on the code before this rule: there a track of a checked net over a void of its reference plane is free.
use super::*;

/// 30 x 20 mm, F.Cu / In1.Cu (plane) / B.Cu, F.Cu references In1.Cu. The GND fill on In1.Cu covers (1, 1)-(29, 19)
/// less a screw-hole void (10, 8)-(14, 12). SIG and SIG2 are checked nets of domain GND, OTH is checked with no
/// domain. A SIG pad (1.0 x 1.0) at (14.5, 10): its anchor disc (0.5 + via_allow 0.6) reaches into the void.
fn model(with_fill: bool) -> Value {
    let mut m = serde_json::json!({
        "copper_layers": ["F.Cu", "In1.Cu", "B.Cu"], "plane_layers": ["In1.Cu"], "adjacent": {"F.Cu": "In1.Cu"},
        "outline_bbox": [0.0, 0.0, 30.0, 20.0], "setup": {"edge_clearance": 0.3},
        "classes": {"Default": {"width": 0.15, "clearance": 0.15, "via": 0.6, "drill": 0.3}},
        "nets": {"SIG": {"class": "Default", "layers": ["F.Cu", "B.Cu"], "plane_ref": true, "ref_domain": "GND"},
                 "SIG2": {"class": "Default", "layers": ["F.Cu", "B.Cu"], "plane_ref": true, "ref_domain": "GND"},
                 "OTH": {"class": "Default", "layers": ["F.Cu", "B.Cu"], "plane_ref": true},
                 "GND": {"class": "Default", "layers": ["F.Cu", "B.Cu"], "plane": true}},
        "pads": [{"ref": "U1", "num": "1", "net": "SIG", "x": 14.5, "y": 10.0, "bbox": [14.0, 9.5, 15.0, 10.5],
                  "layers": ["F.Cu"], "drill": 0.0}],
        "copper": []
    });
    if with_fill {
        m["ref_fill"] = serde_json::json!({"via_allow": 0.6, "anchors": [[14.5, 10.0, 0.5, "SIG"]],
            "layers": {"F.Cu": {"plane": "In1.Cu", "domains": {"GND": [[
                [[1.0, 1.0], [29.0, 1.0], [29.0, 19.0], [1.0, 19.0]],
                [[10.0, 8.0], [10.0, 12.0], [14.0, 12.0], [14.0, 8.0]]]]}}}});
    }
    m
}

fn id(bd: &Board, n: &str) -> usize {
    bd.nets.iter().position(|q| q.name == n).unwrap()
}

#[test]
fn track_keeps_on_the_filled_reference() {
    let bd = load(&model(true), 0.28);
    let (sig, sig2, oth) = (id(&bd, "SIG"), id(&bd, "SIG2"), id(&bd, "OTH"));
    let cost = |net: usize, l: usize, x: f64| bd.track_cost(net, l, x, 10.0, 0.075, 0.25, None);
    assert!(cost(sig, 0, 12.0) < 0, "SIG over the void on F.Cu: blocked");
    assert!(cost(sig, 0, 5.0) >= 0, "SIG over the fill: free");
    assert!(cost(sig, 2, 12.0) >= 0, "B.Cu has no adjacent plane in the spec: free");
    assert!(cost(oth, 0, 12.0) >= 0, "a net with no domain: free");
    assert!(cost(sig, 0, 13.6) >= 0, "SIG inside its own pad anchor disc: free");
    assert!(cost(sig2, 0, 13.6) < 0, "SIG2 at the SIG anchor: blocked");
    // the routing margin (EPS) from the fill edge; the audit (eps 0) is the gate's margin 0
    assert!(cost(sig, 0, 9.999) < 0, "0.001 mm from the edge: inside EPS");
    assert!(cost(sig, 0, 9.99) >= 0);
    let mut audit = load(&model(true), 0.28);
    audit.eps = 0.0;
    assert!(audit.track_cost(sig, 0, 9.999, 10.0, 0.075, 0.25, None) >= 0, "audit: margin 0");
    // before this rule (no ref_fill in the model): free over the void
    let old = load(&model(false), 0.28);
    assert!(old.track_cost(sig, 0, 12.0, 10.0, 0.075, 0.25, None) >= 0);
}

#[test]
fn bucket_classes_agree_with_the_exact_test() {
    let bd = load(&model(true), 0.28);
    let d = bd.rfill.dom[id(&bd, "SIG")];
    assert_eq!(d, 1);
    // every 0.0371 mm over the board (off the bucket lattice): the fast path gives the even-odd answer
    let exact = |x: f64, y: f64| (1.0..=29.0).contains(&x) && (1.0..=19.0).contains(&y) && !((10.0..=14.0).contains(&x) && (8.0..=12.0).contains(&y));
    let mut n = 0;
    let mut x: f64 = 0.013;
    while x < 30.0 {
        let mut y: f64 = 0.007;
        while y < 20.0 {
            let near_edge = [1.0f64, 29.0, 10.0, 14.0].iter().any(|e| (x - e).abs() < 1e-6) || [1.0f64, 19.0, 8.0, 12.0].iter().any(|e| (y - e).abs() < 1e-6);
            if !near_edge && (x - 14.5).hypot(y - 10.0) > 1.1 {
                assert_eq!(bd.rfill.code(0, d, x, y, 0.0) == FREE, exact(x, y), "{x} {y}");
                n += 1;
            }
            y += 0.0371;
        }
        x += 0.0371;
    }
    assert!(n > 400_000);
}

/// Gate scope (2026-11-02, model net `ref_soft`): a soft net is not blocked over the void (the gate's D-124c screen
/// may accept the run; iotroute run lets si_planes judge it) but each off-reference step is priced; a hard net stays blocked.
/// Before: ref_soft was not read, the void blocked every checked net.
#[test]
fn soft_reference_is_priced_not_blocked() {
    let mut m = model(true);
    m["nets"]["SIG"]["ref_soft"] = serde_json::json!(true);
    let bd = load(&m, 0.28);
    let (sig, sig2) = (id(&bd, "SIG"), id(&bd, "SIG2"));
    assert!(bd.track_cost(sig, 0, 12.0, 10.0, 0.075, 0.25, None) >= 0, "soft SIG over the void: not blocked");
    assert!(bd.track_cost(sig2, 0, 12.0, 10.0, 0.075, 0.25, None) < 0, "hard SIG2 over the void: blocked");
    assert!(bd.rfill.off_ref(0, sig, 12.0, 10.0, 0.0), "the void is off the reference");
    assert!(!bd.rfill.off_ref(0, sig, 5.0, 10.0, 0.0), "the fill is not");
    assert!(!bd.rfill.off_ref(0, sig, 13.6, 10.0, 0.0), "own anchor disc is not");
    assert!(!bd.rfill.off_ref(0, sig2, 12.0, 10.0, 0.0), "a hard net is never priced (it is blocked)");
    assert_ne!(bd.pflags(sig), bd.pflags(sig2), "soft and hard nets keep separate fixed-copper memo profiles");
    // the A*: SIG from (8, 10) to (16, 10) on F.Cu only. Straight through the void is 8 mm; around it (y 7.9 or 12.1)
    // about 12.3 mm. The off-reference price (1 + DEF_REF_COST per step) makes the route go around.
    let o = Opts { pitch: 0.05, passes: 1, plane_clr: 0.25, hth: 0.45, return_r: 2.0, ret_d: 0.45, ret_drill: 0.2, pres_mult: 1.5,
                   pres_max: 1000.0, hist: 0.3, max_time: 0.0, door_hist: 2.0, via_cost: DEF_VIA_COST, ret_cost: DEF_RET_COST,
                   web_cost: DEF_WEB_COST, no_recover: false, stall_passes: 0 };
    let mut bd = load(&m, 0.28);
    bd.nets[sig].layers = 1;
    let pad = |x: f64| Shape { net: sig as i32, geo: Geo::Rect(x - 0.3, 9.7, x + 0.3, 10.3), clr: 0.15, layers: 1, drill: 0.0, kind: Kind::Pad, owner: -1, alive: true, grp: 0 };
    bd.add(pad(6.0));
    bd.add(pad(18.0));
    let (nx, ny, nr) = (601, 401, 2);
    let tot = nx * ny * nr;
    let gr = Grid { x0: 0.0, y0: 0.0, p: 0.05, nx, ny, nr, cache: vec![0; tot], vcache: vec![0; nx * ny], dcache: vec![0; tot], hist: vec![0.0; tot],
                    vhist: vec![0.0; nx * ny], pres: 0.5, g: vec![0.0; tot], from: vec![0; tot], seen: vec![0; tot], closed: vec![0; tot], tgt: vec![0; tot], sgen: 0, tgen: 0, glen: Vec::new(), lhist: Vec::new(), jit: Default::default() };
    let nn = bd.nets.len();
    let memo_w = bd.nets.iter().flat_map(|n| net_widths(n)).collect();
    let mut ctx = Ctx { bd: &mut bd, gr, o: &o, strict: false, dead: vec![(Vec::new(), String::new()); nn], memo: Vec::new(), memo_w, rcache: vec![0; nx * ny],
                        ban: Vec::new(), neck: Vec::new(), len_cap: None, len_boxes: Vec::new(), len_mode: false, ret_soft: true, lfloor: Vec::new(), leaf_necks: false, stubs: std::collections::HashMap::new(), stub_cost: Default::default(), recover: false, fan_keep: false };
    assert!(route_net(&mut ctx, sig).hard_fail.is_none());
    let off: f64 = ctx.bd.shapes.iter().filter(|s| s.alive && s.owner == sig as i32 && s.kind == Kind::Track).map(|s| match s.geo {
        Geo::Seg(ax, ay, bx, by, _) => { let k = 40; (0..k).filter(|&i| { let f = (i as f64 + 0.5) / k as f64; ctx.bd.rfill.off_ref(0, sig, ax + (bx - ax) * f, ay + (by - ay) * f, 0.0) }).count() as f64 / k as f64 * (bx - ax).hypot(by - ay) }
        _ => 0.0 }).sum();
    assert!(off < 0.5, "soft SIG goes around the void: {off:.2} mm off the reference");
}
