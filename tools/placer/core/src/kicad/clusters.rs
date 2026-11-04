//! Copper clusters: tracks and vias of one net joined by shared end points. The reader asks which copper stays whatever the
//! movable units do; the writer rips whole clusters.

use super::doc::{Copper, Pad, Pt, mm};
use super::hit::pad_hit;
use crate::geom::Rect;
use std::collections::{BTreeSet, HashMap};

pub struct Clusters<'b> {
    pub items: Vec<&'b Copper>,
    parent: Vec<usize>,
}

impl<'b> Clusters<'b> {
    pub fn new(items: Vec<&'b Copper>) -> Self {
        let mut clusters = Self { parent: (0..items.len()).collect(), items };
        let mut at: HashMap<(&str, Pt), usize> = HashMap::new();
        for k in 0..clusters.items.len() {
            let item = clusters.items[k];
            for end in item.ends() {
                match at.get(&(item.net(), end)) {
                    Some(&other) => clusters.join(k, other),
                    None => {
                        at.insert((item.net(), end), k);
                    }
                }
            }
        }
        clusters
    }

    fn join(&mut self, a: usize, b: usize) {
        let (a, b) = (self.find(a), self.find(b));
        self.parent[a] = b;
    }

    pub fn find(&self, mut k: usize) -> usize {
        while self.parent[k] != k {
            k = self.parent[k];
        }
        k
    }

    /// Clusters with an end point on a pad in `pads`, by net.
    pub fn on_pads(&self, pads: &HashMap<&str, Vec<&Pad>>) -> BTreeSet<usize> {
        let mut hit = BTreeSet::new();
        for (k, item) in self.items.iter().enumerate() {
            let Some(rows) = pads.get(item.net()) else { continue };
            if item.ends().iter().any(|e| rows.iter().any(|pad| pad_hit(pad, *e))) {
                hit.insert(self.find(k));
            }
        }
        hit
    }

    /// Clusters of vias only (stitching vias, no track), all inside one of `rects`, or anywhere with no rects given.
    pub fn lone_vias(&self, rects: Option<&[Rect]>) -> BTreeSet<usize> {
        let mut tracked = BTreeSet::new();
        let mut inside: HashMap<usize, bool> = HashMap::new();
        for (k, item) in self.items.iter().enumerate() {
            let cluster = self.find(k);
            let Copper::Via(via) = item else {
                tracked.insert(cluster);
                continue;
            };
            let (x, y) = (mm(via.at.x), mm(via.at.y));
            let ok = rects.is_none_or(|rs| rs.iter().any(|r| contains(*r, x, y)));
            let entry = inside.entry(cluster).or_insert(true);
            *entry = *entry && ok;
        }
        inside.into_iter().filter(|(c, ok)| *ok && !tracked.contains(c)).map(|(c, _)| c).collect()
    }
}

/// True on the edge too.
pub fn contains(r: Rect, x: f64, y: f64) -> bool {
    r.x0 <= x && x <= r.x1 && r.y0 <= y && y <= r.y1
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kicad::doc::{Track, Via};

    fn track(net: &str, a: (i64, i64), b: (i64, i64)) -> Copper {
        Copper::Track(Track { id: String::new(), start: Pt { x: a.0, y: a.1 }, end: Pt { x: b.0, y: b.1 }, mid: None, width: 1, layer: String::new(), net: net.to_string(), locked: false })
    }

    fn via(net: &str, at: (i64, i64)) -> Copper {
        Copper::Via(Via { id: String::new(), at: Pt { x: at.0, y: at.1 }, size: 1, net: net.to_string(), locked: false, layers: Vec::new() })
    }

    #[test]
    fn items_of_one_net_with_a_shared_end_are_one_cluster() {
        let items = [track("A", (0, 0), (1, 0)), track("A", (1, 0), (2, 0)), track("B", (1, 0), (1, 1))];
        let c = Clusters::new(items.iter().collect());
        assert_eq!(c.find(0), c.find(1));
        assert_ne!(c.find(0), c.find(2));
    }

    #[test]
    fn a_via_on_a_track_is_not_lone() {
        let items = [track("A", (0, 0), (1, 0)), via("A", (1, 0)), via("A", (5_000_000, 5_000_000))];
        let c = Clusters::new(items.iter().collect());
        assert_eq!(c.lone_vias(None), BTreeSet::from([c.find(2)]));
        assert!(c.lone_vias(Some(&[Rect::new(0.0, 0.0, 1.0, 1.0)])).is_empty());
    }
}
