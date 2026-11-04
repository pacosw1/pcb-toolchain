//! Block edits on board text. Everything outside the edited block stays byte for byte, which a parsed tree cannot promise.

/// The parentheses of KiCad text, with their index, skipping quoted strings. Strings may hold parentheses.
struct Parens<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl Iterator for Parens<'_> {
    type Item = (usize, u8);

    fn next(&mut self) -> Option<(usize, u8)> {
        let mut quoted = false;
        while let Some(&byte) = self.bytes.get(self.pos) {
            let at = self.pos;
            self.pos += 1;
            match (quoted, byte) {
                (true, b'\\') => self.pos += 1,
                (_, b'"') => quoted = !quoted,
                (false, b'(' | b')') => return Some((at, byte)),
                _ => {}
            }
        }
        None
    }
}

/// Index after the s-expression that opens at `start`.
fn block_end(text: &str, start: usize) -> Result<usize, String> {
    let mut depth = 0usize;
    for (at, paren) in (Parens { bytes: text.as_bytes(), pos: start }) {
        if paren == b'(' {
            depth += 1;
        } else {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                return Ok(at + 1);
            }
        }
    }
    Err("unbalanced s-expression".to_string())
}

/// (start, end) of each depth-1 block that starts with `head`, for example "(zone".
fn top_blocks(text: &str, head: &str) -> Result<Vec<(usize, usize)>, String> {
    let mut out = Vec::new();
    let mut depth = 0i64;
    let mut parens = Parens { bytes: text.as_bytes(), pos: 0 };
    while let Some((at, paren)) = parens.next() {
        if paren == b')' {
            depth -= 1;
        } else if depth == 1 && is_head(&text[at..], head) {
            let end = block_end(text, at)?;
            out.push((at, end));
            parens.pos = end;
        } else {
            depth += 1;
        }
    }
    Ok(out)
}

fn is_head(text: &str, head: &str) -> bool {
    text.strip_prefix(head).is_some_and(|rest| !rest.chars().next().is_some_and(char::is_alphanumeric))
}

/// Remove the top-level zones with these exact names, each with its line. Returns the text and the removed blocks, each
/// ending in a newline. A missing name is an error.
pub fn split_zones(text: &str, names: &[String]) -> Result<(String, Vec<String>), String> {
    let mut kept = String::new();
    let mut blocks = Vec::new();
    let mut found = vec![false; names.len()];
    let mut last = 0;
    for (start, end) in top_blocks(text, "(zone")? {
        let block = &text[start..end];
        let Some(hit) = names.iter().position(|name| block.contains(&format!("(name \"{name}\")"))) else { continue };
        found[hit] = true;
        let line = text[..start].rfind('\n').map_or(0, |newline| newline + 1);
        kept.push_str(&text[last..line.max(last)]);
        let removed = &text[line..end];
        blocks.push(if removed.ends_with('\n') { removed.to_string() } else { format!("{removed}\n") });
        last = if text[end..].starts_with('\n') { end + 1 } else { end };
    }
    let missing: Vec<&str> = names.iter().zip(&found).filter(|(_, found)| !**found).map(|(name, _)| name.as_str()).collect();
    if !missing.is_empty() {
        return Err(format!("no zone named {}", missing.join(", ")));
    }
    kept.push_str(&text[last..]);
    Ok((kept, blocks))
}

/// Insert blocks before the closing parenthesis of the board.
pub fn add_blocks(text: &str, blocks: &[String]) -> Result<String, String> {
    let end = text.rfind(')').ok_or("board text has no closing parenthesis")?;
    Ok(format!("{}{}{}", &text[..end], blocks.concat(), &text[end..]))
}

/// Replace the first block that starts with `head` in `target` by the same block of `source`.
pub fn copy_block(source: &str, target: &str, head: &str) -> Result<String, String> {
    let missing = || format!("{head} block missing");
    let (from, to) = (source.find(head).ok_or_else(missing)?, target.find(head).ok_or_else(missing)?);
    Ok(format!("{}{}{}", &target[..to], &source[from..block_end(source, from)?], &target[block_end(target, to)?..]))
}
