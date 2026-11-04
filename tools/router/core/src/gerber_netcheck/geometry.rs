//! Gerber shapes as the shared KiCad polygon type. This module only constructs primitives; booleans stay in kicad::geom.
use iotroute::kicad::geom::{Polygon, Pt, boolean, ki_round};
use serde::Deserialize;
use std::f64::consts::{PI, TAU};

pub type Point = [f64; 2];

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Geometry {
    Polygon {
        points: Vec<Point>,
    },
    Region {
        rings: Vec<Vec<Point>>,
    },
    Circle {
        center: Point,
        radius: f64,
        #[serde(default = "resolution")]
        resolution: usize,
    },
    Stroke {
        points: Vec<Point>,
        width: f64,
        #[serde(default = "resolution")]
        resolution: usize,
    },
    Union {
        items: Vec<Geometry>,
    },
    Difference {
        a: Box<Geometry>,
        b: Box<Geometry>,
    },
    Intersection {
        a: Box<Geometry>,
        b: Box<Geometry>,
    },
    Translate {
        offset: Point,
        geometry: Box<Geometry>,
    },
}

fn resolution() -> usize {
    24
}

pub fn point([x, y]: Point) -> Pt {
    Pt::new(ki_round(x * 1e6), ki_round(y * 1e6))
}

fn signed_area(points: &[Pt]) -> i128 {
    (0..points.len())
        .map(|i| {
            let (a, b) = (points[i], points[(i + 1) % points.len()]);
            a.x as i128 * b.y as i128 - a.y as i128 * b.x as i128
        })
        .sum()
}

fn polygon(points: &[Point]) -> Vec<Polygon> {
    let mut ring: Vec<_> = points.iter().copied().map(point).collect();
    if ring.len() < 3 {
        return Vec::new();
    }
    if signed_area(&ring) < 0 {
        ring.reverse();
    }
    vec![Polygon::of_ring(ring)]
}

fn check_radius(radius: f64, resolution: usize) -> Result<(), String> {
    if radius < 0.0 || !radius.is_finite() || resolution == 0 {
        return Err("invalid Gerber radius or sampling resolution".into());
    }
    Ok(())
}

pub fn circle(center: Point, radius: f64, resolution: usize) -> Result<Vec<Polygon>, String> {
    check_radius(radius, resolution)?;
    if radius == 0.0 {
        return Ok(Vec::new());
    }
    let steps = 4 * resolution;
    Ok(polygon(
        &(0..steps)
            .map(|i| {
                let angle = TAU * i as f64 / steps as f64;
                [
                    center[0] + radius * angle.cos(),
                    center[1] + radius * angle.sin(),
                ]
            })
            .collect::<Vec<_>>(),
    ))
}

/// Round caps and joins, with the original Shapely buffer's quadrant resolution (24; hole rings use 16).
pub fn capsule(a: Point, b: Point, radius: f64, resolution: usize) -> Result<Vec<Polygon>, String> {
    check_radius(radius, resolution)?;
    if a == b {
        return circle(a, radius, resolution);
    }
    if radius == 0.0 {
        return Ok(Vec::new());
    }
    let theta = (b[1] - a[1]).atan2(b[0] - a[0]);
    let half = 2 * resolution;
    let mut points = Vec::new();
    for (center, start) in [(a, theta + PI / 2.0), (b, theta - PI / 2.0)] {
        for i in 0..=half {
            let angle = start + PI * i as f64 / half as f64;
            points.push([
                center[0] + radius * angle.cos(),
                center[1] + radius * angle.sin(),
            ]);
        }
    }
    Ok(polygon(&points))
}

pub fn render(g: &Geometry) -> Result<Vec<Polygon>, String> {
    match g {
        Geometry::Polygon { points } => boolean::simplify(&polygon(points)),
        Geometry::Circle {
            center,
            radius,
            resolution,
        } => circle(*center, *radius, *resolution),
        Geometry::Stroke {
            points,
            width,
            resolution,
        } => {
            check_radius(*width / 2.0, *resolution)?;
            if points.len() == 1 {
                return circle(points[0], *width / 2.0, *resolution);
            }
            let mut pieces = Vec::new();
            for pair in points.windows(2) {
                pieces.extend(capsule(pair[0], pair[1], *width / 2.0, *resolution)?);
            }
            boolean::union(&pieces, &[])
        }
        Geometry::Region { rings } => {
            let mut out = Vec::new();
            for ring in rings {
                let next = boolean::simplify(&polygon(ring))?;
                let a = boolean::difference(&out, &next)?;
                let b = boolean::difference(&next, &out)?;
                out = boolean::union(&a, &b)?;
            }
            Ok(out)
        }
        Geometry::Union { items } => {
            let mut pieces = Vec::new();
            for g in items {
                pieces.extend(render(g)?);
            }
            boolean::union(&pieces, &[])
        }
        Geometry::Difference { a, b } => boolean::difference(&render(a)?, &render(b)?),
        Geometry::Intersection { a, b } => boolean::intersection(&render(a)?, &render(b)?),
        Geometry::Translate { offset, geometry } => {
            let offset = point(*offset);
            Ok(render(geometry)?
                .into_iter()
                .map(|p| Polygon {
                    outline: p.outline.into_iter().map(|p| p + offset).collect(),
                    holes: p
                        .holes
                        .into_iter()
                        .map(|r| r.into_iter().map(|p| p + offset).collect())
                        .collect(),
                })
                .collect())
        }
    }
}
