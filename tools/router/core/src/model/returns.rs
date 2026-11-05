//! The stackup numbers of the model and the RP-001 return rule, as the board gate checks it (tools/kicad_happy_gate.ts).
use super::files::{BoardFiles, HappySettings, read_exempt, read_plane_spec};
use super::output::{Model, ReturnRule, ReturnScope};
use super::text::round_to;
use crate::kicad::board::{Board, StackupKind, StackupLayer};
use std::collections::BTreeMap;

const FIRST_DIELECTRIC_DEFAULT_MM: f64 = 0.2;
const MIN_RADIUS_MM: f64 = 1.0;

/// The kicad-happy boundary (happy_scope.rs): the nets whose layer changes the gate's RP-001 never checks.
#[derive(Debug, Default)]
pub struct RpScope {
    pub power_rails: Vec<String>,
    pub skip: Vec<String>,
}

pub fn copper_thickness(board: &Board) -> BTreeMap<String, f64> {
    board.stackup.iter().filter(|l| l.kind == StackupKind::Copper).map(|l| (l.layer.clone(), l.thickness_mm())).collect()
}

/// Length KiCad adds for one through via in the DRC length rule: the stackup height from F.Cu to B.Cu, copper included. H7-CORE
/// rev A, /ETH_TX_EN: 46.24 mm of track + 4 vias, KiCad 52.565 mm = 4 x 1.586 less 0.02 mm of track inside the pads.
pub fn via_length(board: &Board) -> Option<f64> {
    let start = board.stackup.iter().position(|l| l.layer == "F.Cu")?;
    let end = board.stackup.iter().position(|l| l.layer == "B.Cu")?;
    (start <= end).then(|| round_to(board.stackup[start..=end].iter().map(StackupLayer::thickness_mm).sum(), 4))
}

/// The gate's radius with return_planes: max(2 h, 1.0 mm), h the dielectric between the two reference planes of that spec.
fn plane_radius(board: &Board, adjacent: &BTreeMap<String, String>) -> Option<(f64, f64, String, String)> {
    let mut planes: Vec<&String> = adjacent.values().collect();
    planes.sort();
    planes.dedup();
    let [a, b] = planes[..] else { return None };
    let index = |name: &str| board.stackup.iter().position(|l| l.layer == name);
    let (i, j) = (index(a)?, index(b)?);
    let (i, j) = (i.min(j), i.max(j));
    let h: f64 = board.stackup[i + 1..j].iter().filter(|l| l.layer.is_empty()).map(StackupLayer::thickness_mm).sum();
    (h > 0.0).then(|| ((2.0 * h).max(MIN_RADIUS_MM), h, a.clone(), b.clone()))
}

/// RP-001 as the gate checks it. With return_planes, the plane radius, and GND through-hole pads count as returns; without it,
/// kicad-happy a6bba1a decides alone: h the first dielectric, GND vias only. None when the gate has no kicad_happy check.
pub fn return_rule(board: &Board, files: &BoardFiles) -> Result<Option<ReturnRule>, String> {
    if !files.gate.checks.happy_enabled() {
        return Ok(None);
    }
    if let Some(name) = files.gate.checks.happy_settings().and_then(|s| s.return_planes.as_ref()) {
        let spec = read_plane_spec(&files.folder.join(name))?;
        let (radius, h, a, b) = plane_radius(board, &spec.adjacent).ok_or_else(|| format!("kicad_happy return_planes set but no radius from {name}"))?;
        return Ok(Some(ReturnRule { radius, pads: true, source: format!("gate return_planes: max(2 x {h:.4} mm ({a}-{b}), 1.0), GND vias and through-hole pads") }));
    }
    let h = board.stackup.iter().find(|l| matches!(l.kind, StackupKind::Core | StackupKind::Prepreg) && l.thickness > 0).map_or(FIRST_DIELECTRIC_DEFAULT_MM, StackupLayer::thickness_mm);
    Ok(Some(ReturnRule { radius: (2.0 * h).max(MIN_RADIUS_MM), pads: false, source: format!("kicad-happy a6bba1a: max(2 x first dielectric {h:?} mm, 1.0), GND vias only") }))
}

/// The return nets: kicad-happy counts a via of any ground net; the core places returns of one net, the first ground that is a
/// plane net here. Written only when it is not the plain default of GND alone.
pub fn set_return_nets(model: &mut Model, happy: Option<&HappySettings>) {
    let extra = happy.map_or(&[][..], |h| &h.grounds);
    let mut grounds: Vec<String> = Vec::new();
    for g in model.grounds.iter().chain(extra).filter(|g| model.nets.contains_key(*g)) {
        if !grounds.contains(g) {
            grounds.push(g.clone());
        }
    }
    let Some(net) = grounds.iter().find(|g| model.nets[*g].plane).cloned() else { return };
    if net != "GND" || grounds.len() > 1 {
        model.return_net = Some(net);
        model.return_nets = Some(grounds);
    }
}

/// `--return-exempt`: the nets the gate exempts from RP-001, each with a user-approved reason in the exempt file.
pub fn set_gate_exemptions(model: &mut Model, files: &BoardFiles) -> Result<(), String> {
    let Some(file) = files.gate.checks.happy_settings().and_then(|h| h.exempt.as_ref()) else { return Ok(()) };
    let entries = read_exempt(&files.folder.join(file))?;
    let mut nets: Vec<String> = entries.into_iter().filter(|e| e.rule.as_deref() == Some("RP-001")).filter_map(|e| e.net).filter(|n| model.nets.contains_key(n)).collect();
    nets.sort();
    nets.dedup();
    model.return_exempt = Some(nets);
    Ok(())
}

/// Never stricter than the gate: the power and ground nets kicad-happy names so need no return via in the router either.
pub fn set_return_scope(model: &mut Model, scope: RpScope) {
    if scope.skip.is_empty() {
        return;
    }
    let mut exempt = model.return_exempt.take().unwrap_or_default();
    exempt.extend(scope.skip.iter().cloned());
    exempt.sort();
    exempt.dedup();
    model.return_exempt = Some(exempt);
    model.return_scope = Some(ReturnScope { source: "kicad-happy a6bba1a RP-001 net filter", power_rails: scope.power_rails, skip: scope.skip });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layer(name: &str, kind: StackupKind, thickness: i64) -> StackupLayer {
        StackupLayer { layer: name.to_string(), kind, thickness }
    }

    fn board(stackup: Vec<StackupLayer>) -> Board {
        Board { path: String::new(), copper_layers: Vec::new(), stackup, nets: BTreeMap::new(), footprints: Vec::new(), copper: Vec::new(), zones: Vec::new(), graphics: Vec::new(), texts: Vec::new(), groups: Vec::new(), constraints: Default::default(), edges_bbox: crate::kicad::geom::Rect::around(Default::default()), outlines: Vec::new() }
    }

    fn four_layers() -> Board {
        board(vec![layer("F.Mask", StackupKind::Other, 10_000), layer("F.Cu", StackupKind::Copper, 35_000), layer("", StackupKind::Prepreg, 210_400), layer("In1.Cu", StackupKind::Copper, 15_200), layer("", StackupKind::Core, 1_065_000), layer("In2.Cu", StackupKind::Copper, 15_200), layer("", StackupKind::Prepreg, 210_400), layer("B.Cu", StackupKind::Copper, 35_000), layer("B.Mask", StackupKind::Other, 10_000)])
    }

    #[test]
    fn a_via_is_the_stack_from_front_to_back() {
        assert_eq!(via_length(&four_layers()), Some(1.5862));
        assert_eq!(via_length(&board(Vec::new())), None);
    }

    #[test]
    fn thickness_is_per_copper_layer() {
        let t = copper_thickness(&four_layers());
        assert_eq!((t["F.Cu"], t["In1.Cu"], t.len()), (0.035, 0.0152, 4));
    }
}
