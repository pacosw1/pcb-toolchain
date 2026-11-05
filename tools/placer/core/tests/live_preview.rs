use serde_json::{json, Value};
use sha2::{Digest,Sha256};
use std::path::Path;
use std::process::Command;

fn digest(bytes:&[u8])->String {format!("{:x}",Sha256::digest(bytes))}
fn run(model:&Path, output:&Path, preview:Option<(&Path,&Path,&str,&str)>)->std::process::Output {
    let mut cmd=Command::new(env!("CARGO_BIN_EXE_iotplace"));
    cmd.arg("run").arg(model).arg("-o").arg(output).args(["--workers","1","--epochs","2","--steps","2","--top","1"]);
    for key in ["IOTPLACE_LIVE_FILE","IOTPLACE_LIVE_BOARD","IOTPLACE_LIVE_BOARD_SHA256","IOTPLACE_LIVE_MODEL_SHA256",
        "IOTPLACE_LIVE_MODEL_ID","IOTPLACE_LIVE_RULES_ID","IOTPLACE_LIVE_ATTEMPT_ID"] {cmd.env_remove(key);}
    if let Some((live,board,board_hash,model_hash))=preview {
        cmd.env("IOTPLACE_LIVE_FILE",live).env("IOTPLACE_LIVE_BOARD",board).env("IOTPLACE_LIVE_BOARD_SHA256",board_hash)
            .env("IOTPLACE_LIVE_MODEL_SHA256",model_hash).env("IOTPLACE_LIVE_MODEL_ID","model-1")
            .env("IOTPLACE_LIVE_RULES_ID","rules-1").env("IOTPLACE_LIVE_ATTEMPT_ID","attempt-1");
    }
    cmd.output().unwrap()
}
#[test]
fn preview_binds_immutable_input_and_does_not_change_search() {
    let root=std::env::temp_dir().join(format!("iotplace-live-{}",std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let board=root.join("input.kicad_pcb"); std::fs::write(&board,b"original board").unwrap();
    let model=root.join("problem.json");
    let raw=json!({"board_file":board,"units":[
        {"name":"U1","refs":["U1"],"fixed":false,"x":10,"y":10,"rects":[[-0.2,-0.2,0.2,0.2,1]]},
        {"name":"U2","refs":["U2"],"fixed":false,"x":14,"y":10,"rects":[[-0.2,-0.2,0.2,0.2,1]]}
    ],"nets":[],"board":{"outline":[[0,0],[30,0],[30,30],[0,30]]}});
    let bytes=serde_json::to_vec(&raw).unwrap();std::fs::write(&model,&bytes).unwrap();
    let baseline=root.join("baseline.json");let live_result=root.join("result.json");let live=root.join("live-place.json");
    let first=run(&model,&baseline,None);
    let second=run(&model,&live_result,Some((&live,&board,&digest(b"original board"),&digest(&bytes))));
    assert_eq!(first.status.code(),second.status.code());
    let a:Value=serde_json::from_slice(&std::fs::read(baseline).unwrap()).unwrap();
    let b:Value=serde_json::from_slice(&std::fs::read(&live_result).unwrap()).unwrap();
    assert_eq!(a["candidates"][0]["pose"],b["candidates"][0]["pose"]);
    assert_eq!(a["candidates"][0]["cost"],b["candidates"][0]["cost"]);
    let frame:Value=serde_json::from_slice(&std::fs::read(&live).unwrap()).unwrap();
    assert_eq!(frame["schema"],"iot-lab.placement-preview.v1");
    assert_eq!(frame["board_sha256"],digest(b"original board"));
    assert_eq!(frame["model_sha256"],digest(&bytes));
    assert_eq!(frame["epoch"],2);assert_eq!(frame["epochs"],2);
    assert_eq!(frame["units"][0]["refs"],json!(["U1"]));
    assert_eq!(frame["units"][0]["origin"],json!([10.0,10.0]));
    assert_eq!(std::fs::read(root.join("live-place-base.kicad_pcb")).unwrap(),b"original board");
    let bad=root.join("bad");std::fs::create_dir(&bad).unwrap();
    let bad_live=bad.join("live-place.json");
    let third=run(&model,&bad.join("result.json"),Some((&bad_live,&board,&"0".repeat(64),&digest(&bytes))));
    assert_eq!(first.status.code(),third.status.code());assert!(!bad_live.exists());
    assert!(!bad.join("live-place-base.kicad_pcb").exists());
    let mismatch=root.join("model-mismatch");std::fs::create_dir(&mismatch).unwrap();
    let fourth=run(&model,&mismatch.join("result.json"),Some((&mismatch.join("live-place.json"),&board,&digest(b"original board"),&"0".repeat(64))));
    assert_eq!(first.status.code(),fourth.status.code());
    assert!(!mismatch.join("live-place.json").exists());
    assert!(!mismatch.join("live-place-base.kicad_pcb").exists());
    std::fs::remove_dir_all(root).unwrap();
}
