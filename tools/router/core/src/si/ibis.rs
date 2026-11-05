//! Source-bound IBIS screening (D-124c): what the driver edges read from a vendor file. IBIS 7.2 [Ramp] defines a 20-80 % loaded
//! swing, package excluded, C_comp included. Vendor bytes stay unchanged; absent corners never inherit typical values.
use crate::sha256::sha256;
use regex_lite::Regex;
use std::collections::BTreeMap;
use std::path::Path;

pub type Triple = [Option<f64>; 3];
pub type ViRows = Vec<(f64, Triple)>;
type Ramp = [Option<(f64, f64)>; 3];

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Model {
    pub kind: Option<String>,
    pub c_comp: Option<Triple>,
    ramp_r: Option<Ramp>,
    ramp_f: Option<Ramp>,
    pulldown: Option<ViRows>,
    pullup: Option<ViRows>,
    pullup_ref: Option<Triple>,
    voltage_range: Option<Triple>,
    temperature_range: Option<Triple>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Ibis {
    pub models: BTreeMap<String, Model>,
    /// Component -> pin -> (signal, model).
    pub pins: BTreeMap<String, BTreeMap<String, (String, String)>>,
    pub selectors: BTreeMap<String, Vec<String>>,
}

fn suffix_scale(suffix: &str) -> f64 {
    match suffix {
        "T" => 1e12,
        "G" => 1e9,
        "M" => 1e6,
        "k" => 1e3,
        "m" => 1e-3,
        "u" => 1e-6,
        "n" => 1e-9,
        "p" => 1e-12,
        "f" => 1e-15,
        _ => 1.0,
    }
}

/// An IBIS number with its scale and unit. NA is None.
pub fn number(text: &str) -> Result<Option<f64>, String> {
    let text = text.trim();
    if text.eq_ignore_ascii_case("NA") {
        return Ok(None);
    }
    let shape = Regex::new(r"^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)([TGMkmunpf]?)([A-Za-z]*)$").expect("a fixed pattern");
    let found = shape.captures(text).ok_or_else(|| format!("invalid IBIS number: {text}"))?;
    if !["", "V", "A", "F", "H", "s", "ohm", "ohms", "Ohm", "Ohms"].contains(&&found[3]) {
        return Err(format!("unsupported IBIS unit: {text}"));
    }
    let value = found[1].parse::<f64>().map_err(|_| format!("invalid IBIS number: {text}"))? * suffix_scale(&found[2]);
    if value.is_finite() { Ok(Some(value)) } else { Err(format!("nonfinite IBIS number: {text}")) }
}

fn triple(words: &[&str]) -> Result<Triple, String> {
    let [a, b, c] = words else { return Err("expected typ/min/max triple".to_string()) };
    Ok([number(a)?, number(b)?, number(c)?])
}

fn ramp_corner(word: &str) -> Result<Option<(f64, f64)>, String> {
    if word.eq_ignore_ascii_case("NA") {
        return Ok(None);
    }
    let parts: Vec<&str> = word.split('/').collect();
    let [dv, dt] = parts[..] else { return Err("ramp requires explicit dV/dt fraction".to_string()) };
    match (number(dv)?, number(dt)?) {
        (Some(dv), Some(dt)) if dv > 0.0 && dt > 0.0 => Ok(Some((dv, dt))),
        _ => Err("nonpositive ramp dV/dt".to_string()),
    }
}

#[derive(Default)]
struct Reader {
    out: Ibis,
    model: Option<String>,
    component: Option<String>,
    section: String,
    selector: Option<String>,
}

impl Reader {
    fn model_mut(&mut self) -> Option<&mut Model> {
        self.model.as_ref().and_then(|m| self.out.models.get_mut(m))
    }

    fn keyword(&mut self, section: String, arg: &str) -> Result<(), String> {
        self.section = section;
        match self.section.as_str() {
            "component" => {
                self.component = Some(arg.to_string());
                self.model = None;
                if self.out.pins.insert(arg.to_string(), BTreeMap::new()).is_some() {
                    return Err(format!("duplicate component: {arg}"));
                }
            }
            "model" => {
                let key = arg.to_lowercase();
                if self.out.models.insert(key.clone(), Model::default()).is_some() {
                    return Err(format!("duplicate model: {arg}"));
                }
                self.model = Some(key);
            }
            "model selector" => {
                let key = arg.to_lowercase();
                if self.out.selectors.insert(key.clone(), Vec::new()).is_some() {
                    return Err(format!("duplicate selector: {arg}"));
                }
                self.selector = Some(key);
            }
            "voltage range" | "temperature range" | "pullup reference" if self.model.is_some() => {
                let section = self.section.clone();
                let value = triple(&arg.split_whitespace().collect::<Vec<_>>());
                let model = self.model_mut().expect("checked");
                let slot = match section.as_str() {
                    "voltage range" => &mut model.voltage_range,
                    "temperature range" => &mut model.temperature_range,
                    _ => &mut model.pullup_ref,
                };
                if slot.is_some() {
                    return Err(format!("duplicate {section}"));
                }
                *slot = Some(value?);
            }
            "pulldown" | "pullup" if self.model.is_some() => {
                let pulldown = self.section == "pulldown";
                let model = self.model_mut().expect("checked");
                let slot = if pulldown { &mut model.pulldown } else { &mut model.pullup };
                if slot.replace(Vec::new()).is_some() {
                    return Err("duplicate V-I table".to_string());
                }
            }
            "end" => self.model = None,
            _ => {}
        }
        Ok(())
    }

    fn pin(&mut self, words: &[&str]) -> Result<(), String> {
        let Some(component) = &self.component else { return Ok(()) };
        let [name, signal, model, ..] = words else { return Err("malformed pin".to_string()) };
        let pins = self.out.pins.get_mut(component).expect("a read component");
        if pins.insert(name.to_string(), (signal.to_string(), model.to_string())).is_some() {
            return Err("duplicate component pin".to_string());
        }
        Ok(())
    }

    fn model_line(&mut self, words: &[&str]) -> Result<(), String> {
        let Some(model) = self.model_mut() else { return Ok(()) };
        match words[0].to_lowercase().as_str() {
            "model_type" => model.kind = words.get(1).map(|w| w.to_string()),
            "c_comp" => {
                let value = triple(&words[1..])?;
                if value.iter().flatten().any(|v| *v < 0.0) {
                    return Err("negative C_comp".to_string());
                }
                model.c_comp = Some(value);
            }
            _ => {}
        }
        Ok(())
    }

    fn vi_line(&mut self, words: &[&str]) -> Result<(), String> {
        let pulldown = self.section == "pulldown";
        let Some(model) = self.model_mut() else { return Ok(()) };
        if words.len() != 4 {
            return Err("malformed V-I row".to_string());
        }
        let (v, currents) = (number(words[0])?, triple(&words[1..])?);
        let (Some(v), Some(_)) = (v, currents[0]) else { return Err("missing V-I voltage or typical current".to_string()) };
        let rows = if pulldown { &mut model.pulldown } else { &mut model.pullup }.as_mut().expect("the keyword opened it");
        if rows.last().is_some_and(|last| v <= last.0) {
            return Err("V-I voltages must strictly increase".to_string());
        }
        rows.push((v, currents));
        Ok(())
    }

    fn ramp_line(&mut self, line: &str, words: &[&str]) -> Result<(), String> {
        let Some(model) = self.model_mut() else { return Ok(()) };
        let key = words[0].to_lowercase();
        if !matches!(key.as_str(), "dv/dt_r" | "dv/dt_f") {
            let load = Regex::new(r"(?i)^r_load\s*=\s*(\S+)$").expect("a fixed pattern");
            if let Some(found) = load.captures(line)
                && number(&found[1])?.is_none_or(|v| v <= 0.0)
            {
                return Err("nonpositive R_load".to_string());
            }
            return Ok(());
        }
        if words.len() != 4 {
            return Err("malformed ramp triple".to_string());
        }
        let corners = [ramp_corner(words[1])?, ramp_corner(words[2])?, ramp_corner(words[3])?];
        if corners[0].is_none() {
            return Err("typical ramp missing".to_string());
        }
        let slot = if key.ends_with('r') { &mut model.ramp_r } else { &mut model.ramp_f };
        if slot.replace(corners).is_some() {
            return Err("duplicate ramp edge".to_string());
        }
        Ok(())
    }

    fn line(&mut self, line: &str) -> Result<(), String> {
        let words: Vec<&str> = line.split_whitespace().collect();
        match self.section.as_str() {
            "pin" => self.pin(&words),
            "model selector" => {
                let selector = self.selector.as_ref().expect("the keyword set it");
                self.out.selectors.get_mut(selector).expect("a read selector").push(words[0].to_lowercase());
                Ok(())
            }
            "model" => self.model_line(&words),
            "pulldown" | "pullup" => self.vi_line(&words),
            "ramp" => self.ramp_line(line, &words),
            _ => Ok(()),
        }
    }
}

/// Parses the text of an .ibs file.
pub fn parse(text: &str) -> Result<Ibis, String> {
    let head = Regex::new(r"^\[([^\]]+)\]\s*(.*)").expect("a fixed pattern");
    let mut reader = Reader::default();
    for raw in text.split(['\n', '\r', '\x0b', '\x0c', '\x1c', '\x1d', '\x1e', '\u{85}', '\u{2028}', '\u{2029}']) {
        let line = raw.split('|').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        match head.captures(line) {
            Some(found) => reader.keyword(found[1].trim().to_lowercase(), found[2].trim())?,
            None => reader.line(line)?,
        }
    }
    Ok(reader.out)
}

/// The vendor file; its bytes must have the hash the table declares.
pub fn load(path: &Path, expected_sha256: Option<&str>) -> Result<Ibis, String> {
    let data = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if expected_sha256.is_some_and(|sha| sha != sha256(&data)) {
        return Err(format!("IBIS source hash mismatch: {}", path.display()));
    }
    parse(&String::from_utf8_lossy(&data))
}

/// Mean magnitude on a covered interval; no extrapolation or invented NA corner.
pub fn vi_avg_current(rows: &[(f64, Triple)], corner: usize, v_lo: f64, v_hi: f64) -> Result<f64, String> {
    if !v_lo.is_finite() || !v_hi.is_finite() || !(0.0 <= v_lo && v_lo < v_hi) {
        return Err("invalid V-I interval".to_string());
    }
    if rows.len() < 2 || rows[0].0 > v_lo || rows[rows.len() - 1].0 < v_hi {
        return Err("V-I interval not covered".to_string());
    }
    if rows.iter().any(|r| !r.0.is_finite()) || rows.windows(2).any(|w| w[0].0 >= w[1].0) {
        return Err("invalid V-I voltages".to_string());
    }
    let at = |x: f64| -> Result<f64, String> {
        let pair = rows.windows(2).find(|w| w[0].0 <= x && x <= w[1].0).ok_or("V-I interval not covered")?;
        let (a, b) = (pair[0].0, pair[1].0);
        let (Some(ya), Some(yb)) = (pair[0].1[corner], pair[1].1[corner]) else {
            return Err(format!("missing V-I corner {}", ["typ", "min", "max"][corner]));
        };
        if !ya.is_finite() || !yb.is_finite() {
            return Err("nonfinite V-I current".to_string());
        }
        Ok(ya + (yb - ya) * (x - a) / (b - a))
    };
    let xs: Vec<f64> = std::iter::once(v_lo).chain(rows.iter().map(|r| r.0).filter(|v| v_lo < *v && *v < v_hi)).chain(std::iter::once(v_hi)).collect();
    let ys = xs.iter().map(|x| at(*x)).collect::<Result<Vec<f64>, _>>()?;
    let (lowest, highest) = ys.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(l, h), y| (l.min(*y), h.max(*y)));
    if ys.contains(&0.0) || (lowest < 0.0 && 0.0 < highest) {
        return Err("zero or changing V-I current sign".to_string());
    }
    let area: f64 = (0..xs.len() - 1).map(|i| (ys[i].abs() + ys[i + 1].abs()) * 0.5 * (xs[i + 1] - xs[i])).sum();
    let result = area / (v_hi - v_lo);
    if result.is_finite() && result > 0.0 { Ok(result) } else { Err("invalid mean V-I current".to_string()) }
}

/// The options of an edge estimate.
#[derive(Debug, Clone, Copy, Default)]
pub struct Load {
    pub c_f: f64,
    pub swing_v: Option<f64>,
    pub open_drain: bool,
    pub i_limit_a: Option<f64>,
}

fn edge_time(model: &Model, ramps: &Ramp, rows: &[(f64, Triple)], load: &Load) -> Result<f64, String> {
    let (mut vi_times, mut ramp_times) = (Vec::new(), Vec::new());
    for idx in 0..3 {
        let reference = model.pullup_ref.as_ref().or(model.voltage_range.as_ref());
        let v = if load.open_drain { load.swing_v } else { reference.map_or(load.swing_v, |r| r[idx]) };
        if v.is_some_and(|v| !v.is_finite() || v <= 0.0) {
            return Err("invalid reference voltage".to_string());
        }
        if let (Some(v), Some((dv, dt))) = (v, ramps[idx]) {
            let t = 0.8 * v / (dv / dt) * 1e9;
            if !t.is_finite() || t <= 0.0 {
                return Err("invalid ramp time".to_string());
            }
            ramp_times.push(t);
        }
        let Some(v) = v.filter(|_| rows.iter().all(|r| r.1[idx].is_some())) else { continue };
        let mut i = vi_avg_current(rows, idx, 0.1 * v, 0.9 * v)?;
        if let Some(limit) = load.i_limit_a {
            i = i.min(limit);
        }
        let t = load.c_f * 0.8 * v / i * 1e9;
        if !t.is_finite() || t <= 0.0 {
            return Err("invalid V-I estimate".to_string());
        }
        vi_times.push(t);
    }
    let fastest = |times: &[f64]| times.iter().copied().fold(f64::INFINITY, f64::min);
    if vi_times.is_empty() {
        return Err("all V-I corners unavailable".to_string());
    }
    if ramp_times.is_empty() {
        return Err("all ramp corners unavailable".to_string());
    }
    Ok(fastest(&vi_times).max(fastest(&ramp_times)))
}

/// tr and tf of an IBIS output in ns (tr is None for an open drain): per edge the larger of two lower bounds (D-124e), each from
/// its fastest corner.
///
/// (1) Ramp-derived 10-90 % time. [Ramp] dV/dt is the slew of the output into the ramp fixture R_fixture over the 20-80 % part of
/// the swing (IBIS 7.0 / Cookbook v4 3.2.1 p. 18), the speed of the driver's own switching. A capacitive board load only adds to
/// it, so it is a lower bound: 0.8 V / (dV/dt), for an open drain V is the pull-up rail on the net.
/// (2) C x 0.8 V / I_avg (D-124c): C the load (routed trace + sourced pins + C_comp), I_avg the mean magnitude of the static
/// [Pulldown] / [Pullup] V-I current over 10-90 % of the swing (Cookbook 3.1.1, p. 13-14). Alone it is far too short for
/// slew-controlled outputs (TCA9535: ramp 9.7-12.3 ns into 50 ohm, C dV/I 0.13 ns).
/// A model with no [Ramp] for the edge, or no usable ramp corner, is an error: the net is unknown, never a pass.
/// Sources: https://ibis.org/cookbook/cookbook-v4.pdf, https://ibis.org/ver7.0/ver7_0.pdf [P].
pub fn vi_edges(model: &Model, load: &Load) -> Result<(Option<f64>, f64), String> {
    if !load.c_f.is_finite() || load.c_f <= 0.0 {
        return Err("invalid load capacitance".to_string());
    }
    if load.i_limit_a.is_some_and(|i| !i.is_finite() || i <= 0.0) {
        return Err("invalid series current limit".to_string());
    }
    if load.swing_v.is_some_and(|v| !v.is_finite() || v <= 0.0) {
        return Err("invalid swing".to_string());
    }
    let kind = model.kind.as_deref().unwrap_or("").to_lowercase();
    if !["output", "i/o", "3-state", "open_drain", "open_sink", "open_source"].contains(&kind.as_str()) {
        return Err("model is not an output".to_string());
    }
    if load.open_drain && load.swing_v.is_none() {
        return Err("open drain needs pull-up voltage".to_string());
    }
    let edge = |rows: &Option<ViRows>, ramps: &Option<Ramp>, table: &str, name: &str| -> Result<f64, String> {
        let rows = rows.as_ref().filter(|r| !r.is_empty()).ok_or_else(|| format!("no {table} V-I table"))?;
        let ramps = ramps.as_ref().ok_or_else(|| format!("no ramp {name}"))?;
        edge_time(model, ramps, rows, load)
    };
    let tf = edge(&model.pulldown, &model.ramp_f, "pulldown", "f")?;
    let tr = if load.open_drain { None } else { Some(edge(&model.pullup, &model.ramp_r, "pullup", "r")?) };
    Ok((tr, tf))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOURCE: &str = "
[Component] TEST
[Pin] signal_name model_name
1 OUT1 buf
[Model Selector] sel
buf_33 3.3 V
[Model] buf_33
Model_type I/O
C_comp 2p 1p 3p
[Voltage Range] 3.3 3.0 3.6
[Pulldown]
0 0 0 0
3.6 36m 36m 36m
[Pullup]
0 0 0 0
3.6 -36m -36m -36m
[Ramp]
dV/dt_r 1.0/1n 0.8/1n 1.2/1n
dV/dt_f 1.0/2n NA NA
R_load = 50
[End]
";

    #[test]
    fn numbers_take_a_scale_and_a_unit() {
        assert_eq!(number("3.3V").unwrap(), Some(3.3));
        assert_eq!(number("2p").unwrap(), Some(2e-12));
        assert_eq!(number("1.5mA").unwrap(), Some(1.5e-3));
        assert_eq!(number("NA").unwrap(), None);
        assert!(number("1x").is_err());
        assert!(number("abc").is_err());
    }

    #[test]
    fn a_file_gives_its_models_pins_and_selectors() {
        let ibis = parse(SOURCE).unwrap();
        let m = &ibis.models["buf_33"];
        assert_eq!(m.kind.as_deref(), Some("I/O"));
        assert_eq!(m.c_comp, Some([Some(2e-12), Some(1e-12), Some(3e-12)]));
        assert_eq!(ibis.pins["TEST"]["1"], ("OUT1".to_string(), "buf".to_string()));
        assert_eq!(ibis.selectors["sel"], ["buf_33"]);
    }

    #[test]
    fn bad_files_stop() {
        for (text, error) in [
            ("[Model] a\n[Model] a", "duplicate model: a"),
            ("[Model] a\n[Pulldown]\n1 1m 1m 1m\n0 1m 1m 1m", "V-I voltages must strictly increase"),
            ("[Model] a\n[Ramp]\ndV/dt_r 1 1 1", "ramp requires explicit dV/dt fraction"),
            ("[Model] a\n[Ramp]\nR_load = 0", "nonpositive R_load"),
            ("[Model] a\nC_comp -1p 1p 1p", "negative C_comp"),
        ] {
            assert_eq!(parse(text).unwrap_err(), error);
        }
    }

    #[test]
    fn the_mean_current_is_the_area_over_the_interval() {
        let rows = vec![(0.0, [Some(0.0), None, None]), (10.0, [Some(10.0), None, None])];
        assert!((vi_avg_current(&rows, 0, 2.0, 4.0).unwrap() - 3.0).abs() < 1e-12);
        assert_eq!(vi_avg_current(&rows, 1, 2.0, 4.0).unwrap_err(), "missing V-I corner min");
        assert_eq!(vi_avg_current(&rows, 0, 2.0, 11.0).unwrap_err(), "V-I interval not covered");
        assert_eq!(vi_avg_current(&rows, 0, 0.0, 4.0).unwrap_err(), "zero or changing V-I current sign");
    }

    #[test]
    fn an_edge_is_the_larger_of_ramp_and_vi_from_the_fastest_corners() {
        let ibis = parse(SOURCE).unwrap();
        let (tr, tf) = vi_edges(&ibis.models["buf_33"], &Load { c_f: 1e-12, ..Load::default() }).unwrap();
        // Ramp r: 0.8 V / (dV/dt), fastest corner: min(2.64, 3.0, 2.4) ns; the small load gives a far shorter C dV/I.
        assert!((tr.unwrap() - 2.4).abs() < 1e-9);
        assert!((tf - 5.28).abs() < 1e-9);
        let big = vi_edges(&ibis.models["buf_33"], &Load { c_f: 1e-9, ..Load::default() }).unwrap();
        assert!(big.1 > 5.28);
    }

    #[test]
    fn an_open_drain_needs_its_pull_up_and_has_no_rise() {
        let ibis = parse(SOURCE).unwrap();
        let model = &ibis.models["buf_33"];
        assert_eq!(vi_edges(model, &Load { c_f: 1e-12, open_drain: true, ..Load::default() }).unwrap_err(), "open drain needs pull-up voltage");
        let (tr, tf) = vi_edges(model, &Load { c_f: 1e-12, open_drain: true, swing_v: Some(3.3), ..Load::default() }).unwrap();
        assert_eq!(tr, None);
        assert!(tf > 0.0);
    }

    #[test]
    fn an_input_model_is_no_driver() {
        let model = Model { kind: Some("Input".to_string()), ..Model::default() };
        assert_eq!(vi_edges(&model, &Load { c_f: 1e-12, ..Load::default() }).unwrap_err(), "model is not an output");
    }

    // The values of tools/test_ibis_screening.py.

    const FIX: &str = "[IBIS Ver] 4.1
[Component] GATE
[Pin] signal_name model_name
1 A IN
4 Y OUT
5 VCC POWER
[Model Selector] OUT
OUT_33 output3V3
[Model] IN_33
Model_type Input
C_comp 3pF 2pF 4pF
[Model] OUT_33
Model_type Output
C_comp 3pF NA 4pF
[Voltage Range] 3.3 3 3.6
[Temperature Range] 25 125 -40
[Ramp]
dV/dt_r 1/10n 1/1n 1/5n
dV/dt_f 1/10n NA 1/5n
[End]
";

    const VI: &str = "[Model] OUT
Model_type Output
C_comp 3pF 2pF 4pF
[Voltage Range] 3.3 3.0 3.6
[Pulldown]
0 0 0 0
3.6 36mA 18mA 72mA
[Pullup]
0 0 0 0
3.6 -18mA -9mA -36mA
[Ramp]
dV/dt_r 3.3/0.1n 3.0/0.1n 3.6/0.1n
dV/dt_f 3.3/0.1n 3.0/0.1n 3.6/0.1n
[End]
";

    fn model() -> Model {
        parse(VI).unwrap().models["out"].clone()
    }

    fn cap(c_f: f64) -> Load {
        Load { c_f, ..Load::default() }
    }

    #[track_caller]
    fn near(a: f64, b: f64) {
        assert!((a - b).abs() < 5e-8, "{a} is not {b}");
    }

    #[test]
    fn a_public_number_accepts_whitespace() {
        assert_eq!(number("  3.3n  ").unwrap(), Some(3.3e-9));
        assert_eq!(number("  NA  ").unwrap(), None);
    }

    #[test]
    fn corners_and_ranges_are_explicit() {
        let parsed = parse(FIX).unwrap();
        let m = &parsed.models["out_33"];
        assert_eq!(m.voltage_range, Some([Some(3.3), Some(3.0), Some(3.6)]));
        assert_eq!(m.temperature_range, Some([Some(25.0), Some(125.0), Some(-40.0)]));
        assert_eq!(m.c_comp.unwrap()[1], None); // an absent corner is not the typical value
        assert_eq!(m.ramp_f.unwrap()[1], None);
    }

    #[test]
    fn an_explicit_load_is_read() {
        parse(&FIX.replace("[End]", "R_load = 300ohms\n[End]")).unwrap();
    }

    #[test]
    fn invalid_numbers_and_ramps_stop() {
        for token in ["1e999", "nan", "inf", "1banana"] {
            assert!(number(token).is_err(), "{token}");
        }
        for replacement in ["1/0", "1/-1n", "0/1n", "NA"] {
            assert!(parse(&FIX.replace("1/10n", replacement)).is_err(), "{replacement}");
        }
    }

    #[test]
    fn a_duplicate_model_stops() {
        assert!(parse(&format!("{FIX}\n[Model] OUT_33")).is_err());
    }

    #[test]
    fn the_hash_binds_the_content() {
        let folder = std::env::temp_dir().join(format!("si-ibis-hash-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let path = folder.join("x.ibs");
        std::fs::write(&path, FIX).unwrap();
        let sha = sha256(FIX.as_bytes());
        load(&path, Some(&sha)).unwrap();
        std::fs::write(&path, FIX.replace("1/1n", "1/2n")).unwrap();
        load(&path, None).unwrap();
        assert!(load(&path, Some(&sha)).unwrap_err().contains("hash mismatch"));
        std::fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn the_static_mean_and_a_hand_calculated_load() {
        let m = model();
        near(vi_avg_current(m.pulldown.as_ref().unwrap(), 0, 0.33, 2.97).unwrap(), 0.0165);
        let (tr, tf) = vi_edges(&m, &cap(4.81e-12)).unwrap();
        near(tf, 0.3848);
        near(tr.unwrap(), 0.7696);
        let (tr, tf) = vi_edges(&m, &Load { c_f: 4.81e-12, swing_v: Some(3.3), open_drain: true, ..Load::default() }).unwrap();
        assert_eq!(tr, None);
        near(tf, 0.3848);
    }

    #[test]
    fn the_ramp_time_is_a_lower_bound_of_the_edge() {
        // D-124e. Ramp 3.3 V / 1 ns typ, 3.0 V / 1.5 ns min, 3.6 V / 0.5 ns max: 10-90 % of the corner's swing (Voltage Range
        // 3.3 / 3.0 / 3.6) = 0.8 V / (dV/dt) = 0.8, 1.2, 0.4 ns; the faster corner (max) is 0.4 ns.
        let mut m = model();
        m.ramp_f = Some([Some((3.3, 1e-9)), Some((3.0, 1.5e-9)), Some((3.6, 0.5e-9))]);
        near(vi_edges(&m, &cap(4.81e-12)).unwrap().1, 0.4); // C*dV/I (fall): typ .7696, max .3848 ns
        near(vi_edges(&m, &cap(40e-12)).unwrap().1, 3.2); // C*dV/I (fall) max 3.2 ns > 0.4 ns
    }

    #[test]
    fn a_missing_ramp_is_an_error() {
        let m = Model { ramp_r: None, ramp_f: None, ..model() };
        assert!(vi_edges(&m, &cap(4.81e-12)).is_err());
    }

    #[test]
    fn a_missing_corner_is_not_typical() {
        let mut m = model();
        m.pulldown.as_mut().unwrap()[0].1[2] = None;
        near(vi_edges(&m, &cap(4.81e-12)).unwrap().1, 0.7696); // the typ corner, not the max one
    }

    #[test]
    fn an_invalid_load_limit_interval_or_current_stops() {
        for c in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(vi_edges(&model(), &cap(c)).is_err(), "{c}");
        }
        for limit in [0.0, -1.0, f64::INFINITY] {
            assert!(vi_edges(&model(), &Load { c_f: 1e-12, i_limit_a: Some(limit), ..Load::default() }).is_err(), "{limit}");
        }
        let same = |v: f64| [Some(v); 3];
        for rows in [vec![(0.0, same(0.0)), (1.0, same(0.01))], vec![(0.0, same(0.01)), (3.6, same(-0.01))], vec![(0.0, same(0.0)), (3.6, same(0.0))]] {
            assert!(vi_avg_current(&rows, 0, 0.33, 2.97).is_err(), "{rows:?}");
        }
    }

    #[test]
    fn malformed_duplicate_and_nonfinite_v_i_rows_stop() {
        let head = "[Model] OUT\nModel_type Output\n[Pulldown]\n";
        for rows in ["0 0 0\n", "NA 0 0 0\n", "0 NA 0 0\n", "0 0 0 0\n0 1 1 1\n", "0 0 0 0\n1 1e999 0 0\n", "0 0 0 0\n[Pulldown]\n"] {
            assert!(parse(&format!("{head}{rows}")).is_err(), "{rows}");
        }
    }

    #[test]
    fn a_series_limit_and_the_model_type_apply() {
        let (_, tf) = vi_edges(&model(), &Load { c_f: 1e-12, i_limit_a: Some(0.001), ..Load::default() }).unwrap();
        near(tf, 2.4);
        let input = Model { kind: Some("Input".to_string()), ..model() };
        assert!(vi_edges(&input, &cap(1e-12)).is_err());
        assert!(vi_edges(&model(), &Load { c_f: 1e-12, open_drain: true, ..Load::default() }).is_err());
    }
}
