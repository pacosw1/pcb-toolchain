//! `iotroute pin-escape BOARD.kicad_pcb [--layers F.Cu,B.Cu] [--in2-nets N,..] [--plane-nets GND,..] [--parts REF,.. | --region
//! x0,y0,x1,y1] [--only-nets N,..] [--escape-mm 3] [--neck-mm W] [--json OUT] [--board-json FILE]`
//!
//! It only reads the board: with --board-json on any host, without it through the pinned KiCad API. Exit 0, 1 on any FAIL, 2 for a
//! usage or tool error.
use super::check::{Checker, Options};
use super::raster::Rect;
use super::report::{Region, Verdict};
use super::rules::Rules;
use crate::kicad::board::Board;
use crate::model::text::round_to;
use crate::pytext::{repr, repr_list};
use crate::si::source;
use crate::tool_args::{Args, list};
use serde::Serialize;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

const USAGE: &str = "usage: iotroute pin-escape BOARD.kicad_pcb [--layers F.Cu,B.Cu] [--in2-nets N,..] [--plane-nets GND,..] [--parts REF,.. | --region x0,y0,x1,y1] [--only-nets N,..] [--escape-mm 3] [--neck-mm W] [--json OUT] [--board-json FILE]";
const DEFAULT_ESCAPE_MM: f64 = 3.0;

#[derive(Debug, Clone, PartialEq)]
pub struct Line {
    pub board: PathBuf,
    pub board_json: Option<PathBuf>,
    pub options: Options,
    pub parts: BTreeSet<String>,
    pub region: Option<Rect>,
    pub escape_mm: f64,
    pub json: Option<PathBuf>,
}

fn read_rect(text: &str) -> Result<Rect, String> {
    let edges = text.split(',').map(|v| v.parse().map_err(|_| format!("--region: not a number: {v}"))).collect::<Result<Vec<f64>, String>>()?;
    Rect::try_from(edges).map_err(|_| format!("--region: want x0,y0,x1,y1, got {text}"))
}

pub fn read_line(args: Vec<String>) -> Result<Line, String> {
    let mut args = Args::new(args);
    let (mut board, mut board_json, mut region, mut json) = (None, None, None, None);
    let (mut parts, mut escape_mm) = (BTreeSet::new(), DEFAULT_ESCAPE_MM);
    let mut options = Options { layers: vec!["F.Cu".to_string(), "B.Cu".to_string()], ..Options::default() };
    while let Some(word) = args.next() {
        match word.as_str() {
            "--layers" => options.layers = list(&args.value(&word)?).collect(),
            "--in2-nets" => options.in2_nets = list(&args.value(&word)?).collect(),
            "--plane-nets" => options.plane_nets = list(&args.value(&word)?).collect(),
            "--parts" => parts = list(&args.value(&word)?).collect(),
            "--region" => region = Some(args.value(&word)?).filter(|text| !text.is_empty()).map(|text| read_rect(&text)).transpose()?,
            "--neck-mm" => options.neck_mm = Some(args.number(&word)?),
            "--only-nets" => options.only_nets = Some(list(&args.value(&word)?).collect()).filter(|nets: &BTreeSet<String>| !nets.is_empty()),
            "--escape-mm" => escape_mm = args.number(&word)?,
            "--json" => json = Some(PathBuf::from(args.value(&word)?)).filter(|path| !path.as_os_str().is_empty()),
            "--board-json" => board_json = Some(PathBuf::from(args.value(&word)?)),
            _ if word.starts_with("--") => return Err(format!("unknown option {word}")),
            _ if board.is_none() => board = Some(PathBuf::from(word)),
            _ => return Err(format!("unexpected argument {word}")),
        }
    }
    Ok(Line { board: board.ok_or("a board is required")?, board_json, options, parts, region, escape_mm, json })
}

/// A region to check: its name, its box and, per part, the part.
struct Target {
    name: String,
    rect: Rect,
    part: Option<String>,
}

fn targets(check: &Checker, line: &Line, out: &mut dyn FnMut(String)) -> Vec<Target> {
    let per_part = |regions: Vec<(String, Rect)>| regions.into_iter().map(|(name, rect)| Target { part: Some(name.clone()), name, rect }).collect::<Vec<_>>();
    let names = |targets: &[Target]| repr_list(&targets.iter().map(|t| t.name.as_str()).collect::<Vec<_>>());
    if !line.parts.is_empty() {
        let found = per_part(check.footprint_regions(line.escape_mm, Some(&line.parts)));
        let missing: Vec<&String> = line.parts.iter().filter(|part| !found.iter().any(|t| t.name == **part)).collect();
        out(format!("PIN_ESCAPE parts: checked {} missing {}", names(&found), repr_list(&missing)));
        found
    } else if let Some(rect) = line.region {
        vec![Target { name: "rect".to_string(), rect, part: None }]
    } else {
        let found = per_part(check.footprint_regions(line.escape_mm, None));
        out(format!("PIN_ESCAPE whole-board: footprints checked {}", names(&found)));
        found
    }
}

#[derive(Serialize)]
struct Document<'d> {
    board: String,
    layers: &'d [String],
    in2_nets: &'d BTreeSet<String>,
    plane_nets: &'d BTreeSet<String>,
    regions: &'d [Region],
    notes: Vec<&'d String>,
    verdict: Verdict,
    wall_s: f64,
    summary: &'d str,
}

fn write_json(path: &Path, document: &Document) -> Result<(), String> {
    let mut bytes = Vec::new();
    let mut writer = serde_json::Serializer::with_formatter(&mut bytes, serde_json::ser::PrettyFormatter::with_indent(b" "));
    document.serialize(&mut writer).map_err(|e| e.to_string())?;
    fs::write(path, bytes).map_err(|e| format!("{}: {e}", path.display()))
}

/// The pitches of a run, each with its class, as Python prints a sorted list of pairs.
fn pitches(regions: &[Region]) -> String {
    let mut found: Vec<(f64, &str)> = regions.iter().filter_map(|r| Some((r.pitch_mm.filter(|p| *p != 0.0)?, r.pitch_class.as_deref()?))).collect();
    found.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(b.1)));
    found.dedup();
    format!("[{}]", found.iter().map(|(pitch, class)| format!("({pitch:?}, {})", repr(class))).collect::<Vec<_>>().join(", "))
}

/// The check of a board with `line`, its lines through `out`. True when every region passes.
pub fn check(board: &Board, rules: Rules, line: &Line, started: Instant, out: &mut dyn FnMut(String)) -> Result<bool, String> {
    let mut check = Checker::new(board, rules, line.options.clone());
    let targets = targets(&check, line, out);
    let mut regions = Vec::new();
    for target in &targets {
        let region = check.run(&target.name, target.rect, target.part.as_deref());
        if region.demand > 0 {
            out(region.line());
        }
        regions.push(region);
    }
    let failed: Vec<&Region> = regions.iter().filter(|r| r.verdict == Verdict::Fail).collect();
    let verdict = if failed.is_empty() { Verdict::Pass } else { Verdict::Fail };
    let wall = round_to(started.elapsed().as_secs_f64(), 2);
    let notes: Vec<&String> = check.rules.notes.iter().collect();
    notes.iter().for_each(|note| out(format!("NOTE {note}")));
    let unescaped: Vec<&String> = failed.iter().flat_map(|r| &r.unescaped).collect();
    let summary = format!(
        "PIN_ESCAPE_SUMMARY {verdict} regions {} fail {} unescaped {} layers {} pitch {} wall {wall:?} s",
        regions.iter().filter(|r| r.demand > 0).count(), failed.len(), repr_list(&unescaped), repr_list(&check.layers), pitches(&regions)
    );
    out(summary.clone());
    if let Some(path) = &line.json {
        let document = Document { board: line.board.display().to_string(), layers: &check.layers, in2_nets: &line.options.in2_nets, plane_nets: &line.options.plane_nets, regions: &regions, notes, verdict, wall_s: wall, summary: &summary };
        write_json(path, &document)?;
    }
    Ok(failed.is_empty())
}

pub fn cli(args: &[String]) -> i32 {
    let started = Instant::now();
    let line = match read_line(args.to_vec()) {
        Ok(line) => line,
        Err(error) => {
            eprintln!("{USAGE}\npin-escape: {error}");
            return 2;
        }
    };
    let run = source::load(&line.board, line.board_json.as_deref()).and_then(|board| {
        let rules = Rules::read(&board, &line.board)?;
        check(&board, rules, &line, started, &mut |text| println!("{text}"))
    });
    match run {
        Ok(passed) => i32::from(!passed),
        Err(error) => {
            eprintln!("pin-escape: {error}");
            2
        }
    }
}

