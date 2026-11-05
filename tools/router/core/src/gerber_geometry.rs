//! Integer polygon operations for Gerber checks. Coordinates on the wire are nanometres.
//! Rings are explicit: each polygon has one exterior and zero or more holes.
use clipper2_rs::{area, difference, inflate_paths, intersect, union_self, EndType, FillRule, JoinType, Path64, Paths64, Point64};
use serde::{Deserialize, Serialize};
use std::io::{self, Read};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Polygon { pub outer: Vec<[i64; 2]>, #[serde(default)] pub holes: Vec<Vec<[i64; 2]>> }
#[derive(Deserialize)]
pub struct Stroke { pub points: Vec<[i64; 2]>, pub width_nm: i64 }
#[derive(Deserialize)]
pub struct Request { pub operation: String, pub a: Vec<Polygon>, #[serde(default)] pub b: Vec<Polygon>, #[serde(default)] pub a_strokes: Vec<Stroke>, #[serde(default)] pub b_strokes: Vec<Stroke>, #[serde(default)] pub offset_nm: i64 }
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

fn shapes(polygons: &[Polygon], strokes: &[Stroke]) -> Result<Paths64, String> {
    let mut all=paths(polygons)?;
    for stroke in strokes {
        if stroke.points.len()<2 || stroke.width_nm<=0 {return Err("invalid buffered polyline".into());}
        let path:Path64=stroke.points.iter().map(|p|Point64{x:p[0],y:p[1]}).collect();
        let radius=stroke.width_nm as f64/2.0;
        let tolerance=radius*(1.0-(std::f64::consts::PI/96.0).cos());
        let expanded=inflate_paths(&vec![path],radius,JoinType::Round,EndType::Round,2.0,tolerance)
            .map_err(|e|format!("polyline buffer: {e:?}"))?;
        all.extend(expanded);
    }
    union_self(&all,FillRule::NonZero).map_err(|e|format!("polygon union: {e:?}"))
}

pub fn execute(req: Request) -> Result<Response, String> {
    let a = shapes(&req.a,&req.a_strokes)?;
    let result = match req.operation.as_str() {
        "union" => {
            let mut all = a; all.extend(shapes(&req.b,&req.b_strokes)?);
            union_self(&all, FillRule::NonZero).map_err(|e| format!("polygon union: {e:?}"))?
        },
        "intersection" | "difference" => {
            let b = shapes(&req.b,&req.b_strokes)?;
            if req.operation == "intersection" { intersect(&a, &b, FillRule::NonZero) } else { difference(&a, &b, FillRule::NonZero) }
                .map_err(|e| format!("polygon boolean: {e:?}"))?
        },
        "buffer_intersection" => {
            let b = shapes(&req.b,&req.b_strokes)?;
            let tolerance = (req.offset_nm as f64).abs() * (1.0 - (std::f64::consts::PI / 64.0).cos());
            let grown = inflate_paths(&b, req.offset_nm as f64, JoinType::Round, EndType::Polygon, 2.0, tolerance)
                .map_err(|e| format!("polygon offset: {e:?}"))?;
            intersect(&a, &grown, FillRule::NonZero).map_err(|e| format!("polygon boolean: {e:?}"))?
        },
        "offset" => {
            // 16 segments per quadrant, matching the previous Shapely buffer setting.
            let tolerance = (req.offset_nm as f64).abs() * (1.0 - (std::f64::consts::PI / 64.0).cos());
            inflate_paths(&a, req.offset_nm as f64, JoinType::Round, EndType::Polygon, 2.0, tolerance)
                .map_err(|e| format!("polygon offset: {e:?}"))?
        },
        _ => return Err("unknown polygon operation".into()),
    };
    let twice_area: i128 = result.iter().map(|ring| {
        (0..ring.len()).map(|i| { let a=ring[i]; let b=ring[(i+1)%ring.len()]; (a.x as i128)*(b.y as i128)-(b.x as i128)*(a.y as i128) }).sum::<i128>()
    }).sum();
    let signed_area_nm2 = twice_area as f64 / 2.0;
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
    fn run(op:&str,a:Vec<Polygon>,b:Vec<Polygon>,d:i64)->Response {execute(Request {operation:op.into(),a,b,a_strokes:vec![],b_strokes:vec![],offset_nm:d}).unwrap()}
    #[test] fn boolean_area_and_holes() {
        assert_eq!(run("union",vec![square(0,0,10)],vec![square(5,0,10)],0).signed_area_nm2,150.0);
        assert_eq!(run("intersection",vec![square(0,0,10)],vec![square(5,5,10)],0).signed_area_nm2,25.0);
        assert_eq!(run("difference",vec![square(0,0,10)],vec![square(2,2,4)],0).signed_area_nm2,84.0);
        let p=Polygon { outer:square(0,0,10).outer,holes:vec![square(2,2,4).outer] };
        assert_eq!(run("union",vec![p],vec![],0).signed_area_nm2,84.0);
    }
    #[test] fn intersection_preserves_one_square_micrometre_threshold() {
        let a=vec![square(100_000_000,100_000_000,1_000_000)];
        for (width,expected) in [(999,999_000.0),(1000,1_000_000.0),(1001,1_001_000.0)] {
            let b=Polygon {outer:vec![[100_000_000,100_000_000],[100_000_000+width,100_000_000],[100_000_000+width,100_001_000],[100_000_000,100_001_000]],holes:vec![]};
            assert_eq!(run("intersection",a.clone(),vec![b],0).signed_area_nm2,expected);
        }
    }
    #[test] fn round_buffer_of_open_polyline() {
        let req=Request {operation:"union".into(),a:vec![],b:vec![],a_strokes:vec![Stroke{points:vec![[0,0],[1_000_000,0]],width_nm:200_000}],b_strokes:vec![],offset_nm:0};
        let area=execute(req).unwrap().signed_area_nm2/1e12;
        assert!((area-(0.2+std::f64::consts::PI*0.01)).abs()<0.0001);
    }
    #[test] fn offset_rounds_and_invalid_input_fails() {
        let out=run("offset",vec![square(0,0,1_000_000)],vec![],100_000);
        assert!(out.signed_area_nm2 > 1.4e12 && out.signed_area_nm2 < 1.44e12);
        assert!(execute(Request {operation:"union".into(),a:vec![Polygon{outer:vec![[0,0],[1,1]],holes:vec![]}],b:vec![],a_strokes:vec![],b_strokes:vec![],offset_nm:0}).is_err());
    }
}
