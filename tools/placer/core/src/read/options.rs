//! What a board read takes besides the board: the flags of `iotplace read`.

use crate::geom::Rect;
use serde::Deserialize;
use std::collections::BTreeMap;

/// An edge anchor: `side` (N, S, E, W) of the part on one of the board edges in `sides`. `exact` = (inset, tol) sets the line.
#[derive(Clone, Debug, PartialEq)]
pub struct EdgeAnchor {
    pub reference: String,
    pub sides: String,
    pub side: char,
    pub exact: Option<(f64, f64)>,
}

/// Pad `pad` of `part` stays within `distance` mm of pad `target_pad` of `target`, a part of a fixed unit.
#[derive(Clone, Debug, PartialEq)]
pub struct Near {
    pub part: String,
    pub pad: String,
    pub target: String,
    pub target_pad: String,
    pub distance: f64,
}

/// Explicit block and component membership (`iotplace members`).
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Members {
    #[serde(default)]
    pub blocks: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub components: BTreeMap<String, Vec<String>>,
}

#[derive(Clone, Debug)]
pub struct Options {
    pub fix: Vec<String>,
    pub skip: Vec<String>,
    pub edge_dist: f64,
    pub keepout_layers: Vec<String>,
    pub free_box: Option<Rect>,
    pub region_refs: Vec<String>,
    pub region_weight: f64,
    pub region_box: Option<Rect>,
    /// Spacing classes: (passive, IC and connector), D-040.
    pub spacing: (f64, f64),
    pub tie: f64,
    pub rigid_nets: Vec<String>,
    pub decap_tie: f64,
    pub keepout_zones: Vec<String>,
    pub edges: Vec<EdgeAnchor>,
    pub zone_refs: BTreeMap<String, String>,
    /// Overrides the domain rules of the board .kicad_dru.
    pub domains: Option<Vec<(String, f64, f64)>>,
    pub via_nets: Vec<String>,
    pub rigid_groups: Vec<Vec<String>>,
    pub blocks: Option<Members>,
    pub w_block: f64,
    pub w_comp: f64,
    pub tp_pins: bool,
    pub in_boxes: Vec<(String, [f64; 4])>,
    pub near: Vec<Near>,
    /// Propose soft clusters (clusters.rs), with this weight per tie.
    pub auto_clusters: Option<f64>,
}

impl Default for Options {
    /// The defaults of the problem reader. The command line sets `rigid_nets`, `decap_tie`, `w_block` and `w_comp` apart.
    fn default() -> Self {
        Self {
            fix: Vec::new(),
            skip: vec!["GND".to_string()],
            edge_dist: 1.5,
            keepout_layers: Vec::new(),
            free_box: None,
            region_refs: Vec::new(),
            region_weight: 1.0,
            region_box: None,
            spacing: (0.5, 1.0),
            tie: 0.0,
            rigid_nets: Vec::new(),
            decap_tie: 0.0,
            keepout_zones: Vec::new(),
            edges: Vec::new(),
            zone_refs: BTreeMap::new(),
            domains: None,
            via_nets: Vec::new(),
            rigid_groups: Vec::new(),
            blocks: None,
            w_block: 0.0,
            w_comp: 0.0,
            tp_pins: false,
            in_boxes: Vec::new(),
            near: Vec::new(),
            auto_clusters: None,
        }
    }
}

/// 'MAINS_K*:8:3': pads of these net classes keep 8 mm to all other nets and 3 mm to another class of the domain.
pub fn parse_domain(item: &str) -> crate::Result<(String, f64, f64)> {
    let bad = || format!("bad --domain {item}: use CLASS_PATTERN:GAP:CLASS_GAP");
    let mut fields = item.rsplitn(3, ':');
    let (class_gap, gap, pattern) = (fields.next(), fields.next(), fields.next());
    let (Some(class_gap), Some(gap), Some(pattern)) = (class_gap, gap, pattern) else { return Err(bad().into()) };
    Ok((pattern.to_string(), gap.parse().map_err(|_| bad())?, class_gap.parse().map_err(|_| bad())?))
}

/// 'J1=TB:S' or 'J2=B:S:0[:TOL]'. An INSET alone has a tolerance of 0.05 mm.
pub fn parse_edge(item: &str) -> crate::Result<EdgeAnchor> {
    let bad = || format!("bad --edge {item}: use REF=<sides from LRTB>:<N|S|E|W>[:INSET[:TOL]]");
    let (reference, rest) = item.split_once('=').ok_or_else(bad)?;
    let fields: Vec<&str> = rest.split(':').collect();
    if !(2..=4).contains(&fields.len()) {
        return Err(bad().into());
    }
    let (sides, side) = (fields[0], fields[1]);
    if sides.is_empty() || !sides.chars().all(|c| "LRTB".contains(c)) || !matches!(side, "N" | "S" | "E" | "W") {
        return Err(bad().into());
    }
    let extra: Vec<f64> = fields[2..].iter().map(|v| v.parse()).collect::<Result<_, _>>().map_err(|_| format!("bad --edge {item}: INSET and TOL are mm"))?;
    if extra.iter().any(|v| *v < 0.0) {
        return Err(format!("bad --edge {item}: INSET and TOL must be >= 0").into());
    }
    let exact = extra.first().map(|inset| (*inset, extra.get(1).copied().unwrap_or(0.05)));
    Ok(EdgeAnchor { reference: reference.to_string(), sides: sides.to_string(), side: side.chars().next().unwrap_or('N'), exact })
}

/// 'D1.1=J1.1:7'.
pub fn parse_near(item: &str) -> crate::Result<Near> {
    let parse = || -> Option<Near> {
        let (a, rest) = item.split_once('=')?;
        let (b, distance) = rest.rsplit_once(':')?;
        let (part, pad) = a.rsplit_once('.')?;
        let (target, target_pad) = b.rsplit_once('.')?;
        Some(Near { part: part.into(), pad: pad.into(), target: target.into(), target_pad: target_pad.into(), distance: distance.parse().ok()? })
    };
    parse().ok_or_else(|| format!("bad --near {item}: use REF.PAD=REF.PAD:MM").into())
}

/// 'TP*=169,120,171.5,153'.
pub fn parse_in_box(item: &str) -> crate::Result<(String, [f64; 4])> {
    let bad = || format!("bad --in-box {item}: use PATTERN=X0,Y0,X1,Y1");
    let (pattern, values) = item.split_once('=').ok_or_else(bad)?;
    let numbers: Vec<f64> = values.split(',').map(str::parse).collect::<Result<_, _>>().map_err(|_| bad())?;
    let boxed: [f64; 4] = numbers.try_into().map_err(|_| bad())?;
    if pattern.is_empty() {
        return Err(bad().into());
    }
    Ok((pattern.to_string(), boxed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_edge_takes_sides_a_side_and_an_optional_line() {
        let plain = parse_edge("J1=TB:S").unwrap();
        assert_eq!((plain.sides.as_str(), plain.side, plain.exact), ("TB", 'S', None));
        assert_eq!(parse_edge("J2=B:S:0").unwrap().exact, Some((0.0, 0.05)));
        assert_eq!(parse_edge("J2=B:S:1:0.2").unwrap().exact, Some((1.0, 0.2)));
        for bad in ["J1", "J1=X:S", "J1=T:Q", "J1=T:S:a", "J1=T:S:-1", "J1=T:S:1:2:3"] {
            assert!(parse_edge(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_near_rule_splits_at_the_last_dot_and_colon() {
        let n = parse_near("D1.1=J1.2:7").unwrap();
        assert_eq!((n.part.as_str(), n.pad.as_str(), n.target.as_str(), n.target_pad.as_str(), n.distance), ("D1", "1", "J1", "2", 7.0));
        assert!(parse_near("D1=J1.2:7").is_err());
    }

    #[test]
    fn a_box_has_four_numbers_and_a_domain_three_fields() {
        assert_eq!(parse_in_box("TP*=1,2,3,4").unwrap(), ("TP*".to_string(), [1.0, 2.0, 3.0, 4.0]));
        assert!(parse_in_box("TP*=1,2,3").is_err());
        assert_eq!(parse_domain("MAINS_K*:8:3").unwrap(), ("MAINS_K*".to_string(), 8.0, 3.0));
        assert!(parse_domain("X:8").is_err());
    }
}
