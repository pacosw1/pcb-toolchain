use super::*;
use serde_json::json;

fn call(input: Value) -> Value {
    handle(serde_json::from_value(input).unwrap()).unwrap()
}
fn board() -> Value {
    json!([[[0, 0], [20, 0], [20, 10], [0, 10]]])
}
fn slot() -> Value {
    json!([[8, 2], [12, 2], [12, 8], [8, 8]])
}
fn spec() -> Value {
    json!({"adjacent":{"F.Cu":"In1.Cu","B.Cu":"In2.Cu"},"grounds":["GND"],"power":["+3V3"],"exempt":{"nets":{"/STATIC":"reason"}}})
}
fn info() -> Value {
    json!({"spec":spec(),"fast":["/SPI_*","/SW"],"pairs":["/USB_P","/USB_N"],"current":["/SW","+5V"],"clocks":s::default_clocks()})
}
fn fills() -> Value {
    json!({"In1.Cu":[["GND",[board()[0],slot()]]],"In2.Cu":[["GND",board()]]})
}
fn keepouts(outline: Value, fills: Value, discs: Value, spec: Value, fast: bool) -> Value {
    call(
        json!({"op":"layer_keepouts","spec":spec,"layers":["F.Cu","B.Cu","In2.Cu"],"outline":outline,"fills":fills,"discs":discs,"fast":fast}),
    )
}
fn area(rects: &Value) -> f64 {
    serde_json::from_value::<Vec<Rect>>(rects.clone())
        .unwrap()
        .iter()
        .map(|r| (r[2] - r[0]) * (r[3] - r[1]))
        .sum()
}

#[test]
fn reference_voids_respect_slots_holes_and_adjacent_layers() {
    let k = keepouts(board(), fills(), json!({}), spec(), false);
    assert_eq!(k["B.Cu"], json!([]));
    assert!(k.get("In2.Cu").is_none());
    assert_eq!(k["F.Cu"], json!([[8.0, 2.0, 12.0, 8.0]]));
    assert_eq!(area(&k["F.Cu"]), 24.0);
    let outline = json!([board()[0], slot()]);
    assert_eq!(
        keepouts(outline, fills(), json!({}), spec(), false)["F.Cu"],
        json!([])
    );
}

#[test]
fn other_net_is_no_reference_and_split_pours_leave_a_void() {
    let k = keepouts(
        board(),
        json!({"In1.Cu":[["+3V3",board()]]}),
        json!({}),
        spec(),
        false,
    );
    assert_eq!(area(&k["F.Cu"]), 200.0);
    let split = json!({"In1.Cu":[["GND",[[[0,0],[9.5,0],[9.5,10],[0,10]]]],["GND",[[[10.5,0],[20,0],[20,10],[10.5,10]]]]]});
    assert_eq!(
        area(&keepouts(board(), split, json!({}), spec(), false)["F.Cu"]),
        10.0
    );
}

#[test]
fn discs_leave_pad_access_and_slow_references_are_stage_specific() {
    let k = keepouts(board(), fills(), json!({"F.Cu":[[10,5,1]]}), spec(), false);
    assert!(area(&k["F.Cu"]) < 21.5);
    let rects: Vec<Rect> = serde_json::from_value(k["F.Cu"].clone()).unwrap();
    assert!(
        rects
            .iter()
            .all(|r| !(r[0] < 10.0 && 10.0 < r[2] && r[1] < 5.0 && 5.0 < r[3]))
    );
    let mut spec = spec();
    spec["alt_refs"] = json!({"VDD":{"slow_only":true},"VCAP":{"cap_mm":2}});
    let fill = json!({"In1.Cu":[["VDD",board()]]});
    assert_eq!(
        keepouts(board(), fill.clone(), json!({}), spec.clone(), false)["F.Cu"],
        json!([])
    );
    assert_eq!(
        area(&keepouts(board(), fill, json!({}), spec.clone(), true)["F.Cu"]),
        200.0
    );
    assert_eq!(
        call(json!({"op":"ref_nets","spec":spec,"fast":false})),
        json!(["GND", "VDD"])
    );
}

#[test]
fn staged_order_precedence_exemptions_and_empty_stages() {
    let plan = call(
        json!({"op":"stage_plan","nets":["/USB_P","/USB_N","/MCU_SCK","/SPI_MOSI","/SW","+5V","+3V3","/LED","/STATIC","GND","/BIG"],"info":info(),"net_class":{"/BIG":"PWR_WIDE"},"wide_classes":["PWR_WIDE"],"planes":["GND"]}),
    );
    assert_eq!(
        plan,
        json!([
            ["pairs_clocks", ["/MCU_SCK", "/USB_N", "/USB_P"], true],
            ["fast", ["/SPI_MOSI"], true],
            ["wide", ["+5V", "/BIG", "/SW"], true],
            ["wide_exempt", ["+3V3"], false],
            ["rest", ["/LED"], true],
            ["rest_exempt", ["/STATIC"], false]
        ])
    );
    assert_eq!(
        call(json!({"op":"stage_plan","nets":["/LED"],"info":info()})),
        json!([["rest", ["/LED"], true]])
    );
    let mut inf = info();
    inf["spec"]["mixed_layers"] = json!({"In2.Cu":{"power":["VBUS*"]}});
    assert_eq!(
        call(json!({"op":"exempt","net":"VBUS1","info":inf})),
        json!(true)
    );
}

#[test]
fn escape_and_hot_stages_precede_wide_routes() {
    let mut inf = info();
    inf["fast"] = json!(["/SPI_*"]);
    let plan = call(
        json!({"op":"stage_plan","info":inf,"nets":["/USB_P","/USB_N","/SPI_MOSI","/SW","+5V","/LED","/QFP_IO","GND"],"planes":["GND"],"escape":["/QFP_IO","/SPI_MOSI","/USB_P"],"hot":["/SW"]}),
    );
    assert_eq!(
        plan,
        json!([
            ["pairs_clocks", ["/USB_N", "/USB_P"], true],
            ["fast", ["/SPI_MOSI"], true],
            ["escape", ["/QFP_IO"], false],
            ["wide_hot", ["/SW"], true],
            ["wide", ["+5V"], true],
            ["rest", ["/LED", "/QFP_IO"], true]
        ])
    );
}

#[test]
fn fine_pitch_selection_and_escape_use_ipc_boundary() {
    assert_eq!(
        call(json!({"op":"footprint_pitch","points":[[0,0]]})),
        Value::Null
    );
    assert_eq!(
        call(json!({"op":"footprint_pitch","points":[[0,0],[1.27,0],[0,1.27]]})),
        json!(1.27)
    );
    let fine = call(
        json!({"op":"fine_pitch_refs","pads_by_ref":{"U1":[[0,0],[0.5,0],[1,0]],"U2":[[0,0],[0.65,0]],"U3":[[0,0],[0.8,0]],"R1":[[0,0],[1.5,0]],"TP1":[[0,0]]}}),
    );
    assert_eq!(fine, json!({"U1":0.5,"U2":0.65}));
    assert_eq!(
        call(
            json!({"op":"escape_nets","pads":[["U1","/A",true],["U1","/USB_P",true],["U1","GND",true],["U1","/B",false],["R1","/C",true],["U1","/NOTJOB",true],["U1","",true]],"fine":fine,"nets":["/A","/USB_P","GND","/B","/C",""],"exclude":["/USB_P","GND"]})
        ),
        json!(["/A"])
    );
    assert_eq!(
        call(json!({"op":"belt_margin","width":0.2,"clearance":0.2,"via":0.6})),
        json!(2.2)
    );
}

#[test]
fn belts_cover_only_board_outside_the_union() {
    let rects =
        call(json!({"op":"outside_rects","board_box":[0,0,20,10],"boxes":[[2,2,6,6],[5,4,9,8]]}));
    assert_eq!(area(&rects), 170.0);
    let rects: Vec<Rect> = serde_json::from_value(rects).unwrap();
    assert!(rects.iter().all(|r| 0.0 <= r[0]
        && r[0] < r[2]
        && r[2] <= 20.0
        && 0.0 <= r[1]
        && r[1] < r[3]
        && r[3] <= 10.0));
    assert_eq!(
        g::outside_rects([0., 0., 20., 10.], &[]),
        vec![[0., 0., 20., 10.]]
    );
}

#[test]
fn hot_loop_bounds_and_current_path_chains() {
    let pads = json!({"U2.5":[0,0],"L1.1":[4,0],"C3.2":[2,1]});
    assert_eq!(
        call(
            json!({"op":"hot_loop","pad_xy":pads,"loop_pads":["U2.5","L1.1"],"factor":1.5,"margin_min":0.4})
        ),
        json!({"straight_mm":4.0,"max_mm":6.0,"margin_mm":1.0,"ends":["U2.5","L1.1"],"box":[-1.0,-1.0,5.0,2.0]})
    );
    assert_eq!(
        call(json!({"op":"hot_loop","pad_xy":{},"loop_pads":[],"factor":1.5,"margin_min":0.4})),
        Value::Null
    );
    assert_eq!(
        call(
            json!({"op":"switch_nodes","current":{"/SW":{"switch_node":true,"pads":["U2.5","L1.1"]},"+5V":{"chains":[{"pads":["J1.1","C1.1"]}]},"/SW2":{"chains":[{"pads":["U3.8","L2.1"]}]}},"names":["/SW2","/SW3"]})
        ),
        json!({"/SW":["U2.5","L1.1"],"/SW2":["U3.8","L2.1"],"/SW3":[]})
    );
}

#[test]
fn via_counts_ground_search_and_hot_report() {
    let report = call(
        json!({"op":"via_report","vias":[["/SPI_MOSI",0,0,0.2],["/SPI_MOSI",10,0,0.2],["/LED",5,5,0.2],["GND",0.8,0,0.2]],"net_stage":{"/SPI_MOSI":"fast","/LED":"rest"},"fast":["/SPI_*"],"grounds":["GND"],"gnd_anchors":[[0.8,0,0.2]],"via_allow":0.6,"hot":{"/SW":{"max_mm":6,"straight_mm":4,"length_mm":5.2},"/SW2":{"max_mm":3,"straight_mm":2,"length_mm":3.5}}}),
    );
    assert_eq!(report["by_stage"]["fast"]["vias"], 2);
    assert_eq!(report["by_stage"]["rest"]["per_net"], json!({"/LED":1}));
    assert!(report["by_class"]["?"]["per_net"].get("GND").is_none());
    assert_eq!(
        report["fast_no_gnd"],
        json!([{"net":"/SPI_MOSI","x":10.0,"y":0.0,"nearest_gnd_mm":null}])
    );
    assert_eq!(report["hot_loops"]["/SW"]["within"], true);
    assert_eq!(report["hot_loops"]["/SW2"]["within"], false);
    assert_eq!(
        call(json!({"op":"summary_line","rep":report})),
        json!(
            "VIAS_BY_STAGE fast=2/1 rest=1/1 (vias/nets) FAST_VIA_NO_GND 1 HOT_LOOPS 1/2 within /SW=5.2/6mm,0via /SW2=3.5/3mm,0via"
        )
    );
}

#[test]
fn repair_selection_is_ranked_by_distance_then_net_and_respects_layers() {
    let mut request = json!({"op":"repair_selection","unrouted":[{"net":"/A","from_xy":[0,5],"to_xy":[10,5],"from":{"layers":["F.Cu","F.Cu"]},"to":{"layers":["F.Cu"]}}],"copper":[["/B","F.Cu",[5,0],[5,10]],["/C","F.Cu",[0,9],[10,9]],["/D",null,[7,5.2],[7,5.2]],["GND","F.Cu",[3,0],[3,10]],["/E","B.Cu",[8,0],[8,10]],["/A","F.Cu",[0,5],[2,5]]],"exclude":["GND"]});
    assert_eq!(
        call(request.clone()),
        json!({"nets":["/A","/B","/D"],"blockers":{"/A":["/B","/D"]},"connections":1,"corridor_mm":1.0})
    );
    request["copper"]
        .as_array_mut()
        .unwrap()
        .push(json!(["/F", "F.Cu", [6, 4.5], [6, 5.5]]));
    request["max_blockers"] = json!(2);
    assert_eq!(call(request.clone())["blockers"], json!({"/A":["/B","/F"]}));
    request["unrouted"] = json!([]);
    assert_eq!(call(request)["nets"], json!([]));
    assert_eq!(
        g::segment_distance([0., 0.], [10., 0.], [5., 3.], [5., 8.]),
        3.0
    );
    assert_eq!(
        g::segment_distance([0., 0.], [10., 0.], [5., -1.], [5., 1.]),
        0.0
    );
    assert_eq!(
        g::segment_distance([0., 0.], [0., 0.], [3., 4.], [3., 4.]),
        5.0
    );
}

#[test]
fn dsn_keepouts_read_a_real_header_with_its_lone_quote() {
    let text = "(pcb x\n  (parser\n    (string_quote \")\n    (space_in_quoted_tokens on)\n  )\n  (structure\n    (layer F.Cu)\n    (via \"Via[0-3]\")\n  )\n)";
    let out = call(json!({"op":"add_wire_keepouts","text":text,"rects_by_layer":{"F.Cu":[[1,2,3,4]]}}));
    assert!(out.as_str().unwrap().contains("(wire_keepout \"iot_ref_void\""));
}

#[test]
fn dsn_keepouts_keep_existing_format_and_handle_no_via_or_rule() {
    let text = "(pcb x\n  (structure\n    (layer F.Cu)\n    (via \"Via[0-3]\")\n    (rule (width 200))\n  )\n)";
    let out =
        call(json!({"op":"add_wire_keepouts","text":text,"rects_by_layer":{"F.Cu":[[1,2,3,4]]}}));
    let out = out.as_str().unwrap();
    assert!(out.contains("(wire_keepout \"iot_ref_void\" (polygon F.Cu 0  1000 -2000  3000 -2000"));
    assert!(out.find("wire_keepout") < out.find("(via \"Via"));
    assert_eq!(
        call(json!({"op":"add_wire_keepouts","text":text,"rects_by_layer":{"F.Cu":[]}})),
        json!(text)
    );
    let out = call(
        json!({"op":"add_keepouts","text":"(pcb x (structure (layer F.Cu)))","rects_by_layer":{"F.Cu":[[1,2,3,4]]},"kinds":["wire_keepout","via_keepout"],"name":"iot_belt"}),
    );
    assert!(out.as_str().unwrap().contains("(via_keepout \"iot_belt\""));
    assert!(iotroute::kicad::sexpr::parse(out.as_str().unwrap()).is_ok());
}

#[test]
fn malformed_grid_and_dsn_fail_before_work() {
    assert!(g::void_rects(&vec![], &[], &[], 0., 0.05, None).is_err());
    assert!(
        g::add_keepouts(
            "(pcb x)",
            &BTreeMap::from([("F.Cu".into(), vec![[0., 0., 1., 1.]])]),
            &kinds(),
            &name()
        )
        .is_err()
    );
}

#[test]
fn board_info_defaults_and_bad_files_fail_closed() {
    assert_eq!(
        call(json!({"op":"board_info"})),
        json!({"spec":{},"fast":[],"pairs":[],"current":[],"clocks":s::default_clocks(),"switch":{}})
    );
    let dir = std::env::temp_dir().join(format!("routing-rules-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("reference-planes.json"),
        r#"{"grounds":["GND"],"fast_file":"fast.json","about":"kept"}"#,
    )
    .unwrap();
    std::fs::write(dir.join("fast.json"), r#"{"fast":["/USB_*"]}"#).unwrap();
    let got = call(json!({"op":"board_info","board_dir":dir,"cfg":{"switch_nodes":["/SW"]}}));
    assert_eq!(
        got["spec"],
        json!({"grounds":["GND"],"fast_file":"fast.json","about":"kept"})
    );
    assert_eq!(got["fast"], json!(["/USB_*"]));
    std::fs::write(dir.join("fast.json"), "{broken").unwrap();
    assert!(s::board_info(Some(&dir), &s::Config::default()).is_err());
    std::fs::remove_dir_all(dir).unwrap();
}
