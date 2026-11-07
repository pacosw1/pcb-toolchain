//! A small routed board for the reader and writer tests: a buck converter laid out like PWR-24V-5V, as the document of
//! `iotroute board-json` and as board text, with its project files in a temporary folder.
//!
//! Board 100..160 x 100..140 mm. J1, J2 at the left and right edges, H3..H5 mounting holes, U1 with L1, D3, C4 on /SW, decoupling
//! caps C1 (near U1) and C2 (far), R2 to R7. /AUX runs J1 to J2 through two vias and is kept copper whatever moves.

use iotplace::kicad::doc::{Board, Copper, Footprint, Geometry, Graphic, NmRect, Pad, PadCopper, PadKind, Polygon, Pt, Track, Via, Zone};
use iotplace::problem::{Place, Pose, Problem};
use iotplace::read::options::Options;
use iotplace::read::out::ProblemOut;
use iotplace::read::project::Project;
use iotplace::read::read_problem;
use iotplace::write::{Report, WriteOptions, WriteProblem, write_board};
use iotroute::kicad::board::{Constraints, RuleArea, Text};
use iotroute::kicad::item_text::nm_text;
use iotroute::kicad::pad::PadShape;
use iotroute::kicad::sexpr::{Node, parse};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

pub fn nm(v: f64) -> i64 {
    (v * 1e6).round() as i64
}

pub fn pt(x: f64, y: f64) -> Pt {
    Pt::new(nm(x), nm(y))
}

pub type Box4 = (f64, f64, f64, f64);

fn square(b: Box4) -> Polygon {
    Polygon { outline: vec![pt(b.0, b.1), pt(b.2, b.1), pt(b.2, b.3), pt(b.0, b.3)], holes: Vec::new() }
}

fn nm_box(b: Box4) -> NmRect {
    NmRect { left: nm(b.0), top: nm(b.1), right: nm(b.2), bottom: nm(b.3) }
}

/// A rectangular pad centred at (x, y), in board coordinates.
pub fn pad(number: &str, net: &str, kind: PadKind, (x, y): (f64, f64), (w, h): (f64, f64)) -> Pad {
    let area = (x - w / 2.0, y - h / 2.0, x + w / 2.0, y + h / 2.0);
    let layers: &[&str] = match kind {
        PadKind::ThroughHole => &["F.Cu", "B.Cu"],
        PadKind::NpThroughHole => &[],
        PadKind::Smd | PadKind::EdgeConnector => &["F.Cu"],
    };
    let hole = if matches!(kind, PadKind::Smd | PadKind::EdgeConnector) { Pt::new(0, 0) } else { pt(w * 0.6, h * 0.6) };
    Pad {
        id: format!("pad-{number}-{x}-{y}"),
        number: number.to_string(),
        kind,
        shape: PadShape::Rect,
        net: net.to_string(),
        position: pt(x, y),
        orientation: 0.0,
        size: pt(w, h),
        drill: hole,
        layers: layers.iter().map(|l| l.to_string()).collect(),
        bbox: nm_box(area),
        zone_connection: None,
        thermal_spoke_angle: 90.0,
        spoke_templates: 0,
        copper: if layers.is_empty() { Vec::new() } else { vec![PadCopper::Polygon(square(area).outline)] },
        polygons: layers.iter().map(|l| (l.to_string(), square(area))).collect(),
        solder_mask_expansion: 0,
        clearance_override: None,
    }
}

pub fn footprint(reference: &str, lib_id: &str, (x, y): (f64, f64), courtyard: Box4, pads: Vec<Pad>) -> Footprint {
    Footprint {
        id: format!("fp-{reference}"),
        reference: reference.to_string(),
        lib_id: lib_id.to_string(),
        layer: "F.Cu".to_string(),
        position: pt(x, y),
        pads,
        courtyard_front: vec![square(courtyard)],
        ..Footprint::default()
    }
}

/// A part with two pads, one to each side of its centre.
pub fn two_pads(reference: &str, (x, y): (f64, f64), first: &str, second: &str) -> Footprint {
    let smd = |n: &str, net: &str, at: f64| pad(n, net, PadKind::Smd, (at, y), (1.0, 1.0));
    footprint(reference, "Device:Two", (x, y), (x - 2.0, y - 1.0, x + 2.0, y + 1.0), vec![smd("1", first, x - 1.0), smd("2", second, x + 1.0)])
}

fn hole(reference: &str, at: (f64, f64)) -> Footprint {
    let drilled = pad("1", "", PadKind::NpThroughHole, at, (3.2, 3.2));
    footprint(reference, "MountingHole:MountingHole_3.2mm_M3", at, (at.0 - 3.0, at.1 - 3.0, at.0 + 3.0, at.1 + 3.0), vec![drilled])
}

fn connector(reference: &str, x: f64, pad_x: f64, nets: [&str; 3]) -> Footprint {
    let pin = |n: usize, net: &str| pad(&(n + 1).to_string(), net, PadKind::ThroughHole, (pad_x, 118.0 + 4.0 * n as f64), (1.7, 1.7));
    let pads = nets.iter().enumerate().map(|(n, net)| pin(n, net)).collect();
    footprint(reference, "Connector:Terminal", (x, 121.0), (x - 4.0, 115.0, x + 4.0, 127.0), pads)
}

fn u1() -> Footprint {
    let pin = |n: &str, net: &str, x: f64, y: f64| pad(n, net, PadKind::Smd, (x, y), (1.2, 0.6));
    let pads = vec![
        pin("1", "/VIN", 127.0, 118.0),
        pin("2", "GND", 127.0, 120.0),
        pin("3", "/EN", 127.0, 122.0),
        pin("4", "/FB", 133.0, 122.0),
        pin("5", "/SW", 133.0, 120.0),
        pin("6", "/BST", 133.0, 118.0),
        pin("7", "/VIN", 130.0, 117.0),
    ];
    // The footprint anchor is pin 1, off the unit origin (the courtyard centre): a turn must move it.
    footprint("U1", "Package_SO:SOIC", (127.0, 118.0), (126.0, 116.5, 134.0, 123.5), pads)
}

pub fn track(id: &str, net: &str, layer: &str, a: (f64, f64), b: (f64, f64)) -> Copper {
    Copper::Track(Track { id: id.to_string(), start: pt(a.0, a.1), end: pt(b.0, b.1), mid: None, width: nm(0.25), layer: layer.to_string(), net: net.to_string(), locked: false })
}

pub fn via(id: &str, net: &str, at: (f64, f64)) -> Copper {
    Copper::Via(Via { id: id.to_string(), at: pt(at.0, at.1), size: nm(0.6), drill: nm(0.3), net: net.to_string(), locked: false, layers: vec!["F.Cu".to_string(), "B.Cu".to_string()] })
}

fn routes() -> Vec<Copper> {
    let top = |id: &str, net: &str, a: (f64, f64), b: (f64, f64)| track(id, net, "F.Cu", a, b);
    vec![
        top("vin-a", "/VIN", (105.0, 118.0), (111.0, 118.0)),
        top("vin-b", "/VIN", (111.0, 118.0), (122.0, 118.0)),
        top("vin-c", "/VIN", (122.0, 118.0), (123.0, 118.0)),
        top("vin-d", "/VIN", (123.0, 118.0), (127.0, 118.0)),
        top("vin-e", "/VIN", (111.0, 118.0), (111.0, 114.0)),
        top("vin-f", "/VIN", (122.0, 118.0), (122.0, 122.0)),
        top("sw-a", "/SW", (133.0, 120.0), (136.0, 120.0)),
        top("sw-b", "/SW", (136.0, 120.0), (140.5, 120.0)),
        top("sw-c", "/SW", (136.0, 120.0), (136.0, 126.0)),
        top("sw-d", "/SW", (136.0, 120.0), (136.0, 114.0)),
        top("bst-a", "/BST", (133.0, 118.0), (138.0, 118.0)),
        top("bst-b", "/BST", (138.0, 118.0), (138.0, 114.0)),
        top("fb-a", "/FB", (133.0, 122.0), (133.0, 128.0)),
        top("fb-b", "/FB", (133.0, 128.0), (129.0, 128.0)),
        top("en-a", "/EN", (127.0, 122.0), (124.0, 122.0)),
        top("en-b", "/EN", (124.0, 122.0), (118.0, 122.0)),
        top("en-c", "/EN", (118.0, 122.0), (118.0, 130.0)),
        top("vout-a", "/VOUT", (143.5, 120.0), (150.0, 120.0)),
        top("vout-b", "/VOUT", (150.0, 120.0), (155.0, 118.0)),
        top("vout-c", "/VOUT", (150.0, 120.0), (150.0, 132.0)),
        top("vout-d", "/VOUT", (150.0, 132.0), (127.0, 132.0)),
        top("vout-e", "/VOUT", (127.0, 132.0), (127.0, 128.0)),
        top("gnd-a", "GND", (127.0, 120.0), (124.5, 120.0)),
        via("gnd-v", "GND", (124.5, 120.0)),
        top("aux-a", "/AUX", (105.0, 126.0), (105.0, 130.0)),
        via("aux-v1", "/AUX", (105.0, 130.0)),
        track("aux-b", "/AUX", "B.Cu", (105.0, 130.0), (155.0, 130.0)),
        via("aux-v2", "/AUX", (155.0, 130.0)),
        top("aux-c", "/AUX", (155.0, 130.0), (155.0, 126.0)),
        via("gnd-lone", "GND", (150.0, 110.0)),
    ]
}

/// A copper zone over `area`.
pub fn pour(name: &str, net: &str, layer: &str, area: Box4) -> Zone {
    Zone { id: format!("zone-{name}"), name: name.to_string(), net: net.to_string(), layers: vec![layer.to_string()], outline: vec![square(area)], filled: Vec::new(), rule_area: None, fill: None }
}

/// A rule area over `area`: what it does not allow is in `rule`.
pub fn rule_area(name: &str, layers: &[&str], area: Box4, rule: RuleArea) -> Zone {
    let layers = layers.iter().map(|l| l.to_string()).collect();
    Zone { id: format!("zone-{name}"), name: name.to_string(), net: String::new(), layers, outline: vec![square(area)], filled: Vec::new(), rule_area: Some(rule), fill: None }
}

pub const ANY_RULE: RuleArea = RuleArea { tracks: false, vias: false, pour: false, pads: false, footprints: false };

/// A closed rectangle on a layer.
pub fn rect_shape(id: &str, layer: &str, b: Box4) -> Graphic {
    Graphic { id: id.to_string(), geometry: Geometry::Rect { top_left: pt(b.0, b.1), bottom_right: pt(b.2, b.3) }, layer: layer.to_string(), width: nm(0.05), filled: false }
}

pub fn label(id: &str, text: &str, at: (f64, f64)) -> Text {
    Text { id: id.to_string(), text: text.to_string(), layer: "User.1".to_string(), position: pt(at.0, at.1) }
}

pub const OUTLINE: Box4 = (100.0, 100.0, 160.0, 140.0);

pub fn buck() -> Board {
    let footprints = vec![
        u1(),
        footprint("L1", "Inductor:Power", (142.0, 120.0), (139.5, 118.5, 144.5, 121.5), vec![pad("1", "/SW", PadKind::Smd, (140.5, 120.0), (1.0, 2.0)), pad("2", "/VOUT", PadKind::Smd, (143.5, 120.0), (1.0, 2.0))]),
        two_pads("D3", (137.0, 126.0), "/SW", "GND"),
        two_pads("C4", (137.0, 114.0), "/SW", "/BST"),
        two_pads("C1", (122.0, 118.0), "GND", "/VIN"),
        two_pads("C2", (112.0, 114.0), "/VIN", "GND"),
        two_pads("R2", (128.0, 128.0), "/VOUT", "/FB"),
        two_pads("R3", (123.0, 122.0), "/VIN", "/EN"),
        two_pads("R4", (130.0, 114.5), "GND", "/TEST"),
        two_pads("R7", (119.0, 130.0), "/EN", "GND"),
        hole("H3", (104.0, 104.0)),
        hole("H4", (156.0, 104.0)),
        hole("H5", (156.0, 136.0)),
        connector("J1", 103.0, 105.0, ["/VIN", "GND", "/AUX"]),
        connector("J2", 157.0, 155.0, ["/VOUT", "GND", "/AUX"]),
    ];
    let mut nets: BTreeMap<String, String> = ["/VIN", "/SW", "/BST", "/FB", "/EN", "/TEST", "/AUX", "GND"].iter().map(|n| (n.to_string(), "Default".to_string())).collect();
    nets.insert("/VOUT".to_string(), "POWER".to_string());
    Board {
        path: String::new(),
        copper_layers: vec!["F.Cu".to_string(), "B.Cu".to_string()],
        stackup: Vec::new(),
        nets,
        footprints,
        copper: routes(),
        zones: vec![pour("GND_F", "GND", "F.Cu", OUTLINE), pour("GND_B", "GND", "B.Cu", OUTLINE), pour("LOCAL_F", "/VOUT", "F.Cu", (145.0, 105.0, 155.0, 112.0))],
        graphics: vec![rect_shape("edge", "Edge.Cuts", OUTLINE)],
        texts: Vec::new(),
        groups: Vec::new(),
        constraints: Constraints { min_clearance: nm(0.2), min_track_width: nm(0.2), min_via_size: nm(0.45), copper_edge_clearance: nm(0.5) },
        edges_bbox: nm_box(OUTLINE),
        outlines: vec![square(OUTLINE)],
    }
}

pub fn locked(item: &mut Copper) {
    match item {
        Copper::Track(t) => t.locked = true,
        Copper::Via(v) => v.locked = true,
    }
}

/// A net class of the .kicad_pro.
pub fn class(name: &str, clearance: f64, track_width: f64) -> Value {
    json!({"name": name, "clearance": clearance, "track_width": track_width, "via_diameter": 0.6})
}

pub fn default_classes() -> Vec<Value> {
    vec![class("Default", 0.2, 0.25), class("POWER", 0.3, 0.5)]
}

fn pads_text(fp: &Footprint) -> String {
    let row = |p: &Pad| {
        let (kind, at) = (pad_word(p.kind), p.position - fp.position);
        let layers: Vec<String> = p.layers.iter().map(|l| format!("\"{l}\"")).collect();
        let net = if p.net.is_empty() { String::new() } else { format!(" (net \"{}\")", p.net) };
        format!("\t\t(pad \"{}\" {kind} rect (at {} {}) (size {} {}) (layers {}){net} (uuid \"{}\"))\n", p.number, nm_text(at.x), nm_text(at.y), nm_text(p.size.x), nm_text(p.size.y), layers.join(" "), p.id)
    };
    fp.pads.iter().map(row).collect()
}

fn pad_word(kind: PadKind) -> &'static str {
    match kind {
        PadKind::ThroughHole => "thru_hole",
        PadKind::NpThroughHole => "np_thru_hole",
        PadKind::EdgeConnector => "connect",
        PadKind::Smd => "smd",
    }
}

fn xy(p: Pt) -> String {
    format!("{} {}", nm_text(p.x), nm_text(p.y))
}

fn copper_text(item: &Copper) -> String {
    match item {
        Copper::Track(t) => {
            let lock = if t.locked { " (locked yes)" } else { "" };
            let (head, mid) = t.mid.map_or(("segment", String::new()), |m| ("arc", format!(" (mid {})", xy(m))));
            format!("\t({head} (start {}){mid} (end {}) (width {}) (layer \"{}\"){lock} (net \"{}\") (uuid \"{}\"))\n", xy(t.start), xy(t.end), nm_text(t.width), t.layer, t.net, t.id)
        }
        Copper::Via(v) => {
            let lock = if v.locked { " (locked yes)" } else { "" };
            let layers: Vec<String> = v.layers.iter().map(|l| format!("\"{l}\"")).collect();
            format!("\t(via (at {}) (size {}) (drill {}) (layers {}){lock} (net \"{}\") (uuid \"{}\"))\n", xy(v.at), nm_text(v.size), nm_text(v.drill), layers.join(" "), v.net, v.id)
        }
    }
}

fn points(ring: &[Pt]) -> String {
    ring.iter().map(|p| format!("(xy {})", xy(*p))).collect::<Vec<_>>().join(" ")
}

fn zone_text(z: &Zone) -> String {
    let ring = points(&z.outline[0].outline);
    let filled = if z.rule_area.is_none() { format!(" (filled_polygon (layer \"{}\") (pts {ring}))", z.layers[0]) } else { String::new() };
    format!("\t(zone (net \"{}\") (layer \"{}\") (uuid \"{}\") (name \"{}\") (polygon (pts {ring})){filled})\n", z.net, z.layers[0], z.id, z.name)
}

fn graphic_text(g: &Graphic) -> String {
    let Geometry::Rect { top_left, bottom_right } = &g.geometry else { panic!("the fixture draws rectangles") };
    format!("\t(gr_rect (start {}) (end {}) (stroke (width {}) (type default)) (fill no) (layer \"{}\") (uuid \"{}\"))\n", xy(*top_left), xy(*bottom_right), nm_text(g.width), g.layer, g.id)
}

/// The board as a file: what `write_board` edits.
pub fn board_text(board: &Board) -> String {
    let layers: Vec<String> = board.copper_layers.iter().enumerate().map(|(k, l)| format!("({} \"{l}\" signal)", 2 * k)).collect();
    let mut out = format!("(kicad_pcb\n\t(layers {})\n", layers.join(" "));
    for f in &board.footprints {
        out += &format!("\t(footprint \"{}\" (layer \"{}\") (uuid \"{}\") (at {})\n\t\t(property \"Reference\" \"{}\" (at 0 -3 0))\n", f.lib_id, f.layer, f.id, xy(f.position), f.reference);
        out += &pads_text(f);
        out += "\t)\n";
    }
    board.copper.iter().for_each(|c| out += &copper_text(c));
    board.zones.iter().for_each(|z| out += &zone_text(z));
    board.graphics.iter().for_each(|g| out += &graphic_text(g));
    for t in &board.texts {
        out += &format!("\t(gr_text \"{}\" (at {} 0) (layer \"{}\") (uuid \"{}\"))\n", t.text, xy(t.position), t.layer, t.id);
    }
    out + ")\n"
}

static NEXT: AtomicUsize = AtomicUsize::new(0);

/// A board in a temporary folder with its project files.
pub struct Fixture {
    dir: PathBuf,
    pub path: PathBuf,
    pub board: Board,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

impl Fixture {
    pub fn new(board: Board) -> Self {
        Self::with(board, &default_classes(), None)
    }

    /// `dru`: the text of the .kicad_dru, none when absent.
    pub fn with(board: Board, classes: &[Value], dru: Option<&str>) -> Self {
        let dir = std::env::temp_dir().join(format!("iotplace-board-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("B.kicad_pcb");
        fs::write(&path, board_text(&board)).unwrap();
        fs::write(path.with_extension("kicad_pro"), json!({"net_settings": {"classes": classes}}).to_string()).unwrap();
        if let Some(text) = dru {
            fs::write(path.with_extension("kicad_dru"), text).unwrap();
        }
        Self { dir, path, board }
    }

    pub fn folder(&self) -> &PathBuf {
        &self.dir
    }

    /// The board document on disk, for the command line.
    pub fn document(&self) -> PathBuf {
        let path = self.dir.join("B.json");
        fs::write(&path, json!({"board": self.board}).to_string()).unwrap();
        path
    }

    pub fn fp(&self, reference: &str) -> &Footprint {
        self.board.footprints.iter().find(|f| f.reference == reference).unwrap()
    }

    pub fn read(&self, options: &Options) -> ProblemOut {
        read_problem(&self.path, &self.board, options).unwrap()
    }

    pub fn read_error(&self, options: &Options) -> String {
        read_problem(&self.path, &self.board, options).err().expect("the read fails").to_string()
    }

    pub fn project(&self, domains: Option<&[(String, f64, f64)]>) -> Project {
        Project::load(&self.path, &self.board, domains).unwrap()
    }

    /// The search's view of a problem, through the file format.
    pub fn problem(&self, pr: &ProblemOut) -> Problem {
        serde_json::from_value(serde_json::to_value(pr).unwrap()).unwrap()
    }

    pub fn pose(&self, pr: &ProblemOut) -> Pose {
        self.problem(pr).initial_pose()
    }

    /// The edited board text and the report, as `iotplace write` before the KiCad save.
    pub fn write(&self, pr: &ProblemOut, pose: &[Place], options: WriteOptions) -> (Written, Report) {
        let problem: WriteProblem = serde_json::from_value(serde_json::to_value(pr).unwrap()).unwrap();
        let design = self.project(None).design;
        let (text, report) = write_board(&board_text(&self.board), &self.board, &design, &problem, pose, options).unwrap();
        (Written::new(&text), report)
    }
}

/// The index of the unit that holds a part.
pub fn unit_of(pr: &ProblemOut, reference: &str) -> usize {
    pr.units.iter().position(|u| u.refs.iter().any(|r| r == reference)).unwrap()
}

pub fn is_fixed(pr: &ProblemOut, reference: &str) -> bool {
    pr.units[unit_of(pr, reference)].fixed
}

/// Rounded to `places` decimals, so rows compare as Python's round() did.
pub fn rounded(v: f64, places: i32) -> f64 {
    let k = 10f64.powi(places);
    (v * k).round() / k
}

pub fn rounded_row(row: &[f64], places: i32) -> Vec<f64> {
    row.iter().map(|v| rounded(*v, places)).collect()
}

/// A written board text.
pub struct Written {
    pub text: String,
    root: Node,
}

fn number(node: &Node, i: usize) -> f64 {
    node.text(i).unwrap().parse().unwrap()
}

impl Written {
    pub fn new(text: &str) -> Self {
        let mut forms = parse(text).unwrap();
        Self { text: text.to_string(), root: forms.remove(0) }
    }

    pub fn item(&self, id: &str) -> &Node {
        self.find(id).unwrap_or_else(|| panic!("no item {id}"))
    }

    pub fn find(&self, id: &str) -> Option<&Node> {
        self.root.items().iter().find(|f| f.value("uuid") == Some(id))
    }

    /// Uuids of the tracks and vias left.
    pub fn copper(&self) -> HashSet<String> {
        let copper = self.root.items().iter().filter(|f| f.is("segment") || f.is("arc") || f.is("via"));
        copper.map(|f| f.value("uuid").unwrap().to_string()).collect()
    }

    /// x, y, angle of a footprint or via.
    pub fn at(&self, id: &str) -> (f64, f64, f64) {
        let at = self.item(id).child("at").unwrap();
        (number(at, 1), number(at, 2), at.text(3).map_or(0.0, |a| a.parse().unwrap()))
    }

    /// The `start` and `end` of a track or shape.
    pub fn ends(&self, id: &str) -> [(f64, f64); 2] {
        let point = |head: &str| {
            let p = self.item(id).child(head).unwrap();
            (number(p, 1), number(p, 2))
        };
        [point("start"), point("end")]
    }

    /// The outline points of a zone.
    pub fn zone_ring(&self, id: &str) -> Vec<(f64, f64)> {
        let pts = self.item(id).child("polygon").unwrap().child("pts").unwrap();
        pts.children("xy").map(|p| (number(p, 1), number(p, 2))).collect()
    }

    /// The (x, y) of pad `number` of a footprint in board mm, with KiCad's turn of a footprint.
    pub fn pad_at(&self, footprint: &str, pad: &str) -> (f64, f64) {
        let (x, y, angle) = self.at(footprint);
        let row = self.item(footprint).children("pad").find(|p| p.text(1) == Some(pad)).unwrap();
        let at = row.child("at").unwrap();
        let (lx, ly) = turned((number(at, 1), number(at, 2)), angle);
        (x + lx, y + ly)
    }

    /// The angle a pad's `at` stores.
    pub fn pad_angle(&self, footprint: &str, pad: &str) -> f64 {
        let row = self.item(footprint).children("pad").find(|p| p.text(1) == Some(pad)).unwrap();
        row.child("at").unwrap().text(3).map_or(0.0, |a| a.parse().unwrap())
    }

    /// The items with a head on a layer.
    pub fn on_layer<'a>(&'a self, head: &'a str, layer: &str) -> Vec<&'a Node> {
        self.root.children(head).filter(|f| f.value("layer") == Some(layer)).collect()
    }
}

/// RotatePoint for quarter turns: y down, the angle in degrees.
pub fn turned((x, y): (f64, f64), angle: f64) -> (f64, f64) {
    match angle as i64 {
        0 => (x, y),
        90 => (y, -x),
        180 => (-x, -y),
        270 => (-y, x),
        other => panic!("{other} is no quarter turn"),
    }
}
