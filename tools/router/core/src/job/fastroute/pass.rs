//! Router passes: the DSN of the board as it is now, admission, the solver, and the session back onto the board text.
use super::args::items;
use super::stages::{Extra, Pass, Rules, project_classes};
use super::{Job, NOT_VERIFIED, copper, finish, prepare};
use crate::job::clock;
use crate::job::files::{atomic_json, digest, unix_time};
use crate::job::snapshots::{self, Source};
use crate::job::stage::Spec;
use crate::job::stop::Stop;
use crate::job::watch::{self, Owner};
use crate::kicad::board::{Board, RoutedCopper};
use crate::kicad::geom::{Polygon, to_mm};
use crate::kicad::pad::{Pad, PadKind};
use crate::kicad::raw;
use crate::kicad::save::WorkDir;
use crate::model::num::short_float;
use crate::pytext::{Separators, dumps};
use crate::route_features::{self, dsn_classes, halo_nets, learned_halo, strengthen_project_clearance};
use crate::routing_rules::geometry::{Copper as RepairCopper, Fills, Unrouted, add_keepouts, layer_keepouts, repair_selection};
use crate::routing_rules::stages::exempt;
use crate::routing_rules::{Disc, Rings, matches as net_matches};
use crate::rule_coverage::{CheckRequest, RouteCoverageTool, RouteScope, check_files};
use crate::sha256::sha256;
use crate::specctra::dsn_edit::{Pair, big_signal_via, pairs_text, restrict_dsn};
use crate::specctra::export::{Throwaway, with_locks};
use crate::specctra::import::{Session, existing_copper, import};
use crate::specctra::kicad10::Unchained;
use crate::specctra::pose;
use crate::specctra::skip::{exclude, routable_open};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// What a pass hands on.
pub struct Done {
    pub report: Value,
    pub imported_vias: usize,
    pub left_open: BTreeSet<String>,
    pub row: Value,
}

fn suffix(tag: &str) -> String {
    if matches!(tag, "all" | "final") { String::new() } else { format!("-{}", tag.replace(':', "_").replace('/', "")) }
}

pub fn nets_file(job: &Job) -> Result<PathBuf, Stop> {
    let path = job.file("routed-nets.txt");
    let list: Vec<&str> = job.nets.iter().map(String::as_str).collect();
    fs::write(&path, format!("{}\n", list.join("\n"))).map_err(|e| Stop::failed(format!("{}: {e}", path.display())))?;
    Ok(path)
}

fn read_json(path: &Path) -> Result<Value, Stop> {
    let text = fs::read_to_string(path).map_err(|e| Stop::failed(format!("{}: {e}", path.display())))?;
    serde_json::from_str(&text).map_err(|e| Stop::failed(format!("{}: {e}", path.display())))
}

fn absolute(path: &Path) -> String {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf()).display().to_string()
}

/// The primary copper layer of a pad, as PAD::GetLayerName.
fn pad_layer(pad: &Pad) -> &str {
    pad.layers.iter().find(|layer| layer.ends_with(".Cu")).map_or("", String::as_str)
}

fn rings(polygon: &Polygon) -> Rings {
    polygon.rings().map(|ring| ring.iter().map(|point| [to_mm(point.x), to_mm(point.y)]).collect()).collect()
}

/// Rule 3: the refilled planes of the board as it is now become wire keepouts on each adjacent signal layer. Pads and vias of other
/// nets keep a disc open (their antipad in the plane): radius + margin, disc_margin_mm above the 0.25 mm plane clearance and never
/// above via_allow_mm. A reference-net pad or via makes no void in its own plane, so it opens nothing.
fn stage_keepouts(job: &Job, rules: &Rules, stage_nets: &BTreeSet<String>) -> Result<crate::routing_rules::Keepouts, Stop> {
    let setting = |key: &str, fallback: f64| job.feat.setting("routing_rules", key).and_then(Value::as_f64).unwrap_or(fallback);
    let via_allow = rules.info.spec.extra.get("via_allow_mm").and_then(Value::as_f64).unwrap_or(0.6);
    let allow = via_allow.min(setting("disc_margin_mm", 0.35));
    let refs = rules.info.spec.ref_nets(false);
    let work = WorkDir::beside(&job.base, "keepouts")?;
    let saved = finish::fill_save(job, "keepout-fill", &job.text, &work.0, "keepouts")?;
    let (board, _) = prepare::read(&saved)?;
    let outline: Rings = board.outlines.iter().flat_map(rings).collect();
    let mut fills: Fills = BTreeMap::new();
    for zone in board.zones.iter().filter(|zone| zone.rule_area.is_none()) {
        for filled in &zone.filled {
            fills.entry(filled.layer.clone()).or_default().extend(filled.polygons.iter().map(|polygon| (zone.net.clone(), rings(polygon))));
        }
    }
    let layers = job.a.layer_list();
    let mut discs: BTreeMap<String, Vec<Disc>> = layers.iter().map(|layer| (layer.clone(), Vec::new())).collect();
    for (_, pad) in board.pads().filter(|(_, pad)| !refs.contains(&pad.net)) {
        let radius = to_mm((pad.bbox.right - pad.bbox.left).max(pad.bbox.bottom - pad.bbox.top)) / 2.0 + allow;
        for layer in layers.iter().filter(|layer| pad.layers.contains(*layer)) {
            discs.entry(layer.clone()).or_default().push([to_mm(pad.position.x), to_mm(pad.position.y), radius]);
        }
    }
    for via in board.vias().filter(|via| !refs.contains(&via.net)) {
        for layer in &layers {
            discs.entry(layer.clone()).or_default().push([to_mm(via.at.x), to_mm(via.at.y), to_mm(via.size) / 2.0 + allow]);
        }
    }
    let fast = stage_nets.iter().any(|net| net_matches(net, &rules.info.fast));
    Ok(layer_keepouts(&rules.info.spec, &layers, &outline, &fills, &discs, setting("keepout_grid_mm", 0.1), fast)?)
}

/// The rule compiler, or the layer masks of the pass alone.
fn apply_masks(job: &Job, board: &Board, mut text: String, net_class: &BTreeMap<String, String>, extra: &Extra) -> Result<String, Stop> {
    if !route_features::on(&job.feat, "rule_compiler") {
        if !extra.masks.is_empty() {
            text = route_features::apply_layer_masks(&text, &extra.masks);
            route_features::verify_layer_masks(&text, &extra.masks)?;
        }
        return Ok(text);
    }
    let mut pad_layers: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (_, pad) in board.pads() {
        let layer = if pad.drill.x != 0 { "*" } else { pad_layer(pad) };
        pad_layers.entry(pad.net.clone()).or_default().insert(layer.to_string());
    }
    let dru = fs::read_to_string(job.stem.with_extension("kicad_dru")).unwrap_or_default();
    let extra_rules: Vec<route_features::ExtraRule> = job.feat.setting("rule_compiler", "extra").cloned().map_or(Ok(Vec::new()), serde_json::from_value).map_err(|e| Stop::failed(format!("rule_compiler extra: {e}")))?;
    let nets: Vec<String> = job.nets.iter().cloned().collect();
    let compiled = route_features::compile_dru(&dru, &nets, net_class, &pad_layers, &job.a.layer_list(), &extra_rules)?;
    text = route_features::apply_layer_masks(&text, &compiled.masks);
    route_features::verify_layer_masks(&text, &compiled.masks)?;
    let class_class = job.feat.setting("rule_compiler", "class_class").and_then(Value::as_bool).unwrap_or(true);
    if class_class {
        text = route_features::add_class_class(&text, &compiled.pairs);
    }
    let mut log = format!("{}\n", compiled.notes.join("\n"));
    compiled.masks.iter().for_each(|(net, layers)| log.push_str(&format!("mask {net}: {}\n", layers.join(" "))));
    compiled.pairs.iter().for_each(|((a, b), value)| log.push_str(&format!("class_class {a} {b}: {} mm\n", short_float(*value))));
    fs::write(job.file("rules.log"), log).map_err(|e| Stop::failed(e.to_string()))?;
    println!("RULES masks {} class_class {} notes {} (see rules.log)", compiled.masks.len(), if class_class { compiled.pairs.len() } else { 0 }, compiled.notes.len());
    Ok(text)
}

fn via_keepouts(job: &Job, board: &Board, text: String) -> String {
    let limit = job.feat.setting("via_off_small_pads", "max_pad_mm").and_then(Value::as_f64).unwrap_or(2.0);
    let layers = job.a.layer_list();
    let mut polygons = Vec::new();
    for (_, pad) in board.pads() {
        let layer = pad_layer(pad);
        let (width, height) = (to_mm(pad.bbox.right - pad.bbox.left), to_mm(pad.bbox.bottom - pad.bbox.top));
        if pad.drill.x != 0 || !layers.iter().any(|name| name == layer) || width.min(height) >= limit {
            continue;
        }
        if let Some(polygon) = pad.polygons.get(layer) {
            polygons.push((layer.to_string(), polygon.outline.iter().map(|point| [to_mm(point.x), to_mm(point.y)]).collect()));
        }
    }
    println!("VIAKEEP {} SMD pads below {} mm", polygons.len(), short_float(limit));
    route_features::add_via_keepouts(&text, &polygons)
}

/// The nets, item types and pad types of the board: what admission must find a rule for.
fn obstacles(board: &Board) -> Vec<crate::rule_coverage::Obstacle> {
    let mut set: BTreeSet<(String, String, String)> = BTreeSet::new();
    for (_, pad) in board.pads() {
        let kind = match pad.kind {
            PadKind::Smd => "SMD",
            PadKind::NpThroughHole => "NPTH, mechanical",
            _ => "Through-hole",
        };
        set.insert((pad.net.clone(), "Pad".into(), kind.into()));
    }
    for item in &board.copper {
        match item {
            RoutedCopper::Via(via) => set.insert((via.net.clone(), "Via".into(), String::new())),
            RoutedCopper::Track(track) => set.insert((track.net.clone(), "Track".into(), String::new())),
        };
    }
    for zone in &board.zones {
        set.insert((zone.net.clone(), "Zone".into(), String::new()));
    }
    set.into_iter().map(|(net_name, kind, pad_type)| crate::rule_coverage::Obstacle { net_name, kind, pad_type: Some(pad_type) }).collect()
}

fn blocked(job: &Job, tag: &str, coverage_path: &Path, coverage: &Value) -> Stop {
    let cause = coverage["cause"].as_str().unwrap_or_default();
    job.progress(&format!("rule coverage blocked: {cause}"));
    let digest_now = digest(coverage_path).ok();
    let outcome = json!({"status": "blocked", "cause": format!("router rule coverage: {cause}"), "coverage": coverage_path.display().to_string(), "coverage_sha256": digest_now, "blocked_stage": tag, "stage_solver_launched": false, "solver_launched": !job.solver_launches.is_empty(), "qualified": false});
    if let Err(error) = job.write_json("outcome.json", &outcome) {
        return error;
    }
    println!("STUCK router rule coverage: {cause}; see {}", coverage_path.display());
    Stop::code(NOT_VERIFIED)
}

/// The project's clearance floor on the model. The exact text before and after is retained; the project is never written.
fn strengthen(job: &Job, text: &str, before: &Path, model: &Path, receipt: &Path, scope: &RouteScope) -> Result<(String, Value), String> {
    fs::write(before, text).map_err(|e| format!("{}: {e}", before.display()))?;
    let project = job.stem.with_extension("kicad_pro");
    let source = absolute(&project);
    let bytes = fs::read(&project).map_err(|e| format!("{source}: {e}"))?;
    let project_text = String::from_utf8(bytes).map_err(|e| format!("{source}: {e}"))?;
    let (strengthened, derived) = strengthen_project_clearance(text, &project_text, &source, scope)?;
    let mut report = serde_json::to_value(&derived).map_err(|e| e.to_string())?;
    if digest(before)? != derived.before_sha256 {
        return Err("pre-strengthening DSN changed during clearance strengthening".into());
    }
    if digest(&project)? != derived.project.sha256 {
        return Err("authored project changed during clearance strengthening".into());
    }
    report["before"] = json!({"path": absolute(before), "sha256": derived.before_sha256});
    report["after"] = json!({"path": absolute(model), "sha256": derived.after_sha256});
    report["inputs"] = json!({absolute(before): derived.before_sha256, source: derived.project.sha256});
    atomic_json(receipt, &report)?;
    Ok((strengthened, report))
}

/// The router's command line, complete: admission binds it.
fn command(job: &Job, model: &Path, ses: &Path, rep: &Path, ignored: &[String], extra: &Extra, pairs: Option<&Path>) -> Result<Vec<String>, Stop> {
    let mut cmd = vec![job.bin.display().to_string(), "-de".into(), model.display().to_string(), "-do".into(), ses.display().to_string(), "-mp".into(), job.a.passes.to_string(), format!("--router.min_trace_width_um={}", job.min_um), format!("--router.copper_to_edge_clearance_um={}", job.edge_um), format!("--report={}", rep.display())];
    cmd.extend(job.a.set.iter().map(|entry| format!("--{entry}")));
    if job.rules_on && !job.a.set.iter().any(|entry| entry.split('=').next() == Some("router.scoring.via_costs")) {
        // Rule 2: a layer change costs much more than Freerouting's default (50). A caller's own --set wins.
        let costs = extra.via_costs.unwrap_or_else(|| job.feat.setting("routing_rules", "via_costs").and_then(Value::as_i64).unwrap_or(300));
        cmd.push(format!("--router.scoring.via_costs={costs}"));
    }
    cmd.extend(extra.flags.iter().cloned());
    if !ignored.is_empty() {
        cmd.push(format!("--router.autorouter.ignore_net_classes={}", ignored.join(",")));
    }
    if job.a.neck_um != 0 {
        cmd.push(format!("--router.neck_width_um={}", job.a.neck_um));
    }
    if job.backend["mode"] == "quality-first" {
        cmd.push("--quality-first".into());
    }
    if let Some(pairs) = pairs {
        cmd.push(format!("--pairs={}", pairs.display()));
    }
    if job.a.max_time != 0 {
        let mut left = if job.multi_pass { clock::remaining(job.deadline).unwrap_or(job.a.max_time as f64) } else { job.a.max_time as f64 };
        if let Some(limit) = extra.max_time {
            left = left.min(limit as f64);
        }
        cmd.push(format!("--max-time={}", (left as i64).max(1)));
    }
    if job.a.optimizer != "always" {
        cmd.push("--router.optimizer.enabled=false".into());
    }
    if job.a.threads != 0 {
        cmd.extend([format!("--router.autorouter.max_threads={}", job.a.threads), format!("--router.optimizer.max_threads={}", job.a.threads)]);
    }
    Ok(cmd)
}

fn pairs_file(job: &Job, stage_nets: &BTreeSet<String>, board: &Board, sfx: &str) -> Result<Option<PathBuf>, Stop> {
    let path = Path::new(&job.a.pairs_json);
    if job.a.pairs_json.is_empty() || !path.is_file() {
        return Ok(None);
    }
    // A pair that has copper on the board already (kept block copper) is not given to the pair router.
    let with_copper: BTreeSet<&str> = board.tracks().map(|track| track.net.as_str()).collect();
    let nets: BTreeSet<String> = stage_nets.iter().filter(|net| !with_copper.contains(net.as_str())).cloned().collect();
    let pairs: Vec<Pair> = serde_json::from_value(read_json(path)?["pairs"].clone()).unwrap_or_default();
    let dru = fs::read_to_string(job.stem.with_extension("kicad_dru")).unwrap_or_default();
    let Some(text) = pairs_text(&pairs, &dru, &nets) else { return Ok(None) };
    let out = job.file(&format!("pairs{sfx}.txt"));
    fs::write(&out, text).map_err(|e| Stop::failed(e.to_string()))?;
    Ok(Some(out))
}

fn bad(report: &Value) -> Result<(i64, i64), Stop> {
    let stat = |key: &str| report["stats"][key].as_i64().unwrap_or(0);
    Ok((stat("violations") - stat("violations_unfixable"), routable_open(report)?))
}

/// Polish only a routed board, and never trade a rule for track length: on AC-24V the optimizer moved mains tracks into the 3 mm
/// clearance at J1 where the screen result had none, so a result with more fixable violations or opens is thrown away.
fn optimize(job: &Job, cmd: &[String], ses: &Path, rep: &Path, sfx: &str) -> Result<i32, Stop> {
    let screen = read_json(rep)?;
    if routable_open(&screen)? != 0 {
        println!("OPTIMIZER deferred: screening result still has open connections");
        return Ok(0);
    }
    let checkpoint = job.file(&format!("screen{sfx}.ses"));
    let screen_report = job.file(&format!("screen-report{sfx}.json"));
    fs::copy(ses, &checkpoint).map_err(|e| Stop::failed(e.to_string()))?;
    fs::copy(rep, &screen_report).map_err(|e| Stop::failed(e.to_string()))?;
    let mut polish: Vec<String> = cmd.iter().filter(|word| !word.starts_with("--router.optimizer.enabled=") && !word.starts_with("--max-time=")).cloned().collect();
    polish.extend(["--router.optimizer.enabled=true".to_string(), format!("--initial-session={}", checkpoint.display())]);
    if let Some(left) = clock::remaining(job.deadline) {
        polish.push(format!("--max-time={}", (left as i64).max(1)));
    }
    let log = job.file(&format!("optimize{sfx}.log"));
    let code = job.runner.run(Spec::new(format!("router-optimize{sfx}"), polish).deadline(job.deadline).env(&job.router_env).logged(&log), |_| ())?.returncode;
    if code == 0 && rep.is_file() {
        let (now, before) = (bad(&read_json(rep)?)?, bad(&screen)?);
        if now.0 > before.0 || now.1 > before.1 {
            println!("OPTIMIZER rejected: violations/opens ({}, {}) > screen ({}, {}); the screen result is kept", now.0, now.1, before.0, before.1);
            fs::copy(&checkpoint, ses).map_err(|e| Stop::failed(e.to_string()))?;
            fs::copy(&screen_report, rep).map_err(|e| Stop::failed(e.to_string()))?;
        }
    }
    Ok(code)
}

fn solve(job: &mut Job, tag: &str, sfx: &str, cmd: &[String], model: &Path, ses: &Path, rep: &Path) -> Result<(), Stop> {
    let stall_passes = job.fail_fast.stall_passes;
    let log = job.file(&format!("run{sfx}.log"));
    let owner: Owner = Arc::new(Mutex::new(None));
    let stage_name = format!("route{sfx}");
    job.progress(&format!("{stage_name} start"));
    let mut watcher = watch::Watcher::start(log.clone(), stall_passes, owner.clone(), job.progress.clone(), stage_name.clone());
    let source = Source { ses: ses.to_path_buf(), outdir: job.out.clone(), log: log.clone(), stage: stage_name.clone(), t0: job.record.t0(), dsn: model.to_path_buf() };
    let mut snapshot = snapshots::Watcher::start(source, job.a.snapshot_interval_s);
    let stage = format!("{}{sfx}", if job.a.optimizer != "always" { "router-screen" } else { "router" });
    let started = owner.clone();
    let run = job.runner.run(Spec::new(stage, cmd.to_vec()).deadline(job.deadline).env(&job.router_env).logged(&log), move |running| {
        *started.lock().unwrap_or_else(|poison| poison.into_inner()) = Some(running);
    });
    if owner.lock().unwrap_or_else(|poison| poison.into_inner()).is_some() {
        job.solver_launches.push(tag.to_string());
    }
    let stalled = watcher.stop();
    let snapped = snapshot.stop();
    let mut code = None;
    let outcome = run.map(|finished| code = Some(finished.returncode));
    let errors: Vec<String> = [stalled.as_ref().err().cloned(), snapped.err()].into_iter().flatten().collect();
    if let Ok(Some(stall)) = &stalled {
        let path = job.file(&format!("stall{sfx}.json"));
        let mut value = serde_json::to_value(stall).map_err(|e| Stop::failed(e.to_string()))?;
        value["stall_passes"] = json!(stall_passes);
        value["stage"] = json!(tag);
        value["observer_cleanup"] = json!({"complete": errors.is_empty(), "errors": errors});
        atomic_json(&path, &value)?;
        println!("STALL interrupt attempt at pass {} (acknowledged={}): {stall_passes} passes without a lower open count (best {}, last {}); see {}", stall.pass_no, stall.interrupt_acknowledged.map_or("None".to_string(), |ack| if ack { "True".into() } else { "False".into() }), stall.best, stall.unrouted, path.display());
    }
    // An observer error must never replace the real timeout or cancellation.
    outcome?;
    if !errors.is_empty() {
        return Err(Stop::failed(format!("router observer cleanup/evidence failed: {}", errors.join("; "))));
    }
    job.progress(&format!("{stage_name} end"));
    let mut code = code.unwrap_or(1);
    if code == 0 && job.a.optimizer == "if-routed" && rep.is_file() && ses.is_file() {
        code = optimize(job, cmd, ses, rep, sfx)?;
    }
    if code != 0 || !ses.is_file() || !rep.is_file() {
        return Err(Stop::failed(format!("fastroute_job: fastroute failed (rc {code}), see {}/run{sfx}.log", job.a.outdir)));
    }
    Ok(())
}

/// The vias of `ids` at their class size, in the text.
fn resize_vias(text: &str, sizes: &BTreeMap<String, (f64, f64)>) -> Result<String, String> {
    let root = raw::parse_first(text).map_err(|error| format!("board text: {error}"))?;
    let (mut out, mut at) = (String::with_capacity(text.len()), 0);
    for form in root.items().iter().filter(|form| form.is("via")) {
        let Some((size, drill)) = form.children("uuid").next().and_then(|uuid| uuid.text(1)).and_then(|id| sizes.get(id)) else { continue };
        for (head, value) in [("size", size), ("drill", drill)] {
            let field = form.children(head).next().ok_or("a via has no size")?;
            out.push_str(&text[at..field.span.start]);
            out.push_str(&format!("({head} {})", short_float(*value)));
            at = field.span.end;
        }
    }
    out.push_str(&text[at..]);
    Ok(out)
}

/// The routing padstack back to the class via size.
fn normalize_signal_vias(job: &mut Job, board: &Board, before: &BTreeSet<copper::Key>, stage_nets: &BTreeSet<String>) -> Result<(), Stop> {
    let (classes, _) = project_classes(&job.stem.with_extension("kicad_pro"));
    let size = |class: &Value| (class["via_diameter"].as_f64().unwrap_or(0.0), class["via_drill"].as_f64().unwrap_or(0.0));
    let by_name: BTreeMap<&str, (f64, f64)> = classes.iter().filter_map(|class| Some((class["name"].as_str()?, size(class)))).collect();
    let threshold = (job.a.signal_via * 1e6) as i64 - 1000;
    let mut resized = BTreeMap::new();
    for item in copper::read(&job.text)?.iter().filter(|item| item.is_via() && stage_nets.contains(&item.net) && !before.contains(&item.key()) && item.width > threshold) {
        let class = board.nets.get(&item.net).map_or("Default", String::as_str);
        let sizes = by_name.get(class).or_else(|| by_name.get("Default")).ok_or("the project has no Default class")?;
        resized.insert(item.id.clone(), *sizes);
    }
    job.text = resize_vias(&job.text, &resized)?;
    println!("fastroute_job: {} signal vias routed with the {} mm padstack, set to the class size", resized.len(), short_float(job.a.signal_via));
    Ok(())
}

fn number_stat(report: &Value, key: &str) -> i64 {
    report["stats"][key].as_i64().unwrap_or(0)
}

fn import_session(job: &mut Job, tag: &str, sfx: &str, board: &Board, locked: &BTreeSet<String>, stage_nets: &BTreeSet<String>, dsn: &Path, ses: &Path, seconds_from: f64, n_keep: usize) -> Result<(usize, Value, BTreeSet<String>, Value), Stop> {
    let report = read_json(&job.file(&format!("report{sfx}.json")))?;
    let before = copper::keys(&copper::read(&job.text)?);
    let existing = existing_copper(board);
    let dsn_text = fs::read_to_string(dsn).map_err(|e| Stop::failed(e.to_string()))?;
    let ses_text = fs::read_to_string(ses).map_err(|e| Stop::failed(e.to_string()))?;
    let integrity = |error: String| Stop::failed(format!("fastroute_job: SES pose integrity failed; result is not verified: {error}"));
    let footprints: Vec<(String, (i64, i64))> = board.footprints.iter().map(|part| (part.reference.clone(), (part.position.x, part.position.y))).collect();
    let grid = pose::check(&footprints, &dsn_text, &ses_text).map_err(integrity)?;
    job.progress(&format!("import{sfx} start"));
    // The board text is in the seed: the route run has one job per stage, and stage tags alone would repeat uuids between them.
    let seed = format!("{}:{tag}", sha256(job.text.as_bytes()));
    let session = Session { board_text: &job.text, copper: &existing, preserved: locked, dsn: &dsn_text, ses: &ses_text, seed: &seed };
    let imported = import(&session).map_err(integrity)?;
    if !imported.duplicates.is_empty() {
        println!("fastroute_job: {} duplicate new segments removed (identical copper), stage {tag}", imported.duplicates.len());
    }
    if !imported.short.is_empty() {
        println!("fastroute_job: {} new segments shorter than 1 um removed (no copper), stage {tag}", imported.short.len());
    }
    let (dsn_sha, ses_sha) = (digest(dsn)?, digest(ses)?);
    job.write_json(&format!("import-pose-audit{sfx}.json"), &json!({"grid_nm": grid, "restored": [], "exact_poses_and_pads": true, "method": "the session is added to the board text and its placement checked: footprints are not touched", "dsn_sha256": dsn_sha, "ses_sha256": ses_sha, "qualified": false, "independent_native_gate_required": true}))?;
    job.write_json(&format!("import-replay-audit{sfx}.json"), &json!({"removed": imported.replays, "preserved_uuids": locked, "duplicate_new_segments_removed": imported.duplicates, "sub_um_new_segments_removed": imported.short, "exact_preserved_source_policy": true, "qualified": false, "independent_native_gate_required": true, "dsn_sha256": dsn_sha, "ses_sha256": ses_sha}))?;
    job.text = imported.text;
    let after = copper::read(&job.text)?;
    {
        let mut progress = job.progress.lock().unwrap_or_else(|poison| poison.into_inner());
        progress.with_vias(&format!("import{sfx} end"), copper::vias(&after) as u64);
    }
    // Excluded-net copper went to the router locked and the import keeps it; new copper there is the router's own doing.
    if after.iter().any(|item| !stage_nets.contains(&item.net) && !before.contains(&item.key())) {
        return Err(Stop::failed("fastroute_job: router changed excluded-net copper; result is not verified"));
    }
    if job.a.signal_via != 0.0 {
        normalize_signal_vias(job, board, &before, stage_nets)?;
    }
    let imported_vias = copper::vias(&copper::read(&job.text)?);
    let (unrouted, vias) = (number_stat(&report, "unrouted"), number_stat(&report, "vias"));
    let seconds = clock::now() - seconds_from;
    if tag != "all" {
        println!("STAGE {tag} nets {} keepouts {n_keep} ROUTER_UNROUTED {unrouted} VIAS {vias} SECONDS {}", stage_nets.len(), seconds as i64);
    }
    let list = report["unrouted"].as_array().cloned().unwrap_or_default();
    let left_open: BTreeSet<String> = list.iter().filter_map(|row| row["net"].as_str()).filter(|net| stage_nets.contains(*net)).map(str::to_string).collect();
    let row = json!({"stage": tag, "nets": stage_nets.len(), "keepouts": n_keep, "router_unrouted": unrouted, "vias": vias, "seconds": crate::job::files::rounded(seconds, 1)});
    Ok((imported_vias, report, left_open, row))
}

/// One router run over `stage_nets`; the other nets are ignored classes and existing copper stays locked. `rip`: nets whose copper
/// of this job is unlocked too (the repair pass).
fn route_pass(job: &mut Job, rules: Option<&Rules>, tag: &str, stage_nets: &BTreeSet<String>, keep: bool, rip: &BTreeSet<String>, extra: &Extra) -> Result<Done, Stop> {
    let sfx = suffix(tag);
    let free: BTreeSet<&String> = job.unlock.iter().chain(rip.iter()).filter(|net| stage_nets.contains(*net)).collect();
    let mut locked = BTreeSet::new();
    for item in copper::read(&job.text)? {
        // --unlock-nets: this copper goes to the router as normal wiring. Copper of an earlier stage is locked unless its net is ripped.
        let lock = match job.was.get(&item.id) {
            None => !rip.contains(&item.net),
            Some(was) => *was || !free.contains(&item.net),
        };
        if lock {
            locked.insert(item.id);
        }
    }
    let (dsn, ses, rep) = (job.file(&format!("board{sfx}.dsn")), job.file(&format!("board{sfx}.ses")), job.file(&format!("report{sfx}.json")));
    let throwaway = Throwaway::new(&job.base, &job.out.join("export"))?;
    let own: Vec<Unchained> = copper::read(&job.text)?.iter().filter(|item| item.kind == copper::Kind::Track && !job.was.contains_key(&item.id)).map(|item| Unchained::of_track(&item.layer, item.start, item.end)).collect();
    let board = throwaway.read(&with_locks(&job.text, &locked)?, Some(&dsn), &own).map_err(|error| Stop::failed(format!("fastroute_job: DSN export failed: {error}")))?;
    let layers = job.a.layer_list();
    let layer_set: BTreeSet<String> = job.a.layers.split(',').map(str::to_string).collect();
    let exported = fs::read_to_string(&dsn).map_err(|e| Stop::failed(e.to_string()))?;
    // Keep electrical membership: exclusions are applied as dedicated router classes after the rule and padstack edits below.
    let mut text = restrict_dsn(&exported, &layer_set, None);
    let net_class = dsn_classes(&text);
    let net_list: Vec<String> = job.nets.iter().cloned().collect();
    if route_features::on(&job.feat, "via_halo") {
        // The selected nets get the larger via padstack: room for an RP-001 via.
        let mut halo: BTreeSet<String> = halo_nets(&job.feat, &net_list, &net_class, job.feat.board_dir.as_deref(), Some(&job.board))?.into_iter().collect();
        if job.a.signal_via != 0.0 && !job.a.signal_via_nets.is_empty() {
            halo.extend(items(&job.a.signal_via_nets));
        }
        if !halo.is_empty() {
            if job.a.signal_via == 0.0 {
                job.a.signal_via = job.feat.setting("via_halo", "size_mm").and_then(Value::as_f64).unwrap_or(1.8);
            }
            job.a.signal_via_nets = halo.iter().cloned().collect::<Vec<_>>().join(",");
        }
        println!("VIA_HALO {} nets, {} mm", halo.len(), short_float(job.a.signal_via));
    }
    if job.a.signal_via != 0.0 {
        text = big_signal_via(&text, job.a.signal_via, &items(&job.a.signal_via_classes), &items(&job.a.signal_via_nets))?;
    }
    text = apply_masks(job, &board, text, &net_class, extra)?;
    if route_features::on(&job.feat, "via_off_small_pads") {
        text = via_keepouts(job, &board, text);
    }
    let mut n_keep = 0;
    if keep {
        let rules = rules.ok_or("a keepout stage needs routing rules")?;
        let keepouts = stage_keepouts(job, rules, stage_nets)?;
        n_keep = keepouts.values().map(Vec::len).sum();
        text = add_keepouts(&text, &keepouts, &["wire_keepout".to_string()], "iot_ref_void")?;
    }
    if !extra.keepouts.is_empty() {
        n_keep += extra.keepouts.values().map(Vec::len).sum::<usize>();
        let name = if extra.name.is_empty() { "iot_stage" } else { &extra.name };
        text = add_keepouts(&text, &extra.keepouts, &["wire_keepout".to_string(), "via_keepout".to_string()], name)?;
    }
    let excluded = exclude(&text, stage_nets)?;
    let (mut text, ignored) = (excluded.text, excluded.ignored_classes);
    let model = job.file(&format!("router-model{sfx}.dsn"));
    let mut classes = board.nets.clone();
    classes.entry(String::new()).or_insert_with(|| "Default".to_string());
    let obstacle_rows = obstacles(&board);
    let active: Vec<String> = stage_nets.iter().cloned().collect();
    let scope = RouteScope { active_nets: &active, net_classes: &classes, obstacles: &obstacle_rows, layers: &layers };
    let gate = job.feat.board_dir.as_ref().map(|dir| dir.join("gate.json"));
    let coverage_path = job.file(&format!("rule-coverage{sfx}.json"));
    let floor_path = job.file(&format!("clearance-floor{sfx}.json"));
    let before_floor = job.file(&format!("clearance-input{sfx}.dsn"));
    let floor = match strengthen(job, &text, &before_floor, &model, &floor_path, &scope) {
        Ok((strengthened, floor)) => {
            text = strengthened;
            floor
        }
        Err(error) => {
            let coverage = json!({"schema": crate::rule_coverage::SCHEMA, "status": "blocked", "solver_launch_allowed": false, "cause": format!("project clearance strengthening: {error}"), "qualified": false, "clearance_strengthening": {"path": floor_path.display().to_string(), "sha256": null}, "inputs": {}});
            atomic_json(&coverage_path, &coverage)?;
            return Err(blocked(job, tag, &coverage_path, &coverage));
        }
    };
    // Each invocation retains its exact model after every edit.
    fs::write(&dsn, &text).map_err(|e| Stop::failed(e.to_string()))?;
    fs::write(&model, &text).map_err(|e| Stop::failed(e.to_string()))?;
    if Some(digest(&model)?.as_str()) != floor["after_sha256"].as_str() {
        return Err(Stop::failed("strengthened final DSN differs from its recorded bytes"));
    }
    if !ignored.is_empty() {
        let help = job.runner.run(Spec::new("net-class-capability", vec![job.bin.display().to_string(), "--help".into()]).deadline(Some(clock::after(10.0, job.runner.env())?)), |_| ())?;
        if help.returncode != 0 || !help.stdout.contains("router.autorouter.ignore_net_classes") {
            return Err(Stop::failed("fastroute_job: backend does not support safe net-class exclusion"));
        }
    }
    let pairs = pairs_file(job, stage_nets, &board, &sfx)?;
    let cmd = command(job, &model, &ses, &rep, &ignored, extra, pairs.as_deref())?;
    // Admission binds the complete argv; this exact command goes to the solver.
    let request = CheckRequest { board: &job.board, base: &job.base, dsn: &model, scope, gate: gate.as_deref(), backend_command: Some(&cmd), backend_policy: Some(&job.backend), native_thermal_capability: None };
    let mut coverage = match check_files(&request, &RouteCoverageTool::default()) {
        Ok(coverage) => serde_json::to_value(&coverage).map_err(|e| Stop::failed(e.to_string()))?,
        Err(error) => json!({"schema": crate::rule_coverage::SCHEMA, "status": "blocked", "solver_launch_allowed": false, "cause": error, "qualified": false}),
    };
    coverage["clearance_strengthening"] = json!({"path": floor_path.display().to_string(), "sha256": digest(&floor_path)?});
    if !coverage["inputs"].is_object() {
        coverage["inputs"] = json!({});
    }
    for (name, wanted) in floor["inputs"].as_object().into_iter().flatten() {
        let actual = digest(name).ok();
        let known = coverage["inputs"].get(name).filter(|value| *value != wanted).is_some();
        if actual.as_deref() != wanted.as_str() || known {
            coverage["status"] = json!("blocked");
            coverage["solver_launch_allowed"] = json!(false);
            coverage["cause"] = json!(format!("clearance strengthening input changed before admission: {name}"));
        }
        coverage["inputs"][name] = wanted.clone();
    }
    coverage["inputs"][absolute(&floor_path)] = json!(digest(&floor_path)?);
    atomic_json(&coverage_path, &coverage)?;
    if coverage["solver_launch_allowed"] != true {
        return Err(blocked(job, tag, &coverage_path, &coverage));
    }
    if coverage["status"] == "pending_native" {
        let rows = coverage["native_postconditions"].as_array().cloned().unwrap_or_default();
        let list: Vec<String> = rows.iter().map(|row| format!("{} {}", row["constraint"].as_str().unwrap_or_default(), row["enforcement"].as_str().unwrap_or("native-checkback"))).collect();
        rows.into_iter().for_each(|row| {
            if !job.native_obligations.contains(&row) {
                job.native_obligations.push(row);
            }
        });
        println!("ADMITTED router model with pending native obligations ({}); evidence={}", list.join(", "), coverage_path.display());
    } else {
        println!("PASS router rule coverage; evidence={}", coverage_path.display());
    }
    let sources: BTreeMap<String, String> = job.sources.iter().filter(|path| path.is_file()).filter_map(|path| Some((path.display().to_string(), digest(path).ok()?))).collect();
    let halo = learned_halo(&job.board, job.feat.board_dir.as_deref())?.1;
    let environment: BTreeMap<&str, Option<&String>> = ["ROUTE_FEATURES", "ROUTE_BOARD", "ROUTE_FEATURES_FILE"].iter().map(|name| (*name, job.runner.env().get(*name))).collect();
    let mut effective = json!({"configuration": job.a, "features": job.features_json(), "command": cmd, "dsn_sha256": digest(&model)?, "rule_coverage": {"path": coverage_path.display().to_string(), "sha256": digest(&coverage_path)?}, "backend_policy": job.backend, "feature_sources": sources, "environment": environment, "backend_resources": {"global_rayon_threads": job.router_env.get("RAYON_NUM_THREADS").and_then(|value| value.parse::<i64>().ok()), "autorouter_workers": job.a.threads, "optimizer_workers": job.a.threads, "live_reservation": job.router_env.get("IOT_RESOURCE_TICKET"), "scope": "cooperating pool caps; coordinator and independently built pools are additional threads"}, "learned_halo": halo, "mandatory_layer_masks": {}, "ignored_classes": ignored, "qualified": false});
    if job.rules_on {
        effective["stage"] = json!(tag);
        effective["stage_nets"] = json!(active);
        effective["keepouts"] = json!(n_keep);
    }
    effective["effective_sha256"] = json!(sha256(dumps(&effective, Separators::Spaced).as_bytes()));
    job.write_json(&format!("effective-configuration{sfx}.json"), &effective)?;
    let started = clock::now();
    solve(job, tag, &sfx, &cmd, &model, &ses, &rep)?;
    let (imported_vias, report, left_open, row) = import_session(job, tag, &sfx, &board, &locked, stage_nets, &dsn, &ses, started, n_keep)?;
    Ok(Done { report, imported_vias, left_open, row })
}

/// The escape stage leaves the far connections open on purpose: the escapes stay and the nets are routed in their own stage.
fn escape_result(job: &Job, rules: &mut Rules, stage_nets: &BTreeSet<String>, done: &Done) -> Result<(), Stop> {
    let new: Vec<copper::Item> = copper::read(&job.text)?.into_iter().filter(|item| !job.was.contains_key(&item.id) && stage_nets.contains(&item.net)).collect();
    let vias: Vec<&copper::Item> = new.iter().filter(|item| item.is_via()).collect();
    let inside = vias.iter().filter(|via| {
        let (x, y) = (to_mm(via.start.0), to_mm(via.start.1));
        rules.courtyards.iter().any(|area| area[0] <= x && x <= area[2] && area[1] <= y && y <= area[3])
    });
    let inside = inside.count();
    let unrouted = number_stat(&done.report, "unrouted");
    rules.escape["result"] = json!({"items": new.len(), "vias": vias.len(), "vias_inside_courtyard": inside, "router_unrouted": unrouted, "seconds": done.row["seconds"]});
    println!("ESCAPE result: {} items, {} vias ({inside} inside a fine-pitch courtyard) for {} pads; router left {unrouted} connections (far ends, expected)", new.len(), vias.len(), rules.escape["pads"]);
    Ok(())
}

fn copy_plain(job: &Job, tag: &str) -> Result<(), Stop> {
    for (from, to) in [(format!("board-{tag}.dsn"), "board.dsn"), (format!("board-{tag}.ses"), "board.ses"), (format!("report-{tag}.json"), "report.json")] {
        fs::copy(job.file(&from), job.file(to)).map_err(|e| Stop::failed(format!("{from}: {e}")))?;
    }
    Ok(())
}

/// Rip-up and repair: the staged order locks each stage's copper, so a later stage cannot move it. Each iteration unlocks only the
/// nets still open and their nearest blockers; an iteration that leaves the same nets open stops the loop.
fn repair_loop(job: &mut Job, rules: &Rules, mut last: Done, mut still_open: BTreeSet<String>, stage_log: &mut Vec<Value>) -> Result<Done, Stop> {
    let setting = |job: &Job, key: &str, fallback: f64| job.feat.setting("routing_rules", key).and_then(Value::as_f64).unwrap_or(fallback);
    let iterations = setting(job, "repair_iterations", 2.0) as i64;
    let keep_any = rules.plan.iter().any(|stage| stage.2);
    let mut grounds: BTreeSet<String> = rules.info.spec.grounds.iter().cloned().collect();
    grounds.extend(job.plane_names.iter().cloned());
    for iteration in 1..=iterations {
        let items = copper::read(&job.text)?;
        let point = |p: copper::Nm| [to_mm(p.0), to_mm(p.1)];
        let rows: Vec<RepairCopper> = items.iter().map(|item| (item.net.clone(), (!item.is_via()).then(|| item.layer.clone()), point(item.start), point(item.end))).collect();
        let unrouted: Vec<Unrouted> = last.report["unrouted"].as_array().into_iter().flatten().filter(|row| row["net"].as_str().is_some_and(|net| still_open.contains(net))).filter_map(|row| serde_json::from_value(row.clone()).ok()).collect();
        let selection = repair_selection(&unrouted, &rows, setting(job, "repair_corridor_mm", 1.0), &grounds, setting(job, "repair_max_blockers", 4.0) as usize);
        let rip: BTreeSet<String> = selection.nets.iter().filter(|net| job.nets.contains(*net)).cloned().collect();
        if rip.is_empty() {
            break;
        }
        let (power, signal): (BTreeSet<String>, BTreeSet<String>) = rip.iter().cloned().partition(|net| exempt(net, &rules.info, &job.plane_names));
        let blockers: Vec<String> = selection.blockers.iter().map(|(net, list)| format!("{net}: {}", if list.is_empty() { "-".to_string() } else { list.join(", ") })).collect();
        println!("STAGE repair{iteration}: {} nets open, {} nets unlocked ({} signal, {} exempt); blockers {}", still_open.len(), rip.len(), signal.len(), power.len(), blockers.join("; "));
        let before = still_open.clone();
        for (tag, part, keep) in [(format!("repair{iteration}"), &signal, keep_any), (format!("repair{iteration}_exempt"), &power, false)] {
            if part.is_empty() {
                continue;
            }
            let done = route_pass(job, Some(rules), &tag, part, keep, part, &Extra::default())?;
            let mut row = done.row.clone();
            row["left_open"] = json!(done.left_open);
            row["repair"] = json!(true);
            row["unlocked"] = json!(part);
            row["blockers"] = json!(selection.blockers);
            stage_log.push(row);
            still_open = still_open.difference(part).cloned().collect();
            still_open.extend(done.left_open.iter().cloned());
            copy_plain(job, &tag)?;
            last = done;
        }
        println!("STAGE repair{iteration}: {} -> {} nets open", before.len(), still_open.len());
        if still_open.is_empty() || still_open == before {
            break;
        }
    }
    Ok(last)
}

/// Every pass of the job, then the checks on the routed board.
pub fn route_all(job: &mut Job) -> Result<(), Stop> {
    let (board, _) = prepare::read(&job.base)?;
    let (mut rules, passes) = prepare::stage_plan(job, &board)?;
    job.multi_pass = passes.len() > 1;
    let started = unix_time();
    let (mut stage_log, mut staged, mut still_open) = (Vec::new(), BTreeSet::new(), BTreeSet::new());
    let mut last: Option<Done> = None;
    let none = BTreeSet::new();
    for (index, pass) in passes.iter().enumerate() {
        let Pass { tag, nets, keep, extra } = pass;
        let mut stage_nets = nets.clone();
        if tag == "final" {
            // The last pass: the nets no stage routed and those a stage left open. A finished stage net is an ignored class here.
            stage_nets = stage_nets.difference(&staged).cloned().collect();
            stage_nets.extend(still_open.iter().cloned());
            // The stage copper of a net left open is ripped up, so the pass routes the net again from its pads.
            let gone: BTreeSet<String> = copper::read(&job.text)?.into_iter().filter(|item| !job.was.contains_key(&item.id) && still_open.contains(&item.net)).map(|item| item.id).collect();
            if !gone.is_empty() {
                let edit = crate::kicad::edit::Edit { removed: gone.iter().cloned().collect(), ..Default::default() };
                job.text = edit.apply(&job.text, tag)?;
                let open: Vec<&str> = still_open.iter().map(String::as_str).collect();
                println!("STAGE final: {} stage items of {} nets left open ripped up: {}", gone.len(), still_open.len(), open.join(", "));
            }
            if stage_nets.is_empty() {
                let previous = suffix(&passes[index - 1].tag);
                copy_plain(job, previous.trim_start_matches('-'))?;
                println!("STAGE final nets 0: every stage net routed; report.json is the last stage report");
                break;
            }
        }
        let empty = Extra::default();
        let mut done = route_pass(job, rules.as_ref(), tag, &stage_nets, *keep, &none, extra.as_ref().unwrap_or(&empty))?;
        if tag == "escape" {
            escape_result(job, rules.as_mut().ok_or("an escape stage needs routing rules")?, &stage_nets, &done)?;
            done.left_open.clear();
        }
        let mut row = done.row.clone();
        row["left_open"] = json!(done.left_open);
        stage_log.push(row);
        staged.extend(stage_nets.iter().cloned());
        still_open = still_open.difference(&stage_nets).cloned().collect();
        still_open.extend(done.left_open.iter().cloned());
        last = Some(done);
    }
    let mut last = last.ok_or("the job ran no router pass")?;
    if let Some(rules) = rules.as_ref().filter(|_| !still_open.is_empty()) {
        last = repair_loop(job, rules, last, still_open, &mut stage_log)?;
    }
    if let Some(rules) = &rules {
        let stages: Vec<Value> = rules.plan.iter().map(|(name, nets, keep)| json!({"stage": name, "nets": nets, "keepout": keep})).collect();
        let hot: BTreeMap<&String, Value> = rules.hot.iter().map(|(net, loop_)| (net, json!({"straight_mm": loop_.found.straight_mm, "max_mm": loop_.found.max_mm, "margin_mm": loop_.found.margin_mm, "ends": loop_.found.ends, "box": loop_.found.r#box, "layer": loop_.layer, "loop_pads": loop_.loop_pads}))).collect();
        job.write_json("stage-plan.json", &json!({"stages": stages, "runs": stage_log, "escape": rules.escape, "hot_loops": hot}))?;
    }
    finish::run(job, rules.as_ref(), &last, (unix_time() - started) as i64)
}
