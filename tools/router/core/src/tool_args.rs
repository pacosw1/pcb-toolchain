//! Command lines of the board tools, argparse's way: `--name value` or `--name=value`, options and paths in any order.
use std::collections::VecDeque;

pub struct Args {
    rest: VecDeque<String>,
}

impl Args {
    pub fn new(args: impl IntoIterator<Item = String>) -> Args {
        let split = |arg: String| match arg.split_once('=') {
            Some((name, value)) if name.starts_with("--") => vec![name.to_string(), value.to_string()],
            _ => vec![arg],
        };
        Args { rest: args.into_iter().flat_map(split).collect() }
    }

    pub fn from_env() -> Args {
        Args::new(std::env::args().skip(1))
    }

    pub fn next(&mut self) -> Option<String> {
        self.rest.pop_front()
    }

    /// The value of option `name`.
    pub fn value(&mut self, name: &str) -> Result<String, String> {
        self.next().ok_or_else(|| format!("{name} needs a value"))
    }

    pub fn number(&mut self, name: &str) -> Result<f64, String> {
        let value = self.value(name)?;
        value.parse().map_err(|_| format!("{name}: not a number: {value}"))
    }
}

/// The items of a comma list; an empty item is none.
pub fn list(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(',').filter(|item| !item.is_empty()).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(text: &[&str]) -> Args {
        Args::new(text.iter().map(|s| s.to_string()))
    }

    #[test]
    fn both_spellings_of_an_option_read_alike() {
        let mut a = args(&["--r=1.5", "--net", "GND", "board"]);
        assert_eq!(a.next().as_deref(), Some("--r"));
        assert_eq!(a.number("--r"), Ok(1.5));
        assert_eq!(a.next().as_deref(), Some("--net"));
        assert_eq!(a.value("--net").as_deref(), Ok("GND"));
        assert_eq!(a.next().as_deref(), Some("board"));
    }

    #[test]
    fn an_equals_sign_in_a_value_stays() {
        let mut a = args(&["--width", "NET=0.3"]);
        a.next();
        assert_eq!(a.value("--width").as_deref(), Ok("NET=0.3"));
    }

    #[test]
    fn a_missing_or_bad_value_says_which() {
        assert!(args(&[]).value("--net").unwrap_err().contains("--net"));
        assert!(args(&["x"]).number("--r").unwrap_err().contains("not a number"));
    }

    #[test]
    fn a_list_drops_empty_items() {
        assert_eq!(list("a,,b,").collect::<Vec<_>>(), ["a", "b"]);
    }
}
