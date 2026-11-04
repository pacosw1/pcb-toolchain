//! Tracks and vias as KiCad board text, the one way every tool writes them: `iotroute write`, the SES import and the tools that
//! edit a board copy. KiCad puts the items in their place when kicad-cli saves the copy.
use crate::sha256::sha256;
use std::collections::HashSet;

/// Whole nanometres as KiCad's millimetre text.
pub fn nm_text(nm: i64) -> String {
    let (sign, abs) = (if nm < 0 { "-" } else { "" }, nm.unsigned_abs());
    let frac = format!("{:06}", abs % 1_000_000);
    let frac = frac.trim_end_matches('0');
    let dot = if frac.is_empty() { "" } else { "." };
    format!("{sign}{}{dot}{frac}", abs / 1_000_000)
}

/// Millimetres as KiCad's text, by way of whole nanometres. The cut toward zero is pcbnew.FromMM's, so a result lands on the
/// same nanometre as it did through pcbnew.
pub fn mm_text(mm: f64) -> String {
    nm_text((mm * 1e6) as i64)
}

/// A KiCad string: the characters a quoted name can hold.
pub fn quoted(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The form that starts at `open`, by depth, skipping quoted text.
pub fn form_end(s: &str, open: usize) -> Option<usize> {
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
pub fn copper_layers(board: &str) -> Result<HashSet<String>, String> {
    let open = board.find("(layers").ok_or("no (layers) table in the board")?;
    let end = form_end(board, open).ok_or("the (layers) table does not close")?;
    Ok(board[open..end].split('"').skip(1).step_by(2).filter(|n| n.ends_with(".Cu")).map(|n| format!("\"{n}\"")).collect())
}

/// Every net the board names, as quoted text: KiCad 10 files name nets on their items and have no net table.
pub fn board_nets(board: &str) -> HashSet<String> {
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
pub fn item_uuid(seed: &str, n: usize) -> String {
    let h = sha256(format!("{seed}:{n}").as_bytes());
    format!("{}-{}-4{}-a{}-{}", &h[0..8], &h[8..12], &h[13..16], &h[17..20], &h[20..32])
}

/// The `(net ...)` line of an item; no net writes no line, as KiCad does.
pub fn net_line(net: &str) -> String {
    if net.is_empty() { String::new() } else { format!("\t\t(net {})\n", quoted(net)) }
}

/// A segment; `start`, `end` and `width` are already KiCad text, `layer` a quoted name.
pub fn segment_text(start: &str, end: &str, width: &str, layer: &str, net_line: &str, uuid: &str) -> String {
    format!("\t(segment\n\t\t(start {start})\n\t\t(end {end})\n\t\t(width {width})\n\t\t(layer {layer})\n{net_line}\t\t(uuid \"{uuid}\")\n\t)\n")
}

/// A through via; the arguments are already KiCad text.
pub fn via_text(at: &str, size: &str, drill: &str, net_line: &str, uuid: &str) -> String {
    format!("\t(via\n\t\t(at {at})\n\t\t(size {size})\n\t\t(drill {drill})\n\t\t(layers \"F.Cu\" \"B.Cu\")\n{net_line}\t\t(uuid \"{uuid}\")\n\t)\n")
}

/// The board with the items before its closing parenthesis.
pub fn with_items(board: &str, items: &str) -> Result<String, String> {
    let close = board.rfind(')').ok_or("the board file has no closing parenthesis")?;
    Ok(format!("{}{items}{}", &board[..close], &board[close..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nanometres_print_as_kicad_millimetres() {
        assert_eq!(nm_text(105_250_000), "105.25");
        assert_eq!(nm_text(-1_000), "-0.001");
        assert_eq!(nm_text(0), "0");
        assert_eq!(nm_text(2_000_000), "2");
    }

    #[test]
    fn millimetres_cut_toward_zero() {
        assert_eq!(mm_text(1.0000009), "1");
        assert_eq!(mm_text(-1.0000009), "-1");
    }

    #[test]
    fn nets_are_read_from_their_items() {
        let nets = board_nets("(a (net \"+3V3\") (net \"a \\\" b\") (net \"+3V3\"))");
        assert_eq!(nets.len(), 2);
        assert!(nets.contains("\"+3V3\""));
        assert!(nets.contains("\"a \\\" b\""));
    }

    #[test]
    fn copper_layers_come_from_the_table() {
        let layers = copper_layers("(p (layers (0 \"F.Cu\" signal) (2 \"B.Cu\" signal) (5 \"F.SilkS\" user)))").unwrap();
        assert_eq!(layers.len(), 2);
    }

    #[test]
    fn items_go_before_the_closing_parenthesis() {
        assert_eq!(with_items("(a\n)\n", "\t(b)\n").unwrap(), "(a\n\t(b)\n)\n");
        assert!(with_items("x", "").is_err());
    }

    #[test]
    fn uuids_follow_the_seed_and_number() {
        assert_eq!(item_uuid("s", 1), item_uuid("s", 1));
        assert_ne!(item_uuid("s", 1), item_uuid("s", 2));
        assert_eq!(item_uuid("s", 1).len(), 36);
    }
}
