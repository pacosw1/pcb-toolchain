//! What current-paths.json asks of the nets, by the formulas of the paths gate. The gate gives a neck credit only from end
//! evidence and a pin escape only from tools/pin-ratings.json, so the router routes every piece at the IPC width.
use super::files::{BoardFiles, Chain, NetPaths, PinRatings};
use super::num::Num;
use super::output::{Class, Escape, FanoutVia, Net, NetVia, Pad, PowerChain};
use super::power::{ipc_width, via_amps, via_for_current};
use super::text::{glob_match, round_to};
use crate::kicad::board::{Board, Footprint};
use crate::kicad::geom::to_mm;
use crate::kicad::pad::Pad as BoardPad;
use std::collections::BTreeMap;

const DEFAULT_THICKNESS: f64 = 0.035;
const DEFAULT_DT: f64 = 10.0;
const DEFAULT_PLATING: f64 = 0.018;

/// dT and plating of current-paths.json, and the copper thickness per layer.
pub struct CurrentContext {
    pub dt: f64,
    pub plating: f64,
    pub thickness: BTreeMap<String, f64>,
}

impl CurrentContext {
    pub fn new(files: &BoardFiles, thickness: BTreeMap<String, f64>) -> CurrentContext {
        let value = |n: Option<Num>, default: f64| n.map_or(default, Num::get);
        CurrentContext { dt: value(files.paths.dt, DEFAULT_DT), plating: value(files.paths.via_plating_mm, DEFAULT_PLATING), thickness }
    }

    fn width(&self, amps: f64, layer: &str) -> f64 {
        ipc_width(amps, self.thickness.get(layer).copied().unwrap_or(DEFAULT_THICKNESS), self.dt)
    }
}

fn largest(values: impl Iterator<Item = f64>) -> f64 {
    values.fold(0.0, f64::max)
}

/// A parallel chain whose pads are all through-hole on both outer layers: routed once on F.Cu and written on both, each copy
/// carrying half the current (the gate rates it by max flow over its copies).
fn twin_layers(net: &Net, paths: &NetPaths, pads: &BTreeMap<String, &Pad>) -> Option<Vec<String>> {
    let parallel = paths.parallel || paths.chains().iter().any(|c| c.parallel);
    let outer: Vec<String> = ["F.Cu", "B.Cu"].iter().filter(|l| net.layers.iter().any(|n| n == *l)).map(|l| l.to_string()).collect();
    let through = |pin: &String| pads.get(pin).is_none_or(|p| p.drill > 0.0 && outer.iter().all(|l| p.layers.contains(l)));
    (parallel && outer.len() == 2 && !net.pins.is_empty() && net.pins.iter().all(through)).then_some(outer)
}

fn power_chain(chain: &Chain, net: &Net, share: f64, context: &CurrentContext) -> PowerChain {
    let amps = chain.amps.unwrap_or(Num::Int(0));
    let need = amps.get() * share;
    let per: BTreeMap<String, f64> = match &net.twin {
        Some(twin) => {
            let w = largest(twin.iter().map(|l| context.width(need, l)));
            twin.iter().map(|l| (l.clone(), w)).collect()
        }
        None => net.layers.iter().map(|l| (l.clone(), context.width(need, l))).collect(),
    };
    PowerChain { pads: chain.pads.clone(), amps, min_width: largest(per.values().copied()), min_width_layers: per }
}

/// The width each power net needs, per layer: the gate rates each piece with the copper of its own layer.
pub fn apply_paths(files: &BoardFiles, nets: &mut BTreeMap<String, Net>, pads: &[Pad], context: &CurrentContext) {
    let by_name: BTreeMap<String, &Pad> = pads.iter().map(|p| (p.name(), p)).collect();
    for (name, paths) in &files.paths.nets {
        let Some(net) = nets.get_mut(name) else { continue };
        let mut share = 1.0;
        if let Some(outer) = twin_layers(net, paths, &by_name) {
            share = 0.5;
            net.layers = outer[..1].to_vec();
            net.twin = Some(outer);
        }
        let chains: Vec<PowerChain> = paths.chains().iter().map(|c| power_chain(c, net, share, context)).collect();
        net.limits.amps = Some(chains.iter().map(|c| c.amps).fold(Num::Int(0), |a, b| if b.get() > a.get() { b } else { a }));
        net.min_width = Some(largest(chains.iter().map(|c| c.min_width)));
        let layers = net.twin.as_ref().unwrap_or(&net.layers);
        net.min_width_layers = Some(layers.iter().map(|l| (l.clone(), largest(chains.iter().map(|c| c.min_width_layers.get(l).copied().unwrap_or(0.0))))).collect());
        net.power_chains = Some(chains);
    }
}

/// (drill, diameter) of a net's via: its rule's, else its class's.
fn net_via(net: &Net, classes: &BTreeMap<String, Class>) -> Option<(f64, f64)> {
    let class = classes.get(&net.class).or_else(|| classes.get("Default"))?;
    let via = net.via.as_ref();
    let pick = |rule: Option<f64>, class: Option<Num>| rule.filter(|v| *v != 0.0).or(class.map(Num::get)).filter(|v| *v != 0.0);
    Some((pick(via.and_then(|v| v.hole_size), class.drill)?, pick(via.and_then(|v| v.via_diameter), class.via)?))
}

/// The core places one via per layer change, so the via of a routed power net gets the smallest drill whose barrel carries the
/// net current. ESP32-CORE b4: VIN_REG 2.1 A through one 0.3 mm via (1.92 A at dT 20 K). Plane nets stay as they are: their
/// current flows through the planes and many vias.
pub fn size_power_vias(nets: &mut BTreeMap<String, Net>, classes: &BTreeMap<String, Class>, context: &CurrentContext) {
    for net in nets.values_mut() {
        let amps = net.limits.amps.map_or(0.0, Num::get);
        if amps == 0.0 || net.plane {
            continue;
        }
        let Some((drill, diameter)) = net_via(net, classes) else { continue };
        let rated = via_amps(drill, context.plating, context.dt);
        if rated >= amps {
            continue;
        }
        let (d, size) = via_for_current(drill, diameter, amps, context.plating, context.dt);
        let shown = net.limits.amps.expect("amps above").text();
        let via = net.via.get_or_insert_with(NetVia::default);
        via.hole_size = Some(d);
        via.via_diameter = Some(size);
        via.current = Some(format!("{shown} A > {rated:.2} A of a {drill:?} mm via (pcbtool.via_amps, dT {:?} K)", context.dt));
    }
}

/// `REF.NUM` -> the larger via a pad of a plane net needs: the core fans each plane pad out through one via, and the gate rates
/// the chain by its widest path. ESP32-CORE c1: GND J2.4 -> U3.6 2.1 A through the 0.3 mm fan-out via of U3.6.
pub fn plane_fanout_vias(nets: &BTreeMap<String, Net>, classes: &BTreeMap<String, Class>, context: &CurrentContext) -> BTreeMap<String, FanoutVia> {
    let mut out: BTreeMap<String, FanoutVia> = BTreeMap::new();
    for net in nets.values().filter(|n| n.plane) {
        let Some((drill, diameter)) = net_via(net, classes) else { continue };
        for chain in net.power_chains.iter().flatten() {
            let amps = chain.amps.get();
            if amps == 0.0 || via_amps(drill, context.plating, context.dt) >= amps {
                continue;
            }
            let (d, size) = via_for_current(drill, diameter, amps, context.plating, context.dt);
            for pad in &chain.pads {
                if out.get(pad).is_none_or(|v| v.hole_size < d) {
                    out.insert(pad.clone(), FanoutVia { hole_size: d, via_diameter: size, amps: chain.amps });
                }
            }
        }
    }
    out
}

/// A key's place in the pad list: the last pad of a name stands for it, as several pads of a footprint can share a number.
pub fn last_pad_of_each_name(pads: &[Pad]) -> BTreeMap<String, usize> {
    pads.iter().enumerate().map(|(i, p)| (p.name(), i)).collect()
}

pub fn set_fanout_vias(pads: &mut [Pad], fanout: &BTreeMap<String, FanoutVia>) {
    for (name, index) in last_pad_of_each_name(pads) {
        if pads[index].drill == 0.0 && fanout.contains_key(&name) {
            pads[index].fanout_via = fanout.get(&name).cloned();
        }
    }
}

/// (amps, source) of a part pin, or None. Two parts that claim the value are ambiguous: no rating.
fn pin_rating(ratings: &PinRatings, mpn: &str, pin: &str) -> Option<(Num, String)> {
    let matches: Vec<(&String, &super::files::PartRating)> = ratings.parts.iter().filter(|(_, p)| p.mpn.iter().any(|q| glob_match(mpn, q))).collect();
    let [(key, part)] = matches[..] else { return None };
    let v = part.pins.get(pin)?;
    Some((v.amps, format!("{key} pin {pin} {} {} A ({})", v.name, v.amps.short(), v.source)))
}

fn footprint_rating(ratings: &PinRatings, footprint: &Footprint, pin: &str) -> Option<(Num, String)> {
    let is_part_field = |name: &str| matches!(name.to_uppercase().as_str(), "MPN" | "MFR PART" | "PART NUMBER");
    let fields = footprint.fields.iter().filter(|(n, _)| is_part_field(n)).map(|(_, t)| t.as_str());
    std::iter::once(footprint.value.as_str()).chain(fields).find_map(|mpn| pin_rating(ratings, mpn, pin))
}

/// A pad of a power net whose pin rating covers the net current may be left by one track piece as narrow as the pad's narrow
/// side and as long as its long side (the paths gate rule D-124c b).
pub fn set_pin_escapes(board: &Board, pads: &mut [Pad], nets: &BTreeMap<String, Net>, ratings: &PinRatings) {
    let sources: Vec<(&Footprint, &BoardPad)> = board.pads().collect();
    for index in last_pad_of_each_name(pads).into_values() {
        let (footprint, pad) = sources[index];
        let amps = nets.get(&pads[index].net).and_then(|n| n.limits.amps).unwrap_or(Num::Int(0));
        if amps.get() == 0.0 || pads[index].layers.is_empty() {
            continue;
        }
        let Some((pin_amps, source)) = footprint_rating(ratings, footprint, &pad.number) else { continue };
        if pin_amps.get() < amps.get() - 1e-12 {
            continue;
        }
        let (minor, major) = (to_mm(pad.size.x.min(pad.size.y)), to_mm(pad.size.x.max(pad.size.y)));
        pads[index].escape = Some(Escape { width: round_to(minor, 4), length: round_to(major, 4), pin_amps, net_amps: amps, source: source.chars().take(200).collect() });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context() -> CurrentContext {
        CurrentContext { dt: 20.0, plating: 0.018, thickness: BTreeMap::new() }
    }

    #[test]
    fn a_plane_pad_of_a_high_current_chain_gets_a_larger_fanout_via() {
        let classes = BTreeMap::from([("Default".to_string(), Class { width: None, clearance: None, via: Some(Num::Float(0.6)), drill: Some(Num::Float(0.3)) })]);
        let chain = |pads: [&str; 2], amps: f64| PowerChain { pads: pads.map(str::to_string).to_vec(), amps: Num::Float(amps), min_width: 0.0, min_width_layers: BTreeMap::new() };
        let gnd = Net { plane: true, class: "Default".to_string(), via: Some(NetVia { hole_size: Some(0.3), via_diameter: Some(0.6), ..NetVia::default() }), power_chains: Some(vec![chain(["J2.4", "U3.6"], 2.1), chain(["C1.2", "U1.1"], 0.5)]), ..Net::default() };
        let vsys = Net { class: "Default".to_string(), power_chains: Some(vec![chain(["J2.1", "U2.3"], 2.1)]), ..Net::default() };
        let out = plane_fanout_vias(&BTreeMap::from([("GND".to_string(), gnd), ("VSYS".to_string(), vsys)]), &classes, &context());
        assert_eq!(out.keys().map(String::as_str).collect::<Vec<_>>(), ["J2.4", "U3.6"]);
        assert_eq!((out["J2.4"].hole_size, out["J2.4"].via_diameter), (0.35, 0.65));
    }

    #[test]
    fn a_power_via_grows_and_says_why() {
        let classes = BTreeMap::from([("Default".to_string(), Class { width: None, clearance: None, via: Some(Num::Float(0.6)), drill: Some(Num::Float(0.3)) })]);
        let mut net = Net { class: "Default".to_string(), ..Net::default() };
        net.limits.amps = Some(Num::Float(2.1));
        let mut nets = BTreeMap::from([("VIN".to_string(), net)]);
        size_power_vias(&mut nets, &classes, &context());
        let via = nets["VIN"].via.as_ref().unwrap();
        assert_eq!((via.hole_size, via.via_diameter), (Some(0.35), Some(0.65)));
        assert!(via.current.as_ref().unwrap().starts_with("2.1 A > 1.92 A of a 0.3 mm via"));
    }
}
