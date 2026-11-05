//! Reference-plane fill edge (model `ref_fill`, src/model/planes.rs reference_fill; DESIGN 5b "plane fill edge").
//!
//! The planes gate (si/planes, D-124c screen) samples the centre line of every track of a checked net on an
//! outer layer and fails a run of samples that are not inside the filled copper of the net's domain on the adjacent
//! plane layer (SHAPE_POLY_SET.Contains, accuracy 0: margin 0), except within pad / via radius + via_allow_mm of the
//! net's own pads and vias. `iotroute model` reads the zones of the router input as KiCad 10 refilled them and writes the filled
//! polygons per outer layer and domain, so the edge holds the zone clearance, thermal / antipad setback and min-width
//! removal around holes, keepouts and fixed copper. New vias use a conservative local setback derived from the
//! adjacent zones' clearance, thermal gaps, via-specific rules and minimum width. Live holes are checked in Board's
//! spatial indexes in both insertion orders, not baked into this immutable fill or its caches. Native refill and
//! the complete planes gate remain necessary for merged voids, disconnected islands and mixed-layer tracks.
//!
//! Board::track_fixed_code applies it to a net whose pflags carry a domain (bits 2..7): a track centre outside the
//! area is blocked, except inside the anchor discs of exactly one net (that net may pass: fixed code n). Two nets'
//! discs at one point give MULTI (stricter than the gate, never looser). The routing EPS margin is kept from the edge.

use serde_json::Value;

/// Bucket size (mm) of the inside / outside / mixed classification. A tuning value (speed only, not a rule): a
/// bucket that no ring edge touches is classified once by its centre; a mixed bucket is tested exactly.
const BS: f64 = 0.25;

#[derive(Clone, Default)]
pub(crate) struct Area {
    x0: f64,
    y0: f64,
    nx: usize,
    ny: usize,
    /// ring edges (ax, ay, bx, by) of all polygons of the area; even-odd over one polygon set = KiCad Contains for a
    /// fill (outlines do not overlap, holes lie in their outline). Overlapping sets of one domain (ground + alt_ref
    /// zones) are kept as separate sets: inside = inside any set.
    sets: Vec<Vec<(f64, f64, f64, f64)>>,
    /// per set, per bucket row: the edges whose y range touches the row (ray cast toward +x)
    rows: Vec<Vec<Vec<u32>>>,
    /// per bucket: 1 inside, 2 outside, 3 mixed (edges near: exact test with `near`)
    cls: Vec<u8>,
    /// mixed buckets: (set, edge) pairs whose bbox, grown by the margin, touches the bucket
    near: std::collections::HashMap<usize, Vec<(u32, u32)>>,
}

impl Area {
    fn build(sets: Vec<Vec<(f64, f64, f64, f64)>>, bbox: (f64, f64, f64, f64)) -> Area {
        let (x0, y0) = (bbox.0 - BS, bbox.1 - BS);
        let nx = ((bbox.2 - bbox.0) / BS).ceil() as usize + 3;
        let ny = ((bbox.3 - bbox.1) / BS).ceil() as usize + 3;
        let mut a = Area { x0, y0, nx, ny, sets: Vec::new(), rows: Vec::new(), cls: vec![0; nx * ny], near: Default::default() };
        let pad = 0.01; // bucket growth for the near lists: above every routing margin (EPS 0.002)
        for (si, set) in sets.iter().enumerate() {
            let mut rows = vec![Vec::new(); ny];
            for (ei, e) in set.iter().enumerate() {
                let (r0, r1) = (a.row(e.1.min(e.3) - pad), a.row(e.1.max(e.3) + pad));
                for r in rows.iter_mut().take(r1 + 1).skip(r0) {
                    r.push(ei as u32);
                }
                let (c0, c1) = (a.col(e.0.min(e.2) - pad), a.col(e.0.max(e.2) + pad));
                for iy in r0..=r1 {
                    for ix in c0..=c1 {
                        a.cls[iy * nx + ix] = 3;
                        a.near.entry(iy * nx + ix).or_default().push((si as u32, ei as u32));
                    }
                }
            }
            a.rows.push(rows);
        }
        a.sets = sets;
        for iy in 0..ny {
            for ix in 0..nx {
                let k = iy * nx + ix;
                if a.cls[k] == 0 {
                    let (cx, cy) = (x0 + (ix as f64 + 0.5) * BS, y0 + (iy as f64 + 0.5) * BS);
                    a.cls[k] = if a.contains_exact(cx, cy) { 1 } else { 2 };
                }
            }
        }
        a
    }
    fn row(&self, y: f64) -> usize {
        (((y - self.y0) / BS).floor().max(0.0) as usize).min(self.ny - 1)
    }
    fn col(&self, x: f64) -> usize {
        (((x - self.x0) / BS).floor().max(0.0) as usize).min(self.nx - 1)
    }
    fn contains_exact(&self, x: f64, y: f64) -> bool {
        let r = self.row(y);
        self.sets.iter().zip(&self.rows).any(|(set, rows)| {
            let mut inside = false;
            for &ei in &rows[r] {
                let (ax, ay, bx, by) = set[ei as usize];
                if (ay > y) != (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax {
                    inside = !inside;
                }
            }
            inside
        })
    }
    /// The point is inside the area and at least m from its edge.
    pub(crate) fn inside(&self, x: f64, y: f64, m: f64) -> bool {
        if x < self.x0 || y < self.y0 || x >= self.x0 + self.nx as f64 * BS || y >= self.y0 + self.ny as f64 * BS {
            return false;
        }
        let k = self.row(y) * self.nx + self.col(x);
        match self.cls[k] {
            1 => true,
            2 => false,
            _ => {
                if m > 0.0 {
                    if let Some(es) = self.near.get(&k) {
                        if es.iter().any(|&(s, e)| {
                            let (ax, ay, bx, by) = self.sets[s as usize][e as usize];
                            crate::seg_dist(x, y, ax, ay, bx, by) < m
                        }) {
                            return false;
                        }
                    }
                }
                self.contains_exact(x, y)
            }
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct RefFill {
    /// Explicit trace-layer to reference-plane mapping. A void on another plane is not a void in this reference.
    adjacent_planes: Vec<(usize, u8)>,
    /// A homogeneous reference plane's net. Mixed or unknown planes keep the conservative hole model.
    reference_nets: Vec<(usize, i32)>,
    /// per net: 0 = no rule, k = domain k - 1
    pub(crate) dom: Vec<u8>,
    /// (copper layer, domain) -> area
    areas: Vec<((usize, u8), Area)>,
    /// own-net exemption discs: centre, radius (pad or via radius + via_allow), net
    anchors: Vec<(f64, f64, f64, i32)>,
    /// Conservative local hole setback per outer layer, from its adjacent zones.
    /// Immutable settings only: live via geometry stays in Board's spatial indexes.
    via_clearance: Vec<(usize, f64)>,
    /// gate scope (2026-11-02, model net `ref_soft`): a net whose off-reference run the gate may accept (si_planes
    /// D-124c: a stub, a run whose terminal snap discs meet in reference copper, a return detour within the edge budget,
    /// or no rule above the board perimeter) is not blocked off the reference: each step there costs more
    /// (Ctx::search_n, --ref-cost), and iotroute run checks the written board with si_planes itself; a net the gate fails
    /// is routed again with ref_soft false (blocked, as before). Fast nets stay blocked (D-124 fast-crossing).
    pub(crate) soft: Vec<bool>,
    /// per net: the off-reference step price (model net `ref_cost`, default crate::DEF_REF_COST); iotroute run raises it for
    /// a soft net whose run the gate failed, before it sets the net hard
    pub(crate) cost: Vec<f64>,
}

impl RefFill {
    fn add_reference(&mut self, l: usize, p: usize, model: &Value, cu: &[String], names: &std::collections::HashMap<String, usize>) {
        self.adjacent_planes.push((l, 1 << p));
        let nets: Option<Vec<usize>> = model["zones"].as_array().into_iter().flatten()
            .filter(|z| z["layer"].as_str() == Some(cu[p].as_str()))
            .map(|z| z["net"].as_str().and_then(|n| names.get(n)).copied()).collect();
        if let Some(nets) = nets
            && let Some(&net) = nets.first()
            && nets.iter().all(|&n| n == net)
        {
            self.reference_nets.push((l, net as i32));
        }
    }

    pub(crate) fn load(model: &Value, cu: &[String], names: &std::collections::HashMap<String, usize>) -> RefFill {
        let rf = &model["ref_fill"];
        let mut out = RefFill { dom: vec![0; names.len()], ..Default::default() };
        for (trace, plane) in model["adjacent"].as_object().into_iter().flatten() {
            if let (Some(l), Some(p)) = (cu.iter().position(|c| c == trace), plane.as_str().and_then(|p| cu.iter().position(|c| c == p))) {
                out.add_reference(l, p, model, cu, names);
            }
        }
        let Some(layers) = rf["layers"].as_object() else { return out };
        let allow = rf["via_allow"].as_f64().unwrap_or(0.6);
        let mut doms: Vec<String> = Vec::new();
        for (name, v) in model["nets"].as_object().unwrap() {
            if let (Some(d), Some(&i)) = (v["ref_domain"].as_str(), names.get(name)) {
                if !doms.iter().any(|q| q == d) {
                    doms.push(d.to_string());
                }
                out.dom[i] = doms.iter().position(|q| q == d).unwrap() as u8 + 1;
            }
            if let (Some(true), Some(&i)) = (v["ref_soft"].as_bool(), names.get(name)) {
                if out.soft.len() < names.len() {
                    out.soft.resize(names.len(), false);
                }
                out.soft[i] = true;
                if out.cost.len() < names.len() {
                    out.cost.resize(names.len(), crate::DEF_REF_COST);
                }
                out.cost[i] = v["ref_cost"].as_f64().unwrap_or(crate::DEF_REF_COST);
            }
        }
        let ob = model["outline_bbox"].as_array().unwrap();
        let bbox = (crate::f(&ob[0]), crate::f(&ob[1]), crate::f(&ob[2]), crate::f(&ob[3]));
        for (lname, lv) in layers {
            let Some(l) = cu.iter().position(|c| c == lname) else { continue };
            if !out.adjacent_planes.iter().any(|&(layer, _)| layer == l)
                && let Some(p) = lv["plane"].as_str().and_then(|p| cu.iter().position(|c| c == p))
            {
                out.add_reference(l, p, model, cu, names);
            }
            // A new via was absent when KiCad produced the static fill. Its hole
            // uses zone/DRU clearance, not the old generic --plane-clr alone.
            // Take maxima across the adjacent layer (including thermal gaps)
            // and a full minimum-width margin. This deliberately overestimates
            // local antipads; it is not a replacement for native refill/islands.
            let class_clearance = ["classes", "nets"].iter().flat_map(|key| model[key].as_object().into_iter().flatten())
                .filter_map(|(_, c)| c["clearance"].as_f64()).fold(0.0, f64::max);
            let setback = model["zones"].as_array().into_iter().flatten()
                .filter(|z| z["layer"].as_str() == lv["plane"].as_str())
                .map(|z| {
                    let via_rule = z["net_clearance"].as_object().into_iter().flatten()
                        .filter_map(|(_, c)| c["via"].as_f64()).fold(0.0, f64::max);
                    let clearance = crate::f(&z["clearance"]).max(crate::f(&z["thermal_gap"]))
                        .max(via_rule).max(class_clearance).max(crate::f(&model["setup"]["min_clearance"]));
                    clearance + crate::f(&z["min_thickness"])
                }).fold(0.0, f64::max);
            out.via_clearance.push((l, setback));
            for (di, d) in doms.iter().enumerate() {
                let mut sets = Vec::new();
                for poly in lv["domains"][d.as_str()].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
                    let mut set = Vec::new();
                    for ring in poly.as_array().unwrap() {
                        let pts: Vec<(f64, f64)> = ring.as_array().unwrap().iter().map(|q| (crate::f(&q[0]), crate::f(&q[1]))).collect();
                        for i in 0..pts.len() {
                            let (a, b) = (pts[i], pts[(i + 1) % pts.len()]);
                            set.push((a.0, a.1, b.0, b.1));
                        }
                    }
                    sets.push(set);
                }
                out.areas.push(((l, di as u8 + 1), Area::build(sets, bbox)));
            }
        }
        for a in rf["anchors"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
            if let Some(&n) = a[3].as_str().and_then(|n| names.get(n)) {
                out.anchors.push((crate::f(&a[0]), crate::f(&a[1]), crate::f(&a[2]) + allow, n as i32));
            }
        }
        out
    }
    pub(crate) fn adjacent_plane_mask(&self, l: usize) -> Option<u8> {
        self.adjacent_planes.iter().find(|&&(layer, _)| layer == l).map(|&(_, mask)| mask)
    }

    pub(crate) fn same_reference_net(&self, l: usize, net: i32) -> bool {
        net >= 0 && self.reference_nets.contains(&(l, net))
    }

    pub(crate) fn is_reference_net(&self, net: usize) -> bool {
        self.reference_nets.iter().any(|&(_, n)| n == net as i32)
    }

    pub(crate) fn via_clearance(&self, l: usize) -> f64 {
        self.via_clearance.iter().find(|(layer, _)| *layer == l).map_or(0.0, |(_, c)| *c)
    }
    pub(crate) fn max_via_clearance(&self) -> f64 {
        self.via_clearance.iter().map(|(_, c)| *c).fold(0.0, f64::max)
    }
    /// A soft net (RefFill::soft) with domain d: the track centre at (x, y) on copper layer l is off its reference
    /// (outside the area and outside its own anchor discs), so the A* step there pays --ref-cost.
    pub(crate) fn off_ref(&self, l: usize, net: usize, x: f64, y: f64, m: f64) -> bool {
        let d = self.dom.get(net).copied().unwrap_or(0);
        if d == 0 || !self.soft.get(net).copied().unwrap_or(false) {
            return false;
        }
        let c = self.code(l, d, x, y, m);
        c != crate::FREE && c != net as i32
    }
    /// Fixed code of a track centre of a net with domain d (1-based) on copper layer l: FREE (inside the area, or no
    /// area for this layer), n (outside; only net n's anchor discs hold the point), MULTI (outside, no or two nets).
    pub(crate) fn code(&self, l: usize, d: u8, x: f64, y: f64, m: f64) -> i32 {
        let Some((_, a)) = self.areas.iter().find(|(k, _)| *k == (l, d)) else { return crate::FREE };
        if a.inside(x, y, m) {
            return crate::FREE;
        }
        let mut own = crate::FREE;
        for &(ax, ay, r, n) in &self.anchors {
            if (x - ax).abs() <= r && (y - ay).abs() <= r && (x - ax).hypot(y - ay) <= r - m {
                if own >= 0 && own != n {
                    return crate::MULTI;
                }
                own = n;
            }
        }
        if own >= 0 { own } else { crate::MULTI }
    }
}
