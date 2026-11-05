//! Routed-load inputs of the driver estimates: an unqualified screening model. C' = sqrt(Eeff)/(c0 Z0) is the Hammerstad-Jensen outer
//! microstrip with the minimum width and the lower outer-layer value; it does not prove actual inner, voided or distributed load
//! capacitance. A missing stackup leaves C*dV/I unresolved without discarding known IBIS or sourced driver values.
use super::sample::sample_arc;
use super::spec::Spec;
use crate::kicad::geom::{Pt, to_mm};
use crate::si::drivers::Geometry;
use crate::si::impedance::{StackLayer, Stackup, microstrip_pf_per_mm};
use crate::si::py::{g, g_with, hypot};
use std::collections::{BTreeMap, HashMap};

/// A routed track: a straight piece has two points, an arc three.
#[derive(Debug, Clone, PartialEq)]
pub struct TraceRecord {
    pub net: String,
    pub layer: String,
    pub path: Vec<Pt>,
    pub width_mm: f64,
}

fn gcd(a: i128, b: i128) -> i128 {
    if b == 0 { a.abs() } else { gcd(b, a % b) }
}

fn mm(p: Pt) -> (f64, f64) {
    (to_mm(p.x), to_mm(p.y))
}

/// Length of the union of intervals, in the unit they are given.
fn union_length(mut intervals: Vec<(i128, i128)>) -> i128 {
    intervals.sort_unstable();
    let (mut total, mut current) = (0, intervals[0]);
    for (left, right) in intervals.into_iter().skip(1) {
        if left <= current.1 {
            current.1 = current.1.max(right);
        } else {
            total += current.1 - current.0;
            current = (left, right);
        }
    }
    total + current.1 - current.0
}

type LineKey = (String, String, i128, i128, i128);

/// The line of a straight piece, and its span along that line. None for a piece of no length.
fn line_of(a: Pt, e: Pt) -> Option<(i128, i128, i128, (i128, i128))> {
    let (ax, ay, ex, ey) = (a.x as i128, a.y as i128, e.x as i128, e.y as i128);
    let (dx, dy) = (ex - ax, ey - ay);
    let divisor = gcd(dx, dy);
    if divisor == 0 {
        return None;
    }
    let (mut ux, mut uy) = (dx / divisor, dy / divisor);
    if ux < 0 || (ux == 0 && uy < 0) {
        (ux, uy) = (-ux, -uy);
    }
    let (s, t) = (ax * ux + ay * uy, ex * ux + ey * uy);
    Some((ux, uy, ax * uy - ay * ux, (s.min(t), s.max(t))))
}

/// Physical line-union lengths and the narrowest track of each net, for capacitance screening, not a bound. Native coordinates are
/// whole nm: collinear pieces of a net on a layer are united, so duplicated, reversed or split-overlap tracks cannot inflate the
/// load. Exact reversed arcs count once; partial arc overlap, width intersections, pads, vias and pours remain unmodeled.
pub fn routed_trace_summary(records: &[TraceRecord]) -> Result<(BTreeMap<String, f64>, BTreeMap<String, f64>), String> {
    let mut lines: Vec<(LineKey, Vec<(i128, i128)>)> = Vec::new();
    let mut line_at: HashMap<LineKey, usize> = HashMap::new();
    let mut arcs: Vec<((String, String, Vec<Pt>), f64)> = Vec::new();
    let mut widths: BTreeMap<String, f64> = BTreeMap::new();
    for r in records {
        if !r.width_mm.is_finite() || r.width_mm <= 0.0 {
            return Err("trace geometry: invalid native width".to_string());
        }
        if !matches!(r.path.len(), 2 | 3) {
            return Err("trace geometry: invalid native path".to_string());
        }
        let width = widths.entry(r.net.clone()).or_insert(f64::INFINITY);
        *width = width.min(r.width_mm);
        let (a, e) = (r.path[0], r.path[r.path.len() - 1]);
        if r.path.len() == 3 {
            let m = r.path[1];
            if (m.x - a.x) as i128 * (e.y - a.y) as i128 != (m.y - a.y) as i128 * (e.x - a.x) as i128 {
                let reversed: Vec<Pt> = r.path.iter().rev().copied().collect();
                let forward = (r.path[0].x, r.path[0].y, r.path[1].x, r.path[1].y) <= (reversed[0].x, reversed[0].y, reversed[1].x, reversed[1].y);
                let key = (r.net.clone(), r.layer.clone(), if forward { r.path.clone() } else { reversed });
                let length = sample_arc(mm(a), mm(m), mm(e), 1e9).iter().map(|s| s.w).sum();
                match arcs.iter_mut().find(|(k, _)| *k == key) {
                    Some(row) => row.1 = length,
                    None => arcs.push((key, length)),
                }
                continue;
            }
        }
        let Some((ux, uy, offset, span)) = line_of(a, e) else { continue };
        let key = (r.net.clone(), r.layer.clone(), ux, uy, offset);
        let at = *line_at.entry(key.clone()).or_insert_with(|| {
            lines.push((key, Vec::new()));
            lines.len() - 1
        });
        lines[at].1.push(span);
    }
    let mut length: BTreeMap<String, f64> = BTreeMap::new();
    for ((net, _, ux, uy, _), intervals) in lines {
        *length.entry(net).or_default() += union_length(intervals) as f64 / hypot(ux as f64, uy as f64) / 1e6;
    }
    for ((net, _, _), arc) in arcs {
        *length.entry(net).or_default() += arc;
    }
    Ok((length, widths))
}

fn lowest<'a>(w: f64, outer: &'a [(String, StackLayer)]) -> (f64, &'a str, &'a StackLayer) {
    let of = |(layer, d): &'a (String, StackLayer)| (microstrip_pf_per_mm(w, d.h_mm.expect("usable"), d.t_mm.unwrap_or(0.0), d.er.expect("usable")), layer.as_str(), d);
    outer.iter().map(of).reduce(|a, b| if (b.0, b.1) < (a.0, a.1) { b } else { a }).expect("a usable layer")
}

/// D-124d inputs: line-union lengths and the outer layers with a usable dielectric.
pub fn trace_geometry(stackup: Option<&Stackup>, spec: &Spec, records: &[TraceRecord]) -> Result<Geometry, String> {
    let (length_mm, width) = routed_trace_summary(records)?;
    let mut geom = Geometry { length_mm, pf_per_mm: BTreeMap::new() };
    let Some(stackup) = stackup else { return Ok(geom) };
    let usable = |d: &StackLayer| d.h_mm.is_some_and(|v| v.is_finite() && v > 0.0) && d.er.is_some_and(|v| v.is_finite() && v > 0.0) && d.t_mm.is_none_or(|t| t.is_finite() && t >= 0.0);
    let outer: Vec<(String, StackLayer)> = ["F.Cu", "B.Cu"].iter().filter(|l| spec.adjacent_of(l).is_some()).filter_map(|l| stackup.get(*l).filter(|d| usable(d)).map(|d| (l.to_string(), *d))).collect();
    if outer.is_empty() {
        return Ok(geom);
    }
    for (net, w) in width {
        let (value, layer, d) = lowest(w, &outer);
        if !value.is_finite() || value <= 0.0 {
            return Err("trace geometry: invalid modeled capacitance".to_string());
        }
        let text = format!("screening microstrip w {} h {} t {} mm Er {} ({layer}); Hammerstad-Jensen si/impedance.rs; applicability unproved", g(w), g(d.h_mm.expect("usable")), g(d.t_mm.unwrap_or(0.0)), g(d.er.expect("usable")));
        geom.pf_per_mm.insert(net, (value, text));
    }
    Ok(geom)
}

/// D-124c inputs: sampled routed length and the narrowest track of each net.
pub fn d124c_trace_geometry(stackup: Option<&Stackup>, spec: &Spec, routed: BTreeMap<String, f64>, width: &BTreeMap<String, f64>) -> Geometry {
    let mut geom = Geometry { length_mm: routed, pf_per_mm: BTreeMap::new() };
    let Some(stackup) = stackup else { return geom };
    let outer: Vec<(String, StackLayer)> = spec.adjacent.iter().filter_map(|(l, _)| stackup.get(l).filter(|d| d.h_mm.is_some_and(|v| v != 0.0) && d.er.is_some_and(|v| v != 0.0)).map(|d| (l.clone(), *d))).collect();
    if outer.is_empty() {
        return geom;
    }
    for (net, w) in width {
        let (value, layer, d) = lowest(*w, &outer);
        let text = format!("microstrip w {} h {} t {} mm Er {} ({layer} stackup), C' = sqrt(Eeff)/(c0 Z0), Hammerstad-Jensen (si/impedance.rs)", g_with(*w, 3), g(d.h_mm.expect("usable")), g(d.t_mm.unwrap_or(0.0)), g(d.er.expect("usable")));
        geom.pf_per_mm.insert(net.clone(), (value, text));
    }
    geom
}
