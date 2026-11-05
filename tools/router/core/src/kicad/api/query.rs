//! Reads beside the board itself: its rules and the copper connected to an item.
use super::client::{ApiError, Client, decode};
use super::proto::kiapi::board::commands as bc;
use super::proto::kiapi::board::types as bt;
use super::proto::kiapi::common::commands::GetItemsResponse;
use super::proto::kiapi::common::project::NetClass;
use super::proto::kiapi::common::types as ct;
use super::read::{net, nm, pt};
use crate::kicad::geom::Pt;
use crate::kicad::rules::{ClassValues, DesignRules, Minimums, clearance_rules_of};
use std::collections::BTreeMap;
use std::path::Path;

fn class_values(class: &NetClass) -> ClassValues {
    let board = class.board.as_ref();
    let via = board.and_then(|b| b.via_stack.as_ref()).and_then(|s| s.copper_layers.first()).map(|l| pt(&l.size).x);
    ClassValues { clearance: board.and_then(|b| b.clearance.as_ref()).map(|d| d.value_nm), via_diameter: via }
}

/// The rules the server has for its board. `path` is the board file: the custom rules are in the .kicad_dru beside it.
pub fn read_rules(client: &mut Client, path: &Path) -> Result<DesignRules, ApiError> {
    let doc = client.board_document()?;
    let reply: bc::BoardDesignRulesResponse = client.call(&bc::GetBoardDesignRules { board: Some(doc.clone()) })?;
    let constraints = reply.rules.and_then(|r| r.constraints).ok_or_else(|| ApiError::from("KiCad sent no board constraints".to_string()))?;
    let minimums = Minimums {
        clearance: nm(&constraints.min_clearance),
        track_width: nm(&constraints.min_track_width),
        via_size: nm(&constraints.min_via_size),
        copper_edge_clearance: nm(&constraints.copper_edge_clearance),
        hole_clearance: nm(&constraints.hole_clearance),
        hole_to_hole: nm(&constraints.hole_to_hole_min),
    };
    let nets = client.nets(&doc)?;
    let reply: bc::NetClassForNetsResponse = client.call(&bc::GetNetClassForNets { net: nets })?;
    let classes: BTreeMap<String, ClassValues> = reply.classes.iter().map(|(name, class)| (name.clone(), class_values(class))).collect();
    Ok(DesignRules { minimums, classes, clearance_rules: clearance_rules_of(path).map_err(ApiError::from)? })
}

/// The vias connected to an item through copper and the board's zone fills, with their nets.
pub fn connected_vias(client: &mut Client, document: &ct::DocumentSpecifier, item: &str) -> Result<Vec<(Pt, String)>, ApiError> {
    let header = ct::ItemHeader { document: Some(document.clone()), container: None, field_mask: None };
    let request = bc::GetConnectedItems { header: Some(header), items: vec![ct::Kiid { value: item.to_string() }], types: vec![ct::KiCadObjectType::KotPcbVia as i32] };
    let reply: GetItemsResponse = client.call(&request)?;
    if reply.status() != ct::ItemRequestStatus::IrsOk {
        return Err(ApiError::from(format!("GetConnectedItems: {}", reply.status().as_str_name())));
    }
    Ok(reply.items.iter().filter_map(decode::<bt::Via>).map(|v| (pt(&v.position), net(&v.net))).collect())
}
