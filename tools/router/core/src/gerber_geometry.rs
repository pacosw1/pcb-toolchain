//! Integer polygon operations for Gerber checks. Coordinates on the wire are nanometres.
//! Rings are explicit: each polygon has one exterior and zero or more holes.
use clipper2_rs::{area, area_paths, difference, inflate_paths, intersect, union_self, EndType, FillRule, JoinType, Path64, Paths64, Point64};
use serde::{Deserialize, Serialize};
use std::io::{self, Read};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Polygon { pub outer: Vec<[i64; 2]>, #[serde(default)] pub holes: Vec<Vec<[i64; 2]>> }
#[derive(Deserialize)]
pub struct Request { pub operation: String, pub a: Vec<Polygon>, #[serde(default)] pub b: Vec<Polygon>, #[serde(default)] pub offset_nm: i64 }
#[derive(Serialize)]
pub struct Response { pub rings: Vec<Vec<[i64; 2]>>, pub signed_area_nm2: f64 }

fn paths(polys: &[Polygon]) -> Result<Paths64, String> {
    let mut out = Vec::new();
    for poly in polys {
        for (index, ring) in std::iter::once(&poly.outer).chain(poly.holes.iter()).enumerate() {
            if ring.len() < 3 { return Err("polygon ring has fewer than three points".into()); }
            let mut p: Path64 = ring.iter().map(|v| Point64 { x: v[0], y: v[1] }).collect();
            let ar = area(&p);
            if !ar.is_finite() || ar == 0.0 { return Err("polygon ring has zero area".into()); }
            if (ar > 0.0) != (index == 0) { p.reverse(); }
            out.push(p);
        }
    }
    Ok(out)
}

pub fn execute(req: Request) -> Result<Response, String> {
    let a = paths(&req.a)?;
    let a = union_self(&a, FillRule::NonZero).map_err(|e| format!("polygon union: {e:?}"))?;
    let result = match req.operation.as_str() {
        "union" => {
            let mut all = a; all.extend(paths(&req.b)?);
            union_self(&all, FillRule::NonZero).map_err(|e| format!("polygon union: {e:?}"))?
        },
        "intersection" | "difference" => {
            let b = union_self(&paths(&req.b)?, FillRule::NonZero).map_err(|e| format!("polygon union: {e:?}"))?;
            if req.operation == "intersection" { intersect(&a, &b, FillRule::NonZero) } else { difference(&a, &b, FillRule::NonZero) }
                .map_err(|e| format!("polygon boolean: {e:?}"))?
        },
        "offset" => {
            // 16 segments per quadrant, matching the previous Shapely buffer setting.
            let tolerance = (req.offset_nm as f64).abs() * (1.0 - (std::f64::consts::PI / 64.0).cos());
            inflate_paths(&a, req.offset_nm as f64, JoinType::Round, EndType::Polygon, 2.0, tolerance)
                .map_err(|e| format!("polygon offset: {e:?}"))?
        },
        _ => return Err("unknown polygon operation".into()),
    };
    let signed_area_nm2 = area_paths(&result);
    Ok(Response { rings: result.iter().map(|p| p.iter().map(|v| [v.x,v.y]).collect()).collect(), signed_area_nm2 })
}

pub fn cli() -> i32 {
    let mut input = String::new();
    let result = io::stdin().read_to_string(&mut input).map_err(|e| e.to_string())
        .and_then(|_| serde_json::from_str::<Request>(&input).map_err(|e| e.to_string()))
        .and_then(execute).and_then(|r| serde_json::to_string(&r).map_err(|e| e.to_string()));
    match result { Ok(json) => { println!("{json}"); 0 }, Err(e) => { eprintln!("FAIL polygon geometry: {e}"); 1 } }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn square(x:i64,y:i64,s:i64)->Polygon { Polygon {outer:vec![[x,y],[x+s,y],[x+s,y+s],[x,y+s]], holes:vec![]} }
    fn run(op:&str,a:Vec<Polygon>,b:Vec<Polygon>,d:i64)->Response {execute(Request {operation:op.into(),a,b,offset_nm:d}).unwrap()}
    #[test] fn boolean_area_and_holes() {
        assert_eq!(run("union",vec![square(0,0,10)],vec![square(5,0,10)],0).signed_area_nm2,150.0);
        assert_eq!(run("intersection",vec![square(0,0,10)],vec![square(5,5,10)],0).signed_area_nm2,25.0);
        assert_eq!(run("difference",vec![square(0,0,10)],vec![square(2,2,4)],0).signed_area_nm2,84.0);
        let p=Polygon { outer:square(0,0,10).outer,holes:vec![square(2,2,4).outer] };
        assert_eq!(run("union",vec![p],vec![],0).signed_area_nm2,84.0);
    }
    #[test] fn offset_rounds_and_invalid_input_fails() {
        let out=run("offset",vec![square(0,0,1_000_000)],vec![],100_000);
        assert!(out.signed_area_nm2 > 1.4e12 && out.signed_area_nm2 < 1.44e12);
        assert!(execute(Request {operation:"union".into(),a:vec![Polygon{outer:vec![[0,0],[1,1]],holes:vec![]}],b:vec![],offset_nm:0}).is_err());
    }
}
