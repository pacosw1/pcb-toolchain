//! A region's result, its output line and its place in the --json file.
use super::raster::Rect;
use crate::model::text::round_to;
use crate::pytext::repr_list;
use serde::Serialize;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Verdict {
    #[serde(rename = "PASS")]
    Pass,
    #[serde(rename = "FAIL")]
    Fail,
}

impl fmt::Display for Verdict {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(if *self == Verdict::Pass { "PASS" } else { "FAIL" })
    }
}

/// Where the competing nets run out of room.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Cut {
    pub cells: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layers: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bbox: Option<[f64; 4]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub near: Vec<String>,
}

/// One class alone on its own pitch and clearances.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ClassRun {
    pub demand_nets: Vec<String>,
    pub demand: usize,
    pub flow: i64,
    pub verdict: Verdict,
    pub unescaped: Vec<String>,
    pub contested: Vec<String>,
    pub cut: Option<Cut>,
    pub pitch_mm: Option<f64>,
    pub pitch_class: Option<String>,
}

impl ClassRun {
    pub fn of(region: &Region) -> ClassRun {
        ClassRun {
            demand_nets: region.demand_nets.clone(),
            demand: region.demand,
            flow: region.flow,
            verdict: region.verdict,
            unescaped: region.unescaped.clone(),
            contested: region.contested.clone(),
            cut: region.cut.clone(),
            pitch_mm: region.pitch_mm,
            pitch_class: region.pitch_class.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Region {
    pub region: String,
    pub rect: [f64; 4],
    pub demand_nets: Vec<String>,
    pub demand: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pitch_mm: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pitch_class: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub neck_mm: Option<f64>,
    pub flow: i64,
    pub verdict: Verdict,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grid: Option<[usize; 3]>,
    pub unescaped: Vec<String>,
    pub cut: Option<Cut>,
    pub contested: Vec<String>,
    pub time_s: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub per_class: Option<Vec<ClassRun>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub failed_classes: Vec<String>,
}

impl Region {
    /// A region with its demand and no flow yet: with no demand it stands as a PASS.
    pub fn new(name: &str, rect: Rect, demand: &[String]) -> Region {
        Region {
            region: name.to_string(),
            rect: rect.map(|v| round_to(v, 3)),
            demand_nets: demand.to_vec(),
            demand: demand.len(),
            pitch_mm: None,
            pitch_class: None,
            neck_mm: None,
            flow: 0,
            verdict: Verdict::Pass,
            grid: None,
            unescaped: Vec::new(),
            cut: None,
            contested: Vec::new(),
            time_s: 0.0,
            per_class: None,
            failed_classes: Vec::new(),
        }
    }

    /// Takes in a failed run of one class.
    pub fn absorb(&mut self, run: Region, class: &str) {
        if run.verdict == Verdict::Pass {
            return;
        }
        if self.verdict == Verdict::Pass {
            self.cut = run.cut;
        }
        self.verdict = Verdict::Fail;
        add_new(&mut self.unescaped, run.unescaped);
        add_new(&mut self.contested, run.contested);
        self.failed_classes.push(class.to_string());
    }

    /// "PIN_ESCAPE PASS|FAIL region ... demand D flow F unescaped [...] cut [...]".
    pub fn line(&self) -> String {
        let cut = self.cut.as_ref().map_or("[]".to_string(), |cut| {
            let layers = cut.layers.as_ref().map_or(String::new(), |l| l.join("/"));
            let bbox = cut.bbox.as_ref().map_or("-".to_string(), |b| floats(b));
            let near = cut.near.iter().take(SHOWN_NAMES).cloned().collect::<Vec<_>>().join(", ");
            format!("[{} cells {layers} bbox {bbox} near {near}]", cut.cells)
        });
        let failed = if self.failed_classes.is_empty() { String::new() } else { format!(" failed_classes {}", repr_list(&self.failed_classes)) };
        let pitch = self.pitch_mm.map_or("-".to_string(), |p| format!("{p:?}"));
        let class = self.pitch_class.as_deref().unwrap_or("-");
        format!(
            "PIN_ESCAPE {} region {} {} demand {} flow {}{failed} unescaped {} contested {} cut {cut} pitch {pitch} mm ({class}) {:?} s",
            self.verdict, self.region, floats(&self.rect), self.demand, self.flow, repr_list(&self.unescaped), repr_list(&self.contested), self.time_s
        )
    }
}

/// How many names of the cut a line shows.
const SHOWN_NAMES: usize = 5;

fn add_new(to: &mut Vec<String>, names: Vec<String>) {
    for name in names {
        if !to.contains(&name) {
            to.push(name);
        }
    }
}

/// A list of floats as Python prints it.
pub fn floats(values: &[f64]) -> String {
    format!("[{}]", values.iter().map(|v| format!("{v:?}")).collect::<Vec<_>>().join(", "))
}

/// Names counted in the order they first came.
#[derive(Default)]
pub struct Tally {
    counts: Vec<(String, usize)>,
}

impl Tally {
    pub fn add(&mut self, name: &str) {
        match self.counts.iter_mut().find(|(n, _)| n == name) {
            Some((_, count)) => *count += 1,
            None => self.counts.push((name.to_string(), 1)),
        }
    }

    /// The names most counted; a tie goes to the name that came first.
    pub fn most_common(mut self, limit: usize) -> Vec<String> {
        self.counts.sort_by_key(|(_, count)| std::cmp::Reverse(*count));
        self.counts.into_iter().take(limit).map(|(name, _)| name).collect()
    }
}
