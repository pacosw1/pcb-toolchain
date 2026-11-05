//! What the si tests share. The tables' evidence files live in the hardware repository, so a table is read here without them;
//! a test that needs them says so with #[ignore] and reads IOT_TEST_RULES_ROOT.
use crate::si::drivers::netlist::{Netlist, Node};
use crate::si::drivers::table::{Part, Table, read_part};
use crate::si::json::Json;
use crate::si::planes::spec::Spec;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// A folder of its own for one test.
pub(crate) fn scratch(name: &str) -> PathBuf {
    let folder = std::env::temp_dir().join(format!("si-tests-{}", std::process::id())).join(name);
    fs::create_dir_all(&folder).expect("a scratch folder");
    folder
}

pub(crate) fn real_text(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").join(name);
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// A folder like tools/ whose edge-rates.json is the real table without its "evidence_files".
pub(crate) fn tools() -> &'static Path {
    static TOOLS: OnceLock<PathBuf> = OnceLock::new();
    TOOLS.get_or_init(|| {
        let text = real_text("edge-rates.json");
        let end = text.find(",\n  \"evidence_files\"").expect("edge-rates.json ends with its evidence");
        let folder = scratch("tools");
        fs::write(folder.join("edge-rates.json"), format!("{}\n}}\n", &text[..end])).expect("a scratch table");
        folder
    })
}

/// The spec of a 4-layer test board, `extra` over its keys (a value is JSON text).
pub(crate) fn raw_spec(extra: &[(&str, &str)]) -> Json {
    let mut rows: Vec<(&str, &str)> = vec![
        ("about", r#""test board""#),
        ("adjacent", r#"{"F.Cu": "In1.Cu", "B.Cu": "In2.Cu"}"#),
        ("plane_layers", r#"["In1.Cu", "In2.Cu"]"#),
        ("grounds", r#"["GND", "ISO_0V"]"#),
    ];
    for &(key, value) in extra {
        match rows.iter_mut().find(|r| r.0 == key) {
            Some(row) => row.1 = value,
            None => rows.push((key, value)),
        }
    }
    Json::Obj(rows.into_iter().map(|(k, v)| (k.to_string(), Json::parse(v).unwrap_or_else(|e| panic!("{k}: {e}")))).collect())
}

pub(crate) fn spec(extra: &[(&str, &str)]) -> Spec {
    Spec::load(&raw_spec(extra), tools()).unwrap()
}

pub(crate) fn spec_error(extra: &[(&str, &str)]) -> String {
    Spec::load(&raw_spec(extra), tools()).unwrap_err()
}

/// A part of driver-edges.json from its JSON text.
pub(crate) fn part(key: &str, text: &str, evidence: &[Json]) -> Part {
    read_part("table", key, &Json::parse(text).unwrap(), evidence).unwrap()
}

pub(crate) fn table_of(parts: Vec<Part>) -> Table {
    Table::of_parts(parts, PathBuf::new())
}

/// The parts of the real tools/driver-edges.json; `more` come after them.
pub(crate) fn real_table_with(more: Vec<Part>) -> Table {
    let raw = Json::parse(&real_text("driver-edges.json")).unwrap();
    let evidence = raw.get("evidence_files").and_then(Json::as_arr).unwrap();
    let parts = raw.get("parts").and_then(Json::as_obj).unwrap();
    let mut read: Vec<Part> = parts.iter().map(|(key, p)| read_part("driver-edges.json", key, p, evidence).unwrap()).collect();
    read.extend(more);
    table_of(read)
}

pub(crate) fn real_table() -> Table {
    real_table_with(Vec::new())
}

/// A netlist from reference -> MPN and net -> (reference, pin, pin name).
pub(crate) fn netlist(comps: &[(&str, &str)], nets: &[(&str, &[(&str, &str, &str)])]) -> Netlist {
    let node = |&(part, pin, name): &(&str, &str, &str)| Node { part: part.to_string(), pin: pin.to_string(), name: name.to_string() };
    Netlist {
        comps: comps.iter().map(|(r, m)| (r.to_string(), m.to_string())).collect(),
        values: Default::default(),
        nets: nets.iter().map(|(n, nodes)| (n.to_string(), nodes.iter().map(node).collect())).collect(),
    }
}

/// assertAlmostEqual: equal to 7 places.
#[track_caller]
pub(crate) fn near(a: f64, b: f64) {
    assert!((a - b).abs() < 5e-8, "{a} is not {b}");
}
