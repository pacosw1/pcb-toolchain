//! The authored clearances that apply to this new copper: the floor the strengthened DSN must reach.
use super::{Collaborators, RouteScope, Witness};
use crate::decimal::Decimal;
use serde::Serialize;
use std::collections::BTreeSet;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SourcePointer {
    pub path: String,
    pub pointer: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RequirementRow {
    pub constraint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub netclass: Option<String>,
    pub source: SourcePointer,
    pub required_mm: String,
    pub witness: Witness,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ClearanceRequirement {
    pub required_mm: String,
    pub requirements: Vec<RequirementRow>,
    pub active_nets: Vec<String>,
    pub counterparts: Vec<String>,
}

fn counterparts(scope: &RouteScope) -> Result<BTreeSet<String>, String> {
    let active = scope.active_nets;
    if active.is_empty() || active.iter().any(|net| net.is_empty() || !scope.net_classes.contains_key(net)) {
        return Err("clearance strengthening requires exact active native nets/classes".to_string());
    }
    let mut nets: BTreeSet<String> = active.iter().cloned().collect();
    for obstacle in scope.obstacles {
        if !scope.net_classes.contains_key(&obstacle.net_name) {
            return Err("clearance strengthening has an unknown retained native net".to_string());
        }
        nets.insert(obstacle.net_name.clone());
    }
    if nets.iter().any(|net| scope.net_classes[net].is_empty()) {
        return Err("clearance strengthening has an unknown native class".to_string());
    }
    Ok(nets)
}

fn witness((active, obstacle): &(String, String)) -> Witness {
    Witness { active: active.clone(), obstacle: Some(obstacle.clone()) }
}

/// The largest value, the first of equal ones, starting from zero.
fn highest(values: impl Iterator<Item = Decimal>) -> Decimal {
    values.fold(Decimal::ZERO, |high, value| if value > high { value } else { high })
}

/// Only the authored clearances applicable to this new-copper scope: the classes of the nets a track can come near and the
/// project minimum. This certifies no router model. `source` is the project path the rows name.
pub fn project_clearance_requirement(project_text: &str, source: &str, scope: &RouteScope, native: &dyn Collaborators) -> Result<ClearanceRequirement, String> {
    let project = native.project_clearances(project_text)?;
    let nets = counterparts(scope)?;
    let active = scope.sorted_active();
    let pairs: Vec<(String, String)> = active.iter().flat_map(|a| nets.iter().filter(move |b| a != *b).map(move |b| (a.clone(), b.clone()))).collect();
    let classes: BTreeSet<&String> = nets.iter().map(|net| &scope.net_classes[net]).collect();
    let mut requirements = Vec::new();
    for name in classes {
        let unresolved = || format!("actual native netclass clearance is unresolved: {name}");
        let class = project.classes.get(name).ok_or_else(unresolved)?;
        let value = class.clearance.clone().ok_or_else(unresolved)??;
        if let Some(pair) = pairs.iter().find(|(a, b)| scope.net_classes[a] == *name || scope.net_classes[b] == *name) {
            requirements.push(RequirementRow {
                constraint: "netclass_clearance".to_string(),
                netclass: Some(name.clone()),
                source: SourcePointer { path: source.to_string(), pointer: format!("/net_settings/classes/{}/clearance", class.index) },
                required_mm: value.text(),
                witness: witness(pair),
            });
        }
    }
    let minimum = project.min_clearance.clone().ok_or("native project min_clearance is absent; no default is inferred")??;
    if let Some(pair) = pairs.first() {
        requirements.push(RequirementRow {
            constraint: "min_clearance".to_string(),
            netclass: None,
            source: SourcePointer { path: source.to_string(), pointer: "/board/design_settings/rules/min_clearance".to_string() },
            required_mm: minimum.text(),
            witness: witness(pair),
        });
    }
    let values = requirements.iter().filter_map(|row| Decimal::parse(&row.required_mm));
    Ok(ClearanceRequirement { required_mm: highest(values).text(), requirements, active_nets: active, counterparts: nets.into_iter().collect() })
}
