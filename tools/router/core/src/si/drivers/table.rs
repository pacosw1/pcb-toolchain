//! tools/driver-edges.json: per part, the role and edge time of each pin, with its source. Never a default.
use crate::model::text::glob_match;
use crate::sha256::sha256;
use crate::si::ibis::{self, Ibis, Model};
use crate::si::json::Json;
use crate::si::planes::spec::positive_finite;
use regex_lite::Regex;
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const ROLES: [&str; 5] = ["input", "push_pull", "open_drain", "opto", "unknown"];

/// `re.fullmatch` of a table pattern.
pub fn regex_full(pattern: &str) -> Result<Regex, String> {
    Regex::new(&format!("^(?:{pattern})$")).map_err(|e| format!("bad pin pattern {pattern}: {e}"))
}

/// Checks the exact local evidence a table declares. `tools` is the folder of the table; the paths start at its parent.
pub fn verify_evidence(raw: &Json, tools: &Path) -> Result<(), String> {
    let root = tools.parent().unwrap_or(tools);
    for e in raw.get("evidence_files").and_then(Json::as_arr).unwrap_or(&[]) {
        let path = e.get("path").and_then(Json::as_str).unwrap_or("");
        if !(path.starts_with("hardware-design/registry/datasheets/") || path.starts_with("hardware-design/registry/ibis/")) || path.split('/').any(|p| p == "..") {
            return Err("invalid driver evidence path".to_string());
        }
        let bytes = std::fs::read(root.join(path)).map_err(|_| format!("missing or changed driver evidence: {path}"))?;
        if e.get("sha256").and_then(Json::as_str) != Some(sha256(&bytes).as_str()) {
            return Err(format!("missing or changed driver evidence: {path}"));
        }
    }
    Ok(())
}

/// How a bound output's edge is limited: t >= C x dV / I (D-124b).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Bound {
    pub i_ma: f64,
    pub i_source: String,
    pub supply_pin: Option<String>,
    pub pullup: bool,
    pub vdd_v: Option<f64>,
    pub vdd_source: String,
    pub cpin_pf: Option<f64>,
    pub cpin_source: String,
}

#[derive(Debug, Clone)]
pub struct Rule {
    pub matcher: Regex,
    pub role: String,
    pub tr_ns: Option<f64>,
    pub tf_ns: Option<f64>,
    pub source: String,
    pub ibis_model: Option<String>,
    pub bound: Option<Bound>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct IbisRef {
    pub file: String,
    pub sha256: Option<String>,
    pub component: String,
    pub supply_pin: String,
    pub url: String,
    pub downloaded: String,
    /// Volts as the file spells them, with the model suffix, in file order.
    pub variants: Vec<(f64, String)>,
}

#[derive(Debug, Clone)]
pub struct Part {
    pub key: String,
    pub mpn: Vec<String>,
    pub pins: Vec<Rule>,
    pub pin_c: Option<(f64, String)>,
    pub ibis: Option<IbisRef>,
}

impl Part {
    /// The first rule that matches a pin.
    pub fn rule(&self, pin: &str) -> Option<&Rule> {
        self.pins.iter().find(|r| r.matcher.is_match(pin))
    }
}

#[derive(Debug)]
pub struct Table {
    pub parts: Vec<Part>,
    root: PathBuf,
    loaded: RefCell<BTreeMap<String, Ibis>>,
}

fn text(json: &Json, key: &str) -> String {
    json.get(key).map_or(String::new(), Json::text)
}

fn number(json: &Json, key: &str) -> Option<f64> {
    json.get(key).and_then(Json::as_f64)
}

fn read_bound(b: &Json, role: &str, place: &str) -> Result<Bound, String> {
    if !positive_finite(number(b, "i_ma")) || text(b, "i_source").trim().is_empty() {
        return Err(format!("{place}: a bound needs i_ma > 0 and i_source"));
    }
    let supply_pin = b.get("supply_pin").filter(|p| p.truthy()).map(Json::text);
    let pullup = b.get("pullup").is_some_and(Json::truthy);
    if supply_pin.is_none() && !positive_finite(number(b, "vdd_v")) && !(role == "open_drain" && pullup) {
        return Err(format!("{place}: a bound needs supply_pin, vdd_v or (open drain) \"pullup\": true"));
    }
    if b.get("cpin_pf").is_some() && (!positive_finite(number(b, "cpin_pf")) || text(b, "cpin_source").trim().is_empty()) {
        return Err(format!("{place}: cpin_pf needs a value > 0 and cpin_source"));
    }
    Ok(Bound {
        i_ma: number(b, "i_ma").expect("checked"),
        i_source: text(b, "i_source"),
        supply_pin,
        pullup,
        vdd_v: number(b, "vdd_v"),
        vdd_source: text(b, "vdd_source"),
        cpin_pf: number(b, "cpin_pf"),
        cpin_source: text(b, "cpin_source"),
    })
}

fn read_rule(rule: &Json, has_ibis: bool, place: &str) -> Result<Rule, String> {
    let role = rule.get("role").and_then(Json::as_str).filter(|r| ROLES.contains(r));
    let (Some(role), Some(matcher)) = (role, rule.get("match").and_then(Json::as_str)) else {
        return Err(format!("{place}: needs \"match\" (regex) and a role of ('input', 'push_pull', 'open_drain', 'opto', 'unknown')"));
    };
    let ibis_model = rule.get("ibis_model").filter(|m| m.truthy()).map(Json::text);
    if ibis_model.is_some() && !has_ibis {
        return Err(format!("{place}: IBIS model needs source binding"));
    }
    let bound = rule.get("bound").map(|b| read_bound(b, role, place)).transpose()?;
    let alternative = ibis_model.is_some() || bound.is_some();
    let (tr_ns, tf_ns) = (number(rule, "tr_ns"), number(rule, "tf_ns"));
    if matches!(role, "push_pull" | "opto") && !alternative && !(positive_finite(tr_ns) && positive_finite(tf_ns)) {
        return Err(format!("{place}: {role} needs tr_ns and tf_ns > 0"));
    }
    if role == "open_drain" && !alternative && !positive_finite(tf_ns) {
        return Err(format!("{place}: open_drain needs tf_ns > 0 (the driver fall time)"));
    }
    if role != "input" && text(rule, "source").trim().is_empty() {
        return Err(format!("{place}: a {role} rule needs a source (or the reason it is unknown)"));
    }
    Ok(Rule { matcher: regex_full(matcher)?, role: role.to_string(), tr_ns, tf_ns, source: text(rule, "source"), ibis_model, bound })
}

fn read_ibis(key: &str, ib: &Json, evidence: &[Json]) -> Result<IbisRef, String> {
    let (file, sha) = (text(ib, "file"), ib.get("sha256").and_then(Json::as_str).map(str::to_string));
    let declared = evidence.iter().any(|e| e.get("path").and_then(Json::as_str) == Some(&file) && e.get("sha256").and_then(Json::as_str) == sha.as_deref());
    if !declared {
        return Err(format!("{key}: IBIS source closure missing"));
    }
    if ["component", "supply_pin", "url", "downloaded"].iter().any(|k| ib.get(k).and_then(Json::as_str).is_none_or(|v| v.trim().is_empty())) {
        return Err(format!("{key}: incomplete IBIS source/model metadata"));
    }
    let variants = ib.get("variants").and_then(Json::as_obj).filter(|v| !v.is_empty()).ok_or_else(|| format!("{key}: missing IBIS voltage variants"))?;
    let variants = variants.iter().map(|(volts, suffix)| {
        let voltage: f64 = volts.trim().parse().map_err(|_| format!("{key}: invalid IBIS voltage variant"))?;
        match suffix.as_str().filter(|s| !s.is_empty() && positive_finite(Some(voltage))) {
            Some(suffix) => Ok((voltage, suffix.to_string())),
            None => Err(format!("{key}: invalid IBIS voltage/model suffix")),
        }
    }).collect::<Result<_, String>>()?;
    Ok(IbisRef { file, sha256: sha, component: text(ib, "component"), supply_pin: text(ib, "supply_pin"), url: text(ib, "url"), downloaded: text(ib, "downloaded"), variants })
}

fn read_part(path: &str, key: &str, p: &Json, evidence: &[Json]) -> Result<Part, String> {
    let mpn = p.get("mpn").and_then(Json::strings).filter(|m| !m.is_empty());
    let (Some(mpn), Some(rules)) = (mpn, p.get("pins").and_then(Json::as_arr)) else {
        return Err(format!("{path}: part {key} needs \"mpn\" (patterns) and \"pins\" (rules)"));
    };
    let pin_c = p.get("pin_c").map(|c| {
        let pf = number(c, "pf");
        if !positive_finite(pf) || text(c, "source").trim().is_empty() {
            return Err(format!("{key}: invalid sourced pin capacitance"));
        }
        Ok((pf.expect("checked"), text(c, "source")))
    }).transpose()?;
    let ibis = p.get("ibis").map(|ib| read_ibis(key, ib, evidence)).transpose()?;
    let pins = rules.iter().enumerate().map(|(i, r)| read_rule(r, ibis.is_some(), &format!("{path}: part {key} pin rule {i}"))).collect::<Result<_, _>>()?;
    Ok(Part { key: key.to_string(), mpn, pins, pin_c, ibis })
}

impl Table {
    /// The parts of driver-edges.json in `tools`. Each rule needs a role; a driver role needs its times and a source.
    pub fn load(tools: &Path) -> Result<Table, String> {
        let path = tools.join("driver-edges.json");
        let raw = Json::read(&path)?;
        verify_evidence(&raw, tools)?;
        let name = path.display().to_string();
        let parts = raw.get("parts").and_then(Json::as_obj).filter(|p| !p.is_empty()).ok_or_else(|| format!("{name}: \"parts\" must be an object"))?;
        let evidence = raw.get("evidence_files").and_then(Json::as_arr).unwrap_or(&[]);
        let parts = parts.iter().map(|(key, p)| read_part(&name, key, p, evidence)).collect::<Result<_, _>>()?;
        Ok(Table { parts, root: tools.parent().unwrap_or(tools).to_path_buf(), loaded: RefCell::new(BTreeMap::new()) })
    }

    pub fn part_of(&self, mpn: &str) -> Option<&Part> {
        self.parts.iter().find(|p| p.mpn.iter().any(|q| glob_match(mpn, q)))
    }

    /// Reads an IBIS file once and gives `read` its parsed form.
    pub fn with_ibis<T>(&self, ib: &IbisRef, read: impl FnOnce(&Ibis) -> Result<T, String>) -> Result<T, String> {
        let mut loaded = self.loaded.borrow_mut();
        if !loaded.contains_key(&ib.file) {
            loaded.insert(ib.file.clone(), ibis::load(&self.root.join(&ib.file), ib.sha256.as_deref())?);
        }
        read(&loaded[&ib.file])
    }

    pub fn ibis_model(&self, ib: &IbisRef, name: &str) -> Result<Model, String> {
        self.with_ibis(ib, |parsed| parsed.models.get(&name.to_lowercase()).cloned().ok_or_else(|| format!("IBIS model {name} is not in {}", ib.file)))
    }

    #[cfg(test)]
    pub fn of_parts(parts: Vec<Part>, root: PathBuf) -> Table {
        Table { parts, root, loaded: RefCell::new(BTreeMap::new()) }
    }
}
