//! Where a plane net really is a plane, and the reference rule of the planes gate (si/planes, D-124c screen) as router
//! data: which domain each checked net belongs to, and the filled copper of each domain on the adjacent plane layer.
use super::files::{BoardFiles, PlaneSpec};
use super::items::fine_point;
use super::num::{Num, short_float};
use super::output::{Anchor, Net, Pad, Point, RefFill, RefLayer, Zone};
use super::text::{glob_match, round_to};
use crate::kicad::board::{Board, RoutedCopper};
use crate::kicad::geom::boolean::union;
use crate::kicad::geom::{Polygon, Pt, from_mm, to_mm};
use crate::kicad::pad::Copper;
use std::collections::{BTreeMap, BTreeSet};

/// The fan-out reach of the core for an SMD pad.
const FANOUT_REACH_MM: f64 = 3.0;
const DEFAULT_VIA_ALLOW_MM: Num = Num::Float(0.6);
const SOURCE: &str = "si/planes D-124c: track centre sample inside the filled reference of its domain on the adjacent layer (margin 0), own pads / vias within radius + via_allow_mm exempt";

fn polys_touch_pad(polygons: &[Polygon], copper: &[Copper]) -> bool {
    polygons.iter().any(|p| copper.iter().any(|c| p.collides(c)))
}

/// Does a zone of the net reach this pad? Its copper on a shared layer, a through-hole pad also on a plane layer, and an SMD pad
/// by the fan-out reach of a plane-layer zone.
fn pad_reached(board: &Board, pad: &Pad, copper: &[Copper], net_zones: &[usize], plane_zones: &[usize], plane_layers: &[String]) -> bool {
    let through = if pad.drill > 0.0 { plane_layers } else { &[] };
    let layers: Vec<&String> = pad.layers.iter().chain(through).collect();
    let hit = net_zones.iter().any(|z| {
        let zone = &board.zones[*z];
        layers.iter().any(|l| zone.layers.contains(l)) && polys_touch_pad(&zone.outline, copper)
    });
    if hit || pad.drill != 0.0 {
        return hit;
    }
    let center = Pt::new(from_mm(pad.x), from_mm(pad.y));
    plane_zones.iter().any(|z| board.zones[*z].outline.iter().any(|p| p.near(center, from_mm(FANOUT_REACH_MM))))
}

/// The zones with each pour once. The router has always counted pours of one outline as one, by pcbnew's zone equality; their
/// plane outlines are the same, and a pad they miss still has the fan-out reach.
fn distinct_pours(board: &Board, zones: BTreeSet<usize>) -> Vec<usize> {
    let mut kept: Vec<usize> = Vec::new();
    for z in zones {
        if !kept.iter().any(|k| board.zones[*k].same_pour(&board.zones[z])) {
            kept.push(z);
        }
    }
    kept
}

/// A ground or alt-ref net is a plane net only where its plane exists: a net with no plane-layer zone, or with a pad not reached,
/// is routed with tracks like a signal net (`plane_off` gives the reason). POE-ETHERNET: ISO_GND has no plane on the board, and
/// the VDD_3V3 In2 zones do not reach J1.11 / J1.13. A plane net gets its outlines: the core puts its fan-out vias inside them.
pub fn plane_reach(board: &Board, nets: &mut BTreeMap<String, Net>, pads: &[Pad], zones: &[Zone], sources: &[usize], plane_layers: &BTreeSet<String>) {
    let sorted_planes: Vec<String> = plane_layers.iter().cloned().collect();
    let copper: Vec<&[Copper]> = board.pads().map(|(_, p)| p.copper.as_slice()).collect();
    for (name, net) in nets.iter_mut().filter(|(_, n)| n.plane) {
        let of_net = |only_planes: bool| -> Vec<usize> {
            let found = zones.iter().zip(sources).filter(|(z, _)| z.net == *name && (!only_planes || plane_layers.contains(&z.layer)));
            let unique: BTreeSet<usize> = found.map(|(_, s)| *s).collect();
            distinct_pours(board, unique)
        };
        let (all, on_planes) = (of_net(false), of_net(true));
        let off: Vec<String> = pads.iter().enumerate().filter(|(_, p)| p.net == *name).filter(|(i, p)| !pad_reached(board, p, copper[*i], &all, &on_planes, &sorted_planes)).map(|(_, p)| p.name()).collect();
        if on_planes.is_empty() || !off.is_empty() {
            net.plane = false;
            net.plane_off = Some(if on_planes.is_empty() { "no zone of the net on a plane layer".to_string() } else { format!("pads its zones do not reach: {}", off[..off.len().min(8)].join(" ")) });
            continue;
        }
        let outlines = on_planes.iter().flat_map(|z| &board.zones[*z].outline);
        net.plane_polys = Some(outlines.map(|p| p.outline.iter().copied().map(fine_point).collect()).collect());
    }
}

/// `plane_ref`: a net on a layer of `adjacent` that is not a ground, not exempt and not power must run over its reference plane.
pub fn set_plane_ref(nets: &mut BTreeMap<String, Net>, planes: &PlaneSpec) {
    let power: Vec<&String> = planes.power.iter().chain(planes.mixed_layers.values().flat_map(|m| &m.power)).collect();
    for (name, net) in nets.iter_mut() {
        net.plane_ref = !planes.grounds.contains(name) && !planes.exempt.nets.contains_key(name) && !power.iter().any(|q| glob_match(name, q));
    }
}

/// The domain of a reference net: a ground itself, or an alt_ref of no cap (its cap needs a decoupling cap the model does not
/// place).
fn reference_domain<'a>(reference: &'a str, planes: &'a PlaneSpec) -> Option<&'a str> {
    if planes.grounds.iter().any(|g| g == reference) {
        return Some(reference);
    }
    planes.alt_refs.get(reference).filter(|a| a.cap_mm.is_none()).map(|a| a.domain.as_str())
}

/// si_planes.net_domain: a spec pattern first, else the domain that holds most of its pads. A tie gives None.
fn net_domain(net: &str, pad_refs: &[Option<&str>], planes: &PlaneSpec) -> Option<String> {
    if let Some((g, _)) = planes.domains.iter().find(|(_, pats)| pats.iter().any(|p| glob_match(net, p))) {
        return Some(g.clone());
    }
    let mut votes: BTreeMap<&str, usize> = BTreeMap::new();
    for domain in pad_refs.iter().flatten().filter_map(|r| reference_domain(r, planes)) {
        *votes.entry(domain).or_default() += 1;
    }
    let top = votes.values().copied().max()?;
    let mut leaders = votes.iter().filter(|(_, n)| **n == top);
    let (leader, _) = leaders.next()?;
    leaders.next().is_none().then(|| leader.to_string())
}

fn is_fast(net: &str, files: &BoardFiles) -> bool {
    files.fast_top.iter().chain(files.fast_mixed.iter().flatten()).any(|q| glob_match(net, q))
}

/// The reference net of each pad's net: the first reference zone whose outline holds the pad centre, per pad.
fn pad_references<'a>(board: &'a Board, planes: &PlaneSpec) -> BTreeMap<&'a str, Vec<Option<&'a str>>> {
    let refs: Vec<&crate::kicad::board::Zone> = board.zones.iter().filter(|z| z.rule_area.is_none()).filter(|z| planes.grounds.contains(&z.net) || planes.alt_refs.contains_key(&z.net)).collect();
    let mut out: BTreeMap<&str, Vec<Option<&str>>> = BTreeMap::new();
    for (_, pad) in board.pads() {
        let reference = refs.iter().find(|z| z.outline.iter().any(|p| p.contains(pad.position))).map(|z| z.net.as_str());
        out.entry(pad.net.as_str()).or_default().push(reference);
    }
    out
}

/// A net in an exempt area gets its own domain: its ground's fill plus the boxes, never stricter than the gate. POE-ETHERNET:
/// /LED_*_K leave J1 through the J1 box that has no plane, the WIZnet rule.
fn exempt_domain(domain: &str, boxes: &[[Num; 4]]) -> String {
    let text = |b: &[Num; 4]| b.iter().map(|v| short_float(v.get())).collect::<Vec<_>>().join(",");
    format!("{domain}+exempt:{}", boxes.iter().map(text).collect::<Vec<_>>().join(";"))
}

/// Assigns `ref_domain` and `ref_soft`; returns the domains and the boxes of the exempt ones.
fn assign_domains(board: &Board, nets: &mut BTreeMap<String, Net>, files: &BoardFiles) -> BTreeMap<String, Option<(String, Vec<[Num; 4]>)>> {
    let planes = &files.planes;
    let pad_refs = pad_references(board, planes);
    let mut domains = BTreeMap::new();
    for (name, net) in nets.iter_mut().filter(|(_, n)| n.plane_ref) {
        let Some(domain) = net_domain(name, pad_refs.get(name.as_str()).map_or(&[], |v| v), planes) else { continue };
        let boxes: Vec<[Num; 4]> = planes.exempt.areas.iter().filter(|a| a.nets.contains(name)).map(|a| a.bounds).collect();
        let (key, exempt) = if boxes.is_empty() { (domain, None) } else { (exempt_domain(&domain, &boxes), Some((domain, boxes))) };
        net.ref_domain = Some(key.clone());
        // The screen may accept an off-reference run of a net that is not fast: the core prices it and iotroute run lets si_planes
        // judge the written board. A fast net may cross no gap.
        net.ref_soft = Some(!is_fast(name, files));
        domains.insert(key, exempt);
    }
    domains
}

fn anchors(board: &Board, nets: &BTreeMap<String, Net>) -> Vec<Anchor> {
    let anchor = |at: Pt, diameter: i64, net: &str| (round_to(to_mm(at.x), 4), round_to(to_mm(at.y), 4), round_to(to_mm(diameter) / 2.0, 4), net.to_string());
    let pads = board.pads().filter(|(_, p)| nets.contains_key(&p.net)).map(|(_, p)| anchor(p.position, p.size.x.max(p.size.y), &p.net));
    let vias = board.copper.iter().filter_map(|c| match c {
        RoutedCopper::Via(v) if nets.contains_key(&v.net) => Some(anchor(v.at, v.size, &v.net)),
        _ => None,
    });
    pads.chain(vias).collect()
}

fn polygon_points(p: &Polygon) -> Vec<Vec<Point>> {
    p.rings().map(|r| r.iter().copied().map(fine_point).collect()).collect()
}

/// The ground and the alt_refs of its domain that count everywhere: a smaller area than the gate's, which is safe.
fn members<'a>(ground: &'a str, planes: &'a PlaneSpec) -> Vec<&'a str> {
    let alt = planes.alt_refs.iter().filter(|(_, a)| a.domain == ground && a.cap_mm.is_none() && !a.slow_only).map(|(n, _)| n.as_str());
    std::iter::once(ground).chain(alt).collect()
}

/// The fill of a domain on a plane layer. An exempt domain is one exact union of the fill and the boxes, so the box edge that
/// meets the fill edge leaves no seam the core's edge margin would close.
fn domain_fill(filled: &Board, plane: &str, ground: &str, exempt: Option<&Vec<[Num; 4]>>, planes: &PlaneSpec) -> Result<Vec<Polygon>, String> {
    let names = members(ground, planes);
    let zones = filled.zones.iter().filter(|z| z.rule_area.is_none() && names.contains(&z.net.as_str()) && z.layers.iter().any(|l| l == plane));
    let fills: Vec<Polygon> = zones.flat_map(|z| z.filled.iter().filter(|f| f.layer == plane).flat_map(|f| f.polygons.clone())).collect();
    let Some(boxes) = exempt else { return Ok(fills) };
    let mut merged = union(&fills, &[])?;
    for b in boxes {
        let [x0, y0, x1, y1] = b.map(|v| from_mm(v.get()));
        merged = union(&merged, &[Polygon::of_ring(vec![Pt::new(x0, y0), Pt::new(x1, y0), Pt::new(x1, y1), Pt::new(x0, y1)])])?;
    }
    Ok(merged)
}

/// The reference rule as router data: model `ref_fill` and net `ref_domain`. The gate samples the centre line of each checked
/// track and fails a run off the filled copper of the net's domain on the adjacent plane layer, except near the net's own pads
/// and vias. `filled` is the board after KiCad 10 refilled it, so the fill edge is KiCad's own: zone clearance, antipads and
/// min-width removal included. Routed vias add antipads later: the plane clearance rule of `plane_ref` nets keeps tracks off them.
pub fn reference_fill(board: &Board, filled: &Board, nets: &mut BTreeMap<String, Net>, files: &BoardFiles) -> Result<Option<RefFill>, String> {
    let planes = &files.planes;
    if planes.adjacent.is_empty() {
        return Ok(None);
    }
    let domains = assign_domains(board, nets, files);
    let mut layers = BTreeMap::new();
    for (outer, plane) in &planes.adjacent {
        let mut per = BTreeMap::new();
        for (key, exempt) in &domains {
            let (ground, boxes) = exempt.as_ref().map_or((key.as_str(), None), |(g, b)| (g.as_str(), Some(b)));
            let polygons = domain_fill(filled, plane, ground, boxes, planes)?;
            per.insert(key.clone(), polygons.iter().map(polygon_points).collect());
        }
        layers.insert(outer.clone(), RefLayer { plane: plane.clone(), domains: per });
    }
    Ok(Some(RefFill { source: SOURCE, via_allow: planes.via_allow_mm.unwrap_or(DEFAULT_VIA_ALLOW_MM), layers, anchors: anchors(board, nets) }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::files::{AltRef, ExemptArea};

    fn spec() -> PlaneSpec {
        PlaneSpec {
            grounds: vec!["GND".to_string(), "ISO".to_string()],
            alt_refs: BTreeMap::from([("VBAT".to_string(), AltRef { domain: "GND".to_string(), cap_mm: None, slow_only: false }), ("VCC".to_string(), AltRef { domain: "GND".to_string(), cap_mm: Some(Num::Int(3)), slow_only: false })]),
            ..PlaneSpec::default()
        }
    }

    #[test]
    fn a_domain_is_the_one_most_pads_sit_on_and_a_tie_is_none() {
        let s = spec();
        assert_eq!(net_domain("/A", &[Some("GND"), Some("VBAT"), Some("ISO")], &s).as_deref(), Some("GND"));
        assert_eq!(net_domain("/A", &[Some("GND"), Some("ISO")], &s), None);
        assert_eq!(net_domain("/A", &[None, Some("VCC")], &s), None);
    }

    #[test]
    fn a_spec_pattern_comes_first() {
        let mut s = spec();
        s.domains.insert("ISO".to_string(), vec!["/A*".to_string()]);
        assert_eq!(net_domain("/AI1", &[Some("GND")], &s).as_deref(), Some("ISO"));
    }

    #[test]
    fn plane_ref_leaves_out_grounds_power_and_exempt_nets() {
        let mut s = spec();
        s.power = vec!["/PRIMARY_*".to_string()];
        s.exempt.nets.insert("/X".to_string(), "why".to_string());
        let mut nets: BTreeMap<String, Net> = ["GND", "/PRIMARY_5V", "/X", "/SIG"].map(|n| (n.to_string(), Net::default())).into_iter().collect();
        set_plane_ref(&mut nets, &s);
        assert!(nets["/SIG"].plane_ref);
        assert!(!nets["GND"].plane_ref && !nets["/PRIMARY_5V"].plane_ref && !nets["/X"].plane_ref);
    }

    #[test]
    fn an_exempt_domain_names_its_boxes() {
        let area = ExemptArea { bounds: [Num::Float(122.5), Num::Int(100), Num::Float(130.25), Num::Int(110)], nets: Vec::new() };
        assert_eq!(exempt_domain("PHY_GND", &[area.bounds]), "PHY_GND+exempt:122.5,100,130.25,110");
    }

    #[test]
    fn an_exempt_box_joins_the_fill_with_no_seam() {
        let fill = Polygon::of_ring(vec![Pt::new(0, 0), Pt::new(10_000_000, 0), Pt::new(10_000_000, 10_000_000), Pt::new(0, 10_000_000)]);
        let zone = crate::kicad::board::Zone {
            id: String::new(), name: String::new(), net: "GND".to_string(), layers: vec!["In1.Cu".to_string()], outline: Vec::new(),
            filled: vec![crate::kicad::board::FilledLayer { layer: "In1.Cu".to_string(), polygons: vec![fill] }], rule_area: None, fill: None,
        };
        let filled = Board { path: String::new(), copper_layers: Vec::new(), stackup: Vec::new(), nets: BTreeMap::new(), footprints: Vec::new(), copper: Vec::new(), zones: vec![zone], graphics: Vec::new(), texts: Vec::new(), groups: Vec::new(), constraints: Default::default(), edges_bbox: crate::kicad::geom::Rect::around(Pt::default()), outlines: Vec::new() };
        let boxes = vec![[Num::Int(10), Num::Int(0), Num::Int(20), Num::Int(10)]];
        let merged = domain_fill(&filled, "In1.Cu", "GND", Some(&boxes), &spec()).unwrap();
        assert_eq!((merged.len(), merged[0].outline.len()), (1, 4));
    }
}
