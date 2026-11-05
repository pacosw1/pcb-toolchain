//! Placement rules from a board .kicad_dru (single source: a DRU change flows into the placer model).
//!
//! Read forms (gap = the larger of clearance and creepage):
//!   A.NetClass == 'P' && B.NetClass != 'P'                                -> domain P, gap to other nets
//!   A.NetClass == 'P' && B.NetClass == 'P' && A.NetClass != B.NetClass    -> gap between two classes of P
//!   A.NetClass == 'P' && ... (B.Reference == 'H1' || ...) + hole_clearance -> hole rule for those refs
//!   (A.NetClass == 'X' || A.NetClass == 'Y') && (B.NetClass == 'H' || ...) -> gap between the two class sets
//!   A domain rule ending in && !(B.Type == 'Pad' && B.memberOfFootprint('R') && B.Pad_Number == 'N')
//!                                                                         -> the domain, and pad R.N is a member
//!   A.NetClass == 'P' && B.NetName == '' + creepage                       -> no-net creepage of P (a keepout gap)
//! Rules limited to one footprint, net names, courtyards or diff pairs are local exceptions: not read, not listed.
//! Other rules with a net-class condition and a clearance, creepage or hole constraint are listed in `ignored`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const GAP_KINDS: [&str; 3] = ["clearance", "creepage", "hole_clearance"];
const LOCAL: [&str; 5] = ["memberOfFootprint", "NetName", "intersectsCourtyard", "DiffPair", "isCoupledDiffPair"];
const EXCEPT_OPEN: &str = "&&!(B.Type=='Pad'&&B.memberOfFootprint('";
const EXCEPT_MIDDLE: &str = "')&&B.Pad_Number=='";
const EXCEPT_CLOSE: &str = "')";

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Rules {
    /// (class pattern, gap to other nets, gap between two classes of the domain).
    #[serde(default)]
    pub domains: Vec<(String, f64, f64)>,
    /// (class pattern, refs, hole clearance).
    #[serde(default)]
    pub holes: Vec<(String, Vec<String>, f64)>,
    /// (A class patterns, B class patterns, gap).
    #[serde(default)]
    pub pairs: Vec<(Vec<String>, Vec<String>, f64)>,
    /// Names of clearance, creepage or hole rules the model cannot read.
    #[serde(default)]
    pub ignored: Vec<String>,
    /// (class pattern, ref, pad number): no-net pads the dru puts in a domain.
    #[serde(default)]
    pub members: Vec<(String, String, String)>,
    /// (class pattern, creepage to no-net items).
    #[serde(default)]
    pub nonet: Vec<(String, f64)>,
}

/// A parsed S-expression.
#[derive(Debug, PartialEq)]
pub enum Node {
    Atom(String),
    List(Vec<Node>),
}

impl Node {
    fn atom(&self) -> Option<&str> {
        match self {
            Self::Atom(a) => Some(a),
            Self::List(_) => None,
        }
    }

    fn list(&self) -> Option<&[Node]> {
        match self {
            Self::List(l) => Some(l),
            Self::Atom(_) => None,
        }
    }

    /// The list when it starts with this head.
    fn headed(&self, head: &str) -> Option<&[Node]> {
        self.list().filter(|l| l.first().and_then(Node::atom) == Some(head))
    }
}

/// End of a quoted token that starts at `start`; a backslash keeps the next character.
fn quoted_end(chars: &[char], start: usize) -> Option<usize> {
    let mut i = start + 1;
    while i < chars.len() {
        match chars[i] {
            '"' => return Some(i),
            '\\' => i += 2,
            _ => i += 1,
        }
    }
    None
}

/// Top level S-expressions of a text; lines that start with # are comments.
pub fn parse_tree(text: &str) -> Vec<Node> {
    let body: String = text.lines().filter(|l| !l.trim_start().starts_with('#')).collect::<Vec<_>>().join("\n");
    let chars: Vec<char> = body.chars().collect();
    let mut stack = vec![Vec::new()];
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '(' => {
                stack.push(Vec::new());
                i += 1;
            }
            ')' => {
                let done = stack.pop().unwrap_or_default();
                if stack.is_empty() {
                    stack.push(Vec::new());
                }
                stack.last_mut().expect("the stack has a top").push(Node::List(done));
                i += 1;
            }
            '"' if quoted_end(&chars, i).is_some() => {
                let end = quoted_end(&chars, i).expect("checked by the guard");
                stack.last_mut().expect("the stack has a top").push(Node::Atom(chars[i + 1..end].iter().collect()));
                i = end + 1;
            }
            c if c.is_whitespace() => i += 1,
            _ => {
                let end = (i..chars.len()).find(|&k| matches!(chars[k], '(' | ')') || chars[k].is_whitespace());
                let end = end.unwrap_or(chars.len());
                stack.last_mut().expect("the stack has a top").push(Node::Atom(chars[i..end].iter().collect()));
                i = end;
            }
        }
    }
    stack.swap_remove(0)
}

fn mm(v: &str) -> Option<f64> {
    v.strip_suffix("mm").unwrap_or(v).parse().ok()
}

#[derive(Default)]
struct Gaps {
    clearance: Option<f64>,
    creepage: Option<f64>,
    hole: Option<f64>,
}

impl Gaps {
    fn is_empty(&self) -> bool {
        self.clearance.is_none() && self.creepage.is_none() && self.hole.is_none()
    }

    fn gap(&self) -> f64 {
        self.clearance.unwrap_or(0.0).max(self.creepage.unwrap_or(0.0))
    }

    fn add(&mut self, kind: &str, value: f64) {
        match kind {
            "clearance" => self.clearance = Some(value),
            "creepage" => self.creepage = Some(value),
            "hole_clearance" => self.hole = Some(value),
            _ => {}
        }
    }
}

struct RawRule {
    name: String,
    condition: String,
    gaps: Gaps,
    /// A gap constraint whose min could not be read: its kind.
    unreadable: Option<String>,
}

fn constraint_min(items: &[Node]) -> Option<f64> {
    items.iter().find_map(|z| z.headed("min")).and_then(|z| z.get(1)?.atom()).and_then(mm)
}

fn raw_rule(rule: &[Node]) -> Option<RawRule> {
    let mut r = RawRule { name: rule.get(1)?.atom()?.to_string(), condition: String::new(), gaps: Gaps::default(), unreadable: None };
    for item in &rule[2..] {
        if let Some(c) = item.headed("condition") {
            r.condition = c.get(1).and_then(Node::atom).unwrap_or("").to_string();
        } else if let Some(c) = item.headed("constraint") {
            let kind = c.get(1).and_then(Node::atom).unwrap_or("");
            match constraint_min(&c[2..]) {
                Some(v) => r.gaps.add(kind, v),
                None if GAP_KINDS.contains(&kind) => r.unreadable = Some(kind.to_string()),
                None => {}
            }
        }
    }
    Some(r)
}

/// The text between 'quotes' of `A.NetClass=='P'`, when `s` is exactly `prefix'P'`.
fn one_class<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let v = s.strip_prefix(prefix)?.strip_prefix('\'')?.strip_suffix('\'')?;
    (!v.is_empty() && !v.contains('\'')).then_some(v)
}

/// `(A.NetClass=='X'||A.NetClass=='Y')` -> [X, Y]; the brackets are optional.
fn class_list(s: &str, prefix: &str) -> Option<Vec<String>> {
    let s = s.strip_prefix('(').unwrap_or(s);
    let s = s.strip_suffix(')').unwrap_or(s);
    s.split("||").map(|part| one_class(part, prefix).map(String::from)).collect()
}

/// All 'X' after each `B.Reference==`.
fn references(c: &str) -> Vec<String> {
    let key = "B.Reference=='";
    c.match_indices(key)
        .filter_map(|(i, _)| {
            let rest = &c[i + key.len()..];
            rest.find('\'').filter(|&e| e > 0).map(|e| rest[..e].to_string())
        })
        .collect()
}

/// Removes the pad exception of a domain rule. Returns the condition left and (ref, pad number).
fn split_exception(c: &str) -> (String, Option<(String, String)>) {
    let found = c.find(EXCEPT_OPEN).and_then(|start| {
        let rest = &c[start + EXCEPT_OPEN.len()..];
        let middle = rest.find(EXCEPT_MIDDLE)?;
        let pad = &rest[middle + EXCEPT_MIDDLE.len()..];
        let close = pad.find(EXCEPT_CLOSE)?;
        let end = c.len() - pad.len() + close + EXCEPT_CLOSE.len();
        Some((start, end, rest[..middle].to_string(), pad[..close].to_string()))
    });
    match found {
        Some((start, end, reference, pad)) => (format!("{}{}", &c[..start], &c[end..]), Some((reference, pad))),
        None => (c.to_string(), None),
    }
}

/// What one condition means.
enum Form {
    Domain(String),
    ClassGap(String),
    Hole(String, Vec<String>),
    Pair(Vec<String>, Vec<String>),
    Unknown,
}

fn classify(c: &str, gaps: &Gaps) -> Form {
    let gap = gaps.gap() > 0.0;
    let parts: Vec<&str> = c.split("&&").collect();
    let class_a = parts.first().and_then(|p| one_class(p, "A.NetClass=="));
    if let (Some(a), true, [_, second]) = (class_a, gap, &parts[..]) {
        if one_class(second, "B.NetClass!=") == Some(a) {
            return Form::Domain(a.to_string());
        }
    }
    if let (Some(a), true, [_, second, "A.NetClass!=B.NetClass"]) = (class_a, gap, &parts[..]) {
        if one_class(second, "B.NetClass==") == Some(a) {
            return Form::ClassGap(a.to_string());
        }
    }
    let refs = references(c);
    if let (Some(a), false, true, true) = (class_a, refs.is_empty(), gaps.hole.is_some(), parts.len() > 1) {
        return Form::Hole(a.to_string(), refs);
    }
    if let (true, [a, b]) = (gap, &parts[..]) {
        if let (Some(a), Some(b)) = (class_list(a, "A.NetClass=="), class_list(b, "B.NetClass==")) {
            return Form::Pair(a, b);
        }
    }
    Form::Unknown
}

fn sorted_unique<T: PartialOrd + PartialEq>(mut v: Vec<T>) -> Vec<T> {
    v.sort_by(|a, b| a.partial_cmp(b).expect("rule rows have no NaN"));
    v.dedup();
    v
}

/// Domains keep the order of their first rule.
#[derive(Default)]
struct Domains {
    order: Vec<String>,
    gap: BTreeMap<String, f64>,
}

impl Domains {
    fn raise(&mut self, class: String, gap: f64) {
        if !self.gap.contains_key(&class) {
            self.order.push(class.clone());
        }
        let slot = self.gap.entry(class).or_insert(0.0);
        *slot = slot.max(gap);
    }
}

/// The rules of a .kicad_dru. A gap rule with no min in mm is refused: dropping it would drop a clearance without a word.
pub fn parse(text: &str) -> Result<Rules, String> {
    let (mut domains, mut between) = (Domains::default(), BTreeMap::<String, f64>::new());
    let mut out = Rules::default();
    for rule in parse_tree(text).iter().filter_map(|n| n.headed("rule")).filter_map(raw_rule) {
        if let Some(kind) = &rule.unreadable {
            return Err(format!("rule {}: {kind} has no min in mm", rule.name));
        }
        let (c, exception) = split_exception(&rule.condition.replace(' ', ""));
        if let (Some(class), Some(creepage)) = (
            c.strip_suffix("&&B.NetName==''").and_then(|a| one_class(a, "A.NetClass==")),
            rule.gaps.creepage,
        ) {
            out.nonet.push((class.to_string(), creepage));
            continue;
        }
        if rule.gaps.is_empty() || !c.contains("NetClass") || LOCAL.iter().any(|k| c.contains(k)) {
            continue;
        }
        match classify(&c, &rule.gaps) {
            Form::Domain(class) => {
                if let Some((reference, pad)) = exception {
                    out.members.push((class.clone(), reference, pad));
                }
                domains.raise(class, rule.gaps.gap());
            }
            Form::ClassGap(class) => {
                let slot = between.entry(class).or_insert(0.0);
                *slot = slot.max(rule.gaps.gap());
            }
            Form::Hole(class, refs) => out.holes.push((class, refs, rule.gaps.hole.unwrap_or(0.0))),
            Form::Pair(a, b) => out.pairs.push((a, b, rule.gaps.gap())),
            Form::Unknown => out.ignored.push(rule.name),
        }
    }
    out.ignored.extend(between.keys().filter(|p| !domains.gap.contains_key(*p)).cloned());
    out.domains = domains.order.iter().map(|p| (p.clone(), domains.gap[p], between.get(p).copied().unwrap_or(0.0))).collect();
    out.pairs = sorted_unique(out.pairs);
    out.members = sorted_unique(out.members);
    out.nonet = sorted_unique(out.nonet);
    out.ignored = sorted_unique(out.ignored);
    Ok(out)
}

/// Shell pattern match: * ? [seq] [!seq].
pub fn fnmatch(name: &str, pattern: &str) -> bool {
    let (n, p): (Vec<char>, Vec<char>) = (name.chars().collect(), pattern.chars().collect());
    glob(&n, &p)
}

fn set_end(p: &[char]) -> Option<usize> {
    let start = if p.get(1) == Some(&'!') { 2 } else { 1 };
    (start + 1..p.len()).find(|&k| p[k] == ']')
}

fn in_set(c: char, set: &[char]) -> bool {
    let (negated, set) = match set.split_first() {
        Some(('!', rest)) => (true, rest),
        _ => (false, set),
    };
    let mut hit = false;
    let mut i = 0;
    while i < set.len() {
        if i + 2 < set.len() && set[i + 1] == '-' {
            hit |= (set[i]..=set[i + 2]).contains(&c);
            i += 3;
        } else {
            hit |= set[i] == c;
            i += 1;
        }
    }
    hit != negated
}

fn glob(n: &[char], p: &[char]) -> bool {
    match p.first() {
        None => n.is_empty(),
        Some('*') => (0..=n.len()).any(|k| glob(&n[k..], &p[1..])),
        Some('?') => !n.is_empty() && glob(&n[1..], &p[1..]),
        Some('[') => match set_end(p) {
            Some(end) => !n.is_empty() && in_set(n[0], &p[1..end]) && glob(&n[1..], &p[end + 1..]),
            None => n.first() == Some(&'[') && glob(&n[1..], &p[1..]),
        },
        Some(c) => n.first() == Some(c) && glob(&n[1..], &p[1..]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(name: &str, cond: &str, constraint: &str) -> String {
        format!("(rule \"{name}\"\n (condition \"{cond}\")\n (constraint {constraint}))\n")
    }

    #[test]
    fn domain_and_class_gap() {
        let text = rule("m", "A.NetClass == 'MAINS' && B.NetClass != 'MAINS'", "clearance (min 8mm)")
            + &rule("b", "A.NetClass == 'MAINS' && B.NetClass == 'MAINS' && A.NetClass != B.NetClass", "clearance (min 3mm)");
        assert_eq!(parse(&text).unwrap().domains, vec![("MAINS".to_string(), 8.0, 3.0)]);
    }

    #[test]
    fn creepage_counts_as_the_gap_and_the_larger_wins() {
        let text = format!(
            "(rule a (condition \"A.NetClass == 'P' && B.NetClass != 'P'\") (constraint clearance (min 2mm)) (constraint creepage (min 5mm)))"
        );
        assert_eq!(parse(&text).unwrap().domains[0].1, 5.0);
    }

    #[test]
    fn hole_rule_lists_its_refs() {
        let text = rule("h", "A.NetClass == 'P' && (B.Reference == 'H1' || B.Reference == 'H2')", "hole_clearance (min 9.65mm)");
        assert_eq!(parse(&text).unwrap().holes, vec![("P".to_string(), vec!["H1".to_string(), "H2".to_string()], 9.65)]);
    }

    #[test]
    fn pair_rule_between_class_sets() {
        let text = rule("i", "(A.NetClass == 'F' || A.NetClass == 'G') && (B.NetClass == 'H')", "clearance (min 4mm)");
        assert_eq!(parse(&text).unwrap().pairs, vec![(vec!["F".to_string(), "G".to_string()], vec!["H".to_string()], 4.0)]);
    }

    #[test]
    fn member_pad_and_nonet_creepage() {
        let a = rule("m", "A.NetClass == 'P' && B.NetClass != 'P' && !(B.Type == 'Pad' && B.memberOfFootprint('K1') && B.Pad_Number == '7')", "clearance (min 8mm)");
        let b = rule("n", "A.NetClass == 'P' && B.NetName == ''", "creepage (min 6mm)");
        let r = parse(&(a + &b)).unwrap();
        assert_eq!(r.members, vec![("P".to_string(), "K1".to_string(), "7".to_string())]);
        assert_eq!(r.nonet, vec![("P".to_string(), 6.0)]);
    }

    #[test]
    fn local_rules_are_skipped_and_unknown_ones_listed() {
        let local = rule("l", "A.NetClass == 'P' && A.intersectsCourtyard('U1')", "clearance (min 1mm)");
        let unknown = rule("u", "A.NetClass == 'P' || B.Layer == 'F.Cu'", "clearance (min 1mm)");
        let r = parse(&(local + &unknown)).unwrap();
        assert_eq!(r.ignored, vec!["u".to_string()]);
    }

    #[test]
    fn a_gap_rule_with_no_readable_min_is_refused() {
        for constraint in ["clearance (min 20mil)", "creepage (opt 1mm)", "hole_clearance (max 1mm)"] {
            let error = parse(&rule("x", "A.NetClass == 'P' && B.NetClass != 'P'", constraint)).unwrap_err();
            assert!(error.starts_with("rule x:"), "{error}");
        }
        assert!(parse(&rule("w", "A.NetClass == 'P'", "track_width (opt 1mm)")).is_ok());
    }

    #[test]
    fn comments_and_tree() {
        let t = parse_tree("# note\n(a \"b c\" (d))");
        let inner = vec![Node::Atom("a".into()), Node::Atom("b c".into()), Node::List(vec![Node::Atom("d".into())])];
        assert_eq!(t, vec![Node::List(inner)]);
    }

    #[test]
    fn shell_patterns() {
        assert!(fnmatch("MAINS_K1", "MAINS_K*"));
        assert!(fnmatch("K1", "K?"));
        assert!(fnmatch("K1", "K[0-9]"));
        assert!(!fnmatch("K1", "K[!0-9]"));
        assert!(!fnmatch("MAINS", "M"));
    }
}
