//! iotplace: the placer search, with no Python in the job.
//!
//!   iotplace run PROB.json -o RES.json [--workers N --epochs 20 --steps 20000 --seed 1 --top 3] [--param k=v ...]
//!   iotplace scramble PROB.json -o OUT.json [--seed 1] [--sigma MM]
//!   iotplace gplace PROB.json -o OUT.json [--param k=v ...]    the analytic stage alone: {pose, history}
//!   iotplace count DRC.json [--nets NETS.txt]                  the open and error counts of a kicad-cli DRC report
//!   iotplace read BOARD.kicad_pcb --board-json DOC.json -o PROB.json [flags]    the problem of a board (read/cli.rs)
//!   iotplace write BOARD.kicad_pcb --board-json DOC.json PROB.json POSE.json -o OUT.kicad_pcb    a pose as a board (write/cli.rs)
//!
//! run: exit 3 when no candidate is legal. Last lines: a cost line per candidate and the speed.

use iotplace::bench::scramble;
use iotplace::drc_count::{Report, count};
use iotplace::gplace::place;
use iotplace::params::Params;
use iotplace::problem::Problem;
use iotplace::evaluator::Evaluator;
use iotplace::model::Model;
use iotplace::problem::Pose;
use iotplace::search::{Candidate, Initial, Plan, SearchResult, optimize_with_preview};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

/// The flags of a command: options with one value, and the words after --param.
#[derive(Default)]
struct Args {
    file: Option<PathBuf>,
    output: Option<PathBuf>,
    options: Vec<(String, String)>,
    params: Vec<String>,
}

const VALUE_OPTIONS: [&str; 13] = ["--workers", "--epochs", "--steps", "--seed", "--top", "--sigma", "--nets", "--pose", "--engineering-frozen-model-sha256", "--native-population", "--snapshot-root", "--pdfinfo", "--pdfinfo-sha256"];

fn parse_args(argv: &[String]) -> iotplace::Result<Args> {
    let mut a = Args::default();
    let mut it = argv.iter().peekable();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "-o" => a.output = it.next().map(PathBuf::from),
            "--param" => {
                while let Some(v) = it.next_if(|v| !v.starts_with("--")) {
                    a.params.push(v.clone());
                }
            }
            flag if VALUE_OPTIONS.contains(&flag) => {
                let value = it.next().ok_or(format!("{flag} needs a value"))?;
                a.options.push((flag.to_string(), value.clone()));
            }
            flag if flag.starts_with('-') => return Err(format!("unknown option {flag}").into()),
            file => a.file = Some(PathBuf::from(file)),
        }
    }
    Ok(a)
}

impl Args {
    fn number<T: std::str::FromStr>(&self, flag: &str, default: T) -> iotplace::Result<T> {
        match self.options.iter().rev().find(|(f, _)| f == flag) {
            Some((_, v)) => v.parse().map_err(|_| format!("{flag}: bad value {v}").into()),
            None => Ok(default),
        }
    }

    fn paths(&self) -> iotplace::Result<(&Path, &Path)> {
        let input = self.file.as_deref().ok_or("a problem file is required")?;
        Ok((input, self.output.as_deref().ok_or("-o is required")?))
    }
}

fn default_workers() -> usize {
    std::thread::available_parallelism().map_or(1, usize::from)
}

fn summary(cost: f64, c: &iotplace::evaluator::Terms) -> String {
    format!("cost {cost:.1} hpwl {:.1} cong {:.1} overlap {:.3} oob {:.3}", c.hpwl, c.cong, c.overlap, c.oob)
}

fn report(initial: &Initial, res: &SearchResult) {
    println!("initial   {}", summary(initial.cost, &initial.components));
    for (k, c) in res.candidates.iter().enumerate() {
        let names = c.illegal.iter().take(8).cloned().collect::<Vec<_>>().join(" ");
        println!("cand{k}     {} illegal {} {names}", summary(c.cost, &c.components), c.illegal.len());
    }
    println!("wall {:.0} s, {:.0} moves/s per worker", res.wall_s, res.moves_per_s_per_worker);
    if res.candidates.iter().any(|c| c.timeout) {
        println!("LEGALIZE TIMEOUT: a candidate is not legal (legalizer time limit). Run more steps or raise legal_time.");
    }
}

fn is_legal(c: &Candidate) -> bool {
    c.illegal.is_empty()
}

fn run(a: &Args) -> iotplace::Result<ExitCode> {
    let (input, output) = a.paths()?;
    if a.options.iter().any(|(f, _)| f == "--engineering-frozen-model-sha256") {
        return Err("digest-only reviewed admission disabled: native source verification is incomplete".into());
    }
    let input_bytes = std::fs::read(input)?;
    let mut pr: Problem = serde_json::from_slice(&input_bytes)?;
    pr.check_supported()?;
    let plan = Plan {
        workers: a.number("--workers", default_workers())?,
        epochs: a.number("--epochs", 20)?,
        steps: a.number("--steps", 20_000)?,
        seed: a.number("--seed", 1)?,
        top: a.number("--top", 3)?,
    };
    let params = Params::from_args(&a.params)?;
    let live = iotplace::live_preview::LivePreview::from_environment(&pr, input, &input_bytes);
    let res = optimize_with_preview(&mut pr, &params, plan, &|line| println!("{line}"),
        &|epoch, epochs, cost, pose| {if let Some(live) = &live {live.publish(epoch,epochs,cost,pose);}})?;
    let mut output_value = serde_json::to_value(&res)?;
    if a.options.iter().any(|(f, _)| f == "--engineering-frozen-model-sha256") {
        output_value["engineering_source_verification"] = Value::from(
            "frozen_model_only; producer must recheck original sources before writing");
    }
    std::fs::write(output, serde_json::to_string(&output_value)?)?;
    report(&res.initial, &res);
    if res.candidates.first().is_none_or(|c| !is_legal(c)) {
        println!("NO LEGAL CANDIDATE");
        return Ok(ExitCode::from(3));
    }
    Ok(ExitCode::SUCCESS)
}

/// A problem copy with seeded start places. The copy keeps every field of the input.
fn scramble_cmd(a: &Args) -> iotplace::Result<ExitCode> {
    let (input, output) = a.paths()?;
    let text = std::fs::read_to_string(input)?;
    let pr: Problem = serde_json::from_str(&text)?;
    let seed = a.number("--seed", 1)?;
    let sigma = a.options.iter().any(|(f, _)| f == "--sigma").then(|| a.number("--sigma", 0.0)).transpose()?;
    let pose = scramble(&pr, seed, sigma);
    let mut copy: Value = serde_json::from_str(&text)?;
    let units = copy["units"].as_array_mut().ok_or("no units")?;
    for (u, (x, y, _)) in units.iter_mut().zip(&pose) {
        (u["x"], u["y"]) = (Value::from(*x), Value::from(*y));
    }
    std::fs::write(output, serde_json::to_string(&copy)?)?;
    let moved = pr.units.iter().filter(|u| !u.fixed).count();
    println!("scrambled {moved} movable units (seed {seed}, sigma {sigma:?})");
    Ok(ExitCode::SUCCESS)
}

fn gplace_cmd(a: &Args) -> iotplace::Result<ExitCode> {
    let (input, output) = a.paths()?;
    let pr = Problem::load(input)?;
    let params = Params::from_args(&a.params)?;
    let (pose, history) = place(&pr, &params, &|line| println!("{line}"));
    std::fs::write(output, serde_json::to_string(&serde_json::json!({ "pose": pose, "history": history }))?)?;
    Ok(ExitCode::SUCCESS)
}

/// Prints the UNROUTED line and the counts as JSON. NETS.txt is a comma list.
fn count_cmd(a: &Args) -> iotplace::Result<ExitCode> {
    let input = a.file.as_deref().ok_or("a DRC report is required")?;
    let report: Report = serde_json::from_str(&std::fs::read_to_string(input)?)?;
    let nets = a.options.iter().rev().find(|(f, _)| f == "--nets").map(|(_, path)| std::fs::read_to_string(path)).transpose()?;
    let nets: Vec<String> = nets.iter().flat_map(|t| t.trim().split(',')).map(String::from).collect();
    let counts = count(&report, &nets);
    println!("{}", counts.line());
    println!("{}", serde_json::to_string(&counts)?);
    Ok(ExitCode::SUCCESS)
}

/// The default proxy cost for the benchmark table, optionally at an explicit pose.
fn cost_cmd(a: &Args) -> iotplace::Result<ExitCode> {
    let input = a.file.as_deref().ok_or("a problem file is required")?;
    let pr = Problem::load(input)?;
    let pose: Pose = match a.options.iter().rev().find(|(f, _)| f == "--pose") {
        Some((_, path)) => serde_json::from_str(&std::fs::read_to_string(path)?)?,
        None => pr.initial_pose(),
    };
    if pose.len() != pr.units.len() || pose.iter().any(|(x, y, r)| !x.is_finite() || !y.is_finite() || *r > 3) {
        return Err("invalid pose: expected one finite [x, y, turn 0..3] per unit".into());
    }
    let params = Params::from_args::<String>(&[])?;
    let model = Model::new(&pr, &params)?;
    let evaluator = Evaluator::new(&model, &params, &pose);
    println!("{}", serde_json::json!({"cost": evaluator.cost(), "components": evaluator.terms()}));
    Ok(ExitCode::SUCCESS)
}

fn dispatch(argv: &[String]) -> iotplace::Result<ExitCode> {
    let (command, rest) = argv.split_first().ok_or("usage: iotplace run|scramble|gplace|count|read ...")?;
    match command.as_str() {
        "read" => return iotplace::read::cli::run(rest).map(|()| ExitCode::SUCCESS),
        "write" => return iotplace::write::cli::run(rest).map(|()| ExitCode::SUCCESS),
        _ => {}
    }
    let args = parse_args(rest)?;
    match command.as_str() {
        "run" => run(&args),
        "scramble" => scramble_cmd(&args),
        "gplace" => gplace_cmd(&args),
        "count" => count_cmd(&args),
        "cost" => cost_cmd(&args),
        "review-preflight" => {
            let input = args.file.as_deref().ok_or("a problem file is required")?;
            let problem: Value = serde_json::from_slice(&std::fs::read(input)?)?;
            let population: Option<Value> = args.options.iter().rev().find(|(f,_)| f == "--native-population")
                .map(|(_, path)| -> iotplace::Result<Value> { Ok(serde_json::from_slice(&std::fs::read(path)?)?) }).transpose()?;
            if let Some((_, root)) = args.options.iter().rev().find(|(f,_)| f == "--snapshot-root") {
                let tool = args.options.iter().rev().find(|(f,_)| f == "--pdfinfo").map(|(_,v)| v.as_str());
                let hash = args.options.iter().rev().find(|(f,_)| f == "--pdfinfo-sha256").map(|(_,v)| v.as_str());
                let inspector = match (tool,hash) {
                    (Some(t),Some(h)) => Some((Path::new(t),h)),
                    (None,None) => None,
                    _ => return Err("--pdfinfo and --pdfinfo-sha256 must be supplied together".into()),
                };
                iotplace::source_preflight::preflight_snapshot_with_pdf(&problem, Path::new(root), population.as_ref(), inspector)?;
            } else if args.options.iter().any(|(f,_)| f == "--pdfinfo" || f == "--pdfinfo-sha256") {
                return Err("PDF inspection requires --snapshot-root".into());
            } else if let Some(population) = &population {
                iotplace::source_preflight::preflight_with_native(&problem, population)?;
            } else {
                iotplace::source_preflight::preflight(&problem)?;
            }
            println!("preflight passed; reviewed source verification is incomplete; search and write remain blocked");
            Ok(ExitCode::from(3))
        },
        other => Err(format!("unknown command {other}").into()),
    }
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    dispatch(&argv).unwrap_or_else(|e| {
        eprintln!("iotplace: {e}");
        ExitCode::FAILURE
    })
}
