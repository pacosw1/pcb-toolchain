use super::gerber_netcheck::{self as gnc, geometry};
use serde_json::{Value, json};

fn check(input: Value) -> gnc::Report {
    gnc::check(&serde_json::from_value(input).unwrap()).unwrap()
}
fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Value {
    json!({"kind":"polygon","points":[[x0,y0],[x1,y0],[x1,y1],[x0,y1]]})
}
fn pad(r: &str, pin: &str, x: f64, y: f64, layer: &str, net: &str) -> Value {
    json!({"ref":r,"pin":pin,"x":x,"y":y,"layers":[layer],"net":net})
}

#[test]
fn one_copper_piece_connects_expected_pads() {
    let rep = check(
        json!({"layers":[{"name":"F.Cu","operations":[{"dark":true,"geometry":rect(0.,0.,10.,2.)}]}],"holes":[],"pads":[pad("J1","1",1.,1.,"F.Cu","N"),pad("J2","1",9.,1.,"F.Cu","N")]}),
    );
    assert!(rep.passed());
    assert_eq!(rep.nets, 1);
    assert_eq!(rep.nets_checked, 1);
    assert_eq!(rep.layers[0].pieces, 1);
}

#[test]
fn opens_shorts_missing_and_unconnected_nets_are_distinct() {
    let rep = check(
        json!({"layers":[{"name":"F.Cu","operations":[{"dark":true,"geometry":rect(0.,0.,2.,2.)},{"dark":true,"geometry":rect(8.,0.,10.,2.)}]}],"holes":[],"pads":[pad("A","1",1.,1.,"F.Cu","N"),pad("B","1",9.,1.,"F.Cu","N"),pad("C","1",1.5,1.,"F.Cu","OTHER"),pad("D","1",50.,1.,"F.Cu","N"),pad("E","1",9.,1.,"F.Cu","unconnected-(E-Pad1)")]}),
    );
    assert!(!rep.passed());
    assert_eq!(rep.opens.len(), 1);
    assert_eq!(rep.shorts.len(), 1);
    assert_eq!(rep.missing, vec!["D.1 (N)"]);
    assert_eq!(rep.nets, 2);
    assert_eq!(rep.shorts[0]["OTHER"], vec!["C.1"]);
}

#[test]
fn clear_operations_remove_previous_copper_and_later_dark_restores_it() {
    let mut input = json!({"layers":[{"name":"F.Cu","operations":[{"dark":true,"geometry":rect(0.,0.,10.,2.)},{"dark":false,"geometry":rect(4.,-1.,6.,3.)}]}],"holes":[],"pads":[pad("A","1",1.,1.,"F.Cu","N"),pad("B","1",9.,1.,"F.Cu","N")]});
    assert_eq!(check(input.clone()).opens.len(), 1);
    input["layers"][0]["operations"]
        .as_array_mut()
        .unwrap()
        .push(json!({"dark":true,"geometry":rect(4.,0.,6.,2.)}));
    assert!(check(input).passed());
}

#[test]
fn plated_holes_and_slots_join_layers_but_separate_layers_are_open() {
    let mut input = json!({"layers":[{"name":"F.Cu","operations":[{"dark":true,"geometry":rect(0.,0.,2.,2.)}]},{"name":"B.Cu","operations":[{"dark":true,"geometry":rect(0.,0.,2.,2.)}]}],"holes":[],"pads":[pad("A","1",1.,1.,"F.Cu","N"),pad("B","1",1.,1.,"B.Cu","N")]});
    assert_eq!(check(input.clone()).opens.len(), 1);
    input["holes"] = json!([{"start":[1,1],"end":[1,1],"diameter":0.3}]);
    assert!(check(input.clone()).passed());
    input["holes"] = json!([{"start":[0.5,1],"end":[1.5,1],"diameter":0.3}]);
    assert!(check(input).passed());
}

#[test]
fn aperture_holes_do_not_clear_copper_under_the_flash() {
    let ring = json!({"kind":"difference","a":{"kind":"circle","center":[5,1],"radius":0.8},"b":{"kind":"circle","center":[5,1],"radius":0.3}});
    let rep = check(
        json!({"layers":[{"name":"F.Cu","operations":[{"dark":true,"geometry":rect(0.,0.,10.,2.)},{"dark":true,"geometry":ring}]}],"holes":[],"pads":[pad("A","1",5.,1.,"F.Cu","N")]}),
    );
    assert!(rep.passed());
    assert_eq!(rep.layers[0].pieces, 1);
}

#[test]
fn region_holes_remain_empty_and_round_strokes_have_endcaps() {
    let shape: geometry::Geometry = serde_json::from_value(
        json!({"kind":"region","rings":[[[0,0],[10,0],[10,10],[0,10]],[[4,4],[6,4],[6,6],[4,6]]]}),
    )
    .unwrap();
    let polygons = geometry::render(&shape).unwrap();
    assert_eq!(polygons.len(), 1);
    assert_eq!(polygons[0].holes.len(), 1);
    assert!(!polygons[0].near(geometry::point([5., 5.]), 0));
    let rep = check(
        json!({"layers":[{"name":"F.Cu","operations":[{"dark":true,"geometry":{"kind":"stroke","points":[[0,0],[1,0]],"width":1}}]}],"holes":[],"pads":[pad("A","1",-0.4,0.,"F.Cu","N"),pad("B","1",1.4,0.,"F.Cu","N")]}),
    );
    assert!(rep.passed());
}

#[test]
fn pad_layer_membership_and_drill_allowance_are_preserved() {
    let rep = check(
        json!({"layers":[{"name":"F.Cu","operations":[{"dark":true,"geometry":rect(0.,0.,2.,2.)}]}],"holes":[],"pads":[pad("A","1",1.,1.,"B.Cu","N")]}),
    );
    assert_eq!(rep.missing, vec!["A.1 (N)"]);
    let rep = check(
        json!({"layers":[{"name":"F.Cu","operations":[{"dark":true,"geometry":rect(0.19,-1.,1.,1.)}]},{"name":"B.Cu","operations":[{"dark":true,"geometry":rect(-1.,-1.,-0.19,1.)}]}],"holes":[{"start":[0,0],"end":[0,0],"diameter":0.3}],"pads":[pad("A","1",0.5,0.,"F.Cu","N"),pad("B","1",-0.5,0.,"B.Cu","N")]}),
    );
    assert!(rep.passed());
}
