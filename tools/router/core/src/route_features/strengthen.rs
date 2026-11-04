//! Raising the DSN clearance atoms to the applicable authored floor. No geometry, membership, settings or pad-only exception
//! is rewritten. A value with no exact form at the DSN resolution abstains: no rounding, no precedence assumption, no floats.
use super::exact::Exact;
use crate::decimal::Decimal;
use crate::kicad::raw::Form;
use crate::rule_coverage::{ClearanceRequirement, Model, RouteScope, dsn_forms, project_clearance_requirement, unit_mm};
use crate::sha256::sha256;
use serde::Serialize;
use std::cmp::Ordering;

pub const STRENGTHENING_SCHEMA: &str = "iot-lab.dsn-clearance-strengthening.v1";
const SCOPE: &str = "conservative model strengthening only; complete fresh native/configured gates remain required";
const PAD_ONLY: [&str; 3] = ["smd_smd", "pin_pin", "pin_smd"];
const NEW_COPPER: [&str; 7] = ["wire_wire", "wire_pin", "wire_smd", "wire_via", "via_via", "via_pin", "via_smd"];

/// One raised atom. `start` and `end` count characters, as the receipts always have.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ClearanceEdit {
    pub start: usize,
    pub end: usize,
    pub before: String,
    pub after: String,
    pub types: Vec<String>,
    pub location: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectBinding {
    pub path: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StrengthenReceipt {
    pub schema: &'static str,
    pub status: &'static str,
    pub scope: &'static str,
    pub project: ProjectBinding,
    pub before_sha256: String,
    pub after_sha256: String,
    pub unit: String,
    pub resolution: u32,
    pub changes: Vec<ClearanceEdit>,
    #[serde(flatten)]
    pub requirement: ClearanceRequirement,
    pub qualified: bool,
}

struct Floor {
    required: Exact,
    unit: Exact,
    resolution: Exact,
}

/// The walk over the forms. Byte spans of the text; the receipt turns them into character counts.
struct Walk<'a> {
    text: &'a str,
    floor: Floor,
    declarations: [std::ops::Range<usize>; 2],
    edits: Vec<(std::ops::Range<usize>, ClearanceEdit)>,
}

fn is_quoted(text: &str, form: &Form) -> bool {
    text.as_bytes()[form.span.start] == b'"'
}

/// `[+]digits[.digits]` or `.digits`, nothing after.
fn is_plain_number(text: &str) -> bool {
    let body = text.strip_prefix('+').unwrap_or(text);
    let (whole, fraction) = body.split_once('.').unwrap_or((body, ""));
    let digits = |part: &str| part.chars().all(|c| c.is_ascii_digit());
    !(whole.is_empty() && fraction.is_empty()) && digits(whole) && digits(fraction)
}

/// Every list has an unquoted atom at its head.
fn check_heads(form: &Form) -> Result<(), String> {
    if matches!(form.body, crate::kicad::raw::Body::List(_)) {
        if form.items().first().and_then(Form::atom).is_none() {
            return Err("empty or malformed DSN form".to_string());
        }
        form.items().iter().try_for_each(check_heads)?;
    }
    Ok(())
}

impl Walk<'_> {
    fn form(&mut self, form: &Form, path: &str) -> Result<(), String> {
        if is_quoted(self.text, &form.items()[0]) {
            return Err("quoted DSN form keyword is unsupported".to_string());
        }
        if (form.is("unit") || form.is("resolution")) && !self.declarations.contains(&form.span) {
            return Err("nested DSN unit/resolution overrides are unsupported".to_string());
        }
        if form.is("clearance") {
            self.clearance(form, path)?;
        }
        for (index, child) in form.items().iter().enumerate().skip(1) {
            if !child.items().is_empty() {
                self.form(child, &format!("{path}/{index}"))?;
            }
        }
        Ok(())
    }

    fn clearance(&mut self, form: &Form, path: &str) -> Result<(), String> {
        let items = form.items();
        let token = items.get(1).filter(|_| matches!(items.len(), 2 | 3)).filter(|token| !is_quoted(self.text, token));
        let Some((token, value)) = token.and_then(|token| Some((token, token.atom()?))).filter(|(_, value)| is_plain_number(value)) else {
            return Err("malformed/nonfinite DSN clearance or inline units".to_string());
        };
        let types = self.qualifier(items.get(2))?;
        let number = Decimal::parse(value).and_then(Exact::from_decimal).ok_or("malformed/nonfinite DSN clearance or inline units")?;
        let on_grid = number.mul(self.floor.resolution).is_some_and(Exact::is_integer);
        if !on_grid {
            return Err("DSN clearance is not exactly representable at declared resolution".to_string());
        }
        let current = number.mul(self.floor.unit).ok_or(TOO_BIG)?;
        let pad_only = matches!(types.as_slice(), [only] if PAD_ONLY.contains(&only.as_str()));
        if !pad_only && current.compare(self.floor.required).ok_or(TOO_BIG)? == Ordering::Less {
            let after = self.required_text()?;
            let edit = ClearanceEdit { start: 0, end: 0, before: value.to_string(), after, types, location: path.to_string() };
            self.edits.push((token.span.clone(), edit));
        }
        Ok(())
    }

    fn required_text(&self) -> Result<String, String> {
        let required = self.floor.required.div(self.floor.unit).ok_or(TOO_BIG)?;
        if !required.mul(self.floor.resolution).is_some_and(Exact::is_integer) {
            return Err("required clearance is not exactly representable at DSN resolution".to_string());
        }
        required.finite_text().ok_or_else(|| "required clearance has no exact finite DSN-unit representation".to_string())
    }

    /// The `(type ...)` of a clearance, checked.
    fn qualifier(&self, form: Option<&Form>) -> Result<Vec<String>, String> {
        let Some(form) = form else { return Ok(Vec::new()) };
        let items = form.items();
        let unquoted = items.iter().all(|item| item.atom().is_some() && !is_quoted(self.text, item));
        let known = |item: &Form| item.atom().is_some_and(|name| PAD_ONLY.contains(&name) || NEW_COPPER.contains(&name));
        if !form.is("type") || items.len() < 2 || !unquoted || !items[1..].iter().all(known) {
            return Err("unknown or malformed DSN clearance qualifier".to_string());
        }
        let types: Vec<String> = items[1..].iter().filter_map(Form::atom).map(str::to_string).collect();
        let mut unique = types.clone();
        unique.sort();
        unique.dedup();
        if unique.len() != types.len() {
            return Err("duplicated DSN clearance types".to_string());
        }
        Ok(types)
    }
}

const TOO_BIG: &str = "required clearance has no exact finite DSN-unit representation";

/// The one unit and resolution of the root, with their spans, or an error when they are not plain atoms.
fn declarations<'a>(text: &str, root: &'a Form) -> Result<(&'a Form, &'a Form), String> {
    let plain = |form: &Form| form.items().iter().all(|item| item.atom().is_some() && !is_quoted(text, item));
    let units: Vec<&Form> = root.items()[1..].iter().filter(|form| form.is("unit")).collect();
    let resolutions: Vec<&Form> = root.items()[1..].iter().filter(|form| form.is("resolution")).collect();
    match (units.as_slice(), resolutions.as_slice()) {
        ([unit], [resolution]) if root.is("pcb") && plain(unit) && plain(resolution) => Ok((unit, resolution)),
        _ => Err("ambiguous DSN unit/resolution declaration".to_string()),
    }
}

fn floor_of(requirement: &ClearanceRequirement, model: &Model, resolution: u32) -> Result<Floor, String> {
    let required = Decimal::parse(&requirement.required_mm).and_then(Exact::from_decimal).ok_or(TOO_BIG)?;
    let unit = unit_mm(&model.unit).and_then(Exact::from_decimal).ok_or(TOO_BIG)?;
    Ok(Floor { required, unit, resolution: Exact::from_int(resolution.into()) })
}

/// The text with the edits made, and the edits with their character offsets.
fn applied(text: &str, edits: Vec<(std::ops::Range<usize>, ClearanceEdit)>) -> (String, Vec<ClearanceEdit>) {
    let (mut out, mut cursor, mut changes) = (String::with_capacity(text.len()), 0, Vec::with_capacity(edits.len()));
    for (span, mut edit) in edits {
        out.push_str(&text[cursor..span.start]);
        out.push_str(&edit.after);
        edit.start = text[..span.start].chars().count();
        edit.end = edit.start + text[span.clone()].chars().count();
        cursor = span.end;
        changes.push(edit);
    }
    out.push_str(&text[cursor..]);
    (out, changes)
}

/// Raises every existing new-copper clearance of `text` to the floor of `project_text`. `source` is the project path the
/// receipt names. An error is a value this cannot prove; the model is then not admitted.
pub fn strengthen_project_clearance(text: &str, project_text: &str, source: &str, scope: &RouteScope) -> Result<(String, StrengthenReceipt), String> {
    let model = Model::new(text, scope.layers).map_err(|error| format!("invalid source DSN model: {error}"))?;
    let requirement = project_clearance_requirement(project_text, source, scope)?;
    if requirement.counterparts.iter().any(|net| !net.is_empty() && !model.membership.contains_key(net)) {
        return Err("native active/retained net is absent from the DSN model".to_string());
    }
    let forms = dsn_forms(text)?;
    let root = &forms[0];
    check_heads(root)?;
    let (unit, resolution) = declarations(text, root)?;
    let resolution_value: u32 = resolution.text(2).and_then(|value| value.parse().ok()).ok_or("ambiguous DSN unit/resolution declaration")?;
    let floor = floor_of(&requirement, &model, resolution_value)?;
    let mut walk = Walk { text, floor, declarations: [unit.span.clone(), resolution.span.clone()], edits: Vec::new() };
    walk.form(root, "")?;
    let (strengthened, changes) = applied(text, walk.edits);
    let required = Decimal::parse(&requirement.required_mm).ok_or(TOO_BIG)?;
    if Model::new(&strengthened, scope.layers)?.all_clearances.iter().any(|value| *value < required) {
        return Err("strengthened DSN still has a weaker new-copper declaration".to_string());
    }
    let receipt = StrengthenReceipt {
        schema: STRENGTHENING_SCHEMA,
        status: "passed",
        scope: SCOPE,
        project: ProjectBinding { path: source.to_string(), sha256: sha256(project_text.as_bytes()) },
        before_sha256: sha256(text.as_bytes()),
        after_sha256: sha256(strengthened.as_bytes()),
        unit: model.unit.clone(),
        resolution: resolution_value,
        changes,
        requirement,
        qualified: false,
    };
    Ok((strengthened, receipt))
}
