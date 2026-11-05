//! The driver of a net and its edge: the values of tools/test_net_drivers.py and the driver half of tools/test_ibis_screening.py.
//! A real-table test reads tools/driver-edges.json without its evidence files.
use super::estimate::edge_bound_ns;
use super::netlist::{Netlist, Node, export_netlist, parse_netlist};
use super::table::{Part, Table, read_part, verify_evidence};
use super::*;
use crate::sha256::sha256;
use crate::si::fixture::{near, netlist, part, real_table, real_table_with, real_text, scratch, spec, spec_error, table_of};
use crate::si::ibis::{self, Load, vi_edges};
use crate::si::json::Json;
use crate::si::planes::sample::{NetResult, Run, Terminal};
use crate::si::planes::screen::{Domains, Edges, reference_assessment};
use crate::si::planes::spec::{Spec, load_edge_rates};
use std::fs;
use std::path::{Path, PathBuf};

const NETLIST: &str = r#"(export (version "E")
  (components
    (comp (ref "U1") (value "STM32H743VIT6") (fields (field (name "MPN") "STM32H743VIT6")))
    (comp (ref "U2") (value "LTV-217-B-G") (fields (field (name "MPN") "LTV-217-B-G")))
    (comp (ref "U3") (value "ESP32-S3-WROOM-1-N8") (fields (field (name "MPN") "ESP32-S3-WROOM-1-N8")))
    (comp (ref "U4") (value "XYZ123") (fields (field (name "MPN") "XYZ123")))
    (comp (ref "U5") (value "ODX") (fields (field (name "MPN") "ODX-1")))
    (comp (ref "U6") (value "CA-IS2062W") (fields (field (name "MPN") "CA-IS2062W")))
    (comp (ref "R1") (value "10k"))
    (comp (ref "R2") (value "10k"))
    (comp (ref "J1") (value "conn"))
    (comp (ref "U7") (value "ODX") (fields (field (name "MPN") "ODX-2")))
    (comp (ref "R3") (value "4.7k")))
  (nets
    (net (code "1") (name "/ALMn")
      (node (ref "U2") (pin "4") (pinfunction "COL_4") (pintype "unspecified"))
      (node (ref "U1") (pin "40") (pinfunction "PE10_40") (pintype "unspecified"))
      (node (ref "R1") (pin "2") (pinfunction "2_2") (pintype "passive")))
    (net (code "2") (name "+3V3")
      (node (ref "R1") (pin "1") (pinfunction "1_1") (pintype "passive"))
      (node (ref "R3") (pin "1") (pinfunction "1_1") (pintype "passive")))
    (net (code "8") (name "/OD2")
      (node (ref "U7") (pin "3") (pinfunction "FLT_3") (pintype "unspecified"))
      (node (ref "R3") (pin "2") (pinfunction "2_2") (pintype "passive")))
    (net (code "3") (name "/FLTn")
      (node (ref "U5") (pin "3") (pinfunction "FLT_3") (pintype "unspecified"))
      (node (ref "R2") (pin "2") (pinfunction "2_2") (pintype "passive")))
    (net (code "4") (name "/CS")
      (node (ref "U3") (pin "22") (pinfunction "IO14_22") (pintype "unspecified")))
    (net (code "5") (name "/ODD") (node (ref "U4") (pin "1") (pinfunction "OUT_1") (pintype "unspecified")))
    (net (code "6") (name "/CAN_RXD")
      (node (ref "U6") (pin "5") (pinfunction "RXD_5") (pintype "unspecified"))
      (node (ref "R2") (pin "1") (pinfunction "1_1") (pintype "passive")))
    (net (code "7") (name "/FIELD_IN") (node (ref "J1") (pin "1") (pinfunction "1_1") (pintype "passive")))))
"#;

const OD_PART: &str = r#"{"mpn": ["ODX*"], "pins": [{"match": "FLT", "role": "open_drain", "tf_ns": 8, "source": "test table"}]}"#;

fn od_part() -> Part {
    part("ODX", OD_PART, &[])
}

fn base(extra: &[(&str, &str)]) -> Spec {
    let mut rows = vec![("grounds", r#"["GND"]"#)];
    rows.extend_from_slice(extra);
    spec(&rows)
}

const ALM_RECEIVER: (&str, &str) = ("receivers", r#"{"/ALMn": {"refs": ["U1"], "reason": "pin map: PE10 GPIO in"}}"#);

fn nl() -> Netlist {
    parse_netlist(NETLIST).unwrap()
}

/// The edge of a net by the spec, as the proposed screen looks it up.
fn lookup_edge(net: &str, s: &Spec, netlist: &Netlist, table: &Table) -> Edge {
    let (power, geom) = (s.power_patterns(), Geometry::default());
    net_edge(net, &Lookup { netlist, table, receivers: &s.receivers, offboard: &s.offboard, rates: &s.rates, power: &power, geom: &geom }, s.edge_class(net))
}

#[track_caller]
fn known(edge: &Edge) -> (f64, &str) {
    match edge {
        Edge::Known { edge_ns, driver } => (*edge_ns, driver),
        Edge::Unknown(why) => panic!("unknown: {why}"),
    }
}

#[track_caller]
fn unknown(edge: &Edge) -> &str {
    match edge {
        Edge::Unknown(why) => why,
        Edge::Known { edge_ns, driver } => panic!("known: {edge_ns} {driver}"),
    }
}

/// The screen lines of one run with a fake detour: `detour` mm, none over budget.
fn fails(net: &str, s: &Spec, edge: &Edge, detour: Option<f64>) -> Vec<String> {
    let run = Run { length: 1.0, terminals: vec![Terminal { x: 0.0, y: 0.0, snap: 0.1 }, Terminal { x: 1.0, y: 0.0, snap: 0.1 }], ..Run::default() };
    let r = NetResult { length: 10.0, unref: 1.0, bad: 1.0, worst: 1.0, worst_at: Some((0.0, 0.0)), runs: vec![run], ..NetResult::default() };
    let results = vec![(("B.Cu".to_string(), net.to_string()), r)];
    let domains = Domains::from([(net.to_string(), Some("GND".to_string()))]);
    let edges = Edges::from([(net.to_string(), edge.clone())]);
    let mut fake = |_: &str, _: &str, _: &Run, budget: f64| detour.filter(|d| *d <= budget);
    reference_assessment(&results, &domains, s, &edges, &mut fake, 300.0).unwrap().screen
}

// The netlist and the table

#[test]
fn parsing_strips_the_pin_number_from_the_pin_name() {
    let n = nl();
    assert!(n.net("/ALMn").unwrap().contains(&Node { part: "U2".to_string(), pin: "4".to_string(), name: "COL".to_string() }));
    assert_eq!(n.comps["U2"], "LTV-217-B-G");
}

#[test]
fn the_table_loads_and_has_no_default() {
    let table = real_table();
    assert!(table.parts.iter().any(|p| p.key == "LTV-217"));
    assert!(!table.parts.iter().any(|p| p.key == "default"));
}

#[test]
fn a_missing_schematic_never_looks_like_success() {
    assert!(export_netlist(Path::new("/no/such/missing.kicad_sch")).unwrap_err().contains("no schematic"));
}

// Drivers

#[test]
fn an_optocoupler_net_uses_the_datasheet_time() {
    let s = base(&[ALM_RECEIVER]);
    let e = lookup_edge("/ALMn", &s, &nl(), &real_table());
    let (ns, driver) = known(&e);
    assert_eq!(ns, 2000.0); // LTV-217 tr typ 2 us (tf 3 us), not 1 ns
    assert!(driver.contains("LTV-217"));
    assert_eq!(fails("/ALMn", &s, &e, Some(50.0)), [""; 0]); // 50 mm detour: inside 13 m (board rule off)
}

#[test]
fn an_mcu_pin_counts_as_a_driver_unless_it_is_a_receiver() {
    assert_eq!(known(&lookup_edge("/ALMn", &base(&[]), &nl(), &real_table())).0, 1.5); // STM32H743 GPIO is faster than the opto
}

#[test]
fn an_open_drain_net_uses_the_fall_time() {
    let s = base(&[ALM_RECEIVER]);
    let e = lookup_edge("/OD2", &s, &nl(), &table_of(vec![od_part()])); // open drain with a 4.7k pull-up: the RC rise is slow, the fall is 8 ns
    let (ns, driver) = known(&e);
    assert_eq!(ns, 8.0);
    assert!(driver.contains("open drain, tf 8 ns"));
    assert_eq!(fails("/OD2", &s, &e, Some(50.0)), [""; 0]); // 8 ns -> 53.3 mm
    assert_eq!(fails("/OD2", &s, &e, Some(60.0)).len(), 1);
}

#[test]
fn an_open_drain_rule_needs_the_fall_time() {
    let bad = Json::parse(r#"{"mpn": ["X"], "pins": [{"match": "A", "role": "open_drain", "tr_ns": 300, "source": "s"}]}"#).unwrap();
    assert!(read_part("table", "X", &bad, &[]).unwrap_err().contains("open_drain needs tf_ns"));
}

#[test]
fn an_esp32_gpio_net_needs_its_routed_length() {
    let s = base(&[ALM_RECEIVER]);
    let e = lookup_edge("/CS", &s, &nl(), &real_table());
    assert!(unknown(&e).contains("routed length")); // D124b conditional estimate needs actual geometry
    let f = fails("/CS", &s, &e, Some(2.0));
    assert_eq!(f.len(), 1);
    assert!(f[0].contains("unknown driver") && f[0].contains("routed length"));
}

#[test]
fn an_unknown_driver_is_flagged_not_1_ns() {
    let s = base(&[ALM_RECEIVER]);
    let f = fails("/ODD", &s, &lookup_edge("/ODD", &s, &nl(), &real_table()), Some(2.0));
    assert_eq!(f.len(), 1);
    assert!(f[0].starts_with("FAIL unknown-driver B.Cu /ODD"), "{}", f[0]);
    assert!(f[0].contains("XYZ123: no entry"));
    assert!(!f[0].contains("1 ns"));
}

#[test]
fn a_series_resistor_passes_the_driver_edge() {
    let s = base(&[ALM_RECEIVER]);
    assert!(matches!(lookup_edge("/FLTn", &s, &nl(), &real_table()), Edge::Unknown(_))); // U5 is not in the real table
    let e = lookup_edge("/FLTn", &s, &nl(), &real_table_with(vec![od_part()])); // R2 leads to /CAN_RXD (CA-IS2062W RXD 2.5 ns)
    let (ns, driver) = known(&e);
    assert_eq!(ns, 2.5);
    assert!(driver.contains("through R2"));
}

#[test]
fn a_pull_up_to_a_rail_is_not_followed() {
    let e = lookup_edge("/ALMn", &base(&[ALM_RECEIVER]), &nl(), &real_table());
    assert!(!known(&e).1.contains("+3V3"));
}

#[test]
fn an_offboard_net_needs_an_interface_class() {
    let (n, table) = (nl(), real_table());
    assert!(unknown(&lookup_edge("/FIELD_IN", &base(&[ALM_RECEIVER]), &n, &table)).contains("off-board via J1.1"));
    let bare = base(&[("offboard", r#"{"/FIELD_IN": {"class": "rs485", "reason": "RS-485 bus from the drive"}}"#)]);
    assert!(unknown(&lookup_edge("/FIELD_IN", &bare, &n, &table)).contains("MPN/pin"));
    let named = base(&[("offboard", r#"{"/FIELD_IN": {"class": "rs485", "reason": "RS-485 bus from the drive", "driver_mpn": "THVD1410DR", "driver_pin": "A"}}"#)]);
    assert_eq!(known(&lookup_edge("/FIELD_IN", &named, &n, &table)).0, 460.0);
}

#[test]
fn an_sp3485_cannot_inherit_the_thvd1410_class() {
    let n = netlist(&[("U13", "SP3485EN-L/TR")], &[("/RS485_A", &[("U13", "6", "A")])]);
    let s = base(&[("edge_classes", r#"{"rs485": ["/RS485_A"]}"#)]);
    let e = lookup_edge("/RS485_A", &s, &n, &real_table());
    assert!(unknown(&e).contains("incompatible"));
    assert_eq!(crate::si::planes::screen::net_edge_of("/RS485_A", &s, &Edges::from([("/RS485_A".to_string(), e.clone())])).0, None);
    assert_eq!(fails("/RS485_A", &s, &e, Some(2.0)).len(), 1);
}

#[test]
fn an_unknown_driver_cannot_be_masked_by_an_interface_class() {
    let s = base(&[("edge_classes", r#"{"rs485": ["/ODD"]}"#)]);
    let e = lookup_edge("/ODD", &s, &nl(), &real_table());
    assert!(unknown(&e).contains("XYZ123"));
    assert_eq!(crate::si::planes::screen::net_edge_of("/ODD", &s, &Edges::from([("/ODD".to_string(), e.clone())])).0, None);
}

#[test]
fn the_thvd1410_bus_pin_is_compatible_but_the_logic_pin_is_not() {
    let s = base(&[("edge_classes", r#"{"rs485": ["/A"]}"#)]);
    let table = real_table();
    assert_eq!(known(&lookup_edge("/A", &s, &netlist(&[("U1", "THVD1410DR")], &[("/A", &[("U1", "6", "A")])]), &table)).0, 460.0);
    assert!(matches!(lookup_edge("/A", &s, &netlist(&[("U1", "THVD1410DR")], &[("/A", &[("U1", "6", "R")])]), &table), Edge::Unknown(_)));
}

#[test]
fn an_offboard_driver_part_must_match() {
    let s = base(&[("offboard", r#"{"/FIELD_IN": {"class": "rs485", "reason": "field bus", "driver_mpn": "SP3485EN-L/TR", "driver_pin": "A"}}"#)]);
    assert!(unknown(&lookup_edge("/FIELD_IN", &s, &nl(), &real_table())).contains("incompatible"));
}

#[test]
fn another_incompatible_driver_on_the_net_cannot_be_hidden() {
    let n = netlist(&[("U1", "THVD1410DR"), ("U2", "SP3485EN-L/TR")], &[("/A", &[("U1", "6", "A"), ("U2", "6", "A")])]);
    assert!(unknown(&lookup_edge("/A", &base(&[("edge_classes", r#"{"rs485": ["/A"]}"#)]), &n, &real_table())).contains("incompatible"));
}

#[test]
fn a_protocol_class_keeps_its_contract_with_no_gpio_fallback() {
    let e = lookup_edge("/CS", &base(&[("edge_classes", r#"{"i2c": ["/CS"]}"#)]), &nl(), &real_table());
    let (ns, driver) = known(&e);
    assert_eq!(ns, 12.0);
    assert!(driver.contains("protocol i2c"));
}

// Fail closed

#[test]
fn nonfinite_or_boolean_driver_timing_is_rejected() {
    for value in ["1e999", "-1e999", "true", "false", "0", "-1"] {
        let text = format!(r#"{{"mpn": ["TEST"], "pins": [{{"match": "OUT", "role": "push_pull", "tr_ns": {value}, "tf_ns": 1, "source": "fixture"}}]}}"#);
        assert!(read_part("table", "test", &Json::parse(&text).unwrap(), &[]).unwrap_err().contains("needs tr_ns and tf_ns"), "{value}");
    }
}

#[test]
fn a_reviewed_minimum_needs_its_primary_evidence_declared() {
    let raw = Json::parse(&real_text("driver-edges.json")).unwrap();
    let parts = raw.get("parts").and_then(Json::as_obj).unwrap();
    let evidence = raw.get("evidence_files").and_then(Json::as_arr).unwrap();
    let without: Vec<Json> = evidence.iter().filter(|e| !e.get("path").and_then(Json::as_str).unwrap().contains("LAN8742A")).cloned().collect();
    assert_eq!(without.len(), evidence.len() - 1);
    let errors: Vec<String> = parts.iter().filter_map(|(key, p)| read_part("t", key, p, &without).err()).collect();
    assert_eq!(errors.len(), 1, "{errors:?}");
    assert!(errors[0].ends_with("reviewed minimum primary evidence declaration missing/changed"), "{}", errors[0]);
    assert!(parts.iter().all(|(key, p)| read_part("t", key, p, evidence).is_ok()));
}

#[test]
fn changed_or_missing_evidence_is_rejected() {
    let folder = scratch("evidence");
    let tools = folder.join("tools");
    let dir = folder.join("hardware-design/registry/datasheets");
    fs::create_dir_all(&dir).unwrap();
    fs::create_dir_all(&tools).unwrap();
    fs::write(dir.join("a.pdf"), "bytes").unwrap();
    let raw = |path: &str, sha: &str| Json::parse(&format!(r#"{{"evidence_files": [{{"path": "hardware-design/registry/datasheets/{path}", "sha256": "{sha}"}}]}}"#)).unwrap();
    verify_evidence(&raw("a.pdf", &sha256(b"bytes")), &tools).unwrap();
    assert!(verify_evidence(&raw("a.pdf", &"0".repeat(64)), &tools).unwrap_err().contains("missing or changed"));
    assert!(verify_evidence(&raw("SP3485EN-L-TR_C8963.pdf", &"0".repeat(64)), &tools).unwrap_err().contains("missing or changed"));
    assert!(verify_evidence(&raw("../escape", &"0".repeat(64)), &tools).unwrap_err().contains("invalid driver evidence path"));
}

#[test]
fn the_spec_checks_receivers_and_offboard() {
    assert!(spec_error(&[("receivers", r#"{"/A": {"refs": ["U1"]}}"#)]).contains("a written reason"));
    assert!(spec_error(&[("offboard", r#"{"/A": {"class": "gpio", "reason": "x"}}"#)]).contains("\"class\" must be a class"));
}

#[test]
fn there_is_no_gpio_default_class() {
    assert_eq!(load_edge_rates(crate::si::fixture::tools()).unwrap().get("gpio"), None);
    assert_eq!(base(&[]).edge_class("/EN"), None);
}

// D-124c: a load on an IBIS driver, by hand calculation

const GATE: &str = "[Component] GATE
[Pin] signal_name model_name
4 Y OUT
5 VCC POWER
[Model Selector] OUT
OUT_33 gate
[Model] OUT_33
Model_type Output
C_comp 7.52pF 3.81pF 9.89pF
[Voltage Range] 3.3 3.0 3.6
[Pullup Reference] 3.3 3.0 3.6
[Pulldown]
-1 -50mA -40mA -60mA
0 0 0 0
3.6 36mA 18mA 72mA
[Pullup]
0 0 0 0
3.6 -18mA -9mA -36mA
[Ramp]
dV/dt_r 3.3/0.1n 3.3/0.1n 3.3/0.1n
dV/dt_f 3.3/0.1n 3.3/0.1n 3.3/0.1n
[End]
";

const OUT_RULE: &str = r#"{"match": "Y", "role": "push_pull", "ibis_model": "OUT", "source": "fixture V-I"}"#;

/// Writes an IBIS file; the GATE part reads it through `rule` and the 3.3 V variant, or `variants`.
fn gate_part_with(name: &str, text: &str, rule: &str, variants: &str) -> (Part, PathBuf) {
    let file = scratch(name).join("fixture.ibs");
    fs::write(&file, text).unwrap();
    let sha = sha256(text.as_bytes());
    let path = file.display();
    let body = format!(r#"{{"mpn": ["GATE"], "ibis": {{"file": "{path}", "sha256": "{sha}", "component": "GATE", "supply_pin": "VCC", "variants": {variants}, "url": "fixture", "downloaded": "2026-10-10"}}, "pins": [{rule}, {{"match": "A|VCC", "role": "input"}}]}}"#);
    let evidence = Json::parse(&format!(r#"{{"path": "{path}", "sha256": "{sha}"}}"#)).unwrap();
    (part("gate", &body, &[evidence]), file)
}

fn gate_part(name: &str, text: &str, rule: &str) -> Part {
    gate_part_with(name, text, rule, r#"{"3.3": "_33"}"#).0
}

fn gate_netlist() -> Netlist {
    netlist(&[("U1", "GATE")], &[("/Y", &[("U1", "4", "Y")]), ("VDD_3V3", &[("U1", "5", "VCC")])])
}

fn geom(net: &str, length: f64, text: &str) -> Geometry {
    Geometry { length_mm: [(net.to_string(), length)].into(), pf_per_mm: [(net.to_string(), (0.1, text.to_string()))].into() }
}

fn load_edge(net: &str, n: &Netlist, table: &Table, geom: &Geometry) -> Edge {
    let rates = crate::si::planes::spec::EdgeRates::default();
    net_edge(net, &Lookup { netlist: n, table, receivers: &[], offboard: &[], rates: &rates, power: &[], geom }, None)
}

fn gate_edge(name: &str, text: &str) -> Edge {
    load_edge("/Y", &gate_netlist(), &table_of(vec![gate_part(name, text, OUT_RULE)]), &geom("/Y", 10.0, "test 0.1 pF/mm"))
}

#[test]
fn an_actual_load_uses_v_i_and_not_the_fixture_ramp() {
    let e = gate_edge("load-10", GATE);
    let (ns, driver) = known(&e);
    near(ns, 0.3848);
    assert!(driver.contains("V-I conditional estimate"));
    assert!(driver.contains("1 pF trace"));
    assert!(driver.contains("3.81 pF C_comp min"));
    near(known(&load_edge("/Y", &gate_netlist(), &table_of(vec![gate_part("load-20", GATE, OUT_RULE)]), &geom("/Y", 20.0, "test 0.1 pF/mm"))).0, 0.4648);
}

#[test]
fn the_edge_is_the_larger_of_ramp_and_c_dv_over_i_when_the_ramp_wins() {
    // D-124e. [Ramp] 3.3 V / 1 ns into R_fixture: fastest corner = min supply 3.0 V: 10-90 % = 0.8 * 3.0 / 3.3e9 = 0.72727 ns >
    // C*dV/I fall 0.3848 ns (rise 0.7696 ns).
    let text = GATE.replace("3.3/0.1n", "3.3/1n");
    near(known(&gate_edge("ramp-wins", &text)).0, 0.8 * 3.0 / 3.3);
    let model = ibis::parse(&text).unwrap().models["out_33"].clone();
    let (tr, tf) = vi_edges(&model, &Load { c_f: 4.81e-12, ..Load::default() }).unwrap();
    near(tf, 0.8 * 3.0 / 3.3);
    near(tr.unwrap(), 0.7696); // rise: C*dV/I 0.7696 ns > ramp 0.7273 ns
}

#[test]
fn the_edge_is_the_larger_of_ramp_and_c_dv_over_i_when_c_dv_wins() {
    // D-124e. Ramp 3.3 V / 0.1 ns -> 0.0727 ns < C*dV/I 0.3848 ns (fall) and 0.7696 ns (rise): the V-I time stays.
    near(known(&gate_edge("cdv-wins", GATE)).0, 0.3848);
}

#[test]
fn an_edge_with_no_ramp_is_unknown() {
    assert!(unknown(&gate_edge("no-ramp", &GATE.replace("[Ramp]", "[Ramp Removed]"))).contains("ramp"));
}

#[test]
fn receiver_capacitance_and_missing_loads_are_attributed() {
    let n = netlist(&[("U1", "GATE"), ("U2", "RECEIVER"), ("U3", "MISSING")], &[("/Y", &[("U1", "4", "Y"), ("U2", "1", "IN"), ("U3", "1", "IN")]), ("VDD_3V3", &[("U1", "5", "VCC")])]);
    let table = table_of(vec![
        gate_part("receivers", GATE, OUT_RULE),
        part("receiver", r#"{"mpn": ["RECEIVER"], "pin_c": {"pf": 2, "source": "receiver fixture"}, "pins": [{"match": "IN", "role": "input"}]}"#, &[]),
        part("missing", r#"{"mpn": ["MISSING"], "pins": [{"match": "IN", "role": "input"}]}"#, &[]),
    ]);
    let e = load_edge("/Y", &n, &table, &geom("/Y", 10.0, "test 0.1 pF/mm"));
    let (ns, driver) = known(&e);
    near(ns, 0.5448);
    assert!(driver.contains("2 pF sourced loads"));
    assert!(driver.contains("loads without source omitted: U3.IN"));
}

#[test]
fn missing_geometry_is_unknown() {
    let e = load_edge("/Y", &gate_netlist(), &table_of(vec![gate_part("no-geometry", GATE, OUT_RULE)]), &Geometry::default());
    assert!(unknown(&e).contains("routed length"));
}

#[test]
fn a_missing_v_i_never_uses_the_ramp_or_a_datasheet_fallback() {
    let rule = r#"{"match": "Y", "role": "push_pull", "ibis_model": "OUT", "source": "fixture V-I", "tr_ns": 1, "tf_ns": 1}"#;
    let table = table_of(vec![gate_part("no-vi", &GATE.replace("[Pulldown]", "[GND Clamp]"), rule)]);
    assert!(unknown(&load_edge("/Y", &gate_netlist(), &table, &geom("/Y", 10.0, "test"))).contains("no pulldown"));
}

#[test]
fn a_missing_supply_variant_does_not_hide_a_bad_possible_model() {
    let (p, _) = gate_part_with("no-rail", GATE, OUT_RULE, r#"{"3.3": "_33", "5": "_MISSING"}"#);
    let n = netlist(&[("U1", "GATE")], &[("/Y", &[("U1", "4", "Y")])]);
    assert!(unknown(&load_edge("/Y", &n, &table_of(vec![p]), &geom("/Y", 10.0, "test"))).contains("not in"));
}

fn series_netlist() -> Netlist {
    let mut n = netlist(&[("U1", "GATE"), ("R1", "10k")], &[("/Y", &[("U1", "4", "Y"), ("R1", "1", "1")]), ("/POST", &[("R1", "2", "2")]), ("VDD_3V3", &[("U1", "5", "VCC")])]);
    n.values.insert("R1".to_string(), "10k".to_string());
    n
}

#[test]
fn a_series_load_and_its_limit_are_explicit() {
    let e = load_edge("/POST", &series_netlist(), &table_of(vec![gate_part("series", GATE, OUT_RULE)]), &geom("/POST", 10.0, "fixture"));
    let (ns, driver) = known(&e);
    assert!(ns > 5.0, "{ns}");
    assert!(driver.contains("0 pF C_comp min")); // the driver capacitance is left out behind a series part
    assert!(driver.contains("through R1 from /Y"));
}

// The conditional screen of a driver

const FIX: &str = "[IBIS Ver] 4.1
[Component] GATE
[Pin] signal_name model_name
1 A IN
4 Y OUT
5 VCC POWER
[Model Selector] OUT
OUT_33 output3V3
[Model] IN_33
Model_type Input
C_comp 3pF 2pF 4pF
[Model] OUT_33
Model_type Output
C_comp 3pF NA 4pF
[Voltage Range] 3.3 3 3.6
[Temperature Range] 25 125 -40
[Ramp]
dV/dt_r 1/10n 1/1n 1/5n
dV/dt_f 1/10n NA 1/5n
[End]
";

fn driver_fixture() -> String {
    FIX.replace("C_comp 3pF NA 4pF", "C_comp 3pF 2pF 4pF")
        .replace("[Ramp]", "[Pulldown]\n0 0 0 0\n3.6 36mA 18mA 72mA\n[Pullup]\n0 0 0 0\n3.6 -18mA -9mA -36mA\n[Ramp]")
        .replace("1/10n", "3.3/0.1n")
        .replace("1/1n", "3.3/0.1n")
        .replace("1/5n", "3.3/0.1n")
}

fn screen(name: &str, rule: &str, n: &Netlist, net: &str, g: &Geometry) -> Edge {
    load_edge(net, n, &table_of(vec![gate_part(name, &driver_fixture(), rule)]), g)
}

const BOUND_RULE: &str = r#"{"match": "Y", "role": "push_pull", "source": "vendor model", "bound": {"i_ma": 20, "i_source": "approx drive", "vdd_v": 3.3, "cpin_pf": 2, "cpin_source": "typ capacitance"}}"#;
const PLAIN_BOUND: &str = r#"{"match": "Y", "role": "push_pull", "source": "vendor model", "bound": {"i_ma": 20, "i_source": "approx", "vdd_v": 3.3}}"#;

#[test]
fn an_actual_model_screen_is_an_estimate() {
    let e = screen("actual-model", OUT_RULE, &gate_netlist(), "/Y", &geom("/Y", 10.0, "fixture microstrip"));
    let (ns, driver) = known(&e);
    near(ns, 0.24);
    assert!(driver.contains("IBIS V-I conditional estimate"));
    assert!(driver.contains("3 pF (1 pF trace, 0 pF sourced loads, 2 pF C_comp min)"));
}

#[test]
fn a_wrong_component_pin_or_selector_is_unknown() {
    let n = netlist(&[("U1", "GATE")], &[("/Y", &[("U1", "1", "Y")]), ("VDD_3V3", &[("U1", "5", "VCC")])]);
    assert!(unknown(&screen("wrong-pin", OUT_RULE, &n, "/Y", &geom("/Y", 10.0, "fixture"))).contains("selector mismatch"));
}

#[test]
fn a_wrong_role_or_a_tampered_source_is_unknown() {
    let drain = r#"{"match": "Y", "role": "open_drain", "ibis_model": "OUT", "source": "vendor model"}"#;
    let mut n = netlist(&[("U1", "GATE"), ("R1", "10k")], &[("/Y", &[("U1", "4", "Y"), ("R1", "1", "1")]), ("VDD_3V3", &[("U1", "5", "VCC"), ("R1", "2", "2")])]);
    n.values.insert("R1".to_string(), "10k".to_string());
    assert!(unknown(&screen("wrong-role", drain, &n, "/Y", &geom("/Y", 10.0, "fixture"))).contains("incompatible"));
    let (p, file) = gate_part_with("tampered", &driver_fixture(), OUT_RULE, r#"{"3.3": "_33"}"#);
    fs::write(file, format!("{FIX}\n| changed")).unwrap();
    assert!(unknown(&load_edge("/Y", &gate_netlist(), &table_of(vec![p]), &geom("/Y", 10.0, "fixture"))).contains("hash mismatch"));
}

#[test]
fn an_unknown_driver_is_not_masked_by_a_model() {
    let n = netlist(&[("U1", "GATE"), ("U2", "UNKNOWN")], &[("/Y", &[("U1", "4", "Y"), ("U2", "1", "OUT")]), ("VDD_3V3", &[("U1", "5", "VCC")])]);
    assert!(unknown(&screen("masked", OUT_RULE, &n, "/Y", &Geometry::default())).contains("no entry"));
}

#[test]
fn the_bound_formula_stays_conditional() {
    let n = gate_netlist();
    let e = screen("bound", BOUND_RULE, &n, "/Y", &geom("/Y", 10.0, "estimatedmicrostrip"));
    let (ns, driver) = known(&e);
    near(ns, 3.0 * 2.64 / 20.0);
    assert!(driver.contains("conditional estimate: C*dV/I"));
    assert!(driver.contains("[10.0 mm x 0.1000 pF/mm, estimatedmicrostrip]"));
    assert!(matches!(screen("bound-none", BOUND_RULE, &n, "/Y", &Geometry::default()), Edge::Unknown(_)));
    let length_only = Geometry { length_mm: [("/Y".to_string(), 10.0)].into(), ..Geometry::default() };
    assert!(matches!(screen("bound-length", BOUND_RULE, &n, "/Y", &length_only), Edge::Unknown(_)));
}

#[test]
fn the_formula_rejects_nonfinite_and_negative_input() {
    for (c, v, i) in [(f64::INFINITY, 3.3, 20.0), (1.0, -3.3, 20.0), (1.0, 3.3, 0.0)] {
        assert!(edge_bound_ns(c, v, i).is_err());
    }
}

#[test]
fn the_real_sp3485_bound_and_unknowns_are_kept() {
    let table = real_table();
    assert!(matches!(pin_edge("SP3485EN-L/TR", "RO", &table, None), PinEdge::Estimated(..)));
    assert!(matches!(pin_edge("TPS2116DRLR", "ST", &table, None), PinEdge::Unknown(_)));
}

#[test]
fn a_missing_minimum_capacitance_is_not_substituted() {
    let text = driver_fixture().replace("C_comp 3pF 2pF 4pF\n[Voltage", "C_comp 3pF NA 4pF\n[Voltage");
    let table = table_of(vec![gate_part("no-minimum", &text, OUT_RULE)]);
    assert!(unknown(&load_edge("/Y", &gate_netlist(), &table, &geom("/Y", 10.0, "fixture"))).contains("C_comp minimum unavailable"));
}

#[test]
fn invalid_geometry_is_unknown_and_no_screening_pass() {
    for (i, value) in [f64::INFINITY, f64::NAN, -1.0].into_iter().enumerate() {
        let g = Geometry { length_mm: [("/Y".to_string(), value)].into(), pf_per_mm: [("/Y".to_string(), (0.1, "screen".to_string()))].into() };
        assert!(matches!(screen(&format!("bad-geometry-{i}"), PLAIN_BOUND, &gate_netlist(), "/Y", &g), Edge::Unknown(_)), "{value}");
    }
}

#[test]
fn a_series_resistor_limits_a_bound_too() {
    near(known(&screen("series-bound", PLAIN_BOUND, &series_netlist(), "/POST", &geom("/POST", 10.0, "screen"))).0, 7.6);
}

#[test]
fn an_unknown_supply_keeps_all_variant_uncertainty() {
    let n = netlist(&[("U1", "GATE")], &[("/Y", &[("U1", "4", "Y")])]);
    assert!(known(&screen("all-variants", OUT_RULE, &n, "/Y", &geom("/Y", 10.0, "fixture"))).1.contains("rail not found"));
}

#[test]
fn a_sibling_output_is_not_checked_as_the_selected_pin() {
    let rule = r#"{"match": "Y|Z", "role": "push_pull", "ibis_model": "OUT", "source": "vendor model"}"#;
    let n = netlist(&[("U1", "GATE")], &[("/Y", &[("U1", "4", "Y")]), ("VDD_3V3", &[("U1", "5", "VCC")]), ("/Z", &[("U1", "1", "Z")])]); // the sibling's distinct model is irrelevant to Y
    near(known(&screen("sibling", rule, &n, "/Y", &geom("/Y", 10.0, "fixture"))).0, 0.24);
}

#[test]
#[ignore = "needs the evidence files: set IOT_TEST_RULES_ROOT to a folder with tools/ and hardware-design/"]
fn the_nine_original_files_and_their_models() {
    let root = PathBuf::from(std::env::var("IOT_TEST_RULES_ROOT").expect("IOT_TEST_RULES_ROOT"));
    let table = Table::load(&root.join("tools")).unwrap();
    let (mut files, mut models) = (0, 0);
    for p in &table.parts {
        let Some(ib) = &p.ibis else { continue };
        files += 1;
        models += table.with_ibis(ib, |parsed| {
            assert!(parsed.pins.contains_key(&ib.component), "{}", ib.file);
            Ok(parsed.models.len())
        }).unwrap();
        for rule in p.pins.iter().filter(|r| r.role != "input") {
            let Some(model) = &rule.ibis_model else { continue };
            for (volts, suffix) in &ib.variants {
                let read = table.ibis_model(ib, &format!("{model}{suffix}")).unwrap();
                let (_, tf) = vi_edges(&read, &Load { c_f: 1e-12, swing_v: Some(*volts), open_drain: rule.role == "open_drain", i_limit_a: None }).unwrap();
                assert!(tf > 0.0, "{model}{suffix}");
            }
        }
    }
    assert_eq!((files, models), (9, 92));
}
