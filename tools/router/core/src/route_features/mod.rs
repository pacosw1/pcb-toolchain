//! The project root, the features file, and two rule-text helpers.
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

/// The project root: `IOT_LAB`, the nearest parent of the current folder with
/// hardware-design/boards, the folder that holds the tools this binary came from.
pub fn root() -> PathBuf {
    let real = |path: PathBuf| fs::canonicalize(&path).unwrap_or(path);
    if let Some(value) = env::var_os("IOT_LAB").filter(|v| !v.is_empty()) {
        return real(value.into());
    }
    let cwd = env::current_dir().ok().map(real);
    let marked = cwd.as_deref().and_then(|dir| dir.ancestors().find(|d| d.join("hardware-design/boards").is_dir()).map(Path::to_path_buf));
    marked.or_else(tools_root).or(cwd).unwrap_or_default()
}

fn tools_root() -> Option<PathBuf> {
    let exe = env::current_exe().ok()?;
    exe.ancestors().find(|dir| dir.join("tools/route-features.json").is_file()).map(Path::to_path_buf)
}

pub fn defaults_path() -> PathBuf {
    root().join("tools/route-features.json")
}

/// A rule value in mm, leniently: the number at the start, then an optional unit (mm, mil, in). Anything after is not read.
pub fn mm(text: &str) -> Result<f64, String> {
    let end = text.find(|c: char| !c.is_ascii_digit() && c != '.').unwrap_or(text.len());
    let (digits, rest) = text.split_at(end);
    let value: f64 = digits.parse().map_err(|_| format!("could not convert string to float: '{digits}'"))?;
    let rest = rest.trim_start();
    Ok(if rest.starts_with("mil") {
        value * 0.0254
    } else if rest.starts_with("in") {
        value * 25.4
    } else {
        value
    })
}

/// `&&`, `||` and `!` spelled out over the whole text, quoted literals included: the literal a compiled rule compares is
/// the literal after this, so a net name with `!` in it matches nothing.
pub fn spelled_out(condition: &str) -> String {
    let words = condition.replace("&&", " and ").replace("||", " or ");
    let mut out = String::with_capacity(words.len());
    let mut chars = words.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '!' && chars.peek() != Some(&'=') {
            out.push_str(" not ");
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::mm;

    #[test]
    fn mm_reads_the_number_at_the_start() {
        assert_eq!(mm("0.2mm"), Ok(0.2));
        assert_eq!(mm("10mil").unwrap(), 10.0 * 0.0254);
        assert_eq!(mm("1 in").unwrap(), 25.4);
        assert_eq!(mm("3cm"), Ok(3.0));
        assert!(mm("-1mm").is_err() && mm("1.2.3").is_err());
    }
}
