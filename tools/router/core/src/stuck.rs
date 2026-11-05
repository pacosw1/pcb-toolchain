//! `iotroute stuck WORK BOARD [--previous STUCK.json]`: what a failed route left, short enough to read each round. WORK/stuck.json,
//! schema `iot-lab.stuck-report.v1`, and its `summary` lines on stdout.
//!
//! It only reads what the run wrote into WORK: drc.json (the verdict), open-triage.json and pin-escape.json (`iotroute run --diagnose`),
//! checkpoint.json (how the search ended), model.json (which layers a net may use) and seed.json (the run started from an earlier
//! one: `reused`). A file that is not there leaves its part out;
//! only drc.json is needed. Same files, same report: no clock, no search, no LLM.
//!
//! Each stuck connection says where its ends are and why it is open. ENCLOSED: no legal path on the diagnosis grid, and what walls it
//! in. ROUTER_MISS: a path exists for this net alone, so the router lost it, or its search hit the limit and it is not proved blocked.
//! Neither is a claim about the whole board: DRC stays the verdict. `open_nets` is the whole list; the rows stop at MAX_ROWS.
use crate::grid::opens::pad_of;
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
    /// More, or fewer, DRC errors and open connections than the report before.
    pub worse: bool,
    pub better: bool,
    pub new: Vec<String>,
    pub resolved: Vec<String>,
    pub same: usize,
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
        Some("ENCLOSED") => format!("walled in ({} mm2 left): {}", connection["region_mm2"], walled_by(connection)),
        Some("ROUTER_MISS") if search_why.is_some_and(|why| why.contains("search limit")) => "search limit hit: not proved blocked".to_string(),
        Some("ROUTER_MISS") => format!("a path exists for this net alone; router: {}", search_why.map_or("left it open".to_string(), clip)),
        _ => "the diagnosis could not place an end".to_string(),
    };
    if let Some(layers) = layers {
        text.push_str(&format!("; only on {layers}"));
    }
    text
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

fn changed(previous: &Value, open: &[String], unconnected: usize, errors: usize) -> Option<Changed> {
    let before: BTreeSet<&str> = previous["open_nets"].as_array().map(|_| names(&previous["open_nets"]).collect())?;
    let now: BTreeSet<&str> = open.iter().map(String::as_str).collect();
    let count = |key: &str| previous[key].as_u64().unwrap_or(0) as usize;
    let (problems, problems_before) = (unconnected + errors, count("unconnected") + count("drc_errors"));
    let first = |set: Vec<&&str>| set.into_iter().take(MAX_NAMES).map(|net| net.to_string()).collect();
    Some(Changed { open_before: before.len(), open_now: now.len(), unconnected_before: count("unconnected"), unconnected_now: unconnected, worse: problems > problems_before, better: problems < problems_before, new: first(now.difference(&before).collect()), resolved: first(before.difference(&now).collect()), same: now.intersection(&before).count() })
}

fn summary(report: &Report) -> Vec<String> {
    let mut lines = vec![format!("{} nets open: {} connections enclosed, {} router miss, {} unknown; DRC errors {} unconnected {} parity {}", report.open_nets.len(), report.enclosed, report.router_miss, report.unknown, report.drc_errors, report.unconnected, report.parity)];
    if !report.search.is_null() {
        let stop = report.search["stop"].as_str().unwrap_or("not stopped");
        lines.push(format!("search: stop {stop} at pass {} of {}, best pass {}, {} search-limited", report.search["pass"], report.search["max_passes"], report.search["best_pass"], report.search["search_limited"]));
    }
    if let Some([x0, y0, x1, y1]) = report.region {
        let hot = report.hot.first().map_or(String::new(), |cell| format!(", hottest ({}, {}) {}", cell["x"], cell["y"], cell["layer"].as_str().unwrap_or("")));
        lines.push(format!("where: x {x0}..{x1} y {y0}..{y1} mm{hot}"));
    }
    lines.extend(report.rows.iter().map(|row| format!("{} x{} {} ({}, {}) -> {} ({}, {}): {}", row.net, row.connections, row.from.at, row.from.x, row.from.y, row.to.at, row.to.x, row.to.y, row.why)));
    if report.open_nets.len() > report.rows.len() {
        lines.push(format!("and {} more nets", report.open_nets.len() - report.rows.len()));
    }
    let b = &report.blockers;
    let blocks = [("parts", &b.parts), ("nets", &b.nets), ("keepouts", &b.keepouts), ("layer limits", &b.layers), ("boxed-in pads", &b.boxed_in)];
    let blocks: Vec<String> = blocks.iter().filter(|(_, found)| !found.is_empty()).map(|(name, found)| format!("{name} {}", found.join(" "))).collect();
    if !blocks.is_empty() {
        lines.push(format!("blocked by: {}", blocks.join("; ")));
    }
    lines.extend(report.drc.iter().map(|row| format!("DRC {} x{} first at ({}, {})", row["type"].as_str().unwrap_or("?"), row["count"], row["x"], row["y"])));
    if let Some(c) = &report.changed {
        let verdict = if c.worse { "WORSE: " } else { "" };
        lines.push(format!("changed: {verdict}open nets {} -> {}, connections {} -> {}, new {}, resolved {}, same {}", c.open_before, c.open_now, c.unconnected_before, c.unconnected_now, if c.new.is_empty() { "none".to_string() } else { c.new.join(" ") }, if c.resolved.is_empty() { "none".to_string() } else { c.resolved.join(" ") }, c.same));
    }
    lines
}

/// The report of these sources.
pub fn report(board: &str, work: &str, s: &Sources) -> Report {
    let connections = list(&s.triage["connections"]);
    let reasons: BTreeMap<&str, &str> = list(&s.checkpoint["worst_nets"]).iter().filter_map(|w| Some((w["net"].as_str()?, w["why"].as_str()?))).collect();
    let limits = layer_limits(&s.model);
    let rows: Vec<Row> = connections.iter().map(|c| {
        let net = c["net"].as_str().unwrap_or("");
        Row { net: net.to_string(), class: c["class"].as_str().unwrap_or("UNKNOWN").to_string(), connections: 1, from: end(&c["a"], &c["a_pos"]), to: end(&c["b"], &c["b_pos"]), why: why(c, reasons.get(net).copied(), limits.get(net)) }
    }).collect();
    let open: BTreeSet<&str> = rows.iter().map(|row| row.net.as_str()).chain(reasons.keys().copied()).collect();
    let open_nets: Vec<String> = open.into_iter().map(str::to_string).collect();
    let region = rows.iter().flat_map(|row| [&row.from, &row.to]).fold(None, |bbox: Option<[f64; 4]>, e| {
        Some(bbox.map_or([e.x, e.y, e.x, e.y], |[x0, y0, x1, y1]| [x0.min(e.x), y0.min(e.y), x1.max(e.x), y1.max(e.y)]))
    });
    let tally = |key: &str| {
        let mut counts = BTreeMap::new();
        connections.iter().flat_map(|c| names(&c[key])).for_each(|name| *counts.entry(name.to_string()).or_insert(0) += 1);
        top(&counts)
    };
    let layers = open_nets.iter().filter_map(|net| limits.get(net).map(|on| format!("{net}: {on}"))).take(MAX_NAMES).collect();
    let boxed_in = list(&s.escape["boxed_in"]).iter().take(MAX_NAMES).map(|pad| format!("{}.{}", pad["ref"].as_str().unwrap_or("?"), pad["pad"].as_str().unwrap_or("?"))).collect();
    let (errors, drc) = drc_errors(&s.drc);
    let unconnected = list(&s.drc["unconnected_items"]).len();
    let count = |class: &str| rows.iter().filter(|row| row.class == class).count();
    // Enclosed first: it needs a change of the board, not another route.
    let mut shown: Vec<Row> = Vec::new();
    for row in &rows {
        match shown.iter_mut().find(|seen| seen.net == row.net && seen.class == row.class) {
            Some(seen) => seen.connections += 1,
            None => shown.push(row.clone()),
        }
    }
    shown.sort_by_key(|row| row.class != "ENCLOSED");
    shown.truncate(MAX_ROWS);
    let mut report = Report {
        schema: SCHEMA, board: board.to_string(), work: work.to_string(), drc_errors: errors, unconnected, parity: list(&s.drc["schematic_parity"]).len(),
        enclosed: count("ENCLOSED"), router_miss: count("ROUTER_MISS"), unknown: rows.len() - count("ENCLOSED") - count("ROUTER_MISS"), search: search(&s.checkpoint),
        route_layers: route_layers(&s.model), reused: s.reused, changed: changed(&s.previous, &open_nets, unconnected, errors), open_nets, rows: shown, region, hot: list(&s.checkpoint["hot"]).iter().take(MAX_HOT).cloned().collect(),
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
        Sources {
            drc: json!({"unconnected_items": [{}, {}], "violations": [{"severity": "error", "type": "clearance", "items": [{"pos": {"x": 9.04, "y": 8.0}}]}, {"severity": "warning", "type": "silk"}]}),
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
        }
    }

    #[test]
    fn a_report_names_what_is_stuck_where_and_why_and_what_changed() {
        let mut s = sources();
        s.previous = json!({"open_nets": ["/SDA", "/OLD"], "unconnected": 1});
        let report = report("ENV-SENSE", "w", &s);
        assert_eq!(report.open_nets, ["/INT", "/SDA"]);
        assert_eq!((report.enclosed, report.router_miss, report.drc_errors, report.unconnected), (1, 1, 1, 2));
        assert_eq!(report.region, Some([10.0, 20.0, 30.0, 25.0]));
        let expected = [
            "2 nets open: 1 connections enclosed, 1 router miss, 0 unknown; DRC errors 1 unconnected 2 parity 0",
            "search: stop stall-passes at pass 31 of 80, best pass 24, 0 search-limited",
            "where: x 10..30 y 20..25 mm, hottest (11.5, 21.5) F.Cu",
            "/INT x1 U1.4 (11, 22) -> J1.1 (30, 25): walled in (0.6 mm2 left): U1, C4, keepout ANT, net /SCL; only on F.Cu",
            "/SDA x1 R1.1 (10, 20) -> U1.2 (12, 21): a path exists for this net alone; router: no path",
            "blocked by: parts C4 U1; nets /SCL; keepouts ANT; layer limits /INT: F.Cu; boxed-in pads U1.4",
            "DRC clearance x1 first at (9.0, 8.0)",
            "changed: WORSE: open nets 2 -> 2, connections 1 -> 2, new /INT, resolved /OLD, same 1",
        ];
        assert_eq!(report.summary, expected);
    }

    #[test]
    fn a_search_limit_is_not_called_blocked_and_the_list_stays_short() {
        let one = |n: usize| json!({"net": format!("/N{n}"), "class": "ROUTER_MISS", "a": pad(1, "/N", "R1"), "b": pad(2, "/N", "R1"), "a_pos": {"x": 0.0, "y": 0.0}, "b_pos": {"x": 1.0, "y": 1.0}});
        let mut s = Sources { triage: json!({"connections": (0..40).map(one).collect::<Vec<_>>()}), ..Sources::default() };
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
