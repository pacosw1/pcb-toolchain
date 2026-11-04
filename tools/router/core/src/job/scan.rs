//! A small reader for the fixed text of router logs and DSN heads: each call takes what it matches or gives None.

#[derive(Clone, Copy)]
pub struct Scan<'a> {
    text: &'a str,
}

impl<'a> Scan<'a> {
    pub fn new(text: &'a str) -> Scan<'a> {
        Scan { text }
    }

    pub fn rest(&self) -> &'a str {
        self.text
    }

    pub fn literal(&mut self, head: &str) -> Option<()> {
        self.text = self.text.strip_prefix(head)?;
        Some(())
    }

    fn take(&mut self, wanted: impl Fn(char) -> bool) -> Option<&'a str> {
        let end = self.text.find(|c| !wanted(c)).unwrap_or(self.text.len());
        let (head, rest) = self.text.split_at(end);
        self.text = rest;
        (!head.is_empty()).then_some(head)
    }

    /// One or more whitespace characters.
    pub fn spaces(&mut self) -> Option<()> {
        self.take(char::is_whitespace).map(|_| ())
    }

    pub fn skip_spaces(&mut self) {
        self.text = self.text.trim_start();
    }

    /// `\w+`.
    pub fn word(&mut self) -> Option<&'a str> {
        self.take(|c| c.is_alphanumeric() || c == '_')
    }

    /// `\d+` as a number.
    pub fn whole(&mut self) -> Option<u64> {
        self.take(|c| c.is_ascii_digit())?.parse().ok()
    }

    /// `[\d.]+` as text.
    pub fn decimal(&mut self) -> Option<&'a str> {
        self.take(|c| c.is_ascii_digit() || c == '.')
    }

    /// `[\d.]+` as a number.
    pub fn number(&mut self) -> Option<f64> {
        self.decimal()?.parse().ok()
    }

    /// Everything up to `end`, and past it.
    pub fn until(&mut self, end: &str) -> Option<&'a str> {
        let (head, rest) = self.text.split_once(end)?;
        self.text = rest;
        Some(head)
    }
}
