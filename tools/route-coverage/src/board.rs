//! Typed adapter for the KiCad API JSON. No text-derived board geometry and no pcbnew.
use crate::{
    Result,
    decimal::{self as dec, Point},
    evidence,
};
use iotroute::kicad::raw;
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::Path,
    process::Command,
};

#[derive(Clone, Debug, Deserialize)]
pub struct NmPoint {
    pub x: i64,
    pub y: i64,
}
impl NmPoint {
    pub fn mm(&self) -> Point {
        [dec::nanometres(self.x), dec::nanometres(self.y)]
    }
}
#[derive(Clone, Debug, Deserialize)]
pub struct Pad {
    pub id: String,
    pub number: String,
    pub kind: String,
    pub shape: String,
    pub net: String,
    pub position: NmPoint,
    pub orientation: f64,
    pub size: NmPoint,
    pub drill: NmPoint,
    pub layers: Vec<String>,
    pub copper: Vec<Value>,
    /// The pad's `layers` as the file spells them. The API lists `*.Cu` on every copper layer KiCad knows, enabled or not, so only
    /// the file tells a wildcard from a pad that names a disabled layer.
    #[serde(skip)]
    pub authored_layers: Option<Vec<String>>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Footprint {
    pub reference: String,
    pub layer: String,
    pub position: NmPoint,
    pub orientation: f64,
    pub pads: Vec<Pad>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct NativeBoard {
    pub copper_layers: Vec<String>,
    pub footprints: Vec<Footprint>,
    pub copper: Vec<Value>,
}
#[derive(Deserialize)]
struct Document {
    schema: String,
    board_sha256: String,
    project_sha256: String,
    rules_sha256: String,
    board: NativeBoard,
}

pub trait BoardReader {
    fn read(&self, path: &Path) -> Result<NativeBoard>;
}
pub struct Iotroute;
impl BoardReader for Iotroute {
    fn read(&self, path: &Path) -> Result<NativeBoard> {
        let binary = std::env::var_os("IOTROUTE_BIN").unwrap_or_else(|| "iotroute".into());
        let out = Command::new(binary)
            .arg("board-json")
            .arg(path)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!(
                "iotroute board-json: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        read_json(
            &String::from_utf8(out.stdout).map_err(|e| e.to_string())?,
            path,
        )
    }
}
pub fn read_json(text: &str, path: &Path) -> Result<NativeBoard> {
    let doc: Document =
        serde_json::from_value(evidence::parse(text)?).map_err(|e| e.to_string())?;
    if doc.schema != "iot-lab.board.v1" || evidence::hash(path)? != doc.board_sha256 {
        return Err("board JSON does not bind the exact native source".into());
    }
    for (ext, expected) in [
        ("kicad_pro", doc.project_sha256),
        ("kicad_dru", doc.rules_sha256),
    ] {
        let p = path.with_extension(ext);
        let actual = if p.is_file() {
            evidence::hash(&p)?
        } else {
            String::new()
        };
        if actual != expected {
            return Err("board JSON native sidecars changed".into());
        }
    }
    let mut board = doc.board;
    let mut authored = authored_layers(path)?;
    for pad in board.footprints.iter_mut().flat_map(|footprint| &mut footprint.pads) {
        pad.authored_layers = authored.remove(&pad.id);
        if pad.authored_layers.is_none() && (pad.drill.x != 0 || pad.drill.y != 0) {
            return Err("drilled pad has no layers in the native file".into());
        }
    }
    Ok(board)
}
/// The `layers` of each footprint pad of the file, by uuid. Names only: geometry still comes from the API.
fn authored_layers(path: &Path) -> Result<BTreeMap<String, Vec<String>>> {
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let root = raw::parse_first(&text)?;
    let mut out = BTreeMap::new();
    for pad in root.children("footprint").flat_map(|footprint| footprint.children("pad")) {
        let Some(id) = pad.children("uuid").next().and_then(|uuid| uuid.text(1)) else { continue };
        let Some(layers) = pad.children("layers").next() else { continue };
        let names = layers.items().iter().skip(1).filter_map(raw::Form::atom).map(str::to_string).collect();
        if out.insert(id.to_string(), names).is_some() {
            return Err("ambiguous native pad UUID".into());
        }
    }
    Ok(out)
}
pub fn uuid_nets(board: &NativeBoard) -> Result<BTreeMap<String, String>> {
    let mut out = BTreeMap::new();
    for p in board.footprints.iter().flat_map(|f| &f.pads) {
        if !p.id.is_empty() && out.insert(p.id.clone(), p.net.clone()).is_some() {
            return Err("ambiguous native diagnostic item UUID".into());
        }
    }
    for item in &board.copper {
        for kind in ["Track", "Via"] {
            if let Some(v) = item.get(kind) {
                let id = v["id"].as_str().ok_or("missing native item UUID")?;
                let net = v["net"].as_str().ok_or("missing native item net")?;
                if out.insert(id.into(), net.into()).is_some() {
                    return Err("ambiguous native diagnostic item UUID".into());
                }
            }
        }
    }
    Ok(out)
}
