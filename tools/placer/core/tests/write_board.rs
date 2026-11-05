//! The board writer on a small routed board: what it moves, what it rips and what it keeps, in the edited text. The KiCad save
//! after it is not part of a case.

mod common;

use common::board::{ANY_RULE, Box4, Fixture, Written, buck, locked, pt, rect_shape, rounded_row, rule_area, turned, unit_of, via};
use common::within;
use iotplace::evaluator::Evaluator;
use iotplace::geom::Rect;
use iotplace::kicad::doc::{Board, Copper, CopperItem, Footprint, Pad, Polygon, Pt};
use iotplace::kicad::hit::{collides_with_polygon, pad_hit};
use iotplace::model::Model;
use iotplace::params::Params;
use iotplace::problem::Problem;
use iotplace::read::options::{EdgeAnchor, Options};
use iotplace::read::out::ProblemOut;
use iotplace::read::parts::fp_rect;
use iotplace::write::WriteOptions;
use iotroute::kicad::board::RuleArea;
use std::collections::{BTreeSet, HashSet};

fn plain() -> Options {
    Options::default()
}

fn write(fx: &Fixture, pr: &ProblemOut, pose: &[(f64, f64, u8)]) -> (Written, iotplace::write::Report) {
    fx.write(pr, pose, WriteOptions::default())
}

fn rect_of(r: Rect) -> Box4 {
    (r.x0, r.y0, r.x1, r.y1)
}

/// U1 shifted by (dx, dy), other units where they are.
fn shifted_u1(fx: &Fixture, pr: &ProblemOut, dx: f64, dy: f64, turn: u8) -> Vec<(f64, f64, u8)> {
    let mut pose = fx.pose(pr);
    let i = unit_of(pr, "U1");
    pose[i] = (pose[i].0 + dx, pose[i].1 + dy, turn);
    pose
}

fn free_u1(fx: &Fixture) -> Options {
    Options { free_box: Some(fp_rect(fx.fp("U1"))), ..plain() }
}

fn item<'a>(board: &'a Board, id: &str) -> &'a Copper {
    board.copper.iter().find(|c| c.id() == id).unwrap()
}

fn lone_vias(board: &Board) -> HashSet<String> {
    let mut ends = HashSet::new();
    for c in board.copper.iter().filter(|c| matches!(c, Copper::Track(_))) {
        c.ends().iter().for_each(|p| {
            ends.insert((c.net().to_string(), p.x, p.y));
        });
    }
    let lone = board.copper.iter().filter(|c| matches!(c, Copper::Via(_)) && !ends.contains(&(c.net().to_string(), c.ends()[0].x, c.ends()[0].y)));
    lone.map(|c| c.id().to_string()).collect()
}

fn key(item: &Copper) -> Vec<f64> {
    let ends = item.ends();
    let (a, b) = (ends[0], *ends.last().unwrap());
    rounded_row(&[a.x as f64 / 1e6, a.y as f64 / 1e6, b.x as f64 / 1e6, b.y as f64 / 1e6], 3)
}

fn shifted_pad(p: &Pad, dx: f64, dy: f64) -> Pad {
    let shift = pt(dx, dy);
    let moved = |ring: &Vec<Pt>| ring.iter().map(|q| *q + shift).collect::<Vec<_>>();
    let mut out = p.clone();
    out.position = p.position + shift;
    out.polygons = p.polygons.iter().map(|(l, g)| (l.clone(), Polygon { outline: moved(&g.outline), holes: g.holes.iter().map(moved).collect() })).collect();
    out
}

#[test]
fn a_locked_track_stays_when_the_movable_units_land_on_it() {
    let mut board = buck();
    let t = board.copper.iter_mut().find(|c| c.id() == "vin-d").unwrap();
    locked(t);
    let fx = Fixture::new(board);
    let pr = fx.read(&plain());
    assert_eq!(pr.board.fixed_copper.len(), 1);
    let ends = item(&fx.board, "vin-d").ends();
    let (end_x, end_y) = (ends[0].x as f64 / 1e6, ends[0].y as f64 / 1e6);
    // Its parts stay: the route is fixed.
    let on: BTreeSet<&str> = fx.board.pads().filter(|(_, p)| ends.iter().any(|e| pad_hit(p, *e))).map(|(f, _)| f.reference.as_str()).collect();
    assert_eq!(on, BTreeSet::from(["C1", "U1"]));
    on.iter().for_each(|r| assert!(common::board::is_fixed(&pr, r), "{r}"));
    let mut pose = fx.pose(&pr);
    for (place, u) in pose.iter_mut().zip(&pr.units) {
        if !u.fixed {
            *place = (end_x, end_y, 0); // every movable unit moves onto the track
        }
    }
    let (out, _) = write(&fx, &pr, &pose);
    assert!(out.copper().contains("vin-d"));
}

#[test]
fn kept_copper_is_the_copper_the_writer_keeps() {
    let fx = Fixture::new(buck());
    let lone = lone_vias(&fx.board);
    assert_eq!(lone, HashSet::from(["gnd-lone".to_string()]));
    let none = fx.read(&Options { free_box: Some(Rect::new(0.0, 0.0, 1.0, 1.0)), ..plain() }); // nothing movable: all copper stays
    assert_eq!(none.board.copper.len(), fx.board.copper.len() - lone.len(), "lone stitching vias are no obstacle");
    assert!(none.board.copper.iter().any(|c| c.0 == "via"));
    let pr = fx.read(&free_u1(&fx));
    assert_eq!(pr.units.iter().filter(|u| !u.fixed).map(|u| u.refs.clone()).collect::<Vec<_>>(), [["U1".to_string()]], "only U1 moves");
    let (out, report) = write(&fx, &pr, &shifted_u1(&fx, &pr, 3.0, 0.0, 0));
    let left = out.copper();
    let kept: BTreeSet<Vec<String>> = fx.board.copper.iter().filter(|c| left.contains(c.id()) && !lone.contains(c.id())).map(|c| key(c).iter().map(|v| v.to_string()).collect()).collect();
    let counted: BTreeSet<Vec<String>> = pr.board.copper.iter().map(|c| rounded_row(&[c.1, c.2, c.3, c.4], 3).iter().map(|v| v.to_string()).collect()).collect();
    assert_eq!(kept.difference(&counted).count(), 0, "the writer keeps nothing the cost did not count");
    assert!(counted.difference(&kept).count() <= report.removed_collisions);
}

#[test]
fn a_lone_via_under_a_movable_part_moves_with_it_not_kept() {
    // A stitching via under the U1 body (on no pad, no track) belongs to U1: not an obstacle, removed on a move.
    let mut board = buck();
    board.copper.push(via("under", "GND", (130.0, 120.0)));
    let fx = Fixture::new(board);
    assert!(!fx.board.pads().any(|(_, p)| pad_hit(p, pt(130.0, 120.0))));
    let pr = fx.read(&free_u1(&fx));
    assert!(!pr.board.copper.iter().any(|c| c.0 == "via" && (c.1 - 130.0).abs() <= 1e-3 && (c.2 - 120.0).abs() <= 1e-3));
    let (out, _) = write(&fx, &pr, &shifted_u1(&fx, &pr, 3.0, 0.0, 0));
    assert!(!out.copper().contains("under"));
    assert!(out.copper().contains("gnd-lone"), "a lone via elsewhere stays");
}

fn outline_box(pr: &ProblemOut) -> Box4 {
    let xs = pr.board.outline.iter().map(|p| p[0]);
    let ys = pr.board.outline.iter().map(|p| p[1]);
    (xs.clone().fold(f64::MAX, f64::min), ys.clone().fold(f64::MAX, f64::min), xs.fold(f64::MIN, f64::max), ys.fold(f64::MIN, f64::max))
}

#[test]
fn write_on_a_virtual_board_replaces_the_outline_by_the_scaled_box() {
    let fx = Fixture::new(buck());
    let pr = fx.read(&plain());
    let (x0, y0, x1, y1) = outline_box(&pr);
    let (out, _) = fx.write(&pr, &fx.pose(&pr), WriteOptions { outline_scale: 1.5, retain_copper: false });
    let rects = out.on_layer("gr_rect", "Edge.Cuts");
    assert_eq!(rects.len(), 1);
    let id = rects[0].value("uuid").unwrap();
    let [(ax, ay), (bx, by)] = out.ends(id);
    let (cx, cy, w, h) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0, (x1 - x0) * 1.5, (y1 - y0) * 1.5);
    for (got, want) in [(ax, cx - w / 2.0), (ay, cy - h / 2.0), (bx, cx + w / 2.0), (by, cy + h / 2.0)] {
        within(got, want, 0.01);
    }
}

fn ring_box(ring: &[(f64, f64)]) -> Box4 {
    let xs = ring.iter().map(|p| p.0);
    let ys = ring.iter().map(|p| p.1);
    (xs.clone().fold(f64::MAX, f64::min), ys.clone().fold(f64::MAX, f64::min), xs.fold(f64::MIN, f64::max), ys.fold(f64::MIN, f64::max))
}

#[test]
fn write_on_a_virtual_board_grows_the_full_board_zones_with_the_outline() {
    let fx = Fixture::new(buck());
    let pr = fx.read(&plain());
    let (x0, y0, x1, y1) = outline_box(&pr);
    let (out, _) = fx.write(&pr, &fx.pose(&pr), WriteOptions { outline_scale: 1.5, retain_copper: false });
    let (w, h) = ((x1 - x0) * 1.5, (y1 - y0) * 1.5);
    for id in ["zone-GND_F", "zone-GND_B"] {
        let b = ring_box(&out.zone_ring(id));
        assert!(b.2 - b.0 > w - 1.0, "{id}");
        assert!(b.3 - b.1 > h - 1.0, "{id}");
        assert!(out.item(id).child("filled_polygon").is_none(), "the old fill of {id} is dropped");
    }
    let local = ring_box(&out.zone_ring("zone-LOCAL_F"));
    assert_eq!(local, (145.0, 105.0, 155.0, 112.0), "a local zone (not the whole board) keeps its outline");
}

#[test]
fn write_moves_and_rotates_like_the_model() {
    let fx = Fixture::new(buck());
    let pr = fx.read(&plain());
    let i = unit_of(&pr, "U1");
    let problem = fx.problem(&pr);
    let (x, y, _) = problem.units[i].place();
    let pose = shifted_u1(&fx, &pr, 3.0, -2.0, 1);
    let (out, report) = write(&fx, &pr, &pose);
    assert_eq!(report.moved_units, 1);
    let u1 = fx.fp("U1");
    let (ax, ay, angle) = out.at(&u1.id);
    assert_eq!(angle, 90.0);
    // The courtyard, from the written footprint, is where the model turns the unit rect.
    let local = |p: Pt| ((p.x - u1.position.x) as f64 / 1e6, (p.y - u1.position.y) as f64 / 1e6);
    let corners: Vec<(f64, f64)> = u1.courtyard_front[0].outline.iter().map(|q| {
        let (lx, ly) = turned(local(*q), angle);
        (ax + lx, ay + ly)
    }).collect();
    let got = ring_box(&corners);
    let r = pr.units[i].rects[0];
    let want = Rect::new(r[0], r[1], r[2], r[3]).turned(1).shifted(x + 3.0, y - 2.0);
    for (a, b) in [(got.0, want.x0), (got.1, want.y0), (got.2, want.x1), (got.3, want.y1)] {
        within(a, b, 1e-3);
    }
    // Every pin of U1 lands where the model puts it.
    let mut pins = 0;
    for pin in pr.nets.iter().flat_map(|n| n.pins.iter().filter(|q| q.0 == i).map(move |q| (n, q))) {
        let (net, q) = pin;
        let want = Rect::new(q.1, q.2, q.3, q.4).turned(1).shifted(x + 3.0, y - 2.0);
        let at: Vec<(f64, f64)> = u1.pads.iter().filter(|p| p.net == net.name).map(|p| out.pad_at(&u1.id, &p.number)).collect();
        let got = ring_box(&at);
        for (a, b) in [(got.0, want.x0), (got.1, want.y0), (got.2, want.x1), (got.3, want.y1)] {
            within(a, b, 1e-3);
        }
        pins += 1;
    }
    assert_eq!(pins, 5, "/VIN, /EN, /FB, /SW and /BST: GND is skipped");
    u1.pads.iter().for_each(|p| assert_eq!(out.pad_angle(&u1.id, &p.number), 90.0, "a file stores a pad angle absolute"));
    // Other units do not move.
    for f in fx.board.footprints.iter().filter(|f| f.reference != "U1") {
        let (fx_, fy, fa) = out.at(&f.id);
        assert_eq!((fx_, fy, fa), (f.position.x as f64 / 1e6, f.position.y as f64 / 1e6, 0.0));
    }
}

#[test]
fn write_removes_only_copper_at_moved_pads() {
    let fx = Fixture::new(buck());
    let pr = fx.read(&plain());
    let u1_nets: HashSet<&str> = fx.fp("U1").pads.iter().map(|p| p.net.as_str()).collect();
    let (out, report) = write(&fx, &pr, &shifted_u1(&fx, &pr, 3.0, 0.0, 0));
    assert!(report.removed_tracks > 0);
    let left = out.copper();
    let other = |c: &&Copper| !u1_nets.contains(c.net());
    let before: BTreeSet<&str> = fx.board.copper.iter().filter(other).map(|c| c.id()).collect();
    let after: BTreeSet<&str> = fx.board.copper.iter().filter(|c| left.contains(c.id())).filter(other).map(|c| c.id()).collect();
    assert_eq!(before, after);
    let moved: Vec<Pad> = fx.fp("U1").pads.iter().map(|p| shifted_pad(p, 3.0, 0.0)).collect();
    for c in fx.board.copper.iter().filter(|c| left.contains(c.id())) {
        for pad in moved.iter().filter(|p| p.net == c.net()) {
            assert!(!c.ends().iter().any(|e| pad_hit(pad, *e)), "{} left at a moved pad", c.id());
        }
    }
}

#[test]
fn write_removes_other_copper_under_moved_pads() {
    let fx = Fixture::new(buck());
    let pr = fx.read(&plain());
    let i = unit_of(&pr, "U1");
    let u1_nets: HashSet<&str> = fx.fp("U1").pads.iter().map(|p| p.net.as_str()).collect();
    let long = |c: &&Copper| matches!(c, Copper::Track(t) if t.layer == "F.Cu" && !u1_nets.contains(t.net.as_str()) && ((t.end.x - t.start.x).abs() + (t.end.y - t.start.y).abs()) > 2_000_000);
    let t = fx.board.copper.iter().find(long).unwrap();
    let ends = t.ends();
    let mid = ((ends[0].x + ends[1].x) as f64 / 2e6, (ends[0].y + ends[1].y) as f64 / 2e6);
    let u = &pr.units[i];
    let (dx, dy) = (mid.0 - (u.x + u.pads[0][0]), mid.1 - (u.y + u.pads[0][1])); // put U1 pad 0 on the track
    let mut pose = fx.pose(&pr);
    pose[i] = (u.x + dx, u.y + dy, 0);
    let (out, report) = write(&fx, &pr, &pose);
    assert!(report.removed_collisions > 0);
    assert!(!out.copper().contains(t.id()));
    let left = out.copper();
    let moved: Vec<Pad> = fx.fp("U1").pads.iter().map(|p| shifted_pad(p, dx, dy)).collect();
    for c in fx.board.copper.iter().filter(|c| left.contains(c.id())) {
        for pad in moved.iter().filter(|p| p.net != c.net()) {
            for (layer, shape) in &pad.polygons {
                if c.layers().contains(&layer.as_str()) {
                    assert!(!collides_with_polygon(c, shape, 0), "copper of {} under U1", c.net());
                }
            }
        }
    }
}

#[test]
fn a_moved_pad_with_no_polygons_clears_the_copper_under_it() {
    // The document has no polygons for a pad that shares its uuid: its copper says where it is, as for pad_hit.
    let mut board = buck();
    let u1 = board.footprints.iter_mut().find(|f| f.reference == "U1").unwrap();
    u1.pads.iter_mut().for_each(|p| p.polygons.clear());
    let fx = Fixture::new(board);
    let pr = fx.read(&plain());
    let i = unit_of(&pr, "U1");
    let u = &pr.units[i];
    let mut pose = fx.pose(&pr);
    pose[i] = (105.0 - u.pads[0][0], 128.0 - u.pads[0][1], 0); // pad 1 on /AUX
    let (out, report) = write(&fx, &pr, &pose);
    assert!(report.removed_collisions > 0);
    assert!(!out.copper().contains("aux-a"));
}

#[test]
fn a_moved_pad_clears_an_arc_along_its_bend() {
    // PCB_ARC::GetEffectiveShape follows the arc: this pad lands on the bend, 3 mm off the chord.
    let mut board = buck();
    let Copper::Track(mut arc) = common::board::track("arc", "/ARC", "F.Cu", (110.0, 124.0), (110.0, 128.0)) else { unreachable!() };
    arc.mid = Some(pt(113.0, 126.0));
    board.copper.push(Copper::Track(arc));
    board.nets.insert("/ARC".to_string(), "Default".to_string());
    let fx = Fixture::new(board);
    let pr = fx.read(&plain());
    let i = unit_of(&pr, "U1");
    let u = &pr.units[i];
    let mut pose = fx.pose(&pr);
    pose[i] = (113.0 - u.pads[0][0], 126.0 - u.pads[0][1], 0);
    let (out, report) = write(&fx, &pr, &pose);
    assert!(report.removed_collisions > 0);
    assert!(!out.copper().contains("arc"));
}

/// The nearest part of U1 that is not a connector.
fn nearest_to_u1(board: &Board) -> &Footprint {
    let ic = fp_rect(board.footprints.iter().find(|f| f.reference == "U1").unwrap());
    let gap = |f: &&Footprint| {
        let c = fp_rect(f);
        (ic.x0 - c.x1).max(c.x0 - ic.x1).max(ic.y0 - c.y1).max(c.y0 - ic.y1)
    };
    let others = board.footprints.iter().filter(|f| !["U1", "J1", "J2"].contains(&f.reference.as_str()));
    others.min_by(|a, b| gap(a).total_cmp(&gap(b))).unwrap()
}

/// A User.1 border around U1 and its nearest part: (U1 courtyard, border box, the other part).
fn block_u1(board: &mut Board) -> (Box4, Box4, String) {
    let other = nearest_to_u1(board);
    let (ic, oc) = (fp_rect(board.footprints.iter().find(|f| f.reference == "U1").unwrap()), fp_rect(other));
    let area = (ic.x0.min(oc.x0) - 0.5, ic.y0.min(oc.y0) - 0.5, ic.x1.max(oc.x1) + 0.5, ic.y1.max(oc.y1) + 0.5);
    let name = other.reference.clone();
    board.graphics.push(rect_shape("border", "User.1", area));
    (rect_of(ic), area, name)
}

#[test]
fn edge_anchor_and_block_rule_area_clipped_at_the_anchor_line_move_with_the_block() {
    let mut board = buck();
    let (ic, area, _) = block_u1(&mut board);
    board.zones.push(rule_area("ANT", &["F.Cu"], (ic.0 - 3.0, ic.3 - 1.0, ic.2 + 3.0, ic.3 + 5.0), RuleArea { tracks: true, ..ANY_RULE })); // beyond the S side
    let fx = Fixture::new(board);
    // A rule area goes with a unit only when named: a board-wide area (a mains domain) that meets a block stays.
    let loose = fx.read(&plain());
    assert!(loose.units[unit_of(&loose, "U1")].zones.is_empty());
    let edges = vec![EdgeAnchor { reference: "U1".to_string(), sides: "LR".to_string(), side: 'S', exact: None }];
    let pr = fx.read(&Options { edges, zone_refs: [("ANT".to_string(), "U1".to_string())].into(), ..plain() });
    let i = unit_of(&pr, "U1");
    let u = &pr.units[i];
    let edge = u.edge.as_ref().unwrap();
    assert_eq!(edge.sides, "LR");
    // In a block the anchor is on the border (block copper ends there), in line with the part side.
    within(edge.at[0], (ic.0 + ic.2) / 2.0 - u.x, 0.01);
    within(edge.at[1], area.3 - u.y, 0.01);
    assert_eq!(u.zones, ["zone-ANT"]);
    assert_eq!(u.ko.iter().map(|k| u.rects[*k][4]).collect::<Vec<_>>(), [0.0], "the area rect is a keepout rect");
    let want = rounded_row(&[ic.0 - 3.0 - u.x, ic.3 - 1.0 - u.y, ic.2 + 3.0 - u.x, area.3 - u.y, 0.0], 2);
    assert!(u.rects.iter().any(|r| rounded_row(r, 2) == want));
    let mut pose = fx.pose(&pr);
    pose[i] = (pose[i].0 - 4.0, pose[i].1 + 1.0, 0);
    let (out, _) = write(&fx, &pr, &pose);
    let b = ring_box(&out.zone_ring("zone-ANT"));
    within(b.0, ic.0 - 3.0 - 4.0, 0.01);
    within(b.1, ic.3 - 1.0 + 1.0, 0.01);
}

#[test]
fn a_board_slot_inside_a_block_border_moves_with_the_block_as_a_keepout_rect() {
    // RELAY-4: each relay block has an Edge.Cuts slot under the relay (creepage); it is part of the block.
    let mut board = buck();
    let (ic, _, _) = block_u1(&mut board);
    let slot = (ic.0 + 0.5, ic.1 + 0.5, ic.0 + 1.5, ic.1 + 2.5);
    board.graphics.push(rect_shape("slot", "Edge.Cuts", slot));
    board.outlines[0].holes.push(vec![pt(slot.0, slot.1), pt(slot.2, slot.1), pt(slot.2, slot.3), pt(slot.0, slot.3)]);
    let fx = Fixture::new(board);
    let pr = fx.read(&plain());
    assert!(!pr.board.keepouts.iter().any(|k| (k.iter().map(|q| q[0]).fold(f64::MAX, f64::min) - slot.0).abs() < 0.01));
    let i = unit_of(&pr, "U1");
    let u = &pr.units[i];
    assert_eq!(u.cuts, ["slot"]);
    let want = rounded_row(&[slot.0 - u.x, slot.1 - u.y, slot.2 - u.x, slot.3 - u.y, 0.0], 2);
    assert!(u.ko.iter().any(|k| rounded_row(&u.rects[*k], 2) == want));
    // Its own slot adds no penalty.
    let mut plainer = serde_json::to_value(&pr).unwrap();
    plainer["units"][i]["rects"].as_array_mut().unwrap().pop();
    plainer["units"][i].as_object_mut().unwrap().remove("ko");
    let penalty = |problem: &Problem| {
        let params = Params::default();
        let model = Model::new(problem, &params).unwrap();
        Evaluator::new(&model, &params, &problem.initial_pose()).legal_penalty(i)
    };
    let without: Problem = serde_json::from_value(plainer).unwrap();
    within(penalty(&fx.problem(&pr)), penalty(&without), 1e-7);
    let mut pose = fx.pose(&pr);
    pose[i] = (pose[i].0 - 4.0, pose[i].1 + 1.0, 0);
    let (out, _) = write(&fx, &pr, &pose);
    let [(x, y), _] = out.ends("slot");
    within(x, slot.0 - 4.0, 0.05);
    within(y, slot.1 + 1.0, 0.05);
}

#[test]
fn block_border_moves_with_its_parts() {
    // A border on User.1 around U1 and its nearest part: one rigid unit (with any other part inside).
    let mut board = buck();
    let (_, area, other) = block_u1(&mut board);
    let fx = Fixture::new(board);
    let pr = fx.read(&plain());
    let i = unit_of(&pr, "U1");
    let u = &pr.units[i];
    assert!(u.refs.contains(&other));
    assert_eq!(u.borders, ["border"]);
    // The border box is a rect of class 0: block copper inside it stays clear of other parts.
    let want = rounded_row(&[area.0 - u.x, area.1 - u.y, area.2 - u.x, area.3 - u.y, 0.0], 3);
    assert!(u.rects.iter().any(|r| rounded_row(r, 3) == want));
    let mut pose = fx.pose(&pr);
    pose[i] = (pose[i].0 - 4.0, pose[i].1 + 1.0, 2);
    let (out, _) = write(&fx, &pr, &pose);
    let [(ax, ay), (bx, by)] = out.ends("border");
    within((ax + bx) / 2.0, (area.0 + area.2) / 2.0 - 4.0, 0.01);
    within((ay + by) / 2.0, (area.1 + area.3) / 2.0 + 1.0, 0.01);
    // The two parts keep their relative layout, turned 180 degrees.
    let (f0, g0) = (fx.fp("U1"), fx.fp(&other));
    let (fx1, fy1, fa) = out.at(&f0.id);
    let (gx1, gy1, _) = out.at(&g0.id);
    assert_eq!(fa, 180.0);
    let d0 = ((g0.position.x - f0.position.x) as f64 / 1e6, (g0.position.y - f0.position.y) as f64 / 1e6);
    within(gx1 - fx1, -d0.0, 2e-6);
    within(gy1 - fy1, -d0.1, 2e-6);
}
