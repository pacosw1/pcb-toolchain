//! Board units and the plane arithmetic of KiCad's reader: whole nanometres, y down, angles in degrees, positive clockwise on
//! screen. Values round the way KiCad does, so a point lands on the same nanometre as it does in pcbnew.
use serde::Serialize;
use std::ops::{Add, Sub};

/// Nanometres, KiCad's internal unit.
pub type Iu = i64;

const IU_PER_MM: f64 = 1e6;

/// KiCad's KiROUND: to the nearest, half away from zero.
pub fn ki_round(v: f64) -> Iu {
    v.round() as Iu
}

/// Millimetre text as whole nanometres.
pub fn parse_iu(text: &str) -> Result<Iu, String> {
    Ok(ki_round(parse_f64(text)? * IU_PER_MM))
}

pub fn parse_f64(text: &str) -> Result<f64, String> {
    text.parse().map_err(|_| format!("not a number: {text}"))
}

/// Nanometres as millimetres, as pcbnew.ToMM.
pub fn to_mm(iu: Iu) -> f64 {
    iu as f64 / IU_PER_MM
}

/// Millimetres as nanometres, cut toward zero as pcbnew.FromMM.
pub fn from_mm(mm: f64) -> Iu {
    (mm * IU_PER_MM) as Iu
}

/// An angle in [0, 360), as EDA_ANGLE::Normalize.
pub fn normalize_deg(deg: f64) -> f64 {
    let d = deg % 360.0;
    if d < 0.0 { d + 360.0 } else { d }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct Pt {
    pub x: Iu,
    pub y: Iu,
}

impl Pt {
    pub fn new(x: Iu, y: Iu) -> Self {
        Pt { x, y }
    }

    /// The point turned about the origin, as KiCad's RotatePoint.
    pub fn rotated(self, deg: f64) -> Pt {
        let angle = normalize_deg(deg);
        let (x, y) = (self.x, self.y);
        match angle {
            0.0 => self,
            90.0 => Pt::new(y, -x),
            180.0 => Pt::new(-x, -y),
            270.0 => Pt::new(-y, x),
            _ => {
                let (sin, cos) = angle.to_radians().sin_cos();
                let (fx, fy) = (x as f64, y as f64);
                Pt::new(ki_round(fy * sin + fx * cos), ki_round(fy * cos - fx * sin))
            }
        }
    }
}

impl Add for Pt {
    type Output = Pt;
    fn add(self, o: Pt) -> Pt {
        Pt::new(self.x + o.x, self.y + o.y)
    }
}

impl Sub for Pt {
    type Output = Pt;
    fn sub(self, o: Pt) -> Pt {
        Pt::new(self.x - o.x, self.y - o.y)
    }
}

/// An axis-parallel box, left <= right and top <= bottom.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Rect {
    pub left: Iu,
    pub top: Iu,
    pub right: Iu,
    pub bottom: Iu,
}

impl Rect {
    pub fn around(p: Pt) -> Rect {
        Rect { left: p.x, top: p.y, right: p.x, bottom: p.y }
    }

    pub fn of_points(points: impl IntoIterator<Item = Pt>) -> Option<Rect> {
        points.into_iter().map(Rect::around).reduce(Rect::merged)
    }

    pub fn merged(self, o: Rect) -> Rect {
        Rect { left: self.left.min(o.left), top: self.top.min(o.top), right: self.right.max(o.right), bottom: self.bottom.max(o.bottom) }
    }

    pub fn inflated(self, by: Iu) -> Rect {
        Rect { left: self.left - by, top: self.top - by, right: self.right + by, bottom: self.bottom + by }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn millimetres_round_to_the_nearest_nanometre() {
        assert_eq!(parse_iu("1.27").unwrap(), 1_270_000);
        assert_eq!(parse_iu("-0.0000005").unwrap(), -1);
        assert_eq!(parse_iu("0.1234564").unwrap(), 123_456);
    }

    #[test]
    fn from_mm_cuts_toward_zero() {
        assert_eq!(from_mm(1.0000009), 1_000_000);
        assert_eq!(from_mm(-1.0000009), -1_000_000);
    }

    #[test]
    fn quarter_turns_are_exact() {
        let p = Pt::new(3, 1);
        assert_eq!(p.rotated(90.0), Pt::new(1, -3));
        assert_eq!(p.rotated(-90.0), Pt::new(-1, 3));
        assert_eq!(p.rotated(180.0), Pt::new(-3, -1));
        assert_eq!(p.rotated(450.0), Pt::new(1, -3));
    }

    #[test]
    fn other_angles_round_to_the_nanometre() {
        assert_eq!(Pt::new(1_000_000, 0).rotated(45.0), Pt::new(707_107, -707_107));
    }

    #[test]
    fn boxes_merge_and_grow() {
        let r = Rect::of_points([Pt::new(1, 5), Pt::new(3, 2)]).unwrap();
        assert_eq!(r, Rect { left: 1, top: 2, right: 3, bottom: 5 });
        assert_eq!(r.inflated(1).left, 0);
        assert_eq!(Rect::of_points([]), None);
    }
}
