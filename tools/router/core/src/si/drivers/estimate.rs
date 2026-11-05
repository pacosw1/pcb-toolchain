//! Conditional edge estimates of a driver with no datasheet edge: t >= C x 0.8 VDD / I (D-124b) and the IBIS V-I form (D-124c).
//! Static V-I averages and omitted loads do not prove a fastest-edge bound; every possible supply and model must be readable, and
//! errors leave the net unknown.
use super::netlist::Netlist;
use super::table::{IbisRef, Part, Rule, Table};
use super::{Estimated, Lookup, is_passive_or_connector, is_rail, ref_prefix};
use crate::si::ibis::{Load, vi_edges};
use crate::si::planes::spec::positive_finite;
use crate::si::py::{g, g_with};
use std::path::Path;

const R_TOL: f64 = 0.95;

/// The voltage in a rail name: VDD_3V3, +3V3 -> 3.3; FIELD_5V, 5V_LOGIC -> 5; +15V -> 15. None if not one value.
pub fn rail_volts(net: &str) -> Option<f64> {
    let chars: Vec<char> = net.chars().collect();
    let mut values: Vec<f64> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let digits = i + chars[i..].iter().take_while(|c| c.is_ascii_digit()).count();
        let blocked = i > 0 && (chars[i - 1].is_ascii_digit() || chars[i - 1] == '.');
        if digits == i || blocked || chars.get(digits) != Some(&'V') {
            i = digits.max(i + 1);
            continue;
        }
        let tail = digits + 1 + chars[digits + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
        let whole: String = chars[i..digits].iter().collect();
        let fraction: String = chars[digits + 1..tail].iter().collect();
        let text = if fraction.is_empty() { whole } else { format!("{whole}.{fraction}") };
        let value: f64 = text.parse().expect("digits");
        if !values.contains(&value) {
            values.push(value);
        }
        i = tail;
    }
    if let [one] = values[..] { Some(one) } else { None }
}

/// The rail voltage on the supply pin (name) of a part.
pub fn supply_volts(netlist: &Netlist, part: &str, pin: &str) -> Option<f64> {
    netlist.pins_of(part).find(|(node, _)| node.name == pin).and_then(|(_, net)| rail_volts(net))
}

/// The lowest rail that a resistor from this net leads to (the pull-up of an open drain).
fn pullup_volts(net: &str, netlist: &Netlist, power: &[String]) -> Option<f64> {
    let resistors = netlist.net(net).unwrap_or(&[]).iter().filter(|n| ref_prefix(&n.part) == "R");
    let rails = resistors.flat_map(|n| netlist.pins_of(&n.part).filter(|(_, other)| *other != net && is_rail(other, power)).filter_map(|(_, other)| rail_volts(other)));
    rails.filter(|v| *v != 0.0).fold(None, |low: Option<f64>, v| Some(low.map_or(v, |l| if v < l { v } else { l })))
}

/// t >= C x dV / I, dV = 0.8 x VDD (the 10-90 % swing). pF x V / mA = 1e-9 s.
pub fn edge_bound_ns(c_pf: f64, vdd_v: f64, i_ma: f64) -> Result<f64, String> {
    if ![c_pf, vdd_v, i_ma].iter().all(|v| positive_finite(Some(*v))) {
        return Err("invalid C*dV/I inputs".to_string());
    }
    Ok(c_pf * 0.8 * vdd_v / i_ma)
}

/// The current through a series resistor is at most VDD / (0.95 x R), R at its low tolerance.
pub fn series_limit_ma(i_ma: f64, vdd_v: f64, r_ohm: f64) -> Result<f64, String> {
    if ![i_ma, vdd_v, r_ohm].iter().all(|v| positive_finite(Some(*v))) {
        return Err("invalid series-current inputs".to_string());
    }
    Ok(i_ma.min(vdd_v / (R_TOL * r_ohm) * 1000.0))
}

/// The model suffix, volts and note of the variant for the part's supply rail, else of all (the caller takes the worst).
fn ibis_variants(ib: &IbisRef, part: &str, netlist: &Netlist) -> Vec<(String, f64, String)> {
    let v = supply_volts(netlist, part, &ib.supply_pin);
    if let Some(v) = v
        && let Some((_, suffix)) = ib.variants.iter().find(|(k, _)| (k - v).abs() < 0.05)
    {
        return vec![(suffix.clone(), v, format!("{} {} V", ib.supply_pin, g(v)))];
    }
    ib.variants.iter().map(|(k, suffix)| (suffix.clone(), *k, format!("{} rail not found: all variants", ib.supply_pin))).collect()
}

/// The pF and text of the input capacitance of a part pin with a source, or the reason there is none.
fn pin_c_pf(mpn: &str, pin: &str, table: &Table, part_ref: &str, netlist: &Netlist) -> Result<Result<(f64, String), String>, String> {
    let Some(part) = table.part_of(mpn) else { return Ok(Err(format!("{mpn}: no entry"))) };
    let key = &part.key;
    if let (Some(rule), Some(ib)) = (part.rule(pin), &part.ibis)
        && let Some(model) = &rule.ibis_model
    {
        let mut values: Vec<(f64, String)> = Vec::new();
        for (suffix, _, _) in ibis_variants(ib, part_ref, netlist) {
            if let Some(minimum) = table.ibis_model(ib, &format!("{model}{suffix}"))?.c_comp.and_then(|t| t[1]) {
                values.push((minimum * 1e12, suffix));
            }
        }
        let Some((c, suffix)) = values.into_iter().min_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(&b.1))) else {
            return Ok(Err(format!("{key} {pin}: IBIS C_comp minimum unavailable")));
        };
        return Ok(Ok((c, format!("{key} {pin} {} pF (IBIS {model}{suffix} C_comp min)", g_with(c, 3)))));
    }
    Ok(part.pin_c.as_ref().map(|(pf, source)| (*pf, format!("{key} {pin} {} pF ({source})", g(*pf)))).ok_or_else(|| format!("{key} {pin}: no input capacitance with a source")))
}

struct NetLoad {
    pf: f64,
    used: Vec<String>,
    left: Vec<String>,
}

/// The IC pins on a net with a sourced input capacitance (not passives, not connectors); `skip` is the driver.
fn net_load_pf(net: &str, netlist: &Netlist, table: &Table, skip: (&str, &str)) -> Result<NetLoad, String> {
    let mut load = NetLoad { pf: 0.0, used: Vec::new(), left: Vec::new() };
    for node in netlist.net(net).unwrap_or(&[]) {
        if (node.part.as_str(), node.name.as_str()) == skip || is_passive_or_connector(&ref_prefix(&node.part)) {
            continue;
        }
        let mpn = netlist.comps.get(&node.part).map_or("", String::as_str);
        match pin_c_pf(mpn, &node.name, table, &node.part, netlist)? {
            Ok((c, text)) => {
                load.pf += c;
                load.used.push(format!("{}.{text}", node.part));
            }
            Err(_) => load.left.push(format!("{}.{}", node.part, node.name)),
        }
    }
    Ok(load)
}

/// Edge and text, or the reason there is no estimate; an Err is an invalid one.
type Outcome = Result<Result<(f64, String), String>, String>;

fn pin_bound(part_ref: &str, name: &str, drive: &Estimated, net: &str, lookup: &Lookup) -> Outcome {
    let (key, bound) = (&drive.part.key, drive.rule.bound.as_ref().expect("a bound driver"));
    let (Some(length), Some((cpm, cpm_src))) = (lookup.geom.length_mm.get(net).copied(), lookup.geom.pf_per_mm.get(net)) else {
        return Ok(Err(format!("{part_ref}.{name} {key}: the bound C*dV/I needs the routed length of {net} (no board geometry)")));
    };
    let (vdd, vsrc) = if let Some(pin) = &bound.supply_pin {
        let vdd = supply_volts(lookup.netlist, part_ref, pin);
        (vdd, vdd.map(|v| format!("{pin} rail {} V", g(v))))
    } else if bound.pullup {
        let vdd = pullup_volts(&drive.home, lookup.netlist, lookup.power);
        (vdd, vdd.map(|v| format!("pull-up rail {} V", g(v))))
    } else {
        (bound.vdd_v, bound.vdd_v.map(|v| format!("{} V ({})", g(v), bound.vdd_source)))
    };
    let (Some(vdd), Some(vsrc)) = (vdd.filter(|v| *v != 0.0), vsrc) else {
        return Ok(Err(format!("{part_ref}.{name} {key}: the bound needs the supply voltage; no rail found for it")));
    };
    if !positive_finite(Some(length)) || !positive_finite(Some(*cpm)) {
        return Ok(Err(format!("{part_ref}.{name}: invalid/nonpositive geometry capacitance")));
    }
    let c_trace = length * cpm;
    let load = net_load_pf(net, lookup.netlist, lookup.table, (part_ref, name))?;
    let c_pin = if drive.series.is_empty() { bound.cpin_pf.unwrap_or(0.0) } else { 0.0 };
    let c = c_trace + load.pf + c_pin;
    let (mut i, mut i_label) = (bound.i_ma, format!("{} mA ({})", g(bound.i_ma), bound.i_source));
    for (resistor, ohms) in &drive.series {
        let Some(ohms) = ohms else { continue };
        let limit = series_limit_ma(i, vdd, *ohms)?;
        if limit < i {
            (i, i_label) = (limit, format!("{} mA = {} V / (0.95 x {} ohm {resistor})", g_with(limit, 3), g(vdd), g(*ohms)));
        }
    }
    if c <= 0.0 {
        return Ok(Err(format!("{part_ref}.{name} {key}: the bound has no capacitance (no routed length)")));
    }
    let t = edge_bound_ns(c, vdd, i)?;
    if !positive_finite(Some(t)) {
        return Ok(Err(format!("{part_ref}.{name}: invalid capacitance/current estimate")));
    }
    let loads = if load.used.is_empty() { "none with a source".to_string() } else { load.used.join("; ") };
    let pin_text = if c_pin != 0.0 { format!(" + {} pF pin [{}]", g(c_pin), bound.cpin_source) } else { String::new() };
    let left = if load.left.is_empty() { String::new() } else { format!("; loads with no source left out (bound shorter): {}", load.left.join(", ")) };
    let via = if drive.series.is_empty() { String::new() } else { format!(" (through {} from {})", series_names(drive), drive.home) };
    Ok(Ok((t, format!("{part_ref}.{name} {key} conditional estimate: C*dV/I = ({c_trace:.2} pF trace [{length:.1} mm x {cpm:.4} pF/mm, {cpm_src}] + {:.2} pF loads [{loads}]{pin_text}) x 0.8 x {} V [{vsrc}] / {i_label} = {} ns{left}{via}", load.pf, g(vdd), g_with(t, 3)))))
}

fn series_names(drive: &Estimated) -> String {
    drive.series.iter().map(|(r, _)| r.as_str()).collect::<Vec<_>>().join(", ")
}

/// Is the model the selector of this pin allows?
fn check_pins(ib: &IbisRef, table: &Table, part_ref: &str, name: &str, model_name: &str, netlist: &Netlist) -> Result<(), String> {
    let nodes: Vec<&str> = netlist.pins_of(part_ref).filter(|(n, _)| n.name == name).map(|(n, _)| n.pin.as_str()).collect();
    table.with_ibis(ib, |parsed| {
        let pins = parsed.pins.get(&ib.component).ok_or("IBIS component missing")?;
        if nodes.is_empty() {
            return Err("selected schematic pin missing".to_string());
        }
        for pin in nodes {
            let (_, base) = pins.get(pin).ok_or_else(|| format!("IBIS component pin missing: {pin}"))?;
            let base = base.to_lowercase();
            let allowed = parsed.selectors.get(&base).map_or_else(|| model_name.to_lowercase() == base, |choices| choices.contains(&model_name.to_lowercase()));
            if !allowed {
                return Err(format!("IBIS component/pin/model selector mismatch: {pin}"));
            }
        }
        Ok(())
    })
}

struct Variant {
    model: String,
    note: String,
    capacitance_pf: f64,
    c_comp_pf: f64,
    edge_ns: f64,
}

struct Trace {
    c_trace: f64,
    c_load: f64,
    swing: Option<f64>,
}

fn variant(part_ref: &str, name: &str, drive: &Estimated, ib: &IbisRef, lookup: &Lookup, trace: &Trace, (suffix, volts, note): (String, f64, String)) -> Result<Variant, String> {
    let table = lookup.table;
    let open_drain = drive.rule.role == "open_drain";
    let model_name = format!("{}{suffix}", drive.rule.ibis_model.as_ref().expect("an IBIS driver"));
    let model = table.ibis_model(ib, &model_name)?;
    let allowed: &[&str] = if open_drain { &["open_drain", "open_sink"] } else { &["output", "i/o", "3-state"] };
    if !allowed.contains(&model.kind.as_deref().unwrap_or("").to_lowercase().as_str()) {
        return Err("IBIS model type incompatible with output role".to_string());
    }
    check_pins(ib, table, part_ref, name, &model_name, lookup.netlist)?;
    let minimum = model.c_comp.and_then(|t| t[1]);
    if drive.series.is_empty() && !positive_finite(minimum) {
        return Err("driver IBIS C_comp minimum unavailable".to_string());
    }
    let c_pin = if drive.series.is_empty() { minimum.expect("checked") * 1e12 } else { 0.0 };
    let total = trace.c_trace + trace.c_load + c_pin;
    if !positive_finite(Some(total)) {
        return Err("invalid total capacitance".to_string());
    }
    let mut limit: Option<f64> = None;
    for ohms in drive.series.iter().filter_map(|(_, ohms)| *ohms) {
        if !positive_finite(Some(ohms)) {
            return Err("invalid series resistance".to_string());
        }
        let current = trace.swing.filter(|s| *s != 0.0).unwrap_or(volts) / (R_TOL * ohms);
        limit = Some(limit.map_or(current, |l: f64| l.min(current)));
    }
    let (tr, tf) = vi_edges(&model, &Load { c_f: total * 1e-12, swing_v: trace.swing, open_drain, i_limit_a: limit })?;
    let edge_ns = if open_drain { tf } else { tr.expect("a push-pull rise").min(tf) };
    if !positive_finite(Some(edge_ns)) {
        return Err("invalid IBIS V-I edge estimate".to_string());
    }
    Ok(Variant { model: model_name, note, capacitance_pf: total, c_comp_pf: c_pin, edge_ns })
}

fn ibis_vi_bound(part_ref: &str, name: &str, drive: &Estimated, net: &str, lookup: &Lookup) -> Result<(f64, String), String> {
    let Part { key, ibis, .. } = drive.part;
    let ib = ibis.as_ref().expect("an IBIS rule has its source");
    let (Some(length), Some((cpm, _))) = (lookup.geom.length_mm.get(net).copied(), lookup.geom.pf_per_mm.get(net)) else {
        return Err(format!("{part_ref}.{name}: V-I estimate needs the routed length and capacitance of {net}"));
    };
    if !positive_finite(Some(length)) || !positive_finite(Some(*cpm)) {
        return Err("invalid/nonpositive geometry capacitance".to_string());
    }
    let c_trace = length * cpm;
    let load = net_load_pf(net, lookup.netlist, lookup.table, (part_ref, name))?;
    let swing = if is_open_drain(drive.rule) { pullup_volts(&drive.home, lookup.netlist, lookup.power) } else { None };
    if is_open_drain(drive.rule) && !positive_finite(swing) {
        return Err(format!("open drain has no pull-up rail on {}", drive.home));
    }
    let trace = Trace { c_trace, c_load: load.pf, swing };
    let mut best: Option<Variant> = None;
    for choice in ibis_variants(ib, part_ref, lookup.netlist) {
        let v = variant(part_ref, name, drive, ib, lookup, &trace, choice)?;
        if best.as_ref().is_none_or(|b| v.edge_ns < b.edge_ns) {
            best = Some(v);
        }
    }
    let best = best.ok_or("no IBIS model variants")?;
    let file = Path::new(&ib.file).file_name().map_or(ib.file.clone(), |f| f.to_string_lossy().into_owned());
    let left = if load.left.is_empty() { String::new() } else { format!("; loads without source omitted: {}", load.left.join(", ")) };
    let via = if drive.series.is_empty() { String::new() } else { format!("; through {} from {}", series_names(drive), drive.home) };
    let text = format!(
        "{part_ref}.{name} {key} IBIS V-I conditional estimate: C*dV/I_avg, {file} [Model] {} ({}): {} pF ({} pF trace, {} pF sourced loads, {} pF C_comp min) -> {} ns; source {} (downloaded {}){left}{via}",
        best.model, best.note, g(best.capacitance_pf), g(c_trace), g(load.pf), g(best.c_comp_pf), g(best.edge_ns), ib.url, ib.downloaded
    );
    Ok((best.edge_ns, text))
}

fn is_open_drain(rule: &Rule) -> bool {
    rule.role == "open_drain"
}

/// The estimate of one driver.
pub fn edge_of(part_ref: &str, name: &str, drive: &Estimated, net: &str, lookup: &Lookup) -> Outcome {
    if drive.rule.ibis_model.is_some() {
        return ibis_vi_bound(part_ref, name, drive, net, lookup).map(Ok);
    }
    pin_bound(part_ref, name, drive, net, lookup)
}
