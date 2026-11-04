use std::path::PathBuf;

use super::*;

pub const PCB: &str = r#"(kicad_pcb (version 20260101)
 (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
 (footprint "R" (at 3 4) (property "Reference" "R1") (uuid "fp"))
 (segment (start 0 0) (end 2 0) (width .25) (layer "F.Cu") (net "A") (uuid "top"))
 (segment (start -1 -1) (end 0 0) (width .15) (layer "B.Cu") (net "A") (uuid "bottom"))
 (via (at 0 0) (size .6) (drill .3) (layers "F.Cu" "B.Cu") (net "A") (uuid "via")))"#;

fn project(name: &str, text: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pcbsearch-eco-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let board = dir.join("input.kicad_pcb");
    fs::write(&board, text).unwrap();
    for extension in ["kicad_pro", "kicad_dru", "kicad_sch"] {
        fs::write(board.with_extension(extension), "fixture").unwrap();
    }
    board
}

#[test]
fn uuid5_matches_the_rfc_example_for_the_url_namespace() {
    // uuid.uuid5(uuid.NAMESPACE_URL, 'https://example.com')
    assert_eq!(uuid5("https://example.com"), "4fd35a71-71ef-5a55-a9d9-aa75c889a6d0");
}

#[test]
fn via_moves_on_the_track_and_the_other_layer_keeps_its_connection() {
    let board = project("move", PCB);
    let before = source_set(&board).unwrap();
    let out = board.with_file_name("out");
    let record = shift_via(&board, "via", "top", &out, 0.5).unwrap();
    assert_eq!(record["destination_mm"], json!(["1.000000", "0.000000"]));
    let target = Board::read(&out.join("proposal.kicad_pcb")).unwrap();
    let bridge_id = record["added_bridge_id"].as_str().unwrap();
    let copper = Copper::read(&target).unwrap();
    let bridge = copper.get(bridge_id).unwrap();
    let text = target.source(bridge.form);
    for part in ["(start 0 0)", "(end 1.000000 0.000000)", "(layer \"B.Cu\")", "(width .15)"] {
        assert!(text.contains(part), "{part} in {text}");
    }
    assert_eq!(bridge.net, "A");
    assert_eq!(before, source_set(&board).unwrap());
    assert_eq!(record["qualified"], false);
    assert!(shift_via(&board, "via", "top", &out, 0.5).unwrap_err().0.contains("new separate"));
}

#[test]
fn locked_branch_and_wrong_layer_repairs_abstain() {
    let variants = [
        PCB.replace("(via (at", "(via (locked yes) (at"),
        PCB.replace("(via (at", "(via micro (at"),
        PCB.replace("(via (at", "(via blind (at"),
        PCB.replace("(uuid \"top\")", "(locked yes) (uuid \"top\")"),
        PCB.replace("(layer \"B.Cu\") (net \"A\")", "(layer \"F.Cu\") (net \"A\")"),
        format!("{}(segment (start 0 0) (end 0 2) (width .15) (layer \"B.Cu\") (net \"A\") (uuid \"branch\")))", &PCB[..PCB.len() - 1]),
        format!("{}(segment (start -1 0) (end 1 0) (width .15) (layer \"B.Cu\") (net \"A\") (uuid \"mid\")))", &PCB[..PCB.len() - 1]),
    ];
    for (index, text) in variants.iter().enumerate() {
        let board = project(&format!("abstain{index}"), text);
        let out = board.with_file_name("out");
        assert!(shift_via(&board, "via", "top", &out, 0.5).is_err(), "{text}");
        assert!(!out.exists());
    }
}

#[test]
fn fraction_and_subgrid_moves_cannot_break_the_original_anchor() {
    let board = project("fraction", PCB);
    let out = board.with_file_name("out");
    for fraction in [0.0, 1.0, -0.1, f64::NAN] {
        assert!(shift_via(&board, "via", "top", &out, fraction).is_err(), "{fraction}");
    }
    let board = project("subgrid", &PCB.replace("(end 2 0)", "(end 0.000001 0)"));
    let error = shift_via(&board, "via", "top", &board.with_file_name("out"), 0.1).unwrap_err();
    assert!(error.0.contains("precision"), "{error}");
}
