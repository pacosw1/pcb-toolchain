//! Taking tracks out of a board text: the keep patterns, the exact list, and what stays.

use iotplace::write::strip::{Strip, strip_text};
use iotroute::kicad::sexpr::parse;
use std::collections::HashSet;

const BOARD: &str = r#"(kicad_pcb
	(layers (0 "F.Cu" signal))
	(footprint "x" (layer "F.Cu") (uuid "fp") (pad "1" smd rect (layers "F.Cu") (net "/SIG") (uuid "p1")))
	(segment (start 0 0) (end 1 0) (width 0.2) (layer "F.Cu") (net "/SIG") (uuid "a"))
	(arc (start 1 0) (mid 2 1) (end 1 2) (width 0.2) (layer "F.Cu") (net "/SIG") (uuid "b"))
	(via (at 1 2) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "GND") (uuid "c"))
	(segment (start 5 0) (end 6 0) (width 0.2) (layer "F.Cu") (net "/PWR_A") (uuid "d"))
	(segment (start 7 0) (end 8 0) (width 0.2) (layer "F.Cu") (uuid "e"))
	(zone (net "GND") (layer "F.Cu") (uuid "z") (polygon (pts (xy 0 0) (xy 9 0) (xy 9 9))))
)
"#;

/// What is left of the board: its copper by uuid, and the zones.
fn left(text: &str) -> (Vec<String>, usize) {
    let forms = parse(text).unwrap();
    let copper = forms[0].items().iter().filter(|f| f.is("segment") || f.is("arc") || f.is("via"));
    (copper.map(|f| f.value("uuid").unwrap().to_string()).collect(), forms[0].children("zone").count())
}

fn keep(patterns: &[&str]) -> Strip {
    Strip::AllBut(patterns.iter().map(|p| p.to_string()).collect())
}

fn only(names: &[&str]) -> Strip {
    Strip::Only(names.iter().map(|n| n.to_string()).collect::<HashSet<_>>())
}

#[test]
fn strip_removes_tracks_except_kept_nets() {
    let (out, removed) = strip_text(BOARD, &keep(&["GND"])).unwrap();
    assert_eq!(removed, 4);
    assert_eq!(left(&out), (vec!["c".to_string()], 1));
}

#[test]
fn a_keep_pattern_is_a_shell_pattern() {
    let (out, removed) = strip_text(BOARD, &keep(&["/PWR_*", "G?D"])).unwrap();
    assert_eq!(removed, 3);
    assert_eq!(left(&out).0, ["c", "d"]);
}

#[test]
fn with_nothing_kept_all_copper_goes_and_zones_and_pads_stay() {
    let (out, removed) = strip_text(BOARD, &keep(&[])).unwrap();
    assert_eq!(removed, 5);
    assert_eq!(left(&out), (Vec::new(), 1));
    assert!(out.contains("(pad \"1\" smd rect (layers \"F.Cu\") (net \"/SIG\")"));
}

#[test]
fn strip_only_removes_the_tracks_of_the_listed_nets() {
    let (out, removed) = strip_text(BOARD, &only(&["/SIG", "GND"])).unwrap();
    assert_eq!(removed, 3);
    assert_eq!(left(&out), (vec!["d".to_string(), "e".to_string()], 1));
}

#[test]
fn an_only_name_is_exact() {
    assert_eq!(strip_text(BOARD, &only(&["/PWR_*"])).unwrap().1, 0);
}
