//! The run record of a routing job: OUTDIR/run.jsonl, one action per line, with the why of each. tools/run_record.ts reads it.
//!
//! Live writers append; `sync` at the job's end derives the rest from the files the job writes anyway, with no duplicates:
//! progress.jsonl, each stage's run/optimize log, report and stall receipt, stages.jsonl, open-triage.json and outcome.json.
use super::files::{append_line, iso_now, load_json, read_jsonl, read_lossy, rounded, unix_time};
use super::scan::Scan;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

const FILE: &str = "run.jsonl";

/// One record. Every key is present in every line, in this order.
#[derive(Debug, Clone, Default)]
pub struct Record {
    pub t: Option<String>,
    pub elapsed_s: Option<f64>,
    pub stage: String,
    pub action: String,
    pub inputs: Value,
    pub evidence: Value,
    pub result: Value,
    pub why: String,
}

impl Record {
    pub fn new(stage: impl Into<String>, action: impl Into<String>, why: impl Into<String>) -> Record {
        Record { stage: stage.into(), action: action.into(), why: why.into(), ..Record::default() }
    }

    pub fn inputs(mut self, inputs: Value) -> Record {
        self.inputs = inputs;
        self
    }

    pub fn evidence(mut self, evidence: impl Into<String>) -> Record {
        self.evidence = Value::String(evidence.into());
        self
    }

    pub fn result(mut self, result: Value) -> Record {
        self.result = result;
        self
    }

    pub fn at(mut self, elapsed_s: Option<f64>) -> Record {
        self.elapsed_s = elapsed_s;
        self
    }

    fn time(mut self, t: Option<&str>) -> Record {
        self.t = t.map(str::to_string);
        self
    }

    /// The JSON line. serde_json's map sorts its keys, so the order is written out here.
    fn line(&self) -> String {
        let fields = [
            ("t", json!(self.t.clone().unwrap_or_else(iso_now))),
            ("elapsed_s", json!(self.elapsed_s)),
            ("stage", json!(self.stage)),
            ("action", json!(self.action)),
            ("inputs", self.inputs.clone()),
            ("evidence", self.evidence.clone()),
            ("result", self.result.clone()),
            ("why", json!(self.why)),
        ];
        let body: Vec<String> = fields.iter().map(|(key, value)| format!("{}: {value}", json!(key))).collect();
        format!("{{{}}}", body.join(", "))
    }

    fn key(&self) -> Key {
        let field = |value: &Value, name: &str| value.get(name).cloned().unwrap_or(Value::Null).to_string();
        let keeps_evidence = matches!(self.action.as_str(), "pass" | "checkpoint" | "stop" | "router end" | "skip" | "diagnosis" | "fanout");
        let evidence = if keeps_evidence { self.evidence.to_string() } else { "null".to_string() };
        (self.stage.clone(), self.action.clone(), field(&self.result, "pass"), field(&self.inputs, "net"), field(&self.inputs, "from"), field(&self.inputs, "to"), evidence)
    }
}

type Key = (String, String, String, String, String, String, String);

fn key_of_row(row: &Value) -> Key {
    let text = |name: &str| row.get(name).and_then(Value::as_str).unwrap_or("").to_string();
    let record = Record { stage: text("stage"), action: text("action"), inputs: row["inputs"].clone(), evidence: row["evidence"].clone(), result: row["result"].clone(), ..Record::default() };
    record.key()
}

/// The job clock of a folder: t0 of progress.jsonl.
pub fn job_t0(outdir: &Path) -> Option<f64> {
    let text = read_lossy(outdir.join("progress.jsonl"))?;
    serde_json::from_str::<Value>(text.lines().next()?).ok()?["t0"].as_f64()
}

/// The writer of one folder's record, on the job's clock.
#[derive(Clone)]
pub struct RunRecord {
    path: PathBuf,
    folder: PathBuf,
    t0: f64,
}

impl RunRecord {
    pub fn start(outdir: &Path) -> RunRecord {
        RunRecord { path: outdir.join(FILE), folder: outdir.to_path_buf(), t0: job_t0(outdir).unwrap_or_else(unix_time) }
    }

    pub fn t0(&self) -> f64 {
        self.t0
    }

    /// A record that gives no time gets the job's elapsed time.
    pub fn append(&self, mut record: Record) -> Result<(), String> {
        if record.elapsed_s.is_none() && record.t.is_none() {
            record.elapsed_s = Some(rounded(unix_time() - self.t0, 1));
        }
        append_line(&self.path, &record.line())
    }

    /// Appends every derived record that is not there yet, and says how many.
    pub fn sync(&self) -> Result<usize, String> {
        let mut have: BTreeSet<Key> = read_jsonl(&self.path)?.iter().map(key_of_row).collect();
        let mut added = 0;
        for record in derive(&self.folder)? {
            if have.insert(record.key()) {
                append_line(&self.path, &record.line())?;
                added += 1;
            }
        }
        Ok(added)
    }
}

// ------------------------------------------------------------------ the router's log and report

/// `^\s*T \w+ ` of a log line: its router-relative time and the text after the level.
fn log_head(line: &str) -> Option<(f64, Scan<'_>)> {
    let mut scan = Scan::new(line);
    scan.skip_spaces();
    let t = scan.number()?;
    scan.spaces()?;
    scan.word()?;
    scan.spaces()?;
    Some((t, scan))
}

fn violations_tail(scan: &mut Scan) -> Option<()> {
    scan.literal(" violation")?;
    let _ = scan.literal("s");
    scan.literal(")")
}

fn parse_pass(mut scan: Scan, line: &str, at: f64) -> Option<Record> {
    scan.literal("Auto-routing pass #")?;
    let number = scan.whole()?;
    scan.literal(" was completed in ")?;
    let seconds = scan.number()?;
    scan.literal(" seconds with score ")?;
    let score = scan.number()?;
    scan.literal(" (")?;
    let open = scan.whole()?;
    scan.literal(" unrouted and ")?;
    let violations = scan.whole()?;
    violations_tail(&mut scan)?;
    let mut result = json!({"pass": number, "open": open, "violations": violations, "seconds": seconds, "score": score});
    let mut ripped = 0;
    if let Some((routed, failed, rips)) = pass_counts(scan) {
        ripped = rips;
        result["routed"] = json!(routed);
        result["failed"] = json!(failed);
        result["ripups"] = json!(rips);
    }
    Some(Record::new("route", "pass", format!("autorouter pass {number}: {open} open, {violations} violations, {ripped} rip-ups")).evidence(line.trim()).result(result).at(Some(at)))
}

/// ` (routed R, failed F, ripped P)`.
fn pass_counts(mut scan: Scan) -> Option<(u64, u64, u64)> {
    scan.literal(" (routed ")?;
    let routed = scan.whole()?;
    scan.literal(", failed ")?;
    let failed = scan.whole()?;
    scan.literal(", ripped ")?;
    let ripped = scan.whole()?;
    scan.literal(")")?;
    Some((routed, failed, ripped))
}

fn parse_checkpoint(mut scan: Scan, at: f64) -> Option<Record> {
    scan.literal("checkpoint: best board so far (")?;
    let open = scan.whole()?;
    scan.literal(" unrouted, ")?;
    let violations = scan.whole()?;
    violations_tail(&mut scan)?;
    scan.literal(" written to '")?;
    let ses = scan.until("'")?;
    Some(Record::new("route", "checkpoint", "lowest open count so far: best board written").evidence(ses).result(json!({"open": open, "violations": violations})).at(Some(at)))
}

fn parse_stop(mut scan: Scan, line: &str, at: f64) -> Option<Record> {
    scan.literal("stop requested: ")?;
    Some(Record::new("route", "stop", "the job asked the router to stop (stall or deadline)").evidence(line.trim()).result(json!({"reason": scan.rest().trim()})).at(Some(at)))
}

fn parse_stage_done(mut scan: Scan, line: &str, at: f64) -> Option<Record> {
    scan.literal("Auto-routing stage completed: started with ")?;
    let started = scan.whole()?;
    scan.literal(" unrouted nets, completed in ")?;
    let seconds = scan.number()?;
    scan.literal(" seconds, final score: ")?;
    let score = scan.number()?;
    scan.literal(" (")?;
    let open = scan.whole()?;
    scan.literal(" unrouted and ")?;
    let violations = scan.whole()?;
    violations_tail(&mut scan)?;
    let result = json!({"open": open, "violations": violations, "seconds": seconds, "score": score, "started_open": started});
    Some(Record::new("route", "router end", format!("autorouting stage over: {started} -> {open} open")).evidence(line.trim()).result(result).at(Some(at)))
}

fn parse_skipped(mut scan: Scan, line: &str, at: f64) -> Option<Record> {
    let items = scan.whole()?;
    scan.literal(" item(s) cannot be routed even on the board as loaded (")?;
    let cause = scan.until(")")?;
    scan.literal("; they were skipped after their ")?;
    let nth = scan.word()?;
    scan.literal(" failure")?;
    Some(Record::new("route", "skip", format!("{items} items {cause}; skipped after their {nth} failure")).evidence(line.trim()).result(json!({"items": items})).at(Some(at)))
}

fn parse_diagnosis(mut scan: Scan, line: &str, at: f64) -> Option<Record> {
    scan.literal("diagnosis of ")?;
    let open = scan.whole()?;
    scan.literal(" unrouted connections in ")?;
    let seconds = scan.number()?;
    scan.literal(" s: ")?;
    let congestion = scan.whole()?;
    scan.literal(" routable alone (congestion), ")?;
    let blocked = scan.whole()?;
    scan.literal(" not routable on the loaded board (blocked), ")?;
    let ignored = scan.whole()?;
    scan.literal(" in ignored net classes")?;
    let result = json!({"open": open, "congestion": congestion, "blocked": blocked, "ignored": ignored, "seconds": seconds});
    let why = format!("{congestion} open connections are routable alone (congestion), {blocked} are blocked on the loaded board");
    Some(Record::new("route", "diagnosis", why).evidence(line.trim()).result(result).at(Some(at)))
}

fn parse_fanout(mut scan: Scan, line: &str, at: f64) -> Option<Record> {
    scan.literal("Fanout stage completed: ")?;
    let passes = scan.whole()?;
    scan.literal(" passes, completed in ")?;
    let seconds = scan.number()?;
    scan.literal(" seconds")?;
    Some(Record::new("route", "fanout", "SMD fanout before autorouting").evidence(line.trim()).result(json!({"passes": passes, "seconds": seconds})).at(Some(at)))
}

/// The record of a Fastroute log line that is an action. `offset` is the job time at the router's start.
pub fn parse_log_line(line: &str, offset: f64) -> Option<Record> {
    let (t, scan) = log_head(line)?;
    let at = rounded(offset + t, 1);
    parse_pass(scan, line, at)
        .or_else(|| parse_checkpoint(scan, at))
        .or_else(|| parse_stop(scan, line, at))
        .or_else(|| parse_stage_done(scan, line, at))
        .or_else(|| parse_skipped(scan, line, at))
        .or_else(|| parse_diagnosis(scan, line, at))
        .or_else(|| parse_fanout(scan, line, at))
}

fn parse_log(text: &str, offset: f64, stage: &str, inputs: &Value) -> Vec<Record> {
    let tag = |mut record: Record| {
        record.stage = stage.to_string();
        record.inputs = inputs.clone();
        record
    };
    text.lines().filter_map(|line| parse_log_line(line, offset)).map(tag).collect()
}

/// One record per failed connection of a report: the router's own reason.
fn reasons(report: &Value, at: Option<f64>, stage: &str, evidence: &str, attempt: &Value) -> Vec<Record> {
    let empty = Vec::new();
    let end = |side: &Value| {
        let kind = side["kind"].as_str();
        if kind == Some("pin") {
            format!("{}.{}", side["component"].as_str().unwrap_or(""), side["pin"].as_str().unwrap_or(""))
        } else {
            kind.unwrap_or("?").to_string()
        }
    };
    let first = |unit: &Value, keys: [&str; 2]| keys.iter().map(|key| unit[*key].clone()).find(|side| side.as_object().is_some_and(|map| !map.is_empty())).unwrap_or(Value::Null);
    let mut out = Vec::new();
    for open in report["unrouted"].as_array().unwrap_or(&empty) {
        let diagnosis = &open["diagnosis"];
        let alone = first(diagnosis, ["from_alone", "to_alone"]);
        let class = diagnosis["class"].as_str().unwrap_or("unknown");
        let why = match class {
            "blocked" => "no path exists on the loaded board (pins, keepouts or fixed wiring)",
            "congestion" => "routable alone; other copper took the space",
            "ignored" => "its net class is ignored",
            _ => "the router gave no class; the cause is unknown",
        };
        let mut inputs = json!({"net": open["net"], "from": end(&open["from"]), "to": end(&open["to"]), "length_mm": open["length_mm"]});
        if !attempt.is_null() {
            inputs["attempt"] = attempt.clone();
        }
        let failed: Vec<Value> = diagnosis["in_context"].as_array().unwrap_or(&empty).iter().map(|try_| try_["pass"].clone()).collect();
        let result = json!({"class": class, "router_text": alone["details"].as_str().unwrap_or(""), "passes_failed": failed});
        out.push(Record::new(stage, "open", format!("{class}: {why}")).inputs(inputs).evidence(format!("{evidence} unrouted[]")).result(result).at(at));
    }
    out
}

// ------------------------------------------------------------------ derive from the job's files

/// `run-fast.log` -> "-fast": the stage suffix of a stage file.
fn stage_suffix(name: &str) -> Option<&str> {
    let stem = name.strip_suffix(".log").or_else(|| name.strip_suffix(".json"))?;
    ["run", "optimize", "report", "stall"].iter().find_map(|kind| {
        let rest = stem.strip_prefix(kind)?;
        (rest.is_empty() || (rest.starts_with('-') && rest.len() > 1 && !rest.contains('/'))).then_some(rest)
    })
}

#[derive(Debug, Default, Clone)]
struct Clock {
    attempt: Option<u64>,
    start_s: Option<f64>,
    end_s: Option<f64>,
}

#[derive(Debug)]
struct RouteStage {
    stage: String,
    suffix: String,
    clock: Clock,
    files: BTreeMap<&'static str, String>,
}

/// Every routing stage with its own clock and files, in start order; a stage with no rows still has its files read.
fn route_stages(outdir: &Path, progress: &[Value]) -> Vec<RouteStage> {
    let mut clocks: Vec<(String, Clock)> = Vec::new();
    let mut clock_of = |suffix: &str| -> usize {
        clocks.iter().position(|(name, _)| name == suffix).unwrap_or_else(|| {
            clocks.push((suffix.to_string(), Clock::default()));
            clocks.len() - 1
        })
    };
    let mut rows: Vec<(usize, bool, Option<f64>)> = Vec::new();
    for row in progress {
        let name = row["stage"].as_str().unwrap_or("");
        let Some(rest) = name.strip_prefix("route") else { continue };
        let Some((suffix, edge)) = rest.rsplit_once(' ') else { continue };
        if suffix.contains(char::is_whitespace) || !matches!(edge, "start" | "end") {
            continue;
        }
        rows.push((clock_of(suffix), edge == "start", row["elapsed_s"].as_f64()));
    }
    let mut names: Vec<String> = fs::read_dir(outdir).map_or_else(|_| Vec::new(), |dir| dir.filter_map(|entry| entry.ok()?.file_name().into_string().ok()).collect());
    names.sort();
    for name in &names {
        if let Some(suffix) = stage_suffix(name) {
            clock_of(suffix);
        }
    }
    for (index, start, at) in rows {
        let clock = &mut clocks[index].1;
        if start {
            *clock = Clock { attempt: Some(clock.attempt.unwrap_or(0) + 1), start_s: at, end_s: None };
        } else {
            clock.end_s = at;
        }
    }
    let mut stages: Vec<RouteStage> = clocks.into_iter().map(|(suffix, clock)| {
        let files = [("run", "log"), ("optimize", "log"), ("report", "json"), ("stall", "json")].into_iter()
            .map(|(kind, extension)| (kind, format!("{kind}{suffix}.{extension}")))
            .filter(|(_, name)| outdir.join(name).is_file())
            .collect();
        RouteStage { stage: format!("route{suffix}"), suffix, clock, files }
    }).collect();
    stages.sort_by(|a, b| {
        let order = |s: &RouteStage| (s.clock.start_s.is_none(), s.clock.start_s.unwrap_or(0.0));
        order(a).partial_cmp(&order(b)).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.suffix.cmp(&b.suffix))
    });
    stages
}

fn stall_record(stall: &Value, stage: &RouteStage, file: &str, t0: Option<f64>, attempt: &Value) -> Record {
    let passes = &stall["stall_passes"];
    let attempted = &stall["interrupt_attempted"];
    let (action, acknowledgment) = if attempted == true {
        let said = match stall["interrupt_acknowledged"].as_bool() {
            Some(true) => "broker acknowledged the request",
            Some(false) => "broker did not acknowledge the request",
            None => "broker acknowledgment is unknown",
        };
        ("stall interrupt attempted", said)
    } else if attempted == false {
        ("stall interrupt not attempted", "no owned router handle")
    } else {
        ("stall interrupt unknown", "attempt status is unknown")
    };
    let why = format!("{} passes without a lower open count: {acknowledgment}; this receipt does not confirm process exit", number_text(passes));
    let at = stall["seconds"].as_f64().zip(t0).map(|(seconds, t0)| rounded(seconds - t0, 1)).or(stage.clock.end_s);
    Record::new(&stage.stage, action, why).inputs(json!({"attempt": attempt, "receipt_format": "interrupt_request"})).evidence(file).result(stall.clone()).at(at)
}

fn number_text(value: &Value) -> String {
    if value.is_null() { "None".to_string() } else { value.to_string() }
}

fn stage_records(outdir: &Path, stage: &RouteStage, progress: &[Value], out: &mut Vec<Record>) {
    let attempt = json!(stage.clock.attempt);
    let text = |name: &str| read_lossy(outdir.join(name)).unwrap_or_default();
    let mut passes = Vec::new();
    if let Some(file) = stage.files.get("run") {
        let clock = if stage.clock.start_s.is_some() { "stage start" } else { "unknown" };
        passes = parse_log(&text(file), stage.clock.start_s.unwrap_or(0.0), &stage.stage, &json!({"attempt": attempt, "log": file, "clock": clock}));
    }
    let logged = passes.iter().any(|record| record.action == "pass");
    out.extend(passes);
    if !logged {
        for row in progress.iter().filter(|row| row["stage"].as_str() == Some(&stage.stage) && !row["pass"].is_null()) {
            let why = format!("autorouter pass {}: {} open (live watcher)", row["pass"], row["open"]);
            let record = Record::new(&stage.stage, "pass", why).inputs(json!({"attempt": attempt, "log": "progress.jsonl"})).evidence("progress.jsonl");
            out.push(record.result(json!({"pass": row["pass"], "open": row["open"]})).at(row["elapsed_s"].as_f64()).time(row["t"].as_str()));
        }
    }
    if let Some(file) = stage.files.get("optimize") {
        let clock = if stage.clock.end_s.is_some() { "route end" } else { "unknown" };
        out.extend(parse_log(&text(file), stage.clock.end_s.unwrap_or(0.0), &format!("optimize{}", stage.suffix), &json!({"attempt": attempt, "log": file, "clock": clock})));
    }
    if let Some(report) = stage.files.get("report").and_then(|file| load_json(outdir.join(file)).map(|data| (file, data))) {
        out.extend(reasons(&report.1, stage.clock.end_s, &stage.stage, report.0, &attempt));
    }
    if let Some(file) = stage.files.get("stall")
        && let Some(stall) = load_json(outdir.join(file))
        && stall.get("interrupt_attempted").is_some()
    {
        out.push(stall_record(&stall, stage, file, job_t0(outdir), &attempt));
    }
}

fn subset(row: &Value, keys: &[&str]) -> Value {
    let map: serde_json::Map<String, Value> = keys.iter().filter_map(|key| row.get(*key).filter(|value| !value.is_null()).map(|value| (key.to_string(), value.clone()))).collect();
    Value::Object(map)
}

fn triage_records(tri: &Value, progress: &[Value], out: &mut Vec<Record>) {
    let at = progress.iter().find(|row| row["stage"] == "triage end").and_then(|row| row["elapsed_s"].as_f64());
    let result = json!({"open": tri["open"], "enclosed": tri["enclosed"], "router_miss": tri["router_miss"], "unknown": tri["unknown"]});
    let why = "each open signal connection classed as ENCLOSED (no legal path), ROUTER_MISS (a path exists) or UNKNOWN (the cause is unknown)";
    out.push(Record::new("triage", "triage", why).evidence("open-triage.json").result(result).at(at));
    for open in tri["connections"].as_array().unwrap_or(&Vec::new()) {
        let why = match open["class"].as_str() {
            Some("ENCLOSED") => "no legal path on the clearance grid".to_string(),
            Some("ROUTER_MISS") => "a path exists; the router missed it".to_string(),
            class => format!("{}: the cause is unknown; the triage did not establish whether a legal path exists", class.filter(|c| !c.is_empty()).unwrap_or("no class")),
        };
        let inputs = json!({"net": open["net"], "from": open["a"], "to": open["b"]});
        out.push(Record::new("triage", "open", why).inputs(inputs).evidence("open-triage.json").result(json!({"class": open["class"], "blockers": open["blockers"]})).at(at));
    }
}

fn configure_record(outdir: &Path) -> Option<Record> {
    let effective = load_json(outdir.join("effective-configuration.json")).or_else(|| load_json(outdir.join("input-manifest.json")))?;
    let features: Vec<&String> = effective["features"].as_object().map_or_else(Vec::new, |map| map.iter().filter(|(_, value)| value["on"].as_bool().unwrap_or(false)).map(|(name, _)| name).collect());
    let result = json!({"features_on": features, "command": effective["command"]});
    Some(Record::new("job", "configure", "the inputs and feature flags bound at the job start").inputs(effective["configuration"].clone()).evidence("effective-configuration.json").result(result).at(Some(0.0)))
}

/// All records the job's files imply, in job order.
pub fn derive(outdir: &Path) -> Result<Vec<Record>, String> {
    let mut out: Vec<Record> = configure_record(outdir).into_iter().collect();
    let progress = read_jsonl(outdir.join("progress.jsonl"))?;
    for row in progress.iter().filter(|row| row["pass"].is_null()) {
        let name = row["stage"].as_str().unwrap_or("");
        let result = subset(row, &["open", "best_open", "vias", "eta_s"]);
        let result = if result.as_object().is_some_and(|map| map.is_empty()) { Value::Null } else { result };
        out.push(Record::new(name.split(' ').next().unwrap_or(""), name, "stage boundary of the job").evidence("progress.jsonl").result(result).at(row["elapsed_s"].as_f64()).time(row["t"].as_str()));
    }
    for stage in route_stages(outdir, &progress) {
        stage_records(outdir, &stage, &progress, &mut out);
    }
    for row in read_jsonl(outdir.join("stages.jsonl"))? {
        let status = row["status"].as_str().unwrap_or("None");
        let why = if status == "complete" { "owned subprocess stage of the job".to_string() } else { format!("stage {status}: {}", row["cause"]) };
        let result = subset(&row, &["returncode", "wall_s", "cause"]);
        out.push(Record::new(row["stage"].as_str().unwrap_or(""), format!("stage {status}"), why).inputs(json!({"command": row["command"]})).evidence("stages.jsonl").result(result));
    }
    if let Some(tri) = load_json(outdir.join("open-triage.json")) {
        triage_records(&tri, &progress, &mut out);
    }
    if let Some(outcome) = load_json(outdir.join("outcome.json")) {
        let status = outcome["status"].as_str().unwrap_or("None");
        let at = progress.last().and_then(|row| row["elapsed_s"].as_f64());
        let result = json!({"signal_open": outcome["signal_open"], "ground_open": outcome["ground_open"], "errors": outcome["errors"], "returncode": outcome["returncode"], "qualified": outcome["qualified"]});
        let why = outcome["note"].as_str().map_or_else(|| format!("job {status}"), str::to_string);
        out.push(Record::new("job", format!("exit {}", status.to_uppercase()), why).evidence("outcome.json").result(result).at(at));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASS: &str = "   12.5 INFO   Auto-routing pass #3 was completed in 1.5 seconds with score 900.5 (7 unrouted and 1 violation) (routed 4, failed 2, ripped 9)";

    fn folder(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("job-record-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn a_pass_line_is_a_pass_record() {
        let record = parse_log_line(PASS, 100.0).unwrap();
        assert_eq!((record.action.as_str(), record.elapsed_s), ("pass", Some(112.5)));
        assert_eq!(record.result["ripups"], 9);
        assert_eq!(record.why, "autorouter pass 3: 7 open, 1 violations, 9 rip-ups");
        let plain = "1.0 INFO Auto-routing pass #3 was completed in 1.5 seconds with score 900.5 (7 unrouted and 2 violations)";
        assert_eq!(parse_log_line(plain, 0.0).unwrap().why, "autorouter pass 3: 7 open, 2 violations, 0 rip-ups");
    }

    #[test]
    fn each_action_line_has_its_record() {
        let cases = [
            ("2.0 INFO checkpoint: best board so far (3 unrouted, 0 violations) written to 'b.ses'", "checkpoint"),
            ("2.0 INFO stop requested: time limit", "stop"),
            ("2.0 INFO Auto-routing stage completed: started with 9 unrouted nets, completed in 3.5 seconds, final score: 1.5 (2 unrouted and 0 violations)", "router end"),
            ("2.0 INFO 3 item(s) cannot be routed even on the board as loaded (no path); they were skipped after their first failure", "skip"),
            ("2.0 INFO diagnosis of 4 unrouted connections in 0.5 s: 1 routable alone (congestion), 2 not routable on the loaded board (blocked), 1 in ignored net classes", "diagnosis"),
            ("2.0 INFO Fanout stage completed: 2 passes, completed in 1.5 seconds", "fanout"),
        ];
        for (line, action) in cases {
            assert_eq!(parse_log_line(line, 0.0).unwrap().action, action, "{line}");
        }
        assert!(parse_log_line("2.0 INFO nothing to see", 0.0).is_none());
    }

    #[test]
    fn stage_files_name_their_suffix() {
        assert_eq!(stage_suffix("run.log"), Some(""));
        assert_eq!(stage_suffix("report-fast.json"), Some("-fast"));
        assert_eq!(stage_suffix("optimize-wide_hot_N.log"), Some("-wide_hot_N"));
        assert_eq!(stage_suffix("run.jsonl"), None);
        assert_eq!(stage_suffix("board.dsn"), None);
    }

    #[test]
    fn sync_derives_each_record_once_and_keeps_the_key_order() {
        let dir = folder("sync");
        fs::write(dir.join("progress.jsonl"), "{\"t\":\"x\",\"t0\":100.0,\"elapsed_s\":0.0,\"stage\":\"job start\",\"pass\":null,\"open\":null}\n{\"t\":\"x\",\"t0\":100.0,\"elapsed_s\":1.0,\"stage\":\"route start\",\"pass\":null,\"open\":null}\n").unwrap();
        fs::write(dir.join("run.log"), format!("{PASS}\n")).unwrap();
        fs::write(dir.join("report.json"), r#"{"unrouted":[{"net":"N","from":{"kind":"pin","component":"U1","pin":"1"},"to":{"kind":"wire"},"diagnosis":{"class":"blocked"}}]}"#).unwrap();
        fs::write(dir.join("outcome.json"), r#"{"status":"stuck","note":"open"}"#).unwrap();
        let record = RunRecord::start(&dir);
        assert_eq!(record.t0(), 100.0);
        assert_eq!(record.sync().unwrap(), 5);
        assert_eq!(record.sync().unwrap(), 0);
        let text = fs::read_to_string(dir.join(FILE)).unwrap();
        assert!(text.lines().next().unwrap().starts_with("{\"t\": "));
        let rows = read_jsonl(dir.join(FILE)).unwrap();
        let open = rows.iter().find(|row| row["action"] == "open").unwrap();
        assert_eq!((open["inputs"]["from"].as_str(), open["inputs"]["to"].as_str()), (Some("U1.1"), Some("wire")));
        assert_eq!(rows.last().unwrap()["action"], "exit STUCK");
    }

    #[test]
    fn a_new_attempt_of_a_stage_replaces_its_clock() {
        let dir = folder("attempt");
        let rows = [json!({"stage": "route-a start", "elapsed_s": 1.0}), json!({"stage": "route-a end", "elapsed_s": 2.0}), json!({"stage": "route-a start", "elapsed_s": 3.0})];
        let stages = route_stages(&dir, &rows);
        assert_eq!((stages[0].clock.attempt, stages[0].clock.start_s, stages[0].clock.end_s), (Some(2), Some(3.0), None));
    }
}
