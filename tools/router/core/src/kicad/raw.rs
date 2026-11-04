//! S-expression reader that keeps the file's own text: atoms stay undecoded and every form knows its byte span.
//!
//! For code that hashes board text or edits it in place. `kicad::sexpr` decodes escapes, which is right for reading values
//! and wrong for both of those. This file uses only std: tools/pcb_search/core includes it by path, because linking
//! iotroute would merge the two crates' serde_json features.

use std::ops::Range;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Body {
    /// The text of an atom: for a quoted atom, what stands between the quotes, escapes included.
    Atom(String),
    List(Vec<Form>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Form {
    /// Bytes of the source text, brackets or quotes included.
    pub span: Range<usize>,
    pub body: Body,
}

impl Form {
    pub fn atom(&self) -> Option<&str> {
        match &self.body {
            Body::Atom(text) => Some(text),
            Body::List(_) => None,
        }
    }

    pub fn items(&self) -> &[Form] {
        match &self.body {
            Body::Atom(_) => &[],
            Body::List(items) => items,
        }
    }

    /// The atom at the head of a list.
    pub fn head(&self) -> Option<&str> {
        self.items().first()?.atom()
    }

    pub fn is(&self, head: &str) -> bool {
        self.head() == Some(head)
    }

    /// Item `index` of a list, as text.
    pub fn text(&self, index: usize) -> Option<&str> {
        self.items().get(index)?.atom()
    }

    pub fn children<'a>(&'a self, head: &'a str) -> impl Iterator<Item = &'a Form> {
        self.items().iter().filter(move |form| form.is(head))
    }
}

/// Every top-level form of the text. A line whose first text is `#` is a comment.
pub fn parse(text: &str) -> Result<Vec<Form>, String> {
    read(text, usize::MAX, false)
}

/// The first top-level form of the text; what follows it is not read. For a form inside text that as a whole is not
/// s-expressions: a Specctra DSN holds an unpaired quote in `(string_quote ")`.
pub fn parse_first(text: &str) -> Result<Form, String> {
    read(text, 1, false)?.pop().ok_or_else(|| "no form".to_string())
}

/// As `parse`, but a quote also ends a bare atom: a DSN writes a pin as `R1-"A 1"`, one bare and one quoted atom.
pub fn parse_unglued(text: &str) -> Result<Vec<Form>, String> {
    read(text, usize::MAX, true)
}

fn read(text: &str, limit: usize, quote_ends_atom: bool) -> Result<Vec<Form>, String> {
    let mut open: Vec<(usize, Vec<Form>)> = Vec::new();
    let mut top = Vec::new();
    let mut position = 0;
    while let Some(start) = next_token(text, position) {
        position = start + 1;
        let form = match text.as_bytes()[start] {
            b'(' => {
                open.push((start, Vec::new()));
                continue;
            }
            b')' => {
                let (begin, items) = open.pop().ok_or("unbalanced parentheses")?;
                Form { span: begin..position, body: Body::List(items) }
            }
            b'"' => {
                position = quoted_end(text, start)?;
                Form { span: start..position, body: Body::Atom(text[start + 1..position - 1].to_string()) }
            }
            _ => {
                position = bare_end(text, start, quote_ends_atom);
                Form { span: start..position, body: Body::Atom(text[start..position].to_string()) }
            }
        };
        open.last_mut().map_or(&mut top, |(_, items)| items).push(form);
        if open.is_empty() && top.len() == limit {
            return Ok(top);
        }
    }
    if open.is_empty() { Ok(top) } else { Err("unbalanced parentheses".to_string()) }
}

/// The start of the next token, past whitespace and comment lines.
fn next_token(text: &str, from: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut position = from;
    let mut line_start = from == 0 || bytes[from - 1] == b'\n';
    while position < bytes.len() {
        match bytes[position] {
            b'\n' => line_start = true,
            b' ' | b'\t' | b'\r' => {}
            b'#' if line_start => {
                position += text[position..].find('\n').unwrap_or(bytes.len() - position);
                continue;
            }
            _ => return Some(position),
        }
        position += 1;
    }
    None
}

fn quoted_end(text: &str, start: usize) -> Result<usize, String> {
    let bytes = text.as_bytes();
    let mut position = start + 1;
    while position < bytes.len() {
        match bytes[position] {
            b'"' => return Ok(position + 1),
            b'\\' => position += 2,
            _ => position += 1,
        }
    }
    Err("unterminated string".to_string())
}

fn bare_end(text: &str, start: usize, quote_ends_atom: bool) -> usize {
    text[start..].find(|c: char| c.is_whitespace() || matches!(c, '(' | ')') || (quote_ends_atom && c == '"')).map_or(text.len(), |end| start + end)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(text: &str) -> Form {
        parse(text).unwrap().remove(0)
    }

    #[test]
    fn atoms_keep_their_escapes() {
        let form = one(r#"(a "x\"y\\z\n" b)"#);
        assert_eq!(form.text(1), Some(r#"x\"y\\z\n"#));
        assert_eq!(form.text(2), Some("b"));
    }

    #[test]
    fn spans_cut_the_source_text_exactly() {
        let text = "\n(kicad_pcb (net 1 \"a b\")\n  (via (at 1 2)))\n";
        let root = one(text);
        assert_eq!(&text[root.span.clone()], text.trim());
        let via = root.children("via").next().unwrap();
        assert_eq!(&text[via.span.clone()], "(via (at 1 2))");
        assert_eq!(&text[via.items()[1].span.clone()], "(at 1 2)");
        assert_eq!(&text[root.items()[1].items()[2].span.clone()], "\"a b\"");
    }

    #[test]
    fn multibyte_text_keeps_byte_spans() {
        let text = "(a \"Ω\" é (b))";
        let form = one(text);
        assert_eq!(form.text(2), Some("é"));
        assert_eq!(&text[form.items()[3].span.clone()], "(b)");
    }

    #[test]
    fn a_comment_line_is_skipped_but_a_hash_in_an_atom_stays() {
        let forms = parse("# top\n(a #b)\n  # indented\n(c \"#d\")").unwrap();
        assert_eq!(forms.len(), 2);
        assert_eq!(forms[0].text(1), Some("#b"));
        assert_eq!(forms[1].text(1), Some("#d"));
    }

    #[test]
    fn the_first_form_does_not_read_what_follows_it() {
        let form = parse_first("(a (b)) \" ) (").unwrap();
        assert_eq!(form.span, 0..7);
        assert!(form.is("a"));
        assert!(parse_first("(a").is_err());
        assert!(parse_first("  ").is_err());
    }

    #[test]
    fn an_unglued_read_ends_a_bare_atom_at_a_quote() {
        let text = "(pins R1-\"(a) 1\" \"U 1\"-2)";
        let form = parse_unglued(text).unwrap().remove(0);
        let atoms: Vec<_> = form.items().iter().filter_map(Form::atom).collect();
        assert_eq!(atoms, ["pins", "R1-", "(a) 1", "U 1", "-2"]);
    }

    #[test]
    fn bad_text_is_an_error() {
        for text in ["(a", "a)", "(a \"b)"] {
            assert!(parse(text).is_err(), "{text}");
        }
    }
}
