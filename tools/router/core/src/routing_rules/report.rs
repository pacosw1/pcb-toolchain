use super::{Disc, distance, matches};
use iotroute::model::text::round_to;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub type Via = (String, f64, f64, f64);

#[derive(Debug, Default, Deserialize, Serialize)]
pub struct Counts {
    pub nets: usize,
    pub vias: usize,
    pub max: usize,
    pub per_net: BTreeMap<String, usize>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct MissingGround {
    pub net: String,
    pub x: f64,
    pub y: f64,
    pub nearest_gnd_mm: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct HotLengths {
    pub max_mm: f64,
    pub length_mm: f64,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct HotReport {
    #[serde(flatten)]
    pub lengths: HotLengths,
    pub vias: usize,
    pub within: bool,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ViaReport {
    pub by_stage: BTreeMap<String, Counts>,
    pub by_class: BTreeMap<String, Counts>,
    pub fast_no_gnd: Vec<MissingGround>,
    pub via_allow_mm: f64,
    pub hot_loops: BTreeMap<String, HotReport>,
}

#[derive(Debug, Default, Deserialize)]
pub struct ReportOptions {
    #[serde(default)]
    pub net_stage: BTreeMap<String, String>,
    #[serde(default)]
    pub net_class: BTreeMap<String, String>,
    #[serde(default)]
    pub fast: Vec<String>,
    #[serde(default)]
    pub grounds: BTreeSet<String>,
    #[serde(default)]
    pub gnd_anchors: Vec<Disc>,
    pub via_allow: f64,
    #[serde(default)]
    pub hot: BTreeMap<String, HotLengths>,
}

pub fn via_report(vias: &[Via], options: &ReportOptions) -> ViaReport {
    let mut per_net = BTreeMap::<String, usize>::new();
    for (net, ..) in vias {
        *per_net.entry(net.clone()).or_default() += 1;
    }
    let (mut by_stage, mut by_class) = (
        BTreeMap::<String, Counts>::new(),
        BTreeMap::<String, Counts>::new(),
    );
    for (net, &n) in &per_net {
        if options.grounds.contains(net) {
            continue;
        }
        for (table, key) in [
            (
                &mut by_stage,
                options.net_stage.get(net).map_or("other", String::as_str),
            ),
            (
                &mut by_class,
                options.net_class.get(net).map_or("?", String::as_str),
            ),
        ] {
            let e = table.entry(key.into()).or_default();
            e.nets += 1;
            e.vias += n;
            e.max = e.max.max(n);
            e.per_net.insert(net.clone(), n);
        }
    }
    let mut anchors = options.gnd_anchors.clone();
    anchors.sort_by(|a, b| {
        a[0].total_cmp(&b[0])
            .then(a[1].total_cmp(&b[1]))
            .then(a[2].total_cmp(&b[2]))
    });
    let reach = anchors.iter().map(|a| a[2]).fold(0.0, f64::max);
    let mut missing = Vec::new();
    for (net, x, y, r) in vias {
        if options.grounds.contains(net) || !matches(net, &options.fast) {
            continue;
        }
        let lo = anchors.partition_point(|a| a[0] < x - r - reach - options.via_allow);
        let hi = anchors.partition_point(|a| a[0] <= x + r + reach + options.via_allow);
        let best = anchors[lo..hi]
            .iter()
            .map(|a| distance([*x, *y], [a[0], a[1]]) - r - a[2])
            .fold(f64::INFINITY, f64::min);
        if best > options.via_allow {
            missing.push(MissingGround {
                net: net.clone(),
                x: round_to(*x, 3),
                y: round_to(*y, 3),
                nearest_gnd_mm: best.is_finite().then(|| round_to(best, 3)),
            });
        }
    }
    let hot_loops = options
        .hot
        .iter()
        .map(|(n, h)| {
            (
                n.clone(),
                HotReport {
                    lengths: h.clone(),
                    vias: per_net.get(n).copied().unwrap_or(0),
                    within: h.length_mm <= h.max_mm,
                },
            )
        })
        .collect();
    ViaReport {
        by_stage,
        by_class,
        fast_no_gnd: missing,
        via_allow_mm: options.via_allow,
        hot_loops,
    }
}

pub fn summary_line(report: &ViaReport) -> String {
    let stages = report
        .by_stage
        .iter()
        .map(|(n, c)| format!("{n}={}/{}", c.vias, c.nets))
        .collect::<Vec<_>>()
        .join(" ");
    let mut line = format!(
        "VIAS_BY_STAGE {} (vias/nets) FAST_VIA_NO_GND {}",
        if stages.is_empty() { "-" } else { &stages },
        report.fast_no_gnd.len()
    );
    if !report.hot_loops.is_empty() {
        let ok = report.hot_loops.values().filter(|h| h.within).count();
        line += &format!(" HOT_LOOPS {ok}/{} within ", report.hot_loops.len());
        line += &report
            .hot_loops
            .iter()
            .map(|(n, h)| {
                format!(
                    "{n}={}/{}mm,{}via",
                    general(h.lengths.length_mm),
                    general(h.lengths.max_mm),
                    h.vias
                )
            })
            .collect::<Vec<_>>()
            .join(" ");
    }
    line
}

// Python's :g has six significant digits, choosing scientific notation outside [-4, 6).
fn general(value: f64) -> String {
    let scientific = format!("{value:.5e}");
    let (mantissa, exponent) = scientific.split_once('e').unwrap();
    let exp: i32 = exponent.parse().unwrap();
    let trim = |s: String| {
        if s.contains('.') {
            s.trim_end_matches('0').trim_end_matches('.').to_string()
        } else {
            s
        }
    };
    if !(-4..6).contains(&exp) {
        format!("{}e{exp:+03}", trim(mantissa.into()))
    } else {
        trim(format!(
            "{value:.digits$}",
            digits = (5 - exp).max(0) as usize
        ))
    }
}
