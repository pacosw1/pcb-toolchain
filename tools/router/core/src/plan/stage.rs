//! What a stage means for its router and its check: command lines, kept nets, limits.
use super::{DRC_UNCONNECTED_CAP, Stage, WidthRule};
use crate::model::text::glob_match;
use serde_json::Value;
use std::collections::{BTreeSet, HashSet};

impl WidthRule {
    /// A track gets `width_mm` when its midpoint is in the box, its layer is listed and it is wider.
    pub fn applies(&self, start: (f64, f64), end: (f64, f64), layer: &str, width_mm: f64) -> bool {
        let (x, y) = ((start.0 + end.0) / 2.0, (start.1 + end.1) / 2.0);
        let [x0, y0, x1, y1] = self.bounds;
        self.layers.iter().any(|l| l == layer) && x0 <= x && x <= x1 && y0 <= y && y <= y1 && width_mm > self.width_mm
    }
}

impl Stage {
    /// TraceMaker routes every open connection; the runner keeps only the new copper of `tracemaker_kept` afterwards.
    pub fn tracemaker_args(&self, copper: &[String], binary: &str, source: &str, output: &str, summary: &str) -> Vec<String> {
        let time = self.budget.time_s.to_string();
        let mut args: Vec<String> =
            [binary, "route", source, "-o", output, "--time", &time, "--json", summary].map(str::to_string).to_vec();
        if self.budget.threads != 0 {
            args.extend(["--threads".to_string(), self.budget.threads.to_string()]);
        }
        let blocked: Vec<&str> = copper.iter().filter(|layer| !self.layers.contains(layer)).map(String::as_str).collect();
        if !blocked.is_empty() {
            args.extend(["--no-tracks-on".to_string(), blocked.join(",")]);
        }
        if !self.plane_nets.is_empty() {
            args.push("--soft-zones".to_string());
        }
        if !self.only_nets.is_empty() {
            args.extend(["--first-nets".to_string(), self.only_nets.join(",")]);
        }
        args
    }

    fn keeps(&self, net: &str) -> bool {
        if self.only_nets.is_empty() {
            !self.skip_nets.iter().any(|pattern| glob_match(net, pattern))
        } else {
            self.only_nets.iter().any(|only| only == net)
        }
    }

    /// Nets whose new copper the stage keeps.
    pub fn kept_nets<'a>(&self, nets: &'a [String]) -> BTreeSet<&'a str> {
        nets.iter().map(String::as_str).filter(|net| self.keeps(net)).collect()
    }

    /// `kept_nets` plus the plane nets of the stage, because TraceMaker connects plane-net pads with its own copper.
    pub fn tracemaker_kept<'a>(&self, nets: &'a [String]) -> BTreeSet<&'a str> {
        let plane = |net: &str| self.only_nets.is_empty() && self.plane_nets.iter().any(|p| p == net);
        nets.iter().map(String::as_str).filter(|net| self.keeps(net) || plane(net)).collect()
    }

    /// `open_nets`: the net of each open connection after the stage; `vias`: vias on the stage nets.
    pub fn failures(&self, open_nets: &[String], vias: u64) -> Vec<String> {
        let mut out = Vec::new();
        let open = open_nets.iter().filter(|net| self.keeps(net)).count() as u64;
        if open > self.require_open {
            out.push(format!("stage {}: {open} open connections on its nets (limit {})", self.name, self.require_open));
        }
        if let Some(limit) = self.max_vias.filter(|limit| vias > *limit) {
            out.push(format!("stage {}: {vias} vias on its nets (limit {limit})", self.name));
        }
        out
    }
}

/// The net of each open connection in a kicad-cli DRC JSON report. A list at the KiCad cap is an error, not a count.
pub fn open_nets(drc: &Value) -> Result<Vec<String>, String> {
    let items = drc["unconnected_items"].as_array().map_or(&[][..], Vec::as_slice);
    if items.len() >= DRC_UNCONNECTED_CAP {
        return Err(format!("DRC lists {} open connections (cap {DRC_UNCONNECTED_CAP}): count unknown", items.len()));
    }
    items.iter().map(open_net).collect()
}

fn open_net(item: &Value) -> Result<String, String> {
    let parts = item["items"].as_array().map_or(&[][..], Vec::as_slice);
    let nets: HashSet<&str> = parts.iter().filter_map(|part| bracketed(part["description"].as_str()?)).collect();
    let mut nets = nets.into_iter();
    match (nets.next(), nets.next()) {
        (Some(net), None) => Ok(net.to_string()),
        _ => Err(format!("open connection without one net: {}", item.to_string().chars().take(200).collect::<String>())),
    }
}

/// The first non-empty text between `[` and the next `]`.
fn bracketed(text: &str) -> Option<&str> {
    let mut rest = text;
    loop {
        let open = rest.find('[')?;
        let inner = &rest[open + 1..];
        let close = inner.find(']')?;
        if close > 0 {
            return Some(&inner[..close]);
        }
        rest = inner;
    }
}
