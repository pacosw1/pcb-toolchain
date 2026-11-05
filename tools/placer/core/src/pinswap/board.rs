//! The board side of a pin swap. `read_pins` makes the search problem of one IC from a pin map and the pad places of the board; it
//! fails closed when a pin map net disagrees with the board pad. `apply_swap` changes the pad nets for a routing benchmark only: it
//! takes out the copper that touched a changed pad. The schematic never changes, so parity fails on the copy.
//!
//! A pin map is `{ref, pins: [{number, name, net, function, af, pin_type, exti, note}]}`.

use super::{Change, Kind, Nets, Pin, Segment, Slot, Slots, SwapNet, rat_line};
use crate::dru::fnmatch;
use crate::geom::Point;
use crate::kicad::clusters::Clusters;
use crate::kicad::doc::{Board, CopperItem, Footprint, Pad, PtMm};
use crate::write::text::{Changes, items_by_uuid, set_pad_net};
use iotroute::kicad::edit::Edit;
use iotroute::kicad::raw::parse_first;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

/// Nets that are no signal: their pins draw no fixed rat line.
const POWER: [&str; 8] = ["GND", "+*", "VDD*", "VSS*", "VCAP*", "VREF*", "VBAT*", "NC"];

#[derive(Debug, Deserialize)]
pub struct PinMap {
    #[serde(rename = "ref")]
    pub reference: Option<String>,
    pub pins: Vec<MapPin>,
}

#[derive(Debug, Deserialize)]
pub struct MapPin {
    pub number: Pin,
    pub name: String,
    pub net: String,
    pub function: Option<String>,
    pub af: Option<Value>,
    pub pin_type: Option<String>,
    pub exti: Option<Value>,
    pub note: Option<String>,
}

/// What the search may do with a pin.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// An unused pin: a net may move here.
    Free,
    /// Its net may move.
    Swappable(Kind),
}

/// The role of a pin, `None` for a fixed one.
pub fn kind_of(pin: &MapPin) -> Option<Role> {
    let function = pin.function.as_deref().unwrap_or("");
    if pin.af.is_some() {
        None
    } else if function == "unused" {
        Some(Role::Free)
    } else if function.contains("EXTI") && pin.exti.is_some() {
        Some(Role::Swappable(Kind::Exti))
    } else if function.starts_with("GPIO out") {
        Some(Role::Swappable(Kind::Out))
    } else if function.starts_with("GPIO in") {
        Some(Role::Swappable(Kind::Plain))
    } else {
        None
    }
}

/// The search problem of one IC.
#[derive(Debug, Default)]
pub struct PinProblem {
    pub nets: Nets,
    pub slots: Slots,
    pub fixed: Vec<Segment>,
}

fn footprint<'b>(board: &'b Board, reference: &str) -> crate::Result<&'b Footprint> {
    board.footprints.iter().find(|f| f.reference == reference).ok_or_else(|| format!("{reference} not on the board").into())
}

fn short(net: &str) -> &str {
    net.rsplit('/').next().unwrap_or(net)
}

fn is_power(net: &str) -> bool {
    POWER.iter().any(|p| fnmatch(short(net), p))
}

/// The pad of every other footprint, by net.
fn other_ends<'b>(board: &'b Board, reference: &str) -> HashMap<&'b str, Vec<Point>> {
    let mut ends: HashMap<&str, Vec<Point>> = HashMap::new();
    for pad in board.footprints.iter().filter(|f| f.reference != reference).flat_map(|f| &f.pads).filter(|p| !p.net.is_empty()) {
        ends.entry(&pad.net).or_default().push(pad.position.mm());
    }
    ends
}

pub fn read_pins(board: &Board, map: &PinMap, reference: &str) -> crate::Result<PinProblem> {
    let fp = footprint(board, reference)?;
    let pads: HashMap<&str, &Pad> = fp.pads.iter().map(|p| (p.number.as_str(), p)).collect();
    let others = other_ends(board, reference);
    let mut out = PinProblem::default();
    for pin in &map.pins {
        let number = pin.number.to_string();
        let pad = pads.get(number.as_str()).ok_or_else(|| format!("{reference} pin {number} not on the board"))?;
        let net = pad.net.as_str();
        let free = net.is_empty() || net.starts_with("unconnected-");
        if (pin.net == "NC") != free || (!free && short(net) != pin.net) {
            return Err(format!("{reference} pin {number} ({}): pin map net {}, board net {net}", pin.name, pin.net).into());
        }
        let (x, y) = pad.position.mm();
        let slot = Slot { name: pin.name.clone(), pin_type: pin.pin_type.clone().unwrap_or_default(), note: pin.note.clone().unwrap_or_default(), x, y };
        let ends = others.get(net).map_or(&[][..], Vec::as_slice);
        match kind_of(pin) {
            Some(Role::Free) => {
                out.slots.insert(pin.number.clone(), slot);
            }
            Some(Role::Swappable(kind)) if !ends.is_empty() => {
                let ft = slot.pin_type.starts_with("FT");
                out.slots.insert(pin.number.clone(), slot);
                out.nets.insert(net.to_string(), SwapNet { pin: pin.number.clone(), kind, ft, ends: ends.to_vec() });
            }
            _ if !free && !ends.is_empty() && !is_power(net) => out.fixed.push(rat_line((x, y), ends)),
            _ => {}
        }
    }
    Ok(out)
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Applied {
    pub changed_pads: usize,
    pub removed_tracks: usize,
}

/// Every id of the copper clusters with an end on one of `pads`.
fn copper_on_pads(board: &Board, pads: &[&Pad]) -> HashSet<String> {
    let mut by_net: HashMap<&str, Vec<&Pad>> = HashMap::new();
    for pad in pads.iter().filter(|p| !p.net.is_empty()) {
        by_net.entry(&pad.net).or_default().push(pad);
    }
    let clusters = Clusters::new(board.copper.iter().collect());
    let hit = clusters.on_pads(&by_net);
    let on_hit = |k: &usize| hit.contains(&clusters.find(*k));
    (0..clusters.items.len()).filter(on_hit).map(|k| clusters.items[k].id().to_string()).collect()
}

/// `text` with the pad nets of `diff` on the footprint `reference`. A pin the diff leaves without a net has none. All pads of a
/// number change together: they are one pin. A pad is found by footprint and number, as pads may share a uuid.
pub fn apply_swap(text: &str, board: &Board, diff: &[Change], reference: &str) -> crate::Result<(String, Applied)> {
    let fp = footprint(board, reference)?;
    let changed: BTreeSet<String> = diff.iter().flat_map(|d| [d.from_pin.to_string(), d.to_pin.to_string()]).collect();
    if let Some(n) = changed.iter().find(|n| !fp.pads.iter().any(|p| p.number == **n)) {
        return Err(format!("{reference} pin {n} not on the board").into());
    }
    let pads: Vec<&Pad> = fp.pads.iter().filter(|p| changed.contains(&p.number)).collect();
    let removed = copper_on_pads(board, &pads);
    let kept = Edit { removed: removed.clone(), ..Edit::default() }.apply(text, "placer-pinswap")?;
    let root = parse_first(&kept)?;
    let items = items_by_uuid(&root);
    let item = items.get(fp.id.as_str()).ok_or_else(|| format!("no footprint {reference} in the board text"))?;
    let new_net: BTreeMap<String, &str> = diff.iter().map(|d| (d.to_pin.to_string(), d.net.as_str())).collect();
    let mut changes = Changes::default();
    for pad in item.children("pad") {
        if let Some(number) = pad.text(1).filter(|n| changed.contains(*n)) {
            set_pad_net(pad, new_net.get(number).copied(), &mut changes);
        }
    }
    Ok((changes.apply(&kept), Applied { changed_pads: changed.len(), removed_tracks: removed.len() }))
}
