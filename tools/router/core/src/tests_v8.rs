//! Unit checks of the v8 fixes (cargo test --release): rated pin escape and per-layer current width (fix 1), rule
//! areas (fix 2), the bounded third-net repair of a plane net (fix 3). Each test fails on the v7 code.
use super::*;
use super::tests_v6::opts;

fn n(name: &str, plane: bool) -> Net {
    Net { name: name.into(), width: 0.15, clr: 0.15, fast: false, plane, power: false, layers: 0b101, via_d: 0.6, via_drill: 0.3, max_vias: None,
          max_len: None, pref: false, min_w: 0.0, min_wl: Vec::new(), in_vias: 0 }
}

/// A power net of 2.1 A: 0.55 mm on F.Cu / B.Cu (1 oz), 1.27 mm on the thin inner copper (as ESP32-CORE VSYS_IN).
fn pwr(name: &str) -> Net {
    Net { power: true, width: 0.4, min_w: 0.55, min_wl: vec![0.55, 1.27, 0.55], layers: 0b111, ..n(name, false) }
}

fn grid() -> Grid {
    let (nx, ny, nr) = (401, 201, 3);
    let tot = nx * ny * nr;
    Grid { x0: 0.0, y0: 0.0, p: 0.05, nx, ny, nr, cache: vec![0; tot], vcache: vec![0; nx * ny], dcache: vec![0; tot], hist: vec![0.0; tot],
           vhist: vec![0.0; nx * ny], pres: 0.5, g: vec![0.0; tot], from: vec![0; tot], seen: vec![0; tot], closed: vec![0; tot], tgt: vec![0; tot], sgen: 0, tgen: 0, glen: Vec::new(), lhist: Vec::new(), jit: Default::default() }
}

/// 20 x 10 mm, F.Cu / In2.Cu / B.Cu all routable; nets P (power), A, B, GND (index 3, plane).
fn board() -> Board {
    let nets = vec![pwr("P"), n("A", false), n("B", false), Net { via_d: 0.45, via_drill: 0.2, ..n("GND", true) }];
    Board { layer_names: vec!["F.Cu".into(), "In2.Cu".into(), "B.Cu".into()], routable: vec![0, 1, 2], nets, shapes: Vec::new(),
            idx: Index::new(-1.0, -1.0, 21.0, 11.0, 3), sidx: Index::new(-1.0, -1.0, 21.0, 11.0, 3), maxc: 0.15,
            edge: (0.0, 0.0, 20.0, 10.0), edge_clr: 0.3, gnd: 3, plane_clr: 0.25, eps: EPS, hole_clr: 0.28,
            spoke_notes: Vec::new(), attach: Vec::new(), spoke_sites: std::collections::HashSet::new(), adj: 0, pad_need: Vec::new(), gnd_fixed: Vec::new(), pours: Vec::new(),
            circ: std::collections::HashMap::new(), vip: Vec::new(), tvia: Vec::new(), web: 0.0, web_hard: false, via_len: DEF_VIA_LEN, keep: Vec::new(), esc: Vec::new(), edges: Vec::new(), fvia: Vec::new(), iso: None, niv: Vec::new(), ppoly: Vec::new(), twin: Vec::new(), gnds: Vec::new(), pidx: Vec::new(), prad: Vec::new(), noret: Vec::new(), rgn: Vec::new(), rfill: Default::default() }
}

pub(crate) fn ctx_of<'a>(bd: &'a mut Board, o: &'a Opts) -> Ctx<'a> {
    let nn = bd.nets.len();
    let memo_w = bd.nets.iter().flat_map(|n| net_widths(n)).collect();
    let g = grid();
    let k = g.nx * g.ny;
    Ctx { bd, gr: g, o, strict: false, dead: vec![(Vec::new(), String::new()); nn], memo: Vec::new(), memo_w, rcache: vec![0; k],
          ban: Vec::new(), neck: Vec::new(), len_cap: None, len_boxes: Vec::new(), len_mode: false, ret_soft: true, lfloor: Vec::new(), leaf_necks: false, stubs: std::collections::HashMap::new(), stub_cost: Default::default(), recover: false, fan_keep: false }
}

/// A SOT-583 pin: 0.28 x 0.68 mm, long side along y, centre (x, y), on F.Cu.
fn pin(net: i32, x: f64, y: f64) -> Shape {
    Shape { net, geo: Geo::Rect(x - 0.14, y - 0.34, x + 0.14, y + 0.34), clr: 0.15, layers: 1, drill: 0.0, kind: Kind::Pad, owner: -1, alive: true, grp: 0 }
}

/// Fix 2 (ESP32-CORE L1_NO_TRACKS, 10 items_not_allowed in v7): a rule area that does not allow tracks on F.Cu and
/// In2.Cu, and vias, blocks every net there (also the net of a pad inside it), and nothing on B.Cu. v7 had no keepouts.
#[test]
fn rule_area_blocks_tracks_and_vias_of_every_net() {
    let mut bd = board();
    bd.keep.push(Keep { r: (9.0, 4.0, 10.0, 6.0), tl: 0b011, via: true, poly: Vec::new(), holes: Vec::new(), pl: 0 });
    for net in [0usize, 1, 3] {
        assert_eq!(bd.track_cost(net, 0, 9.5, 5.0, 0.075, 0.25, None), -1, "track inside, F.Cu");
        assert_eq!(bd.track_cost(net, 1, 9.5, 5.0, 0.075, 0.25, None), -1, "track inside, In2.Cu");
        assert_eq!(bd.track_cost(net, 2, 9.5, 5.0, 0.075, 0.25, None), 0, "B.Cu is allowed");
        assert_eq!(bd.track_cost(net, 0, 10.06, 5.0, 0.075, 0.25, None), -1, "copper edge 0.015 mm inside the area");
        assert_eq!(bd.track_cost(net, 0, 10.1, 5.0, 0.075, 0.25, None), 0, "copper edge 0.025 mm outside");
        assert_eq!(bd.via_cost(net, 10.2, 5.0, 0.6, 0.3, 0.25, None), -1, "via copper touches the area");
        assert_eq!(bd.via_cost(net, 10.4, 5.0, 0.6, 0.3, 0.25, None), 0, "via 0.1 mm clear");
    }
}

/// Fix 1 (ESP32-CORE: 2.1 A net, 0.55 mm on F.Cu, U3 pins 0.28 mm at 0.5 mm pitch): a pin with a rating in
/// tools/pin-ratings.json (model pad escape) necks to its narrow side, below the current width, for a zone capped by
/// the gate's escape length; an unrated pin of a power chain keeps the current width; an unrated pin in no chain
/// (no design current, not checked by the gate) necks like a signal pin. v7: every pin kept min_w (no path).
#[test]
fn rated_pin_escape_necks_below_the_current_width() {
    let o = opts();
    let mut bd = board();
    bd.add(pin(0, 5.0, 5.0));
    bd.add(pin(0, 8.0, 5.0));
    bd.add(pin(0, 11.0, 5.0));
    bd.esc.push(((4.86, 4.66, 5.14, 5.34), 0.28, 0.68, true));
    bd.pad_need.push((5.0, 5.0, 0.55));
    bd.pad_need.push((8.0, 5.0, 0.55));
    let mut ctx = ctx_of(&mut bd, &o);
    ctx.set_neck(0, 0.275);
    // v8b: a rated pin has no neck zone (the search keeps the full width); its narrow entry is one escape stub
    assert!((ctx.hw_at(0, 5.0, 4.66 - 0.20, 0.275) - 0.275).abs() < 1e-9, "no neck zone at a rated pin");
    let st = ctx.escape_stubs(0, 0);
    assert!(!st.is_empty() && st.iter().all(|s| (s.hw - 0.14).abs() < 1e-9 && s.len <= 0.68 - 1e-3));
    // unrated chain pin: the current width
    assert!((ctx.hw_at(0, 8.0, 4.66 - 0.1, 0.275) - 0.275).abs() < 1e-9);
    // unrated pin in no chain: the current width while chain pads are joined; the pad's narrow side only when the
    // join targets leaf pads (route_net joins them last: ESP32-CORE b6, VSYS_IN ran through the U2.5 necks)
    assert!((ctx.hw_at(0, 11.0, 4.66 - 0.1, 0.275) - 0.275).abs() < 1e-9);
    ctx.leaf_necks = true;
    ctx.set_neck(0, 0.275);
    assert!((ctx.hw_at(0, 11.0, 4.66 - 0.1, 0.275) - 0.14).abs() < 1e-9);
}

/// Fix 1b: the gate rates every piece with the copper of its own layer. The net's search width is the outer-layer
/// current width (0.55 mm); on the thin inner copper the layer floor (1.27 mm) applies. v7 used the widest (1.27 mm)
/// on every layer, so no track fit between the 0.5 mm pitch pins.
#[test]
fn layer_floor_raises_the_width_on_thin_copper() {
    let o = opts();
    let mut bd = board();
    assert_eq!(net_widths(&bd.nets[0])[0], 0.55);
    let mut ctx = ctx_of(&mut bd, &o);
    ctx.set_neck(0, 0.275);
    assert!((ctx.hw_at(0, 15.0, 5.0, 0.275) - 0.275).abs() < 1e-9, "F.Cu");
    assert!((ctx.hw_at(1, 15.0, 5.0, 0.275) - 0.635).abs() < 1e-9, "In2.Cu");
    // geometry writes the layer floor as the track width on In2.Cu
    let p = ctx.gr.p;
    let path: Vec<usize> = (0..20).map(|k| { let (i, j) = ctx.gr.at(14.0 + k as f64 * p, 5.0); ctx.gr.nx * ctx.gr.ny + j * ctx.gr.nx + i }).collect();
    let (tr, _) = ctx.geometry(0, &path, 0.275);
    assert!(!tr.is_empty() && tr.iter().all(|t| t.0 == 1 && (t.3 - 0.635).abs() < 1e-9));
}

/// Fix 1c: the gate gives the escape only to ONE piece that starts on the pad and is no longer than the pad's long
/// side. Two narrow pieces (a bend inside the zone) become one straight piece from END_IN inside the pad; the full
/// width piece stays. v7 had no merge (the second narrow piece had no escape credit: paths_low).
#[test]
fn escape_merge_gives_one_piece_no_longer_than_the_pad() {
    let o = opts();
    let mut bd = board();
    bd.add(pin(0, 5.0, 5.0));
    bd.esc.push(((4.86, 4.66, 5.14, 5.34), 0.28, 0.68, true));
    let mut ctx = ctx_of(&mut bd, &o);
    ctx.set_neck(0, 0.275);
    let mut tr = vec![(0usize, (5.0, 5.2), (5.0, 4.5), 0.14), (0, (5.0, 4.5), (4.8, 4.3), 0.14), (0, (4.8, 4.3), (4.0, 3.5), 0.275)];
    ctx.merge_escapes(0, 0, &mut tr, 0, 0.275);
    assert_eq!(tr.len(), 2, "one narrow piece + the full piece: {tr:?}");
    let (a, b, h) = (tr[0].1, tr[0].2, tr[0].3);
    assert!((h - 0.14).abs() < 1e-9);
    assert_eq!(b, (4.8, 4.3));
    assert!(Geo::Rect(4.86, 4.66, 5.14, 5.34).dist(a.0, a.1) <= 0.0, "starts inside the pad: {a:?}");
    assert!((b.0 - a.0).hypot(b.1 - a.1) <= 0.68, "no longer than the pad's long side");
    assert_eq!(tr[1].1, (4.8, 4.3));
}

/// Fix 3 (ESP32-CORE a5: the end step ran about 9 minutes on GND): for a plane net only the nets with copper near a
/// pad with no fan-out via are repair candidates. v7 took the bbox of all GND items: every routed net.
#[test]
fn plane_repair_looks_only_near_the_open_pads() {
    let mut bd = board();
    let g = 3;
    bd.add(pin(g, 3.0, 5.0)); // open: no via
    bd.add(pin(g, 17.0, 5.0)); // has a fixed via beside it
    bd.add(Shape { net: g, geo: Geo::Circ(17.0, 6.0, 0.225), clr: 0.15, layers: 0b111, drill: 0.2, kind: Kind::Via, owner: -1, alive: true, grp: 0 });
    let tr = |net: i32, x: f64| Shape { net, geo: Geo::Seg(x, 2.0, x, 8.0, 0.075), clr: 0.15, layers: 1, drill: 0.0, kind: Kind::Track, owner: net, alive: true, grp: 0 };
    bd.add(tr(1, 4.0)); // A: 1 mm from the open pad
    bd.add(tr(2, 16.0)); // B: near the pad that has its via, far from the open one
    bd.add(tr(0, 10.0)); // P: in the middle of the board
    assert_eq!(repair_cands(&bd, g as usize, &[0, 1, 2]), vec![1]);
    // a routed net keeps the v7 window (JOIN_MARGIN around its own items)
    bd.add(pin(1, 9.0, 5.0));
    assert_eq!(repair_cands(&bd, 1, &[0, 1, 2]), vec![0]);
}

/// Fix 4 (BASE-PWR-C U1.41, second unseen board): a plane-net pad ringed by other pads (the 3 x 3 exposed-pad grid of a
/// module) has no legal via site within 2 mm of its centre; the fan-out then looks out to 3 mm. v7: "no via site
/// within 2 mm" (a hard fail for the whole run).
#[test]
fn ringed_plane_pad_finds_a_via_site_past_2_mm() {
    let o = opts();
    let mut bd = board();
    let g = 3;
    let sq = |net: i32, x: f64, y: f64| Shape { net, geo: Geo::Rect(x - 0.45, y - 0.45, x + 0.45, y + 0.45), clr: 0.15, layers: 1, drill: 0.0,
                                               kind: Kind::Pad, owner: -1, alive: true, grp: 0 };
    for i in -1..=1 {
        for j in -1..=1 {
            bd.add(sq(if i == 0 && j == 0 { g } else { 1 }, 10.0 + 1.4 * i as f64, 5.0 + 1.4 * j as f64));
        }
    }
    let mut ctx = ctx_of(&mut bd, &o);
    let r = fanout_net(&mut ctx, g as usize);
    assert!(r.hard_fail.is_none(), "{:?}", r.hard_fail);
    let v = ctx.bd.shapes.iter().find(|s| s.alive && s.net == g && s.kind == Kind::Via).expect("a fan-out via");
    let Geo::Circ(x, y, _) = v.geo else { panic!() };
    let d = (x - 10.0).hypot(y - 5.0);
    assert!(d > 2.0 && d <= 3.0 * SQ2, "via at {d:.2} mm");
}

/// Fix 5 (BASE-PWR-C, 9 copper_edge_clearance): the board edge is the Edge.Cuts outline, not only its bbox. A notch
/// edge inside the bbox keeps tracks and vias edge_clr away. v7 checked the bbox only.
#[test]
fn notch_in_the_outline_keeps_the_edge_clearance() {
    let mut bd = board();
    bd.edges.push((15.0, 0.0, 15.0, 4.0)); // a notch edge from the top side down to y = 4
    assert_eq!(bd.track_cost(1, 0, 15.3, 2.0, 0.075, 0.25, None), -1, "0.3 mm from the notch edge (rule 0.075 + 0.3, as the bbox rule)");
    assert_eq!(bd.track_cost(1, 0, 15.4, 2.0, 0.075, 0.25, None), 0);
    assert_eq!(bd.via_cost(1, 15.5, 2.0, 0.6, 0.3, 0.25, None), -1);
    assert_eq!(bd.track_cost(1, 0, 15.0, 4.5, 0.075, 0.25, None), 0, "past the end of the notch");
}

/// v8b fix 1 (H7-CORE b7 U2.3, paths_low): the stubs of a rated pin start inside the pad, are straight, no longer than
/// the pad's long side and legal at the pad's narrow width; between 0.5 mm pitch neighbours none goes sideways.
#[test]
fn escape_stubs_are_straight_legal_and_short() {
    let o = opts();
    let mut bd = board();
    bd.add(pin(0, 5.0, 5.0));
    bd.add(pin(1, 4.5, 5.0));
    bd.add(pin(2, 5.5, 5.0));
    bd.esc.push(((4.86, 4.66, 5.14, 5.34), 0.28, 0.68, true));
    let mut ctx = ctx_of(&mut bd, &o);
    let st = ctx.escape_stubs(0, 0);
    assert!(!st.is_empty());
    for s in &st {
        assert!(s.a.0 >= 4.86 + END_IN && s.a.0 <= 5.14 - END_IN && s.a.1 >= 4.66 + END_IN && s.a.1 <= 5.34 - END_IN, "starts END_IN inside: {s:?}");
        assert!(Geo::Rect(4.86, 4.66, 5.14, 5.34).dist(s.b.0, s.b.1) > 0.0, "ends outside: {s:?}");
        assert!(((s.b.0 - s.a.0).hypot(s.b.1 - s.a.1) - s.len).abs() < 1e-9 && s.len <= 0.68 - 1e-3);
        assert!(s.b.1 < 4.66 || s.b.1 > 5.34, "no sideways stub between the neighbours: {s:?}");
    }
}

/// v8b (ESP32-CORE c1: /SW1_LX /SW2_LX GND standoff from iteration 40 to 80): a stub that crosses routed copper of
/// another net is priced like the A* steps under it (present cost x soft conflicts, history), and a strict search may
/// not take it. c1 took any stub at no price when a pad had no free one, so the negotiation never moved it.
#[test]
fn stub_through_routed_copper_is_priced_and_strict_refuses_it() {
    let o = opts();
    let mut bd = board();
    bd.add(pin(0, 5.0, 5.0));
    bd.esc.push(((4.86, 4.66, 5.14, 5.34), 0.28, 0.68, true));
    // routed track of net A across the north side of the pin, 0.3 mm above the pad end
    bd.add(Shape { net: 1, geo: Geo::Seg(4.0, 4.36, 6.0, 4.36, 0.075), clr: 0.15, layers: 1, drill: 0.0, kind: Kind::Track, owner: 1, alive: true, grp: 0 });
    let mut ctx = ctx_of(&mut bd, &o);
    let st = ctx.escape_stubs(0, 0);
    let north = st.iter().find(|s| s.b.1 < 4.3 && (s.b.0 - s.a.0).abs() < 1e-9).expect("a straight north stub");
    let south = st.iter().find(|s| s.b.1 > 5.34 && (s.b.0 - s.a.0).abs() < 1e-9 && (s.len - north.len).abs() < 1e-9).expect("a south stub as long");
    let (pn, ps) = (ctx.stub_price(0, north).unwrap(), ctx.stub_price(0, south).unwrap());
    assert!(pn > ps * 1.2, "crossing {pn} vs free {ps}");
    ctx.strict = true;
    assert!(ctx.stub_price(0, north).is_none() && ctx.stub_price(0, south).is_some());
}

/// The paths gate rule (tools/pcbtool.py width_report / net_graph pin escape) on the routed copper of `net`: every
/// track narrower than `need` is a pin escape of a rated pad in `esc`: one end inside the pad, no narrower than its
/// narrow side, no longer than its long side. A track with an end in a leaf pad (a pad in no power chain: no
/// pad_need) is a dead-end branch that carries no chain current; the gate does not rate it.
fn gate_escape_faults(ctx: &Ctx, net: i32, need: f64) -> Vec<String> {
    let leaf = |x: f64, y: f64| ctx.bd.shapes.iter().any(|s| s.alive && s.net == net && s.kind == Kind::Pad && s.owner < 0
        && s.geo.dist(x, y) <= 0.0 && { let (a, b, c, d) = s.geo.bbox(); let (cx, cy) = ((a + c) / 2.0, (b + d) / 2.0);
            !ctx.bd.pad_need.iter().any(|q| (q.0 - cx).abs() < 1e-6 && (q.1 - cy).abs() < 1e-6) });
    let mut out = Vec::new();
    for s in ctx.bd.shapes.iter().filter(|s| s.alive && s.owner == net && s.kind == Kind::Track) {
        let Geo::Seg(ax, ay, bx, by, hw) = s.geo else { continue };
        if 2.0 * hw >= need - 1e-6 {
            continue;
        }
        let len = (bx - ax).hypot(by - ay);
        if leaf(ax, ay) || leaf(bx, by) {
            continue;
        }
        let ok = ctx.bd.esc.iter().any(|&((x0, y0, x1, y1), w, l, _)| {
            let inside = |x: f64, y: f64| x > x0 && x < x1 && y > y0 && y < y1;
            (inside(ax, ay) || inside(bx, by)) && 2.0 * hw >= w - 1e-6 && len <= l + 1e-6
        });
        if !ok {
            out.push(format!("({ax:.3}, {ay:.3})-({bx:.3}, {by:.3}) w {:.3} len {len:.3}", 2.0 * hw));
        }
    }
    out
}

/// v8b fix 1 (H7-CORE b7: VSYS_IN reached U2.3 along the 0.6 mm channel between the two pin rows: narrow pieces with a
/// bend, no escape credit, paths_low). The H7-CORE U2 layout, moved: rated U2.3 = P at (5.0, 6.28); U2.5 = P leaf
/// (no design current) at (5.5, 5.0); U2.6, U2.4 = other nets; the 1.5 A chain (0.35 mm) comes from a pad east of the
/// channel. The narrow copper must be one straight escape piece of U2.3; the rest is at the current width.
#[test]
fn rated_pin_is_joined_through_one_straight_escape() {
    let o = opts();
    let mut bd = board();
    bd.nets[0].min_wl = vec![0.35, 0.35, 0.35];
    bd.nets[0].min_w = 0.35;
    bd.nets[0].layers = 0b001; // F.Cu only: no via detour
    for (net, x, y) in [(0, 5.0, 6.28), (1, 4.5, 6.28), (2, 5.5, 6.28), (1, 4.5, 5.0), (2, 5.0, 5.0), (0, 5.5, 5.0)] {
        bd.add(pin(net, x, y));
    }
    bd.esc.push(((4.86, 5.94, 5.14, 6.62), 0.28, 0.68, true));
    bd.add(Shape { net: 0, geo: Geo::Rect(7.5, 5.1, 8.5, 6.1), clr: 0.15, layers: 1, drill: 0.0, kind: Kind::Pad, owner: -1, alive: true, grp: 0 });
    bd.pad_need.push((5.0, 6.28, 0.35));
    bd.pad_need.push((8.0, 5.6, 0.35));
    let mut ctx = ctx_of(&mut bd, &o);
    let r = route_net(&mut ctx, 0);
    assert!(r.hard_fail.is_none(), "{:?}", r.hard_fail);
    let bad = gate_escape_faults(&ctx, 0, 0.35);
    let all: Vec<_> = ctx.bd.shapes.iter().filter(|s| s.alive && s.owner == 0).map(|s| s.geo).collect();
    assert!(bad.is_empty(), "narrow pieces with no escape credit: {bad:?}; copper {all:?}");
}

/// v8b (ESP32-CORE c1, /SW2_LX + GND strict re-route open): the two LX pins of a SOT-583 (0.5 mm pitch, 2.1 A, 0.55 mm)
/// go to the two inductor pads up-left and up-right. A 45 degree stub does not pass the U3.1 / U3.4 corners and two
/// straight stubs leave the full widths 0.5 mm apart; steep straight stubs (any angle) let both nets route strictly.
#[test]
fn adjacent_lx_pins_both_route_through_any_angle_stubs() {
    let o = opts();
    let mut bd = board();
    bd.nets[1] = pwr("A");
    for (net, x, y) in [(2, 5.0, 6.5), (0, 5.5, 6.5), (1, 6.0, 6.5), (2, 6.5, 6.5), (2, 5.0, 7.78), (2, 5.5, 7.78), (2, 6.0, 7.78), (2, 6.5, 7.78)] {
        bd.add(pin(net, x, y));
    }
    bd.esc.push(((5.36, 6.16, 5.64, 6.84), 0.28, 0.68, true));
    bd.esc.push(((5.86, 6.16, 6.14, 6.84), 0.28, 0.68, true));
    bd.add(Shape { net: 0, geo: Geo::Rect(3.35, 0.89, 4.95, 4.39), clr: 0.15, layers: 1, drill: 0.0, kind: Kind::Pad, owner: -1, alive: true, grp: 0 });
    bd.add(Shape { net: 1, geo: Geo::Rect(6.55, 0.89, 8.15, 4.39), clr: 0.15, layers: 1, drill: 0.0, kind: Kind::Pad, owner: -1, alive: true, grp: 0 });
    for q in [(5.5, 6.5), (6.0, 6.5), (4.15, 2.64), (7.35, 2.64)] {
        bd.pad_need.push((q.0, q.1, 0.55));
    }
    bd.nets[0].layers = 0b001;
    bd.nets[1].layers = 0b001;
    let mut ctx = ctx_of(&mut bd, &o);
    ctx.strict = true;
    let (r0, r1) = (route_net(&mut ctx, 0), route_net(&mut ctx, 1));
    assert!(r0.hard_fail.is_none() && r1.hard_fail.is_none(), "{:?} {:?}", r0.hard_fail, r1.hard_fail);
    assert_eq!(ctx.audit(0.0).pairs, 0);
    for net in [0, 1] {
        let bad = gate_escape_faults(&ctx, net, 0.55);
        assert!(bad.is_empty(), "net {net}: {bad:?}");
    }
}

/// v8b (ESP32-CORE c1 paths_low: GND J2.4 -> U3.6 2.1 A through one 0.3 mm fan-out via, 1.92 A): a plane-net pad in
/// the model fanout_via list gets that larger via; the other pads keep the net's via. c1 used the net via everywhere.
#[test]
fn plane_pad_of_a_high_current_chain_fans_out_through_its_larger_via() {
    let o = opts();
    let mut bd = board();
    let g = 3;
    bd.add(pin(g, 5.0, 5.0));
    bd.add(pin(g, 12.0, 5.0));
    bd.fvia.push((5.0, 5.0, 0.65, 0.35));
    let mut ctx = ctx_of(&mut bd, &o);
    let r = fanout_net(&mut ctx, g as usize);
    assert!(r.hard_fail.is_none(), "{:?}", r.hard_fail);
    let vias: Vec<(f64, f64, f64)> = ctx.bd.shapes.iter().filter(|s| s.alive && s.net == g && s.kind == Kind::Via)
        .map(|s| match s.geo { Geo::Circ(x, _, r) => (x, r, s.drill), _ => panic!() }).collect();
    assert_eq!(vias.len(), 2, "{vias:?}");
    for (x, r, dr) in vias {
        if x < 8.5 { assert!((r - 0.325).abs() < 1e-9 && (dr - 0.35).abs() < 1e-9) } else { assert!((r - 0.225).abs() < 1e-9 && (dr - 0.2).abs() < 1e-9) }
    }
    assert_eq!((ctx.bd.nets[3].via_d, ctx.bd.nets[3].via_drill), (0.45, 0.2), "the net via is restored");
}

/// v8b (ESP32-CORE c4: GND-only standoff from iteration 17 to 80, U12 GND pads 0.65 mm apart, one free via site): when
/// no new via site is free, a plane-net pad fans out with a track to a via of its net already there (no new via).
/// c4: "no via site within 3 mm" in the strict end step.
#[test]
fn plane_pad_with_no_free_site_shares_a_via_of_its_net() {
    let o = opts();
    let mut bd = board();
    let g = 3;
    bd.add(Shape { net: g, geo: Geo::Rect(9.85, 4.8, 10.15, 5.2), clr: 0.15, layers: 1, drill: 0.0, kind: Kind::Pad, owner: -1, alive: true, grp: 0 });
    // a GND via of the net 1.5 mm away (fixed here; in the router also the fan-out via of a neighbour pad placed
    // before in the same fan-out) and routed copper of net A on In2.Cu over every via site
    bd.add(Shape { net: g, geo: Geo::Circ(10.0, 6.5, 0.225), clr: 0.15, layers: 0b111, drill: 0.2, kind: Kind::Via, owner: -1, alive: true, grp: 0 });
    bd.add(Shape { net: 1, geo: Geo::Seg(6.0, 5.0, 14.0, 5.0, 3.6), clr: 0.15, layers: 0b010, drill: 0.0, kind: Kind::Track, owner: 1, alive: true, grp: 0 });
    let mut ctx = ctx_of(&mut bd, &o);
    ctx.strict = true;
    let r = fanout_net(&mut ctx, g as usize);
    assert!(r.hard_fail.is_none(), "{:?}", r.hard_fail);
    let vias = ctx.bd.shapes.iter().filter(|s| s.alive && s.net == g && s.kind == Kind::Via).count();
    assert_eq!(vias, 1, "no new via");
    assert!(ctx.bd.shapes.iter().any(|s| s.alive && s.net == g && s.kind == Kind::Track && s.owner == g));
}

/// v8b (ESP32-CORE c5 diag: U12.2 / U12.3 forced fan-outs, one column, vias 0.3 mm apart, GND-GND standoff): the
/// second forced fan-out goes on along its ray past a site in conflict, or takes the first pad's via (no new via).
#[test]
fn forced_fanouts_in_one_column_do_not_break_hole_to_hole() {
    let o = opts();
    let mut bd = board();
    let g = 3;
    let pad = |net: i32, a: f64, b: f64, c: f64, d: f64| Shape { net, geo: Geo::Rect(a, b, c, d), clr: 0.15, layers: 1, drill: 0.0, kind: Kind::Pad, owner: -1, alive: true, grp: 0 };
    bd.add(pad(g, 9.85, 4.8, 10.15, 5.2));
    bd.add(pad(g, 9.85, 5.45, 10.15, 5.85));
    bd.add(pad(1, 10.45, 3.0, 12.0, 5.9)); // walls of another net: only the south ray is open
    bd.add(pad(1, 8.0, 3.0, 9.55, 5.9));
    bd.add(pad(1, 9.85, 3.0, 10.15, 4.45));
    bd.attach.push((10.0, 5.0));
    bd.attach.push((10.0, 5.65));
    for i in 0..=240 {
        for j in 0..=240 {
            let (x, y) = (7.0 + i as f64 * 0.025, 3.0 + j as f64 * 0.025);
            bd.spoke_sites.insert(((x * 1e3).round() as i64, (y * 1e3).round() as i64));
        }
    }
    let mut ctx = ctx_of(&mut bd, &o);
    ctx.gr.pres = 1000.0; // the standoff ran at the present-cost cap
    let r = fanout_net(&mut ctx, g as usize);
    assert!(r.hard_fail.is_none(), "{:?}", r.hard_fail);
    let n_tr = ctx.bd.shapes.iter().filter(|s| s.alive && s.net == g && s.kind == Kind::Track).count();
    assert_eq!(n_tr, 2, "one spoke track per pad");
    let au = ctx.audit(0.0);
    let ids: Vec<_> = au.pair_ids.iter().map(|&(a, b)| (ctx.bd.shapes[a as usize].geo, ctx.bd.shapes[a as usize].owner, ctx.bd.shapes[b as usize].geo, ctx.bd.shapes[b as usize].owner)).collect();
    assert_eq!(au.pairs, 0, "no GND-GND hole-to-hole conflict: {ids:?}");
}

/// Fix 1e (H7-CORE b5, paths_low 2): /SW1_LX left U3.3 straight out and then at 45 degrees (two narrow pieces); the
/// straight chord passes 0.287 mm from the corner of U3.4 (rule 0.29). A start near the corner of the rectangular pad
/// gives one legal straight piece. The same layout, moved: U3.3 at (5.0, 5.36), U3.4 at (4.5, 5.36), U3.2 at (5.5, 5.36).
#[test]
fn escape_start_near_the_rect_corner_clears_the_neighbour() {
    let o = opts();
    let mut bd = board();
    bd.nets[0].min_wl = vec![0.35, 0.35, 0.35];
    bd.nets[0].min_w = 0.35;
    bd.add(pin(0, 5.0, 5.36));
    bd.add(pin(1, 4.5, 5.36));
    bd.add(pin(2, 5.5, 5.36));
    bd.esc.push(((4.86, 5.02, 5.14, 5.70), 0.28, 0.68, true));
    let mut ctx = ctx_of(&mut bd, &o);
    ctx.set_neck(0, 0.175);
    let far = (4.705, 4.655);
    let mut tr = vec![(0usize, (4.15, 4.1), far, 0.175), (0, far, (5.0, 4.95), 0.14), (0, (5.0, 4.95), (5.0, 5.05), 0.14)];
    ctx.merge_escapes(0, 0, &mut tr, 0, 0.175);
    assert_eq!(tr.len(), 2, "{tr:?}");
    let (a, b) = (tr[1].1, tr[1].2);
    assert_eq!(a, far);
    assert!(b.0 >= 4.86 + END_IN && b.0 <= 5.14 - END_IN && b.1 >= 5.02 + END_IN && b.1 <= 5.70 - END_IN, "ends END_IN inside the pad: {b:?}");
    assert!((b.0 - a.0).hypot(b.1 - a.1) <= 0.68);
    // clear of the U3.4 corner (4.64, 5.02) by the rule 0.14 + 0.15
    assert!(seg_dist(4.64, 5.02, a.0, a.1, b.0, b.1) >= 0.29);
}

#[test]
fn live_preview_writes_only_live_routed_geometry() {
    let o = opts();
    let mut bd = board();
    bd.add(pin(0, 1.0, 1.0));
    let base = bd.shapes.len();
    bd.add(Shape { net: 1, geo: Geo::Seg(1.0, 2.0, 3.0, 4.0, 0.1), clr: 0.15, layers: 1, drill: 0.0, kind: Kind::Track, owner: 1, alive: true, grp: 0 });
    bd.add(Shape { net: 1, geo: Geo::Circ(3.0, 4.0, 0.3), clr: 0.15, layers: 7, drill: 0.3, kind: Kind::Via, owner: 1, alive: true, grp: 0 });
    let ctx = ctx_of(&mut bd, &o);
    let file = std::env::temp_dir().join(format!("iotroute-live-test-{}.json", std::process::id()));
    live_frame(&ctx, base, 7, 20, 2, 3, 5.0, "fixture-hash", &file).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(value["schema"], "iot-lab.route-preview.v1");
    assert_eq!(value["passes"], 7);
    assert_eq!(value["conflict_pairs"], 3);
    assert_eq!(value["tracks"].as_array().unwrap().len(), 1);
    assert_eq!(value["vias"].as_array().unwrap().len(), 1);
    assert_eq!(value["tracks"][0]["layer"], "F.Cu");
    assert_eq!(ctx.bd.shapes.len(), 3);
    std::fs::remove_file(file).unwrap();
}
