//! Isolated preview writes must never alter the model, source board or final route.
use serde_json::{json, Value};
use std::process::{Command, Stdio};

#[test]
fn preview_binds_source_and_refuses_an_aliased_output() {
    let dir = std::env::temp_dir().join(format!("iotroute-preview-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let source = dir.join("source.kicad_pcb"); let model = dir.join("model.json");
    std::fs::write(&source, b"fixture board").unwrap();
    let m = json!({"pcb":source.to_str().unwrap(),"copper_layers":["F.Cu","B.Cu"],"plane_layers":[],"outline_bbox":[0,0,10,10],
       "setup":{"edge_clearance":0.25},"classes":{"Default":{"width":0.2,"clearance":0.2,"via":0.6,"drill":0.3}},
       "nets":{"A":{"class":"Default","width":0.2,"clearance":0.2,"layers":["F.Cu"]}},
       "pads":[{"ref":"J1","num":"1","net":"A","x":1.0,"y":5.0,"bbox":[0.7,4.7,1.3,5.3],"layers":["F.Cu"]},
               {"ref":"J2","num":"1","net":"A","x":9.0,"y":5.0,"bbox":[8.7,4.7,9.3,5.3],"layers":["F.Cu"]}],"copper":[]});
    std::fs::write(&model, m.to_string()).unwrap();
    let run = |out: &str, preview: &std::path::Path| Command::new(env!("CARGO_BIN_EXE_iotroute"))
        .arg(&model).arg(dir.join(out)).args(["--pitch", "0.2", "--iters", "2"])
        .env("IOTROUTE_LIVE_FILE", preview).stdout(Stdio::null()).stderr(Stdio::null()).status().unwrap();
    let preview = dir.join("preview.json");
    assert!(run("out.json", &preview).success());
    let frame: Value = serde_json::from_slice(&std::fs::read(&preview).unwrap()).unwrap();
    assert_eq!(frame["board_sha256"], "db5447ecf114555646f06d5a6f3da315ccce524559b5578c6c13692851d63789");
    assert_eq!(std::fs::read(dir.join("live-route-base.kicad_pcb")).unwrap(), b"fixture board");
    assert!(run("out2.json", &source).success());
    assert_eq!(std::fs::read(&source).unwrap(), b"fixture board");
    std::fs::remove_dir_all(dir).unwrap();
}
