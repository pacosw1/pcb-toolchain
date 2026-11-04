//! Fastroute exclusions without deleting electrical pin membership.
//!
//! Apply after all rule, layer and padstack changes. Ignored subclasses inherit every class property and class_class rule;
//! the DSN outside the network section stays byte for byte. A form this does not understand fails before the router starts.
use crate::kicad::raw::{self, Form};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};

/// A DSN with the nets that are not routed moved to ignored classes.
#[derive(Debug, PartialEq, Eq)]
pub struct Exclusion {
    pub text: String,
    /// The new class names, sorted: the router's --ignore-net-classes.
    pub ignored_classes: Vec<String>,
}

/// An edit of the DSN text.
struct Change {
    start: usize,
    end: usize,
    text: String,
}

/// The network section: spans are positions in the whole DSN.
struct Network<'a> {
    dsn: &'a str,
    offset: usize,
    root: Form,
}

impl<'a> Network<'a> {
    fn read(dsn: &'a str) -> Result<Self, String> {
        let offset = dsn.find("(network").ok_or("DSN has no network section")?;
        let root = raw::parse_first(&dsn[offset..]).map_err(|error| format!("invalid DSN network: {error}"))?;
        Ok(Self { dsn, offset, root })
    }

    fn lists(&self) -> impl Iterator<Item = &Form> {
        lists(&self.root)
    }

    fn of_kind(&self, kind: &'static str) -> impl Iterator<Item = &Form> {
        self.lists().filter(move |form| first_atom(form) == Some(kind))
    }

    /// The source text of a form.
    fn source(&self, form: &Form) -> &'a str {
        &self.dsn[self.offset + form.span.start..self.offset + form.span.end]
    }

    fn change(&self, form: &Form, text: String) -> Change {
        Change { start: self.offset + form.span.start, end: self.offset + form.span.end, text }
    }

    /// Text inserted before the closing parenthesis of the section.
    fn append(&self, text: String) -> Change {
        let at = self.offset + self.root.span.end - 1;
        Change { start: at, end: at, text }
    }
}

fn atoms(form: &Form) -> impl Iterator<Item = &Form> {
    form.items().iter().filter(|item| item.atom().is_some())
}

fn lists(form: &Form) -> impl Iterator<Item = &Form> {
    form.items().iter().filter(|item| item.atom().is_none())
}

fn first_atom(form: &Form) -> Option<&str> {
    atoms(form).next()?.atom()
}

/// The name in a `(net NAME ...)` or `(class NAME ...)` form.
fn name_of(form: &Form) -> Option<&str> {
    atoms(form).nth(1)?.atom()
}

fn python_list<'a>(names: impl IntoIterator<Item = &'a str>) -> String {
    let quoted: Vec<String> = names.into_iter().map(|name| format!("'{name}'")).collect();
    format!("[{}]", quoted.join(", "))
}

/// The classes of the skipped nets: the edits, and the ignored class of each class it took nets from.
struct Split {
    changes: Vec<Change>,
    additions: Vec<String>,
    aliases: HashMap<String, String>,
}

fn split_classes(network: &Network, skipped: &BTreeSet<&str>) -> Result<Split, String> {
    let classes: Vec<&Form> = network.of_kind("class").collect();
    let taken: Vec<String> = classes.iter().filter_map(|class| name_of(class)).map(str::to_lowercase).collect();
    let mut split = Split { changes: Vec::new(), additions: Vec::new(), aliases: HashMap::new() };
    let mut covered = BTreeSet::new();
    for (index, class) in classes.iter().enumerate() {
        let ignored: Vec<&Form> = atoms(class).skip(2).filter(|atom| atom.atom().is_some_and(|net| skipped.contains(net))).collect();
        if ignored.is_empty() {
            continue;
        }
        for net in ignored.iter().filter_map(|atom| atom.atom()) {
            if !covered.insert(net) {
                return Err("skipped net belongs to multiple DSN classes".to_string());
            }
        }
        let alias = format!("IOT_SKIP_{index}");
        if taken.contains(&alias.to_lowercase()) {
            return Err("reserved ignored class name already present".to_string());
        }
        split.additions.push(ignored_class(network, class, &alias, &ignored));
        split.changes.extend(ignored.iter().map(|atom| network.change(atom, String::new())));
        split.aliases.insert(name_of(class).unwrap_or_default().to_string(), alias);
    }
    if covered != *skipped {
        return Err(format!("skipped nets lack explicit DSN class: {}", python_list(skipped.difference(&covered).copied())));
    }
    Ok(split)
}

/// The new class: the members, then the nested circuit and rule forms of the old class as they stand.
fn ignored_class(network: &Network, class: &Form, alias: &str, members: &[&Form]) -> String {
    let members: Vec<&str> = members.iter().map(|atom| network.source(atom)).collect();
    let tail_start = lists(class).next().map_or(class.span.end - 1, |nested| nested.span.start);
    let tail = &network.dsn[network.offset + tail_start..network.offset + class.span.end];
    format!("(class {alias} {}\n{tail}", members.join(" "))
}

/// The pairwise rules for every combination of an original and an ignored class, with their values.
fn pair_rules(network: &Network, aliases: &HashMap<String, String>) -> Result<Vec<String>, String> {
    let mut rules = Vec::new();
    for rule in network.of_kind("class_class") {
        let mut groups = lists(rule).filter(|form| first_atom(form) == Some("classes"));
        let (Some(group), None) = (groups.next(), groups.next()) else { return Err("unsupported DSN class_class form".to_string()) };
        let names: Vec<&Form> = atoms(group).skip(1).collect();
        let [left, right] = names[..] else { return Err("unsupported DSN class_class form".to_string()) };
        let sides = |side: &Form| {
            let alias = side.atom().and_then(|name| aliases.get(name)).map(String::as_str);
            [Some(network.source(side)), alias].into_iter().flatten().collect::<Vec<_>>()
        };
        for (i, a) in sides(left).into_iter().enumerate() {
            for (j, b) in sides(right).into_iter().enumerate() {
                if i + j > 0 {
                    rules.push(renamed(network, rule, (left, a), (right, b)));
                }
            }
        }
    }
    Ok(rules)
}

/// The text of `rule` with its two class names replaced.
fn renamed(network: &Network, rule: &Form, left: (&Form, &str), right: (&Form, &str)) -> String {
    let source = network.source(rule);
    let cut = |form: &Form| (form.span.start - rule.span.start, form.span.end - rule.span.start);
    let ((left_start, left_end), (right_start, right_end)) = (cut(left.0), cut(right.0));
    format!("{}{}{}{}{}", &source[..left_start], left.1, &source[left_end..right_start], right.1, &source[right_end..])
}

fn apply(dsn: &str, mut changes: Vec<Change>) -> String {
    changes.sort_by_key(|change| change.start);
    let mut out = String::with_capacity(dsn.len());
    let mut at = 0;
    for change in changes {
        out.push_str(&dsn[at..change.start]);
        out.push_str(&change.text);
        at = change.end;
    }
    out.push_str(&dsn[at..]);
    out
}

/// Move every net not in `routed` to an ignored class. Every routed net must be in the DSN; every other one needs a class.
pub fn exclude(dsn: &str, routed: &BTreeSet<String>) -> Result<Exclusion, String> {
    let network = Network::read(dsn)?;
    let declared: BTreeSet<&str> = network.of_kind("net").filter_map(name_of).collect();
    let missing: Vec<&str> = routed.iter().map(String::as_str).filter(|net| !declared.contains(net)).collect();
    if !missing.is_empty() {
        return Err(format!("routed nets absent from DSN: {}", python_list(missing)));
    }
    let skipped: BTreeSet<&str> = declared.iter().copied().filter(|net| !routed.contains(*net)).collect();
    let Split { mut changes, mut additions, aliases } = split_classes(&network, &skipped)?;
    additions.extend(pair_rules(&network, &aliases)?);
    if !additions.is_empty() {
        changes.push(network.append(format!("\n{}\n", additions.join("\n"))));
    }
    let mut ignored_classes: Vec<String> = aliases.into_values().collect();
    ignored_classes.sort();
    Ok(Exclusion { text: apply(dsn, changes), ignored_classes })
}

/// Open connections of the routed nets in a router report: unrouted minus those of ignored classes.
pub fn routable_open(report: &Value) -> Result<i64, String> {
    let stats = &report["stats"];
    match (stats["unrouted"].as_i64(), stats["unrouted_ignored_classes"].as_i64()) {
        (Some(total), Some(ignored)) if 0 <= ignored && ignored <= total => Ok(total - ignored),
        _ => Err("invalid router ignored-net accounting".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const FIXTURE: &str = "(pcb test
 (parser (string_quote \"))
 (network
  (net A (pins U1-1 U2-1))
  (net B (pins U1-2 U2-2))
  (net C (pins U1-3 U2-3))
  (class Mixed A B (circuit (use_via VIA)) (rule (width 220) (clearance 200)))
  (class Other C (rule (width 180) (clearance 300)))
  (class_class (classes Mixed Other) (rule (clearance 500)))
 )
 (wiring (wire (path F.Cu 220 0 0 1000 0) (net B) (type fix)))
)";

    fn routed(nets: &[&str]) -> BTreeSet<String> {
        nets.iter().map(|net| net.to_string()).collect()
    }

    fn wiring(text: &str) -> &str {
        &text[text.find("(wiring").unwrap()..]
    }

    /// Atoms of each list of the network section, to compare forms without their spacing.
    fn shape(form: &Form) -> String {
        match form.atom() {
            Some(atom) => atom.to_string(),
            None => format!("({})", form.items().iter().map(shape).collect::<Vec<_>>().join(" ")),
        }
    }

    fn network(text: &str) -> Vec<String> {
        let form = raw::parse_first(&text[text.find("(network").unwrap()..]).unwrap();
        form.items().iter().filter(|item| item.atom().is_none()).map(shape).collect()
    }

    fn starting(text: &str, head: &str) -> Vec<String> {
        network(text).into_iter().filter(|form| form.starts_with(head)).collect()
    }

    #[test]
    fn membership_stays_and_only_the_skipped_net_moves() {
        let result = exclude(FIXTURE, &routed(&["A", "C"])).unwrap();
        assert_eq!(result.ignored_classes, ["IOT_SKIP_0"]);
        assert_eq!(starting(&result.text, "(net "), starting(FIXTURE, "(net "));
        assert_eq!(wiring(&result.text), wiring(FIXTURE));
        let classes = starting(&result.text, "(class ");
        assert_eq!(classes[0], "(class Mixed A (circuit (use_via VIA)) (rule (width 220) (clearance 200)))");
        assert_eq!(classes[1], "(class Other C (rule (width 180) (clearance 300)))");
        assert_eq!(classes[2], "(class IOT_SKIP_0 B (circuit (use_via VIA)) (rule (width 220) (clearance 200)))");
        assert_eq!(
            starting(&result.text, "(class_class "),
            ["(class_class (classes Mixed Other) (rule (clearance 500)))", "(class_class (classes IOT_SKIP_0 Other) (rule (clearance 500)))"]
        );
    }

    #[test]
    fn no_selection_excludes_every_net() {
        let result = exclude(FIXTURE, &routed(&[])).unwrap();
        assert_eq!(result.ignored_classes, ["IOT_SKIP_0", "IOT_SKIP_1"]);
        assert_eq!(starting(&result.text, "(net ").len(), 3);
        assert_eq!(starting(&result.text, "(class_class ").len(), 4);
    }

    #[test]
    fn all_selected_changes_nothing() {
        let result = exclude(FIXTURE, &routed(&["A", "B", "C"])).unwrap();
        assert!(result.ignored_classes.is_empty());
        assert_eq!(result.text, FIXTURE);
    }

    #[test]
    fn unknown_and_unclassified_nets_fail_closed() {
        assert_eq!(exclude(FIXTURE, &routed(&["missing"])).unwrap_err(), "routed nets absent from DSN: ['missing']");
        let unclassified = FIXTURE.replace("Mixed A B", "Mixed A");
        assert_eq!(exclude(&unclassified, &routed(&["A", "C"])).unwrap_err(), "skipped nets lack explicit DSN class: ['B']");
    }

    #[test]
    fn the_ignored_class_name_is_reserved() {
        let taken = FIXTURE.replace("Other C", "iot_skip_0 C");
        assert_eq!(exclude(&taken, &routed(&["A", "C"])).unwrap_err(), "reserved ignored class name already present");
    }

    #[test]
    fn a_net_in_two_classes_fails() {
        let twice = FIXTURE.replace("Other C", "Other B C");
        assert_eq!(exclude(&twice, &routed(&["A", "C"])).unwrap_err(), "skipped net belongs to multiple DSN classes");
    }

    #[test]
    fn an_unknown_class_class_form_fails() {
        let odd = FIXTURE.replace("(classes Mixed Other)", "(classes Mixed)");
        assert_eq!(exclude(&odd, &routed(&["A", "C"])).unwrap_err(), "unsupported DSN class_class form");
    }

    #[test]
    fn a_quoted_net_keeps_its_quotes_in_the_new_class() {
        let quoted = FIXTURE.replace("(net B (pins", "(net \"B 1\" (pins").replace("Mixed A B", "Mixed A \"B 1\"");
        let result = exclude(&quoted, &routed(&["A", "C"])).unwrap();
        assert!(result.text.contains("(class IOT_SKIP_0 \"B 1\"\n"), "{}", result.text);
    }

    #[test]
    fn a_dsn_with_no_network_is_an_error() {
        assert!(exclude("(pcb x)", &routed(&[])).is_err());
    }

    #[test]
    fn report_accounting() {
        assert_eq!(routable_open(&json!({"stats": {"unrouted": 3, "unrouted_ignored_classes": 3}})), Ok(0));
        assert_eq!(routable_open(&json!({"stats": {"unrouted": 4, "unrouted_ignored_classes": 3}})), Ok(1));
        for bad in [json!({}), json!({"unrouted": 1, "unrouted_ignored_classes": 2}), json!({"unrouted": true})] {
            assert!(routable_open(&json!({"stats": bad})).is_err());
        }
    }
}
