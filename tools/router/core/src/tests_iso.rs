//! Unit checks of the isolation pair rules (model `iso`, src/model/pairs.rs; cargo test --release). Each test
//! fails on the code before the isolation work (no pair table: the per-net clearance alone decides).
use super::*;

fn n(name: &str) -> Net {
    Net { name: name.into(), width: 0.2, clr: 0.2, fast: false, plane: false, power: false, layers: 0b101, via_d: 0.6, via_drill: 0.3, max_vias: None,
          max_len: None, pref: false, min_w: 0.0, min_wl: Vec::new(), in_vias: 0, neck_w: 0.0 }
}

/// 30 x 20 mm, F.Cu / In1.Cu (plane) / B.Cu; nets ISO (0), OTH (1), OTH2 (2). Groups: 0 no net, 1 ISO track outside
/// the region, 2 ISO track inside, 3 OTH pad (inside the region), 4 OTH pad outside, 5 OTH2 track, 6 ISO via, 7 NPTH
/// hole H1. Table (as src/model/pairs.rs resolves POE-ETHERNET): ISO-OTH 3.0, ISO-OTH inside the region (both items) 1.25,
/// ISO-OTH2 3.0, ISO to the H1 hole 9.65 (RELAY-4 'Mains to screw hole').
fn board(with_iso: bool) -> Board {
    let nets = vec![n("ISO"), n("OTH"), n("OTH2")];
    let mut bd = Board { layer_names: vec!["F.Cu".into(), "In1.Cu".into(), "B.Cu".into()], routable: vec![0, 2], nets, shapes: Vec::new(),
            idx: Index::new(-1.0, -1.0, 31.0, 21.0, 3), sidx: Index::new(-1.0, -1.0, 31.0, 21.0, 3), maxc: 0.2,
            edge: (0.0, 0.0, 30.0, 20.0), edge_clr: 0.3, gnd: -1, plane_clr: 0.25, eps: EPS, hole_clr: 0.28,
            spoke_notes: Vec::new(), attach: Vec::new(), spoke_sites: std::collections::HashSet::new(), adj: 0, pad_need: Vec::new(), gnd_fixed: Vec::new(), pours: Vec::new(),
            circ: std::collections::HashMap::new(), vip: Vec::new(), tvia: Vec::new(), web: 0.0, web_hard: false, via_len: DEF_VIA_LEN, keep: Vec::new(), esc: Vec::new(), edges: Vec::new(), fvia: Vec::new(), iso: None, niv: Vec::new(), ppoly: Vec::new(), twin: Vec::new(), gnds: Vec::new(), pidx: Vec::new(), prad: Vec::new(), noret: Vec::new(), rgn: Vec::new(), rfill: Default::default() };
    if with_iso {
        let g = 8;
        let mut tab = vec![0.0; g * g];
        let mut set = |a: usize, b: usize, v: f64| { tab[a * g + b] = v; tab[b * g + a] = v; };
        for iso in [1, 2, 6] {
            set(iso, 3, 3.0);
            set(iso, 4, 3.0);
            set(iso, 5, 3.0);
            set(iso, 7, 9.65);
        }
        set(2, 3, 1.25);
        // region 0: the courtyard x 10..20, y 5..15; var entry 1 = ISO (track outside 1 / inside 2, via 6 / 6),
        // entry 2 = OTH2 (5), entry 3 = OTH tracks (4 / 3)
        let reg = vec![vec![(10.0, 5.0), (20.0, 5.0), (20.0, 15.0), (10.0, 15.0)]];
        let var = vec![[vec![0, 0], vec![0, 0]], [vec![1, 2], vec![6, 6]], [vec![5, 5], vec![5, 5]], [vec![4, 3], vec![4, 3]]];
        bd.iso = Some(Iso { n: g, tab, regs: vec![reg], var });
        bd.niv = vec![1, 3, 2];
    }
    bd
}

fn pad(bd: &mut Board, net: i32, x: f64, y: f64, grp: u16) {
    bd.add(Shape { net, geo: Geo::Rect(x - 0.5, y - 0.5, x + 0.5, y + 0.5), clr: 0.2, layers: 0b101, drill: 0.0, kind: Kind::Pad, owner: -1, alive: true, grp });
}

#[test]
fn pair_clearance_between_two_classes_blocks_a_track_the_net_clearance_allows() {
    // ISO track centre 1.5 mm from the edge of an OTH pad outside the region: the class clearance (0.2) allows it, the
    // pair rule (3.0) does not; 3.2 mm away it is free
    for with in [false, true] {
        let mut bd = board(with);
        pad(&mut bd, 1, 5.0, 3.0, 4);
        let pf = bd.pflags(0);
        let near = bd.track_fixed_code(0, 5.0 + 0.5 + 1.5, 3.0, 0.1, 0.2, pf, 0.25);
        let far = bd.track_fixed_code(0, 5.0 + 0.5 + 3.2, 3.0, 0.1, 0.2, pf, 0.25);
        assert_eq!(blocks(near, 0), with, "with iso {with}");
        assert!(!blocks(far, 0));
        // the OTH net itself keeps only its class clearance to its own pad's neighbourhood (same net: never blocked)
        assert!(!blocks(bd.track_fixed_code(0, 7.0, 3.0, 0.1, 0.2, bd.pflags(1), 0.25), 1));
    }
}

#[test]
fn region_relaxation_applies_only_when_both_items_touch_the_region() {
    // OTH pad inside the courtyard (group 3). An ISO track 1.5 mm from it: legal inside the region (1.25, the later
    // POE rule 'PoE isolation inside J1'), illegal when the track does not touch the region (3.0). A track piece
    // that touches the region with its copper only (centre 0.05 mm outside, half width 0.1) counts as inside.
    let mut bd = board(true);
    pad(&mut bd, 1, 12.0, 8.0, 3);
    let pf = bd.pflags(0);
    assert!(!blocks(bd.track_fixed_code(0, 12.0, 8.0 + 0.5 + 1.5, 0.1, 0.2, pf, 0.25), 0), "inside: 1.25 applies");
    assert!(!blocks(bd.track_fixed_code(0, 9.95, 8.0, 0.1, 0.2, pf, 0.25), 0), "copper touches the region");
    let mut bd = board(true);
    pad(&mut bd, 1, 12.0, 6.0, 3);
    // track centre at y 3.85 (outside the region, 1.5 mm from the pad at y 5.5..6.5 less the half width): 3.0 applies
    assert!(blocks(bd.track_fixed_code(0, 12.0, 6.0 - 0.5 - 1.5 - 0.1, 0.1, 0.2, pf, 0.25), 0), "outside: 3.0 applies");
    assert_eq!(bd.grp_at(1, false, (12.0, 3.85), (12.0, 3.85), 0.1), 1);
    assert_eq!(bd.grp_at(1, false, (12.0, 3.85), (12.0, 6.0), 0.1), 2, "a segment into the region is inside (KiCad: whole item)");
}

#[test]
fn routed_copper_gets_its_group_and_other_nets_keep_the_pair_value_from_it() {
    // a routed ISO track (soft, owner 0) inside the region; an OTH2 track 2 mm away conflicts (ISO-OTH2 3.0), with
    // the class clearance alone it does not; a via of OTH2 too
    for with in [false, true] {
        let mut bd = board(with);
        let id = bd.add(Shape { net: 0, geo: Geo::Seg(12.0, 10.0, 18.0, 10.0, 0.1), clr: 0.2, layers: 1, drill: 0.0, kind: Kind::Track, owner: 0, alive: true, grp: 0 });
        assert_eq!(bd.shapes[id].grp, if with { 2 } else { 0 });
        let k = bd.track_soft(2, 0, 15.0, 12.2, 0.1, 0.25, None);
        assert_eq!(k, with as i32, "track, with iso {with}");
        let v = bd.via_soft(2, 15.0, 12.5, 0.6, 0.3, 0.45, None);
        assert_eq!(v, with as i32, "via, with iso {with}");
    }
}

#[test]
fn via_keeps_the_pair_value_from_fixed_copper() {
    for with in [false, true] {
        let mut bd = board(with);
        pad(&mut bd, 1, 5.0, 15.0, 4);
        let code = bd.via_fixed_code(5.0 + 0.5 + 0.3 + 1.0, 15.0, 0.6, 0.3, 0.2, 0.45, true, bd.iv(0));
        assert_eq!(bd.via_code_blocks(code, 0, 6.8, 15.0, 0.6, 0.3, 0.45), with, "with iso {with}");
    }
}

#[test]
fn pair_hole_clearance_to_a_screw_hole() {
    // NPTH H1 (hole 3.2 mm, group 7): an ISO track keeps 9.65 mm from the hole edge (RELAY-4 'Mains to screw hole');
    // the board hole clearance (0.28) alone allows 2 mm
    for with in [false, true] {
        let mut bd = board(with);
        bd.add(Shape { net: -1, geo: Geo::Circ(25.0, 10.0, 1.6), clr: 0.28, layers: 0b111, drill: 3.2, kind: Kind::Pad, owner: -1, alive: true, grp: 7 });
        let pf = bd.pflags(0);
        // a no-net hole blocks every net within its clearance: 0.28 + 0.1 from the edge; 2 mm is outside
        assert_eq!(blocks(bd.track_fixed_code(0, 25.0 - 1.6 - 2.0, 10.0, 0.1, 0.2, pf, 0.25), 0), with);
        assert!(!blocks(bd.track_fixed_code(2, 25.0 - 1.6 - 2.0, 10.0, 0.1, 0.2, bd.pflags(2), 0.25), 2), "OTH2 has no hole rule");
    }
}

#[test]
fn memo_keys_differ_per_isolation_entry() {
    // two nets with the same width, clearance and plane flags but other isolation entries must not share a fixed-copper
    // memo (pflags carries the entry); without iso they do
    let bd = board(true);
    assert_ne!(bd.pflags(0), bd.pflags(1));
    let bd = board(false);
    assert_eq!(bd.pflags(0), bd.pflags(1));
}

#[test]
fn query_reach_covers_the_largest_pair_value() {
    let bd = board(true);
    assert!(bd.track_r(0.1, 0.25) >= 0.1 + 9.65);
    assert!(bd.via_r(0.6, 0.45) >= 0.3 + 9.65);
    let bd = board(false);
    assert!(bd.track_r(0.1, 0.25) < 1.0);
}

#[test]
fn parallel_copy_is_checked_and_written_on_both_layers() {
    // RELAY-4 mains nets (current-paths.json parallel): net ISO routes on F.Cu with a twin on B.Cu. A foreign pad on
    // B.Cu only blocks the F.Cu cell above it; add_copper writes the track on both layers
    let mut bd = board(false);
    bd.add(Shape { net: 1, geo: Geo::Rect(4.5, 4.5, 5.5, 5.5), clr: 0.2, layers: 0b100, drill: 0.0, kind: Kind::Pad, owner: -1, alive: true, grp: 0 });
    assert_eq!(bd.track_cost(0, 0, 5.0, 5.0, 0.1, 0.25, None), 0, "no twin: B.Cu copper does not block F.Cu");
    bd.twin = vec![2, -1, -1];
    assert_eq!(bd.track_cost(0, 0, 5.0, 5.0, 0.1, 0.25, None), -1, "twin: the B.Cu copy would hit the pad");
    let o = super::tests_v6::opts();
    let mut ctx = super::tests_v8::ctx_of(&mut bd, &o);
    add_copper(&mut ctx, 0, 0, &[(0, (10.0, 10.0), (15.0, 10.0), 0.5)], &[]);
    let t: Vec<u8> = ctx.bd.shapes.iter().filter(|s| s.net == 0 && s.kind == Kind::Track).map(|s| s.layers).collect();
    assert_eq!(t, vec![1, 4]);
}

#[test]
fn plane_fanout_via_stays_inside_the_plane_outline() {
    // POE-ETHERNET TP1.1: the In2 VDD_3V3 zone ends at y 126.5; a fan-out via outside it is no connection
    let mut bd = board(false);
    assert!(bd.in_plane(0, 25.0, 18.0), "no outline: no limit (older model)");
    bd.ppoly = vec![(0, vec![(0.0, 0.0), (30.0, 0.0), (30.0, 12.0), (0.0, 12.0)])];
    assert!(bd.in_plane(0, 5.0, 11.0));
    assert!(!bd.in_plane(0, 5.0, 12.4));
    assert!(bd.in_plane(1, 5.0, 12.4), "other nets keep no limit");
}

#[test]
fn ring_rule_area_keeps_its_hole_free() {
    // INPUT-4D2A BARRIER_BAND: a ring (outline 0..20 x 0..20, hole 4..16 x 4..16) that forbids tracks and vias. The
    // bbox model blocked the hole (the host island); the exact one blocks only the band
    let mut bd = board(false);
    let ring = Keep { r: (0.0, 0.0, 20.0, 20.0), tl: 0b101, via: true,
                      poly: vec![vec![(0.0, 0.0), (20.0, 0.0), (20.0, 20.0), (0.0, 20.0)]], holes: vec![vec![(4.0, 4.0), (16.0, 4.0), (16.0, 16.0), (4.0, 16.0)]], pl: 0 };
    bd.keep.push(ring);
    assert!(!bd.keep_hit(Some(0), 10.0, 10.0, 0.1), "inside the hole");
    assert!(bd.keep_hit(Some(0), 2.0, 10.0, 0.1), "on the band");
    assert!(bd.keep_hit(Some(0), 4.05, 10.0, 0.1), "copper reaches the band");
    assert!(bd.keep_hit(None, 2.0, 2.0, 0.3));
    assert!(!bd.keep_hit(Some(0), 25.0, 10.0, 0.1), "outside");
}

#[test]
fn partner_indexes_give_the_verdicts_of_one_wide_query() {
    // the main query keeps maxc and the partner index of the querying group adds the far items: the same fixed-copper
    // codes and soft counts as one query at the largest pair value, on a grid around fixed and routed copper
    let build = |part: bool| {
        let mut bd = board(true);
        if part {
            let i = bd.iso.clone().unwrap();
            bd.prad = (0..i.n).map(|g| i.tab[g * i.n..(g + 1) * i.n].iter().cloned().fold(0.0, f64::max)).collect();
            bd.pidx = (0..i.n).map(|_| (Index::with_bucket(-1.0, -1.0, 31.0, 21.0, 3, 2.0), Index::with_bucket(-1.0, -1.0, 31.0, 21.0, 3, 2.0))).collect();
        }
        pad(&mut bd, 1, 12.0, 8.0, 3);
        pad(&mut bd, 1, 5.0, 3.0, 4);
        bd.add(Shape { net: -1, geo: Geo::Circ(25.0, 10.0, 1.6), clr: 0.28, layers: 0b111, drill: 3.2, kind: Kind::Pad, owner: -1, alive: true, grp: 7 });
        bd.add(Shape { net: 2, geo: Geo::Seg(2.0, 15.0, 28.0, 15.0, 0.1), clr: 0.2, layers: 1, drill: 0.0, kind: Kind::Track, owner: 2, alive: true, grp: 0 });
        bd
    };
    let (a, b) = (build(false), build(true));
    assert!(b.track_r(0.1, 0.25) < a.track_r(0.1, 0.25));
    for j in 0..40 {
        for i in 0..60 {
            let (x, y) = (0.5 + i as f64 * 0.49, 0.5 + j as f64 * 0.49);
            for net in 0..3 {
                assert_eq!(a.track_fixed_code(0, x, y, 0.1, 0.2, a.pflags(net), 0.25), b.track_fixed_code(0, x, y, 0.1, 0.2, b.pflags(net), 0.25), "{x} {y} {net}");
                assert_eq!(a.track_soft(net, 0, x, y, 0.1, 0.25, None), b.track_soft(net, 0, x, y, 0.1, 0.25, None));
                assert_eq!(a.via_cost(net, x, y, 0.6, 0.3, 0.45, None), b.via_cost(net, x, y, 0.6, 0.3, 0.45, None), "via {x} {y} {net}");
            }
        }
    }
}

#[test]
fn no_layer_change_when_no_return_can_keep_the_pair_value() {
    // ISO via vs a return via of the ground OTH2 (entry 2): pair 3.0 > the 1.0 mm return radius: no layer change
    let mut bd = board(true);
    bd.gnd = 2;
    let o = super::tests_v6::opts();
    let mut ctx = super::tests_v8::ctx_of(&mut bd, &o);
    assert!(!ctx.ret_reachable(0));
    assert!(!ctx.via_site_ok(0, 100, 100));
    assert!(ctx.ret_reachable(1), "OTH pair value with OTH2 is 0");
    let mut bd = board(false);
    bd.gnd = 2;
    let mut ctx = super::tests_v8::ctx_of(&mut bd, &o);
    assert!(ctx.ret_reachable(0));
}

#[test]
fn field_net_returns_on_its_own_ground() {
    // INPUT-4D2A: gnd = GND (host), other ground ISO_0V (field). ISO (field) vias keep 3.0 from the host ground OTH2
    // (entry 2) but none from OTH (entry 3): the return ground of ISO is OTH, and a layer change is possible again
    let mut bd = board(true);
    if let Some(i) = bd.iso.as_mut() {
        for (a, b) in [(6, 4), (6, 3)] {
            i.tab[a * i.n + b] = 0.0;
            i.tab[b * i.n + a] = 0.0;
        }
    }
    bd.gnd = 2;
    bd.gnds = vec![1];
    bd.rgn = vec![1, 1, 2];
    assert_eq!(bd.rg(0), 1);
    assert!(bd.is_ret_net(1) && bd.is_ret_net(2) && !bd.is_ret_net(0));
    let o = super::tests_v6::opts();
    let mut ctx = super::tests_v8::ctx_of(&mut bd, &o);
    ctx.rcache = vec![0; ctx.gr.nx * ctx.gr.ny * 2];
    assert!(ctx.ret_reachable(0), "field net with the field ground");
}

#[test]
fn plane_rule_net_keeps_out_of_a_pour_keepout_void() {
    // INPUT-4D2A H1_KEEPOUT: no pour on any layer around a screw hole: the In1 plane has a void there. A net under the
    // plane rule (si_planes checked, on a layer with an adjacent plane) keeps out; other nets may pass
    let mut bd = board(false);
    bd.adj = 0b101;
    bd.nets[0].pref = true;
    bd.keep.push(Keep { r: (10.0, 10.0, 14.0, 14.0), tl: 0, via: false, poly: Vec::new(), holes: Vec::new(), pl: 0b111 });
    assert_eq!(bd.track_fixed_code(0, 12.0, 12.0, 0.1, 0.2, bd.pflags(0), 0.25), MULTI);
    assert_eq!(bd.track_fixed_code(0, 12.0, 12.0, 0.1, 0.2, bd.pflags(1), 0.25), FREE);
    // a pour keepout on the outer layers only makes no plane void
    bd.keep[0].pl = 0b101;
    assert_eq!(bd.track_fixed_code(0, 12.0, 12.0, 0.1, 0.2, bd.pflags(0), 0.25), FREE);
}
