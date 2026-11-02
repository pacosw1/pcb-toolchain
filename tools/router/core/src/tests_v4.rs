//! Unit checks of the v4 hard rules (cargo test --release): DRU via_count, RP-001 return via, si_planes plane
//! reference of slow nets, power width from the design current, track ends inside the pad.
use super::*;

fn n(name: &str, plane: bool, layers: u8) -> Net {
    Net { name: name.into(), width: 0.15, clr: 0.15, fast: false, plane, power: false, layers, via_d: 0.6, via_drill: 0.3, max_vias: None,
          max_len: None, pref: false, min_w: 0.0, min_wl: Vec::new(), in_vias: 0 }
}

fn opts() -> Opts {
    Opts { pitch: 0.05, passes: 1, plane_clr: 0.25, hth: 0.45, return_r: 2.0, ret_d: 0.45, ret_drill: 0.2, pres_mult: 1.5, pres_max: 1000.0,
           hist: 0.3, max_time: 0.0, door_hist: 2.0, via_cost: DEF_VIA_COST, ret_cost: DEF_RET_COST, web_cost: DEF_WEB_COST, no_recover: false }
}

fn grid() -> Grid {
    let (nx, ny, nr) = (201, 201, 2);
    let tot = nx * ny * nr;
    Grid { x0: 0.0, y0: 0.0, p: 0.05, nx, ny, nr, cache: vec![0; tot], vcache: vec![0; nx * ny], dcache: vec![0; tot], hist: vec![0.0; tot],
           vhist: vec![0.0; nx * ny], pres: 0.5, g: vec![0.0; tot], from: vec![0; tot], seen: vec![0; tot], closed: vec![0; tot], tgt: vec![0; tot], sgen: 0, tgen: 0, glen: Vec::new() }
}

/// 10 x 10 mm, F.Cu / In1.Cu (plane) / B.Cu. Net A: two SMD pads on F.Cu at y = 3, x = 2 and x = 8. A fixed track of
/// net C (0.5 mm wide) cuts F.Cu at x = 5 from edge to edge, so A must change layer twice. Net GND (index 2) exists,
/// with no fixed GND copper.
fn wall_board() -> Board {
    let nets = vec![n("A", false, 0b101), n("C", false, 0b101), Net { via_d: 0.45, via_drill: 0.2, ..n("GND", true, 0b101) }];
    let mut bd = Board { layer_names: vec!["F.Cu".into(), "In1.Cu".into(), "B.Cu".into()], routable: vec![0, 2], nets, shapes: Vec::new(),
                         idx: Index::new(-1.0, -1.0, 11.0, 11.0, 3), sidx: Index::new(-1.0, -1.0, 11.0, 11.0, 3), maxc: 0.15,
                         edge: (0.0, 0.0, 10.0, 10.0), edge_clr: 0.3, gnd: 2, plane_clr: 0.25, eps: EPS, hole_clr: 0.28,
                         spoke_notes: Vec::new(), attach: Vec::new(), spoke_sites: std::collections::HashSet::new(), adj: 0b101, pad_need: Vec::new(), gnd_fixed: Vec::new(), pours: Vec::new(), circ: std::collections::HashMap::new(), vip: Vec::new(), web: 0.0, web_hard: false, via_len: DEF_VIA_LEN, keep: Vec::new(), esc: Vec::new(), edges: Vec::new(), fvia: Vec::new(), iso: None, niv: Vec::new(), ppoly: Vec::new(), twin: Vec::new(), gnds: Vec::new(), pidx: Vec::new(), prad: Vec::new(), noret: Vec::new(), rgn: Vec::new(), rfill: Default::default() };
    let pad = |x: f64| Shape { net: 0, geo: Geo::Rect(x - 0.3, 2.8, x + 0.3, 3.2), clr: 0.15, layers: 1, drill: 0.0, kind: Kind::Pad, owner: -1, alive: true, grp: 0 };
    bd.add(pad(2.0));
    bd.add(pad(8.0));
    bd.add(Shape { net: 1, geo: Geo::Seg(5.0, -1.0, 5.0, 11.0, 0.25), clr: 0.15, layers: 1, drill: 0.0, kind: Kind::Track, owner: -1, alive: true, grp: 0 });
    bd
}

fn ctx_of<'a>(bd: &'a mut Board, o: &'a Opts) -> Ctx<'a> {
    let nn = bd.nets.len();
    let memo_w = bd.nets.iter().flat_map(|n| net_widths(n)).collect();
    Ctx { bd, gr: grid(), o, strict: false, dead: vec![(Vec::new(), String::new()); nn], memo: Vec::new(), memo_w, rcache: vec![0; 201 * 201],
          ban: Vec::new(), neck: Vec::new(), len_cap: None, len_boxes: Vec::new(), len_mode: false, ret_soft: true, lfloor: Vec::new(), leaf_necks: false, stubs: std::collections::HashMap::new(), stub_cost: Default::default(), recover: false, fan_keep: false }
}

fn vias_of(ctx: &Ctx, net: usize) -> usize {
    ctx.bd.shapes.iter().filter(|s| s.alive && s.owner == net as i32 && s.net == net as i32 && s.kind == Kind::Via).count()
}

/// DRU via_count is a hard limit: max 0 = one layer only (no route here: a named fail), the locked input vias count.
#[test]
fn via_count_is_a_hard_limit() {
    let o = opts();
    let mut bd = wall_board();
    let mut ctx = ctx_of(&mut bd, &o);
    let r = route_net(&mut ctx, 0);
    assert!(r.hard_fail.is_none(), "free: {:?}", r.hard_fail);
    assert_eq!(vias_of(&ctx, 0), 2, "the wall needs two layer changes");

    for (max, inp) in [(0.0, 0usize), (1.0, 0), (2.0, 1)] {
        let mut bd = wall_board();
        bd.nets[0].max_vias = Some(max);
        bd.nets[0].in_vias = inp;
        let mut ctx = ctx_of(&mut bd, &o);
        let r = route_net(&mut ctx, 0);
        let why = r.hard_fail.unwrap_or_default();
        assert!(why.contains("via_count"), "max {max} input {inp}: {why}");
        assert_eq!(vias_of(&ctx, 0), 0, "max {max} input {inp}: no via may stay");
    }
    let mut bd = wall_board();
    bd.nets[0].max_vias = Some(2.0);
    let mut ctx = ctx_of(&mut bd, &o);
    assert!(route_net(&mut ctx, 0).hard_fail.is_none(), "max 2 is enough");
}

/// RP-001 is a hard rule: every new signal via gets a GND via within --return-r that keeps the rules, and a via site
/// with no possible return is not a legal layer change.
#[test]
fn every_layer_change_has_a_return_via() {
    let o = opts();
    let mut bd = wall_board();
    let mut ctx = ctx_of(&mut bd, &o);
    assert!(route_net(&mut ctx, 0).hard_fail.is_none());
    assert_eq!(vias_of(&ctx, 0), 2);
    assert!(ctx.ret_missing().is_empty(), "missing returns: {:?}", ctx.ret_missing());
    let gnd_vias = ctx.bd.shapes.iter().filter(|s| s.alive && s.net == 2 && s.owner == 0 && s.kind == Kind::Via).count();
    assert!(gnd_vias >= 1);
    assert_eq!(ctx.audit(0.0).pairs, 0, "return vias keep the clearance");

    // a blocker of net C on the plane layer fills the board except a window that holds one signal via at (8, 8):
    // there is no GND site within 2 mm, so (8, 8) is no legal layer change; a fixed GND via 1.5 mm away makes it one
    let mut bd = wall_board();
    for g in [Geo::Rect(-1.0, -1.0, 11.0, 7.5), Geo::Rect(-1.0, 8.5, 11.0, 11.0), Geo::Rect(-1.0, 7.5, 7.5, 8.5), Geo::Rect(8.5, 7.5, 11.0, 8.5)] {
        bd.add(Shape { net: 1, geo: g, clr: 0.15, layers: 0b010, drill: 0.0, kind: Kind::Pad, owner: -1, alive: true, grp: 0 });
    }
    let mut ctx = ctx_of(&mut bd, &o);
    let (ix, iy) = ctx.gr.at(8.0, 8.0);
    assert!(ctx.vcost(0, ix, iy).is_some(), "the signal via fits the window");
    assert!(!ctx.via_site_ok(0, ix, iy), "no return site: not a legal layer change");
    ctx.bd.gnd_fixed.push((6.5, 8.0));
    ctx.rcache.iter_mut().for_each(|c| *c = 0);
    assert!(ctx.via_site_ok(0, ix, iy), "a fixed GND via within 2 mm is a return");
}

/// si_planes: a checked (pref) net on a layer with an adjacent plane keeps --plane-clr from foreign drilled items
/// (their antipads are voids in the plane); a net without the flag, or a layer without an adjacent plane, keeps only
/// the copper clearance. The via side mirrors it (a via next to a pref track is a conflict).
#[test]
fn checked_nets_stay_off_plane_voids() {
    let mut bd = wall_board();
    bd.adj = 0b001; // F.Cu has an adjacent plane, B.Cu not (for this test)
    bd.add(Shape { net: 1, geo: Geo::Circ(5.0, 7.0, 0.3), clr: 0.15, layers: 0b111, drill: 0.3, kind: Kind::Via, owner: -1, alive: true, grp: 0 });
    // track centre 0.27 mm from the via edge: copper clearance needs 0.075 + 0.15, the plane rule 0.075 + 0.25
    let (x, y) = (5.57, 7.0);
    assert!(bd.track_cost(0, 0, x, y, 0.075, 0.25, None) >= 0, "no flag: free");
    bd.nets[0].pref = true;
    assert!(bd.track_cost(0, 0, x, y, 0.075, 0.25, None) < 0, "pref on F.Cu: over the antipad");
    assert!(bd.track_cost(0, 2, x, y, 0.075, 0.25, None) >= 0, "pref on a layer with no adjacent plane: free");
    assert!(bd.track_cost(0, 0, 5.65, y, 0.075, 0.25, None) >= 0, "0.35 mm from the via edge: free");
    // mirror: a routed pref track on F.Cu, a new via of net C beside it
    bd.add(Shape { net: 0, geo: Geo::Seg(2.0, 9.0, 4.0, 9.0, 0.075), clr: 0.15, layers: 1, drill: 0.0, kind: Kind::Track, owner: 0, alive: true, grp: 0 });
    let vy = 9.0 - 0.075 - 0.3 - 0.2; // via edge 0.2 mm from the track edge
    assert!(bd.via_cost(1, 3.0, vy, 0.6, 0.3, 0.45, None) > 0, "a via beside a pref track opens a void under it");
    bd.nets[0].pref = false;
    assert_eq!(bd.via_cost(1, 3.0, vy, 0.6, 0.3, 0.45, None), 0, "no flag: the copper clearance is kept");
}

/// Power width: a power net never necks below the width of its design current, and its route keeps that width.
#[test]
fn power_width_follows_the_design_current() {
    let net = Net { power: true, width: 0.5, min_w: 0.2, ..n("P", false, 0b101) };
    let w = net_widths(&net);
    assert_eq!(w[0], 0.5);
    assert!(w.iter().all(|&x| x >= 0.2 - 1e-9), "{w:?}");
    let low = Net { power: true, width: 0.15, min_w: 0.2, ..n("P", false, 0b101) };
    assert_eq!(net_widths(&low), vec![0.2], "a class narrower than the current needs is raised");
    let o = opts();
    let mut bd = wall_board();
    bd.nets[0] = Net { power: true, width: 0.5, min_w: 0.2, ..n("A", false, 0b101) };
    let mut ctx = ctx_of(&mut bd, &o);
    assert!(route_net(&mut ctx, 0).hard_fail.is_none());
    let narrow = ctx.bd.shapes.iter().filter(|s| s.alive && s.owner == 0 && s.kind == Kind::Track)
        .filter(|s| matches!(s.geo, Geo::Seg(.., hw) if hw * 2.0 < 0.2 - 1e-9)).count();
    assert_eq!(narrow, 0, "no piece below 0.2 mm");
}

/// A track end lies strictly inside the pad (the paths gate drops an end on the pad edge: v3 "no copper path").
#[test]
fn track_ends_lie_inside_the_pad() {
    let o = opts();
    let mut bd = wall_board();
    let pad = bd.shapes[0].clone();
    let ctx = ctx_of(&mut bd, &o);
    let cells = ctx.cells_of(&pad, 0b101);
    assert!(!cells.is_empty());
    let Geo::Rect(a, b, c, d) = pad.geo else { panic!() };
    for &i in &cells {
        let (_, iy, ix) = ctx.gr.cell(i);
        let (x, y) = ctx.gr.xy(ix, iy);
        let edge = (x - a).min(c - x).min(y - b).min(d - y);
        assert!(edge >= END_IN - 1e-9, "end ({x}, {y}) {edge} mm from the pad edge");
    }
}

/// Exposed pad (M2, H7-CORE U5.25): a GND pad walled in by foreign pads on F.Cu has no fan-out site outside it. On the
/// gate viapads allow list (model `via_in_pad`) the own-net via may sit inside the pad; off the list it may not.
#[test]
fn allowed_exposed_pad_gets_a_via_in_the_pad() {
    let o = opts();
    let walled = |vip: bool| {
        let mut bd = wall_board();
        let ep = (3.7, 3.7, 6.3, 6.3);
        bd.add(Shape { net: 2, geo: Geo::Rect(ep.0, ep.1, ep.2, ep.3), clr: 0.15, layers: 1, drill: 0.0, kind: Kind::Pad, owner: -1, alive: true, grp: 0 });
        // frame of net C pads, 0.3 mm from the exposed pad, 0.5 mm wide (no via fits the gap, none outside within 2 mm)
        for g in [Geo::Rect(3.0, 3.0, 7.0, 3.4), Geo::Rect(3.0, 6.6, 7.0, 7.0), Geo::Rect(3.0, 3.4, 3.4, 6.6), Geo::Rect(6.6, 3.4, 7.0, 6.6)] {
            bd.add(Shape { net: 1, geo: g, clr: 0.15, layers: 1, drill: 0.0, kind: Kind::Pad, owner: -1, alive: true, grp: 0 });
        }
        if vip {
            bd.vip.push(ep);
        }
        bd
    };
    let mut bd = walled(false);
    let mut ctx = ctx_of(&mut bd, &o);
    let r = fanout_net(&mut ctx, 2);
    assert!(r.hard_fail.unwrap_or_default().contains("no via site"), "not allowed: no via in the pad");
    let mut bd = walled(true);
    let mut ctx = ctx_of(&mut bd, &o);
    let r = fanout_net(&mut ctx, 2);
    assert!(r.hard_fail.is_none(), "allowed: {:?}", r.hard_fail);
    let v: Vec<(f64, f64)> = ctx.bd.shapes.iter().filter(|s| s.alive && s.net == 2 && s.kind == Kind::Via)
        .map(|s| match s.geo { Geo::Circ(x, y, _) => (x, y), _ => (0.0, 0.0) }).collect();
    assert_eq!(v.len(), 1);
    assert!(v[0].0 > 3.7 && v[0].0 < 6.3 && v[0].1 > 3.7 && v[0].1 < 6.3, "via {:?} inside the pad", v[0]);
    assert_eq!(ctx.audit(0.0).pairs, 0, "the via keeps the clearance to the frame");
    // the allow list is per pad: an own-net pad off the list keeps the own-pad verdict (3 or 4), the allowed one drops it
    let own = Shape { net: 0, geo: Geo::Rect(1.7, 2.8, 2.3, 3.2), clr: 0.15, layers: 1, drill: 0.0, kind: Kind::Pad, owner: -1, alive: true, grp: 0 };
    assert!(matches!(ctx.bd.vhit(&own, 2.0, 3.0, 0.3, 0.3, 0.15, 0.45, true, 0), 3 | 4));
    let ep = Shape { net: 2, geo: Geo::Rect(3.7, 3.7, 6.3, 6.3), clr: 0.15, layers: 1, drill: 0.0, kind: Kind::Pad, owner: -1, alive: true, grp: 0 };
    assert!(!matches!(ctx.bd.vhit(&ep, 5.0, 5.0, 0.3, 0.3, 0.15, 0.45, true, 0), 3 | 4));
}

/// The return via is the GND net's own via (model class + DRU rules for GND); the flag overrides it.
#[test]
fn return_via_follows_the_gnd_net_rule() {
    let mut bd = wall_board();
    assert_eq!(return_via(&bd, None), (0.45, 0.2, "GND net"));
    bd.nets[2].via_d = 0.6;
    bd.nets[2].via_drill = 0.3;
    assert_eq!(return_via(&bd, None), (0.6, 0.3, "GND net"));
    assert_eq!(return_via(&bd, Some((0.7, 0.35))), (0.7, 0.35, "cli"));
    bd.gnd = -1;
    assert_eq!(return_via(&bd, None), (0.45, 0.2, "default"));
}

/// M2 (H7-CORE, RP-001 radius 1.0 mm, return via 0.6 / 0.3): the return ring is 0.75 .. 1.0 mm from the signal via,
/// and the path's own tracks often cover its free part. The rejected site gets its return reserved and the join routes
/// around it: every layer change has its return, no return via is left without a signal via, and the audit is clean.
#[test]
fn small_return_ring_is_reserved_before_the_route() {
    let mut o = opts();
    o.return_r = 1.0;
    o.ret_d = 0.6;
    o.ret_drill = 0.3;
    // the corridor: fixed net C copper on both layers leaves a 1.9 mm wide channel at y = 2.05 .. 3.95 around the pads
    let mut bd = wall_board();
    for g in [Geo::Rect(-1.0, -1.0, 11.0, 2.05), Geo::Rect(-1.0, 3.95, 11.0, 11.0)] {
        bd.add(Shape { net: 1, geo: g, clr: 0.15, layers: 0b100, drill: 0.0, kind: Kind::Pad, owner: -1, alive: true, grp: 0 });
    }
    let mut ctx = ctx_of(&mut bd, &o);
    let r = route_net(&mut ctx, 0);
    assert!(r.hard_fail.is_none(), "{:?}", r.hard_fail);
    assert_eq!(vias_of(&ctx, 0), 2);
    assert!(ctx.ret_missing().is_empty(), "missing returns: {:?}", ctx.ret_missing());
    let sig: Vec<(f64, f64)> = ctx.bd.shapes.iter().filter(|s| s.alive && s.owner == 0 && s.net == 0 && s.kind == Kind::Via)
        .filter_map(|s| match s.geo { Geo::Circ(x, y, _) => Some((x, y)), _ => None }).collect();
    for s in ctx.bd.shapes.iter().filter(|s| s.alive && s.owner == 0 && s.net == 2 && s.kind == Kind::Via) {
        let Geo::Circ(x, y, _) = s.geo else { panic!() };
        assert!(sig.iter().any(|&(a, b)| ((a - x).powi(2) + (b - y).powi(2)).sqrt() <= 1.0 + 1e-9), "unused return via at ({x}, {y})");
    }
    assert_eq!(ctx.audit(0.0).pairs, 0);
}

/// M2: a locked input signal via with no GND via within --return-r gets a fixed GND return via before routing (H7-CORE
/// MDI RX pair vias); a locked via that already has one gets none.
#[test]
fn locked_input_vias_get_a_return() {
    let mut o = opts();
    o.return_r = 1.0;
    o.ret_d = 0.6;
    o.ret_drill = 0.3;
    let mut bd = wall_board();
    let via = |x: f64, y: f64, net: i32| Shape { net, geo: Geo::Circ(x, y, 0.3), clr: 0.15, layers: 0b111, drill: 0.3, kind: Kind::Via, owner: -1, alive: true, grp: 0 };
    bd.add(via(2.0, 7.0, 0)); // net A, alone
    bd.add(via(8.0, 7.0, 0)); // net A, with a GND via 0.9 mm away
    bd.add(via(8.9, 7.0, 2));
    let n0 = bd.shapes.len();
    let notes = fixed_returns(&mut bd, &o);
    assert!(notes.is_empty(), "{notes:?}");
    let new: Vec<&Shape> = bd.shapes[n0..].iter().collect();
    assert_eq!(new.len(), 1, "one return, for the via at (2, 7) only");
    let Geo::Circ(x, y, _) = new[0].geo else { panic!() };
    let d = ((x - 2.0).powi(2) + (y - 7.0).powi(2)).sqrt();
    assert!(new[0].net == 2 && new[0].owner < 0 && d <= 1.0 && d >= 0.75 - 1e-9, "GND fixed via at ({x}, {y}), {d} mm");
    let o2 = opts();
    let mut ctx = ctx_of(&mut bd, &o2);
    assert_eq!(ctx.audit(0.0).pairs, 0, "the return keeps the clearance");
}
