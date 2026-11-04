//! End-to-end interruption checks. Synthetic routing model only.
use std::{process::{Command, Stdio}, time::{Duration, Instant}};
use serde_json::{json, Value};

#[test]
fn sigterm_keeps_a_replayable_pass_boundary() {
    let d = std::env::temp_dir().join(format!("resume-signal-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    let model = d.join("model.json"); let state = d.join("state.json");
    let m = json!({"copper_layers":["F.Cu","B.Cu"],"plane_layers":[],"outline_bbox":[0,0,10,10],
       "setup":{"edge_clearance":0.25},"classes":{"Default":{"width":0.2,"clearance":0.2,"via":0.6,"drill":0.3}},
       "nets":{"A":{"class":"Default","width":0.2,"clearance":0.2,"layers":["F.Cu"]},"B":{"class":"Default","width":0.2,"clearance":0.2,"layers":["F.Cu"]}},
       "pads":[{"ref":"J1","num":"1","net":"A","x":0.6,"y":5.0,"bbox":[0.3,4.7,0.9,5.3],"layers":["F.Cu"]},
                {"ref":"J2","num":"1","net":"A","x":9.4,"y":5.0,"bbox":[9.1,4.7,9.7,5.3],"layers":["F.Cu"]},
                {"ref":"J3","num":"1","net":"B","x":5.0,"y":0.6,"bbox":[4.7,0.3,5.3,0.9],"layers":["F.Cu"]},
                {"ref":"J4","num":"1","net":"B","x":5.0,"y":9.4,"bbox":[4.7,9.1,5.3,9.7],"layers":["F.Cu"]}],"copper":[]});
    std::fs::write(&model,m.to_string()).unwrap();
    let run = |out: &str| { let mut c = Command::new(env!("CARGO_BIN_EXE_iotroute"));
        c.arg(&model).arg(d.join(out)).args(["--pitch","0.2","--seed","7","--iters","40","--pres-mult","1","--hist","0"])
            .stdout(Stdio::null()).stderr(Stdio::null()); c };
    let mut child = run("partial.json").arg("--resume-save").arg(&state).spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(60);
    while !state.exists() {
        assert!(Instant::now() < deadline, "no pass boundary before timeout");
        assert!(child.try_wait().unwrap().is_none(), "route finished before interruption");
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(unsafe { libc::kill(child.id() as i32, libc::SIGTERM) }, 0);
    assert!(child.wait().unwrap().success(), "signal should stop cleanly");
    let snapshot: Value = serde_json::from_slice(&std::fs::read(&state).unwrap()).unwrap();
    assert!(snapshot["terminal"].is_null(), "must retain resumable state");
    let pass = snapshot["payload"]["pass"].as_u64().unwrap();
    assert!(pass < 40, "interrupted before the last pass");
    assert!(run("resume.json").arg("--resume").arg(&state).status().unwrap().success());
    assert!(run("full.json").status().unwrap().success());
    let read = |name: &str| -> Value { serde_json::from_slice(&std::fs::read(d.join(name)).unwrap()).unwrap() };
    let (a,b) = (read("resume.json"), read("full.json"));
    for key in ["tracks","vias","failed","passes"] { assert_eq!(a[key],b[key],"{key}"); }
    std::fs::remove_dir_all(d).unwrap();
}
