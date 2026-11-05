//! Duplicate item uuids in a board file: the first keeps its uuid, each repeat gets uuid5(NAMESPACE, "<uuid>#<ordinal>"), so a repair
//! is the same on every host. Only the uuid tokens change. Generator scripts copy a zone with its uuid; the job's copy gets fixed.
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

/// 7b6f2c8e-5d1a-4d0e-9f3b-2a6c4e8d1b05, fixed for this repository.
const NAMESPACE: [u8; 16] = [0x7b, 0x6f, 0x2c, 0x8e, 0x5d, 0x1a, 0x4d, 0x0e, 0x9f, 0x3b, 0x2a, 0x6c, 0x4e, 0x8d, 0x1b, 0x05];

/// SHA-1 (FIPS 180-4): RFC 4122 names it for uuid5. It identifies, it protects nothing.
fn sha1(data: &[u8]) -> [u8; 20] {
    let mut state: [u32; 5] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
    let mut message = data.to_vec();
    message.push(0x80);
    message.resize(message.len() + (64 - (message.len() + 8) % 64) % 64, 0);
    message.extend((data.len() as u64 * 8).to_be_bytes());
    for block in message.chunks(64) {
        let mut w = [0u32; 80];
        for (i, word) in block.chunks(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = state;
        for (i, word) in w.iter().enumerate() {
            let (f, k) = match i / 20 {
                0 => ((b & c) | (!b & d), 0x5a827999),
                1 => (b ^ c ^ d, 0x6ed9eba1),
                2 => ((b & c) | (b & d) | (c & d), 0x8f1bbcdc),
                _ => (b ^ c ^ d, 0xca62c1d6),
            };
            let next = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(*word);
            (e, d, c, b, a) = (d, c, b.rotate_left(30), a, next);
        }
        for (slot, add) in state.iter_mut().zip([a, b, c, d, e]) {
            *slot = slot.wrapping_add(add);
        }
    }
    let mut out = [0u8; 20];
    for (chunk, word) in out.chunks_mut(4).zip(state) {
        chunk.copy_from_slice(&word.to_be_bytes());
    }
    out
}

fn uuid5(name: &str) -> String {
    let mut digest = sha1(&[&NAMESPACE[..], name.as_bytes()].concat());
    digest[6] = (digest[6] & 0x0f) | 0x50;
    digest[8] = (digest[8] & 0x3f) | 0x80;
    let hex: String = digest[..16].iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

fn replacement(old: &str, ordinal: usize) -> String {
    uuid5(&format!("{old}#{ordinal}"))
}

/// Every `(uuid "...")` with the kind of the item around it.
struct Token {
    start: usize,
    end: usize,
    uuid: String,
    kind: String,
}

/// Quote-aware, on bytes: no multi-byte character holds a quote or a bracket.
fn tokens(text: &str) -> Vec<Token> {
    let bytes = text.as_bytes();
    let (mut out, mut stack, mut at) = (Vec::new(), Vec::<&str>::new(), 0);
    while at < bytes.len() {
        match bytes[at] {
            b'"' => {
                let mut end = at + 1;
                while end < bytes.len() && bytes[end] != b'"' {
                    end += if bytes[end] == b'\\' { 2 } else { 1 };
                }
                at = end + 1;
            }
            b'(' => {
                let mut end = at + 1;
                while end < bytes.len() && !bytes[end].is_ascii_whitespace() && !matches!(bytes[end], b'(' | b')') {
                    end += 1;
                }
                let word = &text[at + 1..end];
                if word == "uuid"
                    && let Some(open) = text[end..].find('"').map(|found| end + found)
                    && let Some(close) = text[open + 1..].find('"').map(|found| open + 1 + found)
                {
                    out.push(Token { start: open + 1, end: close, uuid: text[open + 1..close].to_string(), kind: stack.last().copied().unwrap_or("").to_string() });
                }
                stack.push(word);
                at = end;
            }
            b')' => {
                stack.pop();
                at += 1;
            }
            _ => at += 1,
        }
    }
    out
}

/// One replaced uuid.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Row {
    pub kind: String,
    pub uuid: String,
    pub ordinal: usize,
    pub new: String,
}

/// The text with each repeated uuid replaced. A replacement that collides takes ordinal + 1000.
pub fn repair(text: &str) -> (String, Vec<Row>) {
    let found = tokens(text);
    let mut seen: BTreeMap<&str, usize> = BTreeMap::new();
    let mut repeats: Vec<(&Token, usize)> = Vec::new();
    for token in &found {
        let count = seen.entry(&token.uuid).or_default();
        *count += 1;
        if *count > 1 {
            repeats.push((token, *count - 1));
        }
    }
    if repeats.is_empty() {
        return (text.to_string(), Vec::new());
    }
    let mut used: BTreeSet<String> = found.iter().map(|token| token.uuid.clone()).collect();
    let mut out = text.to_string();
    let mut rows = Vec::with_capacity(repeats.len());
    for (token, ordinal) in repeats.iter().rev() {
        let (mut number, mut new) = (*ordinal, replacement(&token.uuid, *ordinal));
        while used.contains(&new) {
            number += 1000;
            new = replacement(&token.uuid, number);
        }
        used.insert(new.clone());
        out.replace_range(token.start..token.end, &new);
        rows.push(Row { kind: token.kind.clone(), uuid: token.uuid.clone(), ordinal: *ordinal, new });
    }
    rows.reverse();
    (out, rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha1_of_the_rfc_message() {
        let hex: String = sha1(b"abc").iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(hex, "a9993e364706816aba3e25717850c26c9cd0d89d");
    }

    #[test]
    fn uuid5_has_the_version_and_variant_bits() {
        let id = uuid5("x");
        assert_eq!((&id[14..15], id.len()), ("5", 36));
        assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
    }

    #[test]
    fn a_repeat_gets_a_stable_new_uuid_and_nothing_else_changes() {
        let board = "(kicad_pcb (zone (uuid \"a\")) (zone (uuid \"a\")) (gr_text \"(uuid \\\"a\\\")\" (uuid \"b\")) (zone (uuid \"a\")))";
        let (text, rows) = repair(board);
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[0].ordinal, rows[1].ordinal, rows[0].kind.as_str()), (1, 2, "zone"));
        assert_eq!(rows[0].new, replacement("a", 1));
        assert!(text.starts_with("(kicad_pcb (zone (uuid \"a\")) (zone (uuid \""));
        assert!(text.contains("\"(uuid \\\"a\\\")\""));
        assert_eq!(repair(&text).1.len(), 0);
        assert_eq!(repair(board), repair(board));
    }

    #[test]
    fn a_clean_board_is_returned_as_it_is() {
        let board = "(kicad_pcb (zone (uuid \"a\")))";
        assert_eq!(repair(board), (board.to_string(), Vec::new()));
    }
}
