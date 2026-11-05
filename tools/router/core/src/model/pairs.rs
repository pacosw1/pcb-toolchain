//! DRU pair rules (isolation boards, DESIGN.md 5b 2026-11-01 isolation).
//!
//! A pair rule is a clearance, creepage or hole_clearance constraint whose condition reads both items, for example
//! `A.NetClass == 'POE' && B.NetClass != 'POE'`. The per-net model cannot hold it: the value depends on the pair. Each item gets
//! a clearance group (items whose atoms are equal behave the same in every pair rule) and each group pair gets its value in
//! KiCad 10's order, confirmed with kicad-cli DRC on test boards (reports/2026-11-01-isolation.md):
//!
//!  - the condition is tested with (A, B) and with (B, A);
//!  - of the matching rules of one constraint type, the last in the file wins, not the largest value;
//!  - a custom rule replaces the net class clearance; no rule means the net class clearance (the core default stays).
//!
//! Creepage (a surface path on one copper layer, around slots) is kept in its safe form: the straight distance on a layer is
//! never longer than the surface path, so a straight clearance of at least the creepage value is safe. KiCad DRC stays the judge.
//!
//! Spatial selectors are region atoms. Pads and zones get them from the board geometry; routed items get them in the core from
//! the region polygons: a piece intersects only when its own copper does, and KiCad evaluates the whole written segment, so
//! KiCad's atom is true whenever the core's is. That is safe only while a true region atom never raises a value (a relaxation,
//! as POE 'PoE isolation inside J1'); a raising region atom on routed copper is refused.
use super::dru::{HoleScope, Rule};
use super::selector::{Atom, Item, REGION_FUNCTIONS, Scope, Selector};
use super::text::round_to;
use std::collections::{BTreeMap, BTreeSet, HashMap};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PairKind {
    Clearance,
    Creepage,
    HoleClearance,
}

impl PairKind {
    const ALL: [PairKind; 3] = [PairKind::Clearance, PairKind::Creepage, PairKind::HoleClearance];

    fn of(kind: &str) -> Option<PairKind> {
        match kind {
            "clearance" => Some(PairKind::Clearance),
            "creepage" => Some(PairKind::Creepage),
            "hole_clearance" => Some(PairKind::HoleClearance),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            PairKind::Clearance => "clearance",
            PairKind::Creepage => "creepage",
            PairKind::HoleClearance => "hole_clearance",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ItemKind {
    Track,
    Via,
    PadSmd,
    PadThroughHole,
    PadNpth,
    Zone,
}

impl ItemKind {
    fn has_hole(self) -> bool {
        matches!(self, ItemKind::Via | ItemKind::PadThroughHole | ItemKind::PadNpth)
    }

    fn is_copper(self) -> bool {
        self != ItemKind::PadNpth
    }

    fn name(self) -> &'static str {
        match self {
            ItemKind::Track => "track",
            ItemKind::Via => "via",
            ItemKind::PadSmd => "pad_smd",
            ItemKind::PadThroughHole => "pad_pth",
            ItemKind::PadNpth => "npth",
            ItemKind::Zone => "zone",
        }
    }
}

/// An item of the table: what rules read of it and what it is.
#[derive(Debug, Clone, PartialEq)]
pub struct PairItem {
    pub kind: ItemKind,
    pub item: Item,
}

impl PairItem {
    /// As the reports name it: `pad_pth /NET J1.5 in intersectsCourtyard:J1`.
    fn label(&self) -> String {
        let it = &self.item;
        let mut s = format!("{} {}", self.kind.name(), it.net_name.as_deref().filter(|n| !n.is_empty()).unwrap_or("(no net)"));
        if let Some(r) = it.reference.as_deref().filter(|r| !r.is_empty()) {
            s += &format!(" {r}.{}", it.pad_number.as_deref().unwrap_or(""));
        }
        let inside: Vec<&str> = it.regions.iter().filter(|(_, v)| *v).map(|(k, _)| k.as_str()).collect();
        if !inside.is_empty() {
            s += &format!(" in {}", inside.join(","));
        }
        s
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PairRule {
    pub name: String,
    pub kind: PairKind,
    pub condition: Selector,
    pub min: f64,
    pub layered: bool,
}

impl PairRule {
    fn holds(&self, a: &Item, b: &Item) -> Option<bool> {
        if self.condition.text.is_empty() {
            return Some(true);
        }
        self.condition.eval(Scope { a, b, pair: true })
    }
}

/// A rule that may match cannot be decided for this pair.
struct Undecided;

/// The pair-kind constraints of a rule file, in file order.
pub struct PairRules {
    rules: Vec<PairRule>,
}

impl PairRules {
    pub fn new(rules: &[Rule]) -> Result<PairRules, String> {
        let mut out = Vec::new();
        for rule in rules {
            for con in &rule.constraints {
                if let (Some(kind), Some(min)) = (PairKind::of(&con.kind), con.value("min")) {
                    out.push(PairRule { name: rule.name.clone(), kind, condition: rule.condition.clone(), min: min?, layered: rule.layer.is_some() });
                }
            }
        }
        Ok(PairRules { rules: out })
    }

    /// The pair rules proper: creepage, a clearance that reads B (not only B.Type), a hole rule whose scope the model does not
    /// know. None of them means the board has no pair rules and the model stays as it is without.
    pub fn triggers(&self) -> Vec<(String, PairKind)> {
        let trigger = |r: &&PairRule| match r.kind {
            PairKind::Creepage => true,
            PairKind::Clearance => r.condition.reads_both_items(),
            PairKind::HoleClearance => HoleScope::of(&r.condition).is_none(),
        };
        self.rules.iter().filter(trigger).map(|r| (r.name.clone(), r.kind)).collect()
    }

    /// The rule that decides `kind` for the pair, if any. A rule with a layer clause applies only on that layer, so the result
    /// is the larger of "it applies" and "it does not": safe on every layer.
    fn resolve(&self, kind: PairKind, a: &Item, b: &Item) -> Result<Option<&PairRule>, Undecided> {
        let rows: Vec<&PairRule> = self.rules.iter().filter(|r| r.kind == kind).collect();
        last_match(&rows, a, b)
    }

    /// Region atoms of the rules in a fixed order: the core's bit order. Only intersects* selectors are modelled on routed copper.
    pub fn region_keys(&self) -> Result<Vec<String>, String> {
        let mut keys = BTreeSet::new();
        for rule in &self.rules {
            for atom in rule.condition.reads().atoms {
                let Atom::Call { function, arg } = atom else { continue };
                if function.starts_with("inside") || function == "enclosedByArea" {
                    return Err(format!("{function}: only intersects* region selectors are modelled for routed copper"));
                }
                if REGION_FUNCTIONS.contains(&function.as_str()) {
                    keys.insert(format!("{function}:{arg}"));
                }
            }
        }
        Ok(keys.into_iter().collect())
    }

    /// The clearance groups and their pair table, or the pair that cannot be modelled.
    pub fn build(&self, input: &PairInput) -> Result<PairTable, String> {
        let mut groups = Groups::new(&self.rules);
        let var = groups.add_routed(&input.routed, input.regions);
        let pad_groups: Vec<usize> = input.pads.iter().map(|p| groups.of(p)).collect();
        let zone_groups: Vec<usize> = input.zones.iter().map(|z| groups.of(z)).collect();
        let (table, clearance, rules) = self.fill(&groups.reps)?;
        let n = groups.reps.len();
        refuse_raising_regions(&var, &table, n, input.regions, &groups.reps)?;
        Ok(PairTable { groups: n, table, clearance, var, pad_groups, zone_groups, rules, reps: groups.reps.iter().map(PairItem::label).collect() })
    }

    /// Both n x n tables and the rules that decided an entry.
    fn fill(&self, reps: &[PairItem]) -> Result<(Vec<f64>, Vec<f64>, Vec<(String, PairKind)>), String> {
        let n = reps.len();
        let (mut table, mut clearance, mut used) = (vec![0.0; n * n], vec![0.0; n * n], BTreeSet::new());
        for i in 0..n {
            for j in i..n {
                let entry = self.pair_value(&reps[i], &reps[j], &mut used)?;
                table[i * n + j] = round_to(entry.value, 6);
                table[j * n + i] = table[i * n + j];
                clearance[i * n + j] = round_to(entry.clearance, 6);
                clearance[j * n + i] = clearance[i * n + j];
            }
        }
        Ok((table, clearance, used.into_iter().collect()))
    }

    fn pair_value(&self, a: &PairItem, b: &PairItem, used: &mut BTreeSet<(String, PairKind)>) -> Result<Entry, String> {
        let mut entry = Entry { value: 0.0, clearance: 0.0 };
        for kind in PairKind::ALL {
            if !kind_applies(kind, a.kind, b.kind) {
                continue;
            }
            let found = self.resolve(kind, &a.item, &b.item).map_err(|_| format!("{}: pair not decidable: {} / {}", kind.name(), a.label(), b.label()))?;
            let Some(rule) = found else { continue };
            // The model applies a hole rule of known scope from the hole edge; here it would count from the pad copper.
            if kind == PairKind::HoleClearance && HoleScope::of(&rule.condition).is_some() {
                continue;
            }
            if kind == PairKind::Clearance {
                entry.clearance = entry.clearance.max(rule.min);
            }
            // The zone fill keeps the clearance only; a zone's creepage is DRC's.
            if kind == PairKind::Creepage && (a.kind == ItemKind::Zone || b.kind == ItemKind::Zone) {
                continue;
            }
            entry.value = entry.value.max(rule.min);
            used.insert((rule.name.clone(), kind));
        }
        Ok(entry)
    }
}

fn last_match<'a>(rows: &[&'a PairRule], a: &Item, b: &Item) -> Result<Option<&'a PairRule>, Undecided> {
    for (i, rule) in rows.iter().enumerate().rev() {
        let (ab, ba) = (rule.holds(a, b), rule.holds(b, a));
        if ab == Some(true) || ba == Some(true) {
            if !rule.layered {
                return Ok(Some(rule));
            }
            return Ok(match last_match(&rows[..i], a, b)? {
                Some(rest) if rest.min > rule.min => Some(rest),
                _ => Some(rule),
            });
        }
        if ab.is_none() || ba.is_none() {
            return Err(Undecided);
        }
    }
    Ok(None)
}

fn kind_applies(kind: PairKind, a: ItemKind, b: ItemKind) -> bool {
    match kind {
        PairKind::HoleClearance => a.has_hole() || b.has_hole(),
        _ => a.is_copper() && b.is_copper(),
    }
}

struct Entry {
    value: f64,
    clearance: f64,
}

/// What the table is built from. `routed`: an item per net, the unconnected net "" too, with no regions; `regions`: the region
/// atoms in the core's bit order; pads and zones carry theirs.
pub struct PairInput<'a> {
    pub routed: BTreeMap<String, Item>,
    pub pads: Vec<PairItem>,
    pub zones: Vec<PairItem>,
    pub regions: &'a [String],
}

/// The groups of a routed net, one per combination of region bits.
#[derive(Debug, Clone, PartialEq)]
pub struct NetGroups {
    pub track: Vec<usize>,
    pub via: Vec<usize>,
}

impl NetGroups {
    fn by_kind(&self) -> [(&'static str, &[usize]); 2] {
        [("track", &self.track), ("via", &self.via)]
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PairTable {
    pub groups: usize,
    /// groups x groups, row major, 0 = no pair value.
    pub table: Vec<f64>,
    /// The clearance part alone, for the pour model.
    pub clearance: Vec<f64>,
    pub var: BTreeMap<String, NetGroups>,
    pub pad_groups: Vec<usize>,
    pub zone_groups: Vec<usize>,
    /// The rules that decided a table entry.
    pub rules: Vec<(String, PairKind)>,
    pub reps: Vec<String>,
}

type Signature = (ItemKind, Vec<Option<bool>>, Vec<Option<String>>);

/// Items grouped by what the rules can tell apart.
struct Groups {
    atoms: Vec<Atom>,
    compared: Vec<String>,
    ids: HashMap<Signature, usize>,
    reps: Vec<PairItem>,
}

impl Groups {
    fn new(rules: &[PairRule]) -> Groups {
        let (mut atoms, mut compared) = (BTreeSet::new(), BTreeSet::new());
        for rule in rules {
            let reads = rule.condition.reads();
            atoms.extend(reads.atoms);
            compared.extend(reads.compared);
        }
        Groups { atoms: atoms.into_iter().collect(), compared: compared.into_iter().collect(), ids: HashMap::new(), reps: Vec::new() }
    }

    fn of(&mut self, item: &PairItem) -> usize {
        let atoms = self.atoms.iter().map(|a| a.value(&item.item)).collect();
        let compared = self.compared.iter().map(|c| item.item.attr(c).map(str::to_string)).collect();
        let next = self.reps.len();
        let id = *self.ids.entry((item.kind, atoms, compared)).or_insert(next);
        if id == next {
            self.reps.push(item.clone());
        }
        id
    }

    fn add_routed(&mut self, routed: &BTreeMap<String, Item>, regions: &[String]) -> BTreeMap<String, NetGroups> {
        let mut var = BTreeMap::new();
        for (net, item) in routed {
            let mut per_kind = |kind, type_name: &str| -> Vec<usize> {
                (0..1usize << regions.len()).map(|bits| self.of(&routed_item(item, kind, type_name, regions, bits))).collect()
            };
            let track = per_kind(ItemKind::Track, "Track");
            let via = per_kind(ItemKind::Via, "Via");
            var.insert(net.clone(), NetGroups { track, via });
        }
        var
    }
}

fn routed_item(item: &Item, kind: ItemKind, type_name: &str, regions: &[String], bits: usize) -> PairItem {
    let mut item = item.clone();
    item.item_type = Some(type_name.to_string());
    item.regions = regions.iter().enumerate().map(|(i, k)| (k.clone(), bits >> i & 1 == 1)).collect();
    PairItem { kind, item }
}

/// A true region atom of a routed item must never raise a value (see the module text).
fn refuse_raising_regions(var: &BTreeMap<String, NetGroups>, table: &[f64], n: usize, regions: &[String], reps: &[PairItem]) -> Result<(), String> {
    for (net, groups) in var {
        for (kind, per_bits) in groups.by_kind() {
            for (bits, &g) in per_bits.iter().enumerate() {
                for k in (0..regions.len()).filter(|k| bits >> k & 1 == 1) {
                    let g0 = per_bits[bits & !(1 << k)];
                    if let Some(h) = (0..n).find(|&h| table[g * n + h] > table[g0 * n + h] + 1e-9) {
                        return Err(format!("region {} raises the value for {net} {kind} vs {}: a raising spatial rule on routed copper is not modelled", regions[k], reps[h].label()));
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::dru::parse_rules;

    const COURTYARD: &str = "intersectsCourtyard:J1";

    fn rules(text: &str) -> PairRules {
        PairRules::new(&parse_rules(&format!("(version 1)\n{text}")).unwrap()).unwrap()
    }

    fn trk(net: &str, class: &str) -> Item {
        Item::plain(net, class, "Track")
    }

    fn within(mut item: Item, inside: bool) -> Item {
        item.regions = vec![(COURTYARD.to_string(), inside)];
        item
    }

    fn pad(net: &str, class: &str, reference: &str, number: &str) -> Item {
        let mut it = Item::plain(net, class, "Pad");
        it.pad_type = Some("SMD".to_string());
        it.reference = Some(reference.to_string());
        it.pad_number = Some(number.to_string());
        it
    }

    /// (value, rule) of the clearance, None for no rule, panics on undecided.
    fn clearance(r: &PairRules, a: &Item, b: &Item) -> Option<(f64, String)> {
        r.resolve(PairKind::Clearance, a, b).ok().expect("decided").map(|x| (x.min, x.name.clone()))
    }

    const G: &str = r#"(rule "G" (condition "A.NetClass == 'ISO' && B.NetClass != 'ISO'") (constraint clearance (min 1.0mm)))"#;
    const R: &str = r#"(rule "R" (condition "A.NetClass == 'ISO' && B.NetClass != 'ISO' && A.intersectsCourtyard('J1') && B.intersectsCourtyard('J1')") (constraint clearance (min 0.4mm)))"#;

    #[test]
    fn the_later_rule_wins_not_the_largest() {
        // kicad-cli t1 (G then R): inside J1 0.4 applies; t2 (R then G): 1.0 applies inside J1 too.
        let (a, b) = (within(trk("ISO2", "ISO"), true), within(trk("OTH2", "OTH"), true));
        assert_eq!(clearance(&rules(&format!("{G}{R}")), &a, &b), Some((0.4, "R".to_string())));
        assert_eq!(clearance(&rules(&format!("{R}{G}")), &a, &b), Some((1.0, "G".to_string())));
        // t1 case 4: B outside the courtyard: G.
        assert_eq!(clearance(&rules(&format!("{G}{R}")), &a, &within(trk("OTH3", "OTH"), false)), Some((1.0, "G".to_string())));
    }

    #[test]
    fn both_item_orders_count() {
        // kicad-cli t3: the ISO-Default pair is flagged from either side.
        let r = rules(r#"(rule "S" (condition "A.NetClass == 'Default' && B.NetClass == 'ISO'") (constraint clearance (min 1.0mm)))"#);
        let (iso, def) = (trk("ISO7", "ISO"), trk("DEF7", "Default"));
        assert_eq!(clearance(&r, &iso, &def), Some((1.0, "S".to_string())));
        assert_eq!(clearance(&r, &def, &iso), Some((1.0, "S".to_string())));
        assert_eq!(clearance(&r, &trk("X", "Default"), &trk("Y", "Default")), None);
    }

    #[test]
    fn attributes_compare_with_each_other() {
        // RELAY-4 'Relay circuit to relay circuit': two mains classes 3 mm, one class with itself no rule.
        let r = rules(r#"(rule "M" (condition "A.NetClass == 'MAINS_K*' && B.NetClass != 'MAINS_K*'") (constraint clearance (min 8mm)))
(rule "K" (condition "A.NetClass == 'MAINS_K*' && B.NetClass == 'MAINS_K*' && A.NetClass != B.NetClass") (constraint clearance (min 3mm)))"#);
        let a = trk("a", "MAINS_K1");
        assert_eq!(clearance(&r, &a, &trk("b", "MAINS_K2")), Some((3.0, "K".to_string())));
        assert_eq!(clearance(&r, &a, &trk("c", "MAINS_K1")), None);
        assert_eq!(clearance(&r, &a, &trk("s", "SELV")), Some((8.0, "M".to_string())));
    }

    #[test]
    fn a_footprint_exception_holds_for_two_pads_of_it() {
        // BASE-PWR-B 'CAN isolation barrier': not between two pads of U22, the isolator.
        let r = rules(r#"(rule "CAN" (condition "A.NetClass == 'CAN_ISO' && B.NetClass != 'CAN_ISO' && B.NetName != '' && !(A.memberOfFootprint('U22') && B.memberOfFootprint('U22'))") (constraint clearance (min 4mm)) (constraint creepage (min 4mm)))"#);
        let supply = pad("3V3", "Default", "U22", "1");
        assert_eq!(clearance(&r, &pad("CANH", "CAN_ISO", "U22", "13"), &supply), None);
        assert_eq!(clearance(&r, &trk("CANH", "CAN_ISO"), &supply), Some((4.0, "CAN".to_string())));
        assert_eq!(clearance(&r, &trk("CANH", "CAN_ISO"), &pad("", "Default", "H1", "")), None);
    }

    #[test]
    fn a_pair_that_cannot_be_decided_is_not_guessed() {
        let r = rules(r#"(rule "X" (condition "A.NetClass == 'ISO' && B.someFunction('Q')") (constraint clearance (min 2mm)))"#);
        assert!(r.resolve(PairKind::Clearance, &trk("a", "ISO"), &trk("b", "OTH")).is_err());
        assert_eq!(clearance(&r, &trk("a", "OTH"), &trk("b", "OTH")), None);
    }

    #[test]
    fn a_layer_rule_gives_the_larger_value() {
        let r = rules(r#"(rule "A" (condition "A.NetClass == 'ISO' && B.NetClass != 'ISO'") (constraint clearance (min 3mm)))
(rule "L" (layer "F.Cu") (condition "A.NetClass == 'ISO' && B.NetClass != 'ISO'") (constraint clearance (min 1mm)))"#);
        assert_eq!(clearance(&r, &trk("a", "ISO"), &trk("b", "OTH")), Some((3.0, "A".to_string())));
    }

    const POE: &str = r#"(rule "PoE isolation" (condition "A.NetClass == 'POE' && B.NetClass != 'POE'") (constraint clearance (min 3mm)) (constraint creepage (min 3mm)))
(rule "PoE isolation inside J1" (condition "A.NetClass == 'POE' && B.NetClass != 'POE' && A.Type != 'Zone' && B.Type != 'Zone' && A.intersectsCourtyard('J1') && B.intersectsCourtyard('J1')") (constraint clearance (min 1.25mm)))
(rule "PoE creepage J1 pin pitch" (condition "(A.NetName == '/POE_V1P' && B.NetName == '/MAG_RDN') || (A.NetName == '/MAG_RDN' && B.NetName == '/POE_V1P')") (constraint creepage (min 1.25mm)))
(rule "JLC PTH hole to copper" (constraint hole_clearance (min 0.28mm)) (condition "A.Pad_Type == 'Through-hole' || B.Pad_Type == 'Through-hole'"))"#;

    fn pth(net: &str, number: &str) -> PairItem {
        let mut it = pad(net, "Default", "J1", number);
        it.pad_type = Some("Through-hole".to_string());
        PairItem { kind: ItemKind::PadThroughHole, item: within(it, true) }
    }

    fn poe_table() -> PairTable {
        let regions = [COURTYARD.to_string()];
        let routed = [("/POE_V1P", "POE"), ("/POE_V1N", "POE"), ("GND", "Default"), ("", "Default")].map(|(n, c)| (n.to_string(), trk(n, c))).into_iter().collect();
        let c1 = PairItem { kind: ItemKind::PadSmd, item: within(pad("GND", "Default", "C1", "2"), false) };
        let mut zone = within(trk("GND", "Default"), true);
        zone.item_type = Some("Zone".to_string());
        let input = PairInput { routed, pads: vec![pth("/MAG_RDN", "5"), pth("/ETH_CT", "3"), c1], zones: vec![PairItem { kind: ItemKind::Zone, item: zone }], regions: &regions };
        rules(POE).build(&input).unwrap()
    }

    fn value(t: &PairTable, net: &str, bits: usize, other: usize) -> f64 {
        t.table[t.var[net].track[bits] * t.groups + other]
    }

    #[test]
    fn creepage_keeps_the_relaxed_clearance_up() {
        let t = poe_table();
        let (mag, ct, c1) = (t.pad_groups[0], t.pad_groups[1], t.pad_groups[2]);
        // Inside J1 the clearance relaxes to 1.25 for every pair, but the creepage stays 3.0 except the named pair.
        assert_eq!(value(&t, "/POE_V1P", 1, mag), 1.25);
        assert_eq!(value(&t, "/POE_V1P", 1, ct), 3.0);
        assert_eq!(value(&t, "/POE_V1P", 0, mag), 3.0);
        assert_eq!(value(&t, "/POE_V1N", 1, mag), 3.0);
        assert_eq!(value(&t, "GND", 0, c1), 0.0);
        // The zone keeps the clearance only: GND zone in J1 to a POE track in J1 = 3.0, the rule excludes zones.
        assert_eq!(t.clearance[t.zone_groups[0] * t.groups + t.var["/POE_V1P"].track[1]], 3.0);
    }

    #[test]
    fn a_known_hole_rule_stays_out_of_the_table() {
        // 'JLC PTH hole to copper' is the model's hole rule; in the table it would count from the pad copper.
        let t = poe_table();
        assert_eq!(value(&t, "GND", 1, t.pad_groups[1]), 0.0);
    }

    #[test]
    fn the_table_names_its_rules_and_groups() {
        let t = poe_table();
        assert!(t.rules.contains(&("PoE isolation".to_string(), PairKind::Creepage)));
        assert!(!t.rules.iter().any(|(r, _)| r == "JLC PTH hole to copper"));
        assert!(t.reps.iter().any(|r| r.starts_with("track (no net)")));
        assert!(t.reps.iter().any(|r| r.contains("J1.5 in intersectsCourtyard:J1")));
    }

    #[test]
    fn a_raising_region_on_routed_copper_is_refused() {
        let r = rules(r#"(rule "In" (condition "A.NetClass == 'ISO' && A.intersectsArea('HV') && B.NetClass != 'ISO'") (constraint clearance (min 5mm)))"#);
        let regions = ["intersectsArea:HV".to_string()];
        let routed = [("a", "ISO"), ("b", "OTH"), ("", "Default")].map(|(n, c)| (n.to_string(), trk(n, c))).into_iter().collect();
        let input = PairInput { routed, pads: Vec::new(), zones: Vec::new(), regions: &regions };
        assert!(r.build(&input).unwrap_err().contains("raises the value"));
    }

    #[test]
    fn triggers_are_the_rules_the_per_net_model_cannot_hold() {
        // NET-CORE-like rules (pair inner gap, pour gap, JLC hole rules) are not pair rules.
        let r = rules(r#"(rule "gap" (condition "A.isCoupledDiffPair()") (constraint clearance (min 0.12mm)))
(rule "pour" (condition "A.inDiffPair('/USB_D') && A.Type == 'Track' && B.Type == 'Zone'") (constraint clearance (min 0.5mm)))
(rule "JLC" (constraint hole_clearance (min 0.28mm)) (condition "A.Pad_Type == 'Through-hole' || B.Pad_Type == 'Through-hole'"))"#);
        assert_eq!(r.triggers(), []);
        let names: Vec<(String, PairKind)> = [("PoE isolation", PairKind::Clearance), ("PoE isolation", PairKind::Creepage), ("PoE isolation inside J1", PairKind::Clearance), ("PoE creepage J1 pin pitch", PairKind::Creepage)].map(|(n, k)| (n.to_string(), k)).into();
        assert_eq!(rules(POE).triggers(), names);
    }

    #[test]
    fn region_keys_are_sorted_and_inside_is_refused() {
        let r = rules(r#"(rule "a" (condition "A.intersectsCourtyard('J1') && B.intersectsArea('Z')") (constraint clearance (min 1mm)))"#);
        assert_eq!(r.region_keys().unwrap(), ["intersectsArea:Z", "intersectsCourtyard:J1"]);
        let inside = rules(r#"(rule "a" (condition "A.insideArea('Z')") (constraint clearance (min 1mm)))"#);
        assert!(inside.region_keys().is_err());
    }
}
