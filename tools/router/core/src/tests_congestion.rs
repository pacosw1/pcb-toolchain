//! Unit checks of the congestion map (congestion.rs, cargo test --release).
use super::*;
use super::congestion::*;
use super::tests_v6::{opts, pad};
use super::tests_v9::{board, ctx_of};

fn tr(net: i32, a: (f64, f64), b: (f64, f64)) -> Shape {
    Shape { net, geo: Geo::Seg(a.0, a.1, b.0, b.1, 0.075), clr: 0.15, layers: 1, drill: 0.0, kind: Kind::Track, owner: net, alive: true, grp: 0 }
}

#[test]
fn default_profile_is_the_most_common_signal_class_and_mst_is_prim() {
    let mut bd = board();
    let mut w = bd.nets[0].clone();
    w.name = "PWR".into();
    w.width = 0.5;
    w.power = true;
    bd.nets.push(w);
    assert_eq!(default_profile(&bd), (0.15, 0.15), "power and plane nets do not count");
    assert!((mst(&[(0.0, 0.0), (3.0, 0.0), (3.0, 4.0), (10.0, 0.0)]) - (3.0 + 4.0 + 7.0)).abs() < 1e-9);
    assert_eq!(mst(&[(1.0, 1.0)]), 0.0);
}

/// One routed F.Cu track from x 2 to x 18 at y 5 (cells of 2 mm): the routed length per cell sums to the track length and
/// sits in the cells of row y 4..6; the occupied fraction is > 0 there and 0 far away; a pad lowers the free fraction of
/// its cell; the history of the grid cells is averaged per cell.
#[test]
fn cell_arrays_measure_length_room_occupancy_and_history() {
    let o = opts();
    let mut bd = board();
    bd.add(pad(0, 2.0, 5.0, 1));
    bd.add(pad(0, 18.0, 5.0, 1));
    bd.add(tr(0, (2.0, 5.0), (18.0, 5.0)));
    let mut ctx = ctx_of(&mut bd, &o);
    // history 1.0 on every F.Cu grid cell of x in [10, 12), y in [0, 2)
    for j in 0..ctx.gr.ny {
        for i in 0..ctx.gr.nx {
            let (x, y) = ctx.gr.xy(i, j);
            if (10.0..12.0 - 1e-9).contains(&x) && y < 2.0 - 1e-9 {
                ctx.gr.hist[j * ctx.gr.nx + i] = 1.0;
            }
        }
    }
    let (nx, ny, layers, vias, _) = cells(&ctx, 2.0);
    assert_eq!((nx, ny), (11, 6));
    let f = &layers[0];
    let tot: f64 = f.len.iter().sum();
    assert!((tot - 16.0).abs() < 0.01, "length per cell sums to the track: {tot}");
    let row = 5.0f64 / 2.0;
    assert!(f.len.iter().enumerate().all(|(c, &l)| l == 0.0 || c / nx == row as usize), "only row 2 (y 4..6) has length");
    assert!(f.occ[2 * nx + 5] > 0.0 && f.occ[0] == 0.0);
    assert!(f.free[3 * nx + 5] == 1.0 && f.free[2 * nx + 1] < 1.0, "the pad at (2, 5) takes room: {} vs {}", f.free[2 * nx + 1], f.free[3 * nx + 5]);
    assert!((f.cap[3 * nx + 5] - f.free[3 * nx + 5] * 4.0 / 0.3).abs() < 0.01);
    assert!((f.hist[5] - 1.0).abs() < 1e-9 && f.hist[4] == 0.0 && layers[1].hist[5] == 0.0, "F.Cu cell (5, 0) mean 1.0");
    assert_eq!(vias.iter().sum::<u32>(), 0);
}

/// Net rows: a net routed around another net's copper has a detour (objective now - objective alone > 0), the free route
/// is the straight one, and the routed copper is unchanged after the map (the map never changes the result).
#[test]
fn free_route_gives_the_detour_and_leaves_the_copper_unchanged() {
    let o = opts();
    let mut bd = board();
    bd.add(pad(0, 2.0, 5.0, 1));
    bd.add(pad(0, 18.0, 5.0, 1));
    bd.add(pad(1, 10.0, 0.6, 1));
    bd.add(pad(1, 10.0, 9.4, 1));
    // A goes around over the top: (2,5) -> (2,9.6)? keep it legal: A detours down to y 2 and B runs from y 3 to 9.4
    for (a, b) in [((2.0, 5.0), (5.0, 2.0)), ((5.0, 2.0), (15.0, 2.0)), ((15.0, 2.0), (18.0, 5.0))] {
        bd.add(tr(0, a, b));
    }
    bd.add(tr(1, (10.0, 9.4), (10.0, 3.0)));
    let mut ctx = ctx_of(&mut bd, &o);
    let before: Vec<(i32, Geo)> = ctx.bd.shapes.iter().filter(|s| s.alive).map(|s| (s.owner, s.geo)).collect();
    let rows = net_rows(&mut ctx, &[false, false, false], true);
    let after: Vec<(i32, Geo)> = ctx.bd.shapes.iter().filter(|s| s.alive).map(|s| (s.owner, s.geo)).collect();
    assert_eq!(format!("{before:?}"), format!("{after:?}"));
    let a = rows.iter().find(|r| r.name == "A").unwrap();
    assert!((a.mst - 16.0).abs() < 1e-9);
    assert!(a.len > 18.0, "routed with the detour: {}", a.len);
    let fl = a.free_len.unwrap();
    assert!(fl < 16.0 + 0.1, "alone it goes straight: {fl}");
    assert!(a.detour.unwrap() > 2.0, "detour {:?}", a.detour);
    // no free route when it is off or the net failed
    let rows = net_rows(&mut ctx, &[true, false, false], true);
    assert!(rows.iter().find(|r| r.name == "A").unwrap().free_cost.is_none());
    let rows = net_rows(&mut ctx, &[false, false, false], false);
    assert!(rows.iter().all(|r| r.detour.is_none()));
}
