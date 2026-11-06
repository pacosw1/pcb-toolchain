//! The steps a run spawns, each with its log: model, route, write and the gate's planes screen. A step is this same binary, so a
//! core that exits or panics is a failed step of the run, not the end of it.
use super::guard::keeps_copper;
use super::record::{AttemptStages, CoreStage, RouteClaim, WriteStage};
use super::{Args, project::project_of};
use crate::model::text::round_to;
use crate::plan::WidthRule;
use crate::sha256::sha256;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Instant;

/// How a refused admission starts: the compaction stops on it instead of searching on (tools/placer/iotroute-step.ts).
pub const RULE_COVERAGE: &str = "rule coverage refused";

pub struct Steps {
    pub exe: PathBuf,
    tools: PathBuf,
}

/// The last line of a step's output, cut for the summary line.
pub fn last_line(text: &str) -> String {
    text.trim().lines().last().unwrap_or("no output").chars().take(300).collect()
}

/// A command with stdout and stderr in `log`; -> exit code and the log's text.
fn run_logged(mut command: Command, log: &Path) -> Result<(i32, String), String> {
    let file = fs::File::create(log).map_err(|e| format!("{}: {e}", log.display()))?;
    let error = file.try_clone().map_err(|e| format!("{}: {e}", log.display()))?;
    let name = command.get_program().to_string_lossy().into_owned();
    let status = command.stdout(Stdio::from(file)).stderr(Stdio::from(error)).status().map_err(|e| format!("{name}: {e}"))?;
    let text = String::from_utf8_lossy(&fs::read(log).unwrap_or_default()).into_owned();
    Ok((status.code().unwrap_or(-1), text))
}

/// The files that define the binary, relative to the core: Cargo.toml, Cargo.lock and every file below src/, a folder's files
/// before its sorted folders. tools/lib/iotroute-bin.ts walks the same.
fn core_sources(core: &Path) -> Vec<String> {
    fn walk(core: &Path, relative: &str, out: &mut Vec<String>) {
        let mut files = Vec::new();
        let mut folders = Vec::new();
        for entry in fs::read_dir(core.join(relative)).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.path().is_dir() { folders.push(name) } else { files.push(name) }
        }
        files.sort();
        folders.sort();
        out.extend(files.iter().map(|f| format!("{relative}/{f}")));
        for folder in folders {
            walk(core, &format!("{relative}/{folder}"), out);
        }
    }
    let mut out: Vec<String> = ["Cargo.toml", "Cargo.lock"].iter().filter(|n| core.join(n).is_file()).map(|n| n.to_string()).collect();
    walk(core, "src", &mut out);
    out
}

/// The hash of the core sources beside this run, for the record and the checkpoint bind. None when they are not here.
pub fn sources_sha(tools: &Path) -> Option<String> {
    let core = tools.join("router/core");
    let files = core_sources(&core);
    if !files.iter().any(|f| f.starts_with("src/")) {
        return None;
    }
    let mut all = Vec::new();
    for file in files {
        all.extend_from_slice(file.as_bytes());
        all.push(0);
        all.extend(fs::read(core.join(&file)).ok()?);
        all.push(0);
    }
    Some(sha256(&all))
}

/// `ROUTE PASS|FAIL converged B iters N tracks N vias N failed N ...`, the last such line. A `stop X` after it names why it ended.
pub fn parse_route_line(text: &str) -> Option<RouteClaim> {
    let line = text.lines().rev().find_map(claim_of)?;
    let stop = text.lines().rev().filter(|l| l.starts_with("ROUTE ")).find_map(|l| ["stall-passes", "cancelled"].into_iter().find(|s| l.contains(&format!(" stop {s} "))));
    Some(RouteClaim { stop: stop.map(str::to_string), ..line })
}

fn claim_of(line: &str) -> Option<RouteClaim> {
    let words: Vec<&str> = line.split(' ').collect();
    let [_, status, "converged", converged, "iters", iters, "tracks", tracks, "vias", vias, "failed", failed, ..] = words[..] else { return None };
    if words[0] != "ROUTE" || !matches!(status, "PASS" | "FAIL") {
        return None;
    }
    Some(RouteClaim { status: status.to_string(), converged: converged == "true", iters: iters.parse().ok()?, tracks: tracks.parse().ok()?, vias: vias.parse().ok()?, failed: failed.parse().ok()?, stop: None })
}

/// The arguments of the core for one route.
pub fn core_args(a: &Args, model: &Path, route: &Path, work: &Path, extra: &[String], source_sha: Option<&str>) -> Vec<String> {
    let mut args = vec![model.display().to_string(), route.display().to_string(), "--iters".to_string(), a.iters.to_string()];
    if let Some(seconds) = a.max_time {
        args.extend(["--max-time".to_string(), seconds.to_string()]);
    }
    args.extend(extra.iter().cloned());
    // The congestion map (DESIGN.md 5d) is an opt-in side file for the placer repair rank 'hot'; it never changes route.json.
    if a.congestion {
        args.extend(["--congestion".to_string(), work.join("congestion.json").display().to_string(), "--cong-free".to_string(), "1".to_string()]);
    }
    for (flag, value) in [("--seed", a.seed), ("--stall-passes", a.stall_passes)] {
        if let Some(value) = value {
            args.extend([flag.to_string(), value.to_string()]);
        }
    }
    if let Some(cost) = a.via_cost {
        args.extend(["--via-cost".into(), cost.to_string()]);
    }
    if a.checkpoint {
        args.extend(["--checkpoint".to_string(), work.join("checkpoint.json").display().to_string()]);
        if let Some(sha) = source_sha {
            args.extend(["--source-sha".to_string(), sha.to_string()]);
        }
    }
    args
}

impl Steps {
    pub fn new(tools: &Path) -> Result<Steps, String> {
        Ok(Steps { exe: std::env::current_exe().map_err(|e| e.to_string())?, tools: tools.to_path_buf() })
    }

    pub fn model(&self, folder: &Path, pcb: &Path, out: &Path, log: &Path, return_exempt: bool) -> Result<(i32, String), String> {
        let mut command = Command::new(&self.exe);
        command.arg("model").arg(folder).arg("--pcb").arg(pcb).arg("--out").arg(out).arg("--tools").arg(&self.tools);
        if return_exempt {
            command.arg("--return-exempt");
        }
        run_logged(command, log)
    }

    /// `iotroute model` as a route's admission: a board whose rules the router cannot honour stops here, each rule by name.
    pub fn admit(&self, folder: &Path, pcb: &Path, out: &Path, log: &Path, return_exempt: bool) -> Result<String, String> {
        let (code, text) = self.model(folder, pcb, out, log, return_exempt)?;
        refused(code, &text)?;
        Ok(text)
    }

    /// The core, the board's widths rules, then `iotroute write`, then the written board at `out`.
    pub fn route_and_write(&self, a: &Args, model: &Path, route_in: &Path, out: &Path, work: &Path, extra: &[String], widths: &[WidthRule]) -> Result<AttemptStages, String> {
        let route = work.join("route.json");
        let source_sha = if a.checkpoint { sources_sha(&self.tools) } else { None };
        let started = Instant::now();
        let mut core = Command::new(&self.exe);
        core.args(core_args(a, model, &route, work, extra, source_sha.as_deref()));
        let (exit, text) = run_logged(core, &work.join("route.log"))?;
        let claim = parse_route_line(&text);
        if !route.is_file() || claim.is_none() {
            return Err(format!("iotroute wrote no result (exit {exit}), see {}", work.join("route.log").display()));
        }
        let core = CoreStage { exit, seconds: round_to(started.elapsed().as_secs_f64(), 1), claim };
        let write = self.write_route(route_in, &route, out, work, widths)?;
        Ok(AttemptStages { core, write })
    }

    /// Finalize an already computed route using the same width, native writer and copper guards.
    pub fn write_route(&self, route_in: &Path, route: &Path, out: &Path, work: &Path, widths: &[WidthRule]) -> Result<WriteStage, String> {
        super::widths::narrow(&route, widths)?;
        let folder = work.join("write");
        let mut write = Command::new(&self.exe);
        write.arg("write").arg(route_in).arg(&route).arg(&folder);
        let (exit, text) = run_logged(write, &work.join("write.log"))?;
        let written = folder.join(format!("{}.kicad_pcb", project_of(route_in)?));
        if !written.is_file() {
            return Err(format!("iotroute write wrote no board (exit {exit}), see {}", work.join("write.log").display()));
        }
        let read = |path: &Path| fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()));
        keeps_copper(&read(route_in)?, &read(&written)?)?;
        fs::copy(&written, out).map_err(|e| format!("{}: {e}", out.display()))?;
        Ok(WriteStage { exit, line: text.trim().lines().last().unwrap_or("").to_string() })
    }

    /// The gate's planes check itself, this binary with the gate's spec, as tools/gate.mjs runs it. The FAIL lines are the verdict
    /// here, not the difference between exit 0 and 1.
    pub fn planes_check(&self, board: &Path, spec: &Path, log: &Path) -> Result<String, String> {
        let mut command = Command::new(&self.exe);
        command.arg("si-planes").arg(board).arg(spec).arg("--tools").arg(&self.tools);
        let (code, text) = run_logged(command, log)?;
        finished_check(code, text, log)
    }
}

/// The verdict of a model step: `rule coverage refused` names what it refused; another failure gives its last line.
fn refused(code: i32, text: &str) -> Result<(), String> {
    if code == 0 {
        return Ok(());
    }
    let names: Vec<&str> = text.lines().filter_map(|line| line.strip_prefix("REFUSED ")).collect();
    Err(if names.is_empty() { format!("iotroute model failed: {}", last_line(text)) } else { format!("{RULE_COVERAGE}: {}", names.join("; ")) })
}

/// A check that gave no result has no FAIL lines either, so a run must not read that as a pass. si-planes exits 0 or 1 when it ran to
/// its end and 2 when it did not; anything else is a crash or a signal.
fn finished_check(code: i32, text: String, log: &Path) -> Result<String, String> {
    if matches!(code, 0 | 1) {
        return Ok(text);
    }
    Err(format!("the planes check gave no result (exit {code}): {}; see {}", text.trim().lines().last().unwrap_or(""), log.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::parse_args;

    fn args(text: &str) -> Args {
        parse_args(&text.split_whitespace().map(str::to_string).collect::<Vec<_>>()).unwrap()
    }

    fn core(a: &Args) -> Vec<String> {
        core_args(a, Path::new("m.json"), Path::new("r.json"), Path::new("w"), &[], Some("sha"))
    }

    #[test]
    fn a_route_claim_is_read_but_is_not_the_verdict() {
        let text = "iter 1: ...\nROUTE PASS converged true iters 11 tracks 1334 vias 248 failed 0 notes 17 52 s -> x.json\n";
        assert_eq!(parse_route_line(text), Some(RouteClaim { status: "PASS".to_string(), converged: true, iters: 11, tracks: 1334, vias: 248, failed: 0, stop: None }));
        assert_eq!(parse_route_line("thread panicked"), None);
        let stalled = "ROUTE FAIL converged false iters 9 tracks 3 vias 1 failed 2 notes 4 stop stall-passes 6 s -> x.json\n";
        assert_eq!(parse_route_line(stalled).unwrap().stop.as_deref(), Some("stall-passes"));
    }

    #[test]
    fn seed_stall_and_checkpoint_reach_the_core_only_when_asked() {
        assert_eq!(core(&args("B o.kicad_pcb")), ["m.json", "r.json", "--iters", "80"]);
        let all = core(&args("B o.kicad_pcb --seed 0 --stall-passes 12 --checkpoint"));
        assert_eq!(all[4..], ["--seed", "0", "--stall-passes", "12", "--checkpoint", "w/checkpoint.json", "--source-sha", "sha"]);
    }

    #[test]
    fn the_congestion_map_goes_beside_the_route() {
        let a = args("B o.kicad_pcb");
        assert!(!core(&a).contains(&"--congestion".to_string()) || a.congestion);
        let cmd = core(&args("B o.kicad_pcb --congestion"));
        assert_eq!(cmd[4..], ["--congestion", "w/congestion.json", "--cong-free", "1"]);
    }

    #[test]
    fn a_step_keeps_its_exit_and_output() {
        let log = std::env::temp_dir().join(format!("iotroute-step-{}.log", std::process::id()));
        let mut command = Command::new("sh");
        command.args(["-c", "echo out; echo err >&2; exit 3"]);
        let (code, text) = run_logged(command, &log).unwrap();
        fs::remove_file(&log).unwrap();
        assert_eq!(code, 3);
        assert!(text.contains("out") && text.contains("err"));
    }

    #[test]
    fn a_refused_model_names_its_rules() {
        assert_eq!(refused(0, "MODEL ok"), Ok(()));
        assert_eq!(refused(2, "no board"), Err("iotroute model failed: no board".to_string()));
        let text = "REFUSED r / creepage: why\nREFUSED pad U1.1 / layers: names In3.Cu\nMODEL FAIL nets 1\n";
        assert_eq!(refused(1, text), Err("rule coverage refused: r / creepage: why; pad U1.1 / layers: names In3.Cu".to_string()));
    }

    #[test]
    fn a_planes_check_with_no_result_stops_the_run() {
        let log = Path::new("planes.log");
        assert_eq!(finished_check(0, "0 reference-plane failures\n".into(), log).unwrap(), "0 reference-plane failures\n");
        assert_eq!(finished_check(1, "FAIL detour F.Cu /B: x\n".into(), log).unwrap(), "FAIL detour F.Cu /B: x\n");
        let error = finished_check(2, "ERROR the board did not load\n".into(), log).unwrap_err();
        assert!(error.contains("exit 2") && error.contains("the board did not load") && error.contains("planes.log"), "{error}");
        assert!(finished_check(-1, String::new(), log).unwrap_err().contains("exit -1"));
    }

    #[test]
    fn the_sources_sha_walks_files_before_folders() {
        let dir = std::env::temp_dir().join(format!("iotroute-src-{}", std::process::id()));
        fs::create_dir_all(dir.join("router/core/src/a")).unwrap();
        fs::write(dir.join("router/core/Cargo.toml"), "t").unwrap();
        fs::write(dir.join("router/core/src/z.rs"), "z").unwrap();
        fs::write(dir.join("router/core/src/a/b.rs"), "b").unwrap();
        let want = sha256(b"Cargo.toml\0t\0src/z.rs\0z\0src/a/b.rs\0b\0");
        assert_eq!(sources_sha(&dir).as_deref(), Some(want.as_str()));
        fs::remove_dir_all(&dir).unwrap();
        assert_eq!(sources_sha(&dir), None);
    }
}
