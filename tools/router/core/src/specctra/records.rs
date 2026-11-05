//! The copper of a DSN `wiring` section and an SES `network_out`, as exact nanometres. Straight segments and through padstacks
//! are all the Fastroute job exchanges; anything else is an error, so nothing is matched approximately.
use crate::kicad::raw::{self, Form};
use std::collections::{BTreeMap, HashMap};

/// x, y in nanometres, y down as in KiCad.
pub type Point = (i64, i64);

/// What two copper items must share to be the same copper. The ends of a segment are sorted: direction is no difference.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Geometry {
    Segment { net: String, layer: String, width: i64, ends: [Point; 2] },
    Via { net: String, at: Point, size: i64, drill: i64 },
    /// An arc, by uuid: no replay of one is ever proved.
    Unsupported(String),
}

impl Geometry {
    pub fn segment(net: &str, layer: &str, width: i64, a: Point, b: Point) -> Self {
        Self::Segment { net: net.to_string(), layer: layer.to_string(), width, ends: [a.min(b), a.max(b)] }
    }

    /// One line for an error message.
    pub fn describe(&self) -> String {
        match self {
            Self::Segment { net, layer, width, ends } => format!("segment {net} {layer} w{width} {:?}-{:?}", ends[0], ends[1]),
            Self::Via { net, at, .. } => format!("via {net} at {at:?}"),
            Self::Unsupported(id) => format!("arc {id}"),
        }
    }
}

/// One copper item of the file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub geometry: Geometry,
    /// The `(type ...)` of the wire or via, "unspecified" when it has none.
    pub mode: String,
    /// A segment's ends in the file's direction; a via's position twice.
    pub path: [Point; 2],
}

/// The modes of each geometry: how many copies a file holds and what it called them.
pub type Modes = BTreeMap<Geometry, Vec<String>>;

pub fn modes(records: &[Record]) -> Modes {
    let mut out = Modes::new();
    for record in records {
        out.entry(record.geometry.clone()).or_default().push(record.mode.clone());
    }
    out
}

/// The one form with this head, read from its own start: the text before it may hold the DSN's unpaired quote.
pub(super) fn section(text: &str, name: &str) -> Result<Form, String> {
    let head = format!("({name}");
    let ends_head = |at: usize| text[at + head.len()..].chars().next().is_some_and(|c| c.is_whitespace() || matches!(c, '(' | ')'));
    let found: Vec<usize> = text.match_indices(&head).map(|(at, _)| at).filter(|at| ends_head(*at)).collect();
    let [start] = found[..] else { return Err(format!("missing/ambiguous Specctra {name}")) };
    raw::parse_first(&text[start..]).map_err(|error| format!("unterminated Specctra {name}: {error}"))
}

fn child<'a>(node: &'a Form, tag: &str) -> Result<&'a Form, String> {
    let mut found = node.items().iter().filter(|item| item.is(tag));
    match (found.next(), found.next()) {
        (Some(form), None) => Ok(form),
        _ => Err(format!("missing/ambiguous {tag}")),
    }
}

/// A decimal text times `scale`, which must come out whole: no float rounds a coordinate here.
pub(super) fn scaled(text: &str, scale: i64) -> Result<i64, String> {
    let bad = || format!("noninteger native geometry: {text}");
    let (negative, digits) = text.strip_prefix('-').map_or((false, text), |rest| (true, rest));
    let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
    let all_digits = |part: &str| part.bytes().all(|byte| byte.is_ascii_digit());
    if (whole.is_empty() && fraction.is_empty()) || !all_digits(whole) || !all_digits(fraction) || fraction.len() > 18 {
        return Err(bad());
    }
    let unit = 10i128.pow(fraction.len() as u32);
    let number: i128 = format!("{whole}{fraction}").parse().map_err(|_| bad())?;
    let product = number * i128::from(scale);
    if product % unit != 0 {
        return Err(bad());
    }
    let value = i64::try_from(product / unit).map_err(|_| bad())?;
    Ok(if negative { -value } else { value })
}

pub(super) fn atom<'a>(form: &'a Form, index: usize) -> Result<&'a str, String> {
    form.text(index).ok_or_else(|| "unsupported Specctra form".to_string())
}

/// Nanometres per unit from `(resolution um N)`: N must divide 1000.
pub(super) fn resolution_step(unit: &str, divisor: &str) -> Result<i64, String> {
    let divisor: i64 = divisor.parse().map_err(|_| "unsupported resolution".to_string())?;
    if unit != "um" || divisor <= 0 || 1000 % divisor != 0 {
        return Err("unsupported resolution".to_string());
    }
    Ok(1000 / divisor)
}

/// The atoms of every `(head a b ...)` in the text, each with `count` of them.
pub(super) fn directives(text: &str, head: &str, count: usize) -> Vec<Vec<String>> {
    let pattern = format!("({head}");
    let mut found = Vec::new();
    for (at, _) in text.match_indices(&pattern) {
        let rest = &text[at + pattern.len()..];
        if !rest.starts_with(char::is_whitespace) {
            continue;
        }
        let Some(end) = rest.find(')') else { continue };
        let atoms: Vec<String> = rest[..end].split_whitespace().map(str::to_string).collect();
        if atoms.len() == count {
            found.push(atoms);
        }
    }
    found
}

/// The size and drill of a `Via[0-N]_SIZE:DRILL_um` name, with its last layer index, all in the name's units.
fn via_name(name: &str) -> Option<(usize, i64, i64)> {
    let rest = name.strip_prefix("Via[0-")?.strip_suffix("_um")?;
    let (last, rest) = rest.split_once("]_")?;
    let (size, drill) = rest.split_once(':')?;
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
    (digits(last) && digits(size) && digits(drill)).then_some(())?;
    Some((last.parse().ok()?, size.parse().ok()?, drill.parse().ok()?))
}

/// The circle shapes of a padstack as (layer, diameter). A shape off the padstack origin is an error.
fn circles(stack: &Form, scale: i64) -> Result<Vec<(String, i64)>, String> {
    let mut shapes = Vec::new();
    for row in stack.children("shape") {
        let [_, shape] = row.items() else { continue };
        if !shape.is("circle") {
            continue;
        }
        let parts = shape.items();
        if !matches!(parts.len(), 3 | 5) {
            return Err("unsupported padstack origin".to_string());
        }
        for offset in parts.iter().skip(3) {
            if scaled(offset.atom().unwrap_or("x"), 1_000_000)? != 0 {
                return Err("unsupported padstack origin".to_string());
            }
        }
        shapes.push((atom(shape, 1)?.to_string(), scaled(atom(shape, 2)?, scale)?));
    }
    Ok(shapes)
}

/// The size and drill of each through via padstack of the library, in nanometres. Other padstacks are the footprints'.
fn via_stacks(library: &Form, scale: i64) -> Result<HashMap<String, (i64, i64)>, String> {
    let mut stacks = HashMap::new();
    for stack in library.children("padstack") {
        let name = atom(stack, 1)?;
        let Some((last, size, drill)) = via_name(name) else { continue };
        let (size, drill) = (size * 1000, drill * 1000);
        let shapes = circles(stack, scale)?;
        let mut layers: Vec<&str> = shapes.iter().map(|(layer, _)| layer.as_str()).collect();
        layers.sort_unstable();
        layers.dedup();
        let through = layers.contains(&"F.Cu") && layers.contains(&"B.Cu");
        if shapes.len() != last + 1 || layers.len() != shapes.len() || !through || shapes.iter().any(|(_, width)| *width != size) {
            return Err("inconsistent via padstack".to_string());
        }
        if stacks.insert(name.to_string(), (size, drill)).is_some() {
            return Err("duplicate padstack".to_string());
        }
    }
    Ok(stacks)
}

fn mode_of(node: &Form) -> Result<String, String> {
    let mut types = node.children("type");
    match (types.next(), types.next()) {
        (None, _) => Ok("unspecified".to_string()),
        (Some(form), None) => Ok(atom(form, 1)?.to_string()),
        _ => Err("ambiguous record type".to_string()),
    }
}

/// Coordinates in the file have y up.
fn point(x: &str, y: &str, scale: i64) -> Result<Point, String> {
    Ok((scaled(x, scale)?, -scaled(y, scale)?))
}

/// The segments of a wire. A one-point path is no copper: KiCad makes no track of it, and Fastroute writes one now and then.
fn wire(net: &str, node: &Form, scale: i64, out: &mut Vec<Record>) -> Result<(), String> {
    let path = child(node, "path")?;
    let length = path.items().len();
    if length == 5 {
        return Ok(());
    }
    if length < 7 || (length - 3) % 2 != 0 {
        return Err("unsupported path".to_string());
    }
    let mode = mode_of(node)?;
    let (layer, width) = (atom(path, 1)?, scaled(atom(path, 2)?, scale)?);
    let mut points = Vec::new();
    for index in (3..length).step_by(2) {
        points.push(point(atom(path, index)?, atom(path, index + 1)?, scale)?);
    }
    for pair in points.windows(2) {
        let geometry = Geometry::segment(net, layer, width, pair[0], pair[1]);
        out.push(Record { geometry, mode: mode.clone(), path: [pair[0], pair[1]] });
    }
    Ok(())
}

fn via(net: &str, node: &Form, scale: i64, stacks: &HashMap<String, (i64, i64)>, out: &mut Vec<Record>) -> Result<(), String> {
    let &(size, drill) = stacks.get(atom(node, 1)?).ok_or("unsupported via padstack")?;
    let at = point(atom(node, 2)?, atom(node, 3)?, scale)?;
    let geometry = Geometry::Via { net: net.to_string(), at, size, drill };
    out.push(Record { geometry, mode: mode_of(node)?, path: [at, at] });
    Ok(())
}

/// The copper of a session, in file order. Its numbers are resolution ticks.
pub fn session_records(text: &str) -> Result<Vec<Record>, String> {
    let root = section(text, "routes")?;
    let resolution = child(&root, "resolution")?;
    let scale = resolution_step(atom(resolution, 1)?, atom(resolution, 2)?)?;
    let stacks = via_stacks(child(&root, "library_out")?, scale)?;
    let mut out = Vec::new();
    for net in child(&root, "network_out")?.children("net") {
        let name = atom(net, 1)?;
        for node in net.items().iter().skip(2) {
            if node.is("wire") {
                wire(name, node, scale, &mut out)?;
            } else if node.is("via") {
                via(name, node, scale, &stacks, &mut out)?;
            }
        }
    }
    Ok(out)
}

/// The wiring of a DSN, in file order. Its numbers are in its unit, um; the resolution only says how many decimals it has.
pub fn dsn_records(text: &str) -> Result<Vec<Record>, String> {
    if directives(text, "unit", 1) != [["um"]] {
        return Err("unsupported/ambiguous DSN unit".to_string());
    }
    let resolutions = directives(text, "resolution", 2);
    let [resolution] = &resolutions[..] else { return Err("unsupported/ambiguous DSN resolution".to_string()) };
    resolution_step(&resolution[0], &resolution[1])?;
    const NM_PER_UM: i64 = 1000;
    let stacks = via_stacks(&section(text, "library")?, NM_PER_UM)?;
    let mut out = Vec::new();
    for node in section(text, "wiring")?.items().iter().skip(1) {
        if node.is("wire") {
            wire(atom(child(node, "net")?, 1)?, node, NM_PER_UM, &mut out)?;
        } else if node.is("via") {
            via(atom(child(node, "net")?, 1)?, node, NM_PER_UM, &stacks, &mut out)?;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DSN_VIA: &str = "(resolution um 10)(unit um)(library(padstack \"Via[0-1]_600:300_um\"(shape(circle F.Cu 600))(shape(circle B.Cu 600))))(wiring(via \"Via[0-1]_600:300_um\" 1 -2(net P)(type fix)))";

    #[test]
    fn declared_units_a_polyline_its_reverse_and_a_quoted_net_are_the_same_copper() {
        let dsn = "(resolution um 10)(unit um)(library)(wiring (wire (path F.Cu .2 1 -2 2 -2 3 -2)(net \"P A\")(type route)))";
        let ses = "(routes(resolution um 10)(library_out)(network_out(net \"P A\"(wire(path F.Cu 2 30 -20 20 -20 10 -20)(type protect)))))";
        let (a, b) = (modes(&dsn_records(dsn).unwrap()), modes(&session_records(ses).unwrap()));
        assert_eq!(a.len(), 2);
        assert_eq!(a.keys().collect::<Vec<_>>(), b.keys().collect::<Vec<_>>());
    }

    #[test]
    fn a_session_keeps_the_direction_of_the_file() {
        let ses = "(routes(resolution um 10)(library_out)(network_out(net P(wire(path F.Cu 2 30 -20 10 -20)))))";
        let record = &session_records(ses).unwrap()[0];
        assert_eq!(record.path, [(3000, 2000), (1000, 2000)]);
        assert_eq!(record.mode, "unspecified");
    }

    #[test]
    fn a_one_point_path_is_no_copper_and_an_odd_path_is_an_error() {
        let ses = "(routes(resolution um 10)(library_out)(network_out(net P(wire(path F.Cu 20 10 -20))(wire(path F.Cu 20 10 -20 30 -20)))))";
        assert_eq!(session_records(ses).unwrap().len(), 1);
        assert!(session_records(&ses.replace("30 -20", "30")).is_err());
    }

    #[test]
    fn a_via_padstack_is_checked() {
        assert_eq!(dsn_records(DSN_VIA).unwrap().len(), 1);
        assert!(dsn_records(&DSN_VIA.replace("circle B.Cu 600", "circle B.Cu 599")).is_err());
        assert!(dsn_records(&DSN_VIA.replacen("um)", "mm)", 1)).is_err());
        for replacement in ["(resolution mm 10)", "(resolution um 0)", "(resolution um 3)", ""] {
            assert!(dsn_records(&DSN_VIA.replace("(resolution um 10)", replacement)).is_err(), "{replacement}");
        }
    }

    #[test]
    fn a_via_has_the_size_and_drill_of_its_padstack() {
        let record = &dsn_records(DSN_VIA).unwrap()[0];
        assert_eq!(record.geometry, Geometry::Via { net: "P".to_string(), at: (1000, 2000), size: 600_000, drill: 300_000 });
        assert_eq!(record.mode, "fix");
    }

    #[test]
    fn a_via_on_an_unknown_padstack_is_an_error() {
        assert!(dsn_records(&DSN_VIA.replace("(via \"Via[0-1]_600:300_um\"", "(via Other")).is_err());
    }

    #[test]
    fn two_types_on_a_record_are_an_error() {
        let ses = "(routes(resolution um 10)(library_out)(network_out(net P(wire(path F.Cu 2 1 1 2 2)(type fix)(type route)))))";
        assert_eq!(session_records(ses).unwrap_err(), "ambiguous record type");
    }

    #[test]
    fn numbers_are_exact_or_refused() {
        assert_eq!(scaled("1.5", 1000), Ok(1500));
        assert_eq!(scaled("-.2", 1000), Ok(-200));
        assert_eq!(scaled("111972.5", 100), Ok(11_197_250));
        assert!(scaled("0.0001", 1000).is_err());
        assert!(scaled("1e3", 1000).is_err());
        assert!(scaled("", 1000).is_err());
    }

    #[test]
    fn a_section_needs_its_exact_head_once() {
        assert!(section("(library_out)", "library").is_err());
        assert!(section("(library)(library)", "library").is_err());
        assert!(section("(parser (string_quote \"))(library (a))", "library").is_ok());
    }
}
