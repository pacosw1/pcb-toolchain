//! A GND via next to each signal via that has none within r (kicad-happy RP-001), by a full grid search (2026-10-16). Each grid cell
//! within r where a GND via is legal on F.Cu and B.Cu is a candidate; the one nearest the via is taken. `pcbtool stitch` searches fixed
//! rings only.
use super::astar::exact_hypot;
use super::finish::{route_grids, routing_grid};
use super::item::{Item, Point};
use crate::kicad::edit::NewVia;
use crate::kicad::geom::{Pt, from_mm, to_mm};
use crate::kicad::session::Session;
use std::collections::BTreeSet;

const GROUND: &str = "GND";
const PLANE_NETS: [&str; 2] = [GROUND, "VDD_3V3"];
const LAYERS: [&str; 2] = ["F.Cu", "B.Cu"];
const TRACK_WIDTH_MM: f64 = 0.15;
/// The ground via written, and its clearance as an obstacle to the next one.
const VIA_MM: f64 = 0.6;
const DRILL_MM: f64 = 0.3;
const VIA_CLEARANCE_MM: f64 = 0.2;
/// Room around the search circle, so a site at its rim is in the window.
const WINDOW_MARGIN_MM: f64 = 0.5;

#[derive(Debug, Clone, PartialEq)]
pub struct Options {
    pub nets: BTreeSet<String>,
    pub r: f64,
    pub grid: f64,
    pub dry_run: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options { nets: BTreeSet::new(), r: 1.0, grid: 0.025, dry_run: false }
    }
}

fn near(p: Point, sites: &[Point], r: f64) -> bool {
    sites.iter().any(|s| exact_hypot(p.0 - s.0, p.1 - s.1) <= r)
}

/// The nearest legal site within r of `at`; the first in row order on a tie.
fn nearest(bd: &mut super::GridBoard, at: Point, r: f64) -> Option<Point> {
    let (x, y) = at;
    let reach = r + WINDOW_MARGIN_MM;
    let window = bd.window(x - reach, y - reach, x + reach, y + reach);
    let via_ok = route_grids(bd, GROUND, window, 0.0).via_ok;
    let mut best: Option<(f64, Point)> = None;
    for j in 0..via_ok.ny() {
        for i in 0..via_ok.nx() {
            let centre = bd.centre(&window, j, i);
            let distance = (centre.0 - x).hypot(centre.1 - y);
            if via_ok.at(j, i) && distance <= r && best.is_none_or(|(d, _)| distance < d) {
                best = Some((distance, centre));
            }
        }
    }
    best.map(|(_, site)| site)
}

/// The summary line. The board is saved when a via was added and this is no dry run.
pub fn run(session: &mut Session, o: &Options) -> Result<String, String> {
    let at = |p: Pt| (to_mm(p.x), to_mm(p.y));
    let ground: Vec<Point> = session.board.vias().filter(|v| v.net == GROUND).map(|v| at(v.at)).collect();
    let signal: Vec<(String, Point)> = session.board.vias()
        .filter(|v| !PLANE_NETS.contains(&v.net.as_str()) && (o.nets.is_empty() || o.nets.contains(&v.net)))
        .map(|v| (v.net.clone(), at(v.at))).collect();
    let layers: Vec<String> = LAYERS.map(str::to_string).to_vec();
    let mut bd = routing_grid(&session.board, &session.rules, &layers, o.grid, Some(TRACK_WIDTH_MM), &[])?;
    let (mut added, mut missed): (Vec<Point>, Vec<String>) = (Vec::new(), Vec::new());
    for (net, via) in signal.iter().filter(|(_, via)| !near(*via, &ground, o.r)) {
        if near(*via, &added, o.r) {
            continue;
        }
        match nearest(&mut bd, *via, o.r) {
            Some(site) => {
                added.push(site);
                let all = bd.all_layers();
                bd.items.push(Item::segment(GROUND, "via", all, VIA_CLEARANCE_MM, [site.0, site.1, site.0, site.1], VIA_MM / 2.0));
                bd.clear_caches();
            }
            None => missed.push(format!("{net}@({:.2},{:.2})", via.0, via.1)),
        }
    }
    if !added.is_empty() && !o.dry_run {
        for site in &added {
            session.add_via(NewVia { at: Pt::new(from_mm(site.0), from_mm(site.1)), size: from_mm(VIA_MM), drill: from_mm(DRILL_MM), net: GROUND.to_string(), locked: true });
        }
        session.save_to(&session.path.clone())?;
    }
    Ok(format!("GNDVIA added {}, no room {}: {}", added.len(), missed.len(), missed.join(" ")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_site_at_the_radius_counts_as_near() {
        assert!(near((0.0, 0.0), &[(1.0, 0.0)], 1.0));
        assert!(!near((0.0, 0.0), &[(1.5, 0.0)], 1.0));
        assert!(!near((0.0, 0.0), &[], 1.0));
    }
}
