//! Draws the stub tips of differential pairs for `iotroute pair-route` from a board spec (2026-10-26, KIOSK-CM4). pair-route routes a
//! pair as one centreline between two tip pairs: at each end the P and N tracks must end side by side at the pair pitch (width + gap),
//! on the pair layer, pointing along a common heading with 1 mm free in front, and P must be on opposite sides of the two headings.
//!
//!   {"pairs": [{"base": "MDI0_", "width": 0.2, "gap": 0.2, "layer": "F.Cu",
//!               "ends": [{"ref": "JP1", "p": "56", "n": "55", "dir": [0, 1]},
//!                        {"ref": "J5", "p": "P2", "n": "P3", "dir": [0, -1], "run": 1.5, "cross_ok": true}]}]}
//!
//! An end: the P and N pads of one footprint, the heading dir (pointing out of the pads into the route) and an optional run (mm straight
//! out of the pads before the fan; default: the pad half size along dir + 0.35). An end may name a "link": another footprint's pads
//! joined to the end pads by straight tracks first (a flow-through ESD array next to its connector: the connector pads link to the ESD
//! pads, the tips start at the ESD pads).
//!
//! Fan: P and N go straight along dir, then on 45 degree diagonals to the pair axis at +-pitch/2, then FRONT straight to the tips. When P
//! is on the same side of both headings, the end with cross_ok gets a crossover: both legs go outward, then cross on diagonals (P on
//! B.Cu between two vias, N on F.Cu), then come back to +-pitch/2. Hand geometry only at the pads; the result goes through DRC with
//! parity like any router result.
use super::{Point, point};
use crate::grid::astar::exact_hypot;
use crate::kicad::board::Board;
use crate::kicad::edit::{NewTrack, NewVia};
use crate::kicad::geom::{from_mm, to_mm};
use crate::kicad::pad::Pad;
use crate::kicad::session::Session;
use crate::model::text::round_to;
use serde::Deserialize;
use std::fmt;

/// pair-route FRONT: free straight run before the tip.
const FRONT: f64 = 1.0;
/// Straight run past the pad edge before the fan.
const RUN_MARGIN: f64 = 0.35;
/// Crossover: extra outward offset beyond the pad offset.
const CROSS_OUT: f64 = 0.35;
const VIA_MM: f64 = 0.45;
const VIA_DRILL_MM: f64 = 0.2;
/// A drop's via at +-0.45: 0.55 mm from a neighbour pair's leg 1.2 mm away (0.475 needed).
const DROP_OUT: f64 = 0.45;
/// How far along the N via of a drop stands from the P via.
const DROP_STAGGER: f64 = 0.6;
/// A track shorter than this is not drawn.
const LEAST_TRACK_MM: f64 = 1e-3;
const CROSS_LAYER: &str = "B.Cu";

#[derive(Debug, Deserialize)]
pub struct Spec {
    pub pairs: Vec<PairSpec>,
}

#[derive(Debug, Deserialize)]
pub struct PairSpec {
    pub base: String,
    pub width: f64,
    pub gap: f64,
    #[serde(default = "front_layer")]
    pub layer: String,
    pub ends: Vec<EndSpec>,
}

fn front_layer() -> String {
    "F.Cu".to_string()
}

/// A pad number, as text or a bare number.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum PadName {
    Text(String),
    Number(serde_json::Number),
}

impl fmt::Display for PadName {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            PadName::Text(text) => f.write_str(text),
            PadName::Number(number) => write!(f, "{number}"),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct EndSpec {
    #[serde(rename = "ref")]
    pub reference: String,
    pub p: PadName,
    pub n: PadName,
    pub dir: Point,
    pub run: Option<f64>,
    #[serde(default)]
    pub cross_ok: bool,
    /// SMD pads of an end whose pair runs on another layer: fan here, then drop.
    pub fan_layer: Option<String>,
    /// The tips are on this layer, staggered vias after the fan.
    pub drop: Option<String>,
    pub through: Option<Through>,
    pub link: Option<Link>,
}

/// Straight-through ESD: the linked pads feed these entry pads, a straight track joins entry and end pads.
#[derive(Debug, Deserialize)]
pub struct Through {
    pub p: PadName,
    pub n: PadName,
}

#[derive(Debug, Deserialize)]
pub struct Link {
    #[serde(rename = "ref")]
    pub reference: String,
    pub p: PadName,
    pub n: PadName,
    #[serde(default)]
    pub run: f64,
    pub paths: Option<LinkPaths>,
}

/// Explicit escape polylines from the linked pads to the entry pads.
#[derive(Debug, Deserialize)]
pub struct LinkPaths {
    #[serde(rename = "P")]
    pub p: Vec<PathPoint>,
    #[serde(rename = "N")]
    pub n: Vec<PathPoint>,
}

/// [x, y] or [x, y, "B.Cu"]: a via where the layer changes.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum PathPoint {
    Same(f64, f64),
    On(f64, f64, String),
}

fn pad_of<'b>(board: &'b Board, reference: &str, number: &PadName) -> Result<&'b Pad, String> {
    let footprint = board.footprints.iter().find(|f| f.reference == reference).ok_or(format!("{reference}: not on the board"))?;
    let number = number.to_string();
    footprint.pads.iter().find(|p| p.number == number).ok_or(format!("{reference} pad {number}: not found"))
}

fn centre(pad: &Pad) -> Point {
    (to_mm(pad.position.x), to_mm(pad.position.y))
}

fn half_along(pad: &Pad, d: Point) -> f64 {
    d.0.abs() * to_mm(pad.bbox.right - pad.bbox.left) / 2.0 + d.1.abs() * to_mm(pad.bbox.bottom - pad.bbox.top) / 2.0
}

fn unit(d: Point) -> Point {
    let n = exact_hypot(d.0, d.1);
    (d.0 / n, d.1 / n)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Side {
    Left,
    Right,
}

impl fmt::Display for Side {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(if *self == Side::Left { "left" } else { "right" })
    }
}

/// Left when `p` is left of heading `h` seen from `m` (y-down coordinates).
fn side(p: Point, m: Point, h: Point) -> Side {
    if h.0 * (p.1 - m.1) - h.1 * (p.0 - m.0) < 0.0 { Side::Left } else { Side::Right }
}

/// The frame of an end: pad centres, their midpoint, the heading and P's offset from the axis (N is minus that).
struct EndFrame {
    d: Point,
    normal: Point,
    p_net: String,
    n_net: String,
    p_centre: Point,
    n_centre: Point,
    mid: Point,
    p_offset: f64,
    default_run: f64,
}

impl EndFrame {
    fn of(board: &Board, end: &EndSpec) -> Result<EndFrame, String> {
        let d = unit(end.dir);
        let normal = (-d.1, d.0);
        let (p, n) = (pad_of(board, &end.reference, &end.p)?, pad_of(board, &end.reference, &end.n)?);
        let (p_centre, n_centre) = (centre(p), centre(n));
        let mid = ((p_centre.0 + n_centre.0) / 2.0, (p_centre.1 + n_centre.1) / 2.0);
        let p_offset = (p_centre.0 - mid.0) * normal.0 + (p_centre.1 - mid.1) * normal.1;
        let default_run = half_along(p, d).max(half_along(n, d)) + RUN_MARGIN;
        Ok(EndFrame { d, normal, p_net: p.net.clone(), n_net: n.net.clone(), p_centre, n_centre, mid, p_offset, default_run })
    }

    /// A point along the heading and across it, from the midpoint.
    fn at(&self, along: f64, across: f64) -> Point {
        (round_to(self.mid.0 + self.d.0 * along + self.normal.0 * across, 4), round_to(self.mid.1 + self.d.1 * along + self.normal.1 * across, 4))
    }
}

struct Draw<'s> {
    session: &'s mut Session,
    width: f64,
}

impl Draw<'_> {
    fn track(&mut self, a: Point, b: Point, net: &str, layer: &str) {
        if exact_hypot(b.0 - a.0, b.1 - a.1) >= LEAST_TRACK_MM {
            self.session.add_track(NewTrack { start: point(a), end: point(b), width: from_mm(self.width), layer: layer.to_string(), net: net.to_string(), locked: true });
        }
    }

    fn via(&mut self, at: Point, net: &str) {
        self.session.add_via(NewVia { at: point(at), size: from_mm(VIA_MM), drill: from_mm(VIA_DRILL_MM), net: net.to_string(), locked: true });
    }

    fn polyline(&mut self, start: Point, middle: &[PathPoint], end: Point, net: &str, layer: &str) {
        let (mut previous, mut on) = (start, layer.to_string());
        for step in middle.iter().cloned().map(Some).chain([None]) {
            let (to, next) = match step {
                Some(PathPoint::Same(x, y)) => ((x, y), on.clone()),
                Some(PathPoint::On(x, y, layer)) => ((x, y), layer),
                None => (end, on.clone()),
            };
            if next != on {
                self.via(previous, net);
            }
            self.track(previous, to, net, &next);
            (previous, on) = (to, next);
        }
    }

    /// From `from`, diverge to +-DROP_OUT, staggered vias, back on the drop layer to +-pitch/2, then FRONT; equal lengths. `k` is 0 for
    /// P, 1 for N; `sign` is the side; `along` where the leg starts, `back` where it is at +-pitch/2 again.
    fn drop(&mut self, frame: &EndFrame, leg: Leg, net: &str, layer: &str, drop: &str) {
        let Leg { from, along, back, sign, k, pitch } = leg;
        let bend = frame.at(along, sign * DROP_OUT);
        let via = frame.at(along + DROP_STAGGER * k, sign * DROP_OUT);
        self.track(from, bend, net, layer);
        self.track(bend, via, net, layer);
        self.via(via, net);
        let rejoin = frame.at(along + DROP_STAGGER, sign * DROP_OUT);
        self.track(via, rejoin, net, drop);
        let axis = frame.at(back, sign * pitch / 2.0);
        self.track(rejoin, axis, net, drop);
        self.track(axis, frame.at(back + FRONT, sign * pitch / 2.0), net, drop);
    }
}

/// One net's last leg of a drop.
struct Leg {
    from: Point,
    along: f64,
    back: f64,
    sign: f64,
    k: f64,
    pitch: f64,
}

fn entry_tracks(draw: &mut Draw, board: &Board, end: &EndSpec, frame: &EndFrame, layer: &str) -> Result<(), String> {
    let (mut entry_p, mut entry_n) = (frame.p_centre, frame.n_centre);
    if let Some(through) = &end.through {
        (entry_p, entry_n) = (centre(pad_of(board, &end.reference, &through.p)?), centre(pad_of(board, &end.reference, &through.n)?));
        draw.track(entry_p, frame.p_centre, &frame.p_net, layer);
        draw.track(entry_n, frame.n_centre, &frame.n_net, layer);
    }
    let Some(link) = &end.link else { return Ok(()) };
    let (link_p, link_n) = (centre(pad_of(board, &link.reference, &link.p)?), centre(pad_of(board, &link.reference, &link.n)?));
    if let Some(paths) = &link.paths {
        draw.polyline(link_p, &paths.p, entry_p, &frame.p_net, layer);
        draw.polyline(link_n, &paths.n, entry_n, &frame.n_net, layer);
        return Ok(());
    }
    // Straight out of the linked pads along dir by link run, then straight to the entry pads.
    for (a, entry, net) in [(link_p, entry_p, &frame.p_net), (link_n, entry_n, &frame.n_net)] {
        let b = (round_to(a.0 + frame.d.0 * link.run, 4), round_to(a.1 + frame.d.1 * link.run, 4));
        draw.track(a, b, net, layer);
        draw.track(b, entry, net, layer);
    }
    Ok(())
}

/// The plain fan. Returns P's tip.
fn straight_fan(draw: &mut Draw, frame: &EndFrame, end: &EndSpec, pitch: f64, run: f64, layer: &str) -> Point {
    let (sign, offset) = (if frame.p_offset >= 0.0 { 1.0 } else { -1.0 }, frame.p_offset.abs());
    let diagonal = (offset - pitch / 2.0).max(0.0);
    for (k, (centre, s, net)) in [(frame.p_centre, sign, &frame.p_net), (frame.n_centre, -sign, &frame.n_net)].into_iter().enumerate() {
        let a = frame.at(run, s * offset);
        let b = frame.at(run + diagonal, s * pitch / 2.0);
        draw.track(centre, a, net, layer);
        draw.track(a, b, net, layer);
        if let Some(drop) = &end.drop {
            let dv = DROP_OUT - pitch / 2.0;
            let along = run + diagonal + dv;
            draw.drop(frame, Leg { from: b, along, back: along + DROP_STAGGER + dv, sign: s, k: k as f64, pitch }, net, layer, drop);
        } else {
            draw.track(b, frame.at(run + diagonal + FRONT, s * pitch / 2.0), net, layer);
        }
    }
    frame.at(run + diagonal + FRONT, sign * pitch / 2.0)
}

/// The crossover fan. Returns P's tip.
fn crossing_fan(draw: &mut Draw, frame: &EndFrame, end: &EndSpec, pitch: f64, run: f64, layer: &str) -> Point {
    let (sign, offset) = (if frame.p_offset >= 0.0 { 1.0 } else { -1.0 }, frame.p_offset.abs());
    let out = offset + CROSS_OUT;
    let (l1, l2, l3) = (out - offset, 2.0 * out, out - pitch / 2.0);
    let length = run + l1 + l2 + l3;
    for (k, (centre, s, net, hop)) in [(frame.p_centre, sign, &frame.p_net, true), (frame.n_centre, -sign, &frame.n_net, false)].into_iter().enumerate() {
        let a = frame.at(run, s * offset);
        let a1 = frame.at(run + l1, s * out);
        let a2 = frame.at(run + l1 + l2, -s * out);
        let a3 = frame.at(length, -s * pitch / 2.0);
        draw.track(centre, a, net, layer);
        draw.track(a, a1, net, layer);
        if hop {
            draw.via(a1, net);
            draw.track(a1, a2, net, CROSS_LAYER);
            draw.via(a2, net);
        } else {
            draw.track(a1, a2, net, layer);
        }
        draw.track(a2, a3, net, layer);
        if let Some(drop) = &end.drop {
            let dv = DROP_OUT - pitch / 2.0;
            draw.drop(frame, Leg { from: a3, along: length + dv, back: length + 2.0 * dv + DROP_STAGGER, sign: -s, k: k as f64, pitch }, net, layer, drop);
        } else {
            draw.track(a3, frame.at(length + FRONT, -s * pitch / 2.0), net, layer);
        }
    }
    frame.at(length + FRONT, -sign * pitch / 2.0)
}

/// Draws the stubs of one end; the report line says what was drawn.
fn fan(session: &mut Session, end: &EndSpec, pair: &PairSpec, cross: bool) -> Result<String, String> {
    let board = session.board.clone();
    let frame = EndFrame::of(&board, end)?;
    let layer = end.fan_layer.as_deref().unwrap_or(&pair.layer);
    let pitch = pair.width + pair.gap;
    let run = end.run.unwrap_or(frame.default_run);
    let mut draw = Draw { session, width: pair.width };
    entry_tracks(&mut draw, &board, end, &frame, layer)?;
    let tip = if cross { crossing_fan(&mut draw, &frame, end, pitch, run, layer) } else { straight_fan(&mut draw, &frame, end, pitch, run, layer) };
    let tail = if cross { " CROSSOVER" } else { "" };
    Ok(format!("  end {} {}/{} dir {:+.0},{:+.0} run {run:.2} P {}{tail}", end.reference, end.p, end.n, frame.d.0, frame.d.1, side(tip, frame.mid, frame.d)))
}

/// Which ends of a pair cross, and whether polarity stays wrong. When P is on the same side of both headings, the first cross_ok end does.
fn crossings(board: &Board, pair: &PairSpec) -> Result<(Vec<bool>, bool), String> {
    let mut cross = vec![false; pair.ends.len()];
    let sides = pair.ends.iter().map(|end| EndFrame::of(board, end).map(|f| side(f.p_centre, f.mid, f.d))).collect::<Result<Vec<_>, _>>()?;
    if sides.len() != 2 || sides[0] != sides[1] {
        return Ok((cross, false));
    }
    let chosen = pair.ends.iter().position(|end| end.cross_ok);
    if let Some(k) = chosen {
        cross[k] = true;
    }
    Ok((cross, chosen.is_none()))
}

/// Draws every pair of `spec`; the lines to print.
pub fn draw(session: &mut Session, spec: &Spec) -> Result<Vec<String>, String> {
    let mut report = Vec::new();
    for pair in &spec.pairs {
        report.push(format!("PAIR {} w {:?} gap {:?} pitch {:?}", pair.base, pair.width, pair.gap, pair.width + pair.gap));
        let (cross, stuck) = crossings(&session.board, pair)?;
        if stuck {
            report.push("  WARN P on the same side of both headings and no cross_ok end: pair_route will fail polarity".to_string());
        }
        for (end, cross) in pair.ends.iter().zip(cross) {
            report.push(fan(session, end, pair, cross)?);
        }
    }
    Ok(report)
}
