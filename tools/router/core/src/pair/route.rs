//! Routes differential pairs as one centreline, then offsets it into the P and N tracks.
//!
//! Each pair (nets BASE+'P' / BASE+'N') must end in two free stub tips per end, side by side at the pair pitch (width + gap) and on one
//! layer: `iotroute pair-stubs` makes them. The centreline runs on a grid from the midpoint of one tip pair to the midpoint of the
//! other, on one layer, 8 directions; `obstacles` says what closes a cell. The path leaves each tip pair along its stub heading. P and N
//! are the path offset by +-pitch/2 with mitred corners. No hand routing: this is a router; its result goes through DRC with parity
//! like any router result.
use super::lattice::Lattice;
use super::line::{length, offset, turns, without_collinear, without_short};
use super::obstacles::{CLEAR, Field};
use super::search::{astar, dump, flood};
use super::tips::{Tip, free_tips};
use super::{Point, add_polyline};
use crate::grid::astar::exact_hypot;
use crate::kicad::board::Board;
use crate::kicad::geom::to_mm;
use crate::kicad::session::Session;
use crate::pytext::repr_list;
use std::path::{Path, PathBuf};

/// Forced free run along the heading (pair-stubs FRONT).
const FRONT: f64 = 1.0;
/// Shortest centreline segment kept (mm).
const MIN_SEG: f64 = 0.25;
/// Tips of a pair may stand this far from the pitch.
const PITCH_TOLERANCE_MM: f64 = 0.05;
/// An offset end this far from its tip has the wrong polarity or heading.
const TIP_TOLERANCE_MM: f64 = 0.06;
/// Where a failed route looks along each heading, in mm.
const PROBES: [f64; 6] = [0.5, 1.0, 1.5, 2.0, 3.0, 4.0];

#[derive(Debug, Clone, PartialEq)]
pub struct Options {
    pub pairs: Vec<String>,
    pub nets: Vec<String>,
    pub same_class_space: f64,
    pub guard_class: Vec<String>,
    pub space_exempt_area: Vec<String>,
    pub channel: Vec<String>,
    pub layer: String,
    pub keepout: Vec<String>,
    pub space: f64,
    pub pad_room: f64,
    pub space_exempt: Vec<String>,
    pub barrier: Vec<String>,
    pub grid: f64,
    pub margin: f64,
    pub debug: Option<PathBuf>,
}

impl Default for Options {
    fn default() -> Self {
        Options { pairs: Vec::new(), nets: Vec::new(), same_class_space: CLEAR, guard_class: Vec::new(), space_exempt_area: Vec::new(), channel: Vec::new(), layer: "F.Cu".to_string(), keepout: Vec::new(), space: 0.5, pad_room: CLEAR, space_exempt: Vec::new(), barrier: Vec::new(), grid: 0.05, margin: 15.0, debug: None }
    }
}

impl Options {
    /// The --barrier NETPREFIX:MM items.
    pub fn barriers(&self) -> Result<Vec<(String, f64)>, String> {
        self.barrier.iter().map(|spec| {
            let (prefix, distance) = spec.split_once(':').ok_or(format!("--barrier: want NETPREFIX:MM, got {spec}"))?;
            Ok((prefix.to_string(), distance.parse().map_err(|_| format!("--barrier: not a number: {distance}"))?))
        }).collect()
    }

    /// The pairs, then the single tracks, by their route specs.
    fn order(&self) -> Vec<String> {
        self.pairs.iter().cloned().chain(self.nets.iter().map(|net| format!("NET={net}"))).collect()
    }
}

/// One thing to route: BASE:WIDTH:GAP[:LAYER], or NET=NET:WIDTH[:LAYER] for one track between its two free tips.
#[derive(Debug, Clone, PartialEq)]
pub struct Job {
    pub base: String,
    pub width: f64,
    pub gap: f64,
    pub layer: String,
    pub single: bool,
}

impl Job {
    pub fn read(spec: &str, default_layer: &str) -> Result<Job, String> {
        let (single, text) = spec.strip_prefix("NET=").map_or((false, spec), |rest| (true, rest));
        let mut parts: Vec<&str> = text.split(':').collect();
        let layer = if parts.last().is_some_and(|last| last.ends_with(".Cu")) { parts.pop().unwrap_or_default() } else { default_layer };
        let numbers = if single { 1 } else { 2 };
        if parts.len() < numbers {
            return Err(format!("a route wants its sizes: {spec}"));
        }
        let (name, sizes) = parts.split_at(parts.len() - numbers);
        let number = |text: &str| text.parse::<f64>().map_err(|_| format!("{spec}: not a number: {text}"));
        Ok(Job { base: name.join(":"), width: number(sizes[0])?, gap: if single { 0.0 } else { number(sizes[1])? }, layer: layer.to_string(), single })
    }

    fn nets(&self) -> (String, String) {
        if self.single { (self.base.clone(), self.base.clone()) } else { (format!("{}P", self.base), format!("{}N", self.base)) }
    }

    fn pitch(&self) -> f64 {
        if self.single { 0.0 } else { self.width + self.gap }
    }
}

/// One end of a route: the tip of each net, their midpoint and the heading away from the stubs.
#[derive(Debug, Clone, PartialEq)]
pub struct End {
    pub p: Tip,
    pub n: Tip,
    pub mid: Point,
    pub heading: Point,
}

fn tuple(p: Point) -> String {
    format!("({:?}, {:?})", p.0, p.1)
}

fn apart(a: Point, b: Point) -> f64 {
    exact_hypot(b.0 - a.0, b.1 - a.1)
}

/// The nearest N tip of each P tip makes an end. Heading: perpendicular to the tip pair (pair-stubs puts the tips side by side across
/// it), away from the stubs.
fn pair_ends(base: &str, p_tips: &[Tip], n_tips: &[Tip], pitch: f64) -> Result<Vec<End>, String> {
    let mut ends = Vec::new();
    for p in p_tips {
        let nearest = n_tips.iter().map(|q| (apart(p.at, q.at), q)).min_by(|a, b| a.0.total_cmp(&b.0)).expect("two N tips");
        let (distance, q) = nearest;
        if (distance - pitch).abs() > PITCH_TOLERANCE_MM {
            return Err(format!("PAIR {base} FAILED tips {} / {} not at the pitch {pitch:.2}", tuple(p.at), tuple(q.at)));
        }
        let (tx, ty) = (q.at.0 - p.at.0, q.at.1 - p.at.1);
        let (mut hx, mut hy) = (-ty, tx);
        if hx * (p.out.0 + q.out.0) + hy * (p.out.1 + q.out.1) < 0.0 {
            (hx, hy) = (-hx, -hy);
        }
        let h = exact_hypot(hx, hy);
        ends.push(End { p: p.clone(), n: q.clone(), mid: ((p.at.0 + q.at.0) / 2.0, (p.at.1 + q.at.1) / 2.0), heading: (hx / h, hy / h) });
    }
    Ok(ends)
}

/// Sorted by position: the board order follows the file, which changes with the random uuids of new tracks; the first end is the A*
/// start, so an unsorted order gave a different equal-cost route on each build (KIOSK-CM4 MDI, 2026-10-26).
fn sorted_tips(board: &Board, net: &str, layer: &str) -> Vec<Tip> {
    let mut tips = free_tips(board, net, layer);
    tips.sort_by(|a, b| a.at.0.total_cmp(&b.at.0).then(a.at.1.total_cmp(&b.at.1)));
    tips
}

fn along(end: &End, distance: f64) -> Point {
    (end.mid.0 + end.heading.0 * distance, end.mid.1 + end.heading.1 * distance)
}

fn lattice_round(ends: &[End], o: &Options) -> Lattice {
    let (xs, ys) = (ends.iter().map(|e| e.mid.0), ends.iter().map(|e| e.mid.1));
    let (x0, x1) = (xs.clone().fold(f64::INFINITY, f64::min), xs.fold(f64::NEG_INFINITY, f64::max));
    let (y0, y1) = (ys.clone().fold(f64::INFINITY, f64::min), ys.fold(f64::NEG_INFINITY, f64::max));
    Lattice::new(x0 - o.margin, y0 - o.margin, x1 + o.margin, y1 + o.margin, o.grid)
}

/// Leave each end along its heading: the first cells are free by construction (pair-stubs FRONT).
fn open_lead_ins(grid: &mut Lattice, ends: &[End]) {
    let steps = (FRONT / grid.g) as i64;
    for end in ends {
        for k in 0..=steps {
            let cell = grid.cell(along(end, k as f64 * grid.g));
            grid.set(cell, false);
        }
    }
}

/// Says why no path exists: what the headings run into, and how far each end gets.
fn no_path(grid: &Lattice, job: &Job, ends: &[End], o: &Options, out: &mut dyn FnMut(String)) -> Result<String, String> {
    let reach = [flood(grid, grid.cell(ends[0].mid)), flood(grid, grid.cell(ends[1].mid))];
    for end in ends {
        let probes: Vec<String> = PROBES.iter().map(|&d| format!("{d:?}:{}", if grid.is_blocked(grid.cell(along(end, d))) { "X" } else { "." })).collect();
        out(format!("  end {:.2},{:.2} heading {:+.2},{:+.2} {}", end.mid.0, end.mid.1, end.heading.0, end.heading.1, probes.join(" ")));
    }
    if let Some(folder) = &o.debug {
        dump(grid, &reach, &folder.join(format!("{}.pgm", job.base.replace('/', "_"))))?;
    }
    let count = |cells: &[bool]| cells.iter().filter(|c| **c).count();
    Ok(format!("PAIR {} FAILED no centreline path on {} (free cells reached from the ends: {} / {})", job.base, job.layer, count(&reach[0]), count(&reach[1])))
}

fn net_length(board: &Board, net: &str) -> f64 {
    board.tracks().filter(|t| t.net == net && t.mid.is_none()).map(|t| to_mm(t.end.x - t.start.x).hypot(to_mm(t.end.y - t.start.y))).sum()
}

/// The centreline from the path cells: lead-ins at the ends, short steps out.
fn centreline(grid: &Lattice, path: &[(i64, i64)], ends: &[End], leads: [Point; 2]) -> Vec<Point> {
    let mut points: Vec<Point> = turns(path).into_iter().map(|cell| grid.xy(cell)).collect();
    let last = points.len() - 1;
    (points[0], points[last]) = (leads[0], leads[1]);
    let line: Vec<Point> = std::iter::once(ends[0].mid).chain(points).chain(std::iter::once(ends[1].mid)).collect();
    without_collinear(&without_short(&line, MIN_SEG))
}

fn write_pair(session: &mut Session, job: &Job, line: &[Point], ends: &[End]) -> String {
    let (p_net, n_net) = job.nets();
    let (first, second) = (&ends[0], &ends[1]);
    let half = job.pitch() / 2.0;
    // P on the side of its tip at the start.
    let (dx, dy) = (line[1].0 - line[0].0, line[1].1 - line[0].1);
    let left = (first.p.at.0 - first.mid.0) * -dy + (first.p.at.1 - first.mid.1) * dx > 0.0;
    let (mut p_line, mut n_line) = (offset(line, if left { half } else { -half }), offset(line, if left { -half } else { half }));
    // The offset ends must be the tips (straight start / end along the heading).
    let last = p_line.len() - 1;
    if apart(p_line[last], second.p.at) > TIP_TOLERANCE_MM {
        return format!("PAIR {} FAILED polarity or heading mismatch at the far end ({} vs {})", job.base, tuple(p_line[last]), tuple(second.p.at));
    }
    (p_line[0], n_line[0]) = (first.p.at, first.n.at);
    (p_line[last], n_line[last]) = (second.p.at, second.n.at);
    add_polyline(session, &p_line, job.width, &p_net, &job.layer);
    add_polyline(session, &n_line, job.width, &n_net, &job.layer);
    let (p_length, n_length) = (net_length(&session.board, &p_net), net_length(&session.board, &n_net));
    format!("PAIR {} routed on {} centreline {:.1} mm P {p_length:.2} N {n_length:.2} skew {:+.2} mm", job.base, job.layer, length(line), p_length - n_length)
}

/// Routes one job into the session; the line says how it went.
pub fn route(session: &mut Session, job: &Job, o: &Options, out: &mut dyn FnMut(String)) -> Result<String, String> {
    let (p_net, n_net) = job.nets();
    let (p_tips, n_tips) = (sorted_tips(&session.board, &p_net, &job.layer), sorted_tips(&session.board, &n_net, &job.layer));
    if p_tips.len() != 2 || n_tips.len() != 2 {
        return Ok(format!("PAIR {} FAILED tips P {} N {} on {}", job.base, p_tips.len(), n_tips.len(), job.layer));
    }
    let ends = if job.single {
        // One track: each free tip is an end, its heading the tip direction.
        p_tips.iter().map(|t| End { p: t.clone(), n: t.clone(), mid: t.at, heading: t.out }).collect()
    } else {
        match pair_ends(&job.base, &p_tips, &n_tips, job.pitch()) {
            Ok(ends) => ends,
            Err(line) => return Ok(line),
        }
    };
    let mut grid = lattice_round(&ends, o);
    let last: Vec<&str> = ends.iter().flat_map(|e| [e.p.track.as_str(), e.n.track.as_str()]).collect();
    let half = job.pitch() / 2.0 + job.width / 2.0;
    let field = Field { board: &session.board, options: o, p_net: &p_net, n_net: &n_net, single: job.single, layer: &job.layer, half };
    field.close(&mut grid, &ends, &last)?;
    open_lead_ins(&mut grid, &ends);
    // Lead-in points: FRONT along each heading (free by construction); A* runs between them.
    let leads = [along(&ends[0], FRONT), along(&ends[1], FRONT)];
    let Some(path) = astar(&grid, grid.cell(leads[0]), grid.cell(leads[1]), ends[0].heading, ends[1].heading) else {
        return no_path(&grid, job, &ends, o, out);
    };
    let line = centreline(&grid, &path, &ends, leads);
    if job.single {
        add_polyline(session, &line, job.width, &p_net, &job.layer);
        return Ok(format!("PAIR {} routed on {} single track {:.1} mm, net {:.2} mm", job.base, job.layer, length(&line), net_length(&session.board, &p_net)));
    }
    Ok(write_pair(session, job, &line, &ends))
}

/// Every job in order: the lines, and the specs of the routes that failed.
fn route_all(session: &mut Session, order: &[String], o: &Options, out: &mut dyn FnMut(String)) -> Result<(Vec<String>, Vec<String>), String> {
    let (mut lines, mut failed) = (Vec::new(), Vec::new());
    for spec in order {
        let line = route(session, &Job::read(spec, &o.layer)?, o, out)?;
        if !line.contains(" routed ") {
            failed.push(spec.clone());
        }
        lines.push(line);
    }
    Ok((lines, failed))
}

/// The tool: routes `board`, retrying with failed routes first, and saves the last try over `target`. True when every route is in.
pub fn run(board: &Path, target: &Path, arguments: &str, o: &Options, out: &mut dyn FnMut(String)) -> Result<bool, String> {
    let mut order = o.order();
    if order.is_empty() {
        return Err("no --pair or --net to route".to_string());
    }
    let opened = Session::open(board, arguments)?;
    let mut attempt = 0;
    let (session, lines) = loop {
        attempt += 1;
        let mut session = Session::of(board, opened.board.clone(), opened.rules.clone(), arguments)?;
        let (lines, failed) = route_all(&mut session, &order, o, out)?;
        if failed.is_empty() {
            break (session, lines);
        }
        // A pair blocked by one routed before it: route it first next time.
        out(format!("ORDER attempt {attempt}: failed {}; retry with them first", repr_list(&failed)));
        order = failed.iter().chain(order.iter().filter(|spec| !failed.contains(spec))).cloned().collect();
        if attempt == order.len() {
            break (session, lines);
        }
    };
    lines.iter().for_each(|line| out(line.clone()));
    session.save_to(target)?;
    let routed = lines.iter().filter(|line| line.contains(" routed ")).count();
    out(format!("PAIRS routed {routed} failed {}", lines.len() - routed));
    Ok(routed == lines.len())
}
