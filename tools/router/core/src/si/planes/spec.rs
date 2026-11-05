//! reference-planes.json and tools/edge-rates.json, checked; a bad file stops the gate (fail closed).
use crate::kicad::board::Board;
use crate::model::text::glob_match;
use crate::si::drivers::table::{regex_full, verify_evidence};
use crate::si::json::Json;
use crate::si::py::{dist, list_repr, most_common};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

const REQUIRED: [&str; 4] = ["about", "adjacent", "plane_layers", "grounds"];
const OTHER_KEYS: [&str; 12] = ["via_allow_mm", "step_mm", "alt_refs", "domains", "exempt", "mixed_layers", "fast_file", "power", "edge_classes", "receivers", "offboard", "schematic"];

pub fn positive_finite(v: Option<f64>) -> bool {
    v.is_some_and(|v| v.is_finite() && v > 0.0)
}

fn number(json: Option<&Json>) -> Option<f64> {
    json.and_then(Json::as_f64)
}

fn reason(json: Option<&Json>, place: &str) -> Result<(), String> {
    match json.and_then(Json::as_str) {
        Some(text) if !text.trim().is_empty() => Ok(()),
        _ => Err(format!("{place}: a written reason is required")),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Applicability {
    /// The class holds for its interface.
    Protocol { reason: String },
    /// The class holds for these parts and pins only.
    Part { mpn: Vec<String>, pins: String },
}

#[derive(Debug, Clone, PartialEq)]
pub struct EdgeClass {
    pub tr_ns: f64,
    pub source: String,
    pub assumption: bool,
    pub applicability: Applicability,
}

impl EdgeClass {
    pub fn is_protocol(&self) -> bool {
        matches!(self.applicability, Applicability::Protocol { .. })
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct EdgeRates {
    /// In file order.
    pub classes: Vec<(String, EdgeClass)>,
    /// mm of return detour per ns of edge.
    pub mm_per_ns: f64,
}

impl EdgeRates {
    pub fn get(&self, name: &str) -> Option<&EdgeClass> {
        self.classes.iter().find(|(k, _)| k == name).map(|(_, c)| c)
    }

    fn names(&self) -> Vec<String> {
        let sorted: BTreeSet<&String> = self.classes.iter().map(|(k, _)| k).collect();
        sorted.into_iter().cloned().collect()
    }

    /// Allowed return detour for a rise time: tr x 10 nH/ns / 1.5 nH/mm (tools/edge-rates.json, report C3).
    pub fn budget_mm(&self, tr_ns: f64) -> Result<f64, String> {
        if !positive_finite(Some(tr_ns)) {
            return Err("edge time must be a finite number > 0".to_string());
        }
        let budget = tr_ns * self.mm_per_ns;
        if positive_finite(Some(budget)) { Ok(budget) } else { Err("non-finite detour budget".to_string()) }
    }
}

fn read_class(path: &str, key: &str, v: &Json) -> Result<EdgeClass, String> {
    let tr_ns = number(v.get("tr_ns"));
    let source = v.get("source").map_or(String::new(), Json::text);
    if !positive_finite(tr_ns) || source.trim().is_empty() {
        return Err(format!("{path}: class {key} needs tr_ns > 0 and a source"));
    }
    let a = v.get("applicability");
    let (kind, why) = (a.and_then(|a| a.get("kind")).and_then(Json::as_str), a.and_then(|a| a.get("reason")).map_or(String::new(), Json::text));
    if !matches!(kind, Some("part" | "protocol")) || why.trim().is_empty() {
        return Err(format!("{path}: class {key} needs explicit part/protocol applicability and reason"));
    }
    let applicability = if kind == Some("part") {
        let mpn = a.and_then(|a| a.get("mpn")).and_then(Json::strings).filter(|m| !m.is_empty() && m.iter().all(|q| !q.is_empty()));
        let pins = a.and_then(|a| a.get("pins")).and_then(Json::as_str).filter(|p| !p.is_empty());
        let (Some(mpn), Some(pins)) = (mpn, pins) else { return Err(format!("{path}: part class {key} needs MPN patterns and pin regex")) };
        regex_full(pins)?;
        Applicability::Part { mpn, pins: pins.to_string() }
    } else {
        Applicability::Protocol { reason: why }
    };
    Ok(EdgeClass { tr_ns: tr_ns.expect("checked"), source, assumption: v.get("assumption").is_some_and(Json::truthy), applicability })
}

fn budget_ratio(path: &str, raw: &Json) -> Result<f64, String> {
    if raw.get("default_class").is_some() {
        return Err(format!("{path}: no default class (D-124 addendum: the edge comes from the net driver)"));
    }
    let budget = raw.get("budget");
    let coefficient = |key: &str| number(budget.and_then(|b| b.get(key)));
    let (per_ns, per_mm) = (coefficient("nh_per_ns"), coefficient("nh_per_mm"));
    if !positive_finite(per_ns) || !positive_finite(per_mm) {
        return Err(format!("{path}: budget coefficients must be finite numbers > 0"));
    }
    let ratio = per_ns.expect("checked") / per_mm.expect("checked");
    if positive_finite(Some(ratio)) { Ok(ratio) } else { Err(format!("{path}: invalid budget ratio")) }
}

/// The classes of tools/edge-rates.json. `tools` is the folder of the tables; its parent holds the evidence files.
pub fn load_edge_rates(tools: &Path) -> Result<EdgeRates, String> {
    let path = tools.join("edge-rates.json");
    let raw = Json::read(&path)?;
    verify_evidence(&raw, tools)?;
    let name = path.display().to_string();
    let classes = raw.get("classes").and_then(Json::as_obj).ok_or_else(|| format!("{name}: no classes"))?;
    let classes = classes.iter().map(|(k, v)| Ok((k.clone(), read_class(&name, k, v)?))).collect::<Result<_, String>>()?;
    Ok(EdgeRates { classes, mm_per_ns: budget_ratio(&name, &raw)? })
}

#[derive(Debug, Clone, PartialEq)]
pub struct AltRef {
    pub domain: String,
    pub cap_mm: Option<f64>,
    pub slow_only: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExemptArea {
    pub rect: [f64; 4],
    pub nets: Vec<String>,
}

impl ExemptArea {
    pub fn holds(&self, x: f64, y: f64) -> bool {
        let [x0, y0, x1, y1] = self.rect;
        x0.min(x1) <= x && x <= x0.max(x1) && y0.min(y1) <= y && y <= y0.max(y1)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct MixedLayer {
    pub fast_file: String,
    pub power: Vec<String>,
    pub fast: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Offboard {
    pub class: String,
    pub reason: String,
    pub driver_mpn: String,
    pub driver_pin: String,
}

/// What a checked spec says. Every list keeps its file order: the first match decides.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Spec {
    pub via_allow_mm: f64,
    pub step_mm: f64,
    pub adjacent: Vec<(String, String)>,
    pub plane_layers: Vec<String>,
    pub grounds: Vec<String>,
    pub alt_refs: Vec<(String, AltRef)>,
    pub domains: Vec<(String, Vec<String>)>,
    pub exempt_nets: Vec<(String, String)>,
    pub exempt_areas: Vec<ExemptArea>,
    pub mixed_layers: Vec<(String, MixedLayer)>,
    pub fast_file: Option<String>,
    pub fast_top: Vec<String>,
    pub power: Vec<String>,
    pub edge_classes: Vec<(String, Vec<String>)>,
    pub rates: EdgeRates,
    pub receivers: Vec<(String, Vec<String>)>,
    pub offboard: Vec<(String, Offboard)>,
    pub schematic: Option<String>,
}

/// An optional object key: missing, null and empty all read as nothing.
fn object<'a>(raw: &'a Json, key: &str) -> &'a [(String, Json)] {
    raw.get(key).filter(|v| v.truthy()).and_then(Json::as_obj).unwrap_or(&[])
}

fn read_alt_refs(raw: &Json, grounds: &[String]) -> Result<Vec<(String, AltRef)>, String> {
    object(raw, "alt_refs").iter().map(|(net, a)| {
        let domain = a.get("domain").and_then(Json::as_str).filter(|d| grounds.iter().any(|g| g == d));
        let domain = domain.ok_or_else(|| format!("alt_refs {net}: domain must be one of the grounds"))?;
        let cap_mm = a.get("cap_mm");
        if cap_mm.is_some() && !positive_finite(number(cap_mm)) {
            return Err(format!("alt_refs {net}: cap_mm must be a number > 0"));
        }
        let slow_only = match a.get("slow_only") {
            None | Some(Json::Bool(false)) => false,
            Some(Json::Bool(true)) => true,
            _ => return Err(format!("alt_refs {net}: slow_only must be true or false")),
        };
        reason(a.get("reason"), &format!("alt_refs {net}"))?;
        Ok((net.clone(), AltRef { domain: domain.to_string(), cap_mm: number(cap_mm), slow_only }))
    }).collect()
}

fn read_domains(raw: &Json, grounds: &[String]) -> Result<Vec<(String, Vec<String>)>, String> {
    object(raw, "domains").iter().map(|(g, pats)| {
        match pats.strings().filter(|_| grounds.contains(g)) {
            Some(list) => Ok((g.clone(), list)),
            None => Err(format!("domains {g}: key must be a ground, value a list of net patterns")),
        }
    }).collect()
}

fn read_area(i: usize, area: &Json) -> Result<ExemptArea, String> {
    let bad = || format!("exempt area {i}: needs box [x0, y0, x1, y1] and nets");
    let rect: Vec<f64> = area.get("box").and_then(Json::as_arr).unwrap_or(&[]).iter().filter_map(Json::as_f64).collect();
    let nets = area.get("nets").filter(|n| n.truthy()).and_then(Json::strings).ok_or_else(bad)?;
    let rect = <[f64; 4]>::try_from(rect).map_err(|_| bad())?;
    reason(area.get("reason"), &format!("exempt area {i}"))?;
    Ok(ExemptArea { rect, nets })
}

fn read_exempt(raw: &Json) -> Result<(Vec<(String, String)>, Vec<ExemptArea>), String> {
    let exempt = raw.get("exempt").filter(|e| e.truthy());
    let unknown: BTreeSet<&str> = exempt.and_then(Json::as_obj).unwrap_or(&[]).iter().map(|(k, _)| k.as_str()).filter(|k| !["nets", "areas"].contains(k)).collect();
    if !unknown.is_empty() {
        return Err(format!("unknown exempt keys: {}", list_repr(&unknown.into_iter().collect::<Vec<_>>())));
    }
    let nets = exempt.and_then(|e| e.get("nets")).and_then(Json::as_obj).unwrap_or(&[]);
    for (net, why) in nets {
        reason(Some(why), &format!("exempt net {net}"))?;
    }
    let areas = exempt.and_then(|e| e.get("areas")).and_then(Json::as_arr).unwrap_or(&[]);
    Ok((nets.iter().map(|(k, v)| (k.clone(), v.text())).collect(), areas.iter().enumerate().map(|(i, a)| read_area(i, a)).collect::<Result<_, _>>()?))
}

fn read_mixed(raw: &Json, plane_layers: &[String]) -> Result<Vec<(String, MixedLayer)>, String> {
    object(raw, "mixed_layers").iter().map(|(layer, m)| {
        if !plane_layers.contains(layer) || m.as_obj().is_none() {
            return Err(format!("mixed_layers {layer}: must be a plane layer with an object value"));
        }
        let fast_file = m.get("fast_file").and_then(Json::as_str).filter(|f| !f.is_empty());
        let Some(fast_file) = fast_file.filter(|_| m.get("allow").and_then(Json::as_str) == Some("slow")) else {
            return Err(format!("mixed_layers {layer}: needs \"allow\": \"slow\" and \"fast_file\""));
        };
        let power = m.get("power").and_then(Json::strings).ok_or_else(|| format!("mixed_layers {layer}: \"power\" must be a list of net patterns"))?;
        reason(m.get("reason"), &format!("mixed_layers {layer}"))?;
        Ok((layer.clone(), MixedLayer { fast_file: fast_file.to_string(), power, fast: Vec::new() }))
    }).collect()
}

fn read_edge_classes(raw: &Json, rates: &EdgeRates, tools: &Path) -> Result<Vec<(String, Vec<String>)>, String> {
    let file = tools.join("edge-rates.json");
    object(raw, "edge_classes").iter().map(|(k, pats)| {
        if rates.get(k).is_none() {
            return Err(format!("edge_classes {k}: not a class of {} ({})", file.display(), list_repr(&rates.names())));
        }
        pats.strings().map(|p| (k.clone(), p)).ok_or_else(|| format!("edge_classes {k}: must be a list of net patterns"))
    }).collect()
}

fn read_receivers(raw: &Json) -> Result<Vec<(String, Vec<String>)>, String> {
    object(raw, "receivers").iter().map(|(net, r)| {
        let refs = r.get("refs").filter(|l| l.truthy()).and_then(Json::as_arr).map(|l| l.iter().map(Json::text).collect());
        let refs = refs.ok_or_else(|| format!("receivers {net}: needs \"refs\" (a list of part references)"))?;
        reason(r.get("reason"), &format!("receivers {net}"))?;
        Ok((net.clone(), refs))
    }).collect()
}

fn read_offboard(raw: &Json, rates: &EdgeRates, tools: &Path) -> Result<Vec<(String, Offboard)>, String> {
    let text = |o: &Json, key: &str| o.get(key).map_or(String::new(), Json::text);
    object(raw, "offboard").iter().map(|(net, o)| {
        let class = o.get("class").and_then(Json::as_str).filter(|c| rates.get(c).is_some());
        let class = class.ok_or_else(|| format!("offboard {net}: \"class\" must be a class of {}", tools.join("edge-rates.json").display()))?;
        reason(o.get("reason"), &format!("offboard {net}"))?;
        Ok((net.clone(), Offboard { class: class.to_string(), reason: text(o, "reason"), driver_mpn: text(o, "driver_mpn"), driver_pin: text(o, "driver_pin") }))
    }).collect()
}

fn read_step(raw: &Json, key: &str, default: f64) -> Result<f64, String> {
    let value = raw.get(key).map_or(Some(default), Json::as_f64);
    if positive_finite(value) { Ok(value.expect("checked")) } else { Err(format!("{key} must be a number > 0")) }
}

fn check_keys(raw: &Json) -> Result<(), String> {
    let keys = raw.as_obj().ok_or("spec must be a JSON object")?;
    let unknown: BTreeSet<&str> = keys.iter().map(|(k, _)| k.as_str()).filter(|k| !REQUIRED.contains(k) && !OTHER_KEYS.contains(k)).collect();
    if !unknown.is_empty() {
        return Err(format!("unknown spec keys: {}", list_repr(&unknown.into_iter().collect::<Vec<_>>())));
    }
    // plane_layers may be empty: a 2-layer board has no plane layer.
    let missing: Vec<&str> = REQUIRED.iter().copied().filter(|k| raw.get(k).is_none_or(|v| *k != "plane_layers" && !v.truthy())).collect();
    if missing.is_empty() { Ok(()) } else { Err(format!("missing spec keys: {}", list_repr(&missing))) }
}

impl Spec {
    /// Checks a spec and adds the defaults. `tools` is the folder of edge-rates.json.
    pub fn load(raw: &Json, tools: &Path) -> Result<Spec, String> {
        check_keys(raw)?;
        let (via_allow_mm, step_mm) = (read_step(raw, "via_allow_mm", 0.6)?, read_step(raw, "step_mm", 0.25)?);
        let adjacent = raw.get("adjacent").and_then(Json::as_obj);
        let (plane_layers, grounds) = (raw.get("plane_layers").and_then(Json::strings), raw.get("grounds").and_then(Json::strings));
        let (Some(adjacent), Some(plane_layers), Some(grounds)) = (adjacent, plane_layers, grounds) else {
            return Err("adjacent must be an object; plane_layers and grounds must be lists".to_string());
        };
        let alt_refs = read_alt_refs(raw, &grounds)?;
        let domains = read_domains(raw, &grounds)?;
        let (exempt_nets, exempt_areas) = read_exempt(raw)?;
        let mixed_layers = read_mixed(raw, &plane_layers)?;
        let power = raw.get("power").filter(|p| p.truthy()).map_or(Some(Vec::new()), Json::strings).ok_or("\"power\" must be a list of net patterns")?;
        let rates = load_edge_rates(tools)?;
        Ok(Spec {
            via_allow_mm,
            step_mm,
            adjacent: adjacent.iter().map(|(k, v)| (k.clone(), v.text())).collect(),
            alt_refs,
            domains,
            exempt_nets,
            exempt_areas,
            mixed_layers,
            fast_file: raw.get("fast_file").and_then(Json::as_str).filter(|f| !f.is_empty()).map(str::to_string),
            fast_top: Vec::new(),
            power,
            edge_classes: read_edge_classes(raw, &rates, tools)?,
            receivers: read_receivers(raw)?,
            offboard: read_offboard(raw, &rates, tools)?,
            schematic: raw.get("schematic").filter(|s| s.truthy()).map(Json::text),
            rates,
            plane_layers,
            grounds,
        })
    }

    /// Reads the fast_file of each mixed layer, relative to `spec_dir`. A missing or bad file stops (fail closed).
    pub fn load_fast(&mut self, spec_dir: &Path) -> Result<(), String> {
        for (layer, mixed) in &mut self.mixed_layers {
            let path = spec_dir.join(&mixed.fast_file);
            if !path.is_file() {
                return Err(format!("mixed_layers {layer}: no fast net file {}", path.display()));
            }
            let raw = Json::read(&path)?;
            let pats = raw.get("fast").filter(|p| p.truthy()).and_then(Json::strings);
            mixed.fast = pats.ok_or_else(|| format!("{}: \"fast\" must be a list of net patterns", path.display()))?;
        }
        if let Some(file) = &self.fast_file {
            let path = spec_dir.join(file);
            if !path.is_file() {
                return Err(format!("fast_file: no fast net file {}", path.display()));
            }
            self.fast_top = Json::read(&path)?.get("fast").and_then(Json::strings).unwrap_or_default();
        }
        Ok(())
    }

    pub fn adjacent_of(&self, layer: &str) -> Option<&str> {
        self.adjacent.iter().find(|(k, _)| k == layer).map(|(_, v)| v.as_str())
    }

    fn is_ground(&self, net: &str) -> bool {
        self.grounds.iter().any(|g| g == net)
    }

    pub fn checked(&self, net: &str) -> bool {
        !self.is_ground(net) && !self.exempt_nets.iter().any(|(n, _)| n == net)
    }

    pub fn power_patterns(&self) -> Vec<String> {
        self.power.iter().chain(self.mixed_layers.iter().flat_map(|(_, m)| &m.power)).cloned().collect()
    }

    /// A power or DC net (no reference rule): a ground, the top-level "power" or a mixed layer "power" pattern.
    pub fn is_power(&self, net: &str) -> bool {
        self.is_ground(net) || matches_any(net, &self.power_patterns())
    }

    pub fn is_fast(&self, net: &str) -> bool {
        matches_any(net, &self.fast_top) || self.mixed_layers.iter().any(|(_, m)| self.net_kind(net, m) == "fast")
    }

    /// "fast", "power" or "slow" for a net on a mixed layer. Every ground is power.
    pub fn net_kind(&self, net: &str, m: &MixedLayer) -> &'static str {
        if matches_any(net, &m.fast) {
            "fast"
        } else if self.is_ground(net) || matches_any(net, &m.power) {
            "power"
        } else {
            "slow"
        }
    }

    /// The interface class of a net ("edge_classes"), else None: the edge then comes from the net's driver.
    pub fn edge_class(&self, net: &str) -> Option<&str> {
        self.edge_classes.iter().find(|(_, pats)| matches_any(net, pats)).map(|(k, _)| k.as_str())
    }

    /// Every layer and net the spec names must exist on the board (no stale exemption).
    pub fn check_against_board(&self, board: &Board) -> Result<(), String> {
        let layers = self.adjacent.iter().flat_map(|(k, v)| [k, v]).chain(&self.plane_layers);
        let want: BTreeSet<&String> = layers.filter(|l| !board.copper_layers.contains(l)).collect();
        if !want.is_empty() {
            return Err(format!("layers not on the board: {}", list_repr(&want.into_iter().collect::<Vec<_>>())));
        }
        let nets = self.grounds.iter().chain(self.alt_refs.iter().map(|(n, _)| n)).chain(self.exempt_nets.iter().map(|(n, _)| n)).chain(self.exempt_areas.iter().flat_map(|a| &a.nets));
        let want: BTreeSet<&String> = nets.filter(|n| !board.nets.contains_key(*n)).collect();
        if want.is_empty() { Ok(()) } else { Err(format!("nets not on the board: {}", list_repr(&want.into_iter().collect::<Vec<_>>()))) }
    }

    /// The domain of a reference net (a ground or an alt_ref), else None. A slow_only alt_ref is no reference for a fast net. An
    /// alt_ref with cap_mm is a reference only within cap_mm of a decoupling cap centre.
    pub fn ref_domain(&self, reference: Option<&str>, fast: bool, at: (f64, f64), caps: &Caps) -> Option<&str> {
        let reference = reference?;
        if let Some(ground) = self.grounds.iter().find(|g| *g == reference) {
            return Some(ground);
        }
        let (_, a) = self.alt_refs.iter().find(|(n, _)| n == reference)?;
        if fast && a.slow_only {
            return None;
        }
        if let Some(cap) = a.cap_mm
            && !caps.get(reference).is_some_and(|list| list.iter().any(|c| dist(at, *c) <= cap))
        {
            return None;
        }
        Some(&a.domain)
    }

    /// Domain of a net: a spec pattern first, else the domain that holds most of its pads. A tie gives None.
    pub fn net_domain(&self, net: &str, pad_refs: &[Option<String>]) -> Option<String> {
        if let Some((g, _)) = self.domains.iter().find(|(_, pats)| matches_any(net, pats)) {
            return Some(g.clone());
        }
        let mut votes: Vec<(String, u32)> = Vec::new();
        for domain in pad_refs.iter().filter_map(|r| self.ref_domain(r.as_deref(), false, (0.0, 0.0), &Caps::new())) {
            crate::si::py::count(&mut votes, domain.to_string(), 1);
        }
        let top = most_common(&votes);
        match top.as_slice() {
            [] => None,
            [first, second, ..] if first.1 == second.1 => None,
            [first, ..] => Some(first.0.clone()),
        }
    }
}

/// Alt-ref net -> the centres of its decoupling caps.
pub type Caps = BTreeMap<String, Vec<(f64, f64)>>;

pub fn matches_any(net: &str, patterns: &[String]) -> bool {
    patterns.iter().any(|q| glob_match(net, q))
}
