//! Which parts move together: PCB groups, block borders on User.1, explicit membership, and the ties (switch nodes, decoupling
//! caps, support parts). The result is an ordered list of units.

use super::options::{Members, Options};
use super::parts::{fp_rect, is_mounting_hole, is_test_point, pad_gap, pads_box, part_fixed, ref_prefix, round6};
use crate::dru::fnmatch;
use crate::geom::Rect;
use crate::kicad::clusters::contains;
use crate::kicad::doc::{Board, Copper, CopperItem, Footprint, Geometry, Graphic, PtMm, mm};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

/// A User.1 text this close to a block border is its label.
const LABEL_DIST: f64 = 3.0;
/// A part is in a block when its anchor and this share of its courtyard are inside.
const BLOCK_SHARE: f64 = 0.6;
const LINE_TOLERANCE: f64 = 1e-3;

/// A closed shape as a polygon.
pub fn shape_polygon(g: &Graphic) -> Option<Vec<(f64, f64)>> {
    match &g.geometry {
        Geometry::Rect { top_left, bottom_right } => {
            let ((ax, ay), (bx, by)) = (top_left.mm(), bottom_right.mm());
            let (x0, x1, y0, y1) = (ax.min(bx), ax.max(bx), ay.min(by), ay.max(by));
            Some(vec![(x0, y0), (x1, y0), (x1, y1), (x0, y1)])
        }
        Geometry::Poly { rings } => rings.first().map(|r| r.iter().map(|p| p.mm()).collect()),
        _ => None,
    }
}

pub fn bbox_of(polygon: &[(f64, f64)]) -> Rect {
    let points = polygon.iter().map(|&(x, y)| Rect::new(x, y, x, y));
    Rect::bounding(points).unwrap_or(Rect::new(0.0, 0.0, 0.0, 0.0))
}

type Line = (f64, f64, f64, f64, String);

fn key(v: f64) -> i64 {
    (v / LINE_TOLERANCE).round_ties_even() as i64
}

/// Axis-aligned rectangles closed by 4 line segments: a border drawn as 4 lines is a block border like a rectangle shape.
pub fn line_rectangles(lines: &[Line]) -> Vec<(Rect, Vec<String>)> {
    let mut horizontal: BTreeMap<(i64, i64, i64), (f64, f64, f64, &str)> = BTreeMap::new();
    let mut vertical: HashMap<(i64, i64, i64), &str> = HashMap::new();
    for (x0, y0, x1, y1, id) in lines {
        let flat = |a: f64, b: f64| (a - b).abs() <= LINE_TOLERANCE;
        if flat(*y0, *y1) && !flat(*x0, *x1) {
            let (a, b) = (x0.min(*x1), x0.max(*x1));
            horizontal.insert((key(a), key(b), key(*y0)), (a, b, *y0, id));
        } else if flat(*x0, *x1) && !flat(*y0, *y1) {
            vertical.insert((key(*x0), key(y0.min(*y1)), key(y0.max(*y1))), id);
        }
    }
    let rows: Vec<_> = horizontal.iter().collect();
    let mut out = Vec::new();
    for (a, (ka, (xa, xb, ya, ia))) in rows.iter().enumerate() {
        for (kb, (_, _, yb, ib)) in &rows[a + 1..] {
            if (kb.0, kb.1) != (ka.0, ka.1) || kb.2 == ka.2 {
                continue;
            }
            let (lo, hi) = (ka.2.min(kb.2), ka.2.max(kb.2));
            if let (Some(left), Some(right)) = (vertical.get(&(ka.0, lo, hi)), vertical.get(&(ka.1, lo, hi))) {
                let ids = [ia, ib, left, right].iter().map(|s| s.to_string()).collect();
                out.push((Rect::new(*xa, ya.min(*yb), *xb, ya.max(*yb)), ids));
            }
        }
    }
    out
}

#[derive(Clone, Debug)]
pub struct Border {
    pub boxed: Rect,
    pub ids: Vec<String>,
    pub label: Option<String>,
}

/// User.1 closed shapes, and rectangles closed by 4 User.1 lines, with the User.1 texts near each box.
pub fn block_borders(board: &Board) -> Vec<Border> {
    let on_layer = || board.graphics.iter().filter(|g| g.layer == "User.1");
    let mut out: Vec<Border> = on_layer().filter_map(|g| shape_polygon(g).map(|p| Border { boxed: bbox_of(&p), ids: vec![g.id.clone()], label: None })).collect();
    let segment = |g: &Graphic| match &g.geometry {
        Geometry::Segment { start, end } => Some((mm(start.x), mm(start.y), mm(end.x), mm(end.y), g.id.clone())),
        _ => None,
    };
    let lines: Vec<Line> = on_layer().filter_map(segment).collect();
    out.extend(line_rectangles(&lines).into_iter().map(|(boxed, ids)| Border { boxed, ids, label: None }));
    for text in board.texts.iter().filter(|t| t.layer == "User.1") {
        let (x, y) = text.position.mm();
        // Inside overlapping borders the label goes to the nearest top-left corner: the builders put it just inside that corner.
        let distance = |b: &Border| ((b.boxed.x0 - x).max(x - b.boxed.x1).max(b.boxed.y0 - y).max(y - b.boxed.y1).max(0.0), (x - b.boxed.x0).hypot(y - b.boxed.y0));
        let nearest = out.iter().enumerate().map(|(k, b)| (distance(b), k)).min_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        if let Some(((edge, _), k)) = nearest.filter(|((edge, _), _)| *edge <= LABEL_DIST) {
            let _ = edge;
            out[k].ids.push(text.id.clone());
            out[k].label.get_or_insert_with(|| text.text.clone());
        }
    }
    out
}

/// A unit before its rects: name, parts, what moves with it.
#[derive(Clone, Debug, Default)]
pub struct Draft {
    pub key: String,
    pub name: String,
    pub refs: Vec<String>,
    pub borders: Vec<String>,
    pub boxed: Option<Rect>,
    pub group: Option<String>,
    /// Private locked copper of an explicit block: it moves with the block.
    pub private: BTreeSet<String>,
}

#[derive(Default)]
pub struct Grouping {
    pub units: Vec<Draft>,
    pub member: HashMap<String, String>,
    /// [cap, ic, gap] of every tied decoupling cap.
    pub decaps: Vec<Decap>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Decap(pub String, pub String, pub f64);

impl Grouping {
    fn has(&self, key: &str) -> bool {
        self.units.iter().any(|u| u.key == key)
    }

    fn unit(&mut self, key: &str) -> Option<&mut Draft> {
        self.units.iter_mut().find(|u| u.key == key)
    }

    /// Part `r` joins the unit of `anchor`, if `r` has no unit yet.
    fn join(&mut self, r: &str, anchor: &str) {
        if !self.member.contains_key(r) {
            let key = self.member.entry(anchor.to_string()).or_insert(format!("F:{anchor}")).clone();
            self.member.insert(r.to_string(), key);
        }
    }

    /// As join, but the part leaves a unit it had.
    fn move_to(&mut self, r: &str, anchor: &str) {
        let key = self.member.entry(anchor.to_string()).or_insert(format!("F:{anchor}")).clone();
        self.member.insert(r.to_string(), key);
    }
}

fn groups(board: &Board, g: &mut Grouping) {
    let by_id: HashMap<&str, &str> = board.footprints.iter().map(|f| (f.id.as_str(), f.reference.as_str())).collect();
    let nested: HashSet<&str> = board.groups.iter().flat_map(|x| x.items.iter().map(String::as_str)).collect();
    for group in board.groups.iter().filter(|x| !nested.contains(x.id.as_str())) {
        let refs: Vec<&str> = group.items.iter().filter_map(|i| by_id.get(i.as_str()).copied()).collect();
        let Some(first) = refs.first() else { continue };
        let key = format!("G:{}", group.id);
        let name = if group.name.is_empty() { (*first).to_string() } else { group.name.clone() };
        g.units.push(Draft { key: key.clone(), name, group: Some(group.id.clone()), ..Draft::default() });
        for r in refs {
            g.member.insert(r.to_string(), key.clone());
        }
    }
}

/// Uuids of the locked tracks and vias that belong to one block: every end inside its border and a net whose pads are all on
/// parts of the block (a crystal route). Such copper moves with the block.
fn private_locked(locked: &[&Copper], net_refs: &HashMap<&str, HashSet<&str>>, refs: &[String], boxed: Rect) -> BTreeSet<String> {
    let set: HashSet<&str> = refs.iter().map(String::as_str).collect();
    let mine = |t: &&&Copper| {
        net_refs.get(t.net()).is_some_and(|on| on.is_subset(&set)) && t.ends().iter().all(|p| contains(boxed, p.mm().0, p.mm().1))
    };
    locked.iter().filter(mine).map(|t| t.id().to_string()).collect()
}

struct BlockInput<'a> {
    board: &'a Board,
    by_ref: &'a HashMap<&'a str, &'a Footprint>,
    options: &'a Options,
    outline: &'a [(f64, f64)],
    locked: &'a [&'a Copper],
}

/// A border whose label names a block holds exactly those parts, when no part of the block is fixed. A block with a fixed part
/// is soft: its parts stay single units, tied by a cohesion net.
fn explicit_blocks(input: &BlockInput, members: &Members, g: &mut Grouping) -> crate::Result<()> {
    let missing: BTreeSet<&String> = members.blocks.values().flatten().filter(|r| !input.by_ref.contains_key(r.as_str())).collect();
    if !missing.is_empty() {
        let names: Vec<&str> = missing.iter().take(8).map(|s| s.as_str()).collect();
        return Err(format!("block membership names parts not on the board: {}", names.join(", ")).into());
    }
    let mut net_refs: HashMap<&str, HashSet<&str>> = HashMap::new();
    for fp in &input.board.footprints {
        for p in fp.pads.iter().filter(|p| !p.net.is_empty()) {
            net_refs.entry(&p.net).or_default().insert(&fp.reference);
        }
    }
    for (k, border) in block_borders(input.board).into_iter().enumerate() {
        let Some(refs) = border.label.as_ref().and_then(|l| members.blocks.get(l)) else { continue };
        if refs.is_empty() || refs.iter().any(|r| g.member.contains_key(r)) {
            continue;
        }
        let own = private_locked(input.locked, &net_refs, refs, border.boxed);
        let rest: Vec<&Copper> = input.locked.iter().copied().filter(|t| !own.contains(t.id())).collect();
        let fixed = |r: &String| {
            let fp = input.by_ref[r.as_str()];
            part_fixed(fp, pads_box(fp, fp_rect(fp)), input.outline, input.options, &rest)
        };
        if refs.iter().any(fixed) {
            continue;
        }
        let key = format!("B:{k}");
        for r in refs {
            g.member.insert(r.clone(), key.clone());
        }
        let name = border.label.clone().unwrap_or_default();
        g.units.push(Draft { key, name, borders: border.ids, boxed: Some(border.boxed), private: own, ..Draft::default() });
    }
    Ok(())
}

/// The share of rect `c` inside `b`.
fn share_inside(c: Rect, b: Rect) -> f64 {
    let (w, h) = ((c.x1.min(b.x1) - c.x0.max(b.x0)).max(0.0), (c.y1.min(b.y1) - c.y0.max(b.y0)).max(0.0));
    w * h / (c.width() * c.height()).max(1e-9)
}

/// A border holds the parts whose anchor and most of the courtyard are inside it; a border around one part is stale.
fn borders_by_place(board: &Board, g: &mut Grouping) {
    for (k, border) in block_borders(board).into_iter().enumerate() {
        let b = border.boxed;
        let holds = |f: &&Footprint| {
            let (x, y) = f.position.mm();
            !g.member.contains_key(&f.reference) && !is_test_point(&f.reference) && contains(b, x, y) && share_inside(fp_rect(f), b) >= BLOCK_SHARE
        };
        let inside: Vec<String> = board.footprints.iter().filter(holds).map(|f| f.reference.clone()).collect();
        if inside.len() < 2 {
            continue;
        }
        let key = format!("B:{k}");
        for r in inside {
            g.member.insert(r, key.clone());
        }
        let name = border.label.clone().unwrap_or(format!("BLOCK{}", k + 1));
        g.units.push(Draft { key, name, borders: border.ids, boxed: Some(b), ..Draft::default() });
    }
}

/// All parts on a net that matches a pattern and has an inductor pad (a buck switch node) join the unit of the part with the
/// most pads. SWDIO and SWCLK match *SW* but have no inductor.
fn rigid_nets(board: &Board, patterns: &[String], g: &mut Grouping) {
    let mut nets: BTreeMap<&str, BTreeMap<&str, &Footprint>> = BTreeMap::new();
    for fp in board.footprints.iter().filter(|f| !is_test_point(&f.reference) && !is_mounting_hole(f)) {
        for p in fp.pads.iter().filter(|p| !p.net.is_empty() && patterns.iter().any(|q| fnmatch(&p.net, q))) {
            nets.entry(&p.net).or_default().insert(&fp.reference, fp);
        }
    }
    for parts in nets.values() {
        if !parts.keys().any(|r| ref_prefix(r) == "L") {
            continue;
        }
        let mut sorted: Vec<&&Footprint> = parts.values().collect();
        sorted.sort_by(|a, b| b.pads.len().cmp(&a.pads.len()).then(a.reference.cmp(&b.reference)));
        for fp in &sorted[1..] {
            g.join(&fp.reference, &sorted[0].reference);
        }
    }
}

/// A 2-pad capacitor with one pad on GND whose other pad is within `dist` mm of a pin of the same net on an IC joins the nearest
/// such IC. Every such cap is listed, also those that had a unit.
fn decaps(board: &Board, dist: f64, g: &mut Grouping) {
    let ics: Vec<&Footprint> = board.footprints.iter().filter(|f| f.pads.len() > 3 && ref_prefix(&f.reference) == "U").collect();
    for fp in &board.footprints {
        let on_gnd = fp.pads.iter().filter(|p| p.net == "GND").count();
        if ref_prefix(&fp.reference) != "C" || fp.pads.len() != 2 || on_gnd != 1 {
            continue;
        }
        let Some(power) = fp.pads.iter().find(|p| p.net != "GND" && !p.net.is_empty()) else { continue };
        let mut best: Option<(f64, &str)> = None;
        for ic in &ics {
            for pin in ic.pads.iter().filter(|q| q.net == power.net) {
                let gap = pad_gap(power, pin);
                if best.is_none_or(|(b, _)| gap < b) {
                    best = Some((gap, &ic.reference));
                }
            }
        }
        if let Some((gap, ic)) = best.filter(|(gap, _)| *gap <= dist) {
            g.decaps.push(Decap(fp.reference.clone(), ic.to_string(), round6(gap)));
            g.join(&fp.reference, ic);
        }
    }
}

/// A loose part with 3 pads or fewer joins the unit of the nearest IC that shares a net (not `skip`) within `tie` mm.
fn support_ties(board: &Board, tie: f64, skip: &[String], g: &mut Grouping) {
    let nets_of = |f: &'_ Footprint| -> HashSet<String> { f.pads.iter().map(|p| p.net.clone()).filter(|n| !n.is_empty() && !skip.iter().any(|s| fnmatch(n, s))).collect() };
    let ics: Vec<&Footprint> = board.footprints.iter().filter(|f| f.pads.len() > 3).collect();
    let mut joins: Vec<(String, String)> = Vec::new();
    for fp in &board.footprints {
        if g.member.contains_key(&fp.reference) || fp.pads.len() > 3 || is_mounting_hole(fp) || fp.locked {
            continue;
        }
        let (c, nets) = (fp_rect(fp), nets_of(fp));
        let mut best: Option<(f64, &str)> = None;
        for ic in &ics {
            let q = fp_rect(ic);
            let gap = (q.x0 - c.x1).max(c.x0 - q.x1).max(q.y0 - c.y1).max(c.y0 - q.y1);
            if gap <= tie && !nets.is_disjoint(&nets_of(ic)) && best.is_none_or(|(b, _)| gap < b) {
                best = Some((gap, &ic.reference));
            }
        }
        if let Some((_, ic)) = best {
            joins.push((fp.reference.clone(), ic.to_string()));
        }
    }
    for (r, ic) in joins {
        g.move_to(&r, &ic);
    }
}

/// Parts of a reviewed rigid group become one unit; the group may not split another unit or own board drawings.
fn reviewed_groups(board: &Board, rigid: &[Vec<String>], g: &mut Grouping) -> crate::Result<()> {
    let on_board: HashSet<&str> = board.footprints.iter().map(|f| f.reference.as_str()).collect();
    for (number, refs) in rigid.iter().enumerate() {
        let wanted: BTreeSet<&str> = refs.iter().map(String::as_str).collect();
        if wanted.len() < 2 || wanted.len() != refs.len() || !wanted.iter().all(|r| on_board.contains(r)) {
            return Err("reviewed rigid group needs distinct existing native refs".into());
        }
        let previous: BTreeSet<String> = wanted.iter().filter_map(|r| g.member.get(*r).cloned()).collect();
        if g.member.iter().any(|(r, key)| !wanted.contains(r.as_str()) && previous.contains(key)) {
            return Err("reviewed rigid group would split an existing native/grouping unit".into());
        }
        if previous.len() == 1 && wanted.iter().all(|r| g.member.get(*r).is_some_and(|k| previous.contains(k))) {
            continue;
        }
        let owns_drawings = |key: &String| g.units.iter().any(|u| u.key == *key && (u.boxed.is_some() || !u.borders.is_empty()));
        if previous.iter().any(owns_drawings) {
            return Err("reviewed rigid group owns unsupported board-drawing transforms".into());
        }
        let key = format!("E:{number}");
        let name = format!("reviewed:{}", wanted.iter().copied().collect::<Vec<_>>().join(","));
        g.units.push(Draft { key: key.clone(), name, ..Draft::default() });
        for r in wanted {
            g.member.insert(r.to_string(), key.clone());
        }
    }
    Ok(())
}

/// Every part in one unit, units in the order they were made, single parts last in footprint order.
pub fn group_parts(board: &Board, options: &Options, outline: &[(f64, f64)], locked: &[&Copper], by_ref: &HashMap<&str, &Footprint>) -> crate::Result<Grouping> {
    let mut g = Grouping::default();
    groups(board, &mut g);
    match &options.blocks {
        Some(members) => explicit_blocks(&BlockInput { board, by_ref, options, outline, locked }, members, &mut g)?,
        None => borders_by_place(board, &mut g),
    }
    for fp in board.footprints.iter().filter(|f| is_test_point(&f.reference)) {
        g.member.insert(fp.reference.clone(), format!("F:{}", fp.reference));
    }
    if !options.rigid_nets.is_empty() {
        rigid_nets(board, &options.rigid_nets, &mut g);
    }
    if options.decap_tie > 0.0 {
        decaps(board, options.decap_tie, &mut g);
    }
    if options.tie > 0.0 {
        support_ties(board, options.tie, &options.skip, &mut g);
    }
    reviewed_groups(board, &options.rigid_groups, &mut g)?;
    for fp in &board.footprints {
        let key = g.member.entry(fp.reference.clone()).or_insert(format!("F:{}", fp.reference)).clone();
        if !g.has(&key) {
            g.units.push(Draft { key: key.clone(), name: key[2..].to_string(), ..Draft::default() });
        }
    }
    for fp in &board.footprints {
        let key = g.member[&fp.reference].clone();
        if let Some(unit) = g.unit(&key) {
            unit.refs.push(fp.reference.clone());
        }
    }
    Ok(g)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(a: (f64, f64), b: (f64, f64), id: &str) -> Line {
        (a.0, a.1, b.0, b.1, id.to_string())
    }

    #[test]
    fn four_lines_close_a_rectangle() {
        let lines = [line((0.0, 0.0), (10.0, 0.0), "t"), line((10.0, 5.0), (0.0, 5.0), "b"), line((0.0, 0.0), (0.0, 5.0), "l"), line((10.0, 0.0), (10.0, 5.0), "r")];
        let found = line_rectangles(&lines);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, Rect::new(0.0, 0.0, 10.0, 5.0));
        assert_eq!(found[0].1, ["t", "b", "l", "r"]);
    }

    #[test]
    fn three_lines_close_nothing() {
        let lines = [line((0.0, 0.0), (10.0, 0.0), "t"), line((0.0, 5.0), (10.0, 5.0), "b"), line((0.0, 0.0), (0.0, 5.0), "l")];
        assert!(line_rectangles(&lines).is_empty());
    }

    #[test]
    fn share_inside_is_the_covered_part_of_the_rect() {
        assert_eq!(share_inside(Rect::new(0.0, 0.0, 2.0, 1.0), Rect::new(1.0, 0.0, 5.0, 5.0)), 0.5);
    }
}
