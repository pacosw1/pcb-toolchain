//! Finishes the last open connections of a routed board with the grid A* (2026-10-16, H7-CORE). For each open connection of the
//! DRC report, one at a time, in report order: A* over (layer, cell) with 8 moves, a turn cost and a via cost, then the path as
//! merged straight segments and vias, locked. Nothing is moved or removed. The grid is half a cell conservative: the DRC result is
//! the evidence. Fastroute stays the router; this closes what it leaves.
use super::astar::{DEFAULT_WEIGHT, PathItem, Search, astar, counts, to_items, track_length};
use super::board::{GridBoard, NetGrids};
use super::item::{Item, ItemKind, Point, Shape};
use super::mask::{Mask, Window};
use super::opens::{End, Open, item_for, pads_by_uuid, run_drc, signal_opens};
use crate::kicad::board::Board;
use crate::kicad::edit::{NewTrack, NewVia};
use crate::kicad::geom::{Pt, from_mm, to_mm};
use crate::kicad::pad::PadKind;
use crate::kicad::rules::DesignRules;
use crate::kicad::save::WorkDir;
use crate::kicad::session::Session;
use crate::model::text::round_to;
use std::collections::{BTreeMap, BTreeSet, HashSet};

const DEFAULT_VIA_MM: f64 = 0.6;
/// Vias of a net this close are one via: it is reused, not doubled.
const SAME_VIA_NM: i64 = 1000;
const CONNECT_WIDTH_MM: f64 = 0.15;
/// A via keeps this far from an SMD pad of its own net, beyond its radius (viapads gate).
const PAD_VIA_MARGIN_MM: f64 = 0.05;

#[derive(Debug, Clone, PartialEq)]
pub struct Options {
    pub nets: BTreeSet<String>,
    pub layers: Vec<String>,
    pub grid: f64,
    pub widths: BTreeMap<String, f64>,
    pub via_cost: f64,
    pub turn_cost: f64,
    pub margin: f64,
    pub layer_cost: BTreeMap<String, f64>,
    pub via_drill: f64,
    pub in2_clear_of_b: bool,
    pub via_halo: f64,
    pub skip: Vec<String>,
    pub dry_run: bool,
    /// REF.PAD:REF.PAD pairs routed in place of the DRC list.
    pub connect: Vec<String>,
    /// X0,Y0,X1,Y1 no-track boxes on every job layer, for this call only.
    pub block: Vec<[f64; 4]>,
    pub escape: String,
    pub escape_ring: f64,
    pub escape_skip: Vec<String>,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            nets: BTreeSet::new(),
            layers: vec!["F.Cu".to_string(), "B.Cu".to_string()],
            grid: 0.05,
            widths: BTreeMap::new(),
            via_cost: 4.0,
            turn_cost: 0.3,
            margin: 10.0,
            layer_cost: BTreeMap::new(),
            via_drill: 0.3,
            in2_clear_of_b: false,
            via_halo: 0.0,
            skip: vec!["GND".to_string(), "VDD_3V3".to_string()],
            dry_run: false,
            connect: Vec::new(),
            block: Vec::new(),
            escape: String::new(),
            escape_ring: 3.0,
            escape_skip: Vec::new(),
        }
    }
}

impl Options {
    fn layer_costs(&self) -> Vec<f64> {
        self.layers.iter().map(|l| self.layer_cost.get(l).copied().unwrap_or(1.0)).collect()
    }

    fn search<'a>(&self, seeds: &'a [Mask], target: &'a [Mask], costs: &'a [f64]) -> Search<'a> {
        Search { seeds, target, via_cost: self.via_cost / self.grid, turn_cost: self.turn_cost / self.grid, layer_cost: costs, goal: None, weight: DEFAULT_WEIGHT }
    }
}

/// The grid for routing a net at `width`: one cell more on every clearance, `block` boxes as no-track areas.
pub fn routing_grid<'a>(board: &'a Board, rules: &DesignRules, layers: &[String], grid: f64, width: Option<f64>, block: &[[f64; 4]]) -> Result<GridBoard<'a>, String> {
    let mut bd = GridBoard::new(board, rules, layers, grid)?;
    if let Some(w) = width {
        bd.min_width = w;
    }
    for [x0, y0, x1, y1] in block {
        let polygon = vec![(*x0, *y0), (*x1, *y0), (*x1, *y1), (*x0, *y1)];
        let all = bd.all_layers();
        bd.items.push(Item::polygons("", "keepout:block", all, 0.0, ItemKind::KeepTrack, vec![polygon]));
    }
    bd.for_routing();
    Ok(bd)
}

/// B.Cu tracks of all nets as In2.Cu obstacles: an In2 track then never lies under one (the In2 slot would be under it: planes gate).
fn in2_clear_of_b(bd: &mut GridBoard) {
    let bit = |name: &str| bd.layers.iter().position(|l| l == name).map(|i| 1u32 << i);
    let (Some(in2), Some(back)) = (bit("In2.Cu"), bit("B.Cu")) else { return };
    let extra: Vec<Item> = bd.items.iter().filter(|it| it.owner == "track" && it.layers & back != 0).filter_map(|it| match it.shape {
        Shape::Segment(seg, half_width) => Some(Item::segment("", "keepout:b-over-in2", in2, 0.2, seg, half_width)),
        Shape::Polygons(_) => None,
    }).collect();
    bd.items.extend(extra);
    bd.clear_caches();
}

/// Clears the via sites over the net's own SMD pads (other nets' pads are obstacles already): a via in an SMD pad fails the viapads
/// gate.
pub fn no_via_in_pads(bd: &mut GridBoard, net: &str, via_ok: &mut Mask) {
    let r = bd.net_via.get(net).copied().unwrap_or(DEFAULT_VIA_MM) / 2.0 + PAD_VIA_MARGIN_MM;
    let pads: Vec<usize> = bd.pads_of(net).iter().filter(|at| bd.pad(at).1.kind == PadKind::Smd).map(|at| at.item).collect();
    for k in pads {
        if let Some(mask) = bd.item_mask(k, r) {
            via_ok.clear_where(&mask);
        }
    }
}

/// The net's rasters with room for a via of `via_halo` when set; the via itself keeps its class size.
pub fn route_grids(bd: &mut GridBoard, net: &str, window: Window, via_halo: f64) -> NetGrids {
    let real = bd.net_via.get(net).copied().unwrap_or(DEFAULT_VIA_MM);
    if via_halo != 0.0 {
        bd.net_via.insert(net.to_string(), via_halo);
    }
    let mut grids = bd.net_grids(net, window, false);
    bd.net_via.insert(net.to_string(), real);
    no_via_in_pads(bd, net, &mut grids.via_ok);
    grids
}

/// Seed cells of an end item plus all same-net copper joined to it (touching cells on a shared layer; a via joins its layers).
/// H7-CORE v2: a seed of the end item alone made the router drop a second via 0.1-0.3 mm from a stub's own via.
fn island_seed(bd: &mut GridBoard, item: usize, window: Window) -> Vec<Mask> {
    let mut seed = bd.item_seed(item, window);
    let net = bd.items[item].net.clone();
    let others: Vec<usize> = (0..bd.items.len()).filter(|k| *k != item && bd.items[*k].net == net && matches!(bd.items[*k].kind, ItemKind::Copper | ItemKind::Pad)).collect();
    let mut left: Vec<Vec<Mask>> = others.iter().map(|k| bd.item_seed(*k, window)).collect();
    let mut grown = true;
    while grown {
        grown = false;
        let dilated: Vec<Mask> = seed.iter().map(Mask::dilated).collect();
        left.retain(|cells| {
            let joined = cells.iter().zip(&dilated).any(|(c, d)| c.and(d).any());
            if joined {
                grown = true;
                seed.iter_mut().zip(cells).for_each(|(s, c)| *s = s.or(c));
            }
            !joined
        });
    }
    seed
}

fn mm(p: Point) -> Pt {
    Pt::new(from_mm(p.0), from_mm(p.1))
}

/// Lays a path, locked. A via already on the net is reused, not doubled.
pub fn write_items(session: &mut Session, net: &str, items: &[PathItem], width: f64, layers: &[String], via_size: f64, via_drill: f64) {
    let mut have: Vec<Pt> = session.board.vias().filter(|v| v.net == net).map(|v| v.at).collect();
    for item in items {
        match *item {
            PathItem::Segment { layer, a, b } => session.add_track(NewTrack { start: mm(a), end: mm(b), width: from_mm(width), layer: layers[layer].clone(), net: net.to_string(), locked: true }),
            PathItem::Via(at) => {
                let at = mm(at);
                if have.iter().any(|h| (at.x - h.x).abs() < SAME_VIA_NM && (at.y - h.y).abs() < SAME_VIA_NM) {
                    continue;
                }
                have.push(at);
                session.add_via(NewVia { at, size: from_mm(via_size), drill: from_mm(via_drill), net: net.to_string(), locked: true });
            }
        }
    }
}

/// A route found on the grid, ready to lay.
struct Found {
    items: Vec<PathItem>,
    via_size: f64,
}

fn first_chars(text: &str, n: usize) -> String {
    text.chars().take(n).collect()
}

/// The search windows of a connection: small first.
fn margins(margin: f64) -> Vec<f64> {
    let small: Vec<f64> = [4.0, 12.0, margin].into_iter().filter(|m| *m <= margin).collect();
    if small.is_empty() { vec![margin] } else { small }
}

fn route_open(session: &Session, o: &Options, open: &Open, width: Option<f64>) -> Result<Result<(Found, f64), String>, String> {
    let mut bd = routing_grid(&session.board, &session.rules, &o.layers, o.grid, None, &o.block)?;
    let w = width.unwrap_or(bd.min_width);
    bd.min_width = w;
    bd.clear_caches();
    if o.in2_clear_of_b {
        in2_clear_of_b(&mut bd);
    }
    let by_uuid = pads_by_uuid(&bd);
    let (Some(a), Some(b)) = (item_for(&bd, &open.a, &by_uuid), item_for(&bd, &open.b, &by_uuid)) else {
        return Ok(Err(format!("SKIP {}: an end item was not found", open.net)));
    };
    let (xs, ys) = ([open.a.x(), open.b.x()], [open.a.y(), open.b.y()]);
    let costs = o.layer_costs();
    for margin in margins(o.margin) {
        let window = bd.window(xs[0].min(xs[1]) - margin, ys[0].min(ys[1]) - margin, xs[0].max(xs[1]) + margin, ys[0].max(ys[1]) + margin);
        let grids = route_grids(&mut bd, &open.net, window, o.via_halo);
        let (seed_a, seed_b) = (island_seed(&mut bd, a, window), island_seed(&mut bd, b, window));
        if let Some(path) = astar(&grids, &o.search(&seed_a, &seed_b, &costs)) {
            let via_size = bd.net_via.get(&open.net).copied().unwrap_or(DEFAULT_VIA_MM);
            return Ok(Ok((Found { items: to_items(&bd, &window, &path), via_size }, w)));
        }
    }
    let end = |e: &End| first_chars(&e.description, 40);
    Ok(Err(format!("NOPATH {}: {} -> {}", open.net, end(&open.a), end(&open.b))))
}

fn routed_line(net: &str, spec: &str, items: &[PathItem], width: f64) -> String {
    let (tracks, vias) = counts(items);
    format!("ROUTED {net}: {spec}{tracks} segments, {vias} vias, {:.2} mm, width {width:.2}", track_length(items))
}

/// Routes the connections of `opens`, in order, and says how many it closed.
pub fn route_opens(session: &mut Session, o: &Options, opens: &[Open], log: &mut dyn FnMut(&str)) -> Result<usize, String> {
    let mut routed = 0;
    for open in opens {
        let width = o.widths.get(&open.net).copied();
        match route_open(session, o, open, width)? {
            Err(line) => log(&line),
            Ok((found, w)) => {
                log(&routed_line(&open.net, "", &found.items, w));
                routed += 1;
                if !o.dry_run {
                    write_items(session, &open.net, &found.items, w, &o.layers, found.via_size, o.via_drill);
                }
            }
        }
    }
    Ok(routed)
}

/// The connections of a report this run routes.
pub fn selected_opens(report: &serde_json::Value, o: &Options) -> Vec<Open> {
    let skip: Vec<&str> = o.skip.iter().map(String::as_str).collect();
    signal_opens(report, &skip).into_iter().filter(|open| o.nets.is_empty() || o.nets.contains(&open.net)).collect()
}

/// A named pad: its item on the grid, when it stands on `net`.
fn pad_item(bd: &GridBoard, net: &str, reference: &str, number: &str) -> Option<usize> {
    bd.pads_of(net).iter().find(|at| {
        let (f, p) = bd.pad(at);
        f.reference == reference && p.number == number
    }).map(|at| at.item)
}

fn split_pad(spec: &str) -> Result<(&str, &str), String> {
    spec.split_once('.').ok_or_else(|| format!("{spec}: not REF.PAD"))
}

/// One pad pair: seeds are the two pads, not the copper joined to them (a direct track, for power chains whose order matters).
fn connect_one(session: &mut Session, o: &Options, spec: &str, log: &mut dyn FnMut(&str)) -> Result<bool, String> {
    let (first, second) = spec.split_once(':').ok_or_else(|| format!("{spec}: not REF.PAD:REF.PAD"))?;
    let ((ra, na), (rb, nb)) = (split_pad(first)?, split_pad(second)?);
    let footprint = session.board.footprints.iter().find(|f| f.reference == ra).ok_or_else(|| format!("{ra}: not on the board"))?;
    let net = footprint.pads.iter().find(|p| p.number == na).ok_or_else(|| format!("{first}: not on the board"))?.net.clone();
    let w = o.widths.get(&net).copied().unwrap_or(CONNECT_WIDTH_MM);
    let found = {
        let mut bd = routing_grid(&session.board, &session.rules, &o.layers, o.grid, Some(w), &o.block)?;
        if o.in2_clear_of_b {
            in2_clear_of_b(&mut bd);
        }
        let (Some(a), Some(b)) = (pad_item(&bd, &net, ra, na), pad_item(&bd, &net, rb, nb)) else {
            log(&format!("SKIP {spec}: pad not on net {net}"));
            return Ok(false);
        };
        let (ba, bb) = (bd.items[a].bbox, bd.items[b].bbox);
        let (xs, ys) = ([ba[0], ba[2], bb[0], bb[2]], [ba[1], ba[3], bb[1], bb[3]]);
        let low = |v: [f64; 4]| v.into_iter().fold(f64::INFINITY, f64::min);
        let high = |v: [f64; 4]| v.into_iter().fold(f64::NEG_INFINITY, f64::max);
        let window = bd.window(low(xs) - o.margin, low(ys) - o.margin, high(xs) + o.margin, high(ys) + o.margin);
        let grids = route_grids(&mut bd, &net, window, o.via_halo);
        let (seed_a, seed_b, costs) = (bd.item_seed(a, window), bd.item_seed(b, window), o.layer_costs());
        astar(&grids, &o.search(&seed_a, &seed_b, &costs)).map(|path| Found { items: to_items(&bd, &window, &path), via_size: bd.net_via.get(&net).copied().unwrap_or(DEFAULT_VIA_MM) })
    };
    let Some(found) = found else {
        log(&format!("NOPATH {net}: {spec}"));
        return Ok(false);
    };
    log(&routed_line(&net, &format!("{spec} "), &found.items, w));
    if !o.dry_run {
        write_items(session, &net, &found.items, w, &o.layers, found.via_size, o.via_drill);
    }
    Ok(true)
}

fn connect(session: &mut Session, o: &Options, log: &mut dyn FnMut(&str)) -> Result<(), String> {
    let mut done = 0;
    for spec in &o.connect {
        done += usize::from(connect_one(session, o, spec, log)?);
    }
    log(&format!("FINISH routed {done} of {}", o.connect.len()));
    Ok(())
}

/// A pad to escape, in the order of its angle round the part.
struct EscapePad {
    angle: f64,
    number: String,
    net: String,
    at: Point,
    goal: Point,
}

/// Net, x, y of every track end and via, to 0.01 mm.
fn touched_points(board: &Board) -> HashSet<(String, i64, i64)> {
    let key = |net: &str, p: Pt| (net.to_string(), (round_to(to_mm(p.x), 2) * 100.0).round() as i64, (round_to(to_mm(p.y), 2) * 100.0).round() as i64);
    let tracks = board.tracks().flat_map(|t| [key(&t.net, t.start), key(&t.net, t.end)]);
    let vias = board.vias().map(|v| key(&v.net, v.at));
    tracks.chain(vias).collect()
}

/// The ring box of the part and the pads that need an escape: a signal pad with no copper yet and a pad of its net elsewhere.
fn escape_pads(board: &Board, o: &Options) -> Result<([f64; 4], Vec<EscapePad>), String> {
    let footprint = board.footprints.iter().find(|f| f.reference == o.escape).ok_or_else(|| format!("{}: not on the board", o.escape))?;
    let courtyard = footprint.courtyard_front.iter().filter_map(|p| p.bbox()).reduce(crate::kicad::geom::Rect::merged).ok_or_else(|| format!("{}: no front courtyard", o.escape))?;
    let ring = o.escape_ring;
    let (rx0, ry0, rx1, ry1) = (to_mm(courtyard.left) - ring, to_mm(courtyard.top) - ring, to_mm(courtyard.right) + ring, to_mm(courtyard.bottom) + ring);
    let (cx, cy) = ((rx0 + rx1) / 2.0, (ry0 + ry1) / 2.0);
    let touched = touched_points(board);
    let skip: BTreeSet<&str> = o.skip.iter().chain(&o.escape_skip).map(String::as_str).collect();
    let mut pads = Vec::new();
    for pad in &footprint.pads {
        let net = pad.net.as_str();
        if net.is_empty() || skip.contains(net) || net.starts_with("unconnected") {
            continue;
        }
        let (x, y) = (to_mm(pad.position.x), to_mm(pad.position.y));
        let b = pad.bbox;
        let has_copper = touched.iter().any(|(n, tx, ty)| {
            let (tx, ty) = (*tx as f64 / 100.0, *ty as f64 / 100.0);
            n == net && to_mm(b.left) - 0.01 <= tx && tx <= to_mm(b.right) + 0.01 && to_mm(b.top) - 0.01 <= ty && ty <= to_mm(b.bottom) + 0.01
        });
        if has_copper {
            continue; // A hand route.
        }
        let others = board.pads().filter(|(f, p)| p.net == net && f.reference != o.escape).map(|(_, p)| (to_mm(p.position.x), to_mm(p.position.y)));
        let nearest = others.fold(None, |best: Option<(f64, Point)>, q| {
            let d = (q.0 - x).hypot(q.1 - y);
            if best.is_none_or(|(old, _)| d < old) { Some((d, q)) } else { best }
        });
        if let Some((_, goal)) = nearest {
            pads.push(EscapePad { angle: (y - cy).atan2(x - cx), number: pad.number.clone(), net: net.to_string(), at: (x, y), goal });
        }
    }
    pads.sort_by(|a, b| a.angle.total_cmp(&b.angle).then(a.number.cmp(&b.number)).then(a.net.cmp(&b.net)).then(a.at.0.total_cmp(&b.at.0)).then(a.at.1.total_cmp(&b.at.1)));
    Ok(([rx0, ry0, rx1, ry1], pads))
}

/// The first free cells outside the ring.
fn outside_ring(bd: &GridBoard, window: Window, ring: [f64; 4], free: &[Mask]) -> Vec<Mask> {
    let [rx0, ry0, rx1, ry1] = ring;
    let mut out = Mask::filled(window, false);
    for j in 0..out.ny() {
        for i in 0..out.nx() {
            let (x, y) = bd.centre(&window, j, i);
            out.set(j, i, x < rx0 || x > rx1 || y < ry0 || y > ry1);
        }
    }
    free.iter().map(|f| out.and(f)).collect()
}

fn escape_one(session: &mut Session, o: &Options, ring: [f64; 4], pad: &EscapePad, log: &mut dyn FnMut(&str)) -> Result<bool, String> {
    let [rx0, ry0, rx1, ry1] = ring;
    let (found, width) = {
        let mut bd = routing_grid(&session.board, &session.rules, &o.layers, o.grid, None, &[])?;
        let window = bd.window(rx0 - 3.0, ry0 - 3.0, rx1 + 3.0, ry1 + 3.0);
        let grids = bd.net_grids(&pad.net, window, false);
        let Some(own) = pad_item(&bd, &pad.net, &o.escape, &pad.number) else { return Ok(false) };
        let seeds = bd.item_seed(own, window);
        let target = outside_ring(&bd, window, ring, &grids.free);
        let goal = ((pad.goal.1 - bd.y0) / bd.g - window.j0 as f64, (pad.goal.0 - bd.x0) / bd.g - window.i0 as f64);
        let costs = o.layer_costs();
        let search = Search { goal: Some(goal), weight: 0.4, ..o.search(&seeds, &target, &costs) };
        let found = astar(&grids, &search).map(|path| Found { items: to_items(&bd, &window, &path), via_size: bd.net_via.get(&pad.net).copied().unwrap_or(DEFAULT_VIA_MM) });
        (found, bd.min_width)
    };
    let Some(found) = found else {
        log(&format!("NOPATH escape {}.{} {}", o.escape, pad.number, pad.net));
        return Ok(false);
    };
    let (tracks, vias) = counts(&found.items);
    log(&format!("ESCAPE {}.{} {}: {tracks} segments, {vias} vias", o.escape, pad.number, pad.net));
    if !o.dry_run {
        write_items(session, &pad.net, &found.items, width, &o.layers, found.via_size, o.via_drill);
    }
    Ok(true)
}

/// Routes every signal pad of the part that has no copper yet from the pad to the first free cell outside the ring (courtyard +
/// ring), biased towards the nearest other pad of its net. The track end stays open for the autorouter (settle the package escape
/// topology first, then autoroute).
fn escapes(session: &mut Session, o: &Options, log: &mut dyn FnMut(&str)) -> Result<(), String> {
    let (ring, pads) = escape_pads(&session.board, o)?;
    let mut done = 0;
    for pad in &pads {
        done += usize::from(escape_one(session, o, ring, pad, log)?);
    }
    log(&format!("FINISH escapes {done} of {}", pads.len()));
    Ok(())
}

/// The whole tool on an open board: --escape, --connect or the DRC list, then one save over the board. A dry run saves nothing.
pub fn run(session: &mut Session, o: &Options, log: &mut dyn FnMut(&str)) -> Result<(), String> {
    if !o.escape.is_empty() {
        escapes(session, o, log)?;
    } else if !o.connect.is_empty() {
        connect(session, o, log)?;
    } else {
        let work = WorkDir::beside(&session.path, "grid-finish")?;
        let report = run_drc(&session.path, &work.0.join("drc.json"))?;
        let opens = selected_opens(&report, o);
        let routed = route_opens(session, o, &opens, log)?;
        log(&format!("FINISH routed {routed} of {}", opens.len()));
    }
    if !o.dry_run && !session.edit.is_empty() {
        session.save_to(&session.path.clone())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grid::tests::{at, board, footprint, layers, pad, rules, track, via};

    #[test]
    fn small_windows_come_first() {
        assert_eq!(margins(10.0), [4.0, 10.0]);
        assert_eq!(margins(30.0), [4.0, 12.0, 30.0]);
        assert_eq!(margins(3.0), [3.0]);
    }

    #[test]
    fn a_route_clears_a_block_box() {
        let b = board(Vec::new(), Vec::new());
        let mut bd = routing_grid(&b, &rules(), &layers(), 0.1, None, &[[8.0, 8.0, 12.0, 12.0]]).unwrap();
        let w = bd.full_window();
        assert!(bd.blocked("A", 0, w, false, false).0.at(100, 100));
    }

    #[test]
    fn no_via_stands_in_an_own_smd_pad() {
        let b = board(vec![footprint("U1", vec![pad("1", "A", 10.0, 10.0, 1.0)])], Vec::new());
        let mut bd = routing_grid(&b, &rules(), &layers(), 0.1, None, &[]).unwrap();
        let w = bd.full_window();
        let grids = route_grids(&mut bd, "A", w, 0.0);
        assert!(!grids.via_ok.at(100, 100) && grids.via_ok.at(50, 50));
    }

    #[test]
    fn a_via_halo_asks_for_more_room_than_the_via() {
        let b = board(Vec::new(), vec![via("B", at(10.0, 10.0))]);
        let mut bd = routing_grid(&b, &rules(), &layers(), 0.1, None, &[]).unwrap();
        let w = bd.full_window();
        let plain = route_grids(&mut bd, "A", w, 0.0).via_ok.count();
        let halo = route_grids(&mut bd, "A", w, 2.0).via_ok.count();
        assert!(halo < plain);
        assert_eq!(bd.net_via["A"], 0.6);
    }

    #[test]
    fn an_island_seed_follows_tracks_and_vias_of_the_net() {
        let b = board(vec![footprint("U1", vec![pad("1", "A", 5.0, 10.0, 1.0)])], vec![track("A", at(5.0, 10.0), at(12.0, 10.0), "F.Cu"), via("A", at(12.0, 10.0)), track("A", at(12.0, 10.0), at(12.0, 15.0), "B.Cu")]);
        let mut bd = GridBoard::new(&b, &rules(), &layers(), 0.1).unwrap();
        let (w, first) = (bd.full_window(), bd.pads_of("A")[0].item);
        let seed = island_seed(&mut bd, first, w);
        assert!(seed[0].at(100, 100) && seed[1].at(140, 120));
    }

    #[test]
    fn in2_keeps_clear_of_back_tracks_of_every_net() {
        let names: Vec<String> = ["F.Cu", "In2.Cu", "B.Cu"].map(str::to_string).to_vec();
        let b = board(Vec::new(), vec![track("B", at(5.0, 10.0), at(15.0, 10.0), "B.Cu")]);
        let mut bd = GridBoard::new(&b, &rules(), &names, 0.1).unwrap();
        in2_clear_of_b(&mut bd);
        let w = bd.full_window();
        assert!(bd.blocked("B", 1, w, false, false).0.at(100, 100));
    }

    #[test]
    fn a_via_on_the_net_is_reused_not_doubled() {
        let b = board(vec![footprint("U1", vec![pad("1", "A", 5.0, 10.0, 1.0)])], vec![via("A", at(10.0, 10.0))]);
        let path = tmp_board("reuse");
        let mut session = Session::of(&path, b, rules(), "").unwrap();
        let items = [PathItem::Via((10.0, 10.0)), PathItem::Via((12.0, 10.0)), PathItem::Segment { layer: 0, a: (10.0, 10.0), b: (12.0, 10.0) }];
        write_items(&mut session, "A", &items, 0.2, &layers(), 0.6, 0.3);
        assert_eq!((session.edit.vias.len(), session.edit.tracks.len()), (1, 1));
        assert!(session.edit.vias[0].locked && session.edit.tracks[0].locked);
        assert_eq!(session.board.vias().count(), 2);
        let _ = std::fs::remove_file(path);
    }

    fn tmp_board(tag: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("grid-finish-test-{tag}-{}.kicad_pcb", std::process::id()));
        std::fs::write(&path, "(kicad_pcb\n)\n").unwrap();
        path
    }
}
