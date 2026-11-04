//! Same-layer centerline crossings between routes. Full clearance DRC stays native.

use std::collections::BTreeSet;

use serde_json::{Value, json};

use super::{coordinate, text, traces};
use crate::error::{Result, invalid};

#[derive(Clone, Copy)]
struct Corner<'a> {
    x: f64,
    y: f64,
    source: &'a Value,
}

impl Corner<'_> {
    /// The coordinates as they were written, so 1 and 1.0 survive into the report.
    fn written(&self) -> Value {
        json!([self.source["x"], self.source["y"]])
    }

    fn same_place(&self, other: &Corner) -> bool {
        self.x == other.x && self.y == other.y
    }
}

struct Segment<'a> {
    trace: &'a str,
    net: &'a str,
    layer: &'a str,
    start: Corner<'a>,
    end: Corner<'a>,
}

/// Crossings between different nets. Protected copper comes from the input, whatever the solver returned for it, and
/// two pieces of protected copper never count against each other.
pub fn route_crossings(srj: &Value, output: &[Value]) -> Result<Vec<Value>> {
    let originals: BTreeSet<&str> = traces(srj).iter().map(|trace| text(trace, "pcb_trace_id")).collect::<Result<_>>()?;
    let mut segments = Vec::new();
    for trace in traces(srj) {
        collect_segments(trace, &mut segments)?;
    }
    for trace in output {
        if !originals.contains(text(trace, "pcb_trace_id")?) {
            collect_segments(trace, &mut segments)?;
        }
    }
    let mut conflicts = Vec::new();
    for (index, a) in segments.iter().enumerate() {
        for b in &segments[index + 1..] {
            let comparable = a.layer == b.layer && a.net != b.net && !(originals.contains(a.trace) && originals.contains(b.trace));
            if comparable && crosses(a, b) {
                conflicts.push(conflict(a, b));
            }
        }
    }
    Ok(conflicts)
}

fn collect_segments<'a>(trace: &'a Value, segments: &mut Vec<Segment<'a>>) -> Result<()> {
    let (id, net) = (text(trace, "pcb_trace_id")?, text(trace, "connection_name")?);
    let mut last: Option<(Corner<'a>, &'a str)> = None;
    for point in trace["route"].as_array().map_or(&[][..], Vec::as_slice) {
        let corner = Corner { x: coordinate(point, "x")?, y: coordinate(point, "y")?, source: point };
        match text(point, "route_type")? {
            "wire" => {
                let layer = text(point, "layer")?;
                if let Some((start, on)) = last {
                    if on == layer && !start.same_place(&corner) {
                        segments.push(Segment { trace: id, net, layer, start, end: corner });
                    }
                }
                last = Some((corner, layer));
            }
            "via" => last = Some((corner, text(point, "to_layer")?)),
            _ => return invalid("crossing screen cannot represent this route element"),
        }
    }
    Ok(())
}

fn orient(a: &Corner, b: &Corner, c: &Corner) -> f64 {
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

/// True when the two segments share a point, touching included.
fn crosses(p: &Segment, q: &Segment) -> bool {
    let (a, b, c, d) = (&p.start, &p.end, &q.start, &q.end);
    let apart = a.x.max(b.x) < c.x.min(d.x) || c.x.max(d.x) < a.x.min(b.x)
        || a.y.max(b.y) < c.y.min(d.y) || c.y.max(d.y) < a.y.min(b.y);
    !apart && orient(a, b, c) * orient(a, b, d) <= 0.0 && orient(c, d, a) * orient(c, d, b) <= 0.0
}

fn conflict(a: &Segment, b: &Segment) -> Value {
    json!({"type": "tracks_crossing", "layer": a.layer, "trace_ids": [a.trace, b.trace], "nets": [a.net, b.net],
           "segments": [[a.start.written(), a.end.written()], [b.start.written(), b.end.written()]]})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trace(id: &str, net: &str, points: &[(f64, f64)], layer: &str) -> Value {
        let route: Vec<Value> = points.iter()
            .map(|(x, y)| json!({"route_type": "wire", "x": x, "y": y, "layer": layer, "width": 0.2})).collect();
        json!({"pcb_trace_id": id, "connection_name": net, "route": route})
    }

    #[test]
    fn original_copper_is_checked_even_when_the_solver_moves_it() {
        let original = trace("old", "SCL", &[(0.0, 0.0), (4.0, 4.0)], "bottom");
        let srj = json!({"traces": [original]});
        let moved = trace("old", "SCL", &[(10.0, 10.0), (14.0, 14.0)], "bottom");
        let proposed = trace("new", "V_GAS", &[(0.0, 4.0), (4.0, 0.0)], "bottom");
        let conflicts = route_crossings(&srj, &[moved, proposed]).unwrap();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0]["nets"], json!(["SCL", "V_GAS"]));
        let clear = trace("new", "V_GAS", &[(0.0, 4.0), (1.0, 4.0)], "bottom");
        assert!(route_crossings(&srj, &[clear]).unwrap().is_empty());
        let other_layer = trace("new", "V_GAS", &[(0.0, 4.0), (4.0, 0.0)], "top");
        assert!(route_crossings(&srj, &[other_layer]).unwrap().is_empty());
    }

    #[test]
    fn an_unknown_route_element_is_refused() {
        let odd = json!({"pcb_trace_id": "x", "connection_name": "A",
                         "route": [{"route_type": "through_obstacle", "x": 1, "y": 1}]});
        assert!(route_crossings(&json!({}), &[odd]).is_err());
    }
}
