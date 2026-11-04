//! `iotroute write BOARD.kicad_pcb RESULT.json OUT_DIR`: the router result as tracks and vias in a copy of the board.
//!
//! Copies the project files next to BOARD (.kicad_pro, .kicad_dru, .kicad_sch, sym/fp-lib-table) into OUT_DIR, adds the
//! result to the board text, then one kicad-cli DRC with parity refills every zone and saves OUT_DIR/<name>.kicad_pcb. KiCad
//! puts the new items in their place on that save. A save can rewrite .kicad_pro with defaults, so the original goes back
//! after it. The input copper is not touched. Prints one line: WRITE PASS|FAIL drc <errors by type> unconnected N parity N -> OUT.
use crate::checkpoint::sha256;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const MAC_KICAD_CLI: &str = "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli";

/// Millimetres as KiCad's text, by way of whole nanometres. The cut toward zero is pcbnew.FromMM's, so a result lands on the
/// same nanometre as it did through pcbnew.
fn mm_text(mm: f64) -> String {
    let nm = (mm * 1e6) as i64;
    let (sign, abs) = (if nm < 0 { "-" } else { "" }, nm.unsigned_abs());
    let frac = format!("{:06}", abs % 1_000_000);
    let frac = frac.trim_end_matches('0');
    let dot = if frac.is_empty() { "" } else { "." };
    format!("{sign}{}{dot}{frac}", abs / 1_000_000)
}

/// A KiCad string: the characters a quoted name can hold.
fn quoted(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The form that starts at `open`, by depth, skipping quoted text.
fn form_end(s: &str, open: usize) -> Option<usize> {
    let (mut depth, mut in_str, mut esc) = (0i32, false, false);
    for (i, c) in s[open..].char_indices() {
        if in_str {
            match c {
                _ if esc => esc = false,
                '\\' => esc = true,
                '"' => in_str = false,
                _ => {}
            }
            continue;
        }
        match c {
            '"' => in_str = true,
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(open + i + 1);
                }
            }
            _ => {}
        }
    }
    None
}

/// The copper layers of the board's `(layers ...)` table, as quoted names.
fn copper_layers(board: &str) -> Result<HashSet<String>, String> {
    let open = board.find("(layers").ok_or("no (layers) table in the board")?;
    let end = form_end(board, open).ok_or("the (layers) table does not close")?;
    Ok(board[open..end].split('"').skip(1).step_by(2).filter(|n| n.ends_with(".Cu")).map(|n| format!("\"{n}\"")).collect())
}

/// Every net the board names, as quoted text: KiCad 10 files name nets on their items and have no net table.
fn board_nets(board: &str) -> HashSet<String> {
    let mut nets = HashSet::new();
    for (i, _) in board.match_indices("(net \"") {
        let start = i + 5;
        if let Some(end) = form_end(board, i) {
            nets.insert(board[start..end - 1].to_string());
        }
    }
    nets
}

/// A UUID from the seed and the item's number: the same input gives the same ids, so the same file. Another input gives other
/// ids, so a re-route of a board this tool wrote does not repeat the ones in it.
fn item_uuid(seed: &str, n: usize) -> String {
    let h = sha256(format!("{seed}:{n}").as_bytes());
    format!("{}-{}-4{}-a{}-{}", &h[0..8], &h[8..12], &h[13..16], &h[17..20], &h[20..32])
}

/// The JSON with each number as a string. serde_json's default float parse can miss the nearest double by a bit, and the cut
/// to whole nanometres then lands 1 nm away from pcbnew's; `str::parse` is exact. Its float_roundtrip feature would do the same
/// here but also change how the core reads its model.
fn numbers_as_strings(json: &str) -> String {
    let mut out = String::with_capacity(json.len() + json.len() / 4);
    let (mut in_str, mut esc, mut in_num) = (false, false, false);
    for c in json.chars() {
        if in_str {
            out.push(c);
            match c {
                _ if esc => esc = false,
                '\\' => esc = true,
                '"' => in_str = false,
                _ => {}
            }
            continue;
        }
        let part = c.is_ascii_digit() || matches!(c, '-' | '+' | '.' | 'e' | 'E');
        if in_num && !part {
            out.push('"');
            in_num = false;
        }
        // e and E belong to a number only once one has started: true, false and null are not numbers.
        if !in_num && (c.is_ascii_digit() || c == '-') {
            out.push('"');
            in_num = true;
        }
        if c == '"' {
            in_str = true;
        }
        out.push(c);
    }
    if in_num {
        out.push('"');
    }
    out
}

fn as_number(v: &Value) -> Option<f64> {
    v.as_str()?.parse().ok()
}

fn num(v: &Value, key: &str) -> Result<f64, String> {
    as_number(&v[key]).ok_or_else(|| format!("result item without {key}: {v}"))
}

fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v[key].as_str().ok_or_else(|| format!("result item without {key}: {v}"))
}

fn point(v: &Value, key: &str) -> Result<String, String> {
    match (as_number(&v[key][0]), as_number(&v[key][1])) {
        (Some(x), Some(y)) => Ok(format!("{} {}", mm_text(x), mm_text(y))),
        _ => Err(format!("result item without {key}: {v}")),
    }
}

/// The result as board text. An unknown net or layer stops the write: the route was made for another board.
fn items_text(result: &Value, board: &str, seed: &str) -> Result<String, String> {
    let (nets, layers) = (board_nets(board), copper_layers(board)?);
    // No net: KiCad writes no (net) line. An item with no net is legal, a name the board lacks is not.
    let net_of = |v: &Value| -> Result<String, String> {
        let name = text(v, "net")?;
        if name.is_empty() {
            return Ok(String::new());
        }
        let n = quoted(name);
        if nets.contains(&n) { Ok(format!("\t\t(net {n})\n")) } else { Err(format!("net {n} is not on the board")) }
    };
    let mut out = String::new();
    let mut n = 0;
    for t in result["tracks"].as_array().ok_or("result has no tracks")? {
        let layer = quoted(text(t, "layer")?);
        if !layers.contains(&layer) {
            return Err(format!("layer {layer} is not on the board"));
        }
        out += &format!("\t(segment\n\t\t(start {})\n\t\t(end {})\n\t\t(width {})\n\t\t(layer {layer})\n{}\t\t(uuid \"{}\")\n\t)\n",
                        point(t, "a")?, point(t, "b")?, mm_text(num(t, "w")?), net_of(t)?, item_uuid(seed, n));
        n += 1;
    }
    for v in result["vias"].as_array().ok_or("result has no vias")? {
        out += &format!("\t(via\n\t\t(at {} {})\n\t\t(size {})\n\t\t(drill {})\n\t\t(layers \"F.Cu\" \"B.Cu\")\n{}\t\t(uuid \"{}\")\n\t)\n",
                        mm_text(num(v, "x")?), mm_text(num(v, "y")?), mm_text(num(v, "d")?), mm_text(num(v, "drill")?), net_of(v)?, item_uuid(seed, n));
        n += 1;
    }
    Ok(out)
}

/// The board with the items before its closing parenthesis.
fn with_items(board: &str, items: &str) -> Result<String, String> {
    let close = board.rfind(')').ok_or("the board file has no closing parenthesis")?;
    Ok(format!("{}{items}{}", &board[..close], &board[close..]))
}

/// The project next to the board: the one of its name when there is one, else the last by name.
fn project_of(pcb: &Path) -> Result<String, String> {
    let dir = pcb.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let mut names: Vec<String> = fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter_map(|n| n.strip_suffix(".kicad_pro").map(str::to_string))
        .collect();
    names.sort();
    let own = pcb.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    if names.iter().any(|n| n == own) {
        return Ok(own.to_string());
    }
    names.pop().ok_or_else(|| format!("no .kicad_pro next to {}", pcb.display()))
}

fn kicad_cli() -> String {
    std::env::var("KICAD_CLI").unwrap_or_else(|_| if Path::new(MAC_KICAD_CLI).exists() { MAC_KICAD_CLI.to_string() } else { "kicad-cli".to_string() })
}

/// 0 PASS, 1 FAIL. An Err is no verdict.
fn write(pcb: &Path, result: &Path, out_dir: &Path) -> Result<i32, String> {
    let read = |p: &Path| fs::read(p).map_err(|e| format!("{}: {e}", p.display()));
    fs::create_dir_all(out_dir).map_err(|e| format!("{}: {e}", out_dir.display()))?;
    let src = pcb.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new(".")).to_path_buf();
    let proj = project_of(pcb)?;
    for name in [format!("{proj}.kicad_pro"), format!("{proj}.kicad_dru"), format!("{proj}.kicad_sch"), "sym-lib-table".to_string(), "fp-lib-table".to_string()] {
        let from = src.join(&name);
        if from.exists() {
            fs::copy(&from, out_dir.join(&name)).map_err(|e| format!("{}: {e}", from.display()))?;
        }
    }
    let (board_bytes, result_bytes) = (read(pcb)?, read(result)?);
    let seed = sha256(&[board_bytes.as_slice(), b"\0", result_bytes.as_slice()].concat());
    let board = String::from_utf8(board_bytes).map_err(|e| format!("{}: {e}", pcb.display()))?;
    let result_text = std::str::from_utf8(&result_bytes).map_err(|e| format!("{}: {e}", result.display()))?;
    let parsed: Value = serde_json::from_str(&numbers_as_strings(result_text)).map_err(|e| format!("{}: {e}", result.display()))?;
    let out: PathBuf = out_dir.join(format!("{proj}.kicad_pcb"));
    fs::write(&out, with_items(&board, &items_text(&parsed, &board, &seed)?)?).map_err(|e| format!("{}: {e}", out.display()))?;

    let report = out_dir.join("drc.json");
    let _ = fs::remove_file(&report);
    let run = Command::new(kicad_cli())
        .args(["pcb", "drc", "--schematic-parity", "--refill-zones", "--save-board", "--format", "json", "--severity-error", "--output"])
        .arg(&report).arg(&out).output().map_err(|e| format!("kicad-cli: {e}"))?;
    fs::copy(src.join(format!("{proj}.kicad_pro")), out_dir.join(format!("{proj}.kicad_pro"))).map_err(|e| format!("restoring .kicad_pro: {e}"))?;
    let raw = read(&report).map_err(|e| format!("kicad-cli wrote no report (exit {:?}): {e}: {}", run.status.code(), String::from_utf8_lossy(&run.stderr)))?;
    let d: Value = serde_json::from_slice(&raw).map_err(|e| format!("{}: {e}", report.display()))?;
    let mut kinds: BTreeMap<String, u32> = BTreeMap::new();
    for v in d["violations"].as_array().map_or(&[][..], |a| a) {
        *kinds.entry(v["type"].as_str().unwrap_or("?").to_string()).or_default() += 1;
    }
    let count = |key: &str| d[key].as_array().map_or(0, |a| a.len());
    let (errors, unconnected, parity) = (kinds.values().sum::<u32>(), count("unconnected_items"), count("schematic_parity"));
    let ok = errors == 0 && unconnected == 0 && parity == 0;
    println!("WRITE {} drc {errors} {kinds:?} unconnected {unconnected} parity {parity} -> {}", if ok { "PASS" } else { "FAIL" }, out.display());
    Ok(if ok { 0 } else { 1 })
}

pub(crate) fn cli(args: &[String]) -> i32 {
    let [pcb, result, out_dir] = args else {
        eprintln!("usage: iotroute write BOARD.kicad_pcb RESULT.json OUT_DIR");
        return 2;
    };
    write(Path::new(pcb), Path::new(result), Path::new(out_dir)).unwrap_or_else(|e| {
        eprintln!("write: {e}");
        2
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const BOARD: &str = "(kicad_pcb\n\t(version 20260206)\n\t(layers\n\t\t(0 \"F.Cu\" signal)\n\t\t(2 \"B.Cu\" signal)\n\t\t(25 \"Edge.Cuts\" user)\n\t)\n\t(footprint \"a\"\n\t\t(pad \"1\" smd rect (net \"/A\"))\n\t\t(pad \"2\" smd rect (net \"N\\\"Q\"))\n\t)\n)\n";

    #[test]
    fn millimetres_are_cut_to_whole_nanometres_like_pcbnew() {
        assert_eq!(mm_text(178.705), "178.705");
        assert_eq!(mm_text(0.4), "0.4");
        assert_eq!(mm_text(2.0), "2");
        assert_eq!(mm_text(-1.5), "-1.5");
        assert_eq!(mm_text(222.0289881), "222.028988");
        assert_eq!(mm_text(1.2345679), "1.234567"); // cut, not rounded
        assert_eq!(mm_text(-0.0000004), "0");
    }

    #[test]
    fn numbers_keep_their_nearest_double() {
        // A long route.json value, just under a whole nanometre: pcbnew cuts it down, and so must this.
        let v: Value = serde_json::from_str(&numbers_as_strings(r#"{"a":[122.52499999999999,-1.5e0],"n":"x 1.5","t":true,"z":null,"w":0.2}"#)).unwrap();
        assert_eq!(point(&v, "a").unwrap(), "122.524999 -1.5");
        assert_eq!(num(&v, "w").unwrap(), 0.2);
        assert_eq!((v["n"].as_str(), v["t"].as_bool(), v["z"].is_null()), (Some("x 1.5"), Some(true), true));
    }

    #[test]
    fn reads_layers_and_nets_from_the_board() {
        let layers = copper_layers(BOARD).unwrap();
        assert_eq!(layers.len(), 2);
        assert!(layers.contains("\"F.Cu\"") && !layers.contains("\"Edge.Cuts\""));
        let nets = board_nets(BOARD);
        assert!(nets.contains("\"/A\"") && nets.contains("\"N\\\"Q\""));
    }

    #[test]
    fn writes_tracks_and_vias_as_kicad_text() {
        let r = json!({"tracks": [{"a": ["1.0", "2.5"], "b": ["3.0", "2.5"], "w": "0.2", "layer": "B.Cu", "net": "/A"}],
                       "vias": [{"x": "3.0", "y": "2.5", "d": "0.6", "drill": "0.3", "net": "N\"Q"}]});
        let t = items_text(&r, BOARD, "seed").unwrap();
        assert!(t.contains("(start 1 2.5)\n\t\t(end 3 2.5)\n\t\t(width 0.2)\n\t\t(layer \"B.Cu\")\n\t\t(net \"/A\")"), "{t}");
        assert!(t.contains("(at 3 2.5)\n\t\t(size 0.6)\n\t\t(drill 0.3)\n\t\t(layers \"F.Cu\" \"B.Cu\")\n\t\t(net \"N\\\"Q\")"), "{t}");
        let done = with_items(BOARD, &t).unwrap();
        assert!(done.ends_with("\t)\n)\n"));
        assert_eq!(form_end(&done, 0), Some(done.trim_end().len()));
    }

    #[test]
    fn stops_on_a_net_or_layer_the_board_does_not_have() {
        let net = json!({"tracks": [{"a": ["0", "0"], "b": ["1", "0"], "w": "0.2", "layer": "F.Cu", "net": "/GONE"}], "vias": []});
        assert!(items_text(&net, BOARD, "s").unwrap_err().contains("/GONE"));
        let layer = json!({"tracks": [{"a": ["0", "0"], "b": ["1", "0"], "w": "0.2", "layer": "In1.Cu", "net": "/A"}], "vias": []});
        assert!(items_text(&layer, BOARD, "s").unwrap_err().contains("In1.Cu"));
    }

    #[test]
    fn an_item_with_no_net_has_no_net_line() {
        let r = json!({"tracks": [{"a": ["0", "0"], "b": ["1", "0"], "w": "0.2", "layer": "F.Cu", "net": ""}], "vias": []});
        assert!(!items_text(&r, BOARD, "s").unwrap().contains("(net"));
    }

    #[test]
    fn ids_are_stable_for_an_input_and_differ_between_inputs() {
        assert_eq!(item_uuid("a", 1), item_uuid("a", 1));
        assert_ne!(item_uuid("a", 1), item_uuid("a", 2));
        assert_ne!(item_uuid("a", 1), item_uuid("b", 1));
        let u = item_uuid("a", 1);
        assert_eq!((u.len(), &u[14..15], &u[19..20]), (36, "4", "a"));
    }
}
