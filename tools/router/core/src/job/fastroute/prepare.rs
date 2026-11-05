//! The job up to its first router pass: the folder, the backend policy, the board copy, plane vias, preflight and the net selection.
use super::args::{Args, items};
use super::thermal;
use super::{FailFast, Job, copper, feature_sources, finish, pass, stages};
use crate::gnd_pad_vias::{self, Options as ViaOptions};
use crate::job::backend;
use crate::job::clock::{self, Env};
use crate::job::files::{append_line, atomic_json, digest, digest_if_file};
use crate::job::progress::Progress;
use crate::job::record::{Record, RunRecord};
use crate::job::resources;
use crate::job::stage::{Runner, Spec};
use crate::job::stop::Stop;
use crate::job::uuids;
use crate::kicad::api::{Server, read_board, read_rules};
use crate::kicad::board::Board;
use crate::kicad::rules::DesignRules;
use crate::kicad::save::kicad_cli;
use crate::route_features::{self, Features};
use crate::specctra::dsn_edit::glob;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

fn binary(env: &Env) -> PathBuf {
    env.get("FASTROUTE_BIN").filter(|value| !value.is_empty()).map_or_else(|| Path::new(env.get("HOME").map_or("", String::as_str)).join("opt/fastroute/fastroute-0.1.7-macos-arm64/fastroute"), PathBuf::from)
}

fn fail_fast(feat: &Features) -> FailFast {
    if !route_features::on(feat, "fail_fast") {
        return FailFast { optimizer_if_routed: false, stuck_exit: false, stall_passes: 0 };
    }
    let flag = |key: &str| feat.setting("fail_fast", key).and_then(Value::as_bool).unwrap_or(true);
    FailFast { optimizer_if_routed: flag("optimizer_if_routed"), stuck_exit: flag("stuck_exit"), stall_passes: feat.setting("fail_fast", "stall_passes").and_then(Value::as_u64).unwrap_or(0) }
}

/// The plugin of a board with mandatory preserved-copper rules. They are Python, so the job stops: they must not be skipped.
fn mandatory_plugin(root: &Path, candidates: &[String]) -> Result<Option<String>, Stop> {
    for board in candidates {
        if board.is_empty() || !board.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '-') {
            continue;
        }
        let folder = root.join("hardware-design/boards").join(board);
        let Some(text) = ["gate.json", "gate.pending.json"].iter().find_map(|name| fs::read_to_string(folder.join(name)).ok()) else { continue };
        let config: Value = serde_json::from_str(&text).map_err(|e| Stop::failed(format!("{board} gate.json: {e}")))?;
        let Some(plugin) = config["route_rules"].as_str() else { continue };
        let source = fs::read_to_string(root.join(plugin)).map_err(|e| Stop::failed(format!("route_rules plugin {plugin}: {e}")))?;
        if source.contains("def preserved_input_faults") {
            return Ok(Some(format!("{board}: {plugin}")));
        }
    }
    Ok(None)
}

pub fn via_options(net: &str, via_args: &[String]) -> Result<ViaOptions, String> {
    let mut o = ViaOptions { net: net.to_string(), ..ViaOptions::default() };
    let mut words = crate::tool_args::Args::new(via_args.iter().cloned());
    while let Some(word) = words.next() {
        match word.as_str() {
            "--skip" => o.skip = crate::tool_args::list(&words.value(&word)?).collect(),
            "--r" => o.radius = words.number(&word)?,
            "--width" => o.width = words.number(&word)?,
            "--via" => o.via = (words.number(&word)?, words.number(&word)?),
            "--clearance" => o.clearance = words.number(&word)?,
            "--pth-hole" => o.pth_hole = words.number(&word)?,
            "--in-pad" => o.in_pad = true,
            other => return Err(format!("--via-args: unknown option {other}")),
        }
    }
    Ok(o)
}

/// `shlex.split` of `--via-args`: words, quotes taken off.
pub fn shell_words(text: &str) -> Result<Vec<String>, String> {
    let (mut words, mut word, mut quote, mut open) = (Vec::new(), String::new(), None, false);
    for c in text.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => word.push(c),
            (None, '"' | '\'') => {
                quote = Some(c);
                open = true;
            }
            (None, c) if c.is_whitespace() => {
                if open {
                    words.push(std::mem::take(&mut word));
                    open = false;
                }
            }
            (None, c) => {
                word.push(c);
                open = true;
            }
        }
    }
    if quote.is_some() {
        return Err("--via-args: no closing quotation".into());
    }
    if open {
        words.push(word);
    }
    Ok(words)
}

/// Pads of `gate.json` `plane_via_skip` for a net, merged with a `--skip` of `--via-args`.
fn with_gate_skip(via_args: &[String], pads: &[String]) -> Vec<String> {
    let mut words = via_args.to_vec();
    let mut skip = pads.to_vec();
    if let Some(index) = words.iter().position(|word| word == "--skip") {
        let given: Vec<String> = words.get(index + 1).map_or(Vec::new(), |list| list.split(',').map(str::to_string).collect());
        skip = given.into_iter().chain(skip).collect();
        words.drain(index..(index + 2).min(words.len()));
    }
    words.extend(["--skip".to_string(), skip.join(",")]);
    words
}

fn add_plane_vias(job: &Job, via_skip: &Value) -> Result<(), Stop> {
    job.progress("plane-vias start");
    let via_args = shell_words(&job.a.via_args)?;
    for net in &job.planes {
        let pads: Vec<String> = via_skip[net].as_array().map_or(Vec::new(), |list| list.iter().filter_map(|pad| pad.as_str().map(str::to_string)).collect());
        let words = if pads.is_empty() {
            via_args.clone()
        } else {
            println!("PLANE_VIA_SKIP {net}: {} (gate.json plane_via_skip)", pads.join(" "));
            with_gate_skip(&via_args, &pads)
        };
        let tmp = job.file("planevias.kicad_pcb");
        let options = via_options(net, &words)?;
        let plan = job.runner.phase(&format!("initial-plane-vias:{net}"), job.deadline, || Ok(gnd_pad_vias::run(&job.base, &tmp, &options)?))?;
        let line = gnd_pad_vias::summary(&plan, net);
        append_line(job.file("planevias.log"), &line[0])?;
        if tmp.is_file() {
            fs::rename(&tmp, &job.base).map_err(|e| Stop::failed(format!("{}: {e}", job.base.display())))?;
        }
    }
    job.progress("plane-vias end");
    Ok(())
}

/// The board through the API, with its rules.
pub fn read(path: &Path) -> Result<(Board, DesignRules), String> {
    let read = {
        let (_server, mut client) = Server::start(path)?;
        let board = read_board(&mut client, path).map_err(|e| e.to_string())?;
        let rules = read_rules(&mut client, path).map_err(|e| e.to_string())?;
        (board, rules)
    };
    // The server is gone and leaves its project lock behind: no file of the job.
    if let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) {
        let _ = fs::remove_file(path.with_file_name(format!("~{stem}.kicad_pro.lck")));
    }
    Ok(read)
}

fn preflight(job: &mut Job) -> Result<(), Stop> {
    job.progress("preflight start");
    let check = job.file("preflight.json");
    let drc = finish::native_drc(job, "native-preflight", &job.base.clone(), &check, "preflight failed to produce independent native evidence")?;
    let via_args = shell_words(&job.a.via_args)?;
    let (drc, thermal) = thermal::run(job, &job.base.clone(), &job.board.clone(), drc, &via_args, "preflight-thermal")?;
    job.progress("preflight end");
    atomic_json(&check, &drc)?;
    job.write_json("preflight-thermal.json", &thermal)?;
    job.text = fs::read_to_string(&job.base).map_err(|e| Stop::failed(format!("{}: {e}", job.base.display())))?;
    let faults: Vec<&Value> = drc["violations"].as_array().map_or(Vec::new(), |list| list.iter().filter(|finding| finish::blocks_routing(finding)).collect());
    let note = "opens and router-internal skipped-net findings are not preflight blockers";
    job.write_json("preflight-summary.json", &json!({"board_sha256": digest(&job.base)?, "blocking": faults, "note": note}))?;
    if !faults.is_empty() {
        return Err(Stop::failed(format!("preflight blocked: {} native existing-copper faults; see {}", faults.len(), check.display())));
    }
    Ok(())
}

fn pin_escape(job: &Job, board: &Board, rules: &DesignRules, nets_file: &Path) -> Result<(), Stop> {
    let line = finish::escape_line(job, board, rules, nets_file);
    println!("{line}");
    Ok(())
}

/// The nets the job routes and the patterns it leaves out.
fn select_nets(a: &Args, board: &Board, planes: &[String]) -> Result<(BTreeSet<String>, Vec<String>), Stop> {
    let mut skip = items(&a.skip_net);
    if a.route_planes {
        skip.retain(|pattern| !planes.iter().any(|net| glob(net, pattern)));
    } else {
        skip.extend(planes.iter().cloned());
    }
    let mut nets: BTreeSet<String> = board.nets.keys().filter(|net| !skip.iter().any(|pattern| glob(net, pattern))).cloned().collect();
    if !a.only_nets.is_empty() {
        let want: BTreeSet<String> = items(&a.only_nets).into_iter().collect();
        let missing: Vec<&String> = want.iter().filter(|net| !board.nets.contains_key(*net)).collect();
        if !missing.is_empty() {
            return Err(Stop::failed(format!("fastroute_job: no such net: {}", crate::pytext::repr_list(&missing))));
        }
        nets = want;
    }
    Ok((nets, skip))
}

pub fn run(mut a: Args, cpu: u32, env: Env) -> Result<(), Stop> {
    if a.threads == 0 {
        a.threads = i64::from(cpu);
    }
    let bin = binary(&env);
    if !bin.is_file() {
        return Err(Stop::failed(format!("fastroute_job: binary not found: {} (set FASTROUTE_BIN)", bin.display())));
    }
    let out = PathBuf::from(&a.outdir);
    if out.is_dir() && fs::read_dir(&out).map_err(|e| Stop::failed(e.to_string()))?.next().is_some() {
        return Err(Stop::failed("router output directory is not empty; choose a fresh job directory"));
    }
    fs::create_dir_all(&out).map_err(|e| Stop::failed(format!("{}: {e}", out.display())))?;
    let mut progress = Progress::new(out.join("progress.jsonl"));
    progress.mark("job start");
    let board_path = PathBuf::from(&a.board);
    let tools = route_features::root().join("tools");
    let manifest = a.quality_backend_manifest.clone().map(PathBuf::from);
    let policy = match backend::bind(&bin, manifest.as_deref(), &tools) {
        Ok(policy) => policy,
        Err(error) => {
            atomic_json(out.join("backend-policy.json"), &json!({"mode": "rejected", "reason": error, "qualified": false}))?;
            return Err(Stop::failed(format!("fastroute_job: required quality backend rejected: {error}")));
        }
    };
    atomic_json(out.join("backend-policy.json"), &policy)?;
    let stem = board_path.with_extension("");
    let feat = route_features::load(Some(&board_path), None)?;
    let rules_on = route_features::on(&feat, "routing_rules");
    if a.native_thermal_checkback {
        if rules_on {
            return Err(Stop::failed("native thermal checkback prohibits internal routing/repair stages"));
        }
        return Err(Stop::failed("native thermal checkback needs the result of ZONE_FILLER.Fill, which kicad-cli does not report; no receipt is written"));
    }
    println!("FEATURES {}", route_features::summary(&feat));
    let record = RunRecord::start(&out);
    let on: Vec<&String> = feat.features.keys().filter(|name| route_features::on(&feat, name)).collect();
    record.append(Record::new("job", "configure", "the inputs and feature flags bound at the job start").inputs(json!(a)).evidence("input-manifest.json").result(json!({"features_on": on})))?;
    let fast = fail_fast(&feat);
    if fast.optimizer_if_routed && a.optimizer == "always" {
        a.optimizer = "if-routed".into();
        println!("FAIL_FAST optimizer if-routed: the optimizer runs only when the router leaves 0 open connections");
    }
    let runner = Runner::new(&out, env.clone(), Some(record.clone()))?;
    let mut job = Job {
        out: out.clone(),
        board: board_path.clone(),
        stem: stem.clone(),
        base: out.join("base.kicad_pcb"),
        routed: out.join("routed.kicad_pcb"),
        bin,
        cli: env.get("KICAD_CLI").cloned().unwrap_or_else(kicad_cli),
        runner,
        progress: Arc::new(Mutex::new(progress)),
        record,
        rules_on,
        fail_fast: fast,
        backend: policy,
        text: String::new(),
        was: BTreeMap::new(),
        unlock: items(&a.unlock_nets).into_iter().collect(),
        nets: BTreeSet::new(),
        planes: Vec::new(),
        plane_names: BTreeSet::new(),
        skip: Vec::new(),
        min_um: 0,
        edge_um: 0,
        sources: feature_sources(&feat),
        router_env: BTreeMap::new(),
        deadline: None,
        multi_pass: false,
        solver_launches: Vec::new(),
        native_obligations: Vec::new(),
        feat,
        a,
    };
    start(&mut job, &env)?;
    pass::route_all(&mut job)
}

fn sidecars(stem: &Path) -> BTreeMap<String, String> {
    [".kicad_pro", ".kicad_dru"].iter().filter_map(|ext| digest_if_file(format!("{}{ext}", stem.display())).map(|sha| (ext.to_string(), sha))).collect()
}

fn start(job: &mut Job, env: &Env) -> Result<(), Stop> {
    let board_abs = fs::canonicalize(&job.board).unwrap_or_else(|_| job.board.clone());
    job.write_json("input-manifest.json", &json!({"board": board_abs.display().to_string(), "board_sha256": digest(&job.board)?, "router_sha256": digest(&job.bin)?, "configuration": job.a, "features": job.features_json(), "sidecars": sidecars(&job.stem), "qualified": false}))?;
    let name = job.stem.file_name().and_then(|name| name.to_str()).unwrap_or_default().to_string();
    let declared = env.get("ROUTE_BOARD").cloned().unwrap_or_default();
    if let Some(plugin) = mandatory_plugin(&route_features::root(), &[declared, name])? {
        return Err(Stop::failed(format!("mandatory route rules are Python and cannot run here ({plugin}); the job does not route without them")));
    }
    if job.backend["mode"] == "quality-first" {
        let help = job.runner.run(Spec::new("quality-backend-capability", vec![job.bin.display().to_string(), "--help".into()]).deadline(Some(clock::after(10.0, job.runner.env())?)), |_| ())?;
        let proved = if help.returncode != 0 { Err("quality backend capability probe failed".to_string()) } else { backend::require_capability(&help.stdout) };
        if let Err(error) = proved {
            job.write_json("backend-policy.json", &json!({"mode": "rejected", "reason": error, "qualified": false}))?;
            return Err(Stop::failed(format!("fastroute_job: required quality backend rejected: {error}")));
        }
    }
    for ext in ["kicad_pro", "kicad_dru"] {
        let side = job.stem.with_extension(ext);
        if side.is_file() {
            for name in ["base", "routed"] {
                fs::copy(&side, job.file(&format!("{name}.{ext}"))).map_err(|e| Stop::failed(format!("{}: {e}", side.display())))?;
            }
        }
    }
    job.planes = items(&job.a.plane_nets);
    if job.a.gnd_vias && !job.planes.iter().any(|net| net == "GND") {
        job.planes.insert(0, "GND".into());
    }
    job.plane_names = job.planes.iter().cloned().collect();
    // Duplicate item UUIDs stop the import: the job copy gets deterministic new ones.
    let source = fs::read_to_string(&job.board).map_err(|e| Stop::failed(format!("{}: {e}", job.board.display())))?;
    let (text, rows) = uuids::repair(&source);
    fs::write(&job.base, &text).map_err(|e| Stop::failed(format!("{}: {e}", job.base.display())))?;
    job.write_json("uuid-repair.json", &json!({"replaced": rows.len(), "rows": rows}))?;
    if !rows.is_empty() {
        let list: Vec<String> = rows.iter().map(|row| format!("{} {}", row.kind, row.uuid)).collect();
        println!("UUIDS {} duplicate item UUIDs on the job copy replaced (deterministic; no copper change): {}", rows.len(), list.join(", "));
    }
    let gate = job.feat.board_dir.as_ref().map(|dir| dir.join("gate.json")).filter(|path| path.is_file());
    let gate_json: Value = gate.and_then(|path| fs::read_to_string(path).ok()).and_then(|text| serde_json::from_str(&text).ok()).unwrap_or(Value::Null);
    add_plane_vias(job, &gate_json["plane_via_skip"])?;
    job.text = fs::read_to_string(&job.base).map_err(|e| Stop::failed(format!("{}: {e}", job.base.display())))?;
    if job.a.preflight {
        preflight(job)?;
    }
    for item in copper::read(&job.text)? {
        job.was.insert(item.id.clone(), item.locked);
    }
    let (board, rules) = read(&job.base)?;
    let (nets, skip) = select_nets(&job.a, &board, &job.planes)?;
    job.nets = nets;
    job.skip = skip;
    if route_features::on(&job.feat, "pin_escape_check") {
        let list = pass::nets_file(job)?;
        pin_escape(job, &board, &rules, &list)?;
    }
    if job.unlock.iter().any(|net| !job.nets.contains(net)) {
        return Err(Stop::failed("fastroute_job: skipped nets cannot have unlocked copper"));
    }
    if job.a.set.iter().any(|entry| entry.split('=').next() == Some("router.autorouter.ignore_net_classes")) {
        return Err(Stop::failed("fastroute_job: ignored classes are derived from selected nets"));
    }
    job.min_um = (board.constraints.min_track_width as f64 / 1000.0).round() as i64;
    job.edge_um = (board.constraints.copper_edge_clearance as f64 / 1000.0).round() as i64;
    job.router_env = resources::router_env(job.a.threads as u32, job.runner.env())?;
    job.deadline = match job.a.max_time {
        0 => clock::inherited(job.runner.env())?,
        seconds => Some(clock::after(seconds as f64, job.runner.env())?),
    };
    Ok(())
}

pub(super) use stages::plan as stage_plan;

#[cfg(test)]
mod tests {
    use super::*;

    fn words(text: &[&str]) -> Vec<String> {
        text.iter().map(|word| word.to_string()).collect()
    }

    #[test]
    fn shell_words_split_as_shlex_does() {
        assert_eq!(shell_words("--via 0.5 0.3  --skip 'U1,R7.1' \"a b\"").unwrap(), words(&["--via", "0.5", "0.3", "--skip", "U1,R7.1", "a b"]));
        assert_eq!(shell_words("").unwrap(), Vec::<String>::new());
        assert!(shell_words("--skip 'U1").is_err());
    }

    #[test]
    fn the_gate_skip_list_joins_the_given_one() {
        assert_eq!(with_gate_skip(&words(&["--skip", "U1", "--in-pad"]), &words(&["U22.3"])), words(&["--in-pad", "--skip", "U1,U22.3"]));
        assert_eq!(with_gate_skip(&[], &words(&["U22.3"])), words(&["--skip", "U22.3"]));
    }

    #[test]
    fn via_args_reach_the_options() {
        let o = via_options("GND", &words(&["--via", "0.5", "0.3", "--clearance", "0.15", "--in-pad"])).unwrap();
        assert_eq!((o.net.as_str(), o.via, o.clearance, o.in_pad), ("GND", (0.5, 0.3), 0.15, true));
        assert!(via_options("GND", &words(&["--net", "X"])).is_err());
    }

    #[test]
    fn a_mandatory_plugin_stops_the_job_and_another_plugin_does_not() {
        let root = std::env::temp_dir().join(format!("fastroute-plugin-{}", std::process::id()));
        fs::create_dir_all(root.join("hardware-design/boards/BASE-X")).unwrap();
        fs::create_dir_all(root.join("tools")).unwrap();
        fs::write(root.join("hardware-design/boards/BASE-X/gate.json"), r#"{"route_rules":"tools/x.py"}"#).unwrap();
        fs::write(root.join("tools/x.py"), "def preserved_input_faults(): pass\n").unwrap();
        assert!(mandatory_plugin(&root, &words(&["", "BASE-X"])).unwrap().is_some());
        fs::write(root.join("tools/x.py"), "def other(): pass\n").unwrap();
        assert!(mandatory_plugin(&root, &words(&["BASE-X"])).unwrap().is_none());
        fs::remove_dir_all(root).unwrap();
    }
}
