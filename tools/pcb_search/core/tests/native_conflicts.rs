//! Native evidence and automatic local-repair selection counterexamples.

use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};

use pcbsearch::budget::Budget;
use pcbsearch::native::conflicts::{propose, select_repair};
use pcbsearch::native::digest::{file_sha256, source_set};
use serde_json::{Value, json};

const PCB: &str = r#"(kicad_pcb (version 20260101)
 (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
 (footprint "R" (at 3 4) (property "Reference" "R1") (uuid "fp"))
 (segment (start 0 0) (end 2 0) (width .25) (layer "F.Cu") (net "A") (uuid "top"))
 (segment (start -1 -1) (end 0 0) (width .15) (layer "B.Cu") (net "A") (uuid "bottom"))
 (via (at 0 0) (size .6) (drill .3) (layers "F.Cu" "B.Cu") (net "A") (uuid "via"))(footprint "U" (at -1 -1) (uuid "u")
          (property "Reference" "U1") (pad "1" smd rect (at 0 0) (net "B") (uuid "p"))))"#;
const FRACTIONS: [f64; 1] = [0.5];

struct Case {
    root: PathBuf,
    board: PathBuf,
    folder: PathBuf,
    drc: Value,
    record: Value,
}

impl Case {
    fn new(name: &str) -> Case {
        let root = std::env::temp_dir().join(format!("pcbsearch-conflicts-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let folder = root.join("native");
        fs::create_dir_all(&folder).unwrap();
        let board = root.join("input.kicad_pcb");
        fs::write(&board, PCB).unwrap();
        for extension in ["kicad_pro", "kicad_dru", "kicad_sch"] {
            fs::write(board.with_extension(extension), "fixture").unwrap();
        }
        let violations: Vec<Value> = ["clearance", "hole_clearance"].iter().map(|kind| {
            json!({"type": kind, "severity": "error", "items": [{"uuid": "via"}, {"uuid": "p"}]})
        }).collect();
        let drc = json!({"source": "input.kicad_pcb", "coordinate_units": "mm", "included_severities": ["error", "warning", "exclusion"],
                         "violations": violations, "unconnected_items": [], "schematic_parity": []});
        let record = json!({"schema": "iot-lab.native-export.v1", "board": board, "status": "reject", "source_mutated": false, "drc_returncode": 0,
                            "drc_command": ["kicad-cli", "pcb", "drc", "--schematic-parity", "--refill-zones", "--severity-all"]});
        let mut case = Case { root, board, folder, drc, record };
        case.save();
        case
    }

    fn save(&mut self) {
        let report = self.folder.join("drc.json");
        fs::write(&report, self.drc.to_string()).unwrap();
        self.record["inputs"] = source_set(&self.board).unwrap();
        self.record["drc_sha256"] = file_sha256(&report).unwrap().into();
        fs::write(self.folder.join("record.json"), self.record.to_string()).unwrap();
    }

    fn board_text(&self) -> String {
        fs::read_to_string(&self.board).unwrap()
    }

    fn select(&self) -> Result<Value, String> {
        let clock = || 0.0;
        select_repair(&self.folder, &FRACTIONS, 2.0, &Budget::new(2.0, &clock)).map_err(|error| error.0)
    }

    fn propose(&self) -> Value {
        let clock = || 0.0;
        propose(&self.folder, &self.root.join("out"), &FRACTIONS, 2.0, &Budget::new(2.0, &clock)).unwrap()
    }
}

fn append(text: &str, form: &str) -> String {
    format!("{}{form})", &text[..text.len() - 1])
}

#[test]
fn native_ids_select_the_away_trace_without_a_manual_choice() {
    let case = Case::new("away");
    let plan = case.select().unwrap();
    assert_eq!(plan["status"], "candidate");
    assert_eq!(plan["choice"]["via_id"], "via");
    assert_eq!(plan["choice"]["along_trace_id"], "top");
    assert_eq!(plan["choice"]["conflict_error_indices"], json!([0, 1]));
    assert_eq!(plan["qualified"], false);
    let result = case.propose();
    assert_eq!(result["destination_mm"], json!(["1.000000", "0.000000"]));
    assert_eq!(result["conflict_selection"]["choice"]["via_id"], "via");
    assert_eq!(result["qualified"], false);
    assert_eq!(result["native_and_board_specific_gates_required"], true);
}

#[test]
fn a_tampered_report_or_source_is_stale() {
    let case = Case::new("tamper");
    let files: [PathBuf; 3] = [case.board.clone(), case.board.with_extension("kicad_dru"), case.folder.join("drc.json")];
    for path in &files {
        let original = fs::read_to_string(path).unwrap();
        fs::write(path, format!("{original} ")).unwrap();
        assert!(case.select().unwrap_err().contains("stale"), "{}", path.display());
        fs::write(path, original).unwrap();
    }
}

#[test]
fn missing_parity_check_or_existing_parity_fails_before_repair() {
    let mut case = Case::new("parity");
    case.drc["schematic_parity"] = json!([{"type": "missing_footprint"}]);
    case.save();
    assert!(case.select().unwrap_err().contains("schematic parity"));
    case.drc["schematic_parity"] = json!([]);
    case.record["drc_command"] = json!(["kicad-cli", "pcb", "drc", "--refill-zones", "--severity-all"]);
    case.save();
    assert!(case.select().unwrap_err().contains("incomplete"));
}

#[test]
fn other_errors_and_opens_are_not_claimed_fixed() {
    let mut case = Case::new("others");
    case.drc["violations"].as_array_mut().unwrap().push(json!({"type": "track_width", "severity": "error", "items": []}));
    case.drc["unconnected_items"] = json!([{"items": []}]);
    case.save();
    let plan = case.select().unwrap();
    assert_eq!(plan["choice"]["conflict_error_indices"], json!([0, 1]));
    assert_eq!(plan["untargeted_error_indices"], json!([2]));
    assert_eq!(plan["input_open_count"], 1);
    assert_eq!(plan["unsupported_error_indices"], json!([2]));
    assert_eq!(plan["qualified"], false);
}

#[test]
fn opposing_pad_conflicts_cannot_rank_as_one_away_move() {
    let mut case = Case::new("opposing");
    let second = "(footprint \"U\" (at 1 1) (uuid \"u2\")\n (property \"Reference\" \"U2\") (pad \"1\" smd rect (at 0 0) (net \"C\") (uuid \"p2\")))";
    fs::write(&case.board, append(&case.board_text(), second)).unwrap();
    let mut row = case.drc["violations"][0].clone();
    row["items"][1]["uuid"] = "p2".into();
    case.drc["violations"].as_array_mut().unwrap().push(row);
    case.save();
    let plan = case.select().unwrap();
    assert_eq!(plan["status"], "unsupported");
    assert_eq!(plan["choice"], Value::Null);
    let result = case.propose();
    assert_eq!(result["status"], "unsupported");
    assert!(!case.root.join("out/proposal.kicad_pcb").exists());
    assert!(case.root.join("out/record.json").is_file());
}

#[test]
fn a_locked_or_branched_via_abstains() {
    let mut case = Case::new("locked");
    let source = case.board_text();
    let branch = "(segment (start 0 0) (end 0 1) (width .15) (layer \"F.Cu\") (net \"A\") (uuid \"branch\"))";
    for changed in [source.replace("(via (at", "(via (locked yes) (at"), append(&source, branch)] {
        fs::write(&case.board, &changed).unwrap();
        case.save();
        let plan = case.select().unwrap();
        assert_eq!(plan["status"], "unsupported", "{changed}");
        assert_eq!(plan["choice"], Value::Null);
    }
}

#[test]
fn a_timeout_discards_partial_choices() {
    let mut case = Case::new("timeout");
    // The valid away direction comes first, so a timeout must drop a selected candidate, not just an empty search.
    fs::write(&case.board, case.board_text().replace("(uuid \"top\")", "(uuid \"a-top\")")).unwrap();
    case.save();
    let ticks = RefCell::new([0.0, 0.0, 3.0, 3.0].into_iter());
    let clock = || ticks.borrow_mut().next().unwrap();
    let plan = select_repair(Path::new(&case.folder), &FRACTIONS, 1.0, &Budget::new(1.0, &clock)).unwrap();
    assert_eq!(plan["status"], "timeout");
    assert_eq!(plan["choice"], Value::Null);
    assert_eq!(plan["evaluated"], 1);
    assert_eq!(plan["untargeted_error_indices"], json!([0, 1]));
}
