//! Typed adapter for the KiCad API JSON. No text-derived board geometry and no pcbnew.
use crate::{
    Result,
    decimal::{self as dec, D, Point},
    evidence,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
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
        [
            D::from(self.x) / D::from(1_000_000),
            D::from(self.y) / D::from(1_000_000),
        ]
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
    Ok(doc.board)
}
fn quarter(v: f64) -> Result<i32> {
    dec::angle_d(dec::decimal(&v.to_string())?)
}
fn layers(board: &NativeBoard) -> Result<()> {
    if board.copper_layers.first().map(String::as_str) != Some("F.Cu")
        || board.copper_layers.last().map(String::as_str) != Some("B.Cu")
        || board.copper_layers.iter().collect::<BTreeSet<_>>().len() != board.copper_layers.len()
    {
        return Err("missing native copper stack".into());
    }
    Ok(())
}
fn dimensions(p: &Pad, fp: &Footprint, board: &NativeBoard) -> Result<Value> {
    if fp.layer != "F.Cu" {
        return Err("mirrored/backside drilled footprint is unsupported".into());
    }
    let rotation = quarter(p.orientation)?;
    let fp_rotation = quarter(fp.orientation)?;
    let shape = match p.shape.as_str() {
        "Circle" => "circle",
        "Rect" => "rect",
        "Oval" => "oval",
        _ => return Err("unsupported drilled pad copper shape".into()),
    };
    let size = p.size.mm();
    let drill = p.drill.mm();
    if size.iter().chain(drill.iter()).any(|v| v <= &dec::zero())
        || (shape == "circle" && size[0] != size[1])
    {
        return Err("invalid drilled pad dimensions".into());
    }
    let position = p.position.mm();
    // Offsets are represented in the API's effective copper, rather than guessed from the authored form.
    let expected = crate::hole::capsule(position.clone(), size.clone(), rotation);
    let valid = if shape == "rect" {
        p.copper.len() == 1
            && p.copper[0].get("Polygon").is_some_and(|points| {
                let Ok(points) = serde_json::from_value::<Vec<NmPoint>>(points.clone()) else {
                    return false;
                };
                let expected = crate::hole::rectangle(position.clone(), size.clone(), rotation);
                points.len() == 4
                    && points.iter().map(NmPoint::mm).all(|point| match &expected {
                        crate::hole::Obstacle::Rect([x0, y0, x1, y1]) => {
                            (point[0] == *x0 || point[0] == *x1)
                                && (point[1] == *y0 || point[1] == *y1)
                        }
                        _ => false,
                    })
            })
    } else {
        p.copper.len() == 1 && crate::hole::api_obstacle(&p.copper[0]).is_ok_and(|o| o == expected)
    };
    if !valid {
        return Err("custom or offset drilled pad geometry is unsupported".into());
    }
    let copper: Vec<_> = p
        .layers
        .iter()
        .filter(|l| board.copper_layers.contains(l))
        .cloned()
        .collect();
    if p.layers.iter().collect::<BTreeSet<_>>().len() != p.layers.len() {
        return Err("ambiguous drilled pad layers".into());
    }
    Ok(
        json!({"side":"front","footprint_position_mm":dec::strings(&fp.position.mm()),"footprint_rotation_deg":fp_rotation.to_string(),
        "position_mm":dec::strings(&position),"size_mm":dec::strings(&size),"drill_mm":dec::strings(&drill),
        "drill_shape":if drill[0]==drill[1]{"circle"}else{"oval"},"drill_offset_mm":["0","0"],"shape":shape,
        "layers":copper,"hole_layers":board.copper_layers,"rotation_deg":rotation.to_string()}),
    )
}
/// Inventories unsupported geometry as a blocked row; physical multiplicity is never discarded.
/// `native_form_sha256` now binds the API item, not a Python parser's spelling of its source form.
pub fn native_drilled_geometry(board: &NativeBoard) -> Result<Vec<Value>> {
    layers(board)?;
    let mut rows = Vec::new();
    let mut ids = BTreeSet::new();
    let mut refs = BTreeSet::new();
    for (fi, fp) in board.footprints.iter().enumerate() {
        if fp.reference.is_empty() || !refs.insert(fp.reference.to_lowercase()) {
            return Err("ambiguous native drilled reference".into());
        }
        let mut aliases: BTreeMap<&str, usize> = BTreeMap::new();
        let mut nets = BTreeMap::new();
        for (pi, p) in fp.pads.iter().enumerate() {
            let kind = match p.kind.as_str() {
                "ThroughHole" => "pth",
                "NpThroughHole" => "npth",
                _ => "unknown",
            };
            if !p.number.is_empty()
                && kind != "npth"
                && nets
                    .insert(p.number.clone(), p.net.clone())
                    .is_some_and(|old| old != p.net)
            {
                return Err("conflicting repeated native electrical membership".into());
            }
            let ordinal = *aliases.get(p.number.as_str()).unwrap_or(&0);
            if kind != "npth" {
                aliases.insert(&p.number, ordinal + 1);
            }
            if kind == "unknown"
                && p.drill.x == 0
                && p.drill.y == 0
                && matches!(p.kind.as_str(), "Smd" | "EdgeConnector")
            {
                continue;
            }
            let id = if p.id.is_empty() {
                format!("index:{fi}:{pi}")
            } else {
                p.id.clone()
            };
            if !ids.insert(id.clone()) {
                return Err("duplicate physical drilled identity".into());
            }
            let mut row = json!({"kind":kind,"identity":id,"net":p.net,"supported":false,"cause":null,
                "native_form_sha256":evidence::identity(&json!({"id":p.id,"kind":p.kind,"shape":p.shape,"net":p.net,
                    "position":[p.position.x,p.position.y],"orientation":p.orientation,"size":[p.size.x,p.size.y],
                    "drill":[p.drill.x,p.drill.y],"layers":p.layers,"copper":p.copper})),"reference":fp.reference,"pad":p.number});
            let fill = (|| -> Result<Value> {
                if kind == "unknown" {
                    return Err("unknown drilled pad type".into());
                }
                let mut data = dimensions(p, fp, board)?;
                if kind == "pth" {
                    if p.number.is_empty()
                        || p.net.is_empty()
                        || p.net.bytes().all(|b| b.is_ascii_digit())
                        || data["layers"].as_array().is_none_or(Vec::is_empty)
                    {
                        return Err("missing exact drilled electrical membership".into());
                    }
                    if p.shape == "Circle" && p.drill.x >= p.size.x {
                        return Err(
                            "copper-less plated drill requires keepout-specific binding".into()
                        );
                    }
                    data["export_pin"] = format!(
                        "{}{}",
                        p.number,
                        if ordinal == 0 {
                            String::new()
                        } else {
                            format!("@{ordinal}")
                        }
                    )
                    .into();
                } else {
                    if !p.net.is_empty()
                        || p.shape != "Circle"
                        || p.drill.x != p.drill.y
                        || p.size.x > p.drill.x
                    {
                        return Err(
                            "only copper-less circular NPTH exporter keepouts are supported".into(),
                        );
                    }
                    data["export_pin"] = Value::Null;
                }
                data["supported"] = true.into();
                Ok(data)
            })();
            match fill {
                Ok(data) => row
                    .as_object_mut()
                    .unwrap()
                    .extend(data.as_object().unwrap().clone()),
                Err(e) => row["cause"] = e.into(),
            }
            rows.push(row);
        }
    }
    for (vi, item) in board.copper.iter().enumerate() {
        if let Some(v) = item.get("Via") {
            let id = v["id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or(format!("index:via:{vi}"));
            if !ids.insert(id.clone()) {
                return Err("duplicate physical drilled identity".into());
            }
            let mut row = json!({"kind":"via","identity":id,"net":v["net"],"supported":false,"cause":null,"native_form_sha256":evidence::identity(v)});
            let fill = (|| -> Result<Value> {
                let size = v["size"].as_i64().ok_or("unknown via dimensions")?;
                let drill = v["drill"].as_i64().ok_or("unknown via drill")?;
                let net = v["net"]
                    .as_str()
                    .ok_or("unknown via electrical membership")?;
                if net.is_empty()
                    || net.bytes().all(|c| c.is_ascii_digit())
                    || drill <= 0
                    || size <= drill
                {
                    return Err("invalid via annulus".into());
                }
                let at: NmPoint =
                    serde_json::from_value(v["at"].clone()).map_err(|e| e.to_string())?;
                let size = dec::normalized(&(D::from(size) / D::from(1_000_000)));
                let drill = dec::normalized(&(D::from(drill) / D::from(1_000_000)));
                Ok(
                    json!({"position_mm":dec::strings(&at.mm()),"size_mm":[size,size],"drill_mm":[drill,drill],"drill_shape":"circle",
                "drill_offset_mm":["0","0"],"shape":"circle","layers":board.copper_layers,"hole_layers":board.copper_layers,"rotation_deg":"0","supported":true}),
                )
            })();
            match fill {
                Ok(data) => row
                    .as_object_mut()
                    .unwrap()
                    .extend(data.as_object().unwrap().clone()),
                Err(e) => row["cause"] = e.into(),
            }
            rows.push(row);
        }
    }
    Ok(rows)
}
pub fn native_pth_pads(board: &NativeBoard) -> Result<Vec<Value>> {
    let mut pads = Vec::new();
    for mut row in native_drilled_geometry(board)? {
        if row["kind"] != "pth" {
            continue;
        }
        if row["supported"] != true {
            return Err(row["cause"]
                .as_str()
                .unwrap_or("unsupported PTH geometry")
                .into());
        }
        if row["shape"] == "oval" || row["drill_shape"] != "circle" {
            return Err(
                "only circle/rectangle native PTH copper with circular drills is supported".into(),
            );
        }
        let size = dec::pair(&row["size_mm"])?;
        let drill = dec::pair(&row["drill_mm"])?;
        if size.iter().min().unwrap() <= &drill[0] {
            return Err("invalid native PTH dimensions".into());
        }
        for key in [
            "kind",
            "supported",
            "cause",
            "native_form_sha256",
            "drill_shape",
            "hole_layers",
        ] {
            row.as_object_mut().unwrap().remove(key);
        }
        pads.push(row);
    }
    Ok(pads)
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
