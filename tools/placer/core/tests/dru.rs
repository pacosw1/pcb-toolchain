//! Reading the rules of a .kicad_dru file.

use iotplace::dru::Rules;

fn parse(text: &str) -> Rules {
    iotplace::dru::parse(text).unwrap()
}

const RELAY: &str = r#"(version 1)
# comment with (brackets) and 'quotes'
(rule "Mains to SELV and 24 V"
  (condition "A.NetClass == 'MAINS_K*' && B.NetClass != 'MAINS_K*'")
  (constraint clearance (min 8mm))
  (constraint creepage (min 7.5mm)))
(rule "Relay circuit to relay circuit"
  (condition "A.NetClass == 'MAINS_K*' && B.NetClass == 'MAINS_K*' && A.NetClass != B.NetClass")
  (constraint clearance (min 3mm))
  (constraint creepage (min 3mm)))
(rule "Mains to screw hole"
  (condition "A.NetClass == 'MAINS_K*' && B.Type == 'Pad' && B.Pad_Type == 'NPTH, mechanical' && (B.Reference == 'H1' || B.Reference == 'H2')")
  (constraint hole_clearance (min 9.65mm)))
(rule "Edge connector silk"
  (condition "A.memberOfFootprint('J1') && B.Layer == 'Edge.Cuts'")
  (constraint silk_clearance (min -10mm)))
(rule "Isolation barrier"
  (condition "(A.NetClass == 'FIELD' || A.NetClass == 'FIELD_PWR') && (B.NetClass == 'HOST' || B.NetClass == 'HOST_PWR')")
  (constraint clearance (min 4mm)))
"#;

fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn domain_class_gap_and_hole_rules_come_from_the_dru() {
    let r = parse(RELAY);
    assert_eq!(r.domains, vec![("MAINS_K*".to_string(), 8.0, 3.0)]); // the larger of clearance and creepage
    assert_eq!(r.holes, vec![("MAINS_K*".to_string(), strings(&["H1", "H2"]), 9.65)]);
}

#[test]
fn a_barrier_between_two_class_sets_is_a_pair_rule() {
    let r = parse(RELAY);
    assert_eq!(r.pairs, vec![(strings(&["FIELD", "FIELD_PWR"]), strings(&["HOST", "HOST_PWR"]), 4.0)]);
    assert!(r.ignored.is_empty()); // silk rules are no placement rules
}

#[test]
fn a_clearance_rule_the_model_cannot_read_is_listed_not_dropped() {
    let r = parse(r#"(rule "Odd" (condition "A.NetClass == 'X' || B.Layer == 'F.Cu'") (constraint clearance (min 1mm)))"#);
    assert_eq!(r.ignored, strings(&["Odd"]));
}

#[test]
fn a_domain_rule_with_a_pad_exception_is_read_and_the_pad_is_a_domain_member() {
    // BACKUP-POWER b2f9c3e: PS1 pad 3 has no net (parity), the dru makes it FIELD side by rule
    let r = parse(concat!(
        r#"(rule "FIELD to SELV" (condition "A.NetClass == 'FIELD' && B.NetClass != 'FIELD' && "#,
        r#"!(B.Type == 'Pad' && B.memberOfFootprint('PS1') && B.Pad_Number == '3')")"#,
        r#" (constraint clearance (min 4mm)) (constraint creepage (min 4mm)))"#,
    ));
    assert_eq!(r.domains, vec![("FIELD".to_string(), 4.0, 0.0)]);
    assert_eq!(r.members, vec![("FIELD".to_string(), "PS1".to_string(), "3".to_string())]);
    assert!(r.ignored.is_empty());
}

#[test]
fn a_creepage_rule_from_a_class_to_no_net_is_a_keepout_gap() {
    // BACKUP-POWER: a FIELD pad keeps 0.7 mm creepage to the no-net BARRIER rule areas
    let r = parse(r#"(rule "FIELD to no-net creepage" (condition "A.NetClass == 'FIELD' && B.NetName == ''") (constraint creepage (min 0.7mm)))"#);
    assert_eq!(r.nonet, vec![("FIELD".to_string(), 0.7)]);
    assert!(r.ignored.is_empty());
}

#[test]
fn a_dru_without_a_no_net_rule_has_no_keepout_gap() {
    assert!(parse(RELAY).nonet.is_empty());
}

#[test]
fn a_rule_without_a_pad_exception_has_no_members() {
    assert!(parse(RELAY).members.is_empty());
}

#[test]
fn a_domain_without_a_class_rule_keeps_the_net_clearance_between_its_classes() {
    let r = parse(r#"(rule "PoE" (condition "A.NetClass == 'POE' && B.NetClass != 'POE'") (constraint clearance (min 3mm)))"#);
    assert_eq!(r.domains, vec![("POE".to_string(), 3.0, 0.0)]);
}
