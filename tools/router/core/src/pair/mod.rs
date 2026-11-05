//! Differential pairs by hand-free geometry (2026-10-25, NET-NODE): `iotroute pair-stubs` draws the stub tips, `iotroute pair-route`
//! routes each pair as one centreline between them and offsets it into the P and N tracks.
//!
//! Why: KiCadRoutingTools route_diff ignores the copper of the pair's own nets (it ran ETH_TXN
//! over the J201 pad of ETH_TXP and crossed the polarity crossovers, NET-NODE 2026-10-25). Both results go through DRC with parity
//! like any router result.
pub mod cli;
mod lattice;
mod line;
mod obstacles;
pub mod route;
mod search;
pub mod stubs;
#[cfg(test)]
mod tests;
mod tips;

use crate::kicad::edit::NewTrack;
use crate::kicad::geom::{Pt, from_mm};
use crate::kicad::session::Session;

/// A point in mm.
pub type Point = (f64, f64);

fn point(p: Point) -> Pt {
    Pt::new(from_mm(p.0), from_mm(p.1))
}

/// A list of points of one net, written as tracks.
fn add_polyline(session: &mut Session, points: &[Point], width: f64, net: &str, layer: &str) {
    for pair in points.windows(2) {
        session.add_track(NewTrack { start: point(pair[0]), end: point(pair[1]), width: from_mm(width), layer: layer.to_string(), net: net.to_string(), locked: false });
    }
}
