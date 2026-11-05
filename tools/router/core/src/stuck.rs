//! `iotroute stuck WORK BOARD [--previous STUCK.json]`: what a failed route left, short enough to read each round. WORK/stuck.json,
//! schema `iot-lab.stuck-report.v1`, and its `summary` lines on stdout.
//!
//! It only reads what the run wrote into WORK: drc.json (the verdict), open-triage.json and pin-escape.json (`iotroute run --diagnose`),
//! checkpoint.json (how the search ended), model.json (which layers a net may use) and seed.json (the run started from an earlier
//! one: `reused`). A file that is not there leaves its part out;
//! only drc.json is needed. Same files, same report: no clock, no search, no LLM.
//!
//! Native DRC owns the open connections, including ones without optional diagnosis. ENCLOSED and ROUTER_MISS describe only the
//! diagnosis grid, not physical impossibility or a native-verified path. Unmatched/absent diagnosis leaves the cause UNKNOWN.
//! `open_nets` contains native names; coverage records unidentified/unlocated connections. Rows stop at MAX_ROWS.
use crate::grid::opens::{bracket_net, pad_of};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

pub const SCHEMA: &str = "iot-lab.stuck-report.v1";
/// Display limits, not rules, as in the checkpoint: enough to act on, small enough to read each round.
const MAX_ROWS: usize = 8;
const MAX_NAMES: usize = 5;
const MAX_HOT: usize = 3;
const MAX_TEXT: usize = 60;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct End {
    pub at: String,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Row {
    pub net: String,
    pub class: String,
    /// Open connections of this net in this class; `from` and `to` are the first of them.
    pub connections: usize,
    pub from: End,
    pub to: End,
    pub why: String,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct Blockers {
    pub parts: Vec<String>,
    pub nets: Vec<String>,
    pub keepouts: Vec<String>,
    /// Nets the model holds to fewer layers than the board has: "/A: F.Cu".
    pub layers: Vec<String>,
    /// Pads that cannot leave their part: "U1.3".
    pub boxed_in: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Changed {
    pub open_before: usize,
    pub open_now: usize,
    pub unconnected_before: usize,
    pub unconnected_now: usize,
    pub drc_before: usize,
    pub drc_now: usize,
    pub parity_before: usize,
    pub parity_now: usize,
    /// Legacy reports may have omitted undiagnosed net names.
    pub names_comparable: bool,
    /// More, or fewer, DRC errors and open connections than the report before.
    pub worse: bool,
    pub better: bool,
    pub new: Vec<String>,
    pub resolved: Vec<String>,
    pub same: usize,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct Coverage {
    pub native_connections: usize,
    pub diagnosed_connections: usize,
    pub undiagnosed_connections: usize,
    /// Native entries missing at least one usable endpoint position.
    pub unlocated_connections: usize,
    pub unidentified_connections: usize,
    /// Diagnostic rows that do not identify a current native open connection.
    pub unused_diagnoses: usize,
    pub parity_reported: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Report {
    pub schema: &'static str,
    pub board: String,
    /// The folder of the files read, for a later `iotroute stuck`.
    pub work: String,
    pub drc_errors: usize,
    pub unconnected: usize,
    pub parity: usize,
    pub enclosed: usize,
    pub router_miss: usize,
    pub unknown: usize,
    /// The search as the checkpoint left it; null without one.
    pub search: Value,
    /// The layers the board routes on, planes left out.
    pub route_layers: Vec<String>,
    /// This run started from the copper of an earlier one.
    pub reused: bool,
    pub open_nets: Vec<String>,
    pub rows: Vec<Row>,
    /// The box of all stuck ends, mm: x0, y0, x1, y1.
    pub region: Option<[f64; 4]>,
    pub hot: Vec<Value>,
    pub blockers: Blockers,
    /// DRC errors by type, most first, with one place of each.
    pub drc: Vec<Value>,
    pub changed: Option<Changed>,
    pub coverage: Coverage,
    pub comparison_note: Option<String>,
    pub summary: Vec<String>,
}

impl Report {
    pub fn line(&self) -> String {
        format!("STUCK {}", self.summary[0])
    }
}

/// What a report is made from, parsed.
#[derive(Debug, Default)]
pub struct Sources {
    pub drc: Value,
    pub triage: Value,
    pub escape: Value,
    pub checkpoint: Value,
    pub model: Value,
    pub previous: Value,
    pub reused: bool,
}

fn list(value: &Value) -> &[Value] {
    value.as_array().map_or(&[], Vec::as_slice)
}

fn names(value: &Value) -> impl Iterator<Item = &str> {
    list(value).iter().filter_map(Value::as_str)
}

fn clip(text: &str) -> String {
    if text.chars().count() <= MAX_TEXT { text.to_string() } else { format!("{}...", text.chars().take(MAX_TEXT).collect::<String>()) }
}

fn r1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

/// Most counted first, then by name.
fn top(counts: &BTreeMap<String, usize>) -> Vec<String> {
    let mut ranked: Vec<(&String, &usize)> = counts.iter().collect();
    ranked.sort_by_key(|(name, count)| (std::cmp::Reverse(**count), (*name).clone()));
    ranked.into_iter().take(MAX_NAMES).map(|(name, _)| name.clone()).collect()
}

fn end(description: &Value, pos: &Value) -> End {
    let text = description.as_str().unwrap_or("");
    let at = pad_of(text).map_or_else(|| clip(text), |(number, _, reference)| format!("{reference}.{number}"));
    End { at, x: r1(pos["x"].as_f64().unwrap_or(0.0)), y: r1(pos["y"].as_f64().unwrap_or(0.0)) }
}

fn walled_by(connection: &Value) -> String {
    let named = |key: &str, prefix: &str| names(&connection[key]).take(3).map(|name| format!("{prefix}{name}")).collect::<Vec<_>>();
    [named("blocking_parts", ""), named("blocking_keepouts", "keepout "), named("blocking_nets", "net ")].concat().join(", ")
}

/// Why this connection is open, from the triage and what the search said of its net.
fn why(connection: &Value, search_why: Option<&str>, layers: Option<&String>) -> String {
    let mut text = match connection["class"].as_str() {
        Some("ENCLOSED") => format!("no path on diagnosis grid ({} mm2): {}", connection["region_mm2"], walled_by(connection)),
        Some("ROUTER_MISS") if search_why.is_some_and(|why| why.contains("search limit")) => "search limit hit: not proved blocked".to_string(),
        Some("ROUTER_MISS") => format!("path found on diagnosis grid; router: {}", search_why.map_or("left it open".to_string(), clip)),
        _ if connection["diagnosed"] == true => "diagnosis did not establish a cause".to_string(),
        _ => "native connection open; cause not diagnosed".to_string(),
    };
    if let Some(layers) = layers {
        text.push_str(&format!("; only on {layers}"));
    }
    text
}

/// Native DRC owns connectivity. Diagnosis can annotate a matching connection,
/// but cannot invent an open net or hide an undiagnosed native connection.
fn native_connections(s: &Sources) -> (Vec<Value>, Vec<String>, Coverage) {
    let diagnostics = list(&s.triage["connections"]);
    let mut used = vec![false; diagnostics.len()];
    let mut rows = Vec::new();
    let mut nets = BTreeSet::new();
    let mut coverage = Coverage { native_connections: list(&s.drc["unconnected_items"]).len(), parity_reported: s.drc["schematic_parity"].is_array(), ..Coverage::default() };
    let located = |p: &Value| p["x"].as_f64().is_some() && p["y"].as_f64().is_some();
    let same_end = |d: &Value, p: &Value, item: &Value| d == &item["description"] && p == &item["pos"];
    for native in list(&s.drc["unconnected_items"]) {
        let items = list(&native["items"]);
        let found: BTreeSet<&str> = items.iter().filter_map(|i| i["description"].as_str().and_then(bracket_net)).filter(|n| !n.is_empty()).collect();
        nets.extend(found.iter().map(|n| n.to_string()));
        let net = if found.len() == 1 { *found.first().unwrap() } else { coverage.unidentified_connections += 1; "" };
        let (Some(a), Some(b)) = (items.first(), items.get(1)) else { coverage.unlocated_connections += 1; continue };
        if !located(&a["pos"]) || !located(&b["pos"]) { coverage.unlocated_connections += 1; continue; }
        let matched = diagnostics.iter().enumerate().find(|(i, d)| !used[*i] && !net.is_empty() && d["net"] == net && (
            (same_end(&d["a"], &d["a_pos"], a) && same_end(&d["b"], &d["b_pos"], b)) ||
            (same_end(&d["a"], &d["a_pos"], b) && same_end(&d["b"], &d["b_pos"], a))));
        let mut row = matched.map_or_else(|| json!({"class":"UNKNOWN"}), |(i, d)| { used[i] = true; coverage.diagnosed_connections += 1; d.clone() });
        row["net"] = net.into(); row["a"] = a["description"].clone(); row["a_pos"] = a["pos"].clone();
        row["b"] = b["description"].clone(); row["b_pos"] = b["pos"].clone();
        row["diagnosed"] = matched.is_some().into();
        rows.push(row);
    }
    coverage.undiagnosed_connections = coverage.native_connections - coverage.diagnosed_connections;
    coverage.unused_diagnoses = used.iter().filter(|u| !**u).count();
    (rows, nets.into_iter().collect(), coverage)
}

fn route_layers(model: &Value) -> Vec<String> {
    let planes: BTreeSet<&str> = names(&model["plane_layers"]).collect();
    names(&model["copper_layers"]).filter(|layer| !planes.contains(layer)).map(str::to_string).collect()
}

/// The nets the model holds to fewer layers than the board routes.
fn layer_limits(model: &Value) -> BTreeMap<String, String> {
    let all = route_layers(model).len();
    let nets = model["nets"].as_object().into_iter().flatten();
    nets.filter(|(_, net)| !list(&net["layers"]).is_empty() && list(&net["layers"]).len() < all).map(|(name, net)| (name.clone(), names(&net["layers"]).collect::<Vec<_>>().join(","))).collect()
}

fn search(checkpoint: &Value) -> Value {
    if checkpoint.is_null() {
        return Value::Null;
    }
    json!({"state": checkpoint["state"], "stop": checkpoint["stop"], "pass": checkpoint["pass"], "max_passes": checkpoint["max_passes"], "best_pass": checkpoint["best"]["pass"],
           "passes_since_best": checkpoint["passes_since_best"], "unrouted": checkpoint["unrouted"], "conflict_pairs": checkpoint["conflicts"]["pairs"], "search_limited": checkpoint["conflicts"]["search_limited"]})
}

/// DRC errors by type, and where the first of each is.
fn drc_errors(drc: &Value) -> (usize, Vec<Value>) {
    let errors: Vec<&Value> = list(&drc["violations"]).iter().filter(|v| v["severity"] == "error").collect();
    let mut kinds: BTreeMap<&str, (usize, &Value)> = BTreeMap::new();
    for error in &errors {
        kinds.entry(error["type"].as_str().unwrap_or("?")).or_insert((0, *error)).0 += 1;
    }
    let mut ranked: Vec<_> = kinds.into_iter().collect();
    ranked.sort_by_key(|(kind, (count, _))| (std::cmp::Reverse(*count), *kind));
    let rows = ranked.into_iter().take(MAX_NAMES).map(|(kind, (count, first))| {
        let pos = &first["items"][0]["pos"];
        json!({"type": kind, "count": count, "x": pos["x"].as_f64().map(r1), "y": pos["y"].as_f64().map(r1)})
    });
    (errors.len(), rows.collect())
}

fn changed(previous: &Value, board: &str, open: &[String], unconnected: usize, errors: usize, parity: usize, identified: bool) -> Option<Changed> {
    if previous["board"] != board { return None; }
    if previous["coverage"]["parity_reported"] == false { return None; }
    let before: BTreeSet<&str> = previous["open_nets"].as_array().map(|_| names(&previous["open_nets"]).collect())?;
    let now: BTreeSet<&str> = open.iter().map(String::as_str).collect();
    let count = |key: &str| previous[key].as_u64().map(|v| v as usize);
    let (before_open, before_errors, before_parity) = (count("unconnected")?, count("drc_errors")?, count("parity")?);
    let names_comparable = identified && ((before_open == 0 && before.is_empty()) ||
        (previous["coverage"]["native_connections"].as_u64() == Some(before_open as u64) && previous["coverage"]["unidentified_connections"] == 0));
    let (problems, problems_before) = (unconnected + errors + parity, before_open + before_errors + before_parity);
    let first = |set: Vec<&&str>| set.into_iter().take(MAX_NAMES).map(|net| net.to_string()).collect();
    Some(Changed { open_before: before.len(), open_now: now.len(), unconnected_before: before_open, unconnected_now: unconnected,
        drc_before: before_errors, drc_now: errors, parity_before: before_parity, parity_now: parity, names_comparable,
        worse: problems > problems_before, better: problems < problems_before,
        new: if names_comparable { first(now.difference(&before).collect()) } else { Vec::new() },
        resolved: if names_comparable { first(before.difference(&now).collect()) } else { Vec::new() }, same: if names_comparable { now.intersection(&before).count() } else { 0 } })
}

fn summary(report: &Report) -> Vec<String> {
    let parity = if report.coverage.parity_reported { report.parity.to_string() } else { "not reported".into() };
    let mut lines = vec![format!("{} named nets open: {} grid blocked, {} grid path found, {} unknown; DRC errors {} unconnected {} parity {}", report.open_nets.len(), report.enclosed, report.router_miss, report.unknown, report.drc_errors, report.unconnected, parity)];
    let c = &report.coverage;
    if c.undiagnosed_connections + c.unlocated_connections + c.unidentified_connections + c.unused_diagnoses > 0 {
        lines.push(format!("diagnosis coverage: {} of {} native connections; {} unlocated, {} unidentified, {} unmatched diagnoses", c.diagnosed_connections, c.native_connections, c.unlocated_connections, c.unidentified_connections, c.unused_diagnoses));
    }
    if !report.search.is_null() {
        let stop = report.search["stop"].as_str().unwrap_or("not stopped");
        lines.push(format!("search: stop {stop} at pass {} of {}, best pass {}, {} search-limited", report.search["pass"], report.search["max_passes"], report.search["best_pass"], report.search["search_limited"]));
    }
    if let Some([x0, y0, x1, y1]) = report.region {
        let hot = report.hot.first().map_or(String::new(), |cell| format!(", hottest ({}, {}) {}", cell["x"], cell["y"], cell["layer"].as_str().unwrap_or("")));
        lines.push(format!("where: x {x0}..{x1} y {y0}..{y1} mm{hot}"));
    }
    lines.extend(report.rows.iter().map(|row| format!("{} x{} {} ({}, {}) -> {} ({}, {}): {}", if row.net.is_empty() { "unidentified net".into() } else { clip(&row.net) }, row.connections, row.from.at, row.from.x, row.from.y, row.to.at, row.to.x, row.to.y, clip(&row.why))));
    if report.open_nets.len() > report.rows.len() {
        lines.push(format!("and {} more nets", report.open_nets.len() - report.rows.len()));
    }
    let b = &report.blockers;
    let blocks = [("parts", &b.parts), ("nets", &b.nets), ("keepouts", &b.keepouts), ("layer limits", &b.layers), ("boxed-in pads", &b.boxed_in)];
    let blocks: Vec<String> = blocks.iter().filter(|(_, found)| !found.is_empty()).map(|(name, found)| format!("{name} {}", found.join(" "))).collect();
    if !blocks.is_empty() {
        lines.push(format!("diagnosis context: {}", blocks.join("; ")));
    }
    lines.extend(report.drc.iter().map(|row| format!("DRC {} x{} first at ({}, {})", row["type"].as_str().unwrap_or("?"), row["count"], row["x"], row["y"])));
    if let Some(c) = &report.changed {
        let verdict = if c.worse { "WORSE: " } else { "" };
        lines.push(format!("changed: {verdict}DRC {} -> {}, connections {} -> {}, parity {} -> {}; {}", c.drc_before, c.drc_now, c.unconnected_before, c.unconnected_now, c.parity_before, c.parity_now,
            if c.names_comparable { format!("new {}, resolved {}, same {}", if c.new.is_empty() { "none".to_string() } else { c.new.join(" ") }, if c.resolved.is_empty() { "none".to_string() } else { c.resolved.join(" ") }, c.same) } else { "net-name changes unknown".to_string() }));
    }
    lines.extend(report.comparison_note.iter().cloned());
    lines
}

/// The report of these sources.
pub fn report(board: &str, work: &str, s: &Sources) -> Report {
    let (connections, open_nets, coverage) = native_connections(s);
    let reasons: BTreeMap<&str, &str> = list(&s.checkpoint["worst_nets"]).iter().filter_map(|w| Some((w["net"].as_str()?, w["why"].as_str()?))).collect();
    let limits = layer_limits(&s.model);
    let rows: Vec<Row> = connections.iter().map(|c| {
        let net = c["net"].as_str().unwrap_or("");
        Row { net: net.to_string(), class: c["class"].as_str().unwrap_or("UNKNOWN").to_string(), connections: 1, from: end(&c["a"], &c["a_pos"]), to: end(&c["b"], &c["b_pos"]), why: why(c, reasons.get(net).copied(), limits.get(net)) }
    }).collect();
    let region = list(&s.drc["unconnected_items"]).iter().flat_map(|u| list(&u["items"]))
        .filter_map(|item| Some((r1(item["pos"]["x"].as_f64()?), r1(item["pos"]["y"].as_f64()?))))
        .fold(None, |bbox: Option<[f64; 4]>, (x, y)| {
        Some(bbox.map_or([x, y, x, y], |[x0, y0, x1, y1]| [x0.min(x), y0.min(y), x1.max(x), y1.max(y)]))
    });
    let tally = |key: &str| {
        let mut counts = BTreeMap::new();
        connections.iter().flat_map(|c| names(&c[key])).for_each(|name| *counts.entry(name.to_string()).or_insert(0) += 1);
        top(&counts)
    };
    let layers = open_nets.iter().filter_map(|net| limits.get(net).map(|on| format!("{net}: {on}"))).take(MAX_NAMES).collect();
    let boxed_in = list(&s.escape["boxed_in"]).iter().filter(|pad| pad["net"].as_str().is_some_and(|n| open_nets.iter().any(|v| v == n)))
        .take(MAX_NAMES).map(|pad| format!("{}.{}", pad["ref"].as_str().unwrap_or("?"), pad["pad"].as_str().unwrap_or("?"))).collect();
    let (errors, drc) = drc_errors(&s.drc);
    let unconnected = list(&s.drc["unconnected_items"]).len();
    let count = |class: &str| rows.iter().filter(|row| row.class == class).count();
    // Show diagnosis-grid blockage first; it does not prescribe a board move.
    let mut shown: Vec<Row> = Vec::new();
    for row in &rows {
        match shown.iter_mut().find(|seen| seen.net == row.net && seen.class == row.class) {
            Some(seen) => seen.connections += 1,
            None => shown.push(row.clone()),
        }
    }
    shown.sort_by_key(|row| row.class != "ENCLOSED");
    shown.truncate(MAX_ROWS);
    let parity = list(&s.drc["schematic_parity"]).len();
    let changed = coverage.parity_reported.then(|| changed(&s.previous, board, &open_nets, unconnected, errors, parity, coverage.unidentified_connections == 0)).flatten();
    let comparison_note = (!s.previous.is_null() && changed.is_none()).then(|| "change unknown: board identity or native counter coverage does not match".to_string());
    let mut report = Report {
        schema: SCHEMA, board: board.to_string(), work: work.to_string(), drc_errors: errors, unconnected, parity: list(&s.drc["schematic_parity"]).len(),
        enclosed: count("ENCLOSED"), router_miss: count("ROUTER_MISS"), unknown: unconnected.saturating_sub(count("ENCLOSED") + count("ROUTER_MISS")), search: search(&s.checkpoint),
        route_layers: route_layers(&s.model), reused: s.reused, changed, coverage, comparison_note, open_nets, rows: shown, region, hot: list(&s.checkpoint["hot"]).iter().take(MAX_HOT).cloned().collect(),
        blockers: Blockers { parts: tally("blocking_parts"), nets: tally("blocking_nets"), keepouts: tally("blocking_keepouts"), layers, boxed_in }, drc, summary: Vec::new(),
    };
    report.summary = summary(&report);
    report
}

fn read(path: &Path) -> Result<Value, String> {
    serde_json::from_str(&fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?).map_err(|e| format!("{}: {e}", path.display()))
}

/// A part left out when its file is not there; a file that does not parse is an error.
fn optional(path: &Path) -> Result<Value, String> {
    if path.is_file() { read(path) } else { Ok(Value::Null) }
}

/// WORK/stuck.json from the files of the run in WORK.
pub fn write(work: &Path, board: &str, previous: Option<&Path>) -> Result<Report, String> {
    let sources = Sources {
        drc: read(&work.join("drc.json"))?, triage: optional(&work.join("open-triage.json"))?, escape: optional(&work.join("pin-escape.json"))?, checkpoint: optional(&work.join("checkpoint.json"))?,
        model: optional(&work.join("model.json"))?, previous: previous.map_or(Ok(Value::Null), read)?, reused: work.join("seed.json").is_file(),
    };
    if !sources.drc["unconnected_items"].is_array() || !sources.drc["violations"].is_array() {
        return Err("drc.json needs native unconnected_items and violations arrays".into());
    }
    if !sources.drc["schematic_parity"].is_null() && !sources.drc["schematic_parity"].is_array() {
        return Err("drc.json schematic_parity must be a native array when reported".into());
    }
    if sources.drc["coordinate_units"].as_str().is_some_and(|units| units != "mm") {
        return Err("stuck report needs native DRC coordinates in mm".into());
    }
    let report = report(board, &work.display().to_string(), &sources);
    let path = work.join("stuck.json");
    fs::write(&path, serde_json::to_string_pretty(&report).map_err(|e| e.to_string())? + "\n").map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(report)
}

pub fn cli(args: &[String]) -> i32 {
    let usage = "usage: iotroute stuck WORK BOARD [--previous STUCK.json]";
    let (work, board, previous) = match args {
        [work, board] => (work, board, None),
        [work, board, flag, previous] if flag == "--previous" => (work, board, Some(Path::new(previous))),
        _ => {
            eprintln!("{usage}");
            return 2;
        }
    };
    match write(Path::new(work), board, previous) {
        Ok(report) => {
            println!("{}", report.summary.join("\n"));
            0
        }
        Err(error) => {
            eprintln!("{error}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pad(number: u32, net: &str, part: &str) -> String {
        format!("Pad {number} [{net}] of {part} on F.Cu")
    }

    fn sources() -> Sources {
        let mut sources = Sources {
            drc: json!({"unconnected_items": [{}, {}], "schematic_parity":[], "violations": [{"severity": "error", "type": "clearance", "items": [{"pos": {"x": 9.04, "y": 8.0}}]}, {"severity": "warning", "type": "silk"}]}),
            triage: json!({"connections": [
                {"net": "/SDA", "class": "ROUTER_MISS", "a": pad(1, "/SDA", "R1"), "b": pad(2, "/SDA", "U1"), "a_pos": {"x": 10.04, "y": 20.0}, "b_pos": {"x": 12.0, "y": 21.0}},
                {"net": "/INT", "class": "ENCLOSED", "a": pad(4, "/INT", "U1"), "b": pad(1, "/INT", "J1"), "a_pos": {"x": 11.0, "y": 22.0}, "b_pos": {"x": 30.0, "y": 25.0}, "region_mm2": 0.6,
                 "blocking_parts": ["U1", "C4"], "blocking_nets": ["/SCL"], "blocking_keepouts": ["ANT"]}]}),
            escape: json!({"boxed_in": [{"ref": "U1", "pad": "4", "net": "/INT"}]}),
            checkpoint: json!({"state": "done", "stop": "stall-passes", "pass": 31, "max_passes": 80, "best": {"pass": 24, "nets": 2, "pairs": 0}, "passes_since_best": 7, "unrouted": 2,
                "conflicts": {"pairs": 1, "search_limited": 0}, "worst_nets": [{"net": "/SDA", "why": "no path"}], "hot": [{"x": 11.5, "y": 21.5, "layer": "F.Cu", "pairs": 1}]}),
            model: json!({"copper_layers": ["F.Cu", "B.Cu"], "nets": {"/INT": {"layers": ["F.Cu"]}, "/SDA": {"layers": ["F.Cu", "B.Cu"]}}}),
            previous: Value::Null,
            reused: false,
        };
        sources.drc["unconnected_items"] = list(&sources.triage["connections"]).iter().map(|c| json!({"items":[
            {"description":c["a"],"pos":c["a_pos"]},{"description":c["b"],"pos":c["b_pos"]}]})).collect();
        sources
    }

    #[test]
    fn a_report_names_what_is_stuck_where_and_why_and_what_changed() {
        let mut s = sources();
        s.previous = json!({"board":"ENV-SENSE","open_nets": ["/SDA", "/OLD"], "unconnected": 1,"drc_errors":0,"parity":0,
            "coverage":{"native_connections":1,"unidentified_connections":0}});
        let report = report("ENV-SENSE", "w", &s);
        assert_eq!(report.open_nets, ["/INT", "/SDA"]);
        assert_eq!((report.enclosed, report.router_miss, report.drc_errors, report.unconnected), (1, 1, 1, 2));
        assert_eq!(report.region, Some([10.0, 20.0, 30.0, 25.0]));
        let expected = [
            "2 named nets open: 1 grid blocked, 1 grid path found, 0 unknown; DRC errors 1 unconnected 2 parity 0",
            "search: stop stall-passes at pass 31 of 80, best pass 24, 0 search-limited",
            "where: x 10..30 y 20..25 mm, hottest (11.5, 21.5) F.Cu",
            "/INT x1 U1.4 (11, 22) -> J1.1 (30, 25): no path on diagnosis grid (0.6 mm2): U1, C4, keepout ANT, ne...",
            "/SDA x1 R1.1 (10, 20) -> U1.2 (12, 21): path found on diagnosis grid; router: no path",
            "diagnosis context: parts C4 U1; nets /SCL; keepouts ANT; layer limits /INT: F.Cu; boxed-in pads U1.4",
            "DRC clearance x1 first at (9.0, 8.0)",
            "changed: WORSE: DRC 0 -> 1, connections 1 -> 2, parity 0 -> 0; new /INT, resolved /OLD, same 1",
        ];
        assert_eq!(report.summary, expected);
    }

    #[test]
    fn a_search_limit_is_not_called_blocked_and_the_list_stays_short() {
        let one = |n: usize| { let net = format!("/N{n}"); json!({"net": net, "class": "ROUTER_MISS", "a": pad(1, &net, "R1"), "b": pad(2, &net, "R1"), "a_pos": {"x": 0.0, "y": 0.0}, "b_pos": {"x": 1.0, "y": 1.0}}) };
        let mut s = Sources { triage: json!({"connections": (0..40).map(one).collect::<Vec<_>>()}), ..Sources::default() };
        s.drc = json!({"violations":[],"unconnected_items":list(&s.triage["connections"]).iter().map(|c| json!({"items":[
            {"description":c["a"],"pos":c["a_pos"]},{"description":c["b"],"pos":c["b_pos"]}]})).collect::<Vec<_>>()});
        s.checkpoint = json!({"worst_nets": [{"net": "/N0", "why": "search limit 200000 pops"}]});
        let report = report("B", "w", &s);
        assert_eq!((report.open_nets.len(), report.rows.len()), (40, MAX_ROWS));
        assert!(report.rows[0].why.starts_with("search limit hit"), "{}", report.rows[0].why);
        assert!(report.summary.iter().any(|line| line == "and 32 more nets"));
        assert!(report.summary.len() <= MAX_ROWS + 6, "{:?}", report.summary);
    }

    #[test]
    fn only_drc_is_needed() {
        let dir = std::env::temp_dir().join(format!("iotroute-stuck-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        assert!(write(&dir, "B", None).unwrap_err().contains("drc.json"));
        fs::write(dir.join("drc.json"), r#"{"violations": [], "unconnected_items": [], "schematic_parity": [{}]}"#).unwrap();
        let report = write(&dir, "B", None).unwrap();
        assert_eq!((report.parity, report.search.clone(), report.region), (1, Value::Null, None));
        assert!(dir.join("stuck.json").is_file());
        fs::remove_dir_all(&dir).unwrap();
    }
}

#[cfg(test)]
mod native_coverage_regressions {
    use super::*;

    fn item(net: &str, reference: &str, x: f64, y: f64) -> Value {
        json!({"description":format!("Pad 1 [{net}] of {reference} on F.Cu"),"pos":{"x":x,"y":y}})
    }

    #[test]
    fn drc_only_report_keeps_native_open_nets_connections_and_region() {
        let s = Sources { drc: json!({"unconnected_items":[
            {"items":[item("/SCL","U1",-2.0,-1.0),item("/SCL","U2",3.0,4.0)]},
            {"items":[item("GND","C1",0.0,0.0),item("GND","C2",1.0,2.0)]}],
            "violations":[],"schematic_parity":[]}), ..Sources::default() };
        let r = report("ENV-SENSE","work",&s);
        assert_eq!(r.open_nets, ["/SCL","GND"], "native opens must not disappear when --diagnose is absent");
        assert_eq!((r.unconnected,r.unknown,r.rows.len()),(2,2,2));
        assert!(r.rows.iter().all(|r|r.class=="UNKNOWN"));
        assert_eq!(r.region,Some([-2.0,-1.0,3.0,4.0]));
    }

    #[test]
    fn stale_diagnosis_and_search_progress_do_not_create_native_open_nets() {
        let s=Sources{drc:json!({"unconnected_items":[],"violations":[],"schematic_parity":[]}),
            triage:json!({"connections":[{"net":"OLD","class":"ENCLOSED"}]}),
            checkpoint:json!({"worst_nets":[{"net":"OLD","why":"search limit"}]}),..Sources::default()};
        let r=report("B","work",&s);
        assert!(r.open_nets.is_empty());
        assert!(r.rows.is_empty());
    }

    #[test]
    fn a_new_native_parity_error_is_a_worse_result() {
        let s=Sources{drc:json!({"unconnected_items":[],"violations":[],"schematic_parity":[{}]}),
            previous:json!({"board":"B","open_nets":[],"drc_errors":0,"unconnected":0,"parity":0}),..Sources::default()};
        assert!(report("B","work",&s).changed.unwrap().worse);
    }
}

#[cfg(test)]
mod coverage_edge_cases {
    use super::*;

    fn connection(net: &str, a: (f64,f64), b: (f64,f64)) -> Value {
        json!({"items":[{"description":format!("Pad 1 [{net}] of U1 on F.Cu"),"pos":{"x":a.0,"y":a.1}},
            {"description":format!("Pad 1 [{net}] of U2 on F.Cu"),"pos":{"x":b.0,"y":b.1}}]})
    }
    fn drc(connections: Vec<Value>) -> Value {
        json!({"unconnected_items":connections,"violations":[],"schematic_parity":[]})
    }

    #[test]
    fn partial_and_reversed_diagnosis_cover_only_matching_native_connections() {
        let a=connection("BUS[3]",(0.0,0.0),(4.0,5.0));
        let b=connection("GND",(8.0,9.0),(10.0,11.0));
        let diag=json!({"net":"BUS[3]","class":"ROUTER_MISS","a":a["items"][1]["description"],"a_pos":a["items"][1]["pos"],
            "b":a["items"][0]["description"],"b_pos":a["items"][0]["pos"]});
        let s=Sources{drc:drc(vec![a,b]),triage:json!({"connections":[diag,{"net":"OLD","class":"ENCLOSED","blocking_parts":["DO_NOT_MOVE"]}]}),..Sources::default()};
        let r=report("B","work",&s);
        assert_eq!(r.open_nets,["BUS[3]","GND"]);
        assert_eq!((r.router_miss,r.unknown,r.coverage.diagnosed_connections,r.coverage.unused_diagnoses),(1,1,1,1));
        assert_eq!(r.rows[0].from.at,"U1.1");
        assert!(r.blockers.parts.is_empty(),"an unmatched diagnosis cannot prescribe a part move");
    }

    #[test]
    fn missing_coordinates_are_not_invented_at_the_origin() {
        let mut a=connection("A",(0.0,0.0),(4.0,5.0));
        a["items"][0].as_object_mut().unwrap().remove("pos");
        let r=report("B","work",&Sources{drc:drc(vec![a,json!({})]),..Sources::default()});
        assert_eq!(r.open_nets,["A"]);
        assert_eq!((r.unknown,r.rows.len(),r.coverage.unlocated_connections,r.coverage.unidentified_connections),(2,0,2,1));
        assert_eq!(r.region,Some([4.0,5.0,4.0,5.0]),"only the known native endpoint contributes");
    }

    #[test]
    fn legacy_name_lists_and_other_boards_do_not_make_false_deltas() {
        let mut s=Sources{drc:drc(vec![connection("A",(1.0,2.0),(3.0,4.0))]),
            previous:json!({"board":"B","open_nets":[],"unconnected":1,"drc_errors":0,"parity":0}),..Sources::default()};
        let r=report("B","work",&s);
        let c=r.changed.unwrap();assert!(!c.names_comparable && c.new.is_empty() && !c.worse && !c.better);
        s.previous["board"]="OTHER".into();
        let r=report("B","work",&s);assert!(r.changed.is_none()&&r.comparison_note.is_some());
        s.previous["board"]="B".into();s.previous.as_object_mut().unwrap().remove("parity");
        assert!(report("B","work",&s).changed.is_none());
    }

    #[test]
    fn write_rejects_missing_native_connectivity_and_non_mm_coordinates() {
        struct Temp(std::path::PathBuf);
        impl Drop for Temp { fn drop(&mut self){let _=fs::remove_dir_all(&self.0);} }
        let d=Temp(std::env::temp_dir().join(format!("iotroute-stuck-invalid-{}",std::process::id())));
        fs::create_dir_all(&d.0).unwrap();
        fs::write(d.0.join("drc.json"),"{}").unwrap();
        assert!(write(&d.0,"B",None).unwrap_err().contains("unconnected_items"));
        fs::write(d.0.join("drc.json"),json!({"unconnected_items":[],"violations":[],"coordinate_units":"in"}).to_string()).unwrap();
        assert!(write(&d.0,"B",None).unwrap_err().contains("in mm"));
    }
}

#[cfg(test)]
mod parity_coverage_tests {
    use super::*;
    #[test]
    fn absent_parity_is_not_reported_as_zero_checked_faults() {
        let r=report("B","work",&Sources{drc:json!({"violations":[],"unconnected_items":[]}),
            previous:json!({"board":"B","drc_errors":0,"unconnected":0,"parity":0,"open_nets":[]}),..Sources::default()});
        assert!(!r.coverage.parity_reported && r.changed.is_none());
        assert!(r.summary[0].ends_with("parity not reported"));
    }
}
