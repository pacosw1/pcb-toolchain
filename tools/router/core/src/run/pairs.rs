//! --route-pairs: the diff pairs are routed here, first, instead of keeping the input's pair copper. Each pair of diff-pairs.json
//! (the model's `pairs`) is split into sections between its pad ends; each section gets the fan stubs of `pair-stubs` and one
//! centreline of `pair-route`, offset into P and N at the DRU pair width and gap, on one layer (no via), locked. The core then routes
//! the rest of the board around the locked pair copper, as it does around the kept copper today.
//!
//! A pair that cannot be routed this way (no plan, a failed centreline, wrong polarity) keeps its input copper, locked, as without
//! --route-pairs. The routed pairs are then judged by KiCad DRC on the saved copy: a pair whose new copper is in an error, or whose
//! net stays open, keeps its input copper too, and the stage runs again with it, until the DRC names no routed pair.
use super::lock::{make_locked_input, model_pairs};
use super::measure::{DrcReport, read_report, run_drc};
use super::project::restore_pro;
use crate::kicad::board::Board;
use crate::kicad::geom::to_mm;
use crate::kicad::pad::Pad;
use crate::kicad::session::Session;
use crate::model::dru::{Rule, parse_rules};
use crate::model::selector::Item;
use crate::pair::Point;
use crate::pair::route::{self, Job, Options};
use crate::pair::stubs::{self, EndSpec, PadName, PairSpec, Spec};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

/// P and N pads farther apart than this are no pair end: the fan would cross what lies between them.
const MAX_END_MM: f64 = 3.0;
/// Pads per net a pair may have (ends of a chain of sections).
const MAX_ENDS: usize = 4;
/// The stubs leave the pads at once on their diagonals: a straight run at the pad pitch would be a coupled run outside the gap.
const STUB_RUN_MM: f64 = 0.0;
/// The layers a pair may run on, in order of preference (one layer, no via).
const PAIR_LAYERS: [&str; 2] = ["F.Cu", "B.Cu"];
/// An outward offset of the pads from their footprint centre under this does not choose the heading.
const OUTWARD_MM: f64 = 0.1;
/// The uuid seed of the new copper.
const SEED: &str = "iotroute run --route-pairs";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PairResult {
    pub name: String,
    pub p: String,
    pub n: String,
    /// routed, or kept (the input copper, locked).
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gap: Option<f64>,
    pub sections: usize,
    pub why: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PairStage {
    /// Pair stage rounds (one KiCad DRC each when every pair of the round routed).
    pub rounds: usize,
    pub routed: usize,
    pub kept: usize,
    pub pairs: Vec<PairResult>,
}

/// One end of a section: the P pad and the N pad, by footprint and number, and their centres.
#[derive(Debug, Clone, PartialEq)]
pub struct EndPads {
    pub p_ref: String,
    pub p_pad: String,
    pub n_ref: String,
    pub n_pad: String,
    pub p_at: Point,
    pub n_at: Point,
    /// The offsets of the two pads from their footprint centres, summed: which way is out of the parts.
    pub outward: Point,
}

impl EndPads {
    fn mid(&self) -> Point {
        ((self.p_at.0 + self.n_at.0) / 2.0, (self.p_at.1 + self.n_at.1) / 2.0)
    }
}

fn dot(a: Point, b: Point) -> f64 {
    a.0 * b.0 + a.1 * b.1
}

fn dist(a: Point, b: Point) -> f64 {
    (a.0 - b.0).hypot(a.1 - b.1)
}

/// A unit vector on the nearest of the 8 directions.
fn octilinear(v: Point) -> Point {
    let step = std::f64::consts::FRAC_PI_4;
    let angle = (v.1.atan2(v.0) / step).round() * step;
    let (x, y) = (angle.cos(), angle.sin());
    let snap = |c: f64| if c.abs() < 1e-9 { 0.0 } else { c };
    (snap(x), snap(y))
}

/// The heading of an end in a section toward `other`: across the P-N line (the fan puts the tips side by side across it), out of
/// the parts when that is clear and `outward_first`, else toward the other end.
pub fn heading(end: &EndPads, other: Point, outward_first: bool) -> Point {
    let v = (end.p_at.0 - end.n_at.0, end.p_at.1 - end.n_at.1);
    let across = octilinear((-v.1, v.0));
    let out = dot(end.outward, across);
    let toward = dot((other.0 - end.mid().0, other.1 - end.mid().1), across);
    let sign = if outward_first && out.abs() > OUTWARD_MM { out.signum() } else if toward < 0.0 { -1.0 } else { 1.0 };
    (across.0 * sign, across.1 * sign)
}

type PadAt = (String, String, Point, Point);

fn pads_of(board: &Board, net: &str, layer: &str) -> Vec<PadAt> {
    let mm = |x: i64, y: i64| (to_mm(x), to_mm(y));
    let on = |p: &Pad| p.layers.iter().any(|l| l == layer);
    board.pads().filter(|(_, p)| p.net == net && on(p)).map(|(f, p)| {
        let at = mm(p.position.x, p.position.y);
        let centre = mm(f.position.x, f.position.y);
        (f.reference.clone(), p.number.clone(), at, (at.0 - centre.0, at.1 - centre.1))
    }).collect()
}

/// The ends of a pair on a layer: each P pad with its nearest free N pad, nearest pairs first.
pub fn pair_ends(board: &Board, p_net: &str, n_net: &str, layer: &str) -> Result<Vec<EndPads>, String> {
    let all = |net: &str| board.pads().filter(|(_, p)| p.net == net).count();
    let (p, n) = (pads_of(board, p_net, layer), pads_of(board, n_net, layer));
    if p.len() != all(p_net) || n.len() != all(n_net) {
        return Err(format!("not every pad is on {layer}"));
    }
    if p.len() != n.len() || !(2..=MAX_ENDS).contains(&p.len()) {
        return Err(format!("P has {} pads and N {}: 2 to {MAX_ENDS} each are routed", p.len(), n.len()));
    }
    let mut candidates: Vec<(f64, usize, usize)> = (0..p.len()).flat_map(|i| (0..n.len()).map(move |j| (i, j))).map(|(i, j)| (dist(p[i].2, n[j].2), i, j)).collect();
    candidates.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    let (mut used_p, mut used_n, mut ends) = (vec![false; p.len()], vec![false; n.len()], Vec::new());
    for (d, i, j) in candidates {
        if used_p[i] || used_n[j] {
            continue;
        }
        if d > MAX_END_MM {
            return Err(format!("{}.{} and {}.{} are {d:.2} mm apart (over {MAX_END_MM} mm)", p[i].0, p[i].1, n[j].0, n[j].1));
        }
        (used_p[i], used_n[j]) = (true, true);
        let outward = (p[i].3.0 + n[j].3.0, p[i].3.1 + n[j].3.1);
        ends.push(EndPads { p_ref: p[i].0.clone(), p_pad: p[i].1.clone(), n_ref: n[j].0.clone(), n_pad: n[j].1.clone(), p_at: p[i].2, n_at: n[j].2, outward });
    }
    ends.sort_by(|a, b| a.mid().0.total_cmp(&b.mid().0).then(a.mid().1.total_cmp(&b.mid().1)));
    Ok(ends)
}

/// The sections of a chain of ends: the edges of the shortest tree over their midpoints, in the order Prim adds them from end 0.
pub fn sections(ends: &[EndPads]) -> Vec<(usize, usize)> {
    let mut inside = vec![false; ends.len()];
    inside[0] = true;
    let mut edges = Vec::new();
    while edges.len() + 1 < ends.len() {
        let best = (0..ends.len()).filter(|&a| inside[a]).flat_map(|a| (0..ends.len()).filter(|&b| !inside[b]).map(move |b| (a, b)))
            .min_by(|x, y| dist(ends[x.0].mid(), ends[x.1].mid()).total_cmp(&dist(ends[y.0].mid(), ends[y.1].mid())).then(x.cmp(y)));
        let Some((a, b)) = best else { break };
        inside[b] = true;
        edges.push((a, b));
    }
    edges
}

/// Track width and diff pair gap of the DRU rules that hold for the pair's tracks everywhere (the last such rule wins, as in KiCad);
/// a rule that holds only in an area (pad fan-out windows) is not one of them.
pub fn pair_sizes(rules: &[Rule], net: &str, class: &str) -> (Option<f64>, Option<f64>) {
    let item = Item::plain(net, class, "Track");
    let (mut width, mut gap) = (None, None);
    for rule in rules.iter().filter(|r| r.layer.is_none() && r.condition.eval_alone(&item) == Some(true)) {
        for c in &rule.constraints {
            let value = c.value("opt").or_else(|| c.value("min")).and_then(Result::ok);
            match c.kind.as_str() {
                "track_width" => width = value.or(width),
                "diff_pair_gap" => gap = value.or(gap),
                _ => {}
            }
        }
    }
    (width, gap)
}

fn end_spec(end: &EndPads, dir: Point) -> EndSpec {
    EndSpec {
        reference: end.p_ref.clone(), p: PadName::Text(end.p_pad.clone()), n: PadName::Text(end.n_pad.clone()), n_ref: Some(end.n_ref.clone()), dir, run: Some(STUB_RUN_MM),
        cross_ok: false, fan_layer: None, drop: None, through: None, link: None,
    }
}

/// One pair to route: names, nets, the layers its nets may use (empty is any) and its sizes.
#[derive(Debug, Clone, PartialEq)]
pub struct PairJob {
    pub name: String,
    pub p: String,
    pub n: String,
    pub layers: Vec<String>,
    pub width: Option<f64>,
    pub gap: Option<f64>,
}

/// Routes one pair into the session: Ok with its layer and section count, or Err why not. The session is unchanged on Err.
fn route_pair(session: &mut Session, job: &PairJob, keepouts: &[String], log: &mut Vec<String>) -> Result<(String, usize), String> {
    let (Some(width), Some(gap)) = (job.width, job.gap) else { return Err("no DRU track_width and diff_pair_gap for the pair".to_string()) };
    let mut reasons = Vec::new();
    for layer in PAIR_LAYERS.iter().filter(|l| job.layers.is_empty() || job.layers.iter().any(|a| a == *l)) {
        let (board, edit) = (session.board.clone(), session.edit.clone());
        match route_on(session, job, layer, width, gap, keepouts, log) {
            Ok(count) => return Ok((layer.to_string(), count)),
            Err(why) => {
                (session.board, session.edit) = (board, edit);
                reasons.push(format!("{layer}: {why}"));
            }
        }
    }
    Err(if reasons.is_empty() { "no pair layer allowed".to_string() } else { reasons.join("; ") })
}

fn route_on(session: &mut Session, job: &PairJob, layer: &str, width: f64, gap: f64, keepouts: &[String], log: &mut Vec<String>) -> Result<usize, String> {
    let ends = pair_ends(&session.board, &job.p, &job.n, layer)?;
    // Other nets' tracks are cut here but the crystals: the board clearance, no MDI / USB spacing guess.
    let base = Options::default();
    let options = Options { layer: layer.to_string(), keepout: keepouts.to_vec(), space: base.pad_room, board_rules: true, lock: true, ..base };
    let mut used: BTreeMap<usize, Vec<Point>> = BTreeMap::new();
    let edges = sections(&ends);
    for &(a, b) in &edges {
        let mut dirs = [(0.0, 0.0); 2];
        for (k, (this, other)) in [(a, b), (b, a)].into_iter().enumerate() {
            let first = !used.contains_key(&this);
            let dir = heading(&ends[this], ends[other].mid(), first);
            if used.get(&this).is_some_and(|ds| ds.contains(&dir)) {
                return Err(format!("end {}.{} / {}.{} would fan twice the same way", ends[this].p_ref, ends[this].p_pad, ends[this].n_ref, ends[this].n_pad));
            }
            used.entry(this).or_default().push(dir);
            dirs[k] = dir;
        }
        let spec = Spec { pairs: vec![PairSpec { base: job.name.clone(), width, gap, layer: layer.to_string(), ends: vec![end_spec(&ends[a], dirs[0]), end_spec(&ends[b], dirs[1])] }] };
        let report = stubs::draw(session, &spec)?;
        log.extend(report.iter().cloned());
        if report.iter().any(|line| line.contains("WARN")) {
            return Err("P on the same side of both ends: polarity needs a crossover".to_string());
        }
        let line = route::route(session, &Job::pair(&job.name, &job.p, &job.n, width, gap, layer), &options, &mut |text| log.push(text))?;
        log.push(line.clone());
        if !line.contains(" routed ") {
            return Err(line);
        }
    }
    Ok(edges.len())
}

/// The rule areas that keep tracks out of a layer, by name.
fn keepouts(board: &Board, layer: &str) -> Vec<String> {
    let names: BTreeSet<String> = board.zones.iter().filter(|z| z.rule_area.as_ref().is_some_and(|r| r.tracks) && z.layers.iter().any(|l| l == layer)).map(|z| z.name.clone()).collect();
    names.into_iter().collect()
}

/// The routed pairs a DRC report names: an error with a track or via of the pair, or an open of its net.
pub fn implicated(report: &DrcReport, routed: &BTreeMap<String, String>) -> BTreeSet<String> {
    let net_of = |text: &str| text.split_once('[').and_then(|(_, rest)| rest.split_once(']')).map(|(net, _)| net.to_string());
    let mut out = BTreeSet::new();
    for v in report.violations.iter().filter(|v| v.severity.as_deref() == Some("error")) {
        for item in v.items.iter().filter(|i| ["Track", "Via", "Arc"].iter().any(|h| i.description.starts_with(h))) {
            out.extend(net_of(&item.description).and_then(|net| routed.get(&net).cloned()));
        }
    }
    for v in &report.unconnected_items {
        out.extend(v.items.iter().filter_map(|i| net_of(&i.description)).filter_map(|net| routed.get(&net).cloned()));
    }
    out
}

fn dru_rules(src: &Path) -> Result<Vec<Rule>, String> {
    let path = src.with_extension("kicad_dru");
    match fs::read_to_string(&path) {
        Ok(text) => parse_rules(&text).map_err(|e| format!("{}: {e}", path.display())),
        Err(_) => Ok(Vec::new()),
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct NetLayers {
    nets: BTreeMap<String, NetLayerList>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct NetLayerList {
    class: String,
    layers: Vec<String>,
}

/// The pairs of the model with what the router needs of each.
pub fn pair_jobs(model_json: &str, rules: &[Rule]) -> Result<Vec<PairJob>, String> {
    let nets: NetLayers = serde_json::from_str(model_json).map_err(|e| format!("model: {e}"))?;
    let layers_of = |net: &str| nets.nets.get(net).map(|n| n.layers.clone()).unwrap_or_default();
    Ok(model_pairs(model_json)?.into_iter().map(|(name, p, n)| {
        let class = nets.nets.get(&p).map_or("Default".to_string(), |n| n.class.clone());
        let (width, gap) = pair_sizes(rules, &p, &class);
        let layers = { let (lp, ln) = (layers_of(&p), layers_of(&n)); if lp.is_empty() { ln } else if ln.is_empty() { lp } else { lp.into_iter().filter(|l| ln.contains(l)).collect() } };
        PairJob { name, p, n, layers, width, gap }
    }).collect())
}

/// The input to route, with the routed pairs in it and the kept pairs' input copper; `crystals` stay locked as before.
pub fn route_pairs(src: &Path, source: &Path, model_json: &str, crystals: &BTreeSet<String>, work: &Path) -> Result<(PathBuf, usize, usize, BTreeSet<String>, PairStage), String> {
    let jobs = pair_jobs(model_json, &dru_rules(src)?)?;
    let folder = work.join("pairs");
    fs::create_dir_all(&folder).map_err(|e| format!("{}: {e}", folder.display()))?;
    let mut kept: BTreeMap<String, String> = BTreeMap::new();
    let mut round = 0;
    loop {
        round += 1;
        let lock: BTreeSet<String> = crystals.iter().cloned().chain(jobs.iter().filter(|j| kept.contains_key(&j.name)).flat_map(|j| [j.p.clone(), j.n.clone()])).collect();
        let copy = folder.join(format!("r{round}")).join(src.file_name().ok_or("a board file has a name")?);
        let (removed, locked) = make_locked_input(src, source, &lock, &copy)?;
        let todo: Vec<&PairJob> = jobs.iter().filter(|j| !kept.contains_key(&j.name)).collect();
        let mut results: BTreeMap<String, PairResult> = BTreeMap::new();
        if !todo.is_empty() {
            let mut session = Session::open(&copy, SEED)?;
            let mut log = Vec::new();
            let (mut routed_now, mut failed_now) = (BTreeMap::new(), BTreeMap::new());
            for job in &todo {
                let areas = keepouts(&session.board, "F.Cu").into_iter().chain(keepouts(&session.board, "B.Cu")).collect::<BTreeSet<_>>().into_iter().collect::<Vec<_>>();
                match route_pair(&mut session, job, &areas, &mut log) {
                    Ok((layer, count)) => {
                        routed_now.insert(job.name.clone(), (layer, count));
                    }
                    Err(why) => {
                        log.push(format!("PAIR {} KEPT {why}", job.name));
                        failed_now.insert(job.name.clone(), why);
                    }
                }
            }
            fs::write(folder.join(format!("r{round}.log")), log.join("\n") + "\n").map_err(|e| e.to_string())?;
            if !failed_now.is_empty() {
                kept.extend(failed_now);
                continue;
            }
            session.save_to(&copy)?;
            restore_pro(src, &copy)?;
            let report_path = folder.join(format!("r{round}-drc.json"));
            run_drc(&copy, &report_path)?;
            let nets: BTreeMap<String, String> = todo.iter().flat_map(|j| [(j.p.clone(), j.name.clone()), (j.n.clone(), j.name.clone())]).collect();
            let bad = implicated(&read_report(&report_path)?, &nets);
            if !bad.is_empty() {
                kept.extend(bad.into_iter().map(|name| (name, "KiCad DRC names its new copper (error or open)".to_string())));
                continue;
            }
            for job in &todo {
                let (layer, count) = routed_now[&job.name].clone();
                results.insert(job.name.clone(), PairResult { name: job.name.clone(), p: job.p.clone(), n: job.n.clone(), status: "routed".into(), layer: Some(layer), width: job.width, gap: job.gap, sections: count, why: String::new() });
            }
        }
        let pairs: Vec<PairResult> = jobs.iter().map(|j| results.remove(&j.name).unwrap_or_else(|| PairResult {
            name: j.name.clone(), p: j.p.clone(), n: j.n.clone(), status: "kept".into(), layer: None, width: j.width, gap: j.gap, sections: 0, why: kept.get(&j.name).cloned().unwrap_or_default(),
        })).collect();
        let routed = pairs.iter().filter(|p| p.status == "routed").count();
        let stage = PairStage { rounds: round, routed, kept: pairs.len() - routed, pairs };
        return Ok((copy, removed, locked, lock, stage));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grid::tests::{footprint, pad};
    use crate::model::dru::parse_rules;

    fn end(p: Point, n: Point, outward: Point) -> EndPads {
        EndPads { p_ref: "U1".into(), p_pad: "1".into(), n_ref: "U1".into(), n_pad: "2".into(), p_at: p, n_at: n, outward }
    }

    #[test]
    fn a_heading_is_across_the_pads_out_of_the_part_or_toward_the_other_end() {
        // Pins side by side along x at the bottom of a part: out is +y, whatever the other end.
        let e = end((1.0, 0.0), (0.5, 0.0), (0.0, 2.0));
        assert_eq!(heading(&e, (0.0, -10.0), true), (0.0, 1.0));
        assert_eq!(heading(&e, (0.0, -10.0), false), (0.0, -1.0));
        // No clear outside (pads at the part centre): toward the other end, snapped to 45 degrees.
        let e = end((0.2, 1.5), (0.0, 0.0), (0.0, 0.0));
        assert_eq!(heading(&e, (-8.0, 0.0), true), (-1.0, 0.0));
    }

    #[test]
    fn ends_pair_the_nearest_pads_and_a_chain_has_one_section_less() {
        let mut b = crate::grid::tests::board(Vec::new(), Vec::new());
        b.footprints.push(footprint("U1", vec![pad("1", "AP", 10.0, 10.0, 0.3), pad("2", "AN", 10.5, 10.0, 0.3)]));
        b.footprints.push(footprint("R1", vec![pad("1", "AP", 20.0, 10.0, 0.5)]));
        b.footprints.push(footprint("R2", vec![pad("1", "AN", 20.0, 11.8, 0.5)]));
        let ends = pair_ends(&b, "AP", "AN", "F.Cu").unwrap();
        assert_eq!(ends.len(), 2);
        assert_eq!((ends[0].p_ref.as_str(), ends[0].n_ref.as_str(), ends[1].p_ref.as_str(), ends[1].n_ref.as_str()), ("U1", "U1", "R1", "R2"));
        assert_eq!(sections(&ends), [(0, 1)]);
        b.footprints.push(footprint("R3", vec![pad("1", "AN", 30.0, 10.0, 0.5)]));
        assert!(pair_ends(&b, "AP", "AN", "F.Cu").unwrap_err().contains("P has 2 pads and N 3"));
    }

    #[test]
    fn far_apart_pads_are_no_end() {
        let mut b = crate::grid::tests::board(Vec::new(), Vec::new());
        b.footprints.push(footprint("J1", vec![pad("1", "AP", 10.0, 10.0, 0.5), pad("2", "AN", 15.0, 10.0, 0.5)]));
        b.footprints.push(footprint("J2", vec![pad("1", "AP", 30.0, 10.0, 0.5), pad("2", "AN", 30.5, 10.0, 0.5)]));
        assert!(pair_ends(&b, "AP", "AN", "F.Cu").unwrap_err().contains("apart"));
    }

    #[test]
    fn sizes_come_from_the_rules_that_hold_everywhere() {
        let rules = parse_rules(r#"(version 1)
(rule "USB" (condition "A.inDiffPair('/USB_D')") (constraint track_width (min 0.2mm) (opt 0.22mm) (max 0.22mm)) (constraint diff_pair_gap (min 0.12mm) (opt 0.13mm) (max 0.15mm)))
(rule "fan" (condition "A.inDiffPair('/USB_D') && A.intersectsArea('FAN')") (constraint track_width (min 0.15mm)) (constraint diff_pair_gap (min 0.12mm) (max 100mm)))
(rule "other" (condition "A.NetClass == 'Power'") (constraint track_width (min 0.5mm)))
"#).unwrap();
        assert_eq!(pair_sizes(&rules, "/USB_DP", "Default"), (Some(0.22), Some(0.13)));
        assert_eq!(pair_sizes(&rules, "/X", "Default"), (None, None));
    }

    #[test]
    fn the_drc_names_a_pair_by_its_new_copper_or_its_open() {
        let report: DrcReport = serde_json::from_str(r#"{"violations": [
            {"type": "clearance", "severity": "error", "items": [{"description": "Track [/A_P] on F.Cu, length 1.0 mm"}, {"description": "Pad 1 [GND] of C1"}]},
            {"type": "clearance", "severity": "error", "items": [{"description": "Pad 2 [/B_P] of U1"}, {"description": "Pad 1 [GND] of C1"}]},
            {"type": "silk", "severity": "warning", "items": [{"description": "Track [/C_N] on F.Cu"}]}],
            "unconnected_items": [{"items": [{"description": "Pad 3 [/D_N] of U6 on F.Cu"}]}]}"#).unwrap();
        let routed: BTreeMap<String, String> = [("/A_P", "A"), ("/B_P", "B"), ("/C_N", "C"), ("/D_N", "D")].map(|(n, p)| (n.to_string(), p.to_string())).into();
        assert_eq!(implicated(&report, &routed), BTreeSet::from(["A".to_string(), "D".to_string()]));
    }

    fn session(b: Board, tag: &str) -> Session {
        let path = std::env::temp_dir().join(format!("route-pairs-{tag}-{}.kicad_pcb", std::process::id()));
        fs::write(&path, "(kicad_pcb)\n").unwrap();
        let s = Session::of(&path, b, crate::grid::tests::rules(), tag).unwrap();
        fs::remove_file(&path).unwrap();
        s
    }

    fn facing_parts() -> Board {
        // Pins of U1 side by side at x 4 (out of the part: -x is in, +x out); two series parts at x 14, one pad each, 1.0 mm apart.
        let mut u1 = footprint("U1", vec![pad("1", "AP", 4.0, 9.75, 0.3), pad("2", "AN", 4.0, 10.25, 0.3)]);
        u1.position = crate::grid::tests::at(3.0, 10.0);
        let mut r1 = footprint("R1", vec![pad("1", "AP", 14.0, 9.5, 0.5)]);
        r1.position = crate::grid::tests::at(15.0, 9.5);
        let mut r2 = footprint("R2", vec![pad("1", "AN", 14.0, 10.5, 0.5)]);
        r2.position = crate::grid::tests::at(15.0, 10.5);
        crate::grid::tests::board(vec![u1, r1, r2], Vec::new())
    }

    #[test]
    fn a_pair_is_routed_locked_at_its_pitch_with_no_via() {
        let mut s = session(facing_parts(), "route");
        let job = PairJob { name: "A".into(), p: "AP".into(), n: "AN".into(), layers: Vec::new(), width: Some(0.2), gap: Some(0.2) };
        let mut log = Vec::new();
        let (layer, sections) = route_pair(&mut s, &job, &[], &mut log).unwrap();
        assert_eq!((layer.as_str(), sections), ("F.Cu", 1), "{log:?}");
        assert!(s.edit.vias.is_empty() && !s.edit.tracks.is_empty());
        assert!(s.edit.tracks.iter().all(|t| t.locked && t.layer == "F.Cu" && t.width == crate::kicad::geom::from_mm(0.2)));
        assert!(log.iter().any(|l| l.starts_with("PAIR A routed on F.Cu")), "{log:?}");
        assert!(crate::pair::stubs::draw(&mut s, &Spec { pairs: Vec::new() }).unwrap().is_empty());
    }

    #[test]
    fn a_pair_that_cannot_route_leaves_the_session_as_it_was() {
        let mut b = facing_parts();
        // P and N swapped at the far end: same side of both headings, no crossover in this mode.
        b.footprints[1].pads[0].net = "AN".into();
        b.footprints[2].pads[0].net = "AP".into();
        let mut s = session(b, "polarity");
        let job = PairJob { name: "A".into(), p: "AP".into(), n: "AN".into(), layers: vec!["F.Cu".into()], width: Some(0.2), gap: Some(0.2) };
        let why = route_pair(&mut s, &job, &[], &mut Vec::new()).unwrap_err();
        assert!(why.contains("polarity"), "{why}");
        assert!(s.edit.tracks.is_empty() && s.board.copper.is_empty());
        let none = PairJob { width: None, ..job };
        assert!(route_pair(&mut s, &none, &[], &mut Vec::new()).unwrap_err().contains("no DRU"));
    }

    #[test]
    fn pair_jobs_read_the_model_pairs_their_classes_and_shared_layers() {
        let model = r#"{"pairs": [{"name": "USB", "p": "/USB_DP", "n": "/USB_DN"}], "nets": {"/USB_DP": {"class": "USB", "layers": ["F.Cu", "B.Cu"]}, "/USB_DN": {"class": "USB", "layers": ["F.Cu"]}}}"#;
        let rules = parse_rules(r#"(version 1) (rule "u" (condition "A.NetClass == 'USB'") (constraint track_width (opt 0.2mm)) (constraint diff_pair_gap (opt 0.15mm)))"#).unwrap();
        let jobs = pair_jobs(model, &rules).unwrap();
        assert_eq!(jobs, [PairJob { name: "USB".into(), p: "/USB_DP".into(), n: "/USB_DN".into(), layers: vec!["F.Cu".into()], width: Some(0.2), gap: Some(0.15) }]);
    }
}
