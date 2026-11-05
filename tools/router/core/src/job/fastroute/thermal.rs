//! Starved plane thermals: a bounded copper proposal, accepted only by independent native checks.
//!
//! Never changes thermal policies, existing copper or parts. The proposal is made on a copy of the project; the board is replaced
//! only when KiCad's DRC with schematic parity shows fewer errors, no new one, and every part, zone policy and existing track is
//! as it was. An accepted proposal is no qualification: what remains must still pass the final gate.
use super::{Job, finish, prepare};
use crate::gnd_pad_vias::{self, Options as ViaOptions};
use crate::job::clock;
use crate::job::files::{append_line, atomic_json, digest, with_suffix};
use crate::job::stage::Spec;
use crate::job::stop::Stop;
use crate::kicad::raw::{self, Body, Form};
use regex_lite::Regex;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

/// Seconds for one repair, within the deadline of the job.
const BUDGET_S: f64 = 90.0;
const IMMUTABLE: [&str; 10] = ["footprint", "zone", "segment", "arc", "via", "setup", "gr_line", "gr_arc", "gr_rect", "gr_poly"];
/// A fill is computed evidence: its polygons may change. The zone's outline and settings may not.
const COMPUTED: [&str; 2] = ["filled_polygon", "fill_segments"];
const PROHIBITED: [&str; 3] = ["--net", "--only", "--in-pad"];
const SIDECARS: [&str; 3] = ["kicad_pro", "kicad_dru", "kicad_sch"];

/// Reference, pad number and net of each pad, by uuid.
pub type Pads = BTreeMap<String, (String, String, String)>;
/// The net of each zone, by uuid.
pub type Zones = BTreeMap<String, String>;
/// Kind and uuid of each item, with its exact tokens.
pub type Rows = BTreeMap<(String, String), String>;

fn expired(what: &str) -> Stop {
    Stop::Timeout { cause: format!("{what}: thermal repair budget spent"), cleanup: Value::Null }
}

fn check_budget(deadline: f64, what: &str) -> Result<(), Stop> {
    if clock::now() >= deadline { Err(expired(what)) } else { Ok(()) }
}

fn io<T>(path: &Path, result: std::io::Result<T>) -> Result<T, Stop> {
    result.map_err(|error| Stop::failed(format!("{}: {error}", path.display())))
}

/// Pure detector: native UUID, pad, ref, net and owning zone must all agree.
pub fn thermal_targets(drc: &Value, pads: &Pads, zones: &Zones, planes: &BTreeSet<String>) -> Result<BTreeMap<String, Vec<String>>, String> {
    // kicad-cli wording: "Pad 2 [GND] of U16 on F.Cu" (SMD) or "PTH pad 11 [GND] of U10" (through hole, 10.0.6).
    let wording = Regex::new(r"^(?:Pad|PTH pad) (\S+) \[([^\]]*)\] of (\S+)(?: on (.+))?$").expect("a fixed pattern");
    let mut todo: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for finding in drc["violations"].as_array().into_iter().flatten().filter(|finding| finding["type"] == "starved_thermal" && finding["severity"] == "error") {
        let items = finding["items"].as_array().filter(|items| items.len() == 2 && items.iter().all(|item| item["uuid"].is_string() && item["description"].is_string())).ok_or("malformed native thermal violation")?;
        let mut found = Vec::new();
        for item in items {
            let Some((reference, number, net)) = pads.get(item["uuid"].as_str().unwrap_or_default()) else { continue };
            let description = item["description"].as_str().unwrap_or_default();
            let same = wording.captures(description).is_some_and(|text| &text[3] == reference && &text[1] == number && &text[2] == net);
            if !same {
                return Err("native thermal pad identity mismatch".into());
            }
            if !items.iter().any(|other| zones.get(other["uuid"].as_str().unwrap_or_default()) == Some(net)) {
                return Err("native thermal zone identity mismatch".into());
            }
            found.push((net.clone(), format!("{reference}.{number}")));
        }
        let [(net, name)] = &found[..] else { return Err("ambiguous native thermal pads".into()) };
        if planes.contains(net) {
            todo.entry(net.clone()).or_default().insert(name.clone());
        }
    }
    Ok(todo.into_iter().map(|(net, names)| (net, names.into_iter().collect())).collect())
}

/// The exact tokens of a form: whitespace is no difference, an escape or a quote is.
fn tokens(text: &str, form: &Form, skip: &[&str], out: &mut String) {
    match &form.body {
        Body::Atom(_) => out.push_str(&text[form.span.clone()]),
        Body::List(items) => {
            out.push('(');
            for (n, item) in items.iter().filter(|item| !item.head().is_some_and(|head| skip.contains(&head))).enumerate() {
                if n > 0 {
                    out.push(' ');
                }
                tokens(text, item, &[], out);
            }
            out.push(')');
        }
    }
}

/// The saved board for comparison: entire parts, setup, zones and existing tracks. Filled polygons are left out, nothing else.
pub fn immutable_board(path: &Path, deadline: Option<f64>) -> Result<Rows, Stop> {
    let budget = |what: &str| deadline.map_or(Ok(()), |deadline| check_budget(deadline, what));
    budget("native-policy-snapshot")?;
    let text = io(path, fs::read_to_string(path))?;
    let forms = raw::parse(&text).map_err(|_| Stop::failed("malformed native board"))?;
    budget("native-policy-tree")?;
    let [tree] = &forms[..] else { return Err(Stop::failed("malformed native board")) };
    if !tree.is("kicad_pcb") {
        return Err(Stop::failed("not a native PCB"));
    }
    let mut rows = Rows::new();
    for (number, node) in tree.items().iter().enumerate() {
        if number % 4096 == 0 {
            budget("native-policy-rows")?;
        }
        let Some(name) = node.head().filter(|head| IMMUTABLE.contains(head)) else { continue };
        let uuid = node.children("uuid").next().and_then(|form| form.items().get(1)).map_or(name.to_string(), |id| text[id.span.clone()].to_string());
        let mut row = String::new();
        tokens(&text, node, if name == "zone" { &COMPUTED } else { &[] }, &mut row);
        if rows.insert((name.to_string(), uuid), row).is_some() {
            return Err(Stop::failed("duplicate native immutable item identity"));
        }
    }
    Ok(rows)
}

/// Copies the schematic of `source` and every sheet under it, and names them relative to the project.
pub fn copy_hierarchy(source: &Path, destination: &Path, deadline: f64) -> Result<Vec<String>, Stop> {
    let outside = || Stop::failed("schematic hierarchy unavailable or outside source project");
    let parent = source.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let root = io(parent, fs::canonicalize(parent))?;
    let sheet_file = Regex::new(r#"\(property "Sheetfile" "([^"\n]+)""#).expect("a fixed pattern");
    let mut pending = vec![with_suffix(source, "kicad_sch")];
    let mut seen = BTreeSet::new();
    while let Some(next) = pending.pop() {
        check_budget(deadline, "copy-native-hierarchy")?;
        let sheet = fs::canonicalize(&next).map_err(|_| outside())?;
        if seen.contains(&sheet) {
            continue;
        }
        let relative = sheet.strip_prefix(&root).map_err(|_| outside())?.to_path_buf();
        if !sheet.is_file() {
            return Err(outside());
        }
        let target = destination.join(&relative);
        if let Some(folder) = target.parent() {
            io(folder, fs::create_dir_all(folder))?;
        }
        io(&sheet, fs::copy(&sheet, &target))?;
        let text = io(&sheet, fs::read_to_string(&sheet))?;
        let folder = sheet.parent().unwrap_or(&root);
        pending.extend(sheet_file.captures_iter(&text).map(|found| folder.join(found[1].replace("${KIPRJMOD}", &root.display().to_string()))));
        seen.insert(sheet);
    }
    let mut names: Vec<String> = seen.iter().filter_map(|sheet| sheet.strip_prefix(&root).ok()).map(|path| path.display().to_string()).collect();
    names.sort();
    Ok(names)
}

fn count<T: Ord>(items: impl Iterator<Item = T>) -> BTreeMap<T, usize> {
    let mut counts = BTreeMap::new();
    for item in items {
        *counts.entry(item).or_insert(0) += 1;
    }
    counts
}

fn list(drc: &Value, key: &str) -> Vec<Value> {
    drc[key].as_array().cloned().unwrap_or_default()
}

/// Each error by its type and the uuids of its items.
fn errors(drc: &Value) -> BTreeMap<(String, Vec<String>), usize> {
    let identity = |finding: &Value| {
        let mut ids: Vec<String> = list(finding, "items").iter().map(|item| item["uuid"].as_str().unwrap_or_default().to_string()).collect();
        ids.sort();
        (finding["type"].as_str().unwrap_or_default().to_string(), ids)
    };
    count(list(drc, "violations").iter().filter(|finding| finding["severity"] == "error").map(identity))
}

/// Complete native content, with type, uuids, names and coordinates: equal counts cannot conceal a replaced parity fault.
fn parity_identities(drc: &Value) -> BTreeMap<String, usize> {
    count(list(drc, "schematic_parity").iter().map(Value::to_string))
}

/// Anything `after` holds more often than `before`.
fn grew<T: Ord>(before: &BTreeMap<T, usize>, after: &BTreeMap<T, usize>) -> bool {
    after.iter().any(|(key, times)| before.get(key).copied().unwrap_or(0) < *times)
}

/// The decision on a proposal, and why.
pub fn acceptable(before: &Value, after: &Value, old_board: &Rows, new_board: &Rows) -> (bool, &'static str) {
    if old_board.iter().any(|(key, row)| new_board.get(key) != Some(row)) {
        return (false, "existing copper, parts, setup or zone policies changed");
    }
    if new_board.keys().any(|key| !old_board.contains_key(key) && !matches!(key.0.as_str(), "segment" | "via")) {
        return (false, "non-copper addition");
    }
    let (old, new) = (errors(before), errors(after));
    if grew(&old, &new) {
        return (false, "new native errors");
    }
    if new.values().sum::<usize>() >= old.values().sum::<usize>() {
        return (false, "no native error improvement");
    }
    if grew(&parity_identities(before), &parity_identities(after)) {
        return (false, "schematic parity regressed");
    }
    if list(after, "unconnected_items").len() > list(before, "unconnected_items").len() {
        return (false, "native opens regressed");
    }
    (true, "native errors reduced; policies and existing geometry preserved")
}

/// The native steps of a repair.
pub trait Native {
    fn inventory(&self, board: &Path) -> Result<(Pads, Zones), Stop>;
    /// DRC with fresh fills and schematic parity into `report`; its exit code.
    fn drc(&self, stage: &str, board: &Path, report: &Path, log: &Path, deadline: f64) -> Result<i32, Stop>;
    /// Vias for `options.only` on `board`, saved as `out`.
    fn propose(&self, board: &Path, out: &Path, options: &ViaOptions, log: &Path) -> Result<(), Stop>;
}

pub struct Request<'a> {
    pub board: &'a Path,
    /// The source board: its project and schematic are what the copy needs.
    pub project: &'a Path,
    pub planes: &'a BTreeSet<String>,
    pub via_args: &'a [String],
    pub events: Option<&'a Path>,
    pub label: &'a str,
    pub deadline: f64,
}

/// A new folder beside the board, kept on rejection as the evidence.
fn work_folder(request: &Request) -> Result<PathBuf, Stop> {
    let parent = request.board.parent().unwrap_or(Path::new("."));
    for n in 0..1000 {
        let folder = parent.join(format!("{}-{}-{n}", request.label, std::process::id()));
        match fs::create_dir(&folder) {
            Ok(()) => return Ok(folder),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(Stop::failed(format!("{}: {error}", folder.display()))),
        }
    }
    Err(Stop::failed("no free thermal repair folder"))
}

fn copy_tree(from: &Path, to: &Path, deadline: f64) -> Result<(), Stop> {
    io(to, fs::create_dir_all(to))?;
    for entry in io(from, fs::read_dir(from))? {
        let path = io(from, entry)?.path();
        check_budget(deadline, "copy-native-project")?;
        let target = to.join(path.file_name().unwrap_or_default());
        if path.is_dir() {
            copy_tree(&path, &target, deadline)?;
        } else {
            io(&path, fs::copy(&path, &target))?;
        }
    }
    Ok(())
}

/// The project beside `source`: enough for KiCad to keep its name and check parity.
fn copy_project(source: &Path, folder: &Path, deadline: f64) -> Result<(), Stop> {
    let parent = source.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or(Path::new("."));
    for entry in io(parent, fs::read_dir(parent))? {
        check_budget(deadline, "copy-native-project")?;
        let path = io(parent, entry)?.path();
        let name = path.file_name().unwrap_or_default();
        let side = path.extension().and_then(|extension| extension.to_str()).is_some_and(|extension| matches!(extension, "kicad_pro" | "kicad_dru" | "kicad_sch" | "kicad_sym"));
        if path.is_file() && side {
            io(&path, fs::copy(&path, folder.join(name)))?;
        } else if path.is_dir() && (name == "blocks" || name == "BASE.pretty") {
            copy_tree(&path, &folder.join(name), deadline)?;
        }
    }
    for name in ["sym-lib-table", "fp-lib-table"] {
        let table = parent.join(name);
        if table.is_file() {
            io(&table, fs::copy(&table, folder.join(name)))?;
        }
    }
    Ok(())
}

fn hash_sidecars(root: &Path, folder: &Path, deadline: f64, out: &mut BTreeMap<PathBuf, String>) -> Result<(), Stop> {
    for entry in io(folder, fs::read_dir(folder))? {
        check_budget(deadline, "hash-native-sidecars")?;
        let path = io(folder, entry)?.path();
        if path.is_dir() {
            hash_sidecars(root, &path, deadline, out)?;
        } else if path.extension().and_then(|extension| extension.to_str()).is_some_and(|extension| SIDECARS.contains(&extension)) {
            out.insert(path.strip_prefix(root).unwrap_or(&path).to_path_buf(), digest(&path)?);
        }
    }
    Ok(())
}

/// DRC of the candidate; a report without parity evidence proves nothing.
fn check(native: &impl Native, request: &Request, folder: &Path, candidate: &Path, name: &str) -> Result<Value, Stop> {
    let report = folder.join(format!("{name}.json"));
    let stage = format!("{}-{name}", request.label);
    let code = native.drc(&stage, candidate, &report, &folder.join(format!("{name}.log")), request.deadline)?;
    if code != 0 || !report.is_file() {
        return Err(Stop::failed("independent native thermal validation failed"));
    }
    let checked = finish::validated(&report)?;
    if !checked["schematic_parity"].is_array() {
        return Err(Stop::failed("native parity evidence unavailable"));
    }
    Ok(checked)
}

/// The proposal on the copy. The DRC that replaces the job's when it is accepted, else None.
fn attempt(native: &impl Native, request: &Request, folder: &Path, evidence: &mut Value) -> Result<Option<Value>, Stop> {
    let deadline = request.deadline;
    let candidate = folder.join(request.project.file_name().unwrap_or_default());
    copy_project(request.project, folder, deadline)?;
    check_budget(deadline, "copy-native-project")?;
    io(request.board, fs::copy(request.board, &candidate))?;
    evidence["schematic_files"] = json!(copy_hierarchy(request.project, folder, deadline)?);
    let mut sidecars = BTreeMap::new();
    hash_sidecars(folder, folder, deadline, &mut sidecars)?;
    let old_state = immutable_board(&candidate, Some(deadline))?;
    let before = check(native, request, folder, &candidate, "before")?;
    // A refill can change the faults: detect against this evidence, not the job's.
    let (pads, zones) = native.inventory(&candidate)?;
    let targets = thermal_targets(&before, &pads, &zones, request.planes)?;
    evidence["targets"] = json!(targets);
    for (net, names) in &targets {
        let proposal = folder.join("proposal.kicad_pcb");
        let mut options = prepare::via_options(net, request.via_args)?;
        options.only = names.iter().cloned().collect();
        native.propose(&candidate, &proposal, &options, &folder.join("repair.log"))?;
        check_budget(deadline, "thermal-copper-proposal")?;
        if !proposal.is_file() {
            return Err(Stop::failed("thermal copper proposal failed"));
        }
        io(&proposal, fs::rename(&proposal, &candidate))?;
    }
    let after = check(native, request, folder, &candidate, "after")?;
    for (path, hash) in &sidecars {
        check_budget(deadline, "verify-native-sidecars")?;
        if digest(folder.join(path))? != *hash {
            return Err(Stop::failed("native project, rules or schematic changed during proposal"));
        }
    }
    let (accepted, reason) = acceptable(&before, &after, &old_state, &immutable_board(&candidate, Some(deadline))?);
    check_budget(deadline, "accept-native-thermal-proposal")?;
    let thermal = |finding: &&Value| finding["type"] == "starved_thermal" && finding["severity"] == "error";
    evidence["accepted"] = json!(accepted);
    evidence["reason"] = json!(reason);
    evidence["errors_before"] = json!(errors(&before).values().sum::<usize>());
    evidence["errors_after"] = json!(errors(&after).values().sum::<usize>());
    evidence["remaining_thermal"] = json!(list(&after, "violations").iter().filter(thermal).count());
    evidence["board_sha256"] = json!(digest(&candidate)?);
    if !accepted {
        return Ok(None);
    }
    io(&candidate, fs::rename(&candidate, request.board))?;
    Ok(Some(after))
}

fn record(request: &Request, folder: &Path, evidence: &Value, status: &str) -> Result<(), Stop> {
    let mut decision = evidence.clone();
    decision["status"] = json!(status);
    atomic_json(folder.join("decision.json"), &decision)?;
    if let Some(events) = request.events {
        decision["stage"] = json!(request.label);
        append_line(events, &decision.to_string())?;
    }
    Ok(())
}

/// The job's DRC, changed only by an accepted proposal, and the evidence. The folder stays for a rejection or a timeout, and a
/// timeout goes on to the caller: it never counts as a decision on the board.
pub fn repair(native: &impl Native, request: &Request, drc: Value) -> Result<(Value, Value), Stop> {
    let (pads, zones) = native.inventory(request.board)?;
    let targets = thermal_targets(&drc, &pads, &zones, request.planes)?;
    let mut evidence = json!({"targets": targets, "accepted": false, "qualified": false});
    if targets.is_empty() {
        evidence["reason"] = json!("no plane thermal targets");
        return Ok((drc, evidence));
    }
    if request.via_args.iter().any(|word| PROHIBITED.contains(&word.split('=').next().unwrap_or_default())) {
        evidence["reason"] = json!("thermal repair prohibits identity overrides and in-pad vias");
        return Ok((drc, evidence));
    }
    let folder = work_folder(request)?;
    evidence["directory"] = json!(folder.display().to_string());
    if !with_suffix(request.project, "kicad_sch").is_file() {
        evidence["reason"] = json!("source schematic unavailable; parity cannot be proven");
        atomic_json(folder.join("decision.json"), &evidence)?;
        return Ok((drc, evidence));
    }
    let mut result = drc.clone();
    match attempt(native, request, &folder, &mut evidence) {
        Ok(Some(after)) => result = after,
        Ok(None) => {}
        Err(stop @ Stop::Timeout { .. }) => {
            evidence["accepted"] = json!(false);
            evidence["reason"] = json!(stop.reason());
            let checkpoint = json!({"status": "timeout", "qualified": false, "accepted": false, "board_sha256": digest(request.board)?, "native_evidence": drc});
            atomic_json(folder.join("checkpoint.json"), &checkpoint)?;
            record(request, &folder, &evidence, "timeout")?;
            return Err(stop);
        }
        Err(stop @ Stop::Exit { .. }) => evidence["reason"] = json!(stop.reason()),
        Err(stop) => return Err(stop),
    }
    let accepted = evidence["accepted"] == true;
    record(request, &folder, &evidence, if accepted { "complete" } else { "rejected" })?;
    Ok((result, evidence))
}

struct JobNative<'a>(&'a Job);

impl Native for JobNative<'_> {
    fn inventory(&self, board: &Path) -> Result<(Pads, Zones), Stop> {
        let (board, _) = prepare::read(board)?;
        let pads = board.pads().map(|(footprint, pad)| (pad.id.clone(), (footprint.reference.clone(), pad.number.clone(), pad.net.clone()))).collect();
        Ok((pads, board.zones.iter().map(|zone| (zone.id.clone(), zone.net.clone())).collect()))
    }

    fn drc(&self, stage: &str, board: &Path, report: &Path, log: &Path, deadline: f64) -> Result<i32, Stop> {
        let words = [self.0.cli.as_str(), "pcb", "drc", "--refill-zones", "--schematic-parity", "--severity-all", "--format", "json", "--units", "mm", "-o"];
        let command = words.iter().map(|word| word.to_string()).chain([report.display().to_string(), board.display().to_string()]).collect();
        Ok(self.0.runner.run(Spec::new(stage, command).deadline(Some(deadline)).logged(log), |_| ())?.returncode)
    }

    fn propose(&self, board: &Path, out: &Path, options: &ViaOptions, log: &Path) -> Result<(), Stop> {
        let plan = gnd_pad_vias::run(board, out, options)?;
        for line in gnd_pad_vias::summary(&plan, &options.net) {
            append_line(log, &line)?;
        }
        Ok(())
    }
}

/// `repair` for the job, on `board`, with the budget of one repair.
pub fn run(job: &Job, board: &Path, project: &Path, drc: Value, via_args: &[String], label: &str) -> Result<(Value, Value), Stop> {
    let deadline = clock::after(BUDGET_S, job.runner.env())?;
    let events = job.file("stages.jsonl");
    let request = Request { board, project, planes: &job.plane_names, via_args, events: Some(&events), label, deadline };
    let (drc, evidence) = repair(&JobNative(job), &request, drc)?;
    if !evidence["targets"].as_object().is_none_or(|targets| targets.is_empty()) {
        println!("THERMAL {label}: accepted {} ({})", evidence["accepted"], evidence["reason"].as_str().unwrap_or_default());
    }
    Ok((drc, evidence))
}

#[cfg(test)]
mod tests;
