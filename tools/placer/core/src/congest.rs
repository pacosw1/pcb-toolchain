//! Router congestion at the pins of a unit, for the repair rank (README "Repair rank by router congestion").
//!
//! The router writes a congestion map with each route (OUT.iotroute/congestion.json, schema
//! iot-lab.route-congestion.v0). The history is summed over the routable layers. Pins: the pad centres of the signal
//! nets, as in the wire-length term. `value` = the sum of the history at the cells of the unit's pins at a place.

use crate::geom::{Point, turn_point};
use crate::numeric::{compensated, round_to};
use crate::problem::{Place, Problem};
use crate::wirelen::pin_points;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::Path;

const SCHEMA: &str = "iot-lab.route-congestion.v0";

#[derive(Deserialize)]
struct Layer {
    hist: Vec<f64>,
}

#[derive(Deserialize)]
struct RouteFile {
    #[serde(default)]
    schema: String,
    origin: Point,
    cell: f64,
    nx: usize,
    ny: usize,
    layers: Vec<Layer>,
}

/// The history per cell, in world mm.
#[derive(Clone, Debug, PartialEq)]
pub struct HistoryMap {
    pub origin: Point,
    pub cell: f64,
    pub nx: usize,
    pub ny: usize,
    pub history: Vec<f64>,
}

impl HistoryMap {
    pub fn load(path: &Path) -> crate::Result<Self> {
        let f: RouteFile = serde_json::from_str(&std::fs::read_to_string(path)?)?;
        if f.schema != SCHEMA {
            return Err(format!("{}: not a router congestion map", path.display()).into());
        }
        let mut history = vec![0.0; f.nx * f.ny];
        for layer in &f.layers {
            history.iter_mut().zip(&layer.hist).for_each(|(h, v)| *h += v);
        }
        history.iter_mut().for_each(|h| *h = round_to(*h, 4));
        Ok(Self { origin: f.origin, cell: f.cell, nx: f.nx, ny: f.ny, history })
    }

    fn at(&self, (x, y): Point) -> f64 {
        let i = ((x - self.origin.0) / self.cell).floor();
        let j = ((y - self.origin.1) / self.cell).floor();
        if i >= 0.0 && j >= 0.0 && (i as usize) < self.nx && (j as usize) < self.ny {
            self.history[j as usize * self.nx + i as usize]
        } else {
            0.0
        }
    }
}

/// Local pin points per unit for the 4 turns.
pub struct PinHeat {
    map: HistoryMap,
    pins: BTreeMap<usize, [Vec<Point>; 4]>,
}

impl PinHeat {
    pub fn new(pr: &Problem, map: HistoryMap) -> Self {
        let planes = pr.plane_nets.as_deref().unwrap_or(&[]);
        let mut local: BTreeMap<usize, Vec<Point>> = BTreeMap::new();
        for net in pr.nets.iter().filter(|n| !n.cohesion && !planes.contains(&n.name)) {
            for (i, q) in net.pins.iter().enumerate() {
                local.entry(q.unit).or_default().extend(pin_points(net, i, q));
            }
        }
        let turned = |pts: Vec<Point>| [0, 1, 2, 3].map(|r| pts.iter().map(|&p| turn_point(p, r)).collect());
        Self { map, pins: local.into_iter().map(|(u, pts)| (u, turned(pts))).collect() }
    }

    pub fn value(&self, unit: usize, (x, y, r): Place) -> f64 {
        let Some(turns) = self.pins.get(&unit) else { return 0.0 };
        compensated(turns[r as usize % 4].iter().map(|p| self.map.at((p.0 + x, p.1 + y))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map() -> HistoryMap {
        HistoryMap { origin: (0.0, 0.0), cell: 1.0, nx: 2, ny: 2, history: vec![1.0, 2.0, 3.0, 4.0] }
    }

    #[test]
    fn cells_and_outside() {
        let m = map();
        assert_eq!(m.at((0.5, 0.5)), 1.0);
        assert_eq!(m.at((1.5, 1.5)), 4.0);
        assert_eq!(m.at((-0.1, 0.5)), 0.0);
        assert_eq!(m.at((2.5, 0.5)), 0.0);
    }

    #[test]
    fn value_sums_the_pins_of_a_unit() {
        let heat = PinHeat { map: map(), pins: BTreeMap::from([(0, [vec![(0.5, 0.5), (1.5, 0.5)], vec![], vec![], vec![]])]) };
        assert_eq!(heat.value(0, (0.0, 0.0, 0)), 3.0);
        assert_eq!(heat.value(1, (0.0, 0.0, 0)), 0.0);
    }
}
