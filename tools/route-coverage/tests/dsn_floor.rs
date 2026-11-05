use route_coverage::dsn::Rules;

fn rules() -> Rules {
    let text = r#"(pcb fixture (parser (string_quote ")) (resolution um 10) (unit um)
 (structure (layer F.Cu (type signal)) (layer B.Cu (type signal)) (rule (clearance 200)))
 (network (net /A (pins J1-1)) (net /B (pins J1-2))
  (class kicad_default /A /B (circuit (use_via V)) (rule (width 200) (clearance 150)))))"#;
    Rules::new(text).unwrap()
}

#[test]
fn the_unconnected_net_is_no_second_net() {
    let rules = rules();
    assert_eq!(rules.floor("/A", Some("")).unwrap(), rules.floor("/A", None).unwrap());
}

#[test]
fn a_net_with_no_class_stays_an_error() {
    let rules = rules();
    assert!(rules.floor("/A", Some("/MISSING")).is_err());
    assert!(rules.floor("/MISSING", None).is_err());
    assert!(rules.floor("", None).is_err());
}

#[test]
fn a_real_second_net_still_gets_the_floor() {
    assert!(rules().floor("/A", Some("/B")).is_ok());
}
