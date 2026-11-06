//! Gate scope of the reference rule (DESIGN 5b, 2026-11-02). The core prices the off-reference runs of the soft nets; which of them
//! are legal is decided by the gate's own si_planes screen on the written board, never by a copy of its thresholds. A soft net with
//! a FAIL line gets a higher price, then it is set hard, and the board is routed again.
use super::project::gate_path;
use super::record::RouteClaim;
use super::reuse::{FeedbackBinding, ReuseRecord};
use serde::Serialize;
use serde::Deserialize;
use serde_json::value::{RawValue, to_raw_value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

pub const ROUNDS: usize = 4;
/// Search preferences of the reference price, the legality is si_planes': core DEF_REF_COST, x10 per failed round, at most two
/// raises, then the net is hard.
const COST_START: f64 = 3.0;
const COST_RAISE: f64 = 10.0;
const RAISES: i32 = 2;
const FAIL_KINDS: [&str; 4] = ["domain-cross", "fast-crossing", "unknown-driver", "detour"];

#[derive(Debug, Clone, Serialize)]
pub struct Round {
    pub round: usize,
    pub planes_fail_lines: usize,
    pub fail_nets: Vec<String>,
    pub raised: Vec<String>,
    pub set_hard: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_core: Option<Option<RouteClaim>>,
    /// Measured child-process wall time, including core finalization, not just negotiation passes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_core_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reuse: Option<FeedbackReuse>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FeedbackReuse {
    pub status: &'static str,
    pub selected: &'static str,
    pub elapsed_s: Option<f64>,
    pub binding: Option<FeedbackBinding>,
    pub record: Option<ReuseRecord>,
    pub scoped_planes_fail_lines: Option<usize>,
    pub fallback_reason: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct RefGate {
    pub rounds: Vec<Round>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<&'static str>,
}

/// The net of a D-124c reference FAIL line of the planes check: `FAIL <kind> <layer> <net>: ...`.
pub fn failed_net(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("FAIL ")?;
    let (kind, rest) = rest.split_once(' ')?;
    if !FAIL_KINDS.contains(&kind) {
        return None;
    }
    let (layer, rest) = rest.split_once(' ')?;
    let (net, _) = rest.split_once(':')?;
    (!layer.is_empty() && !net.is_empty() && !net.contains(char::is_whitespace)).then_some(net)
}

/// (nets with a reference FAIL line, all FAIL lines) of the screen's output.
pub fn fail_lines(text: &str) -> (Vec<String>, usize) {
    let lines: Vec<&str> = text.lines().filter(|l| l.starts_with("FAIL ")).collect();
    let nets: BTreeSet<String> = lines.iter().filter_map(|l| failed_net(l)).map(str::to_string).collect();
    (nets.into_iter().collect(), lines.len())
}

#[derive(Deserialize)]
struct Gate {
    #[serde(default)]
    checks: Checks,
}

#[derive(Default, Deserialize)]
struct Checks {
    planes: Option<String>,
}

/// The gate's planes spec file, when it has a planes check.
pub fn planes_spec(board_dir: &Path) -> Result<Option<String>, String> {
    let Some(path) = gate_path(board_dir) else { return Ok(None) };
    let text = fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let gate: Gate = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(gate.checks.planes.filter(|p| !p.is_empty()))
}

type RawObject = BTreeMap<String, Box<RawValue>>;

/// The model as text with its nets open. Every other value stays the text it was: a parse and print could move a number.
pub struct ModelFile {
    top: RawObject,
    nets: BTreeMap<String, RawObject>,
}

impl ModelFile {
    pub fn read(path: &Path) -> Result<ModelFile, String> {
        let text = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut top: RawObject = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        let nets = top.remove("nets").ok_or("a model with no nets")?;
        let nets = serde_json::from_str(nets.get()).map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(ModelFile { top, nets })
    }

    pub fn write(&self, path: &Path) -> Result<(), String> {
        let mut all: BTreeMap<&str, Box<RawValue>> = self.top.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
        all.insert("nets", to_raw_value(&self.nets).map_err(|e| e.to_string())?);
        fs::write(path, serde_json::to_string(&all).map_err(|e| e.to_string())?).map_err(|e| format!("{}: {e}", path.display()))
    }

    fn field(&self, net: &str, key: &str) -> Option<&str> {
        self.nets.get(net)?.get(key).map(|v| v.get())
    }

    fn is_soft(&self, net: &str) -> bool {
        self.field(net, "ref_soft") == Some("true")
    }

    pub fn has_soft_net(&self) -> bool {
        self.nets.keys().any(|n| self.is_soft(n))
    }

    fn set(&mut self, net: &str, key: &str, value: impl Serialize) -> Result<(), String> {
        let raw = to_raw_value(&value).map_err(|e| e.to_string())?;
        self.nets.get_mut(net).ok_or("a net of the model")?.insert(key.to_string(), raw);
        Ok(())
    }

    /// A failed soft net: its off-reference price up, so the router takes the shortest off-reference run, which the gate may
    /// accept (J1.3 /ETH_CT); after the last raise it is set hard, blocked as before. -> (soft nets, raised, set hard).
    pub fn raise(&mut self, failed: &[String]) -> Result<(Vec<String>, Vec<String>, Vec<String>), String> {
        let soft: Vec<String> = failed.iter().filter(|n| self.is_soft(n)).cloned().collect();
        let (mut raised, mut hard) = (Vec::new(), Vec::new());
        for net in &soft {
            let cost = self.field(net, "ref_cost").and_then(|c| c.parse().ok()).unwrap_or(COST_START);
            if cost < COST_START * COST_RAISE.powi(RAISES) {
                self.set(net, "ref_cost", cost * COST_RAISE)?;
                raised.push(net.clone());
            } else {
                self.set(net, "ref_soft", false)?;
                hard.push(net.clone());
            }
        }
        Ok((soft, raised, hard))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fail_line_names_its_net() {
        let lines = [
            ("FAIL unknown-driver B.Cu /ETH_CT: 1 of 1 crossings need an edge time (longest run 1.5 mm at (121.8, 113.8))", "/ETH_CT"),
            ("FAIL detour F.Cu /SPI_SCK: 1 of 2 crossings with a return detour > 13.4 mm or no reference path", "/SPI_SCK"),
            ("FAIL domain-cross F.Cu /AI1: 0.6 mm over ISO_0V (domain GND)", "/AI1"),
            ("FAIL fast-crossing F.Cu /ETH_TXP: 1 crossings, longest 0.40 mm at (1.0, 2.0)", "/ETH_TXP"),
        ];
        for (line, net) in lines {
            assert_eq!(failed_net(line), Some(net), "{line}");
        }
        for line in ["FAIL no-domain /X: no pad in a ground zone outline; set \"domains\" or \"exempt\"", "WARN D-124d-proposed unknown-driver B.Cu /ETH_CT: report-only", "0 reference-plane failures"] {
            assert_eq!(failed_net(line), None, "{line}");
        }
    }

    #[test]
    fn fail_lines_count_all_and_name_the_reference_ones() {
        let (nets, count) = fail_lines("FAIL detour F.Cu /B: x\nFAIL no-domain /X: y\nFAIL detour B.Cu /A: z\nFAIL detour F.Cu /A: z\nok\n");
        assert_eq!(nets, ["/A", "/B"]);
        assert_eq!(count, 4);
    }

    fn model(nets: &str) -> ModelFile {
        let path = std::env::temp_dir().join(format!("iotroute-ref-{}-{:?}.json", std::process::id(), std::thread::current().id()));
        fs::write(&path, format!(r#"{{"schema": "x", "width": 0.30000000000000004, "nets": {nets}}}"#)).unwrap();
        let m = ModelFile::read(&path).unwrap();
        fs::remove_file(&path).unwrap();
        m
    }

    #[test]
    fn no_soft_net_means_no_round() {
        assert!(!model(r#"{"A": {"ref_domain": "GND", "ref_soft": false}}"#).has_soft_net());
        assert!(model(r#"{"A": {"ref_soft": true}}"#).has_soft_net());
    }

    #[test]
    fn a_soft_net_rises_twice_then_is_hard() {
        let mut m = model(r#"{"A": {"ref_soft": true}, "B": {"ref_soft": false}}"#);
        let failed = ["A".to_string(), "B".to_string()];
        assert_eq!(m.raise(&failed).unwrap().1, ["A"]);
        assert_eq!(m.field("A", "ref_cost"), Some("30.0"));
        m.raise(&failed).unwrap();
        assert_eq!(m.field("A", "ref_cost"), Some("300.0"));
        let (soft, raised, hard) = m.raise(&failed).unwrap();
        assert_eq!((soft.len(), raised.len(), hard), (1, 0, vec!["A".to_string()]));
        assert!(!m.is_soft("A"));
    }

    #[test]
    fn the_rest_of_the_model_keeps_its_text() {
        let m = model(r#"{"A": {"width": 0.1234567890123456789}}"#);
        let path = std::env::temp_dir().join(format!("iotroute-ref-out-{}.json", std::process::id()));
        m.write(&path).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        fs::remove_file(&path).unwrap();
        assert!(text.contains("0.30000000000000004") && text.contains("0.1234567890123456789"));
    }
}
