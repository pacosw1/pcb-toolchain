//! The custom rule file (.kicad_dru): rules, their constraints and the numbers in them.
use super::selector::Selector;
use crate::kicad::sexpr::{Node, parse};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq)]
pub struct Rule {
    pub name: String,
    pub condition: Selector,
    pub layer: Option<String>,
    pub constraints: Vec<Constraint>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Constraint {
    pub kind: String,
    /// `(min 0.2mm)` and the like, as written.
    pub values: BTreeMap<String, String>,
    /// The bare words after the kind: the item types of `disallow`.
    pub items: Vec<String>,
}

impl Constraint {
    pub fn value(&self, name: &str) -> Option<Result<f64, String>> {
        self.values.get(name).map(|v| number(v))
    }
}

/// Which item pairs a hole rule covers, from its condition. Only these spellings are known: another condition is reported,
/// never guessed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HoleScope {
    All,
    EitherThroughHole,
    BothThroughHole,
}

impl HoleScope {
    pub fn of(condition: &Selector) -> Option<HoleScope> {
        if condition.is_spelled("") || condition.is_spelled("True") {
            Some(HoleScope::All)
        } else if condition.is_spelled("A.Pad_Type == 'Through-hole' || B.Pad_Type == 'Through-hole'") {
            Some(HoleScope::EitherThroughHole)
        } else if condition.is_spelled("A.Pad_Type == 'Through-hole' && B.Pad_Type == 'Through-hole'") {
            Some(HoleScope::BothThroughHole)
        } else {
            None
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            HoleScope::All => "all",
            HoleScope::EitherThroughHole => "either_th",
            HoleScope::BothThroughHole => "both_th",
        }
    }
}

/// The rules of a .kicad_dru text in file order. A rule with no condition holds always.
pub fn parse_rules(text: &str) -> Result<Vec<Rule>, String> {
    parse(text)?.iter().filter(|f| !f.is("version")).map(read_rule).collect()
}

fn read_rule(form: &Node) -> Result<Rule, String> {
    let name = form.text(1).ok_or("a rule with no name")?.to_string();
    Ok(Rule {
        condition: Selector::new(form.value("condition").unwrap_or("True")),
        layer: form.value("layer").map(str::to_string),
        constraints: form.children("constraint").map(read_constraint).collect::<Result<_, _>>().map_err(|e: String| format!("rule {name}: {e}"))?,
        name,
    })
}

fn read_constraint(form: &Node) -> Result<Constraint, String> {
    let rest = form.items().get(2..).unwrap_or(&[]);
    Ok(Constraint {
        kind: form.text(1).ok_or("a constraint with no kind")?.to_string(),
        values: rest.iter().filter_map(|n| match n.items() {
            [Node::Atom(k), Node::Atom(v)] => Some((k.clone(), v.clone())),
            _ => None,
        }).collect(),
        items: rest.iter().filter_map(Node::atom).map(str::to_string).collect(),
    })
}

/// A rule number in millimetres: digits with an optional unit, mm when there is none. Exact until the one rounding to a double.
pub fn number(text: &str) -> Result<f64, String> {
    let bad = || format!("unsupported numeric value or units: {text}");
    let text_digits = text.strip_prefix('+').unwrap_or(text);
    let end = text_digits.find(|c: char| !c.is_ascii_digit() && c != '.').unwrap_or(text_digits.len());
    let (digits, unit) = text_digits.split_at(end);
    // (factor, decimal places of the factor): 1 mil = 0.0254 mm.
    let (factor, places) = match unit.trim_start() {
        "" | "mm" => (1, 0),
        "um" => (1, 3),
        "mil" => (254, 4),
        "in" => (254, 1),
        _ => return Err(bad()),
    };
    let (whole, frac) = digits.split_once('.').unwrap_or((digits, ""));
    if whole.is_empty() && frac.is_empty() || frac.contains('.') {
        return Err(bad());
    }
    let mantissa: u128 = format!("{whole}{frac}").parse().map_err(|_| bad())?;
    let scaled = mantissa.checked_mul(factor).ok_or_else(bad)?;
    format!("{scaled}e-{}", frac.len() + places).parse().map_err(|_| bad())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_rules_in_file_order() {
        let rules = parse_rules("(version 1)\n# note\n(rule \"a\" (layer \"F.Cu\") (condition \"A.NetClass == 'X'\") (constraint clearance (min 0.2mm)) (constraint track_width (min 0.1mm) (opt 0.2mm)))\n(rule b (constraint disallow track via))").unwrap();
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].name, "a");
        assert_eq!(rules[0].layer.as_deref(), Some("F.Cu"));
        assert_eq!(rules[0].condition.text, "A.NetClass == 'X'");
        assert_eq!(rules[0].constraints[1].value("opt"), Some(Ok(0.2)));
        assert_eq!(rules[1].condition.text, "True");
        assert_eq!(rules[1].constraints[0].items, ["track", "via"]);
    }

    #[test]
    fn hole_scope_knows_three_spellings() {
        let of = |text: &str| HoleScope::of(&Selector::new(text));
        assert_eq!(of("True"), Some(HoleScope::All));
        assert_eq!(of(""), Some(HoleScope::All));
        assert_eq!(of("A.Pad_Type=='Through-hole'  ||  B.Pad_Type == 'Through-hole'"), Some(HoleScope::EitherThroughHole));
        assert_eq!(of("A.Pad_Type == 'Through-hole' && B.Pad_Type == 'Through-hole'"), Some(HoleScope::BothThroughHole));
        assert_eq!(of("A.Pad_Type == 'SMD'"), None);
    }

    #[test]
    fn numbers_take_units_and_land_on_the_nearest_double() {
        assert_eq!(number("0.2mm"), Ok(0.2));
        assert_eq!(number("0.2"), Ok(0.2));
        assert_eq!(number("+.5 mm"), Ok(0.5));
        assert_eq!(number("3"), Ok(3.0));
        assert_eq!(number("200um"), Ok(0.2));
        assert_eq!(number("10mil"), Ok(0.254));
        assert_eq!(number("1in"), Ok(25.4));
    }

    #[test]
    fn other_numbers_are_refused() {
        for text in ["-10mm", "1.2.3", "2cm", "", ".", "x"] {
            assert!(number(text).is_err(), "{text}");
        }
    }
}
