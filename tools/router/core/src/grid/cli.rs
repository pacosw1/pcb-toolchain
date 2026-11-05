//! The command lines of the grid tools. They edit a board through the pinned KiCad API, so they run in the route image.
//!
//!   iotroute grid-finish BOARD [--nets N1,N2] [--layers F.Cu,B.Cu] [--grid 0.05] [--width NET=MM ...] [--via-cost 4] [--turn-cost 0.3]
//!       [--margin 10] [--layer-cost LAYER=X ...] [--via-drill 0.3] [--in2-clear-of-b] [--via-halo D] [--skip GND,VDD_3V3] [--dry-run]
//!       [--connect REF.PAD:REF.PAD ...] [--block X0,Y0,X1,Y1 ...] [--escape REF] [--escape-ring 3] [--escape-skip N1,N2]
//!   iotroute grid-ripup BOARD --net NET [--layers F.Cu,B.Cu] [--margin 30] [--via-cost 3] [--grid 0.05] [--width 0.15] [--via-halo D]
//!       [--accept-equal] [--protect N1,N*]
//!   iotroute gnd-via-near BOARD [--nets N1,N2] [--r 1.0] [--grid 0.025] [--dry-run]
//!
//! Exit 0, 1 for a RIPUP FAIL, 2 for a usage or tool error.
use super::{finish, ripup, via_near};
use crate::kicad::session::Session;
use std::collections::BTreeSet;
use std::path::PathBuf;

/// Flags that take no value, and the (flag, value) pairs in order.
struct Line {
    board: PathBuf,
    flags: BTreeSet<String>,
    values: Vec<(String, String)>,
}

fn read_line(args: &[String], switches: &[&str]) -> Result<Line, String> {
    let (mut board, mut flags, mut values) = (None, BTreeSet::new(), Vec::new());
    let mut words = args.iter();
    while let Some(word) = words.next() {
        match word.split_once('=') {
            Some((flag, value)) if flag.starts_with("--") => values.push((flag.to_string(), value.to_string())),
            _ if switches.contains(&word.as_str()) => {
                flags.insert(word.clone());
            }
            _ if word.starts_with("--") => values.push((word.clone(), words.next().ok_or(format!("{word} needs a value"))?.clone())),
            _ if board.is_none() => board = Some(PathBuf::from(word)),
            _ => return Err(format!("unexpected argument {word}")),
        }
    }
    Ok(Line { board: board.ok_or("a board is required")?, flags, values })
}

fn number(flag: &str, text: &str) -> Result<f64, String> {
    text.parse().map_err(|_| format!("{flag}: not a number: {text}"))
}

fn list(text: &str) -> Vec<String> {
    text.split(',').filter(|item| !item.is_empty()).map(str::to_string).collect()
}

fn pair(flag: &str, text: &str) -> Result<(String, f64), String> {
    let (key, value) = text.split_once('=').ok_or(format!("{flag}: want NAME=VALUE, got {text}"))?;
    Ok((key.to_string(), number(flag, value)?))
}

fn finish_options(line: &Line) -> Result<finish::Options, String> {
    let mut o = finish::Options { in2_clear_of_b: line.flags.contains("--in2-clear-of-b"), dry_run: line.flags.contains("--dry-run"), ..finish::Options::default() };
    for (flag, value) in &line.values {
        match flag.as_str() {
            "--nets" => o.nets = list(value).into_iter().collect(),
            "--layers" => o.layers = value.split(',').map(str::to_string).collect(),
            "--grid" => o.grid = number(flag, value)?,
            "--width" => {
                let (net, width) = pair(flag, value)?;
                o.widths.insert(net, width);
            }
            "--via-cost" => o.via_cost = number(flag, value)?,
            "--turn-cost" => o.turn_cost = number(flag, value)?,
            "--margin" => o.margin = number(flag, value)?,
            "--layer-cost" => {
                let (layer, cost) = pair(flag, value)?;
                o.layer_cost.insert(layer, cost);
            }
            "--via-drill" => o.via_drill = number(flag, value)?,
            "--via-halo" => o.via_halo = number(flag, value)?,
            "--skip" => o.skip = value.split(',').map(str::to_string).collect(),
            "--connect" => o.connect.push(value.clone()),
            "--block" => {
                let edges = value.split(',').map(|v| number(flag, v)).collect::<Result<Vec<f64>, String>>()?;
                o.block.push(<[f64; 4]>::try_from(edges).map_err(|_| format!("{flag}: want X0,Y0,X1,Y1, got {value}"))?);
            }
            "--escape" => o.escape = value.clone(),
            "--escape-ring" => o.escape_ring = number(flag, value)?,
            "--escape-skip" => o.escape_skip = list(value),
            _ => return Err(format!("unknown option {flag}")),
        }
    }
    Ok(o)
}

fn ripup_options(line: &Line) -> Result<ripup::Options, String> {
    let mut o = ripup::Options { accept_equal: line.flags.contains("--accept-equal"), ..ripup::Options::default() };
    for (flag, value) in &line.values {
        match flag.as_str() {
            "--net" => o.net = value.clone(),
            "--layers" => o.layers = value.split(',').map(str::to_string).collect(),
            "--margin" => o.margin = number(flag, value)?,
            "--via-cost" => o.via_cost = number(flag, value)?,
            "--grid" => o.grid = number(flag, value)?,
            "--width" => o.width = number(flag, value)?,
            "--via-halo" => o.via_halo = number(flag, value)?,
            "--protect" => o.protect = list(value),
            _ => return Err(format!("unknown option {flag}")),
        }
    }
    if o.net.is_empty() {
        return Err("--net is required".to_string());
    }
    Ok(o)
}

fn near_options(line: &Line) -> Result<via_near::Options, String> {
    let mut o = via_near::Options { dry_run: line.flags.contains("--dry-run"), ..via_near::Options::default() };
    for (flag, value) in &line.values {
        match flag.as_str() {
            "--nets" => o.nets = list(value).into_iter().collect(),
            "--r" => o.r = number(flag, value)?,
            "--grid" => o.grid = number(flag, value)?,
            _ => return Err(format!("unknown option {flag}")),
        }
    }
    Ok(o)
}

fn report(tool: &str, result: Result<i32, String>) -> i32 {
    result.unwrap_or_else(|error| {
        eprintln!("{tool}: {error}");
        2
    })
}

pub fn finish_cli(args: &[String]) -> i32 {
    report("grid-finish", (|| {
        let line = read_line(args, &["--in2-clear-of-b", "--dry-run"])?;
        let o = finish_options(&line)?;
        let mut session = Session::open(&line.board, &args.join(" "))?;
        finish::run(&mut session, &o, &mut |text| println!("{text}"))?;
        Ok(0)
    })())
}

pub fn ripup_cli(args: &[String]) -> i32 {
    report("grid-ripup", (|| {
        let line = read_line(args, &["--accept-equal"])?;
        let outcome = ripup::run(&std::path::absolute(&line.board).map_err(|e| e.to_string())?, &ripup_options(&line)?)?;
        println!("{}", outcome.line);
        Ok(i32::from(!outcome.passed))
    })())
}

pub fn near_cli(args: &[String]) -> i32 {
    report("gnd-via-near", (|| {
        let line = read_line(args, &["--dry-run"])?;
        let o = near_options(&line)?;
        let mut session = Session::open(&line.board, &args.join(" "))?;
        println!("{}", via_near::run(&mut session, &o)?);
        Ok(0)
    })())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(words: &[&str], switches: &[&str]) -> Result<Line, String> {
        read_line(&words.iter().map(|w| w.to_string()).collect::<Vec<_>>(), switches)
    }

    #[test]
    fn repeated_and_inline_options_are_kept() {
        let l = line(&["b.kicad_pcb", "--width", "A=0.3", "--width=B=0.4", "--block", "1,2,3,4", "--dry-run"], &["--dry-run"]).unwrap();
        let o = finish_options(&l).unwrap();
        assert_eq!(o.widths["A"], 0.3);
        assert_eq!(o.widths["B"], 0.4);
        assert_eq!(o.block, vec![[1.0, 2.0, 3.0, 4.0]]);
        assert!(o.dry_run);
    }

    #[test]
    fn a_bad_line_is_an_error() {
        assert!(line(&[], &[]).is_err());
        assert!(line(&["a", "b"], &[]).is_err());
        assert!(line(&["a", "--grid"], &[]).is_err());
        assert!(finish_options(&line(&["a", "--block", "1,2,3"], &[]).unwrap()).is_err());
        assert!(finish_options(&line(&["a", "--nope", "1"], &[]).unwrap()).is_err());
        assert!(ripup_options(&line(&["a"], &[]).unwrap()).is_err());
    }

    #[test]
    fn empty_skip_entries_stay_as_python_split_them() {
        let o = finish_options(&line(&["a", "--skip", ""], &[]).unwrap()).unwrap();
        assert_eq!(o.skip, vec![String::new()]);
    }
}
