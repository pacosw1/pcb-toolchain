//! Stages of the job under the real broker: output, deadline, and the graceful stop Fastroute relies on.
use iotroute::job::clock::{self, Env};
use iotroute::job::files::read_jsonl;
use iotroute::job::stage::{Runner, Spec};
use iotroute::job::stop::Stop;
use std::fs;
use std::path::PathBuf;
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
