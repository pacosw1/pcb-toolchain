//! si-pairs: impedance and reference-plane gate for differential pairs.
//!
//! KiCad DRC checks the pair geometry (track_width, diff_pair_gap, diff_pair_uncoupled, skew, via_count, length) from the board
//! .kicad_dru. This checks only what KiCad does not:
//!   - Zdiff: the differential impedance that the track_width / diff_pair_gap window of the pair DRU rule gives with the board
//!     stackup, against the target,
//!   - reference: the part of each leg that has the reference plane net under it on the adjacent layer.
//! It also checks the reference plane under single-ended fast nets (for example SPI clocks).
//!
//! Spec: see hardware-design/boards/BASE-PWR/diff-pairs.json. Two opt-in keys, on a pair entry or at the spec top level (a pair
//! entry overrides the top level):
//!   "exempt_areas": [{"layer": "F.Cu" or "*", "rect": [x1, y1, x2, y2], "reason": "..."}]
//!     Track length inside the rect on that layer does not count in the reference-plane coverage. An area that removes no length
//!     from any pair is stale: the tool stops with exit 2.
//!   "via_antipad_allowance": true
//!     Track length within (via pad radius + the plane zone clearance to the via) of a via of the same net does not count as
//!     uncovered (it still counts as track length). A plated through-hole pad of the same net (for example an RJ45 pin) counts
//!     as a via: its antipad cuts the planes too (NET-CORE 2026-10-31). A WARN line prints when this removes more than 1.5 mm of
//!     a single via's own allowance.
use super::impedance::{Stackup, microstrip_zdiff, parse_stackup, stripline_zdiff};
use super::json::Json;
use super::py::{TAU, dist, modulo};
use crate::kicad::board::{Board, RoutedCopper, Zone};
use crate::kicad::geom::{FillIndex, Pt, from_mm, to_mm};
use crate::kicad::pad::PadKind;
use regex_lite::Regex;
use std::collections::BTreeMap;

const VIA_ANTIPAD_WARN_MM: f64 = 1.5;
const STEP_MM: f64 = 0.05;

/// One straight piece of a net; an arc comes as short chords.
#[derive(Debug, Clone, PartialEq)]
pub struct Seg {
    pub layer: String,
    pub a: (f64, f64),
    pub b: (f64, f64),
}

/// A via or through-hole pad: where, and its allowance radius.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Antipad {
    pub x: f64,
    pub y: f64,
    pub r: f64,
}

/// Is copper of one of these nets at this point of this layer?
pub type RefAt<'a> = dyn Fn(&str, f64, f64, &[String]) -> bool + 'a;

pub struct PairBoard<'a> {
    pub stackup: Stackup,
    pub nets: BTreeMap<String, Vec<Seg>>,
    pub ref_at: Box<RefAt<'a>>,
    pub dru: String,
    pub vias: BTreeMap<String, Vec<Antipad>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub item: String,
    pub check: String,
    pub status: &'static str,
    pub detail: String,
}

fn row(item: &str, check: &str, status: &'static str, detail: String) -> Row {
    Row { item: item.to_string(), check: check.to_string(), status, detail }
}

/// The circle arc through three points, as points with chords of at most max_chord mm.
pub fn arc_points(start: (f64, f64), mid: (f64, f64), end: (f64, f64), max_chord: f64) -> Vec<(f64, f64)> {
    let Some(circle) = Circle::through(start, mid, end) else { return vec![start, end] };
    let (a0, am, a1) = (circle.angle(start), circle.angle(mid), circle.angle(end));
    let ccw = |a: f64, b: f64| modulo(b - a, TAU);
    let sweep = if ccw(a0, am) < ccw(a0, a1) { ccw(a0, a1) } else { -ccw(a1, a0) };
    let k = ((sweep.abs() * circle.r / max_chord).ceil() as usize).max(1);
    let inner = (1..k).map(|i| circle.at(a0 + sweep * i as f64 / k as f64));
    std::iter::once(start).chain(inner).chain(std::iter::once(end)).collect()
}

/// The circle through three points. None when they lie on a line.
#[derive(Debug, Clone, Copy)]
pub struct Circle {
    pub x: f64,
    pub y: f64,
    pub r: f64,
}

impl Circle {
    pub fn through(a: (f64, f64), b: (f64, f64), c: (f64, f64)) -> Option<Circle> {
        let (x, y) = Circle::center(a, b, c)?;
        Some(Circle { x, y, r: dist((x, y), a) })
    }

    pub fn center((ax, ay): (f64, f64), (bx, by): (f64, f64), (cx, cy): (f64, f64)) -> Option<(f64, f64)> {
        let d = 2.0 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
        if d.abs() < 1e-12 {
            return None;
        }
        let (a2, b2, c2) = (ax * ax + ay * ay, bx * bx + by * by, cx * cx + cy * cy);
        Some(((a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d, (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d))
    }

    pub fn angle(&self, p: (f64, f64)) -> f64 {
        (p.1 - self.y).atan2(p.0 - self.x)
    }

    pub fn at(&self, angle: f64) -> (f64, f64) {
        (self.x + self.r * angle.cos(), self.y + self.r * angle.sin())
    }
}

/// Points along every segment: layer, x, y and the length it stands for.
fn samples(segs: &[Seg], step: f64) -> impl Iterator<Item = (&str, f64, f64, f64)> + '_ {
    segs.iter().flat_map(move |s| {
        let length = dist(s.a, s.b);
        let k = ((length / step).ceil() as usize).max(1);
        (0..k).map(move |i| {
            let t = (i as f64 + 0.5) / k as f64;
            (s.layer.as_str(), s.a.0 + t * (s.b.0 - s.a.0), s.a.1 + t * (s.b.1 - s.a.1), length / k as f64)
        })
    })
}

/// The via-antipad allowance radius: half the via width, plus the largest zone clearance that applies to it.
pub fn via_antipad_radius(width_mm: f64, clearances_mm: &[f64]) -> f64 {
    width_mm / 2.0 + clearances_mm.iter().copied().fold(None, |m: Option<f64>, c| Some(m.map_or(c, |m| if c > m { c } else { m }))).unwrap_or(0.0)
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExemptArea {
    /// Which area this is: an area is counted by identity, two alike are two.
    id: usize,
    layer: String,
    rect: [f64; 4],
    reason: String,
    raw: Json,
}

impl ExemptArea {
    fn covers(&self, layer: &str, x: f64, y: f64) -> bool {
        let [x1, y1, x2, y2] = self.rect;
        (self.layer == "*" || self.layer == layer) && x1.min(x2) <= x && x <= x1.max(x2) && y1.min(y2) <= y && y <= y1.max(y2)
    }
}

/// The nearest via whose allowance radius covers this point.
fn nearest_via(x: f64, y: f64, vias: &[Antipad]) -> Option<usize> {
    let mut best: Option<(usize, f64)> = None;
    for (i, v) in vias.iter().enumerate() {
        let d = dist((x, y), (v.x, v.y));
        if d <= v.r && best.is_none_or(|(_, b)| d < b) {
            best = Some((i, d));
        }
    }
    best.map(|(i, _)| i)
}

/// Reference-plane coverage of one net, with exempt areas and the via-antipad allowance applied.
#[derive(Debug, Default)]
pub struct Coverage {
    pub tot: f64,
    pub hit: f64,
    pub pct: f64,
    /// Length left out of tot and hit for an exempt area, by area id.
    pub exempted: f64,
    pub area_len: Vec<(usize, f64)>,
    /// Length that failed the reference check but sits inside a same-net via's allowance; it still counts in tot and hit.
    pub allowed: f64,
    pub via_len: Vec<(usize, f64)>,
}

/// `percent` of hit in tot: a full cover is exactly 100.
fn percent(hit: f64, tot: f64) -> f64 {
    if tot != 0.0 { 100.0 * (hit / tot) } else { 0.0 }
}

pub fn coverage_detail(segs: &[Seg], layers: &[Layer], refs: &[String], ref_at: &RefAt, areas: &[ExemptArea], vias: &[Antipad]) -> Coverage {
    let mut c = Coverage::default();
    for (layer, x, y, length) in samples(segs, STEP_MM) {
        if let Some(area) = areas.iter().find(|a| a.covers(layer, x, y)) {
            c.exempted += length;
            super::py::count(&mut c.area_len, area.id, length);
            continue;
        }
        c.tot += length;
        let spec = layers.iter().find(|l| l.name == layer).expect("the layers were checked");
        if ref_at(&spec.ref_layer, x, y, refs) {
            c.hit += length;
        } else if let Some(via) = nearest_via(x, y, vias) {
            c.hit += length;
            c.allowed += length;
            super::py::count(&mut c.via_len, via, length);
        }
    }
    c.pct = percent(c.hit, c.tot);
    c
}

/// The min, opt and max of one DRU constraint, in file order.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Limits(pub Vec<(String, f64)>);

impl Limits {
    fn get(&self, name: &str) -> Option<f64> {
        self.0.iter().rev().find(|(k, _)| k == name).map(|(_, v)| *v)
    }

    /// Python's repr of the {min, opt, max} dict.
    fn repr(&self) -> String {
        let mut unique: Vec<&(String, f64)> = Vec::new();
        for item in &self.0 {
            if !unique.iter().any(|u| u.0 == item.0) {
                unique.push(item);
            }
        }
        let text: Vec<String> = unique.iter().map(|(k, _)| format!("'{k}': {}", super::py::float_repr(self.get(k).expect("a listed key")))).collect();
        format!("{{{}}}", text.join(", "))
    }
}

pub type DruRule = BTreeMap<String, Limits>;

/// The constraints of the rule with this name in a .kicad_dru text, in mm.
pub fn parse_dru_rule(text: &str, name: &str) -> Result<DruRule, String> {
    let lines: Vec<&str> = text.lines().filter(|line| !line.trim_start().starts_with('#')).collect();
    let text = lines.join("\n");
    let head = Regex::new(&format!(r#"\(rule\s+"{}""#, regex_lite::escape(name))).expect("an escaped name");
    let found = head.find(&text).ok_or_else(|| format!("rule \"{name}\" not found in the .kicad_dru"))?;
    let body = &text[found.end()..];
    let next = Regex::new(r#"\(rule\s+""#).expect("a fixed pattern");
    let body = &body[..next.find(body).map_or(body.len(), |m| m.start())];
    let constraint = Regex::new(r"\(constraint\s+(\w+)((?:\s*\((?:min|opt|max)\s+[\d.]+(?:mm)?\))*)").expect("a fixed pattern");
    let limit = Regex::new(r"\((min|opt|max)\s+([\d.]+)").expect("a fixed pattern");
    let mut out = DruRule::new();
    for c in constraint.captures_iter(body) {
        let limits = limit.captures_iter(&c[2]).map(|l| Ok((l[1].to_string(), l[2].parse().map_err(|_| format!("not a number: {}", &l[2]))?)));
        out.insert(c[1].to_string(), Limits(limits.collect::<Result<_, String>>()?));
    }
    Ok(out)
}

/// One stackup layer of the spec.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Layer {
    pub name: String,
    pub model: String,
    pub t_mm: Option<f64>,
    pub h_mm: Option<f64>,
    pub b_mm: Option<f64>,
    pub er: Option<f64>,
    pub ref_layer: String,
    pub mask_factor_diff: f64,
}

/// Stops when a spec layer value differs from the board stackup by more than 1 %.
pub fn check_stackup(layers: &[Layer], board: &Stackup) -> Result<(), String> {
    let mut bad = Vec::new();
    for layer in layers {
        let Some(got) = board.get(&layer.name) else {
            bad.push(format!("{}: not in the board stackup", layer.name));
            continue;
        };
        for (key, spec, value) in [("t_mm", layer.t_mm, got.t_mm), ("h_mm", layer.h_mm, got.h_mm), ("er", layer.er, got.er)] {
            let Some(spec) = spec else { continue };
            if value.is_none_or(|v| (v - spec).abs() > 0.01 * spec) {
                bad.push(format!("{} {key}: spec {} board {}", layer.name, super::py::float_repr(spec), value.map_or("None".to_string(), super::py::float_repr)));
            }
        }
    }
    if bad.is_empty() { Ok(()) } else { Err(format!("stackup mismatch (spec vs .kicad_pcb): {}", bad.join("; "))) }
}

fn need(value: Option<f64>, key: &str) -> Result<f64, String> {
    value.ok_or_else(|| format!("KeyError: '{key}'"))
}

pub fn zdiff(layer: &Layer, w: f64, s: f64) -> Result<f64, String> {
    let (t, er) = (need(layer.t_mm, "t_mm"), need(layer.er, "er"));
    match layer.model.as_str() {
        "microstrip" => Ok(layer.mask_factor_diff * microstrip_zdiff(w, s, need(layer.h_mm, "h_mm")?, t?, er?)),
        "stripline" => Ok(stripline_zdiff(w, s, need(layer.b_mm, "b_mm")?, t?, er?)),
        model => Err(format!("no impedance model \"{model}\" for a pair on this layer")),
    }
}

/// Low, nominal and high Zdiff over the track_width x diff_pair_gap window of a DRU rule. Z falls when the width grows and rises
/// when the gap grows. A missing min or max counts as opt.
pub fn zdiff_window(layer: &Layer, rule: &DruRule) -> Result<(f64, f64, f64), String> {
    let opt = |name: &str| rule.get(name).and_then(|l| l.get("opt").map(|o| (l, o)));
    let (Some((w, wo)), Some((gap, go))) = (opt("track_width"), opt("diff_pair_gap")) else {
        return Err("the pair rule needs track_width and diff_pair_gap with an opt value".to_string());
    };
    Ok((
        zdiff(layer, w.get("max").unwrap_or(wo), gap.get("min").unwrap_or(go))?,
        zdiff(layer, wo, go)?,
        zdiff(layer, w.get("min").unwrap_or(wo), gap.get("max").unwrap_or(go))?,
    ))
}

/// What a pair or net entry and the spec top level say about exemptions and allowances.
#[derive(Debug, Clone, PartialEq)]
struct Entry {
    name: String,
    reference: Json,
    min_ref_pct: Json,
    areas: Option<Vec<ExemptArea>>,
    allowance: Option<bool>,
}

#[derive(Debug, Clone, PartialEq)]
struct Pair {
    entry: Entry,
    p: String,
    n: String,
    z_diff: Json,
    tol_pct: Json,
    dru_rule: String,
}

#[derive(Debug, Clone, PartialEq)]
struct SingleNet {
    entry: Entry,
    net: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PairSpec {
    layers: Vec<Layer>,
    areas: Vec<ExemptArea>,
    allowance: bool,
    pairs: Vec<Pair>,
    nets: Vec<SingleNet>,
}

fn field<'a>(json: &'a Json, key: &str) -> Result<&'a Json, String> {
    json.get(key).ok_or_else(|| format!("KeyError: '{key}'"))
}

fn text_field(json: &Json, key: &str) -> Result<String, String> {
    Ok(field(json, key)?.text())
}

fn read_layer(name: &str, json: &Json) -> Result<Layer, String> {
    let number = |key: &str| json.get(key).and_then(Json::as_f64);
    Ok(Layer {
        name: name.to_string(),
        model: text_field(json, "model")?,
        t_mm: number("t_mm"),
        h_mm: number("h_mm"),
        b_mm: number("b_mm"),
        er: number("er"),
        ref_layer: text_field(json, "ref_layer")?,
        mask_factor_diff: number("mask_factor_diff").unwrap_or(1.0),
    })
}

fn read_area(json: &Json, id: usize) -> Result<ExemptArea, String> {
    let reason = json.get("reason").map_or(String::new(), Json::text);
    if reason.trim().is_empty() {
        return Err(format!("exempt_areas: a written reason is required ({})", json.repr()));
    }
    let rect: Vec<f64> = field(json, "rect")?.as_arr().unwrap_or(&[]).iter().filter_map(Json::as_f64).collect();
    let rect = <[f64; 4]>::try_from(rect).map_err(|_| "exempt_areas: rect needs four numbers".to_string())?;
    Ok(ExemptArea { id, layer: json.get("layer").map_or("*".to_string(), Json::text), rect, reason, raw: json.clone() })
}

fn read_areas(json: &Json, next_id: &mut usize) -> Result<Vec<ExemptArea>, String> {
    let list = json.as_arr().ok_or("exempt_areas must be a list")?;
    let mut out = Vec::new();
    for area in list {
        out.push(read_area(area, *next_id)?);
        *next_id += 1;
    }
    Ok(out)
}

fn read_entry(json: &Json, next_id: &mut usize) -> Result<Entry, String> {
    Ok(Entry {
        name: text_field(json, "name")?,
        reference: field(json, "reference")?.clone(),
        min_ref_pct: json.get("min_ref_pct").cloned().unwrap_or(Json::Int(100)),
        areas: json.get("exempt_areas").map(|a| read_areas(a, next_id)).transpose()?,
        allowance: json.get("via_antipad_allowance").map(Json::truthy),
    })
}

impl PairSpec {
    pub fn read(json: &Json) -> Result<PairSpec, String> {
        let stackup = field(field(json, "stackup")?, "layers")?.as_obj().ok_or("stackup layers must be an object")?;
        let layers = stackup.iter().map(|(name, l)| read_layer(name, l)).collect::<Result<_, _>>()?;
        let mut next_id = 0;
        let areas = json.get("exempt_areas").map_or(Ok(Vec::new()), |a| read_areas(a, &mut next_id))?;
        let list = |key: &str| json.get(key).and_then(Json::as_arr).unwrap_or(&[]).to_vec();
        let mut pairs = Vec::new();
        for pr in list("pairs") {
            pairs.push(Pair {
                entry: read_entry(&pr, &mut next_id)?,
                p: text_field(&pr, "p")?,
                n: text_field(&pr, "n")?,
                z_diff: field(&pr, "z_diff")?.clone(),
                tol_pct: field(&pr, "tol_pct")?.clone(),
                dru_rule: text_field(&pr, "dru_rule")?,
            });
        }
        let mut nets = Vec::new();
        for ne in list("nets") {
            nets.push(SingleNet { entry: read_entry(&ne, &mut next_id)?, net: text_field(&ne, "net")? });
        }
        Ok(PairSpec { layers, areas, allowance: json.get("via_antipad_allowance").is_some_and(Json::truthy), pairs, nets })
    }

    /// The nets the spec reads.
    pub fn net_names(&self) -> Vec<String> {
        self.pairs.iter().flat_map(|p| [p.p.clone(), p.n.clone()]).chain(self.nets.iter().map(|n| n.net.clone())).collect()
    }
}

fn net_segs<'a>(board: &'a PairBoard, name: &str) -> Result<&'a [Seg], String> {
    board.nets.get(name).filter(|s| !s.is_empty()).map(Vec::as_slice).ok_or_else(|| format!("net {name} has no tracks on the board"))
}

fn check_layers(segs: &[&[Seg]], layers: &[Layer]) -> Result<(), String> {
    for seg in segs.iter().copied().flatten() {
        if !layers.iter().any(|l| l.name == seg.layer) {
            return Err(format!("track on {} but the spec has no entry for {}", seg.layer, seg.layer));
        }
    }
    Ok(())
}

fn references(entry: &Entry) -> Vec<String> {
    entry.reference.strings().unwrap_or_else(|| vec![entry.reference.text()])
}

/// A stale area is one that removed no length from any pair, also one no entry ends up using.
struct AreaTotals(Vec<(ExemptArea, f64)>);

impl AreaTotals {
    fn register(&mut self, areas: &[ExemptArea]) {
        for area in areas {
            if !self.0.iter().any(|(a, _)| a.id == area.id) {
                self.0.push((area.clone(), 0.0));
            }
        }
    }

    fn add(&mut self, id: usize, length: f64) {
        if let Some(total) = self.0.iter_mut().find(|(a, _)| a.id == id) {
            total.1 += length;
        }
    }

    fn check(&self) -> Result<(), String> {
        let Some((a, _)) = self.0.iter().find(|(_, length)| *length <= 0.0) else { return Ok(()) };
        let reason = a.raw.get("reason").map_or(a.reason.clone(), Json::text);
        Err(format!("STALE exempt_area {} {} ({reason}): removes no length from any pair", a.layer, field(&a.raw, "rect")?.repr()))
    }
}

fn reference_row(item: &str, check: &str, entry: &Entry, cov: &Coverage) -> Row {
    let limit = entry.min_ref_pct.as_f64().unwrap_or(100.0);
    let detail = format!("{:.1} % of the length over {} (min {} %)", (cov.pct * 10.0).floor() / 10.0, entry.reference.text(), entry.min_ref_pct.text());
    row(item, check, if cov.pct >= limit { "PASS" } else { "FAIL" }, detail)
}

struct Evaluation<'a> {
    spec: &'a PairSpec,
    board: &'a PairBoard<'a>,
    totals: AreaTotals,
    rows: Vec<Row>,
}

impl Evaluation<'_> {
    /// The reference rows of one entry and, when opted in, its exempt-area and via-antipad-allowance notes.
    fn reference_rows(&mut self, entry: &Entry, legs: &[(&str, &str, &[Seg])]) {
        let areas = entry.areas.as_ref().unwrap_or(&self.spec.areas);
        self.totals.register(areas);
        let allow = entry.allowance.unwrap_or(self.spec.allowance);
        let refs = references(entry);
        let (mut exempted, mut allowed) = (0.0, 0.0);
        let mut via_len: Vec<(Antipad, f64)> = Vec::new();
        for (check, net_name, segs) in legs {
            let vias = if allow { self.board.vias.get(*net_name).map_or(&[][..], Vec::as_slice) } else { &[] };
            let cov = coverage_detail(segs, &self.spec.layers, &refs, &*self.board.ref_at, areas, vias);
            self.rows.push(reference_row(&entry.name, check, entry, &cov));
            exempted += cov.exempted;
            allowed += cov.allowed;
            for (id, length) in &cov.area_len {
                self.totals.add(*id, *length);
            }
            for (via, length) in &cov.via_len {
                super::py::count(&mut via_len, vias[*via], *length);
            }
        }
        if !areas.is_empty() {
            self.rows.push(row(&entry.name, "exempt area", "INFO", format!("{exempted:.2} mm exempted from the reference check")));
        }
        if allow {
            self.rows.push(row(&entry.name, "via antipad", "INFO", format!("{allowed:.2} mm allowed near a same-net via")));
            for (via, length) in via_len.iter().filter(|(_, length)| *length > VIA_ANTIPAD_WARN_MM) {
                let text = format!("{length:.2} mm allowed near one via at ({:.2}, {:.2}) (over the {VIA_ANTIPAD_WARN_MM} mm bound)", via.x, via.y);
                self.rows.push(row(&entry.name, "via antipad", "WARN", text));
            }
        }
    }

    fn pair(&mut self, pr: &Pair) -> Result<(), String> {
        let (p, n) = (net_segs(self.board, &pr.p)?, net_segs(self.board, &pr.n)?);
        check_layers(&[p, n], &self.spec.layers)?;
        let rule = parse_dru_rule(&self.board.dru, &pr.dru_rule)?;
        let (target, tol_pct) = (pr.z_diff.as_f64().ok_or("z_diff must be a number")?, pr.tol_pct.as_f64().ok_or("tol_pct must be a number")?);
        let tol = tol_pct / 100.0 * target;
        let names: std::collections::BTreeSet<&str> = p.iter().chain(n).map(|s| s.layer.as_str()).collect();
        for name in names {
            let layer = self.spec.layers.iter().find(|l| l.name == name).expect("the layers were checked");
            let (lo, nom, hi) = zdiff_window(layer, &rule)?;
            let ok = target - tol <= lo && hi <= target + tol;
            let detail = format!("{nom:.1} ohm (window {lo:.1}..{hi:.1}, target {} +-{} %) rule \"{}\" w {} gap {}", pr.z_diff.text(), pr.tol_pct.text(), pr.dru_rule, rule["track_width"].repr(), rule["diff_pair_gap"].repr());
            self.rows.push(row(&pr.entry.name, &format!("zdiff {name}"), if ok { "PASS" } else { "FAIL" }, detail));
        }
        self.reference_rows(&pr.entry, &[("reference p", &pr.p, p), ("reference n", &pr.n, n)]);
        Ok(())
    }

    fn net(&mut self, ne: &SingleNet) -> Result<(), String> {
        let segs = net_segs(self.board, &ne.net)?;
        check_layers(&[segs], &self.spec.layers)?;
        self.reference_rows(&ne.entry, &[("reference", &ne.net, segs)]);
        Ok(())
    }
}

/// The result rows. An Err is a spec or board problem: no verdict.
pub fn evaluate(spec: &PairSpec, board: &PairBoard) -> Result<Vec<Row>, String> {
    check_stackup(&spec.layers, &board.stackup)?;
    let mut run = Evaluation { spec, board, totals: AreaTotals(Vec::new()), rows: Vec::new() };
    run.totals.register(&spec.areas); // so an area every pair opts out of still shows as stale
    for pr in &spec.pairs {
        run.pair(pr)?;
    }
    for ne in &spec.nets {
        run.net(ne)?;
    }
    run.totals.check()?;
    Ok(run.rows)
}

fn millimetres(p: Pt) -> (f64, f64) {
    (to_mm(p.x), to_mm(p.y))
}

/// The segments of the named nets; an arc comes as chords.
fn collect_segs(board: &Board, names: &[String]) -> BTreeMap<String, Vec<Seg>> {
    let mut nets: BTreeMap<String, Vec<Seg>> = names.iter().map(|n| (n.clone(), Vec::new())).collect();
    for copper in &board.copper {
        let RoutedCopper::Track(t) = copper else { continue };
        let Some(segs) = nets.get_mut(&t.net) else { continue };
        let (a, b) = (millimetres(t.start), millimetres(t.end));
        let points = t.mid.map_or(vec![a, b], |m| arc_points(a, millimetres(m), b, STEP_MM));
        segs.extend(points.windows(2).map(|w| Seg { layer: t.layer.clone(), a: w[0], b: w[1] }));
    }
    nets
}

/// The local clearance of a zone: a rule area has none.
fn zone_clearance(zone: &Zone) -> f64 {
    zone.fill.as_ref().map_or(0.0, |f| to_mm(f.clearance))
}

/// Per-net via records for the via-antipad allowance: the width on F.Cu and the clearance of every zone that shares a copper
/// layer of the via. This reads the zone's own clearance, not the resolved DRC clearance (net class, board minimum, ...). A
/// plated through-hole pad cuts the planes like a via; its width is the larger pad dimension. SMD pads do not cut the planes.
pub fn collect_vias(board: &Board) -> BTreeMap<String, Vec<Antipad>> {
    let mut vias: BTreeMap<String, Vec<Antipad>> = BTreeMap::new();
    let mut add = |net: &str, at: Pt, width_mm: f64, layers: &[String]| {
        let clearances: Vec<f64> = board.zones.iter().filter(|z| z.layers.iter().any(|l| layers.contains(l))).map(zone_clearance).collect();
        let (x, y) = millimetres(at);
        vias.entry(net.to_string()).or_default().push(Antipad { x, y, r: via_antipad_radius(width_mm, &clearances) });
    };
    for copper in &board.copper {
        if let RoutedCopper::Via(v) = copper
            && !v.net.is_empty()
        {
            add(&v.net, v.at, to_mm(v.size), &board.copper_layers);
        }
    }
    for (_, pad) in board.pads().filter(|(_, p)| p.kind == PadKind::ThroughHole && !p.net.is_empty()) {
        add(&pad.net, pad.position, to_mm(pad.size.x.max(pad.size.y)), &pad.layers);
    }
    vias
}

/// The filled copper of each zone, for point tests by layer and net.
fn zone_hit_test(board: &Board) -> impl Fn(&str, f64, f64, &[String]) -> bool + '_ {
    let fills: Vec<(&str, &str, FillIndex)> = board.zones.iter()
        .flat_map(|z| z.filled.iter().map(move |f| (z.net.as_str(), f.layer.as_str(), FillIndex::new(&f.polygons))))
        .collect();
    move |layer, x, y, nets| {
        let at = Pt::new(from_mm(x), from_mm(y));
        fills.iter().any(|(net, on, fill)| *on == layer && nets.iter().any(|n| n == net) && fill.contains(at))
    }
}

/// The checker's view of a board: nets, vias and the stackup of its file text.
pub fn pair_board<'a>(board: &'a Board, text: &str, dru: String, names: &[String]) -> Result<PairBoard<'a>, String> {
    let stackup = parse_stackup(text)?.ok_or("board has no (stackup) section")?;
    let nets = collect_segs(board, names);
    let vias = collect_vias(board).into_iter().filter(|(n, _)| nets.contains_key(n)).collect();
    Ok(PairBoard { stackup, nets, ref_at: Box::new(zone_hit_test(board)), dru, vias })
}

/// The report lines of a finished check, then the exit code: 0 all pass, 1 a FAIL.
pub fn report(rows: &[Row], verbose: bool) -> (Vec<String>, i32) {
    let pad = |text: &str, width: usize| format!("{text}{}", " ".repeat(width.saturating_sub(text.chars().count())));
    let mut lines: Vec<String> = rows.iter().filter(|r| verbose || r.status != "PASS")
        .map(|r| format!("{} {} {} {}", pad(r.status, 4), pad(&r.item, 12), pad(&r.check, 14), r.detail)).collect();
    let (fails, passes) = (rows.iter().filter(|r| r.status == "FAIL").count(), rows.iter().filter(|r| r.status == "PASS").count());
    lines.push(format!("si_pairs: {passes} PASS, {fails} FAIL"));
    (lines, i32::from(fails > 0))
}

#[cfg(test)]
mod tests;
