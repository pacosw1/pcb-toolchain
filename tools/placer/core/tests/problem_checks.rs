//! What a run refuses in a problem file.

mod common;

use common::{model, parse, problem_json, small_params, square_board, unit};
use iotplace::evaluator::Evaluator;
use serde_json::{Value, json};

#[test]
fn part_rules_stop_a_run() {
    // They make a place illegal and only the pcb_search placer had them: a run must not skip them.
    let mut v = problem_json(json!([unit("H", 5.0, 5.0, json!([[-1, -1, 1, 1, 0.0]]))]), json!([]), square_board(40.0, 0.0));
    v["part_rules"] = json!({"regions": [{"refs": ["H"], "box": [0, 0, 40, 10]}]});
    let error = parse(v).check_supported().unwrap_err();
    assert!(error.to_string().contains("part_rules"), "{error}");
}

/// TP7 with a pad over bottom copper and `layers` as its pad_copper_layers.
fn layered(layers: Value) -> Value {
    let mut u = unit("TP7", 113.0, 101.7, json!([[-1.75, -1.75, 1.75, 1.75, 0.0]]));
    u["pad_rects"] = json!([[-1.25, -1.25, 1.25, 1.25]]);
    u["pad_copper_layers"] = layers;
    let row = json!(["B.Cu", 114.6, 100.95, 111.0, 100.95, 0.2]);
    let mut board = square_board(150.0, 0.0);
    board["fixed_copper"] = json!([row]);
    board["fixed_copper_layers"] = json!([row]);
    problem_json(json!([u]), json!([]), board)
}

/// Does building and asking the evaluator stop on this problem?
fn refused(v: Value) -> bool {
    let p = small_params(&[]);
    let Ok(pr) = serde_json::from_value::<iotplace::problem::Problem>(v) else { return true };
    let m = model(&pr, &p);
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| Evaluator::new(&m, &p, &pr.initial_pose()).legal_penalty(0))).is_err()
}

#[test]
#[ignore = "no check yet: mask.rs indexes the list and takes unknown layers as no copper; the fix is in problem.rs or model.rs"]
fn layer_metadata_must_align_with_pad_boxes() {
    assert!(refused(layered(json!([]))));
    assert!(refused(layered(json!([["F.Cu"], ["B.Cu"]]))));
}

#[test]
#[ignore = "no check yet: mask.rs indexes the list and takes unknown layers as no copper; the fix is in problem.rs or model.rs"]
fn malformed_membership_is_rejected() {
    for layers in [json!("B.Cu"), json!(["B.Cu", "B.Cu"]), json!(["B.Mask"]), json!(["Foo.Cu"]), json!(["In63.Cu"])] {
        assert!(refused(layered(json!([layers.clone()]))), "{layers}");
    }
}
