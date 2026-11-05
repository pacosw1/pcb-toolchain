//! Pin swap proposals: the rules of a pin and the search.

use iotplace::geom::Point;
use iotplace::pinswap::{Assign, Chip, Kind, Nets, Proposal, Slot, Slots, SwapNet, Weights, port_line, usable};

const W: Weights = Weights { crossing: 10.0, change: 0.0 };
const RESTARTS: usize = 5;

fn slot(name: &str, x: f64, y: f64, pin_type: &str, note: &str) -> Slot {
    Slot { name: name.into(), pin_type: pin_type.into(), note: note.into(), x, y }
}

fn plain(name: &str, x: f64) -> Slot {
    slot(name, x, 0.0, "FT_h", "")
}

fn slots(list: Vec<(&str, Slot)>) -> Slots {
    list.into_iter().map(|(k, s)| (k.to_string(), s)).collect()
}

fn net(kind: Kind, pin: &str, ft: bool, end: Point) -> SwapNet {
    SwapNet { pin: pin.into(), kind, ft, ends: vec![end] }
}

fn nets(list: Vec<(&str, SwapNet)>) -> Nets {
    list.into_iter().map(|(k, n)| (k.to_string(), n)).collect()
}

fn assign(list: &[(&str, &str)]) -> Assign {
    list.iter().map(|(n, p)| (n.to_string(), p.to_string())).collect()
}

fn search(n: &Nets, s: &Slots, seed: u64, w: Weights) -> Proposal {
    Chip { nets: n, slots: s, fixed: &[] }.search(seed, RESTARTS, w)
}

#[test]
fn the_port_line_is_the_pin_number_in_the_port() {
    assert_eq!(port_line("PE13"), Some(13));
    assert_eq!(port_line("PC14-OSC32_IN"), Some(14));
    assert_eq!(port_line("PH0-OSC_IN"), Some(0));
    assert_eq!(port_line("VDD"), None);
}

#[test]
fn a_usable_slot_excludes_analog_only_not_usable_and_reserved_pins() {
    assert!(usable(&slot("PA3", 0.0, 0.0, "FT_ha", "PA3: spare")));
    assert!(!usable(&slot("PC2_C", 0.0, 0.0, "ANA TT_a", "")));
    assert!(!usable(&slot("PB14", 0.0, 0.0, "FT_u", "not usable: REF_CLK")));
    assert!(!usable(&slot("PC7", 0.0, 0.0, "FT_h", "spare (reserved for 2nd axis option)")));
}

#[test]
fn allowed_keeps_exti_lines_unique_drive_and_5v_tolerance() {
    let s = slots(vec![
        ("1", plain("PE2", 0.0)),
        ("2", plain("PD2", 1.0)),
        ("3", slot("PC13", 2.0, 0.0, "FT", "")),
        ("4", slot("PE7", 3.0, 0.0, "TT_ha", "")),
        ("5", plain("PE4", 4.0)),
    ]);
    let n = nets(vec![
        ("A", net(Kind::Exti, "1", true, (0.0, 5.0))),
        ("B", net(Kind::Exti, "5", true, (4.0, 5.0))),
        ("O", net(Kind::Out, "2", true, (1.0, 5.0))),
        ("T", net(Kind::Plain, "4", false, (3.0, 5.0))),
    ]);
    let now = assign(&[("A", "1"), ("B", "5"), ("O", "2"), ("T", "4")]);
    let chip = Chip { nets: &n, slots: &s, fixed: &[] };
    // A to pin 2 (PD2): line 2 is A's own line, so it stays unique
    assert!(chip.allowed("A", "2", &now));
    // B to pin 1 (PE2) collides with A on line 2 while A stays there
    assert!(!chip.allowed("B", "1", &now));
    // an output never goes to the low-drive RTC pins
    assert!(!chip.allowed("O", "3", &now));
    // a 5 V tolerant net never goes to a TT pin; a TT net may go to an FT pin
    assert!(!chip.allowed("A", "4", &now));
    assert!(chip.allowed("T", "2", &now));
}

/// Two pins on the IC edge (y = 0), each net ends above the other pin: the rat lines cross.
fn crossed() -> (Nets, Slots) {
    let s = slots(vec![("1", plain("PD1", 0.0)), ("2", plain("PD2", 10.0))]);
    let n = nets(vec![("A", net(Kind::Plain, "1", true, (10.0, 10.0))), ("B", net(Kind::Plain, "2", true, (0.0, 10.0)))]);
    (n, s)
}

/// One net that gains 10 mm on the free pin 2.
fn one_net() -> (Nets, Slots) {
    let s = slots(vec![("1", plain("PD1", 0.0)), ("2", plain("PD2", 10.0))]);
    (nets(vec![("A", net(Kind::Plain, "1", true, (10.0, 10.0)))]), s)
}

#[test]
fn the_cost_counts_hpwl_and_crossings() {
    let (n, s) = crossed();
    let chip = Chip { nets: &n, slots: &s, fixed: &[] };
    let c = chip.measure(&assign(&[("A", "1"), ("B", "2")]), W);
    assert_eq!((c.crossings, c.hpwl), (1, 40.0));
    let c = chip.measure(&assign(&[("A", "2"), ("B", "1")]), W);
    assert_eq!((c.crossings, c.hpwl), (0, 20.0));
}

#[test]
fn the_search_swaps_crossed_pins_and_reports_the_diff() {
    let (n, s) = crossed();
    let r = search(&n, &s, 1, W);
    assert_eq!(r.assign, assign(&[("A", "2"), ("B", "1")]));
    assert_eq!(r.before.crossings, 1);
    assert_eq!(r.after.crossings, 0);
    let mut diff: Vec<_> = r.diff.iter().map(|d| (d.net.as_str(), d.from_name.as_str(), d.to_name.as_str())).collect();
    diff.sort();
    assert_eq!(diff, vec![("A", "PD1", "PD2"), ("B", "PD2", "PD1")]);
}

#[test]
fn the_search_moves_a_net_to_a_free_usable_pin() {
    let (n, s) = one_net();
    assert_eq!(search(&n, &s, 1, W).assign, assign(&[("A", "2")]));
}

#[test]
fn a_cost_per_changed_pin_keeps_small_gains_out_of_the_proposal() {
    let (n, s) = one_net();
    let with_change = |change: f64| Weights { crossing: 10.0, change };
    let chip = Chip { nets: &n, slots: &s, fixed: &[] };
    assert_eq!(chip.measure(&assign(&[("A", "2")]), with_change(4.0)).changes, 1);
    assert_eq!(search(&n, &s, 1, with_change(15.0)).assign, assign(&[("A", "1")])); // gain 10 mm < 15
    assert_eq!(search(&n, &s, 1, with_change(5.0)).assign, assign(&[("A", "2")]));
}

#[test]
fn the_search_never_breaks_a_rule_for_a_gain() {
    // B would gain on pin 1 (PE2), but line 2 belongs to A, and A has no other legal pin
    let s = slots(vec![("1", plain("PE2", 0.0)), ("2", plain("PD5", 10.0)), ("3", plain("PD2", 30.0))]);
    let n = nets(vec![("A", net(Kind::Exti, "1", true, (0.0, 5.0))), ("B", net(Kind::Exti, "2", true, (0.0, 10.0)))]);
    let a = search(&n, &s, 3, W).assign;
    assert_ne!(port_line(&s[&a["A"]].name), port_line(&s[&a["B"]].name));
    let chip = Chip { nets: &n, slots: &s, fixed: &[] };
    n.keys().for_each(|name| assert!(chip.allowed(name, &a[name], &a)));
}

#[test]
fn the_search_is_deterministic_for_a_seed() {
    let (n, s) = crossed();
    assert_eq!(search(&n, &s, 7, W), search(&n, &s, 7, W));
}
