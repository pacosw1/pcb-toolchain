//! Reading rule, board and DSN text for admission: `kicad::raw` with the error text admission records.
use crate::kicad::raw::{Body, Form, parse_unglued};
use crate::pytext::repr;
use std::borrow::Cow;

fn read(text: &str) -> Result<Vec<Form>, String> {
    parse_unglued(text).map_err(|error| {
        if error.contains("unterminated") { "invalid or unterminated rule/model token" } else { "unbalanced rule/model parentheses" }.to_string()
    })
}

/// The top-level forms of a `.kicad_dru` or `.kicad_pcb` text.
pub fn rule_forms(text: &str) -> Result<Vec<Form>, String> {
    read(text)
}

/// The top-level forms of a DSN. The parser section declares its quote character as a bare quote, `(string_quote ")`; it is
/// masked at the same length, so spans stay spans of `text`. A complete DSN reads as one `pcb` form.
pub fn dsn_forms(text: &str) -> Result<Vec<Form>, String> {
    read(&masked_string_quote(text))
}

fn masked_string_quote(text: &str) -> Cow<'_, str> {
    let mut out: Option<Vec<u8>> = None;
    let open = "(string_quote";
    let mut position = 0;
    while let Some(found) = text[position..].find(open) {
        let after = position + found + open.len();
        let rest = &text[after..];
        let quote = after + rest.len() - rest.trim_start().len();
        if quote > after && text[quote..].starts_with("\")") {
            out.get_or_insert_with(|| text.as_bytes().to_vec())[quote] = b'\'';
        }
        position = after;
    }
    match out {
        Some(bytes) => Cow::Owned(String::from_utf8(bytes).expect("a quote byte replaced by a quote byte")),
        None => Cow::Borrowed(text),
    }
}

/// A form as Python prints the list it read: for error text.
pub(super) fn form_repr(form: &Form) -> String {
    match &form.body {
        Body::Atom(text) => repr(text),
        Body::List(items) => format!("[{}]", items.iter().map(form_repr).collect::<Vec<_>>().join(", ")),
    }
}

/// An atom used as a key: a list cannot be one.
pub(super) fn key(form: &Form) -> Result<&str, String> {
    form.atom().ok_or_else(|| "unhashable type: 'list'".to_string())
}

/// True for a form with exactly these atoms.
pub(super) fn is_atoms(form: &Form, atoms: &[&str]) -> bool {
    form.items().len() == atoms.len() && form.items().iter().zip(atoms).all(|(item, atom)| item.atom() == Some(*atom))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bare_quote_directive_reads_and_spans_stay_on_the_text() {
        let text = "(pcb \"Ω\" (parser (string_quote \")\n (space_in_quoted_tokens on)) (unit um))";
        let forms = dsn_forms(text).unwrap();
        let unit = forms[0].children("unit").next().unwrap();
        assert_eq!(&text[unit.span.clone()], "(unit um)");
    }

    #[test]
    fn errors_are_the_ones_admission_records() {
        assert_eq!(dsn_forms("(a \"b)").unwrap_err(), "invalid or unterminated rule/model token");
        assert_eq!(rule_forms("(a").unwrap_err(), "unbalanced rule/model parentheses");
        assert_eq!(rule_forms("a)").unwrap_err(), "unbalanced rule/model parentheses");
    }

    #[test]
    fn a_form_prints_as_a_python_list() {
        assert_eq!(form_repr(&rule_forms("(a (b \"c\"))").unwrap()[0]), "['a', ['b', 'c']]");
    }
}
