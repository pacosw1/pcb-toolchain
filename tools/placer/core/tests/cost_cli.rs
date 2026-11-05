use iotplace::{evaluator::Evaluator, model::Model, params::Params, problem::Problem};
use std::path::PathBuf;
use std::process::Command;

#[test]
fn cost_command_matches_default_evaluator_and_rejects_bad_pose() {
    let problem = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden/synthetic.json");
    let p = Problem::load(&problem).unwrap();
    let params = Params::from_args::<String>(&[]).unwrap();
    let model = Model::new(&p, &params).unwrap();
    let expected = Evaluator::new(&model, &params, &p.initial_pose()).cost();
    let output = Command::new(env!("CARGO_BIN_EXE_iotplace")).arg("cost").arg(&problem).output().unwrap();
    assert!(output.status.success());
    let actual: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(actual["cost"].as_f64().unwrap(), expected);
    let pose = std::env::temp_dir().join(format!("iotplace-invalid-pose-{}.json", std::process::id()));
    std::fs::write(&pose, "[]").unwrap();
    let invalid = Command::new(env!("CARGO_BIN_EXE_iotplace")).arg("cost").arg(&problem).arg("--pose").arg(&pose).output().unwrap();
    std::fs::remove_file(pose).unwrap();
    assert!(!invalid.status.success());
}
