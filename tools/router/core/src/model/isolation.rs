//! The pair rules on a board (model `iso`): region geometry, the items of the table, and what the table changes in the rest of the
//! model. A board with no pair rule gets no `iso` and the model stays as it is without.
use super::items::fine_point;
use super::output::{Iso, IsoNet, IsoRegion, ItemClearance, Net, Pad, Point, RuleReport, RuleState, Zone};
use super::pairs::{ItemKind, PairInput, PairItem, PairKind, PairRules, PairTable};
use super::selector::Item;
use super::text::glob_match;
use crate::kicad::board::Board;
use crate::kicad::geom::Polygon;
use crate::kicad::geom::boolean::intersection;
use crate::kicad::geom::outline::courtyard;
use crate::kicad::pad::{Pad as BoardPad, PadKind};
use std::collections::{BTreeMap, BTreeSet};

/// A region atom `fn:arg`: the polygon sets it hits, and the outlines for the core.
struct Region {
    key: String,
    sets: Vec<Vec<Polygon>>,
}

/// Courtyards of the footprints whose reference matches arg, or the zones and rule areas named arg.
fn region_sets(board: &Board, function: &str, arg: &str) -> Result<Vec<Vec<Polygon>>, String> {
    if !function.contains("Courtyard") {
        let own = board.zones.iter();
        return Ok(own.chain(board.footprints.iter().flat_map(|f| &f.zones)).filter(|z| glob_match(&z.name, arg)).map(|z| z.outline.clone()).collect());
    }
    let mut sets = Vec::new();
    for footprint in board.footprints.iter().filter(|f| glob_match(&f.reference, arg)) {
        if function != "intersectsBackCourtyard" {
            sets.push(courtyard(footprint, false)?);
        }
        if function != "intersectsFrontCourtyard" {
            sets.push(courtyard(footprint, true)?);
        }
    }
    Ok(sets)
}

fn read_region(board: &Board, key: &str) -> Result<Region, String> {
    let (function, arg) = key.split_once(':').unwrap_or((key, ""));
    let sets: Vec<Vec<Polygon>> = region_sets(board, function, arg)?.into_iter().filter(|s| !s.is_empty()).collect();
    if sets.iter().flatten().any(|p| !p.holes.is_empty()) {
        return Err(format!("region {key}: a polygon with a hole is not modelled"));
    }
    if sets.is_empty() {
        return Err(format!("region {key}: no courtyard / area of that name on the board"));
    }
    Ok(Region { key: key.to_string(), sets })
}

impl Region {
    fn polygons(&self) -> impl Iterator<Item = &Polygon> {
        self.sets.iter().flatten()
    }

    fn outlines(&self) -> Vec<Vec<Point>> {
        self.polygons().map(|p| p.outline.iter().copied().map(fine_point).collect()).collect()
    }

    fn hits_pad(&self, pad: &BoardPad) -> bool {
        self.polygons().any(|p| pad.copper.iter().any(|c| p.collides(c)))
    }

    fn hits_zone(&self, outline: &[Polygon]) -> Result<bool, String> {
        for set in &self.sets {
            if !intersection(set, outline)?.is_empty() {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

fn pair_of(files_pairs: &[(String, String)]) -> BTreeMap<&str, &str> {
    files_pairs.iter().flat_map(|(p, n)| [(p.as_str(), p.as_str()), (n.as_str(), p.as_str())]).collect()
}

pub fn pad_type(kind: PadKind) -> &'static str {
    match kind {
        PadKind::ThroughHole => "Through-hole",
        PadKind::Smd => "SMD",
        PadKind::EdgeConnector => "Edge connector",
        PadKind::NpThroughHole => "NPTH, mechanical",
    }
}

fn pad_items(board: &Board, pads: &[Pad], regions: &[Region], pairs: &BTreeMap<&str, &str>) -> Vec<PairItem> {
    board.pads().zip(pads).map(|((_, source), pad)| {
        let kind = if source.kind == PadKind::NpThroughHole {
            ItemKind::PadNpth
        } else if pad.drill > 0.0 {
            ItemKind::PadThroughHole
        } else {
            ItemKind::PadSmd
        };
        let item = Item {
            net_name: Some(pad.net.clone()),
            net_class: Some(board.net_class(&pad.net).to_string()),
            item_type: Some("Pad".to_string()),
            pad_type: Some(pad_type(source.kind).to_string()),
            reference: Some(pad.reference.clone()),
            pad_number: Some(pad.num.clone()),
            pair: pairs.get(pad.net.as_str()).map(|p| p.to_string()),
            regions: regions.iter().map(|r| (r.key.clone(), r.hits_pad(source))).collect(),
        };
        PairItem { kind, item }
    }).collect()
}

fn zone_items(board: &Board, zones: &[Zone], sources: &[usize], nets: &BTreeMap<String, Net>, regions: &[Region]) -> Result<Vec<PairItem>, String> {
    zones.iter().zip(sources).map(|(zone, source)| {
        let class = nets.get(&zone.net).map_or("Default", |n| n.class.as_str());
        let mut item = Item::plain(&zone.net, class, "Zone");
        item.regions = regions.iter().map(|r| Ok((r.key.clone(), r.hits_zone(&board.zones[*source].outline)?))).collect::<Result<_, String>>()?;
        Ok(PairItem { kind: ItemKind::Zone, item })
    }).collect()
}

fn routed_items(nets: &BTreeMap<String, Net>, pairs: &BTreeMap<&str, &str>) -> BTreeMap<String, Item> {
    let mut routed: BTreeMap<String, Item> = nets.iter().map(|(name, net)| {
        let mut item = Item::plain(name, &net.class, "Track");
        item.pair = pairs.get(name.as_str()).map(|p| p.to_string());
        (name.clone(), item)
    }).collect();
    routed.insert(String::new(), Item::plain("", "Default", "Track"));
    routed
}

/// The zone-to-net clearance of the pair rules goes to the zones' `net_clearance`, for the pour model.
fn add_zone_clearances(zones: &mut [Zone], pads: &[Pad], table: &PairTable) {
    let n = table.groups;
    let mut by_net: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    for (pad, group) in pads.iter().zip(&table.pad_groups) {
        if !pad.net.is_empty() {
            by_net.entry(&pad.net).or_default().push(*group);
        }
    }
    for (zone, zone_group) in zones.iter_mut().zip(&table.zone_groups) {
        let value = |groups: &[usize]| groups.iter().map(|g| table.clearance[zone_group * n + g]).fold(0.0, f64::max);
        let mut wanted: Vec<(String, f64, f64, f64)> = Vec::new();
        for (name, groups) in table.var.iter().filter(|(name, _)| !name.is_empty() && **name != zone.net) {
            let pad_groups = by_net.get(name.as_str()).map_or(&[][..], |g| g);
            wanted.push((name.clone(), value(&groups.track), value(&groups.via), value(pad_groups)));
        }
        for (name, track, via, pad) in wanted.into_iter().filter(|(_, t, v, p)| t.max(*v).max(*p) > 0.0) {
            let entry: &mut ItemClearance = zone.net_clearance.entry(name).or_default();
            let raise = |field: &mut Option<f64>, value: f64| {
                if value > 0.0 {
                    *field = Some(field.unwrap_or(0.0).max(value));
                }
            };
            raise(&mut entry.track, track);
            raise(&mut entry.via, via);
            raise(&mut entry.pad, pad);
        }
    }
}

fn mark_applied(report: &mut [RuleReport], triggers: &BTreeSet<(String, PairKind)>, used: &BTreeSet<(String, PairKind)>) {
    let matches = |r: &RuleReport, set: &BTreeSet<(String, PairKind)>| set.iter().any(|(name, kind)| *name == r.rule && kind.name() == r.constraint);
    for r in report.iter_mut() {
        if matches(r, triggers) || (matches(r, used) && r.state == RuleState::Unknown) {
            r.state = RuleState::Applied;
            r.why = if r.constraint == "creepage" {
                "pair table (KiCad: last matching rule wins, both orders); creepage as a straight clearance on every layer (safe form, KiCad DRC creepage judges)".to_string()
            } else {
                "pair table (KiCad: last matching rule wins, both orders)".to_string()
            };
        }
    }
}

fn mark_unknown(report: &mut [RuleReport], triggers: &BTreeSet<(String, PairKind)>, why: &str) {
    for r in report.iter_mut().filter(|r| triggers.iter().any(|(name, kind)| *name == r.rule && kind.name() == r.constraint)) {
        r.state = RuleState::Unknown;
        r.why = format!("pair rule not modelled: {why}");
    }
}

/// What the table needs from the rest of the model.
pub struct IsoContext<'a> {
    pub board: &'a Board,
    pub rules: &'a PairRules,
    pub pairs: &'a [(String, String)],
    pub nets: &'a BTreeMap<String, Net>,
    pub sources: &'a [usize],
}

fn build_table(c: &IsoContext, pads: &[Pad], zones: &[Zone]) -> Result<(PairTable, Vec<Region>), String> {
    let keys = c.rules.region_keys()?;
    let regions: Vec<Region> = keys.iter().map(|k| read_region(c.board, k)).collect::<Result<_, _>>()?;
    let pairs = pair_of(c.pairs);
    let input = PairInput { routed: routed_items(c.nets, &pairs), pads: pad_items(c.board, pads, &regions, &pairs), zones: zone_items(c.board, zones, c.sources, c.nets, &regions)?, regions: &keys };
    Ok((c.rules.build(&input)?, regions))
}

/// Sets pad `iso_grp`, the zones' clearances and the rule states; a pair that cannot be decided marks its rules unknown, which
/// stops the model, and nothing is guessed.
pub fn apply_pair_rules(c: &IsoContext, pads: &mut [Pad], zones: &mut [Zone], report: &mut [RuleReport]) -> Option<Iso> {
    let triggers: BTreeSet<(String, PairKind)> = c.rules.triggers().into_iter().collect();
    if triggers.is_empty() {
        return None;
    }
    let (table, regions) = match build_table(c, pads, zones) {
        Ok(built) => built,
        Err(why) => {
            mark_unknown(report, &triggers, &why);
            return None;
        }
    };
    for (pad, group) in pads.iter_mut().zip(&table.pad_groups) {
        pad.iso_grp = Some(*group);
    }
    add_zone_clearances(zones, pads, &table);
    let used: BTreeSet<(String, PairKind)> = table.rules.iter().cloned().collect();
    mark_applied(report, &triggers, &used);
    let named: BTreeSet<&(String, PairKind)> = used.iter().chain(&triggers).collect();
    Some(Iso {
        groups: table.groups,
        max: table.table.iter().copied().fold(0.0, f64::max),
        var: table.var.iter().map(|(n, g)| (n.clone(), IsoNet { track: g.track.clone(), via: g.via.clone() })).collect(),
        regions: regions.iter().map(|r| IsoRegion { key: r.key.clone(), polys: r.outlines() }).collect(),
        rules: named.iter().map(|(rule, kind)| format!("{rule} / {}", kind.name())).collect(),
        reps: table.reps,
        table: table.table,
    })
}
