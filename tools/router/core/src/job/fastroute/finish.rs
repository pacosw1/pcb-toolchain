//! After the last pass: fill and save through KiCad 10, DRC, the repairs, the verdict lines and the exit.
use super::pass::Done;
use super::stages::Rules;
use super::{Job, NOT_VERIFIED, STUCK_RC, copper, prepare, repair, thermal};
use crate::gnd_pad_vias;
use crate::grid::escape::{self, EscapeConfig, EscapeScope, Runtime};
use crate::grid::triage::{TriageConfig, TriageScope, triage};
use crate::job::files::{append_line, atomic_json, digest};
use crate::job::stage::Spec;
use crate::job::stop::Stop;
use crate::kicad::board::Board;
use crate::kicad::geom::{Polygon, to_mm};
use crate::kicad::geom::Pt;
use crate::kicad::pad::PadKind;
use crate::kicad::rules::DesignRules;
use crate::kicad::save::{WorkDir, put_in_place};
use crate::route_features;
use crate::routing_rules::report::{HotLengths, ReportOptions, summary_line, via_report};
use crate::rule_coverage::discharge_native;
use crate::specctra::dsn_edit::glob;
use regex_lite::Regex;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

const PREFLIGHT_TYPES: [&str; 3] = ["shorting_items", "clearance", "copper_edge_clearance"];

/// Only checked existing-copper faults stop routing; opens, placement warnings and router-internal findings do not.
pub fn blocks_routing(finding: &Value) -> bool {
    let error = finding["severity"] == "error";
    let existing = PREFLIGHT_TYPES.iter().any(|kind| finding["type"] == *kind) && finding["excluded"] != true;
    error && (existing || finding["type"] == "starved_thermal")
}

pub(super) fn validated(path: &Path) -> Result<Value, Stop> {
    let text = fs::read_to_string(path).map_err(|e| Stop::failed(format!("{}: {e}", path.display())))?;
    let drc: Value = serde_json::from_str(&text).map_err(|e| Stop::failed(format!("{}: {e}", path.display())))?;
    if !drc["violations"].is_array() || !drc["unconnected_items"].is_array() {
        return Err(Stop::failed("missing or malformed native DRC evidence"));
    }
    Ok(drc)
}

/// KiCad 10's DRC of a saved board, with fresh fills.
pub fn native_drc(job: &Job, stage: &str, board: &Path, report: &Path, failure: &str) -> Result<Value, Stop> {
    let command = [job.cli.as_str(), "pcb", "drc", "--refill-zones", "--severity-all", "--format", "json", "--units", "mm", "-o"].iter().map(|word| word.to_string()).chain([report.display().to_string(), board.display().to_string()]).collect();
    let run = job.runner.run(Spec::new(stage, command).quiet_stdout(), |_| ())?;
    if run.returncode != 0 || !report.is_file() {
        return Err(Stop::failed(failure));
    }
    validated(report)
}

/// The board text saved by KiCad 10 with fresh fills, in `folder` under `name`. The project of the job goes along and comes back as
/// it was: a save can rewrite it.
pub fn fill_save(job: &Job, stage: &str, text: &str, folder: &Path, name: &str) -> Result<PathBuf, Stop> {
    for extension in ["kicad_pro", "kicad_dru"] {
        let side = job.base.with_extension(extension);
        if side.is_file() {
            fs::copy(&side, folder.join(format!("{name}.{extension}"))).map_err(|e| Stop::failed(format!("{}: {e}", side.display())))?;
        }
    }
    let path = folder.join(format!("{name}.kicad_pcb"));
    fs::write(&path, text).map_err(|e| Stop::failed(format!("{}: {e}", path.display())))?;
    let written = fs::metadata(&path).and_then(|meta| meta.modified()).ok();
    let report = folder.join("save-drc.json");
    let words = [job.cli.as_str(), "pcb", "drc", "--refill-zones", "--save-board", "--format", "json", "--units", "mm", "--severity-error", "--output"];
    let command = words.iter().map(|word| word.to_string()).chain([report.display().to_string(), path.display().to_string()]).collect();
    let run = job.runner.run(Spec::new(stage, command).quiet_stdout(), |_| ())?;
    let pro = job.base.with_extension("kicad_pro");
    if pro.is_file() {
        fs::copy(&pro, folder.join(format!("{name}.kicad_pro"))).map_err(|e| Stop::failed(format!("restoring .kicad_pro: {e}")))?;
    }
    if !report.is_file() || fs::metadata(&path).and_then(|meta| meta.modified()).ok() == written {
        return Err(Stop::failed(format!("native fill and save failed (exit {}): the board was not saved", run.returncode)));
    }
    Ok(path)
}

fn net_of(description: &str) -> String {
    let found = Regex::new(r"\[([^\]]*)\]").expect("a fixed pattern").captures(description).map(|found| found[1].to_string());
    found.unwrap_or_default()
}

/// The open plane-net pads DRC names.
pub fn open_plane_pads(drc: &Value, planes: &BTreeSet<String>) -> repair::Pads {
    let pad = Regex::new(r"^Pad (\S+) \[([^\]]*)\] of (\S+)").expect("a fixed pattern");
    let mut todo = repair::Pads::new();
    for open in drc["unconnected_items"].as_array().into_iter().flatten() {
        for item in open["items"].as_array().into_iter().flatten() {
            if let Some(found) = pad.captures(item["description"].as_str().unwrap_or_default()).filter(|found| planes.contains(&found[2])) {
                todo.entry(found[2].to_string()).or_default().insert(format!("{}.{}", &found[3], &found[1]));
            }
        }
    }
    todo
}

fn zone_to_zone(drc: &Value) -> bool {
    drc["unconnected_items"].as_array().into_iter().flatten().any(|open| {
        let text = |index: usize| open["items"][index]["description"].as_str().unwrap_or_default();
        text(0).contains("Zone") && text(1).contains("Zone")
    })
}

/// A pour piece on an outer layer with pads but no via or through-hole pad of its net is an island with parts on it: DRC shows it as
/// zone to zone with no pad name, so its pads go to the repair list too.
fn island_pads(board: &Board, planes: &BTreeSet<String>, todo: &mut repair::Pads) {
    for zone in board.zones.iter().filter(|zone| zone.rule_area.is_none() && planes.contains(&zone.net)) {
        let Some(layer) = zone.layers.first().filter(|layer| matches!(layer.as_str(), "F.Cu" | "B.Cu")) else { continue };
        let mut anchors: Vec<Pt> = board.vias().filter(|via| via.net == zone.net).map(|via| via.at).collect();
        let mut smd = Vec::new();
        for (footprint, pad) in board.pads().filter(|(_, pad)| pad.net == zone.net) {
            if pad.drill.x != 0 {
                anchors.push(pad.position);
            } else if pad.layers.contains(layer) {
                smd.push((format!("{}.{}", footprint.reference, pad.number), pad.position));
            }
        }
        let filled = zone.filled.iter().find(|filled| &filled.layer == layer);
        for polygon in filled.iter().flat_map(|filled| filled.polygons.iter()) {
            if anchors.iter().any(|point| polygon.contains(*point)) {
                continue;
            }
            for (name, point) in smd.iter().filter(|(_, point)| polygon.contains(*point)) {
                let _: (&String, &Pt) = (name, point);
                todo.entry(zone.net.clone()).or_default().insert(name.clone());
            }
        }
    }
    let _: Option<Polygon> = None;
}

fn repair_pads(job: &Job, todo: &repair::Pads) -> Result<(), Stop> {
    let via_args = prepare::shell_words(&job.a.via_args)?;
    for (net, pads) in todo {
        let mut options = prepare::via_options(net, &via_args)?;
        options.only = pads.iter().cloned().collect();
        let tmp = job.file("repair.kicad_pcb");
        let plan = job.runner.phase(&format!("postimport-plane-repair:{net}"), job.deadline, || Ok(gnd_pad_vias::run(&job.routed, &tmp, &options)?))?;
        append_line(job.file("planevias.log"), &format!("repair {}", gnd_pad_vias::summary(&plan, net)[0]))?;
        if tmp.is_file() {
            fs::rename(&tmp, &job.routed).map_err(|e| Stop::failed(format!("{}: {e}", job.routed.display())))?;
        }
    }
    Ok(())
}

/// Open connections counted as the callers read them. A staged job leaves later stages' nets open by design: only opens on the nets
/// this job routes make it STUCK, and the UNROUTED line still counts every signal open.
struct Opens {
    ground: usize,
    signal: usize,
    job: usize,
}

fn count_opens(job: &Job, drc: &Value) -> Opens {
    let list = drc["unconnected_items"].as_array().cloned().unwrap_or_default();
    let (mut ground, mut other) = (0, 0);
    for open in &list {
        let name = net_of(open["items"][0]["description"].as_str().unwrap_or_default());
        if job.skip.iter().any(|pattern| glob(&name, pattern)) || job.plane_names.contains(&name) {
            ground += 1;
        } else if !job.a.only_nets.is_empty() && !job.nets.contains(&name) {
            other += 1;
        }
    }
    let signal = list.len() - ground;
    Opens { ground, signal, job: signal - other }
}

fn runtime() -> Result<Runtime, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(Runtime { kicad_version: crate::kicad::api::PINNED_COMMIT.to_string(), program: BTreeMap::from([(exe.display().to_string(), digest(&exe)?)]) })
}

/// Pins of the routed nets that cannot leave their part. Read only. The line says "ESCAPE failed" when the check could not run.
pub fn escape_line(job: &Job, board: &Board, rules: &DesignRules, nets_file: &Path) -> String {
    let number = |key: &str, fallback: f64| job.feat.setting("pin_escape_check", key).and_then(Value::as_f64).unwrap_or(fallback);
    let raw = Value::Object(job.feat.get("pin_escape_check").cloned().unwrap_or_default());
    let config = EscapeConfig { grid_mm: number("grid_mm", 0.05), reach_mm: number("reach_mm", 2.0), halo_hint_mm: number("halo_hint_mm", 0.5), raw };
    let nets: BTreeSet<String> = fs::read_to_string(nets_file).unwrap_or_default().lines().filter(|net| !net.is_empty()).map(str::to_string).collect();
    let scope = EscapeScope { layers: job.a.layer_list(), skip: Vec::new(), nets: Some(nets) };
    let line = (|| -> Result<String, String> {
        let generator = escape::generator_inputs(&route_features::defaults_path())?;
        let report = escape::escape(board, rules, &job.base, &config, &scope, generator, runtime()?)?;
        atomic_json(job.file("pin-escape.json"), &report)?;
        Ok(report.line())
    })();
    line.unwrap_or_else(|error| {
        eprintln!("fastroute_job: pin escape: {error}");
        "ESCAPE failed".to_string()
    })
}

fn triage_opens(job: &Job, drc: &Value, signal_open: usize) -> Result<(), Stop> {
    let path = job.file("open-triage.json");
    if signal_open == 0 {
        fs::write(&path, json!({"open": 0, "enclosed": 0, "router_miss": 0, "connections": []}).to_string()).map_err(|e| Stop::failed(e.to_string()))?;
        println!("TRIAGE open 0");
    } else {
        let number = |key: &str, fallback: f64| job.feat.setting("triage_opens", key).and_then(Value::as_f64).unwrap_or(fallback);
        let config = TriageConfig { grid_mm: number("grid_mm", 0.1), max_opens: number("max_opens", 60.0) as usize };
        let skip = job.skip.iter().chain(job.planes.iter()).cloned().collect();
        let scope = TriageScope { layers: job.a.layer_list(), skip, nets: Some(job.nets.clone()) };
        let line = (|| -> Result<String, String> {
            let (board, rules) = prepare::read(&job.routed)?;
            let report = triage(&board, &rules, &job.routed, drc, &config, &scope)?;
            atomic_json(&path, &report)?;
            Ok(report.line())
        })();
        println!("{}", line.unwrap_or_else(|error| {
            eprintln!("fastroute_job: open triage: {error}");
            "TRIAGE failed".to_string()
        }));
    }
    if let Some(dir) = job.feat.board_dir.as_ref().filter(|_| path.is_file()) {
        fs::create_dir_all(dir.join(".gate")).map_err(|e| Stop::failed(e.to_string()))?;
        fs::copy(&path, dir.join(".gate/open-triage.json")).map_err(|e| Stop::failed(e.to_string()))?;
    }
    Ok(())
}

/// Rule 2 evidence: vias per stage and net class; fast-net layer changes with no ground via near.
fn via_evidence(job: &Job, rules: &Rules) -> Result<(), Stop> {
    let (board, _) = prepare::read(&job.routed)?;
    let mut grounds: BTreeSet<String> = rules.info.spec.grounds.iter().cloned().collect();
    grounds.extend(job.plane_names.iter().cloned());
    let (mut vias, mut anchors) = (Vec::new(), Vec::new());
    for via in board.vias() {
        let (x, y, radius) = (to_mm(via.at.x), to_mm(via.at.y), to_mm(via.size) / 2.0);
        vias.push((via.net.clone(), x, y, radius));
        if grounds.contains(&via.net) {
            anchors.push([x, y, radius]);
        }
    }
    for (_, pad) in board.pads().filter(|(_, pad)| grounds.contains(&pad.net) && pad.kind == PadKind::ThroughHole) {
        let radius = to_mm((pad.bbox.right - pad.bbox.left).min(pad.bbox.bottom - pad.bbox.top)) / 2.0;
        anchors.push([to_mm(pad.position.x), to_mm(pad.position.y), radius]);
    }
    let mut net_stage: BTreeMap<String, String> = rules.plan.iter().flat_map(|(stage, nets, _)| nets.iter().map(move |net| (net.clone(), stage.clone()))).collect();
    net_stage.extend(job.plane_names.iter().map(|net| (net.clone(), "plane".to_string())));
    let mut hot = BTreeMap::new();
    for (net, loop_) in &rules.hot {
        let length: f64 = board.tracks().filter(|track| &track.net == net).map(|track| to_mm(track.start.x - track.end.x).hypot(to_mm(track.start.y - track.end.y))).sum();
        hot.insert(net.clone(), HotLengths { max_mm: loop_.found.max_mm, length_mm: crate::job::files::rounded(length, 3), extra: BTreeMap::from([("straight_mm".to_string(), json!(loop_.found.straight_mm))]) });
    }
    let via_allow = rules.info.spec.extra.get("via_allow_mm").and_then(Value::as_f64).unwrap_or(0.6);
    let options = ReportOptions { net_stage, net_class: rules.classes.clone(), fast: rules.info.fast.clone(), grounds, gnd_anchors: anchors, via_allow, hot };
    let report = via_report(&vias, &options);
    job.write_json("via-report.json", &report)?;
    println!("{}", summary_line(&report));
    Ok(())
}

pub(crate) fn diagnosis_count(report: &Value, name: &str) -> String {
    report["diagnosis"][name].as_i64().filter(|value| *value >= 0).map_or("unknown".to_string(), |value| value.to_string())
}

/// Pending admission obligations: the final DRC must show no finding of their types that the input board does not already have.
fn discharge(job: &Job, drc: &Value) -> Result<Option<Value>, Stop> {
    if job.native_obligations.is_empty() {
        return Ok(None);
    }
    let baseline = if job.native_obligations.iter().any(|row| row["enforcement"] == "native-drc") {
        Some(native_drc(job, "native-input-drc", &job.board, &job.file("input-drc.json"), "native DRC of the input board failed; pending obligations are not verified")?)
    } else {
        None
    };
    let post = discharge_native(&job.native_obligations, drc, baseline.as_ref());
    let value = serde_json::to_value(&post).map_err(|e| Stop::failed(e.to_string()))?;
    job.write_json("native-postconditions.json", &value)?;
    if post.status != "passed" {
        let path = job.file("native-postconditions.json").display().to_string();
        job.write_json("outcome.json", &json!({"status": "blocked", "qualified": false, "cause": format!("native postcondition: {}", post.cause), "board_sha256": digest(&job.routed)?, "native_postconditions": path}))?;
        println!("STUCK native postcondition: {}", post.cause);
        return Err(Stop::code(NOT_VERIFIED));
    }
    Ok(Some(value))
}

pub fn run(job: &mut Job, rules: Option<&Rules>, last: &Done, secs: i64) -> Result<(), Stop> {
    {
        let work = WorkDir::beside(&job.routed, "fill")?;
        let saved = fill_save(job, "native-zone-fill-save", &job.text, &work.0, "routed")?;
        put_in_place(&saved, &job.routed)?;
    }
    let drc_path = job.file("drc.json");
    job.progress("drc start");
    let routed = job.routed.clone();
    let mut drc = native_drc(job, "native-drc", &routed, &drc_path, "native DRC failed; result is not verified")?;
    job.progress("drc end");
    // A plane pad open after routing gets its own stub and via now, with the routed copper as the obstacle; then DRC runs again.
    let mut todo = open_plane_pads(&drc, &job.plane_names);
    if zone_to_zone(&drc) {
        let (board, _) = prepare::read(&job.routed)?;
        island_pads(&board, &job.plane_names, &mut todo);
    }
    let source = fs::read_to_string(&job.board).map_err(|e| Stop::failed(e.to_string()))?;
    let source_keys = copper::keys(&copper::read(&source)?);
    let moved = repair::plane_via_clearance(&job.routed, &drc, &job.plane_names, &source_keys)?;
    if !moved.is_empty() {
        let list: Vec<String> = moved.iter().map(|(net, pads)| format!("{net} {}", pads.iter().cloned().collect::<Vec<_>>().join(", "))).collect();
        println!("fastroute_job: plane vias re-placed after a clearance violation with routed copper: {}", list.join(", "));
    }
    for (net, pads) in moved {
        todo.entry(net).or_default().extend(pads);
    }
    if !todo.is_empty() {
        repair_pads(job, &todo)?;
        drc = native_drc(job, "repair-drc", &routed, &drc_path, "native repair DRC failed; result is not verified")?;
    }
    let via_args = prepare::shell_words(&job.a.via_args)?;
    let board_path = job.board.clone();
    let (checked, thermal) = thermal::run(job, &routed, &board_path, drc, &via_args, "postroute-thermal")?;
    let drc = checked;
    atomic_json(&drc_path, &drc)?;
    job.write_json("thermal-repair.json", &thermal)?;
    // Every post-import repair is done: the input board's copper must all be there, except what the caller unlocked.
    let routed_items = copper::read(&fs::read_to_string(&job.routed).map_err(|e| Stop::failed(e.to_string()))?)?;
    let lost: Vec<copper::Key> = copper::missing(&routed_items, &source_keys).into_iter().filter(|key| !job.unlock.contains(&key.1)).collect();
    if let Some(first) = lost.first() {
        return Err(Stop::failed(format!("fastroute_job: SOURCE COPPER LOST: {} input tracks/vias are missing after the post-import repairs (first {:?} {} {}); the result is not used", lost.len(), first.0, first.1, first.2)));
    }
    let vias = copper::vias(&routed_items);
    let errors = drc["violations"].as_array().map_or(0, |list| list.iter().filter(|finding| finding["severity"] == "error").count());
    let opens = count_opens(job, &drc);
    job.progress.lock().unwrap_or_else(|poison| poison.into_inner()).with_open("triage start", opens.signal as u64, Some(vias as u64));
    if route_features::on(&job.feat, "triage_opens") {
        triage_opens(job, &drc, opens.signal)?;
    }
    if let Some(rules) = rules {
        via_evidence(job, rules)?;
    }
    job.progress.lock().unwrap_or_else(|poison| poison.into_inner()).with_open("triage end", opens.signal as u64, None);
    let stats = &last.report["stats"];
    let (router_unrouted, router_vias) = (stats["unrouted"].as_i64().unwrap_or(0), stats["vias"].as_i64().unwrap_or(0));
    println!("UNROUTED {} GND_OPEN {} ERRORS {errors} ROUTER_UNROUTED {router_unrouted} CONGESTION {} BLOCKED {} TRACK_MM {:.0} VIAS {vias} SECONDS {secs}", opens.signal, opens.ground, diagnosis_count(&last.report, "congestion"), diagnosis_count(&last.report, "blocked"), stats["trace_length_mm"].as_f64().unwrap_or(0.0));
    if last.imported_vias as i64 != router_vias {
        println!("fastroute_job: RESULT NOT VERIFIED: {} vias on the board, {router_vias} in the router report", last.imported_vias);
        return Err(Stop::code(NOT_VERIFIED));
    }
    if job.fail_fast.stuck_exit && opens.job != 0 {
        // The imported board, DRC, triage and the UNROUTED line are written; nothing more is spent on a board with opens.
        let note = "fail_fast: open signal connections after routing; see open-triage.json";
        job.write_json("outcome.json", &json!({"status": "stuck", "qualified": false, "optimizer": job.a.optimizer, "signal_open": opens.signal, "ground_open": opens.ground, "errors": errors, "board_sha256": digest(&job.routed)?, "note": note}))?;
        println!("STUCK {} open signal connections after routing (fail_fast): no optimizer, exit {STUCK_RC}; see {}", opens.job, job.file("open-triage.json").display());
        return Err(Stop::code(STUCK_RC));
    }
    let post = discharge(job, &drc)?;
    // The required image shows the final repaired board.
    if job.a.render {
        let image = job.file("routed.png");
        let words = [job.cli.as_str(), "pcb", "render", "--side", "top", "--quality", "basic", "-w", "1600", "-h", "1200", "-o"];
        let command = words.iter().map(|word| word.to_string()).chain([image.display().to_string(), job.routed.display().to_string()]).collect();
        let run = job.runner.run(Spec::new("render", command).quiet_stdout(), |_| ())?;
        if run.returncode != 0 || !image.is_file() {
            return Err(Stop::failed("required per-step rendering failed"));
        }
    }
    let gate = post.as_ref().map_or(json!([]), |post| post["configured_gate"].clone());
    job.write_json("outcome.json", &json!({"status": "complete", "qualified": false, "optimizer": job.a.optimizer, "signal_open": opens.signal, "ground_open": opens.ground, "errors": errors, "board_sha256": digest(&job.routed)?, "configured_gate_obligations": gate, "note": "import verified; full final board gate remains required"}))
}
