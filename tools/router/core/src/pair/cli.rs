//! The command lines of the pair tools. They edit a board through the pinned KiCad API, so they run in the route image.
//!
//!   iotroute pair-stubs BOARD.kicad_pcb OUT.kicad_pcb SPEC.json
//!   iotroute pair-route BOARD.kicad_pcb OUT.kicad_pcb --pair BASE:WIDTH:GAP[:LAYER] [--pair ...] [--net NET:WIDTH[:LAYER] ...] [--layer F.Cu]
//!       [--keepout NAME ...] [--space 0.5] [--same-class-space 0.15] [--guard-class C ...] [--pad-room 0.15] [--space-exempt U101 ...]
//!       [--space-exempt-area NAME ...] [--channel REF:HALF:LATERAL ...] [--barrier NETPREFIX:MM ...] [--grid 0.05] [--margin 15] [--debug DIR]
//!
//! pair-route prints one line per pair "PAIR base routed|FAILED length P/N skew" and "PAIRS routed R failed F", and exits 0 when every
//! route is in, 1 when one failed, 2 for a usage or tool error. pair-stubs exits 1 for a part or pad the board does not have.
use super::route::{self, Options};
use super::stubs::{self, Spec};
use crate::kicad::session::Session;
use crate::tool_args::Args;
use std::fs;
use std::path::{Path, PathBuf};

fn route_options(args: Vec<String>) -> Result<(Vec<PathBuf>, Options), String> {
    let mut args = Args::new(args);
    let (mut paths, mut o) = (Vec::new(), Options::default());
    while let Some(word) = args.next() {
        match word.as_str() {
            "--pair" => o.pairs.push(args.value(&word)?),
            "--net" => o.nets.push(args.value(&word)?),
            "--same-class-space" => o.same_class_space = args.number(&word)?,
            "--guard-class" => o.guard_class.push(args.value(&word)?),
            "--space-exempt-area" => o.space_exempt_area.push(args.value(&word)?),
            "--channel" => o.channel.push(args.value(&word)?),
            "--layer" => o.layer = args.value(&word)?,
            "--keepout" => o.keepout.push(args.value(&word)?),
            "--space" => o.space = args.number(&word)?,
            "--pad-room" => o.pad_room = args.number(&word)?,
            "--space-exempt" => o.space_exempt.push(args.value(&word)?),
            "--barrier" => o.barrier.push(args.value(&word)?),
            "--grid" => o.grid = args.number(&word)?,
            "--margin" => o.margin = args.number(&word)?,
            "--debug" => o.debug = Some(PathBuf::from(args.value(&word)?)).filter(|path| !path.as_os_str().is_empty()),
            _ if word.starts_with("--") => return Err(format!("unknown option {word}")),
            _ => paths.push(PathBuf::from(word)),
        }
    }
    Ok((paths, o))
}

pub fn route_cli(args: &[String]) -> i32 {
    let run = route_options(args.to_vec()).and_then(|(paths, o)| {
        let [board, out] = &paths[..] else { return Err("want BOARD.kicad_pcb OUT.kicad_pcb".to_string()) };
        route::run(board, out, &args.join(" "), &o, &mut |text| println!("{text}"))
    });
    match run {
        Ok(passed) => i32::from(!passed),
        Err(error) => {
            eprintln!("pair-route: {error}");
            2
        }
    }
}

fn draw_stubs(board: &Path, out: &Path, spec: &Path, arguments: &str) -> Result<(), String> {
    let text = fs::read_to_string(spec).map_err(|e| format!("{}: {e}", spec.display()))?;
    let spec: Spec = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", spec.display()))?;
    let mut session = Session::open(board, arguments)?;
    let report = stubs::draw(&mut session, &spec)?;
    session.save_to(out)?;
    println!("{}", report.join("\n"));
    Ok(())
}

pub fn stubs_cli(args: &[String]) -> i32 {
    let [board, out, spec] = args else {
        eprintln!("usage: iotroute pair-stubs BOARD.kicad_pcb OUT.kicad_pcb SPEC.json");
        return 2;
    };
    match draw_stubs(Path::new(board), Path::new(out), Path::new(spec), &args.join(" ")) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("{error}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(line: &[&str]) -> Vec<String> {
        line.iter().map(|word| word.to_string()).collect()
    }

    #[test]
    fn repeated_and_inline_options_are_kept() {
        let (paths, o) = route_options(words(&["a.kicad_pcb", "b.kicad_pcb", "--pair", "/A:0.2:0.2", "--pair=/B:0.2:0.2:B.Cu", "--net", "X:0.1", "--barrier", "PoE:3", "--space=0.4", "--debug", "d"])).unwrap();
        assert_eq!(paths.len(), 2);
        assert_eq!(o.pairs, ["/A:0.2:0.2", "/B:0.2:0.2:B.Cu"]);
        assert_eq!((o.space, o.debug.clone()), (0.4, Some(PathBuf::from("d"))));
        assert_eq!(o.barriers().unwrap(), [("PoE".to_string(), 3.0)]);
    }

    #[test]
    fn a_bad_line_is_an_error() {
        assert!(route_options(words(&["a", "--grid"])).is_err());
        assert!(route_options(words(&["a", "--nope", "1"])).is_err());
        assert!(route_options(words(&["a", "--grid", "x"])).is_err());
        assert_eq!(route_cli(&words(&["only-one", "--pair", "/A:0.2:0.2"])), 2);
        assert_eq!(stubs_cli(&words(&["a", "b"])), 2);
    }
}
