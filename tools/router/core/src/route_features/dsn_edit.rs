//! Edits of the DSN text. They keep every byte they do not change, so they work on the text KiCad exported: its class blocks
//! end at the first `\n    )` after their `(circuit`, the layout the export writes.
use crate::pytext::repr_list;
use crate::rule_coverage::dsn_forms;
use crate::kicad::raw::Form;
use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;

/// A `(class name members (circuit ...` block of the network section.
struct ClassBlock {
    whole: Range<usize>,
    name: Range<usize>,
    members: Range<usize>,
    /// From `(circuit` to the end of the block.
    tail: Range<usize>,
}

const CLASS_OPEN: &str = "(class ";
const BLOCK_END: &str = "\n    )";

fn class_at(text: &str, start: usize) -> Option<ClassBlock> {
    let name_start = start + CLASS_OPEN.len();
    let name_end = name_start + text[name_start..].find(char::is_whitespace)?;
    if name_end == name_start || !text[name_end..].starts_with(' ') {
        return None;
    }
    let circuit = circuit_start(text, name_end + 1)?;
    let end = circuit + text[circuit..].find(BLOCK_END)? + BLOCK_END.len();
    Some(ClassBlock { whole: start..end, name: name_start..name_end, members: name_end + 1..circuit, tail: circuit..end })
}

/// Past the member names to `(circuit`: only quoted names and text without brackets can stand before it.
fn circuit_start(text: &str, from: usize) -> Option<usize> {
    let mut position = from;
    loop {
        let rest = &text[position..];
        if rest.starts_with("(circuit") {
            return Some(position);
        }
        match rest.chars().next()? {
            '(' | ')' => return None,
            '"' => position += 2 + rest[1..].find('"')?,
            c => position += c.len_utf8(),
        }
    }
}

fn class_blocks(text: &str) -> Vec<ClassBlock> {
    let mut blocks = Vec::new();
    let mut position = 0;
    while let Some(found) = text[position..].find(CLASS_OPEN) {
        let start = position + found;
        match class_at(text, start) {
            Some(block) => {
                position = block.whole.end;
                blocks.push(block);
            }
            None => position = start + 1,
        }
    }
    blocks
}

/// The member names of a block as written, quotes included.
fn member_tokens(text: &str) -> Vec<&str> {
    let mut tokens = Vec::new();
    let mut rest = text.trim_start();
    while !rest.is_empty() {
        let quoted = rest.strip_prefix('"').and_then(|inner| inner.find('"')).map(|end| end + 2);
        let end = quoted.unwrap_or_else(|| rest.find(char::is_whitespace).unwrap_or(rest.len()));
        tokens.push(&rest[..end]);
        rest = rest[end..].trim_start();
    }
    tokens
}

fn net_name(token: &str) -> &str {
    token.trim_matches('"')
}

/// Net to class, from the DSN network section.
pub fn dsn_classes(text: &str) -> BTreeMap<String, String> {
    let mut classes = BTreeMap::new();
    for block in class_blocks(text) {
        for token in member_tokens(&text[block.members.clone()]) {
            classes.insert(net_name(token).to_string(), text[block.name.clone()].to_string());
        }
    }
    classes
}

/// `insert` on the lines after the last class block.
fn after_last_class(text: &str, insert: &str) -> String {
    let Some(end) = text.rfind("    (class ").and_then(|last| text[last..].find(BLOCK_END).map(|end| last + end + BLOCK_END.len())) else {
        return text.to_string();
    };
    format!("{}\n{insert}{}", &text[..end], &text[end..])
}

/// Each net with a mask moves to a copy of its class, `<class>__L<k>`, whose circuit has `(use_layer ...)`.
pub fn apply_layer_masks(text: &str, masks: &BTreeMap<String, Vec<String>>) -> String {
    if masks.is_empty() {
        return text.to_string();
    }
    let groups: Vec<&Vec<String>> = masks.values().collect::<BTreeSet<_>>().into_iter().collect();
    let (mut out, mut added, mut cursor) = (String::with_capacity(text.len()), Vec::new(), 0);
    for block in class_blocks(text) {
        let tokens = member_tokens(&text[block.members.clone()]);
        if !tokens.iter().any(|token| masks.contains_key(net_name(token))) {
            continue;
        }
        let (head, tail) = (&text[block.name.clone()], &text[block.tail.clone()]);
        let keep: Vec<&str> = tokens.iter().copied().filter(|token| !masks.contains_key(net_name(token))).collect();
        added.extend(split_classes(&tokens, masks, &groups, head, tail));
        out.push_str(&text[cursor..block.whole.start]);
        out.push_str(&format!("(class {head} {}\n      {tail}", keep.join(" ")));
        cursor = block.whole.end;
    }
    out.push_str(&text[cursor..]);
    after_last_class(&out, &added.join("\n"))
}

/// The copies of one class: one per mask its nets have, in the order the nets stand.
fn split_classes(tokens: &[&str], masks: &BTreeMap<String, Vec<String>>, groups: &[&Vec<String>], head: &str, tail: &str) -> Vec<String> {
    let mut moved: Vec<(&Vec<String>, Vec<&str>)> = Vec::new();
    for token in tokens {
        let Some(layers) = masks.get(net_name(token)) else { continue };
        match moved.iter_mut().find(|(group, _)| *group == layers) {
            Some((_, members)) => members.push(token),
            None => moved.push((layers, vec![token])),
        }
    }
    let circuit = "(circuit";
    moved.iter().map(|(layers, members)| {
        let key = groups.iter().position(|group| group == layers).unwrap_or_default();
        let body = format!("{circuit}\n        (use_layer {}){}", layers.join(" "), &tail[circuit.len()..]);
        format!("    (class {head}__L{key} {}\n      {body}", members.join(" "))
    }).collect()
}

/// Reads the transformed DSN back: every masked net stands in exactly one class, with exactly its mask.
pub fn verify_layer_masks(text: &str, masks: &BTreeMap<String, Vec<String>>) -> Result<(), String> {
    let mut found: BTreeSet<String> = BTreeSet::new();
    for form in dsn_forms(text)? {
        check_classes(&form, masks, &mut found)?;
    }
    let missing: Vec<&str> = masks.keys().map(String::as_str).filter(|net| !found.contains(*net)).collect();
    if missing.is_empty() {
        return Ok(());
    }
    Err(format!("DSN missing layer-masked nets: {}", repr_list(&missing)))
}

fn check_classes(node: &Form, masks: &BTreeMap<String, Vec<String>>, found: &mut BTreeSet<String>) -> Result<(), String> {
    if node.is("class") {
        let circuit = node.items().iter().find(|item| item.is("circuit"));
        let uses: Vec<&Form> = circuit.map_or(Vec::new(), |form| form.children("use_layer").collect());
        for name in node.items().iter().skip(2).filter_map(Form::atom) {
            let Some(mask) = masks.get(name) else { continue };
            if found.contains(name) || !is_exact_mask(&uses, mask) {
                return Err(format!("DSN layer mask not represented exactly: {name}"));
            }
            found.insert(name.to_string());
        }
    }
    node.items().iter().try_for_each(|child| check_classes(child, masks, found))
}

fn is_exact_mask(uses: &[&Form], mask: &[String]) -> bool {
    let [only] = uses else { return false };
    let layers = &only.items()[1..];
    layers.len() == mask.len() && layers.iter().zip(mask).all(|(layer, wanted)| layer.atom() == Some(wanted))
}

/// The class a split copy came from.
fn base_class(class: &str) -> &str {
    let mut rest = class;
    loop {
        let trimmed = rest.strip_suffix("_RPV").or_else(|| rest.strip_suffix("__nets")).or_else(|| strip_layer_suffix(rest));
        match trimmed {
            Some(shorter) => rest = shorter,
            None => return rest,
        }
    }
}

/// Strips `__L<digits>`.
fn strip_layer_suffix(class: &str) -> Option<&str> {
    let stem = class.trim_end_matches(|c: char| c.is_ascii_digit());
    if stem.len() == class.len() { None } else { stem.strip_suffix("__L") }
}

/// Fastroute puts the pads with no net in the class kicad_default too: a class_class rule on it would also hold those pads
/// (AC-24V 2026-10-09: J1 and F2 mounting pins 8 mm from the mains pins, the mains stage failed; KiCad DRC does not apply
/// the rule to them). So the nets of kicad_default go to a copy of the class.
fn rename_default_class(text: &str) -> String {
    let open = "(class kicad_default";
    let (mut out, mut position) = (String::with_capacity(text.len()), 0);
    while let Some(found) = text[position..].find(open) {
        let suffix_start = position + found + open.len();
        let suffix_end = suffix_start + split_suffix_len(&text[suffix_start..]);
        out.push_str(&text[position..suffix_end]);
        if text[suffix_end..].starts_with(' ') {
            out.push_str("__nets");
        }
        position = suffix_end;
    }
    out.push_str(&text[position..]);
    out
}

/// The length of the `__L<digits>` and `_RPV` run at the start of the text.
fn split_suffix_len(text: &str) -> usize {
    let mut position = 0;
    loop {
        let rest = &text[position..];
        if rest.starts_with("_RPV") {
            position += 4;
            continue;
        }
        let digits = rest.strip_prefix("__L").map_or(0, |after| after.len() - after.trim_start_matches(|c: char| c.is_ascii_digit()).len());
        if digits == 0 {
            return position;
        }
        position += 3 + digits;
    }
}

/// `pairs`: mm between two KiCad classes. Every DSN class whose base name is one of the pair gets the rule, so split classes
/// keep it.
pub fn add_class_class(text: &str, pairs: &BTreeMap<(String, String), f64>) -> String {
    if pairs.is_empty() {
        return text.to_string();
    }
    let renamed = pairs.keys().any(|(a, b)| a == "kicad_default" || b == "kicad_default").then(|| rename_default_class(text));
    let text = renamed.as_deref().unwrap_or(text);
    let classes: BTreeSet<&str> = class_blocks(text).iter().map(|block| &text[block.name.clone()]).collect();
    let mut lines = Vec::new();
    for ((a, b), clearance) in pairs {
        let wanted: BTreeSet<&str> = [a.as_str(), b.as_str()].into();
        for x in &classes {
            for y in classes.iter().filter(|y| x <= *y) {
                if BTreeSet::from([base_class(x), base_class(y)]) == wanted {
                    let um = (clearance * 1000.0).round_ties_even() as i64;
                    lines.push(format!("    (class_class (classes {x} {y})\n      (rule (clearance {um}))\n    )"));
                }
            }
        }
    }
    after_last_class(text, &lines.join("\n"))
}

/// `polygons`: layer and points in mm, board coordinates. DSN uses um with y negated. Each ring closes on its first point.
pub fn add_via_keepouts(text: &str, polygons: &[(String, Vec<[f64; 2]>)]) -> String {
    if polygons.is_empty() {
        return text.to_string();
    }
    let lines: Vec<String> = polygons.iter().map(|(layer, points)| {
        let coords: Vec<String> = points.iter().chain(points.first()).map(|[x, y]| format!("{:.0} {:.0}", x * 1000.0, -y * 1000.0)).collect();
        format!("    (via_keepout \"\" (polygon {layer} 0  {}))", coords.join("  "))
    }).collect();
    let start = text.find("(structure").unwrap_or(0);
    let found = text[start..].find("\n    (via").or_else(|| text[start..].find("\n    (rule"));
    let at = found.map_or_else(|| text.char_indices().last().map_or(0, |(last, _)| last), |offset| start + offset);
    format!("{}\n{}{}", &text[..at], lines.join("\n"), &text[at..])
}
