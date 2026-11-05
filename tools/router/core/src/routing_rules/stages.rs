use super::{Point, Rect, ReferenceSpec, distance, matches};
use iotroute::model::text::round_to;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

pub const STAGES: [&str; 4] = ["pairs_clocks", "fast", "wide", "rest"];
/// IPC-7351B: fine pitch is at most 0.65 mm.
pub const FINE_PITCH_MM: f64 = 0.65;

pub fn default_clocks() -> Vec<String> {
    ["*CLK*", "*SCK*", "*XTAL*", "*OSC*"]
        .map(String::from)
        .to_vec()
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct BoardInfo {
    pub spec: ReferenceSpec,
    pub fast: Vec<String>,
    pub pairs: Vec<String>,
    pub current: Vec<String>,
    #[serde(default = "default_clocks")]
    pub clocks: Vec<String>,
    pub switch: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct Config {
    pub clock_patterns: Option<Vec<String>>,
    pub switch_nodes: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct CurrentPath {
    pub switch_node: bool,
    pub pads: Vec<String>,
    pub chains: Vec<CurrentPath>,
}

fn load<T: serde::de::DeserializeOwned + Default>(dir: &Path, name: &str) -> Result<T, String> {
    let path = dir.join(name);
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

pub fn board_info(dir: Option<&Path>, cfg: &Config) -> Result<BoardInfo, String> {
    let mut info = BoardInfo {
        clocks: cfg.clock_patterns.clone().unwrap_or_else(default_clocks),
        ..BoardInfo::default()
    };
    let Some(dir) = dir.filter(|p| !p.as_os_str().is_empty()) else {
        info.switch = switch_nodes(&BTreeMap::new(), &cfg.switch_nodes);
        return Ok(info);
    };
    info.spec = load(dir, "reference-planes.json")?;
    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct Fast {
        fast: Vec<String>,
    }
    info.fast = load::<Fast>(dir, "rp001-fast-nets.json")?.fast;
    for file in info.spec.fast_file.iter().chain(
        info.spec
            .mixed_layers
            .values()
            .filter_map(|m| m.fast_file.as_ref()),
    ) {
        for p in load::<Fast>(dir, file)?.fast {
            if !info.fast.contains(&p) {
                info.fast.push(p);
            }
        }
    }
    #[derive(Deserialize)]
    struct Pair {
        p: String,
        n: String,
    }
    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct Pairs {
        pairs: Vec<Pair>,
    }
    info.pairs = load::<Pairs>(dir, "diff-pairs.json")?
        .pairs
        .into_iter()
        .flat_map(|p| [p.p, p.n])
        .collect();
    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct Current {
        nets: BTreeMap<String, CurrentPath>,
    }
    let current = load::<Current>(dir, "current-paths.json")?.nets;
    info.current = current.keys().cloned().collect();
    info.switch = switch_nodes(&current, &cfg.switch_nodes);
    Ok(info)
}

pub fn exempt(net: &str, info: &BoardInfo, planes: &BTreeSet<String>) -> bool {
    planes.contains(net)
        || info.spec.grounds.iter().any(|g| g == net)
        || matches(net, &info.spec.power_patterns())
        || info.spec.exempt.nets.contains_key(net)
}

pub fn stage_of(
    net: &str,
    info: &BoardInfo,
    classes: &BTreeMap<String, String>,
    wide: &BTreeSet<String>,
) -> &'static str {
    if info.pairs.iter().any(|n| n == net) || matches(net, &info.clocks) {
        "pairs_clocks"
    } else if info.current.iter().any(|n| n == net)
        || classes.get(net).is_some_and(|c| wide.contains(c))
        || matches(net, &info.spec.power_patterns())
    {
        "wide"
    } else if matches(net, &info.fast) {
        "fast"
    } else {
        "rest"
    }
}

pub type Stage = (String, Vec<String>, bool);

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct PlanOptions {
    pub net_class: BTreeMap<String, String>,
    pub wide_classes: BTreeSet<String>,
    pub planes: BTreeSet<String>,
    pub escape: BTreeSet<String>,
    pub hot: BTreeSet<String>,
}

fn split(
    plan: &mut Vec<Stage>,
    stage: &str,
    nets: Vec<String>,
    info: &BoardInfo,
    planes: &BTreeSet<String>,
) {
    let (pwr, sig): (Vec<_>, Vec<_>) = nets.into_iter().partition(|n| exempt(n, info, planes));
    if !sig.is_empty() {
        plan.push((stage.into(), sig, true));
    }
    if !pwr.is_empty() {
        plan.push((format!("{stage}_exempt"), pwr, false));
    }
}

pub fn stage_plan(nets: &[String], info: &BoardInfo, options: &PlanOptions) -> Vec<Stage> {
    let mut groups: BTreeMap<&str, Vec<String>> = STAGES.map(|s| (s, Vec::new())).into();
    let mut nets = nets.to_vec();
    nets.sort();
    for net in nets {
        if !options.planes.contains(&net) {
            groups
                .get_mut(stage_of(
                    &net,
                    info,
                    &options.net_class,
                    &options.wide_classes,
                ))
                .unwrap()
                .push(net);
        }
    }
    let escape: Vec<_> = options
        .escape
        .iter()
        .filter(|n| groups["wide"].contains(n) || groups["rest"].contains(n))
        .cloned()
        .collect();
    let (hot, wide) = groups
        .remove("wide")
        .unwrap()
        .into_iter()
        .partition(|n| options.hot.contains(n));
    groups.insert("wide", wide);
    let mut plan = Vec::new();
    for s in STAGES {
        if s == "wide" {
            if !escape.is_empty() {
                plan.push(("escape".into(), escape.clone(), false));
            }
            split(&mut plan, "wide_hot", hot.clone(), info, &options.planes);
        }
        split(
            &mut plan,
            s,
            groups.remove(s).unwrap(),
            info,
            &options.planes,
        );
    }
    plan
}

pub fn footprint_pitch(points: &[Point]) -> Option<f64> {
    let mut points = points.to_vec();
    points.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
    let mut best = f64::INFINITY;
    for (i, p) in points.iter().enumerate() {
        for q in &points[i + 1..] {
            if q[0] - p[0] >= best {
                break;
            }
            best = best.min(distance(*p, *q));
        }
    }
    best.is_finite().then_some(best)
}

pub fn fine_pitch_refs(pads: &BTreeMap<String, Vec<Point>>, limit: f64) -> BTreeMap<String, f64> {
    pads.iter()
        .filter_map(|(r, p)| {
            footprint_pitch(p)
                .filter(|v| *v <= limit + 1e-6)
                .map(|v| (r.clone(), round_to(v, 4)))
        })
        .collect()
}

pub fn escape_nets(
    pads: &[(String, String, bool)],
    fine: &BTreeMap<String, f64>,
    nets: &BTreeSet<String>,
    exclude: &BTreeSet<String>,
) -> Vec<String> {
    pads.iter()
        .filter(|(r, n, smd)| {
            *smd && !n.is_empty()
                && fine.contains_key(r)
                && nets.contains(n)
                && !exclude.contains(n)
        })
        .map(|(_, n, _)| n.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

pub fn belt_margin(width: f64, clearance: f64, via: f64) -> f64 {
    // Two staggered via rows, a track, and their clearances, from the board's Default class.
    clearance + 2.0 * (via + clearance) + width + clearance
}

pub fn switch_nodes(
    current: &BTreeMap<String, CurrentPath>,
    names: &[String],
) -> BTreeMap<String, Vec<String>> {
    let mut out = BTreeMap::new();
    for (n, e) in current {
        if e.switch_node || names.contains(n) {
            out.insert(
                n.clone(),
                if e.pads.is_empty() {
                    e.chains.first().map(|c| c.pads.clone()).unwrap_or_default()
                } else {
                    e.pads.clone()
                },
            );
        }
    }
    for n in names {
        out.entry(n.clone()).or_default();
    }
    out
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
pub struct HotLoop {
    pub straight_mm: f64,
    pub max_mm: f64,
    pub margin_mm: f64,
    pub ends: Vec<String>,
    pub r#box: Rect,
}

pub fn hot_loop(
    pads: &BTreeMap<String, Point>,
    loop_pads: &[String],
    factor: f64,
    margin_min: f64,
) -> Option<HotLoop> {
    let points: Vec<_> = pads.values().copied().collect();
    let first = *points.first()?;
    let ends = if loop_pads.len() >= 2 {
        vec![loop_pads[0].clone(), loop_pads.last()?.clone()]
    } else {
        Vec::new()
    };
    let d = if ends.len() == 2 && ends.iter().all(|p| pads.contains_key(p)) {
        distance(pads[&ends[0]], pads[&ends[1]])
    } else {
        points
            .iter()
            .flat_map(|p| points.iter().map(move |q| distance(*p, *q)))
            .fold(0.0, f64::max)
    };
    let max = factor * d;
    let margin = ((max - d) / 2.0).max(margin_min);
    let bbox = points
        .iter()
        .fold([first[0], first[1], first[0], first[1]], |b, p| {
            [
                b[0].min(p[0]),
                b[1].min(p[1]),
                b[2].max(p[0]),
                b[3].max(p[1]),
            ]
        });
    Some(HotLoop {
        straight_mm: round_to(d, 3),
        max_mm: round_to(max, 3),
        margin_mm: round_to(margin, 3),
        ends,
        r#box: super::geometry::grow(bbox, margin),
    })
}
