//! RP-001 scope of the gate: the nets whose layer changes the gate never checks for a return via. The router applies RP-001 in exactly
//! this scope, never stricter (lead decision 2026-11-02).
//!
//! kicad-happy drops a net from RP-001 in two places, by name and by the schematic's power rails:
//!  1. skills/kicad/scripts/analyze_pcb.py analyze_layer_transitions: `is_power_net_name(name, power_rails) or is_ground_name(name)`
//!     gets no layer_transitions entry (kicad_utils.py). power_rails is statistics.power_rails of analyze_schematic.py.
//!  2. skills/emc/scripts/emc_rules.py check_layer_transition_stitching: a net with `_is_power_or_ground(name)` is skipped.
//!
//! The rails still come from the pinned clone itself. The three name rules are a transcription of commit PINNED_COMMIT, the pin of
//! tools/kicad_happy_gate.ts: the pin check below stops a clone at any other commit, and a pin bump must compare them again.
use super::returns::RpScope;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const PINNED_COMMIT: &str = "a6bba1a";
const DEFAULT_PYTHON: &str = "python3";
const SCHEMATIC_SCRIPT: &str = "skills/kicad/scripts/analyze_schematic.py";

const GROUND_EXACT: &[&str] = &["GND", "VSS", "AGND", "DGND", "PGND", "GNDPWR", "GNDA", "GNDD", "SGND", "COM", "0V"];
const BATTERY_NEGATIVE: &[&str] = &["BATT-", "BAT-", "VBAT-", "VBATT-", "BATTERY-", "BATT_N", "BAT_N", "VBAT_N"];
const POWER_EXACT: &[&str] = &[
    "GND", "VSS", "AGND", "DGND", "PGND", "GNDPWR", "GNDA", "GNDD", "VCC", "VDD", "AVCC", "AVDD", "DVCC", "DVDD", "VBUS", "VAA", "VIO",
    "VMAIN", "VPWR", "VSYS", "VBAT", "VCORE", "VIN", "VOUT", "VREG", "VBATT", "V3P3", "V1P8", "V1P2", "V2P5", "V5P0", "V12P0", "VCCA",
    "VCCD", "VCCIO", "VDDA", "VDDD", "VDDIO",
];
const POWER_FIRST_SEGMENT: &[&str] = &[
    "VDD", "VCC", "AVDD", "AVCC", "DVDD", "DVCC", "VBAT", "VBATT", "VSYS", "VBUS", "VMAIN", "VPWR", "VCORE", "VDDIO", "VCCIO", "VIN",
    "VOUT", "VREG", "POW", "PWR", "VMOT", "VHEAT", "REGIN", "REGOUT",
];
const SIGNAL_PREFIXES: &[&str] = &[
    "PWM", "EN", "ENABLE", "GATE", "SENSE", "SNS", "LEVEL", "TX", "RX", "SDA", "SCL", "SCK", "MOSI", "MISO", "CS", "SS", "INT", "IRQ", "RST",
    "RESET", "DIR", "STEP", "CLK", "CLOCK", "ALERT", "FAULT", "FLAG", "IO", "GPIO", "INTR", "TRIG", "SYNC", "CTRL", "DATA", "SIG", "DRV", "FB",
    "COMP", "ADC", "DAC",
];
const POWER_PREFIXES: &[&str] = &[
    "RAW", "FUSED", "SW", "SWITCHED", "FILT", "FILTERED", "USB", "SYS", "MAIN", "AUX", "BAT", "BATT", "DC", "EXT", "VREG", "REG", "CLEAN",
    "ISO", "BACKUP", "PWR", "BOARD", "MCU", "BOOST", "BUCK", "LDO",
];
const SUPPLY_TAILS: &[&str] = &["VCC", "VDD", "AVCC", "AVDD", "DVCC", "DVDD", "VCCIO", "VDDIO"];
const RAIL_TAILS_GATED: &[&str] = &["VBUS", "VIN", "VBAT", "VBATT", "VSYS", "VREG"];
const VOLTAGE_SIGNAL_SUFFIXES: &[&str] = &["EN", "ENABLE", "ON", "OFF", "FB", "PG", "OK", "DET", "SENSE"];
const EMC_PREFIXES: &[&str] = &[
    "gnd", "vcc", "vdd", "vss", "vee", "v+", "v-", "+3v", "+5v", "+12v", "+1v", "+2v", "+24v", "+48v", "3v3", "5v0", "1v8", "1v2", "0v9",
    "2v5", "vbat", "vin", "vbus", "vsys", "vmot", "vmotor", "vpwr", "vm", "avcc", "avdd", "dvcc", "dvdd", "agnd", "dgnd", "pgnd", "earth",
    "pwr", "power",
];

/// The last part of a hierarchical net name, upper case.
fn leaf(name: &str) -> String {
    name.rsplit('/').next().unwrap_or(name).to_uppercase()
}

fn digits(text: &str) -> &str {
    &text[..text.find(|c: char| !c.is_ascii_digit()).unwrap_or(text.len())]
}

/// What follows `<digits>V` at the start of `text`, with the digits.
fn after_voltage(text: &str) -> Option<(&str, &str)> {
    let count = digits(text);
    (!count.is_empty()).then(|| text[count.len()..].strip_prefix('V').map(|rest| (count, rest)))?
}

/// What follows a zero-volt spelling (`+0V`, `00V`) that no digit continues: `0V9` is a sub-1 V rail, not ground (KH-407).
fn after_zero_volt(name: &str) -> Option<&str> {
    let zeros = name.strip_prefix('+').unwrap_or(name);
    let rest = zeros.trim_start_matches('0');
    if rest.len() == zeros.len() {
        return None;
    }
    rest.strip_prefix('V').filter(|rest| !rest.starts_with(|c: char| c.is_ascii_digit()))
}

fn upper_alnum(text: &str, extra: char) -> bool {
    text.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == extra)
}

/// kicad_utils.is_ground_name.
pub fn is_ground_name(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    let nu = leaf(name);
    let nu = nu.as_str();
    let zero_volt = after_zero_volt(nu).is_some_and(|rest| rest.is_empty() || (rest.starts_with(|c: char| c.is_ascii_uppercase() || c == '_') && upper_alnum(rest, '_')));
    GROUND_EXACT.contains(&nu) || zero_volt || BATTERY_NEGATIVE.contains(&nu) || nu.starts_with("GND") || nu.ends_with("GND") || nu.starts_with("VSS")
}

/// `<power-prefix>_<voltage>`, `<anything>_<supply-tail>` and `<power-prefix>_VOUT`. Signal prefixes stay signals.
fn descriptive_rail(first: &str, last: &str) -> bool {
    if SUPPLY_TAILS.contains(&last) {
        return true;
    }
    if SIGNAL_PREFIXES.contains(&first) {
        return false;
    }
    let voltage = after_voltage(last).is_some_and(|(_, rest)| upper_alnum(rest, '0'));
    RAIL_TAILS_GATED.contains(&last) || (POWER_PREFIXES.contains(&first) && (last == "VOUT" || voltage))
}

/// kicad_utils.is_power_net_name.
pub fn is_power_net_name(name: &str, power_rails: &BTreeSet<String>) -> bool {
    if name.is_empty() {
        return false;
    }
    if power_rails.contains(name) {
        return true;
    }
    let nu = leaf(name);
    let nu = nu.as_str();
    if after_zero_volt(nu).is_some() {
        return false;
    }
    if POWER_EXACT.contains(&nu) || nu.starts_with('+') || nu.starts_with("V+") {
        return true;
    }
    let bytes = nu.as_bytes();
    if nu.chars().count() >= 3 && bytes[0] == b'V' && bytes[1].is_ascii_digit() {
        return true;
    }
    if let Some((count, rest)) = after_voltage(nu) {
        if rest.starts_with(|c: char| c.is_ascii_digit()) {
            return true;
        }
        // Plain and letter-suffixed voltages. A control suffix (5VEN, 12VPG) names a signal about the rail.
        let suffix = rest.is_empty() || (rest.starts_with(|c: char| c.is_ascii_uppercase()) && upper_alnum(rest, '0'));
        if suffix && count.bytes().any(|d| d != b'0') && !VOLTAGE_SIGNAL_SUFFIXES.contains(&rest) {
            return true;
        }
    }
    let negative = nu.strip_prefix("NEG").and_then(after_voltage).is_some();
    let vdd_number = bytes.len() >= 4 && bytes[0] == b'V' && matches!(bytes[1], b'C' | b'D') && matches!(bytes[2], b'C' | b'D') && bytes[3].is_ascii_digit();
    let pwr_number = nu.strip_prefix("PWR").is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit()));
    if negative || vdd_number || pwr_number {
        return true;
    }
    let Some((first, _)) = nu.split_once('_') else {
        return false;
    };
    let last = nu.rsplit('_').next().unwrap_or(nu);
    after_voltage(first).is_some() || POWER_FIRST_SEGMENT.contains(&first) || (!first.is_empty() && descriptive_rail(first, last))
}

/// emc_rules._is_power_or_ground.
pub fn is_emc_power_or_ground(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    let low = name.to_lowercase();
    let low = low.trim_matches('+');
    if EMC_PREFIXES.iter().any(|prefix| low.strip_prefix(prefix).is_some_and(|rest| rest.is_empty() || rest.starts_with(['_', '/']))) {
        return true;
    }
    let number = low.strip_prefix(['+', '-']).unwrap_or(low);
    let whole = digits(number);
    let tail = &number[whole.len()..];
    let fraction = tail.strip_prefix('.').unwrap_or(tail);
    !whole.is_empty() && fraction[digits(fraction).len()..].starts_with('v')
}

fn happy_dir() -> PathBuf {
    std::env::var("KICAD_HAPPY_DIR").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Documents/GitHub/kicad-happy"))
}

/// A git hook exports GIT_DIR and friends: without clearing them the pin check reads the hook's repository.
fn check_pinned(happy: &Path) -> Result<(), String> {
    if !happy.is_dir() {
        return Err(format!("kicad-happy clone not found at {}. Set KICAD_HAPPY_DIR or clone it there.", happy.display()));
    }
    let mut git = Command::new("git");
    git.arg("-C").arg(happy).args(["rev-parse", "HEAD"]);
    for (key, _) in std::env::vars().filter(|(key, _)| key.starts_with("GIT_")) {
        git.env_remove(key);
    }
    let output = git.output().map_err(|e| format!("kicad-happy at {} is not a git repository: {e}", happy.display()))?;
    let head = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() {
        return Err(format!("kicad-happy at {} is not a git repository", happy.display()));
    }
    if !head.starts_with(PINNED_COMMIT) {
        return Err(format!("kicad-happy at {} is at commit {}, not the pinned commit {PINNED_COMMIT}.", happy.display(), &head[..head.len().min(12)]));
    }
    Ok(())
}

/// The board's schematic: the one named like it, else the only one beside it.
fn schematic_of(pcb: &Path) -> Result<Option<PathBuf>, String> {
    let root = pcb.with_extension("kicad_sch");
    if root.is_file() {
        return Ok(Some(root));
    }
    let folder = pcb.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let entries = fs::read_dir(folder).map_err(|e| format!("{}: {e}", folder.display()))?;
    let found: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "kicad_sch")).collect();
    Ok(<[PathBuf; 1]>::try_from(found).ok().map(|[only]| only))
}

/// statistics.power_rails of the pinned analyzer. An incomplete report stops here, as the gate stops on one.
fn power_rails(happy: &Path, schematic: &Path) -> Result<BTreeSet<String>, String> {
    let python = std::env::var("PYTHON_MODERN").unwrap_or_else(|_| DEFAULT_PYTHON.to_string());
    let folder = std::env::temp_dir().join(format!("rp-scope-{}", std::process::id()));
    fs::create_dir_all(&folder).map_err(|e| format!("{}: {e}", folder.display()))?;
    let report = folder.join("sch.json");
    let run = Command::new(&python).arg(happy.join(SCHEMATIC_SCRIPT)).arg(schematic).arg("-o").arg(&report).output().map_err(|e| format!("{python}: {e}"));
    let text = fs::read_to_string(&report);
    let _ = fs::remove_dir_all(&folder);
    let run = run?;
    if !run.status.success() {
        return Err(format!("{SCHEMATIC_SCRIPT} failed ({}): {}", run.status, String::from_utf8_lossy(&run.stderr).trim()));
    }
    let text = text.map_err(|_| format!("{SCHEMATIC_SCRIPT} produced no output"))?;
    rails_of(&text)
}

fn rails_of(report: &str) -> Result<BTreeSet<String>, String> {
    let doc: serde_json::Value = serde_json::from_str(report).map_err(|e| format!("{SCHEMATIC_SCRIPT}: {e}"))?;
    let failed = doc.get("error").is_some_and(|v| !v.is_null() && v != false) || doc.get("errors").is_some_and(|v| v.as_array().is_none_or(|a| !a.is_empty()));
    let findings = doc.get("findings").and_then(|v| v.as_array()).is_some_and(|list| list.iter().all(|f| f.is_object()));
    if failed || !findings {
        return Err(format!("{SCHEMATIC_SCRIPT} produced an incomplete or error report"));
    }
    let rails = doc.pointer("/statistics/power_rails").and_then(|v| v.as_array());
    Ok(rails.into_iter().flatten().filter_map(|rail| rail.get("name")?.as_str()).filter(|name| !name.is_empty()).map(str::to_string).collect())
}

/// The nets of `names` outside RP-001, given the rails of the schematic.
pub fn skipped_nets(names: &[&String], rails: &BTreeSet<String>) -> Vec<String> {
    let mut skip: Vec<String> = names.iter().filter(|n| is_power_net_name(n, rails) || is_ground_name(n) || is_emc_power_or_ground(n)).map(|n| n.to_string()).collect();
    skip.sort();
    skip
}

/// The RP-001 scope of `pcb` for the nets `names`.
pub fn rp_scope(pcb: &Path, names: &[&String]) -> Result<RpScope, String> {
    let happy = happy_dir();
    check_pinned(&happy)?;
    let rails = match schematic_of(pcb)? {
        Some(schematic) => power_rails(&happy, &schematic)?,
        None => BTreeSet::new(),
    };
    let skip = skipped_nets(names, &rails);
    Ok(RpScope { power_rails: rails.into_iter().collect(), skip })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rails(names: &[&str]) -> BTreeSet<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    #[test]
    fn zero_volt_spellings_are_ground_and_never_rails() {
        for name in ["0V", "0VA", "0VANA", "+0V", "/AI/0V_A", "00V"] {
            assert!(is_ground_name(name), "{name}");
            assert!(!is_power_net_name(name, &rails(&[])), "{name}");
        }
        for name in ["0V9", "0V85"] {
            assert!(!is_ground_name(name), "{name}");
            assert!(is_power_net_name(name, &rails(&[])), "{name}");
        }
    }

    #[test]
    fn a_rail_of_the_schematic_counts_whatever_its_name() {
        assert!(!is_power_net_name("/MAINS_L", &rails(&[])));
        assert!(is_power_net_name("/MAINS_L", &rails(&["/MAINS_L"])));
    }

    #[test]
    fn descriptive_rails_keep_their_signal_prefix_rule() {
        for name in ["RAW_5V", "USB_5V", "ISO_3V3", "SERVO_VCC", "ADC_AVDD", "USB_VBUS", "LED_VIN", "BOOST_VOUT", "/PS/VDD_nRF"] {
            assert!(is_power_net_name(name, &rails(&[])), "{name}");
        }
        for name in ["PWM_5V", "EN_5V", "SENSE_12V", "ADC_VBUS", "OPAMP1_VOUT", "5VEN", "12VPG", "/SDA", "_VCC", "/A/_VBUS"] {
            assert!(!is_power_net_name(name, &rails(&[])), "{name}");
        }
    }

    #[test]
    fn voltage_shapes() {
        for name in ["5V", "12V", "24V", "5VSB", "12VIN", "3V3", "1V8", "V3V3", "V1V8", "NEG12V", "VDD5", "VCC3", "PWR3V3", "5V_INT", "+5V", "V+"] {
            assert!(is_power_net_name(name, &rails(&[])), "{name}");
        }
    }

    #[test]
    fn emc_rule_reads_prefixes_and_numbers() {
        for name in ["GND_ISO", "vcc", "VBUS_IN", "+3.3V", "-12v", "PWR/A", "VM_1", "24v"] {
            assert!(is_emc_power_or_ground(name), "{name}");
        }
        for name in ["GNDISO", "VCCX", "/VBUS", "SIG"] {
            assert!(!is_emc_power_or_ground(name), "{name}");
        }
    }

    #[test]
    fn ground_shapes() {
        for name in ["GND", "/X/GND_ISO", "SGND", "COM", "BAT-", "VBAT_N", "VSS1", "AGND"] {
            assert!(is_ground_name(name), "{name}");
        }
        assert!(!is_ground_name("V-"));
    }

    #[test]
    fn skipped_nets_are_sorted_and_the_rest_stay() {
        let (a, b, c) = ("/VIN".to_string(), "GND".to_string(), "/SDA".to_string());
        assert_eq!(skipped_nets(&[&a, &b, &c], &rails(&[])), vec!["/VIN".to_string(), "GND".to_string()]);
    }

    #[test]
    fn an_error_report_is_not_a_scope() {
        assert!(rails_of(r#"{"error": "boom", "findings": []}"#).is_err());
        assert!(rails_of(r#"{"statistics": {"power_rails": []}}"#).is_err());
        assert_eq!(rails_of(r#"{"findings": [], "statistics": {"power_rails": [{"name": "VDD"}, {"name": ""}, 7]}}"#).unwrap(), rails(&["VDD"]));
    }
}
