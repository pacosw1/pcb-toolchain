//! Continuations are distinct from finished route results, and retain exact replay.
use serde_json::{json, Value};
use std::{path::PathBuf, process::{Command, Output}, sync::atomic::{AtomicUsize, Ordering}};

struct Fixture(PathBuf);
impl Fixture {
    fn new(crossed: bool) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let d = std::env::temp_dir().join(format!("iotroute-yield-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&d).unwrap();
        let mut model = json!({"copper_layers":["F.Cu","B.Cu"],"plane_layers":[],"outline_bbox":[0,0,10,10],
            "setup":{"edge_clearance":0.25},"classes":{"Default":{"width":0.2,"clearance":0.2,"via":0.6,"drill":0.3}},
            "nets":{"A":{"class":"Default","width":0.2,"clearance":0.2,"layers":["F.Cu"]},"B":{"class":"Default","width":0.2,"clearance":0.2,"layers":["F.Cu"]}},
            "pads":[{"ref":"J1","num":"1","net":"A","x":0.6,"y":5.0,"bbox":[0.3,4.7,0.9,5.3],"layers":["F.Cu"]},
                    {"ref":"J2","num":"1","net":"A","x":9.4,"y":5.0,"bbox":[9.1,4.7,9.7,5.3],"layers":["F.Cu"]},
                    {"ref":"J3","num":"1","net":"B","x":5.0,"y":0.6,"bbox":[4.7,0.3,5.3,0.9],"layers":["F.Cu"]},
                    {"ref":"J4","num":"1","net":"B","x":5.0,"y":9.4,"bbox":[4.7,9.1,5.3,9.7],"layers":["F.Cu"]}],"copper":[]});
        if !crossed {
            model["pads"].as_array_mut().unwrap().truncate(2);
            model["nets"].as_object_mut().unwrap().remove("B");
        }
        std::fs::write(d.join("model.json"), model.to_string()).unwrap();
        Self(d)
    }
    fn path(&self, name: &str) -> String { self.0.join(name).to_str().unwrap().to_string() }
    fn run(&self, out: &str, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_iotroute")).args([self.path("model.json"), self.path(out)])
            .args(["--pitch", "0.2", "--seed", "7", "--iters", "5"]).args(args).output().unwrap()
    }
    fn read(&self, name: &str) -> Value { serde_json::from_slice(&std::fs::read(self.path(name)).unwrap()).unwrap() }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

#[test]
fn yielding_skips_finalization_and_replays_across_multiple_invocations() {
    let f = Fixture::new(true);
    assert!(f.run("full.json", &[]).status.success());
    std::fs::write(f.path("yield.json"), "stale successful route").unwrap();
    let state = f.path("state.json"); let progress = f.path("progress.json");
    for pass in 1..=2 {
        let mut args = vec!["--resume-save", &state, "--yield-after-passes", "1", "--checkpoint", &progress];
        if pass > 1 { args.extend(["--resume", &state]); }
        let r = f.run("yield.json", &args);
        assert_eq!(r.status.code(), Some(3), "{}", String::from_utf8_lossy(&r.stderr));
        let receipt = f.read("yield.json");
        assert_eq!(receipt["schema"], "iot-lab.route-yield.v1");
        assert_eq!(receipt["status"], "yielded"); assert_eq!(receipt["finalized"], false);
        assert_eq!(receipt["pass"], pass); assert_eq!(receipt["reason"], "pass-budget");
        assert!(receipt.get("tracks").is_none()); assert!(receipt.get("failed").is_none());
        let bytes = std::fs::read(&state).unwrap();
        assert_eq!(receipt["checkpoint"]["sha256"], iotroute::sha256::sha256(&bytes));
        assert_eq!(receipt["checkpoint"]["bytes"], bytes.len());
        let snapshot = f.read("state.json");
        assert!(snapshot["terminal"].is_null()); assert_eq!(snapshot["payload"]["pass"], pass);
        assert_eq!(f.read("progress.json")["state"], "yielded");
        let log = String::from_utf8_lossy(&r.stderr);
        for marker in ["best iteration", "length recovery:", "returns:"] { assert!(!log.contains(marker), "unexpected finalization: {log}"); }
        assert!(!String::from_utf8_lossy(&r.stdout).contains("ROUTE PASS"));
    }
    assert!(f.run("resumed.json", &["--resume", &state]).status.success());
    let (a,b) = (f.read("full.json"), f.read("resumed.json"));
    for key in ["tracks", "vias", "failed", "passes"] { assert_eq!(a[key],b[key],"{key}"); }
}

#[test]
fn converged_run_finishes_normally_even_at_yield_boundary() {
    let f = Fixture::new(false); let state = f.path("state.json");
    assert!(f.run("full.json", &[]).status.success());
    assert!(f.run("out.json", &["--resume-save", &state, "--yield-after-passes", "1"]).status.success());
    assert_eq!(f.read("out.json"), f.read("full.json"));
    assert_eq!(f.read("state.json")["terminal"], "converged");
}

#[test]
fn saved_boundary_can_be_finalized_without_an_extra_search_pass() {
    let f = Fixture::new(true); let state = f.path("state.json");
    assert!(f.run("full.json", &["--iters", "1"]).status.success());
    assert_eq!(f.run("yield.json", &["--resume-save", &state, "--yield-after-passes", "1"]).status.code(), Some(3));
    let r = f.run("final.json", &["--iters", "1", "--resume", &state]);
    assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
    assert!(!String::from_utf8_lossy(&r.stderr).contains("iter  "), "finalize should do no negotiation pass");
    let (a,b) = (f.read("full.json"), f.read("final.json"));
    for key in ["tracks", "vias", "failed", "passes"] { assert_eq!(a[key],b[key],"{key}"); }
}

#[test]
fn yield_requires_valid_budget_and_durable_nonaliased_state() {
    let f = Fixture::new(true); let state = f.path("state.json");
    for args in [vec!["--yield-after-passes", "1"],
                 vec!["--resume-save", &state, "--yield-after-passes", "0"],
                 vec!["--resume-save", &state, "--yield-after-passes"],
                 vec!["--resume-save", &state, "--yield-after-passes", "1", "--iters", "0"]] {
        assert_eq!(f.run("out.json", &args).status.code(), Some(2));
    }
    assert_eq!(f.run("out.json", &["--resume-save", &f.path("out.json"), "--yield-after-passes", "1"]).status.code(), Some(2));
    // A directory cannot be atomically replaced by the state file. No yield receipt is emitted.
    std::fs::create_dir(&state).unwrap();
    assert_eq!(f.run("out.json", &["--resume-save", &state, "--yield-after-passes", "1"]).status.code(), Some(2));
    assert!(!f.0.join("out.json").exists());
}

#[test]
fn iteration_and_time_stops_yield_without_claiming_a_final_result() {
    let f = Fixture::new(true); let state = f.path("state.json");
    for (limits, reason) in [(vec!["--iters", "1"], "iters"), (vec!["--max-time", "0.0000001"], "max-time")] {
        let mut args = vec!["--resume-save", &state, "--yield-after-passes", "100"];
        args.extend(limits);
        let r = f.run("out.json", &args);
        assert_eq!(r.status.code(), Some(3), "{}", String::from_utf8_lossy(&r.stderr));
        assert_eq!(f.read("out.json")["reason"], reason);
        assert!(f.read("state.json")["terminal"].is_null());
    }
}

#[test]
fn sigterm_in_yield_mode_keeps_a_replayable_boundary() {
    use std::{process::Stdio, time::{Duration, Instant}};
    let f = Fixture::new(true); let state = f.path("state.json");
    let mut child = Command::new(env!("CARGO_BIN_EXE_iotroute"))
        .args([f.path("model.json"), f.path("yield.json")])
        .args(["--pitch", "0.2", "--seed", "7", "--iters", "40", "--yield-after-passes", "100", "--resume-save", &state])
        .stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    while !std::path::Path::new(&state).exists() {
        if Instant::now() >= deadline {
            let _ = child.kill(); let _ = child.wait(); panic!("no saved pass before deadline");
        }
        assert!(child.try_wait().unwrap().is_none(), "route stopped before checkpoint");
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(unsafe { libc::kill(child.id() as i32, libc::SIGTERM) }, 0);
    assert_eq!(child.wait().unwrap().code(), Some(3));
    assert_eq!(f.read("yield.json")["reason"], "cancelled");
    assert!(f.run("resumed.json", &["--iters", "40", "--resume", &state]).status.success());
    assert!(f.run("full.json", &["--iters", "40"]).status.success());
    let (a,b) = (f.read("full.json"), f.read("resumed.json"));
    for key in ["tracks", "vias", "failed", "passes"] { assert_eq!(a[key],b[key],"{key}"); }
}

#[test]
fn live_observation_keeps_route_results_identical_and_records_copper() {
    let f=Fixture::new(true);
    let off=f.run("off.json",&[]);assert!(off.status.success());
    let on=Command::new(env!("CARGO_BIN_EXE_iotroute")).args([f.path("model.json"),f.path("on.json")])
        .args(["--pitch","0.2","--seed","7","--iters","5"]).env("PCB_LIVE_EVENTS",f.path("live.ndjson")).output().unwrap();
    assert_eq!(on.status.code(),off.status.code());assert_eq!(f.read("on.json"),f.read("off.json"));
    let events:Vec<Value>=std::fs::read_to_string(f.path("live.ndjson")).unwrap().lines().map(|s|serde_json::from_str(s).unwrap()).collect();
    assert!(events.iter().any(|e|e["kind"]=="route.delta"));
    assert!(events.iter().any(|e|e["kind"]=="route.activity"&&e["data"]["action"]=="accepted"));
    assert!(events.iter().any(|e|e["kind"]=="checkpoint"));
}
