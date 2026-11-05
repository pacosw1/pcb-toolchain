//! The findings. The gate counts only the D-124c screen: sampled crossings, the grid detour with ground-via portals, "a run with no
//! detour (a stub) passes at any edge", and an "edge_classes" class applied to its nets directly. The D-124d proposal runs beside it;
//! its extra findings are report-only (WARN lines, not counted). A finding of the enforced screen is never dropped.
use super::sample::{NetResult, Run};
use super::spec::Spec;
use crate::si::drivers::Edge;
use crate::si::py::{dist, first_max, g};
use std::collections::BTreeMap;

/// Results keyed (layer, net), in the order the board gives them.
pub type Results = Vec<((String, String), NetResult)>;
pub type Domains = BTreeMap<String, Option<String>>;
pub type Edges = BTreeMap<String, Edge>;
/// Layer, domain, run and budget: the detour in mm, or None over budget or unreachable.
pub type Detour<'a> = dyn FnMut(&str, &str, &Run, f64) -> Option<f64> + 'a;

fn class_label(spec: &Spec, name: &str) -> (Option<f64>, String) {
    let r = spec.rates.get(name).expect("a checked spec names known classes");
    (Some(r.tr_ns), format!("class {name}, tr {} ns{}", g(r.tr_ns), if r.assumption { ", assumption" } else { "" }))
}

fn edge_label(edge: Option<&Edge>) -> (Option<f64>, String) {
    match edge {
        None => (None, "driver not looked up".to_string()),
        Some(Edge::Unknown(reason)) => (None, reason.clone()),
        Some(Edge::Known { edge_ns, driver }) => (Some(*edge_ns), format!("driver {driver}")),
    }
}

/// D-124c: the "edge_classes" class of the net, else its driver edge.
fn d124c_net_edge(net: &str, spec: &Spec, edges: &Edges) -> (Option<f64>, String) {
    spec.edge_class(net).map_or_else(|| edge_label(edges.get(net)), |k| class_label(spec, k))
}

/// D-124d: a protocol class with no looked-up edge, else the looked-up edge.
pub fn net_edge_of(net: &str, spec: &Spec, edges: &Edges) -> (Option<f64>, String) {
    match spec.edge_class(net).filter(|k| !edges.contains_key(net) && spec.rates.get(k).is_some_and(|r| r.is_protocol())) {
        Some(k) => class_label(spec, k),
        None => edge_label(edges.get(net)),
    }
}

fn detour_text(d: Option<f64>) -> String {
    d.map_or("none (no reference path)".to_string(), |d| format!("{d:.1} mm"))
}

/// The detour of a run: a fine grid first, then up to the board size. None when unreachable.
fn measure(detour: &mut Detour, layer: &str, domain: &str, run: &Run, board_mm: f64) -> Option<f64> {
    [20.0, board_mm].into_iter().find_map(|budget| detour(layer, domain, run, budget))
}

/// A line with the length it sorts by.
type Ranked = (f64, String);

#[derive(Default)]
struct Lines {
    nodom: Vec<String>,
    cross: Vec<Ranked>,
    gaps: Vec<Ranked>,
}

impl Lines {
    fn finish(mut self) -> Vec<String> {
        let by_size = |a: &Ranked, b: &Ranked| b.0.total_cmp(&a.0).then_with(|| b.1.cmp(&a.1));
        self.nodom.sort();
        self.cross.sort_by(by_size);
        self.gaps.sort_by(by_size);
        self.nodom.into_iter().chain(self.cross.into_iter().map(|c| c.1)).chain(self.gaps.into_iter().map(|c| c.1)).collect()
    }

    /// The rules every screen shares. Returns the domain when the net goes on to the edge rules.
    fn common<'a>(&mut self, layer: &str, net: &str, r: &NetResult, domains: &'a Domains, spec: &Spec, seen: &mut Vec<String>) -> Option<&'a str> {
        if !spec.checked(net) {
            return None;
        }
        let power = spec.is_power(net);
        let Some(domain) = domains.get(net).and_then(|d| d.as_deref()) else {
            if !power && !seen.iter().any(|n| n == net) {
                seen.push(net.to_string());
                self.nodom.push(format!("FAIL no-domain {net}: no pad in a ground zone outline; set \"domains\" or \"exempt\""));
            }
            return None;
        };
        if r.cross > 0.0 {
            self.cross.push((r.cross, format!("FAIL domain-cross {layer} {net}: {:.1} mm over {} (domain {domain})", r.cross, r.cross_net.as_deref().unwrap_or(""))));
        }
        if power {
            return None;
        }
        if spec.is_fast(net) {
            if r.worst > 0.0 {
                let (x, y) = r.worst_at.expect("a worst run has a place");
                self.gaps.push((r.worst, format!("FAIL fast-crossing {layer} {net}: {} crossings, longest {:.2} mm at ({x:.1}, {y:.1}) (a fast net may cross no gap, void or slot)", r.runs.len().max(1), r.worst)));
            }
            return None;
        }
        Some(domain)
    }

    /// The edge budget rule of a net with a known edge.
    fn over_budget(&mut self, spec: &Spec, (layer, net): (&str, &str), domain: &str, r: &NetResult, tr: f64, label: &str, board_mm: f64, detour: &mut Detour) -> Result<(), String> {
        let budget = spec.rates.budget_mm(tr)?;
        if budget > board_mm {
            return Ok(());
        }
        let over: Vec<&Run> = r.runs.iter().filter(|run| detour(layer, domain, run, budget).is_none()).collect();
        if let Some(w) = first_max(over.iter().copied(), |q| q.length) {
            let (x, y) = w.at;
            let d = measure(detour, layer, domain, w, board_mm);
            self.gaps.push((w.length, format!(
                "FAIL detour {layer} {net}: {} of {} crossings with a return detour > {budget:.1} mm or no reference path, longest run {:.1} mm at ({x:.1}, {y:.1}), detour {} (tr {} ns: {label})",
                over.len(), r.runs.len(), w.length, detour_text(d), g(tr))));
        }
        Ok(())
    }
}

/// The unknown-driver line: `bad` holds the runs that need an edge, with their detours.
fn unknown_driver(layer: &str, net: &str, bad: &[(&Run, Option<f64>)], runs: usize, label: &str) -> Option<Ranked> {
    let (w, d) = first_max(bad.iter().copied(), |q| q.0.length)?;
    let (x, y) = w.at;
    Some((w.length, format!(
        "FAIL unknown-driver {layer} {net}: {} of {runs} crossings need an edge time (longest run {:.1} mm at ({x:.1}, {y:.1}), detour {}); unknown driver: {label}",
        bad.len(), w.length, detour_text(d))))
}

/// The enforced D-124c FAIL lines.
pub fn d124c_reference_failures(results: &Results, domains: &Domains, spec: &Spec, edges: &Edges, detour: &mut Detour, board_mm: f64) -> Result<Vec<String>, String> {
    let (mut lines, mut seen) = (Lines::default(), Vec::new());
    for ((layer, net), r) in results {
        let Some(domain) = lines.common(layer, net, r, domains, spec, &mut seen) else { continue };
        let (tr, label) = d124c_net_edge(net, spec, edges);
        let Some(tr) = tr else {
            // no edge time: only a run with no detour at all (a stub) passes
            let measured: Vec<(&Run, Option<f64>)> = r.runs.iter().map(|run| (run, measure(detour, layer, domain, run, board_mm))).collect();
            let bad: Vec<(&Run, Option<f64>)> = measured.into_iter().filter(|(_, d)| d.is_none_or(|d| d > 0.0)).collect();
            lines.gaps.extend(unknown_driver(layer, net, &bad, r.runs.len(), &label));
            continue;
        };
        lines.over_budget(spec, (layer, net), domain, r, tr, &label, board_mm, detour)?;
    }
    Ok(lines.finish())
}

/// The D-124d screen, with nets of no edge left to the assessment: positive detours cannot qualify a missing edge bound, so only
/// bounded native stub inspection runs for them here.
fn proposed_failures(results: &Results, domains: &Domains, spec: &Spec, edges: &Edges, detour: &mut Detour, board_mm: f64) -> Result<Vec<String>, String> {
    let (mut lines, mut seen) = (Lines::default(), Vec::new());
    for ((layer, net), r) in results {
        let Some(domain) = lines.common(layer, net, r, domains, spec, &mut seen) else { continue };
        let (tr, label) = net_edge_of(net, spec, edges);
        let Some(tr) = tr else {
            for run in r.runs.iter().filter(|run| !run.proven_stub.get()) {
                detour(layer, domain, run, 0.0);
            }
            continue;
        };
        lines.over_budget(spec, (layer, net), domain, r, tr, &label, board_mm, detour)?;
    }
    Ok(lines.finish())
}

/// A net that the timing rules apply to.
fn timing_net<'a>(net: &str, spec: &Spec, domains: &'a Domains) -> Option<&'a str> {
    if !spec.checked(net) || spec.is_power(net) || spec.is_fast(net) {
        return None;
    }
    domains.get(net).and_then(|d| d.as_deref())
}

/// D-124d keeps the unknown-driver geometric screen of D-124c.
fn unknown_edges(results: &Results, domains: &Domains, spec: &Spec, edges: &Edges, detour: &mut Detour, board_mm: f64, screen: &mut Vec<String>) {
    for ((layer, net), r) in results {
        let Some(domain) = timing_net(net, spec, domains) else { continue };
        let (tr, label) = net_edge_of(net, spec, edges);
        if tr.is_some() {
            continue;
        }
        let measured: Vec<(&Run, Option<f64>)> = r.runs.iter().map(|run| (run, measure(detour, layer, domain, run, board_mm))).collect();
        let bad: Vec<(&Run, Option<f64>)> = measured.into_iter().filter(|(_, d)| d.is_none_or(|d| d > 0.0)).collect();
        screen.extend(unknown_driver(layer, net, &bad, r.runs.len(), &label).map(|l| l.1));
    }
}

/// Timing evidence: no edge here is a proven fastest-edge bound, so each run that is not a proved stub stays unresolved. The large
/// budget exemption of the screen may not have called the detour, so a single-terminal leaf is inspected here.
fn timing_failures(results: &Results, domains: &Domains, spec: &Spec, edges: &Edges, detour: &mut Detour) -> Vec<String> {
    let mut evidence = Vec::new();
    for ((layer, net), r) in results {
        let Some(domain) = timing_net(net, spec, domains).filter(|_| !r.runs.is_empty()) else { continue };
        if net_edge_of(net, spec, edges).0.is_some() {
            for run in r.runs.iter().filter(|run| run.terminals.len() == 1 && !run.proven_stub.get()) {
                detour(layer, domain, run, 0.0);
            }
        }
        if r.runs.iter().all(|run| run.proven_stub.get()) {
            continue;
        }
        let protocol = spec.edge_class(net).and_then(|k| spec.rates.get(k)).filter(|c| c.is_protocol()).map(|c| c.tr_ns);
        let screening = match edges.get(net) {
            Some(Edge::Known { edge_ns, .. }) => Some(*edge_ns),
            Some(Edge::Unknown(_)) => None,
            None => protocol,
        };
        evidence.push(match screening {
            None => format!("FAIL unproved-fastest-edge {layer} {net}: driver edge unknown for an unreferenced run; no qualified timing bound or topology-proven stub"),
            Some(edge) => format!("FAIL unproved-fastest-edge {layer} {net}: accepted screening edge {} ns has no proven fastest-edge bound; timing-dependent crossing/perimeter exemption cannot qualify", g(edge)),
        });
    }
    evidence
}

/// The D-124d screen and its timing evidence, both report-only.
pub struct Assessment {
    pub screen: Vec<String>,
    pub evidence: Vec<String>,
}

/// Keeps accepted geometric screening separate from timing-evidence closure.
pub fn reference_assessment(results: &Results, domains: &Domains, spec: &Spec, edges: &Edges, detour: &mut Detour, board_mm: f64) -> Result<Assessment, String> {
    let mut screen = proposed_failures(results, domains, spec, edges, detour, board_mm)?;
    unknown_edges(results, domains, spec, edges, detour, board_mm, &mut screen);
    let evidence = timing_failures(results, domains, spec, edges, detour);
    Ok(Assessment { screen, evidence })
}

/// (kind, layer, net) of a FAIL line: 'FAIL detour B.Cu /X: ...' -> detour B.Cu /X.
fn finding_key(line: &str) -> Vec<&str> {
    line.split(':').next().unwrap_or("").split_whitespace().skip(1).collect()
}

/// D-124d findings the enforced screen does not report, as WARN lines. A finding with the same kind, layer and net is already counted.
pub fn proposed_report(enforced: &[String], proposed: &[String]) -> Vec<String> {
    let keys: Vec<Vec<&str>> = enforced.iter().map(|l| finding_key(l)).collect();
    proposed.iter().filter(|l| l.starts_with("FAIL ") && !keys.contains(&finding_key(l))).map(|l| l.replacen("FAIL ", "WARN D-124d-proposed ", 1)).collect()
}

/// The counted failures, and the report lines that are not counted.
pub fn planes_outcome(geometry: Vec<String>, enforced: &[String], assessment: &Assessment) -> (Vec<String>, Vec<String>) {
    let proposed = proposed_report(enforced, &assessment.screen);
    let mut fails = geometry;
    fails.extend_from_slice(enforced);
    let mut report = proposed.clone();
    report.extend(assessment.evidence.iter().map(|l| l.replacen("FAIL ", "WARN ", 1)));
    report.push(format!("SI_SCREEN geometric_failures={} (D-124c enforced); D-124d proposed screen: {} findings, {} not in the enforced screen (report-only, WARN D-124d-proposed)", fails.len(), assessment.screen.len(), proposed.len()));
    (fails, report)
}

/// FAIL lines for tracks on a plane layer. No exemption applies. On a mixed layer only a fast or power net fails.
pub fn plane_cut_failures(cuts: &[((String, String), f64)], spec: &Spec) -> Vec<String> {
    let mut rows: Vec<(f64, &str, &str)> = cuts.iter().filter(|((l, _), _)| spec.plane_layers.contains(l)).map(|((l, n), mm)| (*mm, l.as_str(), n.as_str())).collect();
    rows.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| b.1.cmp(a.1)).then_with(|| b.2.cmp(a.2)));
    let mut out = Vec::new();
    for (mm, layer, net) in rows {
        match spec.mixed_layers.iter().find(|(l, _)| l == layer) {
            None => out.push(format!("FAIL plane-cut {layer} {net}: {mm:.1} mm of track")),
            Some((_, m)) if spec.net_kind(net, m) != "slow" => out.push(format!("FAIL plane-cut {layer} {net}: {mm:.1} mm of track; a {} net on the mixed layer", spec.net_kind(net, m))),
            Some(_) => {}
        }
    }
    out
}

/// A ground fill piece on a mixed layer: layer, ground, the count of its vias and pads, a point of it.
pub type Piece = (String, String, usize, (f64, f64));

/// FAIL lines for ground fill pieces on a mixed layer with no via or through-hole pad of the ground.
pub fn island_failures(pieces: &[Piece]) -> Vec<String> {
    pieces.iter().filter(|p| p.2 == 0).map(|(layer, ground, _, (x, y))| format!("FAIL island {layer} {ground}: fill piece at ({x:.1}, {y:.1}) has no {ground} via or pad")).collect()
}

/// The largest distance from a point to its nearest via. None when there is no via.
pub fn max_min_distance(points: &[(f64, f64)], vias: &[(f64, f64)]) -> Option<f64> {
    if vias.is_empty() {
        return None;
    }
    let nearest = |p: &(f64, f64)| vias.iter().map(|v| dist(*p, *v)).fold(f64::INFINITY, f64::min);
    Some(points.iter().map(nearest).fold(0.0, f64::max))
}
