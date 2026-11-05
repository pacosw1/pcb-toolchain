//! The check of one board: which nets must leave a region, and the flow that says if they all can.
use super::items::{BoardItems, Kind};
use super::network::{Access, Graph};
use super::raster::{Frame, Nets, Raster, Rect, draw};
use super::report::{ClassRun, Cut, Region, Tally, Verdict};
use super::rules::{NetClass, Rules};
use crate::grid::item::Point;
use crate::kicad::board::{Board, Footprint};
use crate::kicad::geom::{Rect as BoardRect, to_mm};
use crate::model::text::round_to;
use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;

const IN2: &str = "In2.Cu";
/// A part of this many pads is checked in a whole-board run.
const WHOLE_BOARD_PADS: usize = 8;
const CUT_NEIGHBOURHOOD: usize = 2;
const CUT_NAMES: usize = 8;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Options {
    pub layers: Vec<String>,
    pub in2_nets: BTreeSet<String>,
    pub plane_nets: BTreeSet<String>,
    /// None: every net.
    pub only_nets: Option<BTreeSet<String>>,
    /// None: the board min_track_width.
    pub neck_mm: Option<f64>,
}

pub struct Checker<'b> {
    board: &'b Board,
    pub rules: Rules,
    pub items: BoardItems,
    /// Width source: the board min_track_width (.kicad_pro design rules), which fastroute_job gives the router as
    /// router.min_trace_width_um; the router used it (0.15 mm) at the BASE-PWR-B J1 and U19 pads. --neck-mm overrides it, 0 = off.
    pub neck: f64,
    pub layers: Vec<String>,
    options: Options,
    /// Pads with copper, by net.
    net_pads: BTreeMap<String, Vec<(Point, String)>>,
}

fn inside(p: Point, rect: Rect) -> bool {
    rect[0] <= p.0 && p.0 <= rect[2] && rect[1] <= p.1 && p.1 <= rect[3]
}

fn box_mm(b: BoardRect) -> Rect {
    [to_mm(b.left), to_mm(b.top), to_mm(b.right), to_mm(b.bottom)]
}

/// The box of a part: its courtyard, else its pad positions.
fn part_box(footprint: &Footprint) -> Rect {
    if let Some(bbox) = footprint.courtyard_box("F.CrtYd").or_else(|| footprint.courtyard_box("B.CrtYd")) {
        return box_mm(bbox);
    }
    let at = footprint.pads.iter().map(|p| (to_mm(p.position.x), to_mm(p.position.y)));
    at.fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |b, p| [b[0].min(p.0), b[1].min(p.1), b[2].max(p.0), b[3].max(p.1)])
}

impl<'b> Checker<'b> {
    pub fn new(board: &'b Board, rules: Rules, options: Options) -> Checker<'b> {
        let items = BoardItems::of(board);
        let mut layers: Vec<String> = options.layers.iter().filter(|l| items.copper_layers.contains(l)).cloned().collect();
        let in2_on_board = items.copper_layers.iter().any(|l| l == IN2);
        if !options.in2_nets.is_empty() && !layers.iter().any(|l| l == IN2) && in2_on_board {
            layers.push(IN2.to_string());
        }
        let mut net_pads: BTreeMap<String, Vec<(Point, String)>> = BTreeMap::new();
        for pad in &items.pads {
            let net = &items.obstacles[pad.obstacle].item.net;
            if !net.is_empty() {
                net_pads.entry(net.clone()).or_default().push((pad.at, pad.reference.clone()));
            }
        }
        let neck = options.neck_mm.unwrap_or(rules.min_track);
        Checker { board, rules, items, neck, layers, options, net_pads }
    }

    /// Non-plane nets with a pad in the region and another pad outside it or on another part. Per part, only that part's pads count.
    fn demand(&self, rect: Rect, part: Option<&str>) -> Vec<String> {
        let wanted = |net: &String| !self.options.plane_nets.contains(net) && self.options.only_nets.as_ref().is_none_or(|only| only.contains(net));
        self.net_pads.iter().filter(|(net, _)| wanted(net)).filter(|(_, pads)| {
            let mine = pads.iter().find(|(at, reference)| inside(*at, rect) && part.is_none_or(|p| p == reference));
            // Must leave: a pad outside the region, or a pad on another part.
            mine.is_some_and(|(_, first)| pads.iter().any(|(at, reference)| !inside(*at, rect) || reference != first))
        }).map(|(net, _)| net.clone()).collect()
    }

    fn classes(&self, nets: &[String]) -> Vec<NetClass> {
        nets.iter().map(|net| self.rules.class(net).clone()).collect()
    }

    /// The parts of a run: these references, else with --only-nets every part with a pad of those nets, else every large part. The
    /// region of a part is its courtyard box grown by `escape_mm`.
    pub fn footprint_regions(&self, escape_mm: f64, refs: Option<&BTreeSet<String>>) -> Vec<(String, Rect)> {
        let wanted = |f: &Footprint| match (refs, &self.options.only_nets) {
            (Some(refs), _) => refs.contains(&f.reference),
            (None, Some(only)) => f.pads.iter().any(|p| only.contains(&p.net)),
            (None, None) => f.pads.len() >= WHOLE_BOARD_PADS,
        };
        self.board.footprints.iter().filter(|f| wanted(f)).map(|f| {
            let b = part_box(f);
            (f.reference.clone(), [b[0] - escape_mm, b[1] - escape_mm, b[2] + escape_mm, b[3] + escape_mm])
        }).collect()
    }

    /// All demand nets on the smallest class pitch; with mixed net classes also each class alone on its own pitch and clearances (a
    /// necessary condition the mixed run is too optimistic for). FAIL if any run fails.
    pub fn run(&mut self, name: &str, rect: Rect, part: Option<&str>) -> Region {
        let started = Instant::now();
        let demand = self.demand(rect, part);
        let mut region = self.flow(name, rect, part, &demand);
        let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for net in &demand {
            groups.entry(self.rules.class(net).name.clone()).or_default().push(net.clone());
        }
        if groups.len() > 1 {
            let own = self.groups_of_their_own(&groups, &demand, rect);
            let mut runs = Vec::new();
            for (class, nets) in own {
                let sub = self.flow(name, rect, part, &nets);
                runs.push(ClassRun::of(&sub));
                region.absorb(sub, &class);
            }
            region.per_class = Some(runs);
        }
        region.time_s = seconds(started);
        region
    }

    /// A class gets its own run only when its clearances differ from the pitch class (clearance is a DRC constraint; the net class
    /// track width is only the router default, routers neck down at pads).
    fn groups_of_their_own(&mut self, groups: &BTreeMap<String, Vec<String>>, demand: &[String], rect: Rect) -> Vec<(String, Vec<String>)> {
        let least = demand.iter().min_by(|a, b| self.rules.class(a).pitch().total_cmp(&self.rules.class(b).pitch())).expect("two classes have nets").clone();
        let near: BTreeSet<String> = self.items.pads.iter().filter(|p| inside(p.at, rect)).map(|p| self.items.obstacles[p.obstacle].item.net.clone()).collect();
        let mut own = Vec::new();
        for (class, nets) in groups {
            if near.iter().any(|net| self.rules.clearance(net, Kind::Pad, &nets[0]) != self.rules.clearance(net, Kind::Pad, &least)) {
                own.push((class.clone(), nets.clone()));
            }
        }
        own
    }

    fn flow(&mut self, name: &str, rect: Rect, part: Option<&str>, demand: &[String]) -> Region {
        let started = Instant::now();
        let mut region = Region::new(name, rect, demand);
        if demand.is_empty() {
            region.time_s = seconds(started);
            return region;
        }
        let classes = self.classes(demand);
        let narrow = classes.iter().min_by(|a, b| a.pitch().total_cmp(&b.pitch())).expect("demand has nets").clone();
        let frame = Frame::new(rect, narrow.pitch());
        let nets = Nets::new(self, demand, &classes);
        region.pitch_mm = Some(round_to(narrow.pitch(), 4));
        region.pitch_class = Some(narrow.name);
        region.neck_mm = Some(round_to(2.0 * nets.neck_half_min, 4));
        let raster = draw(self, frame, &nets, rect, part);
        let restricted = self.layers.iter().map(|l| !self.options.in2_nets.is_empty() && l == IN2).collect();
        let in2 = demand.iter().map(|net| self.options.in2_nets.contains(net)).collect();
        let graph = Graph::new(frame, &raster, Access { restricted, in2 });
        let solved = graph.solve();
        region.flow = solved.flow;
        region.verdict = if solved.flow == demand.len() as i64 { Verdict::Pass } else { Verdict::Fail };
        region.grid = Some([frame.nx, frame.ny, self.layers.len()]);
        let served = graph.served(&solved);
        region.unescaped = demand.iter().zip(&served).filter(|(_, got)| !**got).map(|(net, _)| net.clone()).collect();
        if region.verdict == Verdict::Fail {
            let seen = solved.reachable(graph.source_node());
            let contested = graph.contested(&seen);
            region.contested = contested.iter().map(|&k| demand[k].clone()).collect();
            let cells = graph.cut_cells(&seen);
            region.cut = Some(if cells.is_empty() { self.boxed_in(&graph, &raster, demand, &contested) } else { self.cut_at(&cells, &raster, frame, demand) });
        }
        region.time_s = seconds(started);
        region
    }

    fn name_of(&self, at: i32) -> &str {
        &self.items.obstacles[at as usize].item.owner
    }

    /// The cut in free cells: its box and what stands round it.
    fn cut_at(&self, cells: &[(usize, usize, usize)], raster: &Raster, frame: Frame, demand: &[String]) -> Cut {
        let mut near = Tally::default();
        for &(layer, j, i) in cells {
            for jj in j.saturating_sub(CUT_NEIGHBOURHOOD)..(j + CUT_NEIGHBOURHOOD + 1).min(frame.ny) {
                for ii in i.saturating_sub(CUT_NEIGHBOURHOOD)..(i + CUT_NEIGHBOURHOOD + 1).min(frame.nx) {
                    let (owner, state) = (raster.owners[layer][frame.at(jj, ii)], raster.states[layer][frame.at(jj, ii)]);
                    if owner >= 0 {
                        near.add(self.name_of(owner));
                    } else if state >= 0 {
                        near.add(&format!("own:{}", demand[state as usize]));
                    }
                }
            }
        }
        let xs = cells.iter().map(|&(_, _, i)| frame.x(i));
        let ys = cells.iter().map(|&(_, j, _)| frame.y(j));
        let low = |v: f64, w: f64| v.min(w);
        let high = |v: f64, w: f64| v.max(w);
        let bbox = [xs.clone().fold(f64::INFINITY, low), ys.clone().fold(f64::INFINITY, low), xs.fold(f64::NEG_INFINITY, high), ys.fold(f64::NEG_INFINITY, high)].map(|v| round_to(v, 2));
        let layers: BTreeSet<&String> = cells.iter().map(|&(layer, _, _)| &self.layers[layer]).collect();
        Cut { cells: cells.len(), layers: Some(layers.into_iter().cloned().collect()), bbox: Some(bbox), note: None, near: near.most_common(CUT_NAMES) }
    }

    /// No free cell on the cut: the sources themselves are boxed in, by what stands on their rim.
    fn boxed_in(&self, graph: &Graph, raster: &Raster, demand: &[String], contested: &[usize]) -> Cut {
        let mut near = Tally::default();
        for &net in contested {
            for layer in 0..self.layers.len() {
                for cell in graph.rim(layer, net) {
                    let (owner, state) = (raster.owners[layer][cell], raster.states[layer][cell]);
                    if owner >= 0 && self.items.obstacles[owner as usize].item.net != demand[net] {
                        near.add(self.name_of(owner));
                    } else if state >= 0 && state != net as i32 {
                        near.add(&format!("own:{}", demand[state as usize]));
                    }
                }
            }
        }
        Cut { cells: 0, layers: None, bbox: None, note: Some("sources boxed in: no free cell reachable (cut at the source)".to_string()), near: near.most_common(CUT_NAMES) }
    }
}

fn seconds(since: Instant) -> f64 {
    round_to(since.elapsed().as_secs_f64(), 3)
}

