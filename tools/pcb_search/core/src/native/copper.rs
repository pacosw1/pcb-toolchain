//! The routing items of a board, by identity.

use std::collections::{BTreeMap, BTreeSet};

use super::board::{Board, uuid};
use crate::error::{Result, invalid};
use crate::raw::Form;

pub struct CopperItem<'a> {
    pub id: &'a str,
    pub kind: &'a str,
    pub net: String,
    pub form: &'a Form,
}

/// Items in file order, with lookup by identity.
pub struct Copper<'a> {
    pub items: Vec<CopperItem<'a>>,
    index: BTreeMap<&'a str, usize>,
}

impl<'a> Copper<'a> {
    pub fn read(board: &'a Board) -> Result<Copper<'a>> {
        let table = net_table(board)?;
        let mut copper = Copper { items: Vec::new(), index: BTreeMap::new() };
        for form in board.forms() {
            if !(form.is("segment") || form.is("arc") || form.is("via")) {
                continue;
            }
            let item = read_item(form, &table)?;
            if copper.index.insert(item.id, copper.items.len()).is_some() {
                return invalid("routing item lacks unique identity or native net");
            }
            copper.items.push(item);
        }
        Ok(copper)
    }

    pub fn get(&self, id: &str) -> Option<&CopperItem<'a>> {
        self.index.get(id).map(|&position| &self.items[position])
    }

    pub fn ids(&self) -> BTreeSet<String> {
        self.index.keys().map(|id| id.to_string()).collect()
    }
}

/// Net codes of the board's `(net code name)` table. KiCad 9 stores codes on copper; KiCad 10 stores names.
pub fn net_table(board: &Board) -> Result<BTreeMap<&str, &str>> {
    let mut table = BTreeMap::new();
    for row in board.forms().iter().filter(|form| form.is("net") && form.items().len() == 3) {
        if let (Some(code), Some(name)) = (row.text(1), row.text(2)) {
            if table.insert(code, name).is_some() {
                return invalid("duplicate native net code");
            }
        }
    }
    Ok(table)
}

fn read_item<'a>(form: &'a Form, table: &BTreeMap<&str, &str>) -> Result<CopperItem<'a>> {
    let net = form.items().iter().find(|row| row.is("net")).and_then(|row| row.items().last()?.atom());
    let net = match net {
        // Never read an unresolved legacy code as a net name.
        Some(code) if is_code(code) => match table.get(code) {
            Some(name) => Some(*name),
            None => return invalid("unresolved numeric native net"),
        },
        other => other,
    };
    match (uuid(form), net.filter(|name| !name.is_empty())) {
        (Some(id), Some(net)) if !id.is_empty() => {
            Ok(CopperItem { id, kind: form.head().unwrap_or(""), net: net.to_string(), form })
        }
        _ => invalid("routing item lacks unique identity or native net"),
    }
}

/// True for an all-digit net field, which is a code and not a name.
pub fn is_code(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|c| c.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(text: &str) -> Result<usize> {
        let board = Board::from_text(text.to_string())?;
        Ok(Copper::read(&board)?.items.len())
    }

    #[test]
    fn numeric_nets_resolve_through_the_table_and_names_pass() {
        assert_eq!(read("(kicad_pcb (net 1 \"A\") (segment (net 1) (uuid \"s\")) (via (net \"B\") (uuid \"v\")))"), Ok(2));
        assert!(read("(kicad_pcb (segment (net 7) (uuid \"s\")))").is_err());
    }

    #[test]
    fn missing_or_repeated_identity_is_refused() {
        assert!(read("(kicad_pcb (segment (net \"A\")))").is_err());
        assert!(read("(kicad_pcb (segment (uuid \"s\")))").is_err());
        assert!(read("(kicad_pcb (via (net \"A\") (uuid \"s\")) (via (net \"A\") (uuid \"s\")))").is_err());
    }
}
