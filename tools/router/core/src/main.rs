//! iotroute: rule-native grid router core (tools/router/DESIGN.md, M1).
//!
//!   iotroute MODEL.json OUT.json [--pitch 0.05] [--iters 40] [--plane-clr 0.25] [--hole-to-hole 0.45] [--hole-clr 0.28]
//!            [--return-r 2.0] [--return-via 0.45,0.2] [--pres-mult 1.5] [--pres-max 1000] [--hist 0.3] [--max-time S] [--door-hist 2.0] [--check RESULT.json]
//!            [--congestion MAP.json [--cong-cell 1.0] [--cong-free 0|1]] (congestion.rs: the map for the placer)
//!            [--seed N] (seed.rs: another route of the same board) [--checkpoint FILE [--source-sha HEX]] (checkpoint.rs: progress per pass)
//!            [--stall-passes N] (stop after N passes that do not beat the best pass; default off)
//!
//! MODEL.json comes from `iotroute model` (src/model, schema iot-lab.route-model.v0). Every clearance is checked against
//! exact geometry (pads as their bounding rectangle, tracks as capsules, vias as circles) with the per-net width and
//! clearance of the model; the grid only decides where the search may step. Stages, in this order:
//!   1. plane fan-out: every SMD pad of a plane net (reference-planes.json) gets its own via to its plane, unless a
//!      fixed via of the net is already within 1 mm (CLAUDE.md: a ground via next to each ground pad).
//!   2. routed nets: power class first, then fast nets, then slow nets; shortest first inside a group. A net is a set
//!      of components (pads + existing copper that touch); the search joins them one by one (multi-source A*).
//!   3. return vias: each new signal via gets a GND via within --return-r (kicad-happy RP-001) when its join is
//!      routed; a via site with no possible GND site is no legal layer change, and a rejected transition reroutes.
//! Hard rules (v4): DRU via_count per net, locked input vias included (max 0 = one layer); RP-001 as above; power nets
//! never narrower than the width of their design current (model min_width, the paths gate formula); track ends
//! END_IN inside the copper they join.
//! NET-CORE lessons (2026-10-31) built in: a fast net keeps --plane-clr from every foreign drilled item, so it never
//! runs over a plane antipad (si_planes fast-crossing); since v4 every si_planes checked net (model plane_ref) does the
//! same on the layers with an adjacent plane (model adjacent); a GND via may go through a foreign plane (antipad), it
//! is checked only against copper items. The negotiation stops when the copper is legal and the open nets are hard
//! fails that did not change for STALL iterations.
//! Negotiation (PathFinder): routed copper is soft. Step cost = length x (1 + history) x (1 + pres x distinct items hit).
//! After each iteration an exact audit of all routed copper (plain rule, no margin) gives the overuse: history grows on
//! every conflicting item of both nets, the nets still in conflict (and search-limited ones) are ripped up, pres grows
//! by --pres-mult up to --pres-max. Not converged after --iters / --max-time: the best iteration is restored, the
//! fewest nets are ripped until the copper is legal, they are routed again with soft conflicts blocking, and what
//! stays open is reported as failed (graceful end: the written copper is always clearance-legal).
//! Pour (v5, pour.rs): after each iteration the outer-layer pours are filled on a 0.025 mm grid as KiCad fills them and
//! the KiCad starved_thermal rule is applied; a thermal pad whose spokes reach only an island (a piece with no other item)
//! is a conflict of the routed nets that wall it in: door history on their cells and they are routed again; after
//! DOOR_STALL iterations the door (its path from the spoke test point to a via or track end of the net) is reserved as
//! pour. --check RESULT.json runs only the pour check on a routed result (verification against KiCad DRC).
//! The output is a proposal: KiCad DRC with parity and tools/gate.mjs decide. Last line: ROUTE PASS|FAIL ... summary.
use serde::Serialize;
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::BinaryHeap;

mod checkpoint;
mod congestion;
mod layers;
mod owned;
mod pour;
mod reffill;
mod reuse;
mod seed;
mod write;

const EPS: f64 = 0.002;
// Defaults when the model has no `hole_rules` key (an old model.json); a model value and then a CLI flag override them.
const DEF_HOLE_CLR: f64 = 0.28; // .kicad_dru "JLC PTH hole to copper"
const DEF_HOLE_TO_HOLE: f64 = 0.45; // .kicad_dru "JLC PTH hole to hole"
const DEF_PLANE_CLR: f64 = 0.25; // local clearance of the inner GND / power zones
const SQ2: f64 = std::f64::consts::SQRT_2;
/// default A* via cost (mm of track) and new-return surcharge (v6 fix 3b): tuning weights, set by the H7-CORE
/// experiment in reports/2026-11-01-v6-h7-core.md (not rule thresholds)
const DEF_VIA_COST: f64 = 3.0;
const DEF_RET_COST: f64 = 0.0;
const DEF_WEB_COST: f64 = 3.0;
/// gate scope (reffill.rs RefFill::soft): an A* step of a soft net off its reference costs (1 + this) times more. A
/// search preference only (as DEF_VIA_COST): which off-reference runs are legal is decided by si_planes in run.py.
pub(crate) const DEF_REF_COST: f64 = 3.0;
/// a join is searched first inside the bounding box of the net's items grown by this margin (mm)
const JOIN_MARGIN: f64 = 5.0;
/// a track end lies at least this far inside the copper it joins (pad, track, via): see cells_of
const END_IN: f64 = 0.01;
/// iterations with the same hard fails and no conflict before the negotiation stops
const STALL: usize = 3;
/// iterations a pour fault may stay under door history before its door is reserved as pour (hard door)
const DOOR_STALL: usize = 3;
/// v7: length of one through via in the KiCad DRC length rule when the model has no `via_length` (an old model): the
/// JLC standard board thickness 1.6 mm, which is not less than the F.Cu-B.Cu stackup height of our 4-layer boards (H7-CORE
/// 1.5862, NET-CORE 1.58), so the bound stays conservative
const DEF_VIA_LEN: f64 = 1.6;
/// v7 fix 5: rejected layer changes of one net (no conflict-free return site) before a return may take a conflicting
/// site (v6: the 40-try RP-001 limit gives the end; 8 leaves 32 tries with the v6 rule)
const RET_SOFT_AFTER: usize = 8;

#[derive(Clone, Copy, Debug)]
enum Geo {
    Rect(f64, f64, f64, f64),
    Seg(f64, f64, f64, f64, f64),
    Circ(f64, f64, f64),
}

fn seg_dist(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let (dx, dy) = (bx - ax, by - ay);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 0.0 { (((px - ax) * dx + (py - ay) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
    ((px - ax - t * dx).powi(2) + (py - ay - t * dy).powi(2)).sqrt()
}

impl Geo {
    /// Distance from a point to the copper edge (negative inside a track or via).
    fn dist(&self, x: f64, y: f64) -> f64 {
        match *self {
            Geo::Rect(x0, y0, x1, y1) => {
                let dx = (x0 - x).max(0.0).max(x - x1);
                let dy = (y0 - y).max(0.0).max(y - y1);
                (dx * dx + dy * dy).sqrt()
            }
            Geo::Seg(ax, ay, bx, by, hw) => seg_dist(x, y, ax, ay, bx, by) - hw,
            Geo::Circ(cx, cy, r) => ((x - cx).powi(2) + (y - cy).powi(2)).sqrt() - r,
        }
    }
    fn bbox(&self) -> (f64, f64, f64, f64) {
        match *self {
            Geo::Rect(a, b, c, d) => (a, b, c, d),
            Geo::Seg(ax, ay, bx, by, hw) => (ax.min(bx) - hw, ay.min(by) - hw, ax.max(bx) + hw, ay.max(by) + hw),
            Geo::Circ(x, y, r) => (x - r, y - r, x + r, y + r),
        }
    }
    /// Points that touch another item when this item is connected to it.
    fn probes(&self) -> Vec<(f64, f64, f64)> {
        match *self {
            Geo::Rect(a, b, c, d) => vec![((a + c) / 2.0, (b + d) / 2.0, 0.0)],
            Geo::Seg(ax, ay, bx, by, hw) => vec![(ax, ay, hw), (bx, by, hw)],
            Geo::Circ(x, y, r) => vec![(x, y, r)],
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Pad,
    Track,
    Via,
    /// reserved thermal spoke channel of a plane-net pad: fixed copper of the pad's net for the clearance checks (a hard
    /// obstacle for other nets, memoized with the rest of the fixed copper), never a pin or a component
    Spoke,
}

#[derive(Clone)]
struct Shape {
    net: i32,
    geo: Geo,
    clr: f64,
    layers: u8,
    drill: f64,
    kind: Kind,
    /// -1: fixed (pads, locked copper, plane fan-out): a hard obstacle. >= 0: routed by that net in this run: other
    /// nets may cross it at the negotiated cost (PathFinder) until the run converges.
    owner: i32,
    alive: bool,
    /// isolation: clearance group of the item (model `iso`, src/model/pairs.rs); pads from the model, tracks and vias from
    /// their net and the region atoms they touch (Board::add). 0 when the board has no pair rules.
    grp: u16,
}

/// Isolation (DRU pair rules, model `iso`, src/model/pairs.rs): clearance groups of the items and the table of
/// the pair value (the larger of the resolved DRU clearance and creepage, and pair hole clearances; KiCad: the last
/// matching rule wins, both item orders). A rule item pair keeps max(the per-net clearance, the table value).
#[derive(Clone, Default)]
struct Iso {
    n: usize,
    tab: Vec<f64>,
    /// region polygons (courtyards / areas of spatial selectors), bit k of a group list index = touches region k
    regs: Vec<Vec<Vec<(f64, f64)>>>,
    /// distinct (track, via) group lists, indexed by the region bits; Board::niv points each net to one (0 = no net)
    var: Vec<[Vec<u16>; 2]>,
}

fn pt_in_poly(x: f64, y: f64, p: &[(f64, f64)]) -> bool {
    let mut inside = false;
    let n = p.len();
    for i in 0..n {
        let (a, b) = (p[i], p[(i + n - 1) % n]);
        if (a.1 > y) != (b.1 > y) && x < (b.0 - a.0) * (y - a.1) / (b.1 - a.1) + a.0 {
            inside = !inside;
        }
    }
    inside
}

fn seg_seg_dist(a: (f64, f64), b: (f64, f64), c: (f64, f64), d: (f64, f64)) -> f64 {
    let cr = |o: (f64, f64), p: (f64, f64), q: (f64, f64)| (p.0 - o.0) * (q.1 - o.1) - (p.1 - o.1) * (q.0 - o.0);
    let (d1, d2, d3, d4) = (cr(c, d, a), cr(c, d, b), cr(a, b, c), cr(a, b, d));
    if ((d1 > 0.0 && d2 < 0.0) || (d1 < 0.0 && d2 > 0.0)) && ((d3 > 0.0 && d4 < 0.0) || (d3 < 0.0 && d4 > 0.0)) {
        return 0.0;
    }
    seg_dist(a.0, a.1, c.0, c.1, d.0, d.1).min(seg_dist(b.0, b.1, c.0, c.1, d.0, d.1))
        .min(seg_dist(c.0, c.1, a.0, a.1, b.0, b.1)).min(seg_dist(d.0, d.1, a.0, a.1, b.0, b.1))
}

/// Copper of a segment a-b with half width hw (a point: a == b) touches the polygon: KiCad intersectsCourtyard /
/// intersectsArea of the item. True only with a margin (1e-6 mm), so the core never says True where KiCad says False.
fn cap_touches(a: (f64, f64), b: (f64, f64), hw: f64, p: &[(f64, f64)]) -> bool {
    if pt_in_poly(a.0, a.1, p) || pt_in_poly(b.0, b.1, p) {
        return true;
    }
    let n = p.len();
    (0..n).any(|i| seg_seg_dist(a, b, p[i], p[(i + 1) % n]) < hw - 1e-6)
}

#[derive(Clone)]
struct Net {
    name: String,
    width: f64,
    clr: f64,
    fast: bool,
    plane: bool,
    power: bool,
    layers: u8,
    via_d: f64,
    via_drill: f64,
    max_vias: Option<f64>,
    max_len: Option<f64>,
    /// si_planes checked net (not ground, power or exempt): on a layer with an adjacent plane (model `adjacent`) the
    /// track keeps --plane-clr from foreign drilled items, so it never runs over a plane void (D-124c crossing)
    pref: bool,
    /// smallest width the net's design current needs (model `min_width`, the paths gate formula); 0 = no current
    min_w: f64,
    /// v8: smallest width per copper layer index (model `min_width_layers`: the gate rates each piece with the copper of
    /// its own layer, tools/pcbtool.py paths); 0 or missing = no floor on that layer. min_w is the smallest of them.
    min_wl: Vec<f64>,
    /// locked input vias of the net: they count in the DRU via_count
    in_vias: usize,
}

/// v8: a KiCad rule area (keepout) that does not allow tracks (on the layers in `tl`) or vias (any layer: a through via
/// touches every layer). KiCad items_not_allowed: an item that touches the area at all (no clearance). A polygon that is
/// not one axis-parallel rectangle is kept as its bounding box (conservative).
#[derive(Clone, Debug)]
struct Keep {
    r: (f64, f64, f64, f64),
    tl: u8,
    via: bool,
    /// isolation work: the exact outlines and holes of a rule area that is not one rectangle (model keepout pts /
    /// holes). An isolation barrier band is a ring (outline + hole); its bbox walled in the whole host island of
    /// INPUT-4D2A (BARRIER_BAND). Empty = the rectangle r.
    poly: Vec<Vec<(f64, f64)>>,
    holes: Vec<Vec<(f64, f64)>>,
    /// layers on which the area forbids copper pour (no thermal spoke channel is reserved there)
    pl: u8,
}

impl Keep {
    /// A disc (x, y, radius r) touches the area: centre inside an outline and in no hole, or within r of an edge.
    fn touches(&self, x: f64, y: f64, r: f64) -> bool {
        if self.poly.is_empty() {
            return Geo::Rect(self.r.0, self.r.1, self.r.2, self.r.3).dist(x, y) < r;
        }
        if x < self.r.0 - r || x > self.r.2 + r || y < self.r.1 - r || y > self.r.3 + r {
            return false;
        }
        if self.poly.iter().any(|p| pt_in_poly(x, y, p)) && !self.holes.iter().any(|h| pt_in_poly(x, y, h)) {
            return true;
        }
        self.poly.iter().chain(self.holes.iter()).any(|p| {
            let n = p.len();
            (0..n).any(|i| seg_dist(x, y, p[i].0, p[i].1, p[(i + 1) % n].0, p[(i + 1) % n].1) < r)
        })
    }
}

#[derive(Serialize, Clone)]
struct OutTrack {
    net: String,
    layer: String,
    a: [f64; 2],
    b: [f64; 2],
    w: f64,
}
#[derive(Serialize, Clone)]
struct OutVia {
    net: String,
    x: f64,
    y: f64,
    d: f64,
    drill: f64,
    role: String,
}
#[derive(Serialize, Clone)]
struct Fail {
    net: String,
    stage: String,
    reason: String,
}
#[derive(Serialize)]
struct Out {
    schema: String,
    tracks: Vec<OutTrack>,
    vias: Vec<OutVia>,
    failed: Vec<Fail>,
    notes: Vec<String>,
    passes: usize,
}

struct Opts {
    pitch: f64,
    passes: usize,
    plane_clr: f64,
    hth: f64,
    return_r: f64,
    ret_d: f64,
    ret_drill: f64,
    pres_mult: f32,
    pres_max: f32,
    hist: f32,
    max_time: f64,
    /// history added per iteration on the routing cells of a pour door (see pour.rs, Ctx::door_cells)
    door_hist: f32,
    /// A* cost of a layer change in mm of F.Cu track (v6 fix 3b; v5: 3.0)
    via_cost: f64,
    /// extra A* cost of a layer change at a site with no GND via within the RP-001 radius (a new return via is needed)
    ret_cost: f64,
    /// extra A* cost of a layer change per foreign signal drilled item inside the antipad web (Board::web, not hard)
    web_cost: f64,
    /// v9: skip the length recovery after a legal end state (`--recover 0`, for comparison runs)
    no_recover: bool,
    /// `--stall-passes N`: stop the negotiation after N passes in a row that do not beat the best pass; 0 = off
    stall_passes: usize,
}

struct Index {
    x0: f64,
    y0: f64,
    b: f64,
    nx: usize,
    ny: usize,
    cells: Vec<Vec<Vec<u32>>>, // [layer][bucket] -> shape ids
}

impl Index {
    fn new(x0: f64, y0: f64, x1: f64, y1: f64, nl: usize) -> Index {
        Index::with_bucket(x0, y0, x1, y1, nl, 0.5)
    }
    fn with_bucket(x0: f64, y0: f64, x1: f64, y1: f64, nl: usize, b: f64) -> Index {
        let nx = ((x1 - x0) / b).ceil() as usize + 2;
        let ny = ((y1 - y0) / b).ceil() as usize + 2;
        Index { x0, y0, b, nx, ny, cells: vec![vec![Vec::new(); nx * ny]; nl] }
    }
    fn range(&self, a: f64, lo: f64, n: usize) -> usize {
        (((a - lo) / self.b).floor().max(0.0) as usize).min(n - 1)
    }
    fn insert(&mut self, id: u32, s: &Shape) {
        let (a, b, c, d) = s.geo.bbox();
        let (i0, i1) = (self.range(a, self.x0, self.nx), self.range(c, self.x0, self.nx));
        let (j0, j1) = (self.range(b, self.y0, self.ny), self.range(d, self.y0, self.ny));
        for l in 0..self.cells.len() {
            if s.layers & (1 << l) == 0 {
                continue;
            }
            for j in j0..=j1 {
                for i in i0..=i1 {
                    self.cells[l][j * self.nx + i].push(id);
                }
            }
        }
    }
}

struct Board {
    layer_names: Vec<String>,
    routable: Vec<usize>, // copper layer index of each routable layer
    nets: Vec<Net>,
    shapes: Vec<Shape>,
    /// fixed items (owner < 0: pads, locked copper); never change during a run
    idx: Index,
    /// routed items (owner >= 0): soft obstacles, negotiated
    sidx: Index,
    maxc: f64,
    edge: (f64, f64, f64, f64),
    edge_clr: f64,
    gnd: i32,
    /// --plane-clr: fast tracks keep it from foreign drilled items (si_planes fast-crossing)
    plane_clr: f64,
    /// margin of every clearance test: EPS while routing (conservative), 0 in the audit (the plain rule)
    eps: f64,
    /// hole edge to foreign copper (.kicad_dru hole_clearance), from the model
    hole_clr: f64,
    /// pads with fewer spoke channels than the zone needs (fixed copper already blocks them): reported in the notes
    spoke_notes: Vec<String>,
    /// SMD pads of a plane net that need their own fan-out track (it counts as one spoke): forced even when a via is near
    attach: Vec<(f64, f64)>,
    /// via sites (x, y in um) of forced fan-outs that lie in the pour fill of the fixed copper (pre_attach): the via
    /// of a forced fan-out must be one of them (its track is then a KiCad track spoke)
    spoke_sites: std::collections::HashSet<(i64, i64)>,
    /// layers with an adjacent reference plane (model `adjacent`, si_planes): the plane rule of `pref` nets applies there
    adj: u8,
    /// pad centre -> width its power chain needs (model power_chains): the plane fan-out of that pad keeps it
    pad_need: Vec<(f64, f64, f64)>,
    /// centres of the fixed GND vias and GND through-hole pads: a return for any signal via within --return-r (RP-001)
    gnd_fixed: Vec<(f64, f64)>,
    /// outer-layer pours with thermal pads (model `zones`): the starved-thermal rule of pour.rs
    pours: Vec<pour::Pour>,
    /// round pads (kept as their bounding box elsewhere): centre (1e-4 mm) -> radius, for the pour model
    circ: std::collections::HashMap<(i64, i64), f64>,
    /// SMD pads (bbox) on the gate viapads allow list (model pad `via_in_pad`): an own-net via may sit inside them
    vip: Vec<(f64, f64, f64, f64)>,
    /// thermal via arrays (model pad `thermal_vias`, from the board's thermal-vias.json with a datasheet source):
    /// (pad bbox, via centres, via diameter, drill, pad name). fixed_vip_vias places them before routing.
    tvia: Vec<((f64, f64, f64, f64), Vec<(f64, f64)>, f64, f64, String)>,
    /// v6 fix 3c: plane antipad web. Two drilled items of different signal (non-plane) nets keep their copper this far
    /// apart: 2 x the plane zone clearance + the zone min_thickness (max over the plane-layer zones). Their antipads on
    /// the plane then stay at least min_thickness apart, so the KiCad zone fill keeps the copper web between them
    /// (fillCopperZone prunes a web below min_thickness, and the antipads merge into one slot). 0 = off.
    web: f64,
    /// web as a hard rule (--web-hard): drilled items of two signal nets inside the web conflict. Default: a priced
    /// limit (A* via cost + web_cost per foreign signal drilled item inside the web), reported as web pairs. The hard
    /// rule did not converge on NET-CORE (RMII field, 80 iterations, twice): reports/2026-11-01-v6-h7-core.md.
    web_hard: bool,
    /// v7: length KiCad adds per via in the DRC length rule (model `via_length`: the F.Cu-B.Cu stackup height)
    via_len: f64,
    /// v8: rule areas that keep tracks or vias out (model `keepouts`)
    keep: Vec<Keep>,
    /// v8: rated pin escapes (model pad `escape`, the paths gate D-124c (b) rule with tools/pin-ratings.json): pad bbox,
    /// escape width (the pad's narrow side, never below the board minimum track), escape length (the pad's long side),
    /// rectangular pad (a track may end anywhere in the rect less END_IN; else only in the inscribed ellipse)
    esc: Vec<((f64, f64, f64, f64), f64, f64, bool)>,
    /// v8: Edge.Cuts centre-line segments (model `edges`): copper keeps edge_clr from them (KiCad copper_edge_clearance);
    /// the outline bbox alone misses a notch or a cut-out (BASE-PWR-C)
    edges: Vec<(f64, f64, f64, f64)>,
    /// v8b: fan-out via of a plane-net pad in a power chain that one net via cannot carry (model pad fanout_via,
    /// pcbtool.via_amps): pad centre, via diameter, drill
    fvia: Vec<(f64, f64, f64, f64)>,
    /// isolation pair rules (model `iso`); None = no pair rule on the board (every query as before)
    iso: Option<Iso>,
    /// isolation: the Iso::var entry of each net (empty without iso)
    niv: Vec<u32>,
    /// plane outlines of each plane net (model net `plane_polys`): its fan-out vias go inside them (a plane that does
    /// not cover the board, POE-ETHERNET In2 VDD_3V3). A net with none: no limit (an older model)
    ppoly: Vec<(usize, Vec<(f64, f64)>)>,
    /// parallel copy (model net `twin`, current-paths.json parallel chains): copper layer of the second copy of each
    /// net (-1 none). The net routes on its one layer; every cell is checked on both layers and every track is written
    /// on both (the paths gate rates the chain by max flow over the two equal copies). Empty = no twin on the board.
    twin: Vec<i8>,
    /// ground nets other than gnd (model `return_nets`: reference-planes.json grounds and the gate kicad_happy grounds):
    /// their fixed vias / through-hole pads count as returns (RP-001 counts any ground via) and their own vias need none
    gnds: Vec<i32>,
    /// isolation partner indexes (fixed, routed) per group g: only the items whose group has a pair value with g, on
    /// 2 mm buckets; prad[g] = the largest pair value of g. The main queries keep the old radius and these add the far
    /// partners (RELAY-4: a 9.65 mm screw-hole value made every query 10 mm wide). Empty = the main index alone, at
    /// the largest pair value (unit tests that set iso by hand).
    pidx: Vec<(Index, Index)>,
    prad: Vec<f64>,
    /// nets that need no return via (model `return_exempt`: the gate's RP-001 exemptions, run.py --return-exempt)
    noret: Vec<i32>,
    /// isolation: the return ground of each net (the ground whose via has the smallest pair value with the net's vias:
    /// a field net returns on the field ground). Empty = gnd for every net (no pair rules, or one ground)
    rgn: Vec<i32>,
    /// reference-plane fill edge (model `ref_fill`, reffill.rs): the filled reference of each domain per outer layer
    /// and the domain of each net (si_planes D-124c). Default = no rule.
    rfill: reffill::RefFill,
}

/// Fixed-copper verdict of a grid site for one rule profile, shared by all nets: FREE, MULTI (blocked for every net),
/// n >= 0 (blocked for every net except n), ONLY(n) = -(n + 10) (blocked only for net n), COMPUTE (evaluate directly).
const FREE: i32 = -1;
const MULTI: i32 = -2;
const COMPUTE: i32 = -3;
const UNKNOWN: i32 = i32::MIN;

fn blocks(code: i32, net: i32) -> bool {
    code == MULTI || (code >= 0 && code != net) || (code <= -10 && -(code + 10) == net)
}

/// Track centre (half width hw, rule clearance clr, fast net) at (x, y) violates the clearance to item s. The same
/// predicate for fixed and routed items (exact geometry, .kicad_dru values).
fn track_hit(s: &Shape, x: f64, y: f64, hw: f64, clr: f64, fast: bool, plane_clr: f64, hole_clr: f64, eps: f64, pc: f64) -> bool {
    let mut need = hw + clr.max(s.clr).max(pc);
    if s.drill > 0.0 {
        if fast {
            need = need.max(hw + plane_clr);
        }
        // hole to copper (.kicad_dru hole_clearance, from the model), measured from the hole edge
        let (cx, cy) = match s.geo {
            Geo::Circ(cx, cy, _) => (cx, cy),
            Geo::Rect(a, b, c, d) => ((a + c) / 2.0, (b + d) / 2.0),
            Geo::Seg(..) => (f64::MAX, f64::MAX),
        };
        if ((x - cx).powi(2) + (y - cy).powi(2)).sqrt() - s.drill / 2.0 < hw + hole_clr + eps {
            return true;
        }
    }
    s.geo.dist(x, y) < need + eps
}

/// Via (radius vr, drill) at (x, y) against item s: 0 no hit, 1 hole-to-hole (any net, own net included),
/// 2 clearance hit (applies to other nets only), 3 own-net SMD pad under the via (applies to the own net only;
/// tools/pcbtool.py viapads), 4 = 2 and 3. The clearance hit mirrors every rule track_hit applies from the other
/// side, so a via that passes here never puts an existing track in violation: the plane clearance of a fast track to
/// a foreign drilled item (s_fast) and the hole-to-copper clearance of the via hole.
fn via_hit(s: &Shape, x: f64, y: f64, vr: f64, drill: f64, clr: f64, hth: f64, s_fast: bool, plane_clr: f64, hole_clr: f64, eps: f64, web: f64, pc: f64) -> u8 {
    if s.drill > 0.0 {
        let (cx, cy) = match s.geo {
            Geo::Circ(cx, cy, _) => (cx, cy),
            Geo::Rect(a, b, c, d) => ((a + c) / 2.0, (b + d) / 2.0),
            Geo::Seg(..) => (x + 99.0, y),
        };
        let cd = ((x - cx).powi(2) + (y - cy).powi(2)).sqrt();
        if cd - s.drill / 2.0 - drill / 2.0 < hth {
            return 1;
        }
    }
    let dd = s.geo.dist(x, y);
    let mut need = vr + clr.max(s.clr).max(pc);
    if s_fast {
        need = need.max(vr + plane_clr);
    }
    // antipad web (v6 fix 3c, Board::web): only between drilled items of two signal nets (web > 0 then)
    if web > 0.0 && s.drill > 0.0 {
        need = need.max(vr + web);
    }
    let other = dd < need + eps || dd < drill / 2.0 + hole_clr + eps;
    let own = s.kind == Kind::Pad && s.drill == 0.0 && dd < vr + 0.05;
    match (other, own) {
        (false, false) => 0,
        (true, false) => 2,
        (false, true) => 3,
        (true, true) => 4,
    }
}

impl Board {
    /// sig: the via is of a signal (non-plane) net (the antipad web rule applies against drilled signal items)
    /// g: isolation group of the via (Board::vgrp)
    fn vhit(&self, s: &Shape, x: f64, y: f64, vr: f64, drill: f64, clr: f64, hth: f64, sig: bool, g: u16) -> u8 {
        let s_fast = s.kind == Kind::Track && s.net >= 0 && {
            let l = (0..8).find(|&l| s.layers & (1 << l) != 0).unwrap_or(0);
            self.plane_rule(self.pflags(s.net as usize), l)
        };
        let web = if self.web_hard && sig && s.net >= 0 && !self.nets[s.net as usize].plane { self.web } else { 0.0 };
        let h = via_hit(s, x, y, vr, drill, clr, hth, s_fast, self.plane_clr, self.hole_clr, self.eps, web, self.pc(g, s));
        // an own-net via inside a viapads-allowed pad is legal (3 -> 0, 4 -> 2): the gate allow list names the pad
        if h >= 3 && self.is_vip(s) { if h == 4 { 2 } else { 0 } } else { h }
    }
    /// v8: a track centre on layer Some(l) (half width r) or a via (None, radius r) at (x, y) touches a rule area that
    /// does not allow it (KiCad items_not_allowed; EPS margin as the other fixed rules)
    fn keep_hit(&self, l: Option<usize>, x: f64, y: f64, r: f64) -> bool {
        self.keep.iter().any(|k| match l { Some(l) => k.tl & (1 << l) != 0, None => k.via } && k.touches(x, y, r + self.eps))
    }
    /// v8: the rated pin escape of a pad (bbox), if any: (width, length)
    fn esc_of(&self, s: &Shape) -> Option<(f64, f64, bool)> {
        let bb = s.geo.bbox();
        self.esc.iter().find(|e| (e.0.0 - bb.0).abs() < 1e-6 && (e.0.1 - bb.1).abs() < 1e-6 && (e.0.2 - bb.2).abs() < 1e-6
            && (e.0.3 - bb.3).abs() < 1e-6).map(|e| (e.1, e.2, e.3))
    }
    fn is_vip(&self, s: &Shape) -> bool {
        match s.geo {
            Geo::Rect(a, b, c, d) if s.kind == Kind::Pad && s.drill == 0.0 => self.vip.iter().any(|v| {
                (v.0 - a).abs() < 1e-6 && (v.1 - b).abs() < 1e-6 && (v.2 - c).abs() < 1e-6 && (v.3 - d).abs() < 1e-6
            }),
            _ => false,
        }
    }
    /// query reach: the largest clearance of any item, and the largest isolation pair value (the return-via spacing
    /// keeps maxc: it is a pre-filter, the site check applies the pair value)
    fn reach(&self) -> f64 {
        match &self.iso {
            Some(i) => self.maxc.max(i.tab.iter().cloned().fold(0.0, f64::max)),
            None => self.maxc,
        }
    }
    /// copper layers that are planes (not routable)
    fn plane_mask(&self) -> u8 {
        let all = ((1u16 << self.layer_names.len()) - 1) as u8;
        self.routable.iter().fold(all, |m, &l| m & !(1 << l))
    }
    /// return ground of a net (rgn, else gnd)
    fn rg(&self, net: usize) -> i32 {
        self.rgn.get(net).cloned().unwrap_or(self.gnd)
    }
    /// a via of net n is a return via (any ground: RP-001 counts a via of any ground net)
    fn is_ret_net(&self, n: i32) -> bool {
        n >= 0 && (n == self.gnd || self.gnds.contains(&n))
    }
    /// index of a return ground in [gnd] + gnds (the return-site cache plane)
    fn rg_slot(&self, g: i32) -> usize {
        if g == self.gnd { 0 } else { self.gnds.iter().position(|&q| q == g).map(|i| i + 1).unwrap_or(0) }
    }
    /// parallel copy layer of a net, if any
    fn twin_of(&self, net: usize) -> Option<usize> {
        self.twin.get(net).and_then(|&t| if t >= 0 { Some(t as usize) } else { None })
    }
    /// A fan-out via of plane net `net` at (x, y) lies inside a plane outline of the net (true when the model gives none)
    fn in_plane(&self, net: usize, x: f64, y: f64) -> bool {
        let mut any = false;
        for (n, p) in &self.ppoly {
            if *n == net {
                if pt_in_poly(x, y, p) {
                    return true;
                }
                any = true;
            }
        }
        !any
    }
    /// isolation: pair value between an item of group g and item s (0 without pair rules)
    fn pc(&self, g: u16, s: &Shape) -> f64 {
        match &self.iso {
            Some(i) => i.tab[g as usize * i.n + s.grp as usize],
            None => 0.0,
        }
    }
    /// isolation: the Iso::var entry of a net (0 = no net; always 0 without pair rules)
    fn iv(&self, net: i32) -> u32 {
        if net >= 0 { self.niv.get(net as usize).cloned().unwrap_or(0) } else { 0 }
    }
    /// isolation: group of a track piece a-b (half width hw) or a via (disc, `via`) of var entry iv
    fn grp_at(&self, iv: u32, via: bool, a: (f64, f64), b: (f64, f64), hw: f64) -> u16 {
        match &self.iso {
            None => 0,
            Some(i) => {
                let mut bits = 0usize;
                for (k, polys) in i.regs.iter().enumerate() {
                    if polys.iter().any(|p| cap_touches(a, b, hw, p)) {
                        bits |= 1 << k;
                    }
                }
                i.var[iv as usize][via as usize][bits]
            }
        }
    }
    fn add(&mut self, mut s: Shape) -> usize {
        if self.iso.is_some() && s.kind != Kind::Pad {
            let iv = self.iv(s.net);
            s.grp = match s.geo {
                Geo::Seg(ax, ay, bx, by, hw) => self.grp_at(iv, false, (ax, ay), (bx, by), hw),
                Geo::Circ(x, y, r) => self.grp_at(iv, s.kind == Kind::Via, (x, y), (x, y), r),
                Geo::Rect(a, b, c, d) => self.grp_at(iv, false, ((a + c) / 2.0, (b + d) / 2.0), ((a + c) / 2.0, (b + d) / 2.0), ((c - a).min(d - b)) / 2.0),
            };
        }
        let id = self.shapes.len();
        if s.owner < 0 {
            self.idx.insert(id as u32, &s);
        } else {
            self.sidx.insert(id as u32, &s);
        }
        if let (false, Some(i)) = (self.pidx.is_empty(), &self.iso) {
            let n = i.n;
            let gs: Vec<usize> = (0..n).filter(|&g| i.tab[g * n + s.grp as usize] > 0.0).collect();
            for g in gs {
                if s.owner < 0 { self.pidx[g].0.insert(id as u32, &s); } else { self.pidx[g].1.insert(id as u32, &s); }
            }
        }
        self.shapes.push(s);
        id
    }
    fn near_in(&self, ix: &Index, l: usize, x: f64, y: f64, r: f64, f: &mut dyn FnMut(u32, &Shape) -> bool) -> bool {
        let (i0, i1) = (ix.range(x - r, ix.x0, ix.nx), ix.range(x + r, ix.x0, ix.nx));
        let (j0, j1) = (ix.range(y - r, ix.y0, ix.ny), ix.range(y + r, ix.y0, ix.ny));
        for j in j0..=j1 {
            for i in i0..=i1 {
                for &id in &ix.cells[l][j * ix.nx + i] {
                    let s = &self.shapes[id as usize];
                    if s.alive && f(id, s) {
                        return true;
                    }
                }
            }
        }
        false
    }
    fn inside(&self, x: f64, y: f64, r: f64) -> bool {
        let (a, b, c, d) = self.edge;
        let m = self.edge_clr + r;
        x - m >= a && x + m <= c && y - m >= b && y + m <= d
            && !self.edges.iter().any(|e| seg_dist(x, y, e.0, e.1, e.2, e.3) < m)
    }
    fn track_r(&self, hw: f64, plane_clr: f64) -> f64 {
        hw + self.base_reach().max(plane_clr).max(self.hole_clr) + 0.01
    }
    /// radius of the main index queries: maxc, or the largest pair value too when there are no partner indexes
    fn base_reach(&self) -> f64 {
        if self.pidx.is_empty() { self.reach() } else { self.maxc }
    }
    /// near_in over the main index (fixed or routed) at radius r, then over the isolation partner index of group g at
    /// half + the group's largest pair value. f may see an item twice: every caller is idempotent or dedupes by id.
    fn near_iso(&self, soft: bool, g: u16, l: usize, x: f64, y: f64, r: f64, half: f64, f: &mut dyn FnMut(u32, &Shape) -> bool) -> bool {
        if self.near_in(if soft { &self.sidx } else { &self.idx }, l, x, y, r, f) {
            return true;
        }
        if let Some((pf, ps)) = self.pidx.get(g as usize) {
            let rad = half + self.prad[g as usize] + 0.01;
            if rad > r {
                return self.near_in(if soft { ps } else { pf }, l, x, y, rad, f);
            }
        }
        false
    }
    /// Plane-rule flags of a net: bit 0 fast (plane clearance on every layer), bit 1 pref (on the layers in `adj`),
    /// bits 2..6 the reference domain (reffill.rs), bit 7 soft reference (priced in search_n, not blocked here).
    /// Bits 8 and up: the isolation var entry of the net (0 without pair rules), so the fixed-copper memo is per entry.
    fn pflags(&self, net: usize) -> u32 {
        let n = &self.nets[net];
        n.fast as u32 | (n.pref as u32) << 1 | (self.rfill.dom.get(net).copied().unwrap_or(0) as u32 & 0x1f) << 2
            | (self.rfill.soft.get(net).copied().unwrap_or(false) as u32) << 7 | self.iv(net as i32) << 8
    }
    /// The plane clearance to foreign drilled items applies to a track with flags pf on copper layer l.
    fn plane_rule(&self, pf: u32, l: usize) -> bool {
        pf & 1 != 0 || (pf & 2 != 0 && self.adj & (1 << l) != 0)
    }
    /// Fixed-copper verdict (FREE / MULTI / n) of a track centre for the profile (hw, clr, plane flags pf).
    fn track_fixed_code(&self, l: usize, x: f64, y: f64, hw: f64, clr: f64, pf: u32, plane_clr: f64) -> i32 {
        if !self.inside(x, y, hw) || self.keep_hit(Some(l), x, y, hw) {
            return MULTI;
        }
        let fast = self.plane_rule(pf, l);
        // a net under the plane rule keeps out of the plane voids that rule areas make: an area that forbids pour on a
        // plane layer (isolation work, INPUT-4D2A gate planes 3: unknown-driver runs over the H1 / H2 screw-hole voids)
        if fast && self.keep.iter().any(|k| k.pl & self.plane_mask() != 0 && k.touches(x, y, hw + self.eps)) {
            return MULTI;
        }
        // the reference-plane fill edge (reffill.rs, si_planes D-124c): the centre of a net with a domain (bits 2..7)
        // stays on the filled reference of its domain on the adjacent plane, or in its own pad / via anchor discs
        let mut code = FREE;
        // (gate scope 2026-11-02: a soft net, bit 7, is not blocked here; search_n prices its off-reference steps)
        if pf & 0x7c != 0 && pf & 0x80 == 0 && self.adj & (1 << l) != 0 {
            code = self.rfill.code(l, ((pf >> 2) & 0x1f) as u8, x, y, self.eps);
            if code == MULTI {
                return MULTI;
            }
        }
        let g = self.grp_at(pf >> 8, false, (x, y), (x, y), hw);
        self.near_iso(false, g, l, x, y, self.track_r(hw, plane_clr), hw, &mut |_, s| {
            if !track_hit(s, x, y, hw, clr, fast, plane_clr, self.hole_clr, self.eps, self.pc(g, s)) {
                return false;
            }
            if s.net < 0 || (code >= 0 && code != s.net) {
                code = MULTI;
                return true;
            }
            code = s.net;
            false
        });
        code
    }
    /// Number of distinct routed items of other nets that a track centre conflicts with; `hits` collects their ids.
    fn track_soft(&self, net: usize, l: usize, x: f64, y: f64, hw: f64, plane_clr: f64, hits: Option<&mut Vec<u32>>) -> i32 {
        let (clr, fast) = (self.nets[net].clr, self.plane_rule(self.pflags(net), l));
        let g = self.grp_at(self.iv(net as i32), false, (x, y), (x, y), hw);
        let mut seen: Vec<u32> = Vec::new();
        self.near_iso(true, g, l, x, y, self.track_r(hw, plane_clr), hw, &mut |id, s| {
            if s.net != net as i32 && !seen.contains(&id) && track_hit(s, x, y, hw, clr, fast, plane_clr, self.hole_clr, self.eps, self.pc(g, s)) {
                seen.push(id);
            }
            false
        });
        if let Some(o) = hits {
            for id in &seen {
                if !o.contains(id) {
                    o.push(*id);
                }
            }
        }
        seen.len() as i32
    }
    /// Track centre of `net` (half width hw) at (x, y) on copper layer l: -1 = blocked by fixed copper or the edge,
    /// k >= 0 = number of distinct routed items of other nets it conflicts with. `hits` collects their shape ids.
    fn track_cost(&self, net: usize, l: usize, x: f64, y: f64, hw: f64, plane_clr: f64, mut hits: Option<&mut Vec<u32>>) -> i32 {
        let n = &self.nets[net];
        if blocks(self.track_fixed_code(l, x, y, hw, n.clr, self.pflags(net), plane_clr), net as i32) {
            return -1;
        }
        // parallel copy: the same centre on the twin layer must be legal too
        if let Some(t) = self.twin_of(net).filter(|&t| t != l) {
            if blocks(self.track_fixed_code(t, x, y, hw, n.clr, self.pflags(net), plane_clr), net as i32) {
                return -1;
            }
            let k = self.track_soft(net, t, x, y, hw, plane_clr, hits.as_deref_mut());
            return k + self.track_soft(net, l, x, y, hw, plane_clr, hits);
        }
        self.track_soft(net, l, x, y, hw, plane_clr, hits)
    }
    fn track_ok(&self, net: usize, l: usize, x: f64, y: f64, hw: f64, plane_clr: f64) -> bool {
        self.track_cost(net, l, x, y, hw, plane_clr, None) == 0
    }
    fn via_r(&self, d: f64, hth: f64) -> f64 {
        // v7 speed: the web enters via_hit only as a hard rule; as a priced limit (web_items) it does not widen the query
        d / 2.0 + self.base_reach().max(self.plane_clr).max(hth).max(self.hole_clr).max(if self.web_hard { self.web } else { 0.0 }) + 0.01
    }
    /// Fixed-copper verdict of a via site for the profile (d, drill, clr): see FREE / MULTI / n / ONLY / COMPUTE.
    /// iv: the isolation var entry of the via's net (Board::iv)
    fn via_fixed_code(&self, x: f64, y: f64, d: f64, drill: f64, clr: f64, hth: f64, sig: bool, iv: u32) -> i32 {
        let vr = d / 2.0;
        if !self.inside(x, y, vr) || self.keep_hit(None, x, y, vr) {
            return MULTI;
        }
        let g = self.grp_at(iv, true, (x, y), (x, y), vr);
        let (mut a, mut b): (Vec<i32>, Vec<i32>) = (Vec::new(), Vec::new());
        let r = self.via_r(d, hth);
        for l in 0..self.layer_names.len() {
            let multi = self.near_iso(false, g, l, x, y, r, vr, &mut |_, s| {
                let h = self.vhit(s, x, y, vr, drill, clr, hth, sig, g);
                if h == 1 {
                    return true;
                }
                if h == 2 || h == 4 {
                    if s.net < 0 {
                        return true;
                    }
                    if !a.contains(&s.net) {
                        a.push(s.net);
                    }
                }
                if (h == 3 || h == 4) && !b.contains(&s.net) {
                    b.push(s.net);
                }
                a.len() > 1
            });
            if multi {
                return MULTI;
            }
        }
        // blocked for net q iff (a without q) is not empty or q is in b
        match (a.len(), b.len()) {
            (0, 0) => FREE,
            (1, _) => if b.contains(&a[0]) { MULTI } else { a[0] },
            (0, 1) => -(b[0] + 10),
            _ => COMPUTE,
        }
    }
    fn via_code_blocks(&self, code: i32, net: usize, x: f64, y: f64, d: f64, drill: f64, hth: f64) -> bool {
        if code == COMPUTE {
            let (vr, clr, r, sig) = (d / 2.0, self.nets[net].clr, self.via_r(d, hth), !self.nets[net].plane);
            let g = self.grp_at(self.iv(net as i32), true, (x, y), (x, y), vr);
            return (0..self.layer_names.len()).any(|l| self.near_iso(false, g, l, x, y, r, vr, &mut |_, s| {
                match self.vhit(s, x, y, vr, drill, clr, hth, sig, g) {
                    1 | 4 => true,
                    2 => s.net != net as i32,
                    3 => s.net == net as i32,
                    _ => false,
                }
            }));
        }
        blocks(code, net as i32)
    }
    /// Distinct routed items a via of `net` conflicts with (hole to hole with any net, clearance with other nets).
    fn via_soft(&self, net: usize, x: f64, y: f64, d: f64, drill: f64, hth: f64, hits: Option<&mut Vec<u32>>) -> i32 {
        let vr = d / 2.0;
        let clr = self.nets[net].clr;
        let sig = !self.nets[net].plane;
        let r = self.via_r(d, hth);
        let g = self.grp_at(self.iv(net as i32), true, (x, y), (x, y), vr);
        let mut seen: Vec<u32> = Vec::new();
        // routed items are tracks on routable layers and through vias (all layers): the routable layers see them all
        for &l in &self.routable {
            self.near_iso(true, g, l, x, y, r, vr, &mut |id, s| {
                if seen.contains(&id) {
                    return false;
                }
                let h = self.vhit(s, x, y, vr, drill, clr, hth, sig, g);
                if h == 1 || ((h == 2 || h == 4) && s.net != net as i32) {
                    seen.push(id);
                }
                false
            });
        }
        if let Some(o) = hits {
            for id in &seen {
                if !o.contains(id) {
                    o.push(*id);
                }
            }
        }
        seen.len() as i32
    }
    /// Through via of `net` (diameter d, drill) at (x, y): -1 blocked, k >= 0 soft conflicts (as track_cost).
    fn via_cost(&self, net: usize, x: f64, y: f64, d: f64, drill: f64, hth: f64, hits: Option<&mut Vec<u32>>) -> i32 {
        let code = self.via_fixed_code(x, y, d, drill, self.nets[net].clr, hth, !self.nets[net].plane, self.iv(net as i32));
        if self.via_code_blocks(code, net, x, y, d, drill, hth) {
            return -1;
        }
        self.via_soft(net, x, y, d, drill, hth, hits)
    }
    /// Rebuild the spatial indexes without the dead (ripped-up) items.
    fn compact(&mut self) {
        let shapes: Vec<Shape> = self.shapes.drain(..).filter(|s| s.alive).collect();
        for ix in [&mut self.idx, &mut self.sidx].into_iter().chain(self.pidx.iter_mut().flat_map(|p| [&mut p.0, &mut p.1])) {
            for l in ix.cells.iter_mut() {
                for c in l.iter_mut() {
                    c.clear();
                }
            }
        }
        for s in shapes {
            self.add(s);
        }
    }
}

#[derive(Copy, Clone, PartialEq)]
struct Node {
    f: f32,
    g: f32,
    i: u32,
}
impl Eq for Node {}
impl Ord for Node {
    fn cmp(&self, o: &Self) -> Ordering {
        o.f.partial_cmp(&self.f).unwrap_or(Ordering::Equal)
    }
}
impl PartialOrd for Node {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}

struct Grid {
    x0: f64,
    y0: f64,
    p: f64,
    nx: usize,
    ny: usize,
    nr: usize,
    cache: Vec<u8>,  // 0 unknown, 1 blocked, 2 + k: k soft conflicts (capped)
    vcache: Vec<u8>, // same, for a via at (ix, iy)
    dcache: Vec<u8>, // same, for the midpoint of a diagonal step: centre of the cell square (ix .. ix+1, iy .. iy+1)
    hist: Vec<f32>,  // PathFinder history cost per routable cell
    vhist: Vec<f32>,
    pres: f32,       // PathFinder present-congestion factor
    g: Vec<f32>,
    from: Vec<u32>,
    seen: Vec<u32>,
    /// expanded in search generation sgen: a weighted A* (h = 1.15 x octile) does not reopen an expanded cell, so a
    /// search expands each cell at most once (v3 reopened cells about 28 times each: /J2_LEDG_A hit 8 M pops on 0.3 M
    /// cells). The path cost stays within the heuristic weight of the optimum; a failed search still visited every
    /// reachable cell, so Err(false) stays a proof.
    closed: Vec<u32>,
    tgt: Vec<u32>,
    sgen: u32,
    tgen: u32,
    /// v7: track length (mm, vias at Board::via_len) of the best path to each cell in the present search: the DRU length
    /// bound (Ctx::len_cap) prunes a step whose length plus the distance to the nearest target box is over the cap
    glen: Vec<f32>,
    /// layer negotiation: PathFinder history of the layer choice of a one-layer net (Ctx::layer_choice), per net x
    /// routable layer index (sized on first use). Each iteration that ends with the net in conflict adds --hist to the
    /// layer its copper is on; route_one_layer prices a layer at its A* cost x (1 + this history).
    lhist: Vec<f32>,
    /// --seed: the seeded cost field of the search (seed.rs); empty without a seed
    jit: seed::Jitter,
}

impl Grid {
    fn cell(&self, i: usize) -> (usize, usize, usize) {
        let n = self.nx * self.ny;
        (i / n, (i % n) / self.nx, i % self.nx)
    }
    fn xy(&self, ix: usize, iy: usize) -> (f64, f64) {
        (self.x0 + ix as f64 * self.p, self.y0 + iy as f64 * self.p)
    }
    fn at(&self, x: f64, y: f64) -> (usize, usize) {
        let ix = ((x - self.x0) / self.p).round().clamp(0.0, (self.nx - 1) as f64) as usize;
        let iy = ((y - self.y0) / self.p).round().clamp(0.0, (self.ny - 1) as f64) as usize;
        (ix, iy)
    }
    fn reset_cache(&mut self) {
        self.cache.iter_mut().for_each(|c| *c = 0);
        self.vcache.iter_mut().for_each(|c| *c = 0);
        self.dcache.iter_mut().for_each(|c| *c = 0);
    }
}

struct Ctx<'a> {
    bd: &'a mut Board,
    gr: Grid,
    o: &'a Opts,
    /// soft conflicts block (final legal re-route of nets that were ripped up)
    strict: bool,
    /// per net: fixed shape ids (stable: fixed items are never removed) of components proved unreachable past fixed
    /// copper, and the reason. Fixed copper never changes and soft copper never blocks a non-strict search, so the
    /// proof holds for the whole run; later rip-ups skip these components instead of repeating an exhaustive search.
    dead: Vec<(Vec<usize>, String)>,
    memo: Vec<((u32, (u64, u64, u64)), Vec<i32>)>,
    memo_w: Vec<f64>,
    /// per via grid site: 0 unknown, 1 a GND return is possible within --return-r (fixed copper only), 2 not possible
    rcache: Vec<u8>,
    /// via grid sites banned for the net being routed (its return via could not be placed there)
    ban: Vec<usize>,
    /// pad-entry neck zones of the net being routed (v6 fix 4): (layer mask, pad, zone radius from the pad edge, neck
    /// half width). Outside them a track keeps its full width.
    neck: Vec<(u8, Geo, f64, f64)>,
    /// v7: DRU length limit of the present join: the length the path may still add (None: no limit), and the target
    /// item boxes (the lower bound of the remaining length is the octile distance to the nearest box)
    len_cap: Option<f64>,
    len_boxes: Vec<(f64, f64, f64, f64)>,
    /// v7: the step cost is the track length only (no history, no present cost, heuristic weight 1): the shortest path
    /// under the length cap, when the congestion-priced search found none
    len_mode: bool,
    /// v7 fix 5: a return via may take a site in conflict with routed copper (v6 behaviour). route_net clears it: the
    /// returns of a layer change must be conflict-free, and only after RET_SOFT_AFTER rejected layer changes of one net
    /// is a conflicting site taken again
    ret_soft: bool,
    /// v8: half-width floor per copper layer of the net being routed (Net::min_wl / 2); set by set_neck
    lfloor: Vec<f64>,
    /// v8: the present join targets only leaf pads of a power net (pads in no power chain): only then do they neck
    /// below the current floor (route_net joins them last, so no chain current passes their necks)
    leaf_necks: bool,
    /// v8b: straight pin escape stubs of a rated pad (fixed pad shape id -> stubs), legal against fixed copper (cached:
    /// fixed copper never changes). See Ctx::escape_stubs.
    stubs: std::collections::HashMap<usize, Vec<Stub>>,
    /// v8b: the price of the escape stubs in the present search (Ctx::stub_price): source stub end cell -> start cost,
    /// target stub end cell -> cost added to the step into it (a target cell is never expanded, so only a path that
    /// ends there pays it)
    stub_cost: (std::collections::HashMap<usize, f32>, std::collections::HashMap<usize, f32>),
    /// v9 length recovery (recover_length): the search prices only the routing objective (track length x layer cost,
    /// via cost, antipad web, stubs), with no PathFinder history, and its heuristic is admissible (octile distance to
    /// the nearest target box, weight 1). The negotiation terms only resolve conflicts; once the copper is legal they
    /// leave detours that nothing removes (v8, NET-CORE: /ETH_TXD0 40.7 mm against 19.5 mm in v4).
    recover: bool,
    /// reuse (reuse.rs): a plane net keeps its routed fan-out copper and fans out only the pads that no own routed copper
    /// touches (iteration 1 of a reuse route); false: fanout_net rips the net's copper and fans out every pad
    fan_keep: bool,
}

/// v8b: one straight pin escape of a rated pad: routable layer index, start (a grid cell inside the pad, END_IN from its
/// edge), end grid cell (index with the layer) and its centre, half width (the pad's narrow side / 2), length.
#[derive(Clone, Copy, Debug)]
struct Stub {
    r: usize,
    a: (f64, f64),
    cell: usize,
    b: (f64, f64),
    hw: f64,
    len: f64,
}

/// Exact clearance audit of all routed copper at the end of an iteration (the PathFinder "overuse").
#[derive(Default)]
struct Audit {
    /// distinct pairs of routed items that violate the clearance
    pairs: usize,
    /// conflicting samples (0.5 pitch along tracks, one per via), weighted by the items hit
    samples: u32,
    /// samples of routed copper that hit fixed copper (must stay 0: the search never steps there)
    hard: u32,
    per_net: Vec<u32>,
    partners: Vec<Vec<usize>>,
    /// the conflicting item pairs (shape ids)
    pair_ids: Vec<(u32, u32)>,
}

fn code(k: i32) -> u8 {
    if k < 0 { 1 } else { 2 + (k.min(200) as u8) }
}

impl<'a> Ctx<'a> {
    /// Half width of a track of the net being routed at (x, y) on layer l: the neck half width inside a pad-entry zone
    /// (v6 fix 4), else hw.
    fn hw_at(&self, l: usize, x: f64, y: f64, hw: f64) -> f64 {
        let mut h = self.full_hw(l, hw);
        for &(lm, g, zone, nh) in &self.neck {
            if nh < h && lm & (1 << l) != 0 && g.dist(x, y) <= zone {
                h = nh;
            }
        }
        h
    }
    /// Pad-entry neck zones for `net` at half width hw (v6 fix 4: no power neckdown). A pad narrower than the track
    /// gets a neck of the pad's narrower side (never below the net's current width min_w) for the length the pad
    /// geometry needs: up to hw + clearance (+ one pitch for the grid) from the pad edge, where a full-width track no
    /// longer meets the neighbours of a pad row.
    fn set_neck(&mut self, net: usize, hw: f64) {
        self.neck.clear();
        let (clr, floor, power) = (self.bd.nets[net].clr, self.bd.nets[net].min_w / 2.0, self.bd.nets[net].power);
        // a plane net is fanned out pad by pad with the width of each pad's own chain (pad_need), no net-wide floor
        self.lfloor = if self.bd.nets[net].plane { Vec::new() } else { self.bd.nets[net].min_wl.iter().map(|w| w / 2.0).collect() };
        let p = self.gr.p;
        for s in self.bd.shapes.iter().filter(|s| s.alive && s.net == net as i32 && s.kind == Kind::Pad && s.owner < 0) {
            let (a, b, c, d) = s.geo.bbox();
            // v8: the full width at this pad is the widest layer floor of the pad's layers (per-layer current width)
            let full = (0..8).filter(|&l| s.layers & (1 << l) != 0).map(|l| self.full_hw(l, hw)).fold(hw, f64::max);
            let (cx, cy) = ((a + c) / 2.0, (b + d) / 2.0);
            let chain = self.bd.pad_need.iter().any(|q| (q.0 - cx).abs() < 1e-6 && (q.1 - cy).abs() < 1e-6 && q.2 > 0.0);
            if self.bd.esc_of(s).is_some() {
                // v8b: a rated pin has no neck zone. The search keeps the full width there; a narrower entry is only
                // one straight escape stub (Ctx::escape_stubs, the paths gate pin_escape rule by construction). v8
                // necked a zone around the pad: the A* bent inside it or ran along the pad row channel (H7-CORE
                // U2.3: 4 narrow pieces, 1.0 mm), and no repair afterwards made one legal piece of it.
                continue;
            }
            // v8: a pad of a power net in no power chain (current-paths.json) carries no design current: the paths
            // gate does not check it, so its entry necks like a signal pad; a chain pad keeps the current floor
            let fl = if power && !chain && self.leaf_necks { 0.0 } else { floor };
            let nh = ((c - a).min(d - b) / 2.0).max(fl);
            if nh < full - 1e-9 {
                self.neck.push((s.layers, s.geo, full + clr + p, nh));
            }
        }
    }
    /// v8b: the straight escape stubs of rated pad `sid` (model pad escape) for `net`: tools/pcbtool.py pin_escape gives
    /// the pin rating to ONE track that starts on the pad, no narrower than the pad's narrow side and no longer than its
    /// long side. A stub starts on a grid cell inside the pad (cells_of: END_IN from the edge), goes straight (any angle)
    /// to a grid cell outside the pad, not longer than the long side less 1 um, at the pad's narrow width, legal against
    /// fixed copper at every half-pitch sample. For each end cell the shortest stub is kept. The search goes on from the
    /// end cell at the full width, so the narrow piece is one piece by construction. Any angle: ESP32-CORE U3.2 / U3.3
    /// (/SW2_LX, /SW1_LX, 0.5 mm pitch, 0.55 mm current width) have no 45 degree stub past the U3.1 / U3.4 corners, and
    /// two straight stubs leave the full widths 0.5 mm apart (c1: strict re-route open). Cached per pad (fixed copper
    /// never changes).
    fn escape_stubs(&mut self, net: usize, sid: usize) -> Vec<Stub> {
        if let Some(v) = self.stubs.get(&sid) {
            return v.clone();
        }
        let s = self.bd.shapes[sid].clone();
        let Some((ew, el, _)) = self.bd.esc_of(&s) else { return Vec::new() };
        let (clr, pf, pc) = (self.bd.nets[net].clr, self.bd.pflags(net), self.o.plane_clr);
        let (p, nx, ny) = (self.gr.p, self.gr.nx as i64, self.gr.ny as i64);
        let n = self.gr.nx * self.gr.ny;
        let hw = ew / 2.0;
        let lmax = el - 1e-3;
        let kr = (lmax / p).floor() as i64;
        let mut best: std::collections::BTreeMap<usize, Stub> = std::collections::BTreeMap::new();
        for c in self.cells_of(&s, self.bd.nets[net].layers) {
            let (r, iy, ix) = self.gr.cell(c);
            let l = self.bd.routable[r];
            let a = self.gr.xy(ix, iy);
            if blocks(self.bd.track_fixed_code(l, a.0, a.1, hw, clr, pf, pc), net as i32) {
                continue;
            }
            for dj in -kr..=kr {
                for di in -kr..=kr {
                    let (jx, jy) = (ix as i64 + di, iy as i64 + dj);
                    if jx < 0 || jy < 0 || jx >= nx || jy >= ny {
                        continue;
                    }
                    let len = p * ((di * di + dj * dj) as f64).sqrt();
                    let b = self.gr.xy(jx as usize, jy as usize);
                    if len > lmax || len < 1e-9 || s.geo.dist(b.0, b.1) <= 1e-9 {
                        continue;
                    }
                    let cell = r * n + jy as usize * self.gr.nx + jx as usize;
                    if matches!(best.get(&cell), Some(o) if o.len <= len + 1e-9) {
                        continue;
                    }
                    let k = (len / (p * 0.5)).ceil().max(1.0) as usize;
                    let ok = (1..=k).all(|t| {
                        let f = t as f64 / k as f64;
                        !blocks(self.bd.track_fixed_code(l, a.0 + (b.0 - a.0) * f, a.1 + (b.1 - a.1) * f, hw, clr, pf, pc), net as i32)
                    });
                    if ok {
                        best.insert(cell, Stub { r, a, cell, b, hw, len });
                    }
                }
            }
        }
        let mut v: Vec<Stub> = best.into_values().collect();
        v.sort_by(|x, y| x.len.partial_cmp(&y.len).unwrap().then(x.cell.cmp(&y.cell)));
        self.stubs.insert(sid, v.clone());
        v
    }
    /// v8b: the search price of a stub, as the A* step cost under it (length x (1 + history) x (1 + present cost x soft
    /// conflicts at the stub width), half-pitch samples, the end cell excluded: the path pays that one). None when
    /// strict and the stub meets routed copper. The negotiation then sees the stubs like any other copper.
    fn stub_price(&self, net: usize, st: &Stub) -> Option<f32> {
        let l = self.bd.routable[st.r];
        let (p, n, pres) = (self.gr.p, self.gr.nx * self.gr.ny, self.gr.pres as f64);
        let k = (st.len / (p * 0.5)).ceil().max(1.0) as usize;
        let seg = st.len / k as f64;
        let mut cost = 0.0f64;
        for t in 0..k {
            let f = t as f64 / k as f64;
            let (x, y) = (st.a.0 + (st.b.0 - st.a.0) * f, st.a.1 + (st.b.1 - st.a.1) * f);
            let (cx, cy) = self.gr.at(x, y);
            let c = st.r * n + cy * self.gr.nx + cx;
            let soft = self.bd.track_soft(net, l, x, y, st.hw, self.o.plane_clr, None);
            if soft > 0 && self.strict {
                return None;
            }
            let hc = if self.recover { 0.0 } else { self.gr.hist[c] as f64 };
            cost += seg * (1.0 + hc) * (1.0 + pres * soft as f64);
        }
        Some(cost as f32)
    }
    /// v8: the full half width of the net being routed on copper layer l: hw, raised to the layer floor
    fn full_hw(&self, l: usize, hw: f64) -> f64 {
        self.lfloor.get(l).map(|&f| hw.max(f)).unwrap_or(hw)
    }
    /// None: blocked; Some(k): k soft conflicts.
    fn cost(&mut self, net: usize, i: usize, hw: f64) -> Option<u32> {
        let mut c = self.gr.cache[i];
        if c == 0 {
            let (r, iy, ix) = self.gr.cell(i);
            let (x, y) = self.gr.xy(ix, iy);
            let l = self.bd.routable[r];
            let hw = self.hw_at(l, x, y, hw);
            let (clr, pf) = (self.bd.nets[net].clr, self.bd.pflags(net));
            let pc = self.o.plane_clr;
            let fixed = match self.memo_slot(0, (hw.to_bits(), clr.to_bits(), pf as u64)) {
                Some(m) => {
                    if self.memo[m].1[i] == UNKNOWN {
                        self.memo[m].1[i] = self.bd.track_fixed_code(l, x, y, hw, clr, pf, pc);
                    }
                    self.memo[m].1[i]
                }
                None => self.bd.track_fixed_code(l, x, y, hw, clr, pf, pc),
            };
            c = if blocks(fixed, net as i32) { 1 } else { code(self.bd.track_soft(net, l, x, y, hw, pc, None)) };
            if let Some(t) = self.bd.twin_of(net).filter(|&t| t != l) {
                c = self.twin_code(net, c, t, i, hw, false);
            }
            self.gr.cache[i] = c;
        }
        if c == 1 { None } else { Some((c - 2) as u32) }
    }
    /// parallel copy: the cell code (1 blocked, 2 + k soft conflicts) combined with the same cell on twin layer t
    fn twin_code(&mut self, net: usize, c: u8, t: usize, i: usize, hw: f64, mid: bool) -> u8 {
        if c == 1 {
            return 1;
        }
        let n = self.gr.nx * self.gr.ny;
        let Some(rt) = self.bd.routable.iter().position(|&q| q == t) else { return 1 };
        let it = rt * n + i % n;
        let ct = if mid { self.mcost(net, it, hw) } else { self.cost(net, it, hw) };
        match ct {
            None => 1,
            Some(k) => code((c - 2) as i32 + k as i32),
        }
    }
    /// Track centre at the midpoint of a diagonal step (index of the lower-left cell of the square). The cell
    /// centres carry the EPS margin, which covers the bulge of a 0.05 mm orthogonal step (0.05^2 / (8 x 0.225) =
    /// 0.0014 mm) but not of a 0.0707 mm diagonal one (0.0028 mm): its midpoint is checked with the same rule.
    fn mcost(&mut self, net: usize, mi: usize, hw: f64) -> Option<u32> {
        let mut c = self.gr.dcache[mi];
        if c == 0 {
            let (r, iy, ix) = self.gr.cell(mi);
            let (x, y) = self.gr.xy(ix, iy);
            let (x, y) = (x + self.gr.p / 2.0, y + self.gr.p / 2.0);
            let l = self.bd.routable[r];
            let hw = self.hw_at(l, x, y, hw);
            let (clr, pf) = (self.bd.nets[net].clr, self.bd.pflags(net));
            let pc = self.o.plane_clr;
            let fixed = match self.memo_slot(1, (hw.to_bits(), clr.to_bits(), pf as u64)) {
                Some(m) => {
                    if self.memo[m].1[mi] == UNKNOWN {
                        self.memo[m].1[mi] = self.bd.track_fixed_code(l, x, y, hw, clr, pf, pc);
                    }
                    self.memo[m].1[mi]
                }
                None => self.bd.track_fixed_code(l, x, y, hw, clr, pf, pc),
            };
            c = if blocks(fixed, net as i32) { 1 } else { code(self.bd.track_soft(net, l, x, y, hw, pc, None)) };
            if let Some(t) = self.bd.twin_of(net).filter(|&t| t != l) {
                c = self.twin_code(net, c, t, mi, hw, true);
            }
            self.gr.dcache[mi] = c;
        }
        if c == 1 { None } else { Some((c - 2) as u32) }
    }
    fn vcost(&mut self, net: usize, ix: usize, iy: usize) -> Option<u32> {
        let k = iy * self.gr.nx + ix;
        let mut c = self.gr.vcache[k];
        if c == 0 {
            let (x, y) = self.gr.xy(ix, iy);
            let n = &self.bd.nets[net];
            let (d, dr, clr, hth, sig) = (n.via_d, n.via_drill, n.clr, self.o.hth, !n.plane);
            let iv = self.bd.iv(net as i32);
            let fixed = match self.memo_slot(2 + 4 * iv, (d.to_bits(), dr.to_bits(), clr.to_bits() | (sig as u64) << 63)) {
                Some(m) => {
                    if self.memo[m].1[k] == UNKNOWN {
                        self.memo[m].1[k] = self.bd.via_fixed_code(x, y, d, dr, clr, hth, sig, iv);
                    }
                    self.memo[m].1[k]
                }
                None => self.bd.via_fixed_code(x, y, d, dr, clr, hth, sig, iv),
            };
            c = if self.bd.via_code_blocks(fixed, net, x, y, d, dr, hth) { 1 } else { code(self.bd.via_soft(net, x, y, d, dr, hth, None)) };
            self.gr.vcache[k] = c;
        }
        if c == 1 { None } else { Some((c - 2) as u32) }
    }
    /// A layer change of `net` may use the via site (ix, iy): not banned for this net, and (RP-001, DESIGN 4) a GND
    /// return is possible within --return-r: a fixed GND via or GND through-hole pad, or a GND via site that fixed
    /// copper leaves free and that keeps the rules to this signal via. Plane nets need no return.
    fn via_site_ok(&mut self, net: usize, ix: usize, iy: usize) -> bool {
        let k = iy * self.gr.nx + ix;
        if self.ban.binary_search(&k).is_ok() {
            return false;
        }
        if self.bd.nets[net].plane || self.bd.gnd < 0 || self.bd.gnds.contains(&(net as i32)) || self.bd.noret.contains(&(net as i32)) {
            return true;
        }
        if !self.ret_reachable(net) {
            return false;
        }
        let g = self.bd.rg(net);
        let k = k + self.bd.rg_slot(g) * self.gr.nx * self.gr.ny;
        if self.rcache[k] == 0 {
            let (x, y) = self.gr.xy(ix, iy);
            self.rcache[k] = if self.ret_possible(g as usize, x, y) { 1 } else { 2 };
        }
        self.rcache[k] == 1
    }
    /// The candidate GND via sites for a signal via at (x, y): grid points (every second grid cell) within
    /// --return-r, at least the hole-to-hole and clearance distance from the signal via, nearest first.
    fn ret_sites(&self, g: usize, x: f64, y: f64) -> Vec<(f64, usize, usize)> {
        let (gd, gdr) = (self.o.ret_d, self.o.ret_drill);
        // the largest signal via of the board (conservative for every net)
        let (sd, sdr) = self.bd.nets.iter().filter(|n| !n.plane).fold((0.0f64, 0.0f64), |a, n| (a.0.max(n.via_d), a.1.max(n.via_drill)));
        let sep = (sdr / 2.0 + gdr / 2.0 + self.o.hth).max(sd / 2.0 + gd / 2.0 + self.bd.maxc.max(self.bd.nets[g].clr));
        let p = self.gr.p;
        let k = (self.o.return_r / p).ceil() as i64;
        let (cx, cy) = self.gr.at(x, y);
        let mut v = Vec::new();
        for j in (-k..=k).step_by(2) {
            for i in (-k..=k).step_by(2) {
                let (ix, iy) = (cx as i64 + i, cy as i64 + j);
                if ix < 0 || iy < 0 || ix >= self.gr.nx as i64 || iy >= self.gr.ny as i64 {
                    continue;
                }
                let (px, py) = self.gr.xy(ix as usize, iy as usize);
                let dd = ((px - x).powi(2) + (py - y).powi(2)).sqrt();
                if dd <= self.o.return_r - 1e-9 && dd >= sep {
                    v.push((dd, ix as usize, iy as usize));
                }
            }
        }
        v.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        v
    }
    fn ret_fixed_code(&mut self, g: usize, ix: usize, iy: usize) -> i32 {
        let (d, dr, clr, hth) = (self.o.ret_d, self.o.ret_drill, self.bd.nets[g].clr, self.o.hth);
        let k = iy * self.gr.nx + ix;
        let (x, y) = self.gr.xy(ix, iy);
        let iv = self.bd.iv(g as i32);
        match self.memo_slot(2 + 4 * iv, (d.to_bits(), dr.to_bits(), clr.to_bits())) {
            Some(m) => {
                if self.memo[m].1[k] == UNKNOWN {
                    self.memo[m].1[k] = self.bd.via_fixed_code(x, y, d, dr, clr, hth, false, iv);
                }
                self.memo[m].1[k]
            }
            None => self.bd.via_fixed_code(x, y, d, dr, clr, hth, false, iv),
        }
    }
    /// isolation: a return via of the ground can lie within --return-r of a via of `net` at all: the smallest pair
    /// value between the two via groups (over the region variants) plus both radii is not beyond the radius. POE-ETHERNET
    /// run 3: a POE via needs a PHY_GND / ISO_GND via within 1.0 mm but keeps 3 mm from every one; the layer change
    /// was allowed and the return fought the negotiation to the end (13 nets in conflict at iteration 19).
    fn ret_reachable(&self, net: usize) -> bool {
        let Some(i) = &self.bd.iso else { return true };
        let (gs, gg) = (&i.var[self.bd.iv(net as i32) as usize][1], &i.var[self.bd.iv(self.bd.rg(net)) as usize][1]);
        let pc = gs.iter().flat_map(|&a| gg.iter().map(move |&b| i.tab[a as usize * i.n + b as usize])).fold(f64::INFINITY, f64::min);
        pc <= 0.0 || self.bd.nets[net].via_d / 2.0 + self.o.ret_d / 2.0 + pc <= self.o.return_r
    }
    fn ret_possible(&mut self, g: usize, x: f64, y: f64) -> bool {
        let r = self.o.return_r;
        if self.bd.gnd_fixed.iter().any(|&(gx, gy)| (gx - x).powi(2) + (gy - y).powi(2) <= r * r) {
            return true;
        }
        let (d, dr, hth) = (self.o.ret_d, self.o.ret_drill, self.o.hth);
        for (_, ix, iy) in self.ret_sites(g, x, y) {
            let code = self.ret_fixed_code(g, ix, iy);
            let (px, py) = self.gr.xy(ix, iy);
            if !self.bd.via_code_blocks(code, g, px, py, d, dr, hth) {
                return true;
            }
        }
        false
    }
    /// Foreign signal drilled items (fixed or routed) whose copper is inside the antipad web of a via of `net` at (x, y).
    fn web_items(&self, net: usize, x: f64, y: f64) -> usize {
        let vr = self.bd.nets[net].via_d / 2.0;
        // v7 speed: an item with copper closer than vr + web has its bbox (index buckets) inside this reach; v6 searched
        // 2 mm more (9 x the buckets, same result)
        let r = vr + self.bd.web + 0.01;
        let mut seen: Vec<u32> = Vec::new();
        let l = self.bd.routable[0];
        for ix in [&self.bd.idx, &self.bd.sidx] {
            self.bd.near_in(ix, l, x, y, r, &mut |id, s| {
                if s.drill > 0.0 && s.net >= 0 && s.net != net as i32 && !self.bd.nets[s.net as usize].plane && s.kind != Kind::Spoke
                    && s.geo.dist(x, y) < vr + self.bd.web && !seen.contains(&id) {
                    seen.push(id);
                }
                false
            });
        }
        seen.len()
    }
    /// A GND via (any owner) or a fixed GND through-hole pad within --return-r of (x, y).
    fn has_return(&self, x: f64, y: f64) -> bool {
        let r = self.o.return_r;
        if self.bd.gnd_fixed.iter().any(|&(gx, gy)| (gx - x).powi(2) + (gy - y).powi(2) <= r * r) {
            return true;
        }
        let l = self.bd.routable[0];
        let mut f = |_: u32, s: &Shape| self.bd.is_ret_net(s.net) && s.kind == Kind::Via && match s.geo { Geo::Circ(cx, cy, _) => (cx - x).powi(2) + (cy - y).powi(2) <= r * r, _ => false };
        self.bd.near_in(&self.bd.idx, l, x, y, r, &mut f) || self.bd.near_in(&self.bd.sidx, l, x, y, r, &mut f)
    }
    /// Return via (RP-001) for the new signal via of `net` at (x, y): an existing GND via within --return-r counts;
    /// else a new GND via, owned by `net`, at the cheapest site (fewest soft conflicts, then nearest; strict: no
    /// conflict). A site that touches the net's own copper is never taken. false: no site (the transition is rejected).
    fn place_return(&mut self, net: usize, x: f64, y: f64, cover: &[(f64, f64)]) -> bool {
        if self.bd.nets[net].plane || self.bd.gnd < 0 || self.bd.gnds.contains(&(net as i32)) || self.bd.noret.contains(&(net as i32)) || self.has_return(x, y) {
            return true;
        }
        let g = self.bd.rg(net) as usize;
        let (d, dr, hth) = (self.o.ret_d, self.o.ret_drill, self.o.hth);
        // v6 fix 3a: among the sites with the fewest conflicts, take the one that also serves the most other new vias
        // of this join that have no return yet (one GND via for several signal vias), then the nearest
        let rr = self.o.return_r * self.o.return_r;
        let open: Vec<(f64, f64)> = cover.iter().cloned().filter(|&(a, b)| ((a - x).abs() > 1e-9 || (b - y).abs() > 1e-9) && !self.has_return(a, b)).collect();
        let serves = |px: f64, py: f64| -> i32 { open.iter().filter(|&&(a, b)| (a - px).powi(2) + (b - py).powi(2) <= rr).count() as i32 };
        let mut best: Option<(i32, i32, f64, f64, f64)> = None;
        let mut hits = Vec::new();
        for (dd, ix, iy) in self.ret_sites(g, x, y) {
            let code = self.ret_fixed_code(g, ix, iy);
            let (px, py) = self.gr.xy(ix, iy);
            if self.bd.via_code_blocks(code, g, px, py, d, dr, hth) {
                continue;
            }
            hits.clear();
            let k = self.bd.via_soft(g, px, py, d, dr, hth, Some(&mut hits));
            if ((self.strict || !self.ret_soft) && k > 0) || hits.iter().any(|&h| { let s = &self.bd.shapes[h as usize]; s.owner == net as i32 || s.net == net as i32 }) {
                continue;
            }
            let sv = -serves(px, py);
            if best.map(|b| (k, sv, dd) < (b.0, b.1, b.2)).unwrap_or(true) {
                best = Some((k, sv, dd, px, py));
                if k == 0 && open.is_empty() {
                    break; // sites come nearest first
                }
            }
        }
        let Some((_, _, _, px, py)) = best else { return false };
        let all = (1u8 << self.bd.layer_names.len()) - 1;
        let clr = self.bd.nets[g].clr;
        self.bd.add(Shape { net: g as i32, geo: Geo::Circ(px, py, d / 2.0), clr, layers: all, drill: dr, kind: Kind::Via, owner: net as i32, alive: true, grp: 0 });
        true
    }
    /// Signal vias with no GND via or GND through-hole pad within --return-r (RP-001): (net, x, y).
    fn ret_missing(&self) -> Vec<(usize, f64, f64)> {
        let mut v = Vec::new();
        for s in self.bd.shapes.iter().filter(|s| s.alive && s.owner >= 0 && s.kind == Kind::Via && s.net == s.owner && !self.bd.nets[s.net as usize].plane && !self.bd.gnds.contains(&s.net) && !self.bd.noret.contains(&s.net)) {
            if let Geo::Circ(x, y, _) = s.geo {
                if self.bd.gnd >= 0 && !self.has_return(x, y) {
                    v.push((s.net as usize, x, y));
                }
            }
        }
        v
    }
    /// Routing cells (track centres on the pour layer) and via sites from which copper of a wall net would block the
    /// door of a pour fault (pour.rs): they get the door history, so the ripped wall nets route around the door.
    fn door_cells(&self, fl: &pour::Fault, cells: &mut std::collections::HashSet<usize>, vcells: &mut std::collections::HashSet<usize>) {
        let pr = &self.bd.pours[fl.pour];
        let Some(r) = self.bd.routable.iter().position(|&l| l == fl.layer) else { return };
        let walls = fl.walls.iter().map(|&w| &self.bd.nets[w]);
        let (hw, vr) = walls.fold((0.075f64, 0.3f64), |a, n| (a.0.max(n.width.max(n.min_w) / 2.0), a.1.max(n.via_d / 2.0)));
        let reach = self.bd.reach().max(pr.clr) + pr.mt / 2.0 + pour::POUR_PITCH;
        let (rt, rv) = (hw + reach, vr + reach);
        let n = self.gr.nx * self.gr.ny;
        for &(x, y) in &fl.door {
            let (i0, j0) = self.gr.at(x - rv, y - rv);
            let (i1, j1) = self.gr.at(x + rv, y + rv);
            for j in j0..=j1 {
                for i in i0..=i1 {
                    let (cx, cy) = self.gr.xy(i, j);
                    let d2 = (cx - x).powi(2) + (cy - y).powi(2);
                    if d2 <= rt * rt {
                        cells.insert(r * n + j * self.gr.nx + i);
                    }
                    if d2 <= rv * rv {
                        vcells.insert(j * self.gr.nx + i);
                    }
                }
            }
        }
    }
    /// Pour faults of the present copper; the door history goes on the routing cells of every fixable door. Returns
    /// (faults, wall nets to rip up, faults that fixed copper alone makes).
    fn pour_pass(&mut self, amount: f32) -> (Vec<pour::Fault>, Vec<usize>, usize) {
        let faults = pour::check(self.bd);
        let (mut cells, mut vcells) = (std::collections::HashSet::new(), std::collections::HashSet::new());
        let mut walls: Vec<usize> = Vec::new();
        let mut fixed = 0;
        for fl in &faults {
            if fl.fixed {
                fixed += 1;
                continue;
            }
            self.door_cells(fl, &mut cells, &mut vcells);
            for &w in &fl.walls {
                if !walls.contains(&w) {
                    walls.push(w);
                }
            }
        }
        if amount > 0.0 {
            for c in cells {
                self.gr.hist[c] += amount;
            }
            for c in vcells {
                self.gr.vhist[c] += amount;
            }
        }
        (faults, walls, fixed)
    }
    /// Hard door (last resort): the part of the fault's path that routed copper blocks becomes a reserved pour strip
    /// (Kind::Spoke of the pour net, min_thickness + 2 pitch wide, zone clearance), so no net routes over it again: from
    /// the spoke ring to the last blocked cell, plus min_thickness + zone clearance into the fill beyond it (v6; v5
    /// reserved the whole path to a via of the net, up to tens of mm through existing fill, which walled off routing
    /// channels: M2 v6 run, J2.18, 1718 cells). The fixed-copper memo is cleared (fixed copper grew); walled-in proofs
    /// stay true (more fixed copper never opens a path).
    fn reserve_door(&mut self, fl: &pour::Fault) {
        let pr = self.bd.pours[fl.pour].clone();
        let hw = pr.mt / 2.0 + pour::POUR_PITCH;
        // the zone clearance (v6: v5 took the largest DRU zone clearance of any net, 0.5 mm of the locked H7-CORE pairs,
        // for every net: the strip then closed the 2.54 mm J2 pin channels). A net with a larger DRU zone clearance keeps
        // it from the real fill, which the pour check models.
        let clr = pr.clr;
        let last = fl.path.iter().rposition(|p| fl.door.iter().any(|d| (d.0 - p.0).abs() < 1e-9 && (d.1 - p.1).abs() < 1e-9));
        let extra = ((pr.mt + pr.clr) / pour::POUR_PITCH).ceil() as usize;
        let end = last.map(|e| (e + extra + 1).min(fl.path.len())).unwrap_or(fl.path.len());
        let path = &fl.path[..end];
        let mut k = 0;
        while k + 1 < path.len() {
            // one segment per straight run of the 4-connected path
            let (a, b) = (path[k], path[k + 1]);
            let d = (b.0 - a.0, b.1 - a.1);
            let mut e = k + 1;
            while e + 1 < path.len() && ((path[e + 1].0 - path[e].0 - d.0).abs() < 1e-9 && (path[e + 1].1 - path[e].1 - d.1).abs() < 1e-9) {
                e += 1;
            }
            let b = path[e];
            self.bd.add(Shape { net: pr.net, geo: Geo::Seg(a.0, a.1, b.0, b.1, hw), clr, layers: 1 << pr.layer, drill: 0.0, kind: Kind::Spoke, owner: -1, alive: true, grp: 0 });
            k = e;
        }
        self.bd.maxc = self.bd.maxc.max(clr); // query reach
        self.memo.clear();
        self.rcache.iter_mut().for_each(|c| *c = 0);
        self.gr.reset_cache();
    }
    /// Memo of the fixed-copper verdict per rule profile (track: hw, clr, fast; via: d, drill, clr). Fixed copper
    /// does not change during a run, so each grid site is evaluated once per profile instead of once per search.
    /// Only the profiles of the net widths (and the power necks) get a memo; others are evaluated directly.
    /// kind: 0 / 1 track, 2 via, plus 4 x the isolation var entry of a via profile (0 without pair rules)
    fn memo_slot(&mut self, kind: u32, key: (u64, u64, u64)) -> Option<usize> {
        let track = kind < 2;
        let tag = (kind, key);
        if let Some(m) = self.memo.iter().position(|(t, _)| *t == tag) {
            return Some(m);
        }
        if track && !self.memo_w.iter().any(|&w| (f64::from_bits(key.0) * 2.0 - w).abs() < 1e-9) {
            return None;
        }
        if self.memo.len() >= 16 {
            return None;
        }
        let n = if track { self.gr.nx * self.gr.ny * self.gr.nr } else { self.gr.nx * self.gr.ny };
        self.memo.push((tag, vec![UNKNOWN; n]));
        Some(self.memo.len() - 1)
    }

    /// Flood fill with the moves and blocking rules of the search (vias allowed, diagonal midpoints checked, soft
    /// conflicts block only when strict): is any cell marked in tgt reachable from src inside bx?
    fn reachable(&mut self, net: usize, hw: f64, src: &[usize], strict: bool, allow_via: bool, bx: (usize, usize, usize, usize)) -> bool {
        self.gr.sgen += 1;
        let sgen = self.gr.sgen;
        let (nx, nr) = (self.gr.nx, self.gr.nr);
        let n = nx * self.gr.ny;
        let lmask = self.bd.nets[net].layers;
        let allowed: Vec<bool> = self.bd.routable.iter().map(|&l| lmask & (1 << l) != 0).collect();
        let ok = |k: Option<u32>| matches!(k, Some(k) if !strict || k == 0);
        let mut stack: Vec<usize> = Vec::new();
        for &s in src {
            if self.gr.seen[s] != sgen && ok(self.cost(net, s, hw)) {
                self.gr.seen[s] = sgen;
                stack.push(s);
            }
        }
        while let Some(i) = stack.pop() {
            if self.gr.tgt[i] == self.gr.tgen {
                return true;
            }
            let (r, iy, ix) = self.gr.cell(i);
            for (dx, dy) in [(-1i32, 0i32), (1, 0), (0, -1), (0, 1), (-1, -1), (1, -1), (-1, 1), (1, 1)] {
                let (jx, jy) = (ix as i32 + dx, iy as i32 + dy);
                if jx < bx.0 as i32 || jy < bx.1 as i32 || jx > bx.2 as i32 || jy > bx.3 as i32 {
                    continue;
                }
                let j = r * n + jy as usize * nx + jx as usize;
                if self.gr.seen[j] == sgen || !ok(self.cost(net, j, hw)) {
                    continue;
                }
                if dx != 0 && dy != 0 && !ok(self.mcost(net, r * n + (iy as i32).min(jy) as usize * nx + (ix as i32).min(jx) as usize, hw)) {
                    continue;
                }
                self.gr.seen[j] = sgen;
                stack.push(j);
            }
            if allow_via && nr > 1 && ok(self.vcost(net, ix, iy)) && self.via_site_ok(net, ix, iy) {
                for r2 in 0..nr {
                    let j = r2 * n + iy * nx + ix;
                    if r2 != r && allowed[r2] && self.gr.seen[j] != sgen && ok(self.cost(net, j, hw)) {
                        self.gr.seen[j] = sgen;
                        stack.push(j);
                    }
                }
            }
        }
        false
    }

    /// The cells an item covers on the routable layers (as source or target).
    fn cells_of(&self, s: &Shape, net_layers: u8) -> Vec<usize> {
        let mut v = Vec::new();
        let mut corner = Vec::new(); // only when the ellipse holds no grid cell (pad narrower than the pitch)
        let (a, b, c, d) = s.geo.bbox();
        let (i0, j0) = self.gr.at(a, b);
        let (i1, j1) = self.gr.at(c, d);
        let n = self.gr.nx * self.gr.ny;
        for (r, &l) in self.bd.routable.iter().enumerate() {
            if s.layers & (1 << l) == 0 || net_layers & (1 << l) == 0 {
                continue;
            }
            for j in j0..=j1 {
                for i in i0..=i1 {
                    let (x, y) = self.gr.xy(i, j);
                    // a pad is known only by its bounding box: a track may end only inside the inscribed ellipse,
                    // which lies inside a rectangular, round, oval or rounded pad (a bbox corner of a round pad is
                    // bare board: KiCad reported such ends as unconnected)
                    // The end must lie strictly inside the copper, END_IN from its edge: an end on the pad edge is
                    // connected for KiCad but not for the paths gate (tools/pcbtool.py: pad.HitTest of the end
                    // node, rounded to 1 um, excludes the edge: v3 "no copper path" at U4.3, U1.30, L2.2)
                    let in_pad = match (s.kind, s.geo) {
                        (Kind::Pad, Geo::Rect(..)) => {
                            let (ex, ey) = (((c - a) / 2.0 - END_IN).max(1e-9), ((d - b) / 2.0 - END_IN).max(1e-9));
                            ((x - (a + c) / 2.0) / ex).powi(2) + ((y - (b + d) / 2.0) / ey).powi(2) <= 1.0
                        }
                        (_, Geo::Seg(..)) | (_, Geo::Circ(..)) => s.geo.dist(x, y) <= -END_IN,
                        _ => true,
                    };
                    if s.geo.dist(x, y) <= 1e-9 {
                        if in_pad {
                            v.push(r * n + j * self.gr.nx + i);
                        } else {
                            corner.push(r * n + j * self.gr.nx + i);
                        }
                    }
                }
            }
        }
        if v.is_empty() { corner } else { v }
    }

    /// Multi-source A* from `src` cells to any cell marked in tgt (generation tgen), inside the grid box bx. Step
    /// cost = length x layer factor x (1 + history) x (1 + pres x soft conflicts); a diagonal step also pays its
    /// midpoint. With strict, soft conflicts block. Err(true): max_pops expansions reached (not a proof);
    /// Err(false): no path inside bx.
    fn search_n(&mut self, net: usize, hw: f64, src: &[usize], anchors: &[(f64, f64)], allow_via: bool, via_mult: f64, strict: bool, max_pops: usize,
                bx: (usize, usize, usize, usize)) -> Result<Vec<usize>, bool> {
        self.gr.sgen += 1;
        let sgen = self.gr.sgen;
        let (nx, ny, nr, p) = (self.gr.nx, self.gr.ny, self.gr.nr, self.gr.p);
        let n = nx * ny;
        let lmask = self.bd.nets[net].layers;
        let lcost: Vec<f64> = self.bd.routable.iter().map(|&l| if lmask & (1 << l) == 0 { f64::INFINITY } else { layer_cost(self.bd, l) }).collect();
        let via_base = (self.o.via_cost + if self.bd.nets[net].max_vias.is_some() { 6.0 } else { 0.0 }) * via_mult;
        // a layer change where no GND via is within the RP-001 radius needs a new return via: it costs ret_cost more
        let need_ret = !self.bd.nets[net].plane && self.bd.gnd >= 0 && !self.bd.gnds.contains(&(net as i32)) && !self.bd.noret.contains(&(net as i32)) && self.o.ret_cost > 0.0;
        let mut ret_memo: std::collections::HashMap<usize, bool> = std::collections::HashMap::new();
        let web_soft = !self.bd.web_hard && self.bd.web > 0.0 && !self.bd.nets[net].plane && self.o.web_cost > 0.0;
        let mut web_memo: std::collections::HashMap<usize, f64> = std::collections::HashMap::new();
        // gate scope: off-reference steps of a soft net (reffill.rs) are priced, not blocked
        let ref_soft = self.bd.rfill.soft.get(net).copied().unwrap_or(false);
        let ref_price = self.bd.rfill.cost.get(net).copied().unwrap_or(DEF_REF_COST);
        let mut ref_memo: std::collections::HashMap<usize, bool> = std::collections::HashMap::new();
        let pres = self.gr.pres as f64;
        let (x0, y0) = (self.gr.x0, self.gr.y0);
        // v7 DRU length bound: the octile distance to the nearest target box is a lower bound of the length still to go
        // (every target cell lies inside the box of its item); len_mode is a plain shortest-path A* on it
        let (len_cap, len_mode, via_len) = (self.len_cap, self.len_mode, self.bd.via_len);
        let boxes = self.len_boxes.clone();
        let lb = |ix: usize, iy: usize| -> f64 {
            let (x, y) = (x0 + ix as f64 * p, y0 + iy as f64 * p);
            boxes.iter().map(|&(a, b, c, d)| {
                let (dx, dy) = ((a - x).max(0.0).max(x - c), (b - y).max(0.0).max(y - d));
                dx.max(dy) + (SQ2 - 1.0) * dx.min(dy)
            }).fold(f64::INFINITY, f64::min)
        };
        if self.gr.glen.len() != self.gr.g.len() {
            self.gr.glen = vec![0.0; self.gr.g.len()];
        }
        // v9 recover: admissible heuristic, the octile distance to the nearest target box grown by the longest escape
        // stub of the board (a stub end cell lies outside its pad's box, at most the stub length away)
        let recover = self.recover;
        let grow = if recover { self.bd.esc.iter().map(|e| e.2).fold(0.0f64, f64::max) } else { 0.0 };
        let rboxes: Vec<(f64, f64, f64, f64)> = boxes.iter().map(|&(a, b, c, d)| (a - grow, b - grow, c + grow, d + grow)).collect();
        let rb = |ix: usize, iy: usize| -> f64 {
            let (x, y) = (x0 + ix as f64 * p, y0 + iy as f64 * p);
            rboxes.iter().map(|&(a, b, c, d)| {
                let (dx, dy) = ((a - x).max(0.0).max(x - c), (b - y).max(0.0).max(y - d));
                dx.max(dy) + (SQ2 - 1.0) * dx.min(dy)
            }).fold(f64::INFINITY, f64::min)
        };
        let h = |ix: usize, iy: usize| -> f32 {
            if len_mode {
                return lb(ix, iy) as f32;
            }
            if recover && !rboxes.is_empty() {
                return rb(ix, iy) as f32;
            }
            let (x, y) = (x0 + ix as f64 * p, y0 + iy as f64 * p);
            let mut m = f64::INFINITY;
            for &(ax, ay) in anchors {
                let (dx, dy) = ((x - ax).abs(), (y - ay).abs());
                let o = dx.max(dy) + (SQ2 - 1.0) * dx.min(dy);
                if o < m {
                    m = o;
                }
            }
            (m * 1.15) as f32
        };
        let (stub_s, stub_t) = self.stub_cost.clone();
        let mut heap = BinaryHeap::new();
        for &s in src {
            match self.cost(net, s, hw) {
                None => continue,
                Some(k) if strict && k > 0 => continue,
                _ => {}
            }
            if self.gr.seen[s] == sgen {
                continue;
            }
            self.gr.seen[s] = sgen;
            self.gr.g[s] = 0.0;
            let g0 = stub_s.get(&s).copied().unwrap_or(0.0);
            self.gr.g[s] = g0;
            self.gr.glen[s] = 0.0;
            self.gr.from[s] = u32::MAX;
            let (_, iy, ix) = self.gr.cell(s);
            heap.push(Node { f: h(ix, iy) + g0, g: g0, i: s as u32 });
        }
        let mut pops = 0usize;
        let dbg = std::env::var("IOTROUTE_DEBUG").is_ok() && max_pops >= 1_000_000;
        let mut expd: Vec<bool> = if dbg { vec![false; self.gr.g.len()] } else { Vec::new() };
        let (mut distinct, mut via_pops) = (0usize, 0usize);
        while let Some(Node { f: _, g: gpush, i }) = heap.pop() {
            let i = i as usize;
            if gpush > self.gr.g[i] || self.gr.closed[i] == sgen {
                continue; // stale entry, or the cell is already expanded (no reopening)
            }
            self.gr.closed[i] = sgen;
            pops += 1;
            if dbg && !expd[i] {
                expd[i] = true;
                distinct += 1;
            }
            if pops > max_pops {
                if dbg {
                    let (r, iy, ix) = self.gr.cell(i);
                    eprintln!("    search limit {}: {} pops, {} distinct cells, box {}x{} x {} layers, via moves {}, last g {:.1} at ({:.2}, {:.2}) r {}, h0 {:.1}",
                              self.bd.nets[net].name, pops, distinct, bx.2 - bx.0 + 1, bx.3 - bx.1 + 1, nr, via_pops, gpush,
                              self.gr.x0 + ix as f64 * p, self.gr.y0 + iy as f64 * p, r,
                              src.first().map(|&s| { let (_, y, x) = self.gr.cell(s); h(x, y) }).unwrap_or(0.0));
                }
                return Err(true);
            }
            if self.gr.tgt[i] == self.gr.tgen {
                let mut path = vec![i];
                let mut c = i;
                while self.gr.from[c] != u32::MAX {
                    c = self.gr.from[c] as usize;
                    path.push(c);
                }
                path.reverse();
                return Ok(path);
            }
            let gi = self.gr.g[i];
            let li = self.gr.glen[i] as f64;
            let (r, iy, ix) = self.gr.cell(i);
            let mut nb: Vec<(usize, f64, bool, usize)> = Vec::with_capacity(10);
            for (dx, dy) in [(-1i32, 0i32), (1, 0), (0, -1), (0, 1), (-1, -1), (1, -1), (-1, 1), (1, 1)] {
                let (jx, jy) = (ix as i32 + dx, iy as i32 + dy);
                if jx < bx.0 as i32 || jy < bx.1 as i32 || jx > bx.2 as i32 || jy > bx.3 as i32 {
                    continue;
                }
                let diag = dx != 0 && dy != 0;
                let step = if diag { SQ2 } else { 1.0 } * p * lcost[r];
                let mid = if diag { r * n + (iy as i32).min(jy) as usize * nx + (ix as i32).min(jx) as usize } else { usize::MAX };
                nb.push((r * n + jy as usize * nx + jx as usize, step, false, mid));
            }
            if allow_via && nr > 1 {
                if let Some(kv) = self.vcost(net, ix, iy).filter(|_| self.via_site_ok(net, ix, iy)) {
                    if !(strict && kv > 0) {
                        let extra = if need_ret {
                            let k = iy * nx + ix;
                            let has = match ret_memo.get(&k) {
                                Some(&h) => h,
                                None => {
                                    let (x, y) = (x0 + ix as f64 * p, y0 + iy as f64 * p);
                                    let h = self.has_return(x, y);
                                    ret_memo.insert(k, h);
                                    h
                                }
                            };
                            if has { 0.0 } else { self.o.ret_cost * via_mult }
                        } else { 0.0 };
                        let webc = if web_soft {
                            let k = iy * nx + ix;
                            match web_memo.get(&k) {
                                Some(&c) => c,
                                None => {
                                    let (x, y) = (x0 + ix as f64 * p, y0 + iy as f64 * p);
                                    let c = self.web_items(net, x, y) as f64 * self.o.web_cost * via_mult;
                                    web_memo.insert(k, c);
                                    c
                                }
                            }
                        } else { 0.0 };
                        let vh = if recover { 0.0 } else { self.gr.vhist[iy * nx + ix] as f64 };
                        // the seeded field moves the via price as it moves a step, so the two keep their ratio
                        let vj = if recover { 0.0 } else { self.gr.jit.via(iy * nx + ix) };
                        let vc = (via_base * (1.0 + vj) + extra + webc + vh) * (1.0 + pres * kv as f64);
                        via_pops += 1;
                        for r2 in 0..nr {
                            if r2 != r && lcost[r2].is_finite() {
                                nb.push((r2 * n + iy * nx + ix, vc, true, usize::MAX));
                            }
                        }
                    }
                }
            }
            for (j, c, is_via, mid) in nb {
                // geometric length of the step (a via counts as KiCad counts it in the length rule)
                let glen = if is_via { via_len } else if mid != usize::MAX { SQ2 * p } else { p };
                if let Some(cap) = len_cap {
                    let (_, jy, jx) = self.gr.cell(j);
                    if li + glen + lb(jx, jy) > cap {
                        continue;
                    }
                }
                let mut k = match self.cost(net, j, hw) {
                    None => continue,
                    Some(k) => k,
                };
                if mid != usize::MAX {
                    match self.mcost(net, mid, hw) {
                        None => continue,
                        Some(km) => k = k.max(km),
                    }
                }
                if strict && k > 0 {
                    continue;
                }
                let hj = if recover { 0.0 } else { self.gr.hist[j] as f64 + self.gr.jit.cell(j) };
                let mut c = if len_mode { glen } else if is_via { c } else { c * (1.0 + hj) * (1.0 + pres * k as f64) };
                if ref_soft && !is_via && !len_mode {
                    let off = *ref_memo.entry(j).or_insert_with(|| {
                        let (rj, jy, jx) = self.gr.cell(j);
                        let l = self.bd.routable[rj];
                        self.bd.adj & (1 << l) != 0 && self.bd.rfill.off_ref(l, net, x0 + jx as f64 * p, y0 + jy as f64 * p, self.bd.eps)
                    });
                    if off {
                        c *= 1.0 + ref_price;
                    }
                }
                if !stub_t.is_empty() && self.gr.tgt[j] == self.gr.tgen {
                    c += stub_t.get(&j).copied().unwrap_or(0.0) as f64;
                }
                let gj = gi + c as f32;
                if self.gr.closed[j] == sgen || (self.gr.seen[j] == sgen && self.gr.g[j] <= gj) {
                    continue;
                }
                self.gr.seen[j] = sgen;
                self.gr.g[j] = gj;
                self.gr.glen[j] = (li + glen) as f32;
                self.gr.from[j] = i as u32;
                let (_, jy, jx) = self.gr.cell(j);
                heap.push(Node { f: gj + h(jx, jy), g: gj, i: j as u32 });
            }
        }
        Err(false)
    }

    /// Exact audit of every live routed item against the other routed items (both sides of each conflict are seen,
    /// since each item is checked from its own net). hist > 0: add PathFinder history on the grid cells (and via
    /// sites) of the conflicting copper, once per cell and iteration.
    fn audit(&mut self, hist: f32) -> Audit {
        self.audit_of(hist, None)
    }
    /// audit of the routed items of one net only (no history)
    fn net_in_conflict(&mut self, net: usize) -> bool {
        self.audit_of(0.0, Some(net)).pairs > 0
    }
    fn audit_of(&mut self, hist: f32, only: Option<usize>) -> Audit {
        self.bd.eps = 0.0;
        let a = self.audit_inner(hist, only);
        self.bd.eps = EPS;
        a
    }
    fn audit_inner(&mut self, hist: f32, only: Option<usize>) -> Audit {
        let nn = self.bd.nets.len();
        let mut a = Audit { per_net: vec![0; nn], partners: vec![Vec::new(); nn], ..Default::default() };
        let mut pairs = std::collections::HashSet::new();
        let mut cells = std::collections::HashSet::new();
        let mut vcells = std::collections::HashSet::new();
        let n = self.gr.nx * self.gr.ny;
        let ids: Vec<usize> = (0..self.bd.shapes.len())
            .filter(|&i| self.bd.shapes[i].alive && self.bd.shapes[i].owner >= 0 && only.map_or(true, |o| self.bd.shapes[i].owner == o as i32))
            .collect();
        let mut hits: Vec<u32> = Vec::new();
        for id in ids {
            let s = self.bd.shapes[id].clone();
            let net = s.net as usize;
            let own = s.owner as usize;
            let mut samples: Vec<(f64, f64, i32, Option<usize>)> = Vec::new();
            hits.clear();
            match (s.kind, s.geo) {
                (Kind::Track, Geo::Seg(ax, ay, bx, by, hw)) => {
                    let l = (0..self.bd.layer_names.len()).find(|&l| s.layers & (1 << l) != 0).unwrap();
                    let r = self.bd.routable.iter().position(|&q| q == l);
                    let len = ((bx - ax).powi(2) + (by - ay).powi(2)).sqrt();
                    let k = (len / (self.gr.p * 0.5)).ceil().max(1.0) as usize;
                    for t in 0..=k {
                        let f = t as f64 / k as f64;
                        let (x, y) = (ax + (bx - ax) * f, ay + (by - ay) * f);
                        let c = self.bd.track_cost(net, l, x, y, hw, self.o.plane_clr, Some(&mut hits));
                        samples.push((x, y, c, r));
                    }
                }
                (Kind::Via, Geo::Circ(x, y, vr)) => {
                    // hole to hole applies to the own net too: take the via itself out while it is checked
                    self.bd.shapes[id].alive = false;
                    let c = self.bd.via_cost(net, x, y, vr * 2.0, s.drill, self.o.hth, Some(&mut hits));
                    self.bd.shapes[id].alive = true;
                    samples.push((x, y, c, None));
                }
                _ => continue,
            }
            // v7 fix 1 (standoffs): the history goes on the keep-out of the conflicting copper (every grid cell within its
            // half width + clearance of the conflict sample), not only on the cell under its centre. v6 put it on one
            // cell per sample (one via site per via): the net moved by one 0.05 mm pitch, still in conflict, onto
            // cells with no history, so the history never grew where the nets fought (IOTROUTE_DIAG, spread NET-CORE
            // iteration 50: the /PHY_RSTn via site 0.3 of history after 50 iterations of conflict)
            // isolation: an isolation conflict reaches the pair value, not the class clearance; the history covers that
            // halo too (POE-ETHERNET run 6: POE and PHY nets stood off at pres 1000 from iteration 10 to 80)
            let pv = hits.iter().map(|&h| self.bd.pc(s.grp, &self.bd.shapes[h as usize])).fold(0.0, f64::max);
            let keep = match s.geo {
                Geo::Seg(_, _, _, _, hw) => hw + s.clr.max(pv),
                Geo::Circ(_, _, vr) => vr + s.clr.max(pv),
                _ => 0.0,
            };
            for &(x, y, c, r) in &samples {
                if c < 0 {
                    a.hard += 1;
                    if std::env::var("IOTROUTE_DEBUG").is_ok() {
                        eprintln!("  audit: {} {:?} on fixed copper at ({x:.3}, {y:.3})", self.bd.nets[net].name, s.geo, );
                    }
                    continue;
                }
                if c == 0 {
                    continue;
                }
                a.samples += c as u32;
                a.per_net[own] += c as u32;
                // v7 fix 1b: a return via in conflict is placed by its owner's layer change, which the owner's search
                // pays at the signal via site only: the history also goes on the keep-out of the owner's signal vias
                // that it serves (diag, spread NET-CORE iteration 50: the /ETH_RXD0 return via on /ETH_CRS_DV, while
                // /ETH_RXD0 had a conflict-free route with all other copper in place)
                let mut centres = vec![(x, y, keep)];
                if r.is_none() && s.net != s.owner && self.bd.is_ret_net(s.net) {
                    let rr = self.o.return_r;
                    let l0 = self.bd.routable[0];
                    let mut sv: Vec<(f64, f64, f64)> = Vec::new();
                    self.bd.near_in(&self.bd.sidx, l0, x, y, rr, &mut |_, q| {
                        if q.kind == Kind::Via && q.owner == s.owner && q.net == s.owner {
                            if let Geo::Circ(a, b, vr) = q.geo {
                                if (a - x).powi(2) + (b - y).powi(2) <= rr * rr {
                                    sv.push((a, b, vr + q.clr));
                                }
                            }
                        }
                        false
                    });
                    centres.extend(sv);
                }
                for (x, y, keep) in centres {
                let (i0, j0) = self.gr.at(x - keep, y - keep);
                let (i1, j1) = self.gr.at(x + keep, y + keep);
                for j in j0..=j1 {
                    for i in i0..=i1 {
                        let (cx, cy) = self.gr.xy(i, j);
                        if (cx - x).powi(2) + (cy - y).powi(2) > keep * keep + 1e-12 {
                            continue;
                        }
                        match r {
                            Some(r) => { cells.insert(r * n + j * self.gr.nx + i); }
                            None => { vcells.insert(j * self.gr.nx + i); }
                        }
                    }
                }
                }
            }
            for &h in &hits {
                let o = self.bd.shapes[h as usize].owner;
                if o >= 0 && !a.partners[own].contains(&(o as usize)) {
                    a.partners[own].push(o as usize);
                }
                pairs.insert(((id as u32).min(h), (id as u32).max(h)));
            }
        }
        a.pairs = pairs.len();
        a.pair_ids = pairs.into_iter().collect();
        a.pair_ids.sort();
        if hist > 0.0 {
            for c in cells {
                self.gr.hist[c] += hist;
            }
            for c in vcells {
                self.gr.vhist[c] += hist;
            }
        }
        a
    }

    fn seg_clear(&self, net: usize, l: usize, a: (f64, f64), b: (f64, f64), hw: f64) -> bool {
        let len = ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt();
        let k = (len / (self.gr.p * 0.5)).ceil().max(1.0) as usize;
        (0..=k).all(|t| {
            let f = t as f64 / k as f64;
            let (x, y) = (a.0 + (b.0 - a.0) * f, a.1 + (b.1 - a.1) * f);
            self.bd.track_ok(net, l, x, y, self.hw_at(l, x, y, hw), self.o.plane_clr)
        })
    }

    /// The 0/45/90 elbow from a to b: one straight leg and one 45-degree leg (straight first or diagonal first).
    /// None of the legs is empty only when a and b are not on one octilinear line.
    fn elbow(a: (f64, f64), b: (f64, f64), straight_first: bool) -> [(f64, f64); 3] {
        let (dx, dy) = (b.0 - a.0, b.1 - a.1);
        let d = dx.abs().min(dy.abs());
        let (sx, sy) = (d * dx.signum(), d * dy.signum());
        let m = if straight_first { (b.0 - sx, b.1 - sy) } else { (a.0 + sx, a.1 + sy) };
        [a, m, b]
    }

    /// Cell path -> (tracks, vias). Greedy string pulling per layer run, octilinear (v6): a pull from point i to point k
    /// is a 0/45/90 elbow (straight + 45-degree leg) whose legs are conflict-free; the grid steps (8 directions) are the
    /// fallback. Collinear neighbours are merged. Every segment is at 0, 45 or 90 degrees.
    fn geometry(&self, net: usize, path: &[usize], hw: f64) -> (Vec<(usize, (f64, f64), (f64, f64), f64)>, Vec<(f64, f64)>) {
        let mut tracks: Vec<(usize, (f64, f64), (f64, f64), f64)> = Vec::new();
        let mut vias = Vec::new();
        let mut runs: Vec<(usize, Vec<(f64, f64)>)> = Vec::new();
        for &c in path {
            let (r, iy, ix) = self.gr.cell(c);
            let pt = self.gr.xy(ix, iy);
            match runs.last_mut() {
                Some((lr, pts)) if *lr == r => pts.push(pt),
                _ => {
                    if let Some((_, pts)) = runs.last() {
                        vias.push(*pts.last().unwrap());
                    }
                    runs.push((r, vec![pt]));
                }
            }
        }
        let tol = self.gr.p * 1e-3;
        // gate scope (reffill.rs RefFill::soft): string pulling must not move a soft net off its reference where the
        // A* path (which paid --ref-cost there) stayed on it: an off-reference sample of a pulled leg is allowed only
        // within one cell of an off-reference cell of the path on that layer
        let soft = self.bd.rfill.soft.get(net).copied().unwrap_or(false);
        let mut off_cells: std::collections::HashSet<(usize, i64, i64)> = std::collections::HashSet::new();
        if soft {
            for &c in path {
                let (r, iy, ix) = self.gr.cell(c);
                let l = self.bd.routable[r];
                let (x, y) = self.gr.xy(ix, iy);
                if self.bd.adj & (1 << l) != 0 && self.bd.rfill.off_ref(l, net, x, y, self.bd.eps) {
                    for dj in -1..=1 {
                        for di in -1..=1 {
                            off_cells.insert((r, ix as i64 + di, iy as i64 + dj));
                        }
                    }
                }
            }
        }
        let ref_leg = |r: usize, u: (f64, f64), v: (f64, f64)| -> bool {
            let l = self.bd.routable[r];
            if !soft || self.bd.adj & (1 << l) == 0 {
                return true;
            }
            let len = (v.0 - u.0).hypot(v.1 - u.1);
            let k = (len / (self.gr.p * 0.5)).ceil().max(1.0) as usize;
            (0..=k).all(|t| {
                let f = t as f64 / k as f64;
                let (x, y) = (u.0 + (v.0 - u.0) * f, u.1 + (v.1 - u.1) * f);
                if !self.bd.rfill.off_ref(l, net, x, y, self.bd.eps) {
                    return true;
                }
                let (ix, iy) = self.gr.at(x, y);
                off_cells.contains(&(r, ix as i64, iy as i64))
            })
        };
        for (r, pts) in runs {
            let l = self.bd.routable[r];
            if pts.len() < 2 {
                continue;
            }
            let run0 = tracks.len();
            let hw = self.full_hw(l, hw); // v8: the layer floor (per-layer current width)
            let mut poly: Vec<(f64, f64)> = vec![pts[0]];
            let mut i = 0;
            while i < pts.len() - 1 {
                let mut best: Option<(usize, [(f64, f64); 3])> = None;
                let mut k = i + 1;
                let mut misses = 0;
                while k < pts.len() {
                    let dl = ((pts[k].0 - pts[i].0).powi(2) + (pts[k].1 - pts[i].1).powi(2)).sqrt();
                    if dl > 12.0 {
                        break;
                    }
                    // prefer the elbow whose first leg goes on in the direction of the last segment (fewer bends)
                    let prev = if poly.len() >= 2 { Some((poly[poly.len() - 1].0 - poly[poly.len() - 2].0, poly[poly.len() - 1].1 - poly[poly.len() - 2].1)) } else { None };
                    let mut opts = [Self::elbow(pts[i], pts[k], true), Self::elbow(pts[i], pts[k], false)];
                    if let Some((px, py)) = prev {
                        let d1 = (opts[1][1].0 - opts[1][0].0, opts[1][1].1 - opts[1][0].1);
                        if (d1.0.abs() > tol || d1.1.abs() > tol) && (px * d1.1 - py * d1.0).abs() < tol * (px.abs() + py.abs() + 1.0) && px * d1.0 + py * d1.1 > 0.0 {
                            opts.swap(0, 1);
                        }
                    }
                    let mut hit = None;
                    for e in opts {
                        let leg = |u: (f64, f64), v: (f64, f64)| (v.0 - u.0).abs() < tol && (v.1 - u.1).abs() < tol || (self.seg_clear(net, l, u, v, hw) && ref_leg(r, u, v));
                        if leg(e[0], e[1]) && leg(e[1], e[2]) {
                            hit = Some(e);
                            break;
                        }
                    }
                    if let Some(e) = hit {
                        best = Some((k, e));
                        misses = 0;
                    } else {
                        misses += 1;
                        if misses > 6 {
                            break;
                        }
                    }
                    k += if pts.len() - k > 40 { 3 } else { 1 };
                }
                // fallback: the grid step itself (0/45/90 by construction)
                let (j, e) = best.unwrap_or((i + 1, [pts[i], pts[i + 1], pts[i + 1]]));
                for q in [e[1], e[2]] {
                    let last = *poly.last().unwrap();
                    if (q.0 - last.0).abs() < tol && (q.1 - last.1).abs() < tol {
                        continue;
                    }
                    // merge with the last segment when collinear and in the same direction
                    if poly.len() >= 2 {
                        let a = poly[poly.len() - 2];
                        let (ux, uy) = (last.0 - a.0, last.1 - a.1);
                        let (vx, vy) = (q.0 - last.0, q.1 - last.1);
                        if (ux * vy - uy * vx).abs() < tol * (ux.abs() + uy.abs() + vx.abs() + vy.abs()) && ux * vx + uy * vy > 0.0 {
                            *poly.last_mut().unwrap() = q;
                            continue;
                        }
                    }
                    poly.push(q);
                }
                i = j;
            }
            // v8: inside the escape zone of a rated pin the full width is kept when it is legal now (fixed and routed
            // copper) at every narrow sample of this run in such a zone; else the run keeps its necks (a full piece
            // at the pad with a narrow piece further out would have no escape credit). H7-CORE b4: a 0.35 mm track
            // fits between the 0.5 mm pitch neighbours, but the zone necked it in two pieces: paths_low.
            let in_esc = |x: f64, y: f64| self.neck.iter().any(|&(lm, g, zone, _)| lm & (1 << l) != 0 && g.dist(x, y) <= zone
                && self.bd.esc.iter().any(|e| { let bb = g.bbox(); (e.0.0 - bb.0).abs() < 1e-6 && (e.0.1 - bb.1).abs() < 1e-6
                    && (e.0.2 - bb.2).abs() < 1e-6 && (e.0.3 - bb.3).abs() < 1e-6 }));
            let mut widen = false;
            if !self.bd.esc.is_empty() {
                widen = true;
                let mut seen = false;
                for w in poly.windows(2) {
                    let (a, b) = (w[0], w[1]);
                    let k = ((((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt()) / (self.gr.p * 0.5)).ceil().max(1.0) as usize;
                    for t in 0..=k {
                        let f = t as f64 / k as f64;
                        let (x, y) = (a.0 + (b.0 - a.0) * f, a.1 + (b.1 - a.1) * f);
                        if self.hw_at(l, x, y, hw) < hw - 1e-9 && in_esc(x, y) {
                            seen = true;
                            if self.bd.track_cost(net, l, x, y, hw, self.o.plane_clr, None) != 0 {
                                widen = false;
                            }
                        }
                    }
                }
                widen = widen && seen;
            }
            // widths: a segment is split where it enters or leaves a pad-entry neck zone; the narrow piece reaches to
            // the first full-width sample on each side (a sample checked at full width is legal at the neck width)
            for w in poly.windows(2) {
                let (a, b) = (w[0], w[1]);
                let len = ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt();
                let k = (len / (self.gr.p * 0.5)).ceil().max(1.0) as usize;
                let at = |t: usize| { let f = t as f64 / k as f64; (a.0 + (b.0 - a.0) * f, a.1 + (b.1 - a.1) * f) };
                let hs: Vec<f64> = (0..=k).map(|t| { let (x, y) = at(t); self.hw_at(l, x, y, hw) }).collect();
                // v8: a sample next to a neck that hw_at rates full is full only when the full width is legal there
                // against fixed copper: the leg checks (seg_clear) sample at other points, so the end of a full piece
                // at a zone boundary was not always checked at full width (ESP32-CORE b1: audit hard samples at the
                // end of /SW2_LX escapes)
                let (clr, pf) = (self.bd.nets[net].clr, self.bd.pflags(net));
                let any_narrow = hs.iter().any(|&h| h < hw - 1e-9);
                let full_ok = |t: usize| { let (x, y) = at(t);
                    if hs[t] < hw - 1e-9 {
                        widen && in_esc(x, y)
                    } else {
                        !any_narrow || !blocks(self.bd.track_fixed_code(l, x, y, hw, clr, pf, self.o.plane_clr), net as i32)
                    } };
                let fk: Vec<bool> = (0..=k).map(|t| full_ok(t)).collect();
                let mut t0 = 0;
                while t0 < k {
                    let narrow = !fk[t0] || !fk[t0 + 1];
                    let mut t1 = t0 + 1;
                    if narrow {
                        while t1 < k && !fk[t1] {
                            t1 += 1;
                        }
                        let h = hs[t0..=t1].iter().cloned().fold(hw, f64::min);
                        tracks.push((l, at(t0), at(t1), h));
                    } else {
                        while t1 < k && fk[t1 + 1] {
                            t1 += 1;
                        }
                        tracks.push((l, at(t0), at(t1), hw));
                    }
                    t0 = t1;
                }
            }
            self.merge_escapes(net, l, &mut tracks, run0, hw);
        }
        (tracks, vias)
    }
    /// v8 fix 1: the paths gate gives a rated pin escape only to ONE track piece that starts on the pad, no narrower
    /// than the pad's narrow side and no longer than its long side (tools/pcbtool.py pin_escape). The narrow pieces at
    /// the start or the end of a run (tracks[from..]) inside a rated pad become one straight piece: from the far end of
    /// the narrow part to the point where that line is END_IN inside the pad (the inscribed ellipse, as cells_of).
    /// Kept only when it is legal against fixed copper at the neck width and not longer than the escape length.
    fn merge_escapes(&self, net: usize, l: usize, tracks: &mut Vec<(usize, (f64, f64), (f64, f64), f64)>, from: usize, full: f64) {
        for side in 0..2 {
            let n = tracks.len() - from;
            if n == 0 {
                return;
            }
            let at = |k: usize| if side == 0 { from + k } else { tracks.len() - 1 - k };
            let first = tracks[at(0)];
            let p0 = if side == 0 { first.1 } else { first.2 };
            let Some(pad) = self.bd.shapes.iter().find(|s| s.alive && s.net == net as i32 && s.kind == Kind::Pad && s.owner < 0
                && s.layers & (1 << l) != 0 && s.geo.dist(p0.0, p0.1) <= 0.0) else { continue };
            let Some((ew, el, rect)) = self.bd.esc_of(pad) else { continue };
            let mut j = 0;
            while j < n && tracks[at(j)].3 < full - 1e-9 {
                j += 1;
            }
            if j == 0 {
                continue;
            }
            let last = tracks[at(j - 1)];
            let far = if side == 0 { last.2 } else { last.1 };
            let h = (0..j).map(|k| tracks[at(k)].3).fold(full, f64::min).max(ew / 2.0 - 1e-9);
            let start = ellipse_clip(pad.geo.bbox(), p0, far);
            let len = (far.0 - start.0).hypot(far.1 - start.1);
            let old = (0..j).map(|k| { let t = tracks[at(k)]; (t.2.0 - t.1.0).hypot(t.2.1 - t.1.1) }).sum::<f64>();
            if (j == 1 && old <= el - 1e-3) || len < 1e-6 {
                continue;
            }
            let (clr, pf) = (self.bd.nets[net].clr, self.bd.pflags(net));
            let legal = |st: (f64, f64)| {
                let len = (far.0 - st.0).hypot(far.1 - st.1);
                let k = (len / (self.gr.p * 0.5)).ceil().max(1.0) as usize;
                len <= el - 1e-3 && (0..=k).all(|t| {
                    let f = t as f64 / k as f64;
                    let (x, y) = (st.0 + (far.0 - st.0) * f, st.1 + (far.1 - st.1) * f);
                    !blocks(self.bd.track_fixed_code(l, x, y, h, clr, pf, self.o.plane_clr), net as i32)
                })
            };
            // the chord first; else the nearest start inside the pad (0.01 mm lattice: in the rect less END_IN for a
            // rectangular pad, else in the END_IN ellipse) from which one straight legal piece reaches `far` (H7-CORE
            // b4 / b5: the chord passed 0.287 mm from the U3.4 corner, rule 0.29; a start near the pad corner clears it)
            let start = if legal(start) { start } else {
                let bb = pad.geo.bbox();
                let m = END_IN + 0.001;
                let mut cs: Vec<(f64, (f64, f64))> = Vec::new();
                let (nx, ny) = (((bb.2 - bb.0 - 2.0 * m) / 0.01).floor() as i32, ((bb.3 - bb.1 - 2.0 * m) / 0.01).floor() as i32);
                for i in 0..=nx {
                    for jy in 0..=ny {
                        let q = (((bb.0 + m + i as f64 * 0.01) * 1e4).round() / 1e4, ((bb.1 + m + jy as f64 * 0.01) * 1e4).round() / 1e4);
                        if rect || in_ellipse(bb, q) {
                            cs.push(((far.0 - q.0).hypot(far.1 - q.1), q));
                        }
                    }
                }
                cs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap().then(a.1.0.partial_cmp(&b.1.0).unwrap()).then(a.1.1.partial_cmp(&b.1.1).unwrap()));
                match cs.into_iter().map(|c| c.1).find(|&q| legal(q)) { Some(q) => q, None => continue }
            };
            let lo = if side == 0 { from } else { tracks.len() - j };
            let piece = if side == 0 { (l, start, far, h) } else { (l, far, start, h) };
            tracks.splice(lo..lo + j, [piece]);
        }
    }
}

/// v8: the point on the segment from `inside` to `outside` nearest `outside` that is still in the inscribed ellipse of the
/// pad bbox shrunk by END_IN (+ 1 um: the paths gate rounds the node to 1 um), found by bisection (deterministic).
/// `inside` itself when it is not in that ellipse.
fn ellipse_clip(bb: (f64, f64, f64, f64), inside: (f64, f64), outside: (f64, f64)) -> (f64, f64) {
    let (a, b, c, d) = bb;
    let (ex, ey) = (((c - a) / 2.0 - END_IN - 0.001).max(1e-9), ((d - b) / 2.0 - END_IN - 0.001).max(1e-9));
    let inn = |p: (f64, f64)| ((p.0 - (a + c) / 2.0) / ex).powi(2) + ((p.1 - (b + d) / 2.0) / ey).powi(2) <= 1.0;
    if !inn(inside) {
        return inside;
    }
    let pt = |t: f64| (inside.0 + (outside.0 - inside.0) * t, inside.1 + (outside.1 - inside.1) * t);
    let (mut lo, mut hi) = (0.0f64, 1.0f64);
    for _ in 0..40 {
        let m = (lo + hi) / 2.0;
        if inn(pt(m)) { lo = m } else { hi = m }
    }
    let q = pt(lo);
    ((q.0 * 1e4).round() / 1e4, (q.1 * 1e4).round() / 1e4)
}

/// v8: q lies in the inscribed ellipse of the pad bbox shrunk by END_IN + 1 um (as ellipse_clip)
fn in_ellipse(bb: (f64, f64, f64, f64), q: (f64, f64)) -> bool {
    let (a, b, c, d) = bb;
    let (ex, ey) = (((c - a) / 2.0 - END_IN - 0.001).max(1e-9), ((d - b) / 2.0 - END_IN - 0.001).max(1e-9));
    ((q.0 - (a + c) / 2.0) / ex).powi(2) + ((q.1 - (b + d) / 2.0) / ey).powi(2) <= 1.0
}

fn touch(a: &Shape, b: &Shape) -> bool {
    if a.layers & b.layers == 0 {
        return false;
    }
    a.geo.probes().iter().any(|&(x, y, r)| b.geo.dist(x, y) <= r + 1e-3)
        || b.geo.probes().iter().any(|&(x, y, r)| a.geo.dist(x, y) <= r + 1e-3)
}

fn find(p: &mut Vec<usize>, i: usize) -> usize {
    let mut r = i;
    while p[r] != r {
        r = p[r];
    }
    let mut c = i;
    while p[c] != r {
        let n = p[c];
        p[c] = r;
        c = n;
    }
    r
}

fn f(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}

/// Hole rules of the model (src/model/rules.rs, `hole_rules`): (hole_clearance, hole_to_hole, plane_clearance).
/// hole_clearance / hole_to_hole = the largest minimum of the DRU rules and the board minimum (the core applies them to
/// every drilled item, a superset of the DRU scope 'either / both items are through-hole pads'); a missing key = None.
fn hole_rules(model: &Value) -> (Option<f64>, Option<f64>, Option<f64>) {
    let hr = &model["hole_rules"];
    let big = |kind: &str| -> Option<f64> {
        let mut v: Vec<f64> = hr[kind].as_array().map(|a| a.iter().filter_map(|r| r["min"].as_f64()).collect()).unwrap_or_default();
        if v.is_empty() {
            return None;
        }
        if let Some(b) = hr["board_min"][kind].as_f64() {
            v.push(b);
        }
        Some(v.into_iter().fold(0.0, f64::max))
    };
    (big("hole_clearance"), big("hole_to_hole"), hr["plane_clearance"]["min"].as_f64())
}

/// Isolation pair rules (model `iso`, src/model/pairs.rs): groups, pair table, region polygons, and the group list of each
/// net (deduplicated; entry 0 = the no-net list). Nothing when the model has no `iso` (no pair rule on the board).
fn load_iso(bd: &mut Board, model: &Value, names: &std::collections::HashMap<String, usize>) {
    let m = &model["iso"];
    let n = match m["groups"].as_u64() {
        Some(n) if n > 0 => n as usize,
        _ => return,
    };
    let tab: Vec<f64> = m["table"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap_or(0.0)).collect();
    assert_eq!(tab.len(), n * n, "model iso table size");
    let regs: Vec<Vec<Vec<(f64, f64)>>> = m["regions"].as_array().map(|a| a.iter().map(|r| {
        r["polys"].as_array().unwrap().iter().map(|p| p.as_array().unwrap().iter().map(|q| (f(&q[0]), f(&q[1]))).collect()).collect()
    }).collect()).unwrap_or_default();
    let list = |v: &Value| -> Vec<u16> { v.as_array().unwrap().iter().map(|g| g.as_u64().unwrap() as u16).collect() };
    let var_of = |v: &Value| -> [Vec<u16>; 2] { [list(&v["track"]), list(&v["via"])] };
    let mut var: Vec<[Vec<u16>; 2]> = vec![var_of(&m["var"][""])];
    let mut niv = vec![0u32; bd.nets.len()];
    for (name, v) in m["var"].as_object().unwrap() {
        if let Some(&i) = names.get(name) {
            let e = var_of(v);
            niv[i] = match var.iter().position(|x| *x == e) {
                Some(k) => k as u32,
                None => {
                    var.push(e);
                    (var.len() - 1) as u32
                }
            };
        }
    }
    for e in &var {
        assert!(e[0].len() == 1 << regs.len() && e[1].len() == 1 << regs.len(), "model iso var size");
    }
    let (x0, y0) = (bd.idx.x0, bd.idx.y0);
    let (x1, y1) = (x0 + bd.idx.b * bd.idx.nx as f64, y0 + bd.idx.b * bd.idx.ny as f64);
    let nl = bd.layer_names.len();
    bd.prad = (0..n).map(|g| tab[g * n..(g + 1) * n].iter().cloned().fold(0.0, f64::max)).collect();
    bd.pidx = (0..n).map(|_| (Index::with_bucket(x0, y0, x1, y1, nl, 2.0), Index::with_bucket(x0, y0, x1, y1, nl, 2.0))).collect();
    bd.iso = Some(Iso { n, tab, regs, var });
    bd.niv = niv;
}

fn load(model: &Value, hole_clr: f64) -> Board {
    let cu: Vec<String> = model["copper_layers"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
    let planes: Vec<String> = model["plane_layers"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
    let lid = |n: &str| cu.iter().position(|c| c == n);
    let mask = |arr: &Value| -> u8 { arr.as_array().unwrap().iter().filter_map(|v| lid(v.as_str().unwrap())).fold(0u8, |m, l| m | (1 << l)) };
    let routable: Vec<usize> = (0..cu.len()).filter(|&l| !planes.contains(&cu[l])).collect();
    let ob = model["outline_bbox"].as_array().unwrap();
    // outline bbox includes the Edge.Cuts line width (0.1 mm): the edge is 0.05 mm inside
    let edge = (f(&ob[0]) + 0.05, f(&ob[1]) + 0.05, f(&ob[2]) - 0.05, f(&ob[3]) - 0.05);
    let edge_clr = model["setup"]["edge_clearance"].as_f64().unwrap_or(0.5);
    let classes = &model["classes"];
    let min_track = model["setup"]["min_track"].as_f64().unwrap_or(0.0);
    let mut nets = Vec::new();
    let mut names = std::collections::HashMap::new();
    let mut ppoly = Vec::new();
    let mut twin: Vec<i8> = Vec::new();
    for (name, v) in model["nets"].as_object().unwrap() {
        let cls = &classes[v["class"].as_str().unwrap_or("Default")];
        let via = &v["via"];
        let n = Net {
            name: name.clone(),
            width: v["width"].as_f64().unwrap_or(0.15),
            clr: v["clearance"].as_f64().unwrap_or(0.15),
            fast: v["fast"].as_bool().unwrap_or(false),
            plane: v["plane"].as_bool().unwrap_or(false),
            power: v["class"].as_str() == Some("PWR") || v["limits"]["amps"].as_f64().unwrap_or(0.0) > 0.0,
            layers: mask(&v["layers"]),
            via_d: via["via_diameter"].as_f64().or(cls["via"].as_f64()).unwrap_or(0.6),
            via_drill: via["hole_size"].as_f64().or(cls["drill"].as_f64()).unwrap_or(0.3),
            max_vias: v["limits"]["via_count"].as_f64(),
            max_len: v["limits"]["length"].as_f64().filter(|&l| l > 0.0),
            pref: v["plane_ref"].as_bool().unwrap_or(false),
            // never below the board setup minimum track width (KiCad DRC track_width; v4 first run: 0.06 mm necks)
            min_w: v["min_width"].as_f64().filter(|&w| w > 0.0).map(|w| w.max(min_track)).unwrap_or(0.0),
            min_wl: Vec::new(),
            in_vias: v["input_vias"].as_u64().unwrap_or(0) as usize,
        };
        let mut n = n;
        // v8: per-layer current width; min_w = the smallest over the net's layers (the others are layer floors)
        if let Some(o) = v["min_width_layers"].as_object() {
            n.min_wl = vec![0.0; cu.len()];
            for (ln, w) in o {
                if let (Some(l), Some(w)) = (lid(ln), w.as_f64().filter(|&w| w > 0.0)) {
                    n.min_wl[l] = w.max(min_track);
                }
            }
            let lo = (0..cu.len()).filter(|&l| n.layers & (1 << l) != 0 && n.min_wl[l] > 0.0).map(|l| n.min_wl[l]).fold(f64::MAX, f64::min);
            if lo < f64::MAX {
                n.min_w = lo;
            }
        }
        if let Some(t) = v["twin"].as_array() {
            twin.resize(nets.len() + 1, -1);
            twin[nets.len()] = t.get(1).and_then(|q| q.as_str()).and_then(|q| lid(q)).map(|q| q as i8).unwrap_or(-1);
        }
        for p in v["plane_polys"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
            ppoly.push((nets.len(), p.as_array().unwrap().iter().map(|q| (f(&q[0]), f(&q[1]))).collect()));
        }
        names.insert(name.clone(), nets.len());
        nets.push(n);
    }
    let maxc = nets.iter().map(|n| n.clr).fold(0.15, f64::max);
    let idx = Index::new(edge.0 - 1.0, edge.1 - 1.0, edge.2 + 1.0, edge.3 + 1.0, cu.len());
    // the return net (model `return_net`: the first plane ground; an older model: GND)
    let gnd = names.get(model["return_net"].as_str().unwrap_or("GND")).map(|&i| i as i32).unwrap_or(-1);
    let gnds: Vec<i32> = model["return_nets"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().and_then(|n| names.get(n)).map(|&i| i as i32))
        .filter(|&i| i != gnd).collect()).unwrap_or_default();
    let sidx = Index::new(edge.0 - 1.0, edge.1 - 1.0, edge.2 + 1.0, edge.3 + 1.0, cu.len());
    // layers with an adjacent reference plane (reference-planes.json 'adjacent' via the model)
    let adj = model["adjacent"].as_object().map(|o| o.keys().filter_map(|k| lid(k)).fold(0u8, |m, l| m | (1 << l))).unwrap_or(0);
    let mut bd = Board { layer_names: cu.clone(), routable, nets, shapes: Vec::new(), idx, sidx, maxc, edge, edge_clr, gnd, plane_clr: DEF_PLANE_CLR, eps: EPS, hole_clr,
                         spoke_notes: Vec::new(), attach: Vec::new(), spoke_sites: std::collections::HashSet::new(), adj, pad_need: Vec::new(), gnd_fixed: Vec::new(), pours: Vec::new(), circ: std::collections::HashMap::new(), vip: Vec::new(), tvia: Vec::new(), web: 0.0, web_hard: false, via_len: DEF_VIA_LEN, keep: Vec::new(), esc: Vec::new(), edges: Vec::new(), fvia: Vec::new(), iso: None, niv: Vec::new(), ppoly: Vec::new(), twin: Vec::new(), gnds: Vec::new(), pidx: Vec::new(), prad: Vec::new(), noret: Vec::new(), rgn: Vec::new(), rfill: Default::default() };
    bd.ppoly = ppoly;
    bd.gnds = gnds;
    bd.noret = model["return_exempt"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().and_then(|n| names.get(n)).map(|&i| i as i32)).collect()).unwrap_or_default();
    if !twin.is_empty() {
        twin.resize(bd.nets.len(), -1);
    }
    bd.twin = twin;
    load_iso(&mut bd, model, &names);
    bd.rfill = reffill::RefFill::load(model, &cu, &names);
    // isolation: the return ground of each net = the ground (gnd first, then the other grounds) whose via has the
    // smallest pair value with the net's vias (INPUT-4D2A: a FIELD net returns on ISO_0V; GND is 4 mm away by rule)
    if let (Some(i), false) = (&bd.iso, bd.gnds.is_empty()) {
        let cands: Vec<i32> = std::iter::once(bd.gnd).chain(bd.gnds.iter().cloned()).filter(|&g| g >= 0).collect();
        let minpc = |a: u32, b: u32| -> f64 {
            let (ga, gb) = (&i.var[a as usize][1], &i.var[b as usize][1]);
            ga.iter().flat_map(|&p| gb.iter().map(move |&q| i.tab[p as usize * i.n + q as usize])).fold(f64::INFINITY, f64::min)
        };
        let rgn: Vec<i32> = (0..bd.nets.len()).map(|n| {
            let mut best = (f64::INFINITY, bd.gnd);
            for &g in &cands {
                let v = minpc(bd.niv[n], bd.niv[g as usize]);
                if v < best.0 - 1e-9 {
                    best = (v, g);
                }
            }
            best.1
        }).collect();
        bd.rgn = rgn;
    }
    // antipad web (v6 fix 3c): from the zones on the plane layers (their own clearance and min_thickness)
    for z in model["zones"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        if planes.iter().any(|p| Some(p.as_str()) == z["layer"].as_str()) {
            bd.web = bd.web.max(2.0 * z["clearance"].as_f64().unwrap_or(0.0) + z["min_thickness"].as_f64().unwrap_or(0.0));
        }
    }
    // width per power-chain pad (model power_chains): the plane fan-out of that pad keeps it. v8: the width of the
    // pad's own layers (chain min_width_layers) when the model has it
    let mut need_of: std::collections::HashMap<String, (f64, std::collections::HashMap<String, f64>)> = std::collections::HashMap::new();
    for (_, v) in model["nets"].as_object().unwrap() {
        for c in v["power_chains"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
            let w = c["min_width"].as_f64().unwrap_or(0.0);
            for p in c["pads"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
                let e = need_of.entry(p.as_str().unwrap_or("").to_string()).or_insert((0.0, Default::default()));
                e.0 = e.0.max(w);
                for (ln, lw) in c["min_width_layers"].as_object().into_iter().flatten() {
                    let q = e.1.entry(ln.clone()).or_insert(0.0);
                    *q = q.max(lw.as_f64().unwrap_or(0.0));
                }
            }
        }
    }
    let net_of = |n: &str| names.get(n).map(|&i| i as i32).unwrap_or(-1);
    let clr_of = |bd: &Board, n: i32| if n >= 0 { bd.nets[n as usize].clr } else { 0.15 };
    for p in model["pads"].as_array().unwrap() {
        let bb = p["bbox"].as_array().unwrap();
        let net = net_of(p["net"].as_str().unwrap_or(""));
        let layers = mask(&p["layers"]);
        let drill = f(&p["drill"]);
        if layers == 0 && drill > 0.0 {
            // NPTH: no copper, but the hole keeps the hole-to-copper clearance on every layer (.kicad_dru hole_clearance)
            let s = Shape { net: -1, geo: Geo::Circ(f(&p["x"]), f(&p["y"]), drill / 2.0), clr: hole_clr, layers: (1u8 << cu.len()) - 1, drill, kind: Kind::Pad, owner: -1, alive: true, grp: p["iso_grp"].as_u64().unwrap_or(0) as u16 };
            bd.add(s);
            continue;
        }
        let s = Shape { net, geo: Geo::Rect(f(&bb[0]), f(&bb[1]), f(&bb[2]), f(&bb[3])), clr: clr_of(&bd, net), layers, drill, kind: Kind::Pad, owner: -1, alive: true, grp: p["iso_grp"].as_u64().unwrap_or(0) as u16 };
        bd.add(s);
        if p["via_in_pad"].as_bool() == Some(true) && drill == 0.0 {
            bd.vip.push((f(&bb[0]), f(&bb[1]), f(&bb[2]), f(&bb[3])));
            if let Some(t) = p["thermal_vias"].as_object() {
                let pts: Vec<(f64, f64)> = t["vias"].as_array().map(|a| a.iter().map(|q| (f(&q[0]), f(&q[1]))).collect()).unwrap_or_default();
                let name = format!("{}.{}", p["ref"].as_str().unwrap_or(""), p["num"].as_str().unwrap_or(""));
                bd.tvia.push(((f(&bb[0]), f(&bb[1]), f(&bb[2]), f(&bb[3])), pts, f(&t["d"]), f(&t["drill"]), name));
            }
        }
        let (cx, cy) = ((f(&bb[0]) + f(&bb[2])) / 2.0, (f(&bb[1]) + f(&bb[3])) / 2.0);
        if p["shape"].as_str() == Some("circle") {
            bd.circ.insert(((cx * 1e4).round() as i64, (cy * 1e4).round() as i64), (f(&bb[2]) - f(&bb[0])) / 2.0);
        }
        if let Some((w, per)) = need_of.get(&format!("{}.{}", p["ref"].as_str().unwrap_or(""), p["num"].as_str().unwrap_or(""))) {
            let pl: Vec<f64> = p["layers"].as_array().unwrap().iter().filter_map(|n| per.get(n.as_str().unwrap_or("")).cloned()).collect();
            bd.pad_need.push((cx, cy, if pl.is_empty() { *w } else { pl.iter().cloned().fold(0.0, f64::max) }));
        }
        if let Some(v) = p["fanout_via"].as_object() {
            let (dr, d) = (v["hole_size"].as_f64().unwrap_or(0.0), v["via_diameter"].as_f64().unwrap_or(0.0));
            if dr > 0.0 && d > 0.0 {
                bd.fvia.push((cx, cy, d, dr));
            }
        }
        // v8: rated pin escape (model pad escape: tools/pcbtool.py pin_escape with tools/pin-ratings.json)
        if let Some(e) = p["escape"].as_object() {
            let (w, l) = (e["width"].as_f64().unwrap_or(0.0), e["length"].as_f64().unwrap_or(0.0));
            if w > 0.0 && l > 0.0 {
                bd.esc.push(((f(&bb[0]), f(&bb[1]), f(&bb[2]), f(&bb[3])), w.max(min_track), l, p["shape"].as_str() == Some("rect")));
            }
        }
        // a GND through-hole pad is a return only where the gate counts it (model return_rule.pads; kicad-happy alone
        // counts GND vias only: H7-CORE M2, 26 RP-001 findings)
        if (net == gnd || bd.gnds.contains(&net)) && net >= 0 && drill > 0.0 && model["return_rule"]["pads"].as_bool().unwrap_or(true) {
            bd.gnd_fixed.push((f(&p["x"]), f(&p["y"])));
        }
    }
    for c in model["copper"].as_array().unwrap() {
        let net = net_of(c["net"].as_str().unwrap_or(""));
        let clr = clr_of(&bd, net);
        if c["kind"] == "via" {
            let s = Shape { net, geo: Geo::Circ(f(&c["x"]), f(&c["y"]), f(&c["d"]) / 2.0), clr, layers: (1u8 << cu.len()) - 1, drill: f(&c["drill"]), kind: Kind::Via, owner: -1, alive: true, grp: 0 };
            bd.add(s);
            if (net == gnd || bd.gnds.contains(&net)) && net >= 0 {
                bd.gnd_fixed.push((f(&c["x"]), f(&c["y"])));
            }
        } else {
            let (a, b) = (c["a"].as_array().unwrap(), c["b"].as_array().unwrap());
            let l = lid(c["layer"].as_str().unwrap()).unwrap();
            let s = Shape { net, geo: Geo::Seg(f(&a[0]), f(&a[1]), f(&b[0]), f(&b[1]), f(&c["w"]) / 2.0), clr, layers: 1 << l, drill: 0.0, kind: Kind::Track, owner: -1, alive: true, grp: 0 };
            bd.add(s);
        }
    }
    // v8 fix 2: rule areas that keep tracks / vias out (model keepouts; a non-rectangular outline as its bbox)
    for k in model["keepouts"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        let bb = k["bbox"].as_array().unwrap();
        let tl = if k["tracks"].as_bool() == Some(true) { mask(&k["layers"]) } else { 0 };
        let via = k["vias"].as_bool() == Some(true) && mask(&k["layers"]) != 0;
        let pour_l = if k["pour"].as_bool() == Some(true) { mask(&k["layers"]) } else { 0 };
        if tl != 0 || via || pour_l != 0 {
            let pl = |v: &Value| -> Vec<Vec<(f64, f64)>> { v.as_array().map(|a| a.iter().map(|c| c.as_array().unwrap().iter()
                .map(|q| (f(&q[0]), f(&q[1]))).collect()).collect()).unwrap_or_default() };
            let exact = k["rect"].as_bool() != Some(true);
            bd.keep.push(Keep { r: (f(&bb[0]), f(&bb[1]), f(&bb[2]), f(&bb[3])), tl, via,
                                poly: if exact { pl(&k["pts"]) } else { Vec::new() }, holes: if exact { pl(&k["holes"]) } else { Vec::new() }, pl: pour_l });
        }
        if k["pour"].as_bool() == Some(true) {
            bd.spoke_notes.push(format!("rule area {}: no copper pour; not in the pour model (KiCad DRC checks it)", k["name"].as_str().unwrap_or("?")));
        }
        if k["rect"].as_bool() != Some(true) && k["pts"].as_array().map_or(true, |a| a.is_empty()) {
            bd.spoke_notes.push(format!("rule area {}: not a rectangle and no outline; the router keeps out of its bbox", k["name"].as_str().unwrap_or("?")));
        }
    }
    for e in model["edges"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        bd.edges.push((f(&e[0]), f(&e[1]), f(&e[2]), f(&e[3])));
    }
    reserve_spokes(&mut bd, model, &lid, &net_of);
    pour::load_pours(&mut bd, model, &lid, &net_of);
    bd.maxc = bd.shapes.iter().map(|s| s.clr).fold(bd.maxc, f64::max); // query reach: the largest clearance of any item
    if let Some(v) = model["via_length"].as_f64().filter(|&v| v > 0.0) {
        bd.via_len = v;
    }
    bd
}

/// Thermal spoke channels (KiCad `starved_thermal`): a pad of a plane net on an outer layer with a thermal-relief pour
/// of its net (model `zones`) needs `setup.min_spokes` spokes that reach the pour. A spoke is a strip of the pour from
/// the pad edge outward, `spoke_width` wide and `thermal_gap + spoke_width` long; a foreign track within the zone
/// clearance of it cuts it. Per pad the strips (east / west / north / south of the pad bbox) are scanned against the
/// fixed copper; the `min_spokes` free ones with the most free room behind them are reserved as hard obstacles of the
/// pad's net (Kind::Spoke, clearance = zone clearance), so other nets keep out. A pad with fewer free strips gets all
/// of them and a note. Own-net copper (the fan-out track and via) never blocks a strip.
fn reserve_spokes(bd: &mut Board, model: &Value, lid: &dyn Fn(&str) -> Option<usize>, net_of: &dyn Fn(&str) -> i32) {
    let min_sp = model["setup"]["min_spokes"].as_u64().unwrap_or(2) as usize;
    let zones = match model["zones"].as_array() {
        Some(z) => z,
        None => return,
    };
    // (net, layer, clearance, gap, spoke width, tht only, bbox)
    let mut zr: Vec<(i32, usize, f64, f64, f64, bool, [f64; 4])> = Vec::new();
    for z in zones {
        let conn = z["pad_connection"].as_str().unwrap_or("");
        let (Some(l), true) = (lid(z["layer"].as_str().unwrap_or("")), conn == "thermal" || conn == "tht_thermal") else { continue };
        let net = net_of(z["net"].as_str().unwrap_or(""));
        let bb = &z["bbox"];
        if net < 0 || !bd.routable.contains(&l) {
            continue;
        }
        zr.push((net, l, f(&z["clearance"]), f(&z["thermal_gap"]), f(&z["spoke_width"]), conn == "tht_thermal", [f(&bb[0]), f(&bb[1]), f(&bb[2]), f(&bb[3])]));
    }
    let step = 0.1;
    let mut count = 0;
    let mut short = 0;
    for p in model["pads"].as_array().unwrap() {
        let net = net_of(p["net"].as_str().unwrap_or(""));
        let bb = p["bbox"].as_array().unwrap();
        let (x0, y0, x1, y1) = (f(&bb[0]), f(&bb[1]), f(&bb[2]), f(&bb[3]));
        let (cx, cy) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0);
        let drill = f(&p["drill"]);
        if net < 0 || p["layers"].as_array().map(|a| a.is_empty()).unwrap_or(true) {
            continue;
        }
        if matches!(p["zone_conn"].as_str(), Some("none") | Some("full")) {
            continue;
        }
        for &(zn, l, zclr, gap, sw, tht, zb) in &zr {
            let on = p["layers"].as_array().unwrap().iter().any(|v| lid(v.as_str().unwrap_or("")) == Some(l));
            if zn != net || !on || (tht && drill == 0.0) || cx < zb[0] || cx > zb[2] || cy < zb[1] || cy > zb[3] {
                continue;
            }
            let (hw, len) = (sw / 2.0, gap + sw);
            let reach = len + 1.0;
            // KiCad also counts a spoke whose pour is trimmed behind the relief gap (checked on NET-CORE: C13.2, C14.2)
            let partial = (gap + 0.1).min(len);
            // blocked(x, y): the pour is absent at this point of a spoke strip
            // isolation work: no pour in a rule area that forbids it (INPUT-4D2A BARRIER_BAND), and the zone keeps the
            // pair value from foreign copper (KiCad fills it so); the spoke group is the zone net's track group
            let gz = bd.grp_at(bd.iv(net), false, (cx, cy), (cx, cy), 0.0);
            let blocked = |bd: &Board, x: f64, y: f64| -> bool {
                if !bd.inside(x, y, 0.0) || bd.keep.iter().any(|k| k.pl & (1 << l) != 0 && k.touches(x, y, 0.0)) {
                    return true;
                }
                bd.near_in(&bd.idx, l, x, y, 1.0, &mut |_, s| {
                    if s.kind == Kind::Spoke || s.owner >= 0 {
                        return false;
                    }
                    if s.net == net {
                        // another pad of the net: its own relief gap is a hole in the pour
                        let (a, b, c, d) = s.geo.bbox();
                        let me = (a - x0).abs() < 1e-6 && (b - y0).abs() < 1e-6 && (c - x1).abs() < 1e-6 && (d - y1).abs() < 1e-6;
                        return s.kind == Kind::Pad && !me && s.geo.dist(x, y) < gap;
                    }
                    s.geo.dist(x, y) < zclr.max(s.clr).max(bd.pc(gz, s))
                })
            };
            // free length of each direction: 0 east, 1 west, 2 north, 3 south
            let mut cand: Vec<(f64, usize)> = Vec::new();
            for dir in 0..4 {
                let mut free = 0.0;
                let mut t = step;
                while t <= reach + 1e-9 {
                    let mut ok = true;
                    let mut k = -hw;
                    while k <= hw + 1e-9 {
                        let (x, y) = match dir {
                            0 => (x1 + t, cy + k),
                            1 => (x0 - t, cy + k),
                            2 => (cx + k, y0 - t),
                            _ => (cx + k, y1 + t),
                        };
                        if blocked(bd, x, y) {
                            ok = false;
                            break;
                        }
                        k += step;
                    }
                    if !ok {
                        break;
                    }
                    free = t;
                    t += step;
                }
                if free + 1e-9 >= partial {
                    cand.push((free.min(len), dir));
                }
            }
            cand.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap().then(a.1.cmp(&b.1)));
            let free_of = |d: usize| cand.iter().find(|c| c.1 == d).map(|c| c.0).unwrap_or(len);
            for &(_, dir) in cand.iter().take(min_sp) {
                let ln = free_of(dir);
                let g = match dir {
                    0 => Geo::Rect(x1, cy - hw, x1 + ln, cy + hw),
                    1 => Geo::Rect(x0 - ln, cy - hw, x0, cy + hw),
                    2 => Geo::Rect(cx - hw, y0 - ln, cx + hw, y0),
                    _ => Geo::Rect(cx - hw, y1, cx + hw, y1 + ln),
                };
                bd.add(Shape { net, geo: g, clr: zclr, layers: 1 << l, drill: 0.0, kind: Kind::Spoke, owner: -1, alive: true, grp: 0 });
                count += 1;
            }
            if cand.len() < min_sp {
                // KiCad counts a pad copper connection (the pad's own fan-out track) as one spoke (checked on NET-CORE:
                // C14.2 passes with one pour spoke and its track, starves without the track). An SMD pad with no
                // track yet gets a forced fan-out in the plane stage.
                let attached = bd.shapes.iter().any(|s| s.net == net && s.kind == Kind::Track && s.owner < 0 && s.layers & (1 << l) != 0
                    && match s.geo { Geo::Seg(ax, ay, bx, by, h) => Geo::Rect(x0, y0, x1, y1).dist(ax, ay) <= h + 1e-3 || Geo::Rect(x0, y0, x1, y1).dist(bx, by) <= h + 1e-3, _ => false });
                if drill == 0.0 && !attached && cand.len() + 1 >= min_sp {
                    bd.attach.push((cx, cy));
                } else if cand.len() + (attached as usize) < min_sp {
                    short += 1;
                    bd.spoke_notes.push(format!("{}.{} ({:.2}, {:.2}) on {}: {} free spoke channel(s){}, the zone needs {} (fixed copper blocks the rest)",
                                                p["ref"].as_str().unwrap_or("?"), p["num"].as_str().unwrap_or("?"), cx, cy, bd.layer_names[l], cand.len(),
                                                if attached { " + a fixed fan-out track" } else { "" }, min_sp));
                }
            }
        }
    }
    eprintln!("spoke channels: {count} reserved, {} pad(s) get a forced fan-out track, {short} pad(s) stay below {min_sp} (fixed copper)", bd.attach.len());
}


/// Plane fan-out of one plane net: a via (plus a short track) for every SMD pad of the net, unless a fixed via of the
/// net is already within 1 mm. The fan-out is owned by the plane net, so it takes part in the negotiation: when a
/// signal net conflicts with it, the whole fan-out of that plane net is ripped up and placed again at the present
/// costs (it is not a hard wall that can enclose pins).
fn fanout_net(ctx: &mut Ctx, net: usize) -> NetResult {
    let via0 = (ctx.bd.nets[net].via_d, ctx.bd.nets[net].via_drill);
    let r = fanout_net_inner(ctx, net);
    if (ctx.bd.nets[net].via_d, ctx.bd.nets[net].via_drill) != via0 {
        ctx.bd.nets[net].via_d = via0.0;
        ctx.bd.nets[net].via_drill = via0.1;
        ctx.gr.reset_cache();
    }
    ctx.neck.clear();
    ctx.lfloor.clear();
    ctx.leaf_necks = false;
    r
}

fn fanout_net_inner(ctx: &mut Ctx, net: usize) -> NetResult {
    if !ctx.fan_keep {
        for s in ctx.bd.shapes.iter_mut() {
            if s.owner == net as i32 {
                s.alive = false;
            }
        }
    }
    let mut out = NetResult { hard_fail: None, limit: false, conflicts: 0, cost: 0.0 };
    let all = (1u8 << ctx.bd.layer_names.len()) - 1;
    let pads: Vec<Shape> = ctx.bd.shapes.iter().filter(|s| s.alive && s.net == net as i32 && s.kind == Kind::Pad && s.drill == 0.0).cloned().collect();
    let mut misses = Vec::new();
    let pres = ctx.gr.pres as f64;
    // v8b: the net's own via; a pad in the model fanout_via list gets its larger via for its fan-out only
    let via0 = (ctx.bd.nets[net].via_d, ctx.bd.nets[net].via_drill);
    for pad in pads {
        if (ctx.bd.nets[net].via_d, ctx.bd.nets[net].via_drill) != via0 {
            ctx.bd.nets[net].via_d = via0.0;
            ctx.bd.nets[net].via_drill = via0.1;
            ctx.gr.reset_cache();
        }
        let vip = ctx.bd.is_vip(&pad);
        let (cx, cy) = match pad.geo { Geo::Rect(a, b, c, d) => ((a + c) / 2.0, (b + d) / 2.0), _ => continue };
        if let Some(&(_, _, d, dr)) = ctx.bd.fvia.iter().find(|q| (q.0 - cx).abs() < 1e-6 && (q.1 - cy).abs() < 1e-6) {
            ctx.bd.nets[net].via_d = d;
            ctx.bd.nets[net].via_drill = dr;
            ctx.gr.reset_cache();
        }
        // a fixed via within 1 mm counts (input copper); a routed via counts only when it touches this pad: the
        // fan-out via of a neighbour pad has no copper to it (DESIGN 5a: every plane-net SMD pad gets its own via)
        // a pad on the gate viapads allow list needs a via inside it (the gate reports an allow entry with no via as
        // stale, exit 2: v6 t1, U1.129 got its via beside the pad; the datasheets ask for vias in these exposed pads)
        let has = ctx.bd.shapes.iter().any(|s| s.alive && s.net == net as i32 && s.kind == Kind::Via
            && (if vip { matches!(s.geo, Geo::Circ(x, y, _) if pad.geo.dist(x, y) <= 0.0) }
                else if s.owner < 0 { s.geo.dist(cx, cy) < 1.0 } else { touch(s, &pad) }));
        // a pad short of thermal spokes gets its own fan-out track even next to a fixed via (the track is one spoke)
        let forced = ctx.bd.attach.iter().any(|&(ax, ay)| (ax - cx).abs() < 1e-6 && (ay - cy).abs() < 1e-6);
        if has && !forced {
            continue;
        }
        // reuse: a kept fan-out (own routed copper that touches the pad, forced fan-out tracks included) stays
        if ctx.fan_keep && ctx.bd.shapes.iter().any(|s| s.alive && s.owner == net as i32 && s.net == net as i32 && touch(s, &pad)) {
            continue;
        }
        let (pw, ph) = match pad.geo { Geo::Rect(a, b, c, d) => (c - a, d - b), _ => (0.3, 0.3) };
        let via_r = ctx.bd.nets[net].via_d / 2.0;
        let relief = ctx.bd.pours.iter().filter(|p| p.net == net as i32).map(|p| p.gap + p.mt / 2.0).fold(0.0, f64::max);
        let others: Vec<Geo> = if forced {
            ctx.bd.shapes.iter().filter(|s| s.alive && s.net == net as i32 && s.kind == Kind::Pad && s.owner < 0 && s.geo.bbox() != pad.geo.bbox()
                && s.geo.dist(cx, cy) < 3.0).map(|s| s.geo).collect()
        } else { Vec::new() };
        let mut done = false;
        let mut limited = false;
        // a pad of a power chain (current-paths.json) keeps the width its current needs on its fan-out track
        let need = ctx.bd.pad_need.iter().filter(|q| (q.0 - cx).abs() < 1e-6 && (q.1 - cy).abs() < 1e-6).map(|q| q.2).fold(0.0, f64::max);
        // v6 (t1, U8.6): a forced fan-out is one straight 0/45/90 segment from the pad centre to a via in the fill. KiCad
        // counts a track spoke per segment that starts in the pad and ends in the fill; a pulled path or a neck split
        // ended its first segment in the relief gap (no spoke). One width: the pad's narrower side (never below the
        // current width), the pad-entry neck of fix 4 over the short stub.
        if forced && !ctx.bd.spoke_sites.is_empty() {
            let l = ctx.bd.routable.iter().cloned().find(|&l| pad.layers & (1 << l) != 0).unwrap_or(0);
            let full = ctx.bd.nets[net].width.max(need) / 2.0;
            let h0 = ((pw.min(ph)) / 2.0).max(need / 2.0).max(ctx.bd.nets[net].min_w / 2.0).min(full);
            let (d, dr, hth) = (ctx.bd.nets[net].via_d, ctx.bd.nets[net].via_drill, ctx.o.hth);
            let p = ctx.gr.p;
            let mut best: Option<(f64, f64, f64, bool)> = None;
            let s2 = std::f64::consts::FRAC_1_SQRT_2;
            // v8b: vias of the net that stay while it stays (its own fan-out vias, fixed vias): a straight track to one
            // in the fill is a spoke too, with no new via (ESP32-CORE c5 diag: the forced fan-outs of U12.2 / U12.3,
            // 0.65 mm apart in one column, both took the south ray and put their vias 0.3 mm apart: a GND-GND
            // hole-to-hole conflict that names no other net, from iteration 17 to 80)
            let own_vias: Vec<(f64, f64)> = ctx.bd.shapes.iter().filter(|v| v.alive && v.net == net as i32 && v.kind == Kind::Via
                && (v.owner == net as i32 || v.owner < 0)).filter_map(|v| match v.geo { Geo::Circ(x, y, _) => Some((x, y)), _ => None }).collect();
            for (dx, dy) in [(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0), (s2, s2), (s2, -s2), (-s2, s2), (-s2, -s2)] {
                let mut t = 0.35 + pw.max(ph) / 2.0;
                while t <= 2.0 + pw.max(ph) / 2.0 {
                    let (x, y) = (cx + dx * t, cy + dy * t);
                    t += p;
                    if pad.geo.dist(x, y) < 0.35 || others.iter().any(|g| g.dist(x, y) < via_r + relief) || !ctx.bd.in_plane(net, x, y) {
                        continue;
                    }
                    let (gi, gj) = ctx.gr.at(x, y);
                    let (gx, gy) = ctx.gr.xy(gi, gj);
                    if !ctx.bd.spoke_sites.contains(&((gx * 1e3).round() as i64, (gy * 1e3).round() as i64)) {
                        continue;
                    }
                    let share = own_vias.iter().any(|&(vx, vy)| (vx - x).abs() < p * 0.5 + 1e-9 && (vy - y).abs() < p * 0.5 + 1e-9);
                    let kv = if share { 0 } else { ctx.bd.via_cost(net, x, y, d, dr, hth, None) };
                    if kv < 0 || (ctx.strict && kv > 0) {
                        continue;
                    }
                    let len = (x - cx).hypot(y - cy);
                    let n = (len / (p * 0.5)).ceil().max(1.0) as usize;
                    let mut kt = 0;
                    let mut ok = true;
                    for q in 0..=n {
                        let f = q as f64 / n as f64;
                        let c = ctx.bd.track_cost(net, l, cx + (x - cx) * f, cy + (y - cy) * f, h0, ctx.o.plane_clr, None);
                        if c < 0 || (ctx.strict && c > 0) {
                            ok = false;
                            break;
                        }
                        kt += c;
                    }
                    if !ok {
                        continue;
                    }
                    let score = len * (1.0 + pres * (kv + kt) as f64);
                    if best.map(|b| score < b.0).unwrap_or(true) {
                        best = Some((score, x, y, share));
                    }
                    // the nearest legal site on this ray; v8b: past a site in conflict the ray goes on to a free one
                    if kv + kt == 0 || kt > 0 {
                        break;
                    }
                }
            }
            if let Some((_, x, y, share)) = best {
                add_copper(ctx, net, net as i32, &[(l, (cx, cy), (x, y), h0)], &[]);
                let n_ = ctx.bd.nets[net].clone();
                if !share {
                    ctx.bd.add(Shape { net: net as i32, geo: Geo::Circ(x, y, n_.via_d / 2.0), clr: n_.clr, layers: all, drill: n_.via_drill, kind: Kind::Via, owner: net as i32, alive: true, grp: 0 });
                }
                continue;
            }
        }
        // v6 fix 4: the class width (raised to the pad's current need) with a neck only at the pad entry; narrower
        // widths only when the full width has no path past fixed copper
        let _ = (pw, ph);
        let mut ws = vec![ctx.bd.nets[net].width.max(need), 0.3f64.max(need), 0.15f64.max(need)];
        ws.retain(|&w| w <= ctx.bd.nets[net].width.max(need) + 1e-9);
        ws.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
        // v8: the via sites lie within 2 mm of the pad centre; only when that window has none, 3 mm (a pad ringed by
        // pads of its own net, as the 3 x 3 exposed-pad grid of a module, has its nearest legal site further out:
        // BASE-PWR-C U1.41, 2.2 mm; a via may not sit on an own-net SMD pad, tools/pcbtool.py viapads)
        'reach: for rad in [2.0f64, 3.0] {
        for &w in &ws {
            let hw = w / 2.0;
            ctx.set_neck(net, hw);
            ctx.gr.reset_cache();
            let src = ctx.cells_of(&pad, pad.layers);
            ctx.gr.tgen += 1;
            let tg = ctx.gr.tgen;
            let (i0, j0) = ctx.gr.at(cx - rad, cy - rad);
            let (i1, j1) = ctx.gr.at(cx + rad, cy + rad);
            let r = ctx.bd.routable.iter().position(|&l| pad.layers & (1 << l) != 0).unwrap_or(0);
            let n = ctx.gr.nx * ctx.gr.ny;
            let mut cands = Vec::new();
            for j in j0..=j1 {
                for i in i0..=i1 {
                    let (x, y) = ctx.gr.xy(i, j);
                    if (pad.geo.dist(x, y) < 0.35 && !vip) || !ctx.bd.in_plane(net, x, y) {
                        continue;
                    }
                    if vip && !matches!(pad.geo, Geo::Rect(a, b, c, d) if x >= a + via_r && x <= c - via_r && y >= b + via_r && y <= d - via_r) {
                        continue; // the via lies inside the allowed pad
                    }
                    // a forced fan-out is a track spoke: KiCad counts it only when its far end (the via) lies in the
                    // pour fill, so the via keeps the relief gap from every other pad of the net (v6, t1: U8.6 got a via
                    // on the U8 exposed pad, no spoke, starved_thermal)
                    if forced && (others.iter().any(|g| g.dist(x, y) < via_r + relief)
                        || (!ctx.bd.spoke_sites.is_empty() && !ctx.bd.spoke_sites.contains(&((x * 1e3).round() as i64, (y * 1e3).round() as i64)))) {
                        continue;
                    }
                    let (Some(kv), Some(kt)) = (ctx.vcost(net, i, j), ctx.cost(net, r * n + j * ctx.gr.nx + i, hw)) else { continue };
                    if ctx.strict && kv + kt > 0 {
                        continue;
                    }
                    // the via site takes part in the negotiation like a path cell: history and present cost
                    let hc = (ctx.gr.hist[r * n + j * ctx.gr.nx + i] + ctx.gr.vhist[j * ctx.gr.nx + i]) as f64;
                    cands.push((pad.geo.dist(x, y) * (1.0 + hc) * (1.0 + pres * (kv + kt) as f64), x, y, kv, r * n + j * ctx.gr.nx + i));
                }
            }
            // v8b (ESP32-CORE c4, GND standoff from iteration 17 to 80): two GND pads 0.65 mm apart (U12) with one free
            // via site between the routed nets: each pad wanted its own new via, the two vias broke hole-to-hole, and
            // the conflict was GND against GND, so the audit named no other net and the negotiation never moved the
            // nets that took the other sites. When no new site is free (strict: none at all; else every site has a
            // via conflict), the fan-out may also end on a via of the net already there (a track to it, no new via).
            let kmin = cands.iter().map(|c| c.3).min().unwrap_or(u32::MAX);
            let mut share: Vec<(usize, f64, f64)> = Vec::new();
            if kmin > 0 && !vip && !forced && need == 0.0 {
                // only vias that stay while this net stays: its own fan-out vias and fixed vias (a return via of a
                // signal net goes away when that net is ripped up)
                for v in ctx.bd.shapes.iter().filter(|v| v.alive && v.net == net as i32 && v.kind == Kind::Via && (v.owner == net as i32 || v.owner < 0)) {
                    let Geo::Circ(x, y, _) = v.geo else { continue };
                    if (x - cx).abs() > rad || (y - cy).abs() > rad || pad.geo.dist(x, y) < 0.35 {
                        continue;
                    }
                    let (i, j) = ctx.gr.at(x, y);
                    share.push((r * n + j * ctx.gr.nx + i, x, y));
                }
                share.retain(|q| ctx.cost(net, q.0, hw).map_or(false, |k| !ctx.strict || k == 0));
            }
            if cands.is_empty() && share.is_empty() {
                continue;
            }
            // the search ends at the first target it reaches and does not price the via itself: offer only the via
            // sites with the fewest via conflicts
            for c in cands.iter().filter(|c| c.3 == kmin) {
                ctx.gr.tgt[c.4] = tg;
            }
            for q in &share {
                ctx.gr.tgt[q.0] = tg;
            }
            cands.retain(|c| c.3 == kmin);
            cands.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
            let anchors = if cands.is_empty() { share.iter().map(|q| (q.1, q.2)).collect() } else { vec![(cands[0].1, cands[0].2)] };
            // the via sites are within 2 mm: search the pad's box first (a bounded flood even at a high present
            // cost); no path there = whole board; a search stopped by its pop cap is not a proof (limit, not a miss)
            let full = (0, 0, ctx.gr.nx - 1, ctx.gr.ny - 1);
            let (b0, b1) = (ctx.gr.at(cx - rad - 1.0, cy - rad - 1.0), ctx.gr.at(cx + rad + 1.0, cy + rad + 1.0));
            let mut found = ctx.search_n(net, hw, &src, &anchors, false, 1.0, ctx.strict, 2_000_000, (b0.0, b0.1, b1.0, b1.1));
            if found == Err(false) {
                found = ctx.search_n(net, hw, &src, &anchors, false, 1.0, ctx.strict, 2_000_000, full);
            }
            if found == Err(true) {
                limited = true;
            }
            if let Ok(path) = found {
                let last = *path.last().unwrap();
                let (_, iy, ix) = ctx.gr.cell(last);
                let (vx, vy) = ctx.gr.xy(ix, iy);
                // conflicts at routing time (log only; the end-of-iteration audit decides rip-up and history)
                let mut k: u32 = path.iter().map(|&c| ctx.cost(net, c, hw).unwrap_or(0)).sum();
                let n_ = ctx.bd.nets[net].clone();
                k += ctx.vcost(net, ix, iy).unwrap_or(0);
                out.conflicts += k;
                let (tr, _) = ctx.geometry(net, &path, hw);
                add_copper(ctx, net, net as i32, &tr, &[]);
                // v8b: a path that ends on a via of the net already there adds no via
                if !share.iter().any(|q| q.0 == last) {
                    ctx.bd.add(Shape { net: net as i32, geo: Geo::Circ(vx, vy, n_.via_d / 2.0), clr: n_.clr, layers: all, drill: n_.via_drill, kind: Kind::Via, owner: net as i32, alive: true, grp: 0 });
                }
                done = true;
                break 'reach;
            }
        }
        }
        if !done {
            if limited {
                out.limit = true;
                out.conflicts += 1000;
            }
            misses.push(format!("({cx:.2}, {cy:.2}){}", if limited { " (search limit)" } else { "" }));
        }
    }
    if !misses.is_empty() {
        out.hard_fail = Some(format!("no via site within 3 mm of {} pad(s): {}", misses.len(), misses.join(" ")));
    }
    out
}

fn add_copper(ctx: &mut Ctx, net: usize, owner: i32, tracks: &[(usize, (f64, f64), (f64, f64), f64)], vias: &[(f64, f64)]) {
    let clr = ctx.bd.nets[net].clr;
    for &(l, a, b, hw) in tracks {
        if (a.0 - b.0).abs() < 1e-9 && (a.1 - b.1).abs() < 1e-9 {
            continue;
        }
        ctx.bd.add(Shape { net: net as i32, geo: Geo::Seg(a.0, a.1, b.0, b.1, hw), clr, layers: 1 << l, drill: 0.0, kind: Kind::Track, owner, alive: true, grp: 0 });
        // parallel copy: the same track on the twin layer
        if let Some(t) = ctx.bd.twin_of(net).filter(|&t| t != l) {
            ctx.bd.add(Shape { net: net as i32, geo: Geo::Seg(a.0, a.1, b.0, b.1, hw), clr, layers: 1 << t, drill: 0.0, kind: Kind::Track, owner, alive: true, grp: 0 });
        }
    }
    let all = (1u8 << ctx.bd.layer_names.len()) - 1;
    for &(x, y) in vias {
        let (d, dr) = (ctx.bd.nets[net].via_d, ctx.bd.nets[net].via_drill);
        ctx.bd.add(Shape { net: net as i32, geo: Geo::Circ(x, y, d / 2.0), clr, layers: all, drill: dr, kind: Kind::Via, owner, alive: true, grp: 0 });
    }
}

struct NetResult {
    hard_fail: Option<String>,
    limit: bool,
    conflicts: u32,
    /// A* cost (g at the target) of the joins routed, summed: the price of the route in the search units
    cost: f64,
}

/// Rip up the copper this net routed before, then join its components again against the present congestion.
fn route_net(ctx: &mut Ctx, net: usize) -> NetResult {
    release_returns(ctx, net);
    ctx.ret_soft = false;
    let r = match ctx.layer_choice(net) {
        Some(cands) => layers::route_one_layer(ctx, net, &cands),
        None => route_net_inner(ctx, net),
    };
    ctx.ret_soft = true;
    ctx.neck.clear(); // the neck zones belong to this net only
    ctx.stub_cost = Default::default();
    ctx.lfloor.clear();
    ctx.leaf_necks = false;
    r
}

fn route_net_inner(ctx: &mut Ctx, net: usize) -> NetResult {
    for s in ctx.bd.shapes.iter_mut() {
        if s.owner == net as i32 {
            s.alive = false;
        }
    }
    let mut out = NetResult { hard_fail: None, limit: false, conflicts: 0, cost: 0.0 };
    let items: Vec<usize> = (0..ctx.bd.shapes.len()).filter(|&i| { let s = &ctx.bd.shapes[i]; s.alive && s.net == net as i32 && s.owner < 0 && s.kind != Kind::Spoke }).collect();
    if items.len() < 2 {
        return out;
    }
    let mut par: Vec<usize> = (0..items.len()).collect();
    for a in 0..items.len() {
        for b in a + 1..items.len() {
            if touch(&ctx.bd.shapes[items[a]], &ctx.bd.shapes[items[b]]) {
                let (ra, rb) = (find(&mut par, a), find(&mut par, b));
                par[ra] = rb;
            }
        }
    }
    let mut comps: Vec<Vec<usize>> = Vec::new();
    let mut root_of = std::collections::HashMap::new();
    for a in 0..items.len() {
        let r = find(&mut par, a);
        let k = *root_of.entry(r).or_insert_with(|| { comps.push(vec![]); comps.len() - 1 });
        comps[k].push(items[a]);
    }
    let nmask = ctx.bd.nets[net].layers;
    let widths = net_widths(&ctx.bd.nets[net]);
    let base_w = widths[0];
    ctx.ban.clear();
    // DRU via_count: the locked input vias of the net count too (KiCad too_many_vias counts every via of the net)
    let mut used_vias = ctx.bd.nets[net].in_vias;
    let max_vias = ctx.bd.nets[net].max_vias;
    if !ctx.dead[net].0.is_empty() {
        let dead = ctx.dead[net].0.clone();
        comps.retain(|c| !c.iter().any(|s| dead.contains(s)));
        out.hard_fail = Some(ctx.dead[net].1.clone());
        if comps.len() < 2 {
            return out;
        }
    }
    let nbox = {
        let (mut a, mut b, mut c, mut d) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for &s in comps.iter().flatten() {
            let (x0, y0, x1, y1) = ctx.bd.shapes[s].geo.bbox();
            a = a.min(x0);
            b = b.min(y0);
            c = c.max(x1);
            d = d.max(y1);
        }
        let (i0, j0) = ctx.gr.at(a - JOIN_MARGIN, b - JOIN_MARGIN);
        let (i1, j1) = ctx.gr.at(c + JOIN_MARGIN, d + JOIN_MARGIN);
        (i0, j0, i1, j1)
    };
    // v8: leaf components of a power net (only pads in no power chain, ESP32-CORE U2.5 MODE pin) are joined last and
    // are the only targets then: their entry necks below the current width (leaf_necks) and the chain current never
    // passes them (ESP32-CORE b6: VSYS_IN D2.1 -> U2.3 ran through the U2.5 necks, paths_low)
    let power = ctx.bd.nets[net].power && !ctx.bd.nets[net].plane;
    let is_leaf = |ctx: &Ctx, c: &Vec<usize>| power && c.iter().all(|&s| {
        let sh = &ctx.bd.shapes[s];
        let (a, b, cc, d) = sh.geo.bbox();
        let (cx, cy) = ((a + cc) / 2.0, (b + d) / 2.0);
        sh.kind == Kind::Pad && !ctx.bd.pad_need.iter().any(|q| (q.0 - cx).abs() < 1e-6 && (q.1 - cy).abs() < 1e-6 && q.2 > 0.0)
    });
    if is_leaf(ctx, &comps[0]) {
        if let Some(k) = (0..comps.len()).find(|&k| !is_leaf(ctx, &comps[k])) {
            comps.swap(0, k);
        }
    }
    let mut tree = comps.remove(0);
    let mut trapped: Vec<String> = Vec::new();
    let mut ret_rejects = 0usize;
    // v7 DRU length (KiCad length_out_of_range): locked tracks and vias of the net count; each join may add what is left
    let max_len = ctx.bd.nets[net].max_len;
    let via_len = ctx.bd.via_len;
    let mut len_used: f64 = ctx.bd.nets[net].in_vias as f64 * via_len + ctx.bd.shapes.iter()
        .filter(|s| s.alive && s.owner < 0 && s.net == net as i32 && s.kind == Kind::Track)
        .map(|s| match s.geo { Geo::Seg(ax, ay, bx, by, _) => (bx - ax).hypot(by - ay), _ => 0.0 }).sum::<f64>();
    while !comps.is_empty() {
        ctx.leaf_necks = comps.iter().all(|c| is_leaf(ctx, c));
        let leaf_phase = ctx.leaf_necks;
        ctx.len_cap = max_len.map(|m| m - len_used);
        ctx.len_boxes = comps.iter().flatten().map(|&s| ctx.bd.shapes[s].geo.bbox()).collect();
        // via budget of this join (None: no DRU via_count for the net)
        let budget: Option<usize> = max_vias.map(|m| (m.floor() as i64 - used_vias as i64).max(0) as usize);
        // via tries: free vias; then vias priced up (x10, x100) and none, until the path keeps the budget
        let tries: Vec<(bool, f64)> = match budget {
            None => vec![(true, 1.0)],
            Some(0) => vec![(false, 1.0)],
            Some(_) => vec![(true, 1.0), (true, 10.0), (true, 100.0), (false, 1.0)],
        };
        let mut over_budget = false;
        // best width: the widest with the fewest conflicts (power nets neck only when it removes conflicts, never below
        // the width of their design current)
        let mut best: Option<(u32, f64, Vec<usize>)> = None;
        let mut best_g = 0.0f64;
        // v8b: the escape stubs of the best try: source stubs (end cell -> stub) and target stubs (end cell -> stub, pad)
        let mut best_stubs: (std::collections::HashMap<usize, Stub>, std::collections::HashMap<usize, (Stub, usize)>) = Default::default();
        let mut limit = false;
        for (wi, &w) in widths.iter().enumerate() {
            if wi > 0 && w >= base_w {
                continue;
            }
            let hw = w / 2.0;
            ctx.set_neck(net, hw);
            ctx.gr.reset_cache();
            let mut src = Vec::new();
            for &s in &tree {
                let sh = ctx.bd.shapes[s].clone();
                src.extend(ctx.cells_of(&sh, nmask));
            }
            // v8b: a rated pad of the tree is also left through one of its straight escape stubs (Ctx::escape_stubs);
            // not in the leaf phase: a leaf branch carries no chain current and may join the tree anywhere
            let mut s_stub: std::collections::HashMap<usize, Stub> = std::collections::HashMap::new();
            let mut t_stub: std::collections::HashMap<usize, (Stub, usize)> = std::collections::HashMap::new();
            let (mut s_cost, mut t_cost) = (std::collections::HashMap::new(), std::collections::HashMap::new());
            if !ctx.bd.esc.is_empty() && !leaf_phase {
                let src_set: std::collections::HashSet<usize> = src.iter().cloned().collect();
                for &s in &tree {
                    if ctx.bd.shapes[s].kind != Kind::Pad || ctx.bd.shapes[s].owner >= 0 {
                        continue;
                    }
                    for st in ctx.escape_stubs(net, s) {
                        if src_set.contains(&st.cell) || s_stub.contains_key(&st.cell) {
                            continue;
                        }
                        if let Some(c) = ctx.stub_price(net, &st) {
                            s_stub.insert(st.cell, st);
                            s_cost.insert(st.cell, c);
                            src.push(st.cell);
                        }
                    }
                }
            }
            ctx.gr.tgen += 1;
            let tg = ctx.gr.tgen;
            let mut anchors = Vec::new();
            let mut open = false;
            for comp in &comps {
                if !leaf_phase && is_leaf(ctx, comp) {
                    continue; // v8: leaf pads are joined last
                }
                for &s in comp {
                    let sh = ctx.bd.shapes[s].clone();
                    for c in ctx.cells_of(&sh, nmask) {
                        ctx.gr.tgt[c] = tg;
                        open = open || ctx.cost(net, c, hw).is_some();
                    }
                    for (x, y, _) in sh.geo.probes() {
                        anchors.push((x, y));
                    }
                }
            }
            // v8b: a rated pad to join is also reached at the end cell of one of its escape stubs
            if !ctx.bd.esc.is_empty() {
                for comp in &comps {
                    if !leaf_phase && is_leaf(ctx, comp) {
                        continue;
                    }
                    for &s in comp {
                        if ctx.bd.shapes[s].kind != Kind::Pad || ctx.bd.shapes[s].owner >= 0 {
                            continue;
                        }
                        for st in ctx.escape_stubs(net, s) {
                            if ctx.gr.tgt[st.cell] == tg {
                                continue;
                            }
                            if let Some(c) = ctx.stub_price(net, &st) {
                                ctx.gr.tgt[st.cell] = tg;
                                t_stub.insert(st.cell, (st, s));
                                t_cost.insert(st.cell, c);
                                open = open || ctx.cost(net, st.cell, hw).is_some();
                            }
                        }
                    }
                }
            }
            // no target cell open: no path at this width (proved without a search). A wider try is only a
            // preference (the narrowest width is always tried last and the blocked set grows with the width), so its
            // search is bounded
            let last = wi + 1 == widths.len();
            if !open {
                continue;
            }
            ctx.stub_cost = (s_cost, t_cost);
            let mut found = Err(false);
            for &(allow_via, vm) in &tries {
                found = join_search(ctx, net, hw, &src, &anchors, allow_via, vm, last, nbox);
                match &found {
                    Ok(path) if budget.map(|b| path_vias(&ctx.gr, path) > b).unwrap_or(false) => {
                        over_budget = true;
                        found = Err(false);
                    }
                    Ok(_) => break,
                    // no path even with free vias: fewer vias cannot help
                    Err(false) if allow_via && vm == 1.0 => break,
                    Err(_) => {}
                }
            }
            if found == Err(false) && budget.is_some() && !over_budget && last {
                // no path within the budget: say so when a path with more vias exists (a via_count fail, not a wall)
                let full = (0, 0, ctx.gr.nx - 1, ctx.gr.ny - 1);
                over_budget = ctx.reachable(net, hw, &src, ctx.strict, true, full);
            }
            if let Err(true) = found {
                limit = limit || last;
            }
            if let Ok(path) = found {
                best_g = ctx.gr.g[*path.last().unwrap()] as f64;
                let k: u32 = path.iter().map(|&c| ctx.cost(net, c, hw).unwrap_or(0)).sum();
                // v6 fix 4: the widest width with a path, conflicts or not (the negotiation moves the other nets); v5
                // took a narrower width whenever it had fewer conflicts (133 power segments necked to 0.3 mm on M2)
                best = Some((k, w, path));
                best_stubs = (s_stub, t_stub);
                ctx.stub_cost = Default::default();
                break;
            }
            ctx.stub_cost = Default::default();
        }
        if best.is_none() && over_budget && !limit {
            let pads: Vec<String> = comps.iter().flat_map(|c| tree_pads(ctx, c)).collect();
            out.hard_fail = Some(format!("DRU via_count max {} (locked input vias {}): no path with at most {} via(s) to pad(s) at {}",
                                         max_vias.unwrap_or(0.0), ctx.bd.nets[net].in_vias, budget.unwrap_or(0), pads.join(",")));
            break;
        }
        if best.is_none() && !limit && max_len.is_some() {
            // no path under the length cap: a DRU length fail when a path exists without the cap (not a wall)
            let hw = widths.last().unwrap() / 2.0;
            ctx.set_neck(net, hw);
            ctx.gr.reset_cache();
            let src: Vec<usize> = tree.iter().flat_map(|&s| { let sh = ctx.bd.shapes[s].clone(); ctx.cells_of(&sh, nmask) }).collect();
            let full = (0, 0, ctx.gr.nx - 1, ctx.gr.ny - 1);
            ctx.gr.tgen += 1;
            let tg = ctx.gr.tgen;
            for &s in comps.iter().flatten() {
                let sh = ctx.bd.shapes[s].clone();
                for c in ctx.cells_of(&sh, nmask) {
                    ctx.gr.tgt[c] = tg;
                }
            }
            if ctx.reachable(net, hw, &src, ctx.strict, true, full) {
                let pads: Vec<String> = comps.iter().flat_map(|c| tree_pads(ctx, c)).collect();
                out.hard_fail = Some(format!("DRU length max {:.2} mm: no path within the {:.2} mm left (locked and routed {:.2} mm, via {:.3} mm) to pad(s) at {}",
                                             max_len.unwrap(), ctx.len_cap.unwrap_or(0.0), len_used, via_len, pads.join(",")));
                break;
            }
        }
        let Some((k, w, path)) = best else {
            if limit {
                out.conflicts += 1000; // search limit: not proven blocked, try again next iteration
                out.limit = true;
                out.hard_fail = Some(format!("A* search limit reached, {} component(s) not joined", comps.len()));
            } else if tree_pads(ctx, &tree).len() > 0 && !comps.is_empty() && trapped.len() < 4
                && tree_pads(ctx, &tree).len() < comps.iter().map(|c| tree_pads(ctx, c).len()).sum::<usize>() {
                // the start side has fewer pads than the rest: it is the walled-in side. Record it, go on from the
                // next component
                trapped.push(tree_pads(ctx, &tree).join(","));
                if !ctx.strict {
                    let ids: Vec<usize> = tree.iter().cloned().filter(|&s| ctx.bd.shapes[s].owner < 0).collect();
                    ctx.dead[net].0.extend(ids);
                }
                tree = comps.remove(0);
                continue;
            } else {
                let pads: Vec<String> = comps.iter().flat_map(|c| tree_pads(ctx, c)).collect();
                out.hard_fail = Some(format!("{} component(s) not reachable past fixed copper: pad(s) at {}", comps.len(), pads.join(",")));
                if !ctx.strict {
                    let ids: Vec<usize> = comps.iter().flatten().cloned().collect();
                    ctx.dead[net].0.extend(ids);
                    ctx.dead[net].1 = out.hard_fail.clone().unwrap();
                }
                if std::env::var("IOTROUTE_DEBUG").is_ok() {
                    let hw = widths.last().unwrap() / 2.0;
                    ctx.gr.reset_cache();
                    for (ci, comp) in std::iter::once(&tree).chain(comps.iter()).enumerate() {
                        for &s in comp {
                            let sh = ctx.bd.shapes[s].clone();
                            let cells = ctx.cells_of(&sh, nmask);
                            let free = cells.iter().filter(|&&c| ctx.cost(net, c, hw).is_some()).count();
                            eprintln!("  {} comp {ci} {:?} {:?}: {} cells, {} not hard-blocked at w {:.2}",
                                      ctx.bd.nets[net].name, sh.kind as u8, sh.geo.bbox(), cells.len(), free, hw * 2.0);
                        }
                    }
                }
            }
            break;
        };
        let hw = w / 2.0;
        ctx.set_neck(net, hw);
        let last = *path.last().unwrap();
        let (_, iy, ix) = ctx.gr.cell(last);
        let (gx, gy) = ctx.gr.xy(ix, iy);
        let (mut tr, vs) = ctx.geometry(net, &path, hw);
        // v8b: the escape stubs at the start and the end of the path (one straight narrow piece from the pad)
        if let Some(st) = best_stubs.0.get(&path[0]) {
            tr.insert(0, (ctx.bd.routable[st.r], st.a, st.b, st.hw));
        }
        let end_pad = best_stubs.1.get(&last).map(|&(st, s)| {
            tr.push((ctx.bd.routable[st.r], st.b, st.a, st.hw));
            s
        });
        let first_new = ctx.bd.shapes.len();
        add_copper(ctx, net, net as i32, &tr, &vs);
        // RP-001 (DESIGN 4): every new layer change gets a GND return via within --return-r; no site = the
        // transition is rejected and the join is searched again
        let mut rejected = Vec::new();
        for &(vx, vy) in &vs {
            if !ctx.place_return(net, vx, vy, &vs) {
                rejected.push((vx, vy));
            }
        }
        if !rejected.is_empty() {
            for i in first_new..ctx.bd.shapes.len() {
                ctx.bd.shapes[i].alive = false;
            }
            // reserve, then route (M2, H7-CORE at the 1.0 mm gate radius): the path's own tracks often take the free
            // part of the small return ring. With the path removed, a site that has a return now gets it reserved
            // (a GND via of this net's return set), and the search routes around it; a site with no return even then
            // is banned for this net. Unused reserved vias are removed at the end of the net.
            for (vx, vy) in rejected {
                if !ctx.place_return(net, vx, vy, &[]) {
                    // v7 fix 5: ban the via sites within one via radius (their return site sets are nearly the same;
                    // v6 banned one 0.05 mm site and the next search took the site beside it)
                    let (ix, iy) = ctx.gr.at(vx, vy);
                    let k = (ctx.bd.nets[net].via_d / 2.0 / ctx.gr.p).floor() as i64;
                    for dj in -k..=k {
                        for di in -k..=k {
                            let (jx, jy) = (ix as i64 + di, iy as i64 + dj);
                            if di * di + dj * dj <= k * k && jx >= 0 && jy >= 0 && (jx as usize) < ctx.gr.nx && (jy as usize) < ctx.gr.ny {
                                ctx.ban.push(jy as usize * ctx.gr.nx + jx as usize);
                            }
                        }
                    }
                }
            }
            ctx.ban.sort_unstable();
            ctx.ban.dedup();
            ret_rejects += 1;
            if ret_rejects >= RET_SOFT_AFTER {
                ctx.ret_soft = true;
            }
            if ret_rejects > 40 {
                let pads: Vec<String> = comps.iter().flat_map(|c| tree_pads(ctx, c)).collect();
                out.hard_fail = Some(format!("RP-001: no layer change with a GND return via within {} mm found (40 tries) to pad(s) at {}",
                                             ctx.o.return_r, pads.join(",")));
                break;
            }
            continue;
        }
        used_vias += vs.len();
        len_used += tr.iter().map(|&(_, a, b, _)| (b.0 - a.0).hypot(b.1 - a.1)).sum::<f64>() + vs.len() as f64 * via_len;
        out.conflicts += k;
        out.cost += best_g;
        let ci = match end_pad {
            Some(pad) => comps.iter().position(|comp| comp.contains(&pad)).unwrap_or(0),
            None => comps.iter().position(|comp| comp.iter().any(|&s| ctx.bd.shapes[s].geo.dist(gx, gy) <= 1e-6)).unwrap_or(0),
        };
        let reached = comps.remove(ci);
        tree.extend(reached);
        // the net's own new copper joins the tree (its return vias are GND copper: not part of the net)
        tree.extend((first_new..ctx.bd.shapes.len()).filter(|&i| ctx.bd.shapes[i].net == net as i32));
    }
    if !trapped.is_empty() && out.hard_fail.is_none() {
        out.hard_fail = Some(format!("walled in by fixed copper (input placement / locked routes): pad(s) at {}", trapped.join("; ")));
        if !ctx.strict && ctx.dead[net].1.is_empty() {
            ctx.dead[net].1 = out.hard_fail.clone().unwrap();
        }
    }
    ctx.len_cap = None;
    ctx.len_boxes.clear();
    drop_unused_returns(ctx, net);
    out
}

/// v6 (t1, NET-CORE U1.129 / U7.25 / U8.25): each pad on the gate viapads allow list (model via_in_pad) of a plane net
/// gets one via of its net inside it before routing, as fixed copper: at the legal grid site nearest the pad centre.
/// The gate reports an allowed pad with no via as stale (exit 2), and the datasheets ask for vias in these exposed
/// pads. In the negotiation the in-pad via met routed copper on the inner layers, and the strict end step found no
/// site. Returns notes (an allowed pad with no legal site inside: input).
fn fixed_vip_vias(bd: &mut Board, o: &Opts) -> Vec<String> {
    let mut notes = Vec::new();
    let all = (1u8 << bd.layer_names.len()) - 1;
    for &(a, b, c, d) in bd.vip.clone().iter() {
        let Some(pad) = bd.shapes.iter().find(|s| s.alive && s.kind == Kind::Pad && s.owner < 0 && s.geo.bbox() == (a, b, c, d)).cloned() else { continue };
        if pad.net < 0 || !bd.nets[pad.net as usize].plane {
            continue;
        }
        let net = pad.net as usize;
        // thermal via array (model pad thermal_vias): every via of the spec at its exact place, as fixed copper of the
        // pad's net; a via that the fixed copper does not allow there is a note (input), never moved
        if let Some((_, pts, td, tdr, name)) = bd.tvia.iter().find(|t| t.0 == (a, b, c, d)).cloned() {
            let clr = bd.nets[net].clr;
            for (x, y) in pts {
                if bd.shapes.iter().any(|s| s.alive && s.net == net as i32 && s.kind == Kind::Via && matches!(s.geo, Geo::Circ(vx, vy, _) if (vx - x).abs() < 1e-6 && (vy - y).abs() < 1e-6)) {
                    continue;
                }
                let code = bd.via_fixed_code(x, y, td, tdr, clr, o.hth, false, bd.iv(net as i32));
                if bd.via_code_blocks(code, net, x, y, td, tdr, o.hth) {
                    notes.push(format!("thermal vias: {name} via ({x:.3}, {y:.3}) {td}/{tdr} mm is not legal against the fixed copper (input)"));
                    continue;
                }
                bd.add(Shape { net: net as i32, geo: Geo::Circ(x, y, td / 2.0), clr, layers: all, drill: tdr, kind: Kind::Via, owner: -1, alive: true, grp: 0 });
                if bd.is_ret_net(net as i32) {
                    bd.gnd_fixed.push((x, y));
                }
            }
            continue;
        }
        let (vd, vdr, clr) = (bd.nets[net].via_d, bd.nets[net].via_drill, bd.nets[net].clr);
        let vr = vd / 2.0;
        if bd.shapes.iter().any(|s| s.alive && s.net == net as i32 && s.kind == Kind::Via && matches!(s.geo, Geo::Circ(x, y, _) if x >= a && x <= c && y >= b && y <= d)) {
            continue;
        }
        let (cx, cy) = ((a + c) / 2.0, (b + d) / 2.0);
        let (x0, y0, p) = (bd.edge.0, bd.edge.1, o.pitch);
        let mut sites: Vec<(f64, f64, f64)> = Vec::new();
        let (i0, i1) = (((a + vr - x0) / p).ceil() as i64, ((c - vr - x0) / p).floor() as i64);
        let (j0, j1) = (((b + vr - y0) / p).ceil() as i64, ((d - vr - y0) / p).floor() as i64);
        for j in j0..=j1 {
            for i in i0..=i1 {
                let (x, y) = (x0 + i as f64 * p, y0 + j as f64 * p);
                sites.push(((x - cx).hypot(y - cy), x, y));
            }
        }
        sites.sort_by(|q, r| q.0.partial_cmp(&r.0).unwrap());
        let site = sites.into_iter().find(|&(_, x, y)| {
            let code = bd.via_fixed_code(x, y, vd, vdr, clr, o.hth, false, bd.iv(net as i32));
            !bd.via_code_blocks(code, net, x, y, vd, vdr, o.hth)
        });
        match site {
            Some((_, x, y)) => {
                bd.add(Shape { net: net as i32, geo: Geo::Circ(x, y, vr), clr, layers: all, drill: vdr, kind: Kind::Via, owner: -1, alive: true, grp: 0 });
                if bd.is_ret_net(net as i32) {
                    bd.gnd_fixed.push((x, y));
                }
            }
            None => notes.push(format!("viapads: allowed pad at ({cx:.2}, {cy:.2}) of {} has no legal via site inside (input)", bd.nets[net].name)),
        }
    }
    notes
}

/// The via of each forced fan-out must lie in the fill (Board::spoke_sites).
/// v6 (t1, committed compact NET-CORE, U8.6): the spoke heuristic of reserve_spokes (N/S/E/W strips, zone clearance
/// only) found 2 free channels, but the pour model (spoke angle, DRU zone clearance of the locked pairs) gives 1, and
/// KiCad reported starved_thermal. The pour check of the fixed copper alone decides: each SMD pad of a plane net that
/// it finds starved gets a forced fan-out track, which KiCad counts as a spoke. Returns the number of pads added.
fn pre_attach(bd: &mut Board, pitch: f64) -> usize {
    let mut n = 0;
    let faults = pour::check(bd);
    for fl in &faults {
        let pr = &bd.pours[fl.pour];
        let Some(pd) = pr.pads.iter().find(|p| p.name == fl.pad) else { continue };
        if pd.hole.is_some() || pd.proxy.is_some() {
            continue;
        }
        let Geo::Rect(a, b, c, d) = pd.geo else { continue };
        let (cx, cy) = ((a + c) / 2.0, (b + d) / 2.0);
        if !bd.attach.iter().any(|&(x, y)| (x - cx).abs() < 1e-6 && (y - cy).abs() < 1e-6) {
            bd.attach.push((cx, cy));
            n += 1;
        }
    }
    // the via sites of every forced fan-out (grid points within 2 mm, as fanout_net searches) that lie in the fill
    for pi in 0..bd.pours.len() {
        let (x0, y0) = (bd.edge.0, bd.edge.1);
        let mut pts = Vec::new();
        for &(cx, cy) in &bd.attach {
            if !bd.pours[pi].pads.iter().any(|p| { let (a, b, c, d) = p.geo.bbox(); ((a + c) / 2.0 - cx).abs() < 1e-6 && ((b + d) / 2.0 - cy).abs() < 1e-6 }) {
                continue;
            }
            let (i0, j0) = (((cx - 2.0 - x0) / pitch).floor() as i64, ((cy - 2.0 - y0) / pitch).floor() as i64);
            for j in j0..=j0 + (4.0 / pitch).ceil() as i64 + 1 {
                for i in i0..=i0 + (4.0 / pitch).ceil() as i64 + 1 {
                    pts.push((x0 + i as f64 * pitch, y0 + j as f64 * pitch));
                }
            }
        }
        if pts.is_empty() {
            continue;
        }
        for (q, ok) in pts.iter().zip(pour::in_fill(bd, pi, &pts)) {
            if ok {
                bd.spoke_sites.insert(((q.0 * 1e3).round() as i64, (q.1 * 1e3).round() as i64));
            }
        }
    }
    n
}

/// RP-001 for the locked input vias (M2: the H7-CORE MDI RX pair vias kept from the existing board, whose GND stitching
/// vias were not kept: 2 kicad-happy findings). Each fixed signal via (not a plane net) with no GND via or counted GND
/// through-hole pad within --return-r gets a GND via of the return size at the nearest site that the fixed copper
/// leaves legal, as fixed copper (before any routing, so the memoized fixed-copper verdicts include it). A via with no
/// such site is returned as a note (an input defect).
fn fixed_returns(bd: &mut Board, o: &Opts) -> Vec<String> {
    let mut notes = Vec::new();
    if bd.gnd < 0 {
        return notes;
    }
    let (gd, gdr, r) = (o.ret_d, o.ret_drill, o.return_r);
    let all = (1u8 << bd.layer_names.len()) - 1;
    let sig: Vec<(f64, f64, f64, f64, usize)> = bd.shapes.iter()
        .filter(|s| s.alive && s.owner < 0 && s.kind == Kind::Via && s.net >= 0 && !bd.is_ret_net(s.net) && !bd.noret.contains(&s.net) && !bd.nets[s.net as usize].plane)
        .filter_map(|s| match s.geo { Geo::Circ(x, y, vr) => Some((x, y, vr, s.drill, s.net as usize)), _ => None }).collect();
    for (x, y, vr, dr, net) in sig {
        let g = bd.rg(net) as usize;
        let has = bd.gnd_fixed.iter().any(|&(a, b)| (a - x).powi(2) + (b - y).powi(2) <= r * r)
            || bd.near_in(&bd.idx, 0, x, y, r, &mut |_, s| bd.is_ret_net(s.net) && s.kind == Kind::Via
                && matches!(s.geo, Geo::Circ(a, b, _) if (a - x).powi(2) + (b - y).powi(2) <= r * r));
        if has {
            continue;
        }
        let sep = (dr / 2.0 + gdr / 2.0 + o.hth).max(vr + gd / 2.0 + bd.maxc.max(bd.nets[g].clr));
        let p = o.pitch;
        let k = (r / p).ceil() as i64;
        let mut sites: Vec<(f64, f64, f64)> = Vec::new();
        for j in -k..=k {
            for i in -k..=k {
                let (px, py) = (x + i as f64 * p, y + j as f64 * p);
                let dd = ((px - x).powi(2) + (py - y).powi(2)).sqrt();
                if dd <= r - 1e-9 && dd >= sep {
                    sites.push((dd, px, py));
                }
            }
        }
        let clr = bd.nets[g].clr;
        // v6 (t1, committed compact NET-CORE): the nearest legal site took the only escape channel of U8.9 /CH_DVDDK
        // (a 0.1 mm wide corridor of track centres) and walled the pad in. Take the legal site with the most free room
        // to foreign copper (the edge distance to the nearest non-GND item, counted up to SPACE_CAP), then the nearest.
        const SPACE_CAP: f64 = 1.5;
        let mut best: Option<(f64, f64, f64, f64)> = None; // (-room, dd, x, y)
        for (dd, px, py) in sites {
            let code = bd.via_fixed_code(px, py, gd, gdr, clr, o.hth, false, bd.iv(g as i32));
            if bd.via_code_blocks(code, g, px, py, gd, gdr, o.hth) {
                continue;
            }
            let mut room = SPACE_CAP;
            for l in 0..bd.layer_names.len() {
                bd.near_in(&bd.idx, l, px, py, SPACE_CAP + gd, &mut |_, s| {
                    if s.net != g as i32 && s.kind != Kind::Spoke {
                        room = room.min((s.geo.dist(px, py) - gd / 2.0).max(0.0));
                    }
                    false
                });
            }
            let key = (-((room / p).round() * p), dd, px, py);
            if best.map(|b| (key.0, key.1) < (b.0, b.1)).unwrap_or(true) {
                best = Some(key);
            }
        }
        let site = best.map(|b| (b.1, b.2, b.3));
        match site {
            Some((_, px, py)) => {
                bd.add(Shape { net: g as i32, geo: Geo::Circ(px, py, gd / 2.0), clr, layers: all, drill: gdr, kind: Kind::Via, owner: -1, alive: true, grp: 0 });
                bd.gnd_fixed.push((px, py));
            }
            None => notes.push(format!("RP-001: locked via of {} at ({x:.2}, {y:.2}) has no GND return site within {r} mm (input)", bd.nets[net].name)),
        }
    }
    notes
}

/// Remove the return vias of `net` (GND vias it owns) with no signal via of `net` within --return-r: reserved for a
/// layer change that the final path does not use.
/// Pairs of drilled items of two different signal nets (at least one routed) closer than the antipad web.
fn web_pairs(bd: &Board, web: f64) -> usize {
    let items: Vec<&Shape> = bd.shapes.iter().filter(|s| s.alive && s.drill > 0.0 && s.net >= 0 && !bd.nets[s.net as usize].plane && s.kind != Kind::Spoke).collect();
    let mut n = 0;
    for (i, a) in items.iter().enumerate() {
        if a.owner < 0 || a.kind != Kind::Via {
            continue;
        }
        let Geo::Circ(x, y, r) = a.geo else { continue };
        for (j, b) in items.iter().enumerate() {
            if b.net != a.net && (b.owner < 0 || j > i) && b.geo.dist(x, y) < r + web - 1e-9 {
                n += 1;
            }
        }
    }
    n
}

/// Live signal vias (routed, not of a plane net) of nets other than `except`, within --return-r of (x, y): the nearest
/// one's net.
fn ret_user(ctx: &Ctx, x: f64, y: f64, except: usize) -> Option<usize> {
    let r2 = ctx.o.return_r * ctx.o.return_r;
    let mut best: Option<(f64, usize)> = None;
    let l = ctx.bd.routable[0];
    ctx.bd.near_in(&ctx.bd.sidx, l, x, y, ctx.o.return_r, &mut |_, s| {
        if s.kind == Kind::Via && s.owner >= 0 && s.net == s.owner && s.owner as usize != except && !ctx.bd.nets[s.net as usize].plane {
            if let Geo::Circ(a, b, _) = s.geo {
                let d = (a - x).powi(2) + (b - y).powi(2);
                if d <= r2 && best.map(|q| d < q.0).unwrap_or(true) {
                    best = Some((d, s.net as usize));
                }
            }
        }
        false
    });
    best.map(|b| b.1)
}

/// v6 fix 3a (shared returns): before `net` is ripped up, each of its return vias that also serves a signal via of
/// another net goes to that net (v5 removed it with the net, and the other net then needed a new return).
fn release_returns(ctx: &mut Ctx, net: usize) {
    if ctx.bd.gnd < 0 || ctx.bd.is_ret_net(net as i32) {
        return;
    }
    let ids: Vec<usize> = (0..ctx.bd.shapes.len()).filter(|&i| { let s = &ctx.bd.shapes[i]; s.alive && s.owner == net as i32 && ctx.bd.is_ret_net(s.net) && s.kind == Kind::Via }).collect();
    for i in ids {
        if let Geo::Circ(x, y, _) = ctx.bd.shapes[i].geo {
            if let Some(o) = ret_user(ctx, x, y, net) {
                ctx.bd.shapes[i].owner = o as i32;
            }
        }
    }
}

/// End of a net: a return via of `net` that serves none of its signal vias goes to another net it serves (shared), or
/// is removed.
fn drop_unused_returns(ctx: &mut Ctx, net: usize) {
    let r2 = ctx.o.return_r * ctx.o.return_r;
    let sig: Vec<(f64, f64)> = ctx.bd.shapes.iter().filter(|s| s.alive && s.owner == net as i32 && s.net == net as i32 && s.kind == Kind::Via)
        .filter_map(|s| match s.geo { Geo::Circ(x, y, _) => Some((x, y)), _ => None }).collect();
    let ids: Vec<usize> = (0..ctx.bd.shapes.len()).filter(|&i| { let s = &ctx.bd.shapes[i]; s.alive && s.owner == net as i32 && ctx.bd.is_ret_net(s.net) && !ctx.bd.is_ret_net(net as i32) && s.kind == Kind::Via }).collect();
    for i in ids {
        if let Geo::Circ(x, y, _) = ctx.bd.shapes[i].geo {
            if !sig.iter().any(|&(a, b)| (a - x).powi(2) + (b - y).powi(2) <= r2) {
                match ret_user(ctx, x, y, net) {
                    Some(o) => ctx.bd.shapes[i].owner = o as i32,
                    None => ctx.bd.shapes[i].alive = false,
                }
            }
        }
    }
}

/// v6 fix 3a: remove router return vias that no signal via needs (each signal via keeps a GND via or a counted GND
/// through-hole pad within --return-r). Greedy, the returns that serve the fewest signal vias first. A removal that
/// makes a pour fault (a GND via was a pour piece's connection) is undone. Returns the number removed.
fn prune_returns(ctx: &mut Ctx) -> usize {
    let g = ctx.bd.gnd;
    if g < 0 {
        return 0;
    }
    let r = ctx.o.return_r;
    let r2 = r * r;
    let sig: Vec<(f64, f64)> = ctx.bd.shapes.iter().filter(|s| s.alive && s.owner >= 0 && s.net == s.owner && s.kind == Kind::Via && !ctx.bd.nets[s.net as usize].plane)
        .filter_map(|s| match s.geo { Geo::Circ(x, y, _) => Some((x, y)), _ => None }).collect();
    let mut cand: Vec<(usize, usize)> = Vec::new(); // (signal vias served, shape id)
    for (i, s) in ctx.bd.shapes.iter().enumerate() {
        if s.alive && s.owner >= 0 && ctx.bd.is_ret_net(s.net) && !ctx.bd.is_ret_net(s.owner) && s.kind == Kind::Via {
            if let Geo::Circ(x, y, _) = s.geo {
                cand.push((sig.iter().filter(|&&(a, b)| (a - x).powi(2) + (b - y).powi(2) <= r2).count(), i));
            }
        }
    }
    cand.sort();
    let faults0 = pour::check(ctx.bd).len();
    let mut removed: Vec<usize> = Vec::new();
    for &(_, i) in &cand {
        let Geo::Circ(x, y, _) = ctx.bd.shapes[i].geo else { continue };
        ctx.bd.shapes[i].alive = false;
        // every signal via this one served still has a return
        let ok = sig.iter().filter(|&&(a, b)| (a - x).powi(2) + (b - y).powi(2) <= r2).all(|&(a, b)| ctx.has_return(a, b));
        if ok {
            removed.push(i);
        } else {
            ctx.bd.shapes[i].alive = true;
        }
    }
    // pour guard: undo the removals near a new fault (a pour piece lost its via), up to 3 rounds, then all
    for round in 0..4 {
        let pf = pour::check(ctx.bd);
        if pf.len() <= faults0 || removed.is_empty() {
            break;
        }
        let pads: Vec<(f64, f64)> = pf.iter().flat_map(|fl| fl.path.first().cloned()).collect();
        let back: Vec<usize> = if round == 3 { removed.clone() } else {
            removed.iter().cloned().filter(|&i| match ctx.bd.shapes[i].geo { Geo::Circ(x, y, _) => pads.iter().any(|&(a, b)| (a - x).hypot(b - y) < 6.0) || pads.is_empty(), _ => false }).collect()
        };
        for &i in &back {
            ctx.bd.shapes[i].alive = true;
        }
        removed.retain(|i| !back.contains(i));
    }
    removed.len()
}

/// Track widths a net may use, widest first: the class width (raised to the width of its design current); a power
/// net may neck to 0.3 / 0.2 / 0.15 mm, never below the width its current needs (current-paths.json via the model).
fn net_widths(n: &Net) -> Vec<f64> {
    let base = n.width.max(n.min_w);
    if !n.power {
        return vec![base];
    }
    let mut v: Vec<f64> = [base, 0.3, 0.2, 0.15, n.min_w].iter().cloned()
        .filter(|&w| w > 0.0 && w <= base + 1e-9 && w >= n.min_w - 1e-9).collect();
    v.sort_by(|a, b| b.partial_cmp(a).unwrap());
    v.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
    v
}

/// v7: length of each net as the KiCad DRC length rule measures it (upper bound: track ends inside pads are counted):
/// all live tracks of the net plus Board::via_len per via of the net (locked and routed; return vias are GND copper).
fn net_lengths(bd: &Board) -> Vec<f64> {
    let mut v = vec![0.0; bd.nets.len()];
    for s in bd.shapes.iter().filter(|s| s.alive && s.net >= 0) {
        match (s.kind, s.geo) {
            (Kind::Track, Geo::Seg(ax, ay, bx, by, _)) => v[s.net as usize] += (bx - ax).hypot(by - ay),
            (Kind::Via, _) => v[s.net as usize] += bd.via_len,
            _ => {}
        }
    }
    v
}

/// v7 fix 2 (standoffs): the rip-up order of the next iteration. The nets in conflict are routed again fewest moves
/// first (then in the base order: power, fast, slow). A net whose partner has already moved away keeps its copper (the
/// v6 rule against swapping), so in v6 the net first in the base order always moved and its partner never did: H7-CORE
/// m3, VDD_3V3 (power, first) moved 50 times between /SPI_SCK and /DAC2 + /PFAILn, which never moved; spread NET-CORE,
/// /ETH_TX_EN had no conflict-free route until /PHY_RSTn moved (IOTROUTE_DIAG). Fewest moves first gives the turn to
/// the net that has not tried to move yet.
fn rip_order(order: &[usize], involved: &[usize], moves: &[u32]) -> Vec<usize> {
    let mut v: Vec<(u32, usize, usize)> = order.iter().enumerate().filter(|(_, n)| involved.contains(n)).map(|(i, &n)| (moves[n], i, n)).collect();
    v.sort();
    v.into_iter().map(|e| e.2).collect()
}

/// Step cost factor of copper layer l in the A* (F.Cu 1.0, B.Cu 1.05, inner layers 1.15).
fn layer_cost(bd: &Board, l: usize) -> f64 {
    let name = &bd.layer_names[l];
    if name == "F.Cu" { 1.0 } else if name == "B.Cu" { 1.05 } else { 1.15 }
}

/// v9: the routing objective of the live routed copper of `net`, in the units of the A* (Ctx::search_n without the
/// negotiation terms): track length x layer cost + per signal via the via cost (DRU via_count surcharge included) and the
/// priced antipad web items. Escape stubs are tracks.
fn net_cost(ctx: &Ctx, net: usize) -> f64 {
    let n = &ctx.bd.nets[net];
    let via_base = ctx.o.via_cost + if n.max_vias.is_some() { 6.0 } else { 0.0 };
    let web_soft = !ctx.bd.web_hard && ctx.bd.web > 0.0 && !n.plane && ctx.o.web_cost > 0.0;
    let mut c = 0.0;
    for s in ctx.bd.shapes.iter().filter(|s| s.alive && s.owner == net as i32 && s.net == net as i32) {
        match (s.kind, s.geo) {
            (Kind::Track, Geo::Seg(ax, ay, bx, by, _)) => {
                let l = (0..ctx.bd.layer_names.len()).find(|&l| s.layers & (1 << l) != 0).unwrap_or(0);
                c += (bx - ax).hypot(by - ay) * layer_cost(ctx.bd, l);
            }
            (Kind::Via, Geo::Circ(x, y, _)) => {
                c += via_base + if web_soft { ctx.web_items(net, x, y) as f64 * ctx.o.web_cost } else { 0.0 };
            }
            _ => {}
        }
    }
    c
}

/// v9 length recovery. Cause (v8, hand NET-CORE placement, 1593 mm against 1495 mm for v4 on the same placement): the
/// nets that fought in the negotiation (/ETH_TXD0, /ETH_TXD1, /ETH_TX_EN, /PHY_RSTn, ...) keep the detours that the
/// PathFinder history and present cost pushed them into, and the nets that settled early keep routes made before the
/// later nets were there; once the copper is legal nothing removes a detour. After a legal end state (audit pairs 0),
/// each routed signal / power net is routed again strictly (routed copper of the other nets blocks) with the history
/// off and an admissible heuristic (Ctx::recover). The new route is kept only when it is legal (no hard fail, no
/// conflict of the net in the exact audit), no signal via loses its RP-001 return, the pour faults do not grow, and its
/// routing objective (net_cost) is lower by more than one grid pitch (the resolution of the route). Else the old copper
/// is put back. Rounds go on until a round keeps nothing. Returns (nets improved, objective saved).
fn recover_length(ctx: &mut Ctx, order: &[usize], state: &[(Option<String>, u32)]) -> (usize, f64) {
    recover_length_in(ctx, order, state, None)
}

/// recover_length on the nets with `only[net]` (reuse: reuse::recover_scope); None = every net.
fn recover_length_in(ctx: &mut Ctx, order: &[usize], state: &[(Option<String>, u32)], only: Option<&[bool]>) -> (usize, f64) {
    let (mut kept, mut saved) = (0usize, 0.0f64);
    let pour_n = |ctx: &Ctx| pour::check(ctx.bd).iter().filter(|f| !f.fixed).count();
    let mut pf0 = pour_n(ctx);
    let mut miss0 = ctx.ret_missing().len();
    let p = ctx.gr.p;
    loop {
        let mut round = 0usize;
        for &net in order {
            if ctx.bd.nets[net].plane || state[net].0.is_some() || only.map_or(false, |v| !v[net]) || !ctx.bd.shapes.iter().any(|s| s.alive && s.owner == net as i32 && s.net == net as i32) {
                continue;
            }
            let c0 = net_cost(ctx, net);
            let snap = ctx.bd.shapes.clone();
            ctx.strict = true;
            ctx.recover = true;
            let r = route_net(ctx, net);
            ctx.recover = false;
            ctx.strict = false;
            let c1 = net_cost(ctx, net);
            let mut ok = r.hard_fail.is_none() && c1 < c0 - p && !ctx.net_in_conflict(net);
            let (mut miss, mut pf) = (miss0, pf0);
            if ok {
                miss = ctx.ret_missing().len();
                ok = miss <= miss0;
            }
            if ok {
                pf = pour_n(ctx);
                ok = pf <= pf0;
            }
            if ok {
                round += 1;
                saved += c0 - c1;
                miss0 = miss;
                pf0 = pf;
                if std::env::var("IOTROUTE_DEBUG").is_ok() {
                    eprintln!("  recover {}: objective {c0:.2} -> {c1:.2}", ctx.bd.nets[net].name);
                }
            } else {
                ctx.bd.shapes = snap;
                ctx.bd.compact();
            }
            ctx.gr.reset_cache();
        }
        kept += round;
        if round == 0 {
            break;
        }
    }
    (kept, saved)
}

/// v9 debug (IOTROUTE_LENDIAG=all or net,net): for each routed net, its objective now, the objective of a strict
/// recover route with the other copper in place, and of a recover route with no other routed copper (fixed copper only),
/// and the nets whose copper the free route meets. Free << now: other routed nets hold the short way. The copper is put
/// back after each net.
fn diag_length(ctx: &mut Ctx, order: &[usize], which: &str) {
    for &net in order {
        let name = ctx.bd.nets[net].name.clone();
        if ctx.bd.nets[net].plane || !ctx.bd.shapes.iter().any(|s| s.alive && s.owner == net as i32 && s.net == net as i32) {
            continue;
        }
        if which != "all" && !which.split(',').any(|w| w == name) {
            continue;
        }
        let c0 = net_cost(ctx, net);
        let snap = ctx.bd.shapes.clone();
        ctx.strict = true;
        ctx.recover = true;
        let r1 = route_net(ctx, net);
        let c1 = net_cost(ctx, net);
        ctx.bd.shapes = snap.clone();
        ctx.bd.compact();
        ctx.gr.reset_cache();
        let killed: Vec<usize> = (0..ctx.bd.shapes.len()).filter(|&i| { let s = &ctx.bd.shapes[i]; s.alive && s.owner >= 0 && s.owner != net as i32 }).collect();
        for &i in &killed {
            ctx.bd.shapes[i].alive = false;
        }
        ctx.gr.reset_cache();
        let r2 = route_net(ctx, net);
        let c2 = net_cost(ctx, net);
        for &i in &killed {
            ctx.bd.shapes[i].alive = true;
        }
        ctx.recover = false;
        ctx.strict = false;
        let au = ctx.audit_of(0.0, Some(net));
        let mut bl: Vec<usize> = au.partners[net].clone();
        bl.sort();
        bl.dedup();
        eprintln!("lendiag {name}: now {c0:.2} strict {} free {} blockers: {}", if r1.hard_fail.is_some() { "fail".into() } else { format!("{c1:.2}") },
                  if r2.hard_fail.is_some() { "fail".into() } else { format!("{c2:.2}") },
                  bl.iter().map(|&n| ctx.bd.nets[n].name.as_str()).collect::<Vec<_>>().join(" "));
        ctx.bd.shapes = snap;
        ctx.bd.compact();
        ctx.gr.reset_cache();
    }
}

/// Layer changes (vias) along a cell path.
fn path_vias(gr: &Grid, path: &[usize]) -> usize {
    path.windows(2).filter(|w| gr.cell(w[0]).0 != gr.cell(w[1]).0).count()
}

/// One join search of `net` at half width hw: first inside the net's box + JOIN_MARGIN (once every way to a target
/// crosses congested copper, an unbounded search floods the whole board before it pays that cost); no path in the box
/// = the whole board, after a flood fill proves a target reachable (so a failure is still a proof). Err(true): search
/// limit, Err(false): no path. A wider try (last = false) is only a preference: its search is bounded.
fn join_search(ctx: &mut Ctx, net: usize, hw: f64, src: &[usize], anchors: &[(f64, f64)], allow_via: bool, vm: f64, last: bool,
               nbox: (usize, usize, usize, usize)) -> Result<Vec<usize>, bool> {
    let cap = if last && !ctx.strict { 8_000_000 } else if last { 1_000_000 } else { 300_000 };
    let full = (0, 0, ctx.gr.nx - 1, ctx.gr.ny - 1);
    let mut found = ctx.search_n(net, hw, src, anchors, allow_via, vm, ctx.strict, cap, nbox);
    if found.is_err() && last {
        found = if !ctx.reachable(net, hw, src, ctx.strict, allow_via, full) {
            Err(false)
        } else if found == Err(false) && nbox != full {
            ctx.search_n(net, hw, src, anchors, allow_via, vm, ctx.strict, cap, full)
        } else {
            found
        };
        if found == Err(true) && !ctx.strict {
            // search limit at a high present cost (v3: /J2_LEDG_A from iteration 4 on, pres 1.7 .. 1000): a
            // conflict-free path, when one exists, is found by a strict search (routed copper blocks); else the present
            // cost is capped for this one search, so the path pays its crossings and the negotiation moves the others
            found = if ctx.reachable(net, hw, src, true, allow_via, full) {
                ctx.search_n(net, hw, src, anchors, allow_via, vm, true, 30_000_000, full)
            } else {
                let p = ctx.gr.pres;
                ctx.gr.pres = p.min(4.0);
                let r = ctx.search_n(net, hw, src, anchors, allow_via, vm, false, cap, full);
                ctx.gr.pres = p;
                r
            };
            if std::env::var("IOTROUTE_DEBUG").is_ok() {
                eprintln!("  {}: search limit at pres {:.1}; fallback {}", ctx.bd.nets[net].name, ctx.gr.pres,
                          match &found { Ok(_) => "found", Err(true) => "limit", Err(false) => "no path" });
            }
        }
        // v7 DRU length: the congestion-priced search found no path under the length cap (its cheapest path to a cell
        // can be too long to go on): the shortest path under the cap (length cost only, crossings allowed unless
        // strict; the negotiation then moves the other nets)
        if found.is_err() && ctx.len_cap.is_some() && !ctx.len_mode {
            ctx.len_mode = true;
            found = ctx.search_n(net, hw, src, anchors, allow_via, vm, ctx.strict, cap, full);
            ctx.len_mode = false;
        }
    }
    found
}

/// Debug (IOTROUTE_DIAG=iteration): for a small conflict set, print each conflicting pair with the history on the grid
/// cells under both items, then for each involved net: can it route strictly (routed copper of the others blocks)? If
/// not, which single other net, removed, makes it routable (the third net that blocks the detour)?
fn diag_standoff(ctx: &mut Ctx, au: &Audit, involved: &[usize], order: &[usize]) {
    let n = ctx.gr.nx * ctx.gr.ny;
    let hist_of = |ctx: &Ctx, s: &Shape| -> (f32, f32, usize) {
        let (a, b, c, d) = s.geo.bbox();
        let (i0, j0) = ctx.gr.at(a, b);
        let (i1, j1) = ctx.gr.at(c, d);
        let (mut mx, mut sum, mut k) = (0.0f32, 0.0f32, 0usize);
        for (r, &l) in ctx.bd.routable.iter().enumerate() {
            if s.layers & (1 << l) == 0 {
                continue;
            }
            for j in j0..=j1 {
                for i in i0..=i1 {
                    let (x, y) = ctx.gr.xy(i, j);
                    if s.geo.dist(x, y) <= 0.0 {
                        let h = if s.kind == Kind::Via { ctx.gr.vhist[j * ctx.gr.nx + i] } else { ctx.gr.hist[r * n + j * ctx.gr.nx + i] };
                        mx = mx.max(h);
                        sum += h;
                        k += 1;
                    }
                }
            }
        }
        (mx, sum, k)
    };
    for &(p, q) in au.pair_ids.iter().take(6) {
        let (a, b) = (ctx.bd.shapes[p as usize].clone(), ctx.bd.shapes[q as usize].clone());
        let (ha, hb) = (hist_of(ctx, &a), hist_of(ctx, &b));
        eprintln!("  DIAG pair: {} (owner {}) {:?} hist max {:.1} sum {:.1} cells {} | {} (owner {}) {:?} hist max {:.1} sum {:.1} cells {}",
                  ctx.bd.nets[a.net as usize].name, ctx.bd.nets[a.owner as usize].name, a.geo, ha.0, ha.1, ha.2,
                  ctx.bd.nets[b.net as usize].name, ctx.bd.nets[b.owner as usize].name, b.geo, hb.0, hb.1, hb.2);
    }
    let snap: Vec<Shape> = ctx.bd.shapes.clone();
    let restore = |ctx: &mut Ctx, snap: &Vec<Shape>| {
        ctx.bd.shapes = snap.clone();
        ctx.bd.compact();
        ctx.gr.reset_cache();
    };
    for &net in involved {
        if ctx.bd.nets[net].plane {
            continue;
        }
        ctx.strict = true;
        let r = route_net(ctx, net);
        let ok = r.hard_fail.is_none();
        restore(ctx, &snap);
        let mut openers = Vec::new();
        if !ok {
            // other routed nets near this net's items
            let others: Vec<usize> = order.iter().cloned().filter(|&q| q != net && snap.iter().any(|s| s.alive && s.owner == q as i32)).collect();
            let (mut a, mut b, mut c, mut d) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
            for s in snap.iter().filter(|s| s.alive && s.net == net as i32) {
                let (x0, y0, x1, y1) = s.geo.bbox();
                a = a.min(x0); b = b.min(y0); c = c.max(x1); d = d.max(y1);
            }
            for q in others {
                let near = snap.iter().any(|s| s.alive && s.owner == q as i32 && { let (x0, y0, x1, y1) = s.geo.bbox(); x1 >= a - 2.0 && x0 <= c + 2.0 && y1 >= b - 2.0 && y0 <= d + 2.0 });
                if !near {
                    continue;
                }
                for s in ctx.bd.shapes.iter_mut() {
                    if s.owner == q as i32 {
                        s.alive = false;
                    }
                }
                ctx.bd.compact();
                ctx.gr.reset_cache();
                let r = route_net(ctx, net);
                if r.hard_fail.is_none() {
                    openers.push(ctx.bd.nets[q].name.clone());
                }
                restore(ctx, &snap);
            }
        }
        ctx.strict = false;
        eprintln!("  DIAG {}: strict route {} {}; nets whose removal opens it: [{}]", ctx.bd.nets[net].name, if ok { "OK" } else { "FAILS:" },
                  if ok { String::new() } else { r.hard_fail.unwrap_or_default() }, openers.join(" "));
    }
}

/// v7 fix 4 (end step): `net` has no strict route with the other copper in place. For each other net q with routed
/// copper near it (inside the box of its items + JOIN_MARGIN, the join search box), in the base order: remove q, route
/// `net` strictly, then route q strictly; keep it when both route, the copper is legal and every signal via keeps its
/// return; else restore and try the next q. Returns the net that moved. The diagnosis (IOTROUTE_DIAG, spread NET-CORE
/// iteration 50) found such a single opener for every open net (/ETH_TX_EN: /PHY_RSTn or /ETH_TXD0).
fn third_net_repair(ctx: &mut Ctx, net: usize, order: &[usize]) -> Option<usize> {
    // a net proved walled in by fixed copper (Ctx::dead) cannot be opened by moving routed copper (ESP32-CORE a4: 5
    // walled power nets, 17 min of useless repair tries)
    if !ctx.dead[net].0.is_empty() {
        return None;
    }
    let snap: Vec<Shape> = ctx.bd.shapes.clone();
    let cands = repair_cands(ctx.bd, net, order);
    let restore = |ctx: &mut Ctx| {
        ctx.bd.shapes = snap.clone();
        ctx.bd.compact();
        ctx.gr.reset_cache();
    };
    let strict0 = ctx.strict;
    ctx.strict = true;
    let mut done = None;
    for q in cands {
        for s in ctx.bd.shapes.iter_mut() {
            if s.owner == q as i32 {
                s.alive = false;
            }
        }
        ctx.bd.compact();
        ctx.gr.reset_cache();
        // a plane net is fanned out, not joined (ESP32-CORE a4: route_net on GND)
        let ok = (if ctx.bd.nets[net].plane { fanout_net(ctx, net) } else { route_net(ctx, net) }).hard_fail.is_none()
            && (if ctx.bd.nets[q].plane { fanout_net(ctx, q) } else { route_net(ctx, q) }).hard_fail.is_none();
        if ok && ctx.audit(0.0).pairs == 0 && ctx.ret_missing().is_empty() {
            done = Some(q);
            break;
        }
        restore(ctx);
    }
    ctx.strict = strict0;
    done
}

/// Nets the third-net repair may move for the open net, in base order. A routed net: every net with copper within
/// JOIN_MARGIN of the bbox of the net's fixed items (v7). v8 fix 3: a plane net is open only at the pads that have no
/// fan-out via, and the fan-out search looks only 2 mm around such a pad (fanout_net_inner), so only copper that
/// reaches into that window (2 mm + via radius + the largest clearance) can block it. v7 took the bbox of all GND
/// items (the whole board): every net was a candidate, and the ESP32-CORE end step ran about 9 minutes.
fn repair_cands(bd: &Board, net: usize, order: &[usize]) -> Vec<usize> {
    let mut boxes: Vec<(f64, f64, f64, f64)> = Vec::new();
    if bd.nets[net].plane {
        let m = 2.0 + bd.nets[net].via_d / 2.0 + bd.reach();
        for pad in bd.shapes.iter().filter(|s| s.alive && s.net == net as i32 && s.kind == Kind::Pad && s.owner < 0 && s.drill == 0.0) {
            let (a, b, c, d) = pad.geo.bbox();
            let (cx, cy) = ((a + c) / 2.0, (b + d) / 2.0);
            let has = bd.shapes.iter().any(|s| s.alive && s.net == net as i32 && s.kind == Kind::Via
                && (if s.owner < 0 { s.geo.dist(cx, cy) < 1.0 } else { touch(s, pad) }));
            if !has {
                boxes.push((a - m, b - m, c + m, d + m));
            }
        }
    } else {
        let (mut a, mut b, mut c, mut d) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for s in bd.shapes.iter().filter(|s| s.alive && s.net == net as i32 && s.owner < 0) {
            let (x0, y0, x1, y1) = s.geo.bbox();
            a = a.min(x0); b = b.min(y0); c = c.max(x1); d = d.max(y1);
        }
        let m = JOIN_MARGIN;
        boxes.push((a - m, b - m, c + m, d + m));
    }
    order.iter().cloned().filter(|&q| q != net && bd.shapes.iter().any(|s| s.alive && s.owner == q as i32 && {
        let (x0, y0, x1, y1) = s.geo.bbox();
        boxes.iter().any(|&(a, b, c, d)| x1 >= a && x0 <= c && y1 >= b && y0 <= d)
    })).collect()
}

fn tree_pads(ctx: &Ctx, items: &[usize]) -> Vec<String> {
    items.iter().filter_map(|&s| {
        let sh = &ctx.bd.shapes[s];
        match (sh.kind == Kind::Pad, sh.geo) {
            (true, Geo::Rect(a, b, c, d)) => Some(format!("({:.2}, {:.2})", (a + c) / 2.0, (b + d) / 2.0)),
            _ => None,
        }
    }).collect()
}

/// Return via (RP-001) diameter and drill: the flag, else the GND net's own via from the model (its class via and the
/// DRU via rules that select GND, as for its fan-out vias), else the old fixed 0.45 / 0.2. M2: the fixed default put 131
/// return vias under the H7-CORE DRU 0.6 / 0.3 minimum; NET-CORE has a GND-only 0.45 / 0.2 rule, so it keeps 0.45 / 0.2.
fn return_via(bd: &Board, cli: Option<(f64, f64)>) -> (f64, f64, &'static str) {
    if let Some((d, dr)) = cli {
        return (d, dr, "cli");
    }
    if bd.gnd >= 0 {
        let g = &bd.nets[bd.gnd as usize];
        return (g.via_d, g.via_drill, "GND net");
    }
    (0.45, 0.2, "default")
}

/// Add the tracks and vias of a router result as routed copper of their nets (pour check of a routed board, --check).
pub(crate) fn add_result(bd: &mut Board, r: &Value) {
    let names_v: Vec<String> = bd.nets.iter().map(|q| q.name.clone()).collect();
    let ni = |n: &str| names_v.iter().position(|q| q == n).map(|i| i as i32).unwrap_or(-1);
    let all = (1u8 << bd.layer_names.len()) - 1;
    for t in r["tracks"].as_array().unwrap() {
        let net = ni(t["net"].as_str().unwrap());
        let l = bd.layer_names.iter().position(|q| q == t["layer"].as_str().unwrap()).unwrap();
        let clr = if net >= 0 { bd.nets[net as usize].clr } else { 0.15 };
        bd.add(Shape { net, geo: Geo::Seg(f(&t["a"][0]), f(&t["a"][1]), f(&t["b"][0]), f(&t["b"][1]), f(&t["w"]) / 2.0), clr, layers: 1 << l, drill: 0.0, kind: Kind::Track, owner: net.max(0), alive: true, grp: 0 });
    }
    for v in r["vias"].as_array().unwrap() {
        let net = ni(v["net"].as_str().unwrap());
        let clr = if net >= 0 { bd.nets[net as usize].clr } else { 0.15 };
        bd.add(Shape { net, geo: Geo::Circ(f(&v["x"]), f(&v["y"]), f(&v["d"]) / 2.0), clr, layers: all, drill: f(&v["drill"]), kind: Kind::Via, owner: net.max(0), alive: true, grp: 0 });
    }
}

fn main() {
    if let Some(code) = owned::dispatch() {
        std::process::exit(code);
    }
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("write") => std::process::exit(write::cli(&args[2..])),
        Some("board-json") => std::process::exit(iotroute::kicad::cli(&args[2..])),
        Some("model") => std::process::exit(iotroute::model::cli::cli(&args[2..])),
        _ => {}
    }
    route_cli(&args);
}

fn route_cli(args: &[String]) {
    if args.len() < 3 {
        eprintln!("usage: iotroute MODEL.json OUT.json [--pitch 0.05] [--iters 40] [--plane-clr 0.25] [--hole-to-hole 0.45] [--hole-clr 0.28] [--return-r 2.0] [--return-via 0.45,0.2] [--pres-mult 1.5] [--pres-max 1000] [--hist 0.3] [--max-time S] [--door-hist 2.0] [--check RESULT.json] [--congestion MAP.json [--cong-cell 1.0] [--cong-free 0|1]] [--seed N] [--checkpoint FILE [--source-sha HEX]] [--stall-passes N]");
        std::process::exit(2);
    }
    let mut o = Opts { pitch: 0.05, passes: 40, plane_clr: DEF_PLANE_CLR, hth: DEF_HOLE_TO_HOLE, return_r: 2.0, ret_d: 0.45, ret_drill: 0.2,
                       pres_mult: 1.5, pres_max: 1000.0, hist: 0.3, max_time: 0.0, door_hist: 2.0, via_cost: DEF_VIA_COST, ret_cost: DEF_RET_COST, web_cost: DEF_WEB_COST, no_recover: false, stall_passes: 0 };
    // CLI flags override the model's hole rules, which override the defaults
    let (mut cli_plane, mut cli_hth, mut cli_hole): (Option<f64>, Option<f64>, Option<f64>) = (None, None, None);
    let mut check_only: Option<String> = None;
    let mut cli_web: Option<f64> = None;
    let mut web_hard = false;
    let mut cli_ret = false;
    let mut cli_rr = false;
    let mut reuse_path: Option<String> = None;
    let mut reuse_near = 1.0f64;
    let mut cong_path: Option<String> = None;
    let mut cong_cell = 1.0f64;
    let mut cong_free = false;
    let mut seed: Option<u64> = None;
    let mut ckpt_path: Option<String> = None;
    let mut source_sha: Option<String> = None;
    let mut i = 3;
    while i + 1 < args.len() {
        let v = &args[i + 1];
        match args[i].as_str() {
            "--pitch" => o.pitch = v.parse().unwrap(),
            "--iters" | "--passes" => o.passes = v.parse().unwrap(),
            "--plane-clr" => cli_plane = Some(v.parse().unwrap()),
            "--hole-to-hole" => cli_hth = Some(v.parse().unwrap()),
            "--hole-clr" => cli_hole = Some(v.parse().unwrap()),
            "--return-r" => {
                o.return_r = v.parse().unwrap();
                cli_rr = true;
            }
            "--pres-mult" => o.pres_mult = v.parse().unwrap(),
            "--pres-max" => o.pres_max = v.parse().unwrap(),
            "--hist" => o.hist = v.parse().unwrap(),
            "--max-time" => o.max_time = v.parse().unwrap(),
            "--door-hist" => o.door_hist = v.parse().unwrap(),
            "--check" => check_only = Some(v.clone()),
            "--web" => cli_web = Some(v.parse().unwrap()),
            "--web-hard" => web_hard = v == "1",
            "--web-cost" => o.web_cost = v.parse().unwrap(),
            "--via-cost" => o.via_cost = v.parse().unwrap(),
            "--recover" => o.no_recover = v == "0",
            "--reuse" => reuse_path = Some(v.clone()),
            "--reuse-near" => reuse_near = v.parse().unwrap(),
            "--congestion" => cong_path = Some(v.clone()),
            "--cong-cell" => cong_cell = v.parse().unwrap(),
            "--cong-free" => cong_free = v == "1",
            "--ret-cost" => o.ret_cost = v.parse().unwrap(),
            "--seed" => seed = Some(v.parse().unwrap()),
            "--checkpoint" => ckpt_path = Some(v.clone()),
            "--source-sha" => source_sha = Some(v.clone()),
            "--stall-passes" => o.stall_passes = v.parse().unwrap(),
            "--return-via" => {
                let p: Vec<f64> = v.split(',').map(|s| s.parse().unwrap()).collect();
                o.ret_d = p[0];
                o.ret_drill = p[1];
                cli_ret = true;
            }
            a => {
                eprintln!("unknown option {a}");
                std::process::exit(2)
            }
        }
        i += 2;
    }
    let t0 = std::time::Instant::now();
    let mut ckpt = ckpt_path.as_ref().map(|p| checkpoint::Writer::new(p, t0, seed, o.passes));
    let model_text = std::fs::read_to_string(&args[1]).expect("model");
    let model: Value = serde_json::from_str(&model_text).expect("json");
    if let Some(w) = &mut ckpt {
        w.bind(checkpoint::Bind::new(&model_text, &model, source_sha, &args[3..]));
        checkpoint::stop_on_signal();
    }
    let (m_hole, m_hth, m_plane) = hole_rules(&model);
    let hole_clr = cli_hole.or(m_hole).unwrap_or(DEF_HOLE_CLR);
    o.hth = cli_hth.or(m_hth).unwrap_or(DEF_HOLE_TO_HOLE);
    o.plane_clr = cli_plane.or(m_plane).unwrap_or(DEF_PLANE_CLR);
    let src = |c: Option<f64>, m: Option<f64>| if c.is_some() { "cli" } else if m.is_some() { "model" } else { "default" };
    eprintln!("hole rules: hole-clr {:.3} ({}), hole-to-hole {:.3} ({}), plane-clr {:.3} ({})", hole_clr, src(cli_hole, m_hole), o.hth,
              src(cli_hth, m_hth), o.plane_clr, src(cli_plane, m_plane));
    let mut bd = load(&model, hole_clr);
    bd.plane_clr = o.plane_clr;
    if let Some(w) = cli_web {
        bd.web = w;
    }
    bd.web_hard = web_hard;
    eprintln!("antipad web {:.3} mm ({}, {}), via cost {:.1}, new-return surcharge {:.1}", bd.web, if cli_web.is_some() { "cli" } else { "model plane zones: 2 x clearance + min_thickness" },
              if web_hard { "hard rule".to_string() } else { format!("priced {:.1} per item", o.web_cost) }, o.via_cost, o.ret_cost);
    let (rd, rdr, rsrc) = return_via(&bd, if cli_ret { Some((o.ret_d, o.ret_drill)) } else { None });
    o.ret_d = rd;
    o.ret_drill = rdr;
    // RP-001 radius as the board gate checks it (model return_rule: kicad-happy formula from the stackup); the flag
    // overrides; 2.0 mm only when the model has none (H7-CORE: 1.0 mm, the fixed 2.0 left 26 RP-001 findings)
    let m_rr = model["return_rule"]["radius"].as_f64().filter(|&r| r > 0.0);
    if !cli_rr {
        if let Some(r) = m_rr {
            o.return_r = r;
        }
    }
    eprintln!("return via: {rd:.2} / {rdr:.2} ({rsrc}), radius {:.3} ({}), GND through-hole pads {}", o.return_r,
              if cli_rr { "cli" } else if m_rr.is_some() { "model" } else { "default" },
              if model["return_rule"]["pads"].as_bool().unwrap_or(true) { "count" } else { "do not count" });
    if let Some(res) = check_only {
        // pour check of a routed result (no routing): its tracks and vias are added as routed copper of their nets
        let r: Value = serde_json::from_str(&std::fs::read_to_string(&res).expect("result")).expect("json");
        add_result(&mut bd, &r);
        let tp = std::time::Instant::now();
        let faults = pour::check(&bd);
        for fl in &faults {
            let walls: Vec<&str> = fl.walls.iter().map(|&w| bd.nets[w].name.as_str()).collect();
            println!("  {} on {}: spokes {} ignored {}; door {} cells ({}), walls {}", fl.pad, bd.layer_names[fl.layer], fl.good, fl.ignored, fl.door.len(),
                     if fl.fixed { "none: fixed copper" } else { "routed copper" }, walls.join(" "));
        }
        let modes: Vec<String> = bd.pours.iter().map(|p| format!("{} island_removal_mode {}", bd.layer_names[p.layer], p.island_mode)).collect();
        println!("POUR {} faults {} pours {} ({}) {:.2} s", if faults.is_empty() { "PASS" } else { "FAIL" }, faults.len(), bd.pours.len(), modes.join(", "), tp.elapsed().as_secs_f64());
        return;
    }
    if let Ok(v) = std::env::var("IOTROUTE_DUMP_FIXED") {
        // debug: fixed shapes in the box "x0,y0,x1,y1" (net, kind, layers, geo)
        let b: Vec<f64> = v.split(',').map(|q| q.parse().unwrap()).collect();
        for s in bd.shapes.iter().filter(|s| s.alive) {
            let (a, c, d, e) = s.geo.bbox();
            if d >= b[0] && a <= b[2] && e >= b[1] && c <= b[3] {
                eprintln!("fixed {} {:?} L{:b} {:?}", if s.net >= 0 { bd.nets[s.net as usize].name.as_str() } else { "-" }, s.kind as u8, s.layers, s.geo);
            }
        }
    }
    if let Ok(v) = std::env::var("IOTROUTE_PROBE") {
        // debug: "NET,x0,y0,x1,y1": fixed-copper map of a track centre of NET at its width on F.Cu (0.05 grid): # blocked
        let a: Vec<&str> = v.split(',').collect();
        let net = bd.nets.iter().position(|n| n.name == a[0]).unwrap();
        let b: Vec<f64> = a[1..].iter().map(|q| q.parse().unwrap()).collect();
        let hw = bd.nets[net].width / 2.0;
        let mut y = b[1];
        while y <= b[3] + 1e-9 {
            let mut row = format!("{y:8.2} ");
            let mut x = b[0];
            while x <= b[2] + 1e-9 {
                let c = bd.track_fixed_code(0, x, y, hw, bd.nets[net].clr, bd.pflags(net), bd.plane_clr);
                row.push(if blocks(c, net as i32) { '#' } else if c == net as i32 { 'o' } else { '.' });
                x += 0.05;
            }
            eprintln!("{row}");
            y += 0.05;
        }
    }
    let base0 = bd.shapes.len();
    // RP-001 for the locked input vias (pairs): a return via is placed now as fixed copper (written with the result)
    let in_ret_notes = fixed_returns(&mut bd, &o);
    for m in &in_ret_notes {
        eprintln!("{m}");
    }
    for m in fixed_vip_vias(&mut bd, &o) {
        eprintln!("{m}");
    }
    let pre = pre_attach(&mut bd, o.pitch);
    if pre > 0 {
        eprintln!("pour model before routing: {pre} SMD pad(s) starved by fixed copper alone get a forced fan-out track (a track spoke)");
    }
    // reuse (reuse.rs): the kept copper of the earlier route is loaded as routed copper; only the ripped nets are routed
    // in iteration 1
    let plan: Option<reuse::SeedPlan> = reuse_path.as_ref().map(|p| {
        let seed: Value = serde_json::from_str(&std::fs::read_to_string(p).expect("seed")).expect("seed json");
        reuse::load_seed(&mut bd, &o, &model, &seed)
    });
    if let Some(pl) = &plan {
        let why: Vec<String> = pl.why.iter().map(|(n, w)| format!("{} ({w})", bd.nets[*n].name)).collect();
        eprintln!("REUSE kept {} nets ({} items), ripped {} nets ({} items dropped), plane re-fan {} (clusters dropped {}): {}", pl.kept_nets, pl.items_kept,
                  pl.rip.len(), pl.items_dropped, pl.fan.iter().map(|&n| bd.nets[n].name.as_str()).collect::<Vec<_>>().join(" "), pl.fan_dropped, why.join(", "));
    }
    let (e0, e1, e2, e3) = bd.edge;
    let nx = ((e2 - e0) / o.pitch).ceil() as usize + 1;
    let ny = ((e3 - e1) / o.pitch).ceil() as usize + 1;
    let nr = bd.routable.len();
    let tot = nx * ny * nr;
    let mut gr = Grid { x0: e0, y0: e1, p: o.pitch, nx, ny, nr, cache: vec![0; tot], vcache: vec![0; nx * ny], dcache: vec![0; tot], hist: vec![0.0; tot], vhist: vec![0.0; nx * ny], pres: 0.5,
                    g: vec![0.0; tot], from: vec![0; tot], seen: vec![0; tot], closed: vec![0; tot], tgt: vec![0; tot], sgen: 0, tgen: 0, glen: Vec::new(), lhist: Vec::new(), jit: Default::default() };
    let mut order: Vec<usize> = (0..bd.nets.len()).collect();
    let spread = |bd: &Board, n: usize| -> f64 {
        let (mut a, mut b, mut c, mut d) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for s in bd.shapes.iter().filter(|s| s.net == n as i32 && s.kind == Kind::Pad) {
            let (x0, y0, x1, y1) = s.geo.bbox();
            a = a.min(x0); b = b.min(y0); c = c.max(x1); d = d.max(y1);
        }
        if a == f64::MAX { 0.0 } else { (c - a) + (d - b) }
    };
    let group = |bd: &Board, n: usize| if bd.nets[n].plane { 0 } else if bd.nets[n].power { 1 } else if bd.nets[n].fast { 2 } else { 3 };
    order.sort_by(|&a, &b| group(&bd, a).cmp(&group(&bd, b)).then(spread(&bd, a).partial_cmp(&spread(&bd, b)).unwrap()));
    if let Some(s) = seed {
        let mut rng = seed::Rng::new(s);
        seed::shuffle_groups(&mut order, &|n| group(&bd, n), &mut rng);
        gr.jit = seed::Jitter::new(&mut rng, nx, ny, nr, o.pitch);
        eprintln!("seed {s}: net order shuffled inside its groups, search cost field on");
    }
    let nets_n = bd.nets.len();
    let mut memo_w: Vec<f64> = bd.nets.iter().flat_map(|n| net_widths(n)).chain([0.3, 0.2, 0.15]).collect();
    // v8: layer floors and pin-escape widths are search widths too (hw_at)
    memo_w.extend(bd.nets.iter().flat_map(|n| n.min_wl.iter().cloned().filter(|&w| w > 0.0)));
    memo_w.extend(bd.esc.iter().map(|e| e.1));
    memo_w.sort_by(|a, b| a.partial_cmp(b).unwrap());
    memo_w.dedup();
    let rplanes = 1 + bd.gnds.len();
    let mut ctx = Ctx { bd: &mut bd, gr, o: &o, strict: false, dead: vec![(Vec::new(), String::new()); nets_n], memo: Vec::new(), memo_w,
                        rcache: vec![0; nx * ny * rplanes], ban: Vec::new(), neck: Vec::new(), len_cap: None, len_boxes: Vec::new(), len_mode: false, ret_soft: true, lfloor: Vec::new(), leaf_necks: false, stubs: std::collections::HashMap::new(), stub_cost: Default::default(), recover: false, fan_keep: false };
    let fan_fail: Vec<Fail> = Vec::new();
    let nn = ctx.bd.nets.len();
    let mut todo: Vec<usize> = match &plan {
        Some(pl) => order.iter().cloned().filter(|n| pl.rip.contains(n) || pl.fan.contains(n)).collect(),
        None => order.clone(),
    };
    ctx.fan_keep = plan.is_some();
    // reuse: the kept copper is the legal end state of an earlier negotiation, so the present cost starts where that
    // negotiation ended (pres after its iteration count, seed `passes`: start 0.5, x --pres-mult per iteration, capped at
    // --pres-max), not at the start price 0.5 (with 0.5 the ripped nets crossed kept copper and the conflicts spread)
    if let Some(pl) = &plan {
        if pl.passes > 1 {
            ctx.gr.pres = (0.5 * o.pres_mult.powi(pl.passes as i32 - 1)).min(o.pres_max);
        }
        eprintln!("reuse: present cost starts at {:.2} (earlier route: {} iteration(s))", ctx.gr.pres, pl.passes);
    }
    let mut state: Vec<(Option<String>, u32)> = vec![(None, 0); nn];
    let mut iters = 0;
    let mut converged = false;
    let names = |bd: &Board, v: &[usize]| v.iter().map(|&n| bd.nets[n].name.as_str()).collect::<Vec<_>>().join(" ");
    // best iteration so far: (nets in conflict, conflicting pairs) -> its copper and state, restored when not converged
    let mut best: Option<((usize, usize), usize, Vec<Shape>, Vec<(Option<String>, u32)>)> = None;
    let mut limited_prev: Vec<usize> = Vec::new();
    let (mut stall, mut stall_sig): (usize, Option<Vec<(usize, Option<String>)>>) = (0, None);
    // pour faults by pad: consecutive iterations seen; hard doors reserved in the negotiation
    let mut pour_seen: Vec<(String, usize)> = Vec::new();
    let mut hard_doors = 0usize;
    // v7 fix 2: times each net was routed in the negotiation (rip_order)
    let mut moves: Vec<u32> = vec![0; nn];
    // why the negotiation ended; passes in a row that did not beat `best` (--stall-passes, checkpoint)
    let mut stop = "iters";
    let mut since_best = 0usize;
    let mut stall_note: Option<String> = None;
    for it in 0..o.passes {
        iters = it + 1;
        ctx.bd.compact();
        let mut total = 0u32;
        let mut limited: Vec<usize> = Vec::new();
        let prof = std::env::var("IOTROUTE_PROF").is_ok();
        let mut kept = 0;
        for &net in &todo {
            // a net ripped up for a conflict whose partner has already moved away in this iteration keeps its copper
            // (without this, two nets in conflict both move every iteration and swap places forever)
            if it > 0 && !limited_prev.contains(&net) && ctx.bd.shapes.iter().any(|s| s.alive && s.owner == net as i32) && !ctx.net_in_conflict(net) {
                kept += 1;
                continue;
            }
            let tn = std::time::Instant::now();
            moves[net] += 1;
            let r = if ctx.bd.nets[net].plane { fanout_net(&mut ctx, net) } else { route_net(&mut ctx, net) };
            if prof {
                eprintln!("  {:<14} {:6.2} s conflicts {:5}{}", ctx.bd.nets[net].name, tn.elapsed().as_secs_f64(), r.conflicts, if r.limit { " LIMIT" } else { "" });
            }
            if r.limit {
                limited.push(net);
            }
            total += r.conflicts;
            state[net] = (r.hard_fail.clone(), r.conflicts);
        }
        let search_limited = limited.len();
        ctx.fan_keep = false;
        // PathFinder overuse = exact audit of the final copper of this iteration: history on every conflicting item
        // of both nets, and the rip-up set = every net that is still in conflict (not the stale routing-time count)
        let au = ctx.audit(o.hist);
        let mut involved: Vec<usize> = (0..nn).filter(|&n| au.per_net[n] > 0 || !au.partners[n].is_empty()).collect();
        // layer negotiation (layers.rs): a one-layer net in conflict gets history on the layer it is on
        ctx.layer_hist(&involved, o.hist);
        // RP-001: a signal via whose GND return went away (the return via of another net that moved) re-routes its net
        let mut ret_nets: Vec<usize> = ctx.ret_missing().into_iter().map(|m| m.0).collect();
        ret_nets.sort();
        ret_nets.dedup();
        for &n in limited.iter().chain(ret_nets.iter()) {
            if !involved.contains(&n) {
                involved.push(n);
            }
        }
        limited.extend(ret_nets.iter().cloned());
        // pour (v5): a thermal pad whose spokes reach only an island (KiCad starved_thermal) is a conflict of the
        // routed nets that wall the island in: door history on their cells, and they are routed again
        let (pf, pour_nets, pour_fixed) = ctx.pour_pass(o.door_hist);
        // a fault that the door history did not remove in DOOR_STALL iterations gets a hard door now (its path is
        // reserved as pour, the walls are routed again around it in the next iteration)
        let mut seen_now: Vec<(String, usize)> = Vec::new();
        for fl in pf.iter().filter(|fl| !fl.fixed) {
            let c = pour_seen.iter().find(|e| e.0 == fl.pad).map(|e| e.1).unwrap_or(0) + 1;
            if c >= DOOR_STALL {
                ctx.reserve_door(fl);
                hard_doors += 1;
                eprintln!("  pour: hard door for {} ({} iterations), path {} cells, walls {}", fl.pad, c, fl.path.len(), names(ctx.bd, &fl.walls));
            } else {
                seen_now.push((fl.pad.clone(), c));
            }
        }
        pour_seen = seen_now;
        for &n in &pour_nets {
            if !involved.contains(&n) {
                involved.push(n);
            }
            if !limited.contains(&n) {
                limited.push(n);
            }
        }
        limited_prev = limited;
        let hard_nets: Vec<usize> = order.iter().cloned().filter(|&n| state[n].0.is_some()).collect();
        eprintln!("iter {:2}: routed {:3}, conflicts {:5}, audit pairs {:4} samples {:5} hard {}, pour faults {} (walls {}, fixed {}), involved {:3}, hard fails {:2}, pres {:.2}, {:.1} s  hard: {}  involved: {}",
                  it + 1, todo.len() - kept, total, au.pairs, au.samples, au.hard, pf.len(), pour_nets.len(), pour_fixed, involved.len(), hard_nets.len(), ctx.gr.pres, t0.elapsed().as_secs_f64(),
                  names(ctx.bd, &hard_nets), if involved.len() <= 16 { names(ctx.bd, &involved) } else { String::from("...") });
        if std::env::var("IOTROUTE_DEBUG").is_ok() {
            for fl in &pf {
                eprintln!("  pour fault {} on {}: spokes {} ignored {}, door {} cells, walls {}", fl.pad, ctx.bd.layer_names[fl.layer], fl.good, fl.ignored, fl.door.len(), names(ctx.bd, &fl.walls));
            }
        }
        if std::env::var("IOTROUTE_DEBUG").is_ok() && involved.len() <= 3 {
            for &(p, q) in au.pair_ids.iter().take(8) {
                let (a, b) = (&ctx.bd.shapes[p as usize], &ctx.bd.shapes[q as usize]);
                eprintln!("  pair: {} {:?} | {} {:?}", ctx.bd.nets[a.net as usize].name, a.geo, ctx.bd.nets[b.net as usize].name, b.geo);
            }
        }
        if let Some(from) = std::env::var("IOTROUTE_DIAG").ok().and_then(|v| v.parse::<usize>().ok()) {
            let most = std::env::var("IOTROUTE_DIAG_NETS").ok().and_then(|v| v.parse::<usize>().ok()).unwrap_or(4);
            if it + 1 >= from && involved.len() <= most {
                diag_standoff(&mut ctx, &au, &involved, &order);
            }
        }
        let score = (involved.len(), au.pairs);
        if best.as_ref().map(|b| score < b.0).unwrap_or(true) {
            best = Some((score, it + 1, ctx.bd.shapes.iter().filter(|s| s.alive).cloned().collect(), state.clone()));
            since_best = 0;
        } else {
            since_best += 1;
        }
        if let Some(w) = &mut ckpt {
            w.pass(&ctx, &checkpoint::Pass { pass: it + 1, au: &au, involved: &involved, state: &state, pour_faults: pf.len(), search_limited, best: best.as_ref().map(|b| (b.1, b.0)), since_best });
        }
        if involved.is_empty() {
            converged = true;
            stop = "converged";
            break;
        }
        if o.max_time > 0.0 && t0.elapsed().as_secs_f64() > o.max_time {
            eprintln!("time limit {:.0} s reached", o.max_time);
            stop = "max-time";
            break;
        }
        // a pass end is the safe boundary: every net has its copper, so the best pass can be restored as for --max-time
        if checkpoint::stop_asked() {
            let m = format!("stopped early: cancel signal, ended at pass {}", it + 1);
            eprintln!("{m}");
            stall_note = Some(m);
            stop = "cancelled";
            break;
        }
        // progress = a pass better than the best so far, on the score that picks the iteration a run ends from: a pass that
        // does not beat it would not change what an early stop keeps
        if o.stall_passes > 0 && since_best >= o.stall_passes {
            let b = best.as_ref().unwrap();
            let m = format!("stopped early: no progress for {since_best} passes (--stall-passes {}), best pass {}: {} nets in conflict, {} pairs", o.stall_passes, b.1, b.0.0, b.0.1);
            eprintln!("{m}");
            stall_note = Some(m);
            stop = "stall-passes";
            break;
        }
        // stop early: the copper is legal and every net still open is a hard fail whose reason has not changed for
        // STALL iterations (v3 ran iterations 20-80 on one unchanged hard fail)
        let sig: Vec<(usize, Option<String>)> = involved.iter().map(|&n| (n, state[n].0.clone())).collect();
        if au.pairs == 0 && involved.iter().all(|&n| state[n].0.is_some()) && stall_sig.as_ref() == Some(&sig) {
            stall += 1;
            if stall >= STALL {
                eprintln!("stopped: {} hard fail(s) unchanged for {} iterations, no conflicts", involved.len(), STALL + 1);
                stop = "hard-fails";
                break;
            }
        } else {
            stall = 0;
        }
        stall_sig = Some(sig);
        ctx.gr.pres = (ctx.gr.pres * o.pres_mult).min(o.pres_max);
        // hard fails are walls of fixed copper: they do not change, so a hard-failed net is routed again only when it
        // is in conflict
        todo = rip_order(&order, &involved, &moves);
    }
    let best_end = best.as_ref().map(|b| (b.1, b.0));
    let mut web_relaxed = 0.0f64;
    if !converged {
        // graceful end: take the best iteration, rip up nets until the copper is legal (most conflicts first), then
        // route the ripped nets again with soft conflicts blocking; what stays open is reported as failed
        let (score, bit, shapes, st) = best.take().unwrap();
        // the hard doors reserved so far stay (fixed copper of this run): replace the snapshot's doors by the present
        let doors_now: Vec<Shape> = ctx.bd.shapes.iter().enumerate().filter(|(i, s)| *i >= base0 && s.alive && s.kind == Kind::Spoke).map(|(_, s)| s.clone()).collect();
        ctx.bd.shapes = shapes;
        if hard_doors > 0 {
            for (i, s) in ctx.bd.shapes.iter_mut().enumerate() {
                if i >= base0 && s.kind == Kind::Spoke {
                    s.alive = false;
                }
            }
            ctx.bd.shapes.extend(doors_now);
        }
        ctx.bd.compact();
        if hard_doors > 0 {
            ctx.memo.clear();
            ctx.rcache.iter_mut().for_each(|c| *c = 0);
            ctx.gr.reset_cache();
        }
        state = st;
        let mut ripped: Vec<usize> = Vec::new();
        loop {
            let au = ctx.audit(0.0);
            if au.pairs == 0 {
                break;
            }
            // greedy vertex cover of the net conflict graph: rip the net with the most partners left (then the most
            // conflict samples) until no conflict pair is left; one audit per round, a second round only as a guard
            let mut adj: Vec<Vec<usize>> = au.partners.clone();
            for a in 0..nn {
                for &b in &au.partners[a] {
                    if !adj[b].contains(&a) {
                        adj[b].push(a);
                    }
                }
            }
            let mut cut = vec![false; nn];
            loop {
                let deg = |n: usize| adj[n].iter().filter(|&&m| !cut[m]).count();
                let worst = (0..nn).filter(|&n| !cut[n]).max_by_key(|&n| (deg(n), au.per_net[n])).unwrap();
                if deg(worst) == 0 {
                    break;
                }
                cut[worst] = true;
            }
            // a net in conflict with no routed partner listed (cannot happen: conflicts are only with routed items)
            for n in 0..nn {
                if au.per_net[n] > 0 && adj[n].iter().all(|&m| !cut[m]) {
                    cut[n] = true;
                }
            }
            for s in ctx.bd.shapes.iter_mut() {
                if s.owner >= 0 && cut[s.owner as usize] {
                    s.alive = false;
                }
            }
            ripped.extend((0..nn).filter(|&n| cut[n]));
        }
        ctx.strict = true;
        // v6 fix 3c: the antipad web is a limit of the negotiation; when it did not converge, the strict end step
        // routes the ripped nets with the web off (the copper rules stay), and the web pairs left are reported
        web_relaxed = if ctx.bd.web_hard { ctx.bd.web } else { 0.0 };
        if web_relaxed > 0.0 {
            ctx.bd.web_hard = false;
            ctx.bd.web = 0.0;
            ctx.memo.clear();
            ctx.gr.reset_cache();
        }
        let mut reopened = Vec::new();
        for &net in order.iter().filter(|n| ripped.contains(n)) {
            let r = if ctx.bd.nets[net].plane { fanout_net(&mut ctx, net) } else { route_net(&mut ctx, net) };
            match r.hard_fail {
                Some(m) => {
                    state[net] = (Some(format!("negotiation did not converge; strict re-route (routed copper blocks): {m}")), 0);
                    reopened.push(net);
                }
                None => state[net] = (None, 0),
            }
        }
        // v6: rip-up cascade for a net that the strict re-route left open (NET-CORE RMII standoffs: /ETH_TX_EN,
        // /ETH_TXD0): route it once with conflicts allowed, rip the nets it now crosses and route those strictly;
        // up to 4 rounds, kept only when fewer nets stay open and the copper is legal (else restored)
        let mut cascade_note = String::new();
        if !reopened.is_empty() {
            let snap: Vec<Shape> = ctx.bd.shapes.clone();
            let st0 = state.clone();
            let open0 = reopened.len();
            let mut open = reopened.clone();
            for _round in 0..4 {
                if open.is_empty() {
                    break;
                }
                let mut next: Vec<usize> = Vec::new();
                for &net in &open {
                    ctx.strict = false;
                    let r = route_net(&mut ctx, net);
                    if r.hard_fail.is_some() {
                        next.push(net);
                        continue;
                    }
                    state[net] = (None, 0);
                    let au = ctx.audit_of(0.0, Some(net));
                    let partners: Vec<usize> = au.partners[net].clone();
                    for s in ctx.bd.shapes.iter_mut() {
                        if s.owner >= 0 && partners.contains(&(s.owner as usize)) {
                            s.alive = false;
                        }
                    }
                    ctx.strict = true;
                    for &q in order.iter().filter(|q| partners.contains(q)) {
                        let r = if ctx.bd.nets[q].plane { fanout_net(&mut ctx, q) } else { route_net(&mut ctx, q) };
                        match r.hard_fail {
                            Some(m) => {
                                state[q] = (Some(format!("negotiation did not converge; cascade re-route (routed copper blocks): {m}")), 0);
                                next.push(q);
                            }
                            None => state[q] = (None, 0),
                        }
                    }
                }
                ctx.strict = false;
                let au = ctx.audit(0.0);
                for n in 0..nn {
                    if au.per_net[n] > 0 && !next.contains(&n) {
                        next.push(n);
                    }
                }
                next.sort();
                next.dedup();
                open = next;
            }
            ctx.strict = false;
            let legal = ctx.audit(0.0).pairs == 0;
            if open.len() < open0 && legal {
                cascade_note = format!("; cascade: open {} -> {}", open0, open.len());
                reopened = open;
            } else {
                ctx.bd.shapes = snap;
                ctx.bd.compact();
                ctx.gr.reset_cache();
                state = st0;
                cascade_note = format!("; cascade did not help ({} open, legal {}), restored", open.len(), legal);
            }
        }
        // v7 fix 4: third-net repair for each net still open (IOTROUTE_DIAG: the open net routes strictly once one other
        // net is removed, and that net has another way)
        if !reopened.is_empty() {
            let mut fixed = Vec::new();
            for &net in &reopened.clone() {
                if let Some(q) = third_net_repair(&mut ctx, net, &order) {
                    state[net] = (None, 0);
                    state[q] = (None, 0);
                    fixed.push(format!("{} (moved {})", ctx.bd.nets[net].name, ctx.bd.nets[q].name));
                    reopened.retain(|&n| n != net);
                }
            }
            if !fixed.is_empty() {
                cascade_note.push_str(&format!("; third-net repair: {}", fixed.join(", ")));
            }
        }
        ctx.strict = false;
        let au = ctx.audit(0.0);
        eprintln!("best iteration {bit} (nets in conflict {}, pairs {}); ripped {}: {}; strict re-route open {}: {}; audit pairs {}{}",
                  score.0, score.1, ripped.len(), names(ctx.bd, &ripped), reopened.len(), names(ctx.bd, &reopened), au.pairs, cascade_note);
        // the output keeps "N conflicts left" only for copper that is still illegal (a guard: should be none)
        for n in 0..nn {
            state[n].1 = au.per_net[n];
        }
    }
    if let Ok(w) = std::env::var("IOTROUTE_LENDIAG") {
        eprintln!("lendiag before the length recovery");
        diag_length(&mut ctx, &order, &w);
    }
    // v9: length recovery on a legal end state (see recover_length)
    let mut notes = Vec::new();
    if ctx.audit(0.0).pairs == 0 && !o.no_recover && !checkpoint::stop_asked() {
        let tr = std::time::Instant::now();
        let len0: f64 = net_lengths(ctx.bd).iter().sum();
        let scope = plan.as_ref().map(|pl| reuse::recover_scope(ctx.bd, pl, &moves, reuse_near));
        if let Some(sc) = &scope {
            notes.push(format!("reuse: length recovery on {} of {} nets (routed now or within {reuse_near} mm of a change)", sc.iter().filter(|&&b| b).count(), nn));
        }
        let (k, saved) = match &scope { Some(sc) => recover_length_in(&mut ctx, &order, &state, Some(sc)), None => recover_length(&mut ctx, &order, &state) };
        let len1: f64 = net_lengths(ctx.bd).iter().sum();
        notes.push(format!("length recovery: {k} re-route(s) kept, objective -{saved:.1}, net length {len0:.1} -> {len1:.1} mm (vias at {:.3} mm)", ctx.bd.via_len));
        eprintln!("{} {:.1} s", notes.last().unwrap(), tr.elapsed().as_secs_f64());
    }
    if let Ok(w) = std::env::var("IOTROUTE_LENDIAG") {
        eprintln!("lendiag after the length recovery");
        diag_length(&mut ctx, &order, &w);
    }
    // RP-001 check of the final copper: a net with a signal via and no GND return within --return-r (its return via
    // was the one of a net ripped at the end) is routed again strictly, which places its returns; up to 3 rounds
    if ctx.bd.web > 0.0 && web_relaxed == 0.0 {
        notes.push(format!("antipad web {:.2} mm ({}): {} signal via pair(s) closer", ctx.bd.web, if ctx.bd.web_hard { "hard rule" } else { "priced" }, web_pairs(ctx.bd, ctx.bd.web)));
        eprintln!("{}", notes.last().unwrap());
    }
    if web_relaxed > 0.0 {
        let n = web_pairs(ctx.bd, web_relaxed);
        notes.push(format!("antipad web {web_relaxed:.2} mm relaxed in the strict end step (negotiation not converged): {n} signal via pair(s) closer"));
        eprintln!("{}", notes.last().unwrap());
    }
    // then the pour check of the final copper: a fault left after the negotiation (or made by a re-route here) gets a
    // hard door (pour strip reserved as fixed copper) and its wall nets are routed again strictly; up to 3 rounds
    let mut doors = 0;
    for round in 0..4 {
        ctx.strict = true;
        for _round in 0..3 {
            let mut miss: Vec<usize> = ctx.ret_missing().into_iter().map(|m| m.0).collect();
            miss.sort();
            miss.dedup();
            if miss.is_empty() {
                break;
            }
            for &net in order.iter().filter(|n| miss.contains(n)) {
                let r = route_net(&mut ctx, net);
                state[net].0 = r.hard_fail.map(|m| format!("RP-001 strict re-route: {m}"));
                // v7 fix 4: the third-net repair also here (H7-CORE a2n: /STEP1_S open after this re-route)
                if state[net].0.is_some() {
                    if let Some(q) = third_net_repair(&mut ctx, net, &order) {
                        state[net].0 = None;
                        state[q].0 = None;
                        eprintln!("third-net repair after RP-001 re-route: {} (moved {})", ctx.bd.nets[net].name, ctx.bd.nets[q].name);
                    }
                }
            }
        }
        ctx.strict = false;
        let (pf, walls, _) = ctx.pour_pass(0.0);
        let act: Vec<pour::Fault> = pf.into_iter().filter(|fl| !fl.fixed).collect();
        if act.is_empty() || round == 3 {
            break;
        }
        eprintln!("pour: {} fault(s) after the negotiation ({}); hard door round {}, walls re-routed strictly: {}", act.len(),
                  act.iter().map(|fl| fl.pad.as_str()).collect::<Vec<_>>().join(" "), round + 1, names(ctx.bd, &walls));
        for fl in &act {
            ctx.reserve_door(fl);
            doors += 1;
        }
        ctx.strict = true;
        for &net in order.iter().filter(|n| walls.contains(n)) {
            let r = if ctx.bd.nets[net].plane { fanout_net(&mut ctx, net) } else { route_net(&mut ctx, net) };
            state[net].0 = r.hard_fail.map(|m| format!("pour door strict re-route: {m}"));
        }
        ctx.strict = false;
    }
    if doors + hard_doors > 0 {
        notes.push(format!("pour: {hard_doors} hard door(s) reserved in the negotiation, {doors} after it"));
    }
    // v6 fix 3a: shared returns, the ones no signal via needs are removed
    let pruned = prune_returns(&mut ctx);
    eprintln!("returns: {pruned} return via(s) removed (every signal via keeps a GND via within {} mm)", o.return_r);
    let mut pour_fails: Vec<Fail> = Vec::new();
    for fl in pour::check(ctx.bd) {
        let pr = &ctx.bd.pours[fl.pour];
        let m = format!("{} on {}: {} spoke(s) reach a connected pour piece, {} reach an island (KiCad starved_thermal){}", fl.pad,
                        ctx.bd.layer_names[fl.layer], fl.good, fl.ignored, if fl.fixed { "; fixed copper alone walls it in (input)" } else { "" });
        if fl.fixed {
            notes.push(format!("pour: {m}"));
        } else {
            pour_fails.push(Fail { net: ctx.bd.nets[pr.net as usize].name.clone(), stage: "pour".into(), reason: m });
        }
    }
    for (net, x, y) in ctx.ret_missing() {
        let m = format!("RP-001: no GND return via within {} mm of the via at ({x:.2}, {y:.2})", o.return_r);
        state[net].0 = Some(match &state[net].0 { Some(r) => format!("{r}; {m}"), None => m });
    }
    // output: every live routed item plus the plane fan-out (fixed, added after the input copper)
    let mut tracks = Vec::new();
    let mut vias = Vec::new();
    let mut via_count = vec![0usize; nn];
    for (i, s) in ctx.bd.shapes.iter().enumerate() {
        if !s.alive || (s.owner < 0 && i < base0) || s.kind == Kind::Spoke {
            continue;
        }
        let name = if s.net >= 0 { ctx.bd.nets[s.net as usize].name.clone() } else { continue };
        match s.geo {
            Geo::Seg(ax, ay, bx, by, hw) => {
                let l = (0..ctx.bd.layer_names.len()).find(|&l| s.layers & (1 << l) != 0).unwrap();
                if s.owner >= 0 && ctx.bd.nets[s.net as usize].power && hw * 2.0 < ctx.bd.nets[s.net as usize].width - 1e-6 {
                    notes.push(format!("{name}: neck {:.2} mm (class {:.2})", hw * 2.0, ctx.bd.nets[s.net as usize].width));
                }
                tracks.push(OutTrack { net: name, layer: ctx.bd.layer_names[l].clone(), a: [ax, ay], b: [bx, by], w: hw * 2.0 });
            }
            Geo::Circ(x, y, r) => {
                let role = if s.owner < 0 || ctx.bd.nets[s.net as usize].plane && s.net == s.owner { "plane" } else if s.net == s.owner { "signal" } else { "return" };
                if role == "signal" {
                    via_count[s.net as usize] += 1;
                }
                vias.push(OutVia { net: name, x, y, d: r * 2.0, drill: s.drill, role: role.into() });
            }
            _ => {}
        }
    }
    // DRU via_count is a hard limit (input vias of the net included): a guard, route_net keeps it
    for n in 0..nn {
        if let Some(mv) = ctx.bd.nets[n].max_vias {
            if (via_count[n] + ctx.bd.nets[n].in_vias) as f64 > mv {
                let m = format!("DRU via_count max {mv}: {} new + {} locked vias", via_count[n], ctx.bd.nets[n].in_vias);
                state[n].0 = Some(match &state[n].0 { Some(r) => format!("{r}; {m}"), None => m });
            }
        }
    }
    // v7 DRU length (KiCad length_out_of_range) is a hard limit: a guard, route_net keeps it
    for (n, l) in net_lengths(ctx.bd).into_iter().enumerate() {
        if let Some(ml) = ctx.bd.nets[n].max_len {
            if l > ml {
                let m = format!("DRU length max {ml:.2} mm: {l:.2} mm (tracks + vias at {:.3} mm)", ctx.bd.via_len);
                state[n].0 = Some(match &state[n].0 { Some(r) => format!("{r}; {m}"), None => m });
            }
        }
    }
    if let Some(pl) = &plan {
        notes.push(format!("reuse: kept {} nets ({} items), ripped {} nets, plane re-fan {}, {} iteration(s)", pl.kept_nets, pl.items_kept, pl.rip.len(), pl.fan.len(), iters));
    }
    notes.extend(ctx.bd.spoke_notes.iter().cloned());
    notes.extend(in_ret_notes.iter().cloned());
    notes.extend(stall_note);
    if let Some(s) = seed {
        notes.push(format!("seed {s}"));
    }
    notes.sort();
    notes.dedup();
    let mut failed = fan_fail;
    for n in 0..nn {
        if let Some(r) = &state[n].0 {
            failed.push(Fail { net: ctx.bd.nets[n].name.clone(), stage: "route".into(), reason: r.clone() });
        } else if !converged && state[n].1 > 0 {
            failed.push(Fail { net: ctx.bd.nets[n].name.clone(), stage: "route".into(), reason: format!("{} conflicts left", state[n].1) });
        }
    }
    failed.extend(pour_fails);
    let out = Out { schema: "iot-lab.route-result.v0".into(), tracks, vias, failed, notes, passes: iters };
    std::fs::write(&args[2], serde_json::to_string_pretty(&out).unwrap()).expect("write");
    let route_s = t0.elapsed().as_secs_f64();
    if let Some(w) = &mut ckpt {
        w.done(&mut ctx, iters, stop, &out.failed, best_end, since_best);
    }
    if let Some(cp) = &cong_path {
        // congestion map (congestion.rs): after OUT.json, so it never changes the routed result
        let tc = std::time::Instant::now();
        let failed: Vec<bool> = (0..nn).map(|n| out.failed.iter().any(|f| f.net == ctx.bd.nets[n].name)).collect();
        let fs = congestion::write_map(&mut ctx, cp, cong_cell, &failed, cong_free);
        eprintln!("congestion map: {cp} (cell {cong_cell} mm, free routes {}) {:.1} s, free routes {fs:.1} s", if cong_free { "on" } else { "off" }, tc.elapsed().as_secs_f64());
    }
    let status = if out.failed.is_empty() { "PASS" } else { "FAIL" };
    let stopped = if stop == "stall-passes" || stop == "cancelled" { format!(" stop {stop}") } else { String::new() };
    println!("ROUTE {status} converged {converged} iters {iters} tracks {} vias {} failed {} notes {}{stopped} {:.0} s -> {}",
             out.tracks.len(), out.vias.len(), out.failed.len(), out.notes.len(), route_s, args[2]);
}

#[cfg(test)]
mod tests {
    //! The split fixed / routed check and the per-profile memo must give the same verdict as the plain rule
    //! (v1 code, brute force over all items): blocked / free / in conflict, at random sites, for every net.
    use super::*;

    fn net(name: &str, clr: f64, fast: bool) -> Net {
        Net { name: name.into(), width: 0.15, clr, fast, plane: false, power: false, layers: 0b101, via_d: 0.6, via_drill: 0.3, max_vias: None, max_len: None,
              pref: false, min_w: 0.0, min_wl: Vec::new(), in_vias: 0 }
    }

    fn board() -> Board {
        let nets = vec![net("A", 0.15, false), net("B", 0.2, true), net("C", 0.15, true)];
        let (x0, y0, x1, y1) = (0.0, 0.0, 10.0, 10.0);
        let mut bd = Board { layer_names: vec!["F.Cu".into(), "In1.Cu".into(), "B.Cu".into()], routable: vec![0, 2], nets, shapes: Vec::new(),
                             idx: Index::new(x0 - 1.0, y0 - 1.0, x1 + 1.0, y1 + 1.0, 3), sidx: Index::new(x0 - 1.0, y0 - 1.0, x1 + 1.0, y1 + 1.0, 3),
                             maxc: 0.2, edge: (x0, y0, x1, y1), edge_clr: 0.3, gnd: -1, plane_clr: 0.25, eps: EPS, hole_clr: 0.28,
                             spoke_notes: Vec::new(), attach: Vec::new(), spoke_sites: std::collections::HashSet::new(), adj: 0, pad_need: Vec::new(), gnd_fixed: Vec::new(), pours: Vec::new(), circ: std::collections::HashMap::new(), vip: Vec::new(), tvia: Vec::new(), web: 0.0, web_hard: false, via_len: DEF_VIA_LEN, keep: Vec::new(), esc: Vec::new(), edges: Vec::new(), fvia: Vec::new(), iso: None, niv: Vec::new(), ppoly: Vec::new(), twin: Vec::new(), gnds: Vec::new(), pidx: Vec::new(), prad: Vec::new(), noret: Vec::new(), rgn: Vec::new(), rfill: Default::default() };
        let sh = |net: i32, geo: Geo, clr: f64, layers: u8, drill: f64, kind: Kind, owner: i32| Shape { net, geo, clr, layers, drill, kind, owner, alive: true, grp: 0 };
        bd.add(sh(0, Geo::Rect(2.0, 2.0, 2.6, 2.4), 0.15, 1, 0.0, Kind::Pad, -1));
        bd.add(sh(0, Geo::Rect(2.0, 2.9, 2.6, 3.3), 0.15, 1, 0.0, Kind::Pad, -1));
        bd.add(sh(1, Geo::Rect(3.0, 2.0, 3.6, 2.4), 0.2, 1, 0.0, Kind::Pad, -1));
        bd.add(sh(2, Geo::Rect(5.0, 5.0, 6.6, 6.6), 0.15, 0b111, 0.9, Kind::Pad, -1));
        bd.add(sh(-1, Geo::Circ(7.5, 3.0, 0.6), 0.28, 0b111, 1.2, Kind::Pad, -1));
        bd.add(sh(1, Geo::Circ(4.0, 7.0, 0.3), 0.2, 0b111, 0.3, Kind::Via, -1));
        bd.add(sh(0, Geo::Seg(1.0, 8.0, 6.0, 8.5, 0.1), 0.15, 0b100, 0.0, Kind::Track, -1));
        bd.add(sh(2, Geo::Seg(1.0, 5.0, 4.0, 4.0, 0.075), 0.15, 0b001, 0.0, Kind::Track, 2));
        bd.add(sh(0, Geo::Circ(6.0, 2.5, 0.3), 0.15, 0b111, 0.3, Kind::Via, 0));
        bd.add(sh(1, Geo::Seg(6.5, 7.0, 8.5, 9.0, 0.1), 0.2, 0b100, 0.0, Kind::Track, 1));
        // a reserved spoke strip of net A (zone clearance 0.25): fixed copper of A for the memo and the rule
        bd.add(sh(0, Geo::Rect(1.3, 2.1, 2.0, 2.3), 0.25, 1, 0.0, Kind::Spoke, -1));
        bd.maxc = bd.shapes.iter().map(|s| s.clr).fold(bd.maxc, f64::max); // as load()
        bd
    }

    /// v1 track rule, brute force: -1 fixed hit / edge, else number of routed hits (> 0 counts only as "conflict").
    fn ref_track(bd: &Board, net: usize, l: usize, x: f64, y: f64, hw: f64, pc: f64) -> i32 {
        if !bd.inside(x, y, hw) {
            return -1;
        }
        let (clr, fast) = (bd.nets[net].clr, bd.nets[net].fast);
        let mut k = 0;
        for s in bd.shapes.iter().filter(|s| s.alive && s.layers & (1 << l) != 0 && s.net != net as i32) {
            let mut need = hw + clr.max(s.clr);
            let mut hit = false;
            if s.drill > 0.0 {
                if fast {
                    need = need.max(hw + pc);
                }
                let (cx, cy) = match s.geo { Geo::Circ(cx, cy, _) => (cx, cy), Geo::Rect(a, b, c, d) => ((a + c) / 2.0, (b + d) / 2.0), Geo::Seg(..) => (f64::MAX, f64::MAX) };
                hit = ((x - cx).powi(2) + (y - cy).powi(2)).sqrt() - s.drill / 2.0 < hw + bd.hole_clr + EPS;
            }
            if hit || s.geo.dist(x, y) < need + EPS {
                if s.owner < 0 {
                    return -1;
                }
                k += 1;
            }
        }
        k
    }

    /// v1 via rule, brute force.
    fn ref_via(bd: &Board, net: usize, x: f64, y: f64, d: f64, drill: f64, hth: f64) -> i32 {
        let vr = d / 2.0;
        if !bd.inside(x, y, vr) {
            return -1;
        }
        let clr = bd.nets[net].clr;
        let mut k = 0;
        for s in bd.shapes.iter().filter(|s| s.alive) {
            let mut hit = false;
            if s.drill > 0.0 {
                let (cx, cy) = match s.geo { Geo::Circ(cx, cy, _) => (cx, cy), Geo::Rect(a, b, c, d) => ((a + c) / 2.0, (b + d) / 2.0), Geo::Seg(..) => (x + 99.0, y) };
                hit = ((x - cx).powi(2) + (y - cy).powi(2)).sqrt() - s.drill / 2.0 - drill / 2.0 < hth;
            }
            if !hit {
                if s.net == net as i32 {
                    if s.kind == Kind::Pad && s.drill == 0.0 && s.geo.dist(x, y) < vr + 0.05 {
                        return -1;
                    }
                    continue;
                }
                // v1 clearance, plus (since v2) the rules a track checks from its side: fast-track plane clearance to
                // a drilled item and hole to copper
                let dd = s.geo.dist(x, y);
                let fast_track = s.kind == Kind::Track && s.net >= 0 && bd.nets[s.net as usize].fast;
                hit = dd < vr + clr.max(s.clr) + EPS || (fast_track && dd < vr + bd.plane_clr + EPS) || dd < drill / 2.0 + bd.hole_clr + EPS;
            }
            if hit {
                if s.owner < 0 {
                    return -1;
                }
                k += 1;
            }
        }
        k
    }

    #[test]
    fn split_and_memo_match_v1_rule() {
        let bd = board();
        let mut seed: u64 = 12345;
        let mut rnd = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        let (mut n_block, mut n_soft, mut n_free) = (0, 0, 0);
        for _ in 0..20000 {
            let (x, y) = (rnd() * 10.0, rnd() * 10.0);
            for net in 0..3 {
                for &l in &[0usize, 2] {
                    for &hw in &[0.075, 0.25] {
                        let r = ref_track(&bd, net, l, x, y, hw, 0.25);
                        let n = bd.track_cost(net, l, x, y, hw, 0.25, None);
                        assert_eq!(r.signum(), n.signum(), "track net {net} l {l} ({x}, {y}) hw {hw}");
                        let code = bd.track_fixed_code(l, x, y, hw, bd.nets[net].clr, bd.pflags(net), 0.25);
                        assert_eq!(r < 0, blocks(code, net as i32), "track memo net {net} ({x}, {y})");
                        match r.signum() {
                            -1 => n_block += 1,
                            0 => n_free += 1,
                            _ => n_soft += 1,
                        }
                    }
                }
                let rv = ref_via(&bd, net, x, y, 0.6, 0.3, 0.45);
                let nv = bd.via_cost(net, x, y, 0.6, 0.3, 0.45, None);
                assert_eq!(rv.signum(), nv.signum(), "via net {net} ({x}, {y})");
            }
        }
        assert!(n_block > 1000 && n_soft > 100 && n_free > 1000, "coverage {n_block} {n_soft} {n_free}");
    }

    #[test]
    fn audit_sees_a_crossing_once_per_pair() {
        let mut bd = board();
        // a routed track of A crossing the routed track of C on F.Cu
        bd.add(Shape { net: 0, geo: Geo::Seg(2.0, 3.8, 2.0, 5.5, 0.075), clr: 0.15, layers: 1, drill: 0.0, kind: Kind::Track, owner: 0, alive: true, grp: 0 });
        let o = Opts { pitch: 0.05, passes: 1, plane_clr: 0.25, hth: 0.45, return_r: 2.0, ret_d: 0.45, ret_drill: 0.2, pres_mult: 1.5, pres_max: 1000.0, hist: 0.3, max_time: 0.0, door_hist: 2.0, via_cost: DEF_VIA_COST, ret_cost: DEF_RET_COST, web_cost: DEF_WEB_COST, no_recover: false, stall_passes: 0 };
        let (nx, ny, nr) = (201, 201, 2);
        let tot = nx * ny * nr;
        let gr = Grid { x0: 0.0, y0: 0.0, p: 0.05, nx, ny, nr, cache: vec![0; tot], vcache: vec![0; nx * ny], dcache: vec![0; tot], hist: vec![0.0; tot], vhist: vec![0.0; nx * ny], pres: 0.5,
                        g: vec![0.0; tot], from: vec![0; tot], seen: vec![0; tot], closed: vec![0; tot], tgt: vec![0; tot], sgen: 0, tgen: 0, glen: Vec::new(), lhist: Vec::new(), jit: Default::default() };
        let nn = bd.nets.len();
        let mut ctx = Ctx { bd: &mut bd, gr, o: &o, strict: false, dead: vec![(Vec::new(), String::new()); nn], memo: Vec::new(), memo_w: vec![0.15], rcache: vec![0; nx * ny], ban: Vec::new(), neck: Vec::new(), len_cap: None, len_boxes: Vec::new(), len_mode: false, ret_soft: true, lfloor: Vec::new(), leaf_necks: false, stubs: std::collections::HashMap::new(), stub_cost: Default::default(), recover: false, fan_keep: false };
        let a = ctx.audit(0.3);
        assert_eq!(a.pairs, 1, "one crossing = one pair");
        assert_eq!(a.hard, 0);
        assert!(a.partners[0].contains(&2) && a.partners[2].contains(&0));
        assert_eq!(a.per_net[1], 0);
        assert!(ctx.gr.hist.iter().any(|&h| h > 0.0));
    }

    /// A via or track site that the search sees as free must not create a conflict that the audit sees from the
    /// other item's side (v1 let a via sit 0.15 mm from a fast track that needs 0.25 mm to a foreign drilled item).
    #[test]
    fn free_sites_stay_legal_from_both_sides() {
        let mut bd = board();
        let o = Opts { pitch: 0.05, passes: 1, plane_clr: 0.25, hth: 0.45, return_r: 2.0, ret_d: 0.45, ret_drill: 0.2, pres_mult: 1.5, pres_max: 1000.0, hist: 0.3, max_time: 0.0, door_hist: 2.0, via_cost: DEF_VIA_COST, ret_cost: DEF_RET_COST, web_cost: DEF_WEB_COST, no_recover: false, stall_passes: 0 };
        let (nx, ny, nr) = (201, 201, 2);
        let tot = nx * ny * nr;
        let gr = Grid { x0: 0.0, y0: 0.0, p: 0.05, nx, ny, nr, cache: vec![0; tot], vcache: vec![0; nx * ny], dcache: vec![0; tot], hist: vec![0.0; tot], vhist: vec![0.0; nx * ny], pres: 0.5,
                        g: vec![0.0; tot], from: vec![0; tot], seen: vec![0; tot], closed: vec![0; tot], tgt: vec![0; tot], sgen: 0, tgen: 0, glen: Vec::new(), lhist: Vec::new(), jit: Default::default() };
        let nn = bd.nets.len();
        let mut ctx = Ctx { bd: &mut bd, gr, o: &o, strict: false, dead: vec![(Vec::new(), String::new()); nn], memo: Vec::new(), memo_w: vec![0.15], rcache: vec![0; nx * ny], ban: Vec::new(), neck: Vec::new(), len_cap: None, len_boxes: Vec::new(), len_mode: false, ret_soft: true, lfloor: Vec::new(), leaf_necks: false, stubs: std::collections::HashMap::new(), stub_cost: Default::default(), recover: false, fan_keep: false };
        let base = ctx.audit(0.0).pairs;
        let mut seed: u64 = 777;
        let mut rnd = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        let (mut vias, mut tracks) = (0, 0);
        for t in 0..4000 {
            let (x, y) = (rnd() * 10.0, rnd() * 10.0);
            let net = t % 3;
            let id = ctx.bd.shapes.len();
            if t % 2 == 0 {
                let (d, dr) = if t % 4 == 0 { (0.6, 0.3) } else { (0.45, 0.2) };
                if ctx.bd.via_cost(net, x, y, d, dr, 0.45, None) != 0 {
                    continue;
                }
                ctx.bd.add(Shape { net: net as i32, geo: Geo::Circ(x, y, d / 2.0), clr: ctx.bd.nets[net].clr, layers: 0b111, drill: dr, kind: Kind::Via, owner: net as i32, alive: true, grp: 0 });
                vias += 1;
            } else {
                let l = if t % 4 == 1 { 0 } else { 2 };
                if ctx.bd.track_cost(net, l, x, y, 0.075, 0.25, None) != 0 {
                    continue;
                }
                ctx.bd.add(Shape { net: net as i32, geo: Geo::Seg(x, y, x, y, 0.075), clr: ctx.bd.nets[net].clr, layers: 1 << l, drill: 0.0, kind: Kind::Track, owner: net as i32, alive: true, grp: 0 });
                tracks += 1;
            }
            let a = ctx.audit(0.0);
            assert_eq!(a.pairs, base, "site ({x}, {y}) net {net} kind {}", t % 4);
            assert_eq!(a.hard, 0);
            ctx.bd.shapes[id].alive = false;
            ctx.bd.compact();
        }
        assert!(vias > 200 && tracks > 200, "coverage {vias} {tracks}");
    }
}

#[cfg(test)]
mod tests_model;

#[cfg(test)]
mod tests_v4;

#[cfg(test)]
mod tests_pour;
#[cfg(test)]
mod tests_v6;
#[cfg(test)]
mod tests_v7;
#[cfg(test)]
mod tests_v8;
#[cfg(test)]
mod tests_v9;
#[cfg(test)]
mod tests_reuse;
#[cfg(test)]
mod tests_congestion;
#[cfg(test)]
mod tests_iso;
#[cfg(test)]
mod tests_reffill;
#[cfg(test)]
mod tests_layers;

#[cfg(test)]
mod tests_seed;
