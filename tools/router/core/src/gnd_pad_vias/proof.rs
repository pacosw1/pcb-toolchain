//! Is a pad already joined to a nearby via? Being near proves nothing: only a fresh native connectivity does.
use crate::kicad::board::Board;
use crate::kicad::edit::Edit;
use crate::kicad::geom::collide::collide;
use crate::kicad::geom::{Polygon, Pt};
use crate::kicad::pad::{Copper, Pad};

/// What connectivity says about one pad: the vias of its net joined to it.
pub trait Links {
    fn vias_of(&mut self, pad: &Pad) -> Result<Vec<Pt>, String>;
}

fn nearby(center: Pt, position: Pt, radius: f64) -> bool {
    ((position.x - center.x) as f64).hypot((position.y - center.y) as f64) <= radius
}

/// A proximity candidate needs fresh connectivity before it can suppress a repair. Every copper change invalidates the proof;
/// saved filled polygons alone are not evidence. A refresh that fails propagates: an unproved pad is never taken as connected.
pub struct NearbyViaProof<L> {
    links: Option<L>,
}

impl<L: Links> NearbyViaProof<L> {
    pub fn new() -> Self {
        NearbyViaProof { links: None }
    }

    pub fn invalidate(&mut self) {
        self.links = None;
    }

    /// The refresh runs only when a via is near and no fresh connectivity is held.
    pub fn connected(&mut self, pad: &Pad, vias: &[Pt], radius: f64, refresh: impl FnOnce() -> Result<L, String>) -> Result<bool, String> {
        if !vias.iter().any(|v| nearby(pad.position, *v, radius)) {
            return Ok(false);
        }
        if self.links.is_none() {
            self.links = Some(refresh()?);
        }
        let links = self.links.as_mut().expect("just refreshed");
        Ok(links.vias_of(pad)?.iter().any(|v| nearby(pad.position, *v, radius)))
    }
}

impl<L: Links> Default for NearbyViaProof<L> {
    fn default() -> Self {
        Self::new()
    }
}

/// One item of a net, for the copper-only graph.
struct Node {
    layers: Vec<String>,
    shapes: Vec<Copper>,
    via: Option<Pt>,
}

/// The tracks, vias and pads of one net and how they touch, with zones left out: the clusters of GetConnectedItems with
/// EXCLUDE_ZONES, which KiCad's API does not offer. Stale fills can then never pass for a connection.
pub struct DirectCopper {
    nodes: Vec<Node>,
    pads: Vec<(String, usize)>,
}

fn pad_shapes(pad: &Pad) -> Vec<Copper> {
    if !pad.copper.is_empty() {
        return pad.copper.clone();
    }
    pad.polygons.values().next().map(|p: &Polygon| vec![Copper::Polygon(p.outline.clone())]).unwrap_or_default()
}

/// CN_VISITOR of KiCad 10.0.6: two items on a common layer connect when their effective shapes collide.
fn touches(a: &Node, b: &Node) -> bool {
    let common = a.layers.iter().any(|l| b.layers.contains(l));
    common && a.shapes.iter().any(|one| b.shapes.iter().any(|other| collide(one, other)))
}

impl DirectCopper {
    /// `added` is what this run placed so far.
    pub fn of(board: &Board, net: &str, added: &Edit) -> DirectCopper {
        let (mut nodes, mut pads) = (Vec::new(), Vec::new());
        for (_, pad) in board.pads().filter(|(_, p)| p.net == net) {
            pads.push((pad.id.clone(), nodes.len()));
            nodes.push(Node { layers: pad.layers.clone(), shapes: pad_shapes(pad), via: None });
        }
        for t in board.tracks().filter(|t| t.net == net) {
            nodes.push(Node { layers: vec![t.layer.clone()], shapes: t.copper(), via: None });
        }
        for t in added.tracks.iter().filter(|t| t.net == net) {
            let shape = Copper::Segment { a: t.start, b: t.end, width: t.width };
            nodes.push(Node { layers: vec![t.layer.clone()], shapes: vec![shape], via: None });
        }
        let copper = board.copper_layers.clone();
        for v in board.vias().filter(|v| v.net == net) {
            nodes.push(Node { layers: copper.clone(), shapes: vec![v.copper()], via: Some(v.at) });
        }
        for v in added.vias.iter().filter(|v| v.net == net) {
            let shape = Copper::Circle { center: v.at, radius: v.size / 2 };
            nodes.push(Node { layers: copper.clone(), shapes: vec![shape], via: Some(v.at) });
        }
        DirectCopper { nodes, pads }
    }
}

impl Links for DirectCopper {
    fn vias_of(&mut self, pad: &Pad) -> Result<Vec<Pt>, String> {
        let Some(start) = self.pads.iter().find(|(id, _)| *id == pad.id).map(|(_, n)| *n) else { return Ok(Vec::new()) };
        let mut seen = vec![false; self.nodes.len()];
        seen[start] = true;
        let mut stack = vec![start];
        while let Some(at) = stack.pop() {
            for next in 0..self.nodes.len() {
                if !seen[next] && touches(&self.nodes[at], &self.nodes[next]) {
                    seen[next] = true;
                    stack.push(next);
                }
            }
        }
        Ok(self.nodes.iter().zip(&seen).filter(|(_, s)| **s).filter_map(|(n, _)| n.via).collect())
    }
}
