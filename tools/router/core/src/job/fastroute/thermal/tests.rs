//! Detection, the acceptance rule and the transaction, with a scripted native side. No KiCad.
use super::*;
use std::cell::RefCell;

fn fault() -> Value {
    json!({"type": "starved_thermal", "severity": "error", "items": [
        {"uuid": "z", "description": "Zone 'ground' [GND] on F.Cu"},
        {"uuid": "p", "description": "Pad 2 [GND] of U16 on F.Cu"}]})
}

fn pads(reference: &str, number: &str, net: &str) -> Pads {
    Pads::from([("p".to_string(), (reference.to_string(), number.to_string(), net.to_string()))])
}

fn zones(net: &str) -> Zones {
    Zones::from([("z".to_string(), net.to_string())])
}

fn planes(names: &[&str]) -> BTreeSet<String> {
    names.iter().map(|name| name.to_string()).collect()
}

fn folder(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("thermal-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn uuid_and_identity_are_required_not_only_text() {
    let drc = json!({"violations": [fault()]});
    let found = thermal_targets(&drc, &pads("U16", "2", "GND"), &zones("GND"), &planes(&["GND"])).unwrap();
    assert_eq!(found["GND"], ["U16.2"]);
    for (pads, zones) in [(Pads::new(), zones("GND")), (pads("U4", "2", "GND"), zones("GND")), (pads("U16", "2", "GND"), zones("VDD"))] {
        assert!(thermal_targets(&drc, &pads, &zones, &planes(&["GND"])).is_err());
    }
    assert!(thermal_targets(&drc, &pads("U16", "2", "GND"), &zones("GND"), &planes(&["/CAN_GND"])).unwrap().is_empty());
}

#[test]
fn a_through_hole_pad_has_the_wording_of_kicad_10() {
    let drc = json!({"violations": [{"type": "starved_thermal", "severity": "error", "items": [
        {"uuid": "z", "description": "Zone 'GND_B' [GND] on B.Cu, priority 0"},
        {"uuid": "p", "description": "PTH pad 11 [GND] of U10"}]}]});
    assert_eq!(thermal_targets(&drc, &pads("U10", "11", "GND"), &zones("GND"), &planes(&["GND"])).unwrap()["GND"], ["U10.11"]);
    assert!(thermal_targets(&drc, &pads("U10", "12", "GND"), &zones("GND"), &planes(&["GND"])).is_err());
}

#[test]
fn a_malformed_native_thermal_is_refused() {
    let pad = json!({"uuid": "p", "description": "Pad 2 [GND] of U16 on F.Cu"});
    for items in [json!([]), json!([{}]), Value::Null, json!([pad, pad])] {
        let mut finding = fault();
        finding["items"] = items;
        assert!(thermal_targets(&json!({"violations": [finding]}), &pads("U16", "2", "GND"), &zones("GND"), &planes(&["GND"])).is_err());
    }
}

#[test]
fn the_transaction_refuses_new_errors_regression_and_a_policy_change() {
    let before = json!({"violations": [fault()], "unconnected_items": [{}], "schematic_parity": []});
    let after = json!({"violations": [], "unconnected_items": [], "schematic_parity": []});
    let original = Rows::from([(("setup".to_string(), "setup".to_string()), "(setup (min_spokes 2))".to_string())]);
    assert!(acceptable(&before, &after, &original, &original).0);
    let with = |key: &str, value: Value| {
        let mut changed = after.clone();
        changed[key] = value;
        changed
    };
    let cases = [with("violations", json!([{"type": "clearance", "severity": "error", "items": []}])), with("schematic_parity", json!([{}])), with("unconnected_items", json!([{}, {}])), before.clone()];
    for candidate in &cases {
        assert!(!acceptable(&before, candidate, &original, &original).0, "{candidate}");
    }
    let weaker = Rows::from([(("setup".to_string(), "setup".to_string()), "(setup (min_spokes 1))".to_string())]);
    assert!(!acceptable(&before, &after, &original, &weaker).0);
    // The count of parity faults stays, the fault is another one.
    let parity = |uuid: &str, text: &str| json!([{"type": "net_mismatch", "items": [{"uuid": uuid, "description": text}]}]);
    let mut old = before.clone();
    old["schematic_parity"] = parity("old", "old net");
    assert!(!acceptable(&old, &with("schematic_parity", parity("new", "new net")), &original, &original).0);
    assert!(!acceptable(&old, &with("schematic_parity", parity("old", "new net")), &original, &original).0);
}

#[test]
fn an_addition_may_only_be_copper() {
    let before = json!({"violations": [fault()], "unconnected_items": [], "schematic_parity": []});
    let after = json!({"violations": [], "unconnected_items": [], "schematic_parity": []});
    let row = |kind: &str| Rows::from([((kind.to_string(), "n".to_string()), format!("({kind})"))]);
    assert!(acceptable(&before, &after, &Rows::new(), &row("via")).0);
    assert!(acceptable(&before, &after, &Rows::new(), &row("segment")).0);
    assert_eq!(acceptable(&before, &after, &Rows::new(), &row("zone")), (false, "non-copper addition"));
}

#[test]
fn immutable_rows_hold_every_node_and_leave_out_the_fill_alone() {
    let dir = folder("immutable");
    let path = dir.join("board.kicad_pcb");
    let text = r#"(kicad_pcb (setup (min_spokes 2)) (footprint "U" (uuid f) (pad "2" (net 1 "GND"))) (zone (uuid z) (fill (thermal_gap .3) (thermal_bridge_width .4)) (filled_polygon (pts (xy 1 2)))) (segment (uuid s) (width .2)))"#;
    fs::write(&path, text).unwrap();
    let before = immutable_board(&path, None).unwrap();
    assert_eq!(before.len(), 4);
    fs::write(&path, text.replace("(xy 1 2)", "(xy 3 4)")).unwrap();
    assert_eq!(before, immutable_board(&path, None).unwrap());
    fs::write(&path, text.replace("thermal_gap .3", "thermal_gap .2")).unwrap();
    assert_ne!(before, immutable_board(&path, None).unwrap());
    fs::write(&path, text.replace("(uuid s)", "(uuid f)").replace("(segment", "(footprint")).unwrap();
    assert!(immutable_board(&path, None).unwrap_err().reason().contains("duplicate"));
    for bad in ["(kicad_sch)", "(kicad_pcb", "(kicad_pcb)(kicad_pcb)"] {
        fs::write(&path, bad).unwrap();
        assert!(immutable_board(&path, None).is_err(), "{bad}");
    }
}

#[test]
fn the_parser_and_the_hierarchy_keep_the_deadline_and_a_missing_sheet_fails() {
    let dir = folder("hierarchy");
    let board = dir.join("board.kicad_pcb");
    fs::write(&board, "(kicad_pcb (setup))").unwrap();
    assert!(matches!(immutable_board(&board, Some(clock::now() - 1.0)), Err(Stop::Timeout { .. })));
    fs::write(dir.join("board.kicad_sch"), r#"(kicad_sch (property "Sheetfile" "blocks/child.kicad_sch"))"#).unwrap();
    let copy = dir.join("copy");
    fs::create_dir(&copy).unwrap();
    assert!(matches!(copy_hierarchy(&board, &copy, clock::now() + 5.0), Err(Stop::Exit { .. })));
    fs::create_dir(dir.join("blocks")).unwrap();
    fs::write(dir.join("blocks/child.kicad_sch"), "(kicad_sch)").unwrap();
    assert_eq!(copy_hierarchy(&board, &copy, clock::now() + 5.0).unwrap(), ["blocks/child.kicad_sch", "board.kicad_sch"]);
    assert!(copy.join("blocks/child.kicad_sch").is_file());
    assert!(matches!(copy_hierarchy(&board, &copy, clock::now() - 1.0), Err(Stop::Timeout { .. })));
}

#[test]
fn a_sheet_outside_the_project_fails() {
    let dir = folder("outside");
    let project = dir.join("project");
    fs::create_dir(&project).unwrap();
    fs::write(dir.join("other.kicad_sch"), "(kicad_sch)").unwrap();
    fs::write(project.join("board.kicad_sch"), r#"(kicad_sch (property "Sheetfile" "../other.kicad_sch"))"#).unwrap();
    let copy = dir.join("copy");
    fs::create_dir(&copy).unwrap();
    assert!(copy_hierarchy(&project.join("board.kicad_pcb"), &copy, clock::now() + 5.0).unwrap_err().reason().contains("outside source project"));
}

/// The native side, scripted: DRC reports in order, and the board a proposal saves.
#[derive(Default)]
struct Script {
    reports: RefCell<Vec<Value>>,
    proposal: Option<String>,
    timeout: bool,
    change_rules: bool,
    proposed: RefCell<Vec<ViaOptions>>,
}

impl Native for Script {
    fn inventory(&self, _board: &Path) -> Result<(Pads, Zones), Stop> {
        Ok((pads("U16", "2", "GND"), zones("GND")))
    }

    fn drc(&self, _stage: &str, _board: &Path, report: &Path, _log: &Path, _deadline: f64) -> Result<i32, Stop> {
        if self.timeout {
            return Err(expired("native"));
        }
        fs::write(report, self.reports.borrow_mut().remove(0).to_string()).unwrap();
        Ok(0)
    }

    fn propose(&self, board: &Path, out: &Path, options: &ViaOptions, _log: &Path) -> Result<(), Stop> {
        self.proposed.borrow_mut().push(options.clone());
        if self.change_rules {
            fs::write(with_suffix(board, "kicad_dru"), "(rules changed)").unwrap();
        }
        if let Some(text) = &self.proposal {
            fs::write(out, text).unwrap();
        }
        Ok(())
    }
}

const BOARD: &str = "(kicad_pcb (segment (uuid s)))";

fn project(name: &str) -> (PathBuf, PathBuf) {
    let dir = folder(name);
    let board = dir.join("board.kicad_pcb");
    fs::write(&board, BOARD).unwrap();
    fs::write(with_suffix(&board, "kicad_sch"), "(kicad_sch)").unwrap();
    fs::write(with_suffix(&board, "kicad_dru"), "(rules)").unwrap();
    (dir, board)
}

fn faulty() -> Value {
    json!({"violations": [fault()], "unconnected_items": [], "schematic_parity": []})
}

fn clean() -> Value {
    json!({"violations": [], "unconnected_items": [], "schematic_parity": []})
}

fn repaired() -> Option<String> {
    Some("(kicad_pcb (segment (uuid s)) (via (uuid v)))".to_string())
}

fn run_script(script: &Script, board: &Path, events: Option<&Path>, via_args: &[String]) -> Result<(Value, Value), Stop> {
    let plane = planes(&["GND"]);
    let request = Request { board, project: board, planes: &plane, via_args, events, label: "test", deadline: clock::now() + 30.0 };
    repair(script, &request, faulty())
}

#[test]
fn an_accepted_proposal_replaces_the_board_and_the_drc() {
    let (_, board) = project("accepted");
    let script = Script { reports: RefCell::new(vec![faulty(), clean()]), proposal: repaired(), ..Script::default() };
    let (drc, evidence) = run_script(&script, &board, None, &[]).unwrap();
    assert_eq!(evidence["accepted"], true);
    assert_eq!(evidence["qualified"], false);
    assert_eq!((evidence["errors_before"].as_u64(), evidence["errors_after"].as_u64(), evidence["remaining_thermal"].as_u64()), (Some(1), Some(0), Some(0)));
    assert_eq!(drc, clean());
    assert_eq!(fs::read_to_string(&board).unwrap(), repaired().unwrap());
    let options = &script.proposed.borrow()[0];
    assert_eq!((options.net.as_str(), options.only.iter().collect::<Vec<_>>()), ("GND", vec![&"U16.2".to_string()]));
    let decision: Value = serde_json::from_str(&fs::read_to_string(Path::new(evidence["directory"].as_str().unwrap()).join("decision.json")).unwrap()).unwrap();
    assert_eq!(decision["status"], "complete");
}

#[test]
fn a_rejected_proposal_leaves_the_board_and_the_drc() {
    let (_, board) = project("rejected");
    let worse = json!({"violations": [fault(), {"type": "clearance", "severity": "error", "items": []}], "unconnected_items": [], "schematic_parity": []});
    let script = Script { reports: RefCell::new(vec![faulty(), worse]), proposal: repaired(), ..Script::default() };
    let (drc, evidence) = run_script(&script, &board, None, &[]).unwrap();
    assert_eq!((evidence["accepted"].clone(), evidence["reason"].clone()), (json!(false), json!("new native errors")));
    assert_eq!(drc, faulty());
    assert_eq!(fs::read_to_string(&board).unwrap(), BOARD);
}

#[test]
fn a_proposal_that_edits_existing_copper_or_saves_nothing_is_rejected() {
    let (_, board) = project("edited");
    let script = Script { reports: RefCell::new(vec![faulty(), clean()]), proposal: Some("(kicad_pcb (segment (uuid s) (width 1)))".to_string()), ..Script::default() };
    let (_, evidence) = run_script(&script, &board, None, &[]).unwrap();
    assert_eq!(evidence["reason"], "existing copper, parts, setup or zone policies changed");
    assert_eq!(fs::read_to_string(&board).unwrap(), BOARD);
    let (_, board) = project("nothing");
    let script = Script { reports: RefCell::new(vec![faulty(), clean()]), ..Script::default() };
    let (_, evidence) = run_script(&script, &board, None, &[]).unwrap();
    assert_eq!(evidence["reason"], "thermal copper proposal failed");
}

#[test]
fn rules_changed_during_the_proposal_reject_it() {
    let (_, board) = project("rules");
    let script = Script { reports: RefCell::new(vec![faulty(), clean()]), proposal: repaired(), change_rules: true, ..Script::default() };
    let (drc, evidence) = run_script(&script, &board, None, &[]).unwrap();
    assert_eq!(evidence["reason"], "native project, rules or schematic changed during proposal");
    assert_eq!((evidence["accepted"].clone(), drc), (json!(false), faulty()));
    assert_eq!(fs::read_to_string(&board).unwrap(), BOARD);
}

#[test]
fn a_report_without_parity_evidence_proves_nothing() {
    let (_, board) = project("parity");
    let script = Script { reports: RefCell::new(vec![json!({"violations": [], "unconnected_items": []})]), proposal: repaired(), ..Script::default() };
    let (_, evidence) = run_script(&script, &board, None, &[]).unwrap();
    assert_eq!(evidence["reason"], "native parity evidence unavailable");
}

#[test]
fn identity_overrides_in_pad_vias_and_a_missing_schematic_make_no_proposal() {
    let (_, board) = project("overrides");
    for word in ["--net=VDD", "--only", "--in-pad"] {
        let script = Script::default();
        let (drc, evidence) = run_script(&script, &board, None, &[word.to_string()]).unwrap();
        assert_eq!(evidence["reason"], "thermal repair prohibits identity overrides and in-pad vias");
        assert_eq!(drc, faulty());
        assert!(script.proposed.borrow().is_empty());
    }
    fs::remove_file(with_suffix(&board, "kicad_sch")).unwrap();
    let (_, evidence) = run_script(&Script::default(), &board, None, &[]).unwrap();
    assert_eq!(evidence["reason"], "source schematic unavailable; parity cannot be proven");
    assert!(Path::new(evidence["directory"].as_str().unwrap()).join("decision.json").is_file());
}

#[test]
fn no_target_makes_no_folder() {
    let (dir, board) = project("none");
    let plane = planes(&["VDD"]);
    let request = Request { board: &board, project: &board, planes: &plane, via_args: &[], events: None, label: "test", deadline: clock::now() + 30.0 };
    let (_, evidence) = repair(&Script::default(), &request, faulty()).unwrap();
    assert_eq!(evidence["reason"], "no plane thermal targets");
    assert_eq!(fs::read_dir(&dir).unwrap().filter(|entry| entry.as_ref().unwrap().path().is_dir()).count(), 0);
}

#[test]
fn a_timeout_is_persisted_and_goes_on_without_accepting_the_original() {
    let (dir, board) = project("timeout");
    let events = dir.join("stages.jsonl");
    let script = Script { timeout: true, ..Script::default() };
    assert!(matches!(run_script(&script, &board, Some(&events), &[]), Err(Stop::Timeout { .. })));
    let work = fs::read_dir(&dir).unwrap().map(|entry| entry.unwrap().path()).find(|path| path.is_dir()).unwrap();
    let read = |path: PathBuf| serde_json::from_str::<Value>(&fs::read_to_string(path).unwrap()).unwrap();
    let (decision, checkpoint) = (read(work.join("decision.json")), read(work.join("checkpoint.json")));
    assert_eq!((decision["status"].clone(), decision["accepted"].clone()), (json!("timeout"), json!(false)));
    assert_eq!((checkpoint["qualified"].clone(), checkpoint["native_evidence"].clone()), (json!(false), faulty()));
    assert_eq!(read(events)["status"], "timeout");
    assert_eq!(fs::read_to_string(&board).unwrap(), BOARD);
}
