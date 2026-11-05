//! What a route does to a board, as board text: stage keepouts, the widths rules, the pours. KiCad 10 fills and checks the result.
//! Zones read the way pcbnew's SaveBoard writes them, so a router and kicad-cli see the same items.
use crate::kicad::board::{Board, RoutedCopper};
use crate::kicad::geom::boolean::{circle_segments, difference, inflate_round, intersection, simplify};
use crate::kicad::geom::{Iu, Polygon, Pt, Rect, from_mm, ki_round, parse_iu, to_mm};
use crate::kicad::item_text::{item_uuid, mm_text, nm_text, quoted};
use crate::kicad::pad::Copper;
use crate::kicad::raw::{Form, parse};
use crate::plan::{Keepout, KeepoutMode, Pour, PourConnection, PourShape, Rect as MmBox, Stage, WidthRule};
use std::f64::consts::{FRAC_PI_2, PI};

/// Names the keepouts of a stage, which are taken out again after the router.
pub const TMP: &str = "TMP_ROUTE_";
/// An 'outside' keepout reaches this far past the board box.
const OUTSIDE_MARGIN_MM: f64 = 5.0;
/// route.py's pour settings: minimum fill width, the arc error of the net's copper and of the growth.
const MIN_THICKNESS_MM: f64 = 0.25;
const COPPER_ERROR_MM: f64 = 0.01;
const GROW_ERROR_MM: f64 = 0.05;

fn box_polygon([x0, y0, x1, y1]: MmBox) -> Polygon {
    let (x0, y0, x1, y1) = (from_mm(x0), from_mm(y0), from_mm(x1), from_mm(y1));
    Polygon::of_ring(vec![Pt::new(x0, y0), Pt::new(x1, y0), Pt::new(x1, y1), Pt::new(x0, y1)])
}

/// The area of a keepout: its box, or for 'outside' the board box grown by 5 mm minus its box.
pub fn keepout_area(edges: Rect, keepout: &Keepout) -> Result<Vec<Polygon>, String> {
    let inner = box_polygon(keepout.bounds);
    if keepout.mode == KeepoutMode::Inside {
        return Ok(vec![inner]);
    }
    let (left, top) = (to_mm(edges.left) - OUTSIDE_MARGIN_MM, to_mm(edges.top) - OUTSIDE_MARGIN_MM);
    let (right, bottom) = (to_mm(edges.right) + OUTSIDE_MARGIN_MM, to_mm(edges.bottom) + OUTSIDE_MARGIN_MM);
    difference(&[box_polygon([left, top, right, bottom])], &[inner])
}

/// The polygon KiCad writes for a zone. Its file holds one polygon, the first of SHAPE_POLY_SET, so what pcbnew saved of a shape
/// in several pieces is this piece alone (seen on ENV-SENSE, 2026-11-04). SHAPE_POLY_SET stores an island in a hole before the
/// polygon around it; `polygons` has the polygon first.
pub fn saved_polygon(polygons: &[Polygon]) -> Option<&Polygon> {
    let inside = |island: &Polygon, around: &Polygon| Polygon::of_ring(around.outline.clone()).contains(island.outline[0]);
    let mut at = 0;
    while at + 1 < polygons.len() && inside(&polygons[at + 1], &polygons[at]) {
        at += 1;
    }
    polygons.get(at)
}

fn layers_text(layers: &[String]) -> String {
    match layers {
        [one] => format!("\t\t(layer {})\n", quoted(one)),
        many => format!("\t\t(layers {})\n", many.iter().map(|l| quoted(l)).collect::<Vec<_>>().join(" ")),
    }
}

fn ring_text(ring: &[Pt]) -> String {
    let points: Vec<String> = ring.iter().map(|p| format!("(xy {} {})", nm_text(p.x), nm_text(p.y))).collect();
    let lines: Vec<String> = points.chunks(6).map(|line| format!("\t\t\t\t{}\n", line.join(" "))).collect();
    format!("\t\t(polygon\n\t\t\t(pts\n{}\t\t\t)\n\t\t)\n", lines.concat())
}

fn outline_text(polygons: &[Polygon]) -> String {
    saved_polygon(polygons).map_or(String::new(), |polygon| polygon.rings().map(|ring| ring_text(ring)).collect())
}

/// A rule area: no tracks, vias or fills.
pub fn keepout_zone(stage: &Stage, keepout: &Keepout, area: &[Polygon], seed: &str, number: usize) -> String {
    format!(
        "\t(zone\n{layers}\t\t(uuid \"{uuid}\")\n\t\t(name {name})\n\t\t(hatch edge 0.5)\n\t\t(connect_pads\n\t\t\t(clearance 0)\n\t\t)\n\t\t(min_thickness 0.25)\n\t\t(keepout\n\t\t\t(tracks not_allowed)\n\t\t\t(vias not_allowed)\n\t\t\t(pads allowed)\n\t\t\t(copperpour not_allowed)\n\t\t\t(footprints allowed)\n\t\t)\n\t\t(placement\n\t\t\t(enabled no)\n\t\t\t(sheetname \"\")\n\t\t)\n\t\t(fill\n\t\t\t(thermal_gap 0.5)\n\t\t\t(thermal_bridge_width 0.5)\n\t\t\t(island_removal_mode 0)\n\t\t)\n{outline}\t)\n",
        layers = layers_text(&keepout.layers),
        uuid = item_uuid(seed, number),
        name = quoted(&format!("{TMP}{}_{}", stage.name, keepout.name)),
        outline = outline_text(area),
    )
}

/// TransformCircleToPolygon with the error inside: an even number of chords, the first corner on the +x axis.
fn circle(center: Pt, radius: Iu, error: Iu) -> Vec<Pt> {
    let chords = circle_segments(radius, error);
    let chords = chords + chords % 2;
    (0..chords).map(|i| Pt::new(radius, 0).rotated(i as f64 * 360.0 / chords as f64) + center).collect()
}

/// A thick segment: two half circles of `circle`'s chords.
fn oval(a: Pt, b: Pt, width: Iu, error: Iu) -> Vec<Pt> {
    let radius = width / 2;
    if a == b {
        return circle(a, radius, error);
    }
    let chords = circle_segments(radius, error);
    let half = (chords + chords % 2) / 2;
    let heading = ((b.y - a.y) as f64).atan2((b.x - a.x) as f64);
    let cap = |center: Pt, from: f64| {
        (0..=half).map(move |i| {
            let (sin, cos) = (from + PI * i as f64 / half as f64).sin_cos();
            Pt::new(ki_round(center.x as f64 + radius as f64 * cos), ki_round(center.y as f64 + radius as f64 * sin))
        })
    };
    cap(b, heading - FRAC_PI_2).chain(cap(a, heading + FRAC_PI_2)).collect()
}

fn copper_polygon(copper: &Copper, error: Iu) -> Polygon {
    Polygon::of_ring(match copper {
        Copper::Circle { center, radius } => circle(*center, *radius, error),
        Copper::Segment { a, b, width } => oval(*a, *b, *width, error),
        Copper::Polygon(points) => points.clone(),
    })
}

/// The polygon wound one way. Clipper's offset takes its fill rule from the first shape and loses the shapes wound the other way.
fn wound(mut polygon: Polygon) -> Polygon {
    let ring = &polygon.outline;
    let twice_area: i128 = (0..ring.len()).map(|i| {
        let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
        a.x as i128 * b.y as i128 - b.x as i128 * a.y as i128
    }).sum();
    if twice_area < 0 {
        polygon.outline.reverse();
    }
    polygon
}

/// The pads, tracks and vias of the pour's net on its layer, one polygon each. Every via counts, whatever layers it joins.
fn net_copper(board: &Board, pour: &Pour) -> Vec<Polygon> {
    let error = from_mm(COPPER_ERROR_MM);
    let mut out = Vec::new();
    for (_, pad) in board.pads().filter(|(_, p)| p.net == pour.net && p.layers.contains(&pour.layer)) {
        match pad.polygons.get(&pour.layer) {
            Some(polygon) => out.push(polygon.clone()),
            None => out.extend(pad.copper.iter().map(|c| copper_polygon(c, error))),
        }
    }
    for item in &board.copper {
        match item {
            RoutedCopper::Track(t) if t.net == pour.net && t.layer == pour.layer => out.extend(t.copper().iter().map(|c| copper_polygon(c, error))),
            RoutedCopper::Via(v) if v.net == pour.net => out.push(copper_polygon(&v.copper(), error)),
            _ => {}
        }
    }
    out.into_iter().map(wound).collect()
}

fn board_outline(board: &Board) -> Result<&[Polygon], String> {
    if board.outlines.is_empty() {
        return Err("route: the board outline (Edge.Cuts) is not closed".to_string());
    }
    Ok(&board.outlines)
}

/// The area of a pour, or None when the route put no copper of an 'around' net on its layer.
pub fn pour_area(board: &Board, pour: &Pour) -> Result<Option<Vec<Polygon>>, String> {
    if !board.nets.contains_key(&pour.net) {
        return Err(format!("route: pour {}: no net {}", pour.name, pour.net));
    }
    let mut area = match pour.shape {
        PourShape::Board => board_outline(board)?.to_vec(),
        PourShape::Around => {
            let copper = net_copper(board, pour);
            if copper.is_empty() {
                return Ok(None);
            }
            let grow = pour.grow_mm.ok_or_else(|| format!("route: pour {}: no grow_mm", pour.name))?;
            let grown = inflate_round(&copper, from_mm(grow), from_mm(GROW_ERROR_MM))?;
            simplify(&intersection(&grown, board_outline(board)?)?)?
        }
    };
    for minus in &pour.minus {
        area = difference(&area, &[box_polygon(*minus)])?;
    }
    Ok(Some(area))
}

/// A copper zone with every setting of the pour. Islands are always removed: mode 0.
pub fn pour_zone(pour: &Pour, area: &[Polygon], seed: &str, number: usize) -> String {
    let priority = if pour.priority > 0 { format!("\t\t(priority {})\n", pour.priority) } else { String::new() };
    let connection = if pour.connection == PourConnection::Full { " yes" } else { "" };
    format!(
        "\t(zone\n\t\t(net {net})\n\t\t(layer {layer})\n\t\t(uuid \"{uuid}\")\n\t\t(name {name})\n\t\t(hatch edge 0.5)\n{priority}\t\t(connect_pads{connection}\n\t\t\t(clearance {clearance})\n\t\t)\n\t\t(min_thickness {thickness})\n\t\t(fill\n\t\t\t(thermal_gap {gap})\n\t\t\t(thermal_bridge_width {spoke})\n\t\t\t(island_removal_mode 0)\n\t\t)\n{outline}\t)\n",
        net = quoted(&pour.net),
        layer = quoted(&pour.layer),
        uuid = item_uuid(seed, number),
        name = quoted(&pour.name),
        clearance = mm_text(pour.clearance_mm),
        thickness = mm_text(MIN_THICKNESS_MM),
        gap = mm_text(pour.thermal_gap_mm),
        spoke = mm_text(pour.spoke_mm),
        outline = outline_text(area),
    )
}

/// The widths rules on `board` and its text: each track wider than a rule whose box holds its midpoint gets the rule's width. The
/// count per rule name, in rule order. A later rule sees the width of an earlier one.
pub fn set_widths(text: &str, board: &mut Board, rules: &[WidthRule]) -> Result<(String, Vec<(String, u64)>), String> {
    let mut counts: Vec<(String, u64)> = Vec::new();
    for rule in rules {
        if !counts.iter().any(|(name, _)| *name == rule.name) {
            counts.push((rule.name.clone(), 0));
        }
    }
    let mut changed = 0;
    for item in &mut board.copper {
        let RoutedCopper::Track(track) = item else { continue };
        let width = narrowed(rules, track.start, track.end, &track.layer, track.width, |rule| {
            counts.iter_mut().filter(|(name, _)| *name == rule.name).for_each(|(_, count)| *count += 1);
        });
        changed += usize::from(width != track.width);
        track.width = width;
    }
    let (text, edited) = with_widths(text, rules)?;
    if edited != changed {
        return Err(format!("route: the width rules change {changed} tracks of the board and {edited} of its text"));
    }
    Ok((text, counts))
}

/// A track's width after the rules; `hit` hears each rule that applied.
fn narrowed(rules: &[WidthRule], start: Pt, end: Pt, layer: &str, width: Iu, mut hit: impl FnMut(&WidthRule)) -> Iu {
    let (from, to) = ((to_mm(start.x), to_mm(start.y)), (to_mm(end.x), to_mm(end.y)));
    let mut now = width;
    for rule in rules {
        if rule.applies(from, to, layer, to_mm(now)) {
            now = from_mm(rule.width_mm);
            hit(rule);
        }
    }
    now
}

fn form_point(form: &Form, head: &str) -> Result<Pt, String> {
    let point = form.children(head).next().ok_or_else(|| format!("a track without {head}"))?;
    let number = |index| parse_iu(point.text(index).unwrap_or_default());
    Ok(Pt::new(number(1)?, number(2)?))
}

/// The text with the rules done on each track as it stands there: tracks are told apart by their own text, because a uuid can
/// repeat on a routed board. The count of tracks changed.
fn with_widths(text: &str, rules: &[WidthRule]) -> Result<(String, usize), String> {
    if rules.is_empty() {
        return Ok((text.to_string(), 0));
    }
    let forms = parse(text)?;
    let root = forms.first().ok_or("an empty board file")?;
    let (mut out, mut at, mut edited) = (String::with_capacity(text.len()), 0, 0);
    for form in root.items().iter().filter(|f| f.is("segment") || f.is("arc")) {
        let old = form.children("width").next().ok_or("a track without a width")?;
        let width = parse_iu(old.text(1).unwrap_or_default())?;
        let layer = form.children("layer").next().and_then(|l| l.text(1)).ok_or("a track without a layer")?;
        let new = narrowed(rules, form_point(form, "start")?, form_point(form, "end")?, layer, width, |_| {});
        if new != width {
            out += &text[at..old.span.start];
            out += &format!("(width {})", nm_text(new));
            at = old.span.end;
            edited += 1;
        }
    }
    Ok((out + &text[at..], edited))
}
