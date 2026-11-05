use super::{Disc, Keepouts, Point, Rect, ReferenceSpec, Rings};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

type Interval = [f64; 2];
type Edge = [f64; 4];

fn union(mut intervals: Vec<Interval>) -> Vec<Interval> {
    intervals.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
    let mut out: Vec<Interval> = Vec::new();
    for [a, b] in intervals {
        if let Some(last) = out.last_mut().filter(|last| a <= last[1]) {
            last[1] = last[1].max(b);
        } else {
            out.push([a, b]);
        }
    }
    out
}

fn subtract(base: Vec<Interval>, cut: Vec<Interval>) -> Vec<Interval> {
    let cut = union(cut);
    let mut out = Vec::new();
    for [a, b] in base {
        let mut cursor = a;
        for &[c, d] in &cut {
            if d <= cursor || c >= b {
                continue;
            }
            if c > cursor {
                out.push([cursor, c]);
            }
            cursor = cursor.max(d);
            if cursor >= b {
                break;
            }
        }
        if cursor < b {
            out.push([cursor, b]);
        }
    }
    out
}

fn buckets(rings: &Rings, min: f64, grid: f64, count: usize) -> Vec<Vec<Edge>> {
    let mut rows = vec![Vec::new(); count];
    for ring in rings {
        for i in 0..ring.len() {
            let ([x0, y0], [x1, y1]) = (ring[i], ring[(i + 1) % ring.len()]);
            if y0 == y1 {
                continue;
            }
            let lo = (((y0.min(y1) - min) / grid - 0.5).floor().max(0.0) as usize).min(count);
            let hi = (((y0.max(y1) - min) / grid - 0.5).ceil() + 1.0).max(0.0) as usize;
            for row in &mut rows[lo..hi.min(count).max(lo)] {
                row.push([x0, y0, x1, y1]);
            }
        }
    }
    rows
}

fn crossings(edges: &[Edge], y: f64) -> Vec<Interval> {
    let mut xs: Vec<_> = edges
        .iter()
        .filter(|&&[_, y0, _, y1]| (y0 <= y && y < y1) || (y1 <= y && y < y0))
        .map(|&[x0, y0, x1, y1]| x0 + (y - y0) * (x1 - x0) / (y1 - y0))
        .collect();
    xs.sort_by(f64::total_cmp);
    xs.chunks_exact(2).map(|x| [x[0], x[1]]).collect()
}

/// The scan algorithm and defaults of the original rule, including conservative disc chords and row merging.
pub fn void_rects(
    outline: &Rings,
    refs: &[Rings],
    discs: &[Disc],
    grid: f64,
    min_mm: f64,
    tolerance: Option<f64>,
) -> Result<Vec<Rect>, String> {
    if !grid.is_finite() || grid <= 0.0 {
        return Err("keepout grid must be positive and finite".into());
    }
    let tol = tolerance.unwrap_or(grid / 2.0);
    if !tol.is_finite()
        || tol < 0.0
        || !min_mm.is_finite()
        || min_mm < 0.0
        || discs.iter().any(|d| d[2] < 0.0)
    {
        return Err("keepout tolerances and disc radii must be finite and nonnegative".into());
    }
    let Some(y_min) = outline
        .iter()
        .flatten()
        .map(|p| p[1])
        .min_by(f64::total_cmp)
    else {
        return Ok(Vec::new());
    };
    let y_max = outline
        .iter()
        .flatten()
        .map(|p| p[1])
        .max_by(f64::total_cmp)
        .unwrap();
    let count = ((y_max - y_min) / grid).ceil().max(1.0) as usize;
    let board = buckets(outline, y_min, grid, count);
    let refs: Vec<_> = refs
        .iter()
        .map(|r| buckets(r, y_min, grid, count))
        .collect();
    let mut disc_rows = vec![Vec::new(); count];
    for &[x, y, r] in discs {
        let lo = ((((y - r - y_min) / grid) - 0.5).floor().max(0.0) as usize).min(count);
        let hi = ((((y + r - y_min) / grid) - 0.5).ceil() + 1.0).max(0.0) as usize;
        for row in &mut disc_rows[lo..hi.min(count).max(lo)] {
            row.push([x, y, r]);
        }
    }
    let mut rects = Vec::new();
    // Key interval stays distinct from its conservative accumulated extent. Vec preserves Python insertion order.
    let mut open: Vec<(Interval, Rect)> = Vec::new();
    for row in 0..count {
        let y0 = y_min + row as f64 * grid;
        let y = y_min + (row as f64 + 0.5) * grid;
        let mut cut: Vec<_> = refs.iter().flat_map(|r| crossings(&r[row], y)).collect();
        for &[cx, cy, r] in &disc_rows[row] {
            let dy = ((y - cy).abs() - grid / 2.0).max(0.0);
            if dy < r {
                let w = (r * r - dy * dy).sqrt();
                cut.push([cx - w, cx + w]);
            }
        }
        let mut next = Vec::new();
        for [a, b] in subtract(crossings(&board[row], y), cut)
            .into_iter()
            .filter(|[a, b]| b - a >= min_mm)
        {
            let hit = open
                .iter()
                .position(|(k, _)| (k[0] - a).abs() <= tol && (k[1] - b).abs() <= tol);
            let rect = if let Some(i) = hit {
                let (_, r) = open.remove(i);
                [r[0].min(a), r[1], r[2].max(b), y0 + grid]
            } else {
                [a, y0, b, y0 + grid]
            };
            next.push(([a, b], rect));
        }
        rects.extend(open.into_iter().map(|(_, mut r)| {
            r[3] = y0;
            r
        }));
        open = next;
    }
    rects.extend(open.into_iter().map(|(_, mut r)| {
        r[3] = y_min + count as f64 * grid;
        r
    }));
    Ok(rects)
}

pub type Fills = BTreeMap<String, Vec<(String, Rings)>>;

pub fn layer_keepouts(
    spec: &ReferenceSpec,
    layers: &[String],
    outline: &Rings,
    fills: &Fills,
    discs: &BTreeMap<String, Vec<Disc>>,
    grid: f64,
    fast: bool,
) -> Result<Keepouts, String> {
    let refs = spec.ref_nets(fast);
    let mut out = BTreeMap::new();
    for layer in layers {
        let Some(adjacent) = spec.adjacent.get(layer).filter(|s| !s.is_empty()) else {
            continue;
        };
        let polygons = fills
            .get(adjacent)
            .into_iter()
            .flatten()
            .filter(|(n, _)| refs.contains(n))
            .map(|(_, r)| r.clone())
            .collect::<Vec<_>>();
        out.insert(
            layer.clone(),
            void_rects(
                outline,
                &polygons,
                discs.get(layer).map_or(&[], Vec::as_slice),
                grid,
                0.05,
                None,
            )?,
        );
    }
    Ok(out)
}

pub fn grow([x0, y0, x1, y1]: Rect, margin: f64) -> Rect {
    [x0 - margin, y0 - margin, x1 + margin, y1 + margin]
}

pub fn outside_rects([x0, y0, x1, y1]: Rect, boxes: &[Rect]) -> Vec<Rect> {
    let mut ys: Vec<_> = [y0, y1]
        .into_iter()
        .chain(boxes.iter().flat_map(|b| [b[1], b[3]]))
        .filter(|y| y0 <= *y && *y <= y1)
        .collect();
    ys.sort_by(f64::total_cmp);
    ys.dedup();
    let mut out: Vec<Rect> = Vec::new();
    for band in ys.windows(2) {
        let (ya, yb) = (band[0], band[1]);
        let cut = boxes
            .iter()
            .filter(|b| b[1] < yb && b[3] > ya)
            .map(|b| [b[0], b[2]])
            .collect();
        for [a, c] in subtract(vec![[x0, x1]], cut) {
            if let Some(last) = out
                .last_mut()
                .filter(|r| r[0] == a && r[2] == c && (r[3] - ya).abs() < 1e-9)
            {
                last[3] = yb;
            } else {
                out.push([a, ya, c, yb]);
            }
        }
    }
    out
}

/// Insert into the parsed structure boundary, even when the DSN has neither a via nor a rule. Old code inserted at -1.
pub fn add_keepouts(
    text: &str,
    rects: &Keepouts,
    kinds: &[String],
    name: &str,
) -> Result<String, String> {
    use iotroute::kicad::sexpr;
    let mut lines = Vec::new();
    let name = serde_json::to_string(name).map_err(|e| e.to_string())?;
    for (layer, rects) in rects {
        if layer
            .chars()
            .any(|c| c.is_whitespace() || "()\"".contains(c))
        {
            return Err("invalid DSN layer name".into());
        }
        for &[x0, y0, x1, y1] in rects {
            let coords = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]
                .map(|[x, y]| format!("{:.0} {:.0}", x * 1000.0, -y * 1000.0))
                .join("  ");
            for kind in kinds {
                if !["wire_keepout", "via_keepout"].contains(&kind.as_str()) {
                    return Err(format!("unsupported keepout kind {kind}"));
                }
                lines.push(format!("    ({kind} {name} (polygon {layer} 0  {coords}))"));
            }
        }
    }
    if lines.is_empty() {
        return Ok(text.to_string());
    }
    let forms = sexpr::parse(text)?;
    if forms.len() != 1 || forms[0].child("structure").is_none() {
        return Err("DSN needs one structure section".into());
    }
    let start = text.find("(structure").ok_or("DSN has no structure")?;
    let tail = &text[start..];
    let offset = tail.find("\n    (via").or_else(|| tail.find("\n    (rule"));
    let at = if let Some(offset) = offset {
        start + offset
    } else {
        structure_end(text, start)?
    };
    Ok(format!(
        "{}\n{}{}",
        &text[..at],
        lines.join("\n"),
        &text[at..]
    ))
}

fn structure_end(text: &str, start: usize) -> Result<usize, String> {
    let (mut depth, mut quoted, mut escape) = (0usize, false, false);
    for (i, c) in text[start..].char_indices() {
        if escape {
            escape = false;
            continue;
        }
        if quoted && c == '\\' {
            escape = true;
        } else if c == '"' {
            quoted = !quoted;
        } else if !quoted {
            if c == '(' {
                depth += 1;
            }
            if c == ')' {
                depth -= 1;
                if depth == 0 {
                    return Ok(start + i);
                }
            }
        }
    }
    Err("unclosed DSN structure".into())
}

fn point_segment(p: Point, a: Point, b: Point) -> f64 {
    let [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    let len2 = dx * dx + dy * dy;
    let t = if len2 == 0.0 {
        0.0
    } else {
        (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2).clamp(0.0, 1.0)
    };
    super::distance(p, [a[0] + t * dx, a[1] + t * dy])
}

pub fn segment_distance(a: Point, b: Point, c: Point, d: Point) -> f64 {
    let orient = |p: Point, q: Point, r: Point| {
        (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    };
    let (d1, d2, d3, d4) = (
        orient(a, b, c),
        orient(a, b, d),
        orient(c, d, a),
        orient(c, d, b),
    );
    if d1 * d2 < 0.0 && d3 * d4 < 0.0 {
        return 0.0;
    }
    point_segment(c, a, b)
        .min(point_segment(d, a, b))
        .min(point_segment(a, c, d))
        .min(point_segment(b, c, d))
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct Endpoint {
    pub layers: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct Unrouted {
    pub net: String,
    pub from_xy: Option<Point>,
    pub to_xy: Option<Point>,
    pub from: Option<Endpoint>,
    pub to: Option<Endpoint>,
}

pub type Copper = (String, Option<String>, Point, Point);

#[derive(Debug, Serialize, PartialEq)]
pub struct RepairSelection {
    pub nets: Vec<String>,
    pub blockers: BTreeMap<String, Vec<String>>,
    pub connections: usize,
    pub corridor_mm: f64,
}

pub fn repair_selection(
    unrouted: &[Unrouted],
    copper: &[Copper],
    corridor_mm: f64,
    exclude: &BTreeSet<String>,
    max_blockers: usize,
) -> RepairSelection {
    let mut nets: BTreeSet<_> = unrouted
        .iter()
        .filter(|u| !u.net.is_empty())
        .map(|u| u.net.clone())
        .collect();
    let mut blockers: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut connections = 0;
    for u in unrouted {
        let (Some(a), Some(b)) = (u.from_xy, u.to_xy) else {
            continue;
        };
        if u.net.is_empty() {
            continue;
        }
        connections += 1;
        let layers: BTreeSet<_> = u
            .from
            .iter()
            .chain(u.to.iter())
            .flat_map(|e| &e.layers)
            .collect();
        let mut best = BTreeMap::<String, f64>::new();
        for (net, layer, c, d) in copper {
            if net == &u.net
                || exclude.contains(net)
                || layer
                    .as_ref()
                    .is_some_and(|l| !layers.is_empty() && !layers.contains(l))
            {
                continue;
            }
            let dist = segment_distance(a, b, *c, *d);
            if dist <= corridor_mm {
                best.entry(net.clone())
                    .and_modify(|v| *v = v.min(dist))
                    .or_insert(dist);
            }
        }
        let mut near: Vec<_> = best.into_iter().collect();
        near.sort_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
        blockers
            .entry(u.net.clone())
            .or_default()
            .extend(near.into_iter().take(max_blockers).map(|(n, _)| n));
    }
    nets.extend(blockers.values().flatten().cloned());
    RepairSelection {
        nets: nets.difference(exclude).cloned().collect(),
        blockers: blockers
            .into_iter()
            .map(|(n, b)| (n, b.into_iter().collect()))
            .collect(),
        connections,
        corridor_mm,
    }
}
