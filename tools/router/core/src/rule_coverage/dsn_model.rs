//! The actual DSN as a model: units, signal layers, classes with their masks, and every clearance it declares.
use super::forms::{dsn_forms, form_repr, is_atoms, key};
use crate::decimal::Decimal;
use crate::kicad::raw::Form;
use crate::pytext::repr;
use std::collections::{BTreeMap, BTreeSet};

/// More digits than this do not fit the exact product with a unit; Python's Decimal would round them. Refused instead.
const MAX_DIGITS: usize = 28;

/// A length unit in mm.
pub fn unit_mm(unit: &str) -> Option<Decimal> {
    Decimal::parse(match unit {
        "mm" => "1",
        "um" => "0.001",
        "mil" => "0.0254",
        "in" => "25.4",
        _ => return None,
    })
}

/// A rule or model number in mm, with an optional unit; `unit` applies when it has none. Exact, keeping the written scale.
pub fn number(text: &str, unit: &str) -> Result<Decimal, String> {
    let bad = || format!("unsupported numeric value or units: {text}");
    let body = text.strip_prefix('+').unwrap_or(text);
    let end = body.find(|c: char| !c.is_ascii_digit() && c != '.').unwrap_or(body.len());
    let (digits, rest) = body.split_at(end);
    let named = rest.trim_start();
    let scale = unit_mm(if named.is_empty() { unit } else { named }).ok_or_else(bad)?;
    let shape = digits.matches('.').count() <= 1 && digits.chars().any(|c| c.is_ascii_digit()) && digits.len() <= MAX_DIGITS;
    Ok(Decimal::parse(digits).filter(|_| shape).ok_or_else(bad)? * scale)
}

fn form_number(form: &Form, unit: &str) -> Result<Decimal, String> {
    match form.atom() {
        Some(text) => number(text, unit),
        None => Err(format!("unsupported numeric value or units: {}", form_repr(form))),
    }
}

/// Exported pad-to-pad exceptions cannot apply to new tracks or vias.
fn is_pad_only(clearance: &Form) -> bool {
    match clearance.items() {
        [_, _, qualifier] => ["smd_smd", "pin_pin", "pin_smd"].iter().any(|kind| is_atoms(qualifier, &["type", kind])),
        _ => false,
    }
}

fn clearances(form: &Form, unit: &str) -> Result<Vec<Decimal>, String> {
    let mut values = Vec::new();
    for rule in form.children("rule") {
        for item in rule.children("clearance").filter(|item| !is_pad_only(item)) {
            let value = item.items().get(1).ok_or("invalid DSN clearance")?;
            values.push(form_number(value, unit)?);
        }
    }
    Ok(values)
}

fn gather_clearances(form: &Form, unit: &str, out: &mut Vec<Decimal>) -> Result<(), String> {
    if form.is("clearance") && !is_pad_only(form) {
        let value = form.items().get(1).ok_or("invalid nested DSN clearance")?;
        out.push(form_number(value, unit)?);
    }
    form.items().iter().try_for_each(|item| gather_clearances(item, unit, out))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassModel {
    pub layers: Vec<String>,
    pub clearances: Vec<Decimal>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Model {
    pub unit: String,
    pub actual_layers: BTreeSet<String>,
    pub classes: BTreeMap<String, ClassModel>,
    /// Net to class.
    pub membership: BTreeMap<String, String>,
    pub pairs: BTreeMap<(String, String), Vec<Decimal>>,
    pub defaults: Vec<Decimal>,
    /// Every new-copper clearance anywhere in the DSN.
    pub all_clearances: Vec<Decimal>,
}

fn read_unit(root: &Form) -> Result<String, String> {
    let bad = || "unknown or ambiguous DSN units".to_string();
    let units: Vec<&Form> = root.children("unit").collect();
    let [unit] = units.as_slice() else { return Err(bad()) };
    let [_, name] = unit.items() else { return Err(bad()) };
    let name = key(name)?;
    unit_mm(name).map(|_| name.to_string()).ok_or_else(bad)
}

fn check_resolution(root: &Form, unit: &str) -> Result<(), String> {
    let forms: Vec<&Form> = root.children("resolution").collect();
    let valid = match forms.as_slice() {
        [form] => match form.items() {
            [_, name, count] => name.atom() == Some(unit) && count.atom().is_some_and(is_resolution),
            _ => false,
        },
        _ => false,
    };
    if valid { Ok(()) } else { Err("DSN resolution and unit must agree unambiguously".to_string()) }
}

fn is_resolution(text: &str) -> bool {
    text.starts_with(|c: char| ('1'..='9').contains(&c)) && text.chars().all(|c| c.is_ascii_digit()) && text.parse::<u64>().is_ok_and(|value| value <= 2147483647)
}

/// Every layer of the structure, and the signal ones in order.
fn read_layers(structure: &Form) -> Result<(BTreeSet<String>, Vec<String>), String> {
    let bad = || "unknown or ambiguous actual DSN layer type".to_string();
    let (mut seen, mut signal) = (BTreeSet::new(), Vec::new());
    for layer in structure.children("layer") {
        let name = key(layer.items().get(1).ok_or_else(bad)?)?;
        let types: Vec<&Form> = layer.children("type").collect();
        let [kind] = types.as_slice() else { return Err(bad()) };
        let [_, value] = kind.items() else { return Err(bad()) };
        let value = value.atom().filter(|text| matches!(*text, "signal" | "power")).ok_or_else(bad)?;
        if !seen.insert(name.to_string()) {
            return Err(bad());
        }
        if value == "signal" {
            signal.push(name.to_string());
        }
    }
    Ok((seen, signal))
}

impl Model {
    pub fn new(text: &str, layers: &[String]) -> Result<Model, String> {
        let forms = dsn_forms(text)?;
        let [root] = forms.as_slice() else { return Err("expected one complete DSN PCB".to_string()) };
        if !root.is("pcb") {
            return Err("expected one complete DSN PCB".to_string());
        }
        let unit = read_unit(root)?;
        check_resolution(root, &unit)?;
        let networks: Vec<&Form> = root.children("network").collect();
        let structures: Vec<&Form> = root.children("structure").collect();
        let ([network], [structure]) = (networks.as_slice(), structures.as_slice()) else {
            return Err("missing or ambiguous DSN network/structure".to_string());
        };
        let (actual_layers, signal) = read_layers(structure)?;
        if signal.is_empty() || !layers.iter().all(|layer| signal.contains(layer)) {
            return Err("requested layers absent from actual DSN signal layers".to_string());
        }
        let defaults = clearances(structure, &unit)?;
        if defaults.is_empty() {
            return Err("no explicit DSN fallback clearance".to_string());
        }
        let mut all_clearances = Vec::new();
        gather_clearances(root, &unit, &mut all_clearances)?;
        let mut model = Model { unit, actual_layers, classes: BTreeMap::new(), membership: BTreeMap::new(), pairs: BTreeMap::new(), defaults, all_clearances };
        for form in network.children("class") {
            model.read_class(form, &signal)?;
        }
        for form in network.children("class_class") {
            model.read_class_pair(form)?;
        }
        Ok(model)
    }

    fn read_class(&mut self, form: &Form, signal: &[String]) -> Result<(), String> {
        let name = key(form.items().get(1).ok_or("ambiguous DSN class")?)?;
        if self.classes.contains_key(name) {
            return Err("ambiguous DSN class".to_string());
        }
        let layers = class_layers(form, signal)?;
        self.classes.insert(name.to_string(), ClassModel { layers, clearances: clearances(form, &self.unit)? });
        for net in form.items().iter().skip(2).filter_map(Form::atom) {
            if self.membership.insert(net.to_string(), name.to_string()).is_some() {
                return Err(format!("ambiguous DSN net membership: {net}"));
            }
        }
        Ok(())
    }

    fn read_class_pair(&mut self, form: &Form) -> Result<(), String> {
        let bad = || "invalid DSN class-pair membership".to_string();
        let names: Vec<&Form> = form.children("classes").collect();
        let [names] = names.as_slice() else { return Err(bad()) };
        let [_, a, b] = names.items() else { return Err(bad()) };
        let (a, b) = (key(a)?, key(b)?);
        if !self.classes.contains_key(a) || !self.classes.contains_key(b) {
            return Err(bad());
        }
        let pair = if a <= b { (a.to_string(), b.to_string()) } else { (b.to_string(), a.to_string()) };
        if self.pairs.contains_key(&pair) {
            return Err("ambiguous DSN class-pair rules".to_string());
        }
        self.pairs.insert(pair, clearances(form, &self.unit)?);
        Ok(())
    }

    /// The layers a net may use. The net must be in the model.
    pub fn allowed(&self, net: &str) -> Result<&[String], String> {
        let class = self.membership.get(net).ok_or_else(|| repr(net))?;
        self.classes.get(class).map(|model| model.layers.as_slice()).ok_or_else(|| repr(class))
    }

    /// The lowest clearance that could apply between two nets, `right` empty for no second net. Exact: it admits only if every
    /// potentially applicable declaration suffices, so no class, type or precedence override is assumed.
    pub fn clearance_floor(&self, left: &str, right: Option<&str>) -> Result<Decimal, String> {
        let class_a = self.membership.get(left).ok_or_else(|| repr(left))?;
        let mut values = self.defaults.clone();
        values.extend(&self.classes[class_a].clearances);
        if let Some(right) = right.filter(|net| !net.is_empty()) {
            let class_b = self.membership.get(right).ok_or_else(|| repr(right))?;
            values.extend(&self.classes[class_b].clearances);
            let pair = if class_a <= class_b { (class_a.clone(), class_b.clone()) } else { (class_b.clone(), class_a.clone()) };
            values.extend(self.pairs.get(&pair).into_iter().flatten());
        }
        values.extend(&self.all_clearances);
        first_minimum(&values).ok_or_else(|| "no attributable DSN clearance".to_string())
    }
}

/// The first of the lowest values: equal values can differ in written scale, and the record shows the text.
pub(super) fn first_minimum(values: &[Decimal]) -> Option<Decimal> {
    values.iter().copied().reduce(|low, value| if value < low { value } else { low })
}

fn class_layers(form: &Form, signal: &[String]) -> Result<Vec<String>, String> {
    let circuits: Vec<&Form> = form.children("circuit").collect();
    let masks: Vec<&Form> = if let [circuit] = circuits.as_slice() { circuit.children("use_layer").collect() } else { Vec::new() };
    if circuits.len() > 1 || masks.len() > 1 {
        return Err("ambiguous DSN layer mask".to_string());
    }
    let Some(mask) = masks.first() else { return Ok(signal.to_vec()) };
    let bad = || "invalid DSN layer mask".to_string();
    let names: Vec<&str> = mask.items()[1..].iter().map(key).collect::<Result<_, _>>()?;
    let unique: BTreeSet<&&str> = names.iter().collect();
    if names.is_empty() || unique.len() != names.len() || !names.iter().all(|name| signal.iter().any(|layer| layer == name)) {
        return Err(bad());
    }
    Ok(names.into_iter().map(str::to_string).collect())
}
