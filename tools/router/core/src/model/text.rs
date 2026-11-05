//! Small text and number helpers of the model: glob match and decimal rounding.

/// Shell-style match with `*`, `?` and `[...]`, case sensitive and over the whole text. A `[` with no closing `]` is literal.
pub fn glob_match(text: &str, pattern: &str) -> bool {
    let (t, p): (Vec<char>, Vec<char>) = (text.chars().collect(), pattern.chars().collect());
    glob(&t, &p)
}

fn glob(text: &[char], pattern: &[char]) -> bool {
    let Some((first, rest)) = pattern.split_first() else { return text.is_empty() };
    match first {
        '*' => (0..=text.len()).any(|i| glob(&text[i..], rest)),
        '?' => !text.is_empty() && glob(&text[1..], rest),
        '[' => match char_class(rest) {
            Some((class, after)) => !text.is_empty() && class.matches(text[0]) && glob(&text[1..], after),
            None => text.first() == Some(&'[') && glob(&text[1..], rest),
        },
        c => text.first() == Some(c) && glob(&text[1..], rest),
    }
}

struct CharClass<'a> {
    negated: bool,
    body: &'a [char],
}

impl CharClass<'_> {
    fn matches(&self, c: char) -> bool {
        let mut hit = false;
        let mut i = 0;
        while i < self.body.len() {
            if i + 2 < self.body.len() && self.body[i + 1] == '-' {
                hit |= self.body[i] <= c && c <= self.body[i + 2];
                i += 3;
            } else {
                hit |= self.body[i] == c;
                i += 1;
            }
        }
        hit != self.negated
    }
}

/// The class after a `[`, and the pattern after its `]`. A `]` right after the opening is a member.
fn char_class(after_open: &[char]) -> Option<(CharClass<'_>, &[char])> {
    let negated = after_open.first() == Some(&'!');
    let start = usize::from(negated);
    let end = (start + 1..after_open.len()).find(|&i| after_open[i] == ']')?;
    Some((CharClass { negated, body: &after_open[start..end] }, &after_open[end + 1..]))
}

/// `value` rounded to `digits` decimals from its exact binary value, ties to even, as Python's round().
pub fn round_to(value: f64, digits: usize) -> f64 {
    format!("{value:.digits$}").parse().expect("a formatted float reads back")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn globs_match_the_whole_text() {
        assert!(glob_match("MAINS_K1", "MAINS_K*"));
        assert!(glob_match("U3", "U?"));
        assert!(!glob_match("U33", "U?"));
        assert!(!glob_match("xU3", "U3"));
        assert!(glob_match("", "*"));
        assert!(!glob_match("a", ""));
    }

    #[test]
    fn classes_take_ranges_and_negation() {
        assert!(glob_match("J2", "J[12]"));
        assert!(glob_match("J7", "J[5-9]"));
        assert!(!glob_match("J7", "J[!5-9]"));
        assert!(glob_match("]", "[]]"));
    }

    #[test]
    fn an_open_bracket_with_no_close_is_literal() {
        assert!(glob_match("a[b", "a[b"));
    }

    #[test]
    fn rounding_is_from_the_exact_value_with_ties_to_even() {
        assert_eq!(round_to(1.23456789, 4), 1.2346);
        assert_eq!(round_to(0.125, 2), 0.12);
        assert_eq!(round_to(0.375, 2), 0.38);
        assert_eq!(round_to(2.675, 2), 2.67);
    }
}
