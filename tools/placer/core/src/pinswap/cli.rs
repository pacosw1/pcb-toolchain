//! `iotplace pinswap BOARD.kicad_pcb --board-json DOC.json PINMAP.json -o PROPOSAL.json [--ref U1 --seed 0 --w-x 10 --restarts 5
//! --w-c 5] [--apply OUT.kicad_pcb]`. PROPOSAL.json holds before, after, diff and assign; it never edits a schematic. `--apply`
//! writes a board copy with the swapped pad nets, for a routing benchmark only. `--w-x` is the cost of a rat line crossing and
//! `--w-c` of a changed pin, both in mm of HPWL.

use super::board::{PinMap, apply_swap, read_pins};
use super::{Chip, Proposal, Weights};
use crate::kicad::doc::load_board;
use crate::read::cli::Flags;
use crate::write::cli::{read_json, save_board};
use std::path::Path;

fn summary(p: &Proposal, nets: usize, slots: usize, fixed: usize) -> Vec<String> {
    let mut lines = vec![format!("swappable nets {nets}, slots {slots}, fixed rat lines {fixed}")];
    for (name, m) in [("before", &p.before), ("after", &p.after)] {
        lines.push(format!("{name:<6} HPWL {:.1} mm, crossings {}", m.hpwl, m.crossings));
    }
    for d in &p.diff {
        lines.push(format!("  {:<12} {} ({}) -> {} ({})", d.net, d.from_pin, d.from_name, d.to_pin, d.to_name));
    }
    lines
}

pub fn run(argv: &[String]) -> crate::Result<()> {
    let flags = Flags::parse_single(argv, &[]);
    let [board_file, pinmap] = &flags.positional[..] else {
        return Err("usage: iotplace pinswap BOARD.kicad_pcb --board-json DOC.json PINMAP.json -o PROPOSAL.json [--apply OUT.kicad_pcb]".into());
    };
    let board = load_board(&flags.path("--board-json")?)?;
    let map: PinMap = read_json(pinmap)?;
    let reference = flags.one("--ref")?.or(map.reference.as_deref()).unwrap_or("U1");
    let problem = read_pins(&board, &map, reference)?;
    let chip = Chip { nets: &problem.nets, slots: &problem.slots, fixed: &problem.fixed };
    let weights = Weights { crossing: flags.number("--w-x", 10.0)?, change: flags.number("--w-c", 5.0)? };
    let proposal = chip.search(flags.number("--seed", 0)?, flags.number("--restarts", 5)?, weights);
    std::fs::write(flags.path("-o")?, serde_json::to_string_pretty(&proposal)?)?;
    println!("{}", summary(&proposal, problem.nets.len(), problem.slots.len(), problem.fixed.len()).join("\n"));
    if let Some(out) = flags.one("--apply")? {
        let source = Path::new(board_file);
        let text = std::fs::read_to_string(source).map_err(|e| format!("{board_file}: {e}"))?;
        let (edited, applied) = apply_swap(&text, &board, &proposal.diff, reference)?;
        save_board(source, &edited, Path::new(out))?;
        println!("{{\"changed_pads\": {}, \"removed_tracks\": {}}}", applied.changed_pads, applied.removed_tracks);
    }
    Ok(())
}
