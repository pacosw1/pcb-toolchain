//! Rules that attach to units after they exist: edge anchors, rule areas that move with a part, boxes, near rules, block slots.

use super::grouping::bbox_of;
use super::options::{EdgeAnchor, Near, Options};
use super::out::{CuRow, Edge, Unit, Xy};
use super::parts::fp_rect;
use crate::dru::fnmatch;
use crate::geom::Rect;
use crate::kicad::doc::{Board, Footprint, Geometry, Graphic, Pt, Zone, mm};
use std::collections::{BTreeSet, HashMap};

/// mm: an Edge.Cuts shape box includes its line width.
const CUT_TOLERANCE: f64 = 0.2;

pub struct Index<'a> {
    pub by_ref: &'a HashMap<&'a str, &'a Footprint>,
    /// Part reference to unit index.
    pub unit_of: &'a HashMap<String, usize>,
}

fn unit_box(u: &Unit) -> Option<Rect> {
    u.boxed.map(|b| Rect::new(b[0], b[1], b[2], b[3]))
}

fn anchor(u: &mut Unit, a: &EdgeAnchor, fp: &Footprint) -> (char, f64, f64) {
    let rc = fp_rect(fp);
    let (mx, my) = rc.centre();
    // Block copper ends at the border: the anchor goes onto the border, in line with the part.
    let edge = unit_box(u).unwrap_or(rc);
    let (ax, ay) = match a.side {
        'N' => (mx, edge.y0),
        'S' => (mx, edge.y1),
        'W' => (edge.x0, my),
        _ => (edge.x1, my),
    };
    let (inset, tol) = a.exact.map_or((None, 0.5), |(inset, tol)| (Some(inset), tol));
    u.edge = Some(Edge { at: [ax - u.x, ay - u.y], sides: a.sides.clone(), tol, inset });
    (a.side, ax, ay)
}

/// A rule area that moves with a unit is a keepout rect, cut at the anchor line when the unit has one: the part beyond lies off
/// the board.
fn attach_zone(u: &mut Unit, zone: &Zone, cut: Option<(char, f64, f64)>) {
    let Some(mut r) = zone.bbox() else { return };
    match cut {
        Some(('S', _, ay)) => r.y1 = r.y1.min(ay),
        Some(('N', _, ay)) => r.y0 = r.y0.max(ay),
        Some(('E', ax, _)) => r.x1 = r.x1.min(ax),
        Some((_, ax, _)) => r.x0 = r.x0.max(ax),
        None => {}
    }
    u.ko.push(u.rects.len());
    let row = u.local(r, 0.0);
    u.rects.push(row);
    u.zones.push(zone.id.clone());
    if zone.rule_area.is_some_and(|a| a.vias) {
        u.cu.push(CuRow(row[0], row[1], row[2], row[3], -1));
    }
}

/// Edge anchors, then rule areas named in `zone_refs`.
pub fn edges_and_zones(board: &Board, units: &mut [Unit], index: &Index, options: &Options) -> crate::Result<()> {
    let mut cuts: HashMap<usize, (char, f64, f64)> = HashMap::new();
    for a in &options.edges {
        let i = *index.unit_of.get(&a.reference).ok_or_else(|| format!("edge: no part {}", a.reference))?;
        let fp = index.by_ref[a.reference.as_str()];
        cuts.insert(i, anchor(&mut units[i], a, fp));
    }
    for zone in board.zones.iter().filter(|z| z.rule_area.is_some()) {
        let Some(reference) = options.zone_refs.get(&zone.name) else { continue };
        let i = *index.unit_of.get(reference).ok_or_else(|| format!("zone {}: no part {reference}", zone.name))?;
        attach_zone(&mut units[i], zone, cuts.get(&i).copied());
    }
    Ok(())
}

/// Each movable unit with a matching part keeps its courtyards in the box.
pub fn in_boxes(units: &mut [Unit], boxes: &[(String, [f64; 4])]) -> crate::Result<()> {
    for (pattern, b) in boxes {
        if b[0] >= b[2] || b[1] >= b[3] {
            return Err(format!("in_box {pattern}: box {b:?} is not x0 y0 x1 y1 with x0 < x1, y0 < y1").into());
        }
        let hits = |u: &&mut Unit| u.refs.iter().any(|r| fnmatch(r, pattern));
        let mut any = false;
        for u in units.iter_mut().filter(hits) {
            any = true;
            if u.fixed {
                continue;
            }
            if u.in_box.is_some_and(|old| old != *b) {
                return Err(format!("in_box: unit {} has two boxes {:?} and {b:?}", u.name, u.in_box).into());
            }
            let body: Vec<&[f64; 5]> = u.rects.iter().enumerate().filter(|(k, _)| !u.ko.contains(k)).map(|(_, r)| r).collect();
            let (w, h) = extent(&body);
            if w > b[2] - b[0] + 1e-9 || h > b[3] - b[1] + 1e-9 {
                return Err(format!("in_box {pattern}: unit {} ({w:.3} x {h:.3} mm) does not fit the box {b:?}", u.name).into());
            }
            u.in_box = Some(*b);
        }
        if !any {
            return Err(format!("in_box {pattern}: no part matches").into());
        }
    }
    Ok(())
}

fn extent(rects: &[&[f64; 5]]) -> (f64, f64) {
    let span = |lo: usize, hi: usize| {
        let min = rects.iter().map(|r| r[lo]).fold(f64::INFINITY, f64::min);
        rects.iter().map(|r| r[hi]).fold(f64::NEG_INFINITY, f64::max) - min
    };
    (span(0, 2), span(1, 3))
}

fn pad_at(by_ref: &HashMap<&str, &Footprint>, reference: &str, number: &str) -> crate::Result<(f64, f64)> {
    let fp = by_ref.get(reference).ok_or_else(|| format!("near: no part {reference}"))?;
    let pad = fp.pads.iter().find(|p| p.number == number).ok_or_else(|| format!("near: {reference} has no pad {number}"))?;
    Ok(pad.position.mm())
}

/// The pad of a movable part stays near a pad of a fixed unit. A movable target would make the rule depend on two units, and
/// the incremental cost would no longer be exact.
pub fn near_rules(units: &mut [Unit], index: &Index, near: &[Near]) -> crate::Result<()> {
    for n in near {
        let name = format!("{}.{}", n.part, n.pad);
        if n.distance <= 0.0 {
            return Err(format!("near {name}: distance {} must be > 0", n.distance).into());
        }
        let &i = index.unit_of.get(&n.part).ok_or_else(|| format!("near: no part {}", n.part))?;
        if !index.unit_of.get(&n.target).is_some_and(|t| units[*t].fixed) {
            return Err(format!("near {name}: target {} must be a part of a fixed unit", n.target).into());
        }
        if units[i].fixed {
            return Err(format!("near {name}: {} is in a fixed unit", n.part).into());
        }
        let (x, y) = pad_at(index.by_ref, &n.part, &n.pad)?;
        let (wx, wy) = pad_at(index.by_ref, &n.target, &n.target_pad)?;
        let u = &mut units[i];
        u.near.push([x - u.x, y - u.y, wx, wy, n.distance]);
    }
    Ok(())
}

fn points_box(points: &[Pt]) -> Rect {
    bbox_of(&points.iter().map(|p| p.mm()).collect::<Vec<_>>())
}

/// The box of a shape with its line width.
fn shape_box(g: &Graphic) -> Rect {
    let body = match &g.geometry {
        Geometry::Segment { start, end } => points_box(&[*start, *end]),
        Geometry::Rect { top_left, bottom_right } => points_box(&[*top_left, *bottom_right]),
        Geometry::Circle { center, radius_point } => {
            let (c, p) = (center, radius_point);
            let r = ((p.x - c.x) as f64).hypot((p.y - c.y) as f64) / 1e6;
            let (x, y) = c.mm();
            Rect::new(x - r, y - r, x + r, y + r)
        }
        Geometry::Arc { start, end, center } => {
            let r = ((start.x - center.x) as f64).hypot((start.y - center.y) as f64) / 1e6;
            let (x, y) = center.mm();
            let _ = end;
            Rect::new(x - r, y - r, x + r, y + r)
        }
        Geometry::Poly { rings } => points_box(&rings.concat()),
        Geometry::Other => Rect::new(0.0, 0.0, 0.0, 0.0),
    };
    body.grown(mm(g.width) / 2.0)
}

/// `a` inside `b` within the width of a cut line.
fn inside(a: Rect, b: Rect) -> bool {
    let t = CUT_TOLERANCE;
    b.x0 - t <= a.x0 && b.y0 - t <= a.y0 && a.x1 <= b.x1 + t && a.y1 <= b.y1 + t
}

/// A board hole wholly inside a block border is part of the block (a creepage slot under a relay): its Edge.Cuts shapes move
/// with the block and it is a keepout rect of the block, not a board keepout. Returns the other keepouts.
pub fn block_cuts(board: &Board, units: &mut [Unit], keepouts: Vec<Vec<Xy>>) -> Vec<Vec<Xy>> {
    let cuts: Vec<(&Graphic, Rect)> = board.graphics.iter().filter(|g| g.layer == "Edge.Cuts").map(|g| (g, shape_box(g))).collect();
    let mut rest = Vec::new();
    for keepout in keepouts {
        let hole = bbox_of(&keepout.iter().map(|p| (p[0], p[1])).collect::<Vec<_>>());
        let Some(u) = units.iter_mut().find(|u| unit_box(u).is_some_and(|b| inside(hole, b))) else {
            rest.push(keepout);
            continue;
        };
        u.ko.push(u.rects.len());
        let row = u.local(hole, 0.0);
        u.rects.push(row);
        u.cuts.extend(cuts.iter().filter(|(_, b)| inside(*b, hole)).map(|(g, _)| g.id.clone()));
    }
    rest
}

/// Net codes as KiCad gives them while it loads a file with no net table: the order nets first appear in, pads first.
pub fn net_codes(board: &Board) -> HashMap<String, i64> {
    let mut codes: HashMap<String, i64> = HashMap::from([(String::new(), 0)]);
    let pads = board.footprints.iter().flat_map(|f| &f.pads).map(|p| p.net.as_str());
    let copper = board.copper.iter().map(|c| c.net());
    let zones = board.zones.iter().map(|z| z.net.as_str());
    let others = board.nets.keys().map(String::as_str);
    for net in pads.chain(copper).chain(zones).chain(others) {
        let next = codes.len() as i64;
        codes.entry(net.to_string()).or_insert(next);
    }
    codes
}

/// The sorted codes of the nets that match a pattern.
pub fn matching_codes(codes: &HashMap<String, i64>, patterns: &[String]) -> Vec<i64> {
    let hits: BTreeSet<i64> = codes.iter().filter(|(n, _)| patterns.iter().any(|q| fnmatch(n, q))).map(|(_, c)| *c).collect();
    hits.into_iter().collect()
}
