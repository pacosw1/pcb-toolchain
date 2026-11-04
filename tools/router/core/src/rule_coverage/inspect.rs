//! The decision per native rule, against the actual DSN model. Everything not proved stays unsupported and blocks.
use super::dsn_model::{first_minimum, number};
use super::forms::{form_repr, is_atoms, key, rule_forms};
use super::{Collaborators, Coverage, Disposition, HoleRequest, Model, RouteScope, Row, SCHEMA, Status, Witness};
use crate::decimal::Decimal;
use crate::kicad::raw::Form;
use crate::model::selector::{Item, Scope, Selector};
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

const INSPECT_SCOPE: &str = "native custom-rule model coverage only; final fresh native/configured gates remain mandatory";
const NEW_VIAS: &str = "new vias are possible; the final native DRC of the saved candidate must show zero findings of these types";

/// Rule or constraint name to the KiCad 10 DRC item types: what only the final native DRC can decide when new vias are possible.
pub(super) fn drc_types(constraint: &str) -> Option<&'static [&'static str]> {
    Some(match constraint {
        "min_hole_to_hole" | "hole_to_hole" => &["hole_to_hole", "holes_co_located"],
        "min_hole_clearance" | "hole_clearance" => &["hole_clearance"],
        "min_silk_clearance" | "silk_clearance" => &["silk_overlap", "silk_over_copper"],
        _ => return None,
    })
}

/// The pending obligation that the final native DRC reports none of these types, as a row disposition. `extra` holds the
/// fields the obligation carries beside the constraint: `rule`, `required_mm`.
pub fn native_drc(row: &mut Row, constraint: &str, extra: Map<String, Value>) {
    let mut obligation = extra;
    obligation.insert("constraint".to_string(), constraint.into());
    obligation.insert("enforcement".to_string(), "native-drc".into());
    obligation.insert("drc_types".to_string(), json!(drc_types(constraint).unwrap_or_default()));
    row.native_obligation = Some(Value::Object(obligation));
    row.settle(Disposition::NativePostcondition, NEW_VIAS);
}

fn drc_extra(rule: &str, required: Option<Decimal>) -> Map<String, Value> {
    let mut extra = Map::new();
    extra.insert("rule".to_string(), rule.into());
    if let Some(required) = required {
        extra.insert("required_mm".to_string(), required.text().into());
    }
    extra
}

/// The items new copper can be, and what they can meet.
struct Parties {
    moving: Vec<Item>,
    fixed: Vec<Item>,
}

impl Parties {
    fn any_via(&self) -> bool {
        self.moving.iter().any(|item| item.item_type.as_deref() == Some("Via"))
    }

    fn counterparts(&self) -> impl Iterator<Item = &Item> {
        self.fixed.iter().chain(&self.moving)
    }
}

fn parties(model: &Model, scope: &RouteScope) -> Result<Parties, String> {
    let mut moving = Vec::new();
    for net in scope.sorted_active() {
        let kinds: &[&str] = if model.allowed(&net)?.len() > 1 { &["Track", "Via"] } else { &["Track"] };
        moving.extend(kinds.iter().map(|kind| Item::plain(&net, &scope.net_classes[&net], kind)));
    }
    let mut fixed = Vec::new();
    for obstacle in scope.obstacles {
        let class = scope.net_classes.get(&obstacle.net_name).ok_or("unknown retained obstacle identity/type")?;
        fixed.push(Item { net_name: Some(obstacle.net_name.clone()), net_class: Some(class.clone()), item_type: Some(obstacle.kind.clone()), pad_type: obstacle.pad_type.clone(), ..Item::default() });
    }
    Ok(Parties { moving, fixed })
}

fn check_scope(model: &Model, scope: &RouteScope) -> Result<(), String> {
    let in_both = |net: &String| scope.net_classes.contains_key(net) && model.membership.contains_key(net);
    if scope.active_nets.is_empty() || !scope.active_nets.iter().all(in_both) {
        return Err("active native nets are absent from native or final DSN classes".to_string());
    }
    if scope.net_classes.keys().any(|net| !net.is_empty() && !model.membership.contains_key(net)) {
        return Err("retained native obstacle net absent from final DSN model".to_string());
    }
    for net in scope.active_nets {
        if !model.allowed(net)?.iter().all(|layer| scope.layers.contains(layer)) {
            return Err("actual DSN permits undeclared routing layers for an active net".to_string());
        }
    }
    Ok(())
}

/// A rule as admission reads it. `condition` is None for a selector that is not text, which nothing can decide.
struct NativeRule<'a> {
    name: String,
    condition: Option<Selector>,
    layer: Option<&'a Form>,
    constraints: Vec<&'a Form>,
}

fn read_rule(form: &Form) -> Result<Option<NativeRule<'_>>, String> {
    if is_atoms(form, &["version", "1"]) {
        return Ok(None);
    }
    let items = form.items();
    if items.len() < 2 || !form.is("rule") {
        return Err("unsupported native rules document/version".to_string());
    }
    let name = items[1].atom().map_or_else(|| form_repr(&items[1]), str::to_string);
    let conditions: Vec<&Form> = form.children("condition").collect();
    let layers: Vec<&Form> = form.children("layer").collect();
    if conditions.len() > 1 || layers.len() > 1 || conditions.iter().chain(&layers).any(|field| field.items().len() != 2) {
        return Err("ambiguous native rule condition/layer".to_string());
    }
    let constraints: Vec<&Form> = form.children("constraint").collect();
    let known = |field: &Form| ["condition", "layer", "constraint"].iter().any(|head| field.is(head));
    if constraints.is_empty() || !items[2..].iter().all(known) {
        return Err(format!("unsupported native rule fields: {name}"));
    }
    let condition = match conditions.first() {
        Some(field) => field.text(1).map(Selector::new),
        None => Some(Selector::new("True")),
    };
    Ok(Some(NativeRule { name, condition, layer: layers.first().map(|field| &field.items()[1]), constraints }))
}

/// The `(min value)` bound when it is the only bound.
fn only_minimum(constraint: &Form) -> Option<&Form> {
    match &constraint.items()[2..] {
        [bound] if bound.items().len() == 2 && bound.is("min") => Some(&bound.items()[1]),
        _ => None,
    }
}

fn millimetres(value: &Form) -> Result<Decimal, String> {
    match value.atom() {
        Some(text) => number(text, "mm"),
        None => Err(format!("unsupported numeric value or units: {}", form_repr(value))),
    }
}

fn net(item: &Item) -> &str {
    item.net_name.as_deref().unwrap_or("")
}

/// Which pairs the selector holds for, and whether any could not be decided.
struct Reach<'a> {
    applicable: Vec<(&'a Item, &'a Item)>,
    uncertain: bool,
}

impl<'a> Reach<'a> {
    fn test(&mut self, condition: Option<&Selector>, sides: (&Item, &Item), found: (&'a Item, &'a Item)) {
        let (a, b) = sides;
        match condition.and_then(|selector| selector.eval(Scope { a, b, pair: false })) {
            None => self.uncertain = true,
            Some(true) => self.applicable.push(found),
            Some(false) => {}
        }
    }
}

/// A rule on two items is tried both ways round against everything new copper can meet. Only the two clearance kinds need
/// every pair: the others stop at the first new item it holds for.
fn reach<'a>(condition: Option<&Selector>, kind: &str, parties: &'a Parties, nothing: &'a Item) -> Reach<'a> {
    let binary = matches!(kind, "clearance" | "creepage" | "hole_clearance" | "hole_to_hole");
    let every_pair = matches!(kind, "clearance" | "hole_clearance");
    let mut result = Reach { applicable: Vec::new(), uncertain: false };
    for new in &parties.moving {
        if binary {
            for other in parties.counterparts() {
                result.test(condition, (new, other), (new, other));
                result.test(condition, (other, new), (new, other));
            }
        } else {
            result.test(condition, (new, nothing), (new, nothing));
        }
        if !result.applicable.is_empty() && !every_pair {
            break;
        }
    }
    result
}

struct Admission<'a> {
    model: Model,
    scope: RouteScope<'a>,
    parties: Parties,
    dsn_text: &'a str,
    native_pads: Option<&'a [Value]>,
    native: &'a dyn Collaborators,
}

impl Admission<'_> {
    fn floor(&self, applicable: &[(&Item, &Item)]) -> Result<Decimal, String> {
        let floors: Vec<Decimal> = applicable.iter().map(|(a, b)| self.model.clearance_floor(net(a), b.net_name.as_deref())).collect::<Result<_, _>>()?;
        first_minimum(&floors).ok_or_else(|| "no attributable DSN clearance".to_string())
    }

    /// True when the row is settled before any selector is read.
    fn shortcut(&self, rule: &NativeRule, constraint: &Form, kind: &str, row: &mut Row) -> Result<bool, String> {
        let vias = self.parties.any_via();
        if kind == "silk_clearance" && !vias {
            row.settle(Disposition::ImmutableUnchanged, "single-layer router adds covered tracks, no new holes; source and import/final identity guards preserve masks, silk and outline");
        } else if kind == "silk_clearance" {
            native_drc(row, kind, drc_extra(&rule.name, None));
        } else if kind == "disallow" && matches!(&constraint.items()[2..], [only] if only.atom() == Some("pad")) {
            row.settle(Disposition::ImmutableUnchanged, "router does not modify footprint/pad geometry; import identity guard remains required");
        } else if matches!(kind, "hole_to_hole" | "hole_size" | "annular_width" | "via_diameter") && !vias {
            row.settle(Disposition::ImmutableUnchanged, "verified single-layer model introduces no new via/hole transitions");
        } else if self.layer_is_out_of_reach(rule)? {
            row.settle(Disposition::NotApplicable, "exact native layer cannot receive new copper under every actual active-net mask");
        } else {
            return Ok(false);
        }
        Ok(true)
    }

    fn layer_is_out_of_reach(&self, rule: &NativeRule) -> Result<bool, String> {
        let Some(layer) = rule.layer else { return Ok(false) };
        let layer = key(layer)?;
        if !self.model.actual_layers.contains(layer) {
            return Ok(false);
        }
        for net in self.scope.active_nets {
            if self.model.allowed(net)?.iter().any(|allowed| allowed == layer) {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn constraint(&self, rule: &NativeRule, constraint: &Form, row: &mut Row) -> Result<(), String> {
        let kind = row.constraint.clone();
        if self.shortcut(rule, constraint, &kind, row)? {
            return Ok(());
        }
        let nothing = Item::default();
        let found = reach(rule.condition.as_ref(), &kind, &self.parties, &nothing);
        if found.uncertain {
            row.reason = Some("native selector applicability cannot be proved (spatial/unsupported terms are not compiled coverage)".to_string());
            return Ok(());
        }
        let Some((first_active, first_other)) = found.applicable.first() else {
            row.settle(Disposition::NotApplicable, "selector false for every active track/via and retained obstacle orientation");
            return Ok(());
        };
        row.witness = Some(Witness { active: net(first_active).to_string(), obstacle: first_other.net_name.clone() });
        if rule.layer.is_some() {
            row.reason = Some("layer-dependent native rule precedence is not represented by this coverage subset".to_string());
            return Ok(());
        }
        match kind.as_str() {
            "clearance" => self.clearance(constraint, &found.applicable, row),
            "hole_clearance" => self.hole_clearance(rule, constraint, &found.applicable, row),
            "hole_to_hole" if self.parties.any_via() => self.hole_to_hole(rule, constraint, row),
            "disallow" if is_via_ban(constraint) => {
                self.via_ban(&found.applicable, row);
                Ok(())
            }
            _ => {
                row.reason = Some("applicable native constraint has no proven enforcement in the actual DSN model".to_string());
                Ok(())
            }
        }
    }

    fn clearance(&self, constraint: &Form, applicable: &[(&Item, &Item)], row: &mut Row) -> Result<(), String> {
        let Some(bound) = only_minimum(constraint) else {
            row.reason = Some("only a native minimum clearance is covered".to_string());
            return Ok(());
        };
        let required = millimetres(bound)?;
        let floor = self.floor(applicable)?;
        row.required_mm = Some(required.text());
        row.model_floor_mm = Some(floor.text());
        let disposition = if floor >= required { Disposition::Covered } else { Disposition::WeakerThanNative };
        row.settle(disposition, "conservative lower bound of actual final DSN declarations; no override precedence assumed");
        Ok(())
    }

    fn hole_clearance(&self, rule: &NativeRule, constraint: &Form, applicable: &[(&Item, &Item)], row: &mut Row) -> Result<(), String> {
        let Some(bound) = only_minimum(constraint) else {
            row.reason = Some("only a native minimum hole clearance is covered".to_string());
            return Ok(());
        };
        if applicable.iter().any(|(a, _)| a.item_type.as_deref() == Some("Via")) {
            native_drc(row, "hole_clearance", drc_extra(&rule.name, Some(millimetres(bound)?)));
            return Ok(());
        }
        let Some(pads) = self.native_pads.filter(|pads| !pads.is_empty() && pads_cover(pads, applicable)) else {
            row.reason = Some("hole coverage requires exact retained PTH geometry and tracks only".to_string());
            return Ok(());
        };
        let required = millimetres(bound)?;
        let floor = self.floor(applicable)?.text();
        let (active, required_mm) = (self.scope.sorted_active(), required.text());
        let proof = self.native.inspect_holes(&HoleRequest { dsn_text: self.dsn_text, pads, active_nets: &active, layers: self.scope.layers, required_mm: &required_mm, clearance_floor_mm: &floor })?;
        let covered = proof.get("status").and_then(Value::as_str) == Some("covered");
        let reason = proof.get("cause").and_then(Value::as_str).unwrap_or("actual exported PTH copper containment was not proved").to_string();
        row.required_mm = Some(required_mm);
        row.hole_geometry = Some(proof);
        row.settle(if covered { Disposition::Covered } else { Disposition::Unsupported }, reason);
        Ok(())
    }

    fn hole_to_hole(&self, rule: &NativeRule, constraint: &Form, row: &mut Row) -> Result<(), String> {
        let Some(bound) = only_minimum(constraint) else {
            row.reason = Some("only a native minimum hole-to-hole distance is covered".to_string());
            return Ok(());
        };
        native_drc(row, "hole_to_hole", drc_extra(&rule.name, Some(millimetres(bound)?)));
        Ok(())
    }

    fn via_ban(&self, applicable: &[(&Item, &Item)], row: &mut Row) {
        let single = applicable.iter().all(|(a, _)| self.model.allowed(net(a)).is_ok_and(|layers| layers.len() == 1));
        let disposition = if single { Disposition::Covered } else { Disposition::WeakerThanNative };
        row.settle(disposition, "native via prohibition requires verified single-layer routing for every applicable active net");
    }

    fn stitching(&self) -> Result<Row, String> {
        let mut multilevel = Vec::new();
        for net in self.scope.sorted_active() {
            if self.model.allowed(&net)?.len() != 1 {
                multilevel.push(net);
            }
        }
        let mut row = Row::new("configured kicad_happy RP-001", "reference_stitching");
        row.settle(Disposition::Covered, "active net masks prevent new layer transitions");
        if !multilevel.is_empty() {
            // No stitching producer here; the configured board gate runs RP-001 on the final board.
            row.native_obligation = Some(json!({"rule": row.rule, "constraint": row.constraint, "enforcement": "configured-gate", "nets": multilevel}));
            row.settle(Disposition::NativePostcondition, "new layer transitions are possible; the configured gate must pass RP-001 on the final board");
        }
        row.nets = Some(multilevel);
        Ok(row)
    }
}

/// Tracks against retained through-hole pads of known geometry, and nothing else.
fn pads_cover(pads: &[Value], applicable: &[(&Item, &Item)]) -> bool {
    let shapes_fit = applicable.iter().all(|(a, b)| a.item_type.as_deref() == Some("Track") && b.item_type.as_deref() == Some("Pad") && b.pad_type.as_deref() == Some("Through-hole"));
    let pad_nets: BTreeSet<&str> = pads.iter().filter_map(|pad| pad.get("net")?.as_str()).collect();
    shapes_fit && applicable.iter().all(|(_, b)| pad_nets.contains(net(b)))
}

fn is_via_ban(constraint: &Form) -> bool {
    let items = &constraint.items()[2..];
    !items.is_empty() && items.iter().all(|item| item.atom() == Some("via"))
}

fn admit(dru_text: &str, dsn_text: &str, scope: &RouteScope, require_stitching: bool, native_pads: Option<&[Value]>, native: &dyn Collaborators, rows: &mut Vec<Row>) -> Result<(), String> {
    let model = Model::new(dsn_text, scope.layers)?;
    check_scope(&model, scope)?;
    let parties = parties(&model, scope)?;
    let admission = Admission { model, scope: *scope, parties, dsn_text, native_pads, native };
    let forms = rule_forms(dru_text)?;
    for form in &forms {
        let Some(rule) = read_rule(form)? else { continue };
        for constraint in &rule.constraints {
            let kind = constraint.items().get(1).ok_or("invalid native constraint")?;
            let kind = kind.atom().map_or_else(|| form_repr(kind), str::to_string);
            rows.push(Row::new(&rule.name, &kind));
            let row = rows.last_mut().expect("the row just pushed");
            admission.constraint(&rule, constraint, row)?;
        }
    }
    if require_stitching {
        rows.push(admission.stitching()?);
    }
    Ok(())
}

/// The decision over the rules: `dru_text` against the final DSN. `native_pads` are the retained through-hole pads, None when
/// their geometry is not known. Never an error: what cannot be read blocks, with the reason in the record.
pub fn inspect(dru_text: &str, dsn_text: &str, scope: &RouteScope, require_stitching: bool, native_pads: Option<&[Value]>, native: &dyn Collaborators) -> Coverage {
    let mut result = Coverage {
        schema: SCHEMA,
        status: Status::Blocked,
        solver_launch_allowed: false,
        active_nets: scope.sorted_active(),
        job_layers: scope.layers.to_vec(),
        requirements: Vec::new(),
        qualified: false,
        scope: INSPECT_SCOPE.to_string(),
        cause: String::new(),
        native_pth_geometry_unknown: None,
        native_drilled_geometry_unknown: None,
        native_thermal_capability: None,
        native_postconditions: None,
        files: None,
    };
    match admit(dru_text, dsn_text, scope, require_stitching, native_pads, native, &mut result.requirements) {
        Ok(()) => conclude(&mut result),
        Err(error) => {
            result.requirements.push(Row::unsupported("coverage admission", "model_or_rules", error.clone()));
            result.cause = error;
        }
    }
    result
}

fn conclude(result: &mut Coverage) {
    let blockers: Vec<String> = result.requirements.iter().filter(|row| row.disposition.blocks()).map(|row| format!("{}: {} {}", row.rule, row.constraint, row.disposition.name())).collect();
    let pending = result.requirements.iter().any(|row| row.disposition == Disposition::NativePostcondition);
    result.solver_launch_allowed = blockers.is_empty();
    result.status = match (blockers.is_empty(), pending) {
        (false, _) => Status::Blocked,
        (true, true) => Status::PendingNative,
        (true, false) => Status::Passed,
    };
    result.cause = if blockers.is_empty() { "applicable native requirements covered by final DSN model".to_string() } else { blockers.join("; ") };
}
