//! Cheap deterministic same-layer L and Z routing, tried before any costly topology search.
//!
//! Conservative rectangular obstacles; no vias, planes, pairs or curves. A route here is feasible in this model only,
//! never a native DRC pass.

use std::collections::BTreeSet;

use serde::Serialize;

use crate::budget::Budget;
use crate::contract::{Connection, Point, Problem, Rect};

#[derive(Debug, Clone, Serialize)]
pub struct Route {
    pub connection: String,
    pub net: String,
    pub layer: String,
    pub width: f64,
    pub points: Vec<Point>,
    pub length_mm: f64,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Unresolved {
    Abstained { connection: String, net: String, reason: &'static str },
    Searched { connection: String, net: String, reason: &'static str, blockers: Vec<String>, unroutable_proven: bool },
}

/// Field order is the order of the saved record.
#[derive(Debug, Serialize)]
pub struct Outcome {
    pub schema: &'static str,
    pub input_sha256: String,
    pub qualified: bool,
    pub routes: Vec<Route>,
    pub unresolved: Vec<Unresolved>,
    pub attempts: u32,
    pub native_validation_required: bool,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unsupported: Option<Vec<String>>,
    pub elapsed_s: f64,
}

/// The budget ran out while a route was still being checked.
struct Expired;

enum Search {
    Routed(Route),
    Failed { blockers: BTreeSet<String>, expired: bool },
}

pub fn route_patterns(problem: &Problem, budget: &Budget) -> Outcome {
    let mut outcome = Outcome {
        schema: "iot-lab.pattern-route.v1",
        input_sha256: problem.identity.clone(),
        qualified: false,
        routes: Vec::new(),
        unresolved: Vec::new(),
        attempts: 0,
        native_validation_required: true,
        status: "candidate",
        unsupported: None,
        elapsed_s: 0.0,
    };
    if problem.unsupported.is_empty() {
        search_all(problem, budget, &mut outcome);
    } else {
        abstain(problem, &mut outcome);
    }
    outcome.elapsed_s = budget.elapsed_s();
    outcome
}

fn abstain(problem: &Problem, outcome: &mut Outcome) {
    outcome.status = "unsupported";
    outcome.unsupported = Some(problem.unsupported.clone());
    outcome.unresolved = problem.connections.iter().map(|c| Unresolved::Abstained {
        connection: c.name.clone(),
        net: c.net.clone(),
        reason: "unsupported_constraints",
    }).collect();
}

fn search_all(problem: &Problem, budget: &Budget, outcome: &mut Outcome) {
    for connection in routing_order(problem) {
        match search_connection(problem, connection, &outcome.routes, &mut outcome.attempts, budget) {
            Search::Routed(route) => outcome.routes.push(route),
            Search::Failed { blockers, expired } => {
                if expired {
                    outcome.status = "timeout";
                }
                outcome.unresolved.push(Unresolved::Searched {
                    connection: connection.name.clone(),
                    net: connection.net.clone(),
                    reason: if expired { "budget" } else { "patterns_exhausted" },
                    blockers: blockers.into_iter().collect(),
                    unroutable_proven: false,
                });
            }
        }
    }
}

/// Most constrained first: fewest layers, then widest. No hidden randomized restarts.
fn routing_order(problem: &Problem) -> Vec<&Connection> {
    let width = |connection: &Connection| problem.nets[&connection.net].width;
    let mut order: Vec<&Connection> = problem.connections.iter().collect();
    order.sort_by(|a, b| {
        a.layers.len().cmp(&b.layers.len()).then(width(b).total_cmp(&width(a))).then(a.name.cmp(&b.name))
    });
    order
}

fn search_connection(problem: &Problem, connection: &Connection, kept: &[Route], attempts: &mut u32, budget: &Budget) -> Search {
    let mut tried = BTreeSet::new();
    for layer in &connection.layers {
        for points in candidate_paths(connection) {
            if budget.expired() {
                return Search::Failed { blockers: tried, expired: true };
            }
            let route = Route {
                connection: connection.name.clone(),
                net: connection.net.clone(),
                layer: layer.clone(),
                width: problem.nets[&connection.net].width,
                length_mm: path_length(&points),
                points,
            };
            *attempts += 1;
            match blockers(problem, &route, kept, budget) {
                Err(Expired) => return Search::Failed { blockers: tried, expired: true },
                Ok(found) if found.is_empty() => return Search::Routed(route),
                Ok(found) => tried.extend(found),
            }
        }
    }
    Search::Failed { blockers: tried, expired: false }
}

/// The distinct L and Z paths between the two ends, in the order they are tried.
fn candidate_paths(connection: &Connection) -> Vec<Vec<Point>> {
    let ([ax, ay], [bx, by]) = (connection.start, connection.end);
    let (mx, my) = ((ax + bx) / 2.0, (ay + by) / 2.0);
    let shapes = [
        vec![[ax, ay], [ax, by], [bx, by]],
        vec![[ax, ay], [bx, ay], [bx, by]],
        vec![[ax, ay], [mx, ay], [mx, by], [bx, by]],
        vec![[ax, ay], [ax, my], [bx, my], [bx, by]],
    ];
    let mut paths: Vec<Vec<Point>> = Vec::new();
    for mut path in shapes {
        path.dedup();
        if path.len() == 1 {
            path.push(path[0]);
        }
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    paths
}

/// What stops `route`, given the routes already kept. Names are sorted.
fn blockers(problem: &Problem, route: &Route, kept: &[Route], budget: &Budget) -> Result<BTreeSet<String>, Expired> {
    let live = || if budget.expired() { Err(Expired) } else { Ok(()) };
    live()?;
    let mut found = BTreeSet::new();
    if crosses_board_edge(problem, route) {
        found.insert("board_edge".to_string());
    }
    for segment in segments(&route.points) {
        for obstacle in &problem.obstacles {
            live()?;
            if obstacle_blocks(problem, route, &segment, obstacle) {
                found.insert(obstacle.name.clone());
            }
        }
        for other in kept {
            live()?;
            if route_blocks(problem, route, &segment, other) {
                found.insert(format!("route:{}", other.connection));
            }
        }
    }
    live()?;
    Ok(found)
}

fn crosses_board_edge(problem: &Problem, route: &Route) -> bool {
    let margin = problem.edge_clearance + route.width / 2.0;
    let Rect { x0, y0, x1, y1 } = problem.bounds;
    route.points.iter().any(|&[x, y]| !(x0 + margin <= x && x <= x1 - margin && y0 + margin <= y && y <= y1 - margin))
}

fn obstacle_blocks(problem: &Problem, route: &Route, segment: &Rect, obstacle: &crate::contract::Obstacle) -> bool {
    if !obstacle.layers.contains(&route.layer) || obstacle.net == route.net {
        return false;
    }
    let gap = problem.gap(&route.net, &obstacle.net, obstacle.clearance);
    distance(segment, &obstacle.bounds) < route.width / 2.0 + gap
}

fn route_blocks(problem: &Problem, route: &Route, segment: &Rect, other: &Route) -> bool {
    if other.layer != route.layer || other.net == route.net {
        return false;
    }
    let gap = problem.gap(&route.net, &other.net, 0.0) + (route.width + other.width) / 2.0;
    segments(&other.points).any(|old| distance(segment, &old) < gap)
}

fn segments(points: &[Point]) -> impl Iterator<Item = Rect> + '_ {
    points.windows(2).map(|pair| segment_box(pair[0], pair[1]))
}

fn segment_box(a: Point, b: Point) -> Rect {
    Rect { x0: a[0].min(b[0]), y0: a[1].min(b[1]), x1: a[0].max(b[0]), y1: a[1].max(b[1]) }
}

/// Exact distance between two axis-aligned rectangles or segments.
fn distance(a: &Rect, b: &Rect) -> f64 {
    axis_gap(a.x0, a.x1, b.x0, b.x1).hypot(axis_gap(a.y0, a.y1, b.y0, b.y1))
}

fn axis_gap(a0: f64, a1: f64, b0: f64, b1: f64) -> f64 {
    (b0 - a1).max(a0 - b1).max(0.0)
}

fn path_length(points: &[Point]) -> f64 {
    compensated_sum(points.windows(2).map(|pair| (pair[0][0] - pair[1][0]).hypot(pair[0][1] - pair[1][1])))
}

/// Neumaier summation, the algorithm of Python's `sum` on floats since 3.12. A plain sum differs in the last digit.
fn compensated_sum(values: impl Iterator<Item = f64>) -> f64 {
    let (mut total, mut correction) = (0.0_f64, 0.0_f64);
    for value in values {
        let next = total + value;
        correction += if total.abs() >= value.abs() { (total - next) + value } else { (value - next) + total };
        total = next;
    }
    total + correction
}

#[cfg(test)]
mod tests;
