//! Critical first stage (opt-in): the nets the model names in `critical_nets` (`iotroute run --route-crystals`: the DRU
//! via_count 0 nets, crystals and oscillators) are routed before every other net, against the fixed copper only, then
//! frozen as fixed copper: the rest of the board routes around them and the negotiation never rips them up.
//!
//! Each net is routed by route_net with its own rules (width, clearance, DRU pair rules, keepouts, its via budget: max 0
//! = no via, one layer, the layer of its pads), so the shortest legal path on that layer. Critical nets that share a
//! footprint (the two legs of one crystal: crystal, IC and load-cap pads) are one group; a group is routed in each order
//! of its nets (all orders up to MAX_PERMUTE nets, else the base order and its reverse) and keeps the order with the
//! fewest open nets, then the least total length plus the leg imbalance (longest minus shortest leg). A net the stage
//! cannot route keeps no copper and goes to the negotiation as any other net.
use super::*;

/// up to this many nets in a group every order is tried (4! = 24 routes of a few mm each)
const MAX_PERMUTE: usize = 4;

/// Reuse bypasses the first stage; refuse the combination instead of silently dropping the model's request.
pub(crate) fn check_reuse(model: &Value, reuse: bool) -> Result<(), String> {
    if reuse && model["critical_nets"].as_array().is_some_and(|v| !v.is_empty()) {
        return Err("critical_nets cannot combine with --reuse: the critical stage needs a fresh route".into());
    }
    Ok(())
}

/// The critical nets of the model, in the base order; nets not in `order` (outside a --net stage) are not routed.
pub(crate) fn critical_nets(model: &Value, nets: &[Net], order: &[usize]) -> Vec<usize> {
    let Some(names) = model["critical_nets"].as_array() else { return Vec::new() };
    order.iter().cloned().filter(|&n| names.iter().any(|name| name.as_str() == Some(nets[n].name.as_str()))).collect()
}

/// Critical nets joined by a shared footprint (model net `pins`, "REF.PIN"), each group in the base order of its first net.
pub(crate) fn groups(model: &Value, nets: &[Net], crit: &[usize]) -> Vec<Vec<usize>> {
    let refs = |n: usize| -> Vec<String> {
        model["nets"][nets[n].name.as_str()]["pins"].as_array().map_or(Vec::new(), |pins| {
            pins.iter().filter_map(|p| p.as_str()).filter_map(|p| p.rsplit_once('.').map(|(r, _)| r.to_string())).collect()
        })
    };
    let r: Vec<Vec<String>> = crit.iter().map(|&n| refs(n)).collect();
    let mut group: Vec<usize> = (0..crit.len()).collect();
    for i in 0..crit.len() {
        for j in 0..i {
            if r[i].iter().any(|a| r[j].contains(a)) {
                let (gi, gj) = (group[i], group[j]);
                let keep = gi.min(gj);
                group.iter_mut().filter(|g| **g == gi || **g == gj).for_each(|g| *g = keep);
            }
        }
    }
    let mut out: Vec<Vec<usize>> = Vec::new();
    let mut seen: Vec<usize> = Vec::new();
    for i in 0..crit.len() {
        match seen.iter().position(|&g| g == group[i]) {
            Some(k) => out[k].push(crit[i]),
            None => {
                seen.push(group[i]);
                out.push(vec![crit[i]]);
            }
        }
    }
    out
}

/// Every order of `v` (lexicographic over positions) up to MAX_PERMUTE items, else `v` and its reverse.
fn orders(v: &[usize]) -> Vec<Vec<usize>> {
    if v.len() > MAX_PERMUTE {
        let mut r = v.to_vec();
        r.reverse();
        return vec![v.to_vec(), r];
    }
    let mut out = Vec::new();
    let mut idx: Vec<usize> = (0..v.len()).collect();
    loop {
        out.push(idx.iter().map(|&i| v[i]).collect());
        // next permutation
        let Some(i) = (1..idx.len()).rev().find(|&i| idx[i - 1] < idx[i]) else { break };
        let j = (i..idx.len()).rev().find(|&j| idx[j] > idx[i - 1]).unwrap();
        idx.swap(i - 1, j);
        idx[i..].reverse();
    }
    out
}

/// The fixed-copper caches after the fixed copper changed.
fn fixed_changed(ctx: &mut Ctx) {
    ctx.bd.compact();
    ctx.memo.clear();
    ctx.rcache.iter_mut().for_each(|c| *c = 0);
    ctx.gr.reset_cache();
    ctx.stubs.clear();
    for d in ctx.dead.iter_mut() {
        *d = (Vec::new(), String::new());
    }
}

/// The routed copper of `net` becomes fixed copper of the net.
fn freeze(ctx: &mut Ctx, net: usize) {
    for s in ctx.bd.shapes.iter_mut().filter(|s| s.alive && s.owner == net as i32) {
        s.owner = -1;
    }
    fixed_changed(ctx);
}

pub(crate) struct Stage {
    /// nets routed and frozen by the stage
    pub frozen: Vec<usize>,
    pub notes: Vec<String>,
}

/// Route the critical nets group by group, freezing each routed net; see the module comment.
pub(crate) fn route(ctx: &mut Ctx, groups: &[Vec<usize>]) -> Stage {
    let mut stage = Stage { frozen: Vec::new(), notes: Vec::new() };
    for g in groups {
        let snap: Vec<Shape> = ctx.bd.shapes.iter().filter(|s| s.alive).cloned().collect();
        // (open, length + imbalance) -> copper, routed nets, lengths
        let mut best: Option<((usize, f64), Vec<Shape>, Vec<usize>, Vec<(usize, f64)>)> = None;
        for ord in orders(g) {
            let mut routed = Vec::new();
            for &net in &ord {
                let r = route_net(ctx, net);
                if r.hard_fail.is_none() && ctx.audit(0.0).pairs == 0 {
                    freeze(ctx, net);
                    routed.push(net);
                } else {
                    for s in ctx.bd.shapes.iter_mut().filter(|s| s.owner == net as i32) {
                        s.alive = false;
                    }
                    fixed_changed(ctx);
                }
            }
            let lens = net_lengths(ctx.bd);
            let legs: Vec<(usize, f64)> = g.iter().filter(|n| routed.contains(n)).map(|&n| (n, lens[n])).collect();
            let total: f64 = legs.iter().map(|l| l.1).sum();
            let imbalance = if legs.len() >= 2 {
                legs.iter().map(|l| l.1).fold(f64::MIN, f64::max) - legs.iter().map(|l| l.1).fold(f64::MAX, f64::min)
            } else { 0.0 };
            let score = (g.len() - routed.len(), total + imbalance);
            if best.as_ref().is_none_or(|b| score.0 < b.0.0 || (score.0 == b.0.0 && score.1 < b.0.1 - 1e-9)) {
                best = Some((score, ctx.bd.shapes.iter().filter(|s| s.alive).cloned().collect(), routed, legs));
            }
            ctx.bd.shapes = snap.clone();
            fixed_changed(ctx);
        }
        let (score, shapes, routed, legs) = best.expect("a group has an order");
        ctx.bd.shapes = shapes;
        fixed_changed(ctx);
        let names = |v: &[usize]| v.iter().map(|&n| ctx.bd.nets[n].name.as_str()).collect::<Vec<_>>().join(" ");
        let mut note = format!("critical stage: {} routed of {}", routed.len(), g.len());
        if !legs.is_empty() {
            let each: Vec<String> = legs.iter().map(|(n, l)| format!("{} {l:.2} mm", ctx.bd.nets[*n].name)).collect();
            note.push_str(&format!(" ({}; total {:.2} mm, imbalance {:.2} mm)", each.join(", "), legs.iter().map(|l| l.1).sum::<f64>(), score.1 - legs.iter().map(|l| l.1).sum::<f64>()));
        }
        let open: Vec<usize> = g.iter().cloned().filter(|n| !routed.contains(n)).collect();
        if !open.is_empty() {
            note.push_str(&format!("; open, left to the negotiation: {}", names(&open)));
        }
        eprintln!("{note}");
        stage.notes.push(note);
        stage.frozen.extend(routed);
    }
    stage
}
