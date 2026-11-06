//! Post-route length and skew tuning (`--tune TARGETS.json`, iotroute run `--tune`, DESIGN.md 5f). Opt-in: without the flag the
//! core never comes here.
//!
//! The targets (schema iot-lab.route-tune.v0, run/tune.rs) are the .kicad_dru `skew` groups and per-net `length` limits as KiCad's
//! matched-length DRC reads them. After the route is legal and final (pour doors, RP-001 returns, return pruning), each router-routed
//! net short of its target gets trombone meanders: rectangular bumps of equal height on one side of one of its own straight tracks.
//! Nothing else moves. Fixed copper (pads, locked input copper: the hand-routed pairs and crystals that `--lock-from` keeps, plane
//! fan-out) is never edited, so a group whose short member is hand copper is reported, not tuned.
//!
//! Targets, with the length as the core measures it (net_lengths: tracks + via_len per via, the KiCad rule's sum), plus the per-net
//! `offsets` of the targets file when iotroute run measured KiCad's own length on an earlier board of the same route:
//! - skew group with max S: every member more than 0.75 S shorter than the longest member L is brought into [L - 0.5 S, L], aiming at
//!   L - 0.25 S; the longest member is never lengthened, so L stays the reference. The margin covers the difference between this
//!   length and KiCad's (track inside pads). A group with only a min skew is not tuned.
//! - length min M: a net under M + 0.05 is brought to at least M + 0.05, aiming at M + 0.3 (at most halfway to its max).
//! - every target stays under the net's DRU length max (model limits.length) and the rule's own max, less 0.05 mm.
//!
//! A meander is kept only when all of these hold, else the track is put back:
//! - its new copper is legal against everything else, fixed and routed: Board::track_cost == 0 at every sample (0.5 grid pitch, the
//!   routing EPS margin), which covers clearances, isolation pair values, plane clearance, keepouts, board edge and the hard
//!   reference-fill rule; a soft reference net (reffill) must stay on its reference too;
//! - the replaced stretch of the old track touches no other item of the net (no branch, via or pad is cut off);
//! - the pour model (pour.rs, KiCad starved_thermal) finds no fault that was not there before;
//! - the net's length stays within its target window.
//! Spacing: legs one pitch apart, pitch = width + max(clearance, 2 x width) (same-net copper has no DRC clearance; the 2 x width
//! keeps the legs apart for coupling). Bump height at most AMAX.
use crate::*;
use std::collections::{BTreeMap, BTreeSet};

/// largest bump height (mm): keeps a meander near its track
const AMAX: f64 = 3.0;
/// smallest extra length worth a meander (mm)
const EMIN: f64 = 0.05;

struct Want {
    lo: f64,
    hi: f64,
    aim: f64,
    why: Vec<String>,
}

pub(crate) struct Outcome {
    pub notes: Vec<String>,
    pub report: Value,
}

/// Validate the public --tune input before routing; malformed targets must not become an empty tuning stage.
pub(crate) fn read_targets(path: &str) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let targets: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    validate_targets(&targets)?;
    Ok(targets)
}

pub(crate) fn validate_targets(targets: &Value) -> Result<(), String> {
    if targets["schema"].as_str() != Some("iot-lab.route-tune.v0") {
        return Err("expected schema iot-lab.route-tune.v0".into());
    }
    for kind in ["skew", "length"] {
        let entries = targets[kind].as_array().ok_or_else(|| format!("{kind} must be an array"))?;
        for (i, entry) in entries.iter().enumerate() {
            let label = format!("{kind}[{i}]");
            if !entry.is_object() { return Err(format!("{label} must be an object")); }
            if kind == "length" {
                if entry["net"].as_str().is_none_or(str::is_empty) {
                    return Err(format!("{label}.net must be a nonempty string"));
                }
            } else if entry["nets"].as_array().is_none_or(|nets| nets.iter().any(|n| n.as_str().is_none_or(str::is_empty))) {
                return Err(format!("{label}.nets must be an array of nonempty strings"));
            }
            for key in ["min", "max"] {
                if let Some(value) = entry.get(key)
                    && value.as_f64().is_none_or(|n| !n.is_finite() || n < 0.0)
                {
                    return Err(format!("{label}.{key} must be a finite non-negative number in mm"));
                }
            }
            if let (Some(min), Some(max)) = (entry["min"].as_f64(), entry["max"].as_f64())
                && min > max
            {
                return Err(format!("{label}.min must not exceed max"));
            }
        }
    }
    if let Some(offsets) = targets.get("offsets") {
        let offsets = offsets.as_object().ok_or("offsets must be an object of finite numbers in mm")?;
        for (net, value) in offsets {
            if value.as_f64().is_none_or(|n| !n.is_finite()) {
                return Err(format!("offsets.{net} must be a finite number in mm"));
            }
        }
    }
    Ok(())
}

fn routed_tracks(bd: &Board, net: usize) -> Vec<usize> {
    let mut v: Vec<(f64, usize)> = bd.shapes.iter().enumerate().filter(|(_, s)| s.alive && s.kind == Kind::Track && s.owner == net as i32 && s.net == net as i32)
        .filter_map(|(i, s)| match s.geo { Geo::Seg(ax, ay, bx, by, _) => Some(((bx - ax).hypot(by - ay), i)), _ => None }).collect();
    v.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap().then(a.1.cmp(&b.1)));
    v.into_iter().map(|e| e.1).collect()
}

/// The stretches of track `id` (as distances from its start a) that touch no other item of its net, and keep `margin` from
/// both ends. A meander may replace only these: everything else that joins the track stays joined.
fn free_runs(bd: &Board, id: usize, margin: f64) -> Vec<(f64, f64)> {
    let s = &bd.shapes[id];
    let Geo::Seg(ax, ay, bx, by, hw) = s.geo else { return Vec::new() };
    let len = (bx - ax).hypot(by - ay);
    let l = (0..bd.layer_names.len()).find(|&l| s.layers & (1 << l) != 0).unwrap_or(0);
    let step = 0.025;
    let n = (len / step).ceil().max(1.0) as usize;
    let mut runs = Vec::new();
    let mut start: Option<f64> = None;
    for k in 0..=n {
        let t = len * k as f64 / n as f64;
        let (x, y) = (ax + (bx - ax) * t / len, ay + (by - ay) * t / len);
        let mut touch = t < margin || t > len - margin;
        if !touch {
            let probe = &mut |j: u32, q: &Shape| j as usize != id && q.net == s.net && q.geo.dist(x, y) < hw + 0.01;
            touch = bd.near_in(&bd.idx, l, x, y, hw + 0.5, probe) || bd.near_in(&bd.sidx, l, x, y, hw + 0.5, probe);
        }
        match (touch, start) {
            (false, None) => start = Some(t),
            (true, Some(t0)) => {
                runs.push((t0, t));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(t0) = start {
        runs.push((t0, len));
    }
    runs
}

/// The polyline of track a-b with k bumps of height amp on side `side` (+1 / -1 of the left normal), the first leg at distance
/// `s0` from a, legs `p` apart along the track and the next bump 2p after.
fn meander(a: (f64, f64), b: (f64, f64), s0: f64, k: usize, p: f64, amp: f64, side: f64) -> Vec<(f64, f64)> {
    let len = (b.0 - a.0).hypot(b.1 - a.1);
    let u = ((b.0 - a.0) / len, (b.1 - a.1) / len);
    let nrm = (-u.1 * side, u.0 * side);
    let at = |t: f64, h: f64| (a.0 + u.0 * t + nrm.0 * h, a.1 + u.1 * t + nrm.1 * h);
    let mut pts = vec![a];
    for i in 0..k {
        let t = s0 + i as f64 * 2.0 * p;
        pts.extend([at(t, 0.0), at(t, amp), at(t + p, amp), at(t + p, 0.0)]);
    }
    pts.push(b);
    pts
}

/// Every sample of the new copper is legal (Board::track_cost 0) and, for a soft reference net, on its reference.
fn legal(ctx: &Ctx, net: usize, l: usize, pts: &[(f64, f64)], hw: f64) -> bool {
    let step = ctx.gr.p * 0.5;
    for w in pts.windows(2) {
        let (a, b) = (w[0], w[1]);
        let len = (b.0 - a.0).hypot(b.1 - a.1);
        let n = (len / step).ceil().max(1.0) as usize;
        for k in 0..=n {
            let f = k as f64 / n as f64;
            let (x, y) = (a.0 + (b.0 - a.0) * f, a.1 + (b.1 - a.1) * f);
            if ctx.bd.track_cost(net, l, x, y, hw, ctx.o.plane_clr, None) != 0 || ctx.bd.rfill.off_ref(l, net, x, y, ctx.bd.eps) {
                return false;
            }
        }
    }
    true
}

fn fault_set(bd: &Board) -> BTreeSet<(String, usize)> {
    pour::check(bd).into_iter().map(|f| (f.pad, f.layer)).collect()
}

/// Try to add `extra` mm to `net` with one meander on one of its routed tracks. -> the length added, 0 when nothing fitted.
fn add_meander(ctx: &mut Ctx, net: usize, extra: f64, faults: &BTreeSet<(String, usize)>) -> f64 {
    let n = &ctx.bd.nets[net];
    let clr = n.clr;
    for id in routed_tracks(ctx.bd, net) {
        let s = ctx.bd.shapes[id].clone();
        let Geo::Seg(ax, ay, bx, by, hw) = s.geo else { continue };
        let l = (0..ctx.bd.layer_names.len()).find(|&l| s.layers & (1 << l) != 0).unwrap_or(0);
        let p = 2.0 * hw + clr.max(4.0 * hw);
        let margin = p.max(2.0 * hw + 0.1);
        let mut runs = free_runs(ctx.bd, id, margin);
        runs.sort_by(|x, y| (y.1 - y.0).partial_cmp(&(x.1 - x.0)).unwrap());
        for (t0, t1) in runs {
            let span = t1 - t0;
            if span < p {
                continue;
            }
            let kmax = ((span - p) / (2.0 * p)).floor() as usize + 1;
            let mut ks: Vec<usize> = [kmax, (3 * kmax).div_ceil(4), kmax.div_ceil(2), kmax.div_ceil(3), kmax.div_ceil(4), 2, 1].into_iter().filter(|&k| k >= 1 && k <= kmax).collect();
            ks.dedup();
            for k in ks {
                let amp = extra / (2.0 * k as f64);
                // no bump lower than the track is wide, except a single one for a small remainder
                if amp > AMAX || (k > 1 && amp < 2.0 * hw) {
                    continue;
                }
                let width = (k - 1) as f64 * 2.0 * p + p;
                let spare = span - width;
                for s0 in [t0 + spare / 2.0, t0, t0 + spare] {
                    for side in [1.0, -1.0] {
                        let pts = meander((ax, ay), (bx, by), s0, k, p, amp, side);
                        if !legal(ctx, net, l, &pts, hw) {
                            continue;
                        }
                        ctx.bd.shapes[id].alive = false;
                        let first = ctx.bd.shapes.len();
                        let pieces: Vec<(usize, (f64, f64), (f64, f64), f64)> = pts.windows(2).map(|w| (l, w[0], w[1], hw)).collect();
                        add_copper(ctx, net, net as i32, &pieces, &[]);
                        if fault_set(ctx.bd).is_subset(faults) {
                            return 2.0 * k as f64 * amp;
                        }
                        for q in first..ctx.bd.shapes.len() {
                            ctx.bd.shapes[q].alive = false;
                        }
                        ctx.bd.shapes[id].alive = true;
                    }
                }
            }
        }
    }
    0.0
}

fn merge(want: &mut BTreeMap<usize, Want>, net: usize, lo: f64, hi: f64, aim: f64, why: String) {
    let w = want.entry(net).or_insert(Want { lo: f64::MIN, hi: f64::MAX, aim: f64::MIN, why: Vec::new() });
    w.lo = w.lo.max(lo);
    w.hi = w.hi.min(hi);
    w.aim = w.aim.max(aim);
    w.why.push(why);
}

/// The core's length of every net plus the targets' `offsets` (KiCad's length - the core's, measured by iotroute run on an
/// earlier board of the same route: KiCad leaves out track inside pads and counts vias its own way).
fn lengths(bd: &Board, off: &[f64]) -> Vec<f64> {
    net_lengths(bd).into_iter().zip(off).map(|(l, o)| l + o).collect()
}

pub(crate) fn tune(ctx: &mut Ctx, targets: &Value, state: &[(Option<String>, u32)]) -> Outcome {
    let names: std::collections::HashMap<String, usize> = ctx.bd.nets.iter().enumerate().map(|(i, n)| (n.name.clone(), i)).collect();
    let mut off = vec![0.0; ctx.bd.nets.len()];
    for (name, v) in targets["offsets"].as_object().into_iter().flatten() {
        if let (Some(&n), Some(o)) = (names.get(name), v.as_f64()) {
            off[n] = o;
        }
    }
    let len0 = lengths(ctx.bd, &off);
    let mut want: BTreeMap<usize, Want> = BTreeMap::new();
    let mut notes = Vec::new();
    let mut groups = Vec::new();
    for g in targets["skew"].as_array().into_iter().flatten() {
        let rule = g["rule"].as_str().unwrap_or("").to_string();
        let nets: Vec<usize> = g["nets"].as_array().into_iter().flatten().filter_map(|n| n.as_str().and_then(|n| names.get(n).copied())).collect();
        let Some(smax) = g["max"].as_f64() else {
            notes.push(format!("tune: skew rule {rule}: no max, not tuned"));
            continue;
        };
        if nets.len() < 2 {
            continue;
        }
        let top = nets.iter().map(|&n| len0[n]).fold(0.0, f64::max);
        for &n in &nets {
            if top - len0[n] > 0.75 * smax {
                merge(&mut want, n, top - 0.5 * smax, top, top - 0.25 * smax, format!("skew {rule}"));
            }
        }
        groups.push((rule, nets, smax, top));
    }
    for t in targets["length"].as_array().into_iter().flatten() {
        let (Some(&n), Some(min)) = (t["net"].as_str().and_then(|n| names.get(n)), t["min"].as_f64()) else { continue };
        let hi = t["max"].as_f64().map_or(f64::MAX, |m| m - 0.05);
        if len0[n] < min + 0.05 {
            let aim = (min + 0.3).min(if hi < f64::MAX { (min + hi) / 2.0 } else { f64::MAX });
            merge(&mut want, n, min + 0.05, hi, aim, format!("length {} min {min}", t["rule"].as_str().unwrap_or("")));
        }
    }
    let mut faults = fault_set(ctx.bd);
    let mut nets_report = Vec::new();
    let (mut tuned, mut short, mut added_all) = (0usize, 0usize, 0.0f64);
    for (&net, w) in want.iter_mut() {
        if let Some(m) = ctx.bd.nets[net].max_len {
            w.hi = w.hi.min(m - 0.05);
        }
        if w.lo <= w.hi {
            w.aim = w.aim.clamp(w.lo, w.hi);
        }
        let name = ctx.bd.nets[net].name.clone();
        let l0 = lengths(ctx.bd, &off)[net];
        let skip = if ctx.bd.nets[net].plane { Some("plane net") }
            else if state[net].0.is_some() { Some("route failed") }
            else if ctx.bd.twin_of(net).is_some() { Some("parallel copy net") }
            else if w.lo > w.hi { Some("target window empty (min above max)") }
            else if routed_tracks(ctx.bd, net).is_empty() { Some("hand (locked) copper only: the policy tunes router-routed copper only") }
            else { None };
        let mut added = 0.0;
        if skip.is_none() {
            let mut extra = w.aim - l0;
            let mut tries = 0;
            while w.aim - (l0 + added) > EMIN && tries < 40 {
                tries += 1;
                let need = w.aim - (l0 + added);
                let got = add_meander(ctx, net, extra.min(need), &faults);
                if got > 0.0 {
                    added += got;
                    extra = need - got;
                    faults = fault_set(ctx.bd);
                } else if l0 + added >= w.lo || extra < 2.0 * EMIN {
                    break;
                } else {
                    extra /= 2.0;
                }
            }
            ctx.gr.reset_cache();
        }
        let l1 = lengths(ctx.bd, &off)[net];
        let ok = l1 >= w.lo - 1e-9 && l1 <= w.hi + 1e-9;
        if skip.is_none() {
            if ok { tuned += 1 } else { short += 1 }
        }
        added_all += added;
        notes.push(format!("tune: {name} {l0:.2} -> {l1:.2} mm (window {:.2}..{}, {}){}", w.lo,
                           if w.hi < f64::MAX / 2.0 { format!("{:.2}", w.hi) } else { "-".into() }, w.why.join(", "),
                           skip.map_or_else(|| if ok { String::new() } else { ": short, no legal meander".into() }, |r| format!(": not tuned, {r}"))));
        nets_report.push(serde_json::json!({"net": name, "before": l0, "after": l1, "lo": w.lo, "hi": if w.hi < f64::MAX / 2.0 { Value::from(w.hi) } else { Value::Null },
            "aim": w.aim, "why": w.why, "skipped": skip, "met": ok}));
    }
    let len1 = lengths(ctx.bd, &off);
    let groups_report: Vec<Value> = groups.iter().map(|(rule, nets, smax, top)| {
        let after_top = nets.iter().map(|&n| len1[n]).fold(0.0, f64::max);
        let before = nets.iter().map(|&n| top - len0[n]).fold(0.0, f64::max);
        let after = nets.iter().map(|&n| after_top - len1[n]).fold(0.0, f64::max);
        serde_json::json!({"rule": rule, "max": smax, "nets": nets.iter().map(|&n| ctx.bd.nets[n].name.clone()).collect::<Vec<_>>(), "skew_before": before, "skew_after": after})
    }).collect();
    notes.push(format!("tune: {} net(s) short of a target, {tuned} brought into it, {short} left short, {:.2} mm of meander", want.len(), added_all));
    // the core's own length (no offset) of every net a target names: iotroute run compares it with KiCad's
    let core = net_lengths(ctx.bd);
    let named: BTreeMap<String, f64> = targets["skew"].as_array().into_iter().flatten().flat_map(|g| g["nets"].as_array().into_iter().flatten())
        .chain(targets["length"].as_array().into_iter().flatten().map(|t| &t["net"]))
        .filter_map(|n| n.as_str().and_then(|n| names.get(n)).map(|&i| (ctx.bd.nets[i].name.clone(), core[i]))).collect();
    if off.iter().any(|&o| o != 0.0) {
        notes.push(format!("tune: lengths corrected by KiCad's measure of an earlier board ({} net(s))", off.iter().filter(|&&o| o != 0.0).count()));
    }
    Outcome { notes, report: serde_json::json!({"schema": "iot-lab.route-tune-result.v0", "groups": groups_report, "nets": nets_report, "core_lengths": named}) }
}
