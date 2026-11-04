//! Arbitrary precision decimal geometry; no tolerances or binary-float comparisons.
use crate::Result;
use bigdecimal::{BigDecimal, Zero};
use serde_json::Value;
use std::str::FromStr;
pub type D = BigDecimal;
pub type Point = [D; 2];

pub fn decimal(text: &str) -> Result<D> {
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    if unsigned.is_empty()
        || unsigned.matches('.').count() > 1
        || !unsigned.bytes().all(|c| c.is_ascii_digit() || c == b'.')
        || !unsigned.bytes().any(|c| c.is_ascii_digit())
    {
        return Err(format!("unsupported or nonfinite decimal geometry: {text}"));
    }
    D::from_str(text).map_err(|e| e.to_string())
}
pub fn value(v: &Value) -> Result<D> {
    match v {
        Value::String(s) => decimal(s),
        Value::Number(n) => decimal(&n.to_string()),
        _ => Err("expected finite decimal geometry".into()),
    }
}
pub fn number(v: &Value) -> Result<D> {
    let n = v
        .as_number()
        .ok_or("expected authored finite nonnegative number in millimetres")?;
    let d = D::from_str(&n.to_string()).map_err(|e| e.to_string())?;
    if d < D::zero() {
        return Err("expected authored finite nonnegative number in millimetres".into());
    }
    Ok(d)
}
pub fn pair(v: &Value) -> Result<Point> {
    let a = v
        .as_array()
        .filter(|a| a.len() == 2)
        .ok_or("expected two geometry coordinates")?;
    Ok([value(&a[0])?, value(&a[1])?])
}
pub fn angle(v: &Value) -> Result<i32> {
    angle_d(value(v)?)
}
pub fn angle_d(d: D) -> Result<i32> {
    let d = (d % D::from(360) + D::from(360)) % D::from(360);
    [0, 90, 180, 270]
        .into_iter()
        .find(|a| d == D::from(*a))
        .ok_or("only exact quarter-turn placement is supported".into())
}
pub fn rotate([x, y]: Point, angle: i32) -> Point {
    match angle.rem_euclid(360) {
        0 => [x, y],
        90 => [-y, x],
        180 => [-x, -y],
        270 => [y, -x],
        _ => unreachable!(),
    }
}
pub fn plain(d: &D) -> String {
    d.to_plain_string()
}
pub fn normalized(d: &D) -> String {
    d.normalized().to_plain_string()
}
pub fn strings(p: &Point) -> Vec<String> {
    p.iter().map(plain).collect()
}
pub fn squared(a: &Point, b: &Point) -> D {
    a.iter()
        .zip(b)
        .map(|(x, y)| {
            let d = x - y;
            &d * &d
        })
        .sum()
}
pub fn half(d: &D) -> D {
    d / D::from(2)
}
pub fn zero() -> D {
    D::zero()
}
