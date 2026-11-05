use super::*;
use serde_json::{Value, json};
use std::collections::BTreeSet;

fn copper() -> Vec<String> {
    strings(&["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"])
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| item.to_string()).collect()
}

fn set<'a>(items: &[&'a str]) -> BTreeSet<&'a str> {
    items.iter().copied().collect()
}

fn config() -> Value {
    json!({
        "schema": "iot-lab.route.v1",
        "about": "test board",
        "backend": "tracemaker",
        "layers": ["F.Cu", "In2.Cu", "B.Cu"],
        "budget": {"passes": 60, "time_s": 300, "threads": 8},
        "stages": [
            {"name": "mains", "only_nets": ["/AC_N", "/AC_L"], "layers": ["B.Cu"], "passes": 100,
             "remove_zones": ["BARRIER_BAND"],
             "keepouts": [{"name": "SELV", "outside": [10, 10, 40, 30]}],
             "require": {"open": 0, "vias": 0}},
            {"name": "selv", "skip_nets": ["GND"], "plane_nets": ["GND"], "neck_um": 250,
             "keepouts": [{"name": "HV", "inside": [8, 8, 42, 32], "layers": ["F.Cu", "B.Cu"]}]},
        ],
        "pours": [
            {"name": "GND_B", "net": "GND", "layer": "B.Cu", "shape": "board", "priority": 0},
            {"name": "HI", "net": "/AC_L", "layer": "F.Cu", "shape": "around", "grow_mm": 1.2, "priority": 2},
        ],
    })
}

fn plan_of(cfg: &Value) -> Plan {
    load(cfg, &copper(), None).unwrap()
}

fn stages() -> (Stage, Stage) {
    let mut stages = plan_of(&config()).stages;
    let selv = stages.pop().unwrap();
    (stages.pop().unwrap(), selv)
}

#[track_caller]
fn assert_rejects(cfg: &Value, text: &str) {
    let error = load(cfg, &copper(), None).unwrap_err();
    assert!(error.contains(text), "{error}");
}

#[test]
fn valid_config_gives_normalized_stages() {
    let plan = plan_of(&config());
    assert_eq!(plan.backend, Backend::Tracemaker);
    let (mains, selv) = (&plan.stages[0], &plan.stages[1]);
    assert_eq!(mains.layers, ["B.Cu"]);
    assert_eq!(mains.budget.passes, 100);
    assert_eq!(mains.budget.time_s, 300);
    assert_eq!(mains.max_vias, Some(0));
    // A stage without its own layers or budget takes the board values; open connections default to 0.
    assert_eq!(selv.layers, ["F.Cu", "In2.Cu", "B.Cu"]);
    assert_eq!(selv.budget.passes, 60);
    assert_eq!(selv.require_open, 0);
    assert_eq!(selv.max_vias, None);
    assert_eq!(selv.keepouts[0].layers, ["F.Cu", "B.Cu"]);
    // A keepout without layers blocks every copper layer of the board.
    assert_eq!(mains.keepouts[0].layers, copper());
}

#[test]
fn reuse_names_an_earlier_run_by_absolute_path() {
    let mut cfg = config();
    cfg["reuse"] = json!({"from": "/run/operation/router", "nets": ["/A"]});
    assert_eq!(plan_of(&cfg).reuse, Some(Reuse { from: "/run/operation/router".to_string(), nets: vec!["/A".to_string()] }));
    cfg["reuse"] = json!({"from": "router"});
    assert!(load(&cfg, &copper(), None).unwrap_err().contains("absolute path"));
}

#[test]
fn every_error_is_named_in_one_message() {
    let mut cfg = config();
    cfg["schema"] = json!("x");
    cfg["stages"][1]["name"] = json!("mains");
    cfg["pours"][0]["shape"] = json!("circle");
    assert_eq!(
        load(&cfg, &copper(), None).unwrap_err(),
        "schema must be iot-lab.route.v1; duplicate stage name mains; pours[0].shape must be board or around"
    );
}

#[test]
fn config_that_is_no_object_is_rejected() {
    assert_eq!(load(&json!([]), &copper(), None).unwrap_err(), "route.json must be an object");
}

#[test]
fn unknown_key_is_rejected() {
    let mut cfg = config();
    cfg["stages"][0]["only_net"] = json!(["/AC_N"]);
    assert_rejects(&cfg, "stages[0]: unknown key only_net");
}

#[test]
fn wrong_schema_is_rejected() {
    let mut cfg = config();
    cfg["schema"] = json!("iot-lab.route.v0");
    assert_rejects(&cfg, "schema");
}

#[test]
fn unknown_backend_is_rejected() {
    let mut cfg = config();
    cfg["backend"] = json!("freerouting");
    assert_rejects(&cfg, "backend");
    cfg["backend"] = json!("fastroute");
    assert_rejects(&cfg, "needs the iotroute backend");
}

#[test]
fn only_and_skip_nets_together_are_rejected() {
    let mut cfg = config();
    cfg["stages"][0]["skip_nets"] = json!(["GND"]);
    assert_rejects(&cfg, "only_nets and skip_nets");
}

#[test]
fn layer_not_on_board_is_rejected() {
    let mut cfg = config();
    cfg["stages"][1]["layers"] = json!(["In3.Cu"]);
    assert_rejects(&cfg, "In3.Cu");
}

#[test]
fn missing_board_layers_give_one_error_and_an_empty_list_another() {
    let mut cfg = config();
    cfg.as_object_mut().unwrap().remove("layers");
    assert_eq!(load(&cfg, &copper(), None).unwrap_err(), "layers must be a list of non-empty strings");
    cfg["layers"] = json!([]);
    assert_eq!(load(&cfg, &copper(), None).unwrap_err(), "layers must name at least one layer");
}

#[test]
fn duplicate_stage_name_is_rejected() {
    let mut cfg = config();
    cfg["stages"][1]["name"] = json!("mains");
    assert_rejects(&cfg, "duplicate stage");
}

#[test]
fn no_stage_is_rejected() {
    let mut cfg = config();
    cfg["stages"] = json!([]);
    assert_rejects(&cfg, "stages");
}

#[test]
fn keepout_needs_exactly_one_box() {
    let mut cfg = config();
    cfg["stages"][0]["keepouts"][0]["inside"] = json!([1, 1, 2, 2]);
    assert_rejects(&cfg, "exactly one of inside or outside");
}

#[test]
fn keepout_box_must_have_positive_size() {
    let mut cfg = config();
    cfg["stages"][0]["keepouts"][0]["outside"] = json!([40, 10, 10, 30]);
    assert_rejects(&cfg, "x0 < x1");
}

#[test]
fn around_pour_needs_grow() {
    let mut cfg = config();
    cfg["pours"][1].as_object_mut().unwrap().remove("grow_mm");
    assert_rejects(&cfg, "grow_mm");
}

#[test]
fn pour_shape_must_be_known() {
    let mut cfg = config();
    cfg["pours"][0]["shape"] = json!("circle");
    assert_rejects(&cfg, "shape");
}

#[test]
fn negative_neck_is_rejected() {
    let mut cfg = config();
    cfg["stages"][1]["neck_um"] = json!(-1);
    assert_rejects(&cfg, "neck_um");
}

#[test]
fn boolean_is_not_a_count() {
    let mut cfg = config();
    cfg["stages"][0]["require"]["vias"] = json!(true);
    assert_rejects(&cfg, "vias");
}

#[test]
fn float_is_not_a_count() {
    let mut cfg = config();
    cfg["budget"]["passes"] = json!(1.0);
    assert_rejects(&cfg, "budget.passes must be an integer >= 0");
}

#[test]
fn unknown_feature_is_rejected() {
    let mut cfg = config();
    cfg["features"] = json!({"via_off_small_pad": true});
    let known = BTreeSet::from(["via_off_small_pads".to_string()]);
    assert!(load(&cfg, &copper(), Some(&known)).unwrap_err().contains("unknown feature via_off_small_pad"));
}

#[test]
fn feature_must_be_on_or_off() {
    let mut cfg = config();
    cfg["features"] = json!({"via_off_small_pads": "yes"});
    assert_rejects(&cfg, "features.via_off_small_pads");
}

#[test]
fn pour_defaults_keep_the_existing_zone_settings() {
    let pour = &plan_of(&config()).pours[0];
    assert!(pour.minus.is_empty());
    assert_eq!((pour.clearance_mm, pour.thermal_gap_mm, pour.spoke_mm), (0.3, 0.4, 1.0));
    assert_eq!(pour.connection, PourConnection::Full);
}

#[test]
fn pour_minus_boxes_and_zone_settings_are_read() {
    let mut cfg = config();
    let pour = cfg["pours"][0].as_object_mut().unwrap();
    pour.extend([
        ("minus".to_string(), json!([[1, 2, 3, 4]])),
        ("clearance_mm".to_string(), json!(0.25)),
        ("thermal_gap_mm".to_string(), json!(0.3)),
        ("spoke_mm".to_string(), json!(0.4)),
    ]);
    let pour = &plan_of(&cfg).pours[0];
    assert_eq!(pour.minus, [[1.0, 2.0, 3.0, 4.0]]);
    assert_eq!((pour.clearance_mm, pour.thermal_gap_mm, pour.spoke_mm), (0.25, 0.3, 0.4));
}

#[test]
fn pour_minus_box_must_have_positive_size() {
    let mut cfg = config();
    cfg["pours"][0]["minus"] = json!([[3, 2, 1, 4]]);
    assert_rejects(&cfg, "minus");
}

#[test]
fn pour_zone_setting_must_be_positive() {
    let mut cfg = config();
    cfg["pours"][0]["spoke_mm"] = json!(0);
    assert_rejects(&cfg, "spoke_mm");
}

#[test]
fn widths_are_read_with_board_layers_by_default() {
    let mut cfg = config();
    assert!(plan_of(&cfg).widths.is_empty());
    cfg["widths"] = json!([{"name": "ISLAND", "box": [0, 0, 10, 5], "width_mm": 0.15}]);
    let expected = WidthRule {
        name: "ISLAND".to_string(),
        bounds: [0.0, 0.0, 10.0, 5.0],
        layers: strings(&["F.Cu", "In2.Cu", "B.Cu"]),
        width_mm: 0.15,
    };
    assert_eq!(plan_of(&cfg).widths, [expected]);
}

#[test]
fn width_needs_a_positive_width_and_known_keys() {
    let mut cfg = config();
    cfg["widths"] = json!([{"name": "ISLAND", "box": [0, 0, 10, 5], "width_mm": 0}]);
    assert_rejects(&cfg, "width_mm");
    cfg["widths"] = json!([{"name": "ISLAND", "box": [0, 0, 10, 5], "width_mm": 0.15, "max": 1}]);
    assert_rejects(&cfg, "max");
}

#[test]
fn width_applies_by_segment_midpoint_layer_and_current_width() {
    let rule = WidthRule { name: "I".to_string(), bounds: [0.0, 0.0, 10.0, 5.0], layers: strings(&["F.Cu"]), width_mm: 0.15 };
    // The midpoint (5, 4) is inside although the end is outside.
    assert!(rule.applies((5.0, 3.0), (5.0, 5.0), "F.Cu", 0.25));
    assert!(rule.applies((0.0, 0.0), (0.0, 0.0), "F.Cu", 0.25)); // the box edge is inside
    assert!(!rule.applies((5.0, 4.0), (5.0, 8.0), "F.Cu", 0.25)); // midpoint y = 6
    assert!(!rule.applies((5.0, 3.0), (5.0, 3.0), "B.Cu", 0.25));
    assert!(!rule.applies((5.0, 3.0), (5.0, 3.0), "F.Cu", 0.15)); // never wider
}

#[test]
fn tracemaker_layers_become_no_tracks_on_and_only_nets_go_first() {
    let args = stages().0.tracemaker_args(&copper(), "tm", "in.kicad_pcb", "out.kicad_pcb", "sum.json");
    assert_eq!(
        args,
        strings(&[
            "tm", "route", "in.kicad_pcb", "-o", "out.kicad_pcb", "--time", "300", "--json", "sum.json", "--threads", "8",
            "--no-tracks-on", "F.Cu,In1.Cu,In2.Cu", "--first-nets", "/AC_N,/AC_L",
        ])
    );
}

#[test]
fn tracemaker_plane_nets_use_soft_zones_and_all_layers_give_no_layer_flag() {
    let mut cfg = config();
    cfg["stages"][1]["layers"] = json!(copper());
    let args = plan_of(&cfg).stages[1].tracemaker_args(&copper(), "tm", "a", "b", "c");
    assert!(args.contains(&"--soft-zones".to_string()));
    assert!(!args.contains(&"--no-tracks-on".to_string()));
    assert!(!args.contains(&"--first-nets".to_string()));
}

#[test]
fn only_nets_keep_only_those() {
    let nets = strings(&["/AC_N", "/AC_L", "GND", "/X"]);
    assert_eq!(stages().0.kept_nets(&nets), set(&["/AC_N", "/AC_L"]));
}

#[test]
fn skip_nets_keep_the_rest() {
    let nets = strings(&["/AC_N", "GND", "/X"]);
    assert_eq!(stages().1.kept_nets(&nets), set(&["/AC_N", "/X"]));
}

#[test]
fn skip_nets_are_patterns() {
    let mut cfg = config();
    cfg["stages"][1]["skip_nets"] = json!(["/AC_*"]);
    let nets = strings(&["/AC_N", "GND"]);
    assert_eq!(plan_of(&cfg).stages[1].kept_nets(&nets), set(&["GND"]));
}

#[test]
fn tracemaker_keeps_plane_net_copper_in_place_of_pad_vias() {
    // GND is skipped and a plane net: TraceMaker's GND copper connects its pads.
    let (mains, selv) = stages();
    let nets = strings(&["/AC_N", "GND", "/X"]);
    assert_eq!(selv.tracemaker_kept(&nets), set(&["/AC_N", "GND", "/X"]));
    let nets = strings(&["/AC_N", "GND"]);
    assert_eq!(mains.tracemaker_kept(&nets), set(&["/AC_N"]));
}

#[test]
fn open_connection_on_stage_net_fails() {
    let failures = stages().0.failures(&strings(&["/AC_N", "/OTHER"]), 0);
    assert_eq!(failures, ["stage mains: 1 open connections on its nets (limit 0)"]);
}

#[test]
fn vias_over_limit_fail() {
    assert_eq!(stages().0.failures(&[], 2), ["stage mains: 2 vias on its nets (limit 0)"]);
}

#[test]
fn clean_stage_passes() {
    assert!(stages().1.failures(&strings(&["GND"]), 40).is_empty());
}

fn open_item(net: &str) -> Value {
    json!({"items": [{"description": format!("Pad 1 [{net}] of J1 on F.Cu")}, {"description": format!("Pad 2 [{net}] of J2")}]})
}

#[test]
fn one_net_per_open_connection() {
    let drc = json!({"unconnected_items": [open_item("/AC_N"), open_item("GND"), open_item("GND")]});
    assert_eq!(open_nets(&drc).unwrap(), ["/AC_N", "GND", "GND"]);
}

#[test]
fn net_is_the_first_non_empty_bracket() {
    let drc = json!({"unconnected_items": [{"items": [{"description": "Pad [] [/A[0]] of J1"}]}]});
    assert_eq!(open_nets(&drc).unwrap(), ["/A[0"]);
}

#[test]
fn report_without_open_connections_has_none() {
    assert!(open_nets(&json!({})).unwrap().is_empty());
}

#[test]
fn capped_list_cannot_be_trusted() {
    let drc = json!({"unconnected_items": vec![open_item("GND"); DRC_UNCONNECTED_CAP]});
    assert!(open_nets(&drc).is_err());
}

#[test]
fn item_without_net_is_an_error() {
    assert!(open_nets(&json!({"unconnected_items": [{"items": [{"description": "Track on F.Cu"}]}]})).is_err());
}

#[test]
fn item_with_two_nets_is_an_error() {
    let drc = json!({"unconnected_items": [{"items": [{"description": "[A]"}, {"description": "[B]"}]}]});
    assert!(open_nets(&drc).unwrap_err().starts_with("open connection without one net: "));
}

const BOARD: &str = "(kicad_pcb
\t(version 20260101)
\t(setup
\t\t(stackup
\t\t\t(layer \"F.Cu\" (type \"copper\") (thickness 0.035))
\t\t)
\t)
\t(zone
\t\t(net \"GND\")
\t\t(name \"BARRIER_BAND\")
\t\t(polygon (pts (xy 0 0) (xy 1 0) (xy 1 1)))
\t)
\t(zone
\t\t(net \"GND\")
\t\t(name \"GND_B\")
\t\t(property \"note\" \"a ) in text\")
\t)
\t(zone
\t\t(name \"BARRIER_BAND_2\")
\t)
)
";

#[test]
fn split_removes_named_zones_only() {
    let (text, blocks) = split_zones(BOARD, &strings(&["BARRIER_BAND"])).unwrap();
    assert_eq!(blocks.len(), 1);
    assert!(blocks[0].contains("(name \"BARRIER_BAND\")"));
    assert!(!text.contains("(name \"BARRIER_BAND\")"));
    assert!(text.contains("(name \"GND_B\")"));
    assert!(text.contains("(name \"BARRIER_BAND_2\")"));
}

#[test]
fn split_takes_the_whole_lines_of_the_zone() {
    let (text, blocks) = split_zones(BOARD, &strings(&["GND_B"])).unwrap();
    assert!(blocks[0].starts_with("\t(zone\n"));
    assert!(blocks[0].ends_with("\t)\n"));
    assert_eq!(text.len() + blocks[0].len(), BOARD.len());
}

#[test]
fn missing_zone_name_is_an_error() {
    assert_eq!(split_zones(BOARD, &strings(&["NO_SUCH_ZONE"])).unwrap_err(), "no zone named NO_SUCH_ZONE");
}

#[test]
fn nested_zone_text_is_no_top_level_zone() {
    let board = "(kicad_pcb\n\t(footprint \"X\"\n\t\t(zone (name \"INNER\"))\n\t)\n)\n";
    assert!(split_zones(board, &strings(&["INNER"])).is_err());
}

#[test]
fn split_then_add_restores_the_zone() {
    let names = strings(&["BARRIER_BAND"]);
    let (text, blocks) = split_zones(BOARD, &names).unwrap();
    let back = add_blocks(&text, &blocks).unwrap();
    assert_eq!(back.matches("(name \"BARRIER_BAND\")").count(), 1);
    assert!(back.trim_end().ends_with(')'));
    assert_eq!(split_zones(&back, &names).unwrap().1, blocks);
}

#[test]
fn copy_block_puts_back_the_source_stackup() {
    let changed = BOARD.replace("(thickness 0.035)", "(thickness 0.07)");
    let copied = copy_block(BOARD, &changed, "(stackup").unwrap();
    assert!(copied.contains("(thickness 0.035)"));
    assert!(!copied.contains("(thickness 0.07)"));
}

#[test]
fn copy_block_needs_the_block_on_both_sides() {
    assert_eq!(copy_block("(a)", BOARD, "(stackup").unwrap_err(), "(stackup block missing");
}

#[test]
fn unbalanced_block_is_an_error() {
    assert_eq!(copy_block("(stackup (a)", "(stackup)", "(stackup").unwrap_err(), "unbalanced s-expression");
}
