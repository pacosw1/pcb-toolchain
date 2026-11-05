//! A refused compiler result remains refused when handed straight to the solver.
use iotroute::model::{coverage::{admit_solver_model, check_rules}, dru::parse_rules, files::DesignRules, num::Num, output::{Net, RuleState}, rules::apply_rules};
use serde_json::{Value, json};
use std::{collections::{BTreeMap, BTreeSet}, fs, process::Command};

fn model(rule: &str) -> Value {
    let mut nets = BTreeMap::from([("A".to_string(), Net { class: "Default".to_string(), width: Some(Num::Float(0.2)), clearance: Some(Num::Float(0.2)), layers: vec!["F.Cu".into(), "B.Cu".into()], ..Net::default() })]);
    let rules = parse_rules(rule).unwrap();
    let mut report = apply_rules(&rules, &mut nets, &BTreeSet::new(), &BTreeSet::new()).unwrap().report;
    check_rules(&rules, &DesignRules::default(), &mut report);
    assert_eq!(report[0].state, RuleState::Unknown);
    json!({"schema":"iot-lab.route-model.v0","rules":report,"nets":nets,
        "copper_layers":["F.Cu","B.Cu"],"plane_layers":[],"outline_bbox":[0,0,10,10],
        "setup":{"edge_clearance":0.25},"classes":{"Default":{"width":0.2,"clearance":0.2,"via":0.6,"drill":0.3}},
        "pads":[{"ref":"J1","num":"1","net":"A","x":1.0,"y":5.0,"bbox":[0.7,4.7,1.3,5.3],"layers":["F.Cu"]},
                {"ref":"J2","num":"1","net":"A","x":9.0,"y":5.0,"bbox":[8.7,4.7,9.3,5.3],"layers":["F.Cu"]}],"copper":[]})
}

#[test]
fn malformed_coverage_cannot_be_mistaken_for_no_refusals() {
    for model in [
        json!({"schema":"iot-lab.route-model.v0"}),
        json!({"rules":null}), json!({"rules":{}}), json!({"rules":[{}]}),
        json!({"rules":[{"rule":"r","constraint":"length","state":"typo","nets":[],"why":""}]}),
    ] {
        assert!(admit_solver_model(&model).unwrap_err().contains("rule coverage refused"));
    }
    assert!(admit_solver_model(&json!({})).is_ok(), "legacy unversioned model");
    assert!(admit_solver_model(&json!({"schema":"iot-lab.route-model.v0","rules":[]})).is_ok());
    for state in ["applied", "checked", "stage", "plane"] {
        assert!(admit_solver_model(&json!({"rules":[{"rule":"r","constraint":"clearance","state":state,"nets":[],"why":"existing compiler delegation"}]})).is_ok());
    }
}

#[test]
fn refused_compiler_models_cannot_start_search_or_write_results() {
    let dir = std::env::temp_dir().join(format!("iotroute-rule-admission-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    for (i, rule) in [
        r#"(rule "width minimum" (constraint track_width (min 0.8mm)))"#,
        r#"(rule "length minimum" (constraint length (min 20mm) (max 30mm)))"#,
        r#"(rule "layer width" (layer "F.Cu") (constraint track_width (opt 0.4mm)))"#,
        r#"(rule "via maximum" (constraint via_diameter (min 0.5mm) (max 0.7mm)))"#,
    ].into_iter().enumerate() {
        let input = dir.join(format!("{i}.json"));
        let output = dir.join(format!("{i}-route.json"));
        let checkpoint = dir.join(format!("{i}-checkpoint.json"));
        let m = model(rule);
        fs::write(&input, m.to_string()).unwrap();
        let run = Command::new(env!("CARGO_BIN_EXE_iotroute")).arg(&input).arg(&output)
            .args(["--pitch", "0.2", "--iters", "1", "--checkpoint"]).arg(&checkpoint).output().unwrap();
        let stderr = String::from_utf8_lossy(&run.stderr);
        assert_eq!(run.status.code(), Some(2), "{rule}: {stderr}");
        assert!(stderr.contains("rule coverage refused") && stderr.contains(m["rules"][0]["rule"].as_str().unwrap()), "{stderr}");
        assert!(!output.exists() && !checkpoint.exists(), "refusal must precede output writes");
    }
    fs::remove_dir_all(dir).unwrap();
}
