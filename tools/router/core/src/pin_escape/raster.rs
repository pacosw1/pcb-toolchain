//! The routing space of one region as a grid: which cells are free, private to an escaping net, or blocked, on the class pitch.
use super::check::Checker;
use super::items::{Kind, Obstacle};
use super::rules::NetClass;
use crate::grid::item::{Point, in_poly, poly_dist};
use std::collections::HashMap;
use std::ops::Range;

/// A cell no net owns and nothing blocks.
pub const FREE: i32 = -1;
pub const BLOCKED: i32 = -2;
const NONE: i32 = -1;
/// The least reach round a region for items to matter, before a via and a pitch are added.
const MIN_REACH_MM: f64 = 8.0;

/// x1, y1, x2, y2.
pub type Rect = [f64; 4];

/// The cells of a region, row by row.
#[derive(Debug, Clone, Copy)]
pub struct Frame {
    x0: f64,
    y0: f64,
    pub pitch: f64,
    pub nx: usize,
    pub ny: usize,
}

impl Frame {
    pub fn new(rect: Rect, pitch: f64) -> Frame {
        let cells = |from: f64, to: f64| (((to - from) / pitch).ceil() as usize).max(2);
        Frame { x0: rect[0], y0: rect[1], pitch, nx: cells(rect[0], rect[2]), ny: cells(rect[1], rect[3]) }
    }

    pub fn cells(&self) -> usize {
        self.nx * self.ny
    }

    pub fn x(&self, i: usize) -> f64 {
        self.x0 + (i as f64 + 0.5) * self.pitch
    }

    pub fn y(&self, j: usize) -> f64 {
        self.y0 + (j as f64 + 0.5) * self.pitch
    }

    pub fn at(&self, j: usize, i: usize) -> usize {
        j * self.nx + i
    }

    pub fn on_ring(&self, j: usize, i: usize) -> bool {
        j == 0 || j + 1 == self.ny || i == 0 || i + 1 == self.nx
    }

    /// The (row, column) of each cell in row order.
    pub fn rows(&self) -> impl Iterator<Item = (usize, usize)> + use<> {
        let (nx, ny) = (self.nx, self.ny);
        (0..ny).flat_map(move |j| (0..nx).map(move |i| (j, i)))
    }

    /// The columns and rows round a box. None when they miss the region.
    fn span(&self, bbox: [f64; 4], reach: f64) -> Option<(Range<usize>, Range<usize>)> {
        let low = |edge: f64, origin: f64| (((edge - reach - origin) / self.pitch) as i64).max(0);
        let high = |edge: f64, origin: f64, count: usize| (((edge + reach - origin) / self.pitch) as i64 + 2).min(count as i64);
        let (a0, a1) = (low(bbox[0], self.x0), high(bbox[2], self.x0, self.nx));
        let (b0, b1) = (low(bbox[1], self.y0), high(bbox[3], self.y0, self.ny));
        (a1 > a0 && b1 > b0).then(|| (a0 as usize..a1 as usize, b0 as usize..b1 as usize))
    }

    /// The cell of a point inside the region.
    fn cell_of(&self, p: Point) -> Option<(usize, usize)> {
        let (i, j) = (((p.0 - self.x0) / self.pitch) as i64, ((p.1 - self.y0) / self.pitch) as i64);
        (i >= 0 && j >= 0 && (i as usize) < self.nx && (j as usize) < self.ny).then_some((j as usize, i as usize))
    }
}

/// How many nets reach each cell: a net counts again when another came between.
struct Cover {
    count: Vec<u16>,
    last: Vec<i32>,
}

impl Cover {
    fn new(cells: usize) -> Cover {
        Cover { count: vec![0; cells], last: vec![NONE; cells] }
    }

    fn add(&mut self, cell: usize, net: i32) {
        if self.last[cell] != net {
            self.count[cell] += 1;
            self.last[cell] = net;
        }
    }
}

/// The escaping nets on a region's grid. Halo radius of an escaping net's copper = min clearance to the other escaping nets + their
/// half width; `neck_*` the same at the neck width.
pub struct Nets<'n> {
    pub names: &'n [String],
    index: HashMap<&'n str, i32>,
    half: Vec<f64>,
    neck_half: Vec<f64>,
    halo: Vec<f64>,
    neck_halo: Vec<f64>,
    pub via_radius: f64,
    half_min: f64,
    pub neck_half_min: f64,
}

fn fold_min(values: impl Iterator<Item = f64>) -> f64 {
    values.fold(f64::INFINITY, f64::min)
}

impl<'n> Nets<'n> {
    pub fn new(check: &mut Checker, names: &'n [String], classes: &[NetClass]) -> Nets<'n> {
        let neck = check.neck;
        let half: Vec<f64> = classes.iter().map(|c| c.track_width / 2.0).collect();
        // Router neck: within the pad's long dimension of a source pad every track may be neck width.
        let neck_half: Vec<f64> = half.iter().map(|&h| if neck > 0.0 { h.min(neck / 2.0) } else { h }).collect();
        let mut halo_of = |widths: &[f64]| -> Vec<f64> {
            names.iter().enumerate().map(|(k, net)| {
                let others: Vec<f64> = names.iter().enumerate().filter(|(o, _)| *o != k).map(|(o, other)| check.rules.clearance(net, Kind::Track, other) + widths[o]).collect();
                if others.is_empty() { 0.0 } else { fold_min(others.into_iter()) }
            }).collect()
        };
        let (halo, neck_halo) = (halo_of(&half), halo_of(&neck_half));
        Nets {
            names,
            index: names.iter().enumerate().map(|(k, net)| (net.as_str(), k as i32)).collect(),
            via_radius: fold_min(classes.iter().map(|c| c.via_diameter)) / 2.0,
            half_min: fold_min(half.iter().copied()),
            neck_half_min: fold_min(neck_half.iter().copied()),
            half,
            neck_half,
            halo,
            neck_halo,
        }
    }
}

/// How far an item keeps track and via centres off.
struct Reach {
    /// None: it keeps no track off.
    track: Option<f64>,
    neck: Option<f64>,
    via: f64,
}

fn reach(check: &mut Checker, nets: &Nets, at: usize) -> Reach {
    let Obstacle { item, kind } = &check.items.obstacles[at];
    let (net_of_item, own, kind) = (item.net.clone(), item.clearance, *kind);
    match kind {
        Kind::KeepVia => Reach { track: None, neck: None, via: nets.via_radius },
        // KiCad keepout semantics: no clearance.
        Kind::KeepTrack => Reach { track: Some(nets.half_min), neck: Some(nets.neck_half_min), via: nets.via_radius },
        Kind::Hole => {
            let hole = check.rules.hole;
            Reach { track: Some(hole + nets.half_min), neck: Some(hole + nets.neck_half_min), via: hole + nets.via_radius }
        }
        Kind::Pad | Kind::Track | Kind::Via => {
            let clear: Vec<(usize, f64)> = nets.names.iter().enumerate().filter(|(_, net)| **net != net_of_item)
                .map(|(k, net)| (k, check.rules.clearance(&net_of_item, kind, net).max(own))).collect();
            let least = |widths: &[f64]| clear.iter().map(|&(k, c)| c + widths[k]).reduce(f64::min);
            Reach { track: least(&nets.half), neck: least(&nets.neck_half), via: clear.iter().map(|&(_, c)| c).reduce(f64::min).unwrap_or(0.0) + nets.via_radius }
        }
    }
}

/// One routing layer of the grid.
struct LayerCells {
    /// Blocked by what does not escape.
    blocked: Vec<bool>,
    neck_blocked: Vec<bool>,
    /// The last item blocking each cell, for the cut report.
    owner: Vec<i32>,
    /// Distance to the nearest escaping copper, and its net.
    own_distance: Vec<f64>,
    own_net: Vec<i32>,
    halo: Cover,
    neck_halo: Cover,
    /// Within a pad's long dimension of a source pad.
    zone: Vec<bool>,
}

impl LayerCells {
    fn new(edge: &[bool]) -> LayerCells {
        let cells = edge.len();
        LayerCells { blocked: edge.to_vec(), neck_blocked: edge.to_vec(), owner: vec![NONE; cells], own_distance: vec![f64::INFINITY; cells], own_net: vec![NONE; cells], halo: Cover::new(cells), neck_halo: Cover::new(cells), zone: vec![false; cells] }
    }

    /// FREE, BLOCKED or the net a cell is private to. Own copper overrides other nets' halos, not other nets' copper (the blocked
    /// core), approximated by the halo.
    fn state(&self, cell: usize) -> i32 {
        let (blocked, halo) = if self.zone[cell] { (self.neck_blocked[cell], &self.neck_halo) } else { (self.blocked[cell], &self.halo) };
        if self.own_net[cell] >= 0 {
            self.own_net[cell]
        } else if blocked || halo.count[cell] > 1 {
            BLOCKED
        } else if halo.count[cell] == 1 {
            halo.last[cell]
        } else {
            FREE
        }
    }
}

/// The grid of a region, every item drawn in.
pub struct Raster {
    /// Per routing layer, each cell's state and the item that blocks it.
    pub states: Vec<Vec<i32>>,
    pub owners: Vec<Vec<i32>>,
    pub via_blocked: Vec<bool>,
    /// Escaping nets a via at each cell would meet, and the last of them.
    pub via_nets: Vec<u16>,
    pub via_last: Vec<i32>,
}

struct Painter<'p> {
    frame: Frame,
    nets: &'p Nets<'p>,
    layers: Vec<LayerCells>,
    /// The bit of each routing layer in `Item::layers`.
    layer_at: Vec<usize>,
    via_blocked: Vec<bool>,
    via_cover: Cover,
}

impl Painter<'_> {
    /// `part`: the part whose pads are the source copper; a net's pads elsewhere only block the other escaping nets.
    fn paint(&mut self, obstacle: &Obstacle, at: usize, keep: Reach, part: Option<&str>) {
        let (item, kind) = (&obstacle.item, obstacle.kind);
        let net = self.nets.index.get(item.net.as_str()).copied();
        let source = net.filter(|_| part.is_none() || kind != Kind::Pad || Some(item.reference()) == part);
        let (bb, pitch) = (item.bbox, self.frame.pitch);
        let pad_length = if source.is_some() && kind == Kind::Pad { (bb[2] - bb[0]).max(bb[3] - bb[1]) } else { 0.0 };
        let own_reach = source.map_or(0.0, |k| self.nets.halo[k as usize] + pitch); // pitch: own cells reach d <= pitch / 2
        let span = keep.track.unwrap_or(0.0).max(keep.via).max(own_reach).max(pad_length);
        let Some((columns, rows)) = self.frame.span(bb, span) else { return };
        let on_layers: Vec<usize> = (0..self.layers.len()).filter(|&l| item.on_layer(self.layer_at[l]) && kind != Kind::KeepVia).collect();
        for j in rows {
            for i in columns.clone() {
                let (d, cell) = (item.distance(self.frame.x(i), self.frame.y(j)), self.frame.at(j, i));
                // Vias are through-hole: every copper layer of the item counts.
                if kind != Kind::KeepTrack && d < keep.via {
                    match source {
                        Some(k) => self.via_cover.add(cell, k),
                        None => self.via_blocked[cell] = true,
                    }
                }
                for &l in &on_layers {
                    let cells = &mut self.layers[l];
                    if let Some(k) = source {
                        if d <= 0.5 * pitch && d < cells.own_distance[cell] {
                            cells.own_distance[cell] = d;
                            cells.own_net[cell] = k;
                        }
                        if d < self.nets.halo[k as usize] {
                            cells.halo.add(cell, k);
                        }
                        if d < self.nets.neck_halo[k as usize] {
                            cells.neck_halo.add(cell, k);
                        }
                        if pad_length > 0.0 && d <= pad_length {
                            cells.zone[cell] = true;
                        }
                    } else if let Some(limit) = keep.track {
                        if d < limit {
                            cells.blocked[cell] = true;
                            cells.owner[cell] = at as i32;
                        }
                        if keep.neck.is_some_and(|neck| d < neck) {
                            cells.neck_blocked[cell] = true;
                        }
                    }
                }
            }
        }
        // A pad smaller than a cell still owns its nearest cell.
        if let (Some(k), Kind::Pad) = (source, kind) {
            if let Some((j, i)) = self.frame.cell_of(((bb[0] + bb[2]) / 2.0, (bb[1] + bb[3]) / 2.0)) {
                let cell = self.frame.at(j, i);
                for l in (0..self.layers.len()).filter(|&l| item.on_layer(self.layer_at[l])) {
                    if self.layers[l].own_net[cell] < 0 {
                        self.layers[l].own_net[cell] = k;
                        self.layers[l].own_distance[cell] = 0.0;
                    }
                }
            }
        }
    }
}

/// Cells outside the board or within `margin` of its edge.
fn edge_cells(frame: &Frame, outline: &[Vec<Point>], track_margin: f64, via_margin: f64) -> (Vec<bool>, Vec<bool>) {
    let (mut track, mut via) = (vec![false; frame.cells()], vec![false; frame.cells()]);
    for (j, i) in frame.rows() {
        let (x, y) = (frame.x(i), frame.y(j));
        let inside = outline.iter().fold(false, |ins, points| ins ^ in_poly(x, y, points));
        let distance = fold_min(outline.iter().map(|points| poly_dist(x, y, points)));
        track[frame.at(j, i)] = !inside || distance < track_margin;
        via[frame.at(j, i)] = !inside || distance < via_margin;
    }
    (track, via)
}

pub fn draw(check: &mut Checker, frame: Frame, nets: &Nets, rect: Rect, part: Option<&str>) -> Raster {
    let edge = check.rules.edge;
    let (track_edge, via_edge) = edge_cells(&frame, &check.items.outline, edge + nets.half_min, edge + nets.via_radius);
    let copper = &check.items.copper_layers;
    let layer_at: Vec<usize> = check.layers.iter().map(|l| copper.iter().position(|c| c == l).expect("a routing layer is a copper layer")).collect();
    let mut painter = Painter { frame, nets, layers: layer_at.iter().map(|_| LayerCells::new(&track_edge)).collect(), layer_at, via_blocked: via_edge, via_cover: Cover::new(frame.cells()) };
    let clear = nets.names.iter().fold(MIN_REACH_MM, |most, net| most.max(check.rules.clearance("", Kind::Pad, net)));
    let margin = clear + nets.via_radius + frame.pitch;
    for at in 0..check.items.obstacles.len() {
        let bb = check.items.obstacles[at].item.bbox;
        if bb[2] >= rect[0] - margin && bb[0] <= rect[2] + margin && bb[3] >= rect[1] - margin && bb[1] <= rect[3] + margin {
            let keep = reach(check, nets, at);
            painter.paint(&check.items.obstacles[at], at, keep, part);
        }
    }
    let Painter { layers, via_blocked, via_cover, .. } = painter;
    Raster {
        states: layers.iter().map(|cells| (0..frame.cells()).map(|cell| cells.state(cell)).collect()).collect(),
        owners: layers.into_iter().map(|cells| cells.owner).collect(),
        via_blocked,
        via_nets: via_cover.count,
        via_last: via_cover.last,
    }
}
