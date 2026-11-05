//! The current place of every unit, with the world boxes derived from it.

use crate::geom::{Rect, TaggedRect, Turn};
use crate::model::Model;
use crate::problem::{Place, Pose};

pub struct Layout {
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    pub r: Vec<Turn>,
    /// World rects per unit.
    world: Vec<Vec<Rect>>,
    /// Pair search box per unit: the rects grown by the largest gap of the unit.
    pub reach: Vec<Rect>,
    /// Box of the copper pads per unit; an inverted infinite box (it meets nothing) for a unit with none.
    pub copper_box: Vec<Rect>,
}

const NOTHING: Rect = Rect::new(f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);

impl Layout {
    pub fn new(model: &Model, pose: &[Place]) -> Self {
        let n = model.units.len();
        let mut layout = Self {
            x: vec![0.0; n],
            y: vec![0.0; n],
            r: vec![0; n],
            world: vec![Vec::new(); n],
            reach: vec![NOTHING; n],
            copper_box: vec![NOTHING; n],
        };
        for (i, place) in pose.iter().enumerate() {
            layout.set(model, i, *place);
        }
        layout
    }

    pub fn set(&mut self, model: &Model, i: usize, (x, y, r): Place) {
        let shape = &model.units[i];
        let r = r % 4;
        (self.x[i], self.y[i], self.r[i]) = (x, y, r);
        self.world[i].clear();
        self.world[i].extend(shape.rects[r as usize].iter().map(|q| q.shifted(x, y)));
        self.reach[i] = shape.bounds[r as usize].shifted(x, y).grown(shape.grow);
        self.copper_box[i] = Rect::bounding(shape.copper[r as usize].iter().map(|q| q.rect))
            .map_or(NOTHING, |b| b.shifted(x, y));
    }

    pub fn place(&self, i: usize) -> Place {
        (self.x[i], self.y[i], self.r[i])
    }

    pub fn pose(&self) -> Pose {
        (0..self.x.len()).map(|i| self.place(i)).collect()
    }

    pub fn world(&self, i: usize) -> &[Rect] {
        &self.world[i]
    }

    /// World copper pads of unit i with their net codes.
    pub fn copper(&self, model: &Model, i: usize) -> Vec<TaggedRect> {
        model.units[i].copper[self.r[i] as usize]
            .iter()
            .map(|q| TaggedRect { rect: q.rect.shifted(self.x[i], self.y[i]), value: q.value })
            .collect()
    }

    /// Units whose copper box meets the box grown by g.
    pub fn copper_near(&self, b: Rect, g: f64) -> impl Iterator<Item = usize> + '_ {
        let b = b.grown(g);
        (0..self.x.len()).filter(move |&j| self.copper_box[j].meets(b))
    }
}
