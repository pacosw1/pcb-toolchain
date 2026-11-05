//! Everything about a problem that does not change during a search: built once, shared by all workers and epochs.

use crate::domain::DomainAreas;
use crate::escape::EscapeModel;
use crate::geom::{Point, Rect, TaggedRect, turn_point};
use crate::mask::Mask;
use crate::numeric::pairwise;
use crate::params::Params;
use crate::problem::{Problem, Unit};
use crate::rudy::{Grid, NetShape};
use crate::spacing::{ClassTable, RectSet, class_table};
use crate::via::{ViaSites, reach};
use crate::wirelen::WirelenModel;
use std::collections::BTreeSet;

type Turned<T> = [Vec<T>; 4];

fn turned_rects(rects: &[Rect]) -> Turned<Rect> {
    [0, 1, 2, 3].map(|r| rects.iter().map(|q| q.turned(r)).collect())
}

/// Static geometry of a unit, for the 4 turns.
pub struct UnitShape {
    pub fixed: bool,
    pub rotate: bool,
    pub set: RectSet,
    pub rects: Turned<Rect>,
    /// Box of the rects per turn.
    pub bounds: [Rect; 4],
    /// The largest gap of the unit, incl. hole and class-table gaps of its domain rects.
    pub grow: f64,
    pub area: f64,
    pub keepout_rects: BTreeSet<usize>,
    /// (rect index, class) of the domain rects.
    pub domain_rects: Vec<(usize, i64)>,
    pub pad_rects: Option<Turned<Rect>>,
    /// Copper boxes for the edge band: pad_rects, else edge_pads (a block).
    pub edge_pads: Option<Turned<Rect>>,
    /// Copper pads with their net code.
    pub copper: Turned<TaggedRect>,
    /// True for the copper rows on a via net.
    pub via_pad: Vec<bool>,
    /// Pad points, with pin demand on.
    pub pad_points: Turned<Point>,
}

impl UnitShape {
    fn new(u: &Unit, table: Option<&ClassTable>, p: &Params, via_nets: &[i64]) -> crate::Result<Self> {
        let local: Vec<Rect> = u.rects.iter().map(|r| r.rect).collect();
        let rects = turned_rects(&local);
        let box_at = |r: usize| Rect::bounding(rects[r].iter().copied()).ok_or(format!("unit {} has no rects", u.name));
        let bounds = [box_at(0)?, box_at(1)?, box_at(2)?, box_at(3)?];
        let pad_rects = u.pad_rects.as_deref().map(turned_rects);
        let edge_pads = pad_rects.clone().or_else(|| u.edge_pads.as_deref().map(turned_rects));
        let turned_copper = |r| u.cu.iter().map(|q| TaggedRect { rect: q.rect.turned(r), value: q.value }).collect();
        let pad_points: &[Point] = if p.pin_demand != 0.0 { &u.pads } else { &[] };
        let areas: Vec<f64> = local.iter().map(|r| r.width() * r.height()).collect();
        Ok(Self {
            fixed: u.fixed,
            rotate: u.rotate,
            set: RectSet::new(u),
            bounds,
            grow: largest_gap(u, table),
            area: pairwise(&areas),
            keepout_rects: u.ko.iter().copied().collect(),
            domain_rects: u.dom.iter().map(|d| (d.0, d.1)).collect(),
            pad_rects,
            edge_pads,
            copper: [0, 1, 2, 3].map(turned_copper),
            via_pad: u.cu.iter().map(|q| via_nets.contains(&(q.value as i64))).collect(),
            pad_points: [0, 1, 2, 3].map(|r| pad_points.iter().map(|&q| turn_point(q, r)).collect()),
            rects,
        })
    }
}

fn largest_gap(u: &Unit, table: Option<&ClassTable>) -> f64 {
    let table_gap = table.map_or(0.0, |t| t.iter().flatten().copied().fold(f64::NEG_INFINITY, f64::max));
    let rects = u.rects.iter().map(|r| r.value).fold(f64::NEG_INFINITY, f64::max);
    u.dom.iter().map(|d| d.2.max(table_gap)).fold(rects, f64::max)
}

pub struct Model<'p> {
    pub problem: &'p Problem,
    /// Compiled reviewed rules; admission remains disabled until source verification is implemented.
    pub(crate) reviewed: Option<crate::engineering::ReviewedGeometry>,
    pub params: Params,
    pub units: Vec<UnitShape>,
    pub class_table: Option<ClassTable>,
    pub mask: Mask,
    pub outline_box: Rect,
    pub nets: Vec<NetShape>,
    /// Sorted net indices per unit.
    pub unit_nets: Vec<Vec<usize>>,
    pub grid: Grid,
    pub kept_demand: Vec<f64>,
    pub cell_weights: Option<Vec<f64>>,
    pub threshold: f64,
    pub areas: DomainAreas,
    pub via_sites: Option<ViaSites>,
    pub via_reach: f64,
    pub escape: Option<EscapeModel>,
    pub wirelen: Option<WirelenModel>,
}

fn unit_nets(pr: &Problem) -> Vec<Vec<usize>> {
    let mut sets = vec![BTreeSet::new(); pr.units.len()];
    for (k, net) in pr.nets.iter().enumerate() {
        net.pins.iter().for_each(|q| {
            sets[q.unit].insert(k);
        });
    }
    sets.into_iter().map(|s| s.into_iter().collect()).collect()
}

impl<'p> Model<'p> {
    /// The cost parameters that shape the tables come from `params`; weights may change per epoch.
    pub fn new(pr: &'p Problem, params: &Params) -> crate::Result<Self> {
        // A caller may deserialize a Problem directly without Problem::load; never allow
        // a library search to silently skip unsupported hard-rule contracts either.
        pr.check_supported()?;
        let p = params;
        let reviewed = if pr.engineering_frozen {
            let refs = pr.units.iter().map(|u| u.refs.clone()).collect::<Vec<_>>();
            let origins = pr.units.iter().map(|u| (u.x, u.y)).collect::<Vec<_>>();
            Some(crate::engineering::ReviewedGeometry::compile(&pr.engineering, &refs, &origins)?)
        } else { None };
        let table = class_table(pr);
        let via_nets = pr.via_nets.as_deref().unwrap_or(&[]);
        let units = pr.units.iter().map(|u| UnitShape::new(u, table.as_ref(), p, via_nets));
        let outline_box = pr.board.outline_box();
        let grid = Grid::new(outline_box, p.rudy_cell);
        Ok(Self {
            problem: pr,
            reviewed,
            params: p.clone(),
            units: units.collect::<crate::Result<_>>()?,
            mask: Mask::new(&pr.board, p.mask_cell, p.gap)?,
            outline_box,
            nets: pr.nets.iter().map(|n| NetShape::new(n, p)).collect(),
            unit_nets: unit_nets(pr),
            kept_demand: grid.kept_copper_demand(pr, p),
            cell_weights: grid.cell_weights(pr),
            threshold: p.limit * p.rudy_cell.powf(2.0) * p.layers / p.pitch,
            areas: DomainAreas::new(pr),
            via_sites: (!via_nets.is_empty()).then(|| ViaSites::new(&pr.board, p.via_d / 2.0)),
            via_reach: reach(p),
            escape: p.uses_escape().then(|| EscapeModel::new(pr, p)),
            wirelen: (p.w_mst != 0.0).then(|| WirelenModel::new(pr)),
            class_table: table,
            grid,
        })
    }
}
