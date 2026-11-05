//! Edits of DSN text before the router sees it: the signal layers, the nets kept, the halo padstack, the pairs file.
use regex_lite::{Captures, Regex};
use std::collections::BTreeSet;

fn regex(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a fixed pattern")
}

/// Layers outside `layers` become power layers, so the router keeps off them. With `nets`, the other nets lose their pins.
pub fn restrict_dsn(text: &str, layers: &BTreeSet<String>, nets: Option<&BTreeSet<String>>) -> String {
    let typed = regex(r"\(layer ([^\s()]+)\s*\(type \w+\)").replace_all(text, |caps: &Captures| {
        let kind = if layers.contains(&caps[1]) { "signal" } else { "power" };
        format!("(layer {}\n      (type {kind})", &caps[1])
    });
    let Some(nets) = nets.filter(|nets| !nets.is_empty()) else { return typed.into_owned() };
    regex(r#"\(net ("[^"]*"|[^\s()]+)\s*\(pins[^)]*\)\s*\)"#)
        .replace_all(&typed, |caps: &Captures| {
            if nets.contains(caps[1].trim_matches('"')) { caps[0].to_string() } else { format!("(net {}\n      (pins))", &caps[1]) }
        })
        .into_owned()
}

/// A shell-style glob as fnmatchcase has it: `*`, `?`, `[...]`.
pub fn glob(text: &str, pattern: &str) -> bool {
    fn matches(text: &[char], pattern: &[char]) -> bool {
        match pattern.split_first() {
            None => text.is_empty(),
            Some(('*', rest)) => (0..=text.len()).any(|skip| matches(&text[skip..], rest)),
            Some(('?', rest)) => !text.is_empty() && matches(&text[1..], rest),
            Some(('[', rest)) => set(text, rest).unwrap_or_else(|| text.first() == Some(&'[') && matches(&text[1..], rest)),
            Some((head, rest)) => text.first() == Some(head) && matches(&text[1..], rest),
        }
    }
    /// A `[...]` at the start of `pattern` (the bracket taken): None when it does not close.
    fn set(text: &[char], pattern: &[char]) -> Option<bool> {
        let negate = pattern.first() == Some(&'!');
        let start = usize::from(negate);
        let close = pattern.iter().skip(start + 1).position(|c| *c == ']')? + start + 1;
        let (body, rest) = (&pattern[start..close], &pattern[close + 1..]);
        let Some((head, tail)) = text.split_first() else { return Some(false) };
        let mut hit = false;
        let mut at = 0;
        while at < body.len() {
            if at + 2 < body.len() && body[at + 1] == '-' {
                hit |= (body[at]..=body[at + 2]).contains(head);
                at += 3;
            } else {
                hit |= body[at] == *head;
                at += 1;
            }
        }
        Some(hit != negate && matches(tail, rest))
    }
    let (text, pattern): (Vec<char>, Vec<char>) = (text.chars().collect(), pattern.chars().collect());
    matches(&text, &pattern)
}

/// Copies each class with one of these nets to `<class>_RPV`, whose vias are the halo; the nets leave the original class.
fn split_classes(text: &str, halo: &str, nets: &[String]) -> String {
    let token = regex(r#""[^"]*"|\S+"#);
    let via = regex(r#"\(use_via "[^"]*"\)"#);
    let mut added = Vec::new();
    let split = regex(r#"(?s)\(class (\S+) ((?:"[^"]*"|[^()"])*?)(\(circuit.*?\n    \))"#).replace_all(text, |caps: &Captures| {
        let (head, names, tail) = (&caps[1], &caps[2], &caps[3]);
        let tokens: Vec<&str> = token.find_iter(names).map(|found| found.as_str()).collect();
        let hit: Vec<&str> = tokens.iter().copied().filter(|name| nets.iter().any(|pattern| glob(name.trim_matches('"'), pattern))).collect();
        if hit.is_empty() {
            return caps[0].to_string();
        }
        let keep: Vec<&str> = tokens.iter().copied().filter(|name| !hit.contains(name)).collect();
        let big_tail = via.replace_all(tail, format!(r#"(use_via "{halo}")"#).as_str());
        added.push(format!("    (class {head}_RPV {}\n      {}", hit.join(" "), big_tail.trim_start()));
        format!("(class {head} {}\n      {}", keep.join(" "), tail.trim_start())
    });
    let split = split.into_owned();
    let last = split.rfind("    (class ").expect("a split class is still there");
    let end = split[last..].find("\n    )").map_or(0, |at| last + at + "\n    )".len());
    format!("{}\n{}{}", &split[..end], added.join("\n"), &split[end..])
}

/// `class` gets the halo as its via.
fn use_halo(text: &str, class: &str, halo: &str) -> String {
    let Some(at) = text.find(&format!("(class {class} ")) else { return text.to_string() };
    let Some(via) = text[at..].find("(use_via").map(|found| at + found) else { return text.to_string() };
    let Some(end) = text[via..].find(')').map(|found| via + found) else { return text.to_string() };
    format!("{}(use_via \"{halo}\"{}", &text[..via], &text[end..])
}

/// Adds a halo via padstack with an attributable diameter, drill and layer span. The importer needs KiCad's naming: an alias
/// would lose the drill. With `nets` (globs) only those nets get it; else the `classes`.
pub fn big_signal_via(text: &str, diameter_mm: f64, classes: &[String], nets: &[String]) -> Result<String, String> {
    let found = regex(r#"(?s)\(padstack "(Via[^"]*)"\n(.*?)\n    \)"#).captures(text).ok_or("no via padstack in the DSN")?;
    let (whole, name, body) = (&found[0], &found[1], &found[2]);
    let unsupported = || "halo requires a supported via and integral micrometre diameter above drill".to_string();
    let source = regex(r"^Via\[0-(\d+)\]_(\d+):(\d+)_um$").captures(name).ok_or_else(unsupported)?;
    let drill: f64 = source[3].parse().map_err(|_| unsupported())?;
    let diameter = diameter_mm * 1000.0;
    if diameter.fract() != 0.0 || diameter <= drill {
        return Err(unsupported());
    }
    let halo = format!("Via[0-{}]_{}:{}_um", &source[1], diameter as i64, &source[3]);
    if text.contains(&format!("(padstack \"{halo}\"")) {
        return Err("halo padstack already exists; ambiguous export".to_string());
    }
    let big = regex(r"\(circle (\S+) [\d.]+\)").replace_all(body, |caps: &Captures| format!("(circle {} {})", &caps[1], diameter as i64));
    let text = text.replacen(whole, &format!("{whole}\n    (padstack \"{halo}\"\n{big}\n    )"), 1);
    let text = text.replacen(&format!("(via \"{name}\")"), &format!("(via \"{name}\" \"{halo}\")"), 1);
    if !nets.is_empty() {
        return Ok(split_classes(&text, &halo, nets));
    }
    Ok(classes.iter().fold(text, |text, class| use_halo(&text, class, &halo)))
}

/// One entry of a board's diff-pairs.json.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct Pair {
    pub p: String,
    pub n: String,
    #[serde(default)]
    pub dru_rule: Option<String>,
}

/// The file `fastroute --pairs` takes: one line "pair P N gap=G" for each pair with both nets routed; G is the diff_pair_gap opt of
/// its .kicad_dru rule, in mm as the rule says it. None with no pair.
pub fn pairs_text(pairs: &[Pair], dru: &str, nets: &BTreeSet<String>) -> Option<String> {
    let gap = regex(r"diff_pair_gap[^\n]*\(opt ([\d.]+)mm\)");
    let line = |pair: &Pair| {
        let rule = pair.dru_rule.as_deref().and_then(|rule| dru.find(&format!("(rule \"{rule}\"")));
        let window = rule.map(|at| &dru[at..dru.len().min(dru.floor_char_boundary(at + 600))]);
        let value = window.and_then(|text| gap.captures(text)).map_or(String::new(), |caps| format!(" gap={}", &caps[1]));
        format!("pair {} {}{value}", pair.p, pair.n)
    };
    let lines: Vec<String> = pairs.iter().filter(|pair| nets.contains(&pair.p) && nets.contains(&pair.n)).map(line).collect();
    (!lines.is_empty()).then(|| lines.join("\n") + "\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(names: &[&str]) -> BTreeSet<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    const CLASSES: &str = r#"(pcb t
  (network
    (class HOST "A" B
      (circuit
        (use_via "Via[0-1]_600:300_um")
      )
      (rule (width 200))
    )
    (class Other C
      (circuit
        (use_via "Via[0-1]_600:300_um")
      )
      (rule (width 200))
    )
  )
)"#;

    fn dsn(layers: &[&str]) -> String {
        let last = layers.len() - 1;
        let name = format!("Via[0-{last}]_600:300_um");
        let shapes: Vec<String> = layers.iter().map(|layer| format!("      (shape (circle {layer} 600))")).collect();
        format!("(pcb test (unit um) (resolution um 10)\n (structure (via \"{name}\"))\n (library\n    (padstack \"{name}\"\n{}\n    )\n )\n (wiring))", shapes.join("\n"))
    }

    #[test]
    fn layers_outside_the_job_become_power() {
        let text = "(layer F.Cu (type signal))(layer In1.Cu\n  (type signal))";
        let out = restrict_dsn(text, &set(&["F.Cu"]), None);
        assert_eq!(out, "(layer F.Cu\n      (type signal))(layer In1.Cu\n      (type power))");
    }

    #[test]
    fn nets_outside_the_list_lose_their_pins() {
        let text = "(net \"A\" (pins U1-1 U2-1))(net B\n (pins U1-2))";
        let out = restrict_dsn(text, &set(&[]), Some(&set(&["A"])));
        assert_eq!(out, "(net \"A\" (pins U1-1 U2-1))(net B\n      (pins))");
    }

    #[test]
    fn globs_follow_fnmatch() {
        assert!(glob("/A_GND", "*GND*"));
        assert!(glob("GND", "GND"));
        assert!(!glob("VCC", "*GND*"));
        assert!(glob("/D1", "/D[0-9]"));
        assert!(!glob("/DX", "/D[0-9]"));
        assert!(glob("/DX", "/D[!0-9]"));
        assert!(glob("a?c", "a?c"));
        assert!(glob("[x", "[x"));
    }

    #[test]
    fn a_halo_keeps_drill_and_span_on_two_and_four_layers() {
        for layers in [vec!["F.Cu", "B.Cu"], vec!["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"]] {
            let last = layers.len() - 1;
            let out = big_signal_via(&dsn(&layers), 1.8, &[], &[]).unwrap();
            let halo = format!("Via[0-{last}]_1800:300_um");
            assert!(out.contains(&format!("(padstack \"{halo}\"")), "{out}");
            assert_eq!(out.matches("(circle ").count(), layers.len() * 2);
            assert_eq!(out.matches(" 1800)").count(), layers.len());
            assert!(out.contains(&format!("(via \"Via[0-{last}]_600:300_um\" \"{halo}\")")), "{out}");
            assert!(big_signal_via(&out, 1.8, &[], &[]).unwrap_err().contains("already exists"));
        }
    }

    #[test]
    fn a_halo_needs_a_whole_micrometre_diameter_above_the_drill() {
        assert!(big_signal_via(&dsn(&["F.Cu", "B.Cu"]), 0.3, &[], &[]).is_err());
        assert!(big_signal_via(&dsn(&["F.Cu", "B.Cu"]), 1.2345, &[], &[]).is_err());
        assert!(big_signal_via("(pcb)", 1.8, &[], &[]).unwrap_err().contains("no via padstack"));
    }

    #[test]
    fn a_class_takes_the_halo_as_its_via() {
        let text = format!("{}\n{CLASSES}", dsn(&["F.Cu", "B.Cu"]));
        let out = big_signal_via(&text, 1.8, &["HOST".to_string()], &[]).unwrap();
        let host = &out[out.find("(class HOST").unwrap()..];
        assert!(host[..host.find("(class Other").unwrap()].contains(r#"(use_via "Via[0-1]_1800:300_um")"#), "{out}");
        assert!(host[host.find("(class Other").unwrap()..].contains(r#"(use_via "Via[0-1]_600:300_um")"#), "{out}");
    }

    #[test]
    fn selected_nets_move_to_a_copy_of_their_class() {
        let text = format!("{}\n{CLASSES}", dsn(&["F.Cu", "B.Cu"]));
        let out = big_signal_via(&text, 1.8, &[], &["A".to_string()]).unwrap();
        assert!(out.contains("(class HOST B\n"), "{out}");
        let copy = &out[out.find("(class HOST_RPV \"A\"\n").unwrap()..];
        assert!(copy.contains(r#"(use_via "Via[0-1]_1800:300_um")"#), "{out}");
        assert!(out.find("(class Other").unwrap() < out.find("(class HOST_RPV").unwrap());
    }

    #[test]
    fn a_pair_line_needs_both_nets_and_reads_its_gap() {
        let pairs = vec![Pair { p: "A+".into(), n: "A-".into(), dru_rule: Some("usb".into()) }, Pair { p: "B+".into(), n: "B-".into(), dru_rule: None }];
        let dru = "(rule \"usb\"\n (constraint diff_pair_gap (min 0.1mm) (opt 0.127mm))\n)";
        assert_eq!(pairs_text(&pairs, dru, &set(&["A+", "A-", "B+"])).unwrap(), "pair A+ A- gap=0.127\n");
        assert_eq!(pairs_text(&pairs, "", &set(&["B+", "B-"])).unwrap(), "pair B+ B-\n");
        assert_eq!(pairs_text(&pairs, dru, &set(&["A+"])), None);
    }
}
