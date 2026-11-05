//! Explicit hard geometry constraints must survive non-converged recovery.
use serde_json::{json, Value};
use std::process::Command;

#[test]
fn strict_recovery_preserves_hard_antipad_web() {
    let dir = std::env::temp_dir().join(format!("iotroute-hard-web-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let pad = |net: &str, x: f64, y: f64, layer: &str| json!({
        "ref":net,"num":layer,"net":net,"x":x,"y":y,
        "bbox":[x-0.3,y-0.3,x+0.3,y+0.3],"layers":[layer]
    });
    // Each net needs a layer change. A 20 mm hard web cannot fit both
    // signal vias on this 10 mm board; recovery must leave a net open.
    let model = json!({
        "copper_layers":["F.Cu","B.Cu"],"plane_layers":[],
        "outline_bbox":[0,0,10,10],"setup":{"edge_clearance":0.25},
        "classes":{"Default":{"width":0.2,"clearance":0.2,"via":0.6,"drill":0.3}},
        "nets":{
            "A":{"class":"Default","width":0.2,"clearance":0.2,"layers":["F.Cu","B.Cu"]},
            "B":{"class":"Default","width":0.2,"clearance":0.2,"layers":["F.Cu","B.Cu"]}
        },
        "pads":[pad("A",1.0,2.0,"F.Cu"),pad("A",9.0,2.0,"B.Cu"),
                pad("B",1.0,8.0,"F.Cu"),pad("B",9.0,8.0,"B.Cu")],"copper":[]
    });
    std::fs::write(dir.join("model.json"),model.to_string()).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_iotroute"))
        .arg(dir.join("model.json")).arg(dir.join("out.json"))
        .args(["--pitch","0.2","--iters","1","--web","20","--web-hard","1"])
        .output().unwrap();
    assert!(output.status.success(), "{}",String::from_utf8_lossy(&output.stderr));
    let result: Value = serde_json::from_slice(&std::fs::read(dir.join("out.json")).unwrap()).unwrap();
    assert!(!result["failed"].as_array().unwrap().is_empty(),
        "incompatible hard web must leave an open net, not be relaxed: {result}\n{}",
        String::from_utf8_lossy(&output.stderr));
    let vias = result["vias"].as_array().unwrap();
    for (i, a) in vias.iter().enumerate() {
        for b in &vias[i + 1..] {
            if a["net"] == b["net"] { continue; }
            let dx = a["x"].as_f64().unwrap() - b["x"].as_f64().unwrap();
            let dy = a["y"].as_f64().unwrap() - b["y"].as_f64().unwrap();
            let copper_gap = dx.hypot(dy) - (a["d"].as_f64().unwrap() + b["d"].as_f64().unwrap()) / 2.0;
            assert!(copper_gap >= 20.0 - 1e-9, "recovery left conflicting vias: {a}, {b}");
        }
    }
    assert!(!String::from_utf8_lossy(&output.stderr).contains("relaxed in the strict end step"));
    std::fs::remove_dir_all(dir).unwrap();
}
