//! S-expression reader for KiCad text files (.kicad_pcb, .kicad_dru). Quoted and bare atoms are the same node; a line whose
//! first text is `#` is a comment, as in KiCad's lexer.

/// An atom or a list.
#[derive(Debug, Clone, PartialEq)]
pub enum Node {
    Atom(String),
    List(Vec<Node>),
}

impl Node {
    pub fn atom(&self) -> Option<&str> {
        match self {
            Node::Atom(s) => Some(s),
            Node::List(_) => None,
        }
    }

    pub fn items(&self) -> &[Node] {
        match self {
            Node::Atom(_) => &[],
            Node::List(l) => l,
        }
    }

    /// The atom at the head of a list.
    pub fn head(&self) -> Option<&str> {
        self.items().first()?.atom()
    }

    pub fn is(&self, head: &str) -> bool {
        self.head() == Some(head)
    }

    /// Item `i` of a list, as text.
    pub fn text(&self, i: usize) -> Option<&str> {
        self.items().get(i)?.atom()
    }

    pub fn child(&self, head: &str) -> Option<&Node> {
        self.items().iter().find(|n| n.is(head))
    }

    pub fn children<'a>(&'a self, head: &'a str) -> impl Iterator<Item = &'a Node> {
        self.items().iter().filter(move |n| n.is(head))
    }

    /// The first value of a child: `(head value ...)`.
    pub fn value(&self, head: &str) -> Option<&str> {
        self.child(head)?.text(1)
    }

    /// True when a child `(head yes)`, `(head)` or a bare `head` atom says so.
    pub fn flag(&self, head: &str) -> bool {
        self.items().iter().any(|n| n.atom() == Some(head))
            || self.child(head).is_some_and(|c| c.text(1) != Some("no"))
    }
}

/// Every top-level form of the text.
pub fn parse(text: &str) -> Result<Vec<Node>, String> {
    let mut stack: Vec<Vec<Node>> = vec![Vec::new()];
    let mut lexer = Lexer { text, pos: 0 };
    while let Some(token) = lexer.next()? {
        match token {
            Token::Open => stack.push(Vec::new()),
            Token::Close => {
                let done = stack.pop().ok_or("unbalanced parentheses")?;
                stack.last_mut().ok_or("unbalanced parentheses")?.push(Node::List(done));
            }
            Token::Atom(a) => stack.last_mut().ok_or("unbalanced parentheses")?.push(Node::Atom(a)),
        }
    }
    match (stack.pop(), stack.is_empty()) {
        (Some(top), true) => Ok(top),
        _ => Err("unbalanced parentheses".to_string()),
    }
}

enum Token {
    Open,
    Close,
    Atom(String),
}

struct Lexer<'a> {
    text: &'a str,
    pos: usize,
}

impl Lexer<'_> {
    fn next(&mut self) -> Result<Option<Token>, String> {
        self.skip_blank();
        let rest = &self.text[self.pos..];
        let Some(c) = rest.chars().next() else { return Ok(None) };
        Ok(Some(match c {
            '(' => {
                self.pos += 1;
                Token::Open
            }
            ')' => {
                self.pos += 1;
                Token::Close
            }
            '"' => Token::Atom(self.quoted()?),
            _ => {
                let end = rest.find(|c: char| c.is_whitespace() || matches!(c, '(' | ')' | '"')).unwrap_or(rest.len());
                self.pos += end;
                Token::Atom(rest[..end].to_string())
            }
        }))
    }

    /// Whitespace, and comment lines.
    fn skip_blank(&mut self) {
        let bytes = self.text.as_bytes();
        let mut line_start = self.pos == 0 || bytes[self.pos - 1] == b'\n';
        while self.pos < bytes.len() {
            match bytes[self.pos] {
                b'\n' => line_start = true,
                b' ' | b'\t' | b'\r' => {}
                b'#' if line_start => {
                    self.pos += self.text[self.pos..].find('\n').unwrap_or(bytes.len() - self.pos);
                    continue;
                }
                _ => return,
            }
            self.pos += 1;
        }
    }

    /// A quoted string, with KiCad's escapes.
    fn quoted(&mut self) -> Result<String, String> {
        let mut out = String::new();
        let mut chars = self.text[self.pos + 1..].char_indices();
        while let Some((i, c)) = chars.next() {
            match c {
                '"' => {
                    self.pos += i + 2;
                    return Ok(out);
                }
                '\\' => out.push(match chars.next().map(|(_, e)| e) {
                    Some('n') => '\n',
                    Some('t') => '\t',
                    Some('r') => '\r',
                    Some(e) => e,
                    None => break,
                }),
                _ => out.push(c),
            }
        }
        Err("unterminated string".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(text: &str) -> Node {
        parse(text).unwrap().remove(0)
    }

    #[test]
    fn reads_nested_lists_and_quoted_atoms() {
        let n = one("(net \"a b\" (x 1) y)");
        assert_eq!(n.head(), Some("net"));
        assert_eq!(n.text(1), Some("a b"));
        assert_eq!(n.value("x"), Some("1"));
        assert_eq!(n.text(3), Some("y"));
    }

    #[test]
    fn an_escape_is_read_as_its_character() {
        assert_eq!(one(r#"(a "x\"y\\z")"#).text(1), Some("x\"y\\z"));
    }

    #[test]
    fn a_comment_line_is_skipped_but_a_hash_in_an_atom_stays() {
        let forms = parse("# top\n(a #b)\n  # indented\n(c \"#d\")").unwrap();
        assert_eq!(forms.len(), 2);
        assert_eq!(forms[0].text(1), Some("#b"));
        assert_eq!(forms[1].text(1), Some("#d"));
    }

    #[test]
    fn flags_read_as_atom_child_or_value() {
        let n = one("(pad locked (a yes) (b no) (c))");
        assert!(n.flag("locked") && n.flag("a") && n.flag("c"));
        assert!(!n.flag("b") && !n.flag("d"));
    }

    #[test]
    fn bad_text_is_an_error() {
        for text in ["(a", "a)", "(a \"b)"] {
            assert!(parse(text).is_err(), "{text}");
        }
    }
}
