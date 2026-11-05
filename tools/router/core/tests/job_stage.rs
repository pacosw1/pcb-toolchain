//! Stages of the job under the real broker: output, deadline, and the graceful stop Fastroute relies on.
use iotroute::job::clock::{self, Env};
use iotroute::job::files::read_jsonl;
use iotroute::job::stage::{Runner, Spec};
use iotroute::job::stop::Stop;
use iotroute::job::progress::Progress;
use iotroute::job::watch::{Owner, Watcher};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::sync::mpsc::channel;
use std::thread::{sleep, spawn};
use std::time::Duration;

const BIN: &str = env!("CARGO_BIN_EXE_iotroute");

fn runner(name: &str) -> (Runner, PathBuf) {
    let out = std::env::temp_dir().join(format!("job-stage-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&out);
    fs::create_dir_all(&out).unwrap();
    let env: Env = std::env::vars().collect();
    (Runner::new(&out, env, None).unwrap().with_broker(BIN.into()), out)
}

fn sh(script: &str) -> Vec<String> {
    ["sh", "-c", script].map(str::to_string).to_vec()
}

#[test]
fn a_stage_gives_its_output_and_one_event() {
    let (runner, out) = runner("output");
    let done = runner.run(Spec::new("hello", sh("echo out; echo err >&2; exit 3")), |_| {}).unwrap();
    assert_eq!((done.returncode, done.stdout.as_str(), done.stderr.as_str()), (3, "out\n", "err\n"));
    let events = read_jsonl(out.join("stages.jsonl")).unwrap();
    assert_eq!((events[0]["status"].as_str(), events[0]["returncode"].as_i64()), (Some("failed"), Some(3)));
}

#[test]
fn a_log_takes_both_streams() {
    let (runner, out) = runner("log");
    let log = out.join("run.log");
    runner.run(Spec::new("log", sh("echo a; echo b >&2")).logged(&log), |_| {}).unwrap();
    assert_eq!(fs::read_to_string(&log).unwrap(), "a\nb\n");
}

#[test]
fn the_deadline_stops_a_stage() {
    let (runner, out) = runner("deadline");
    let stopped = runner.run(Spec::new("slow", sh("sleep 30")).deadline(Some(clock::now() + 0.3)), |_| {}).unwrap_err();
    assert!(matches!(stopped, Stop::Timeout { .. }));
    assert_eq!(read_jsonl(out.join("stages.jsonl")).unwrap()[0]["status"], "timeout");
}

#[test]
fn a_missing_command_is_not_a_result() {
    let (runner, _) = runner("missing");
    assert!(matches!(runner.run(Spec::new("gone", vec!["/no/such/tool".to_string()]), |_| {}), Err(Stop::Exit { code: 127, .. })));
}

#[test]
fn an_interrupt_lets_the_stage_finish_by_itself() {
    let (runner, _) = runner("interrupt");
    let script = "trap 'echo best; exit 0' TERM; echo ready; sleep 20 & wait";
    let (tell, told) = channel();
    let stopper = spawn(move || {
        let running: iotroute::job::stage::Running = told.recv().unwrap();
        sleep(Duration::from_millis(500));
        assert!(running.interrupt());
    });
    let done = runner.run(Spec::new("trap", sh(script)), move |running| tell.send(running).unwrap()).unwrap();
    stopper.join().unwrap();
    assert_eq!((done.returncode, done.stdout.as_str()), (0, "ready\nbest\n"));
}

const PASSES: &str = "    0.1 INFO  Auto-routing stage started with baseline score 1 for 3 unrouted items.
    0.2 INFO  Auto-routing pass #1 was completed in 0.1 seconds with score 1 (3 unrouted and 0 violations) (routed 0, failed 1, ripped 0).
    0.3 INFO  Auto-routing pass #2 was completed in 0.1 seconds with score 1 (3 unrouted and 0 violations) (routed 0, failed 1, ripped 0).
    0.4 INFO  Auto-routing pass #3 was completed in 0.1 seconds with score 1 (3 unrouted and 0 violations) (routed 0, failed 1, ripped 0).
    0.5 INFO  Auto-routing pass #4 was completed in 0.1 seconds with score 1 (3 unrouted and 0 violations) (routed 0, failed 1, ripped 0).
";

fn watcher(out: &std::path::Path, text: &str, passes: u64, owner: &Owner) -> Watcher {
    let log = out.join("run.log");
    fs::write(&log, text).unwrap();
    let progress = Arc::new(Mutex::new(Progress::new(out.join("progress.jsonl"))));
    Watcher::start(log, passes, owner.clone(), progress, "route".to_string())
}

#[test]
fn a_stall_stops_the_owned_stage_once_and_says_so() {
    let (runner, out) = runner("stall");
    let owner: Owner = Arc::new(Mutex::new(None));
    let (started, count) = (owner.clone(), out.join("terms"));
    let script = format!("trap 'echo term >> {}; exit 0' TERM; sleep 20 & wait", count.display());
    let stage = spawn(move || runner.run(Spec::new("router", sh(&script)), move |running| *started.lock().unwrap() = Some(running)).map(|done| done.returncode));
    while owner.lock().unwrap().is_none() {
        sleep(Duration::from_millis(20));
    }
    let mut watch = watcher(&out, PASSES, 2, &owner);
    assert_eq!(stage.join().unwrap().ok(), Some(0));
    let stall = watch.stop().unwrap().expect("a stall");
    assert_eq!((stall.interrupt_attempted, stall.interrupt_acknowledged, stall.how.as_str()), (true, Some(true), "owned-stage interrupt requested"));
    assert_eq!(fs::read_to_string(count).unwrap(), "term\n");
}

#[test]
fn a_stall_with_no_owned_stage_signals_nothing() {
    let (_, out) = runner("no-owner");
    let owner: Owner = Arc::new(Mutex::new(None));
    let mut watch = watcher(&out, PASSES, 2, &owner);
    sleep(Duration::from_millis(1500));
    let stall = watch.stop().unwrap().expect("a stall");
    assert_eq!((stall.interrupt_attempted, stall.interrupt_acknowledged), (false, None));
}

#[test]
fn a_run_that_finishes_leaves_no_stall() {
    let (_, out) = runner("no-stall");
    let owner: Owner = Arc::new(Mutex::new(None));
    let mut watch = watcher(&out, "    0.1 INFO  Auto-routing pass #1 was completed in 0.1 seconds with score 1 (3 unrouted and 0 violations) (routed 0, failed 1, ripped 0).\n", 2, &owner);
    sleep(Duration::from_millis(1200));
    assert!(watch.stop().unwrap().is_none());
}

#[test]
fn work_inside_the_job_leaves_a_row_with_its_cpu_by_scope() {
    let (runner, out) = runner("phase");
    assert_eq!(runner.phase("ses-import", None, || Ok(7)).unwrap(), 7);
    assert!(runner.phase("repair", None, || Err::<(), Stop>(Stop::failed("no"))).is_err());
    let rows = read_jsonl(out.join("stages.jsonl")).unwrap();
    assert_eq!((rows[0]["stage"].as_str(), rows[0]["kind"].as_str(), rows[0]["status"].as_str()), (Some("ses-import"), Some("inprocess"), Some("complete")));
    assert_eq!(rows[1]["status"], "failed");
    assert!(rows[0]["self_cpu_s"].is_f64() && rows[0]["child_cpu_s"].is_f64() && rows[0]["accounting"].as_str().unwrap().contains("non-additive"));
}

#[test]
fn expired_work_inside_the_job_never_runs_and_is_no_success() {
    let (runner, out) = runner("phase-expired");
    let ran = std::cell::Cell::new(false);
    let stopped = runner.phase("ses-import", Some(clock::now() - 1.0), || { ran.set(true); Ok(()) }).unwrap_err();
    assert!(matches!(stopped, Stop::Timeout { .. }) && !ran.get());
    let late = runner.phase("slow", Some(clock::now() + 0.05), || { sleep(Duration::from_millis(100)); Ok(()) }).unwrap_err();
    assert!(matches!(late, Stop::Timeout { .. }));
    assert_eq!(read_jsonl(out.join("stages.jsonl")).unwrap().iter().map(|row| row["status"].as_str().unwrap().to_string()).collect::<Vec<_>>(), ["timeout", "timeout"]);
}
