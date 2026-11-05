//! One strict DSN reader for both physical containment and project minima.
use crate::{
    Result,
    decimal::{self as dec, D, Point},
};
use iotroute::kicad::sexpr::{self, Node};
use regex::Regex;
use std::collections::{BTreeMap, BTreeSet};

pub fn one<'a>(n: &'a Node, key: &str) -> Result<&'a Node> {
    let rows: Vec<_> = n.items().iter().filter(|item| item.is(key)).collect();
    if rows.len() != 1 {
        return Err(format!("missing or ambiguous DSN {key}"));
    }
    Ok(rows[0])
}
pub fn atom(n: &Node, i: usize) -> Result<&str> {
    n.text(i).ok_or("malformed DSN atom".into())
}
pub fn num(n: &Node, i: usize) -> Result<D> {
    dec::decimal(atom(n, i)?)
}
pub fn index(n: &Node, kind: &str) -> Result<BTreeMap<String, Node>> {
    let mut out = BTreeMap::new();
    for row in n.children(kind) {
        let key = atom(row, 1)?.to_string();
        if out.insert(key, row.clone()).is_some() {
            return Err(format!("ambiguous DSN {kind} identity"));
        }
    }
    Ok(out)
}
pub fn parse(text: &str) -> Result<Node> {
    let text = Regex::new(r#"\(string_quote\s+"\)"#)
        .unwrap()
        .replace_all(text, "(string_quote quote)");
    let mut roots = sexpr::parse(&text)?;
    if roots.len() != 1 || !roots[0].is("pcb") {
        return Err("expected one complete DSN PCB".into());
    }
    Ok(roots.remove(0))
}
pub fn unit(root: &Node) -> Result<(String, D)> {
    let u = one(root, "unit")?;
    let r = one(root, "resolution")?;
    let name = atom(u, 1)?;
    let scale = match name {
        "mm" => "1",
        "um" => "0.001",
        "mil" => "0.0254",
        "inch" | "in" => "25.4",
        _ => return Err("unsupported DSN units".into()),
    };
    let digits = atom(r, 2)?;
    if u.items().len() != 2
        || r.items().len() != 3
        || r.text(1) != Some(name)
        || digits.starts_with('0')
        || !digits.bytes().all(|c| c.is_ascii_digit())
        || digits.parse::<i32>().is_err()
    {
        return Err("ambiguous or unsupported DSN resolution/unit contract".into());
    }
    Ok((name.to_string(), dec::decimal(scale)?))
}
pub fn normalize_stack(s: &str) -> String {
    Regex::new(r"\.\d+")
        .unwrap()
        .replace_all(s, "")
        .to_lowercase()
}
pub fn normalize_image(s: &str) -> String {
    Regex::new(r"::[0-9]+$")
        .unwrap()
        .replace(s, "")
        .to_lowercase()
}
pub fn angle(n: &Node, i: usize) -> Result<i32> {
    dec::angle_d(num(n, i)?)
}
#[derive(Clone, Debug, PartialEq)]
pub struct Pin {
    pub stack: String,
    pub xy: Point,
    pub rotation: i32,
}
pub fn pins(image: &Node) -> Result<BTreeMap<String, Pin>> {
    let mut out = BTreeMap::new();
    for p in image.children("pin") {
        let mut start = 2;
        let mut rotation = 0;
        if p.items().get(start).is_some_and(|v| v.atom().is_none()) {
            let r = &p.items()[start];
            if !r.is("rotate") || r.items().len() != 2 {
                return Err("unknown DSN pin transform".into());
            }
            rotation = angle(r, 1)?;
            start += 1;
        }
        if p.items().len() != start + 3 {
            return Err("ambiguous DSN image pin".into());
        }
        let pin = Pin {
            stack: atom(p, 1)?.into(),
            xy: [num(p, start + 1)?, num(p, start + 2)?],
            rotation,
        };
        if out.insert(atom(p, start)?.into(), pin).is_some() {
            return Err("ambiguous DSN image pin".into());
        }
    }
    Ok(out)
}
#[derive(Clone)]
pub struct Place {
    pub image: String,
    pub form: Node,
}
#[derive(Clone)]
pub struct Via {
    pub stack: String,
    pub center: Point,
    pub net: String,
    pub text: [String; 2],
}
pub struct Dsn {
    pub root: Node,
    pub unit: String,
    pub scale: D,
    pub layers: BTreeMap<String, String>,
    pub images: BTreeMap<String, Node>,
    pub stacks: BTreeMap<String, Node>,
    pub places: BTreeMap<String, Place>,
    pub members: BTreeMap<String, String>,
    pub nets: BTreeSet<String>,
    pub vias: Vec<Via>,
}
impl Dsn {
    pub fn new(text: &str, layers: &[String]) -> Result<Self> {
        let root = parse(text)?;
        let (unit, scale) = unit(&root)?;
        let actual = layer_types(&root)?;
        if layers.len() != 1
            || !matches!(layers[0].as_str(), "F.Cu" | "B.Cu")
            || actual.get(&layers[0]).map(String::as_str) != Some("signal")
            || actual
                .iter()
                .any(|(n, k)| k == "signal" && !layers.contains(n))
        {
            return Err("actual DSN routing layers differ from drilled proof".into());
        }
        let lib = one(&root, "library")?;
        let images = index(lib, "image")?;
        let stacks = index(lib, "padstack")?;
        for keys in [
            images.keys().map(|s| s.to_lowercase()).collect::<Vec<_>>(),
            stacks.keys().map(|s| normalize_stack(s)).collect(),
        ] {
            if keys.iter().collect::<BTreeSet<_>>().len() != keys.len() {
                return Err("ambiguous importer-normalized drilled names".into());
            }
        }
        let mut places = BTreeMap::new();
        for comp in one(&root, "placement")?.children("component") {
            let image = atom(comp, 1)?;
            if !images.contains_key(image) || comp.items().len() < 3 {
                return Err("missing drilled DSN image".into());
            }
            for p in comp.children("place") {
                if p.items().len() < 6
                    || places
                        .insert(
                            atom(p, 1)?.to_lowercase(),
                            Place {
                                image: image.into(),
                                form: p.clone(),
                            },
                        )
                        .is_some()
                {
                    return Err("ambiguous drilled component placement".into());
                }
            }
        }
        let mut nets = BTreeSet::new();
        let mut net_keys = BTreeSet::new();
        let mut members = BTreeMap::new();
        let mut member_keys = BTreeSet::new();
        for n in one(&root, "network")?.children("net") {
            let name = atom(n, 1)?;
            if n.items().len() < 3 || !net_keys.insert(name.to_lowercase()) {
                return Err("ambiguous drilled DSN net".into());
            }
            nets.insert(name.into());
            for item in one(n, "pins")?.items().iter().skip(1) {
                let pin = item.atom().ok_or("ambiguous drilled pin membership")?;
                if !member_keys.insert(pin.to_lowercase()) {
                    return Err("ambiguous drilled pin membership".into());
                }
                members.insert(pin.into(), name.into());
            }
        }
        let mut vias = Vec::new();
        let wiring: Vec<_> = root.children("wiring").collect();
        if wiring.len() > 1 {
            return Err("ambiguous DSN wiring".into());
        }
        if let Some(w) = wiring.first() {
            for via in w.children("via") {
                if via.items().len() != 6
                    || one(via, "net")?.items().len() != 2
                    || one(via, "type")?.items().len() != 2
                    || one(via, "type")?.text(1) != Some("fix")
                {
                    return Err("retained DSN via is not a fixed, single-center obstacle".into());
                }
                vias.push(Via {
                    stack: atom(via, 1)?.into(),
                    center: [num(via, 2)? * &scale, -num(via, 3)? * &scale],
                    net: atom(one(via, "net")?, 1)?.into(),
                    text: [atom(via, 2)?.into(), atom(via, 3)?.into()],
                });
            }
        }
        Ok(Self {
            root,
            unit,
            scale,
            layers: actual,
            images,
            stacks,
            places,
            members,
            nets,
            vias,
        })
    }
    pub fn image<'a>(&'a self, hole: &serde_json::Value) -> Result<(&'a str, &'a Node, &'a Node)> {
        let name = hole["reference"]
            .as_str()
            .ok_or("missing drilled reference")?;
        let place = self
            .places
            .get(&name.to_lowercase())
            .ok_or("native PTH missing from DSN placement")?;
        let p = &place.form;
        if p.text(1) != Some(name)
            || p.text(4) != Some("front")
            || angle(p, 5)? != dec::angle(&hole["footprint_rotation_deg"])?
            || [num(p, 2)? * &self.scale, -num(p, 3)? * &self.scale]
                != dec::pair(&hole["footprint_position_mm"])?
        {
            return Err("DSN drilled component pose/mirror differs from native".into());
        }
        let image = &self.images[&place.image];
        if image.child("side").is_some() {
            return Err("mirrored drilled image is unsupported".into());
        }
        let signature = |n: &Node| -> Result<_> {
            Ok((
                pins(n)?,
                n.children("keepout").cloned().collect::<Vec<_>>(),
                n.children("wire_keepout").cloned().collect::<Vec<_>>(),
            ))
        };
        for (alias, other) in &self.images {
            if normalize_image(alias) == normalize_image(&place.image)
                && signature(other)? != signature(image)?
            {
                return Err("ambiguous importer-normalized drilled package".into());
            }
        }
        Ok((&place.image, image, p))
    }
    pub fn shape<'a>(&'a self, stack: &str, layer: &str) -> Result<&'a Node> {
        let stack = self
            .stacks
            .get(stack)
            .ok_or("missing actual drilled padstack")?;
        let mut shapes = Vec::new();
        for s in stack.children("shape") {
            if s.items().len() != 2 || s.items()[1].items().len() < 3 {
                return Err("malformed drilled padstack".into());
            }
            let form = &s.items()[1];
            if matches!(form.text(1), Some("signal" | "pcb")) || form.text(1) == Some(layer) {
                shapes.push(form);
            }
        }
        if shapes.len() != 1 {
            return Err("missing or ambiguous drilled obstacle on routing layer".into());
        }
        Ok(shapes[0])
    }
    pub fn center(&self, p: &Node, xy: &Point) -> Result<Point> {
        let [dx, dy] = dec::rotate([&xy[0] * &self.scale, &xy[1] * &self.scale], angle(p, 5)?);
        Ok([
            num(p, 2)? * &self.scale + dx,
            -(num(p, 3)? * &self.scale + dy),
        ])
    }
}
pub fn layer_types(root: &Node) -> Result<BTreeMap<String, String>> {
    let mut layers = BTreeMap::new();
    for l in one(root, "structure")?.children("layer") {
        let kind = one(l, "type")?;
        if l.items().len() < 3
            || kind.items().len() != 2
            || !matches!(kind.text(1), Some("signal" | "power"))
            || layers
                .insert(atom(l, 1)?.into(), atom(kind, 1)?.into())
                .is_some()
        {
            return Err("ambiguous actual drilled DSN layer".into());
        }
    }
    Ok(layers)
}
/// Conservative lower bound across all potentially applicable declarations; no invented precedence.
pub struct Rules {
    pub root: Node,
    pub unit: String,
    pub scale: D,
    pub membership: BTreeMap<String, String>,
    pub allowed: BTreeMap<String, Vec<String>>,
    clearances: Vec<D>,
}
impl Rules {
    pub fn new(text: &str) -> Result<Self> {
        let root = parse(text)?;
        let (unit, scale) = unit(&root)?;
        let types = layer_types(&root)?;
        let signal: Vec<String> = types
            .iter()
            .filter(|(_, k)| *k == "signal")
            .map(|(k, _)| k.clone())
            .collect();
        let mut clearances = Vec::new();
        fn gather(n: &Node, scale: &D, out: &mut Vec<D>) -> Result<()> {
            if n.is("clearance") {
                let excluded = n.items().len() == 3
                    && n.items()[2].is("type")
                    && matches!(
                        n.items()[2].text(1),
                        Some("smd_smd" | "pin_pin" | "pin_smd")
                    );
                if !excluded {
                    let d = num(n, 1)? * scale;
                    if d < dec::zero() {
                        return Err("negative DSN clearance".into());
                    }
                    out.push(d);
                }
            }
            for c in n.items() {
                if c.atom().is_none() {
                    gather(c, scale, out)?;
                }
            }
            Ok(())
        }
        let structure = one(&root, "structure")?;
        let mut defaults = Vec::new();
        for r in structure.children("rule") {
            gather(r, &scale, &mut defaults)?;
        }
        if defaults.is_empty() {
            return Err("no explicit DSN fallback clearance".into());
        }
        gather(&root, &scale, &mut clearances)?;
        let classes = index(one(&root, "network")?, "class")?;
        let mut membership = BTreeMap::new();
        let mut allowed = BTreeMap::new();
        for (name, c) in &classes {
            let circuits: Vec<_> = c.children("circuit").collect();
            if circuits.len() > 1 {
                return Err("ambiguous DSN layer mask".into());
            }
            let masks: Vec<_> = circuits
                .iter()
                .flat_map(|c| c.children("use_layer"))
                .collect();
            if masks.len() > 1 {
                return Err("ambiguous DSN layer mask".into());
            }
            let layers = if let Some(m) = masks.first() {
                m.items()
                    .iter()
                    .skip(1)
                    .map(|v| {
                        v.atom()
                            .map(str::to_string)
                            .ok_or("invalid DSN layer mask".into())
                    })
                    .collect::<Result<Vec<_>>>()?
            } else {
                signal.clone()
            };
            if layers.is_empty()
                || layers.iter().collect::<BTreeSet<_>>().len() != layers.len()
                || !layers.iter().all(|n| signal.contains(n))
            {
                return Err("invalid DSN layer mask".into());
            }
            allowed.insert(name.clone(), layers);
            for net in c.items().iter().skip(2).filter_map(Node::atom) {
                if membership.insert(net.into(), name.clone()).is_some() {
                    return Err(format!("ambiguous DSN net membership: {net}"));
                }
            }
        }
        let mut pairs = BTreeSet::new();
        for cc in one(&root, "network")?.children("class_class") {
            let names = one(cc, "classes")?;
            if names.items().len() != 3
                || !classes.contains_key(atom(names, 1)?)
                || !classes.contains_key(atom(names, 2)?)
            {
                return Err("invalid DSN class-pair membership".into());
            }
            let mut key = [atom(names, 1)?, atom(names, 2)?];
            key.sort();
            if !pairs.insert(key.map(str::to_string)) {
                return Err("ambiguous DSN class-pair rules".into());
            }
        }
        Ok(Self {
            root,
            unit,
            scale,
            membership,
            allowed,
            clearances,
        })
    }
    pub fn allowed(&self, net: &str) -> Result<&[String]> {
        let c = self.membership.get(net).ok_or("missing DSN net class")?;
        Ok(&self.allowed[c])
    }
    pub fn floor(&self, left: &str, right: Option<&str>) -> Result<D> {
        self.allowed(left)?;
        // The unconnected net "" has no class: it is no second net, as in the core's clearance_floor.
        if let Some(r) = right.filter(|net| !net.is_empty()) {
            self.allowed(r)?;
        }
        self.clearances
            .iter()
            .min()
            .cloned()
            .ok_or("no attributable DSN clearance".into())
    }
}
