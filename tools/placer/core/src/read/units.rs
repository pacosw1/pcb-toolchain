//! Drafts to units: rects, domain pads, copper rows and the flags the search reads.

use super::grouping::Draft;
use super::options::Options;
use super::out::{Box4, CuRow, Unit};
use super::parts::{fp_rect, is_test_point, locked_on_pad, pads_box, part_fixed, ref_prefix, round6, round_courtyard};
use super::project::{DomainClasses, Project};
use crate::geom::Rect;
use crate::kicad::clusters::contains;
use crate::kicad::doc::{Board, Copper, Footprint, Pad, PadKind, mm};
use std::collections::{BTreeMap, HashMap, HashSet};

/// Refs with a spacing of the IC and connector class.
const IC_PREFIX: [&str; 8] = ["U", "J", "P", "CN", "K", "SW", "Y", "X"];

pub struct Reader<'a> {
    pub board: &'a Board,
    pub by_ref: &'a HashMap<&'a str, &'a Footprint>,
    pub options: &'a Options,
    pub project: &'a Project,
    pub outline: &'a [(f64, f64)],
    pub locked: &'a [&'a Copper],
    pub net_codes: &'a HashMap<String, i64>,
}

/// What the rects of one part add to the unit under way.
#[derive(Default)]
struct Rects {
    rects: Vec<(Rect, f64)>,
    pads: Vec<(Rect, f64)>,
    /// (index in pads, class, gap to the class, net clearance).
    dom: Vec<(usize, i64, f64, f64)>,
    mech: Vec<usize>,
    rho: Vec<(usize, f64)>,
}

fn rounded(r: Rect, x: f64, y: f64) -> Box4 {
    [round6(r.x0 - x), round6(r.y0 - y), round6(r.x1 - x), round6(r.y1 - y)]
}

fn pad_kind(p: &Pad) -> &'static str {
    match p.kind {
        PadKind::ThroughHole => "pth",
        PadKind::NpThroughHole => "npth",
        PadKind::Smd | PadKind::EdgeConnector => "smd",
    }
}

impl Reader<'_> {
    fn spacing(&self, reference: &str) -> f64 {
        if is_test_point(reference) {
            0.0
        } else if IC_PREFIX.contains(&ref_prefix(reference)) {
            self.options.spacing.1
        } else {
            self.options.spacing.0
        }
    }

    fn class_of(&self, p: &Pad) -> &str {
        self.board.net_class(&p.net)
    }

    /// Gap to other nets (None: the net clearance) and gap to another class, when the pad is a domain pad.
    fn domain_gaps(&self, p: &Pad) -> Option<(Option<f64>, f64)> {
        let class = self.class_of(p);
        let domain = self.project.domain_of(class).map(|d| (Some(d.1), d.2));
        domain.or_else(|| self.project.in_pair(class).then_some((None, 0.0)))
    }

    /// A part with no net pad (a mounting hole) has only its own class to a domain pad; a .kicad_dru hole rule adds its gap.
    fn hole_rects(&self, fp: &Footprint, out: &mut Rects) {
        out.mech.push(out.rects.len() - 1);
        let gap = self.project.rules.holes.iter().filter(|h| h.1.contains(&fp.reference)).map(|h| h.2).next_back();
        if let Some(gap) = gap {
            for p in &fp.pads {
                out.dom.push((out.pads.len(), -1, gap, 0.0));
                out.pads.push((p.bbox.mm(), 0.0));
            }
        }
    }

    /// Every net pad of a domain part is its own rect; the courtyard holds no pad.
    fn domain_rects(&self, fp: &Footprint, classes: &mut DomainClasses, out: &mut Rects) {
        out.mech.push(out.rects.len() - 1);
        for p in fp.pads.iter().filter(|p| !p.net.is_empty()) {
            let clearance = self.project.pad_clearance(self.board, fp, p);
            let gaps = self.domain_gaps(p);
            if let Some((_, class_gap)) = gaps {
                out.dom.push((out.pads.len(), classes.id(self.class_of(p)), class_gap, clearance));
            }
            out.pads.push((p.bbox.mm(), gaps.and_then(|g| g.0).unwrap_or(clearance)));
        }
    }

    /// A pad of a net class with a larger clearance (mains) gets its own spacing rect.
    fn wide_clearance_rects(&self, fp: &Footprint, spacing: f64, out: &mut Rects) {
        for p in &fp.pads {
            let clearance = if p.net.is_empty() { 0.0 } else { self.project.pad_clearance(self.board, fp, p) };
            if clearance > spacing {
                out.pads.push((p.bbox.mm(), clearance));
            }
        }
    }

    fn part_rects(&self, fp: &Footprint, classes: &mut DomainClasses, out: &mut Rects) -> Rect {
        let spacing = self.spacing(&fp.reference);
        let round = round_courtyard(fp);
        // Copper pads beyond the courtyard belong to the part rect (NET-CORE J1 USB-C: A1B12 0.8 mm out); a circle stays one.
        let rc = round.map_or_else(|| pads_box(fp, fp_rect(fp)), |(x, y, r)| Rect::new(x - r, y - r, x + r, y + r));
        out.rects.push((rc, spacing));
        if let Some((_, _, r)) = round {
            out.rho.push((out.rects.len() - 1, r));
        }
        let net_pads = fp.pads.iter().filter(|p| !p.net.is_empty()).count();
        let rules = &self.project.rules;
        if (!rules.domains.is_empty() || !rules.pairs.is_empty()) && net_pads == 0 {
            self.hole_rects(fp, out);
        } else if fp.pads.iter().any(|p| !p.net.is_empty() && self.domain_gaps(p).is_some()) {
            self.domain_rects(fp, classes, out);
        } else if spacing != 0.0 {
            self.wide_clearance_rects(fp, spacing, out);
        }
        rc
    }

    fn footprints<'f>(&'f self, draft: &'f Draft) -> impl Iterator<Item = &'f Footprint> {
        draft.refs.iter().map(|r| self.by_ref[r.as_str()])
    }

    fn pads<'f>(&'f self, draft: &'f Draft) -> impl Iterator<Item = &'f Pad> {
        self.footprints(draft).flat_map(|f| &f.pads)
    }

    fn copper_layers(&self, p: &Pad) -> Vec<String> {
        self.board.copper_layers.iter().filter(|l| p.layers.contains(l)).cloned().collect()
    }

    fn copper_rows(&self, draft: &Draft, u: &mut Unit) {
        let boxes: Vec<Box4> = self.pads(draft).map(|p| rounded(p.bbox.mm(), u.x, u.y)).collect();
        u.cu = boxes.iter().zip(self.pads(draft)).map(|(b, p)| CuRow(b[0], b[1], b[2], b[3], self.net_codes.get(&p.net).copied().unwrap_or(0))).collect();
        u.cu_pads = self.footprints(draft).flat_map(|f| f.pads.iter().map(|p| (f.reference.clone(), pad_kind(p).to_string(), p.number.clone()))).collect();
        u.pad_copper_layers = self.pads(draft).map(|p| self.copper_layers(p)).collect();
        // A block's pads are the copper for the edge band; a loose part's pads meet kept copper. A block also moves its tracks.
        if draft.boxed.is_some() {
            u.edge_pads = Some(boxes);
        } else {
            u.pad_rects = Some(boxes);
        }
    }

    fn origin(&self, draft: &Draft, rects: &[(Rect, f64)]) -> (f64, f64) {
        let around = draft.boxed.or_else(|| Rect::bounding(rects.iter().map(|r| r.0)));
        around.map_or((0.0, 0.0), Rect::centre)
    }

    fn pad_centres(&self, draft: &Draft, x: f64, y: f64) -> Vec<[f64; 2]> {
        let parts = self.footprints(draft).filter(|f| !is_test_point(&f.reference));
        parts.flat_map(|f| &f.pads).map(|p| [round6(mm(p.position.x) - x), round6(mm(p.position.y) - y)]).collect()
    }

    fn is_fixed(&self, draft: &Draft, origin: (f64, f64), rects: &[Rect]) -> bool {
        let by_part = self.footprints(draft).zip(rects).any(|(f, rc)| part_fixed(f, *rc, self.outline, self.options, &[]));
        let outside = self.options.free_box.is_some_and(|b| !contains(b, origin.0, origin.1));
        if by_part || outside {
            return true;
        }
        let rest: Vec<&Copper> = self.locked.iter().copied().filter(|t| !draft.private.contains(t.id())).collect();
        self.footprints(draft).any(|f| locked_on_pad(f, &rest))
    }

    /// The unit of a draft; `classes` numbers the domain classes across units.
    pub fn unit(&self, draft: &Draft, classes: &mut DomainClasses) -> Unit {
        let mut parts = Rects::default();
        let part_rects: Vec<Rect> = self.footprints(draft).map(|f| self.part_rects(f, classes, &mut parts)).collect();
        let (x, y) = self.origin(draft, &parts.rects);
        let fixed = self.is_fixed(draft, (x, y), &part_rects);
        let mut rects = parts.rects;
        let mut mech = parts.mech;
        let mut border = Vec::new();
        if let Some(b) = draft.boxed {
            // Block copper may leave the courtyards but stays inside the border.
            rects.push((b, 0.0));
            border.push(rects.len() - 1);
            if !parts.dom.is_empty() {
                mech.push(rects.len() - 1);
            }
        }
        let base = rects.len();
        rects.extend(parts.pads.iter().copied());
        let on_domain: HashSet<usize> = parts.dom.iter().map(|d| d.0).collect();
        let mut refs = draft.refs.clone();
        refs.sort();
        let centre = |r: &String| {
            let (cx, cy) = fp_rect(self.by_ref[r.as_str()]).centre();
            (r.clone(), [round6(cx - x), round6(cy - y)])
        };
        let centres: BTreeMap<String, [f64; 2]> = refs.iter().map(centre).collect();
        let mut u = Unit {
            name: draft.name.clone(),
            fixed,
            x,
            y,
            pads: self.pad_centres(draft, x, y),
            centres,
            borders: draft.borders.clone(),
            boxed: draft.boxed.map(|b| [b.x0, b.y0, b.x1, b.y1]),
            group: draft.group.clone(),
            hard: (0..parts.pads.len()).filter(|k| !on_domain.contains(k)).map(|k| base + k).collect(),
            dom: parts.dom.iter().map(|&(k, c, g, nc)| (base + k, c, g, nc)).collect(),
            mech,
            nocu: self.pads(draft).all(|p| p.kind == PadKind::NpThroughHole),
            rho: parts.rho,
            border,
            locked_cu: if fixed { Vec::new() } else { draft.private.iter().cloned().collect() },
            refs,
            ..Unit::default()
        };
        u.rects = rects.iter().map(|(r, spacing)| u.local(*r, *spacing)).collect();
        self.copper_rows(draft, &mut u);
        u
    }
}
