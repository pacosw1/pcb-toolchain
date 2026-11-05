//! The option parsers of `iotplace read`; the other cases are in src/read/options.rs.

use iotplace::read::options::{parse_edge, parse_near};

#[test]
fn an_edge_takes_an_inset_and_a_tolerance() {
    let e = parse_edge("J4=R:E:0.2:0.1").unwrap();
    assert_eq!((e.reference.as_str(), e.sides.as_str(), e.side, e.exact), ("J4", "R", 'E', Some((0.2, 0.1))));
    for bad in ["J2=B:S:x", "J2=B:S:-1", "J2=B:S:0:0:0", "J2=Q:S"] {
        assert!(parse_edge(bad).is_err(), "{bad}");
    }
}

#[test]
fn a_near_rule_names_two_pads_and_a_distance() {
    let n = parse_near("U2.A1=J1.3:5.5").unwrap();
    assert_eq!((n.part.as_str(), n.pad.as_str(), n.target.as_str(), n.target_pad.as_str(), n.distance), ("U2", "A1", "J1", "3", 5.5));
    for bad in ["D1.1=J1.1", "D1=J1.1:7", "D1.1=J1.1:x"] {
        assert!(parse_near(bad).is_err(), "{bad}");
    }
}
