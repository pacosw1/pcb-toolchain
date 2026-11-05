//! `iotplace strip BOARD.kicad_pcb OUT.kicad_pcb [--keep=NET,...] [--only NETS.txt]`. A board copy with tracks and vias taken out,
//! so a baseline and each candidate give a router job the same start. `--keep` holds shell patterns: every other net goes.
//! `--only` names a file of comma-separated exact net names: only those go. Zones stay; the save refills them.

use super::cli::save_board;
use crate::dru::fnmatch;
use crate::read::cli::Flags;
use iotroute::kicad::edit::Edit;
use iotroute::kicad::sexpr::parse;
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// Which copper goes.
pub enum Strip {
    /// All but the nets that match one of these patterns.
    AllBut(Vec<String>),
    /// The nets of these exact names.
    Only(HashSet<String>),
}

impl Strip {
    fn takes(&self, net: &str) -> bool {
        match self {
            Self::AllBut(patterns) => !patterns.iter().any(|p| fnmatch(net, p)),
            Self::Only(names) => names.contains(net),
        }
    }
}

/// The net of each track and via of a board text, by uuid. Copper with no net has the name "".
fn copper_nets(text: &str) -> crate::Result<HashMap<String, String>> {
    let forms = parse(text)?;
    let root = forms.first().ok_or("an empty board file")?;
    let copper = root.items().iter().filter(|f| f.is("segment") || f.is("arc") || f.is("via"));
    copper.map(|f| Ok((f.value("uuid").ok_or("a track without a uuid")?.to_string(), f.value("net").unwrap_or("").to_string()))).collect()
}

/// The board text without the copper `rule` takes, and how many items went.
pub fn strip_text(text: &str, rule: &Strip) -> crate::Result<(String, usize)> {
    let removed: HashSet<String> = copper_nets(text)?.into_iter().filter(|(_, net)| rule.takes(net)).map(|(id, _)| id).collect();
    let count = removed.len();
    Ok((Edit { removed, ..Edit::default() }.apply(text, "placer-strip")?, count))
}

fn rule_of(flags: &Flags) -> crate::Result<Strip> {
    if let Some(path) = flags.one("--only")? {
        let names = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
        return Ok(Strip::Only(names.trim().split(',').map(String::from).collect()));
    }
    Ok(Strip::AllBut(flags.one("--keep")?.unwrap_or("").split(',').filter(|k| !k.is_empty()).map(String::from).collect()))
}

pub fn run(argv: &[String]) -> crate::Result<()> {
    let flags = Flags::parse_single(argv, &[]);
    let [board_file, out] = &flags.positional[..] else {
        return Err("usage: iotplace strip BOARD.kicad_pcb OUT.kicad_pcb [--keep=NET,...] [--only NETS.txt]".into());
    };
    let source = Path::new(board_file);
    let text = std::fs::read_to_string(source).map_err(|e| format!("{board_file}: {e}"))?;
    let (edited, count) = strip_text(&text, &rule_of(&flags)?)?;
    save_board(source, &edited, Path::new(out))?;
    println!("removed {count}");
    Ok(())
}
