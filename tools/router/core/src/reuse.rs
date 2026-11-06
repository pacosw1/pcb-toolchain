//! Partial re-route (`--reuse SEED.json`, tools/router/DESIGN.md 5c): start from the copper of an earlier route and
//! route again only what the moved parts affect.
//!
//! SEED.json (schema iot-lab.route-seed.v0, written by iotroute run --reuse) holds the tracks and vias of the earlier route
//! result (route.json of the earlier board), the references of the parts that moved since (`moved_refs`) and the nets
//! that the earlier route left open (`failed_nets`). The selection (load_seed):
//! - a signal / power net is ripped up (no seed copper loaded, routed in iteration 1) when it has a pad on a moved part,
//!   when the earlier route reported it failed, when a seed item of it breaks a rule against the fixed copper of the new
//!   board (pads, locked copper, spoke channels, keepouts, board edge; plain rule, as the audit), or when its seed copper
//!   and fixed copper do not join all its items (open);
//! - else its seed copper is loaded as routed copper of the net (soft, owner = net): the negotiation may still rip it up
//!   when a ripped net conflicts with it, as any routed copper;
//! - a plane net keeps each fan-out cluster (seed items that touch) that touches a pad of the net, touches no moved pad
//!   and breaks no fixed rule; the pads left with no fan-out get one in iteration 1 (fanout_net with Ctx::fan_keep);
//! - a return via (role return) goes to the nearest kept signal via within the RP-001 radius, else it is dropped; a net
//!   whose signal via lost its return is routed again by the loop (ret_missing after iteration 1);
//! - seed vias that the fixed setup of this run made again (fixed_returns, fixed_vip_vias) are not loaded twice; a lone
//!   plane-net via that touches no pad of its net (a fixed return of a locked via that moved) is dropped.
use super::*;

/// Seed coordinates must reach the writer with the same double bits as the
/// original route. serde_json's default float parser can move a decimal by one
/// ULP, which becomes a whole nanometre when the writer cuts toward zero. Keep
/// this exact parse local to seeds; changing the model parser changes search.
pub(crate) fn read_seed_exact(text: &str) -> serde_json::Result<Value> {
    use serde_json::value::RawValue;
    fn decode(raw: &RawValue, depth: usize) -> serde_json::Result<Value> {
        let text = raw.get().trim();
        // Re-parsing RawValue subtrees must not bypass serde_json's ordinary nesting bound.
        if depth >= 128 && matches!(text.as_bytes()[0], b'{' | b'[') {
            return Err(<serde_json::Error as serde::de::Error>::custom("seed JSON nesting exceeds the parser limit"));
        }
        match text.as_bytes()[0] {
            b'{' => {
                let values: std::collections::BTreeMap<String, Box<RawValue>> = serde_json::from_str(text)?;
                values.into_iter().map(|(key, value)| Ok((key, decode(&value, depth + 1)?)))
                    .collect::<serde_json::Result<serde_json::Map<String, Value>>>().map(Value::Object)
            }
            b'[' => {
                let values: Vec<Box<RawValue>> = serde_json::from_str(text)?;
                values.iter().map(|value| decode(value, depth + 1)).collect::<serde_json::Result<Vec<_>>>().map(Value::Array)
            }
            b'-' | b'0'..=b'9' => {
                if text == "-0" { return Ok(serde_json::Number::from_f64(-0.0).unwrap().into()); }
                if let Ok(value) = text.parse::<i64>() { return Ok(value.into()); }
                if let Ok(value) = text.parse::<u64>() { return Ok(value.into()); }
                let value = text.parse::<f64>().map_err(<serde_json::Error as serde::de::Error>::custom)?;
                serde_json::Number::from_f64(value).map(Value::Number)
                    .ok_or_else(|| <serde_json::Error as serde::de::Error>::custom("non-finite seed number"))
            }
            _ => serde_json::from_str(text),
        }
    }
    decode(&serde_json::from_str::<Box<RawValue>>(text)?, 0)
}

pub(crate) struct SeedPlan {
    /// nets to route in iteration 1 (signal / power nets with no seed copper loaded), with the first reason
    pub(crate) rip: Vec<usize>,
    pub(crate) why: Vec<(usize, &'static str)>,
    /// plane nets with pads that have no kept fan-out (fanout_net in keep mode)
    pub(crate) fan: Vec<usize>,
    /// boxes of the changes: moved pads and the seed copper that was not loaded (the length recovery scope)
    pub(crate) boxes: Vec<(f64, f64, f64, f64)>,
    pub(crate) kept_nets: usize,
    pub(crate) items_kept: usize,
    pub(crate) items_dropped: usize,
    pub(crate) fan_dropped: usize,
    /// iterations of the earlier route (seed `passes`, route.json): the present cost of its end state
    pub(crate) passes: usize,
}

fn seed_shapes(bd: &Board, seed: &Value) -> (Vec<(usize, Shape, String)>, usize) {
    let names: std::collections::HashMap<&str, usize> = bd.nets.iter().enumerate().map(|(i, n)| (n.name.as_str(), i)).collect();
    let all = (1u8 << bd.layer_names.len()) - 1;
    let mut v = Vec::new();
    let mut unknown = 0;
    for t in seed["tracks"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        let (Some(&n), Some(l)) = (names.get(t["net"].as_str().unwrap_or("")), bd.layer_names.iter().position(|q| Some(q.as_str()) == t["layer"].as_str())) else {
            unknown += 1;
            continue;
        };
        let s = Shape { net: n as i32, geo: Geo::Seg(f(&t["a"][0]), f(&t["a"][1]), f(&t["b"][0]), f(&t["b"][1]), f(&t["w"]) / 2.0), clr: bd.nets[n].clr,
                        layers: 1 << l, drill: 0.0, kind: Kind::Track, owner: n as i32, alive: true, grp: 0 };
        v.push((n, s, String::from("track")));
    }
    for t in seed["vias"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        let Some(&n) = names.get(t["net"].as_str().unwrap_or("")) else {
            unknown += 1;
            continue;
        };
        let s = Shape { net: n as i32, geo: Geo::Circ(f(&t["x"]), f(&t["y"]), f(&t["d"]) / 2.0), clr: bd.nets[n].clr, layers: all, drill: f(&t["drill"]),
                        kind: Kind::Via, owner: n as i32, alive: true, grp: 0 };
        v.push((n, s, t["role"].as_str().unwrap_or("signal").to_string()));
    }
    (v, unknown)
}

/// The seed item breaks a rule against the fixed copper of this board (plain rule: Board::eps must be 0).
fn fixed_conflict(bd: &Board, s: &Shape, hth: f64, pitch: f64) -> bool {
    let net = s.net as usize;
    match s.geo {
        Geo::Seg(ax, ay, bx, by, hw) => {
            let l = (0..bd.layer_names.len()).find(|&l| s.layers & (1 << l) != 0).unwrap_or(0);
            let k = ((bx - ax).hypot(by - ay) / (pitch * 0.5)).ceil().max(1.0) as usize;
            (0..=k).any(|t| {
                let q = t as f64 / k as f64;
                let c = bd.track_fixed_code(l, ax + (bx - ax) * q, ay + (by - ay) * q, hw, s.clr, bd.pflags(net), bd.plane_clr);
                blocks(c, s.net)
            })
        }
        Geo::Circ(x, y, r) => {
            let code = bd.via_fixed_code(x, y, r * 2.0, s.drill, s.clr, hth, !bd.nets[net].plane, bd.iv(net as i32));
            bd.via_code_blocks(code, net, x, y, r * 2.0, s.drill, hth)
        }
        _ => false,
    }
}

fn same_fixed(bd: &Board, s: &Shape) -> bool {
    bd.shapes.iter().any(|q| q.alive && q.owner < 0 && q.net == s.net && q.kind == s.kind && match (q.geo, s.geo) {
        (Geo::Circ(a, b, _), Geo::Circ(c, d, _)) => (a - c).abs() < 1e-6 && (b - d).abs() < 1e-6,
        (Geo::Seg(a, b, c, d, _), Geo::Seg(e, g, h, i, _)) => q.layers == s.layers
            && (((a - e).abs() < 1e-6 && (b - g).abs() < 1e-6 && (c - h).abs() < 1e-6 && (d - i).abs() < 1e-6)
                || ((a - h).abs() < 1e-6 && (b - i).abs() < 1e-6 && (c - e).abs() < 1e-6 && (d - g).abs() < 1e-6)),
        _ => false,
    })
}

fn grow(b: (f64, f64, f64, f64), m: f64) -> (f64, f64, f64, f64) {
    (b.0 - m, b.1 - m, b.2 + m, b.3 + m)
}

/// Components of `items` (shapes) under `touch`: union-find, -> root per item.
fn comps(items: &[&Shape]) -> Vec<usize> {
    let mut par: Vec<usize> = (0..items.len()).collect();
    for a in 0..items.len() {
        for b in a + 1..items.len() {
            if touch(items[a], items[b]) {
                let (ra, rb) = (find(&mut par, a), find(&mut par, b));
                par[ra] = rb;
            }
        }
    }
    (0..items.len()).map(|a| find(&mut par, a)).collect()
}

/// Select the kept and ripped nets of the seed and load the kept copper (see the module text). The fixed setup of the
/// run (fixed_returns, fixed_vip_vias, pre_attach) must be done first.
pub(crate) fn load_seed(bd: &mut Board, o: &Opts, model: &Value, seed: &Value) -> SeedPlan {
    let nn = bd.nets.len();
    let moved_refs: Vec<&str> = seed["moved_refs"].as_array().map(|a| a.iter().filter_map(|v| v.as_str()).collect()).unwrap_or_default();
    let failed: Vec<&str> = seed["failed_nets"].as_array().map(|a| a.iter().filter_map(|v| v.as_str()).collect()).unwrap_or_default();
    // moved pads: the model pads of the moved parts, matched to the fixed pad shapes by their box
    let mut moved_pads: Vec<usize> = Vec::new();
    let mut boxes = Vec::new();
    for p in model["pads"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        if !moved_refs.contains(&p["ref"].as_str().unwrap_or("")) {
            continue;
        }
        let bb = p["bbox"].as_array().unwrap();
        let b = (f(&bb[0]), f(&bb[1]), f(&bb[2]), f(&bb[3]));
        boxes.push(b);
        for (i, s) in bd.shapes.iter().enumerate() {
            if s.alive && s.owner < 0 && s.kind == Kind::Pad && matches!(s.geo, Geo::Rect(a, c, d, e) if (a - b.0).abs() < 1e-9 && (c - b.1).abs() < 1e-9 && (d - b.2).abs() < 1e-9 && (e - b.3).abs() < 1e-9) && !moved_pads.contains(&i) {
                moved_pads.push(i);
            }
        }
    }
    let mut why: Vec<Option<&'static str>> = vec![None; nn];
    for &i in &moved_pads {
        let n = bd.shapes[i].net;
        if n >= 0 && !bd.nets[n as usize].plane && why[n as usize].is_none() {
            why[n as usize] = Some("pad on a moved part");
        }
    }
    for (n, net) in bd.nets.iter().enumerate() {
        if failed.contains(&net.name.as_str()) && why[n].is_none() && !net.plane {
            why[n] = Some("failed in the earlier route");
        }
    }
    let (items, _unknown) = seed_shapes(bd, seed);
    let eps0 = bd.eps;
    bd.eps = 0.0;
    // per item: a duplicate of fixed copper made by this run (skip), in conflict with fixed copper
    let dup: Vec<bool> = items.iter().map(|(_, s, _)| same_fixed(bd, s)).collect();
    let bad: Vec<bool> = items.iter().map(|(_, s, _)| fixed_conflict(bd, s, o.hth, o.pitch)).collect();
    bd.eps = eps0;
    for (k, (n, _, role)) in items.iter().enumerate() {
        if bad[k] && !dup[k] && role != "return" && !bd.nets[*n].plane && why[*n].is_none() {
            why[*n] = Some("seed copper breaks a fixed rule");
        }
    }
    // open: the net's fixed items and its seed copper do not form one component
    for n in 0..nn {
        if bd.nets[n].plane || why[n].is_some() {
            continue;
        }
        let mut sh: Vec<&Shape> = bd.shapes.iter().filter(|s| s.alive && s.owner < 0 && s.net == n as i32 && s.kind != Kind::Spoke).collect();
        if sh.len() < 2 {
            continue;
        }
        sh.extend(items.iter().enumerate().filter(|(k, (m, _, r))| *m == n && !dup[*k] && r != "return").map(|(_, (_, s, _))| s));
        let roots = comps(&sh);
        if roots.iter().any(|&r| r != roots[0]) {
            why[n] = Some("seed copper leaves the net open");
        }
    }
    // plane nets: fan-out clusters
    let mut keep_item = vec![false; items.len()];
    let mut fan: Vec<usize> = Vec::new();
    let mut fan_dropped = 0;
    for n in 0..nn {
        if !bd.nets[n].plane {
            continue;
        }
        let ids: Vec<usize> = (0..items.len()).filter(|&k| items[k].0 == n && !dup[k] && items[k].2 != "return").collect();
        let sh: Vec<&Shape> = ids.iter().map(|&k| &items[k].1).collect();
        let roots = comps(&sh);
        let pads: Vec<usize> = (0..bd.shapes.len()).filter(|&i| { let s = &bd.shapes[i]; s.alive && s.owner < 0 && s.kind == Kind::Pad && s.net == n as i32 }).collect();
        let mut roots_u: Vec<usize> = roots.clone();
        roots_u.sort();
        roots_u.dedup();
        let mut dropped = false;
        for r in roots_u {
            let mem: Vec<usize> = (0..ids.len()).filter(|&j| roots[j] == r).collect();
            let touched: Vec<usize> = pads.iter().cloned().filter(|&p| mem.iter().any(|&j| touch(sh[j], &bd.shapes[p]))).collect();
            let ok = !touched.is_empty() && !touched.iter().any(|p| moved_pads.contains(p)) && !mem.iter().any(|&j| bad[ids[j]]);
            if ok {
                for &j in &mem {
                    keep_item[ids[j]] = true;
                }
            } else {
                dropped = true;
                fan_dropped += 1;
                for &j in &mem {
                    boxes.push(sh[j].geo.bbox());
                }
            }
        }
        if dropped || moved_pads.iter().any(|&p| bd.shapes[p].net == n as i32) {
            fan.push(n);
        }
    }
    // signal / power nets: all seed copper of a kept net
    let mut kept_nets = 0;
    for n in 0..nn {
        if bd.nets[n].plane {
            continue;
        }
        let mine: Vec<usize> = (0..items.len()).filter(|&k| items[k].0 == n && !dup[k] && items[k].2 != "return").collect();
        if why[n].is_none() {
            if !mine.is_empty() {
                kept_nets += 1;
            }
            for k in mine {
                keep_item[k] = true;
            }
        } else {
            for k in mine {
                boxes.push(items[k].1.geo.bbox());
            }
        }
    }
    let (mut items_kept, mut items_dropped) = (0, 0);
    for (k, (_, s, role)) in items.iter().enumerate() {
        if role == "return" || dup[k] {
            continue;
        }
        if keep_item[k] {
            bd.add(s.clone());
            items_kept += 1;
        } else {
            items_dropped += 1;
        }
    }
    // return vias: owner = the net of the nearest kept signal via within the RP-001 radius (then the lower net index)
    let r2 = o.return_r * o.return_r;
    let sig: Vec<(f64, f64, usize)> = bd.shapes.iter().filter(|s| s.alive && s.owner >= 0 && s.kind == Kind::Via && s.net == s.owner && !bd.nets[s.net as usize].plane)
        .filter_map(|s| match s.geo { Geo::Circ(x, y, _) => Some((x, y, s.net as usize)), _ => None }).collect();
    for (k, (_, s, role)) in items.iter().enumerate() {
        if role != "return" || dup[k] {
            continue;
        }
        let Geo::Circ(x, y, _) = s.geo else { continue };
        let best = sig.iter().map(|&(a, b, n)| ((a - x).powi(2) + (b - y).powi(2), n)).filter(|q| q.0 <= r2)
            .min_by(|p, q| p.0.partial_cmp(&q.0).unwrap().then(p.1.cmp(&q.1)));
        match best {
            Some((_, n)) if !bad[k] => {
                let mut v = s.clone();
                v.owner = n as i32;
                bd.add(v);
                items_kept += 1;
            }
            _ => items_dropped += 1,
        }
    }
    let mut rip: Vec<usize> = (0..nn).filter(|&n| why[n].is_some()).collect();
    rip.sort();
    let why_v = rip.iter().map(|&n| (n, why[n].unwrap())).collect();
    let passes = seed["passes"].as_u64().unwrap_or(0) as usize;
    SeedPlan { rip, why: why_v, fan, boxes, kept_nets, items_kept, items_dropped, fan_dropped, passes }
}

/// The nets the length recovery visits after a reuse route: the nets routed in this run and every net with routed
/// copper within `near` mm of a change box (a moved pad, seed copper that was not loaded, new copper of a routed net).
pub(crate) fn recover_scope(bd: &Board, plan: &SeedPlan, moves: &[u32], near: f64) -> Vec<bool> {
    let nn = bd.nets.len();
    let mut boxes: Vec<(f64, f64, f64, f64)> = plan.boxes.iter().map(|&b| grow(b, near)).collect();
    for s in bd.shapes.iter().filter(|s| s.alive && s.owner >= 0 && s.net == s.owner && moves[s.owner as usize] > 0 && !bd.nets[s.net as usize].plane) {
        boxes.push(grow(s.geo.bbox(), near));
    }
    let mut v: Vec<bool> = (0..nn).map(|n| moves[n] > 0 && !bd.nets[n].plane).collect();
    for s in bd.shapes.iter().filter(|s| s.alive && s.owner >= 0 && s.net == s.owner) {
        let n = s.owner as usize;
        if v[n] {
            continue;
        }
        let b = s.geo.bbox();
        if boxes.iter().any(|q| b.0 <= q.2 && b.2 >= q.0 && b.1 <= q.3 && b.3 >= q.1) {
            v[n] = true;
        }
    }
    v
}

/// Feedback reuse does not authorize optimizing an untouched nearby net. Keep
/// length recovery on nets actually routed by negotiation; retained copper is
/// still negotiable when a real conflict causes the router to revisit its net.
pub(crate) fn recover_changed(bd: &Board, moves: &[u32]) -> Vec<bool> {
    bd.nets.iter().enumerate().map(|(n, net)| moves[n] > 0 && !net.plane).collect()
}
