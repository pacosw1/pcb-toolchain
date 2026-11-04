pub mod geometry;

use geometry::{Geometry, Point};
use iotroute::kicad::geom::{Polygon, Rect, boolean};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Deserialize)]
pub struct Draw {
    pub dark: bool,
    pub geometry: Geometry,
}
#[derive(Debug, Deserialize)]
pub struct Layer {
    pub name: String,
    pub operations: Vec<Draw>,
}
#[derive(Debug, Deserialize)]
pub struct Hole {
    pub start: Point,
    pub end: Point,
    pub diameter: f64,
}
#[derive(Debug, Deserialize)]
pub struct Pad {
    pub r#ref: String,
    pub pin: String,
    pub x: f64,
    pub y: f64,
    pub layers: Vec<String>,
    pub net: Option<String>,
}
#[derive(Debug, Deserialize)]
pub struct Input {
    pub layers: Vec<Layer>,
    pub holes: Vec<Hole>,
    pub pads: Vec<Pad>,
}

#[derive(Debug, Serialize)]
pub struct LayerSummary {
    pub name: String,
    pub pieces: usize,
}
#[derive(Debug, Serialize)]
pub struct Report {
    pub layers: Vec<LayerSummary>,
    pub pads: usize,
    pub holes: usize,
    pub nets: usize,
    pub nets_checked: usize,
    pub opens: BTreeMap<String, Vec<Vec<String>>>,
    pub shorts: Vec<BTreeMap<String, Vec<String>>>,
    pub missing: Vec<String>,
}

impl Report {
    pub fn passed(&self) -> bool {
        self.opens.is_empty() && self.shorts.is_empty() && self.missing.is_empty()
    }
}

struct DisjointSet {
    parents: Vec<usize>,
}
impl DisjointSet {
    fn new(count: usize) -> Self {
        Self {
            parents: (0..count).collect(),
        }
    }
    fn find(&mut self, mut a: usize) -> usize {
        while self.parents[a] != a {
            self.parents[a] = self.parents[self.parents[a]];
            a = self.parents[a];
        }
        a
    }
    fn connect(&mut self, ids: &[usize]) {
        if let Some(&first) = ids.first() {
            for &id in &ids[1..] {
                let (a, b) = (self.find(first), self.find(id));
                self.parents[a] = b;
            }
        }
    }
}

struct Piece {
    layer: String,
    polygon: Polygon,
    bbox: Rect,
}
fn overlap(a: Rect, b: Rect) -> bool {
    a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom
}

/// Dark objects are batched until a clear object: subtraction affects all earlier copper, never a later dark flash.
fn layer_geometry(layer: &Layer) -> Result<Vec<Polygon>, String> {
    let mut geometry = Vec::new();
    let mut dark = Vec::new();
    for op in &layer.operations {
        let shape = geometry::render(&op.geometry)?;
        if op.dark {
            dark.extend(shape);
        } else {
            geometry = boolean::union(&geometry, &dark)?;
            dark.clear();
            geometry = boolean::difference(&geometry, &shape)?;
        }
    }
    boolean::union(&geometry, &dark)
}

pub fn check(input: &Input) -> Result<Report, String> {
    let mut pieces = Vec::new();
    let mut layers = Vec::new();
    for layer in &input.layers {
        let polygons = layer_geometry(layer).map_err(|e| format!("{}: {e}", layer.name))?;
        layers.push(LayerSummary {
            name: layer.name.clone(),
            pieces: polygons.len(),
        });
        for polygon in polygons {
            if let Some(bbox) = polygon.bbox() {
                pieces.push(Piece {
                    layer: layer.name.clone(),
                    polygon,
                    bbox,
                });
            }
        }
    }
    // One index for holes and pads; only candidates whose x and y ranges overlap reach a polygon test.
    let mut by_x: Vec<_> = (0..pieces.len()).collect();
    by_x.sort_by_key(|&i| pieces[i].bbox.left);
    let mut dsu = DisjointSet::new(pieces.len());
    for hole in &input.holes {
        if hole.diameter <= 0.0 {
            return Err("plated hole needs a positive diameter".into());
        }
        // Original overlap allowance: 0.05 mm beyond the hole; buffer quadrant resolution 16.
        let ring = geometry::capsule(hole.start, hole.end, hole.diameter / 2.0 + 0.05, 16)?;
        let mut hits = Vec::new();
        for polygon in ring {
            let bbox = polygon.bbox().unwrap();
            let hi = by_x.partition_point(|&i| pieces[i].bbox.left <= bbox.right);
            hits.extend(by_x[..hi].iter().copied().filter(|&i| {
                overlap(bbox, pieces[i].bbox) && pieces[i].polygon.overlaps(&polygon)
            }));
        }
        dsu.connect(&hits);
    }
    let mut missing = Vec::new();
    let mut pad_components = BTreeMap::new();
    for pad in &input.pads {
        let point = geometry::point([pad.x, pad.y]);
        let hi = by_x.partition_point(|&i| pieces[i].bbox.left <= point.x);
        let hits: Vec<_> = by_x[..hi]
            .iter()
            .copied()
            .filter(|&i| {
                let p = &pieces[i];
                pad.layers.contains(&p.layer)
                    && point.x <= p.bbox.right
                    && p.bbox.top <= point.y
                    && point.y <= p.bbox.bottom
                    && p.polygon.near(point, 0)
            })
            .collect();
        if let Some(&first) = hits.first() {
            dsu.connect(&hits);
            pad_components.insert(
                (pad.r#ref.clone(), pad.pin.clone()),
                (first, pad.net.clone()),
            );
        } else {
            missing.push(format!(
                "{}.{} ({})",
                pad.r#ref,
                pad.pin,
                pad.net.as_deref().unwrap_or("None")
            ));
        }
    }
    let mut components = BTreeMap::<usize, BTreeMap<String, Vec<String>>>::new();
    for ((r, pin), (component, net)) in pad_components {
        let Some(net) = net.filter(|n| !n.starts_with("unconnected-")) else {
            continue;
        };
        components
            .entry(dsu.find(component))
            .or_default()
            .entry(net)
            .or_default()
            .push(format!("{r}.{pin}"));
    }
    let shorts = components
        .values()
        .filter(|nets| nets.len() > 1)
        .cloned()
        .collect();
    let mut net_components = BTreeMap::<String, Vec<Vec<String>>>::new();
    for nets in components.into_values() {
        for (net, pins) in nets {
            net_components.entry(net).or_default().push(pins);
        }
    }
    let nets_checked = net_components
        .values()
        .filter(|c| c.iter().map(Vec::len).sum::<usize>() > 1)
        .count();
    Ok(Report {
        layers,
        pads: input.pads.len(),
        holes: input.holes.len(),
        nets: net_components.len(),
        nets_checked,
        opens: net_components
            .into_iter()
            .filter(|(_, c)| c.len() > 1)
            .collect(),
        shorts,
        missing,
    })
}
